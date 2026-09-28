"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import type { BufferGeometry, Material } from "three";
import {
  roadMat,
  waterMat,
  buildingMat,
  landuseMat,
  boundaryLineMat,
  getPaperColor,
  materialForLayer,
} from "@/lib/scene/materials";
import { sceneMetrics, publishSceneDiagnostics } from "@/lib/scene/sceneMetrics";
import type { Geometry, MapFeature } from "@/lib/data/schema";
import buildBoundary, { selectDatasetBoundary } from "@/lib/scene/buildBoundary";
import { buildBuildings } from "@/lib/scene/buildBuildings";
import { buildRoads } from "@/lib/scene/buildRoads";
import buildWater from "@/lib/scene/buildWater";
import { buildLanduse } from "@/lib/scene/buildLanduse";
import buildPois from "@/lib/scene/buildPois";
import { getTileCacheEntry, markFrameCommitted, syncMountedTiles } from "@/lib/render/tileGpuCache";
import { ORDERED_RENDER_LAYER_IDS } from "@/lib/render/sceneFromDecoded";
import type { RenderLayerId } from "@/lib/render/codec";
import {
  buildBatches,
  hasPosition,
  mergedPickAnchor,
  planTileObjects,
  resolveMergedIndexPick,
  resolveMergedPointPick,
  type MergedIndexPick,
  type MergedPointPick,
  type MountedBatch,
  type TileLayerSource,
} from "@/components/map/sceneObjectPlan";
import LabelLayer from "@/components/map/LabelLayer";

type AreaGeometry = Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;
type LineGeometry = Extract<Geometry, { type: "LineString" | "MultiLineString" }>;
type PointGeometry = Extract<Geometry, { type: "Point" }>;
type BuildingScene = Omit<Extract<MapFeature, { kind: "building" }>, "geometry"> & { geometry: AreaGeometry };
type RoadScene = Omit<Extract<MapFeature, { kind: "road" }>, "geometry"> & { geometry: LineGeometry };
type WaterScene = Omit<Extract<MapFeature, { kind: "water" }>, "geometry"> & { geometry: Extract<Geometry, { type: "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon" }> };
type LanduseScene = Omit<Extract<MapFeature, { kind: "landuse" }>, "geometry"> & { geometry: AreaGeometry };
type PoiScene = Omit<Extract<MapFeature, { kind: "poi" }>, "geometry"> & { geometry: PointGeometry };
type BusinessScene = Omit<Extract<MapFeature, { kind: "business" }>, "geometry"> & { geometry: PointGeometry };
type BoundaryScene = Omit<Extract<MapFeature, { kind: "boundary" }>, "geometry"> & { geometry: AreaGeometry };
export type TransportScene = Omit<Extract<MapFeature, { kind: "transport" }>, "geometry"> & { geometry: Geometry };
export type StructureScene = Omit<Extract<MapFeature, { kind: "structure" }>, "geometry"> & { geometry: Geometry };
export type PlaceScene = Omit<Extract<MapFeature, { kind: "place" }>, "geometry"> & { geometry: Extract<Geometry, { type: "Point" | "Polygon" | "MultiPolygon" }> };
export type SceneFeature = BuildingScene | RoadScene | WaterScene | LanduseScene | PoiScene | BusinessScene | BoundaryScene | TransportScene | StructureScene | PlaceScene;

export interface CitySceneProps {
  /** Present only while tiles are served from the legacy JSON endpoint. */
  features: SceneFeature[];
  layers: Record<string, boolean>;
  /** Tile ids whose geometry is resident in the GPU cache, in render order. */
  tileIds?: string[];
  onPick?: (tileId: string, stableId: string) => void;
  onContextMenu?: (tileId: string, stableId: string, clientX: number, clientY: number) => void;
}

/** Painter order, the codec render order of the layer. */
const LAYER_RENDER_ORDERS: Readonly<Record<RenderLayerId, number>> = {
  habitat: 0,
  landuse: 1,
  water_surface: 2,
  water_line: 3,
  transport_area: 4,
  transport_line: 5,
  structure_line: 6,
  structure_area: 7,
  road_tunnel: 8,
  road_normal: 9,
  road_bridge: 10,
  buildings: 11,
  structures_point: 12,
  poi: 13,
  address: 14,
  place: 15,
  boundary: 16,
};

function visible(feature: SceneFeature, layers: Record<string, boolean>): boolean {
  if (feature.kind === "building") return layers.buildings !== false;
  if (feature.kind === "road") return layers.roads !== false;
  if (feature.kind === "water") return layers.water !== false;
  if (feature.kind === "landuse") return layers.landuse !== false;
  if (feature.kind === "boundary") return layers.boundary !== false;
  if (feature.kind === "transport") return layers.transport !== false;
  if (feature.kind === "structure") return layers.structures !== false;
  if (feature.kind === "place") return layers.places !== false;
  return layers.pois !== false;
}

function isBuildingFeature(feature: SceneFeature): feature is BuildingScene {
  return feature.kind === "building" && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon");
}

function isRoadFeature(feature: SceneFeature): feature is RoadScene {
  return feature.kind === "road" && (feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString");
}

function isWaterFeature(feature: SceneFeature): feature is WaterScene {
  return feature.kind === "water";
}

function isLanduseFeature(feature: SceneFeature): feature is LanduseScene {
  return feature.kind === "landuse" && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon");
}

function isPoiFeature(feature: SceneFeature): feature is PoiScene {
  return feature.kind === "poi" && feature.geometry.type === "Point";
}

function isBusinessFeature(feature: SceneFeature): feature is BusinessScene {
  return feature.kind === "business" && feature.geometry.type === "Point";
}

function isBoundaryFeature(feature: SceneFeature): feature is BoundaryScene {
  return feature.kind === "boundary" && (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon");
}

function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) entry.dispose();
  } else {
    material.dispose();
  }
}

interface BatchNodeProps {
  batch: MountedBatch;
  onPick: (tileId: string, stableId: string) => void;
  onContextMenu: (tileId: string, stableId: string, clientX: number, clientY: number) => void;
}

function BatchNode({ batch, onPick, onContextMenu }: BatchNodeProps) {
  const resolveHit = (event: ThreeEvent<MouseEvent>): MergedIndexPick | MergedPointPick | null => {
    const hitIndex = mergedPickAnchor(batch.objectKind, event);
    if (hitIndex === null) return null;
    return batch.pickIndexKind === "vertex"
      ? resolveMergedPointPick(batch, hitIndex)
      : resolveMergedIndexPick(batch, batch.geometry, hitIndex);
  };
  const handleClick = (event: ThreeEvent<MouseEvent>): void => {
    event.stopPropagation();
    const hit = resolveHit(event);
    if (hit === null || hit.stableId === undefined) return;
    onPick(hit.tileId, hit.stableId);
  };
  const handleContextMenu = (event: ThreeEvent<MouseEvent>): void => {
    const hit = resolveHit(event);
    if (hit === null || hit.stableId === undefined) return;
    event.stopPropagation();
    const native = event.nativeEvent;
    native.preventDefault();
    onContextMenu(hit.tileId, hit.stableId, native.clientX, native.clientY);
  };
  const material = materialForLayer(batch.materialKey);
  const renderOrder = LAYER_RENDER_ORDERS[batch.layerId];
  if (batch.objectKind === "lineSegments") {
    return <lineSegments geometry={batch.geometry} material={material} renderOrder={renderOrder} onClick={handleClick} onContextMenu={handleContextMenu} />;
  }
  if (batch.objectKind === "points") {
    return <points geometry={batch.geometry} material={material} renderOrder={renderOrder} onClick={handleClick} onContextMenu={handleContextMenu} />;
  }
  return <mesh geometry={batch.geometry} material={material} renderOrder={renderOrder} onClick={handleClick} onContextMenu={handleContextMenu} />;
}

interface DatasetBoundaryProps {
  features: SceneFeature[];
}

function DatasetBoundary({ features }: DatasetBoundaryProps) {
  const result = useMemo(() => {
    const selected = selectDatasetBoundary(features.filter(isBoundaryFeature));
    return selected === null ? null : buildBoundary([selected]);
  }, [features]);
  useEffect(() => () => {
    result?.geometry.dispose();
  }, [result]);
  if (result === null || !hasPosition(result.geometry)) return null;
  return <lineSegments geometry={result.geometry} material={boundaryLineMat} renderOrder={14} />;
}

interface JsonSceneProps {
  features: SceneFeature[];
  layers: Record<string, boolean>;
}

function JsonScene({ features, layers }: JsonSceneProps) {
  const active = useMemo(() => features.filter((feature) => visible(feature, layers)), [features, layers]);
  const groups = useMemo(() => ({
    building: active.filter(isBuildingFeature),
    road: active.filter(isRoadFeature),
    water: active.filter(isWaterFeature),
    landuse: active.filter(isLanduseFeature),
    poi: active.filter(isPoiFeature),
    business: active.filter(isBusinessFeature),
    boundary: active.filter(isBoundaryFeature),
  }), [active]);
  const buildingResult = useMemo(() => buildBuildings(groups.building), [groups.building]);
  const roadResult = useMemo(() => buildRoads(groups.road), [groups.road]);
  const waterResult = useMemo(() => buildWater(groups.water), [groups.water]);
  const landuseResult = useMemo(() => buildLanduse(groups.landuse), [groups.landuse]);
  const poiResult = useMemo(() => buildPois(groups.poi), [groups.poi]);

  useEffect(() => () => {
    buildingResult.geometry.dispose();
    roadResult.geometry.dispose();
    for (const stratum of roadResult.strata) stratum.geometry.dispose();
    waterResult.geometry.dispose();
    for (const stratum of waterResult.strata) stratum.geometry.dispose();
    landuseResult.geometry.dispose();
    disposeMaterial(poiResult.mesh.material);
  }, [buildingResult, roadResult, waterResult, landuseResult, poiResult]);

  return (
    <>
      {hasPosition(landuseResult.geometry) ? <mesh geometry={landuseResult.geometry} material={landuseMat} renderOrder={0} /> : null}
      {waterResult.strata.map((stratum) => hasPosition(stratum.geometry) ? <mesh key={stratum.stratum} geometry={stratum.geometry} material={waterMat} renderOrder={stratum.stratum === "surface" ? 1 : 2} /> : null)}
      {roadResult.strata.map((stratum) => hasPosition(stratum.geometry) ? <mesh key={stratum.stratum} geometry={stratum.geometry} material={roadMat} renderOrder={stratum.stratum === "tunnel" ? 3 : stratum.stratum === "normal" ? 4 : 5} /> : null)}
      {hasPosition(buildingResult.geometry) ? <mesh geometry={buildingResult.geometry} material={buildingMat} renderOrder={6} /> : null}
      {poiResult.mesh.count > 0 ? <primitive object={poiResult.mesh} renderOrder={7} /> : null}
      <DatasetBoundary features={groups.boundary} />
    </>
  );
}

function noopPick(): void {}

function noopContextMenu(): void {}

/* One merged-geometry cache for the single mounted CityScene. Module scope
   keeps React out of it: the cache is read while planning during render and
   written by the same pure builder, so no ref is touched during render. */
const batchCache = new Map<string, MountedBatch>();

export default function CityScene({ features, layers, tileIds, onPick, onContextMenu }: CitySceneProps) {
  const sources = useMemo<TileLayerSource[] | null>(() => {
    if (tileIds === undefined) return null;
    const resolved: TileLayerSource[] = [];
    for (const tileId of tileIds) {
      const entry = getTileCacheEntry(tileId);
      if (entry === undefined) continue;
      resolved.push({
        tileId,
        layers: new Map([...entry.layers].map(([layerId, layer]) => [layerId, {
          geometry: layer.geometry,
          rangeLength: layer.rangeLength,
          featureCount: layer.featureCount,
          isPointLayer: layer.isPointLayer,
        }])),
      });
    }
    return resolved;
  }, [tileIds]);
  const mountedTiles = useMemo(() => sources?.map((source) => source.tileId), [sources]);
  const plans = useMemo(() => (sources === null ? [] : planTileObjects(sources, layers)), [sources, layers]);
  const batches = useMemo(
    () => (sources === null ? [] : buildBatches(sources, plans, batchCache)),
    [sources, plans],
  );
  const boundaryFeatures = useMemo(
    () => (sources === null ? features.filter(isBoundaryFeature) : []),
    [features, sources],
  );
  const boundaryVisible = layers.boundary !== false;

  useLayoutEffect(() => {
    syncMountedTiles(mountedTiles ?? []);
  }, [mountedTiles]);

  useFrame(() => {
    markFrameCommitted();
  });

  useEffect(() => {
    return () => {
      for (const batch of batchCache.values()) batch.geometry.dispose();
      batchCache.clear();
    };
  }, []);

  useEffect(() => {
    let unbatchedDrawCalls = 0;
    if (sources !== null) {
      for (const source of sources) unbatchedDrawCalls += source.layers.size;
    }
    sceneMetrics.loadedFeatureCount = features.length;
    sceneMetrics.drawCalls = batches.length;
    sceneMetrics.unbatchedDrawCalls = unbatchedDrawCalls;
    sceneMetrics.batchCount = batches.length;
    publishSceneDiagnostics(true);
  }, [features, sources, batches]);

  const decodedTileIds = useMemo(
    () => (sources === null ? [] : sources.map((source) => source.tileId)),
    [sources],
  );
  const labelsVisible = layers.labels !== false;

  return (
    <>
      <color attach="background" args={[getPaperColor()]} />
      <group>
        {sources === null ? (
          <JsonScene features={features} layers={layers} />
        ) : batches.map((batch) => (
          <BatchNode key={batch.key} batch={batch} onPick={onPick ?? noopPick} onContextMenu={onContextMenu ?? noopContextMenu} />
        ))}
        {sources === null && boundaryVisible ? <DatasetBoundary features={boundaryFeatures} /> : null}
      </group>
      {sources !== null && labelsVisible ? <LabelLayer tileIds={decodedTileIds} layers={layers} /> : null}
    </>
  );
}

export type { BufferGeometry, ORDERED_RENDER_LAYER_IDS };
