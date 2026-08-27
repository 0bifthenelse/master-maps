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
import buildBoundary from "@/lib/scene/buildBoundary";
import { buildBuildings } from "@/lib/scene/buildBuildings";
import { buildRoads } from "@/lib/scene/buildRoads";
import buildWater from "@/lib/scene/buildWater";
import { buildLanduse } from "@/lib/scene/buildLanduse";
import buildPois, {
  buildBusinessInstances,
  type BusinessInstancedResult,
} from "@/lib/scene/buildPois";
import BusinessHoverPopup3D from "./BusinessHoverPopup3D";

type Coordinate = [number, number];
type Geometry =
  | { type: "Point"; coordinates: Coordinate }
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] }
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
  widthInferred?: boolean;
  waterType?: string;
  landuseType?: string;
  category?: string;
  size?: number;
  color?: string;
  bridge?: boolean;
  tunnel?: boolean;
  businessName?: string;
  legalName?: string;
  brand?: string;
  nafLabel?: string;
  nafCode?: string;
  siret?: string;
  phone?: string;
  website?: string;
  openingHours?: string;
  operator?: string;
  wheelchair?: string;
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

function isPolygon(
  geometry: Geometry,
): geometry is Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

type BuildingScene = SceneFeature & {
  kind: "building";
  geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;
};
type RoadScene = SceneFeature & {
  kind: "road";
  geometry: Extract<Geometry, { type: "LineString" | "MultiLineString" }>;
};
type WaterScene = SceneFeature & {
  kind: "water";
  geometry: Extract<Geometry, { type: "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon" }>;
};
type LanduseScene = SceneFeature & {
  kind: "landuse";
  geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;
};
type PoiScene = SceneFeature & {
  kind: "poi";
  geometry: Extract<Geometry, { type: "Point" }>;
};
type BusinessScene = SceneFeature & {
  kind: "business";
  geometry: Extract<Geometry, { type: "Point" }>;
};

function isBuildingFeature(feature: SceneFeature): feature is BuildingScene {
  return feature.kind === "building" && isPolygon(feature.geometry);
}
function isRoadFeature(feature: SceneFeature): feature is RoadScene {
  return (
    feature.kind === "road"
    && (feature.geometry.type === "LineString" || feature.geometry.type === "MultiLineString")
  );
}
function isWaterFeature(feature: SceneFeature): feature is WaterScene {
  return feature.kind === "water";
}
function isLanduseFeature(feature: SceneFeature): feature is LanduseScene {
  return feature.kind === "landuse" && isPolygon(feature.geometry);
}
function isPoiFeature(feature: SceneFeature): feature is PoiScene {
  return feature.kind === "poi" && feature.geometry.type === "Point";
}
function isBusinessFeature(feature: SceneFeature): feature is BusinessScene {
  return feature.kind === "business" && feature.geometry.type === "Point";
}
function isBoundaryFeature(
  feature: SceneFeature,
): feature is SceneFeature & {
  kind: "boundary";
  geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;
} {
  return feature.kind === "boundary" && isPolygon(feature.geometry);
}

function disposeMaterial(material: Material | Material[]): void {
  if (Array.isArray(material)) {
    for (const entry of material) entry.dispose();
    return;
  }
  material.dispose();
}


export default function CityScene({
  features,
  layers,
}: CitySceneProps) {
  const [hoveredBusinessIndex, setHoveredBusinessIndex] = useState<number | null>(null);
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
    business: activeFeatures.filter(isBusinessFeature),
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
  const businessResult = useMemo<BusinessInstancedResult>(
    () => buildBusinessInstances(groups.business.map((feature) => ({ ...feature, kind: "business" as const }))),
    [groups.business],
  );
  const boundaryResult = useMemo(
    () => buildBoundary(groups.boundary.map((feature) => ({ ...feature, kind: "boundary" as const }))),
    [groups.boundary],
  );
  const handleBusinessPointerOver = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      if (typeof event.instanceId !== "number") return;
      const featureIndex = businessResult.featureIdByInstance[event.instanceId];
      if (featureIndex === undefined) return;
      businessResult.setHighlight(event.instanceId);
      setHoveredBusinessIndex(featureIndex);
      document.body.style.cursor = "pointer";
    },
    [businessResult],
  );

  const handleBusinessPointerOut = useCallback(
    (event: ThreeEvent<PointerEvent>) => {
      event.stopPropagation();
      businessResult.setHighlight(null);
      setHoveredBusinessIndex(null);
      document.body.style.cursor = "default";
    },
    [businessResult],
  );

  useEffect(() => {
    return () => {
      businessResult.setHighlight(null);
      document.body.style.cursor = "default";
    };
  }, [businessResult]);

  const hoveredBusiness =
    hoveredBusinessIndex === null ? null : groups.business[hoveredBusinessIndex] ?? null;


  useEffect(() => {
    sceneMetrics.loadedFeatureCount = features.length;
    sceneMetrics.buildingCount = groups.building.length;
    sceneMetrics.roadCount = groups.road.length;
    sceneMetrics.waterCount = groups.water.length;
    sceneMetrics.landuseCount = groups.landuse.length;
    sceneMetrics.poiCount = groups.poi.length + groups.business.length;
    sceneMetrics.businessCount = groups.business.length;
    const geometryCount = [
      buildingResult.geometry,
      roadResult.geometry,
      waterResult.geometry,
      landuseResult.geometry,
      boundaryResult.geometry,
    ].filter((geometry) => (geometry.getAttribute("position")?.count ?? 0) > 0).length;
    sceneMetrics.drawCalls =
      geometryCount
      + (poiResult.mesh.count > 0 ? 1 : 0)
      + (businessResult.mesh.count > 0 ? 1 : 0);
    publishSceneDiagnostics(true);
  }, [
    features,
    groups,
    buildingResult,
    roadResult,
    waterResult,
    landuseResult,
    poiResult,
    businessResult,
    boundaryResult,
  ]);
  useEffect(() => {
    return () => {
      buildingResult.geometry.dispose();
      roadResult.geometry.dispose();
      waterResult.geometry.dispose();
      landuseResult.geometry.dispose();
      boundaryResult.geometry.dispose();
      disposeMaterial(poiResult.mesh.material);
      disposeMaterial(businessResult.mesh.material);
    };
  }, [
    buildingResult,
    roadResult,
    waterResult,
    landuseResult,
    poiResult,
    businessResult,
    boundaryResult,
  ]);

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
        {poiResult.mesh.count > 0 ? <primitive object={poiResult.mesh} renderOrder={4} /> : null}
        {businessResult.mesh.count > 0 ? (
          <primitive
            object={businessResult.mesh}
            renderOrder={5}
            onPointerOver={handleBusinessPointerOver}
            onPointerMove={handleBusinessPointerOver}
            onPointerEnter={handleBusinessPointerOver}
            onPointerOut={handleBusinessPointerOut}
          />
        ) : null}
        {hoveredBusiness ? <BusinessHoverPopup3D business={hoveredBusiness} /> : null}
        {boundaryResult.geometry.getAttribute("position")?.count ? (
          <lineSegments geometry={boundaryResult.geometry} material={boundaryLineMat} renderOrder={6} />
        ) : null}
      </group>
    </>
  );
}
