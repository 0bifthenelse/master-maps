"use client";

import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { BufferGeometry, Material } from "three";
import {
  roadMat,
  waterMat,
  buildingMat,
  landuseMat,
  boundaryLineMat,
  poiMat,
  accentLineMat,
  getPaperColor,
} from "@/lib/scene/materials";
import { sceneMetrics, publishSceneDiagnostics } from "@/lib/scene/sceneMetrics";
import type { Geometry, MapFeature } from "@/lib/data/schema";
import buildBoundary, { selectDatasetBoundary } from "@/lib/scene/buildBoundary";
import { buildBuildings } from "@/lib/scene/buildBuildings";
import { buildRoads } from "@/lib/scene/buildRoads";
import buildWater from "@/lib/scene/buildWater";
import { buildLanduse } from "@/lib/scene/buildLanduse";
import buildPois from "@/lib/scene/buildPois";
import {
  getTileCacheEntry,
  pickStableId,
  type TileCacheEntry,
  type TileLayerEntry,
} from "@/lib/render/tileGpuCache";
import { ORDERED_RENDER_LAYER_IDS } from "@/lib/render/sceneFromDecoded";
import type { RenderLayerId } from "@/lib/render/codec";
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

interface LayerStyle {
  material: Material;
  renderOrder: number;
  object: "mesh" | "lineSegments";
}

const LAYER_STYLES: Readonly<Record<RenderLayerId, LayerStyle>> = {
  habitat: { material: landuseMat, renderOrder: 0, object: "mesh" },
  landuse: { material: landuseMat, renderOrder: 0, object: "mesh" },
  water_surface: { material: waterMat, renderOrder: 1, object: "mesh" },
  water_line: { material: waterMat, renderOrder: 2, object: "mesh" },
  transport_area: { material: landuseMat, renderOrder: 1, object: "mesh" },
  transport_line: { material: accentLineMat, renderOrder: 3, object: "lineSegments" },
  structure_line: { material: accentLineMat, renderOrder: 4, object: "lineSegments" },
  structure_area: { material: buildingMat, renderOrder: 5, object: "mesh" },
  road_tunnel: { material: roadMat, renderOrder: 6, object: "mesh" },
  road_normal: { material: roadMat, renderOrder: 7, object: "mesh" },
  road_bridge: { material: roadMat, renderOrder: 8, object: "mesh" },
  buildings: { material: buildingMat, renderOrder: 9, object: "mesh" },
  structures_point: { material: poiMat, renderOrder: 10, object: "mesh" },
  poi: { material: poiMat, renderOrder: 11, object: "mesh" },
  address: { material: poiMat, renderOrder: 12, object: "mesh" },
  place: { material: poiMat, renderOrder: 13, object: "mesh" },
  boundary: { material: boundaryLineMat, renderOrder: 14, object: "lineSegments" },
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

function hasPosition(geometry: { getAttribute: (name: string) => { count: number } | undefined }): boolean {
  return (geometry.getAttribute("position")?.count ?? 0) > 0;
}

function layerHidden(layerId: RenderLayerId, layers: Record<string, boolean>): boolean {
  if (layerId === "buildings") return layers.buildings === false;
  if (layerId === "road_tunnel" || layerId === "road_normal" || layerId === "road_bridge") return layers.roads === false;
  if (layerId === "water_surface" || layerId === "water_line") return layers.water === false;
  if (layerId === "landuse" || layerId === "habitat") return layers.landuse === false;
  if (layerId === "transport_area" || layerId === "transport_line") return layers.transport === false;
  if (layerId === "structure_area" || layerId === "structure_line" || layerId === "structures_point") return layers.structures === false;
  if (layerId === "poi" || layerId === "address") return layers.pois === false;
  if (layerId === "place") return layers.places === false;
  if (layerId === "boundary") return layers.boundary === false;
  return false;
}

interface TileLayerNodeProps {
  layer: TileLayerEntry;
  tileId: string;
  onPick: (tileId: string, stableId: string) => void;
  onContextMenu: (tileId: string, stableId: string, clientX: number, clientY: number) => void;
}

function TileLayerNode({ layer, tileId, onPick, onContextMenu }: TileLayerNodeProps) {
  const style = LAYER_STYLES[layer.layerId as RenderLayerId];
  if (style === undefined || !hasPosition(layer.geometry)) return null;
  const resolveStableId = (faceIndex: number | null | undefined): string | undefined => {
    if (typeof faceIndex !== "number") return undefined;
    const entry = getTileCacheEntry(tileId);
    if (entry === undefined) return undefined;
    return pickStableId(entry, layer.layerId, faceIndex);
  };
  const handleClick = (event: ThreeEvent<MouseEvent>): void => {
    event.stopPropagation();
    const stableId = resolveStableId(event.faceIndex);
    if (stableId !== undefined) onPick(tileId, stableId);
  };
  const handleContextMenu = (event: ThreeEvent<MouseEvent>): void => {
    const stableId = resolveStableId(event.faceIndex);
    if (stableId === undefined) return;
    event.stopPropagation();
    const native = event.nativeEvent;
    native.preventDefault();
    onContextMenu(tileId, stableId, native.clientX, native.clientY);
  };
  if (style.object === "lineSegments") {
    return <lineSegments geometry={layer.geometry} material={style.material} renderOrder={style.renderOrder} onClick={handleClick} onContextMenu={handleContextMenu} />;
  }
  return <mesh geometry={layer.geometry} material={style.material} renderOrder={style.renderOrder} onClick={handleClick} onContextMenu={handleContextMenu} />;
}

interface TileGroupProps {
  tileId: string;
  entry: TileCacheEntry;
  layers: Record<string, boolean>;
  onPick: (tileId: string, stableId: string) => void;
  onContextMenu: (tileId: string, stableId: string, clientX: number, clientY: number) => void;
}

function TileGroup({ tileId, entry, layers, onPick, onContextMenu }: TileGroupProps) {
  const nodes: ReactNode[] = [];
  for (const layerId of ORDERED_RENDER_LAYER_IDS) {

    const layer = entry.layers.get(layerId);
    if (layer === undefined) continue;
    if (LAYER_STYLES[layerId] === undefined) continue;
    if (layerHidden(layerId, layers)) continue;
    nodes.push(
      <TileLayerNode
        key={`${tileId}:${layerId}`}
        layer={layer}
        tileId={tileId}
        onPick={onPick}
        onContextMenu={onContextMenu}
      />,
    );
  }
  return <group>{nodes}</group>;
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

export default function CityScene({ features, layers, tileIds, onPick, onContextMenu }: CitySceneProps) {
  const tileGroups = useMemo(() => {
    if (tileIds === undefined) return null;
    const resolved: { tileId: string; entry: TileCacheEntry }[] = [];
    for (const tileId of tileIds) {
      const entry = getTileCacheEntry(tileId);
      if (entry === undefined) continue;
      resolved.push({ tileId, entry });
    }
    return resolved;
  }, [tileIds]);

  const boundaryFeatures = useMemo(
    () => (tileGroups === null ? features.filter(isBoundaryFeature) : []),
    [features, tileGroups],
  );
  const boundaryVisible = layers.boundary !== false;

  useEffect(() => {
    let drawCalls = 0;
    if (tileGroups !== null) {
      for (const { entry } of tileGroups) drawCalls += entry.layers.size;
    }
    sceneMetrics.loadedFeatureCount = features.length;
    sceneMetrics.drawCalls = drawCalls;
    publishSceneDiagnostics(true);
  }, [features, tileGroups]);

  const decodedTileIds = useMemo(
    () => (tileGroups === null ? [] : tileGroups.map((entry) => entry.tileId)),
    [tileGroups],
  );
  const labelsVisible = layers.labels !== false;

  return (
    <>
      <color attach="background" args={[getPaperColor()]} />
      <group>
        {tileGroups === null ? (
          <JsonScene features={features} layers={layers} />
        ) : tileGroups.map(({ tileId, entry }) => (
          <TileGroup key={tileId} tileId={tileId} entry={entry} layers={layers} onPick={onPick ?? noopPick} onContextMenu={onContextMenu ?? noopContextMenu} />
        ))}
        {tileGroups === null && boundaryVisible ? <DatasetBoundary features={boundaryFeatures} /> : null}
      </group>
      {tileGroups !== null && labelsVisible ? <LabelLayer tileIds={decodedTileIds} layers={layers} /> : null}
    </>
  );
}

function noopPick(): void {}

function noopContextMenu(): void {}

export type { BufferGeometry };
