"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import MapHud from "@/components/map/MapHud";
import FeatureInspector from "@/components/map/FeatureInspector";
import LayerControls, { DEFAULT_LAYERS as BASE_LAYERS, type LayerId, type LayerState } from "@/components/map/LayerControls";
import SourceAttribution from "@/components/map/SourceAttribution";
import LoadingState from "@/components/map/LoadingState";
import WebGPUUnsupported from "@/components/map/WebGPUUnsupported";
import { publishSceneDiagnostics, sceneMetrics } from "@/lib/scene/sceneMetrics";
import { normalizeSearchText } from "@/lib/data/search";
import { wgs84ToRender } from "@/lib/geo/crs";
import { computeLocalFocus, type LocalGeometry } from "@/lib/geo/focus";
import {
  DatasetManifestSchema,
  type DatasetManifest,
  type FeatureKind,
  type MapFeature,
  type TileData,
} from "@/lib/data/schema";
import { SearchHitSchema, SEARCH_MIN_QUERY_LENGTH, type SearchHit } from "@/lib/data/searchTypes";
import { loadTile } from "@/lib/data/loadTile";
import type { SceneFeature } from "./CityScene";

const WebGPUCityCanvas = dynamic(() => import("@/components/map/WebGPUCityCanvas"), { ssr: false, loading: () => null });
const CityScene = dynamic(() => import("@/components/map/CityScene"), { ssr: false, loading: () => null });

interface ViewportSnapshot {
  target: [number, number];
  zoom: number;
  width: number;
  height: number;
  headingRadians: number;
}
interface TileRuntimeDiagnostics {
  requested: string[];
  aborted: string[];
  failed: string[];
  loaded: string[];
}

declare global {
  interface Window {
    __masterMapsTileDiagnostics?: TileRuntimeDiagnostics;
  }
}

function tileRuntimeDiagnostics(): TileRuntimeDiagnostics {
  if (!window.__masterMapsTileDiagnostics) {
    window.__masterMapsTileDiagnostics = { requested: [], aborted: [], failed: [], loaded: [] };
  }
  return window.__masterMapsTileDiagnostics;
}

const RENDERABLE_KINDS: Record<FeatureKind, boolean> = {
  boundary: true,
  building: true,
  road: true,
  water: true,
  landuse: true,
  poi: true,
  business: true,
  address: false,
  transport: false,
};

const TILE_LOAD_CONCURRENCY = 8;
const DEFAULT_LAYERS: LayerState = { ...BASE_LAYERS, commercialAudit: false };
const LS_THEME_KEY = "map-theme";

function manifestBounds(manifest: DatasetManifest): [number, number, number, number] {
  if (manifest.bounds) return manifest.bounds;
  const tiles = manifest.tiles ?? [];
  if (tiles.length === 0) return [0, 0, 0, 0];
  return tiles.reduce<[number, number, number, number]>((bounds, tile) => [
    Math.min(bounds[0], tile.bounds[0]),
    Math.min(bounds[1], tile.bounds[1]),
    Math.max(bounds[2], tile.bounds[2]),
    Math.max(bounds[3], tile.bounds[3]),
  ], tiles[0]!.bounds);
}

function lodForSpan(span: number): 0 | 1 | 2 {
  if (span <= 12_000) return 0;
  if (span <= 60_000) return 1;
  return 2;
}

function enclosingBounds(viewport: ViewportSnapshot | null, bounds: [number, number, number, number]): [number, number, number, number] {
  const target = viewport?.target ?? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
  const zoom = Math.max(viewport?.zoom ?? 1, 1e-6);
  const halfWidth = (viewport?.width ?? bounds[2] - bounds[0]) / zoom / 2;
  const halfHeight = (viewport?.height ?? bounds[3] - bounds[1]) / zoom / 2;
  const heading = viewport?.headingRadians ?? 0;
  const cosine = Math.abs(Math.cos(heading));
  const sine = Math.abs(Math.sin(heading));
  const halfX = cosine * halfWidth + sine * halfHeight;
  const halfZ = sine * halfWidth + cosine * halfHeight;
  return [target[0] - halfX, target[1] - halfZ, target[0] + halfX, target[1] + halfZ];
}

function visibleTileIds(manifest: DatasetManifest, viewport: ViewportSnapshot | null): string[] {
  const entries = manifest.tiles ?? [];
  if (entries.length === 0) return [];
  const datasetBounds = manifestBounds(manifest);
  const view = enclosingBounds(viewport, datasetBounds);
  const span = Math.max(view[2] - view[0], view[3] - view[1]);
  const lod = viewport ? lodForSpan(span) : 2;
  const candidates = entries.filter((entry) => entry.lod === lod);
  const tileSize = candidates[0]?.bounds[2] !== undefined ? candidates[0].bounds[2] - candidates[0].bounds[0] : span;
  const margin = tileSize;
  const expanded: [number, number, number, number] = [view[0] - margin, view[1] - margin, view[2] + margin, view[3] + margin];
  return candidates.filter((entry) => entry.bounds[0] <= expanded[2] && entry.bounds[2] >= expanded[0] && entry.bounds[1] <= expanded[3] && entry.bounds[3] >= expanded[1]).map((entry) => entry.tileId).sort();
}

function countTileFeatures(tiles: Map<string, TileData>): number {
  let count = 0;
  for (const tile of tiles.values()) count += tile.features.length;
  return count;
}

function focusFromFeature(feature: MapFeature): { x: number; z: number } | null {
  if (feature.localGeometry) {
    const [x, z] = computeLocalFocus(feature.localGeometry as LocalGeometry);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  }
  if (feature.x !== undefined && feature.z !== undefined) return { x: feature.x, z: feature.z };
  return null;
}

function sceneFeature(feature: MapFeature): SceneFeature | null {
  if (!RENDERABLE_KINDS[feature.kind] || !feature.localGeometry) return null;
  const geometry = feature.localGeometry;
  if (feature.kind === "building" && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")) return { ...feature, geometry } as SceneFeature;
  if (feature.kind === "road" && (geometry.type === "LineString" || geometry.type === "MultiLineString")) return { ...feature, geometry } as SceneFeature;
  if (feature.kind === "water" && geometry.type !== "Point") return { ...feature, geometry } as SceneFeature;
  if (feature.kind === "landuse" && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")) return { ...feature, geometry } as SceneFeature;
  if ((feature.kind === "poi" || feature.kind === "business") && geometry.type === "Point") return { ...feature, geometry } as SceneFeature;
  if (feature.kind === "boundary" && (geometry.type === "Polygon" || geometry.type === "MultiPolygon")) return { ...feature, geometry } as SceneFeature;
  return null;
}

function sceneFeatureKey(feature: MapFeature): string {
  return feature.fragmentId ?? feature.stableId;
}

function deduplicateSceneFeatures(tiles: Map<string, TileData>): SceneFeature[] {
  const minimumLod = new Map<string, number>();
  for (const tile of tiles.values()) {
    for (const feature of tile.features) {
      const lod = tile.manifest.lod;
      const previous = minimumLod.get(feature.stableId);
      if (previous === undefined || lod < previous) minimumLod.set(feature.stableId, lod);
    }
  }
  const selected = new Map<string, SceneFeature>();
  for (const tile of tiles.values()) {
    for (const feature of tile.features) {
      if (tile.manifest.lod !== minimumLod.get(feature.stableId)) continue;
      const renderable = sceneFeature(feature);
      if (renderable) selected.set(sceneFeatureKey(feature), renderable);
    }
  }
  return [...selected.values()];
}

export default function MapShell() {
  const [theme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem(LS_THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [selectedFeature, setSelectedFeature] = useState<MapFeature | null>(null);
  const [cameraFocus, setCameraFocus] = useState<{ x: number; z: number; zoom: number } | null>(null);
  const [cameraReset, setCameraReset] = useState(0);
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [manifest, setManifest] = useState<DatasetManifest | null>(null);
  const [tiles, setTiles] = useState<Map<string, TileData>>(new Map());
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [desiredKey, setDesiredKey] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [webGpuStatus, setWebGpuStatus] = useState<"unknown" | "supported" | "unsupported">("unknown");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const tilesRef = useRef<Map<string, TileData>>(new Map());
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  const desiredIdsRef = useRef<string[]>([]);
  const desiredGenerationRef = useRef(0);
  const viewportRef = useRef<ViewportSnapshot | null>(null);
  const desiredKeyRef = useRef("");
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchGenerationRef = useRef(0);

  const syncDesiredTiles = useCallback((source: DatasetManifest, snapshot: ViewportSnapshot | null): void => {
    const ids = visibleTileIds(source, snapshot);
    desiredIdsRef.current = ids;
    const key = ids.join("|");
    if (key === desiredKeyRef.current) return;
    desiredKeyRef.current = key;
    setDesiredKey(key);
  }, []);

  const handleViewportChange = useCallback((snapshot: ViewportSnapshot): void => {
    viewportRef.current = snapshot;
    if (manifest) syncDesiredTiles(manifest, snapshot);
  }, [manifest, syncDesiredTiles]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(LS_THEME_KEY, theme);
    } catch {
      return;
    }
  }, [theme]);

  useEffect(() => {
    const controller = new AbortController();
    const loadMetadata = async (): Promise<void> => {
      try {
        setLoading(true);
        const manifestResponse = await fetch("/api/map/manifest", { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!manifestResponse.ok) throw new Error(`Manifest load failed: ${manifestResponse.status}`);
        const parsedManifest = DatasetManifestSchema.parse(await manifestResponse.json() as unknown);
        setManifest(parsedManifest);
        syncDesiredTiles(parsedManifest, viewportRef.current);
        setWebGpuStatus(typeof navigator !== "undefined" && navigator.gpu ? "supported" : "unsupported");
        setLoading(false);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      }
    };
    void loadMetadata();
    return () => controller.abort();
  }, [syncDesiredTiles]);

  const runSearch = useCallback(async (query: string): Promise<void> => {
    searchGenerationRef.current += 1;
    const generation = searchGenerationRef.current;
    searchAbortRef.current?.abort();
    searchAbortRef.current = null;
    const normalizedQuery = normalizeSearchText(query);
    if (normalizedQuery.length < SEARCH_MIN_QUERY_LENGTH) {
      setSearchHits([]);
      setSearchPending(false);
      return;
    }
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchPending(true);
    try {
      const response = await fetch(`/api/map/search?q=${encodeURIComponent(query)}&limit=10`, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Search request failed: ${response.status}`);
      const hits = SearchHitSchema.array().parse((await response.json()) as unknown);
      if (searchGenerationRef.current !== generation) return;
      setSearchHits(hits);
    } catch (cause) {
      if (searchGenerationRef.current !== generation || isAbortError(cause)) return;
      console.warn("Search request failed", cause);
    } finally {
      if (searchGenerationRef.current === generation) {
        setSearchPending(false);
        if (searchAbortRef.current === controller) searchAbortRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void runSearch(searchQuery), 150);
    return () => clearTimeout(timer);
  }, [runSearch, searchQuery]);

  useEffect(() => () => searchAbortRef.current?.abort(), []);

  useEffect(() => {
    if (!manifest) return;
    const desired = new Set(desiredIdsRef.current);
    const generation = desiredGenerationRef.current + 1;
    desiredGenerationRef.current = generation;
    for (const [tileId, controller] of inFlightRef.current) {
      if (!desired.has(tileId)) {
        controller.abort();
        inFlightRef.current.delete(tileId);
      }
    }
    const pending = desiredIdsRef.current.filter((tileId) => !tilesRef.current.has(tileId) && !inFlightRef.current.has(tileId));
    let cursor = 0;
    const loadWorker = async (): Promise<void> => {
      while (cursor < pending.length && desiredGenerationRef.current === generation) {
        const tileId = pending[cursor++]!;
        const controller = new AbortController();
        inFlightRef.current.set(tileId, controller);
        tileRuntimeDiagnostics().requested.push(tileId);
        controller.signal.addEventListener("abort", () => {
          tileRuntimeDiagnostics().aborted.push(tileId);
        }, { once: true });
        try {
          const tile = await loadTile(tileId, controller.signal);
          if (desiredGenerationRef.current === generation && desiredIdsRef.current.includes(tileId)) {
            setTiles((previous) => {
              const next = new Map(previous);
              next.set(tileId, tile);
              tileRuntimeDiagnostics().loaded.push(tileId);
              const replacementReady = desiredIdsRef.current.some((id) => next.has(id));
              if (replacementReady) for (const loadedId of next.keys()) if (!desired.has(loadedId)) next.delete(loadedId);
              tilesRef.current = next;
              return next;
            });
          }
        } catch (cause) {
          if (!isAbortError(cause)) {
            tileRuntimeDiagnostics().failed.push(tileId);
            console.warn(`Tile ${tileId} fetch failed`, cause);
          }
        } finally {
          inFlightRef.current.delete(tileId);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(TILE_LOAD_CONCURRENCY, pending.length) }, () => loadWorker()));
  }, [manifest, desiredKey]);

  useEffect(() => () => {
    for (const controller of inFlightRef.current.values()) controller.abort();
    inFlightRef.current.clear();
  }, []);

  useEffect(() => {
    sceneMetrics.loadedTileCount = tiles.size;
    sceneMetrics.loadedFeatureCount = countTileFeatures(tiles);
    if (error) {
      sceneMetrics.rendererStatus = "errored";
      sceneMetrics.rendererError = error;
    } else if (webGpuStatus === "unsupported") {
      sceneMetrics.rendererStatus = "unsupported";
      sceneMetrics.rendererError = "WebGPU unavailable in this browser";
    }
    publishSceneDiagnostics(true);
  }, [tiles, error, webGpuStatus]);

  const handleSearchResultSelect = useCallback(async (hit: SearchHit): Promise<void> => {
    let raw: MapFeature | undefined;
    for (const tile of tilesRef.current.values()) {
      raw = tile.features.find((feature) => feature.stableId === hit.featureId);
      if (raw) break;
    }
    if (!raw) {
      tileRuntimeDiagnostics().requested.push(hit.tileId);
      try {
        const tile = await loadTile(hit.tileId);
        tileRuntimeDiagnostics().loaded.push(hit.tileId);
        setTiles((previous) => {
          const next = new Map(previous).set(tile.manifest.tileId, tile);
          tilesRef.current = next;
          return next;
        });
        raw = tile.features.find((feature) => feature.stableId === hit.featureId);
      } catch (cause) {
        tileRuntimeDiagnostics().failed.push(hit.tileId);
        console.warn(`Search tile ${hit.tileId} load failed`, cause);
      }
    }
    const [focusX, focusZ] = wgs84ToRender([hit.focusLon, hit.focusLat]);
    const fallbackFocus = { x: focusX, z: focusZ };
    const focus = raw ? focusFromFeature(raw) : fallbackFocus;
    setCameraFocus({ ...(focus ?? fallbackFocus), zoom: 80 });
    if (raw) {
      setSelectedFeature(raw);
      if (raw.kind === "business" && /nocibe/i.test(raw.businessName)) setLayers((previous) => ({ ...previous, commercialAudit: true }));
    }
    setSearchQuery("");
    setSearchHits([]);
  }, []);

  const sceneFeatures = useMemo(() => deduplicateSceneFeatures(tiles), [tiles]);
  const hasCriticalError = error !== null && manifest === null;
  const attributionData = useMemo(() => manifest ? {
    datasetVersion: manifest.datasetVersion,
    acquisitionTime: manifest.acquisitionTime,
    sources: (manifest.sources ?? []).flatMap((source) => {
      const sourceName = typeof source.source === "string" ? source.source : undefined;
      return sourceName ? [{ source: sourceName, url: typeof source.url === "string" ? source.url : undefined, timestamp: typeof source.timestamp === "string" ? source.timestamp : manifest.acquisitionTime, license: typeof source.license === "string" ? source.license : undefined }] : [];
    }),
    osmAttribution: "OpenStreetMap contributors",
  } : null, [manifest]);

  const handleLayerToggle = useCallback((layer: LayerId, visible: boolean): void => {
    setLayers((previous) => ({ ...previous, [layer]: visible }));
  }, []);
  const resetView = useCallback((): void => {
    setCameraFocus(null);
    setCameraReset((counter) => counter + 1);
  }, []);
  const handleCameraMoved = useCallback((): void => setCameraFocus(null), []);
  const searchResultsNode: ReactNode = searchHits.length > 0 ? (
    <div role="listbox" aria-label="Résultats de recherche" aria-busy={searchPending}>
      {searchHits.map((hit, index) => (
        <button key={hit.featureId} type="button" role="option" data-testid={`search-result-${hit.featureId}`} data-feature-kind={hit.kind} aria-selected={index === 0} onClick={() => void handleSearchResultSelect(hit)}>
          <span>{hit.canonicalName}</span>
          <span>{hit.kind}</span>
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div className="map-shell" data-theme={theme} style={{ position: "fixed", inset: 0, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--color-paper, #ffffff)", color: "var(--color-ink, #000000)" }}>
      {loading ? <div className="map-shell__loading" style={{ position: "absolute", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}><LoadingState /></div> : null}
      {hasCriticalError && !loading ? <div className="map-shell__error"><h2>Impossible de charger la carte</h2><p>{error}</p><code>npm run data:refresh</code></div> : null}
      <div className="map-shell__canvas" style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {!hasCriticalError && manifest && webGpuStatus === "supported" ? (
          <WebGPUCityCanvas bounds={manifestBounds(manifest)} cameraFocus={cameraFocus} cameraReset={cameraReset} onCameraMoved={handleCameraMoved} onViewportChange={handleViewportChange}>
            <CityScene features={sceneFeatures} layers={layers} />
          </WebGPUCityCanvas>
        ) : !hasCriticalError && webGpuStatus === "unsupported" ? <WebGPUUnsupported error={sceneMetrics.rendererError} /> : null}
      </div>
      {!hasCriticalError && !loading ? <MapHud query={searchQuery} onQueryChange={setSearchQuery} onSearch={(query) => void runSearch(query)} onResetView={resetView} results={searchResultsNode} /> : null}
      {!hasCriticalError && !loading ? <LayerControls layers={layers} onToggle={handleLayerToggle} onReset={resetView} /> : null}
      {!hasCriticalError && !loading ? <FeatureInspector feature={selectedFeature} onClose={() => setSelectedFeature(null)} /> : null}
      {!hasCriticalError && !loading && attributionData ? <SourceAttribution data={attributionData} /> : null}
      <div id="scene-diagnostics" aria-hidden="true" style={{ position: "absolute", bottom: "2rem", left: "0.5rem", fontSize: "10px", fontFamily: "monospace", color: "color-mix(in srgb, var(--color-ink, #000) 40%, transparent)", whiteSpace: "pre", pointerEvents: "none", userSelect: "none", opacity: 0.6 }} />
      {selectedFeature && !hasCriticalError && !loading ? <button type="button" className="map-shell__inspector-toggle" onClick={() => setMobileInspectorOpen((open) => !open)} aria-label={mobileInspectorOpen ? "Fermer les détails" : "Ouvrir les détails"}>{mobileInspectorOpen ? "Fermer" : "Détails"}</button> : null}
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
