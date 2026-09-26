'use client';

import { renderLayerIndices, renderLayerPositions, renderLayerRanges, type DecodedRenderTile } from './codec';
import { disposeTileWorkerPool, getTileWorkerPool, type QueueStats } from './workerPool';

export const DEFAULT_RENDER_TILE_CACHE_BYTES = 256 * 1024 * 1024;

export interface RenderTileCacheStats {
  entries: number;
  byteSize: number;
  maxBytes: number;
  inFlight: number;
  hits: number;
  misses: number;
  evictions: number;
  pool: QueueStats;
}

interface CacheEntry {
  tile: DecodedRenderTile;
  byteSize: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<DecodedRenderTile>>();
let cacheByteSize = 0;
let maxCacheBytes = DEFAULT_RENDER_TILE_CACHE_BYTES;
let hits = 0;
let misses = 0;
let evictions = 0;
let currentGeneration = 0;

export function configureRenderTileCache(options: { maxBytes?: number }): void {
  if (options.maxBytes !== undefined) maxCacheBytes = Math.max(1, options.maxBytes);
  evictToBudget();
}

export function getRenderTileCacheStats(): RenderTileCacheStats {
  return {
    entries: cache.size,
    byteSize: cacheByteSize,
    maxBytes: maxCacheBytes,
    inFlight: inFlight.size,
    hits,
    misses,
    evictions,
    pool: getTileWorkerPool().stats,
  };
}

export function clearRenderTileCache(): void {
  cache.clear();
  inFlight.clear();
  cacheByteSize = 0;
  hits = 0;
  misses = 0;
  evictions = 0;
}

export function nextRenderTileGeneration(): number {
  currentGeneration += 1;
  getTileWorkerPool().cancelOlderThan(currentGeneration);
  return currentGeneration;
}

export function getRenderTileGeneration(): number {
  return currentGeneration;
}

export function measuredTileBytes(tile: DecodedRenderTile): number {
  return tile.payload.byteLength;
}

export function tileLayerViews(tile: DecodedRenderTile, layerId: DecodedRenderTile['layers'][number]['id']): {
  positions: Float32Array;
  indices: Uint32Array;
  ranges: Uint32Array;
} | null {
  const layer = tile.layers.find((candidate) => candidate.id === layerId);
  if (layer === undefined) return null;
  return {
    positions: renderLayerPositions(tile.payload, layer),
    indices: renderLayerIndices(tile.payload, layer),
    ranges: renderLayerRanges(tile.payload, layer),
  };
}

function evictToBudget(): void {
  while (cache.size > 0 && cacheByteSize > maxCacheBytes) {
    const oldest = cache.entries().next();
    if (oldest.done) return;
    cache.delete(oldest.value[0]);
    cacheByteSize -= oldest.value[1].byteSize;
    evictions += 1;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

async function fetchRenderTile(tileId: string, signal: AbortSignal | undefined): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(`/api/map/render/${encodeURIComponent(tileId)}`, { signal });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`loadRenderTile: fetch failed for ${tileId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`loadRenderTile: HTTP ${response.status} for ${tileId}: ${body || response.statusText}`);
  }
  return response.arrayBuffer();
}

export async function loadRenderTile(tileId: string, signal?: AbortSignal): Promise<DecodedRenderTile> {
  if (!/^[a-zA-Z0-9_-]+$/.test(tileId) || tileId.includes('..')) {
    throw new Error(`loadRenderTile: invalid tileId "${tileId}"`);
  }
  const cached = cache.get(tileId);
  if (cached !== undefined) {
    cache.delete(tileId);
    cache.set(tileId, cached);
    hits += 1;
    return cached.tile;
  }
  const pending = inFlight.get(tileId);
  if (pending !== undefined && signal?.aborted !== true) {
    hits += 1;
    return pending;
  }
  misses += 1;
  const gen = currentGeneration;
  const request = fetchRenderTile(tileId, signal).then((buffer) => getTileWorkerPool().decode(tileId, buffer, gen));
  inFlight.set(tileId, request);
  try {
    const tile = await request;
    const byteSize = measuredTileBytes(tile);
    cache.delete(tileId);
    cache.set(tileId, { tile, byteSize });
    cacheByteSize += byteSize;
    evictToBudget();
    return tile;
  } finally {
    if (inFlight.get(tileId) === request) inFlight.delete(tileId);
  }
}

export function preloadRenderTile(tileId: string): void {
  void loadRenderTile(tileId).catch(() => undefined);
}

export function abortAllRenderTileLoads(): void {
  getTileWorkerPool().cancelOlderThan(currentGeneration);
  inFlight.clear();
}

export function disposeRenderTileRuntime(): void {
  clearRenderTileCache();
  disposeTileWorkerPool();
}
