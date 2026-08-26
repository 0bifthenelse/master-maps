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
  landuseCount: number;
  drawCalls: number;
  cameraState: string;
  rendererError: string;
}

export const sceneMetrics: SceneMetrics = {
  rendererStatus: "loading",
  backend: "unknown",
  loadedTileCount: 0,
  loadedFeatureCount: 0,
  buildingCount: 0,
  roadCount: 0,
  poiCount: 0,
  waterCount: 0,
  landuseCount: 0,
  drawCalls: 0,
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
    "poi-count": sceneMetrics.poiCount,
    "draw-calls": sceneMetrics.drawCalls,
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
