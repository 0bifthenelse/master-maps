/**
 * @file Builds THREE.BufferGeometry objects from a decoded render tile.
 *
 * Per W2-T15 the decoded tile carries one contiguous payload slab plus
 * per-layer descriptors, so every typed array is a zero-copy view over
 * that slab. Nothing here copies geometry data: the slab stays owned by
 * the tile GPU cache entry and is released only when the whole tile is
 * evicted.
 */
import { BufferGeometry, BufferAttribute } from 'three';
import {
  RENDER_LAYER_IDS,
  renderLayerIndices,
  renderLayerPositions,
  renderLayerRanges,
  type DecodedRenderLayer,
  type DecodedRenderTile,
  type RenderLayerId,
  renderLayerOrder,
} from './codec';

export interface DecodedLayerView {
  id: RenderLayerId;
  positions: Float32Array;
  indices: Uint32Array;
  ranges: Uint32Array;
  /** Ascending painter order taken from RENDER_LAYER_IDS. */
  renderOrder: number;
  /** True when every feature range is zero-length (a bare point layer). */
  isPointLayer: boolean;
}

/** How a layer's geometry must be mounted so it is both visible and pickable. */
export type LayerObjectKind = "mesh" | "lineSegments" | "points";

/**
 * Mount strategy per render layer. The codec emits ribbons and polygons for
 * every surface layer, so all of them mount as a mesh; water_line,
 * transport_line, structure_line and boundary are hairlines by design and
 * mount as lineSegments; poi, address, place and structures_point carry one
 * vertex per feature with a zero-length range, so they mount as Points and
 * are picked by vertex index rather than by face index.
 */
export const LAYER_OBJECT_KINDS: Readonly<Record<RenderLayerId, LayerObjectKind>> = {
  habitat: "mesh",
  landuse: "mesh",
  water_surface: "mesh",
  water_line: "lineSegments",
  transport_area: "mesh",
  transport_line: "lineSegments",
  structure_line: "lineSegments",
  structure_area: "mesh",
  road_tunnel: "mesh",
  road_normal: "mesh",
  road_bridge: "mesh",
  buildings: "mesh",
  structures_point: "points",
  poi: "points",
  address: "points",
  place: "points",
  boundary: "lineSegments",
};

export interface DecodedTileView {
  tileId: string;
  lod: number;
  payload: ArrayBuffer;
  layers: DecodedLayerView[];
  featureCount: number;
}

export class RenderTileViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderTileViewError';
  }
}

const WORD_BYTES = 4;

function requireRange(slab: ArrayBuffer, offset: number, elementCount: number, label: string): void {
  if (offset < 0 || offset % 4 !== 0) {
    throw new RenderTileViewError(`${label} offset ${offset} in ${slab.byteLength} byte slab is not 4-byte aligned`);
  }
  const byteLength = elementCount * WORD_BYTES;
  if (offset + byteLength > slab.byteLength) {
    throw new RenderTileViewError(`${label} spans ${offset}+${byteLength} of a ${slab.byteLength} byte slab`);
  }
}

function viewLayer(slab: ArrayBuffer, layer: DecodedRenderLayer): DecodedLayerView {
  requireRange(slab, layer.positionOffset, layer.positionLength, `layer ${layer.id} positions`);
  requireRange(slab, layer.indexOffset, layer.indexLength, `layer ${layer.id} indices`);
  requireRange(slab, layer.rangeOffset, layer.rangeLength, `layer ${layer.id} featureRanges`);
  const ranges = renderLayerRanges(slab, layer);
  const featureCount = ranges.length / 3;
  let pointLayers = 0;
  for (let index = 0; index < featureCount; index += 1) {
    if (ranges[index * 3 + 1] === 0) pointLayers += 1;
  }
  return {
    id: layer.id,
    positions: renderLayerPositions(slab, layer),
    indices: renderLayerIndices(slab, layer),
    ranges,
    renderOrder: renderLayerOrder(layer.id),
    isPointLayer: featureCount > 0 && pointLayers === featureCount,
  };
}

/**
 * Project a decoded render tile onto zero-copy views of its payload slab.
 * Layer views are returned in codec render order, so callers can iterate
 * them directly to obtain painter ordering for free.
 */
export function viewDecodedTile(tile: DecodedRenderTile): DecodedTileView {
  const slab = tile.payload;
  if (!(slab instanceof ArrayBuffer)) {
    throw new RenderTileViewError(`tile ${tile.header.tileId} carries no payload slab`);
  }
  const layers = tile.layers.map((layer) => viewLayer(slab, layer));
  const featureCount = layers.reduce((total, layer) => total + layer.ranges.length / 3, 0);
  if (featureCount !== tile.meta.length) {
    throw new RenderTileViewError(
      `tile ${tile.header.tileId} declares ${featureCount} features but carries ${tile.meta.length} meta entries`,
    );
  }
  return { tileId: tile.header.tileId, lod: tile.header.lod, payload: slab, layers, featureCount };
}

export function layerViewById(view: DecodedTileView, id: RenderLayerId): DecodedLayerView | undefined {
  return view.layers.find((layer) => layer.id === id);
}

export function isEmptyLayer(layer: DecodedLayerView | undefined): boolean {
  if (layer === undefined) return true;
  if (layer.positions.length === 0) return true;
  /* A point layer carries one vertex per feature and no indices at all, so
     an index count of zero is only empty when no position exists either. */
  return layer.indices.length === 0 && !layer.isPointLayer;
}

export function geometryByteSize(layer: DecodedLayerView): number {
  return layer.positions.byteLength + layer.indices.byteLength + layer.ranges.byteLength;
}

/**
 * Wrap a layer view in a BufferGeometry whose attributes alias the payload
 * slab. An empty layer yields null so the scene never mounts a mesh whose
 * vertex arrays carry no data, which is what produced the WebGPU
 * "Vertex buffer slot 0 was not set" validation failures on a black
 * overview.
 */
export function geometryFromLayer(layer: DecodedLayerView): BufferGeometry | null {
  if (isEmptyLayer(layer)) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(layer.positions, 3));
  /* A point layer is drawn as Points, which must not carry an index; a
     surface or line layer is drawn from the index slab. */
  if (!layer.isPointLayer) geometry.setIndex(new BufferAttribute(layer.indices, 1));
  if (layer.ranges.length > 0) geometry.setAttribute('featureRange', new BufferAttribute(layer.ranges, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export function layerObjectKind(id: RenderLayerId): LayerObjectKind {
  return LAYER_OBJECT_KINDS[id];
}

/**
 * Per-feature class data for a decoded layer, or an empty array when the
 * layer carries none. The MMT1 payload holds positions, indices and feature
 * ranges only, so class-aware (width, height, category) shading has no
 * per-vertex source in the tile: shade per layer and read class data from
 * the tile meta list instead. This helper exists so the limitation is
 * stated at one place rather than implied by a missing attribute.
 */
export function layerSupportsClassShading(): false {
  return false;
}

export const ORDERED_RENDER_LAYER_IDS: readonly RenderLayerId[] = RENDER_LAYER_IDS;
