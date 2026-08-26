import { describe, it, expect } from "vitest";

interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Simplified tiling implementation for tests
function tileId(x: number, z: number, tileSize: number, originX: number, originZ: number): string {
  const tx = Math.floor((x - originX) / tileSize);
  const tz = Math.floor((z - originZ) / tileSize);
  return `${tx}_${tz}`;
}

function tileBounds(
  tx: number,
  tz: number,
  tileSize: number,
  originX: number,
  originZ: number
): Bounds2D {
  return {
    minX: originX + tx * tileSize,
    maxX: originX + (tx + 1) * tileSize,
    minY: originZ + tz * tileSize,
    maxY: originZ + (tz + 1) * tileSize,
  };
}

describe("tileId", () => {
  it("origin point gives tile 0_0", () => {
    expect(tileId(0, 0, 100, 0, 0)).toBe("0_0");
  });

  it("positive quadrant", () => {
    expect(tileId(150, 250, 100, 0, 0)).toBe("1_2");
  });

  it("negative coordinates", () => {
    expect(tileId(-50, -50, 100, 0, 0)).toBe("-1_-1");
  });

  it("edge cases at tile boundaries", () => {
    // At exactly 100, should be tile 1 (since floor(100/100) = 1)
    expect(tileId(100, 100, 100, 0, 0)).toBe("1_1");
    // At exactly 0, should be tile 0
    expect(tileId(0, 0, 100, 0, 0)).toBe("0_0");
    // Just below 0, should be tile -1
    expect(tileId(-0.001, -0.001, 100, 0, 0)).toBe("-1_-1");
  });
});

describe("tileBounds", () => {
  it("tile 0_0 starts at origin", () => {
    const b = tileBounds(0, 0, 100, 0, 0);
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(100);
    expect(b.minY).toBe(0);
    expect(b.maxY).toBe(100);
  });

  it("tile 1_2 offset correctly", () => {
    const b = tileBounds(1, 2, 100, 0, 0);
    expect(b.minX).toBe(100);
    expect(b.maxX).toBe(200);
    expect(b.minY).toBe(200);
    expect(b.maxY).toBe(300);
  });

  it("tile -1_-1 includes origin offset", () => {
    const b = tileBounds(-1, -1, 100, 50, 50);
    expect(b.minX).toBe(-50);
    expect(b.maxX).toBe(50);
    expect(b.minY).toBe(-50);
    expect(b.maxY).toBe(50);
  });
});