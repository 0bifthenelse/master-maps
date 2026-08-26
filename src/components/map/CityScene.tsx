// @ts-nocheck
"use client";

import { useRef, useMemo } from "react";
import type { ReactNode } from "react";
import { useFrame } from "@react-three/fiber";

import {
  roadMat,
  waterMat,
  buildingMat,
  landuseMat,
  poiMat,
} from "@/lib/scene/materials";
import { sceneMetrics } from "@/lib/scene/sceneMetrics";
import { buildBuildings } from "@/lib/scene/buildBuildings";
import { buildRoads } from "@/lib/scene/buildRoads";
import buildWater from "@/lib/scene/buildWater";
import { buildLanduse } from "@/lib/scene/buildLanduse";
import buildPois from "@/lib/scene/buildPois";
import type { MapFeature } from "@/lib/data/schema";

export interface CitySceneProps {
  features: MapFeature[];
  selectedFeatureId?: string | null;
  children?: ReactNode;
}

function separateByKind(features: MapFeature[]) {
  const building = features.filter((f): f is MapFeature => f.kind === "building");
  const road = features.filter((f): f is MapFeature => f.kind === "road");
  const water = features.filter((f): f is MapFeature => f.kind === "water");
  const landuse = features.filter((f): f is MapFeature => f.kind === "landuse");
  const poi = features.filter((f): f is MapFeature => f.kind === "poi" || f.kind === "business");
  return { building, road, water, landuse, poi };
}

export default function CityScene({
  features,
  selectedFeatureId,
  children,
}: CitySceneProps) {
  const groupRef = useRef<THREE.Group>(null);

  const separated = useMemo(() => separateByKind(features), [features]);
  const buildingResult = useMemo(() => separated.building.length > 0 ? buildBuildings(separated.building) : null, [separated.building]);
  const roadResult = useMemo(() => separated.road.length > 0 ? buildRoads(separated.road) : null, [separated.road]);
  const waterResult = useMemo(() => separated.water.length > 0 ? buildWater(separated.water) : null, [separated.water]);
  const landuseResult = useMemo(() => separated.landuse.length > 0 ? buildLanduse(separated.landuse) : null, [separated.landuse]);
  const poiResult = useMemo(() => separated.poi.length > 0 ? buildPois(separated.poi) : null, [separated.poi]);

  useFrame(() => {
    sceneMetrics.loadedFeatureCount = features.length;
    sceneMetrics.buildingCount = separated.building.length;
    sceneMetrics.roadCount = separated.road.length;
    sceneMetrics.poiCount = separated.poi.length;
    sceneMetrics.drawCalls = 5;
  });

  return (
    <group ref={groupRef}>
      {landuseResult && landuseResult.geometry && (
        <mesh geometry={landuseResult.geometry} material={landuseMat} renderOrder={0} />
      )}
      {waterResult && waterResult.geometry && (
        <mesh geometry={waterResult.geometry} material={waterMat} renderOrder={1} />
      )}
      {roadResult && roadResult.geometry && (
        <mesh geometry={roadResult.geometry} material={roadMat} renderOrder={2} />
      )}
      {buildingResult && buildingResult.geometry && (
        <mesh geometry={buildingResult.geometry} material={buildingMat} renderOrder={3} />
      )}
      {poiResult && (
        <primitive object={poiResult.mesh} />
      )}
      {children}
    </group>
  );
}