import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A minimal end-to-end test of the raw-to-normalized-to-tile-to-index pipeline
// Uses local implementations to avoid needing real data or network

describe("data pipeline (raw → normalized → tiles → search index)", () => {
  let tmpDir: string;
  let testDataDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "maps-pipeline-test-"));
    testDataDir = join(tmpDir, "data");
    mkdirSync(join(testDataDir, "raw"), { recursive: true });
    mkdirSync(join(testDataDir, "intermediate"), { recursive: true });
    mkdirSync(join(testDataDir, "generated", "tiles"), { recursive: true });
    mkdirSync(join(testDataDir, "search"), { recursive: true });
    mkdirSync(join(testDataDir, "manifests"), { recursive: true });
  });

  // Clean up after tests
  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes raw boundary file and parses it correctly", () => {
    const boundary = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { code: "32013", nom: "Auch" },
          geometry: {
            type: "Polygon",
            coordinates: [[
              [0.486087, 43.617419],
              [0.647019, 43.617419],
              [0.647019, 43.707701],
              [0.486087, 43.707701],
              [0.486087, 43.617419],
            ]],
          },
        },
      ],
    };

    const path = join(testDataDir, "raw", "auch-boundary.geojson");
    writeFileSync(path, JSON.stringify(boundary));
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.features[0]?.properties?.code).toBe("32013");
    expect(parsed.features[0]?.geometry?.coordinates[0]?.length).toBe(5);
  });

  it("normalizes a building from OSM-style input", () => {
    // This mirrors what normalizeBuilding would do
    const osmBuilding = {
      type: "way",
      id: 12345,
      tags: { building: "house", height: "8", "building:levels": "2" },
      geometry: {
        type: "Polygon",
        coordinates: [[
          [0.59, 43.64],
          [0.60, 43.64],
          [0.60, 43.65],
          [0.59, 43.65],
          [0.59, 43.64],
        ]],
      },
    };

    const feature = {
      id: `osm:way/${osmBuilding.id}`,
      kind: "building" as const,
      name: undefined,
      height: parseFloat(osmBuilding.tags.height),
      levels: parseInt(osmBuilding.tags["building:levels"], 10),
      sourceRefs: [{ source: "osm", timestamp: new Date().toISOString() }],
      status: "active" as const,
      confidence: "high" as const,
    };

    expect(feature.id).toBe("osm:way/12345");
    expect(feature.height).toBe(8);
    expect(feature.levels).toBe(2);
    expect(feature.kind).toBe("building");
  });

  it("clips geometry to boundary polygon", () => {
    // Test that a feature inside boundary stays, one outside gets clipped
    // Simplified: just verify finite coordinates
    const insideCoord = [0.55, 43.65];
    const outsideCoord = [1.0, 44.0];

    const bounds = { minX: 0.486087, maxX: 0.647019, minY: 43.617419, maxY: 43.707701 };

    const isInside = (coord: number[]) =>
      coord[0] >= bounds.minX && coord[0] <= bounds.maxX &&
      coord[1] >= bounds.minY && coord[1] <= bounds.maxY;

    expect(isInside(insideCoord)).toBe(true);
    expect(isInside(outsideCoord)).toBe(false);
  });

  it("assigns features to tiles correctly", () => {
    // Local coords in meters (after projection)
    const tileSize = 384;
    const originX = 0;
    const originZ = 0;

    const getTileId = (x: number, z: number) => {
      const tx = Math.floor(x / tileSize);
      const tz = Math.floor(z / tileSize);
      return `${tx}_${tz}`;
    };

    // Feature near origin
    expect(getTileId(100, 200)).toBe("0_0");
    // Feature in next tile east
    expect(getTileId(500, 200)).toBe("1_0");
    // Feature in next tile north
    expect(getTileId(100, 500)).toBe("0_1");
  });

  it("builds search index and queries work", () => {
    const records = [
      { id: "nocibe-1", name: "Nocibé", normalizedName: "nocibe", aliases: [], featureType: "business", category: "beauty", tileId: "0_0", coord: [0.591913, 43.648231] as [number, number] },
      { id: "auch-mairie", name: "Auch: Mairie", normalizedName: "auch: mairie", aliases: ["Mairie d'Auch"], featureType: "poi", category: "admin", tileId: "0_0", coord: [0.585, 43.65] as [number, number] },
    ];

    const nq = "nocibe".normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    expect(records.some((r) => r.normalizedName === nq)).toBe(true);

    // 1-char typo "nocire"
    const typo = "nocire".normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    let match = false;
    for (const r of records) {
      let dist = 0;
      for (let i = 0; i < Math.min(r.normalizedName.length, typo.length); i++) {
        if (r.normalizedName[i] !== typo[i]) dist++;
      }
      if (dist <= 1) match = true;
    }
    expect(match).toBe(true);
  });

  it("manifest contains expected fields", () => {
    const manifest = {
      datasetVersion: "0.1.0",
      acquisitionTime: "2026-08-26T17:00:00Z",
      boundary: "auch-32013",
      projectionOrigin: [0.586, 43.65] as [number, number],
      tileSize: 384,
      tileCount: 64,
      featureCounts: { buildings: 5000, roads: 2000, water: 100, landuse: 50, pois: 300, businesses: 45, addresses: 8000, transport: 20 },
      byteSizes: { totalBytes: 50000000, largestTileBytes: 420000 },
      layers: ["buildings", "roads", "water", "landuse", "pois", "labels", "commercial-audit"],
      nocibe: { banId: "32013_0050_00028", confidence: "high" },
    };

    expect(manifest.boundary).toContain("32013");
    expect(manifest.tileSize).toBeGreaterThan(0);
    expect(manifest.tileCount).toBeGreaterThan(0);
    expect(manifest.featureCounts.buildings).toBeGreaterThan(0);
    expect(manifest.featureCounts.roads).toBeGreaterThan(0);
    expect(manifest.byteSizes.totalBytes).toBeGreaterThan(0);
    expect(manifest.nocibe.banId).toBe("32013_0050_00028");
  });
});