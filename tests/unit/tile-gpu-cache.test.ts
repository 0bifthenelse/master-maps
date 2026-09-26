import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeRenderTile,
  type FeatureMeta,
  type RenderTileInput,
} from "@/lib/render/codec";
import { decodeRenderTile } from "@/lib/render/codec";
import { viewDecodedTile, geometryFromLayer, ORDERED_RENDER_LAYER_IDS } from "@/lib/render/sceneFromDecoded";
import {
  DEFAULT_GPU_CACHE_BYTES,
  evictTile,
  getTileCacheEntry,
  getTileGpuCacheStats,
  hasTileCacheEntry,
  pickStableId,
  putDecodedTile,
  resetTileGpuCache,
  retainTiles,
  tileLayerIds,
  configureTileGpuCache,
} from "@/lib/render/tileGpuCache";
import { DecodeQueue, isStaleJob, resolvePoolSize, TileDecodeCancelled } from "@/lib/render/workerPool";

const BOUNDS: [number, number, number, number] = [-1024, -512, 1024, 512];

function syntheticTile(tileId: string, lod: number, featureBase: number): RenderTileInput {
  const buildingCount = 3;
  const positions: number[] = [];
  const indices: number[] = [];
  const ranges: number[] = [];
  /* metaIndex is absolute into the tile-wide meta array, exactly as
     buildRenderTile emits it: the road claims meta 0 and the buildings start
     at 1. */
  for (let index = 0; index < buildingCount; index += 1) {
    const x = featureBase + index * 20;
    const base = positions.length / 3;
    positions.push(x, 0, 0, x + 8, 0, 0, x + 8, 0, 8, x, 0, 8, x, 6, 4);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3, base, base + 2, base + 4);
    ranges.push(indices.length - 9, 9, index + 1);
  }
  const roadPositions: number[] = [];
  const roadIndices: number[] = [];
  for (let index = 0; index < 4; index += 1) roadPositions.push(featureBase + index * 10, 0, -5, featureBase + index * 10, 0, 5);
  for (let index = 0; index < 3; index += 1) {
    const base = index * 2;
    roadIndices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }
  const meta: FeatureMeta[] = [
    { s: `road/${tileId}`, k: "road", c: "residential", a: [featureBase, -5], w: 5 },
  ];
  for (let index = 0; index < buildingCount; index += 1) {
    meta.push({ s: `building/${tileId}#${featureBase + index}`, k: "building", c: "yes", a: [featureBase + index, 0], h: 6 });
  }
  return {
    tileId,
    lod,
    bounds: BOUNDS,
    datasetVersion: "0.1.0",
    layers: [
      { id: "buildings", positions: new Float32Array(positions), indices: new Uint32Array(indices), ranges: new Uint32Array(ranges) },
      { id: "road_normal", positions: new Float32Array(roadPositions), indices: new Uint32Array(roadIndices), ranges: new Uint32Array([0, roadIndices.length, 0]) },
    ],
    meta,
  };
}

function decode(input: RenderTileInput) {
  return decodeRenderTile(encodeRenderTile(input));
}

afterEach(() => {
  resetTileGpuCache();
});

describe("decoded render tile views", () => {
  it("projects typed arrays as zero-copy views over one payload slab", () => {
    const tile = decode(syntheticTile("l0_view", 0, 0));
    const view = viewDecodedTile(tile);
    expect(view.payload.byteLength).toBeGreaterThan(0);
    for (const layer of view.layers) {
      expect(layer.positions.buffer).toBe(view.payload);
      expect(layer.indices.buffer).toBe(view.payload);
      expect(layer.ranges.buffer).toBe(view.payload);
      expect(layer.positions.byteOffset).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns layers in codec render order so painters need no sort", () => {
    const view = viewDecodedTile(decode(syntheticTile("l0_order", 0, 0)));
    const order = view.layers.map((layer) => layer.id);
    const expected = ORDERED_RENDER_LAYER_IDS.filter((id) => order.includes(id));
    expect(order).toEqual(expected);
    expect(order.indexOf("road_normal")).toBeLessThan(order.indexOf("buildings"));
  });

  it("rejects a layer whose descriptor overruns the slab", () => {
    const tile = decode(syntheticTile("l0_bad", 0, 0));
    const broken = {
      ...tile,
      layers: [{ ...tile.layers[0]!, indexLength: tile.payload.byteLength }],
    };
    expect(() => viewDecodedTile(broken)).toThrow(/byte slab/);
  });
});

describe("tile GPU cache", () => {
  it("creates one geometry per layer and keeps the slab alive", () => {
    const tile = decode(syntheticTile("l0_cache", 0, 0));
    const entry = putDecodedTile(tile);
    expect(tileLayerIds("l0_cache").sort()).toEqual(["buildings", "road_normal"]);
    expect(entry.layers.get("buildings")!.geometry.getAttribute("position")!.array.buffer).toBe(entry.slab);
    expect(hasTileCacheEntry("l0_cache")).toBe(true);
    expect(getTileGpuCacheStats().geometryCount).toBe(2);
  });

  it("skips empty layers instead of mounting geometry with no vertices", () => {
    const tile = decode(syntheticTile("l0_empty", 0, 0));
    const emptyPoi = { id: "poi" as const, positionOffset: 0, positionLength: 0, indexOffset: 0, indexLength: 0, rangeOffset: 0, rangeLength: 0 };
    const withEmpty = { ...tile, layers: [emptyPoi, tile.layers[0]!, tile.layers[1]!] };
    const entry = putDecodedTile(withEmpty);
    expect(entry.layers.has("poi")).toBe(false);
    expect(geometryFromLayer({ id: "poi", positions: new Float32Array(0), indices: new Uint32Array(0), ranges: new Uint32Array(0) })).toBeNull();
    expect(pickStableId(entry, "buildings", 0)).toBe("building/l0_empty#0");
  });

  it("resolves a picked face index to its canonical stableId", () => {
    const tile = decode(syntheticTile("l0_pick", 0, 100));
    const entry = putDecodedTile(tile);
    expect(pickStableId(entry, "buildings", 0)).toBe("building/l0_pick#100");
    expect(pickStableId(entry, "buildings", 9)).toBe("building/l0_pick#101");
    expect(pickStableId(entry, "buildings", 18)).toBe("building/l0_pick#102");
    expect(pickStableId(entry, "buildings", 1000)).toBeUndefined();
    expect(pickStableId(entry, "road_normal", 0)).toBe("road/l0_pick");
  });

  it("disposes geometries and drops the slab when a tile is evicted", () => {
    const entry = putDecodedTile(decode(syntheticTile("l0_evict", 0, 0)));
    const geometry = entry.layers.get("buildings")!.geometry;
    const disposeSpy = vi.spyOn(geometry, "dispose");
    expect(evictTile("l0_evict")).toBe(true);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(entry.slab.byteLength).toBe(0);
    expect(hasTileCacheEntry("l0_evict")).toBe(false);
    expect(getTileGpuCacheStats().byteSize).toBe(0);
    disposeSpy.mockRestore();
  });

  it("evicts the least recently used tile when the byte budget is exceeded", () => {
    const first = putDecodedTile(decode(syntheticTile("l0_first", 0, 0)));
    const firstBytes = first.byteSize;
    const second = putDecodedTile(decode(syntheticTile("l0_second", 0, 100)));
    configureTileGpuCache(firstBytes + second.byteSize - 1);
    expect(hasTileCacheEntry("l0_first")).toBe(false);
    expect(hasTileCacheEntry("l0_second")).toBe(true);
    expect(getTileGpuCacheStats().evictions).toBeGreaterThan(0);
    expect(getTileGpuCacheStats().byteSize).toBeLessThanOrEqual(getTileGpuCacheStats().maxBytes);
  });

  it("keeps a tile alive when it is the most recently used", () => {
    const first = putDecodedTile(decode(syntheticTile("l0_keep_first", 0, 0)));
    putDecodedTile(decode(syntheticTile("l0_keep_second", 0, 100)));
    getTileCacheEntry("l0_keep_first");
    configureTileGpuCache(Math.ceil(first.byteSize * 1.5));
    expect(hasTileCacheEntry("l0_keep_first")).toBe(true);
  });

  it("leaves other tiles untouched when one tile arrives", () => {
    const first = putDecodedTile(decode(syntheticTile("l0_isolate_a", 0, 0)));
    const firstGeometry = first.layers.get("buildings")!.geometry;
    const firstRanges = firstGeometry.getAttribute("featureRange")!.array.slice();
    putDecodedTile(decode(syntheticTile("l0_isolate_b", 0, 100)));
    const again = getTileCacheEntry("l0_isolate_a");
    expect(again).toBe(first);
    expect(again!.layers.get("buildings")!.geometry).toBe(firstGeometry);
    expect(Array.from(again!.layers.get("buildings")!.geometry.getAttribute("featureRange")!.array)).toEqual(Array.from(firstRanges));
    expect(getTileGpuCacheStats().disposedGeometries).toBe(0);
  });

  it("retains only the tiles the scene still references", () => {
    putDecodedTile(decode(syntheticTile("l0_retain_a", 0, 0)));
    putDecodedTile(decode(syntheticTile("l0_retain_b", 0, 100)));
    const dropped = retainTiles(["l0_retain_a"]);
    expect(dropped).toEqual(["l0_retain_b"]);
    expect(hasTileCacheEntry("l0_retain_a")).toBe(true);
  });

  it("defaults to a 512MB budget", () => {
    expect(DEFAULT_GPU_CACHE_BYTES).toBe(512 * 1024 * 1024);
    expect(getTileGpuCacheStats().maxBytes).toBe(512 * 1024 * 1024);
  });
});

describe("worker decode queue integration", () => {
  it("rejects a job queued before the generation bump", () => {
    const queue = new DecodeQueue();
    let rejection: unknown = null;
    queue.submit({ tileId: "l0_stale", gen: 0, buffer: new ArrayBuffer(8) }, () => undefined, (error) => { rejection = error; });
    expect(queue.stats.queued).toBe(1);
    queue.cancelOlderThan(1);
    expect(rejection).toBeInstanceOf(TileDecodeCancelled);
    expect(queue.stats.queued).toBe(0);
    expect(queue.stats.droppedStale).toBe(1);
  });

  it("marks a job stale once the current generation advances", () => {
    expect(isStaleJob({ tileId: "t", gen: 3, buffer: new ArrayBuffer(1) }, 4)).toBe(true);
    expect(isStaleJob({ tileId: "t", gen: 4, buffer: new ArrayBuffer(1) }, 4)).toBe(false);
  });

  it("sizes the pool from hardware concurrency", () => {
    expect(resolvePoolSize(2)).toBe(2);
    expect(resolvePoolSize(4)).toBe(2);
    expect(resolvePoolSize(8)).toBe(6);
    expect(resolvePoolSize(64)).toBe(6);
    expect(resolvePoolSize(undefined)).toBe(2);
  });
});

