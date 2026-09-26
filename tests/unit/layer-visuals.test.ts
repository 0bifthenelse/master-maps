import { afterEach, describe, expect, it } from "vitest";
import { Color, MeshBasicMaterial, PointsMaterial, LineBasicMaterial } from "three";
import {
  RENDER_LAYER_IDS,
  decodeRenderTile,
  encodeRenderTile,
  type FeatureMeta,
  type RenderLayerId,
  type RenderTileInput,
} from "@/lib/render/codec";
import {
  LAYER_OBJECT_KINDS,
  ORDERED_RENDER_LAYER_IDS,
  geometryFromLayer,
  isEmptyLayer,
  layerObjectKind,
  layerSupportsClassShading,
  viewDecodedTile,
} from "@/lib/render/sceneFromDecoded";
import {
  evictTile,
  getResidentDecodedTile,
  getResidentDecodedTiles,
  getTileGpuCacheStats,
  hasTileCacheEntry,
  pickStableId,
  putDecodedTile,
  resetTileGpuCache,
  retainTiles,
} from "@/lib/render/tileGpuCache";
import {
  MARKER_SIZES,
  ROOT_ACCENT,
  ROOT_INK,
  ROOT_PAPER,
  materialForLayer,
  mixRoots,
  setThemeTokens,
  allLayerMaterialIds,
} from "@/lib/scene/materials";

const BOUNDS: [number, number, number, number] = [0, 0, 2048, 2048];
const POINTS_PER_LAYER = 3;
const TILE_ID = "l0_17layers";

/* Layers whose features are bare points: one vertex each, zero-length range. */
const POINT_LAYERS: ReadonlySet<RenderLayerId> = new Set([
  "structures_point",
  "poi",
  "address",
  "place",
]);
/* Layers mounted as hairlines. */
const LINE_LAYERS: ReadonlySet<RenderLayerId> = new Set([
  "water_line",
  "transport_line",
  "structure_line",
  "boundary",
]);

function square(positions: number[], x: number, z: number, size: number): number {
  const base = positions.length / 3;
  positions.push(
    x, 0, z,
    x + size, 0, z,
    x + size, 0, z + size,
    x, 0, z + size,
  );
  return base;
}

function ribbon(positions: number[], indices: number[], x: number, z: number): number {
  const base = positions.length / 3;
  positions.push(x, 0, z, x, 0, z + 4, x + 60, 0, z + 4, x + 60, 0, z);
  const indexStart = indices.length;
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return indexStart;
}

/**
 * A synthetic tile that populates every one of the 17 render layer ids, with
 * several features per layer, so range triples, metaIndex values and the
 * layer-to-layer feature cursor are all exercised at once.
 */
function allLayerTile(): RenderTileInput {
  const meta: FeatureMeta[] = [];
  const layers: { id: RenderLayerId; positions: Float32Array; indices: Uint32Array; ranges: Uint32Array }[] = [];
  for (const id of ORDERED_RENDER_LAYER_IDS) {
    const positions: number[] = [];
    const indices: number[] = [];
    const ranges: number[] = [];
    for (let index = 0; index < POINTS_PER_LAYER; index += 1) {
      const offset = index * 200;
      const metaIndex = meta.length;
      meta.push({
        s: `${id}/${index}`,
        k: id,
        c: `${id}-class-${index}`,
        n: `${id} label ${index}`,
        a: [offset, offset],
        w: 4 + index,
      });
      if (POINT_LAYERS.has(id)) {
        positions.push(offset, 2, offset);
        ranges.push(indices.length, 0, metaIndex);
        continue;
      }
      if (LINE_LAYERS.has(id)) {
        ranges.push(ribbon(positions, indices, offset, offset), 6, metaIndex);
        continue;
      }
      const base = square(positions, offset, offset, 40);
      const indexStart = indices.length;
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      ranges.push(indexStart, 6, metaIndex);
    }
    layers.push({
      id,
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      ranges: new Uint32Array(ranges),
    });
  }
  return { tileId: TILE_ID, lod: 0, bounds: BOUNDS, datasetVersion: "0.1.0", layers, meta };
}

function decode(input: RenderTileInput) {
  return decodeRenderTile(encodeRenderTile(input));
}

function relativeLuminance(hex: string): number {
  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

afterEach(() => {
  resetTileGpuCache();
  setThemeTokens(ROOT_ACCENT, ROOT_INK, ROOT_PAPER);
});

describe("render layer materials", () => {
  it("defines a material for every codec render layer and nothing else", () => {
    expect(allLayerMaterialIds().sort()).toEqual([...RENDER_LAYER_IDS].sort());
    for (const id of RENDER_LAYER_IDS) expect(materialForLayer(id)).toBeDefined();
    expect(materialForLayer("not_a_layer")).toBeUndefined();
  });

  it("derives every material colour from the three roots by sRGB mixing", () => {
    const roots = new Set([ROOT_ACCENT.toLowerCase(), ROOT_INK.toLowerCase(), ROOT_PAPER.toLowerCase()]);
    const seen = new Set<string>();
    for (const id of RENDER_LAYER_IDS) {
      const material = materialForLayer(id) as MeshBasicMaterial | LineBasicMaterial;
      const hex = `#${material.color.getHexString()}`;
      if (roots.has(hex)) continue;
      seen.add(hex);
      /* A derived tint must be reproducible as a mix of exactly two roots. */
      const pairs: [string, string][] = [
        [ROOT_ACCENT, ROOT_INK],
        [ROOT_ACCENT, ROOT_PAPER],
        [ROOT_INK, ROOT_PAPER],
      ];
      const reproducible = pairs.some(([from, to]) => {
        for (let step = 0; step <= 1000; step += 1) {
          if (mixRoots(from, to, step / 1000).toLowerCase() === hex) return true;
        }
        return false;
      });
      expect(reproducible, `${id} colour ${hex} is not a mix of the three roots`).toBe(true);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("keeps every layer legible against the paper background", () => {
    for (const id of RENDER_LAYER_IDS) {
      const material = materialForLayer(id) as MeshBasicMaterial;
      const hex = `#${material.color.getHexString()}`;
      const ratio = contrastRatio(hex, ROOT_PAPER);
      /* A fill is allowed to be a low-contrast wash because it is stacked on
         other fills; a line or marker must be readable on its own. */
      const isFill = material instanceof MeshBasicMaterial && material.opacity < 1;
      const floor = isFill ? 1.05 : 2.5;
      expect(ratio, `${id} contrast ${ratio.toFixed(2)} below floor ${floor}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it("distinguishes rail from road and points from areas", () => {
    const road = materialForLayer("road_normal") as MeshBasicMaterial;
    const rail = materialForLayer("transport_line") as LineBasicMaterial;
    const poi = materialForLayer("poi") as PointsMaterial;
    const address = materialForLayer("address") as PointsMaterial;
    const place = materialForLayer("place") as PointsMaterial;
    expect(road.color.getHexString()).not.toBe(rail.color.getHexString());
    expect(poi.color.getHexString()).not.toBe(address.color.getHexString());
    expect(poi.color.getHexString()).not.toBe(place.color.getHexString());
    expect(poi.size).toBe(MARKER_SIZES.poi);
    expect(poi.sizeAttenuation).toBe(false);
  });

  it("repaints every layer material from the new roots, not a hardcoded value", () => {
    setThemeTokens("#00ff00", "#101010", "#f0f0f0");
    /* poi is the pure accent family, so it must equal the new accent exactly. */
    expect((materialForLayer("poi") as PointsMaterial).color.getHexString()).toBe("00ff00");
    expect((materialForLayer("boundary") as LineBasicMaterial).color.getHexString()).toBe("00ff00");
    /* structure_line is ink toward paper at t=0.42, a real derived tint. */
    const derived = (materialForLayer("structure_line") as LineBasicMaterial).color.getHexString();
    expect(derived).toBe(new Color(mixRoots("#101010", "#f0f0f0", 0.42)).getHexString());
  });
});

describe("decoded layer mount strategy", () => {
  it("assigns an object kind to every layer id", () => {
    expect(Object.keys(LAYER_OBJECT_KINDS).sort()).toEqual([...RENDER_LAYER_IDS].sort());
    for (const id of RENDER_LAYER_IDS) {
      expect(layerObjectKind(id)).toBe(POINT_LAYERS.has(id) ? "points" : LINE_LAYERS.has(id) ? "lineSegments" : "mesh");
    }
  });

  it("reports layers in codec render order with a matching renderOrder", () => {
    const view = viewDecodedTile(decode(allLayerTile()));
    expect(view.layers.map((layer) => layer.id)).toEqual([...ORDERED_RENDER_LAYER_IDS]);
    view.layers.forEach((layer, index) => expect(layer.renderOrder).toBe(index));
  });

  it("flags point layers and keeps their vertices without an index", () => {
    const view = viewDecodedTile(decode(allLayerTile()));
    for (const layer of view.layers) {
      if (!POINT_LAYERS.has(layer.id)) continue;
      expect(layer.isPointLayer).toBe(true);
      expect(layer.indices.length).toBe(0);
      expect(isEmptyLayer(layer)).toBe(false);
      const geometry = geometryFromLayer(layer);
      expect(geometry).not.toBeNull();
      expect(geometry!.getIndex()).toBeNull();
      expect(geometry!.getAttribute("position").count).toBe(POINTS_PER_LAYER);
    }
  });

  it("returns null for a layer that carries no positions", () => {
    const view = viewDecodedTile(decode(allLayerTile()));
    const blank = { ...view.layers[0]!, positions: new Float32Array(0), indices: new Uint32Array(0) };
    expect(isEmptyLayer(blank)).toBe(true);
    expect(geometryFromLayer(blank)).toBeNull();
    expect(isEmptyLayer(undefined)).toBe(true);
  });

  it("states that the payload carries no per-vertex class attributes", () => {
    expect(layerSupportsClassShading()).toBe(false);
  });
});

describe("multi-layer tile picking", () => {
  it("maps every face of every populated layer back to its own stableId", () => {
    const entry = putDecodedTile(decode(allLayerTile()));
    expect(entry.layers.size).toBe(RENDER_LAYER_IDS.length);
    for (const id of RENDER_LAYER_IDS) {
      const layer = entry.layers.get(id)!;
      expect(layer.featureCount).toBe(POINTS_PER_LAYER);
      for (let feature = 0; feature < POINTS_PER_LAYER; feature += 1) {
        const expected = `${id}/${feature}`;
        if (layer.isPointLayer) {
          expect(pickStableId(entry, id, feature)).toBe(expected);
          continue;
        }
        const ranges = layer.geometry.getAttribute("featureRange")!;
        const start = ranges.getX(feature);
        const count = ranges.getY(feature);
        expect(pickStableId(entry, id, start)).toBe(expected);
        expect(pickStableId(entry, id, start + count - 1)).toBe(expected);
        expect(pickStableId(entry, id, start - 1)).not.toBe(expected);
      }
    }
  });

  it("resolves overlapping range triples without bleeding across layers", () => {
    const entry = putDecodedTile(decode(allLayerTile()));
    const first = entry.layers.get("road_normal")!;
    const second = entry.layers.get("road_bridge")!;
    expect(first.geometry.getAttribute("featureRange")).not.toBe(second.geometry.getAttribute("featureRange"));
    expect(pickStableId(entry, "road_normal", 0)).toBe("road_normal/0");
    expect(pickStableId(entry, "road_bridge", 0)).toBe("road_bridge/0");
    expect(pickStableId(entry, "road_normal", 10_000)).toBeUndefined();
  });

  it("picks a point layer by vertex index and rejects an out of range index", () => {
    const entry = putDecodedTile(decode(allLayerTile()));
    expect(pickStableId(entry, "poi", 0)).toBe("poi/0");
    expect(pickStableId(entry, "place", 2)).toBe("place/2");
    expect(pickStableId(entry, "address", POINTS_PER_LAYER)).toBeUndefined();
    expect(pickStableId(entry, "poi", -1)).toBeUndefined();
    expect(pickStableId(entry, "no_such_layer", 0)).toBeUndefined();
  });

  it("exposes the decoded tile so a pick can be resolved to its label", () => {
    putDecodedTile(decode(allLayerTile()));
    const resident = getResidentDecodedTile(TILE_ID);
    expect(resident).toBeDefined();
    expect(resident!.meta.find((entry) => entry.s === "place/1")!.n).toBe("place label 1");
    expect(getResidentDecodedTiles().get(TILE_ID)).toBe(resident);
  });

  it("drops the registry entry and every geometry when a tile is evicted", () => {
    const entry = putDecodedTile(decode(allLayerTile()));
    const geometries = [...entry.layers.values()].map((layer) => layer.geometry);
    let disposed = 0;
    for (const geometry of geometries) geometry.addEventListener("dispose", () => { disposed += 1; });
    expect(evictTile(TILE_ID)).toBe(true);
    expect(disposed).toBe(geometries.length);
    expect(getResidentDecodedTile(TILE_ID)).toBeUndefined();
    expect(hasTileCacheEntry(TILE_ID)).toBe(false);
    expect(getTileGpuCacheStats().byteSize).toBe(0);
  });

  it("drops registry entries for tiles the scene no longer references", () => {
    putDecodedTile(decode(allLayerTile()));
    expect(retainTiles([])).toEqual([TILE_ID]);
    expect(getResidentDecodedTile(TILE_ID)).toBeUndefined();
  });
});
describe("shared slab byte accounting", () => {
  it("charges the retained slab, which is strictly more than the layer views cover", () => {
    const tile = decode(allLayerTile());
    const entry = putDecodedTile(tile);
    /* The slab is what the cache actually retains: it holds every layer view
       plus the JSON featureMeta section the codec appends after them, so
       charging the slab is both honest and conservative. */
    expect(entry.byteSize).toBe(tile.payload.byteLength);
    const perLayer = [...entry.layers.values()].reduce((total, layer) => total + layer.byteSize, 0);
    expect(perLayer).toBeLessThan(entry.byteSize);
    expect(getTileGpuCacheStats().byteSize).toBe(entry.byteSize);
  });

  it("charges the whole slab, so a tile evicted under the budget frees its meta too", () => {
    const entry = putDecodedTile(decode(allLayerTile()));
    resetTileGpuCache(entry.byteSize - 1);
    const second = putDecodedTile(decode(allLayerTile()));
    expect(hasTileCacheEntry(second.tileId)).toBe(false);
    expect(getTileGpuCacheStats().byteSize).toBe(0);
  });

  it("keeps a tile whose real retained size fits the budget", () => {
    const entry = putDecodedTile(decode(allLayerTile()));
    resetTileGpuCache(entry.byteSize);
    const second = putDecodedTile(decode(allLayerTile()));
    expect(hasTileCacheEntry(second.tileId)).toBe(true);
    expect(getTileGpuCacheStats().byteSize).toBeLessThanOrEqual(entry.byteSize);
  });
});

describe("contrast of the shipped palette", () => {
  it("quotes a contrast figure that a reviewer can reproduce", () => {
    const poi = new Color(materialForLayer("poi")!.color);
    expect(contrastRatio(`#${poi.getHexString()}`, ROOT_PAPER)).toBeGreaterThan(2.5);
    expect(contrastRatio(ROOT_ACCENT, ROOT_PAPER)).toBeGreaterThan(2.5);
    expect(contrastRatio(ROOT_ACCENT, ROOT_INK)).toBeGreaterThan(4.5);
  });
});
