import { describe, it, expect } from "vitest";
import { computeLocalFocus } from "@/lib/geo/focus";

describe("computeLocalFocus", () => {
  it("Point returns the exact coordinate", () => {
    const [x, z] = computeLocalFocus({ type: "Point", coordinates: [42, -17] });
    expect(x).toBe(42);
    expect(z).toBe(-17);
  });

  it("LineString returns the length-weighted midpoint", () => {
    // A straight line from (0,0) to (100,0): midpoint at 50% length is (50,0).
    const [x, z] = computeLocalFocus({
      type: "LineString",
      coordinates: [[0, 0], [100, 0]],
    });
    expect(x).toBeCloseTo(50, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it("LineString midpoint accounts for uneven segment lengths", () => {
    // Segments: (0,0)->(10,0) length 10, (10,0)->(10,100) length 100.
    // Total length 110, half length 55 falls 45 units into the second segment.
    const [x, z] = computeLocalFocus({
      type: "LineString",
      coordinates: [[0, 0], [10, 0], [10, 100]],
    });
    expect(x).toBeCloseTo(10, 6);
    expect(z).toBeCloseTo(45, 6);
  });

  it("LineString 2-vertex edge case returns the true midpoint", () => {
    const [x, z] = computeLocalFocus({
      type: "LineString",
      coordinates: [[-10, -10], [10, 10]],
    });
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it("LineString colinear edge case still finds the midpoint", () => {
    const [x, z] = computeLocalFocus({
      type: "LineString",
      coordinates: [[0, 0], [5, 5], [10, 10], [20, 20]],
    });
    expect(x).toBeCloseTo(10, 6);
    expect(z).toBeCloseTo(10, 6);
  });

  it("Polygon returns the area-weighted centroid", () => {
    // Unit square [0,0]-[10,0]-[10,10]-[0,10]: centroid is (5,5).
    const [x, z] = computeLocalFocus({
      type: "Polygon",
      coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]],
    });
    expect(x).toBeCloseTo(5, 6);
    expect(z).toBeCloseTo(5, 6);
  });

  it("Polygon centroid ignores holes (uses exterior ring only)", () => {
    const [x, z] = computeLocalFocus({
      type: "Polygon",
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10]],
        [[4, 4], [6, 4], [6, 6], [4, 6]], // hole, off-center would skew if used
      ],
    });
    expect(x).toBeCloseTo(5, 6);
    expect(z).toBeCloseTo(5, 6);
  });

  it("MultiPolygon returns the area-weighted centroid across polygons", () => {
    // Two disjoint unit squares of equal area at (5,5) and (105,5):
    // combined centroid is the midpoint, (55,5).
    const [x, z] = computeLocalFocus({
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [10, 0], [10, 10], [0, 10]]],
        [[[100, 0], [110, 0], [110, 10], [100, 10]]],
      ],
    });
    expect(x).toBeCloseTo(55, 6);
    expect(z).toBeCloseTo(5, 6);
  });

  it("MultiPolygon weights larger polygons more heavily", () => {
    // A tiny square at (5,5) and a much larger one at (100,100):
    // the combined centroid should sit close to the larger polygon.
    const [x, z] = computeLocalFocus({
      type: "MultiPolygon",
      coordinates: [
        [[[0, 0], [10, 0], [10, 10], [0, 10]]], // area 100 at (5,5)
        [[[50, 50], [150, 50], [150, 150], [50, 150]]], // area 10000 at (100,100)
      ],
    });
    expect(x).toBeGreaterThan(90);
    expect(z).toBeGreaterThan(90);
  });
});
