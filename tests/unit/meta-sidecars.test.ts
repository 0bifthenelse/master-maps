import { gunzipSync, gzipSync } from "node:zlib";
import { readFile, readdir, stat, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET, resetTileRouteCache } from "../../app/api/map/tile/[tileId]/route";
import { TileMetaDataSchema, TileDataSchema, TileMetaFeatureSchema, type TileMetaFeature } from "@/lib/data/schema";
import { buildTilesAll } from "../../scripts/data/build-tiles";
import { MapFeatureSchema, type MapFeature } from "@/lib/data/schema";
import { decodeRenderTile } from "@/lib/render/codec";

const DATASET_VERSION = "9.9.9";
const MANIFEST = JSON.stringify({ datasetVersion: DATASET_VERSION });

const CANONICAL_FEATURES: MapFeature[] = [
  {
    stableId: "osm:way/1",
    kind: "road",
    geometry: { type: "LineString", coordinates: [[0, 0], [100, 0], [200, 0]] },
    localGeometry: { type: "LineString", coordinates: [[0, 0], [100, 0], [200, 0]] },
    sourceGeometry: { type: "LineString", coordinates: [[0, 0], [100, 0], [200, 0]] },
    roadClass: "residential",
    name: "Rue de test",
    lon: 0.5,
    lat: 43.6,
    x: 10,
    z: 20,
    names: ["Rue de test"],
    displayName: "Rue de test",
    address: "10 rue de test",
    confidence: "high",
    status: "active",
    sourceRefs: [{ source: "IGN BD TOPO", timestamp: "2026-01-01" }],
    sourceMetadata: { persistance: "Permanent" },
    fragmentId: "osm:way/1@l0_0_0",
  },
  {
    stableId: "bdtopo:batiment/2",
    kind: "building",
    geometry: { type: "Polygon", coordinates: [[[300, 300], [300, 320], [320, 320], [320, 300], [300, 300]]] },
    localGeometry: { type: "Polygon", coordinates: [[[300, 300], [300, 320], [320, 320], [320, 300], [300, 300]]] },
    height: 9,
    lon: 0.7,
    lat: 43.7,
    x: 310,
    z: 310,
    sourceRefs: [{ source: "IGN BD TOPO", timestamp: "2026-01-01" }],
    provenance: [{ featureId: "bdtopo:batiment/2", property: "height", winner: "IGN BD TOPO", contenders: ["IGN BD TOPO"], priority: 1, timestamp: "2026-01-01" }],
  },
] as unknown as MapFeature[];

function tileParams(tileId: string): { params: Promise<{ tileId: string }> } {
  return { params: Promise.resolve({ tileId }) };
}

function tileRequest(tileId: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3000/api/map/tile/${tileId}`, { headers });
}

let dataRoot = "";
let previousDataDir: string | undefined;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "master-maps-meta-"));
  await mkdir(join(dataRoot, "generated", "tiles"), { recursive: true });
  await mkdir(join(dataRoot, "generated", "meta"), { recursive: true });
  await writeFile(join(dataRoot, "generated", "manifest.json"), MANIFEST, "utf8");
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

async function writeMetaFixture(tileId: string, features: Record<string, unknown>[], byteSize: number): Promise<void> {
  await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify([
    { tileId, lod: 0, bounds: [0, 0, 2048, 2048], featureCount: features.length, byteSize },
  ]), "utf8");
  await writeFile(join(dataRoot, "generated", "meta", `${tileId}.json.gz`), gzipSync(Buffer.from(JSON.stringify(features), "utf8"), { level: 9 }));
}

describe("TileMetaFeatureSchema", () => {
  it("accepts a canonical record with every geometry field removed", () => {
    const { geometry, localGeometry, sourceGeometry, ...meta } = CANONICAL_FEATURES[0]!;
    void geometry;
    void localGeometry;
    void sourceGeometry;
    const parsed = TileMetaFeatureSchema.parse(meta);
    expect(parsed.stableId).toBe("osm:way/1");
    expect(parsed).not.toHaveProperty("geometry");
    expect(parsed).not.toHaveProperty("localGeometry");
    expect(parsed).not.toHaveProperty("sourceGeometry");
  });

  it("keeps every inspector field the FeatureInspector renders", () => {
    const { geometry, localGeometry, sourceGeometry, ...meta } = CANONICAL_FEATURES[0]!;
    void geometry;
    void localGeometry;
    void sourceGeometry;
    const parsed = TileMetaFeatureSchema.parse(meta) as TileMetaFeature;
    expect(parsed.name).toBe("Rue de test");
    expect(parsed.displayName).toBe("Rue de test");
    expect(parsed.address).toBe("10 rue de test");
    expect(parsed.lon).toBe(0.5);
    expect(parsed.lat).toBe(43.6);
    expect(parsed.x).toBe(10);
    expect(parsed.z).toBe(20);
    expect(parsed.confidence).toBe("high");
    expect(parsed.status).toBe("active");
    expect(parsed.sourceRefs).toHaveLength(1);
    expect(parsed.sourceMetadata).toEqual({ persistance: "Permanent" });
    expect(parsed.fragmentId).toBe("osm:way/1@l0_0_0");
  });

  it("still rejects a geometry-less record that violates a kind invariant", () => {
    const { geometry, localGeometry, sourceGeometry, ...meta } = CANONICAL_FEATURES[0]!;
    void geometry;
    void localGeometry;
    void sourceGeometry;
    expect(TileMetaFeatureSchema.safeParse({ ...meta, sourceRefs: "nope" }).success).toBe(false);
  });

  it("rejects a record that still carries a geometry field under a strict object", () => {
    const feature = MapFeatureSchema.parse(CANONICAL_FEATURES[0]);
    expect(TileMetaFeatureSchema.safeParse(feature).success).toBe(false);
  });

  it("keeps MapFeatureSchema requiring full geometry", () => {
    const { geometry, localGeometry, sourceGeometry, ...meta } = CANONICAL_FEATURES[0]!;
    void geometry;
    void localGeometry;
    void sourceGeometry;
    expect(MapFeatureSchema.safeParse(meta).success).toBe(false);
  });
});

describe("GET /api/map/tile/[tileId] meta sidecar", () => {
  it("serves the geometry-stripped envelope with the gzip encoding header", async () => {
    const { geometry, localGeometry, sourceGeometry, ...meta } = CANONICAL_FEATURES[0]!;
    void geometry;
    void localGeometry;
    void sourceGeometry;
    await writeMetaFixture("l0_0_0", [meta], 4096);
    const response = await GET(tileRequest("l0_0_0"), tileParams("l0_0_0"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as unknown;
    const parsed = TileMetaDataSchema.parse(body);
    expect(parsed.manifest.tileId).toBe("l0_0_0");
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0]?.stableId).toBe("osm:way/1");
  });

  it("answers 304 on If-None-Match without a body", async () => {
    const { geometry, ...rest } = CANONICAL_FEATURES[0]!;
    const { localGeometry, sourceGeometry, ...meta } = rest;
    void geometry;
    void localGeometry;
    void sourceGeometry;
    await writeMetaFixture("l0_0_0", [meta], 4096);
    const response = await GET(tileRequest("l0_0_0", { "if-none-match": DATASET_VERSION }), tileParams("l0_0_0"));
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
  });

  it("falls back to a legacy fat JSON tile when no sidecar exists", async () => {
    await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify([
      { tileId: "l0_0_0", lod: 0, bounds: [0, 0, 2048, 2048], featureCount: 2, byteSize: 5000 },
    ]), "utf8");
    await writeFile(join(dataRoot, "generated", "tiles", "l0_0_0.json"), JSON.stringify(CANONICAL_FEATURES), "utf8");
    const response = await GET(tileRequest("l0_0_0"), tileParams("l0_0_0"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    const parsed = TileDataSchema.parse((await response.json()) as unknown);
    expect(parsed.features).toHaveLength(2);
  });

  it("answers 503 when neither the sidecar nor a legacy tile exists", async () => {
    await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify([
      { tileId: "l0_0_0", lod: 0, bounds: [0, 0, 2048, 2048], featureCount: 0, byteSize: 0 },
    ]), "utf8");
    const response = await GET(tileRequest("l0_0_0"), tileParams("l0_0_0"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
  });

  it("answers 503 for a sidecar whose tile is absent from the tile manifest", async () => {
    await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify([
      { tileId: "l0_0_0", lod: 0, bounds: [0, 0, 2048, 2048], featureCount: 0, byteSize: 0 },
    ]), "utf8");
    await writeFile(join(dataRoot, "generated", "meta", "l9_9_9.json.gz"), gzipSync(Buffer.from("[]", "utf8")));
    const response = await GET(tileRequest("l9_9_9"), tileParams("l9_9_9"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
  });

  it("rejects an oversized sidecar with 413", async () => {
    const payload = "[" + Array.from({ length: 250_000 }, (_value, index) => JSON.stringify({ stableId: `x${"y".repeat(20)}${index}`, kind: "poi", poiType: "peak", names: [], confidence: "medium", status: "active", provenance: [], sourceRefs: [] })).join(",") + "]";
    await writeFile(join(dataRoot, "generated", "tile-manifest.json"), JSON.stringify([
      { tileId: "l0_0_0", lod: 0, bounds: [0, 0, 2048, 2048], featureCount: 250_000, byteSize: 4_000_000 },
    ]), "utf8");
    await writeFile(join(dataRoot, "generated", "meta", "l0_0_0.json.gz"), gzipSync(Buffer.from(payload, "utf8"), { level: 0 }));
    const onDisk = (await stat(join(dataRoot, "generated", "meta", "l0_0_0.json.gz"))).size;
    expect(onDisk).toBeGreaterThan(2 * 1024 * 1024);
    const response = await GET(tileRequest("l0_0_0"), tileParams("l0_0_0"));
    expect(response.status).toBe(413);
  });

  it("rejects a traversing tile id", async () => {
    const response = await GET(tileRequest(".."), tileParams(".."));
    expect(response.status).toBe(400);
  });
});

describe("build-tiles meta emission", () => {
  it("writes slim meta sidecars and no fat JSON tiles by default", async () => {
    const intermediate = join(dataRoot, "intermediate");
    await mkdir(intermediate, { recursive: true });
    await writeFile(join(intermediate, "features.json"), JSON.stringify(CANONICAL_FEATURES), "utf8");
    await writeFile(join(intermediate, "boundary.json"), JSON.stringify([{
      stableId: "boundary:32",
      kind: "boundary",
      territoryCode: "32",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 4000], [4000, 4000], [4000, 0], [0, 0]]] },
      localGeometry: { type: "Polygon", coordinates: [[[0, 0], [0, 4000], [4000, 4000], [4000, 0], [0, 0]]] },
      lon: 0.5,
      lat: 43.6,
      x: 2000,
      z: 2000,
    }]), "utf8");
    const tilesDir = join(dataRoot, "generated", "tiles");
    const renderDir = join(dataRoot, "generated", "render");
    const metaDir = join(dataRoot, "generated", "meta");
    await buildTilesAll(intermediate, tilesDir, 2048, renderDir, "9.9.9", metaDir, false);
    const metaFiles = (await readdir(metaDir)).filter((name) => name.endsWith(".json.gz"));
    const jsonFiles = (await readdir(tilesDir)).filter((name) => name.endsWith(".json"));
    const renderFiles = (await readdir(renderDir)).filter((name) => name.endsWith(".mmt"));
    expect(metaFiles.length).toBeGreaterThan(0);
    expect(jsonFiles).toEqual([]);
    expect(renderFiles.length).toBeGreaterThan(0);
    const manifest = JSON.parse(await readFile(join(dataRoot, "generated", "tile-manifest.json"), "utf8")) as Array<{ tileId: string }>;
    for (const entry of manifest) {
      expect(metaFiles).toContain(`${entry.tileId}.json.gz`);
      const decoded = decodeRenderTile((await readFile(join(renderDir, `${entry.tileId}.mmt`))).buffer as ArrayBuffer);
      expect(decoded.header.tileId).toBe(entry.tileId);
    }
  }, 120_000);

  it("strips exactly the three geometry fields and nothing else", async () => {
    const intermediate = join(dataRoot, "intermediate");
    await mkdir(intermediate, { recursive: true });
    await writeFile(join(intermediate, "features.json"), JSON.stringify(CANONICAL_FEATURES), "utf8");
    await writeFile(join(intermediate, "boundary.json"), JSON.stringify([{
      stableId: "boundary:32",
      kind: "boundary",
      territoryCode: "32",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 4000], [4000, 4000], [4000, 0], [0, 0]]] },
      localGeometry: { type: "Polygon", coordinates: [[[0, 0], [0, 4000], [4000, 4000], [4000, 0], [0, 0]]] },
      lon: 0.5,
      lat: 43.6,
      x: 2000,
      z: 2000,
    }]), "utf8");
    const tilesDir = join(dataRoot, "generated", "tiles");
    const renderDir = join(dataRoot, "generated", "render");
    const metaDir = join(dataRoot, "generated", "meta");
    await buildTilesAll(intermediate, tilesDir, 2048, renderDir, "9.9.9", metaDir, true);
    const jsonFiles = (await readdir(tilesDir)).filter((name) => name.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThan(0);
    let fatTotal = 0;
    let metaTotal = 0;
    for (const name of jsonFiles) {
      const tileId = name.slice(0, -".json".length);
      const fat = (await stat(join(tilesDir, name))).size;
      const meta = (await stat(join(metaDir, `${tileId}.json.gz`))).size;
      fatTotal += fat;
      metaTotal += meta;
      const parsed = JSON.parse(gunzipSync(await readFile(join(metaDir, `${tileId}.json.gz`))).toString("utf8")) as unknown[];
      for (const feature of parsed) {
        expect(feature).not.toHaveProperty("geometry");
        expect(feature).not.toHaveProperty("localGeometry");
        expect(feature).not.toHaveProperty("sourceGeometry");
      }
    }
    expect(metaTotal).toBeGreaterThan(0);
    expect(fatTotal).toBeGreaterThan(metaTotal);
  }, 120_000);
});
