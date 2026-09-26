"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import MapHud from "@/components/map/MapHud";
import FeatureInspector, { type FeatureDetailRecord } from "@/components/map/FeatureInspector";
import LayerControls, { DEFAULT_LAYERS as BASE_LAYERS, type LayerId, type LayerState } from "@/components/map/LayerControls";
import SourceAttribution from "@/components/map/SourceAttribution";
import LoadingState from "@/components/map/LoadingState";
import WebGPUUnsupported from "@/components/map/WebGPUUnsupported";
import { publishSceneDiagnostics, sceneMetrics } from "@/lib/scene/sceneMetrics";
import { normalizeSearchText } from "@/lib/data/search";
import { wgs84ToRender } from "@/lib/geo/crs";
import { DatasetManifestSchema, type DatasetManifest } from "@/lib/data/schema";
import { SearchHitSchema, SEARCH_MIN_QUERY_LENGTH, type SearchHit } from "@/lib/data/searchTypes";
import { loadTileMeta } from "@/lib/data/loadTile";
import type { SceneFeature } from "./CityScene";
import { loadRenderTile, nextRenderTileGeneration } from "@/lib/render/loadRenderTile";
import { evictTile, putDecodedTile, resetTileGpuCache, getResidentDecodedTile } from "@/lib/render/tileGpuCache";
import type { DecodedRenderTile } from "@/lib/render/codec";
import { resolvePickedFeatureByStableId, type PickedFeature } from "@/lib/scene/highlight";
import FeatureContextMenu, { attributeLabel, type FeatureContextMenuDetail } from "@/components/map/FeatureContextMenu";
import FeatureHighlightLayer from "@/components/map/FeatureHighlightLayer";

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


const EMPTY_SCENE_FEATURES: SceneFeature[] = [];

const TILE_LOAD_CONCURRENCY = 8;
const DATASET_BOUNDARY_TILE_ID = "boundary";
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
  if (viewport === null) {
    const lod = lodForSpan(Math.max(datasetBounds[2] - datasetBounds[0], datasetBounds[3] - datasetBounds[1]));
    return entries.filter((entry) => entry.lod === lod).map((entry) => entry.tileId).sort();
  }
  const view = enclosingBounds(viewport, datasetBounds);
  const span = Math.max(view[2] - view[0], view[3] - view[1]);
  const lod = lodForSpan(span);
  const candidates = entries.filter((entry) => entry.lod === lod);
  const tileSize = candidates[0]?.bounds[2] !== undefined ? candidates[0].bounds[2] - candidates[0].bounds[0] : span;
  const margin = tileSize;
  const expanded: [number, number, number, number] = [view[0] - margin, view[1] - margin, view[2] + margin, view[3] + margin];
  return candidates.filter((entry) => entry.bounds[0] <= expanded[2] && entry.bounds[2] >= expanded[0] && entry.bounds[1] <= expanded[3] && entry.bounds[3] >= expanded[1]).map((entry) => entry.tileId).sort();
}

type TileStateUpdate = (state: TileState) => TileState;


function mergeTileSlot(state: TileState, decoded: DecodedRenderTile): TileState {
  const slots = new Map(state.slots);
  slots.set(decoded.header.tileId, decoded);
  const renderTileIds = [...slots.keys()].sort();
  return { slots, renderTileIds, version: state.version + 1 };
}

function dropTileSlot(state: TileState, tileId: string): TileState {
  const slots = new Map(state.slots);
  slots.delete(tileId);
  return { slots, renderTileIds: state.renderTileIds.filter((id) => id !== tileId), version: state.version + 1 };
}

interface TileState {
  slots: Map<string, DecodedRenderTile>;
  renderTileIds: string[];
  version: number;
}

const EMPTY_TILE_STATE: TileState = { slots: new Map(), renderTileIds: [], version: 0 };






export default function MapShell() {
  const [theme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const stored = window.localStorage.getItem(LS_THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [selectedFeature, setSelectedFeature] = useState<PickedFeature | null>(null);
  const [cameraFocus, setCameraFocus] = useState<{ x: number; z: number; zoom: number } | null>(null);
  const [cameraReset, setCameraReset] = useState(0);
  const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYERS);
  const [manifest, setManifest] = useState<DatasetManifest | null>(null);
  const [tileState, setTileState] = useState<TileState>(EMPTY_TILE_STATE);
  const [datasetBoundaryReady, setDatasetBoundaryReady] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchPending, setSearchPending] = useState(false);
  const [desiredKey, setDesiredKey] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [webGpuStatus, setWebGpuStatus] = useState<"unknown" | "supported" | "unsupported">("unknown");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const tileStateRef = useRef<TileState>(EMPTY_TILE_STATE);
  const inFlightRef = useRef<Map<string, AbortController>>(new Map());
  const desiredIdsRef = useRef<string[]>([]);
  const desiredGenerationRef = useRef(0);
  const viewportRef = useRef<ViewportSnapshot | null>(null);
  const desiredKeyRef = useRef("");
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchGenerationRef = useRef(0);
  const showTileFailureRef = useRef(false);

  const applyTileState = useCallback((update: TileStateUpdate): void => {
    setTileState((previous) => {
      const next = update(previous);
      tileStateRef.current = next;
      return next;
    });
  }, []);

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
    nextRenderTileGeneration();
    for (const [tileId, controller] of inFlightRef.current) {
      if (desired.has(tileId)) continue;
      controller.abort();
      inFlightRef.current.delete(tileId);
    }
    for (const tileId of tileStateRef.current.slots.keys()) {
      if (desired.has(tileId)) continue;
      evictTile(tileId);
      tileRuntimeDiagnostics().aborted.push(tileId);
      applyTileState((previous) => dropTileSlot(previous, tileId));
    }
    const pending = desiredIdsRef.current.filter(
      (tileId) => !tileStateRef.current.slots.has(tileId) && !inFlightRef.current.has(tileId),
    );
    let cursor = 0;
    const loadOne = async (tileId: string): Promise<void> => {
      const controller = new AbortController();
      inFlightRef.current.set(tileId, controller);
      tileRuntimeDiagnostics().requested.push(tileId);
      const current = (): boolean => desiredGenerationRef.current === generation && desiredIdsRef.current.includes(tileId);
      try {
        const decoded = await loadRenderTile(tileId, controller.signal);
        if (!current()) return;
        putDecodedTile(decoded);
        tileRuntimeDiagnostics().loaded.push(tileId);
        applyTileState((previous) => mergeTileSlot(previous, decoded));
      } catch (cause) {
        if (isAbortError(cause) || !current()) return;
        showTileFailureRef.current = true;
        tileRuntimeDiagnostics().failed.push(tileId);
        console.warn(`Tile ${tileId} fetch failed`, cause);
      } finally {
        inFlightRef.current.delete(tileId);
      }
    };
    const loadWorker = async (): Promise<void> => {
      while (cursor < pending.length && desiredGenerationRef.current === generation) {
        const tileId = pending[cursor++]!;
        await loadOne(tileId);
      }
    };
    void Promise.all(Array.from({ length: Math.min(TILE_LOAD_CONCURRENCY, pending.length) }, () => loadWorker()));
  }, [manifest, desiredKey]);

  /* The department outline is a dataset-level artifact, not a per-tile
     fragment. It is decoded once through the worker pool and mounted as a
     single geometry, so no tile arrival can re-tessellate it. */
  useEffect(() => {
    if (!manifest) return;
    const controller = new AbortController();
    loadRenderTile(DATASET_BOUNDARY_TILE_ID, controller.signal).then((decoded) => {
      if (controller.signal.aborted) return;
      putDecodedTile(decoded);
      setDatasetBoundaryReady(true);
    }).catch(() => undefined);
    return () => controller.abort();
  }, [manifest]);

  useEffect(() => () => {
    for (const controller of inFlightRef.current.values()) controller.abort();
    inFlightRef.current.clear();
  }, []);

  useEffect(() => () => {
    resetTileGpuCache();
  }, []);

  useEffect(() => {
    sceneMetrics.loadedTileCount = tileState.slots.size;
    sceneMetrics.loadedFeatureCount = [...tileState.slots.values()].reduce((total, tile) => total + tile.meta.length, 0);
    if (error) {
      sceneMetrics.rendererStatus = "errored";
      sceneMetrics.rendererError = error;
    } else if (webGpuStatus === "unsupported") {
      sceneMetrics.rendererStatus = "unsupported";
      sceneMetrics.rendererError = "WebGPU unavailable in this browser";
    }
    publishSceneDiagnostics(true);
  }, [tileState, error, webGpuStatus]);

  const handleSearchResultSelect = useCallback(async (hit: SearchHit): Promise<void> => {
    let pick: PickedFeature | null = null;
    for (const slot of tileStateRef.current.slots.values()) {
      pick = resolvePickedFeatureByStableId(slot, hit.featureId);
      if (pick !== null) break;
    }
    if (pick === null) {
      tileRuntimeDiagnostics().requested.push(hit.tileId);
      try {
        const decoded = await loadRenderTile(hit.tileId);
        putDecodedTile(decoded);
        tileRuntimeDiagnostics().loaded.push(hit.tileId);
        setTileState((previous) => mergeTileSlot(previous, decoded));
        pick = resolvePickedFeatureByStableId(decoded, hit.featureId);
      } catch (cause) {
        tileRuntimeDiagnostics().failed.push(hit.tileId);
        console.warn(`Search tile ${hit.tileId} load failed`, cause);
      }
    }
    const [focusX, focusZ] = wgs84ToRender([hit.focusLon, hit.focusLat]);
    const fallbackFocus = { x: focusX, z: focusZ };
    const focus = pick === null ? fallbackFocus : { x: pick.anchor[0], z: pick.anchor[1] };
    setCameraFocus({ ...focus, zoom: 80 });
    if (pick !== null) setSelectedFeature(pick);
    setSearchQuery("");
    setSearchHits([]);
  }, []);

  const sceneTileIds = useMemo(() => {
    const ids = tileState.renderTileIds.slice();
    if (datasetBoundaryReady && !ids.includes(DATASET_BOUNDARY_TILE_ID)) ids.push(DATASET_BOUNDARY_TILE_ID);
    return ids;
  }, [tileState, datasetBoundaryReady]);

  const handleRenderPick = useCallback(async (tileId: string, stableId: string): Promise<void> => {
    const tile = getResidentDecodedTile(tileId);
    const pick = tile === undefined ? null : resolvePickedFeatureByStableId(tile, stableId);
    if (pick === null) return;
    setSelectedFeature(pick);
    setCameraFocus({ x: pick.anchor[0], z: pick.anchor[1], zoom: 80 });
  }, []);
  const [detailRecord, setDetailRecord] = useState<FeatureDetailRecord | null>(null);
  const [menuDetail, setMenuDetail] = useState<FeatureContextMenuDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ pick: PickedFeature; clientX: number; clientY: number } | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);

  const handleInspect = useCallback((pick: PickedFeature): void => {
    setSelectedFeature(pick);
    setDetailOpen(true);
  }, []);
  const handleCenter = useCallback((pick: PickedFeature): void => {
    setCameraFocus({ x: pick.anchor[0], z: pick.anchor[1], zoom: 80 });
  }, []);
  const handleContextMenu = useCallback((tileId: string, stableId: string, clientX: number, clientY: number): void => {
    const tile = getResidentDecodedTile(tileId);
    const pick = tile === undefined ? null : resolvePickedFeatureByStableId(tile, stableId);
    if (pick === null) return;
    setSelectedFeature(pick);
    setContextMenu({ pick, clientX, clientY });
  }, []);

  useEffect(() => {
    if (selectedFeature === null) {
      setDetailRecord(null);
      setMenuDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    loadTileMeta(selectedFeature.tileId, controller.signal)
      .then((tile) => {
        const record = tile.features.find((feature) => feature.stableId === selectedFeature.stableId);
        if (record === undefined) {
          setDetailError("Détail introuvable");
          return;
        }
        const attributes = Object.entries(record as unknown as Record<string, unknown>)
          .filter(([key, value]) => !["stableId", "geometry", "localGeometry", "sourceGeometry", "names", "provenance", "sourceRefs", "sourceMetadata", "displayName", "lon", "lat", "x", "z", "confidence", "status", "kind", "category", "address", "name"].includes(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
          .slice(0, 24)
          .map(([key, value]) => ({ label: attributeLabel(key), value: String(value) }));
        const businessName = "businessName" in record ? String((record as unknown as Record<string, unknown>).businessName) : undefined;
        const category = "category" in record ? String((record as unknown as Record<string, unknown>).category) : undefined;
        const sources = record.sourceRefs.map((reference) => ({ source: reference.source, timestamp: reference.timestamp, license: reference.license, url: reference.url }));
        setDetailRecord({
          kind: record.kind,
          name: record.name ?? businessName,
          address: record.address,
          category,
          status: record.status,
          confidence: record.confidence,
          lon: "lon" in record ? record.lon : undefined,
          lat: "lat" in record ? record.lat : undefined,
          attributes,
          sources,
        });
        setMenuDetail({ kind: record.kind, name: record.name ?? businessName, address: record.address, category, status: record.status, attributes: attributes.map((attribute) => ({ label: attribute.label, value: attribute.value })), roadClass: "roadClass" in record ? String((record as unknown as Record<string, unknown>).roadClass) : undefined, widthMetres: "width" in record && typeof (record as unknown as Record<string, unknown>).width === "number" ? Number((record as unknown as Record<string, unknown>).width) : undefined });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setDetailError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedFeature]);
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
    <div className="map-shell" data-theme={theme}>
      {loading ? <div className="map-shell__loading" style={{ position: "absolute", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center" }}><LoadingState /></div> : null}
      {hasCriticalError && !loading ? <div className="map-shell__error"><h2>Impossible de charger la carte</h2><p>{error}</p><code>npm run data:refresh</code></div> : null}
      <div className="map-shell__canvas">
        {!hasCriticalError && manifest && webGpuStatus === "supported" ? (
          <WebGPUCityCanvas bounds={manifestBounds(manifest)} cameraFocus={cameraFocus} cameraReset={cameraReset} onCameraMoved={handleCameraMoved} onViewportChange={handleViewportChange}>
            <CityScene features={EMPTY_SCENE_FEATURES} layers={layers} tileIds={sceneTileIds} onPick={handleRenderPick} onContextMenu={handleContextMenu} />
            <FeatureHighlightLayer pick={selectedFeature} />
          </WebGPUCityCanvas>
        ) : !hasCriticalError && webGpuStatus === "unsupported" ? <WebGPUUnsupported error={sceneMetrics.rendererError} /> : null}
      </div>
      {!hasCriticalError && !loading ? <MapHud query={searchQuery} onQueryChange={setSearchQuery} onSearch={(query) => void runSearch(query)} onResetView={resetView} results={searchResultsNode} /> : null}
      {!hasCriticalError && !loading ? <LayerControls layers={layers} onToggle={handleLayerToggle} onReset={resetView} /> : null}
      {!hasCriticalError && !loading ? <FeatureInspector pick={selectedFeature} detail={detailRecord} detailLoading={detailLoading} detailError={detailError} detailOpen={detailOpen} onToggleDetail={setDetailOpen} onClose={() => setSelectedFeature(null)} onCenter={handleCenter} /> : null}
      {!hasCriticalError && !loading && contextMenu ? <FeatureContextMenu pick={contextMenu.pick} clientX={contextMenu.clientX} clientY={contextMenu.clientY} detail={menuDetail} onInspect={handleInspect} onCenter={handleCenter} onDismiss={() => setContextMenu(null)} /> : null}
      {!hasCriticalError && !loading && attributionData ? <SourceAttribution data={attributionData} /> : null}
      <div id="scene-diagnostics" aria-hidden="true" style={{ position: "absolute", bottom: "2rem", left: "0.5rem", fontSize: "10px", fontFamily: "monospace", color: "color-mix(in srgb, var(--color-ink, #000) 40%, transparent)", whiteSpace: "pre", pointerEvents: "none", userSelect: "none", opacity: 0.6 }} />
      {selectedFeature && !hasCriticalError && !loading ? <button type="button" className="map-shell__inspector-toggle" onClick={() => setMobileInspectorOpen((open) => !open)} aria-label={mobileInspectorOpen ? "Fermer les détails" : "Ouvrir les détails"}>{mobileInspectorOpen ? "Fermer" : "Détails"}</button> : null}
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}
