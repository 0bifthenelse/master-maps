import type { DecodedRenderTile, FeatureMeta } from "./codec";

/**
 * Decoded tiles resident on the client, least recently used first. GPU
 * geometry is owned by the mounted scene objects, so evicting a tile here
 * only drops its CPU slab; the meshes of a tile still on screen keep their
 * own references until React unmounts them.
 */

export const DEFAULT_TILE_STORE_BYTES = 384 * 1024 * 1024;

interface Entry {
  tile: DecodedRenderTile;
  bytes: number;
}

const entries = new Map<string, Entry>();
let totalBytes = 0;
let maxBytes = DEFAULT_TILE_STORE_BYTES;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeTileStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function putTile(tile: DecodedRenderTile): void {
  const id = tile.header.tileId;
  const previous = entries.get(id);
  if (previous !== undefined) {
    totalBytes -= previous.bytes;
    entries.delete(id);
  }
  const bytes = tile.payload.byteLength;
  entries.set(id, { tile, bytes });
  totalBytes += bytes;
  notify();
}

export function getTile(id: string): DecodedRenderTile | undefined {
  const entry = entries.get(id);
  if (entry === undefined) return undefined;
  entries.delete(id);
  entries.set(id, entry);
  return entry.tile;
}

export function peekTile(id: string): DecodedRenderTile | undefined {
  return entries.get(id)?.tile;
}

export function hasTile(id: string): boolean {
  return entries.has(id);
}

export function deleteTile(id: string): void {
  const entry = entries.get(id);
  if (entry === undefined) return;
  entries.delete(id);
  totalBytes -= entry.bytes;
}

/** Drop the oldest tiles not in `keep` until the store fits its budget. */
export function trimTileStore(keep: ReadonlySet<string>, budget = maxBytes): string[] {
  const dropped: string[] = [];
  for (const [id, entry] of entries) {
    if (totalBytes <= budget) break;
    if (keep.has(id)) continue;
    entries.delete(id);
    totalBytes -= entry.bytes;
    dropped.push(id);
  }
  return dropped;
}

export function configureTileStore(bytes: number): void {
  maxBytes = Math.max(16 * 1024 * 1024, bytes);
}

export function tileStoreStats(): { tiles: number; bytes: number; maxBytes: number } {
  return { tiles: entries.size, bytes: totalBytes, maxBytes };
}

export function clearTileStore(): void {
  entries.clear();
  totalBytes = 0;
  notify();
}

export function residentTileIds(): string[] {
  return [...entries.keys()];
}

/** Every meta entry of a resident tile with this stable id, first match wins. */
export function findFeatureMeta(stableId: string, tileIds?: Iterable<string>): { tileId: string; meta: FeatureMeta; index: number } | null {
  const ids = tileIds ?? entries.keys();
  for (const id of ids) {
    const tile = entries.get(id)?.tile;
    if (tile === undefined) continue;
    const index = tile.meta.findIndex((entry) => entry.s === stableId);
    if (index >= 0) return { tileId: id, meta: tile.meta[index]!, index };
  }
  return null;
}
