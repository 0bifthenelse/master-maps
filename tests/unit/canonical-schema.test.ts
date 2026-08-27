import { describe, expect, it } from "vitest";
import { MapFeatureSchema, MultiPolygonSchema, PolygonSchema, RingSchema, TileDataSchema } from "@/lib/data/schema";

const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]] as [number, number][];
const source = { source: "fixture", timestamp: "2026-01-01T00:00:00Z" };
const provenance = [{ featureId: "building/1", property: "geometry", winner: "fixture", contenders: ["fixture"], priority: 1, timestamp: source.timestamp }];

function buildingFeature() {
  return MapFeatureSchema.parse({
    kind: "building",
    stableId: "building/1",
    geometry: { type: "Polygon", coordinates: [outer] },
    localGeometry: { type: "Polygon", coordinates: [outer] },
    confidence: "high",
    status: "active",
    sourceRefs: [source],
    provenance,
  });
}

describe("canonical geometry schemas", () => {
  it("rejects open, short, and zero-area rings", () => {
    expect(RingSchema.safeParse([[0, 0], [1, 0], [0, 0]]).success).toBe(false);
    expect(RingSchema.safeParse([[0, 0], [1, 0], [1, 1], [0, 0]]).success).toBe(true);
    expect(RingSchema.safeParse([[0, 0], [1, 0], [2, 0], [0, 0]]).success).toBe(false);
  });

  it("requires holes to be closed and inside the exterior", () => {
    const hole = [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]] as [number, number][];
    expect(PolygonSchema.safeParse({ type: "Polygon", coordinates: [outer, hole] }).success).toBe(true);
    expect(PolygonSchema.safeParse({ type: "Polygon", coordinates: [outer, [[20, 20], [21, 20], [21, 21], [20, 20]]] }).success).toBe(false);
  });

  it("preserves complete MultiPolygon component and hole structure", () => {
    const result = MultiPolygonSchema.parse({ type: "MultiPolygon", coordinates: [[outer, [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]], [[[20, 20], [21, 20], [21, 21], [20, 20]]]] });
    expect(result.coordinates).toHaveLength(2);
    expect(result.coordinates[0]).toHaveLength(2);
  });

  it("rejects numeric confidence and unknown feature fields", () => {
    const valid = buildingFeature();
    expect(MapFeatureSchema.safeParse({ ...valid, confidence: 0.9 }).success).toBe(false);
    expect(MapFeatureSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
  });

  it("validates tile envelopes and feature fragments", () => {
    const feature = buildingFeature();
    const tile = TileDataSchema.parse({
      manifest: { tileId: "l0_0_0", lod: 0, bounds: [0, 0, 10, 10], featureCount: 1, byteSize: 1, features: [feature.stableId], fragmentIds: ["building/1@l0_0_0"] },
      features: [{ ...feature, fragmentId: "building/1@l0_0_0", parentStableId: feature.stableId, fragmentOf: feature.stableId }],
    });
    expect(tile.features[0]?.fragmentId).toBe("building/1@l0_0_0");
  });
});
