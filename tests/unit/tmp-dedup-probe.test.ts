import { describe, expect, it } from "vitest";
import { deduplicateFeatures } from "../../scripts/data/deduplicate";
import { MapFeatureSchema, type Geometry, type MapFeature } from "@/lib/data/schema";

const SOURCE_TIMESTAMP = "2026-01-01T00:00:00Z";

function feature(kind: string, stableId: string, source: string, geometry: Geometry, extra: Record<string, unknown> = {}): MapFeature {
  return MapFeatureSchema.parse({
    kind,
    stableId,
    geometry,
    localGeometry: geometry,
    x: 0,
    z: 0,
    confidence: "high",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: source, contenders: [source], priority: 1, timestamp: SOURCE_TIMESTAMP }],
    sourceRefs: [{ source, timestamp: SOURCE_TIMESTAMP }],
    ...extra,
  });
}

const square = (minX: number, minZ: number, maxX: number, maxZ: number): Geometry => ({
  type: "Polygon",
  coordinates: [[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ]]],
});

const centred = (minX: number, minZ: number, maxX: number, maxZ: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  x: (minX + maxX) / 2,
  z: (minZ + maxZ) / 2,
  ...extra,
});

describe("probe", () => {
  it("building horizon pair", () => {
    const first = feature("building", "osm:way/300", "osm", square(0, 0, 20, 20), centred(0, 0, 20, 20));
    const partner = feature("building", "ign-bdtopo:building/300", "IGN BD TOPO", square(0.5, 100.5, 19.5, 119.5), centred(0, 0, 20, 20));
    console.log("A", first.x, first.z, partner.x, partner.z);
    console.log("A merged", deduplicateFeatures([first, partner]).length);
    const pa = feature("building", "osm:way/301", "osm", square(0, 0, 20, 20), centred(0, 0, 20, 20));
    const pb = feature("building", "ign-bdtopo:building/301", "IGN BD TOPO", square(0.5, 100.5, 19.5, 119.5), centred(10, 110, 10, 110));
    console.log("B", pa.x, pa.z, pb.x, pb.z);
    console.log("B merged", deduplicateFeatures([pa, pb]).length);
    const oa = feature("road", "osm:way/310", "osm", { type: "LineString", coordinates: [[0, 95], [40, 95.4]] }, centred(0, 95, 40, 95.4, { name: "Rue du Port", roadClass: "residential", highway: "residential" }));
    const ob = feature("road", "ign-bdtopo:road/310", "IGN BD TOPO", { type: "LineString", coordinates: [[0, 100.2], [40, 100.6]] }, centred(0, 95, 40, 95.4, { name: "Rue du Port" }));
    console.log("C", oa.x, oa.z, ob.x, ob.z);
    console.log("C merged", deduplicateFeatures([oa, ob]).length);
    const ca = feature("road", "osm:way/311", "osm", { type: "LineString", coordinates: [[0, 95], [40, 95.4]] }, centred(0, 95, 40, 95.4, { name: "Rue du Port", roadClass: "residential", highway: "residential" }));
    const cb = feature("road", "ign-bdtopo:road/311", "IGN BD TOPO", { type: "LineString", coordinates: [[0, 100.2], [40, 100.6]] }, centred(0, 100, 40, 100, { name: "Rue du Port" }));
    console.log("D", ca.x, ca.z, cb.x, cb.z);
    console.log("D merged", deduplicateFeatures([ca, cb]).length);
    expect(true).toBe(true);
  });
});
