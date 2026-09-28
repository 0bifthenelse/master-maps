'use client';

import { GERS_TILE_LEVELS } from '@/lib/geo/tiling';
import type { TileManifest } from '@/lib/data/schema';

export type Bounds = [number, number, number, number];
export type TileQuad = [number, number][];
export type TileLod = 0 | 1 | 2;

export const LOD_TILE_METRES: readonly number[] = GERS_TILE_LEVELS.map((tileLevel) => tileLevel.tileSize);
export const LOD_COUNT = LOD_TILE_METRES.length;
export const MIN_TILE_PIXELS = 128;
export const LOD_METRES_PER_PIXEL: readonly number[] = LOD_TILE_METRES.map((metres) => metres / MIN_TILE_PIXELS);
export const LOD_HYSTERESIS = 0.12;
export const PREFETCH_FRACTION = 0.2;
export const MIN_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 10;
export const TILE_LOAD_TARGET_MS = 80;
export const FAST_SAMPLE_RATIO = 0.7;
export const SLOW_SAMPLE_RATIO = 1.3;

export interface SchedulerViewport {
  target: [number, number];
  zoom: number;
  frustumWidth: number;
  frustumHeight: number;
  headingRadians: number;
}

export interface TileIndex {
  cellSize: number;
  originX: number;
  originZ: number;
  columns: number;
  rows: number;
  cells: TileManifest[][];
  byLod: TileManifest[][];
  largestTileMetres: number;
}

export interface TilePlanInput {
  viewport: SchedulerViewport | null;
  currentLod: number;
  resident: ReadonlySet<string>;
  index: TileIndex;
  bounds: Bounds;
  halo: number;
  requireAll?: boolean;
}

export interface TilePlan {
  lod: number;
  required: string[];
  retain: string[];
  prefetch: string[];
}

export interface ConcurrencyDecision {
  concurrency: number;
  sampleEvent: 'fast' | 'slow' | 'steady';
}

interface WorldPoint {
  x: number;
  z: number;
}

function clampLod(lod: number): number {
  if (!Number.isFinite(lod)) return 0;
  return Math.max(0, Math.min(LOD_COUNT - 1, Math.round(lod)));
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export const TILE_EDGE_EPSILON = 1e-6;

function contains(outer: Bounds, inner: Bounds): boolean {
  return outer[0] <= inner[0] + TILE_EDGE_EPSILON
    && outer[1] <= inner[1] + TILE_EDGE_EPSILON
    && outer[2] >= inner[2] - TILE_EDGE_EPSILON
    && outer[3] >= inner[3] - TILE_EDGE_EPSILON;
}

function quadBounds(quad: TileQuad): Bounds {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const corner of quad) {
    if (corner[0] < minX) minX = corner[0];
    if (corner[0] > maxX) maxX = corner[0];
    if (corner[1] < minZ) minZ = corner[1];
    if (corner[1] > maxZ) maxZ = corner[1];
  }
  return [minX, minZ, maxX, maxZ];
}

function expand(bounds: Bounds, margin: number): Bounds {
  return [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin];
}

function isSeparated(bounds: Bounds, quad: TileQuad, axis: WorldPoint): boolean {
  let quadMin = Infinity;
  let quadMax = -Infinity;
  for (const corner of quad) {
    const projection = axis.x * corner[0] + axis.z * corner[1];
    if (projection < quadMin) quadMin = projection;
    if (projection > quadMax) quadMax = projection;
  }
  const tileLow = Math.min(
    axis.x >= 0 ? axis.x * bounds[0] : axis.x * bounds[2],
    axis.z >= 0 ? axis.z * bounds[1] : axis.z * bounds[3],
    axis.x >= 0 ? axis.x * bounds[2] : axis.x * bounds[0],
    axis.z >= 0 ? axis.z * bounds[3] : axis.z * bounds[1],
  );
  const tileHigh = Math.max(
    axis.x >= 0 ? axis.x * bounds[0] : axis.x * bounds[2],
    axis.z >= 0 ? axis.z * bounds[1] : axis.z * bounds[3],
    axis.x >= 0 ? axis.x * bounds[2] : axis.x * bounds[0],
    axis.z >= 0 ? axis.z * bounds[3] : axis.z * bounds[1],
  );
  return tileLow > quadMax || tileHigh < quadMin;
}

export function isUsableViewport(viewport: SchedulerViewport | null): boolean {
  if (viewport === null) return true;
  return Number.isFinite(viewport.target[0])
    && Number.isFinite(viewport.target[1])
    && Number.isFinite(viewport.zoom)
    && Number.isFinite(viewport.frustumWidth)
    && Number.isFinite(viewport.frustumHeight)
    && Number.isFinite(viewport.headingRadians)
    && viewport.zoom > 0
    && viewport.frustumWidth > 0
    && viewport.frustumHeight > 0;
}

/* Corners run top-left, top-right, bottom-right, bottom-left in NDC, so top
   corners have ndcY 1 and screen-up maps to increasing world z. */
export function visibleWorldQuad(viewport: SchedulerViewport): TileQuad {
  const halfWidth = viewport.frustumWidth / (2 * viewport.zoom);
  const halfHeight = viewport.frustumHeight / (2 * viewport.zoom);
  const cosine = Math.cos(viewport.headingRadians);
  const sine = Math.sin(viewport.headingRadians);
  const [targetX, targetZ] = viewport.target;
  const at = (ndcX: number, ndcY: number): [number, number] => [
    targetX + cosine * ndcX * halfWidth + sine * ndcY * halfHeight,
    targetZ - sine * ndcX * halfWidth + cosine * ndcY * halfHeight,
  ];
  return [at(-1, 1), at(1, 1), at(1, -1), at(-1, -1)];
}

export function tileIntersectsQuad(bounds: Bounds, quad: TileQuad): boolean {
  if (quad.length < 3) return false;
  if (!overlaps(bounds, quadBounds(quad))) return false;
  for (let edge = 0; edge < quad.length; edge += 1) {
    const from = quad[edge]!;
    const to = quad[(edge + 1) % quad.length]!;
    const edgeX = to[0] - from[0];
    const edgeZ = to[1] - from[1];
    const length = Math.hypot(edgeX, edgeZ);
    if (length === 0) continue;
    if (isSeparated(bounds, quad, { x: -edgeZ / length, z: edgeX / length })) return false;
  }
  return true;
}

export function worldMetresPerPixel(viewport: SchedulerViewport, canvasWidth: number, canvasHeight: number): number {
  if (!isUsableViewport(viewport)) return Number.POSITIVE_INFINITY;
  return Math.max(
    viewport.frustumWidth / viewport.zoom / Math.max(1, canvasWidth),
    viewport.frustumHeight / viewport.zoom / Math.max(1, canvasHeight),
  );
}

export function createTileIndex(entries: readonly TileManifest[]): TileIndex {
  const byLod: TileManifest[][] = Array.from({ length: LOD_COUNT }, () => []);
  const cellSize = LOD_TILE_METRES[LOD_COUNT - 1]!;
  let originX = Infinity;
  let originZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  let largestTileMetres = 0;
  for (const entry of entries) {
    byLod[clampLod(entry.lod)]!.push(entry);
    largestTileMetres = Math.max(largestTileMetres, entry.bounds[2] - entry.bounds[0], entry.bounds[3] - entry.bounds[1]);
    originX = Math.min(originX, entry.bounds[0]);
    originZ = Math.min(originZ, entry.bounds[1]);
    maxX = Math.max(maxX, entry.bounds[2]);
    maxZ = Math.max(maxZ, entry.bounds[3]);
  }
  if (entries.length === 0) {
    return { cellSize, originX: 0, originZ: 0, columns: 0, rows: 0, cells: [], byLod, largestTileMetres: 0 };
  }
  const columns = Math.max(1, Math.ceil((maxX - originX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - originZ) / cellSize));
  const cells: TileManifest[][] = Array.from({ length: columns * rows }, () => []);
  for (const entry of entries) {
    const fromX = Math.max(0, Math.min(columns - 1, Math.floor((entry.bounds[0] - originX) / cellSize)));
    const toX = Math.max(0, Math.min(columns - 1, Math.floor((entry.bounds[2] - originX) / cellSize)));
    const fromZ = Math.max(0, Math.min(rows - 1, Math.floor((entry.bounds[1] - originZ) / cellSize)));
    const toZ = Math.max(0, Math.min(rows - 1, Math.floor((entry.bounds[3] - originZ) / cellSize)));
    for (let z = fromZ; z <= toZ; z += 1) {
      for (let x = fromX; x <= toX; x += 1) cells[z * columns + x]!.push(entry);
    }
  }
  return { cellSize, originX, originZ, columns, rows, cells, byLod, largestTileMetres };
}

export function queryTileIndex(index: TileIndex, bounds: Bounds, lod?: number): TileManifest[] {
  if (index.cells.length === 0) return [];
  const fromX = Math.max(0, Math.min(index.columns - 1, Math.floor((bounds[0] - index.originX) / index.cellSize)));
  const toX = Math.max(0, Math.min(index.columns - 1, Math.floor((bounds[2] - index.originX) / index.cellSize)));
  const fromZ = Math.max(0, Math.min(index.rows - 1, Math.floor((bounds[1] - index.originZ) / index.cellSize)));
  const toZ = Math.max(0, Math.min(index.rows - 1, Math.floor((bounds[3] - index.originZ) / index.cellSize)));
  const wanted = lod === undefined ? null : clampLod(lod);
  const found = new Set<string>();
  const matches: TileManifest[] = [];
  for (let z = fromZ; z <= toZ; z += 1) {
    for (let x = fromX; x <= toX; x += 1) {
      for (const entry of index.cells[z * index.columns + x]!) {
        if (wanted !== null && entry.lod !== wanted) continue;
        if (!overlaps(entry.bounds, bounds)) continue;
        if (found.has(entry.tileId)) continue;
        found.add(entry.tileId);
        matches.push(entry);
      }
    }
  }
  return matches;
}

function tileCentreDistance(entry: TileManifest, x: number, z: number): number {
  return Math.hypot((entry.bounds[0] + entry.bounds[2]) / 2 - x, (entry.bounds[1] + entry.bounds[3]) / 2 - z);
}

function byTileId(a: TileManifest, b: TileManifest): number {
  return a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0;
}

function centreFirstOrder(entries: readonly TileManifest[], targetX: number, targetZ: number): TileManifest[] {
  return [...entries].sort((a, b) => {
    const byDistance = tileCentreDistance(a, targetX, targetZ) - tileCentreDistance(b, targetX, targetZ);
    return byDistance !== 0 ? byDistance : byTileId(a, b);
  });
}

/* The finest level whose tile still covers MIN_TILE_PIXELS on screen is
   LOD_METRES_PER_PIXEL[lod] = tile size / MIN_TILE_PIXELS. The current level
   stays selected while the value stays inside its own band around that
   threshold, so a few percent of zoom jitter cannot flip the level. */
export function resolveLod(metresPerPixel: number, currentLod: number, hysteresis: number = LOD_HYSTERESIS): TileLod {
  const current = clampLod(currentLod) as TileLod;
  const value = Number.isFinite(metresPerPixel) ? metresPerPixel : 0;
  const band = Math.max(0, hysteresis);
  const lower = current > 0 ? LOD_METRES_PER_PIXEL[current - 1]! * (1 - band) : 0;
  const upper = LOD_METRES_PER_PIXEL[current]! * (1 + band);
  if (value > lower && value <= upper) return current;
  let selected: TileLod = (LOD_COUNT - 1) as TileLod;
  for (let lod = 0; lod < LOD_COUNT; lod += 1) {
    if (value <= LOD_METRES_PER_PIXEL[lod]!) {
      selected = lod as TileLod;
      break;
    }
  }
  return selected;
}

function overviewLod(index: TileIndex, bounds: Bounds): number {
  for (let lod = LOD_COUNT - 1; lod >= 0; lod -= 1) {
    if (queryTileIndex(index, bounds, lod).length > 0) return lod;
  }
  return 0;
}

function visibleAt(index: TileIndex, lod: number, quad: TileQuad, halo: number, targetX: number, targetZ: number): TileManifest[] {
  const search = expand(quadBounds(quad), halo + index.largestTileMetres);
  return centreFirstOrder(
    queryTileIndex(index, search, lod).filter((entry) => tileIntersectsQuad(expand(entry.bounds, halo), quad)),
    targetX,
    targetZ,
  );
}

function requiredAt(index: TileIndex, lod: number, quad: TileQuad, halo: number, targetX: number, targetZ: number): TileManifest[] {
  for (let candidate = lod; candidate >= 0; candidate -= 1) {
    const visible = visibleAt(index, candidate, quad, halo, targetX, targetZ);
    if (visible.length > 0) return visible;
  }
  for (let candidate = lod + 1; candidate < LOD_COUNT; candidate += 1) {
    const visible = visibleAt(index, candidate, quad, halo, targetX, targetZ);
    if (visible.length > 0) return visible;
  }
  return [];
}

function isNeighbourOf(a: TileManifest, b: TileManifest): boolean {
  if (a.bounds[0] < b.bounds[2] && a.bounds[2] > b.bounds[0] && a.bounds[1] < b.bounds[3] && a.bounds[3] > b.bounds[1]) return true;
  const touchX = Math.abs(a.bounds[2] - b.bounds[0]) <= 1e-6 || Math.abs(b.bounds[2] - a.bounds[0]) <= 1e-6;
  const touchZ = Math.abs(a.bounds[3] - b.bounds[1]) <= 1e-6 || Math.abs(b.bounds[3] - a.bounds[1]) <= 1e-6;
  if (touchX && a.bounds[1] <= b.bounds[3] && a.bounds[3] >= b.bounds[1]) return true;
  return touchZ && a.bounds[0] <= b.bounds[2] && a.bounds[2] >= b.bounds[0];
}

function ringPrefetch(index: TileIndex, required: readonly TileManifest[], halo: number): TileManifest[] {
  if (required.length === 0) return [];
  const requiredIds = new Set(required.map((entry) => entry.tileId));
  const seen = new Set<string>();
  const ring: TileManifest[] = [];
  for (const entry of required) {
    const centreX = (entry.bounds[0] + entry.bounds[2]) / 2;
    const centreZ = (entry.bounds[1] + entry.bounds[3]) / 2;
    const radius = Math.max(entry.bounds[2] - entry.bounds[0], entry.bounds[3] - entry.bounds[1]) / 2 + halo;
    for (const candidate of queryTileIndex(index, [centreX - radius, centreZ - radius, centreX + radius, centreZ + radius], entry.lod)) {
      if (requiredIds.has(candidate.tileId) || seen.has(candidate.tileId) || !isNeighbourOf(entry, candidate)) continue;
      seen.add(candidate.tileId);
      ring.push(candidate);
    }
  }
  return ring;
}

function coverPrefetch(index: TileIndex, required: readonly TileManifest[], lod: number): TileManifest[] {
  if (lod <= 0 || required.length === 0) return [];
  const requiredIds = new Set(required.map((entry) => entry.tileId));
  const covers = new Map<string, TileManifest>();
  for (const entry of required) {
    for (const candidate of queryTileIndex(index, entry.bounds, lod - 1)) {
      if (!contains(candidate.bounds, entry.bounds)) continue;
      covers.set(candidate.tileId, candidate);
    }
  }
  return [...covers.values()].filter((entry) => !requiredIds.has(entry.tileId));
}

function planRetain(
  index: TileIndex,
  required: readonly TileManifest[],
  requiredIds: ReadonlySet<string>,
  resident: ReadonlySet<string>,
  quad: TileQuad | null,
  requireAll: boolean,
): string[] {
  const missing = requireAll ? [...required] : required.filter((entry) => !resident.has(entry.tileId));
  const retain = required.filter((entry) => resident.has(entry.tileId)).map((entry) => entry.tileId);
  const covers: string[] = [];
  const visibleFallback: string[] = [];
  for (const entries of index.byLod) {
    for (const entry of entries) {
      if (!resident.has(entry.tileId) || requiredIds.has(entry.tileId)) continue;
      if (quad !== null && !tileIntersectsQuad(entry.bounds, quad)) continue;
      if (missing.some((target) => entry.lod > target.lod && contains(entry.bounds, target.bounds))) {
        covers.push(entry.tileId);
      } else if (requireAll || missing.length > 0) {
        visibleFallback.push(entry.tileId);
      }
    }
  }
  for (const tileId of [...covers.sort(), ...visibleFallback.sort()]) {
    if (!retain.includes(tileId)) retain.push(tileId);
  }
  return retain;
}

function finishPlan(
  lod: number,
  required: readonly TileManifest[],
  retain: string[],
  prefetchSource: readonly TileManifest[],
  targetX: number,
  targetZ: number,
): TilePlan {
  const requiredIds = new Set(required.map((entry) => entry.tileId));
  const limit = Math.max(0, Math.min(Math.ceil(required.length * PREFETCH_FRACTION), required.length - 1));
  const prefetch = centreFirstOrder(prefetchSource, targetX, targetZ)
    .slice(0, limit)
    .map((entry) => entry.tileId)
    .filter((tileId) => !requiredIds.has(tileId));
  return { lod, required: required.map((entry) => entry.tileId), retain, prefetch };
}

export function planTiles(input: TilePlanInput): TilePlan {
  const { viewport, index, resident, bounds, halo } = input;
  const requireAll = input.requireAll === true;
  const requestedLod = clampLod(input.currentLod);
  if (!isUsableViewport(viewport)) {
    return { lod: requestedLod, required: [], retain: [...resident].sort(), prefetch: [] };
  }
  if (viewport === null) {
    const lod = overviewLod(index, bounds);
    const level = [...(index.byLod[lod] ?? [])].sort(byTileId);
    const requiredIds = new Set(level.map((entry) => entry.tileId));
    return { lod, required: level.map((entry) => entry.tileId), retain: planRetain(index, level, requiredIds, resident, null, requireAll), prefetch: [] };
  }
  const targetX = viewport.target[0];
  const targetZ = viewport.target[1];
  const quad = visibleWorldQuad(viewport);
  const required = requiredAt(index, requestedLod, quad, halo, targetX, targetZ);
  const lod = required[0]?.lod ?? requestedLod;
  const requiredIds = new Set(required.map((entry) => entry.tileId));
  const retain = planRetain(index, required, requiredIds, resident, quad, requireAll);
  if (retain.length === 0) {
    for (const entries of index.byLod) {
      for (const entry of entries) {
        if (resident.has(entry.tileId) && tileIntersectsQuad(entry.bounds, quad)) retain.push(entry.tileId);
      }
    }
    retain.sort();
  }
  const ring = ringPrefetch(index, required, halo);
  const covers = coverPrefetch(index, required, lod);
  return finishPlan(lod, required, retain, covers.length > 0 && covers.length <= ring.length ? covers : ring, targetX, targetZ);
}

export function nextConcurrency(current: number, sample: number): ConcurrencyDecision {
  const bounded = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.round(Number.isFinite(current) ? current : MIN_CONCURRENCY)));
  if (!Number.isFinite(sample) || sample <= 0) return { concurrency: bounded, sampleEvent: 'steady' };
  if (sample <= TILE_LOAD_TARGET_MS * FAST_SAMPLE_RATIO) {
    return { concurrency: Math.min(MAX_CONCURRENCY, bounded + 1), sampleEvent: 'fast' };
  }
  if (sample >= TILE_LOAD_TARGET_MS * SLOW_SAMPLE_RATIO) {
    return { concurrency: Math.max(MIN_CONCURRENCY, bounded - 1), sampleEvent: 'slow' };
  }
  return { concurrency: bounded, sampleEvent: 'steady' };
}
