import { describe, expect, it } from "vitest";
import { deduplicateFeatures } from "../../scripts/data/deduplicate";
import { MapFeatureSchema, type Geometry, type MapFeature } from "@/lib/data/schema";

const sourceTimestamp = "2026-01-01T00:00:00Z";

function feature(kind: string, stableId: string, source: string, geometry: Geometry, extra: Record<string, unknown> = {}): MapFeature {
  return MapFeatureSchema.parse({
    kind,
    stableId,
    geometry,
    localGeometry: geometry,
    x: 5,
    z: 5,
    confidence: "high",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: source, contenders: [source], priority: 1, timestamp: sourceTimestamp }],
    sourceRefs: [{ source, timestamp: sourceTimestamp }],
    ...extra,
  });
}

const square = (minX: number, minZ: number, maxX: number, maxZ: number): Geometry => ({
  type: "Polygon",
  coordinates: [[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ]]],
});

describe("metric cross-source conflation", () => {
  it("merges overlapping buildings and keeps the BD TOPO geometry winner", () => {
    const osm = feature("building", "osm:way/1", "osm", square(0, 0, 10, 10), { x: 5, z: 5 });
    const ign = feature("building", "ign-bdtopo:building/1", "IGN BD TOPO", square(0.5, 0.5, 9.5, 9.5), { x: 5, z: 5 });
    const result = deduplicateFeatures([osm, ign]);
    expect(result).toHaveLength(1);
    expect(result[0]?.stableId).toBe(ign.stableId);
    expect(result[0]?.sourceRefs.map((ref) => ref.source)).toEqual(expect.arrayContaining(["osm", "IGN BD TOPO"]));
  });

  it("does not merge nearby parallel roads", () => {
    const first = feature("road", "osm:way/1", "osm", { type: "LineString", coordinates: [[0, 0], [100, 0]] }, { roadClass: "residential", highway: "residential", name: "Rue A", x: 50, z: 0 });
    const second = feature("road", "IGN BD TOPO:road/1", "IGN BD TOPO", { type: "LineString", coordinates: [[0, 10], [100, 10]] }, { roadClass: "residential", highway: "residential", name: "Rue B", x: 50, z: 10 });
    expect(deduplicateFeatures([first, second])).toHaveLength(2);
  });

  it("does not conflate a water surface with a centerline", () => {
    const surface = feature("water", "ign-bdtopo:surface/1", "IGN BD TOPO", square(0, 0, 20, 20), { waterType: "Ecoulement naturel", isSurface: true, x: 10, z: 10 });
    const line = feature("water", "osm:way/2", "osm", { type: "LineString", coordinates: [[0, 10], [20, 10]] }, { waterType: "river", x: 10, z: 10 });
    expect(deduplicateFeatures([surface, line])).toHaveLength(2);
  });

  it("prefers exact SIRET business identity", () => {
    const first = feature("business", "business:siret/123", "sirene", { type: "Point", coordinates: [5, 5] }, { businessName: "Example", siret: "123", address: "1 Rue A", x: 5, z: 5 });
    const second = feature("business", "business:osm/node/4", "osm", { type: "Point", coordinates: [5.0001, 5.0001] }, { businessName: "Different label", siret: "123", address: "1 Rue A", x: 5, z: 5 });
    expect(deduplicateFeatures([first, second])).toHaveLength(1);
  });
});
