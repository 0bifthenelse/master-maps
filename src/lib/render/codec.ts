/**
 * MMT render tile container, format 2.
 *
 * A 12-byte prefix (magic, format version, header byte length), a JSON
 * header, then one contiguous payload slab holding, per layer, an
 * interleaved Float32 vertex section, a Uint32 triangle index section, a
 * Uint32 feature range section and an optional Uint32 edge section, followed
 * by the feature metadata as UTF-8 JSON. Every section starts on a 4-byte
 * boundary so the client builds typed-array views over the slab without
 * copying a byte.
 *
 * Vertex layouts by layer kind:
 *   fill       x, y, z, style
 *   line       x, y, z, extrudeX, extrudeZ, halfWidthMetres, style, distanceMetres
 *   extrusion  x, y, z, buildingHeight, style
 *
 * A line vertex holds its centreline position plus a miter-scaled extrusion
 * vector; the shader multiplies it by a width chosen per frame from the zoom,
 * so a road keeps a readable pixel width at the department overview and its
 * true width in a street view.
 */

export const RENDER_TILE_MAGIC = 0x4d4d5431;
export const RENDER_TILE_FORMAT_VERSION = 2;
export const RENDER_TILE_ALIGNMENT = 4;

export const RENDER_LAYER_IDS = [
  "landcover",
  "water_area",
  "transport_area",
  "structure_area",
  "water_line",
  "rail",
  "road_tunnel",
  "road",
  "road_bridge",
  "structure_line",
  "boundary",
  "building",
] as const;

export type RenderLayerId = (typeof RENDER_LAYER_IDS)[number];

export type RenderLayerKind = "fill" | "line" | "extrusion";

export const RENDER_LAYER_KINDS: Readonly<Record<RenderLayerId, RenderLayerKind>> = {
  landcover: "fill",
  water_area: "fill",
  transport_area: "fill",
  structure_area: "fill",
  water_line: "line",
  rail: "line",
  road_tunnel: "line",
  road: "line",
  road_bridge: "line",
  structure_line: "line",
  boundary: "line",
  building: "extrusion",
};

/** Float32 components per vertex for each layer kind. */
export const LAYER_KIND_STRIDE: Readonly<Record<RenderLayerKind, number>> = {
  fill: 4,
  line: 8,
  extrusion: 5,
};

/** One row per feature: indexStart, indexCount, metaIndex, vertexStart, vertexCount. */
export const RANGE_STRIDE = 5;

export function layerStride(id: RenderLayerId): number {
  return LAYER_KIND_STRIDE[RENDER_LAYER_KINDS[id]];
}

export type RenderBounds = readonly [number, number, number, number];

/**
 * Per-feature metadata. Point features (places, addresses, POIs,
 * businesses) carry no geometry at all: the overlay draws them from `a`.
 */
export interface FeatureMeta {
  /** Canonical stable id of the feature (the parent id for a clipped fragment). */
  s: string;
  /** Feature kind. */
  k: string;
  /** Category or class: road class, canonical place category, land cover type. */
  c: string;
  /** Display name. */
  n?: string;
  /** Label / marker anchor in local metres [east, north]. */
  a: [number, number];
  /** Height in metres (buildings, structures). */
  h?: number;
  /** Width in metres (roads, waterways). */
  w?: number;
  /** Road or route number, e.g. "D930". */
  r?: string;
  /** Small extra properties used for labels and the dossier. */
  p?: Record<string, unknown>;
}

export interface RenderLayerInput {
  id: RenderLayerId;
  vertices: Float32Array;
  indices: Uint32Array;
  ranges: Uint32Array;
  /** Pairs of vertex indices drawn as hairlines (building roof outlines). */
  edges?: Uint32Array;
}

export interface RenderTileInput {
  tileId: string;
  lod: number;
  bounds: RenderBounds;
  datasetVersion: string;
  layers: RenderLayerInput[];
  meta: FeatureMeta[];
}

export interface RenderLayerHeader {
  id: RenderLayerId;
  vertexCount: number;
  indexCount: number;
  featureCount: number;
  edgeCount: number;
  vertexOffset: number;
  indexOffset: number;
  rangeOffset: number;
  edgeOffset: number;
}

export interface RenderTileHeader {
  tileId: string;
  lod: number;
  bounds: RenderBounds;
  datasetVersion: string;
  layers: RenderLayerHeader[];
  featureMetaBytes: number;
  featureMetaOffset: number;
}

export interface DecodedRenderLayer {
  id: RenderLayerId;
  stride: number;
  vertexOffset: number;
  vertexLength: number;
  indexOffset: number;
  indexLength: number;
  rangeOffset: number;
  rangeLength: number;
  edgeOffset: number;
  edgeLength: number;
}

export interface DecodedRenderTile {
  header: RenderTileHeader;
  payload: ArrayBuffer;
  layers: DecodedRenderLayer[];
  meta: FeatureMeta[];
}

export function renderLayerVertices(payload: ArrayBuffer, layer: DecodedRenderLayer): Float32Array {
  return new Float32Array(payload, layer.vertexOffset, layer.vertexLength);
}

export function renderLayerIndices(payload: ArrayBuffer, layer: DecodedRenderLayer): Uint32Array {
  return new Uint32Array(payload, layer.indexOffset, layer.indexLength);
}

export function renderLayerRanges(payload: ArrayBuffer, layer: DecodedRenderLayer): Uint32Array {
  return new Uint32Array(payload, layer.rangeOffset, layer.rangeLength);
}

export function renderLayerEdges(payload: ArrayBuffer, layer: DecodedRenderLayer): Uint32Array {
  return new Uint32Array(payload, layer.edgeOffset, layer.edgeLength);
}

const WORD_BYTES = 4;
const CONTAINER_PREFIX_BYTES = 12;
const LAYER_ORDER: Readonly<Record<string, number>> = Object.fromEntries(RENDER_LAYER_IDS.map((id, index) => [id, index]));

export function isRenderLayerId(value: string): value is RenderLayerId {
  return (RENDER_LAYER_IDS as readonly string[]).includes(value);
}

export function renderLayerOrder(id: RenderLayerId): number {
  return LAYER_ORDER[id] ?? Number.MAX_SAFE_INTEGER;
}

export function alignRenderTileOffset(offset: number): number {
  const remainder = offset % RENDER_TILE_ALIGNMENT;
  return remainder === 0 ? offset : offset + (RENDER_TILE_ALIGNMENT - remainder);
}

export function emptyRenderLayer(id: RenderLayerId): RenderLayerInput {
  return { id, vertices: new Float32Array(0), indices: new Uint32Array(0), ranges: new Uint32Array(0) };
}

interface PlannedLayer {
  input: RenderLayerInput;
  edges: Uint32Array;
  header: RenderLayerHeader;
}

export function encodeRenderTile(input: RenderTileInput): ArrayBuffer {
  const planned = input.layers
    .filter((layer) => layer.vertices.length > 0)
    .sort((first, second) => renderLayerOrder(first.id) - renderLayerOrder(second.id))
    .map((layer) => planLayer(layer, input.meta.length));
  let offset = 0;
  for (const layer of planned) {
    layer.header.vertexOffset = offset;
    offset += layer.input.vertices.byteLength;
    layer.header.indexOffset = offset;
    offset += layer.input.indices.byteLength;
    layer.header.rangeOffset = offset;
    offset += layer.input.ranges.byteLength;
    layer.header.edgeOffset = offset;
    offset = alignRenderTileOffset(offset + layer.edges.byteLength);
  }
  const metaBytes = new TextEncoder().encode(JSON.stringify(input.meta));
  const featureMetaOffset = offset;
  const payloadBytes = alignRenderTileOffset(offset + metaBytes.byteLength);
  const header: RenderTileHeader = {
    tileId: input.tileId,
    lod: input.lod,
    bounds: input.bounds,
    datasetVersion: input.datasetVersion,
    layers: planned.map((layer) => layer.header),
    featureMetaBytes: metaBytes.byteLength,
    featureMetaOffset,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(CONTAINER_PREFIX_BYTES + headerBytes.byteLength + payloadBytes);
  const view = new DataView(buffer);
  view.setUint32(0, RENDER_TILE_MAGIC, true);
  view.setUint32(4, RENDER_TILE_FORMAT_VERSION, true);
  view.setUint32(8, headerBytes.byteLength, true);
  new Uint8Array(buffer, CONTAINER_PREFIX_BYTES, headerBytes.byteLength).set(headerBytes);
  const base = CONTAINER_PREFIX_BYTES + headerBytes.byteLength;
  for (const layer of planned) {
    writeSection(buffer, base + layer.header.vertexOffset, layer.input.vertices);
    writeSection(buffer, base + layer.header.indexOffset, layer.input.indices);
    writeSection(buffer, base + layer.header.rangeOffset, layer.input.ranges);
    writeSection(buffer, base + layer.header.edgeOffset, layer.edges);
  }
  new Uint8Array(buffer, base + featureMetaOffset, metaBytes.byteLength).set(metaBytes);
  return buffer;
}

function planLayer(layer: RenderLayerInput, metaLength: number): PlannedLayer {
  const { id, vertices, indices, ranges } = layer;
  const edges = layer.edges ?? new Uint32Array(0);
  const stride = layerStride(id);
  if (vertices.length % stride !== 0) throw new Error(`render tile: layer ${id} has ${vertices.length} vertex values, not a multiple of ${stride}`);
  if (indices.length % 3 !== 0) throw new Error(`render tile: layer ${id} has ${indices.length} indices, not a multiple of 3`);
  if (ranges.length % RANGE_STRIDE !== 0) throw new Error(`render tile: layer ${id} has ${ranges.length} range values, not a multiple of ${RANGE_STRIDE}`);
  if (edges.length % 2 !== 0) throw new Error(`render tile: layer ${id} has ${edges.length} edge indices, not a multiple of 2`);
  const vertexCount = vertices.length / stride;
  for (const index of indices) if (index >= vertexCount) throw new Error(`render tile: layer ${id} index ${index} exceeds vertexCount ${vertexCount}`);
  for (const index of edges) if (index >= vertexCount) throw new Error(`render tile: layer ${id} edge index ${index} exceeds vertexCount ${vertexCount}`);
  const featureCount = ranges.length / RANGE_STRIDE;
  let coveredIndex = 0;
  for (let feature = 0; feature < featureCount; feature += 1) {
    const row = feature * RANGE_STRIDE;
    const indexStart = ranges[row]!;
    const indexCount = ranges[row + 1]!;
    const metaIndex = ranges[row + 2]!;
    const vertexStart = ranges[row + 3]!;
    const vertexSpan = ranges[row + 4]!;
    if (indexStart !== coveredIndex) throw new Error(`render tile: layer ${id} range ${feature} starts at index ${indexStart}, expected ${coveredIndex}`);
    if (metaIndex >= metaLength) throw new Error(`render tile: layer ${id} range ${feature} has metaIndex ${metaIndex} for ${metaLength} entries`);
    if (vertexStart + vertexSpan > vertexCount) throw new Error(`render tile: layer ${id} range ${feature} vertices run past vertexCount`);
    for (let index = indexStart; index < indexStart + indexCount; index += 1) {
      const vertex = indices[index]!;
      if (vertex < vertexStart || vertex >= vertexStart + vertexSpan) {
        throw new Error(`render tile: layer ${id} range ${feature} index ${vertex} references a vertex outside its feature`);
      }
    }
    coveredIndex = indexStart + indexCount;
  }
  if (coveredIndex !== indices.length) throw new Error(`render tile: layer ${id} ranges cover ${coveredIndex} of ${indices.length} indices`);
  return {
    input: layer,
    edges,
    header: { id, vertexCount, indexCount: indices.length, featureCount, edgeCount: edges.length / 2, vertexOffset: 0, indexOffset: 0, rangeOffset: 0, edgeOffset: 0 },
  };
}

function writeSection(buffer: ArrayBuffer, offset: number, values: Float32Array | Uint32Array): void {
  if (values.byteLength === 0) return;
  new Uint8Array(buffer, offset, values.byteLength).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
}

export function decodeRenderTile(buffer: ArrayBuffer): DecodedRenderTile {
  if (buffer.byteLength < CONTAINER_PREFIX_BYTES) throw new Error("render tile: buffer is shorter than the container prefix");
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== RENDER_TILE_MAGIC) throw new Error(`render tile: bad magic 0x${magic.toString(16)}`);
  const formatVersion = view.getUint32(4, true);
  if (formatVersion !== RENDER_TILE_FORMAT_VERSION) throw new Error(`render tile: unsupported format version ${formatVersion}`);
  const headerBytes = view.getUint32(8, true);
  const payloadStart = CONTAINER_PREFIX_BYTES + headerBytes;
  if (headerBytes === 0 || payloadStart > buffer.byteLength) {
    throw new Error(`render tile: header of ${headerBytes} bytes does not fit in ${buffer.byteLength} bytes`);
  }
  const header = parseHeader(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buffer, CONTAINER_PREFIX_BYTES, headerBytes)));
  const payloadEnd = payloadStart + header.featureMetaOffset + header.featureMetaBytes;
  if (payloadEnd > buffer.byteLength) throw new Error(`render tile: payload of ${payloadEnd} bytes exceeds ${buffer.byteLength}`);
  /* The slab is copied out once so it starts at offset 0 and can be
     transferred between threads on its own. */
  const payload = buffer.slice(payloadStart, payloadEnd);
  const layers: DecodedRenderLayer[] = header.layers.map((layer) => {
    const stride = layerStride(layer.id);
    const decoded: DecodedRenderLayer = {
      id: layer.id,
      stride,
      vertexOffset: layer.vertexOffset,
      vertexLength: layer.vertexCount * stride,
      indexOffset: layer.indexOffset,
      indexLength: layer.indexCount,
      rangeOffset: layer.rangeOffset,
      rangeLength: layer.featureCount * RANGE_STRIDE,
      edgeOffset: layer.edgeOffset,
      edgeLength: layer.edgeCount * 2,
    };
    requireSection(payload, decoded.vertexOffset, decoded.vertexLength, `layer ${layer.id} vertices`);
    requireSection(payload, decoded.indexOffset, decoded.indexLength, `layer ${layer.id} indices`);
    requireSection(payload, decoded.rangeOffset, decoded.rangeLength, `layer ${layer.id} ranges`);
    requireSection(payload, decoded.edgeOffset, decoded.edgeLength, `layer ${layer.id} edges`);
    return decoded;
  });
  const metaBytes = new Uint8Array(payload, header.featureMetaOffset, header.featureMetaBytes);
  const meta = metaBytes.byteLength === 0 ? [] : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metaBytes)) as FeatureMeta[];
  if (!Array.isArray(meta)) throw new Error("render tile: feature meta section is not a JSON array");
  for (const layer of layers) {
    const ranges = renderLayerRanges(payload, layer);
    for (let row = 0; row < ranges.length; row += RANGE_STRIDE) {
      if (ranges[row + 2]! >= meta.length) throw new Error(`render tile: layer ${layer.id} range points at meta ${ranges[row + 2]} of ${meta.length}`);
    }
  }
  return { header, payload, layers, meta };
}

function requireSection(payload: ArrayBuffer, offset: number, length: number, label: string): void {
  if (offset < 0 || offset % WORD_BYTES !== 0) throw new Error(`render tile: ${label} offset ${offset} is not 4-byte aligned`);
  if (offset + length * WORD_BYTES > payload.byteLength) throw new Error(`render tile: ${label} at ${offset}+${length * WORD_BYTES} exceeds ${payload.byteLength} bytes`);
}

const HEADER_LAYER_KEYS = ["vertexCount", "indexCount", "featureCount", "edgeCount", "vertexOffset", "indexOffset", "rangeOffset", "edgeOffset"] as const;

function parseHeader(json: string): RenderTileHeader {
  const value = JSON.parse(json) as Record<string, unknown>;
  if (typeof value.tileId !== "string" || value.tileId.length === 0) throw new Error("render tile: header tileId is not a non-empty string");
  if (typeof value.lod !== "number" || !Number.isInteger(value.lod)) throw new Error("render tile: header lod is not an integer");
  if (typeof value.datasetVersion !== "string") throw new Error("render tile: header datasetVersion is not a string");
  if (!Array.isArray(value.bounds) || value.bounds.length !== 4 || !value.bounds.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error("render tile: header bounds is not a 4-number array");
  }
  if (typeof value.featureMetaBytes !== "number" || typeof value.featureMetaOffset !== "number") throw new Error("render tile: header feature meta section is missing");
  if (!Array.isArray(value.layers)) throw new Error("render tile: header layers is not an array");
  const layers = value.layers.map((entry) => {
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !isRenderLayerId(candidate.id)) throw new Error(`render tile: unknown layer id ${String(candidate.id)}`);
    for (const key of HEADER_LAYER_KEYS) {
      if (typeof candidate[key] !== "number" || !Number.isInteger(candidate[key])) throw new Error(`render tile: layer ${candidate.id} ${key} is not an integer`);
    }
    return {
      id: candidate.id,
      vertexCount: candidate.vertexCount as number,
      indexCount: candidate.indexCount as number,
      featureCount: candidate.featureCount as number,
      edgeCount: candidate.edgeCount as number,
      vertexOffset: candidate.vertexOffset as number,
      indexOffset: candidate.indexOffset as number,
      rangeOffset: candidate.rangeOffset as number,
      edgeOffset: candidate.edgeOffset as number,
    };
  });
  const [minX, minZ, maxX, maxZ] = value.bounds as [number, number, number, number];
  return {
    tileId: value.tileId,
    lod: value.lod,
    bounds: [minX, minZ, maxX, maxZ],
    datasetVersion: value.datasetVersion,
    layers,
    featureMetaBytes: value.featureMetaBytes,
    featureMetaOffset: value.featureMetaOffset,
  };
}
