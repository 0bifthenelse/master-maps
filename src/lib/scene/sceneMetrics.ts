export type RendererStatus = "loading" | "initialized" | "unsupported" | "errored" | "lost";

export interface SceneMetrics {
  rendererStatus: RendererStatus;
  backend: string;
  loadedTileCount: number;
  loadedFeatureCount: number;
  buildingCount: number;
  roadCount: number;
  poiCount: number;
  waterCount: number;
  businessCount: number;
  landuseCount: number;
  drawCalls: number;
  /** Real camera target X, local metres — published from the mounted camera, not a requested focus. */
  cameraTargetX: number;
  /** Real camera target Z, local metres. */
  cameraTargetZ: number;
  /** Real orthographic camera zoom level. */
  cameraZoom: number;
  rendererError: string;
  cameraState: string;
}

export const sceneMetrics: SceneMetrics = {
  rendererStatus: "loading",
  backend: "unknown",
  loadedTileCount: 0,
  loadedFeatureCount: 0,
  buildingCount: 0,
  roadCount: 0,
  poiCount: 0,
  businessCount: 0,
  waterCount: 0,
  landuseCount: 0,
  drawCalls: 0,
  cameraTargetX: 0,
  cameraTargetZ: 0,
  cameraZoom: 0,
  cameraState: "unknown",
  rendererError: "none",
};

let lastPublishedAt = 0;

export function publishSceneDiagnostics(force = false): void {
  if (typeof document === "undefined") return;
  const element = document.getElementById("scene-diagnostics");
  if (!element) return;
  const now = typeof performance === "undefined" ? Date.now() : performance.now();
  if (!force && now - lastPublishedAt < 100) return;
  lastPublishedAt = now;
  const values: Record<string, string | number> = {
    "renderer-status": sceneMetrics.rendererStatus,
    backend: sceneMetrics.backend,
    "loaded-tile-count": sceneMetrics.loadedTileCount,
    "loaded-feature-count": sceneMetrics.loadedFeatureCount,
    "building-count": sceneMetrics.buildingCount,
    "road-count": sceneMetrics.roadCount,
    "water-count": sceneMetrics.waterCount,
    "landuse-count": sceneMetrics.landuseCount,
    "business-count": sceneMetrics.businessCount,
    "poi-count": sceneMetrics.poiCount,
    "draw-calls": sceneMetrics.drawCalls,
    "camera-target-x": sceneMetrics.cameraTargetX,
    "camera-target-z": sceneMetrics.cameraTargetZ,
    "camera-zoom": sceneMetrics.cameraZoom,
    "camera-state": sceneMetrics.cameraState,
    "renderer-error": sceneMetrics.rendererError,
  };
  for (const [key, value] of Object.entries(values)) {
    element.setAttribute(`data-${key}`, String(value));
  }
  element.textContent = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join(" │ ");
}
