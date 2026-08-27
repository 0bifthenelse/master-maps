import { describe, expect, it } from "vitest";
import { createBoundaryIndex } from "../../scripts/data/boundaryIndex";
import { computeCenter } from "@/lib/geo/projection";

const square = [[
  [0, 0], [10, 0], [10, 10], [0, 10], [0, 0],
]] as [number, number][][];

describe("indexed boundary containment", () => {
  it("matches polygon containment for points and lines", () => {
    const index = createBoundaryIndex([square]);
    expect(index.contains([5, 5])).toBe(true);
    expect(index.contains([15, 5])).toBe(false);
    expect(index.lineInside([[1, 1], [9, 9]])).toBe(true);
    expect(index.lineOutside([[-2, -2], [-1, -1]])).toBe(true);
  });

  it("rejects geometries that cross the boundary despite inside endpoints", () => {
    const index = createBoundaryIndex([[
      [[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10], [0, 0]],
    ]]);
    expect(index.lineInside([[2, 8], [8, 8]])).toBe(false);
  });
});

describe("multipolygon centroid", () => {
  it("weights complete polygons independently of ring winding", () => {
    const center = computeCenter({
      type: "MultiPolygon",
      coordinates: [
        [[[0.5, 43.5], [0.51, 43.5], [0.51, 43.51], [0.5, 43.51], [0.5, 43.5]]],
        [[[0.59, 43.5], [0.6, 43.5], [0.6, 43.51], [0.59, 43.51], [0.59, 43.5]]],
      ],
    });
    expect(center[0]).toBeCloseTo(0.55, 5);
    expect(center[1]).toBeCloseTo(43.505, 4);
  });
});
