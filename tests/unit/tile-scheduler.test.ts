import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  visibleWorldQuad,
  worldMetresPerPixel,
  type SchedulerViewport,
} from "@/components/map/tileScheduler";
import type { DatasetManifest, TileManifest } from "@/lib/data/schema";

const DATASET_BOUNDS: [number, number, number, number] = [-71680, -43008, 59392, 55296];
const CANVAS_WIDTH = 1440;
const CANVAS_HEIGHT = 900;
const FRUSTUM_WIDTH = 151552;
const FRUSTUM_HEIGHT = 118400;
const HALO = 512;
const GRID_COLUMNS = 32;
const GRID_ROWS = 24;
const OVERVIEW_TARGET: [number, number] = [-6144, 6144];
const GRID_TARGET: [number, number] = [LOD_TILE_METRES[0]! * 16, LOD_TILE_METRES[0]! * 12];

const GRID_BOUNDS: [number, number, number, number] = [
  0,
  0,
  GRID_COLUMNS * LOD_TILE_METRES[0]!,
  GRID_ROWS * LOD_TILE_METRES[0]!,
];

function loadManifest(): DatasetManifest {
  return JSON.parse(readFileSync(resolve(process.cwd(), "data/generated/manifest.json"), "utf8")) as DatasetManifest;
}

function viewport(zoom: number, headingRadians = 0, target: [number, number] = GRID_TARGET): SchedulerViewport {
  return { target, zoom, frustumWidth: FRUSTUM_WIDTH, frustumHeight: FRUSTUM_HEIGHT, headingRadians };
}

function gridEntries(): TileManifest[] {
  const entries: TileManifest[] = [];
  for (let lod = 0; lod < LOD_TILE_METRES.length; lod += 1) {
    const size = LOD_TILE_METRES[lod]!;
    const step = size / LOD_TILE_METRES[0]!;
    for (let column = 0; column < GRID_COLUMNS / step; column += 1) {
      for (let row = 0; row < GRID_ROWS / step; row += 1) {
        const minX = column * size;
        const minZ = row * size;
        entries.push({ tileId: `l${lod}_${column}_${row}`, lod, bounds: [minX, minZ, minX + size, minZ + size], featureCount: 1, byteSize: 1 });
      }
    }
  }
  return entries;
}

function metresPerPixelAt(zoom: number, currentLod: number): number {
  return resolveLod(worldMetresPerPixel(viewport(zoom), CANVAS_WIDTH, CANVAS_HEIGHT), currentLod);
}

function enclosingBox(quad: [number, number][]): [number, number, number, number] {
  return [
    Math.min(...quad.map((point) => point[0])),
    Math.min(...quad.map((point) => point[1])),
    Math.max(...quad.map((point) => point[0])),
    Math.max(...quad.map((point) => point[1])),
  ];
}

function enclosingCornerTile(quad: [number, number][]): [number, number, number, number] {
  const box = enclosingBox(quad);
  return [box[0] + 1, box[1] + 1, box[0] + 65, box[1] + 65];
}

describe("visibleWorldQuad", () => {
  it("returns the screen corners at heading 0, top edge first", () => {
    expect(visibleWorldQuad(viewport(4, 0, [0, 0]))).toEqual([
      [-18944, 14800],
      [18944, 14800],
      [18944, -14800],
      [-18944, -14800],
    ]);
  });

  it("returns the hand computed corners at 45 degrees", () => {
    const view = viewport(4, Math.PI / 4, [0, 0]);
    const halfWidth = view.frustumWidth / (2 * view.zoom);
    const halfHeight = view.frustumHeight / (2 * view.zoom);
    const expected: [number, number][] = [
      [-(halfWidth - halfHeight) * Math.SQRT1_2, (halfWidth + halfHeight) * Math.SQRT1_2],
      [(halfWidth + halfHeight) * Math.SQRT1_2, -(halfWidth - halfHeight) * Math.SQRT1_2],
      [(halfWidth - halfHeight) * Math.SQRT1_2, -(halfWidth + halfHeight) * Math.SQRT1_2],
      [-(halfWidth + halfHeight) * Math.SQRT1_2, (halfWidth - halfHeight) * Math.SQRT1_2],
    ];
    visibleWorldQuad(view).forEach((corner, position) => {
      expect(corner[0]).toBeCloseTo(expected[position]![0], 6);
      expect(corner[1]).toBeCloseTo(expected[position]![1], 6);
    });
  });

  it("reaches its widest enclosing extent at 45 degrees", () => {
    const width = (quad: [number, number][]): number => Math.max(...quad.map((corner) => corner[0])) - Math.min(...quad.map((corner) => corner[0]));
    const height = (quad: [number, number][]): number => Math.max(...quad.map((corner) => corner[1])) - Math.min(...quad.map((corner) => corner[1]));
    const flatView = viewport(4, 0, [0, 0]);
    const flat = visibleWorldQuad(flatView);
    const rotated = visibleWorldQuad(viewport(4, Math.PI / 4, [0, 0]));
    const widest = (flatView.frustumWidth + flatView.frustumHeight) / flatView.zoom * Math.SQRT1_2;
    expect(width(rotated)).toBeCloseTo(widest, 6);
    expect(height(rotated)).toBeCloseTo(widest, 6);
    expect(width(rotated)).toBeGreaterThan(width(flat));
    expect(height(rotated)).toBeGreaterThan(height(flat));
  });
});

describe("tileIntersectsQuad", () => {
  it("rejects a tile inside the enclosing AABB but outside the 45 degree quad", () => {
    const quad = visibleWorldQuad(viewport(4, Math.PI / 4, [0, 0]));
    const corner = enclosingCornerTile(quad);
    const box = enclosingBox(quad);
    expect(corner[0] >= box[0] && corner[2] <= box[2] && corner[1] >= box[1] && corner[3] <= box[3]).toBe(true);
    expect(tileIntersectsQuad(corner, quad)).toBe(false);
  });

  it("rejects the enclosing corner across the headings that leave a gap", () => {
    for (const degrees of [39, 42, 45, 48, 51]) {
      const quad = visibleWorldQuad(viewport(4, (degrees * Math.PI) / 180, [0, 0]));
      expect(tileIntersectsQuad(enclosingCornerTile(quad), quad)).toBe(false);
    }
  });

  it("accepts genuinely overlapping tiles and rejects far ones for 0, 45 and 90 degrees", () => {
    for (const degrees of [0, 45, 90]) {
      const quad = visibleWorldQuad(viewport(4, (degrees * Math.PI) / 180, [0, 0]));
      expect(tileIntersectsQuad([-40000, -40000, 40000, 40000], quad)).toBe(true);
      expect(tileIntersectsQuad([-40000, 13000, 40000, 53000], quad)).toBe(true);
      expect(tileIntersectsQuad([200000, 200000, 202000, 202000], quad)).toBe(false);
    }
  });
});

describe("resolveLod", () => {
  const at = (zoom: number, target: [number, number] = OVERVIEW_TARGET): number => worldMetresPerPixel(viewport(zoom, 0, target), CANVAS_WIDTH, CANVAS_HEIGHT);

  it("selects the coarsest level at full department overview", () => {
    expect(at(1)).toBeCloseTo(FRUSTUM_HEIGHT / CANVAS_HEIGHT, 6);
    expect(resolveLod(at(1), 0)).toBe(2);
    expect(resolveLod(at(1), 1)).toBe(2);
  });

  it("selects the finest level at street zoom", () => {
    expect(resolveLod(at(400), 2)).toBe(0);
  });

  it("is monotonic in zoom", () => {
    let previous = 2;
    for (const zoom of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 4000]) {
      const lod = resolveLod(at(zoom), previous);
      expect(lod).toBeLessThanOrEqual(previous);
      previous = lod;
    }
    expect(previous).toBe(0);
  });

  it("keeps the current level through a small change and flips on a large one", () => {
    const band = 1.12;
    const fineSwitch = LOD_METRES_PER_PIXEL[0]!;
    const firstSwitch = LOD_METRES_PER_PIXEL[1]!;
    const secondSwitch = LOD_METRES_PER_PIXEL[2]!;
    expect(resolveLod(firstSwitch * (1 - 1e-9), 0, 0)).toBe(1);
    expect(resolveLod(fineSwitch * band, 0, 0.12)).toBe(0);
    expect(resolveLod(fineSwitch * band * 1.01, 0, 0.12)).toBe(1);
    expect(resolveLod(firstSwitch * band, 1, 0.12)).toBe(1);
    expect(resolveLod(firstSwitch * band * 1.01, 1, 0.12)).toBe(2);
    expect(resolveLod(firstSwitch * 0.95, 0, 0.12)).toBe(1);
    expect(resolveLod(firstSwitch * 0.95, 1, 0.12)).toBe(1);
    expect(resolveLod(secondSwitch * band * 1.01, 1, 0.12)).toBe(2);
    expect(resolveLod(secondSwitch * band * 1.01, 2, 0.12)).toBe(2);
    expect(resolveLod(fineSwitch / 2, 1, 0.12)).toBe(0);
    expect(resolveLod(fineSwitch / 2, 0, 0.12)).toBe(0);
  });
});

describe("tile index", () => {
  const index = createTileIndex(loadManifest().tiles ?? []);

  it("buckets the generated manifest into a small uniform grid", () => {
    expect(index.cellSize).toBe(LOD_TILE_METRES[2]);
    expect(index.cells.length).toBe(index.columns * index.rows);
    expect(index.columns * index.rows).toBeLessThan(64);
    expect(index.byLod.map((entries) => entries.length)).toEqual([5386, 1747, 269]);
  });

  it("returns every intersecting tile of a level without duplicates", () => {
    const expected = index.byLod[2]!.filter((entry) => entry.bounds[0] <= DATASET_BOUNDS[2] && entry.bounds[2] >= DATASET_BOUNDS[0] && entry.bounds[1] <= DATASET_BOUNDS[3] && entry.bounds[3] >= DATASET_BOUNDS[1]);
    const found = queryTileIndex(index, DATASET_BOUNDS, 2);
    expect(found.length).toBe(expected.length);
    expect(new Set(found.map((entry) => entry.tileId)).size).toBe(found.length);
  });
});

describe("planTiles", () => {
  const index = createTileIndex(gridEntries());
  const manifestIndex = createTileIndex(loadManifest().tiles ?? []);

  it("keeps the whole coarsest level before the first viewport snapshot", () => {
    const plan = planTiles({ viewport: null, currentLod: 2, resident: new Set(), index: manifestIndex, bounds: DATASET_BOUNDS, halo: HALO });
    expect(plan.lod).toBe(2);
    expect(plan.required.length).toBe(269);
    expect(plan.prefetch).toEqual([]);
  });

  it("orders required tiles centre first and bounds the prefetch ring", () => {
    const view = viewport(8, 0, GRID_TARGET);
    const plan = planTiles({ viewport: view, currentLod: metresPerPixelAt(8, 2), resident: new Set(), index, bounds: GRID_BOUNDS, halo: HALO });
    const byId = new Map((index.byLod[plan.lod] ?? []).map((entry) => [entry.tileId, entry.bounds]));
    const distances = plan.required.map((tileId) => {
      const bounds = byId.get(tileId)!;
      return Math.hypot((bounds[0] + bounds[2]) / 2 - view.target[0], (bounds[1] + bounds[3]) / 2 - view.target[1]);
    });
    expect(plan.lod).toBe(1);
    expect(plan.required.length).toBeGreaterThan(1);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    expect(plan.prefetch.length).toBeLessThan(plan.required.length);
    expect(plan.prefetch.length).toBeLessThanOrEqual(Math.ceil(plan.required.length * 0.2));
    for (const tileId of plan.prefetch) expect(plan.required).not.toContain(tileId);
  });

  it("keeps the visible count independent of dataset size", () => {
    const level = createTileIndex(gridEntries()).byLod[0]!;
    const queries: [number, number, number, number][] = [
      [20480, 20480, 28672, 28672],
      [20480, 0, 40960, 40960],
      [GRID_BOUNDS[0], GRID_BOUNDS[1], GRID_BOUNDS[2], GRID_BOUNDS[3]],
    ];
    const trimmed = createTileIndex(level.filter((entry) => entry.bounds[0] > 20480));
    expect(trimmed.byLod[0]!.length).toBeLessThan(level.length);
    expect(trimmed.byLod[0]!.length).toBeGreaterThan(0);
    for (const query of queries) {
      const expected = trimmed.byLod[0]!.filter((entry) => entry.bounds[0] <= query[2] && entry.bounds[2] >= query[0] && entry.bounds[1] <= query[3] && entry.bounds[3] >= query[1]);
      expect(expected.length).toBeGreaterThan(0);
      expect(queryTileIndex(trimmed, query, 0)).toHaveLength(expected.length);
    }
  });

  it("retains a resident coarser tile exactly while its finer replacements are missing", () => {
    const view = viewport(6, Math.PI / 4);
    const lod = metresPerPixelAt(6, 2);
    const quad = visibleWorldQuad(view);
    const cover = index.byLod[lod - 1]!.find((entry) => tileIntersectsQuad(entry.bounds, quad));
    expect(cover).toBeDefined();
    const plan = planTiles({ viewport: view, currentLod: lod, resident: new Set([cover!.tileId]), index, bounds: GRID_BOUNDS, halo: HALO });
    expect(plan.required.length).toBeGreaterThan(0);
    expect(plan.retain).toContain(cover!.tileId);
    const settled = planTiles({ viewport: view, currentLod: lod, resident: new Set(plan.required), index, bounds: GRID_BOUNDS, halo: HALO });
    expect(settled.retain).not.toContain(cover!.tileId);
  });

  it("never returns an empty mount while a coarser level is resident", () => {
    const view = viewport(6, Math.PI / 4);
    const lod = metresPerPixelAt(6, 2);
    const quad = visibleWorldQuad(view);
    const resident = index.byLod[lod - 1]!.filter((entry) => tileIntersectsQuad(entry.bounds, quad)).map((entry) => entry.tileId);
    expect(resident.length).toBeGreaterThan(0);
    const plan = planTiles({ viewport: view, currentLod: lod, resident: new Set(resident), index, bounds: GRID_BOUNDS, halo: HALO });
    expect(plan.retain.length).toBeGreaterThan(0);
    for (const tileId of plan.retain) expect(resident).toContain(tileId);
  });
});

describe("numeric faults", () => {
  const index = createTileIndex(gridEntries());

  it("freezes the view on a NaN target instead of blanking it", () => {
    const resident = new Set(["l1_0_0", "l1_1_1"]);
    const plan = planTiles({
      viewport: { target: [Number.NaN, 0], zoom: 4, frustumWidth: FRUSTUM_WIDTH, frustumHeight: FRUSTUM_HEIGHT, headingRadians: 0 },
      currentLod: 2,
      resident,
      index,
      bounds: GRID_BOUNDS,
      halo: HALO,
    });
    expect(plan.required).toEqual([]);
    expect(plan.prefetch).toEqual([]);
    expect(plan.retain).toEqual([...resident].sort());
  });

  it("freezes the view on a zero zoom", () => {
    const resident = new Set(["l1_0_0", "l1_1_1"]);
    const plan = planTiles({ viewport: { ...viewport(4), zoom: 0 }, currentLod: 2, resident, index, bounds: GRID_BOUNDS, halo: HALO });
    expect(plan.required).toEqual([]);
    expect(plan.retain).toEqual([...resident].sort());
  });

  it("rejects every non finite viewport field", () => {
    expect(isUsableViewport(null)).toBe(true);
    expect(isUsableViewport(viewport(2))).toBe(true);
    expect(isUsableViewport({ target: [0, Number.POSITIVE_INFINITY], zoom: 1, frustumWidth: 100, frustumHeight: 100, headingRadians: 0 })).toBe(false);
    expect(isUsableViewport({ target: [0, 0], zoom: 1, frustumWidth: 0, frustumHeight: 100, headingRadians: 0 })).toBe(false);
  });
});

describe("nextConcurrency", () => {
  it("rises on fast samples and falls on slow ones inside the bounds", () => {
    let concurrency = MIN_CONCURRENCY;
    for (let step = 0; step < 40; step += 1) concurrency = nextConcurrency(concurrency, 10).concurrency;
    expect(concurrency).toBe(MAX_CONCURRENCY);
    for (let step = 0; step < 40; step += 1) concurrency = nextConcurrency(concurrency, 500).concurrency;
    expect(concurrency).toBe(MIN_CONCURRENCY);
  });

  it("classifies each sample and holds steady inside the target band", () => {
    expect(nextConcurrency(7, 80)).toEqual({ concurrency: 7, sampleEvent: "steady" });
    expect(nextConcurrency(7, 10)).toEqual({ concurrency: 8, sampleEvent: "fast" });
    expect(nextConcurrency(7, 500)).toEqual({ concurrency: 6, sampleEvent: "slow" });
  });

  it("never returns the previous unconditional 24", () => {
    expect(nextConcurrency(24, 10).concurrency).toBe(MAX_CONCURRENCY);
    expect(nextConcurrency(0, 10).concurrency).toBe(MIN_CONCURRENCY + 1);
    expect(nextConcurrency(Number.NaN, 10).concurrency).toBe(MIN_CONCURRENCY + 1);
  });
});
