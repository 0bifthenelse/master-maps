import { Raycaster, type Object3D, type BufferGeometry } from "three";
import {
  RANGE_STRIDE,
  RENDER_LAYER_KINDS,
  renderLayerIndices,
  renderLayerRanges,
  renderLayerVertices,
  type DecodedRenderLayer,
  type DecodedRenderTile,
  type FeatureMeta,
  type RenderLayerId,
} from "@/lib/render/codec";
import type { MapPoint, MapTransform } from "./transform";

export interface PickResult {
  tileId: string;
  meta: FeatureMeta;
  layerId: RenderLayerId | null;
  /** Map-metre bounding box of the picked geometry (for selection brackets). */
  bbox?: [number, number, number, number];
}

const LINE_PICK_PX = 7;
const LINE_LAYERS: readonly RenderLayerId[] = ["road_bridge", "road", "road_tunnel", "rail", "water_line"];
const AREA_LAYERS: readonly RenderLayerId[] = ["water_area", "transport_area", "structure_area", "landcover"];
const raycaster = new Raycaster();

/** Row of a feature range table containing an index-buffer position. */
export function rangeRowForIndex(ranges: Uint32Array, indexPosition: number): number {
  let low = 0;
  let high = ranges.length / RANGE_STRIDE - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = ranges[middle * RANGE_STRIDE]!;
    const count = ranges[middle * RANGE_STRIDE + 1]!;
    if (indexPosition < start) high = middle - 1;
    else if (indexPosition >= start + count) low = middle + 1;
    else return middle;
  }
  return -1;
}

function tileContains(tile: DecodedRenderTile, point: MapPoint, margin: number): boolean {
  const [minX, minZ, maxX, maxZ] = tile.header.bounds;
  return point[0] >= minX - margin && point[0] <= maxX + margin && point[1] >= minZ - margin && point[1] <= maxZ + margin;
}

/** Bounding box of one feature's vertices in a layer. */
export function featureBounds(tile: DecodedRenderTile, layer: DecodedRenderLayer, row: number): [number, number, number, number] {
  const ranges = renderLayerRanges(tile.payload, layer);
  const vertices = renderLayerVertices(tile.payload, layer);
  const start = ranges[row * RANGE_STRIDE + 3]!;
  const count = ranges[row * RANGE_STRIDE + 4]!;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let vertex = start; vertex < start + count; vertex += 1) {
    const x = vertices[vertex * layer.stride]!;
    const z = vertices[vertex * layer.stride + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

/** 3D buildings under the pointer, nearest first, via the mounted meshes. */
function pickBuilding(transform: MapTransform, x: number, y: number, buildings: Object3D | null, tiles: ReadonlyMap<string, DecodedRenderTile>): PickResult | null {
  if (buildings === null) return null;
  const { origin, direction } = transform.screenRay(x, y);
  raycaster.set(origin, direction);
  const hits = raycaster.intersectObject(buildings, true);
  for (const hit of hits) {
    if (hit.faceIndex === undefined || hit.faceIndex === null) continue;
    const geometry = (hit.object as unknown as { geometry?: BufferGeometry }).geometry;
    const data = geometry?.userData as { tileId?: string; ranges?: Uint32Array } | undefined;
    if (data?.tileId === undefined || data.ranges === undefined) continue;
    const row = rangeRowForIndex(data.ranges, hit.faceIndex * 3);
    if (row < 0) continue;
    const tile = tiles.get(data.tileId);
    if (tile === undefined) continue;
    const meta = tile.meta[data.ranges[row * RANGE_STRIDE + 2]!];
    if (meta === undefined) continue;
    const layer = tile.layers.find((candidate) => candidate.id === "building");
    return { tileId: data.tileId, meta, layerId: "building", bbox: layer === undefined ? undefined : featureBounds(tile, layer, row) };
  }
  return null;
}

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSquared));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function pickLine(point: MapPoint, metresPerPixel: number, tiles: readonly DecodedRenderTile[]): PickResult | null {
  let best: PickResult | null = null;
  let bestDistance = Infinity;
  for (const tile of tiles) {
    if (!tileContains(tile, point, LINE_PICK_PX * metresPerPixel)) continue;
    for (const layerId of LINE_LAYERS) {
      const layer = tile.layers.find((candidate) => candidate.id === layerId);
      if (layer === undefined) continue;
      const ranges = renderLayerRanges(tile.payload, layer);
      const vertices = renderLayerVertices(tile.payload, layer);
      const stride = layer.stride;
      for (let row = 0; row < ranges.length / RANGE_STRIDE; row += 1) {
        const start = ranges[row * RANGE_STRIDE + 3]!;
        const count = ranges[row * RANGE_STRIDE + 4]!;
        const halfWidth = vertices[start * stride + 5]!;
        const tolerance = Math.max(halfWidth, LINE_PICK_PX * metresPerPixel);
        for (let vertex = start; vertex + 2 < start + count; vertex += 2) {
          const ax = vertices[vertex * stride]!;
          const az = vertices[vertex * stride + 2]!;
          const bx = vertices[(vertex + 2) * stride]!;
          const bz = vertices[(vertex + 2) * stride + 2]!;
          const distance = segmentDistance(point[0], point[1], ax, az, bx, bz);
          if (distance <= tolerance && distance < bestDistance) {
            const meta = tile.meta[ranges[row * RANGE_STRIDE + 2]!];
            if (meta === undefined) continue;
            /* Prefer named features a few pixels further away over anonymous ones. */
            const adjusted = meta.n === undefined && meta.r === undefined ? distance + 2 * metresPerPixel : distance;
            if (adjusted >= bestDistance) continue;
            bestDistance = adjusted;
            best = { tileId: tile.header.tileId, meta, layerId, bbox: featureBounds(tile, layer, row) };
          }
        }
      }
    }
  }
  return best;
}

function inTriangle(px: number, pz: number, ax: number, az: number, bx: number, bz: number, cx: number, cz: number): boolean {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const negative = d1 < 0 || d2 < 0 || d3 < 0;
  const positive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(negative && positive);
}

function pickArea(point: MapPoint, tiles: readonly DecodedRenderTile[], requireName: boolean): PickResult | null {
  for (const layerId of AREA_LAYERS) {
    for (const tile of tiles) {
      if (!tileContains(tile, point, 0)) continue;
      const layer = tile.layers.find((candidate) => candidate.id === layerId);
      if (layer === undefined || RENDER_LAYER_KINDS[layerId] !== "fill") continue;
      const ranges = renderLayerRanges(tile.payload, layer);
      const vertices = renderLayerVertices(tile.payload, layer);
      const indices = renderLayerIndices(tile.payload, layer);
      const stride = layer.stride;
      /* Later features paint on top, so search from the end. */
      for (let row = ranges.length / RANGE_STRIDE - 1; row >= 0; row -= 1) {
        const meta = tile.meta[ranges[row * RANGE_STRIDE + 2]!];
        if (meta === undefined || meta.k === "boundary") continue;
        if (requireName && meta.n === undefined) continue;
        const start = ranges[row * RANGE_STRIDE]!;
        const count = ranges[row * RANGE_STRIDE + 1]!;
        for (let index = start; index < start + count; index += 3) {
          const a = indices[index]! * stride;
          const b = indices[index + 1]! * stride;
          const c = indices[index + 2]! * stride;
          if (inTriangle(point[0], point[1], vertices[a]!, vertices[a + 2]!, vertices[b]!, vertices[b + 2]!, vertices[c]!, vertices[c + 2]!)) {
            return { tileId: tile.header.tileId, meta, layerId, bbox: featureBounds(tile, layer, row) };
          }
        }
      }
    }
  }
  return null;
}

/** Nearest address within a radius, for "what's here" on empty ground. */
export function nearestAddress(point: MapPoint, tiles: readonly DecodedRenderTile[], radius: number): PickResult | null {
  let best: PickResult | null = null;
  let bestDistance = radius;
  for (const tile of tiles) {
    if (!tileContains(tile, point, radius)) continue;
    for (const meta of tile.meta) {
      if (meta.k !== "address") continue;
      const distance = Math.hypot(meta.a[0] - point[0], meta.a[1] - point[1]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { tileId: tile.header.tileId, meta, layerId: null };
      }
    }
  }
  return best;
}

/**
 * Feature under a screen pixel: 3D buildings first (what the eye hits),
 * then roads and rivers within a few pixels, then named areas, then any area.
 */
export function pickAt(transform: MapTransform, x: number, y: number, tiles: readonly DecodedRenderTile[], buildings: Object3D | null): PickResult | null {
  const byId = new Map(tiles.map((tile) => [tile.header.tileId, tile]));
  const point = transform.screenToMap(x, y);
  const mpp = transform.metresPerPixel;
  const line = pickLine(point, mpp, tiles);
  const building = transform.zoom >= 14 ? pickBuilding(transform, x, y, buildings, byId) : null;
  if (line !== null && (building === null || (line.meta.n !== undefined && mpp > 0.6))) return line;
  if (building !== null) return building;
  return pickArea(point, tiles, true) ?? pickArea(point, tiles, false);
}
