import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeRenderTile, encodeRenderTile, type RenderTileInput } from "@/lib/render/codec";
import type { DecodeRequest, WorkerToMainMessage } from "@/lib/render/protocol";
import {
  clearRenderTileCache,
  configureRenderTileDatasetVersion,
  getRenderTileCacheStats,
  loadRenderTile,
  renderTileRequestUrl,
} from "@/lib/render/loadRenderTile";

const BOUNDS: [number, number, number, number] = [-1024, -512, 1024, 512];

class InlineDecodeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  postMessage(message: unknown): void {
    const request = message as DecodeRequest;
    if (request.t === "cancel") return;
    const decoded = decodeRenderTile(request.buffer);
    const reply: WorkerToMainMessage = {
      t: "decoded",
      tileId: request.tileId,
      gen: request.gen,
      header: decoded.header,
      payload: decoded.payload,
      layers: decoded.layers,
      meta: decoded.meta,
    };
    this.onmessage?.({ data: reply } as MessageEvent);
  }

  terminate(): void {
    this.onmessage = null;
    this.onerror = null;
  }
}

function renderTileBuffer(tileId: string, datasetVersion: string): ArrayBuffer {
  const input: RenderTileInput = {
    tileId,
    lod: 0,
    bounds: BOUNDS,
    datasetVersion,
    layers: [
      {
        id: "building",
        vertices: new Float32Array([0, 0, 0, 6, 0, 1, 0, 0, 6, 0, 0, 0, 1, 6, 0]),
        indices: new Uint32Array([0, 1, 2]),
        ranges: new Uint32Array([0, 3, 0, 0, 3]),
      },
    ],
    meta: [{ s: `building/${tileId}/${datasetVersion}`, k: "building", c: "yes", a: [0, 0], h: 6 }],
  };
  return encodeRenderTile(input);
}

let requestedUrls: string[] = [];

function stubNetwork(): void {
  vi.stubGlobal("Worker", InlineDecodeWorker);
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    requestedUrls.push(url);
    const parsed = new URL(url, "http://localhost");
    const tileId = decodeURIComponent(parsed.pathname.slice("/api/map/render/".length));
    const datasetVersion = parsed.searchParams.get("v") ?? "unversioned";
    return Promise.resolve(new Response(renderTileBuffer(tileId, datasetVersion)));
  }));
}

beforeEach(() => {
  requestedUrls = [];
  clearRenderTileCache();
  configureRenderTileDatasetVersion(undefined);
  stubNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearRenderTileCache();
  configureRenderTileDatasetVersion(undefined);
});

describe("renderTileRequestUrl", () => {
  it("omits the version when it is unknown", () => {
    expect(renderTileRequestUrl("l0_0_17", undefined)).toBe("/api/map/render/l0_0_17");
  });

  it("pins the request to the dataset version when it is known", () => {
    expect(renderTileRequestUrl("l0_0_17", "2026.09.27")).toBe("/api/map/render/l0_0_17?v=2026.09.27");
  });

  it("omits the version when it is empty", () => {
    expect(renderTileRequestUrl("l0_0_17", "")).toBe("/api/map/render/l0_0_17");
  });

  it("percent-encodes the tile id without opening a path segment or a second query", () => {
    const url = renderTileRequestUrl("a/b c?d&e", "2026.09.27");
    expect(url).toBe(`/api/map/render/${encodeURIComponent("a/b c?d&e")}?v=2026.09.27`);
    expect(url).not.toContain("a/b");
    expect(url).not.toContain("%252F");
    expect(url.split("?")).toHaveLength(2);
    expect(new URL(url, "http://localhost").pathname).toBe(`/api/map/render/${encodeURIComponent("a/b c?d&e")}`);
  });

  it("percent-encodes a version that carries query characters", () => {
    expect(renderTileRequestUrl("l0_0_17", "2026.09.27?a=b")).toBe("/api/map/render/l0_0_17?v=2026.09.27%3Fa%3Db");
  });
});

describe("loadRenderTile dataset version", () => {
  it("requests the configured version and serves a repeated request from the cache", async () => {
    configureRenderTileDatasetVersion("2026.09.27");
    const first = await loadRenderTile("l0_0_17");
    const second = await loadRenderTile("l0_0_17");
    expect(first.header.datasetVersion).toBe("2026.09.27");
    expect(second).toBe(first);
    expect(requestedUrls).toEqual(["/api/map/render/l0_0_17?v=2026.09.27"]);
    const stats = getRenderTileCacheStats();
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(1);
  });

  it("never serves the entry cached under another version", async () => {
    configureRenderTileDatasetVersion("2026.09.27");
    const pinned = await loadRenderTile("l0_0_17");
    expect(pinned.header.datasetVersion).toBe("2026.09.27");

    configureRenderTileDatasetVersion("2026.10.01");
    const repinned = await loadRenderTile("l0_0_17");
    expect(repinned).not.toBe(pinned);
    expect(repinned.header.datasetVersion).toBe("2026.10.01");
    expect(repinned.meta[0]?.s).toBe("building/l0_0_17/2026.10.01");
    expect(requestedUrls).toEqual([
      "/api/map/render/l0_0_17?v=2026.09.27",
      "/api/map/render/l0_0_17?v=2026.10.01",
    ]);
  });

  it("deduplicates concurrent requests only within one version", async () => {
    configureRenderTileDatasetVersion("2026.09.27");
    const [first, second] = await Promise.all([loadRenderTile("l0_0_18"), loadRenderTile("l0_0_18")]);
    expect(first).toBe(second);
    expect(requestedUrls).toEqual(["/api/map/render/l0_0_18?v=2026.09.27"]);

    configureRenderTileDatasetVersion("2026.10.01");
    const repinned = await loadRenderTile("l0_0_18");
    expect(repinned).not.toBe(first);
    expect(requestedUrls).toEqual([
      "/api/map/render/l0_0_18?v=2026.09.27",
      "/api/map/render/l0_0_18?v=2026.10.01",
    ]);
  });

  it("does not let a response issued under the previous version land in the cache", async () => {
    const releases: (() => void)[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      requestedUrls.push(url);
      const parsed = new URL(url, "http://localhost");
      const tileId = decodeURIComponent(parsed.pathname.slice("/api/map/render/".length));
      const datasetVersion = parsed.searchParams.get("v") ?? "unversioned";
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(new Response(renderTileBuffer(tileId, datasetVersion))));
      });
    }));

    configureRenderTileDatasetVersion("2026.09.27");
    const stale = loadRenderTile("l0_0_20");
    configureRenderTileDatasetVersion("2026.10.01");
    const current = loadRenderTile("l0_0_20");
    expect(requestedUrls).toEqual([
      "/api/map/render/l0_0_20?v=2026.09.27",
      "/api/map/render/l0_0_20?v=2026.10.01",
    ]);
    releases[1]!();
    releases[0]!();
    expect((await current).header.datasetVersion).toBe("2026.10.01");
    expect((await stale).header.datasetVersion).toBe("2026.09.27");
    expect(getRenderTileCacheStats().entries).toBe(1);
    const cached = await loadRenderTile("l0_0_20");
    expect(cached.header.datasetVersion).toBe("2026.10.01");
    expect(requestedUrls).toHaveLength(2);
  });

  it("keeps loading a tile whose pinned request came back volatile", async () => {
    configureRenderTileDatasetVersion("0.0.0");
    const tile = await loadRenderTile("l0_0_19");
    expect(tile.header.datasetVersion).toBe("0.0.0");
    expect(requestedUrls).toEqual(["/api/map/render/l0_0_19?v=0.0.0"]);
  });

  it("still refuses a tile id the route would reject, before any request", async () => {
    await expect(loadRenderTile("a/b")).rejects.toThrow('loadRenderTile: invalid tileId "a/b"');
    expect(requestedUrls).toEqual([]);
  });
});
