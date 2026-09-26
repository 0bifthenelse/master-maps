import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, resetManifestCache } from "../../app/api/map/manifest/route";
import { DatasetManifestSchema, TileManifestSchema } from "@/lib/data/schema";
import { parseTileManifestList, slimTileManifestEntries, tileManifestUnionBounds } from "@/lib/data/manifestSlim";
import { MappedFileCache, fileVersionKey } from "@/lib/data/mappedCache";

const CORE_MANIFEST = {
  version: "9.9.9",
  datasetVersion: "9.9.9",
  acquisitionTime: "2026-01-01T00:00:00.000Z",
  territoryCode: "32",
  territoryName: "Gers",
  interchangeCrs: "EPSG:4326",
  processingCrs: "EPSG:2154",
  renderOrigin: [0.586, 43.695],
  boundary: [-0.28, 43.31, 1.2, 44.08],
  projectionOrigin: [0.586, 43.695],
  tileSize: 2048,
  tileCount: 3,
  tileIds: ["a", "b", "c"],
  tileBounds: [[0, 0, 1, 1], [1, 1, 2, 2], [2, 2, 3, 3]],
  featureCounts: { building: 3 },
  byteSizes: { a: 10, b: 20, c: 30 },
  tileFeatureCounts: { a: 1, b: 1, c: 1 },
  layerAvailability: { building: true },
  pipeline: ["refresh"],
  sources: [],
  failedSources: [],
  transformation: {},
};

const TILE_MANIFEST = [
  { tileId: "a", lod: 0, bounds: [0, 0, 1, 1], featureCount: 1, byteSize: 10, features: ["fa"] },
  { tileId: "b", lod: 1, bounds: [1, 1, 2, 2], featureCount: 1, byteSize: 20, features: ["fb"], fragmentIds: ["fb.0"] },
  { tileId: "c", lod: 2, bounds: [2, 2, 3, 3], featureCount: 1, byteSize: 30, features: ["fc"], fragmentOf: "parent" },
];

let dataRoot = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "master-maps-manifest-"));
  await mkdir(join(dataRoot, "generated"), { recursive: true });
  await writeFile(join(dataRoot, "generated", "manifest.json"), JSON.stringify(CORE_MANIFEST), "utf8");
  await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify(TILE_MANIFEST), "utf8");
  previousDataDir = process.env.MASTER_MAPS_DATA_DIR;
  process.env.MASTER_MAPS_DATA_DIR = dataRoot;
  resetManifestCache();
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.MASTER_MAPS_DATA_DIR;
  else process.env.MASTER_MAPS_DATA_DIR = previousDataDir;
  resetManifestCache();
  await rm(dataRoot, { recursive: true, force: true });
});

function manifestRequest(headers?: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost:3000/api/map/manifest", { headers });
}

describe("slimTileManifestEntries", () => {
  it("drops the stable id list and the optional fragment fields from every entry", () => {
    const parsed = parseTileManifestList(TILE_MANIFEST);
    const slim = slimTileManifestEntries(parsed);
    expect(slim).toEqual([
      { tileId: "a", lod: 0, bounds: [0, 0, 1, 1], byteSize: 10, featureCount: 1 },
      { tileId: "b", lod: 1, bounds: [1, 1, 2, 2], byteSize: 20, featureCount: 1 },
      { tileId: "c", lod: 2, bounds: [2, 2, 3, 3], byteSize: 30, featureCount: 1 },
    ]);
    for (const entry of slim) {
      expect(Object.keys(entry).sort()).toEqual(["bounds", "byteSize", "featureCount", "lod", "tileId"]);
    }
  });


  it("emits a smaller wire payload than the source manifest", () => {
    const parsed = parseTileManifestList(TILE_MANIFEST);
    const before = JSON.stringify(parsed);
    const after = JSON.stringify(slimTileManifestEntries(parsed));
    expect(after.length).toBeLessThan(before.length);
  });
});

describe("tileManifestUnionBounds", () => {
  it("unions all tile bounds", () => {
    const parsed = parseTileManifestList(TILE_MANIFEST);
    expect(tileManifestUnionBounds(parsed)).toEqual([0, 0, 3, 3]);
  });
});

describe("fileVersionKey", () => {
  it("changes when mtime or size changes", () => {
    const base = fileVersionKey({ mtimeMs: 10, size: 20 });
    expect(base).toBe("10-20");
    expect(fileVersionKey({ mtimeMs: 11, size: 20 })).not.toBe(base);
    expect(fileVersionKey({ mtimeMs: 10, size: 21 })).not.toBe(base);
    expect(fileVersionKey({ mtimeMs: 10, size: 20 })).toBe(base);
  });
});

describe("MappedFileCache", () => {
  it("loads once for a stable version and reloads after a version change", async () => {
    let version = { mtimeMs: 1, size: 10 };
    let loads = 0;
    const cache = new MappedFileCache<string>({
      maxEntries: 4,
      version: async () => version,
      load: async () => {
        loads += 1;
        return `v${version.mtimeMs}`;
      },
      validate: (value) => String(value),
    });
    expect(await cache.get("x")).toBe("v1");
    expect(await cache.get("x")).toBe("v1");
    expect(loads).toBe(1);
    version = { mtimeMs: 2, size: 10 };
    expect(await cache.get("x")).toBe("v2");
    expect(loads).toBe(2);
  });

  it("coalesces concurrent loads of the same path into one read", async () => {
    let loads = 0;
    const gate = Promise.withResolvers<void>();
    const cache = new MappedFileCache<string>({
      maxEntries: 4,
      version: async () => ({ mtimeMs: 5, size: 5 }),
      load: async () => {
        loads += 1;
        await gate.promise;
        return "value";
      },
      validate: (value) => String(value),
    });
    const first = cache.get("y");
    const second = cache.get("y");
    gate.resolve();
    expect(await first).toBe("value");
    expect(await second).toBe("value");
    expect(loads).toBe(1);
  });
  it("evicts the least recently used entry beyond maxEntries", async () => {
    const cache = new MappedFileCache<number>({
      maxEntries: 2,
      version: async () => ({ mtimeMs: 0, size: 0 }),
      load: async (key) => key.length,
      validate: (value) => Number(value),
    });
    await cache.get("aa");
    await cache.get("bb");
    await cache.get("aa");
    await cache.get("cc");
    expect(cache.size).toBeLessThanOrEqual(2);
  });
});

describe("GET /api/map/manifest", () => {
  it("serves a slim manifest that still validates against DatasetManifestSchema", async () => {
    const response = await GET(manifestRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as unknown;
    const parsed = DatasetManifestSchema.parse(body);
    expect(parsed.tiles).toHaveLength(3);
    expect(parsed.tileCount).toBe(3);
    expect(parsed.bounds).toEqual([0, 0, 3, 3]);
    expect(parsed.datasetVersion).toBe("9.9.9");
    const tileKeys = new Set(Object.keys(parsed.tiles![0]!));
    expect([...tileKeys].sort()).toEqual(["bounds", "byteSize", "featureCount", "lod", "tileId"]);
  });

  it("omits the duplicated fat fields from the wire body", async () => {
    const response = await GET(manifestRequest());
    const raw = (await response.text()) as unknown as Record<string, unknown>;
    expect(raw.tileIds).toBeUndefined();
    expect(raw.tileBounds).toBeUndefined();
    expect(raw.byteSizes).toBeUndefined();
    expect(raw.tileFeatureCounts).toBeUndefined();
  });

  it("sets Cache-Control max-age=60, ETag equal to datasetVersion and X-Dataset-Version", async () => {
    const response = await GET(manifestRequest());
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(response.headers.get("etag")).toBe("9.9.9");
    expect(response.headers.get("x-dataset-version")).toBe("9.9.9");
  });

  it("answers 304 when If-None-Match matches the dataset version", async () => {
    const response = await GET(manifestRequest({ "if-none-match": "9.9.9" }));
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("reads the tile manifest once across repeated requests for a stable mtime", async () => {
    await GET(manifestRequest());
    const first = (await (await GET(manifestRequest())).json()) as { tiles: unknown[] };
    const second = (await (await GET(manifestRequest())).json()) as { tiles: unknown[] };
    expect(second).toEqual(first);
  });

  it("rejects a tile manifest entry with an unsafe tile id", async () => {
    const bad = [{ tileId: "../etc", lod: 0, bounds: [0, 0, 1, 1], featureCount: 1, byteSize: 10, features: ["x"] }];
    await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify(bad), "utf8");
    resetManifestCache();
    const response = await GET(manifestRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "DATASET_INVALID", code: "DATASET_INVALID" });
  });

  it("rejects a tile manifest that is not an array", async () => {
    await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify({ nope: true }), "utf8");
    resetManifestCache();
    const response = await GET(manifestRequest());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "DATASET_INVALID", code: "DATASET_INVALID" });
  });

  it("answers 503 when the dataset is missing", async () => {
    process.env.MASTER_MAPS_DATA_DIR = `${dataRoot}-missing`;
    resetManifestCache();
    const response = await GET(manifestRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
  });
});

describe("parseTileManifestList", () => {
  it("throws for a non array", () => {
    expect(() => parseTileManifestList({})).toThrow();
  });

  it("throws for an entry that violates TileManifestSchema", () => {
    expect(() => parseTileManifestList([{ tileId: "a" }])).toThrow();
  });

  it("returns parsed entries for a valid list", () => {
    const parsed = parseTileManifestList(TILE_MANIFEST);
    for (const entry of parsed) expect(TileManifestSchema.safeParse(entry).success).toBe(true);
  });
});
