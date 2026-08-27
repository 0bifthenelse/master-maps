import { describe, expect, it } from "vitest";
import { buildTiles, type TileBuildResult } from "../../scripts/data/build-tiles";
import { MapFeatureSchema, type Geometry, type MapFeature } from "@/lib/data/schema";

function feature(stableId: string, geometry: Geometry): MapFeature {
  return MapFeatureSchema.parse({
    kind: stableId.startsWith("water") ? "water" : stableId.startsWith("building") ? "building" : "road",
    stableId,
    geometry,
    localGeometry: geometry,
    x: 0,
    z: 0,
    confidence: "high",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: "fixture", contenders: ["fixture"], priority: 1, timestamp: "2026-01-01T00:00:00Z" }],
    sourceRefs: [{ source: "fixture", timestamp: "2026-01-01T00:00:00Z" }],
    ...(stableId.startsWith("water") ? { waterType: "river" } : stableId.startsWith("building") ? {} : { roadClass: "residential", highway: "residential" }),
  });
}

const line = (stableId: string, coordinates: [number, number][]): MapFeature => feature(stableId, { type: "LineString", coordinates });
const polygon = (stableId: string, coordinates: [number, number][][]): MapFeature => feature(stableId, { type: "Polygon", coordinates });

function allFragmentIds(result: TileBuildResult): string[] {
  return [...result.tileMap.values()].flatMap((items) => items.map((item) => item.fragmentId ?? item.stableId));
}

describe("tile spatial fragmentation", () => {
  it("fragments a line across one, two, and several tile boundaries", async () => {
    const result = await buildTiles([line("road:crossing", [[-5, 5], [25, 5]])], 10, 0, 0);
    expect(result.tileMap.size).toBe(4);
    expect([...result.tileMap.values()].every((items) => items[0]?.parentStableId === "road:crossing")).toBe(true);
    expect(new Set(allFragmentIds(result)).size).toBe(result.tileMap.size);

    const several = await buildTiles([line("road:several", [[-1, 5], [31, 5]])], 10, 0, 0);
    expect(several.tileMap.size).toBeGreaterThanOrEqual(4);
    expect([...several.tileMap.values()].every((items) => items[0]?.localGeometry?.type === "LineString")).toBe(true);
  });

  it("clips a polygon spanning tile boundaries without losing area topology", async () => {
    const result = await buildTiles([polygon("building:spanning", [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]])], 10, 0, 0);
    expect(result.tileMap.size).toBe(4);
    for (const items of result.tileMap.values()) {
      const geometry = items[0]?.localGeometry;
      expect(geometry?.type).toBe("Polygon");
      if (geometry?.type === "Polygon") expect(geometry.coordinates[0]!.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("preserves holes and MultiPolygon components in fragments", async () => {
    const holed = await buildTiles([polygon("building:hole", [
      [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]],
      [[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]],
    ])], 10, 0, 0);
    expect([...holed.tileMap.values()].some((items) => items[0]?.localGeometry?.type === "Polygon" && items[0].localGeometry.coordinates.length > 1)).toBe(true);

    const multi = await buildTiles([feature("water:multi", {
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
        [[[16, 16], [20, 16], [20, 20], [16, 20], [16, 16]]],
      ],
    })], 10, 0, 0);
    expect(multi.tileMap.size).toBe(2);
    expect([...multi.tileMap.values()].every((items) => items[0]?.localGeometry?.type === "Polygon")).toBe(true);
  });

  it("keeps a road vertex directly on a tile boundary traceable", async () => {
    const result = await buildTiles([line("road:on-edge", [[0, 1], [10, 1], [20, 1]])], 10, 0, 0);
    expect(result.tileMap.size).toBeGreaterThanOrEqual(3);
    expect([...result.tileMap.values()].every((items) => items[0]?.parentStableId === "road:on-edge")).toBe(true);
    expect(new Set(allFragmentIds(result)).size).toBe(result.tileMap.size);
  });
});
