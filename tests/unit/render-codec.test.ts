import { describe, expect, it } from "vitest";
import {
  RENDER_LAYER_IDS,
  alignRenderTileOffset,
  decodeRenderTile,
  encodeRenderTile,
  isRenderLayerId,
  renderLayerIndices,
  renderLayerPositions,
  renderLayerRanges,
  renderLayerOrder,
  type DecodedRenderTile,
  type FeatureMeta,
  type RenderLayerId,
  type RenderTileInput,
} from "@/lib/render/codec";

const BOUNDS: [number, number, number, number] = [-1024, -512, 1024, 512];
function rewriteHeader(buffer: ArrayBuffer, mutate: (header: { layers: { id: string; vertexCount: number }[] }) => void): ArrayBuffer {
  const headerBytes = new DataView(buffer).getUint32(8, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerBytes))) as { layers: { id: string; vertexCount: number }[] };
  mutate(header);
  const rewritten = new TextEncoder().encode(JSON.stringify(header));
  const patched = new Uint8Array(12 + rewritten.byteLength + (buffer.byteLength - 12 - headerBytes));
  new DataView(patched.buffer).setUint32(0, 0x4d4d5431, true);
  new DataView(patched.buffer).setUint32(4, 1, true);
  new DataView(patched.buffer).setUint32(8, rewritten.byteLength, true);
  patched.set(rewritten, 12);
  patched.set(new Uint8Array(buffer, 12 + headerBytes), 12 + rewritten.byteLength);
  return patched.buffer;
}


function metaEntry(index: number): FeatureMeta {
  return { s: `feature/${index}@l0_0_0`, k: "building", c: "yes", n: `Bâtiment ${index}`, a: [index, index + 1], h: 7 + index };
}

function sampleTile(): RenderTileInput {
  return {
    tileId: "l0_558_293_s4_1_0",
    lod: 0,
    bounds: BOUNDS,
    datasetVersion: "0.1.0",
    layers: [
      {
        id: "landuse",
        positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10, 20, 0, 20, 30, 0, 30, 20, 0, 20]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6]),
        ranges: new Uint32Array([0, 6, 0, 6, 3, 1]),
      },
      {
        id: "buildings",
        positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 0, 4, 0, 0, 4, 0, 7, 0, 4, 7, 0, 4, 7, 4, 0, 7, 4]),
        indices: new Uint32Array([0, 2, 1, 0, 3, 2, 0, 1, 2, 0, 2, 3, 0, 5, 1, 0, 4, 5, 1, 6, 2, 1, 5, 6, 2, 7, 3, 2, 6, 7, 3, 4, 0, 3, 7, 4]),
        ranges: new Uint32Array([0, 36, 0]),
      },
    ],
    meta: [metaEntry(0), metaEntry(1), metaEntry(2)],
  };
}

function layerIds(decoded: DecodedRenderTile): RenderLayerId[] {
  return decoded.layers.map((layer) => layer.id);
}

describe("render tile codec", () => {
  it("encodes the MMT1 container prefix little-endian", () => {
    const buffer = encodeRenderTile(sampleTile());
    const view = new DataView(buffer);
    expect(view.getUint32(0, true)).toBe(0x4d4d5431);
    expect(view.getUint32(4, true)).toBe(1);
    const headerBytes = view.getUint32(8, true);
    expect(headerBytes).toBeGreaterThan(0);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, headerBytes))) as { tileId: string; lod: number; bounds: number[]; datasetVersion: string; featureMetaBytes: number; featureMetaOffset: number; layers: unknown[] };
    expect(header.tileId).toBe("l0_558_293_s4_1_0");
    expect(header.lod).toBe(0);
    expect(header.bounds).toEqual(BOUNDS);
    expect(header.datasetVersion).toBe("0.1.0");
    expect(header.layers).toHaveLength(2);
    expect(header.featureMetaBytes).toBe(new TextEncoder().encode(JSON.stringify(sampleTile().meta)).byteLength);
    expect(header.featureMetaOffset % 4).toBe(0);
    expect(buffer.byteLength % 4).toBe(0);
    expect(buffer.byteLength).toBe(12 + headerBytes + alignRenderTileOffset(header.featureMetaOffset + header.featureMetaBytes));
  });

  it("round-trips a real tile byte-exactly through one shared payload slab", () => {
    const input = sampleTile();
    const encoded = encodeRenderTile(input);
    const decoded = decodeRenderTile(encoded);
    expect(decoded.header.tileId).toBe(input.tileId);
    expect(decoded.header.lod).toBe(input.lod);
    expect(decoded.header.bounds).toEqual(input.bounds);
    expect(decoded.header.datasetVersion).toBe(input.datasetVersion);
    expect(layerIds(decoded)).toEqual(["landuse", "buildings"]);
    expect(decoded.meta).toEqual(input.meta);
    for (const [index, layer] of decoded.layers.entries()) {
      const source = input.layers[index]!;
      expect(layer.id).toBe(source.id);
      expect(Array.from(renderLayerPositions(decoded.payload, layer))).toEqual(Array.from(source.positions));
      expect(Array.from(renderLayerIndices(decoded.payload, layer))).toEqual(Array.from(source.indices));
      expect(Array.from(renderLayerRanges(decoded.payload, layer))).toEqual(Array.from(source.ranges));
      expect(layer.positionLength).toBe(source.positions.length);
      expect(layer.indexLength).toBe(source.indices.length);
      expect(layer.rangeLength).toBe(source.ranges.length);
      expect(layer.positionOffset % 4).toBe(0);
      expect(layer.indexOffset % 4).toBe(0);
      expect(layer.rangeOffset % 4).toBe(0);
      expect(layer.rangeOffset).toBe(layer.indexOffset + layer.indexLength * 4);
    }
  });

  it("aliases every layer view over the single transferable payload", () => {
    const decoded = decodeRenderTile(encodeRenderTile(sampleTile()));
    for (const layer of decoded.layers) {
      expect(renderLayerPositions(decoded.payload, layer).buffer).toBe(decoded.payload);
      expect(renderLayerIndices(decoded.payload, layer).buffer).toBe(decoded.payload);
      expect(renderLayerRanges(decoded.payload, layer).buffer).toBe(decoded.payload);
    }
    expect(new Uint8Array(decoded.payload).byteLength).toBe(decoded.header.featureMetaOffset + decoded.header.featureMetaBytes);
  });

  it("orders layers by renderOrder and drops empty layers", () => {
    const input = sampleTile();
    const decoded = decodeRenderTile(encodeRenderTile({
      ...input,
      layers: [
        { id: "poi", positions: new Float32Array([5, 2, 5]), indices: new Uint32Array(0), ranges: new Uint32Array([0, 0, 0]) },
        { id: "landuse", positions: new Float32Array(0), indices: new Uint32Array(0), ranges: new Uint32Array(0) },
        input.layers[0]!,
        input.layers[1]!,
      ],
    }));
    expect(layerIds(decoded)).toEqual(["landuse", "buildings", "poi"]);
    expect(decoded.header.layers.map((layer) => renderLayerOrder(layer.id))).toEqual([1, 11, 13]);
  });

  it("keeps an empty payload decodable", () => {
    const decoded = decodeRenderTile(encodeRenderTile({ tileId: "l1_1_1", lod: 1, bounds: BOUNDS, datasetVersion: "0.1.0", layers: [], meta: [] }));
    expect(decoded.layers).toHaveLength(0);
    expect(decoded.meta).toEqual([]);
    expect(decoded.header.featureMetaBytes).toBe(2);
    expect(decoded.payload.byteLength).toBe(2);
  });

  it("rejects a corrupted container prefix", () => {
    const buffer = encodeRenderTile(sampleTile());
    const view = new DataView(buffer);
    view.setUint32(0, 0x12345678, true);
    expect(() => decodeRenderTile(buffer)).toThrow(/bad magic/);
    const versioned = encodeRenderTile(sampleTile());
    new DataView(versioned).setUint32(4, 2, true);
    expect(() => decodeRenderTile(versioned)).toThrow(/unsupported format version/);
    expect(() => decodeRenderTile(new ArrayBuffer(4))).toThrow(/shorter than the container prefix/);
  });

  it("rejects a header that does not fit the buffer", () => {
    const buffer = encodeRenderTile(sampleTile());
    new DataView(buffer).setUint32(8, buffer.byteLength + 16, true);
    expect(() => decodeRenderTile(buffer)).toThrow(/does not fit/);
  });

  it("rejects a layer descriptor pointing past the buffer", () => {
    const patched = rewriteHeader(encodeRenderTile(sampleTile()), (header) => { header.layers[0]!.vertexCount = 100_000; });
    expect(() => decodeRenderTile(patched)).toThrow(/exceeds/);
  });

  it("rejects an unknown layer id in the header", () => {
    const patched = rewriteHeader(encodeRenderTile(sampleTile()), (header) => { header.layers[0]!.id = "not_a_layer"; });
    expect(() => decodeRenderTile(patched)).toThrow(/unknown layer id/);
  });

  it("rejects inconsistent per-layer arrays", () => {
    const input = sampleTile();
    const dangling = { ...input.layers[0]!, indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    expect(() => encodeRenderTile({ ...input, layers: [dangling] })).toThrow(/featureRanges/);
    const outOfBounds = { ...input.layers[0]!, indices: new Uint32Array([0, 1, 99]) };
    expect(() => encodeRenderTile({ ...input, layers: [outOfBounds] })).toThrow(/exceeds vertexCount/);
    const gap = { ...input.layers[0]!, ranges: new Uint32Array([3, 6, 0, 6, 3, 1]) };
    expect(() => encodeRenderTile({ ...input, layers: [gap] })).toThrow(/featureRanges feature 0/);
    const outOfRangeMeta = { ...input.layers[0]!, ranges: new Uint32Array([0, 6, 7, 6, 3, 0]) };
    expect(() => encodeRenderTile({ ...input, layers: [outOfRangeMeta] })).toThrow(/metaIndex 7/);
    const odd = { ...input.layers[0]!, positions: new Float32Array([0, 0, 0, 1]) };
    expect(() => encodeRenderTile({ ...input, layers: [odd] })).toThrow(/not a multiple of 3/);
  });

  it("aligns offsets to four bytes", () => {
    expect(alignRenderTileOffset(0)).toBe(0);
    expect(alignRenderTileOffset(4)).toBe(4);
    expect(alignRenderTileOffset(5)).toBe(8);
    expect(alignRenderTileOffset(6)).toBe(8);
    expect(alignRenderTileOffset(7)).toBe(8);
    expect(alignRenderTileOffset(8)).toBe(8);
  });

  it("exposes the fixed render-order layer id set", () => {
    expect(RENDER_LAYER_IDS).toEqual([
      "habitat", "landuse", "water_surface", "water_line", "transport_area", "transport_line",
      "structure_line", "structure_area", "road_tunnel", "road_normal", "road_bridge", "buildings",
      "structures_point", "poi", "address", "place", "boundary",
    ]);
    expect(isRenderLayerId("buildings")).toBe(true);
    expect(isRenderLayerId("nope")).toBe(false);
    expect(renderLayerOrder("habitat")).toBe(0);
    expect(renderLayerOrder("boundary")).toBe(16);
  });
});
