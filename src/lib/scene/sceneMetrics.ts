// @ts-nocheck
/**
 * @file Shared scene metrics interface for diagnostics.
 * Published by CityScene into #scene-diagnostics attributes.
 * Consumed by WebGPUCityCanvas for the diagnostics strip.
 */

export interface SceneMetrics {
  rendererStatus: "initialized" | "errored" | "unsupported" | "loading";
  backend: string;
  loadedTileCount: number;
  loadedFeatureCount: number;
  buildingCount: number;
  roadCount: number;
  poiCount: number;
  waterCount: number;
  landuseCount: number;
  drawCalls: number;
  cameraState: string;
  rendererError: string | null;
}

export const sceneMetrics: SceneMetrics = {
  drawCalls: 0,
  loadedTiles: 0,
  loadedFeatures: 0,
  buildingCount: 0,
  roadCount: 0,
  poiCount: 0,
  waterCount: 0,
  landuseCount: 0,
  rendererStatus: "",
  backend: "",
  rendererError: "",
};
