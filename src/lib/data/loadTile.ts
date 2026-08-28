import { TileDataSchema, type TileData } from "./schema";

const DEFAULT_MAX_CACHE_SIZE_MB = 128;
const DEFAULT_MAX_TILE_SIZE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
  data: TileData;
  size: number;
}

class LruCache<K, V> {
  private readonly values = new Map<K, V>();

  get(key: K): V | undefined {
    const value = this.values.get(key);
    if (value !== undefined) {
      this.values.delete(key);
      this.values.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.values.delete(key);
    this.values.set(key, value);
  }

  get size(): number {
    return this.values.size;
  }

  popOldest(): { key: K; value: V } | undefined {
    const oldest = this.values.entries().next();
    if (oldest.done) return undefined;
    const [key, value] = oldest.value;
    this.values.delete(key);
    return { key, value };
  }

  clear(): void {
    this.values.clear();
  }
}

let cache: LruCache<string, CacheEntry> | null = null;
let cacheByteSize = 0;
let maxCacheSize = DEFAULT_MAX_CACHE_SIZE_MB * 1024 * 1024;
let maxTileSize = DEFAULT_MAX_TILE_SIZE_BYTES;
let maxEntries = DEFAULT_MAX_CACHE_ENTRIES;
const inFlight = new Map<string, Promise<TileData>>();

export function configureTileLoader(options: { maxCacheSizeMb?: number; maxTileSizeBytes?: number; maxEntries?: number }): void {
  if (options.maxCacheSizeMb !== undefined) maxCacheSize = options.maxCacheSizeMb * 1024 * 1024;
  if (options.maxTileSizeBytes !== undefined) maxTileSize = options.maxTileSizeBytes;
  if (options.maxEntries !== undefined && options.maxEntries !== maxEntries) {
    maxEntries = options.maxEntries;
    clearTileCache();
  }
  evictToLimits();
}

export function clearTileCache(): void {
  cache?.clear();
  inFlight.clear();
  cacheByteSize = 0;
}

export function getTileCacheStats(): { entries: number; byteSize: number; maxBytes: number } {
  return { entries: cache?.size ?? 0, byteSize: cacheByteSize, maxBytes: maxCacheSize };
}

function evictToLimits(): void {
  if (!cache) return;
  while (cache.size > maxEntries || cacheByteSize > maxCacheSize) {
    const removed = cache.popOldest();
    if (!removed) break;
    cacheByteSize -= removed.value.size;
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export async function loadTile(tileId: string, signal?: AbortSignal): Promise<TileData> {
  if (!/^[a-zA-Z0-9_-]+$/.test(tileId) || tileId.includes("..")) throw new Error(`loadTile: invalid tileId "${tileId}"`);
  if (!cache) cache = new LruCache<string, CacheEntry>();
  const cached = cache.get(tileId);
  if (cached) return cached.data;
  const pending = inFlight.get(tileId);
  if (pending && !(signal?.aborted ?? false)) return pending;
  const request = fetchTile(tileId, signal);
  inFlight.set(tileId, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(tileId) === request) inFlight.delete(tileId);
  }
}

async function fetchTile(tileId: string, signal?: AbortSignal): Promise<TileData> {
  if (!cache) cache = new LruCache<string, CacheEntry>();
  let response: Response;
  try {
    response = await fetch(`/api/map/tile/${encodeURIComponent(tileId)}`, { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`loadTile: fetch failed for ${tileId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`loadTile: HTTP ${response.status} for ${tileId}: ${body || response.statusText}`);
  }
  const headerLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(headerLength) && headerLength > maxTileSize) throw new Error(`loadTile: tile ${tileId} exceeds ${maxTileSize} bytes`);
  const payload = await response.text();
  const byteSize = new TextEncoder().encode(payload).byteLength;
  if (byteSize > maxTileSize) throw new Error(`loadTile: tile ${tileId} exceeds ${maxTileSize} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    throw new Error(`loadTile: tile ${tileId} response is not valid JSON`);
  }
  const data = TileDataSchema.parse(parsed);
  if (data.manifest.tileId !== tileId) throw new Error(`loadTile: tile ID mismatch for ${tileId}`);
  if (data.manifest.featureCount !== data.features.length) throw new Error(`loadTile: feature count mismatch for ${tileId}`);
  if (cacheByteSize + byteSize > maxCacheSize) evictToLimits();
  if (byteSize <= maxCacheSize) {
    cache.set(tileId, { data, size: byteSize });
    cacheByteSize += byteSize;
    evictToLimits();
  }
  return data;
}
