"use client";

import { useEffect, useMemo } from "react";
import {
  roadMat,
  waterMat,
  buildingMat,
  landuseMat,
  boundaryLineMat,
  getPaperColor,
} from "@/lib/scene/materials";
import { sceneMetrics, publishSceneDiagnostics } from "@/lib/scene/sceneMetrics";
import buildBoundary from "@/lib/scene/buildBoundary";
import { buildBuildings } from "@/lib/scene/buildBuildings";
import { buildRoads } from "@/lib/scene/buildRoads";
import buildWater from "@/lib/scene/buildWater";
import { buildLanduse } from "@/lib/scene/buildLanduse";
import buildPois from "@/lib/scene/buildPois";

type Coordinate = [number, number];
type Geometry =
  | { type: "Point"; coordinates: Coordinate }
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "Polygon"; coordinates: Coordinate[][] }
  | { type: "MultiPolygon"; coordinates: Coordinate[][][] };

type FeatureKind = "building" | "road" | "water" | "landuse" | "poi" | "business" | "boundary";

export interface SceneFeature {
  kind: FeatureKind;
  stableId: string;
  geometry: Geometry;
  name?: string;
  x?: number;
  z?: number;
  height?: number;
  levels?: number;
  highway?: string;
  roadClass?: string;
  width?: number;
  waterType?: string;
  landuseType?: string;
  category?: string;
  size?: number;
  color?: string;
  bridge?: boolean;
  tunnel?: boolean;
}

export interface CitySceneProps {
  features: SceneFeature[];
  layers: Record<string, boolean>;
  selectedFeature?: unknown;
  onFeatureSelect?: (feature: unknown | null) => void;
}

function visible(feature: SceneFeature, layers: Record<string, boolean>): boolean {
  if (feature.kind === "building") return layers.buildings !== false;
  if (feature.kind === "road") return layers.roads !== false;
  if (feature.kind === "water") return layers.water !== false;
  if (feature.kind === "landuse") return layers.landuse !== false;
  if (feature.kind === "boundary") return layers.boundary !== false;
  return layers.pois !== false;
}

function isPolygon(geometry: Geometry): geometry is Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

type BuildingScene = SceneFeature & { kind: "building"; geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> };
type RoadScene = SceneFeature & { kind: "road"; geometry: Extract<Geometry, { type: "LineString" }> };
type WaterScene = SceneFeature & { kind: "water"; geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> };
type LanduseScene = SceneFeature & { kind: "landuse"; geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> };
type PoiScene = SceneFeature & { kind: "poi" | "business"; geometry: Extract<Geometry, { type: "Point" }> };

function isBuildingFeature(feature: SceneFeature): feature is BuildingScene {
  return feature.kind === "building" && isPolygon(feature.geometry);
}
function isRoadFeature(feature: SceneFeature): feature is RoadScene {
  return feature.kind === "road" && feature.geometry.type === "LineString";
}
function isWaterFeature(feature: SceneFeature): feature is WaterScene {
  return feature.kind === "water" && isPolygon(feature.geometry);
}
function isLanduseFeature(feature: SceneFeature): feature is LanduseScene {
  return feature.kind === "landuse" && isPolygon(feature.geometry);
}
function isPoiFeature(feature: SceneFeature): feature is PoiScene {
  return (feature.kind === "poi" || feature.kind === "business") && feature.geometry.type === "Point";
}
function isBoundaryFeature(feature: SceneFeature): feature is SceneFeature & { kind: "boundary"; geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> } {
  return feature.kind === "boundary" && isPolygon(feature.geometry);
}

export default function CityScene({
  features,
  layers,
}: CitySceneProps) {
  const activeFeatures = useMemo(
    () => features.filter((feature) => visible(feature, layers)),
    [features, layers],
  );
  const groups = useMemo(() => ({
    building: activeFeatures.filter(isBuildingFeature),
    road: activeFeatures.filter(isRoadFeature),
    water: activeFeatures.filter(isWaterFeature),
    landuse: activeFeatures.filter(isLanduseFeature),
    poi: activeFeatures.filter(isPoiFeature),
    boundary: activeFeatures.filter(isBoundaryFeature),
  }), [activeFeatures]);
  const buildingResult = useMemo(
    () => buildBuildings(groups.building.map((feature) => ({ ...feature, kind: "building" as const }))),
    [groups.building],
  );
  const roadResult = useMemo(
    () =>
      buildRoads(
        groups.road.map((feature) => ({
          ...feature,
          kind: "road" as const,
          highway: feature.highway ?? feature.roadClass,
        })),
      ),
    [groups.road],
  );
  const waterResult = useMemo(
    () => buildWater(groups.water.map((feature) => ({ ...feature, kind: "water" as const }))),
    [groups.water],
  );
  const landuseResult = useMemo(
    () => buildLanduse(groups.landuse.map((feature) => ({ ...feature, kind: "landuse" as const }))),
    [groups.landuse],
  );
  const poiResult = useMemo(
    () => buildPois(groups.poi.map((feature) => ({ ...feature, kind: "poi" as const }))),
    [groups.poi],
  );
  const boundaryResult = useMemo(
    () => buildBoundary(groups.boundary.map((feature) => ({ ...feature, kind: "boundary" as const }))),
    [groups.boundary],
  );

  useEffect(() => {
    sceneMetrics.loadedFeatureCount = features.length;
    sceneMetrics.buildingCount = groups.building.length;
    sceneMetrics.roadCount = groups.road.length;
    sceneMetrics.waterCount = groups.water.length;
    sceneMetrics.landuseCount = groups.landuse.length;
    sceneMetrics.poiCount = groups.poi.length;
    const geometryCount = [
      buildingResult.geometry,
      roadResult.geometry,
      waterResult.geometry,
      landuseResult.geometry,
      boundaryResult.geometry,
    ].filter((geometry) => (geometry.getAttribute("position")?.count ?? 0) > 0).length;
    sceneMetrics.drawCalls = geometryCount + (poiResult.mesh.count > 0 ? 1 : 0);
    // React commits this effect synchronously after the scene graph
    // reflects the current feature set — publish immediately instead of
    // waiting for the next requestAnimationFrame tick, which otherwise
    // leaves a window where renderer-status reads "initialized" while
    // building/road/poi/draw counts still read their stale defaults.
    publishSceneDiagnostics(true);
  }, [features, groups, buildingResult, roadResult, waterResult, landuseResult, poiResult, boundaryResult]);

  return (
    <>
      <color attach="background" args={[getPaperColor()]} />
      <group>
        {landuseResult.geometry.getAttribute("position")?.count ? (
          <mesh geometry={landuseResult.geometry} material={landuseMat} renderOrder={0} />
        ) : null}
        {waterResult.geometry.getAttribute("position")?.count ? (
          <mesh geometry={waterResult.geometry} material={waterMat} renderOrder={1} />
        ) : null}
        {roadResult.geometry.getAttribute("position")?.count ? (
          <mesh geometry={roadResult.geometry} material={roadMat} renderOrder={2} />
        ) : null}
        {buildingResult.geometry.getAttribute("position")?.count ? (
          <mesh geometry={buildingResult.geometry} material={buildingMat} renderOrder={3} />
        ) : null}
        {poiResult.mesh ? <primitive object={poiResult.mesh} renderOrder={4} /> : null}
        {boundaryResult.geometry.getAttribute("position")?.count ? (
          <lineSegments geometry={boundaryResult.geometry} material={boundaryLineMat} renderOrder={5} />
        ) : null}
      </group>
    </>
  );
}
