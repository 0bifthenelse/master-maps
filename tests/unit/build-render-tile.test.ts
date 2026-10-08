import { describe, expect, it } from "vitest";
import { MapFeatureSchema, type MapFeature } from "@/lib/data/schema";
import {
  RANGE_STRIDE,
  decodeRenderTile,
  encodeRenderTile,
  renderLayerEdges,
  renderLayerIndices,
  renderLayerRanges,
  renderLayerVertices,
  type DecodedRenderLayer,
  type DecodedRenderTile,
  type RenderLayerId,
} from "@/lib/render/codec";
import { DEFAULT_BUILDING_HEIGHT_METRES, buildRenderTile, geometryAnchor, resolveRoadWidth, roadLayerFor } from "@/lib/render/buildRenderTile";

const BOUNDS: [number, number, number, number] = [0, 0, 2048, 2048];

function feature(value: Record<string, unknown>): MapFeature {
  const geometry = value.localGeometry ?? value.geometry ?? { type: "Point", coordinates: [0, 0] };
  return MapFeatureSchema.parse({ geometry, localGeometry: geometry, ...value });
}

function build(features: MapFeature[], includeBoundary = false): DecodedRenderTile {
  return decodeRenderTile(encodeRenderTile(buildRenderTile(features, { tileId: "l0_0_0", lod: 0, bounds: BOUNDS, datasetVersion: "test", includeBoundary })));
}

function layer(tile: DecodedRenderTile, id: RenderLayerId): DecodedRenderLayer {
  const found = tile.layers.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`layer ${id} missing`);
  return found;
}

/** Position (x, y, z) of each vertex of a layer. */
function positions(tile: DecodedRenderTile, found: DecodedRenderLayer): Array<[number, number, number]> {
  const values = renderLayerVertices(tile.payload, found);
  const out: Array<[number, number, number]> = [];
  for (let at = 0; at < values.length; at += found.stride) out.push([values[at]!, values[at + 1]!, values[at + 2]!]);
  return out;
}

function triangles(tile: DecodedRenderTile, found: DecodedRenderLayer): Array<[number, number, number]> {
  const indices = renderLayerIndices(tile.payload, found);
  const out: Array<[number, number, number]> = [];
  for (let at = 0; at < indices.length; at += 3) out.push([indices[at]!, indices[at + 1]!, indices[at + 2]!]);
  return out;
}

const square = (x: number, z: number, size: number): number[][] => [[x, z], [x + size, z], [x + size, z + size], [x, z + size], [x, z]];

describe("buildRenderTile: buildings", () => {
  it("extrudes a footprint into a roof, four walls and a roof outline", () => {
    const tile = build([feature({ kind: "building", stableId: "b/1", geometry: { type: "Polygon", coordinates: [square(10, 10, 10)] }, height: 12 })]);
    const buildings = layer(tile, "building");
    const vertices = positions(tile, buildings);
    expect(vertices).toHaveLength(8);
    expect(new Set(vertices.map(([, y]) => y))).toEqual(new Set([0, 12]));
    expect(triangles(tile, buildings)).toHaveLength(2 + 4 * 2);
    expect(renderLayerEdges(tile.payload, buildings)).toHaveLength(8);
    expect(tile.meta[0]).toMatchObject({ s: "b/1", k: "building", h: 12, a: [15, 15] });
  });

  it("falls back to the default height", () => {
    const tile = build([feature({ kind: "building", stableId: "b/2", geometry: { type: "Polygon", coordinates: [square(50, 50, 5)] } })]);
    expect(Math.max(...positions(tile, layer(tile, "building")).map(([, y]) => y))).toBe(DEFAULT_BUILDING_HEIGHT_METRES);
  });

  it("keeps a courtyard open and never stretches a triangle beyond the footprint", () => {
    const outer = square(100, 100, 30);
    const hole = [[110, 110], [110, 120], [120, 120], [120, 110], [110, 110]];
    const tile = build([feature({ kind: "building", stableId: "b/3", geometry: { type: "Polygon", coordinates: [outer, hole] }, height: 9 })]);
    const buildings = layer(tile, "building");
    const vertices = positions(tile, buildings);
    const diagonal = Math.hypot(30, 30);
    for (const [a, b, c] of triangles(tile, buildings)) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        expect(Math.hypot(vertices[p]![0] - vertices[q]![0], vertices[p]![2] - vertices[q]![2])).toBeLessThanOrEqual(diagonal + 1e-6);
      }
      /* No roof triangle covers the courtyard. */
      if (vertices[a]![1] === 9 && vertices[b]![1] === 9 && vertices[c]![1] === 9) {
        const cx = (vertices[a]![0] + vertices[b]![0] + vertices[c]![0]) / 3;
        const cz = (vertices[a]![2] + vertices[b]![2] + vertices[c]![2]) / 3;
        expect(cx > 110 && cx < 120 && cz > 110 && cz < 120).toBe(false);
      }
    }
    /* 8 walls (4 outer + 4 courtyard) of two triangles each, plus the roof ring. */
    expect(triangles(tile, buildings).length).toBe(8 * 2 + 8);
  });

  it("gives every feature of a multi-building tile its own vertices", () => {
    const tile = build([
      feature({ kind: "building", stableId: "b/4", geometry: { type: "MultiPolygon", coordinates: [[square(0, 0, 10)], [square(100, 100, 10)]] }, height: 6 }),
      feature({ kind: "building", stableId: "b/5", geometry: { type: "Polygon", coordinates: [square(500, 500, 20)] }, height: 15 }),
    ]);
    const buildings = layer(tile, "building");
    const ranges = renderLayerRanges(tile.payload, buildings);
    const indices = renderLayerIndices(tile.payload, buildings);
    expect(ranges.length / RANGE_STRIDE).toBe(2);
    for (let row = 0; row < ranges.length; row += RANGE_STRIDE) {
      const [indexStart, indexCount, , vertexStart, vertexCount] = Array.from(ranges.slice(row, row + RANGE_STRIDE));
      for (let at = indexStart!; at < indexStart! + indexCount!; at += 1) {
        expect(indices[at]).toBeGreaterThanOrEqual(vertexStart!);
        expect(indices[at]).toBeLessThan(vertexStart! + vertexCount!);
      }
    }
  });

  it("draws no wall along a cut made by the tile edge", () => {
    const tile = build([feature({ kind: "building", stableId: "b/6", geometry: { type: "Polygon", coordinates: [[[2038, 100], [2048, 100], [2048, 110], [2038, 110], [2038, 100]]] }, height: 6 })]);
    /* Roof (2 triangles) and three walls; the wall on x = 2048 is a clip artefact. */
    expect(triangles(tile, layer(tile, "building"))).toHaveLength(2 + 3 * 2);
  });
});

describe("buildRenderTile: lines", () => {
  it("emits a road as a centreline ribbon with square caps and its true half width", () => {
    const road = feature({ kind: "road", stableId: "r/1", geometry: { type: "LineString", coordinates: [[0, 0], [100, 0]] }, roadClass: "primary", ref: "D930", name: "Route de Toulouse" });
    const tile = build([road]);
    const roads = layer(tile, "road");
    const values = renderLayerVertices(tile.payload, roads);
    expect(values.length / roads.stride).toBe(4);
    expect(triangles(tile, roads)).toHaveLength(2);
    /* halfWidth component and distance along the line. */
    expect(values[5]).toBe(resolveRoadWidth(road as Extract<MapFeature, { kind: "road" }>) / 2);
    expect([values[7], values[15], values[23], values[31]]).toEqual([0, 0, 100, 100]);
    /* Start cap extrudes backwards (-x) on both sides, end cap forwards. */
    expect(values[3]).toBe(-1);
    expect(values[11]).toBe(-1);
    expect(values[19]).toBe(1);
    expect(values[27]).toBe(1);
    expect(tile.meta[0]).toMatchObject({ k: "road", c: "primary", r: "D930", n: "Route de Toulouse" });
  });

  it("paints major roads over minor ones", () => {
    const tile = build([
      feature({ kind: "road", stableId: "r/trunk", geometry: { type: "LineString", coordinates: [[0, 0], [100, 0]] }, roadClass: "trunk" }),
      feature({ kind: "road", stableId: "r/lane", geometry: { type: "LineString", coordinates: [[50, -50], [50, 50]] }, roadClass: "residential" }),
    ]);
    const ranges = renderLayerRanges(tile.payload, layer(tile, "road"));
    expect(tile.meta[ranges[2]!]!.s).toBe("r/lane");
    expect(tile.meta[ranges[RANGE_STRIDE + 2]!]!.s).toBe("r/trunk");
  });

  it("puts bridges and tunnels on their own layers", () => {
    const base = { kind: "road", geometry: { type: "LineString", coordinates: [[0, 0], [10, 0]] } } as const;
    expect(roadLayerFor(feature({ ...base, stableId: "a", bridge: true }) as Extract<MapFeature, { kind: "road" }>)).toBe("road_bridge");
    expect(roadLayerFor(feature({ ...base, stableId: "b", tunnel: true }) as Extract<MapFeature, { kind: "road" }>)).toBe("road_tunnel");
    expect(roadLayerFor(feature({ ...base, stableId: "c" }) as Extract<MapFeature, { kind: "road" }>)).toBe("road");
  });

  it("splits a hairpin instead of shooting a miter spike", () => {
    const tile = build([feature({ kind: "road", stableId: "r/hairpin", geometry: { type: "LineString", coordinates: [[0, 0], [100, 0], [0, 2]] }, roadClass: "residential" })]);
    const roads = layer(tile, "road");
    const values = renderLayerVertices(tile.payload, roads);
    for (let at = 0; at < values.length; at += roads.stride) {
      expect(Math.hypot(values[at + 3]!, values[at + 4]!)).toBeLessThan(3);
    }
  });

  it("outlines communes, skipping the stretches cut by the tile edge", () => {
    const tile = build([feature({ kind: "place", stableId: "c/1", placeType: "commune", name: "Auch", geometry: { type: "Polygon", coordinates: [[[1000, 1000], [2048, 1000], [2048, 1500], [1000, 1500], [1000, 1000]]] } })]);
    const values = renderLayerVertices(tile.payload, layer(tile, "boundary"));
    for (let at = 0; at < values.length; at += 8) expect(values[at] === 2048 && values[at + 3] === 0 && values[at + 4] !== 0).toBe(false);
    expect(tile.meta[0]).toMatchObject({ k: "place", c: "commune", n: "Auch" });
  });
});

describe("buildRenderTile: points and anchors", () => {
  it("keeps points in the meta table only", () => {
    const tile = build([
      feature({ kind: "poi", stableId: "p/1", poiType: "pharmacy", category: "pharmacy", name: "Pharmacie", geometry: { type: "Point", coordinates: [5, 5] } }),
      feature({ kind: "address", stableId: "a/1", street: "Rue Gambetta", housenumber: "12", geometry: { type: "Point", coordinates: [6, 6] } }),
    ]);
    expect(tile.layers).toHaveLength(0);
    expect(tile.meta.map((entry) => entry.k)).toEqual(["poi", "address"]);
    expect(tile.meta[0]).toMatchObject({ c: "pharmacy", a: [5, 5] });
    expect(tile.meta[1]!.p).toEqual({ hn: "12", st: "Rue Gambetta" });
  });

  it("anchors areas on their centroid and lines on their midpoint", () => {
    expect(geometryAnchor({ type: "Polygon", coordinates: [square(0, 0, 10)] as [number, number][][] })).toEqual([5, 5]);
    expect(geometryAnchor({ type: "LineString", coordinates: [[0, 0], [10, 0], [10, 30]] })).toEqual([10, 10]);
  });
});
