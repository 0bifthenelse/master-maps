import type { BufferGeometry } from 'three';
import type { DecodedRenderTile, RenderLayerId } from './codec';
import {
  geometryByteSize,
  geometryFromLayer,
  isEmptyLayer,
  viewDecodedTile,
  type DecodedTileView,
} from './sceneFromDecoded';

export const DEFAULT_GPU_CACHE_BYTES = 512 * 1024 * 1024;

export interface TileLayerEntry {
  layerId: RenderLayerId;
  geometry: BufferGeometry;
  byteSize: number;
  rangeLength: number;
  /** Index of this layer's first feature inside TileCacheEntry.stableIds. */
  firstStableId: number;
  /** Feature count in this layer, from its range triples. */
  featureCount: number;
  /** True when the layer is drawn as Points and picked by vertex index. */
  isPointLayer: boolean;
}

export interface TileCacheEntry {
  tileId: string;
  lod: number;
  slab: ArrayBuffer;
  byteSize: number;
  layers: Map<RenderLayerId, TileLayerEntry>;
  /** Canonical stableId per feature, ordered by layer then by range. */
  stableIds: string[];
  /** Holder tokens (scene groups or tiles) still rendering this entry. */
  references: number;
  /** Committed frames elapsed since this entry was retired. */
  framesWaiting: number;
  /** True once evicted or replaced, so it is only ever torn down once. */
  isRetired: boolean;
}

export interface TileGpuCacheStats {
  entries: number;
  byteSize: number;
  maxBytes: number;
  geometryCount: number;
  evictions: number;
  disposedGeometries: number;
  lastEvicted: string[];
  mounted: number;
  retiredPending: number;
}

interface CacheStore {
  tiles: Map<string, TileCacheEntry>;
  byteSize: number;
  maxBytes: number;
  evictions: number;
  disposedGeometries: number;
  lastEvicted: string[];
}

const EMPTY_SLAB = new ArrayBuffer(0);
const RECENT_EVICTION_LOG = 32;
const SCENE_HOLDER = "scene";

function createStore(maxBytes: number): CacheStore {
  return { tiles: new Map(), byteSize: 0, maxBytes, evictions: 0, disposedGeometries: 0, lastEvicted: [] };
}

let store = createStore(DEFAULT_GPU_CACHE_BYTES);
const retiredEntries = new Set<TileCacheEntry>();
const mountedHolders = new Map<string, Map<string, TileCacheEntry | undefined>>();

export class TileGpuCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileGpuCacheError';
  }
}

function collectStableIds(view: DecodedTileView, tile: DecodedRenderTile): string[] {
  const stableIds: string[] = [];
  let cursor = 0;
  for (const layer of view.layers) {
    const count = layer.ranges.length / 3;
    for (let index = 0; index < count; index += 1) {
      stableIds.push(tile.meta[cursor + index]?.s ?? "");
    }
    cursor += count;
  }
  return stableIds;
}

function teardownEntry(entry: TileCacheEntry): void {
  for (const layer of entry.layers.values()) {
    layer.geometry.dispose();
    store.disposedGeometries += 1;
  }
  entry.layers.clear();
  entry.stableIds.length = 0;
  entry.slab = EMPTY_SLAB;
  retiredEntries.delete(entry);
}

function retireEntry(entry: TileCacheEntry): void {
  if (entry.isRetired) return;
  entry.isRetired = true;
  entry.framesWaiting = 0;
  retiredEntries.add(entry);
}

function recordEviction(tileId: string): void {
  store.evictions += 1;
  store.lastEvicted.push(tileId);
  if (store.lastEvicted.length > RECENT_EVICTION_LOG) {
    store.lastEvicted.splice(0, store.lastEvicted.length - RECENT_EVICTION_LOG);
  }
}

function evictToBudget(): void {
  while (store.byteSize > store.maxBytes && store.tiles.size > 0) {
    const oldest = store.tiles.entries().next();
    if (oldest.done) return;
    const [tileId, entry] = oldest.value;
    store.tiles.delete(tileId);
    store.byteSize -= entry.byteSize;
    recordEviction(tileId);
    retireEntry(entry);
  }
}

function acquireHolder(tileId: string, token: string): void {
  let holders = mountedHolders.get(tileId);
  if (holders === undefined) {
    holders = new Map();
    mountedHolders.set(tileId, holders);
  } else if (holders.has(token)) {
    return;
  }
  const entry = store.tiles.get(tileId);
  if (entry !== undefined) {
    entry.references += 1;
    entry.framesWaiting = 0;
  }
  holders.set(token, entry);
}

function releaseHolder(tileId: string, token: string): void {
  const holders = mountedHolders.get(tileId);
  if (holders === undefined || !holders.has(token)) {
    throw new TileGpuCacheError(`tile ${tileId} released for holder ${token} that never acquired it`);
  }
  const entry = holders.get(token);
  holders.delete(token);
  if (holders.size === 0) mountedHolders.delete(tileId);
  if (entry === undefined) return;
  if (entry.references === 0) {
    throw new TileGpuCacheError(`tile ${tileId} reference count is already zero for holder ${token}`);
  }
  entry.references -= 1;
}

/**
 * Take a holder reference on a tile, idempotent per holder token so a repeated
 * acquire cannot inflate the count and a double release is rejected instead
 * of driving it negative.
 */
export function acquireTileHolder(tileId: string, token: string = SCENE_HOLDER): void {
  acquireHolder(tileId, token);
}

/** Give back a holder reference; the geometry is freed only by the last release. */
export function releaseTileHolder(tileId: string, token: string = SCENE_HOLDER): void {
  releaseHolder(tileId, token);
}

/**
 * Declare the tiles the scene currently renders. A mounted tile is never
 * disposed whatever the LRU budget does to the store. A tile leaving the set
 * restarts its retirement countdown, so it is torn down on the first
 * committed frame after this call, never by a timer.
 */
export function syncMountedTiles(tileIds: Iterable<string>): void {
  const next = new Set(tileIds);
  for (const tileId of next) {
    if (mountedHolders.get(tileId)?.has(SCENE_HOLDER) !== true) acquireHolder(tileId, SCENE_HOLDER);
  }
  for (const tileId of [...mountedHolders.keys()]) {
    if (!next.has(tileId)) releaseHolder(tileId, SCENE_HOLDER);
  }
}

/**
 * Advance every retirement countdown by one committed frame. A retired entry
 * whose last holder is gone is torn down at the earliest one committed frame
 * after that release, which is after the frame that drew it was submitted.
 */
export function markFrameCommitted(): void {
  for (const entry of [...retiredEntries]) {
    if (entry.references > 0) continue;
    entry.framesWaiting += 1;
    if (entry.framesWaiting >= 1) teardownEntry(entry);
  }
}

export function configureTileGpuCache(maxBytes: number): void {
  store.maxBytes = Math.max(1, Math.floor(maxBytes));
  evictToBudget();
}

export function getTileGpuCacheStats(): TileGpuCacheStats {
  let geometryCount = 0;
  for (const entry of store.tiles.values()) geometryCount += entry.layers.size;
  return {
    entries: store.tiles.size,
    byteSize: store.byteSize,
    maxBytes: store.maxBytes,
    geometryCount,
    evictions: store.evictions,
    disposedGeometries: store.disposedGeometries,
    lastEvicted: [...store.lastEvicted],
    mounted: mountedHolders.size,
    retiredPending: retiredEntries.size,
  };
}

/** Install a decoded tile as GPU-ready geometry, one BufferGeometry per (tileId, layerId). */
export function putDecodedTile(tile: DecodedRenderTile): TileCacheEntry {
  const view = viewDecodedTile(tile);
  const stableIds = collectStableIds(view, tile);
  const layers = new Map<RenderLayerId, TileLayerEntry>();
  let firstStableId = 0;
  for (const layer of view.layers) {
    const layerFeatures = layer.ranges.length / 3;
    const geometry = isEmptyLayer(layer) ? null : geometryFromLayer(layer);
    if (geometry !== null) {
      const layerBytes = geometryByteSize(layer);
      layers.set(layer.id, {
        layerId: layer.id,
        geometry,
        byteSize: layerBytes,
        rangeLength: layer.ranges.length,
        firstStableId,
        featureCount: layerFeatures,
        isPointLayer: layer.isPointLayer,
      });
    }
    firstStableId += layerFeatures;
  }
  if (layers.size === 0) {
    throw new TileGpuCacheError(`tile ${view.tileId} produced no renderable layer geometry`);
  }
  const entry: TileCacheEntry = {
    tileId: view.tileId,
    lod: view.lod,
    slab: view.payload,
    /* One shared slab charged once in full: the per-layer geometries are views
       over those same bytes, so summing view lengths would double count them. */
    byteSize: view.payload.byteLength,
    layers,
    stableIds,
    references: 0,
    framesWaiting: 0,
    isRetired: false,
  };
  const previous = store.tiles.get(entry.tileId);
  if (previous !== undefined) {
    store.tiles.delete(entry.tileId);
    store.byteSize -= previous.byteSize;
    retireEntry(previous);
  }
  const holders = mountedHolders.get(entry.tileId);
  if (holders !== undefined) {
    for (const [token, holder] of holders) {
      if (holder !== undefined && holder.references > 0) holder.references -= 1;
      entry.references += 1;
      holders.set(token, entry);
    }
  }
  residentDecodedTiles.set(entry.tileId, tile);
  store.tiles.set(entry.tileId, entry);
  store.byteSize += entry.byteSize;
  evictToBudget();
  return entry;
}

/* Registry of the decoded tiles backing the cache, kept in the same LRU order
   as the cache itself; the value is the zero-copy tile whose payload is the
   slab the geometries view, so holding it costs no extra bytes. */
const residentDecodedTiles = new Map<string, DecodedRenderTile>();

export function getResidentDecodedTile(tileId: string): DecodedRenderTile | undefined {
  return residentDecodedTiles.get(tileId);
}

export function getResidentDecodedTiles(): ReadonlyMap<string, DecodedRenderTile> {
  return residentDecodedTiles;
}

/** Look up a cached tile, refreshing its recency. */
export function getTileCacheEntry(tileId: string): TileCacheEntry | undefined {
  const entry = store.tiles.get(tileId);
  if (entry === undefined) return undefined;
  store.tiles.delete(tileId);
  store.tiles.set(tileId, entry);
  return entry;
}

export function hasTileCacheEntry(tileId: string): boolean {
  return store.tiles.has(tileId);
}

/** Drop one tile from the cache; its geometry retires only once nothing holds it. */
export function evictTile(tileId: string): boolean {
  const entry = store.tiles.get(tileId);
  if (entry === undefined) return false;
  store.tiles.delete(tileId);
  residentDecodedTiles.delete(tileId);
  store.byteSize -= entry.byteSize;
  recordEviction(tileId);
  retireEntry(entry);
  return true;
}

/** Drop every tile the scene no longer references. */
export function retainTiles(tileIds: Iterable<string>): string[] {
  const keep = new Set(tileIds);
  const dropped: string[] = [];
  for (const tileId of store.tiles.keys()) {
    if (!keep.has(tileId)) dropped.push(tileId);
  }
  for (const tileId of dropped) evictTile(tileId);
  return dropped;
}

export function clearTileGpuCache(): void {
  for (const entry of store.tiles.values()) retireEntry(entry);
  store.tiles.clear();
  residentDecodedTiles.clear();
  store.byteSize = 0;
  store.evictions = 0;
  store.disposedGeometries = 0;
  store.lastEvicted = [];
}

export function resetTileGpuCache(maxBytes: number = DEFAULT_GPU_CACHE_BYTES): void {
  clearTileGpuCache();
  for (const entry of [...retiredEntries]) teardownEntry(entry);
  mountedHolders.clear();
  store = createStore(maxBytes);
}

/* entry.stableIds already carries the absolute meta order buildRenderTile
   emits, so the range triple's meta index is used on its own. */
export function pickStableId(entry: TileCacheEntry, layerId: string, faceIndex: number): string | undefined {
  const layer = entry.layers.get(layerId as RenderLayerId);
  if (layer === undefined) return undefined;
  if (layer.isPointLayer) return pickPointStableId(entry, layer, faceIndex);
  const ranges = layer.geometry.getAttribute('featureRange');
  if (ranges === undefined || ranges.count === 0) return undefined;
  for (let index = 0; index < ranges.count; index += 1) {
    const rangeStart = ranges.getX(index);
    const rangeCount = ranges.getY(index);
    if (faceIndex < rangeStart || faceIndex >= rangeStart + rangeCount) continue;
    return entry.stableIds[ranges.getZ(index)];
  }
  return undefined;
}

/* A point feature owns one vertex and a zero-length range, so the raycast
   reports the vertex index, which addresses the range triple directly. */
function pickPointStableId(entry: TileCacheEntry, layer: TileLayerEntry, vertexIndex: number): string | undefined {
  if (vertexIndex < 0 || vertexIndex >= layer.featureCount) return undefined;
  const ranges = layer.geometry.getAttribute('featureRange');
  if (ranges === undefined || ranges.count !== layer.featureCount) return undefined;
  let previous = -1;
  for (let index = 0; index < ranges.count; index += 1) {
    const metaIndex = ranges.getZ(index);
    if (metaIndex <= previous) return undefined;
    previous = metaIndex;
  }
  return entry.stableIds[ranges.getZ(vertexIndex)];
}

export function tileLayerIds(tileId: string): RenderLayerId[] {
  return [...(store.tiles.get(tileId)?.layers.keys() ?? [])];
}

export function tileLayerGeometry(tileId: string, layerId: string): BufferGeometry | undefined {
  return store.tiles.get(tileId)?.layers.get(layerId as RenderLayerId)?.geometry;
}
