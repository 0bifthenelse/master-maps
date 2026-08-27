import { describe, expect, it } from "vitest";
import { tessellatePolyline } from "@/lib/scene/tessellatePolyline";

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
});
