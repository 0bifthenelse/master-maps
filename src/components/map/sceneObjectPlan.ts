import { BufferAttribute, BufferGeometry } from "three";
import { getTileCacheEntry, tileLayerGeometry } from "@/lib/render/tileGpuCache";
import type { RenderLayerId } from "@/lib/render/codec";
import { LAYER_OBJECT_KINDS, ORDERED_RENDER_LAYER_IDS } from "@/lib/render/sceneFromDecoded";

export type BatchObjectKind = (typeof LAYER_OBJECT_KINDS)[RenderLayerId];

/** A point object is drawn from its vertex buffer, every other kind from its index buffer. */
export type PickIndexKind = "vertex" | "index";

/** The addressable fields one three.js raycast reports, each present for one object kind only. */
export interface RaycastAnchor {
  index?: number | null;
  faceIndex?: number | null;
}

const POSITION_COMPONENTS = 3;
const INDICES_PER_TRIANGLE = 3;
const RANGE_COMPONENTS = 3;
const TILE_GRID_ID = /^l(\d+)_(-?\d+)_(-?\d+)/;
const WHOLE_MAP_CHUNK = "whole-map";
const TILES_PER_CHUNK_SIDE = 2;

export interface TileLayerGeometry {
  geometry: BufferGeometry;
  rangeLength: number;
  featureCount: number;
  isPointLayer: boolean;
}

export interface TileLayerSource {
  tileId: string;
  layers: ReadonlyMap<RenderLayerId, TileLayerGeometry>;
}

export interface BatchContributor {
  tileId: string;
  layerId: RenderLayerId;
  /** Where this tile's first position lands in the merged position buffer. */
  vertexOffset: number;
  /** Positions this tile contributed. */
  vertexCount: number;
  /** Where this tile's first index lands in the merged index buffer. */
  indexOffset: number;
  /** Merged index entries this tile contributed, always zero for a point batch. */
  indexCount: number;
  /** Index of this tile's first feature range in the merged range table. */
  rangeOffset: number;
  /** Number of feature ranges this tile contributed. */
  rangeCount: number;
  featureCount: number;
  isPointLayer: boolean;
}

export interface SceneObjectPlan {
  key: string;
  layerId: RenderLayerId;
  objectKind: BatchObjectKind;
  materialKey: RenderLayerId;
  chunkKey: string;
  pickIndexKind: PickIndexKind;
  contributors: BatchContributor[];
  signature: string;
}

export interface MergedBatchPick {
  tileId: string;
  layerId: RenderLayerId;
  isPointLayer: boolean;
}

export interface MergedIndexPick extends MergedBatchPick {
  /** Position of the hit inside the merged index buffer. */
  hitIndex: number;
  /** Face of the source layer the hit belongs to. */
  faceIndex: number;
  stableId: string | undefined;
}

export interface MergedPointPick extends MergedBatchPick {
  /** Vertex of the source layer the hit belongs to. */
  vertexIndex: number;
  stableId: string | undefined;
}

export interface MergedBatchBuffers {
  positions: Float32Array;
  indices: Uint32Array;
  /** One [indexStart, indexCount, metaIndex] row per source feature range. */
  ranges: Uint32Array;
}

export interface MountedBatch extends SceneObjectPlan {
  geometry: BufferGeometry;
}

export function hasPosition(geometry: { getAttribute: (name: string) => { count: number } | undefined }): boolean {
  return (geometry.getAttribute("position")?.count ?? 0) > 0;
}

export function layerHidden(layerId: RenderLayerId, layers: Record<string, boolean>): boolean {
  if (layerId === "buildings") return layers.buildings === false;
  if (layerId === "road_tunnel" || layerId === "road_normal" || layerId === "road_bridge") return layers.roads === false;
  if (layerId === "water_surface" || layerId === "water_line") return layers.water === false;
  if (layerId === "landuse" || layerId === "habitat") return layers.landuse === false;
  if (layerId === "transport_area" || layerId === "transport_line") return layers.transport === false;
  if (layerId === "structure_area" || layerId === "structure_line" || layerId === "structures_point") return layers.structures === false;
  if (layerId === "poi" || layerId === "address") return layers.pois === false;
  if (layerId === "place") return layers.places === false;
  if (layerId === "boundary") return layers.boundary === false;
  return false;
}

/** The merged index-buffer slot, or vertex for a point batch, that a raycast points at. */
export function mergedPickAnchor(objectKind: BatchObjectKind, anchor: RaycastAnchor): number | null {
  if (objectKind === "points" || objectKind === "lineSegments") return anchor.index ?? null;
  // A mesh reports a triangle ordinal, while every merged range counts index-buffer entries.
  return anchor.faceIndex == null ? null : anchor.faceIndex * INDICES_PER_TRIANGLE;
}

/** Layers merge when they share a material instance, an object kind and an attribute layout. */
export function batchKeyFor(layerId: RenderLayerId, objectKind: BatchObjectKind): string {
  return `${layerId}:${objectKind}`;
}

/** A 2x2 block of grid tiles, so one batch never spans a whole department. */
export function chunkKeyFor(tileId: string): string {
  const match = TILE_GRID_ID.exec(tileId);
  if (match === null) return WHOLE_MAP_CHUNK;
  return `${match[1]}:${Math.floor(Number(match[2]) / TILES_PER_CHUNK_SIDE)}:${Math.floor(Number(match[3]) / TILES_PER_CHUNK_SIDE)}`;
}

export function planTileObjects(tiles: readonly TileLayerSource[], layers: Record<string, boolean>): SceneObjectPlan[] {
  const plans = new Map<string, SceneObjectPlan>();
  for (const tile of tiles) {
    const chunkKey = chunkKeyFor(tile.tileId);
    for (const layerId of ORDERED_RENDER_LAYER_IDS) {
      const layer = tile.layers.get(layerId);
      if (layer === undefined || layerHidden(layerId, layers)) continue;
      if (!hasPosition(layer.geometry)) continue;
      const objectKind = LAYER_OBJECT_KINDS[layerId];
      const contributor: BatchContributor = {
        tileId: tile.tileId,
        layerId,
        vertexOffset: 0,
        vertexCount: 0,
        indexOffset: 0,
        indexCount: 0,
        rangeOffset: 0,
        rangeCount: layer.rangeLength / RANGE_COMPONENTS,
        featureCount: layer.featureCount,
        isPointLayer: layer.isPointLayer,
      };
      const key = `${batchKeyFor(layerId, objectKind)}|${chunkKey}`;
      const plan = plans.get(key);
      if (plan === undefined) {
        plans.set(key, {
          key,
          layerId,
          objectKind,
          materialKey: layerId,
          chunkKey,
          pickIndexKind: layer.isPointLayer ? "vertex" : "index",
          contributors: [contributor],
          signature: "",
        });
        continue;
      }
      if (plan.pickIndexKind === "vertex" && !layer.isPointLayer) plan.pickIndexKind = "index";
      plan.contributors.push(contributor);
    }
  }
  const planned = [...plans.values()];
  for (const plan of planned) {
    plan.contributors.sort((left, right) => (left.tileId < right.tileId ? -1 : left.tileId > right.tileId ? 1 : 0));
    plan.signature = plan.contributors.map((contributor) => contributor.tileId).join("|");
  }
  return planned;
}

/** Binary search over the contributor spans of one addressing space. */
function contributorFor(contributors: readonly BatchContributor[], index: number, anchor: "vertex" | "index"): BatchContributor | undefined {
  let low = 0;
  let high = contributors.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const contributor = contributors[middle]!;
    const start = anchor === "vertex" ? contributor.vertexOffset : contributor.indexOffset;
    const span = anchor === "vertex" ? contributor.vertexCount : contributor.indexCount;
    if (index < start) high = middle - 1;
    else if (index >= start + span) low = middle + 1;
    else return contributor;
  }
  return undefined;
}

/** Concatenate the contributors into one set of buffers and offset every index. */
export function buildMergedBatchBuffers(plan: SceneObjectPlan, sources: ReadonlyMap<string, BufferGeometry>): MergedBatchBuffers {
  const positions: number[] = [];
  const indices: number[] = [];
  const ranges: number[] = [];
  const contributors: BatchContributor[] = [];
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const contributor of plan.contributors) {
    const geometry = sources.get(contributor.tileId);
    if (geometry === undefined) continue;
    const position = geometry.getAttribute("position");
    contributor.vertexOffset = vertexOffset;
    contributor.vertexCount = position.count;
    contributor.indexOffset = indexOffset;
    contributor.indexCount = 0;
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    }
    if (plan.pickIndexKind === "index") {
      const index = geometry.getIndex();
      const count = index?.count ?? 0;
      for (let entry = 0; entry < count; entry += 1) indices.push(index!.getX(entry) + vertexOffset);
      contributor.indexCount = count;
      indexOffset += count;
    }
    contributor.rangeOffset = ranges.length / RANGE_COMPONENTS;
    const source = geometry.getAttribute("featureRange") as BufferAttribute | undefined;
    if (source === undefined) {
      contributor.rangeCount = 0;
    } else {
      contributor.rangeCount = Math.min(contributor.rangeCount, source.count);
      for (let row = 0; row < contributor.rangeCount; row += 1) {
        ranges.push(contributor.indexOffset + source.getX(row), source.getY(row), source.getZ(row));
      }
    }
    vertexOffset += position.count;
    contributors.push(contributor);
  }
  plan.contributors = contributors;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    ranges: new Uint32Array(ranges),
  };
}

export function buildMergedBatchGeometry(plan: SceneObjectPlan, sources: ReadonlyMap<string, BufferGeometry>): BufferGeometry {
  const buffers = buildMergedBatchBuffers(plan, sources);
  const geometry = new BufferGeometry();
  if (buffers.positions.length === 0) return geometry;
  geometry.setAttribute("position", new BufferAttribute(buffers.positions, POSITION_COMPONENTS));
  if (plan.pickIndexKind === "index") geometry.setIndex(new BufferAttribute(buffers.indices, 1));
  if (buffers.ranges.length > 0) geometry.setAttribute("featureRange", new BufferAttribute(buffers.ranges, RANGE_COMPONENTS));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Range starts are absolute in the merged index buffer, so the probe is absolute too. */
function mergedRangeRow(geometry: BufferGeometry, contributor: BatchContributor, hitIndex: number): number {
  const ranges = geometry.getAttribute("featureRange") as BufferAttribute | undefined;
  if (ranges === undefined) return -1;
  for (let row = contributor.rangeOffset; row < contributor.rangeOffset + contributor.rangeCount; row += 1) {
    const start = ranges.getX(row);
    if (hitIndex >= start && hitIndex < start + ranges.getY(row)) return row;
  }
  return -1;
}

/**
 * The stableId of a source feature, resolved through the untouched geometry
 * the tile cache still owns. A point layer is addressed by vertex, every
 * other layer by an index-buffer slot, which is the unit the codec's feature
 * ranges and pickStableId both count in.
 */
function sourceStableId(tileId: string, layerId: RenderLayerId, sourceIndex: number, isPointLayer: boolean): string | undefined {
  const geometry = tileLayerGeometry(tileId, layerId);
  if (geometry === undefined) return undefined;
  const entry = getTileCacheEntry(tileId);
  if (entry === undefined) return undefined;
  const ranges = geometry.getAttribute("featureRange") as BufferAttribute | undefined;
  if (ranges === undefined) return undefined;
  if (isPointLayer) {
    if (sourceIndex >= ranges.count) return undefined;
    return entry.stableIds[ranges.getZ(sourceIndex)];
  }
  for (let row = 0; row < ranges.count; row += 1) {
    const start = ranges.getX(row);
    if (sourceIndex >= start && sourceIndex < start + ranges.getY(row)) return entry.stableIds[ranges.getZ(row)];
  }
  return undefined;
}

/**
 * Translate a raycast hit on a merged indexed buffer. A mesh reports the
 * triangle it pierced, a lineSegments reports the even index of the segment
 * it pierced, so both arrive here already as positions in the merged index
 * buffer and both must land inside the source feature range owning them.
 */
export function resolveMergedIndexPick(plan: SceneObjectPlan, geometry: BufferGeometry, hitIndex: number): MergedIndexPick | null {
  if (!Number.isInteger(hitIndex) || hitIndex < 0) return null;
  if (hitIndex >= (geometry.getIndex()?.count ?? 0)) return null;
  const contributor = contributorFor(plan.contributors, hitIndex, "index");
  if (contributor === undefined) return null;
  const sourceIndex = hitIndex - contributor.indexOffset;
  const row = mergedRangeRow(geometry, contributor, hitIndex);
  if (row < 0) return null;
  return {
    tileId: contributor.tileId,
    layerId: contributor.layerId,
    isPointLayer: contributor.isPointLayer,
    hitIndex,
    faceIndex: row - contributor.rangeOffset,
    stableId: sourceStableId(contributor.tileId, contributor.layerId, sourceIndex, contributor.isPointLayer),
  };
}

/** Translate a raycast hit on a merged point buffer back to its source vertex. */
export function resolveMergedPointPick(plan: SceneObjectPlan, hitIndex: number): MergedPointPick | null {
  if (!Number.isInteger(hitIndex) || hitIndex < 0) return null;
  const vertexTotal = plan.contributors.reduce((total, contributor) => total + contributor.vertexCount, 0);
  if (hitIndex >= vertexTotal) return null;
  const contributor = contributorFor(plan.contributors, hitIndex, "vertex");
  if (contributor === undefined) return null;
  const vertexIndex = hitIndex - contributor.vertexOffset;
  return {
    tileId: contributor.tileId,
    layerId: contributor.layerId,
    isPointLayer: contributor.isPointLayer,
    vertexIndex,
    stableId: sourceStableId(contributor.tileId, contributor.layerId, vertexIndex, true),
  };
}

/** Attach one merged geometry per plan, reusing the object of an unchanged tile set. */
export function buildBatches(sources: readonly TileLayerSource[], plans: readonly SceneObjectPlan[], cache: Map<string, MountedBatch>): MountedBatch[] {
  const live = new Set(plans.map((plan) => plan.key));
  for (const [key, batch] of cache) {
    if (live.has(key)) continue;
    batch.geometry.dispose();
    cache.delete(key);
  }
  const geometries = new Map<string, BufferGeometry>();
  const mounted: MountedBatch[] = [];
  for (const plan of plans) {
    const cached = cache.get(plan.key);
    if (cached !== undefined && cached.signature === plan.signature) {
      mounted.push(cached);
      continue;
    }
    for (const contributor of plan.contributors) {
      if (geometries.has(contributor.tileId)) continue;
      const source = sources.find((candidate) => candidate.tileId === contributor.tileId);
      const geometry = source?.layers.get(contributor.layerId)?.geometry;
      if (geometry !== undefined) geometries.set(contributor.tileId, geometry);
    }
    const geometry = buildMergedBatchGeometry(plan, geometries);
    if (!hasPosition(geometry)) {
      geometry.dispose();
      continue;
    }
    if (cached !== undefined) cached.geometry.dispose();
    const batch: MountedBatch = { ...plan, geometry };
    cache.set(plan.key, batch);
    mounted.push(batch);
  }
  return mounted;
}
