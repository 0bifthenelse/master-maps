import { afterEach, describe, expect, it } from "vitest";
import { BufferGeometry, type Material } from "three";
import {
  RENDER_LAYER_IDS,
  decodeRenderTile,
  encodeRenderTile,
  type FeatureMeta,
  type RenderLayerId,
  type RenderTileInput,
} from "@/lib/render/codec";
import { LAYER_OBJECT_KINDS } from "@/lib/render/sceneFromDecoded";
import { materialForLayer } from "@/lib/scene/materials";
import { getTileCacheEntry, pickStableId, putDecodedTile, resetTileGpuCache, syncMountedTiles } from "@/lib/render/tileGpuCache";
import {
  batchKeyFor,
  buildMergedBatchBuffers,
  buildMergedBatchGeometry,
  chunkKeyFor,
  mergedPickAnchor,
  planTileObjects,
  resolveMergedIndexPick,
  resolveMergedPointPick,
  type SceneObjectPlan,
  type TileLayerSource,
} from "@/components/map/sceneObjectPlan";

const NO_HIDDEN_LAYERS: Record<string, boolean> = {};
const PAIR_LIST_LAYERS: readonly RenderLayerId[] = ["boundary"];
const POINT_LAYERS: readonly RenderLayerId[] = ["structures_point", "poi", "address", "place"];
const RIBBON_LAYERS: readonly RenderLayerId[] = ["water_line", "transport_line", "structure_line"];

interface LayerShape {
  featureCount: number;
  verticesPerFeature: number;
  indicesPerFeature: number;
}

/** Miter ribbons carry two triangles per feature, the boundary one segment pair. */
function layerShape(layerId: RenderLayerId): LayerShape {
  if (POINT_LAYERS.includes(layerId)) return { featureCount: 5, verticesPerFeature: 1, indicesPerFeature: 0 };
  if (PAIR_LIST_LAYERS.includes(layerId)) return { featureCount: 6, verticesPerFeature: 2, indicesPerFeature: 2 };
  return { featureCount: 4, verticesPerFeature: 4, indicesPerFeature: 6 };
}

function stableIdFor(layerId: RenderLayerId, feature: number): string {
  return `feature:${layerId}:${feature}`;
}

function renderTileInput(tileId: string, layerIds: readonly RenderLayerId[]): RenderTileInput {
  const meta: FeatureMeta[] = [];
  const layers: { id: RenderLayerId; positions: Float32Array; indices: Uint32Array; ranges: Uint32Array }[] = [];
  for (const id of layerIds) {
    const shape = layerShape(id);
    const positions: number[] = [];
    const indices: number[] = [];
    const ranges: number[] = [];
    for (let feature = 0; feature < shape.featureCount; feature += 1) {
      const metaIndex = meta.length;
      meta.push({ s: stableIdFor(id, feature), k: id, c: `${id}-${feature}`, a: [feature, feature] });
      const base = positions.length / 3;
      if (shape.indicesPerFeature === 0) {
        positions.push(feature, 3, feature);
        ranges.push(0, 0, metaIndex);
        continue;
      }
      for (let vertex = 0; vertex < shape.verticesPerFeature; vertex += 1) {
        positions.push(feature * 100 + vertex, 1, feature * 10 + vertex);
      }
      ranges.push(indices.length, shape.indicesPerFeature, metaIndex);
      for (let entry = 0; entry < shape.indicesPerFeature; entry += 1) indices.push(base + (entry % shape.verticesPerFeature));
    }
    layers.push({
      id,
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      ranges: new Uint32Array(ranges),
    });
  }
  const lod = Number(/^l(\d+)_/.exec(tileId)?.[1] ?? 0);
  return { tileId, lod, bounds: [0, 0, 2048, 2048], datasetVersion: "0.1.0", layers, meta };
}

function sourcesFor(tileIds: readonly string[], layerIds: readonly RenderLayerId[]): TileLayerSource[] {
  syncMountedTiles(tileIds);
  return tileIds.map((tileId) => {
    const entry = putDecodedTile(decodeRenderTile(encodeRenderTile(renderTileInput(tileId, layerIds))));
    return {
      tileId,
      layers: new Map([...entry.layers].map(([layerId, layer]) => [layerId, {
        geometry: layer.geometry,
        rangeLength: layer.rangeLength,
        featureCount: layer.featureCount,
        isPointLayer: layer.isPointLayer,
      }])),
    };
  });
}

function geometryFor(sources: readonly TileLayerSource[], plan: SceneObjectPlan): Map<string, BufferGeometry> {
  const geometries = new Map<string, BufferGeometry>();
  for (const contributor of plan.contributors) {
    if (geometries.has(contributor.tileId)) continue;
    const source = sources.find((candidate) => candidate.tileId === contributor.tileId);
    const geometry = source?.layers.get(contributor.layerId)?.geometry;
    if (geometry !== undefined) geometries.set(contributor.tileId, geometry);
  }
  return geometries;
}

function sourceLayer(sources: readonly TileLayerSource[], tileId: string, layerId: RenderLayerId) {
  const source = sources.find((candidate) => candidate.tileId === tileId);
  const layer = source?.layers.get(layerId);
  if (layer === undefined) throw new Error(`tile ${tileId} carries no layer ${layerId}`);
  return layer;
}

function facesPerTile(plan: SceneObjectPlan, sources: readonly TileLayerSource[]): number {
  return sourceLayer(sources, plan.contributors[0]!.tileId, plan.layerId).geometry.getIndex()!.count;
}

function expectedMergedLayout(plan: SceneObjectPlan, sources: readonly TileLayerSource[]) {
  const isPointBatch = plan.pickIndexKind === "vertex";
  const vertexOffsets: number[] = [];
  const indexOffsets: number[] = [];
  const rangeOffsets: number[] = [];
  const indexCounts: number[] = [];
  const rangeStarts: number[] = [];
  let vertexOffset = 0;
  let indexOffset = 0;
  let rangeOffset = 0;
  for (const contributor of plan.contributors) {
    const layer = sourceLayer(sources, contributor.tileId, contributor.layerId);
    const ranges = layer.geometry.getAttribute("featureRange");
    const indexCount = isPointBatch ? 0 : layer.geometry.getIndex()!.count;
    vertexOffsets.push(vertexOffset);
    indexOffsets.push(indexOffset);
    rangeOffsets.push(rangeOffset);
    indexCounts.push(indexCount);
    for (let row = 0; row < ranges.count; row += 1) rangeStarts.push(indexOffset + ranges.getX(row));
    rangeOffset += ranges.count;
    vertexOffset += layer.geometry.getAttribute("position").count;
    indexOffset += indexCount;
  }
  return { vertexOffsets, indexOffsets, rangeOffsets, indexCounts, rangeStarts };
}

function coveringRangeRow(ranges: { count: number; getX: (row: number) => number; getY: (row: number) => number }, face: number): number {
  for (let row = 0; row < ranges.count; row += 1) {
    const start = ranges.getX(row);
    if (face >= start && face < start + ranges.getY(row)) return row;
  }
  throw new Error(`no feature range covers face ${face}`);
}

function fillPlan(tileIds: readonly string[], layerId: RenderLayerId): { plan: SceneObjectPlan; geometry: BufferGeometry } {
  const sources = sourcesFor(tileIds, [layerId]);
  const plan = planTileObjects(sources, NO_HIDDEN_LAYERS)[0]!;
  return { plan, geometry: buildMergedBatchGeometry(plan, geometryFor(sources, plan)) };
}

function materialOf(plan: SceneObjectPlan): Material {
  const material = materialForLayer(plan.materialKey);
  if (material === undefined) throw new Error(`layer ${plan.materialKey} has no material`);
  return material;
}

afterEach(() => {
  resetTileGpuCache();
});

describe("scene object plan", () => {
  it("mounts strictly fewer objects than one per tile and layer pair", () => {
    const layerIds = RENDER_LAYER_IDS.slice(0, 8);
    const tileIds = Array.from({ length: 100 }, (_, index) => `l2_${index % 10}_${Math.floor(index / 10)}`);
    const sources = sourcesFor(tileIds, layerIds);
    const plans = planTileObjects(sources, NO_HIDDEN_LAYERS);
    const before = sources.reduce((total, source) => total + source.layers.size, 0);
    expect(before).toBe(tileIds.length * layerIds.length);
    expect(plans.length).toBeLessThan(before);
    expect(before - plans.length).toBeGreaterThanOrEqual(Math.ceil(before / 2));
  });

  it("maps every merged index back to its source tile, face and stableId", () => {
    const layerId: RenderLayerId = "road_normal";
    const tileIds = ["l2_0_0", "l2_1_0", "l2_0_1", "l2_1_1"];
    const sources = sourcesFor(tileIds, [layerId]);
    const plan = planTileObjects(sources, NO_HIDDEN_LAYERS)[0]!;
    const buffers = buildMergedBatchBuffers(plan, geometryFor(sources, plan));
    const layout = expectedMergedLayout(plan, sources);
    expect(plan.contributors.map((contributor) => contributor.vertexOffset)).toEqual(layout.vertexOffsets);
    expect(plan.contributors.map((contributor) => contributor.indexOffset)).toEqual(layout.indexOffsets);
    expect(plan.contributors.map((contributor) => contributor.rangeOffset)).toEqual(layout.rangeOffsets);
    expect(plan.contributors.map((contributor) => contributor.indexCount)).toEqual(layout.indexCounts);
    expect([...buffers.indices]).toEqual(plan.contributors.flatMap((contributor, order) => {
      const index = sourceLayer(sources, contributor.tileId, layerId).geometry.getIndex()!;
      return Array.from({ length: index.count }, (_, entry) => index.getX(entry) + layout.vertexOffsets[order]!);
    }));
    expect([...buffers.ranges].filter((_, at) => at % 3 === 0)).toEqual(layout.rangeStarts);
    expect([...buffers.ranges].filter((_, at) => at % 3 === 2)).toEqual(plan.contributors.flatMap((contributor) => {
      const ranges = sourceLayer(sources, contributor.tileId, layerId).geometry.getAttribute("featureRange");
      return Array.from({ length: ranges.count }, (_, row) => ranges.getZ(row));
    }));

    const geometry = buildMergedBatchGeometry(plan, geometryFor(sources, plan));
    for (const contributor of plan.contributors) {
      const ranges = sourceLayer(sources, contributor.tileId, layerId).geometry.getAttribute("featureRange");
      expect(contributor.indexCount).toBe(facesPerTile(plan, sources));
      const { plan: filled, geometry: filledGeometry } = fillPlan([contributor.tileId], layerId);
      for (let face = 0; face < contributor.indexCount; face += 1) {
        const hit = resolveMergedIndexPick(filled, filledGeometry, face);
        expect(hit, `merged index ${face} of ${contributor.tileId} is unresolvable`).not.toBeNull();
        expect(hit!.tileId).toBe(contributor.tileId);
        expect(hit!.layerId).toBe(layerId);
        expect(hit!.faceIndex).toBe(coveringRangeRow(ranges, face));
        expect(hit!.stableId).toBe(pickStableId(getTileCacheEntry(contributor.tileId)!, layerId, face));
      }
      expect(resolveMergedIndexPick(filled, filledGeometry, contributor.indexCount)).toBeNull();
    }
  });

  it("keeps material sharing inside one object kind and places every layer in one batch per chunk", () => {
    const tileIds = ["l0_0_0", "l0_1_0", "l0_0_1", "l0_1_1", "boundary"];
    const sources = sourcesFor(tileIds, RENDER_LAYER_IDS);
    const plans = planTileObjects(sources, NO_HIDDEN_LAYERS);
    for (const plan of plans) {
      expect(plan.objectKind).toBe(LAYER_OBJECT_KINDS[plan.layerId]);
      expect(materialOf(plan)).toBe(materialForLayer(plan.layerId));
      expect(plan.chunkKey).toBe(chunkKeyFor(plan.contributors[0]!.tileId));
      expect(plan.key).toBe(`${batchKeyFor(plan.layerId, plan.objectKind)}|${plan.chunkKey}`);
      expect(new Set(plan.contributors.map((contributor) => contributor.layerId))).toEqual(new Set([plan.layerId]));
    }
    const byMaterial = new Map<Material, SceneObjectPlan[]>();
    for (const plan of plans) {
      const group = byMaterial.get(materialOf(plan)) ?? [];
      group.push(plan);
      byMaterial.set(materialOf(plan), group);
    }
    for (const group of byMaterial.values()) {
      for (const plan of group) {
        for (const other of group) {
          expect(other.objectKind, `${plan.layerId} shares a material with ${other.layerId} of a different object kind`).toBe(plan.objectKind);
          expect(other.pickIndexKind, `${plan.layerId} shares a material with ${other.layerId} of a different attribute layout`).toBe(plan.pickIndexKind);
        }
      }
    }
    const grouped = new Map<Material, Set<RenderLayerId>>();
    for (const plan of plans) {
      const group = grouped.get(materialOf(plan)) ?? new Set<RenderLayerId>();
      group.add(plan.layerId);
      grouped.set(materialOf(plan), group);
    }
    for (const group of grouped.values()) {
      const kinds = new Set([...group].map((layerId) => LAYER_OBJECT_KINDS[layerId]));
      expect(kinds.size, `${[...group].join(",")} share one material across object kinds`).toBe(1);
    }
    for (const layerId of RENDER_LAYER_IDS) {
      const chunks = new Set(sources.filter((source) => source.layers.has(layerId)).map((source) => chunkKeyFor(source.tileId)));
      const forLayer = plans.filter((plan) => plan.layerId === layerId);
      expect(forLayer.length, `layer ${layerId} must have one batch per chunk`).toBe(chunks.size);
      for (const chunkKey of chunks) {
        expect(forLayer.filter((plan) => plan.chunkKey === chunkKey).length).toBe(1);
      }
    }
  });

  it("keeps an unchanged batch identical across planning calls and rebuilds only arriving chunks", () => {
    const layerIds = RENDER_LAYER_IDS.slice(0, 6);
    const resident = sourcesFor(["l0_0_0", "l0_1_0", "l0_0_1", "l0_1_1"], layerIds);
    const first = planTileObjects(resident, NO_HIDDEN_LAYERS);
    const second = planTileObjects(resident, NO_HIDDEN_LAYERS);
    expect(second.map((plan) => plan.key)).toEqual(first.map((plan) => plan.key));
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]!.signature).toBe(first[index]!.signature);
      expect(second[index]!.contributors.map((contributor) => contributor.tileId))
        .toEqual(first[index]!.contributors.map((contributor) => contributor.tileId));
    }
    const grown = planTileObjects([...resident, ...sourcesFor(["l0_4_4"], layerIds)], NO_HIDDEN_LAYERS);
    const beforeByKey = new Map(first.map((plan) => [plan.key, plan.signature]));
    const untouched = grown.filter((plan) => beforeByKey.get(plan.key) === plan.signature);
    expect(untouched.length).toBeGreaterThan(0);
    for (const plan of grown) {
      if (untouched.includes(plan)) continue;
      expect(beforeByKey.has(plan.key)).toBe(false);
    }
    expect(grown.length).toBe(first.length + layerIds.length);
  });

  it("picks point layers by vertex index and every indexed layer by its reported hit index", () => {
    const tileIds = ["l0_0_0", "l0_1_0", "l0_0_1", "l0_1_1"];

    const pointSources = sourcesFor(tileIds, ["poi"]);
    const pointPlan = planTileObjects(pointSources, NO_HIDDEN_LAYERS)[0]!;
    expect(pointPlan.pickIndexKind).toBe("vertex");
    expect(pointPlan.objectKind).toBe("points");
    const pointGeometry = buildMergedBatchGeometry(pointPlan, geometryFor(pointSources, pointPlan));
    expect(pointGeometry.getIndex()).toBeNull();
    expect(pointPlan.contributors).toHaveLength(tileIds.length);
    for (const contributor of pointPlan.contributors) {
      const { plan: filled } = fillPlan([contributor.tileId], "poi");
      for (let vertex = 0; vertex < contributor.vertexCount; vertex += 1) {
        const hit = resolveMergedPointPick(filled, vertex);
        expect(hit, `poi vertex ${vertex} of ${contributor.tileId} is unresolvable`).not.toBeNull();
        expect(hit!.tileId).toBe(contributor.tileId);
        expect(hit!.vertexIndex).toBe(vertex);
      }
      expect(resolveMergedPointPick(filled, contributor.vertexCount)).toBeNull();
    }


    for (const layerId of ["buildings", "road_normal", ...RIBBON_LAYERS, "boundary"] as const) {
      const sources = sourcesFor(tileIds, [layerId]);
      const plan = planTileObjects(sources, NO_HIDDEN_LAYERS)[0]!;
      expect(plan.pickIndexKind).toBe("index");
      expect(plan.contributors).toHaveLength(tileIds.length);
      const geometry = buildMergedBatchGeometry(plan, geometryFor(sources, plan));
      const mergedIndex = geometry.getIndex()!;
      for (const contributor of plan.contributors) {
        const ranges = sourceLayer(sources, contributor.tileId, layerId).geometry.getAttribute("featureRange");
        const { plan: filled, geometry: filledGeometry } = fillPlan([contributor.tileId], layerId);
        for (const face of [0, contributor.indexCount - 1]) {
          const hit = resolveMergedIndexPick(filled, filledGeometry, face);
          expect(hit, `${layerId} index ${face} of ${contributor.tileId} is unresolvable`).not.toBeNull();
          expect(hit!.tileId).toBe(contributor.tileId);
          expect(hit!.faceIndex).toBe(coveringRangeRow(ranges, face));
        }
        if (plan.objectKind === "lineSegments") {
          expect(mergedIndex.getX(contributor.indexOffset)).toBe(contributor.vertexOffset);
        }
      }
      expect(resolveMergedIndexPick(plan, geometry, geometry.getIndex()!.count)).toBeNull();
    }
  });
});

describe("merged pick anchors", () => {
  const SURFACE_TILES = ["l2_0_0", "l2_1_0"] as const;

  function mergedPlan(layerId: RenderLayerId) {
    const sources = sourcesFor(SURFACE_TILES, [layerId]);
    const plan = planTileObjects(sources, NO_HIDDEN_LAYERS)[0]!;
    return { sources, plan, geometry: buildMergedBatchGeometry(plan, geometryFor(sources, plan)) };
  }

  function ownerOf(plan: SceneObjectPlan, hitIndex: number, anchor: "index" | "vertex") {
    const owner = plan.contributors.find((contributor) => hitIndex >= (anchor === "index" ? contributor.indexOffset : contributor.vertexOffset)
      && hitIndex < (anchor === "index" ? contributor.indexOffset + contributor.indexCount : contributor.vertexOffset + contributor.vertexCount));
    if (owner === undefined) throw new Error(`no contributor owns merged ${anchor} ${hitIndex}`);
    return owner;
  }

  it("resolves every triangle of a merged surface batch from the face index a mesh reports", () => {
    const layerId: RenderLayerId = "buildings";
    const { sources, plan, geometry } = mergedPlan(layerId);
    expect(plan.objectKind).toBe("mesh");
    expect(plan.contributors).toHaveLength(SURFACE_TILES.length);
    const triangleCount = geometry.getIndex()!.count / 3;
    expect(triangleCount).toBeGreaterThan(0);

    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const hitIndex = mergedPickAnchor("mesh", { faceIndex: triangle })!;
      expect(hitIndex).toBe(triangle * 3);
      const hit = resolveMergedIndexPick(plan, geometry, hitIndex);
      expect(hit, `merged triangle ${triangle} is unresolvable`).not.toBeNull();
      const owner = ownerOf(plan, hitIndex, "index");
      expect(hit!.tileId).toBe(owner.tileId);
      const sourceIndex = hitIndex - owner.indexOffset;
      const ranges = sourceLayer(sources, owner.tileId, layerId).geometry.getAttribute("featureRange");
      expect(hit!.faceIndex).toBe(coveringRangeRow(ranges, sourceIndex));
      expect(hit!.stableId).toBe(pickStableId(getTileCacheEntry(owner.tileId)!, layerId, sourceIndex));
      expect(hit!.stableId).toBe(stableIdFor(layerId, hit!.faceIndex));
    }
  });

  it("resolves a hairline batch from the even index slots a lineSegments reports", () => {
    const layerId: RenderLayerId = "boundary";
    const { sources, plan, geometry } = mergedPlan(layerId);
    expect(plan.objectKind).toBe("lineSegments");
    const indexCount = geometry.getIndex()!.count;
    expect(indexCount % 2).toBe(0);

    for (let slot = 0; slot < indexCount - 1; slot += 2) {
      const hitIndex = mergedPickAnchor("lineSegments", { index: slot })!;
      expect(hitIndex).toBe(slot);
      const hit = resolveMergedIndexPick(plan, geometry, hitIndex);
      expect(hit, `merged segment ${slot} is unresolvable`).not.toBeNull();
      const owner = ownerOf(plan, hitIndex, "index");
      expect(hit!.tileId).toBe(owner.tileId);
      const ranges = sourceLayer(sources, owner.tileId, layerId).geometry.getAttribute("featureRange");
      expect(hit!.faceIndex).toBe(coveringRangeRow(ranges, hitIndex - owner.indexOffset));
      expect(hit!.stableId).toBe(stableIdFor(layerId, hit!.faceIndex));
    }
  });

  it("resolves a point batch from the vertex index a points object reports", () => {
    const layerId: RenderLayerId = "poi";
    const { sources, plan, geometry } = mergedPlan(layerId);
    expect(plan.objectKind).toBe("points");
    expect(plan.pickIndexKind).toBe("vertex");
    expect(geometry.getIndex()).toBeNull();
    const vertexTotal = plan.contributors.reduce((total, contributor) => total + contributor.vertexCount, 0);
    expect(vertexTotal).toBeGreaterThan(0);

    for (let vertex = 0; vertex < vertexTotal; vertex += 1) {
      const hitIndex = mergedPickAnchor("points", { index: vertex })!;
      expect(hitIndex).toBe(vertex);
      const hit = resolveMergedPointPick(plan, hitIndex);
      expect(hit, `merged poi vertex ${vertex} is unresolvable`).not.toBeNull();
      const owner = ownerOf(plan, hitIndex, "vertex");
      expect(hit!.tileId).toBe(owner.tileId);
      expect(hit!.vertexIndex).toBe(vertex - owner.vertexOffset);
      expect(hit!.stableId).toBe(stableIdFor(layerId, hit!.vertexIndex));
    }
  });

  it("returns null for an anchor the merged buffers do not cover", () => {
    const { plan, geometry } = mergedPlan("buildings");
    const indexCount = geometry.getIndex()!.count;
    expect(resolveMergedIndexPick(plan, geometry, -1)).toBeNull();
    expect(resolveMergedIndexPick(plan, geometry, indexCount)).toBeNull();
    expect(resolveMergedIndexPick(plan, geometry, Number.NaN)).toBeNull();
    expect(resolveMergedIndexPick(plan, geometry, 1.5)).toBeNull();
    expect(mergedPickAnchor("mesh", { faceIndex: indexCount / 3 })).toBe(indexCount);

    const pointPlan = mergedPlan("poi");
    const vertexTotal = pointPlan.plan.contributors.reduce((total, contributor) => total + contributor.vertexCount, 0);
    expect(resolveMergedPointPick(pointPlan.plan, -1)).toBeNull();
    expect(resolveMergedPointPick(pointPlan.plan, vertexTotal)).toBeNull();

    expect(mergedPickAnchor("mesh", {})).toBeNull();
    expect(mergedPickAnchor("lineSegments", { faceIndex: 0 })).toBeNull();
    expect(mergedPickAnchor("points", { faceIndex: 0 })).toBeNull();
  });
});
