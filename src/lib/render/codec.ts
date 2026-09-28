export const RENDER_TILE_MAGIC = 0x4d4d5431;
export const RENDER_TILE_FORMAT_VERSION = 1;
export const RENDER_TILE_ALIGNMENT = 4;

export const RENDER_LAYER_IDS = [
  "habitat",
  "landuse",
  "water_surface",
  "water_line",
  "transport_area",
  "transport_line",
  "structure_line",
  "structure_area",
  "road_tunnel",
  "road_normal",
  "road_bridge",
  "buildings",
  "structures_point",
  "poi",
  "address",
  "place",
  "boundary",
] as const;

export type RenderLayerId = (typeof RENDER_LAYER_IDS)[number];

/** Primitive a layer's index slab encodes: a triangle list, a segment list or bare points. */
export type RenderLayerPrimitive = "triangles" | "lines" | "points";

export const RENDER_LAYER_KINDS: Readonly<Record<RenderLayerId, RenderLayerPrimitive>> = {
  habitat: "triangles",
  landuse: "triangles",
  water_surface: "triangles",
  water_line: "triangles",
  transport_area: "triangles",
  transport_line: "triangles",
  structure_line: "triangles",
  structure_area: "triangles",
  road_tunnel: "triangles",
  road_normal: "triangles",
  road_bridge: "triangles",
  buildings: "triangles",
  structures_point: "points",
  poi: "points",
  address: "points",
  place: "points",
  boundary: "lines",
};

export type RenderBounds = readonly [number, number, number, number];

export interface FeatureMeta {
  s: string;
  k: string;
  c: string;
  n?: string;
  a: [number, number];
  h?: number;
  w?: number;
  p?: Record<string, unknown>;
}

export interface RenderLayerInput {
  id: RenderLayerId;
  positions: Float32Array;
  indices: Uint32Array;
  ranges: Uint32Array;
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
  positionOffset: number;
  indexOffset: number;
  featureCount: number;
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
  positionOffset: number;
  positionLength: number;
  indexOffset: number;
  indexLength: number;
  rangeOffset: number;
  rangeLength: number;
}

export interface DecodedRenderTile {
  header: RenderTileHeader;
  payload: ArrayBuffer;
  layers: DecodedRenderLayer[];
  meta: FeatureMeta[];
}

export function renderLayerPositions(payload: ArrayBuffer, layer: DecodedRenderLayer): Float32Array {
  return new Float32Array(payload, layer.positionOffset, layer.positionLength);
}

export function renderLayerIndices(payload: ArrayBuffer, layer: DecodedRenderLayer): Uint32Array {
  return new Uint32Array(payload, layer.indexOffset, layer.indexLength);
}

export function renderLayerRanges(payload: ArrayBuffer, layer: DecodedRenderLayer): Uint32Array {
  return new Uint32Array(payload, layer.rangeOffset, layer.rangeLength);
}

const WORD_BYTES = 4;
const CONTAINER_PREFIX_BYTES = 12;
const HEADER_STRING_KEYS = ["tileId", "lod", "bounds", "datasetVersion", "featureMetaBytes", "featureMetaOffset"] as const;
const HEADER_LAYER_KEYS = ["vertexCount", "indexCount", "positionOffset", "indexOffset", "featureCount"] as const;
const LAYER_RENDER_ORDER: Readonly<Record<string, number>> = Object.fromEntries(RENDER_LAYER_IDS.map((id, index) => [id, index]));

export function isRenderLayerId(value: string): value is RenderLayerId {
  return RENDER_LAYER_IDS.includes(value as RenderLayerId);
}

export function renderLayerOrder(id: RenderLayerId): number {
  return LAYER_RENDER_ORDER[id] ?? Number.MAX_SAFE_INTEGER;
}

export function alignRenderTileOffset(offset: number): number {
  const remainder = offset % RENDER_TILE_ALIGNMENT;
  return remainder === 0 ? offset : offset + (RENDER_TILE_ALIGNMENT - remainder);
}

export function emptyRenderLayer(id: RenderLayerId): RenderLayerInput {
  return { id, positions: new Float32Array(0), indices: new Uint32Array(0), ranges: new Uint32Array(0) };
}

export function encodeRenderTile(input: RenderTileInput): ArrayBuffer {
  const layers = planLayers(input.layers, input.meta.length);
  const metaBytes = new TextEncoder().encode(JSON.stringify(input.meta));
  const { plan, payloadBytes } = planPayload(layers, metaBytes.byteLength);
  const headerBytes = new TextEncoder().encode(JSON.stringify({
    tileId: input.tileId,
    lod: input.lod,
    bounds: input.bounds,
    datasetVersion: input.datasetVersion,
    layers: plan.map((layer) => ({
      id: layer.id,
      vertexCount: layer.vertexCount,
      indexCount: layer.indexCount,
      positionOffset: layer.positionOffset,
      indexOffset: layer.indexOffset,
      featureCount: layer.featureCount,
    })),
    featureMetaBytes: metaBytes.byteLength,
    featureMetaOffset: plan.at(-1) ? alignRenderTileOffset(plan.at(-1)!.rangeOffset + plan.at(-1)!.ranges.byteLength) : 0,
  } satisfies RenderTileHeader));
  const buffer = new ArrayBuffer(CONTAINER_PREFIX_BYTES + headerBytes.byteLength + payloadBytes);
  const view = new DataView(buffer);
  view.setUint32(0, RENDER_TILE_MAGIC, true);
  view.setUint32(4, RENDER_TILE_FORMAT_VERSION, true);
  view.setUint32(8, headerBytes.byteLength, true);
  new Uint8Array(buffer, CONTAINER_PREFIX_BYTES, headerBytes.byteLength).set(headerBytes);
  let offset = CONTAINER_PREFIX_BYTES + headerBytes.byteLength;
  for (const layer of layers) {
    offset = writeTypedSection(buffer, offset, layer.positions);
    offset = writeTypedSection(buffer, offset, layer.indices);
    offset = writeTypedSection(buffer, offset, layer.ranges);
  }
  new Uint8Array(buffer, offset, metaBytes.byteLength).set(metaBytes);
  return buffer;
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
  const layers: DecodedRenderLayer[] = header.layers.map((layer) => {
    const positionOffset = layer.positionOffset;
    const indexOffset = layer.indexOffset;
    const rangeOffset = indexOffset + layer.indexCount * WORD_BYTES;
    const positionLength = layer.vertexCount * 3;
    const indexLength = layer.indexCount;
    const rangeLength = layer.featureCount * 3;
    requireRange(buffer, payloadStart + positionOffset, positionLength * WORD_BYTES, `layer ${layer.id} positions`);
    requireRange(buffer, payloadStart + indexOffset, indexLength * WORD_BYTES, `layer ${layer.id} indices`);
    requireRange(buffer, payloadStart + rangeOffset, rangeLength * WORD_BYTES, `layer ${layer.id} featureRanges`);
    return { id: layer.id, positionOffset, positionLength, indexOffset, indexLength, rangeOffset, rangeLength };
  });
  const metaStart = payloadStart + header.featureMetaOffset;
  requireRange(buffer, metaStart, header.featureMetaBytes, "featureMeta section");
  const metaBytes = new Uint8Array(buffer, metaStart, header.featureMetaBytes);
  const meta: FeatureMeta[] = metaBytes.byteLength === 0 ? [] : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(metaBytes)) as FeatureMeta[];
  if (!Array.isArray(meta)) throw new Error("render tile: featureMeta section is not a JSON array");
  const payload = buffer.slice(payloadStart, payloadStart + header.featureMetaOffset + header.featureMetaBytes);
  return { header, payload, layers, meta };
}

function requireRange(buffer: ArrayBuffer, offset: number, byteLength: number, label: string): void {
  if (offset < 0 || byteLength < 0 || offset + byteLength > buffer.byteLength) {
    throw new Error(`render tile: ${label} at ${offset}+${byteLength} exceeds ${buffer.byteLength} bytes`);
  }
}

interface PlannedLayer extends RenderLayerInput {
  vertexCount: number;
  indexCount: number;
  featureCount: number;
  positionOffset: number;
  indexOffset: number;
  rangeOffset: number;
}

function planLayers(layers: RenderLayerInput[], metaLength: number): PlannedLayer[] {
  const populated = layers
    .map((layer, index) => ({ layer, index }))
    .filter((entry) => entry.layer.positions.length > 0 || entry.layer.indices.length > 0 || entry.layer.ranges.length > 0)
    .sort((first, second) => renderLayerOrder(first.layer.id) - renderLayerOrder(second.layer.id) || first.index - second.index);
  return populated.map(({ layer }) => planLayer(layer, metaLength));
}

function planLayer(layer: RenderLayerInput, metaLength: number): PlannedLayer {
  const { id, positions, indices, ranges } = layer;
  if (positions.length % 3 !== 0) throw new Error(`render tile: layer ${id} has ${positions.length} position values, not a multiple of 3`);
  requirePrimitiveIndexCount(id, indices.length);
  if (ranges.length % 3 !== 0) throw new Error(`render tile: layer ${id} has ${ranges.length} featureRange values, not a multiple of 3`);
  const vertexCount = positions.length / 3;
  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index]! >= vertexCount) throw new Error(`render tile: layer ${id} index ${indices[index]!} exceeds vertexCount ${vertexCount}`);
  }
  const featureCount = ranges.length / 3;
  let covered = 0;
  for (let feature = 0; feature < featureCount; feature += 1) {
    const start = ranges[feature * 3]!;
    const count = ranges[feature * 3 + 1]!;
    const metaIndex = ranges[feature * 3 + 2]!;
    if (start !== covered) throw new Error(`render tile: layer ${id} featureRanges feature ${feature} starts at ${start}, expected ${covered}`);
    if (start + count > indices.length) throw new Error(`render tile: layer ${id} featureRanges feature ${feature} runs past indexCount`);
    if (metaIndex >= metaLength) throw new Error(`render tile: layer ${id} featureRanges feature ${feature} has metaIndex ${metaIndex} for ${metaLength} meta entries`);
    covered = start + count;
  }
  if (covered !== indices.length) throw new Error(`render tile: layer ${id} featureRanges cover ${covered} of ${indices.length} indices`);
  return { id, positions, indices, ranges, vertexCount, indexCount: indices.length, featureCount, positionOffset: 0, indexOffset: 0, rangeOffset: 0 };
}

function requirePrimitiveIndexCount(id: RenderLayerId, indexCount: number): void {
  const kind = RENDER_LAYER_KINDS[id];
  if (kind === "triangles" && indexCount % 3 !== 0) throw new Error(`render tile: layer ${id} has ${indexCount} triangle indices, not a multiple of 3`);
  if (kind === "lines" && indexCount % 2 !== 0) throw new Error(`render tile: layer ${id} has ${indexCount} line indices, not a multiple of 2`);
  if (kind === "points" && indexCount !== 0) throw new Error(`render tile: layer ${id} is a point layer and carries ${indexCount} indices`);
}

function planPayload(layers: PlannedLayer[], metaBytes: number): { plan: PlannedLayer[]; payloadBytes: number } {
  let offset = 0;
  for (const layer of layers) {
    layer.positionOffset = offset;
    offset += layer.positions.byteLength;
    layer.indexOffset = offset;
    offset += layer.indices.byteLength;
    layer.rangeOffset = offset;
    offset = alignRenderTileOffset(offset + layer.ranges.byteLength);
  }
  return { plan: layers, payloadBytes: alignRenderTileOffset(offset + metaBytes) };
}

function writeTypedSection(buffer: ArrayBuffer, offset: number, values: Float32Array | Uint32Array): number {
  new Uint8Array(buffer, offset, values.byteLength).set(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
  return offset + values.byteLength;
}

function parseHeader(json: string): RenderTileHeader {
  const value = JSON.parse(json) as Record<string, unknown>;
  for (const key of HEADER_STRING_KEYS) if (value[key] === undefined) throw new Error(`render tile: header ${key} is missing`);
  if (typeof value.tileId !== "string" || value.tileId.length === 0) throw new Error("render tile: header tileId is not a non-empty string");
  if (typeof value.lod !== "number" || !Number.isInteger(value.lod)) throw new Error("render tile: header lod is not an integer");
  if (typeof value.datasetVersion !== "string") throw new Error("render tile: header datasetVersion is not a string");
  if (!Array.isArray(value.bounds) || value.bounds.length !== 4 || !value.bounds.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error("render tile: header bounds is not a 4-number array");
  }
  if (typeof value.featureMetaBytes !== "number" || !Number.isInteger(value.featureMetaBytes) || typeof value.featureMetaOffset !== "number" || !Number.isInteger(value.featureMetaOffset)) {
    throw new Error("render tile: header featureMeta section is missing");
  }
  if (!Array.isArray(value.layers)) throw new Error("render tile: header layers is not an array");
  const [minX, minZ, maxX, maxZ] = value.bounds as [number, number, number, number];
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
      positionOffset: candidate.positionOffset as number,
      indexOffset: candidate.indexOffset as number,
      featureCount: candidate.featureCount as number,
    };
  });
  return {
    tileId: value.tileId,
    lod: value.lod as number,
    bounds: [minX, minZ, maxX, maxZ],
    datasetVersion: value.datasetVersion as string,
    layers,
    featureMetaBytes: value.featureMetaBytes as number,
    featureMetaOffset: value.featureMetaOffset as number,
  };
}
