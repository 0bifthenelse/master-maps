"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Group } from "three";
import { DatasetManifestSchema, type DatasetManifest } from "@/lib/data/schema";
import { SearchHitSchema, SEARCH_MIN_QUERY_LENGTH, type SearchHit } from "@/lib/data/searchTypes";
import { loadTileMeta } from "@/lib/data/loadTile";
import { renderToWgs84, wgs84ToRender } from "@/lib/geo/crs";
import { categoryDefinition } from "@/lib/data/categories";
import type { DecodedRenderTile, FeatureMeta } from "@/lib/render/codec";
import { configureRenderTileDatasetVersion, loadRenderTile } from "@/lib/render/loadRenderTile";
import { putTile, trimTileStore } from "@/lib/render/tileStore";
import { MapTransform, metresPerPixelAt, type MapPoint } from "@/lib/map/transform";
import { MapController, acceptsMapKey } from "@/lib/map/controller";
import { pickAt, nearestAddress, type PickResult } from "@/lib/map/picking";
import { cursorStore, viewStore } from "@/lib/map/viewStore";
import type { BaseMap } from "@/lib/map/theme";
import { publishSceneDiagnostics, sceneMetrics } from "@/lib/scene/sceneMetrics";
import { OverlayRenderer, type OverlayState, type OverlayTarget } from "./overlay/OverlayRenderer";
import {
  MIN_CONCURRENCY,
  createTileIndex,
  isUsableViewport,
  nextConcurrency,
  planTiles,
  resolveLod,
  type SchedulerViewport,
  type TileIndex,
  type TilePlan,
} from "./tileScheduler";
import BootSequence, { type BootStep } from "./hud/BootSequence";
import SearchConsole, { type CategoryChip, type SearchResultView } from "./hud/SearchConsole";
import Dossier, { type DossierData } from "./hud/Dossier";
import NavCluster from "./hud/NavCluster";
import LayerDock, { DEFAULT_LAYERS, type MapLayers } from "./hud/LayerDock";
import Telemetry from "./hud/Telemetry";
import ContextMenu, { type ContextMenuItem } from "./hud/ContextMenu";
import ShortcutHelp from "./hud/ShortcutHelp";
import { buildDossier, categoryLabel, classify } from "./describe";

const MapCanvas = dynamic(() => import("./MapCanvas"), { ssr: false, loading: () => null });

const BOUNDARY_TILE_ID = "boundary";
const HALO_METRES = 600;
const PLAN_THROTTLE_MS = 140;
const SEARCH_DEBOUNCE_MS = 140;
const HASH_DEBOUNCE_MS = 350;
const FOOTPRINT_MAX_SCREENS = 2.2;

const CHIPS: readonly CategoryChip[] = [
  { id: "restaurant", label: "Restaurants" },
  { id: "bakery", label: "Bakeries" },
  { id: "supermarket", label: "Groceries" },
  { id: "pharmacy", label: "Pharmacies" },
  { id: "fuel", label: "Fuel" },
  { id: "hotel", label: "Hotels" },
  { id: "doctor", label: "Doctors" },
  { id: "bank", label: "Banks & ATMs" },
  { id: "attraction", label: "Things to do" },
  { id: "parking", label: "Parking" },
];

interface Selection {
  tileId: string;
  meta: FeatureMeta;
  bbox?: [number, number, number, number];
}

interface MenuState {
  x: number;
  y: number;
  point: MapPoint;
  pick: PickResult | null;
}

interface Toast {
  id: number;
  text: string;
}

const FALLBACK_FONTS = { display: "sans-serif", mono: "monospace" };
const NO_HITS: SearchHit[] = [];

function readFonts(): { display: string; mono: string } {
  if (typeof document === "undefined") return FALLBACK_FONTS;
  const style = getComputedStyle(document.documentElement);
  const display = style.getPropertyValue("--font-display").trim() || "Rajdhani";
  const mono = style.getPropertyValue("--font-mono").trim() || "monospace";
  return { display: `${display}, "Arial Narrow", sans-serif`, mono: `${mono}, monospace` };
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function parseHash(hash: string): { zoom: number; center: MapPoint; bearing: number; pitch: number } | null {
  const match = /map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)(?:\/(-?[\d.]+))?(?:\/([\d.]+))?/.exec(hash);
  if (match === null) return null;
  const zoom = Number(match[1]);
  const lat = Number(match[2]);
  const lon = Number(match[3]);
  if (![zoom, lat, lon].every(Number.isFinite)) return null;
  return {
    zoom,
    center: wgs84ToRender([lon, lat]),
    bearing: ((Number(match[4] ?? 0) || 0) * Math.PI) / 180,
    pitch: ((Number(match[5] ?? 0) || 0) * Math.PI) / 180,
  };
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && (error as { name: string }).name === "AbortError";
}

function hitTarget(hit: SearchHit): OverlayTarget {
  const anchor: MapPoint = hit.x !== undefined && hit.z !== undefined ? [hit.x, hit.z] : wgs84ToRender([hit.focusLon, hit.focusLat]);
  return { stableId: hit.featureId, kind: hit.kind, anchor, name: hit.canonicalName, category: hit.category };
}

function zoomForKind(kind: string, category: string | undefined): number {
  switch (kind) {
    case "address": return 18.6;
    case "business":
    case "poi": return 18;
    case "building": return 18.2;
    case "road": return 16.5;
    case "place": return category === "commune" ? 13.5 : 15.5;
    case "water": return 14.5;
    default: return 16;
  }
}

export default function MapShell() {
  /* ---------------------------------------------------------------- */
  /*  Engine objects                                                    */
  /* ---------------------------------------------------------------- */
  const transform = useMemo(() => new MapTransform(), []);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<OverlayRenderer | null>(null);
  const controllerRef = useRef<MapController | null>(null);
  const invalidateRef = useRef<() => void>(() => undefined);
  const buildingsRef = useRef<Group | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  /* ---------------------------------------------------------------- */
  /*  State                                                             */
  /* ---------------------------------------------------------------- */
  const [manifest, setManifest] = useState<DatasetManifest | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [boot, setBoot] = useState<BootStep[]>([
    { label: "LINKING DATA FEED", status: "wait" },
    { label: "LOADING TERRITORY MANIFEST", status: "wait" },
    { label: "CALIBRATING OPTICS", status: "wait" },
    { label: "RESOLVING FIRST TILES", status: "wait" },
  ]);
  const [tiles, setTiles] = useState<Map<string, DecodedRenderTile>>(new Map());
  const [boundaryTile, setBoundaryTile] = useState<DecodedRenderTile | null>(null);
  const [revision, setRevision] = useState(0);
  const [layers, setLayers] = useState<MapLayers>(DEFAULT_LAYERS);
  const [basemap, setBasemap] = useState<BaseMap>("machine");
  const [selection, setSelection] = useState<Selection | null>(null);
  /* The loaded canonical record, tagged with the selection it belongs to. */
  const [recordState, setRecordState] = useState<{ key: string; record: Record<string, unknown> | null } | null>(null);
  const [hover, setHover] = useState<OverlayTarget | null>(null);
  const [query, setQuery] = useState("");
  /* Text results are tagged with the query they answer; chip results stand alone. */
  const [textResult, setTextResult] = useState<{ query: string; hits: SearchHit[] }>({ query: "", hits: [] });
  const [chipHits, setChipHits] = useState<SearchHit[]>([]);
  const [chipPending, setChipPending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [chip, setChip] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<OverlayTarget[]>([]);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [locating, setLocating] = useState(false);
  const [youAreHere, setYouAreHere] = useState<OverlayTarget | null>(null);
  const [now, setNow] = useState(() => new Date());

  const tilesRef = useRef(tiles);
  useEffect(() => {
    tilesRef.current = tiles;
  }, [tiles]);
  const tileIndexRef = useRef<TileIndex>(createTileIndex([]));
  const boundsRef = useRef<[number, number, number, number] | null>(null);
  const [bounds, setBounds] = useState<[number, number, number, number] | null>(null);
  /* Map gesture handlers are defined further down; the controller calls them through this ref. */
  const handlersRef = useRef<{ click: (x: number, y: number) => void; contextMenu: (x: number, y: number, event: MouseEvent) => void; hover: (x: number, y: number) => void }>({
    click: () => undefined,
    contextMenu: () => undefined,
    hover: () => undefined,
  });
  const planRef = useRef<TilePlan | null>(null);
  const planKeyRef = useRef("");
  const lodRef = useRef(2);
  const inFlightRef = useRef(new Map<string, AbortController>());
  const concurrencyRef = useRef(MIN_CONCURRENCY);
  const pinnedRef = useRef(new Set<string>());
  const [planVersion, setPlanVersion] = useState(0);

  const toastText = useCallback((text: string) => setToast({ id: Date.now(), text }), []);
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const markBoot = useCallback((index: number, status: BootStep["status"], detail?: string) => {
    setBoot((steps) => steps.map((step, position) => (position === index ? { ...step, status, detail: detail ?? step.detail } : step)));
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Overlay                                                           */
  /* ---------------------------------------------------------------- */
  const mountedTiles = useMemo(() => {
    const list = [...tiles.values()];
    if (boundaryTile !== null) list.unshift(boundaryTile);
    return list;
  }, [tiles, boundaryTile]);

  const fontsRef = useRef(FALLBACK_FONTS);
  const overlayStateRef = useRef<OverlayState>({
    tiles: [],
    layers: { labels: true, places: true, pois: true, businesses: true, addresses: true, roads: true },
    selection: null,
    hover: null,
    highlights: [],
    basemap: "machine",
    fonts: FALLBACK_FONTS,
  });

  const selectionTarget = useMemo<OverlayTarget | null>(() => {
    if (selection === null) return null;
    return { stableId: selection.meta.s, kind: selection.meta.k, anchor: selection.meta.a, name: selection.meta.n ?? (selection.meta.k === "address" ? selection.meta.n : categoryLabel(selection.meta)), category: selection.meta.c, bbox: selection.bbox, height: selection.meta.k === "building" ? selection.meta.h : undefined };
  }, [selection]);

  const drawOverlay = useCallback(() => {
    const overlay = overlayRef.current;
    if (overlay === null) return;
    overlay.draw(transform, overlayStateRef.current, performance.now());
  }, [transform]);

  useEffect(() => {
    overlayStateRef.current = {
      tiles: mountedTiles,
      layers: { labels: layers.labels, places: layers.labels, pois: layers.pois, businesses: layers.businesses, addresses: layers.addresses && layers.labels, roads: layers.labels },
      selection: selectionTarget,
      hover,
      highlights: youAreHere === null ? highlights : [...highlights, youAreHere],
      basemap,
      fonts: fontsRef.current,
    };
    overlayRef.current?.retainTiles(new Set(mountedTiles.map((tile) => tile.header.tileId)));
    drawOverlay();
  }, [mountedTiles, layers, selectionTarget, hover, highlights, youAreHere, basemap, drawOverlay]);

  /* Keep the selection brackets breathing without re-rendering the map. */
  useEffect(() => {
    if (selectionTarget === null && youAreHere === null) return;
    if (prefersReducedMotion()) return;
    let frame = 0;
    let last = 0;
    const loop = (time: number): void => {
      frame = requestAnimationFrame(loop);
      if (time - last < 33) return;
      last = time;
      drawOverlay();
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [selectionTarget, youAreHere, drawOverlay]);

  /* Fonts arrive after first paint; re-measure labels when they do. */
  useEffect(() => {
    const refresh = (): void => {
      fontsRef.current = readFonts();
      overlayStateRef.current = { ...overlayStateRef.current, fonts: fontsRef.current };
      drawOverlay();
    };
    refresh();
    void document.fonts?.ready.then(refresh);
  }, [drawOverlay]);

  /* ---------------------------------------------------------------- */
  /*  Tile planning                                                     */
  /* ---------------------------------------------------------------- */
  const syncPlan = useCallback(() => {
    const bounds = boundsRef.current;
    if (bounds === null) return;
    const centre = transform.center;
    const limit = transform.metresPerPixel * Math.max(transform.width, transform.height) * FOOTPRINT_MAX_SCREENS;
    const quad = transform.groundFootprint(24).map(([e, n]): [number, number] => {
      const dx = e - centre[0];
      const dz = n - centre[1];
      const distance = Math.hypot(dx, dz);
      const scale = distance > limit ? limit / distance : 1;
      return [centre[0] + dx * scale, centre[1] + dz * scale];
    });
    const viewport: SchedulerViewport = { target: centre, quad, metresPerPixel: transform.metresPerPixel };
    if (!isUsableViewport(viewport)) return;
    lodRef.current = resolveLod(transform.metresPerPixel, lodRef.current);
    const plan = planTiles({ viewport, currentLod: lodRef.current, resident: new Set(tilesRef.current.keys()), index: tileIndexRef.current, bounds, halo: HALO_METRES });
    planRef.current = plan;
    const key = `${plan.lod}|${plan.required.join(",")}|${plan.prefetch.join(",")}`;
    if (key !== planKeyRef.current) {
      planKeyRef.current = key;
      setPlanVersion((value) => value + 1);
    }
  }, [transform]);

  const planTimer = useRef<number | null>(null);
  const lastPlan = useRef(0);
  const schedulePlan = useCallback(() => {
    const elapsed = performance.now() - lastPlan.current;
    if (elapsed >= PLAN_THROTTLE_MS) {
      lastPlan.current = performance.now();
      syncPlan();
      return;
    }
    if (planTimer.current !== null) return;
    planTimer.current = window.setTimeout(() => {
      planTimer.current = null;
      lastPlan.current = performance.now();
      syncPlan();
    }, PLAN_THROTTLE_MS - elapsed);
  }, [syncPlan]);

  /* Load what the plan requires, abort what it no longer wants. */
  useEffect(() => {
    const plan = planRef.current;
    if (plan === null || manifest === null) return;
    const wanted = new Set([...plan.required, ...plan.prefetch]);
    for (const [tileId, controller] of inFlightRef.current) {
      if (wanted.has(tileId)) continue;
      controller.abort();
      inFlightRef.current.delete(tileId);
    }
    const pending = [...plan.required, ...plan.prefetch].filter((tileId) => !tilesRef.current.has(tileId) && !inFlightRef.current.has(tileId));
    const evict = (): void => {
      const current = planRef.current;
      if (current === null) return;
      if (!current.required.every((tileId) => tilesRef.current.has(tileId))) return;
      const keep = new Set([...current.required, ...current.retain, ...current.prefetch, ...pinnedRef.current]);
      setTiles((previous) => {
        let changed = false;
        const next = new Map<string, DecodedRenderTile>();
        for (const [tileId, tile] of previous) {
          if (keep.has(tileId)) next.set(tileId, tile);
          else changed = true;
        }
        return changed ? next : previous;
      });
      trimTileStore(keep);
    };
    if (pending.length === 0) {
      evict();
      return;
    }
    let cursor = 0;
    const loadOne = async (tileId: string): Promise<void> => {
      const controller = new AbortController();
      inFlightRef.current.set(tileId, controller);
      const started = performance.now();
      try {
        const decoded = await loadRenderTile(tileId, controller.signal);
        concurrencyRef.current = nextConcurrency(concurrencyRef.current, performance.now() - started).concurrency;
        if (controller.signal.aborted) return;
        putTile(decoded);
        setTiles((previous) => {
          if (previous.get(tileId) === decoded) return previous;
          const next = new Map(previous);
          next.set(tileId, decoded);
          return next;
        });
      } catch (error) {
        if (!isAbortError(error)) console.warn(`Tile ${tileId} failed`, error);
      } finally {
        if (inFlightRef.current.get(tileId) === controller) inFlightRef.current.delete(tileId);
      }
    };
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) await loadOne(pending[cursor++]!);
    };
    void Promise.all(Array.from({ length: Math.min(concurrencyRef.current, pending.length) }, () => worker())).then(() => {
      evict();
      syncPlan();
    });
  }, [planVersion, manifest, syncPlan]);

  /* ---------------------------------------------------------------- */
  /*  View publication                                                  */
  /* ---------------------------------------------------------------- */
  const hashTimer = useRef<number | null>(null);
  const revisionFrame = useRef<number | null>(null);
  const publishView = useCallback(() => {
    viewStore.set({ center: transform.center, zoom: transform.zoom, bearing: transform.bearing, pitch: transform.pitch, metresPerPixel: transform.metresPerPixel, width: transform.width });
    const [north, east] = [transform.mapToScreen(transform.centerE, transform.centerN + 10), transform.mapToScreen(transform.centerE + 10, transform.centerN)];
    const centre = transform.mapToScreen(transform.centerE, transform.centerN);
    sceneMetrics.cameraTargetX = transform.centerE;
    sceneMetrics.cameraTargetZ = transform.centerN;
    sceneMetrics.cameraZoom = transform.zoom;
    sceneMetrics.northScreenUp = north[1] < centre[1] - 0.01 && Math.abs(transform.bearing) < Math.PI / 2;
    sceneMetrics.eastScreenRight = east[0] > centre[0] + 0.01 && Math.abs(transform.bearing) < Math.PI / 2;
    sceneMetrics.projectionYScale = transform.camera.projectionMatrix.elements[5] ?? 1;
    sceneMetrics.cameraState = JSON.stringify({ target: [transform.centerE, 0, transform.centerN], zoom: transform.zoom, metresPerPixel: transform.metresPerPixel, headingRadians: transform.bearing, pitchRadians: transform.pitch });
    publishSceneDiagnostics();
    if (hashTimer.current !== null) window.clearTimeout(hashTimer.current);
    hashTimer.current = window.setTimeout(() => {
      try {
        const [lon, lat] = renderToWgs84(transform.center);
        const hash = `#map=${transform.zoom.toFixed(2)}/${lat.toFixed(5)}/${lon.toFixed(5)}/${Math.round((transform.bearing * 180) / Math.PI)}/${Math.round((transform.pitch * 180) / Math.PI)}`;
        window.history.replaceState(null, "", hash);
      } catch {
        /* Out-of-range centre while animating: skip this hash. */
      }
    }, HASH_DEBOUNCE_MS);
    if (revisionFrame.current === null) {
      revisionFrame.current = window.setTimeout(() => {
        revisionFrame.current = null;
        setRevision((value) => value + 1);
      }, 120);
    }
  }, [transform]);

  /* Read-only probe for end-to-end tests: screen ↔ map conversion of the live view. */
  useEffect(() => {
    const probe = {
      screenToMap: (x: number, y: number): MapPoint => transform.screenToMap(x, y),
      mapToScreen: (e: number, n: number): [number, number] => transform.mapToScreen(e, n),
    };
    (window as unknown as { __masterMaps?: typeof probe }).__masterMaps = probe;
    return () => {
      delete (window as unknown as { __masterMaps?: typeof probe }).__masterMaps;
    };
  }, [transform]);

  const onViewChange = useCallback(() => {
    invalidateRef.current();
    publishView();
    schedulePlan();
  }, [publishView, schedulePlan]);

  /* ---------------------------------------------------------------- */
  /*  Manifest and boot                                                 */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        markBoot(0, "ok", "LOCAL NODE");
        const response = await fetch("/api/map/manifest", { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(response.status === 503 ? "The map dataset has not been generated yet." : `Manifest request failed (${response.status}).`);
        const parsed = DatasetManifestSchema.parse(await response.json() as unknown);
        configureRenderTileDatasetVersion(parsed.datasetVersion);
        tileIndexRef.current = createTileIndex(parsed.tiles ?? []);
        const bounds = parsed.bounds ?? [0, 0, 0, 0];
        boundsRef.current = bounds;
        setBounds(bounds);
        const margin = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]) * 0.15;
        transform.setConstraints({ minZoom: 7.5, maxZoom: 21.5, bounds: [bounds[0] - margin, bounds[1] - margin, bounds[2] + margin, bounds[3] + margin] });
        markBoot(1, "ok", `${(parsed.tileCount ?? 0).toLocaleString("en-GB")} TILES`);
        setManifest(parsed);
        const boundary = await loadRenderTile(BOUNDARY_TILE_ID, controller.signal).catch(() => null);
        if (boundary !== null) setBoundaryTile(boundary);
      } catch (error) {
        if (controller.signal.aborted) return;
        markBoot(1, "fail");
        setFatal(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    return () => controller.abort();
  }, [markBoot, transform]);

  /* Once the stage and the manifest exist: size the view, frame the Gers, attach controls. */
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = overlayCanvasRef.current;
    if (stage === null || canvas === null || manifest === null) return;
    const rect = stage.getBoundingClientRect();
    transform.resize(rect.width, rect.height);
    const overlay = new OverlayRenderer(canvas);
    overlay.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    overlayRef.current = overlay;
    const bounds = boundsRef.current!;
    const fromHash = parseHash(window.location.hash);
    if (fromHash !== null) {
      transform.set(fromHash);
    } else {
      const zoom = transform.zoomToFit(bounds, { top: 90, right: 40, bottom: 70, left: 40 });
      transform.set({ center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], zoom, bearing: 0, pitch: 0 });
    }
    markBoot(2, "ok", `Z${transform.zoom.toFixed(1)}`);
    const controller = new MapController(stage, transform, {
      onChange: () => onViewChange(),
      onClick: (x, y) => handlersRef.current.click(x, y),
      onContextMenu: (x, y, event) => handlersRef.current.contextMenu(x, y, event),
      onHover: (x, y) => handlersRef.current.hover(x, y),
      onHoverEnd: () => {
        cursorStore.set({ point: null });
        setHover(null);
      },
      reducedMotion: prefersReducedMotion,
      onInteractionStart: () => setMenu(null),
    });
    controller.attach();
    controllerRef.current = controller;
    const observer = new ResizeObserver(() => {
      const size = stage.getBoundingClientRect();
      if (size.width < 1 || size.height < 1) return;
      transform.resize(size.width, size.height);
      overlay.resize(size.width, size.height, window.devicePixelRatio || 1);
      onViewChange();
    });
    observer.observe(stage);
    onViewChange();
    return () => {
      observer.disconnect();
      controller.detach();
      controllerRef.current = null;
    };
  }, [manifest, transform, markBoot, onViewChange]);

  /* The last boot line reports the first tiles as they arrive. */
  const bootSteps = useMemo(() => boot.map((step, index) => (index === 3 && tiles.size > 0 ? { ...step, status: "ok" as const, detail: `${tiles.size} ONLINE` } : step)), [boot, tiles.size]);

  useEffect(() => {
    sceneMetrics.loadedTileCount = tiles.size;
    sceneMetrics.loadedFeatureCount = [...tiles.values()].reduce((total, tile) => total + tile.meta.length, 0);
    publishSceneDiagnostics(true);
  }, [tiles]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Picking, hover, context menu                                      */
  /* ---------------------------------------------------------------- */
  const pickScreen = useCallback((x: number, y: number): PickResult | null => {
    const marker = overlayRef.current?.hitTest(x, y);
    if (marker !== undefined && marker !== null) {
      for (const tile of [...tilesRef.current.values()]) {
        const meta = tile.meta.find((entry) => entry.s === marker.target.stableId);
        if (meta !== undefined) return { tileId: tile.header.tileId, meta, layerId: null };
      }
    }
    return pickAt(transform, x, y, [...tilesRef.current.values()], buildingsRef.current);
  }, [transform]);

  const select = useCallback((pick: PickResult | null) => {
    setMenu(null);
    if (pick === null) {
      setSelection(null);
      return;
    }
    setSelection({ tileId: pick.tileId, meta: pick.meta, bbox: pick.bbox });
  }, []);

  const onMapClick = useCallback((x: number, y: number) => {
    const pick = pickScreen(x, y);
    if (pick === null || pick.meta.k === "boundary") {
      setSelection(null);
      setSearchOpen(false);
      return;
    }
    select(pick);
  }, [pickScreen, select]);

  const onMapContextMenu = useCallback((x: number, y: number, event: MouseEvent) => {
    const point = transform.screenToMap(x, y);
    const pick = pickScreen(x, y);
    setMenu({ x: event.clientX, y: event.clientY, point, pick: pick !== null && pick.meta.k !== "boundary" ? pick : null });
  }, [pickScreen, transform]);

  const hoverKey = useRef<string | null>(null);
  const onMapHover = useCallback((x: number, y: number) => {
    cursorStore.set({ point: transform.screenToMap(x, y) });
    const marker = overlayRef.current?.hitTest(x, y) ?? null;
    const key = marker?.target.stableId ?? null;
    controllerRef.current?.setHoverCursor(marker !== null);
    if (key === hoverKey.current) return;
    hoverKey.current = key;
    setHover(marker === null ? null : marker.target);
  }, [transform]);

  useEffect(() => {
    handlersRef.current = { click: onMapClick, contextMenu: onMapContextMenu, hover: onMapHover };
  }, [onMapClick, onMapContextMenu, onMapHover]);

  /* Full canonical record for the dossier, from the tile's metadata sidecar. */
  const selectionKey = selection === null ? null : `${selection.tileId}|${selection.meta.s}`;
  useEffect(() => {
    if (selection === null || selectionKey === null) return;
    const controller = new AbortController();
    loadTileMeta(selection.tileId, controller.signal)
      .then((data) => {
        const found = data.features.find((feature) => feature.stableId === selection.meta.s || feature.fragmentId === selection.meta.s);
        setRecordState({ key: selectionKey, record: found === undefined ? null : (found as unknown as Record<string, unknown>) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRecordState({ key: selectionKey, record: null });
      });
    return () => controller.abort();
  }, [selection, selectionKey]);
  const record = recordState !== null && recordState.key === selectionKey ? recordState.record : null;
  const recordLoading = selectionKey !== null && recordState?.key !== selectionKey;

  const dossier = useMemo<DossierData | null>(() => (selection === null ? null : buildDossier(selection.meta, record, now)), [selection, record, now]);

  /* ---------------------------------------------------------------- */
  /*  Camera commands                                                   */
  /* ---------------------------------------------------------------- */
  const dossierPadding = useCallback(() => {
    const wide = transform.width > 720;
    return { top: 120, right: wide ? 430 : 40, bottom: wide ? 80 : Math.round(transform.height * 0.45), left: wide ? 60 : 40 };
  }, [transform]);

  const focusTarget = useCallback((anchor: MapPoint, kind: string, category: string | undefined, bbox?: [number, number, number, number]) => {
    const controller = controllerRef.current;
    if (controller === null) return;
    const padding = dossierPadding();
    if (bbox !== undefined && (bbox[2] - bbox[0] > 30 || bbox[3] - bbox[1] > 30)) {
      void controller.fitBounds(bbox, { padding, maxZoom: 18.5 });
      return;
    }
    const zoom = Math.max(transform.zoom, zoomForKind(kind, category));
    /* Offset so the point lands in the middle of the space left by the dossier. */
    const mpp = metresPerPixelAt(zoom);
    const dx = ((padding.right - padding.left) / 2) * mpp;
    const dy = ((padding.bottom - padding.top) / 2) * mpp;
    const cos = Math.cos(transform.bearing);
    const sin = Math.sin(transform.bearing);
    const centre: MapPoint = [anchor[0] + dx * cos - dy * sin, anchor[1] - dx * sin - dy * cos];
    void controller.flyTo({ center: centre, zoom });
  }, [dossierPadding, transform]);

  const overview = useCallback(() => {
    const bounds = boundsRef.current;
    if (bounds === null) return;
    void controllerRef.current?.fitBounds(bounds, { padding: { top: 90, right: 40, bottom: 70, left: 40 }, bearing: 0, pitch: 0 });
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Search                                                            */
  /* ---------------------------------------------------------------- */
  const searchGeneration = useRef(0);
  const runSearch = useCallback(async (params: URLSearchParams, generation: number): Promise<SearchHit[] | null> => {
    const centre = transform.center;
    params.set("near", `${Math.round(centre[0])},${Math.round(centre[1])}`);
    const response = await fetch(`/api/map/search?${params.toString()}`, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    const parsed = SearchHitSchema.array().parse(await response.json() as unknown);
    return generation === searchGeneration.current ? parsed : null;
  }, [transform]);

  const trimmedQuery = query.trim();
  const textActive = trimmedQuery.length >= SEARCH_MIN_QUERY_LENGTH;
  useEffect(() => {
    if (!textActive) return;
    const generation = ++searchGeneration.current;
    const timer = window.setTimeout(() => {
      runSearch(new URLSearchParams({ q: trimmedQuery, limit: "12" }), generation)
        .then((found) => {
          if (found === null) return;
          setTextResult({ query: trimmedQuery, hits: found });
          setActiveIndex(found.length > 0 ? 0 : -1);
        })
        .catch((error: unknown) => {
          console.warn(error);
          if (generation === searchGeneration.current) setTextResult({ query: trimmedQuery, hits: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [trimmedQuery, textActive, runSearch]);
  /* While typing, the previous answer stays on screen until the new one lands. */
  const hits = textActive ? textResult.hits : chip !== null ? chipHits : NO_HITS;
  const searchPending = textActive ? textResult.query !== trimmedQuery : chipPending;

  const onChip = useCallback((id: string | null) => {
    setChip(id);
    if (id === null) {
      setHighlights([]);
      setChipHits([]);
      return;
    }
    setQuery("");
    setSearchOpen(true);
    const generation = ++searchGeneration.current;
    setChipPending(true);
    const radius = Math.max(1500, transform.metresPerPixel * Math.max(transform.width, transform.height) * 0.7);
    runSearch(new URLSearchParams({ category: id, limit: "40", radius: String(Math.round(radius)) }), generation)
      .then((found) => {
        if (found === null) return;
        setChipHits(found);
        setActiveIndex(-1);
        setHighlights(found.map(hitTarget));
        if (found.length === 0) toastText(`No ${categoryDefinition(id).label.toLowerCase()} found nearby`);
      })
      .catch((error: unknown) => console.warn(error))
      .finally(() => {
        if (generation === searchGeneration.current) setChipPending(false);
      });
  }, [runSearch, transform, toastText]);

  const selectHit = useCallback(async (hit: SearchHit) => {
    setSearchOpen(false);
    searchInputRef.current?.blur();
    const target = hitTarget(hit);
    focusTarget(target.anchor, hit.kind, hit.category, hit.bbox);
    pinnedRef.current.add(hit.tileId);
    try {
      let tile = tilesRef.current.get(hit.tileId);
      if (tile === undefined) {
        tile = await loadRenderTile(hit.tileId);
        putTile(tile);
        const loaded = tile;
        setTiles((previous) => new Map(previous).set(hit.tileId, loaded));
      }
      const meta = tile.meta.find((entry) => entry.s === hit.featureId);
      if (meta !== undefined) setSelection({ tileId: hit.tileId, meta, bbox: hit.bbox });
      else setSelection({ tileId: hit.tileId, meta: { s: hit.featureId, k: hit.kind, c: hit.category ?? hit.kind, n: hit.canonicalName, a: target.anchor }, bbox: hit.bbox });
    } catch (error) {
      console.warn("Search target unavailable", error);
      setSelection({ tileId: hit.tileId, meta: { s: hit.featureId, k: hit.kind, c: hit.category ?? hit.kind, n: hit.canonicalName, a: target.anchor }, bbox: hit.bbox });
    } finally {
      window.setTimeout(() => pinnedRef.current.delete(hit.tileId), 30_000);
    }
  }, [focusTarget]);

  const submitSearch = useCallback(() => {
    if (!textActive) return;
    const submitted = trimmedQuery;
    const generation = ++searchGeneration.current;
    runSearch(new URLSearchParams({ q: submitted, limit: "12" }), generation)
      .then((found) => {
        if (found === null) return;
        setTextResult({ query: submitted, hits: found });
        setActiveIndex(found.length > 0 ? 0 : -1);
        if (found[0] !== undefined) void selectHit(found[0]);
        else toastText(`Nothing found for “${submitted}”`);
      })
      .catch((error: unknown) => {
        console.warn(error);
        if (generation === searchGeneration.current) setTextResult({ query: submitted, hits: [] });
      });
  }, [textActive, trimmedQuery, runSearch, selectHit, toastText]);

  const resultViews = useMemo<SearchResultView[]>(() => hits.map((hit) => {
    const { code, tone } = classify(hit.kind, hit.category);
    const label = categoryLabel({ k: hit.kind, c: hit.category ?? hit.kind });
    let context = hit.context ?? "";
    if (context === "") context = label;
    else if (hit.kind !== "address" && hit.kind !== "place" && !context.toLowerCase().includes(label.toLowerCase())) context = `${label} · ${context}`;
    return { id: hit.featureId, code, tone, name: hit.canonicalName, context, kind: hit.kind };
  }), [hits]);

  /* ---------------------------------------------------------------- */
  /*  Global keys                                                       */
  /* ---------------------------------------------------------------- */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!acceptsMapKey(event) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "/") {
        event.preventDefault();
        searchInputRef.current?.focus();
        setSearchOpen(true);
      } else if (event.key === "?") {
        event.preventDefault();
        setHelpOpen((open) => !open);
      } else if (event.key === "0") {
        event.preventDefault();
        overview();
      } else if (event.key === "Escape") {
        setMenu(null);
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overview]);

  /* ---------------------------------------------------------------- */
  /*  Actions                                                           */
  /* ---------------------------------------------------------------- */
  const copy = useCallback(async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toastText(message);
    } catch {
      toastText("Clipboard unavailable");
    }
  }, [toastText]);

  const coordinatesOf = useCallback((point: MapPoint): string => {
    const [lon, lat] = renderToWgs84(point);
    return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }, []);

  const onLocate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      toastText("Location is not available in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition((position) => {
      setLocating(false);
      const point = wgs84ToRender([position.coords.longitude, position.coords.latitude]);
      const bounds = boundsRef.current;
      if (bounds !== null && (point[0] < bounds[0] || point[0] > bounds[2] || point[1] < bounds[1] || point[1] > bounds[3])) {
        toastText("You are outside the Gers");
        return;
      }
      setYouAreHere({ stableId: "you-are-here", kind: "poi", anchor: point, name: "You are here", category: "other" });
      void controllerRef.current?.flyTo({ center: point, zoom: Math.max(transform.zoom, 16.5) });
    }, () => {
      setLocating(false);
      toastText("Location permission denied");
    }, { enableHighAccuracy: true, timeout: 10_000 });
  }, [toastText, transform]);

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (menu === null) return [];
    const point = menu.point;
    return [
      {
        id: "whats-here",
        label: menu.pick !== null ? "Open details" : "What's here?",
        icon: "info" as const,
        onSelect: (): void => {
          if (menu.pick !== null) {
            select(menu.pick);
            return;
          }
          const nearest = nearestAddress(point, [...tilesRef.current.values()], 120);
          if (nearest !== null) select(nearest);
          else toastText(`No address within 120 m · ${coordinatesOf(point)}`);
        },
      },
      { id: "center", label: "Center the map here", icon: "target" as const, onSelect: (): void => { void controllerRef.current?.easeTo({ center: point, duration: 450 }); } },
      { id: "zoom", label: "Zoom in here", icon: "plus" as const, onSelect: (): void => { void controllerRef.current?.easeTo({ center: point, zoom: transform.zoom + 2, duration: 500 }); } },
      { id: "copy", label: `Copy ${coordinatesOf(point)}`, icon: "copy" as const, onSelect: (): void => { void copy(coordinatesOf(point), "Coordinates copied"); } },
    ];
  }, [menu, select, toastText, coordinatesOf, copy, transform]);

  const visibility = useMemo(() => ({
    buildings: layers.buildings,
    roads: layers.roads,
    water: layers.water,
    landuse: layers.landuse,
    boundaries: layers.boundaries,
    transport: layers.transport,
  }), [layers]);

  const datasetDate = manifest?.acquisitionTime ? manifest.acquisitionTime.slice(0, 10) : null;
  const ready = manifest !== null && tiles.size > 0;

  return (
    <div className="mm-shell" data-basemap={basemap}>
      <div className="mm-stage" ref={stageRef} aria-label="Map of the Gers. Drag to pan, scroll to zoom, right-drag to rotate and tilt." role="application">
        {manifest !== null && bounds !== null ? (
          <MapCanvas
            transform={transform}
            revision={revision}
            tiles={mountedTiles}
            visibility={visibility}
            basemap={basemap}
            grid={layers.grid}
            bounds={bounds}
            buildingsRef={buildingsRef}
            onInvalidate={(invalidate) => { invalidateRef.current = invalidate; }}
            onFrame={drawOverlay}
            onError={setFatal}
          />
        ) : null}
        <canvas ref={overlayCanvasRef} className="mm-overlay" aria-hidden="true" />
      </div>
      <div className="mm-fx" aria-hidden="true" />

      {manifest !== null ? (
        <>
          <SearchConsole
            inputRef={searchInputRef}
            query={query}
            onQueryChange={(value) => {
              setQuery(value);
              setSearchOpen(true);
              if (value.trim() !== "" && chip !== null) {
                setChip(null);
                setHighlights([]);
              }
            }}
            results={resultViews}
            pending={searchPending}
            open={searchOpen}
            activeIndex={activeIndex}
            onActiveIndexChange={setActiveIndex}
            onSelect={(index) => {
              const hit = hits[index];
              if (hit !== undefined) void selectHit(hit);
            }}
            onSubmit={submitSearch}
            onClose={() => setSearchOpen(false)}
            onFocus={() => setSearchOpen(true)}
            chips={CHIPS}
            activeChip={chip}
            onChip={onChip}
            statusText={chip !== null ? `${categoryDefinition(chip).label} near view` : "Matches"}
          />
          {dossier !== null && selection !== null ? (
            <Dossier
              data={dossier}
              loading={recordLoading}
              onClose={() => setSelection(null)}
              onCenter={() => focusTarget(selection.meta.a, selection.meta.k, selection.meta.c, selection.bbox)}
              onCopyCoordinates={() => void copy(coordinatesOf(selection.meta.a), "Coordinates copied")}
              onShare={() => void copy(window.location.href, "Link to this view copied")}
            />
          ) : null}
          <NavCluster
            onZoomIn={() => void controllerRef.current?.zoomBy(1)}
            onZoomOut={() => void controllerRef.current?.zoomBy(-1)}
            onResetNorth={() => void controllerRef.current?.resetNorth()}
            onToggleTilt={() => void controllerRef.current?.easeTo({ pitch: transform.pitch > 0.02 ? 0 : (55 * Math.PI) / 180, zoom: transform.pitch > 0.02 ? transform.zoom : Math.max(transform.zoom, 16), duration: 650 })}
            onRotateTo={(bearing) => controllerRef.current?.jumpTo({ bearing })}
            onLocate={onLocate}
            onHelp={() => setHelpOpen(true)}
            locating={locating}
          />
          <LayerDock basemap={basemap} onBasemap={(value) => { setBasemap(value); invalidateRef.current(); }} layers={layers} onToggle={(key, value) => setLayers((previous) => ({ ...previous, [key]: value }))} />
          <Telemetry tiles={tiles.size} datasetDate={datasetDate} />
        </>
      ) : null}

      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={menu.pick?.meta.n ?? (menu.pick !== null ? categoryLabel(menu.pick.meta) : "Dropped pin")}
          subtitle={coordinatesOf(menu.point)}
          items={menuItems}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {helpOpen ? <ShortcutHelp onClose={() => setHelpOpen(false)} /> : null}
      {toast !== null ? <div key={toast.id} className="mm-toast mm-panel mm-brackets" role="status">{toast.text}</div> : null}

      {fatal !== null ? (
        <div className="mm-error" role="alert">
          <div className="mm-error__card mm-panel mm-brackets">
            <div className="mm-tag" style={{ color: "var(--mm-red)" }}>Feed interrupted</div>
            <h1 style={{ fontFamily: "var(--mm-font-display)", fontSize: 28, marginTop: 6 }}>The map cannot start</h1>
            <p style={{ marginTop: 8, color: "var(--mm-ink-2)" }}>{fatal}</p>
            <code>npm run data:refresh</code>
          </div>
        </div>
      ) : (
        <BootSequence steps={bootSteps} ready={ready} />
      )}
      <div id="scene-diagnostics" aria-hidden="true" />
    </div>
  );
}
