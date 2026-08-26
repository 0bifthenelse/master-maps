/**
 * Tile loader for the Auch map data pipeline.
 * Fetches tiles from /api/map/tile/{tileId} with AbortController support,
 * bounded LRU cache, response-size checks, and manifest validation.
 */

// ---- Local fallback types (converge when schema.ts lands) ----
interface TileManifestFallback {
  tileId: string;
  bounds: [number, number, number, number];
  featureCount: number;
  byteSize: number;
  features: string[];
}

interface TileResponseFallback {
  manifest: TileManifestFallback;
  features: unknown[];
  metadata?: Record<string, unknown>;
}

// ---- LRU Cache ----
interface CacheEntry {
  data: TileResponseFallback;
  size: number;
}

const DEFAULT_MAX_CACHE_SIZE_MB = 128;
const DEFAULT_MAX_TILE_SIZE_BYTES = 768 * 1024; // 750 KiB budget + margin
const DEFAULT_MAX_CACHE_ENTRIES = 64;

class LRUMap<K, V> {
  private _map = new Map<K, V>();
  private _max: number;

  constructor(max: number) {
    this._max = max;
  }

  get(key: K): V | undefined {
    const val = this._map.get(key);
    if (val !== undefined) {
      this._map.delete(key);
      this._map.set(key, val);
    }
    return val;
  }

  set(key: K, value: V): void {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._max) {
      const oldest = this._map.keys().next();
      if (!oldest.done && oldest.value !== undefined) {
        this._map.delete(oldest.value);
      }
    }
    this._map.set(key, value);
  }

  has(key: K): boolean {
    return this._map.has(key);
  }

  delete(key: K): boolean {
    return this._map.delete(key);
  }

  clear(): void {
    this._map.clear();
  }

  get size(): number {
    return this._map.size;
  }

  /** Pop and return the oldest entry key, or undefined if empty. */
  popOldest(): K | undefined {
    const first = this._map.keys().next();
    if (first.done || first.value === undefined) return undefined;
    this._map.delete(first.value);
    return first.value;
  }
}

// ---- State ----
let cache: LRUMap<string, CacheEntry> | null = null;
let cacheByteSize = 0;
let maxCacheSize = DEFAULT_MAX_CACHE_SIZE_MB * 1024 * 1024;
let maxTileSize = DEFAULT_MAX_TILE_SIZE_BYTES;
let maxEntries = DEFAULT_MAX_CACHE_ENTRIES;

// ---- Public config ----
export function configureTileLoader(opts: {
  maxCacheSizeMb?: number;
  maxTileSizeBytes?: number;
  maxEntries?: number;
}): void {
  if (opts.maxCacheSizeMb !== undefined) {
    maxCacheSize = opts.maxCacheSizeMb * 1024 * 1024;
  }
  if (opts.maxTileSizeBytes !== undefined) {
    maxTileSize = opts.maxTileSizeBytes;
  }
  if (opts.maxEntries !== undefined) {
    maxEntries = opts.maxEntries;
  }
}

export function clearTileCache(): void {
  cache?.clear();
  cacheByteSize = 0;
}

export function getTileCacheStats(): { entries: number; byteSize: number; maxBytes: number } {
  return {
    entries: cache?.size ?? 0,
    byteSize: cacheByteSize,
    maxBytes: maxCacheSize,
  };
}

// ---- Validation helpers ----
function validateManifest(obj: unknown): TileManifestFallback {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("TileManifest: expected object");
  }

  const m = obj as Record<string, unknown>;
  const tileId = typeof m.tileId === "string" && m.tileId.length > 0 ? m.tileId : null;
  if (!tileId) throw new Error("TileManifest: missing or invalid tileId");

  const boundsArr = m.bounds;
  const bounds: [number, number, number, number] | null =
    Array.isArray(boundsArr) &&
    boundsArr.length === 4 &&
    boundsArr.every((v: unknown) => typeof v === "number" && isFinite(v))
      ? [boundsArr[0], boundsArr[1], boundsArr[2], boundsArr[3]]
      : null;
  if (!bounds) throw new Error("TileManifest: bounds must be [west, south, east, north]");

  if (typeof m.featureCount !== "number" || !isFinite(m.featureCount) || m.featureCount < 0) {
    throw new Error("TileManifest: invalid featureCount");
  }
  if (typeof m.byteSize !== "number" || !isFinite(m.byteSize) || m.byteSize < 0) {
    throw new Error("TileManifest: invalid byteSize");
  }
  if (!Array.isArray(m.features)) {
    throw new Error("TileManifest: features must be an array");
  }

  return {
    tileId,
    bounds,
    featureCount: m.featureCount,
    byteSize: m.byteSize,
    features: m.features as string[],
  };
}

function evictDownTo(maxBytes: number): void {
  if (!cache) return;
  while (cache.size > 0 && cacheByteSize > maxBytes) {
    const oldestKey = cache.popOldest();
    if (oldestKey === undefined) break;
    const entry = cache.get(oldestKey);
    if (entry) {
      cacheByteSize -= entry.size;
    }
    cache.delete(oldestKey);
  }
}

// ---- Main loader ----
export async function loadTile(
  tileId: string,
  signal?: AbortSignal
): Promise<TileResponseFallback> {
  if (!tileId || typeof tileId !== "string") {
    throw new Error(`loadTile: invalid tileId "${tileId}"`);
  }
  if (tileId.includes("/") || tileId.includes("\\") || tileId.includes("..")) {
    throw new Error(`loadTile: tileId contains path traversal characters: "${tileId}"`);
  }

  if (!cache) {
    cache = new LRUMap<string, CacheEntry>(maxEntries);
  }

  const cached = cache.get(tileId);
  if (cached) {
    return cached.data;
  }

  const url = `/api/map/tile/${encodeURIComponent(tileId)}`;

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`loadTile: fetch failed for ${tileId}: ${msg}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `loadTile: HTTP ${response.status} for ${tileId}: ${body || response.statusText}`
    );
  }

  const contentLength = response.headers.get("Content-Length");
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (!isNaN(len) && len > maxTileSize) {
      throw new Error(
        `loadTile: tile ${tileId} exceeds max size (${len} > ${maxTileSize} bytes)`
      );
    }
  }

  const text = await response.text();
  const byteSize = new TextEncoder().encode(text).length;

  if (byteSize > maxTileSize) {
    throw new Error(
      `loadTile: tile ${tileId} exceeds max size (${byteSize} > ${maxTileSize} bytes)`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`loadTile: tile ${tileId} response is not valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`loadTile: tile ${tileId} response is not an object`);
  }
  const obj: Record<string, unknown> = parsed as Record<string, unknown>;

  if (typeof obj.manifest !== "object" || obj.manifest === null) {
    throw new Error(`loadTile: tile ${tileId} response missing manifest`);
  }
  const manifest = validateManifest(obj.manifest);

  if (manifest.tileId !== tileId) {
    throw new Error(
      `loadTile: manifest tileId mismatch: expected "${tileId}", got "${manifest.tileId}"`
    );
  }

  if (!Array.isArray(obj.features)) {
    throw new Error(`loadTile: tile ${tileId} response missing features array`);
  }

  const expectedSize = manifest.byteSize;
  if (expectedSize > 0 && byteSize !== expectedSize) {
    console.warn(
      `loadTile: tile ${tileId} byteSize mismatch: actual=${byteSize}, manifest=${expectedSize}`
    );
  }

  const metadata =
    typeof obj.metadata === "object" && obj.metadata !== null
      ? (obj.metadata as Record<string, unknown>)
      : undefined;

  const tileData: TileResponseFallback = {
    manifest,
    features: obj.features as unknown[],
    metadata,
  };

  if (cacheByteSize + byteSize > maxCacheSize) {
    evictDownTo(maxCacheSize - byteSize);
  }

  cache.set(tileId, { data: tileData, size: byteSize });
  cacheByteSize += byteSize;

  return tileData;
}