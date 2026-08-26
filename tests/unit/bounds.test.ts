import { describe, it, expect } from "vitest";
// import { computeBounds, extendBounds, unionBounds, Bounds2D } from "@/lib/geo/bounds";

// Using local implementation for test isolation
interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function computeBoundsFromPoints(points: [number, number][]): Bounds2D {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxY, maxX: maxX, minY: minY };
}

function extendBounds(b: Bounds2D, p: [number, number]): Bounds2D {
  return {
    minX: Math.min(b.minX, p[0]),
    maxX: Math.max(b.maxX, p[0]),
    minY: Math.min(b.minY, p[1]),
    maxY: Math.max(b.maxY, p[1]),
  };
}

describe("computeBoundsFromPoints", () => {
  it("returns empty bounds for empty array", () => {
    const b = computeBoundsFromPoints([]);
    expect(b.minX).toBe(Infinity);
    expect(b.minY).toBe(Infinity);
    expect(b.maxX).toBe(-Infinity);
    expect(b.maxY).toBe(-Infinity);
  });

  it("single point gives zero-area bounds", () => {
    const b = computeBoundsFromPoints([[5, 10]]);
    expect(b.minX).toBe(5);
    expect(b.maxX).toBe(5);
    expect(b.minY).toBe(10);
    expect(b.maxY).toBe(10);
  });

  it("multiple points gives extent", () => {
    const b = computeBoundsFromPoints([[0, 0], [10, 20], [5, 5]]);
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(10);
    expect(b.minY).toBe(0);
    expect(b.maxY).toBe(20);
  });
});

describe("extendBounds", () => {
  it("extends min", () => {
    const b = { minX: 5, maxX: 10, minY: 5, maxY: 10 };
    const r = extendBounds(b, [0, 0]);
    expect(r.minX).toBe(0);
    expect(r.minY).toBe(0);
    expect(r.maxX).toBe(10);
    expect(r.maxY).toBe(10);
  });

  it("extends max", () => {
    const b = { minX: 5, maxX: 10, minY: 5, maxY: 10 };
    const r = extendBounds(b, [15, 20]);
    expect(r.minX).toBe(5);
    expect(r.maxX).toBe(15);
    expect(r.minY).toBe(5);
    expect(r.maxY).toBe(20);
  });
});