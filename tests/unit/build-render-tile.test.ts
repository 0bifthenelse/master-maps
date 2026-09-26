import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MapFeatureSchema, type MapFeature } from "@/lib/data/schema";
import { decodeRenderTile, encodeRenderTile, renderLayerIndices, renderLayerPositions, renderLayerRanges, type DecodedRenderLayer, type DecodedRenderTile, type RenderLayerId } from "@/lib/render/codec";
import { DEFAULT_BUILDING_HEIGHT_METRES, buildRenderTile, landuseLayerFor, resolveRoadWidth, roadLayerFor } from "@/lib/render/buildRenderTile";

const BOUNDS: [number, number, number, number] = [0, 0, 2048, 2048];
const TILE_ID = "l0_0_0";

function feature(value: unknown): MapFeature {
  return MapFeatureSchema.parse({ geometry: { type: "Point", coordinates: [0, 0] }, ...value } as Record<string, unknown>);
}

function build(features: MapFeature[], overrides: Partial<Parameters<typeof buildRenderTile>[1]> = {}): DecodedRenderTile {
  const input = buildRenderTile(features, { tileId: TILE_ID, lod: 0, bounds: BOUNDS, datasetVersion: "0.1.0", ...overrides });
  return decodeRenderTile(encodeRenderTile(input));
}

function layer(tile: DecodedRenderTile, id: RenderLayerId): DecodedRenderLayer | undefined {
  return tile.layers.find((candidate) => candidate.id === id);
}

function metaFor(tile: DecodedRenderTile, layerId: RenderLayerId, featureIndex: number): { indices: Uint32Array; positions: Float32Array; ranges: Uint32Array } {
  const found = layer(tile, layerId);
  if (!found) throw new Error(`layer ${layerId} missing`);
  const ranges = renderLayerRanges(tile.payload, found);
  const start = ranges[featureIndex * 3]!;
  const count = ranges[featureIndex * 3 + 1]!;
  const indices = renderLayerIndices(tile.payload, found).slice(start, start + count);
  const positions = renderLayerPositions(tile.payload, found);
  return { indices, positions, ranges };
}

describe("buildRenderTile", () => {
  it("pre-extrudes a building footprint into roof plus wall triangles", () => {
    const tile = build([feature({
      kind: "building",
      stableId: "building/1",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
      height: 12,
    })]);
    const buildings = layer(tile, "buildings");
    expect(buildings).toBeDefined();
    const { indices, positions } = metaFor(tile, "buildings", 0);
    expect(indices.length).toBe(36);
    expect(positions.length / 3).toBe(8);
    const heights = new Set(Array.from({ length: positions.length / 3 }, (_unused, index) => positions[index * 3 + 1]!));
    expect([...heights].sort()).toEqual([0, 12]);
    const topY = Math.max(...Array.from({ length: positions.length / 3 }, (_unused, index) => positions[index * 3 + 1]!));
    expect(topY).toBe(12);
    expect(tile.meta[0]).toEqual({ s: "building/1", k: "building", c: "yes", a: [0, 0], h: 12 });
  });

  it("falls back to the default height and flags the inference", () => {
    const tile = build([feature({
      kind: "building",
      stableId: "building/2",
      fragmentId: "building/2@l0_0_0",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]]] },
      heightInferred: true,
    })]);
    const { positions } = metaFor(tile, "buildings", 0);
    const topY = Math.max(...Array.from({ length: positions.length / 3 }, (_unused, index) => positions[index * 3 + 1]!));
    expect(topY).toBe(DEFAULT_BUILDING_HEIGHT_METRES);
    expect(tile.meta[0]!.s).toBe("building/2@l0_0_0");
    expect(tile.meta[0]!.p).toMatchObject({ heightInferred: true });
  });

  it("tessellates a building footprint with a hole and keeps the ring wall", () => {
    const tile = build([feature({
      kind: "building",
      stableId: "building/3",
      geometry: {
        type: "Polygon",
        coordinates: [
          [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
          [[5, 5], [5, 10], [10, 10], [10, 5], [5, 5]],
        ],
      },
      height: 8,
    })]);
    const { indices, positions } = metaFor(tile, "buildings", 0);
    expect(positions.length / 3).toBe(16);
    expect(indices.length).toBeGreaterThan(6);
  });

  it("splits roads into tunnel, normal, and bridge strata ribbons", () => {
    const road = (stableId: string, extra: Record<string, unknown>): MapFeature => feature({
      kind: "road",
      stableId,
      geometry: { type: "LineString", coordinates: [[0, 0], [100, 0]] },
      roadClass: "residential",
      ...extra,
    });
    const tile = build([road("road/tunnel", { stratum: "tunnel" }), road("road/normal", {}), road("road/bridge", { bridge: true })]);
    expect(tile.layers.map((candidate) => candidate.id)).toEqual(["road_tunnel", "road_normal", "road_bridge"]);
    const normal = metaFor(tile, "road_normal", 0);
    const normalY = new Set(Array.from({ length: normal.positions.length / 3 }, (_unused, index) => normal.positions[index * 3 + 1]!));
    expect([...normalY]).toEqual([0]);
    const bridge = metaFor(tile, "road_bridge", 0);
    const bridgeY = new Set(Array.from({ length: bridge.positions.length / 3 }, (_unused, index) => bridge.positions[index * 3 + 1]!));
    expect([...bridgeY].every((value) => value > 0)).toBe(true);
    const normalZs = Array.from({ length: normal.positions.length / 3 }, (_unused, index) => normal.positions[index * 3 + 2]!);
    expect(Math.abs(Math.min(...normalZs))).toBeCloseTo(2.5, 6);
    expect(tile.meta.filter((entry) => entry.k === "road").map((entry) => entry.w)).toEqual([5, 5, 5]);
  });

  it("honours an explicit road width and the class default table", () => {
    const explicit = build([feature({ kind: "road", stableId: "road/w", geometry: { type: "LineString", coordinates: [[0, 0], [10, 0]] }, roadClass: "residential", width: 20 })]);
    const explicitMeta = explicit.meta[0]!;
    expect(explicitMeta.w).toBe(20);
    const { positions } = metaFor(explicit, "road_normal", 0);
    const zs = Array.from({ length: positions.length / 3 }, (_unused, index) => positions[index * 3 + 2]!);
    expect(Math.min(...zs)).toBeCloseTo(-10, 6);
    expect(Math.max(...zs)).toBeCloseTo(10, 6);
    expect(resolveRoadWidth(feature({ kind: "road", stableId: "road/x", geometry: { type: "Point", coordinates: [0, 0] }, highway: "motorway" }))).toBe(12);
  });

  it("routes water surfaces to water_surface and axes to water_line, skipping fictive axes", () => {
    const tile = build([
      feature({ kind: "water", stableId: "water/lake", geometry: { type: "Polygon", coordinates: [[[0, 0], [40, 0], [40, 40], [0, 40], [0, 0]]] }, isSurface: true }),
      feature({ kind: "water", stableId: "water/river", geometry: { type: "LineString", coordinates: [[0, 0], [80, 0]] }, waterType: "river" }),
      feature({ kind: "water", stableId: "water/fictive", geometry: { type: "LineString", coordinates: [[0, 0], [80, 0]] }, fictiveAxis: true }),
    ]);
    expect(tile.layers.map((candidate) => candidate.id)).toEqual(["water_surface", "water_line"]);
    expect(tile.meta.map((entry) => entry.s)).toEqual(["water/lake", "water/river"]);
    const river = metaFor(tile, "water_line", 0);
    const riverZs = Array.from({ length: river.positions.length / 3 }, (_unused, index) => river.positions[index * 3 + 2]!);
    expect(Math.min(...riverZs)).toBeCloseTo(-5, 6);
    expect(Math.max(...riverZs)).toBeCloseTo(5, 6);
  });

  it("separates habitat landuse from other landuse and triangulates both", () => {
    const tile = build([
      feature({ kind: "landuse", stableId: "landuse/forest", geometry: { type: "Polygon", coordinates: [[[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]]] }, landuseType: "forest" }),
      feature({ kind: "landuse", stableId: "landuse/village", geometry: { type: "Polygon", coordinates: [[[50, 0], [70, 0], [70, 20], [50, 20], [50, 0]]] }, landuseType: "habitat" }),
    ]);
    expect(tile.layers.map((candidate) => candidate.id)).toEqual(["habitat", "landuse"]);
    expect(layer(tile, "landuse")!.positionLength).toBe(2 * 3 * 3);
    expect(layer(tile, "habitat")!.indexLength).toBe(6);
    expect(landuseLayerFor("forest")).toBe("landuse");
    expect(landuseLayerFor("habitat")).toBe("habitat");
    expect(landuseLayerFor("zone_d_habitation")).toBe("habitat");
  });

  it("routes transport areas, lines, and point stops", () => {
    const tile = build([
      feature({ kind: "transport", stableId: "transport/rail", geometry: { type: "LineString", coordinates: [[0, 0], [200, 0]] }, transportType: "rail" }),
      feature({ kind: "transport", stableId: "transport/aero", geometry: { type: "Polygon", coordinates: [[[0, 0], [50, 0], [50, 50], [0, 50], [0, 0]]] }, transportType: "aerodrome" }),
      feature({ kind: "transport", stableId: "transport/stop", geometry: { type: "Point", coordinates: [12, 14] }, transportType: "bus_stop" }),
    ]);
    expect(tile.layers.map((candidate) => candidate.id)).toEqual(["transport_area", "transport_line"]);
    expect(tile.meta.map((entry) => entry.c)).toEqual(["rail", "aerodrome", "bus_stop"]);
    const stop = metaFor(tile, "transport_area", 1);
    expect(stop.indices.length).toBe(0);
    expect(stop.positions.length).toBeGreaterThanOrEqual(6);
    expect(Array.from(stop.positions.slice(-3))).toEqual([12, 2, 14]);
  });

  it("routes structures by geometry into line, area, and point layers", () => {
    const tile = build([
      feature({ kind: "structure", stableId: "structure/pont", structureType: "pont", geometry: { type: "LineString", coordinates: [[0, 0], [60, 0]] }, height: 8 }),
      feature({ kind: "structure", stableId: "structure/reservoir", structureType: "reservoir", geometry: { type: "Polygon", coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] } }),
      feature({ kind: "structure", stableId: "structure/pylone", structureType: "pylone", geometry: { type: "Point", coordinates: [33, 44] } }),
    ]);
    expect(tile.layers.map((candidate) => candidate.id)).toEqual(["structure_line", "structure_area", "structures_point"]);
    const point = metaFor(tile, "structures_point", 0);
    expect(Array.from(point.positions)).toEqual([33, 2, 44]);
    expect(tile.meta[2]!.s).toBe("structure/pylone");
  });

  it("puts poi, business, address, and place in separate point layers", () => {
    const tile = build([
      feature({ kind: "poi", stableId: "poi/1", poiType: "erp:mairie", geometry: { type: "Point", coordinates: [1, 2] }, name: "Mairie" }),
      feature({ kind: "business", stableId: "business/1", businessName: "Boulangerie", geometry: { type: "Point", coordinates: [3, 4] } }),
      feature({ kind: "address", stableId: "address/1", street: "Rue du Gers", housenumber: "12", geometry: { type: "Point", coordinates: [5, 6] } }),
      feature({ kind: "place", stableId: "place/1", placeType: "commune", importance: 4, geometry: { type: "Point", coordinates: [7, 8] } }),
    ]);
    expect(tile.layers.map((candidate) => candidate.id)).toEqual(["poi", "address", "place"]);
    expect(layer(tile, "poi")!.positionLength).toBe(6);
    expect(tile.meta.map((entry) => entry.k)).toEqual(["poi", "business", "address", "place"]);
    expect(tile.meta[0]).toMatchObject({ n: "Mairie", c: "erp:mairie", p: { poiType: "erp:mairie" } });
    expect(tile.meta[3]!.p).toMatchObject({ importance: 4 });
  });

  it("omits the boundary layer when the caller disables it and keeps the meta ordering aligned with ranges", () => {
    const boundary = feature({
      kind: "boundary",
      stableId: "boundary/32",
      territoryCode: "32",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [500, 0], [500, 500], [0, 500], [0, 0]]] },
    });
    const withBoundary = build([boundary]);
    expect(withBoundary.layers.map((candidate) => candidate.id)).toEqual(["boundary"]);
    const withoutBoundary = build([boundary], { includeBoundary: false });
    expect(withoutBoundary.layers).toHaveLength(0);
    expect(withoutBoundary.meta).toEqual([]);
  });

  it("keeps featureRanges contiguous and pointing at the right meta entry for every layer", () => {
    const features: MapFeature[] = [
      feature({ kind: "landuse", stableId: "landuse/1", geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] }, landuseType: "forest" }),
      feature({ kind: "landuse", stableId: "landuse/2", geometry: { type: "Polygon", coordinates: [[[20, 0], [30, 0], [30, 10], [20, 10], [20, 0]]] }, landuseType: "wood" }),
      feature({ kind: "road", stableId: "road/1", geometry: { type: "LineString", coordinates: [[0, 20], [60, 20]] }, roadClass: "track" }),
      feature({ kind: "road", stableId: "road/2", geometry: { type: "LineString", coordinates: [[0, 40], [60, 40]] }, roadClass: "primary", bridge: true }),
    ];
    const tile = build(features);
    expect(tile.layers.map((candidate) => candidate.id)).toEqual(["landuse", "road_normal", "road_bridge"]);
    for (const found of tile.layers) {
      const ranges = renderLayerRanges(tile.payload, found);
      const indices = renderLayerIndices(tile.payload, found);
      const featureCount = found.rangeLength / 3;
      expect(featureCount).toBeGreaterThan(0);
      for (let index = 0; index < featureCount; index += 1) {
        const start = ranges[index * 3]!;
        const count = ranges[index * 3 + 1]!;
        const metaIndex = ranges[index * 3 + 2]!;
        expect(metaIndex).toBeLessThan(tile.meta.length);
        expect(["landuse", "road"]).toContain(tile.meta[metaIndex]!.k);
        expect(count).toBeGreaterThan(0);
        expect(start + count).toBeLessThanOrEqual(indices.length);
        expect(tile.meta[metaIndex]).toBeDefined();
      }
      expect(ranges[(featureCount - 1) * 3]! + ranges[(featureCount - 1) * 3 + 1]!).toBe(indices.length);
    }
    expect(tile.meta.map((entry) => entry.s)).toEqual(["landuse/1", "landuse/2", "road/1", "road/2"]);
  });

  it("classifies road strata consistently with the canonical stratum field", () => {
    const buildRoad = (extra: Record<string, unknown>): Extract<MapFeature, { kind: "road" }> => feature({ kind: "road", stableId: "road/z", geometry: { type: "Point", coordinates: [0, 0] }, ...extra });
    expect(roadLayerFor(buildRoad({ stratum: "bridge" }))).toBe("road_bridge");
    expect(roadLayerFor(buildRoad({ tunnel: true }))).toBe("road_tunnel");
    expect(roadLayerFor(buildRoad({ layer: "1" }))).toBe("road_bridge");
    expect(roadLayerFor(buildRoad({ layer: "-1" }))).toBe("road_tunnel");
    expect(roadLayerFor(buildRoad({}))).toBe("road_normal");
  });

  it("converts and decodes a real LOD0 tile from the generated dataset", () => {
    const tilePath = resolve("data/generated/tiles/l0_137_27_s2_1_1.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(tilePath, "utf8"));
    } catch {
      return;
    }
    expect(Array.isArray(raw)).toBe(true);
    const features = (raw as unknown[]).map((value) => MapFeatureSchema.parse(value));
    const bounds: [number, number, number, number] = [2048 * 137, 2048 * 27, 2048 * 138, 2048 * 28];
    const input = buildRenderTile(features, { tileId: "l0_137_27_s2_1_1", lod: 0, bounds, datasetVersion: "0.1.0" });
    const encoded = encodeRenderTile(input);
    const decoded = decodeRenderTile(encoded);
    expect(decoded.header.tileId).toBe("l0_137_27_s2_1_1");
    expect(decoded.header.bounds).toEqual(bounds);
    const layerIds = decoded.layers.map((candidate) => candidate.id);
    expect(layerIds).toContain("buildings");
    expect(layerIds).toContain("road_normal");
    expect(layerIds).toContain("address");
    for (const [index, found] of decoded.layers.entries()) {
      const source = input.layers.find((candidate) => candidate.id === found.id)!;
      expect(found.positionLength).toBe(source.positions.length);
      expect(found.indexLength).toBe(source.indices.length);
      expect(found.rangeLength).toBe(source.ranges.length);
      expect(Array.from(renderLayerPositions(decoded.payload, found))).toEqual(Array.from(source.positions));
      expect(Array.from(renderLayerIndices(decoded.payload, found))).toEqual(Array.from(source.indices));
    }
    const buildings = decoded.layers.find((candidate) => candidate.id === "buildings")!;
    const buildingRanges = renderLayerRanges(decoded.payload, buildings);
    expect(buildingRanges.length / 3).toBe(features.filter((entry) => entry.kind === "building").length);
    const buildingHeights = new Set<number>();
    const positions = renderLayerPositions(decoded.payload, buildings);
    for (let index = 0; index < positions.length / 3; index += 1) {
      const y = positions[index * 3 + 1]!;
      if (y > 0) buildingHeights.add(y);
    }
    expect(buildingHeights.size).toBeGreaterThan(1);
    expect(encoded.byteLength).toBeGreaterThan(0);
  });
});
