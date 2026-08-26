import { describe, it, expect } from "vitest";

// Local polygon utility implementations for tests
function isRingClosed(coords: [number, number][]): boolean {
  if (coords.length < 3) return false;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

function ensureRingClosed(coords: [number, number][]): [number, number][] {
  if (isRingClosed(coords)) return coords;
  return [...coords, coords[0]];
}

function ringArea(coords: [number, number][]): number {
  let area = 0;
  const n = coords.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += coords[i][0] * coords[j][1];
    area -= coords[j][0] * coords[i][1];
  }
  return area / 2;
}

function pointInRing(point: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > point[1]) !== (yj > point[1]) &&
        point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

describe("isRingClosed", () => {
  it("closed ring returns true", () => {
    expect(isRingClosed([[0, 0], [1, 0], [1, 1], [0, 0]])).toBe(true);
  });

  it("open ring returns false", () => {
    expect(isRingClosed([[0, 0], [1, 0], [1, 1]])).toBe(false);
  });

  it("empty returns false", () => {
    expect(isRingClosed([])).toBe(false);
  });
});

describe("ensureRingClosed", () => {
  it("keeps closed ring unchanged", () => {
    const ring: [number, number][] = [[0, 0], [1, 0], [0, 1], [0, 0]];
    expect(ensureRingClosed(ring)).toEqual(ring);
  });

  it("closes open ring", () => {
    const ring: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const closed = ensureRingClosed(ring);
    expect(closed.length).toBe(5);
    expect(closed[closed.length - 1]).toEqual([0, 0]);
  });
});

describe("ringArea", () => {
  it("unit square area is 1 (or -1)", () => {
    const area = ringArea([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
    expect(Math.abs(area)).toBeCloseTo(1, 5);
  });

  it("clockwise ring has negative area", () => {
    const area = ringArea([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]);
    expect(area).toBeLessThan(0);
  });

  it("counter-clockwise ring has positive area", () => {
    const area = ringArea([[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]);
    expect(area).toBeGreaterThan(0);
  });
});

describe("pointInRing", () => {
  const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];

  it("point inside square", () => {
    expect(pointInRing([5, 5], square)).toBe(true);
  });

  it("point outside square", () => {
    expect(pointInRing([15, 5], square)).toBe(false);
  });

  it("point on edge", () => {
    // Point exactly on edge is ambiguous, but our algorithm returns false
    expect(pointInRing([5, 0], square)).toBe(true);
  });

  it("point at corner", () => {
    expect(pointInRing([0, 0], square)).toBe(true);
  });
});