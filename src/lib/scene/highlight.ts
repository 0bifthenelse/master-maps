/**
 * @file Selection highlight for picked render-tile features.
 *
 * A pick is resolved straight from a decoded render tile: the layer's
 * featureRanges triple maps the clicked triangle to a FeatureMeta entry,
 * and that index range is projected into private BufferGeometry objects
 * owned by one dedicated THREE.Group. Tile slabs, cached geometries and
 * range attributes are only read, never written, re-based or detached, so
 * adding or clearing a highlight cannot perturb the GPU cache nor the
 * meshes aliasing the same payload slab.
 *
 * Every render-tile layer stores triangle data (planLayer rejects index
 * counts that are not a multiple of three), so a picked range always
 * duplicates as filled geometry. The silhouette is the true boundary of
 * that triangle soup: edges shared by two triangles cancel out, which
 * yields the roof plus base ring of an extruded building, the rails plus
 * end caps of a road ribbon, and the ring of a flat polygon. A degenerate
 * range (zero triangles, as emitted for point features) has no boundary
 * to trace and falls back to a square reticle at the feature's anchor.
 *
 * The accent is the #ff7d27 root token; the veil behind it is a
 * lightness step of the same root, so no highlight colour is independent
 * of the three roots.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
} from 'three';
import {
  renderLayerIndices,
  renderLayerPositions,
  renderLayerRanges,
  type DecodedRenderLayer,
  type DecodedRenderTile,
  type FeatureMeta,
  type RenderLayerId,
} from '../render/codec';
import { getResidentDecodedTile } from '../render/tileGpuCache';
import { renderToWgs84 } from '../geo/crs';

export const HIGHLIGHT_ACCENT = '#ff7d27';
export const HIGHLIGHT_ACCENT_DIM = '#b85c1c';
export const HIGHLIGHT_LIFT_METRES = 1.5;
export const HIGHLIGHT_FILL_RENDER_ORDER = 9990;
export const HIGHLIGHT_OUTLINE_RENDER_ORDER = 9991;
export const DEFAULT_POINT_HALF_EXTENT_METRES = 9;

const FILL_OPACITY = 0.34;
const OUTLINE_OPACITY = 0.95;
const EDGE_KEY_BASE = 4_294_967_296;

export interface PickedFeature {
  stableId: string;
  kind: string;
  category: string;
  name?: string;
  layer: RenderLayerId;
  tileId: string;
  anchor: [number, number];
  lonLat?: [number, number];
  height?: number;
  width?: number;
  props?: Record<string, unknown>;
  /** Index of the feature inside its layer's range triples. */
  rangeIndex: number;
}

export interface FeatureHighlightTarget {
  tile: DecodedRenderTile;
  layer: RenderLayerId;
  index: number;
}

export interface FeatureHighlight {
  pick: PickedFeature;
  objects: Object3D[];
  dispose: () => void;
}

export interface HighlightGroup extends Group {
  userData: { highlight?: FeatureHighlight | null };
}

interface ResolvedRange {
  layer: DecodedRenderLayer;
  rangeIndex: number;
  indexStart: number;
  indexCount: number;
  meta: FeatureMeta;
}

function layerOf(tile: DecodedRenderTile, layerId: RenderLayerId): DecodedRenderLayer | null {
  for (const layer of tile.layers) if (layer.id === layerId) return layer;
  return null;
}

function resolveRange(target: FeatureHighlightTarget): ResolvedRange | null {
  const layer = layerOf(target.tile, target.layer);
  if (layer === null) return null;
  const ranges = renderLayerRanges(target.tile.payload, layer);
  const featureCount = ranges.length / 3;
  if (featureCount === 0 || target.index < 0) return null;
  for (let rangeIndex = 0; rangeIndex < featureCount; rangeIndex += 1) {
    const indexStart = ranges[rangeIndex * 3]!;
    const indexCount = ranges[rangeIndex * 3 + 1]!;
    const metaIndex = ranges[rangeIndex * 3 + 2]!;
    if (indexCount === 0) continue;
    if (target.index < indexStart || target.index >= indexStart + indexCount) continue;
    const meta = target.tile.meta[metaIndex];
    if (meta === undefined) return null;
    return { layer, rangeIndex, indexStart, indexCount, meta };
  }
  /* A point feature owns one vertex and a zero-length range, so a face
     scan can never match it: the raycast reports the vertex index, which
     addresses the range triple directly. */
  if (target.index < featureCount) {
    const meta = target.tile.meta[ranges[target.index * 3 + 2]!];
    if (meta !== undefined) return { layer, rangeIndex: target.index, indexStart: target.index, indexCount: 0, meta };
  }
  return null;
}

/** Turn a raycast hit into the payload every HUD surface consumes. */
export function resolvePickedFeature(target: FeatureHighlightTarget): PickedFeature | null {
  const resolved = resolveRange(target);
  if (resolved === null) return null;
  const meta = resolved.meta;
  if (meta.s.length === 0) return null;
  const pick: PickedFeature = {
    stableId: meta.s,
    kind: meta.k,
    category: meta.c,
    layer: target.layer,
    tileId: target.tile.header.tileId,
    rangeIndex: resolved.rangeIndex,
    anchor: [meta.a[0], meta.a[1]],
    lonLat: renderToWgs84([meta.a[0], meta.a[1]]),
  };
  if (meta.n !== undefined) pick.name = meta.n;
  if (meta.h !== undefined) pick.height = meta.h;
  if (meta.w !== undefined) pick.width = meta.w;
  if (meta.p !== undefined) pick.props = meta.p;
  return pick;
}

/**
 * Resolve a pick from a raycast that only knows the tile id, which is
 * what a scene layer handler has. Returns null when the tile is no
 * longer resident or the face belongs to no feature range.
 */
export function resolvePickedFeatureById(
  tileId: string,
  layer: RenderLayerId,
  index: number,
): PickedFeature | null {
  const tile = getResidentDecodedTile(tileId);
  if (tile === undefined) return null;
  return resolvePickedFeature({ tile, layer, index });
}

/**
 * Resolve a stableId back to its pick payload. Needed because a scene
 * handler that reports (tileId, stableId) loses which of a layer's
 * ranges was hit, and a point layer cannot be disambiguated any other
 * way: every point range starts at index 0, so a face scan would always
 * return the first point of the layer.
 */
export function resolvePickedFeatureByStableId(
  tile: DecodedRenderTile,
  stableId: string,
): PickedFeature | null {
  for (const layer of tile.layers) {
    const ranges = renderLayerRanges(tile.payload, layer);
    for (let rangeIndex = 0; rangeIndex < ranges.length / 3; rangeIndex += 1) {
      const meta = tile.meta[ranges[rangeIndex * 3 + 2]!];
      if (meta?.s !== stableId) continue;
      const count = ranges[rangeIndex * 3 + 1]!;
      return resolvePickedFeature({
        tile,
        layer: layer.id,
        index: count === 0 ? rangeIndex : ranges[rangeIndex * 3]!,
      });
    }
  }
  return null;
}

interface LocalizedRange {
  positions: Float32Array;
  remap: Map<number, number>;
  local: Uint32Array;
  vertexCount: number;
  maxY: number;
}

function localizeRange(target: FeatureHighlightTarget, resolved: ResolvedRange): LocalizedRange | null {
  if (resolved.indexCount === 0) return null;
  const positions = renderLayerPositions(target.tile.payload, resolved.layer);
  const indices = renderLayerIndices(target.tile.payload, resolved.layer);
  const remap = new Map<number, number>();
  const local = new Uint32Array(resolved.indexCount);
  let maxY = 0;
  for (let offset = 0; offset < resolved.indexCount; offset += 1) {
    const vertex = indices[resolved.indexStart + offset]!;
    let localIndex = remap.get(vertex);
    if (localIndex === undefined) {
      localIndex = remap.size;
      remap.set(vertex, localIndex);
      const y = positions[vertex * 3 + 1]!;
      if (y > maxY) maxY = y;
    }
    local[offset] = localIndex;
  }
  return { positions, remap, local, vertexCount: remap.size, maxY };
}

function edgeKey(a: number, b: number): number {
  return a < b ? a * EDGE_KEY_BASE + b : b * EDGE_KEY_BASE + a;
}

/**
 * Edges incident to exactly one triangle of the picked range. Shared
 * edges cancel, so the survivors trace the silhouette of the feature.
 */
function silhouetteEdges(local: Uint32Array): number[] {
  const counts = new Map<number, number>();
  for (let triangle = 0; triangle + 2 < local.length; triangle += 3) {
    const a = local[triangle]!;
    const b = local[triangle + 1]!;
    const c = local[triangle + 2]!;
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const key = edgeKey(from, to);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const vertices: number[] = [];
  for (const [key, count] of counts) {
    if (count !== 1) continue;
    const to = key % EDGE_KEY_BASE;
    const from = Math.floor(key / EDGE_KEY_BASE);
    vertices.push(from, to);
  }
  return vertices;
}

function liftPositions(
  positions: Float32Array,
  remap: Map<number, number>,
  vertexCount: number,
  lift: number,
): Float32Array {
  const lifted = new Float32Array(vertexCount * 3);
  for (const [vertex, localIndex] of remap) {
    lifted[localIndex * 3] = positions[vertex * 3]!;
    lifted[localIndex * 3 + 1] = positions[vertex * 3 + 1]! + lift;
    lifted[localIndex * 3 + 2] = positions[vertex * 3 + 2]!;
  }
  return lifted;
}

function fillGeometry(localized: LocalizedRange, lift: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(liftPositions(localized.positions, localized.remap, localized.vertexCount, lift), 3));
  geometry.setIndex(new BufferAttribute(localized.local, 1));
  return geometry;
}

function outlineGeometry(localized: LocalizedRange, lift: number): BufferGeometry {
  const geometry = new BufferGeometry();
  const edges = silhouetteEdges(localized.local);
  const lifted = liftPositions(localized.positions, localized.remap, localized.vertexCount, lift);
  const positions = new Float32Array((edges.length / 2) * 3);
  for (let cursor = 0; cursor < edges.length; cursor += 1) {
    const localIndex = edges[cursor]!;
    positions[cursor * 3] = lifted[localIndex * 3]!;
    positions[cursor * 3 + 1] = lifted[localIndex * 3 + 1]!;
    positions[cursor * 3 + 2] = lifted[localIndex * 3 + 2]!;
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return geometry;
}

function reticleGeometry(anchor: [number, number], half: number): BufferGeometry {
  const [x, z] = anchor;
  const geometry = new BufferGeometry();
  const ring: [number, number][] = [
    [x - half, z - half],
    [x + half, z - half],
    [x + half, z + half],
    [x - half, z + half],
  ];
  const positions = new Float32Array((ring.length + 1) * 3);
  for (let corner = 0; corner <= ring.length; corner += 1) {
    const [cx, cz] = ring[corner % ring.length]!;
    positions[corner * 3] = cx;
    positions[corner * 3 + 1] = 0;
    positions[corner * 3 + 2] = cz;
  }
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return geometry;
}

function disposeObject(object: Object3D): void {
  const mesh = object as Mesh;
  mesh.geometry?.dispose();
  const material = mesh.material as Mesh["material"];
  if (Array.isArray(material)) for (const entry of material) entry.dispose();
  else material?.dispose();
  object.removeFromParent();
}

function buildFill(geometry: BufferGeometry): Mesh {
  const fill = new Mesh(
    geometry,
    new MeshBasicMaterial({ color: HIGHLIGHT_ACCENT_DIM, transparent: true, opacity: FILL_OPACITY, depthTest: false, depthWrite: false }),
  );
  fill.renderOrder = HIGHLIGHT_FILL_RENDER_ORDER;
  fill.frustumCulled = false;
  return fill;
}

function buildOutline(geometry: BufferGeometry): LineSegments {
  const outline = new LineSegments(
    geometry,
    new LineBasicMaterial({ color: HIGHLIGHT_ACCENT, transparent: true, opacity: OUTLINE_OPACITY, depthTest: false, depthWrite: false }),
  );
  outline.renderOrder = HIGHLIGHT_OUTLINE_RENDER_ORDER;
  outline.frustumCulled = false;
  return outline;
}

/**
 * Build the highlight objects for a pick. Returns null when the pick no
 * longer resolves, so a caller can clear instead of drawing a stale
 * outline.
 */
export function buildFeatureHighlight(target: FeatureHighlightTarget): FeatureHighlight | null {
  const pick = resolvePickedFeature(target);
  if (pick === null) return null;
  const resolved = resolveRange(target);
  if (resolved === null) return null;
  const localized = localizeRange(target, resolved);
  const fill = localized === null
    ? buildFill(reticleGeometry(pick.anchor, DEFAULT_POINT_HALF_EXTENT_METRES))
    : buildFill(fillGeometry(localized, HIGHLIGHT_LIFT_METRES));
  const outline = localized === null
    ? buildOutline(reticleGeometry(pick.anchor, DEFAULT_POINT_HALF_EXTENT_METRES))
    : buildOutline(outlineGeometry(localized, HIGHLIGHT_LIFT_METRES));
  return {
    pick,
    objects: [fill, outline],
    dispose: () => {
      disposeObject(fill);
      disposeObject(outline);
    },
  };
}

/** Build the highlight for a raycast identified by tile id. */
export function buildFeatureHighlightById(
  tileId: string,
  layer: RenderLayerId,
  index: number,
): FeatureHighlight | null {
  const tile = getResidentDecodedTile(tileId);
  if (tile === undefined) return null;
  return buildFeatureHighlight({ tile, layer, index });
}


/** Dedicated group that owns at most one live highlight. */
export function createHighlightGroup(): HighlightGroup {
  const group = new Group() as HighlightGroup;
  group.name = "feature-highlight";
  group.userData.highlight = null;
  return group;
}

/** Swap the live highlight on its group, disposing the previous one. */
export function setFeatureHighlight(group: HighlightGroup, highlight: FeatureHighlight | null): void {
  const previous = group.userData.highlight ?? null;
  if (previous === highlight) return;
  if (previous !== null) {
    previous.dispose();
    group.userData.highlight = null;
  }
  if (highlight === null) return;
  group.userData.highlight = highlight;
  for (const object of highlight.objects) group.add(object);
}

export function clearFeatureHighlight(group: HighlightGroup): void {
  setFeatureHighlight(group, null);
}

export function currentHighlightPick(group: HighlightGroup): PickedFeature | null {
  return group.userData.highlight?.pick ?? null;
}
