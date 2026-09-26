import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, isPinnedToDatasetVersion, isValidRenderTileId, renderCacheControl, resetRenderVersionCache } from "../../app/api/map/render/[tileId]/route";

const DATASET_VERSION = "7.7.7";
const CORE_MANIFEST = JSON.stringify({ datasetVersion: DATASET_VERSION });

let dataRoot = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "master-maps-render-"));
  await mkdir(join(dataRoot, "generated", "render"), { recursive: true });
  await writeFile(join(dataRoot, "generated", "manifest.json"), CORE_MANIFEST, "utf8");
  previousDataDir = process.env.MASTER_MAPS_DATA_DIR;
  process.env.MASTER_MAPS_DATA_DIR = dataRoot;
  resetRenderVersionCache();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.MASTER_MAPS_DATA_DIR;
  else process.env.MASTER_MAPS_DATA_DIR = previousDataDir;
  resetRenderVersionCache();
  await rm(dataRoot, { recursive: true, force: true });
});

function renderRequest(tileId: string, query = "", headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/map/render/${tileId}${query}`, { headers });
}

function renderParams(tileId: string): { params: Promise<{ tileId: string }> } {
  return { params: Promise.resolve({ tileId }) };
}

async function writePlain(tileId: string): Promise<Buffer> {
  const payload = Buffer.from(`MMT1-${tileId}-plain-payload`);
  await writeFile(join(dataRoot, "generated", "render", `${tileId}.mmt`), payload);
  return payload;
}

async function writeGzip(tileId: string): Promise<Buffer> {
  const raw = Buffer.from(`MMT1-${tileId}-gzip-payload`);
  const compressed = gzipSync(raw);
  await writeFile(join(dataRoot, "generated", "render", `${tileId}.mmt`), raw);
  await writeFile(join(dataRoot, "generated", "render", `${tileId}.mmt.gz`), compressed);
  return compressed;
}

async function bodyBuffer(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

describe("isValidRenderTileId", () => {
  it("accepts a plain tile id", () => {
    expect(isValidRenderTileId("l0_558_293_s4_1_0")).toBe(true);
    expect(isValidRenderTileId("a")).toBe(true);
  });

  it("rejects path traversal and separators", () => {
    expect(isValidRenderTileId("../secrets")).toBe(false);
    expect(isValidRenderTileId("a/b")).toBe(false);
    expect(isValidRenderTileId("a\\b")).toBe(false);
    expect(isValidRenderTileId("..")).toBe(false);
  });

  it("rejects ids carrying a file extension", () => {
    expect(isValidRenderTileId("tile.json")).toBe(false);
    expect(isValidRenderTileId("tile.mmt")).toBe(false);
    expect(isValidRenderTileId("tile.gz")).toBe(false);
    expect(isValidRenderTileId("tile.mmt.gz")).toBe(false);
  });

  it("rejects an empty or oversized id", () => {
    expect(isValidRenderTileId("")).toBe(false);
    expect(isValidRenderTileId(undefined)).toBe(false);
    expect(isValidRenderTileId("a".repeat(129))).toBe(false);
  });
});

describe("isPinnedToDatasetVersion", () => {
  it("pins only when the query version equals the current dataset version", () => {
    expect(isPinnedToDatasetVersion("7.7.7", "7.7.7")).toBe(true);
    expect(isPinnedToDatasetVersion("0.0.1", "7.7.7")).toBe(false);
    expect(isPinnedToDatasetVersion(null, "7.7.7")).toBe(false);
    expect(isPinnedToDatasetVersion("", "7.7.7")).toBe(false);
  });
});

describe("renderCacheControl", () => {
  it("is immutable only when pinned", () => {
    expect(renderCacheControl(true)).toBe("public, max-age=31536000, immutable");
    expect(renderCacheControl(false)).toBe("no-store");
  });
});

describe("GET /api/map/render/[tileId]", () => {
  it("rejects an unsafe tile id with 400", async () => {
    const response = await GET(renderRequest("..%2Fetc"), renderParams("../etc"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_TILE_ID", code: "INVALID_TILE_ID" });
  });

  it("serves a plain .mmt without Content-Encoding and no-store when unpinned", async () => {
    const payload = await writePlain("l0_1_1");
    const response = await GET(renderRequest("l0_1_1"), renderParams("l0_1_1"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-dataset-version")).toBe(DATASET_VERSION);
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await bodyBuffer(response)).toEqual(payload);
  });

  it("prefers the .gz sidecar with Content-Encoding gzip and Vary when present", async () => {
    const compressed = await writeGzip("l0_2_2");
    const response = await GET(renderRequest("l0_2_2"), renderParams("l0_2_2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(response.headers.get("content-length")).toBe(String(compressed.length));
    expect(await bodyBuffer(response)).toEqual(compressed);
  });

  it("is immutable only when the request carries the current dataset version", async () => {
    await writePlain("l0_3_3");
    const pinned = await GET(renderRequest("l0_3_3", `?v=${DATASET_VERSION}`), renderParams("l0_3_3"));
    expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const stale = await GET(renderRequest("l0_3_3", "?v=0.0.0"), renderParams("l0_3_3"));
    expect(stale.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 when neither .mmt nor .mmt.gz exists", async () => {
    const response = await GET(renderRequest("l0_9_9"), renderParams("l0_9_9"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
  });

  it("answers 503 when the dataset manifest is missing", async () => {
    process.env.MASTER_MAPS_DATA_DIR = `${dataRoot}-missing`;
    resetRenderVersionCache();
    await writePlain("l0_4_4");
    const response = await GET(renderRequest("l0_4_4"), renderParams("l0_4_4"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
  });

  it("reads the dataset version once across repeated requests", async () => {
    const payload = await writePlain("l0_5_5");
    const first = await GET(renderRequest("l0_5_5"), renderParams("l0_5_5"));
    const second = await GET(renderRequest("l0_5_5"), renderParams("l0_5_5"));
    expect(await bodyBuffer(first)).toEqual(payload);
    expect(await bodyBuffer(second)).toEqual(payload);
    expect(second.headers.get("x-dataset-version")).toBe(DATASET_VERSION);
  });
});
