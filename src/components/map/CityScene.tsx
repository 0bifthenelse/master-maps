"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import type { Material } from "three";
import {
  roadMat,
  waterMat,
  buildingMat,
  landuseMat,
  boundaryLineMat,
  getPaperColor,
} from "@/lib/scene/materials";
import { sceneMetrics, publishSceneDiagnostics } from "@/lib/scene/sceneMetrics";
import type { Geometry, MapFeature } from "@/lib/data/schema";
import buildBoundary from "@/lib/scene/buildBoundary";
import { buildBuildings } from "@/lib/scene/buildBuildings";
import { buildRoads } from "@/lib/scene/buildRoads";
import buildWater from "@/lib/scene/buildWater";
import { buildLanduse } from "@/lib/scene/buildLanduse";
import buildPois, { buildBusinessInstances, type BusinessInstancedResult } from "@/lib/scene/buildPois";
import BusinessHoverPopup3D from "./BusinessHoverPopup3D";

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
export type SceneFeature = BuildingScene | RoadScene | WaterScene | LanduseScene | PoiScene | BusinessScene | BoundaryScene;

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

export default function CityScene({ features, layers }: CitySceneProps) {
  const [hoveredBusinessIndex, setHoveredBusinessIndex] = useState<number | null>(null);
  const activeFeatures = useMemo(() => features.filter((feature) => visible(feature, layers)), [features, layers]);
  const groups = useMemo(() => ({
    building: activeFeatures.filter(isBuildingFeature),
    road: activeFeatures.filter(isRoadFeature),
    water: activeFeatures.filter(isWaterFeature),
    landuse: activeFeatures.filter(isLanduseFeature),
    poi: activeFeatures.filter(isPoiFeature),
    business: activeFeatures.filter(isBusinessFeature),
    boundary: activeFeatures.filter(isBoundaryFeature),
  }), [activeFeatures]);
  const buildingResult = useMemo(() => buildBuildings(groups.building), [groups.building]);
  const roadResult = useMemo(() => buildRoads(groups.road), [groups.road]);
  const waterResult = useMemo(() => buildWater(groups.water), [groups.water]);
  const landuseResult = useMemo(() => buildLanduse(groups.landuse), [groups.landuse]);
  const poiResult = useMemo(() => buildPois(groups.poi), [groups.poi]);
  const businessResult = useMemo<BusinessInstancedResult>(() => buildBusinessInstances(groups.business), [groups.business]);
  const boundaryResult = useMemo(() => buildBoundary(groups.boundary), [groups.boundary]);

  const handleBusinessPointerOver = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    if (typeof event.instanceId !== "number") return;
    const featureIndex = businessResult.featureIdByInstance[event.instanceId];
    if (featureIndex === undefined) return;
    businessResult.setHighlight(event.instanceId);
    setHoveredBusinessIndex(featureIndex);
    document.body.style.cursor = "pointer";
  }, [businessResult]);

  const handleBusinessPointerOut = useCallback((event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    businessResult.setHighlight(null);
    setHoveredBusinessIndex(null);
    document.body.style.cursor = "default";
  }, [businessResult]);

  useEffect(() => () => {
    businessResult.setHighlight(null);
    document.body.style.cursor = "default";
  }, [businessResult]);

  const hoveredBusiness = hoveredBusinessIndex === null ? null : groups.business[hoveredBusinessIndex] ?? null;
  useEffect(() => {
    sceneMetrics.loadedFeatureCount = features.length;
    sceneMetrics.buildingCount = groups.building.length;
    sceneMetrics.roadCount = groups.road.length;
    sceneMetrics.waterCount = groups.water.length;
    sceneMetrics.landuseCount = groups.landuse.length;
    sceneMetrics.poiCount = groups.poi.length + groups.business.length;
    sceneMetrics.businessCount = groups.business.length;
    sceneMetrics.drawCalls = [
      ...roadResult.strata.map((stratum) => stratum.geometry),
      ...waterResult.strata.map((stratum) => stratum.geometry),
      buildingResult.geometry,
      landuseResult.geometry,
      boundaryResult.geometry,
    ].filter(hasPosition).length + (poiResult.mesh.count > 0 ? 1 : 0) + (businessResult.mesh.count > 0 ? 1 : 0);
    publishSceneDiagnostics(true);
  }, [features, groups, buildingResult, roadResult, waterResult, landuseResult, poiResult, businessResult, boundaryResult]);

  useEffect(() => () => {
    buildingResult.geometry.dispose();
    roadResult.geometry.dispose();
    for (const stratum of roadResult.strata) stratum.geometry.dispose();
    waterResult.geometry.dispose();
    for (const stratum of waterResult.strata) stratum.geometry.dispose();
    landuseResult.geometry.dispose();
    boundaryResult.geometry.dispose();
    disposeMaterial(poiResult.mesh.material);
    disposeMaterial(businessResult.mesh.material);
  }, [buildingResult, roadResult, waterResult, landuseResult, poiResult, businessResult, boundaryResult]);

  return (
    <>
      <color attach="background" args={[getPaperColor()]} />
      <group>
        {hasPosition(landuseResult.geometry) ? <mesh geometry={landuseResult.geometry} material={landuseMat} renderOrder={0} /> : null}
        {waterResult.strata.map((stratum) => hasPosition(stratum.geometry) ? <mesh key={stratum.stratum} geometry={stratum.geometry} material={waterMat} renderOrder={stratum.stratum === "surface" ? 1 : 2} /> : null)}
        {roadResult.strata.map((stratum) => hasPosition(stratum.geometry) ? <mesh key={stratum.stratum} geometry={stratum.geometry} material={roadMat} renderOrder={stratum.stratum === "tunnel" ? 3 : stratum.stratum === "normal" ? 4 : 5} /> : null)}
        {hasPosition(buildingResult.geometry) ? <mesh geometry={buildingResult.geometry} material={buildingMat} renderOrder={6} /> : null}
        {poiResult.mesh.count > 0 ? <primitive object={poiResult.mesh} renderOrder={7} /> : null}
        {businessResult.mesh.count > 0 ? <primitive object={businessResult.mesh} renderOrder={8} onPointerOver={handleBusinessPointerOver} onPointerMove={handleBusinessPointerOver} onPointerEnter={handleBusinessPointerOver} onPointerOut={handleBusinessPointerOut} /> : null}
        {hoveredBusiness ? <BusinessHoverPopup3D business={hoveredBusiness} /> : null}
        {hasPosition(boundaryResult.geometry) ? <lineSegments geometry={boundaryResult.geometry} material={boundaryLineMat} renderOrder={9} /> : null}
      </group>
    </>
  );
}
