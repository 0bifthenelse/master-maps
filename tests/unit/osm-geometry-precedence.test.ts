import { describe, expect, it } from "vitest";
import { deduplicateFeatures } from "../../scripts/data/deduplicate";
import { MapFeatureSchema, type Geometry } from "@/lib/data/schema";

const timestamp = "2026-01-01T00:00:00Z";
const osmGeometry: Geometry = {
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
};
const bdtopoGeometry: Geometry = {
  type: "Polygon",
  coordinates: [[[0.5, 0.5], [9.5, 0.5], [9.5, 9.5], [0.5, 9.5], [0.5, 0.5]]],
};

function feature(stableId: string, source: string, geometry: Geometry, lon: number, lat: number, x: number, z: number) {
  return MapFeatureSchema.parse({
    kind: "building",
    stableId,
    sourceId: stableId,
    geometry,
    localGeometry: geometry,
    sourceGeometry: geometry,
    lon,
    lat,
    x,
    z,
    confidence: "high",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: source, contenders: [source], priority: 1, timestamp }],
    sourceRefs: [{ source, timestamp }],
  });
}

describe("Auch OSM geometry precedence", () => {
  it("uses usable osm-auch geometry and its anchor over BD TOPO", () => {
    const osm = feature("osm-auch:way/1", "osm-auch", osmGeometry, 1, 2, 100, 200);
    const bdtopo = feature("ign-bdtopo:building/1", "IGN BD TOPO", bdtopoGeometry, 3, 4, 102, 202);
    const [merged] = deduplicateFeatures([bdtopo, osm]);

    expect(merged?.geometry).toEqual(osmGeometry);
    expect(merged?.sourceGeometry).toEqual(osmGeometry);
    expect(merged?.lon).toBe(1);
    expect(merged?.lat).toBe(2);
    expect(merged?.x).toBe(100);
    expect(merged?.z).toBe(200);
    expect(merged?.provenance.some((record) => record.property === "geometry" && record.winner === "osm-auch" && record.priority === 110)).toBe(true);
  });
  it("rejects degenerate OSM polygon rings before precedence", () => {
    const valid = feature("osm-auch:way/2", "osm-auch", osmGeometry, 1, 2, 100, 200);
    const degenerate = {
      ...valid,
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] },
      localGeometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]] },
    };

    expect(MapFeatureSchema.safeParse(degenerate).success).toBe(false);
  });
});
