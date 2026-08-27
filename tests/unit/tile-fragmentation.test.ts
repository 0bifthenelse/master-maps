import { describe, expect, it } from "vitest";
import { buildTiles } from "../../scripts/data/build-tiles";

describe("tile spatial fragmentation", () => {
  it("fragments a crossing line into every intersecting tile", async () => {
    const feature = {
      kind: "road",
      stableId: "road:crossing",
      x: 5,
      z: 5,
      localGeometry: { type: "LineString" as const, coordinates: [[-5, 5], [25, 5]] },
      geometry: { type: "LineString", coordinates: [[0, 0], [1, 1]] },
    };
    const result = await buildTiles([feature], 10, 0, 0);
    expect(result.tileMap.size).toBe(4);
    for (const [tileId, features] of result.tileMap) {
      expect(features[0]?.parentStableId).toBe("road:crossing");
      expect(tileId.startsWith("l0_")).toBe(true);
    }
  });
});
