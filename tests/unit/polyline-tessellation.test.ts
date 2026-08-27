import { describe, expect, it } from "vitest";
import { tessellatePolyline } from "@/lib/scene/tessellatePolyline";
import { buildRoads } from "@/lib/scene/buildRoads";

describe("continuous polyline tessellation", () => {
  it("shares join vertices and emits two triangles per segment", () => {
    const result = tessellatePolyline([[0, 0], [10, 0], [10, 10]], { halfWidth: 2 });
    expect(result.left).toHaveLength(3);
    expect(result.right).toHaveLength(3);
    expect(result.indices).toHaveLength(12);
    expect(result.miterJoinCount + result.bevelJoinCount).toBe(1);
  });

  it("bounds acute joins by the miter limit", () => {
    const result = tessellatePolyline([[0, 0], [10, 0], [9.9, 0.01]], { halfWidth: 2, miterLimit: 2 });
    for (const point of [result.left[1]!, result.right[1]!]) {
      expect(Math.hypot(point[0] - 10, point[1])).toBeLessThan(5);
    }
    expect(result.bevelJoinCount).toBe(1);
  });

  it("removes only consecutive duplicate source vertices", () => {
    const result = tessellatePolyline([[0, 0], [0, 0], [4, 0], [4, 0]], { halfWidth: 1 });
    expect(result.left).toHaveLength(2);
  });

  it("pinches a near-180-degree reversal instead of producing a spike", () => {
    const result = tessellatePolyline([[0, 0], [10, 0], [0.1, 0.01]], { halfWidth: 2, miterLimit: 2 });
    expect(result.bevelJoinCount).toBe(1);
    expect(Math.hypot(result.left[1]![0] - 10, result.left[1]![1])).toBeLessThanOrEqual(2);
    expect(Math.hypot(result.right[1]![0] - 10, result.right[1]![1])).toBeLessThanOrEqual(2);
  });

  it("keeps MultiLineString components separate in the road builder", () => {
    const result = buildRoads([{
      kind: "road",
      stableId: "road:multi",
      geometry: { type: "MultiLineString", coordinates: [[[0, 0], [5, 0]], [[100, 100], [105, 100]]] },
    }]);
    expect(result.sourceSegments).toHaveLength(2);
    expect(result.featureCount).toBe(1);
    result.geometry.dispose();
    for (const stratum of result.strata) stratum.geometry.dispose();
  });
});
