import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireFile, acquireJson } from "../../scripts/data/http-cache";

interface RecordedRequest {
  ifNoneMatch: string | undefined;
}
interface TestServer {
  origin: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function startServer(handler: RequestHandler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  let current: RequestHandler = handler;
  const server: Server = createServer((request, response) => {
    requests.push({ ifNoneMatch: request.headers["if-none-match"] });
    current(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test server failed to bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error: Error | undefined) => (error === undefined ? resolve() : reject(error)));
      });
      server.closeAllConnections();
    },
  };
}

function respondBytes(response: ServerResponse, bytes: Buffer, etag: string): void {
  response.writeHead(200, { "content-type": "application/octet-stream", etag, "content-length": String(bytes.length) });
  response.end(bytes);
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "master-maps-http-cache-"));
}

function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Sidecar {
  url: string;
  etag?: string;
  sha256: string;
  contentLength: number;
  acquiredAt: string;
  checkedAt: string;
}

async function readSidecar(destination: string): Promise<Sidecar> {
  const parsed: unknown = JSON.parse(await readFile(`${destination}.cache.json`, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error("sidecar is not an object");
  return parsed as Sidecar;
}

const FIRST_BODY = Buffer.from("first acquisition payload for master maps");
const SECOND_BODY = Buffer.from("second acquisition payload for master maps");

const servers: TestServer[] = [];

async function start(handler: RequestHandler): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

afterAll(async () => {
  for (const server of servers) await server.close();
});

describe("acquireFile", () => {
  it("writes the file and sidecar on first 200 with the correct sha256", async () => {
    const server = await start((_request, response) => {
      respondBytes(response, FIRST_BODY, '"etag-first"');
    });
    const dir = await tempDir();
    const destination = path.join(dir, "payload.bin");
    const outcome = await acquireFile({ url: `${server.origin}/payload`, destination });

    expect(outcome.fromCache).toBe(false);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.bytesDownloaded).toBe(FIRST_BODY.length);
    expect(outcome.sha256).toBe(sha256Of(FIRST_BODY));
    expect(outcome.etag).toBe('"etag-first"');
    expect(outcome.requestCount).toBe(1);
    expect(outcome.retryCount).toBe(0);
    expect(outcome.rateLimitCount).toBe(0);
    expect(await readFile(destination)).toEqual(FIRST_BODY);
    const sidecar = await readSidecar(destination);
    expect(sidecar.url).toBe(`${server.origin}/payload`);
    expect(sidecar.sha256).toBe(sha256Of(FIRST_BODY));
    expect(sidecar.contentLength).toBe(FIRST_BODY.length);
    expect(sidecar.etag).toBe('"etag-first"');
    expect(new Date(sidecar.acquiredAt).toISOString()).toBe(sidecar.acquiredAt);
  });

  it("sends If-None-Match on the second call and reports a 304 cache hit", async () => {
    const server = await start((request, response) => {
      if (request.headers["if-none-match"] !== undefined) {
        response.writeHead(304);
        response.end();
        return;
      }
      respondBytes(response, FIRST_BODY, '"etag-revalidate"');
    });
    const dir = await tempDir();
    const destination = path.join(dir, "payload.bin");
    const first = await acquireFile({ url: `${server.origin}/payload`, destination });
    const second = await acquireFile({ url: `${server.origin}/payload`, destination });

    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.ifNoneMatch).toBe('"etag-revalidate"');
    expect(second.fromCache).toBe(true);
    expect(second.httpStatus).toBe(304);
    expect(second.bytesDownloaded).toBe(0);
    expect(second.sha256).toBe(first.sha256);
    expect(second.acquiredAt).toBe(first.acquiredAt);
    const sidecar = await readSidecar(destination);
    expect(sidecar.acquiredAt).toBe(first.acquiredAt);
    expect(new Date(sidecar.checkedAt).toISOString()).toBe(sidecar.checkedAt);
  });

  it("retries once after a 500 and reports retryCount 1", async () => {
    let hits = 0;
    const server = await start((_request, response) => {
      hits += 1;
      if (hits === 1) {
        response.writeHead(500, { "content-length": "0" });
        response.end();
        return;
      }
      respondBytes(response, SECOND_BODY, '"etag-retry"');
    });
    const dir = await tempDir();
    const destination = path.join(dir, "payload.bin");
    const outcome = await acquireFile({ url: `${server.origin}/payload`, destination });

    expect(hits).toBe(2);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.retryCount).toBe(1);
    expect(outcome.requestCount).toBe(2);
    expect(outcome.fromCache).toBe(false);
    expect(await readFile(destination)).toEqual(SECOND_BODY);
  });

  it("throws on 404 without retrying", async () => {
    const server = await start((_request, response) => {
      response.writeHead(404, { "content-length": "0" });
      response.end();
    });
    const dir = await tempDir();
    const destination = path.join(dir, "payload.bin");

    await expect(acquireFile({ url: `${server.origin}/payload`, destination })).rejects.toThrow(/404/);
    expect(server.requests).toHaveLength(1);
    await expect(readFile(destination)).rejects.toThrow();
  });

  it("counts a 429 with Retry-After 0 in rateLimitCount and then succeeds", async () => {
    let hits = 0;
    const server = await start((_request, response) => {
      hits += 1;
      if (hits === 1) {
        response.writeHead(429, { "retry-after": "0", "content-length": "0" });
        response.end();
        return;
      }
      respondBytes(response, FIRST_BODY, '"etag-limited"');
    });
    const dir = await tempDir();
    const destination = path.join(dir, "payload.bin");
    const outcome = await acquireFile({ url: `${server.origin}/payload`, destination });

    expect(hits).toBe(2);
    expect(outcome.rateLimitCount).toBe(1);
    expect(outcome.retryCount).toBe(1);
    expect(outcome.httpStatus).toBe(200);
  });

  it("keeps the previous file intact and leaves no .part after a failed download", async () => {
    let broken = false;
    const server = await start((_request, response) => {
      if (!broken) {
        respondBytes(response, FIRST_BODY, '"etag-intact"');
        return;
      }
      response.writeHead(200, { etag: '"etag-broken"', "content-length": String(FIRST_BODY.length + 4096) });
      response.write(FIRST_BODY.subarray(0, 32));
      setTimeout(() => response.destroy(), 20);
    });
    const dir = await tempDir();
    const destination = path.join(dir, "payload.bin");
    const first = await acquireFile({ url: `${server.origin}/payload`, destination });

    broken = true;
    await expect(
      acquireFile({ url: `${server.origin}/payload`, destination, forceRefresh: true }),
    ).rejects.toThrow();

    expect(await readFile(destination)).toEqual(FIRST_BODY);
    const sidecar = await readSidecar(destination);
    expect(sidecar.sha256).toBe(first.sha256);
    const entries = await readdir(dir);
    expect(entries.some((entry) => entry.endsWith(".part"))).toBe(false);
  });

  it("overwrites the sidecar when the source changes between runs", async () => {
    let generation = 0;
    const server = await start((_request, response) => {
      generation += 1;
      respondBytes(response, generation === 1 ? FIRST_BODY : SECOND_BODY, `"etag-gen-${generation}"`);
    });
    const dir = await tempDir();
    const destination = path.join(dir, "payload.bin");
    await acquireFile({ url: `${server.origin}/payload`, destination });
    const second = await acquireFile({ url: `${server.origin}/payload`, destination, forceRefresh: true });

    expect(second.sha256).toBe(sha256Of(SECOND_BODY));
    expect(second.etag).toBe('"etag-gen-2"');
    expect(await readFile(destination)).toEqual(SECOND_BODY);
  });
});
describe("acquireJson", () => {
  it("persists and reuses a durable JSON response cache", async () => {
    let hits = 0;
    const server = await start((_request, response) => {
      hits += 1;
      const body = JSON.stringify({ value: "cached", hits });
      response.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      response.end(body);
    });
    const dir = await tempDir();
    const previousDataDir = process.env.MASTER_MAPS_DATA_DIR;
    process.env.MASTER_MAPS_DATA_DIR = dir;
    try {
      const first = await acquireJson({ url: `${server.origin}/json`, cacheKey: "json-cache-test" });
      const second = await acquireJson({ url: `${server.origin}/json`, cacheKey: "json-cache-test" });

      expect(first.fromCache).toBe(false);
      expect(first.bytesDownloaded).toBeGreaterThan(0);
      expect(second.fromCache).toBe(true);
      expect(second.bytesDownloaded).toBe(0);
      expect(second.body).toBe(first.body);
      expect(hits).toBe(1);
    } finally {
      if (previousDataDir === undefined) delete process.env.MASTER_MAPS_DATA_DIR;
      else process.env.MASTER_MAPS_DATA_DIR = previousDataDir;
    }
  });
});
