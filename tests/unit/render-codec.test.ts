import { describe, expect, it } from "vitest";
import {
  LAYER_KIND_STRIDE,
  RANGE_STRIDE,
  RENDER_LAYER_IDS,
  RENDER_LAYER_KINDS,
  RENDER_TILE_FORMAT_VERSION,
  RENDER_TILE_MAGIC,
  decodeRenderTile,
  encodeRenderTile,
  layerStride,
  renderLayerEdges,
  renderLayerIndices,
  renderLayerRanges,
  renderLayerVertices,
  type FeatureMeta,
  type RenderLayerInput,
  type RenderTileInput,
} from "@/lib/render/codec";

const META: FeatureMeta[] = [
  { s: "road/1", k: "road", c: "primary", n: "Avenue de la Marne", a: [5, 5], w: 8, r: "N124" },
  { s: "building/1", k: "building", c: "building", a: [1, 1], h: 9 },
  { s: "place/1", k: "place", c: "commune", n: "Auch", a: [10, 10], p: { pop: 21935 } },
];

/** A two-vertex-pair road ribbon: one quad, two triangles. */
function roadLayer(): RenderLayerInput {
  const vertices = new Float32Array([
    0, 0, 0, 0, 1, 4, 3, 0,
    0, 0, 0, 0, -1, 4, 3, 0,
    10, 0, 0, 0, 1, 4, 3, 10,
    10, 0, 0, 0, -1, 4, 3, 10,
  ]);
  return { id: "road", vertices, indices: new Uint32Array([0, 1, 2, 2, 1, 3]), ranges: new Uint32Array([0, 6, 0, 0, 4]) };
}

/** A unit box: 4 roof + 4 base vertices, roof and one wall, roof outline edges. */
function buildingLayer(): RenderLayerInput {
  const vertices = new Float32Array([
    0, 9, 0, 9, 0, 1, 9, 0, 9, 0, 1, 9, 1, 9, 0, 0, 9, 1, 9, 0,
    0, 0, 0, 9, 0, 1, 0, 0, 9, 0, 1, 0, 1, 9, 0, 0, 0, 1, 9, 0,
  ]);
  return {
    id: "building",
    vertices,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 1, 4, 1, 0]),
    ranges: new Uint32Array([0, 12, 1, 0, 8]),
    edges: new Uint32Array([0, 1, 1, 2, 2, 3, 3, 0]),
  };
}

function tile(layers: RenderLayerInput[], meta: FeatureMeta[] = META): RenderTileInput {
  return { tileId: "l0_1_2", lod: 0, bounds: [2048, 4096, 4096, 6144], datasetVersion: "test", layers, meta };
}

describe("render tile layer catalogue", () => {
  it("assigns every layer a kind and a stride", () => {
    for (const id of RENDER_LAYER_IDS) {
      expect(["fill", "line", "extrusion"]).toContain(RENDER_LAYER_KINDS[id]);
      expect(layerStride(id)).toBe(LAYER_KIND_STRIDE[RENDER_LAYER_KINDS[id]]);
    }
    expect(LAYER_KIND_STRIDE).toEqual({ fill: 4, line: 8, extrusion: 5 });
  });

  it("orders ground layers before lines and buildings last", () => {
    expect(RENDER_LAYER_IDS[0]).toBe("landcover");
    expect(RENDER_LAYER_IDS.indexOf("road")).toBeGreaterThan(RENDER_LAYER_IDS.indexOf("water_area"));
    expect(RENDER_LAYER_IDS[RENDER_LAYER_IDS.length - 1]).toBe("building");
  });
});

describe("render tile codec", () => {
  it("writes the MMT container prefix little-endian", () => {
    const view = new DataView(encodeRenderTile(tile([roadLayer()])));
    expect(view.getUint32(0, true)).toBe(RENDER_TILE_MAGIC);
    expect(view.getUint32(4, true)).toBe(RENDER_TILE_FORMAT_VERSION);
    expect(RENDER_TILE_FORMAT_VERSION).toBe(2);
    expect(view.getUint32(8, true)).toBeGreaterThan(0);
  });

  it("round-trips vertices, indices, ranges, edges and meta exactly", () => {
    const road = roadLayer();
    const building = buildingLayer();
    const decoded = decodeRenderTile(encodeRenderTile(tile([building, road])));
    expect(decoded.header.tileId).toBe("l0_1_2");
    expect(decoded.header.bounds).toEqual([2048, 4096, 4096, 6144]);
    expect(decoded.meta).toEqual(META);
    expect(decoded.layers.map((layer) => layer.id)).toEqual(["road", "building"]);
    const [decodedRoad, decodedBuilding] = decoded.layers;
    expect(Array.from(renderLayerVertices(decoded.payload, decodedRoad!))).toEqual(Array.from(road.vertices));
    expect(Array.from(renderLayerIndices(decoded.payload, decodedRoad!))).toEqual(Array.from(road.indices));
    expect(Array.from(renderLayerRanges(decoded.payload, decodedRoad!))).toEqual(Array.from(road.ranges));
    expect(Array.from(renderLayerVertices(decoded.payload, decodedBuilding!))).toEqual(Array.from(building.vertices));
    expect(Array.from(renderLayerEdges(decoded.payload, decodedBuilding!))).toEqual(Array.from(building.edges!));
    expect(decodedBuilding!.stride).toBe(5);
    expect(renderLayerRanges(decoded.payload, decodedBuilding!).length).toBe(RANGE_STRIDE);
  });

  it("views every section over one standalone payload buffer", () => {
    const decoded = decodeRenderTile(encodeRenderTile(tile([roadLayer(), buildingLayer()])));
    for (const layer of decoded.layers) {
      expect(renderLayerVertices(decoded.payload, layer).buffer).toBe(decoded.payload);
      expect(renderLayerIndices(decoded.payload, layer).buffer).toBe(decoded.payload);
      expect(layer.vertexOffset % 4).toBe(0);
      expect(layer.indexOffset % 4).toBe(0);
    }
  });

  it("drops empty layers", () => {
    const empty: RenderLayerInput = { id: "rail", vertices: new Float32Array(0), indices: new Uint32Array(0), ranges: new Uint32Array(0) };
    const decoded = decodeRenderTile(encodeRenderTile(tile([empty, roadLayer()])));
    expect(decoded.layers.map((layer) => layer.id)).toEqual(["road"]);
  });

  it("rejects a vertex array that is not a whole number of vertices", () => {
    const road = roadLayer();
    expect(() => encodeRenderTile(tile([{ ...road, vertices: road.vertices.slice(0, 7) }]))).toThrow(/multiple of 8/);
  });

  it("rejects an index past the vertex count", () => {
    expect(() => encodeRenderTile(tile([{ ...roadLayer(), indices: new Uint32Array([0, 1, 9, 2, 1, 3]) }]))).toThrow(/exceeds vertexCount/);
  });

  it("rejects a feature whose triangles reach into another feature's vertices", () => {
    const road = roadLayer();
    /* Two features of two vertices each; the first borrows vertex 2 from the second. */
    const ranges = new Uint32Array([0, 3, 0, 0, 2, 3, 3, 0, 2, 2]);
    expect(() => encodeRenderTile(tile([{ ...road, ranges }]))).toThrow(/outside its feature/);
  });

  it("rejects ranges that do not cover every index", () => {
    expect(() => encodeRenderTile(tile([{ ...roadLayer(), ranges: new Uint32Array([0, 3, 0, 0, 4]) }]))).toThrow(/cover 3 of 6/);
  });

  it("rejects a range pointing at missing meta", () => {
    expect(() => encodeRenderTile(tile([roadLayer()], []))).toThrow(/metaIndex/);
  });

  it("rejects a corrupted prefix, an unknown version and a truncated buffer", () => {
    const bytes = encodeRenderTile(tile([roadLayer()]));
    const badMagic = bytes.slice(0);
    new DataView(badMagic).setUint32(0, 0xdeadbeef, true);
    expect(() => decodeRenderTile(badMagic)).toThrow(/bad magic/);
    const badVersion = bytes.slice(0);
    new DataView(badVersion).setUint32(4, 1, true);
    expect(() => decodeRenderTile(badVersion)).toThrow(/unsupported format version 1/);
    expect(() => decodeRenderTile(bytes.slice(0, bytes.byteLength - 64))).toThrow(/exceeds/);
    expect(() => decodeRenderTile(new ArrayBuffer(4))).toThrow(/shorter than the container prefix/);
  });

  it("rejects an unknown layer id in the header", () => {
    const bytes = encodeRenderTile(tile([roadLayer()]));
    const view = new DataView(bytes);
    const headerLength = view.getUint32(8, true);
    const header = new TextDecoder().decode(new Uint8Array(bytes, 12, headerLength));
    const forged = header.replace('"id":"road"', '"id":"roaq"');
    new Uint8Array(bytes, 12, headerLength).set(new TextEncoder().encode(forged));
    expect(() => decodeRenderTile(bytes)).toThrow(/unknown layer id roaq/);
  });
});
