/**
 * @file Per-tile GPU resource cache.
 *
 * Owns one BufferGeometry per (tileId, layerId) pair plus the stable
 * featureId -> canonical stableId mapping used for picking. Entries are
 * evicted in least-recently-used order once the byte budget is exceeded;
 * eviction disposes the geometries and drops the payload slab reference so
 * the decoded buffers can be collected. Adding or evicting one tile never
 * touches another tile's geometries.
 */
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
}

export interface TileGpuCacheStats {
  entries: number;
  byteSize: number;
  maxBytes: number;
  geometryCount: number;
  evictions: number;
  disposedGeometries: number;
  lastEvicted: string[];
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

function createStore(maxBytes: number): CacheStore {
  return { tiles: new Map(), byteSize: 0, maxBytes, evictions: 0, disposedGeometries: 0, lastEvicted: [] };
}

let store = createStore(DEFAULT_GPU_CACHE_BYTES);

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

function disposeEntry(entry: TileCacheEntry): void {
  for (const layer of entry.layers.values()) {
    layer.geometry.dispose();
    store.disposedGeometries += 1;
  }
  entry.layers.clear();
  entry.stableIds.length = 0;
  entry.slab = EMPTY_SLAB;
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
    disposeEntry(entry);
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
  };
}

/**
 * Install a decoded tile as GPU-ready geometry, one BufferGeometry per
 * (tileId, layerId). The payload slab stays referenced by the entry so
 * every geometry attribute keeps a live view of it.
 */
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
    /* One shared slab, charged once in full: the per-layer geometries are
       views over those same bytes, so summing view lengths would double
       count them. byteSize therefore tracks the real retained size, which is
       what the 512MB budget has to bound. */
    byteSize: view.payload.byteLength,
    layers,
    stableIds,
  };
  const previous = store.tiles.get(entry.tileId);
  if (previous !== undefined) {
    store.tiles.delete(entry.tileId);
    store.byteSize -= previous.byteSize;
    disposeEntry(previous);
  }
  residentDecodedTiles.set(entry.tileId, tile);
  store.tiles.set(entry.tileId, entry);
  store.byteSize += entry.byteSize;
  evictToBudget();
  return entry;
}

/* Registry of the decoded tiles backing the cache, keyed by tileId in the
   same LRU order as the cache itself, so iterating it is iterating in render
   order. The value is the very object putDecodedTile received: it is
   zero-copy (its payload is the same slab the geometries view), so holding
   it costs no extra bytes, and it is a superset of what consumers need
   (meta, header.bounds, and per-layer descriptors to read featureRanges). */
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

/**
 * Remove one tile from the cache and dispose its geometries. Tiles the
 * scene still needs must be re-installed from their decoded tile.
 */
export function evictTile(tileId: string): boolean {
  const entry = store.tiles.get(tileId);
  if (entry === undefined) return false;
  store.tiles.delete(tileId);
  residentDecodedTiles.delete(tileId);
  store.byteSize -= entry.byteSize;
  recordEviction(tileId);
  disposeEntry(entry);
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
  for (const entry of store.tiles.values()) disposeEntry(entry);
  store.tiles.clear();
  residentDecodedTiles.clear();
  store.byteSize = 0;
  store.evictions = 0;
  store.disposedGeometries = 0;
  store.lastEvicted = [];
}

export function resetTileGpuCache(maxBytes: number = DEFAULT_GPU_CACHE_BYTES): void {
  clearTileGpuCache();
  store = createStore(maxBytes);
}

/**
 * Resolve the stableId of a picked feature. Each layer stores its
 * featureRanges as [indexStart, indexCount, metaIndex] triples, so the
 * canonical stableId comes from the meta index of the range covering the
 * picked triangle index.
 *
 * metaIndex is absolute into the tile-wide meta array, and stableIds is built
 * by walking the layers in order with a cursor, so entry.stableIds already
 * carries that same absolute ordering. Adding the layer's firstStableId on top
 * of it double-offset every pick on a layer that is not the first to emit a
 * feature, which is why the index is used on its own here.
 */
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

/**
 * Resolve a point-layer pick. A point feature owns exactly one vertex and a
 * zero-length range, so a face-index scan can never match it: the raycast
 * reports the vertex index instead, which addresses the range triple
 * directly. The guard rejects a tile whose point ranges do not map one
 * strictly increasing meta entry per feature, which is the only shape a
 * point layer can legitimately have.
 */
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
