import { describe, expect, it } from "vitest";
import {
  LOD_METRES_PER_PIXEL,
  LOD_TILE_METRES,
  MAX_CONCURRENCY,
  MIN_CONCURRENCY,
  createTileIndex,
  isUsableViewport,
  nextConcurrency,
  planTiles,
  queryTileIndex,
  resolveLod,
  tileIntersectsQuad,
  type SchedulerViewport,
} from "@/components/map/tileScheduler";
import type { TileManifest } from "@/lib/data/schema";
import { MapTransform } from "@/lib/map/transform";

/** A synthetic 32 × 24 LOD0 grid with its LOD1/LOD2 parents, independent of any generated dataset. */
const COLUMNS = 32;
const ROWS = 24;
const L0 = LOD_TILE_METRES[0]!;
const BOUNDS: [number, number, number, number] = [0, 0, COLUMNS * L0, ROWS * L0];
const CENTRE: [number, number] = [L0 * 16 + L0 / 2, L0 * 12 + L0 / 2];

function grid(): TileManifest[] {
  const entries: TileManifest[] = [];
  for (let lod = 0; lod < LOD_TILE_METRES.length; lod += 1) {
    const size = LOD_TILE_METRES[lod]!;
    for (let column = 0; column < (COLUMNS * L0) / size; column += 1) {
      for (let row = 0; row < (ROWS * L0) / size; row += 1) {
        entries.push({ tileId: `l${lod}_${column}_${row}`, lod, bounds: [column * size, row * size, (column + 1) * size, (row + 1) * size], featureCount: 1, byteSize: 1 });
      }
    }
  }
  return entries;
}

const INDEX = createTileIndex(grid());

function viewportFor(state: { zoom: number; bearing?: number; pitch?: number; center?: [number, number] }): SchedulerViewport {
  const transform = new MapTransform({ center: state.center ?? CENTRE, zoom: state.zoom, bearing: state.bearing ?? 0, pitch: state.pitch ?? 0, width: 1440, height: 900 });
  return { target: transform.center, quad: transform.groundFootprint(), metresPerPixel: transform.metresPerPixel };
}

function plan(viewport: SchedulerViewport | null, resident: string[] = []): ReturnType<typeof planTiles> {
  const lod = viewport === null ? 0 : resolveLod(viewport.metresPerPixel, 0);
  return planTiles({ viewport, currentLod: lod, resident: new Set(resident), index: INDEX, bounds: BOUNDS, halo: 0 });
}

function tileAt(id: string): TileManifest {
  return grid().find((entry) => entry.tileId === id)!;
}

describe("resolveLod", () => {
  it("picks the finest level whose tiles stay at least MIN_TILE_PIXELS wide", () => {
    expect(resolveLod(LOD_METRES_PER_PIXEL[0]! * 0.5, 0)).toBe(0);
    expect(resolveLod(LOD_METRES_PER_PIXEL[0]! * 2, 0)).toBe(1);
    expect(resolveLod(LOD_METRES_PER_PIXEL[2]! * 4, 0)).toBe(2);
  });

  it("holds the current level through small zoom jitter", () => {
    const edge = LOD_METRES_PER_PIXEL[0]!;
    expect(resolveLod(edge * 1.05, 0)).toBe(0);
    expect(resolveLod(edge * 0.95, 1)).toBe(1);
    expect(resolveLod(edge * 1.3, 0)).toBe(1);
  });
});

describe("tile index and quad tests", () => {
  it("finds the tiles overlapping a box at one level", () => {
    const found = queryTileIndex(INDEX, [L0 + 1, L0 + 1, L0 * 2 - 1, L0 * 2 - 1], 0);
    expect(found.map((entry) => entry.tileId)).toEqual(["l0_1_1"]);
  });

  it("separates a rotated quad from a tile its bounding box would include", () => {
    const diamond: [number, number][] = [[1000, 0], [2000, 1000], [1000, 2000], [0, 1000]];
    expect(tileIntersectsQuad([0, 0, 100, 100], diamond)).toBe(false);
    expect(tileIntersectsQuad([900, 900, 1100, 1100], diamond)).toBe(true);
  });
});

describe("planTiles", () => {
  it("requires only the fine tiles under a street-level view, centre first", () => {
    const result = plan(viewportFor({ zoom: 16 }));
    expect(result.lod).toBe(0);
    expect(result.required[0]).toBe("l0_16_12");
    for (const id of result.required) expect(id.startsWith("l0_")).toBe(true);
    expect(result.required.length).toBeLessThanOrEqual(4);
  });

  it("keeps the same centre tile and covers the rotated footprint at any bearing", () => {
    for (const bearing of [0, Math.PI / 4, Math.PI / 2, -2]) {
      const viewport = viewportFor({ zoom: 15, bearing });
      const result = plan(viewport);
      expect(result.required[0]).toBe("l0_16_12");
      for (const id of result.required) expect(tileIntersectsQuad(tileAt(id).bounds, viewport.quad)).toBe(true);
    }
  });

  it("reaches further toward the horizon when the view is tilted", () => {
    const flat = plan(viewportFor({ zoom: 15 }));
    const tilted = plan(viewportFor({ zoom: 15, pitch: (55 * Math.PI) / 180 }));
    expect(tilted.required.length).toBeGreaterThan(flat.required.length);
    const northmost = (ids: string[]): number => Math.max(...ids.map((id) => tileAt(id).bounds[3]));
    expect(northmost(tilted.required)).toBeGreaterThan(northmost(flat.required));
  });

  it("switches to coarse tiles at the department overview", () => {
    const result = plan(viewportFor({ zoom: 9.5 }));
    expect(result.lod).toBe(2);
    expect(result.required.every((id) => id.startsWith("l2_"))).toBe(true);
  });

  it("plans the whole overview level before the first view is known", () => {
    const result = plan(null);
    expect(result.lod).toBe(2);
    expect(result.required.length).toBe(INDEX.byLod[2]!.length);
  });

  it("keeps a resident coarse tile on screen until the fine tiles arrive", () => {
    const result = plan(viewportFor({ zoom: 16 }), ["l1_4_3"]);
    expect(result.retain).toContain("l1_4_3");
    const ready = plan(viewportFor({ zoom: 16 }), ["l1_4_3", ...plan(viewportFor({ zoom: 16 })).required]);
    expect(ready.retain).not.toContain("l1_4_3");
  });
});

describe("viewport and concurrency guards", () => {
  it("rejects a viewport with no usable scale", () => {
    expect(isUsableViewport({ target: [0, 0], quad: [], metresPerPixel: 0 })).toBe(false);
    expect(isUsableViewport({ target: [Number.NaN, 0], quad: [], metresPerPixel: 1 })).toBe(false);
    expect(isUsableViewport(null)).toBe(true);
  });

  it("adapts concurrency to tile load times within its bounds", () => {
    expect(nextConcurrency(MIN_CONCURRENCY, 10)).toEqual({ concurrency: MIN_CONCURRENCY + 1, sampleEvent: "fast" });
    expect(nextConcurrency(MAX_CONCURRENCY, 10).concurrency).toBe(MAX_CONCURRENCY);
    expect(nextConcurrency(MIN_CONCURRENCY, 500)).toEqual({ concurrency: MIN_CONCURRENCY, sampleEvent: "slow" });
  });
});
