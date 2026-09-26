import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, resetTileRouteCache } from "../../app/api/map/tile/[tileId]/route";
import { TileDataSchema } from "@/lib/data/schema";

const DATASET_VERSION = "5.5.5";
const MANIFEST = JSON.stringify({ datasetVersion: DATASET_VERSION });
const TILE_MANIFEST = [
  { tileId: "l0_0_17", lod: 0, bounds: [0, 0, 1, 1], featureCount: 1, byteSize: 42, features: ["feature-a"] },
  { tileId: "l0_0_18", lod: 0, bounds: [1, 0, 2, 1], featureCount: 0, byteSize: 0, features: [] },
];
const TILE_FEATURES = {
  "l0_0_17": [
    {
      stableId: "feature-a",
      kind: "building",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] },
      lon: 0.5,
      lat: 43.6,
      height: 8,
    },
  ],
  "l0_0_18": [],
};

let dataRoot = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "master-maps-tile-"));
  await mkdir(join(dataRoot, "generated", "tiles"), { recursive: true });
  await writeFile(join(dataRoot, "generated", "manifest.json"), MANIFEST, "utf8");
  await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify(TILE_MANIFEST), "utf8");
  for (const [tileId, features] of Object.entries(TILE_FEATURES)) {
    await writeFile(join(dataRoot, "generated", "tiles", `${tileId}.json`), JSON.stringify(features), "utf8");
  }
  previousDataDir = process.env.MASTER_MAPS_DATA_DIR;
  process.env.MASTER_MAPS_DATA_DIR = dataRoot;
  resetTileRouteCache();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.MASTER_MAPS_DATA_DIR;
  else process.env.MASTER_MAPS_DATA_DIR = previousDataDir;
  resetTileRouteCache();
  await rm(dataRoot, { recursive: true, force: true });
});

function tileRequest(tileId: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/map/tile/${tileId}`, { headers });
}

function tileParams(tileId: string): { params: Promise<{ tileId: string }> } {
  return { params: Promise.resolve({ tileId }) };
}

describe("GET /api/map/tile/[tileId]", () => {
  it("serves a TileData envelope that validates against TileDataSchema", async () => {
    const response = await GET(tileRequest("l0_0_17"), tileParams("l0_0_17"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    const parsed = TileDataSchema.parse(body);
    expect(parsed.manifest.tileId).toBe("l0_0_17");
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0]?.stableId).toBe("feature-a");
  });

  it("sets the dataset version as ETag and X-Dataset-Version", async () => {
    const response = await GET(tileRequest("l0_0_17"), tileParams("l0_0_17"));
    expect(response.headers.get("etag")).toBe(DATASET_VERSION);
    expect(response.headers.get("x-dataset-version")).toBe(DATASET_VERSION);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600, must-revalidate");
  });

  it("answers 304 when If-None-Match matches the dataset version", async () => {
    const response = await GET(tileRequest("l0_0_17", { "if-none-match": DATASET_VERSION }), tileParams("l0_0_17"));
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("rejects a tile id carrying the .json suffix", async () => {
    const response = await GET(tileRequest("l0_0_17.json"), tileParams("l0_0_17.json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_TILE_ID", code: "INVALID_TILE_ID" });
  });

  it("rejects a traversing tile id", async () => {
    const response = await GET(tileRequest(".."), tileParams(".."));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_TILE_ID", code: "INVALID_TILE_ID" });
  });

  it("answers 503 for a tile absent from disk", async () => {
    const response = await GET(tileRequest("l9_9_9"), tileParams("l9_9_9"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
  });

  it("answers 503 for a tile present on disk but absent from the tile manifest", async () => {
    await writeFile(join(dataRoot, "generated", "tiles", "l4_4_4.json"), "[]", "utf8");
    const response = await GET(tileRequest("l4_4_4"), tileParams("l4_4_4"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
  });

  it("serves an empty tile without a feature count mismatch", async () => {
    const response = await GET(tileRequest("l0_0_18"), tileParams("l0_0_18"));
    expect(response.status).toBe(200);
    const parsed = TileDataSchema.parse((await response.json()) as unknown);
    expect(parsed.features).toEqual([]);
  });

  it("serves an identical envelope for a repeated request", async () => {
    const first = await GET(tileRequest("l0_0_17"), tileParams("l0_0_17"));
    const firstBody = await first.text();
    const second = await GET(tileRequest("l0_0_17"), tileParams("l0_0_17"));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(firstBody);
  });
});
