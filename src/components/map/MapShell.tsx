// @ts-nocheck
 "use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import dynamic from "next/dynamic";

// ---------------------------------------------------------------------------
// Dynamic imports for heavy canvas components (WebGPU + Three.js)
// ---------------------------------------------------------------------------
const WebGPUCityCanvas = dynamic(
  () => import("@/components/map/WebGPUCityCanvas"),
  { ssr: false, loading: () => null },
);

const CityScene = dynamic(
  () => import("@/components/map/CityScene"),
  { ssr: false, loading: () => null },
);

// ---------------------------------------------------------------------------
// Direct imports for UI overlay components (lightweight, server-compatible)
// ---------------------------------------------------------------------------
import MapHud from "@/components/map/MapHud";
import FeatureInspector from "@/components/map/FeatureInspector";
import LayerControls from "@/components/map/LayerControls";
import SourceAttribution from "@/components/map/SourceAttribution";
import LoadingState from "@/components/map/LoadingState";
import WebGPUUnsupported from "@/components/map/WebGPUUnsupported";
import { publishSceneDiagnostics, sceneMetrics } from "@/lib/scene/sceneMetrics";
import { searchIndex as runSearchIndex, type SearchRecord as SearchIndexRecord } from "@/lib/data/search";

// ---------------------------------------------------------------------------
// Local type definitions — match the schema contracts expected from
// src/lib/data/schema.ts (will converge during typecheck phase).
// ---------------------------------------------------------------------------

/** Source metadata for a data record. */
interface SourceReference {
  source: string;
  url?: string;
  timestamp: string;
  license?: string;
  sha256?: string;
  recordCount?: number;
}

/** A resolved provenance record for a property. */
interface ProvenanceRecord {
  featureId: string;
  property: string;
  winner: string;
  contenders: string[];
  priority: number;
  timestamp: string;
}

/** Discriminated geographic feature. */
type FeatureKind =
  | "building"
  | "road"
  | "water"
  | "landuse"
  | "poi"
  | "business"
  | "address"
  | "transport"
  | "boundary";

interface MapFeatureGeometry {
  type: "Point" | "LineString" | "Polygon" | "MultiPolygon";
  coordinates: number[];
}

interface MapFeatureBase {
  id: string;
  kind: FeatureKind;
  name?: string;
  geometry?: MapFeatureGeometry;
  /** WGS84 [lng, lat] focus coordinate. */
  coord?: [number, number];
  /** Local projection [x, z] position. */
  localCoord?: [number, number];
  provenance?: ProvenanceRecord[];
  status: "active" | "uncertain" | "inferred" | "unresolved";
  sourceRefs?: SourceReference[];
  /** Additional typed metadata. */
  metadata?: Record<string, unknown>;
  /** Search key for accent-insensitive lookup. */
  searchKey?: string;
  /** Nocibé-specific BAN identifier. */
  banId?: string;
}

interface BuildingFeature extends MapFeatureBase {
  kind: "building";
  height?: number;
  levels?: number;
  heightSource?: "explicit" | "inferred-from-levels" | "inferred-category";
}

interface RoadFeature extends MapFeatureBase {
  kind: "road";
  width?: number;
  roadClass?:
    | "motorway"
    | "trunk"
    | "primary"
    | "secondary"
    | "tertiary"
    | "residential"
    | "service"
    | "pedestrian"
    | "footway"
    | "cycleway"
    | "path"
    | "track";
  bridge?: boolean;
  tunnel?: boolean;
}

interface WaterFeature extends MapFeatureBase {
  kind: "water";
  waterType?: "river" | "lake" | "pond" | "stream" | "ditch" | "reservoir";
}

interface LanduseFeature extends MapFeatureBase {
  kind: "landuse";
  landuseType?: string;
}

interface PoiFeature extends MapFeatureBase {
  kind: "poi";
  category?: string;
}

interface BusinessFeature extends MapFeatureBase {
  kind: "business";
  category?: string;
  phone?: string;
  website?: string;
}

interface AddressFeature extends MapFeatureBase {
  kind: "address";
  street?: string;
  housenumber?: string;
  postcode?: string;
}

interface TransportFeature extends MapFeatureBase {
  kind: "transport";
  transportType?: "bus" | "rail" | "tram" | "stop" | "station";
}

type MapFeature =
  | BuildingFeature
  | RoadFeature
  | WaterFeature
  | LanduseFeature
  | PoiFeature
  | BusinessFeature
  | AddressFeature
  | TransportFeature
  | MapFeatureBase;

interface TileManifestEntry {
  tileId: string;
  bounds: [number, number, number, number];
  featureCount: number;
  byteSize: number;
  features: string[];
}

interface ManifestData {
  datasetVersion: string;
  acquisitionTime: string;
  version?: string;
  pipeline?: string[];
  boundary: {
    west: number;
    east: number;
    south: number;
    north: number;
  };
  projectionOrigin: {
    lng: number;
    lat: number;
  };
  tileSize?: number;
  tileCount?: number;
  tileIds?: string[];
  tiles?: TileManifestEntry[];
  featureCounts: Record<string, number>;
  layerAvailability: Record<string, boolean>;
  bounds?: [number, number, number, number];
  nocibeFocus?: NocibeFocusData;
}

interface NocibeFocusData {
  name: string;
  searchKey: string;
  banId: string;
  address: string;
  coord: [number, number];
  sourceRefs: SourceReference[];
  confidence: string;
  status: string;
  anchors: { name: string; coord: [number, number] }[];
}
type LocalCoordinate = [number, number];
type LocalGeometry =
  | { type: "Point"; coordinates: LocalCoordinate }
  | { type: "LineString"; coordinates: LocalCoordinate[] }
  | { type: "Polygon"; coordinates: LocalCoordinate[][] }
  | { type: "MultiPolygon"; coordinates: LocalCoordinate[][][] };

interface RawMapFeature {
  kind: FeatureKind;
  stableId: string;
  localGeometry?: LocalGeometry;
  x?: number;
  z?: number;
  lon?: number;
  lat?: number;
  name?: string;
  displayName?: string;
  [key: string]: unknown;
}

interface TileEnvelope {
  manifest: TileManifestEntry;
  features: RawMapFeature[];
  metadata?: Record<string, unknown>;
}

interface TileData {
  tileId: string;
  features: RawMapFeature[];
  bounds: [number, number, number, number];
}
const renderableKinds: Record<FeatureKind, boolean> = {
  building: true,
  road: true,
  water: true,
  landuse: true,
  poi: true,
  business: true,
  address: false,
  transport: false,
  boundary: false,
};

interface SearchRecord {
  featureId: string;
  canonicalName: string;
  normalizedName: string;
  aliases: string[];
  kind: FeatureKind;
  tileId: string;
  focusLon: number;
  focusLat: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LAYERS: Record<string, boolean> = {
  buildings: true,
  roads: true,
  water: true,
  landuse: true,
  pois: true,
  addresses: false,
  transport: false,
  boundary: true,
  "nocibe-commercial-audit": false,
  labels: true,
};

const LS_THEME_KEY = "map-theme";
const TILE_LOAD_CONCURRENCY = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count loaded features across all tiles. */
function countFeatures(tileMap: Map<string, TileData>): number {
  let count = 0;
  for (const tile of tileMap.values()) {
    count += tile.features.length;
  }
  return count;
}

/** Extract a focus [x, z] from a MapFeature. */
function focusFromFeature(feature: MapFeature): { x: number; z: number } | null {
  if (feature.localCoord) {
    const [x, z] = feature.localCoord;
    if (x !== undefined && z !== undefined) {
      return { x, z };
    }
  }
  if (feature.coord) {
    const [lng, lat] = feature.coord;
    if (lng !== undefined && lat !== undefined) {
      // If only WGS84 available, assume it will be projected by the canvas.
      return { x: lng, z: lat };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MapShell — top-level client component
// ---------------------------------------------------------------------------

export default function MapShell() {
  // ---- State ----
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem(LS_THEME_KEY);
    if (stored === "dark" || stored === "light") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [selectedFeature, setSelectedFeature] = useState<MapFeature | null>(
    null,
  );
  const [cameraFocus, setCameraFocus] = useState<{
    x: number;
    z: number;
  } | null>(null);
  const [layers, setLayers] =
    useState<Record<string, boolean>>(DEFAULT_LAYERS);
  const [manifest, setManifest] = useState<ManifestData | null>(null);
  const [tiles, setTiles] = useState<Map<string, TileData>>(new Map());
  const [searchIndex, setSearchIndex] = useState<SearchRecord[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [webGpuStatus, setWebGpuStatus] = useState<
    "unknown" | "supported" | "unsupported"
  >("unknown");
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);

  // Refs
  const shellRef = useRef<HTMLDivElement>(null);
  const diagnosticsRef = useRef<HTMLDivElement>(null);

  // ---- Theme: track OS preference changes when no explicit choice is stored ----
  useEffect(() => {
    if (localStorage.getItem(LS_THEME_KEY) === "dark" || localStorage.getItem(LS_THEME_KEY) === "light") {
      return undefined;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent): void => {
      setTheme(e.matches ? "dark" : "light");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Apply theme
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(LS_THEME_KEY, theme);
    } catch {
      // localStorage may be unavailable (private browsing, permissions)
    }
  }, [theme]);

  // ---- Data loading ----
  useEffect(() => {
    let cancelled = false;

    async function loadData(): Promise<void> {
      try {
        setLoading(true);
        setError(null);

        // Detect WebGPU support
        const gpuSupported =
          typeof navigator !== "undefined" &&
          typeof navigator.gpu !== "undefined" &&
          navigator.gpu !== null;
        if (!cancelled) {
          setWebGpuStatus(gpuSupported ? "supported" : "unsupported");
        }

        // Fetch dataset manifest
        const manifestRes = await fetch("/api/map/manifest", {
          headers: { Accept: "application/json" },
        });
        if (!manifestRes.ok) {
          const body = await manifestRes.text().catch(() => "");
          if (manifestRes.status === 503) {
            throw new Error(
              `DATASET_UNAVAILABLE: ${manifestRes.status} ${body}`,
            );
          }
          throw new Error(
            `Manifest load failed: ${manifestRes.status} ${body}`,
          );
        }
        const manifestData: ManifestData = await manifestRes.json();
        if (cancelled) return;
        setManifest(manifestData);

        // Fetch search index
        const searchRes = await fetch("/api/map/search", {
          headers: { Accept: "application/json" },
        });
        if (searchRes.ok) {
          const searchBody = await searchRes.json();
          const records: SearchRecord[] = Array.isArray(searchBody)
            ? searchBody
            : (searchBody.records ?? []);
          if (!cancelled) setSearchIndex(records);
        } else {
          throw new Error(`Search index load failed: ${searchRes.status}`);
        }

        // Resolve tile IDs
        const tileIds: string[] =
          manifestData.tileIds ??
          manifestData.tiles?.map((t) => t.tileId) ??
          [];

        // Load tiles in parallel batches
        const loaded = new Map<string, TileData>();

        for (let i = 0; i < tileIds.length; i += TILE_LOAD_CONCURRENCY) {
          if (cancelled) return;
          const batch = tileIds.slice(i, i + TILE_LOAD_CONCURRENCY);
          const results = await Promise.all(
            batch.map(async (tileId) => {
              try {
                const res = await fetch(
                  `/api/map/tile/${encodeURIComponent(tileId)}`,
                  { headers: { Accept: "application/json" } },
                );
                if (!res.ok) {
                  console.warn(`Tile ${tileId} load failed: ${res.status}`);
                  return null;
                }
                const envelope: TileEnvelope = await res.json();
                if (!Array.isArray(envelope.features)) {
                  throw new Error(`Tile ${tileId} has no feature array`);
                }
                return {
                  tileId,
                  data: {
                    tileId,
                    features: envelope.features,
                    bounds: envelope.manifest.bounds,
                  },
                };
              } catch (err) {
                console.warn(`Tile ${tileId} fetch error:`, err);
                return null;
              }
            }),
          );
          if (cancelled) return;
          for (const r of results) {
            if (r) loaded.set(r.tileId, r.data);
          }
        }

        if (!cancelled) setTiles(loaded);
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Failed to load map data";
          setError(message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Scene diagnostics ----
  useEffect(() => {
    sceneMetrics.loadedTileCount = tiles.size;
    sceneMetrics.loadedFeatureCount = countFeatures(tiles);
    if (error) {
      sceneMetrics.rendererStatus = "errored";
      sceneMetrics.backend = "unknown";
      sceneMetrics.rendererError = error;
    } else if (webGpuStatus === "unsupported" && sceneMetrics.rendererError === "none") {
      sceneMetrics.rendererStatus = "unsupported";
      sceneMetrics.backend = "unknown";
      sceneMetrics.rendererError = "WebGPU unavailable in this browser";
    }
    publishSceneDiagnostics(true);
  }, [webGpuStatus, tiles, cameraFocus, error]);

  // ---- Event handlers ----
  const handleSearchSelect = useCallback((feature: MapFeature): void => {
    setSelectedFeature(feature);

    const focus = focusFromFeature(feature);
    if (focus) {
      setCameraFocus(focus);
    }

    // Auto-open Nocibé commercial audit layer
    if (feature.banId || feature.searchKey === "nocibe") {
      setLayers((prev) => ({ ...prev, "nocibe-commercial-audit": true }));
    }
  }, []);
  const handleSearchQueryChange = useCallback((query: string): void => {
    setSearchQuery(query);
  }, []);

  const handleSearchResultSelect = useCallback(
    (featureId: string): void => {
      const raw = Array.from(tiles.values())
        .flatMap((tile) => tile.features)
        .find((feature) => feature.stableId === featureId);
      if (!raw) return;
      const selected = {
        ...raw,
        id: raw.stableId,
        name: raw.name ?? raw.displayName,
        localCoord:
          raw.x !== undefined && raw.z !== undefined ? [raw.x, raw.z] : undefined,
      } as unknown as MapFeature;
      handleSearchSelect(selected);
      setSearchQuery("");
    },
    [tiles, handleSearchSelect],
  );


  const handleLayerToggle = useCallback(
    (layerId: string, visible: boolean): void => {
      setLayers((prev) => ({ ...prev, [layerId]: visible }));
    },
    [],
  );

  const handleResetView = useCallback((): void => {
    setCameraFocus(null);
  }, []);

  const handleFeatureSelect = useCallback(
    (feature: MapFeature | null): void => {
      setSelectedFeature(feature);
    },
    [],
  );

  const handleCameraMoveComplete = useCallback((): void => {
    setCameraFocus(null);
  }, []);

  const handleInspectorClose = useCallback((): void => {
    setSelectedFeature(null);
    setMobileInspectorOpen(false);
  }, []);

  const handleInspectorMobileToggle = useCallback((): void => {
    setMobileInspectorOpen((o) => !o);
  }, []);

  // ---- Derived data ----
  const tileDataArray = useMemo(() => Array.from(tiles.values()), [tiles]);
  const sceneFeatures = useMemo(
    () =>
      tileDataArray.flatMap((tile) =>
        tile.features
          .filter((feature) => renderableKinds[feature.kind] && feature.localGeometry)
          .map((feature) => ({
            ...feature,
            geometry: feature.localGeometry,
            name: feature.name ?? feature.displayName,
          })),
      ),
    [tileDataArray],
  );
  const searchResults = useMemo(
    () => (searchQuery.trim() ? runSearchIndex(searchQuery, searchIndex as SearchIndexRecord[]) : []),
    [searchQuery, searchIndex],
  );
  const hasCriticalError = !!error && !manifest;

  // ---- Nocibé focus enrichment ----
  const enrichedInspectorFeature = useMemo<MapFeature | null>(() => {
    if (!selectedFeature) return null;
    if (selectedFeature.banId && manifest?.nocibeFocus) {
      return {
        ...selectedFeature,
        metadata: {
          ...(selectedFeature.metadata ?? {}),
          nocibeFocus: manifest.nocibeFocus,
          commercialAuditRadius: 750,
          anchors: manifest.nocibeFocus.anchors,
        },
      };
    }
    return selectedFeature;
  }, [selectedFeature, manifest]);

  /** Derive attribution data from the dataset manifest pipeline. */
  const attributionData = useMemo(() => {
    if (!manifest) return null;

    const pipelineSources: Record<string, { source: string; url: string }> = {
      "fetch-osm": {
        source: "OpenStreetMap",
        url: "https://www.openstreetmap.org",
      },
      "fetch-addresses": {
        source: "Base Adresse Nationale",
        url: "https://adresse.data.gouv.fr",
      },
      "fetch-businesses": {

        source: "Annuaire des Entreprises",
        url: "https://annuaire-entreprises.data.gouv.fr",
      },
      "fetch-ign": {
        source: "IGN",
        url: "https://geoservices.ign.fr",
      },
    };

    const sources: SourceReference[] = (manifest.pipeline ?? [])
      .filter((step) => step in pipelineSources)
      .map((step) => ({
        source: pipelineSources[step].source,
        url: pipelineSources[step].url,
        timestamp: manifest.acquisitionTime,
      }));

    return {
      datasetVersion: manifest.version ?? manifest.datasetVersion ?? "unknown",
      acquisitionTime: manifest.acquisitionTime,
      sources,
      osmAttribution: "Contributeurs d\u2019OpenStreetMap",
    };
  }, [manifest]);
  const searchResultsNode: ReactNode =
    searchResults.length > 0 ? (
      <div role="listbox" aria-label="Résultats de recherche">
        {searchResults.map(({ record }, index) => (
          <button
            key={record.featureId}
            type="button"
            role="option"
            aria-selected={index === 0}
            onClick={() => handleSearchResultSelect(record.featureId)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              width: "100%",
              padding: "0.65rem 0.8rem",
              border: 0,
              background: "transparent",
              color: "var(--color-ink)",
              cursor: "pointer",
            }}
          >
            <span>{record.canonicalName}</span>
            <span>{record.kind}</span>
          </button>
        ))}
      </div>
    ) : null;

  // ---- Render ----
  return (
    <div
      className="map-shell"
      ref={shellRef}
      data-theme={theme}
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-paper, #ffffff)",
        color: "var(--color-ink, #000000)",
      }}
    >
      {/* Loading state */}
      {loading && (
        <div
          className="map-shell__loading"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <LoadingState />
        </div>
      )}

      {/* Critical error (no manifest loaded) */}
      {hasCriticalError && !loading && (
        <div
          className="map-shell__error"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          <div
            className="map-shell__error-panel"
            style={{
              maxWidth: "480px",
              padding: "2rem",
              borderRadius: "8px",
              background: "var(--color-paper, #fff)",
              border: "1px solid color-mix(in srgb, var(--color-ink, #000) 20%, transparent)",
              textAlign: "center",
            }}
          >
            <h2
              style={{
                fontSize: "1.25rem",
                fontWeight: 600,
                margin: "0 0 0.75rem",
              }}
            >
              Impossible de charger la carte
            </h2>
            <p style={{ margin: "0 0 1rem", lineHeight: 1.5 }}>
              {error}
            </p>
            <p
              style={{
                fontSize: "0.875rem",
                color: "color-mix(in srgb, var(--color-ink, #000) 60%, transparent)",
              }}
            >
              Vérifiez que les données sont générées avec{" "}
              <code style={{ fontSize: "0.875rem" }}>npm run data:refresh</code>
              .
            </p>
          </div>
        </div>
      )}

      {/* WebGPU canvas with scene children */}
      <div
        className="map-shell__canvas"
        style={{
          flex: 1,
          position: "relative",
          overflow: "hidden",
        }}
      >
        {!hasCriticalError && (
          <>
            {webGpuStatus === "supported" && manifest ? (
              <WebGPUCityCanvas bounds={manifest.bounds}>
                <CityScene
                  features={sceneFeatures}
                  layers={layers}
                  selectedFeature={selectedFeature}
                  onFeatureSelect={handleFeatureSelect}
                  cameraFocus={cameraFocus}
                  onCameraMoveComplete={handleCameraMoveComplete}
                  bounds={manifest.bounds}
                />
              </WebGPUCityCanvas>
            ) : webGpuStatus === "unsupported" ? (
              <WebGPUUnsupported error={sceneMetrics.rendererError} />
            ) : null}
          </>
        )}
      </div>

      {/* HUD overlay */}
      {!hasCriticalError && !loading && (
        <MapHud
          query={searchQuery}
          onQueryChange={handleSearchQueryChange}
          onSearch={handleSearchQueryChange}
          onResetView={handleResetView}
          results={searchResultsNode}
        />
      )}

      {/* Layer controls */}
      {!hasCriticalError && !loading && (
        <LayerControls
          layers={layers}
          onToggle={handleLayerToggle}
          onResetView={handleResetView}
        />
      )}

      {/* Feature inspector */}
      {!hasCriticalError && !loading && (
        <FeatureInspector
          feature={enrichedInspectorFeature}
          onClose={handleInspectorClose}
          mobileOpen={mobileInspectorOpen}
          onMobileToggle={handleInspectorMobileToggle}
        />
      )}

      {/* Source attribution */}
      {!hasCriticalError && !loading && (
        <SourceAttribution data={attributionData} />
      )}

      {/* Scene diagnostics element */}
      <div
        id="scene-diagnostics"
        ref={diagnosticsRef}
        className="map-shell__diagnostics"
        aria-hidden="true"
        style={{
          position: "absolute",
          bottom: "2rem",
          left: "0.5rem",
          fontSize: "10px",
          fontFamily: "monospace",
          color: "color-mix(in srgb, var(--color-ink, #000) 40%, transparent)",
          whiteSpace: "pre",
          pointerEvents: "none",
          userSelect: "none",
          opacity: 0.6,
        }}
      />

      {/* Responsive mobile inspector toggle button */}
      {!hasCriticalError &&
        !loading &&
        selectedFeature && (
          <button
            type="button"
            className="map-shell__inspector-toggle"
            onClick={handleInspectorMobileToggle}
            aria-label={
              mobileInspectorOpen
                ? "Fermer les détails"
                : "Ouvrir les détails"
            }
            style={{
              position: "absolute",
              right: "0.5rem",
              bottom: "4rem",
              zIndex: 100,
              display: "none",
              padding: "0.5rem 0.75rem",
              borderRadius: "4px",
              fontSize: "0.8125rem",
              fontWeight: 500,
              border: "none",
              cursor: "pointer",
              background: "var(--color-accent, #ff7d27)",
              color: "#000000",
            }}
          >
            {mobileInspectorOpen ? "Fermer" : "Détails"}
          </button>
        )}
    </div>
  );
}