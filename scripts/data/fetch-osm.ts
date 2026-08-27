#!/usr/bin/env tsx
/// <reference lib="es2024.promise" />
/**
 * fetch-osm.ts — Overpass API acquisition for Auch commune
 *
 * Reads the Auch boundary polygon from the boundary source (written by
 * discover-auch-boundary.ts), builds constrained Overpass queries by theme,
 * fetches with retry and endpoint fallback, stores raw responses in
 * data/raw/osm-{theme}.json, and writes an acquisition manifest to
 * data/intermediate/osm-manifest.json.
 *
 * Usage:  tsx scripts/data/fetch-osm.ts
 *
 * Environment:
 *   MASTER_MAPS_DATA_DIR  data root directory (default "data")
 *
 * Exit codes:
 *   0  all themes acquired successfully
 *   1  one or more themes failed after retries
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? 'data';
const RAW_DIR = path.join(DATA_DIR, 'raw');
const INTERMEDIATE_DIR = path.join(DATA_DIR, 'intermediate');

const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter';
const OVERPASS_ENDPOINTS = [OVERPASS_PRIMARY, OVERPASS_FALLBACK] as const;

/** Maximum HTTP/network retries per endpoint before switching. */
const MAX_RETRIES = 3;
/** Base delay for exponential backoff (milliseconds). */
const BASE_DELAY_MS = 1_000;
/** Per-request timeout (milliseconds). */
const REQUEST_TIMEOUT_MS = 150_000;
/** Delay between successive theme requests to rate-limit. */
const INTER_REQUEST_DELAY_MS = 1_500;
/** Overpass query timeout (seconds) sent in the query. */
const OVERPASS_QUERY_TIMEOUT = 120;

// ---------------------------------------------------------------------------
// Theme definitions
// ---------------------------------------------------------------------------

interface ThemeDef {
  name: string;
  queryTemplate: (poly: string) => string;
}

const THEMES: ThemeDef[] = [
  {
    name: 'buildings',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["building"](poly:"${poly}");
  relation["building"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'roads',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["highway"~"motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'paths',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["highway"~"path|footway|cycleway|bridleway|track|pedestrian|steps|crossing|corridor|via_ferrata"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'structures',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["bridge"](poly:"${poly}");
  way["tunnel"](poly:"${poly}");
  way["man_made"~"pier|breakwater|groyne|jetty|offshore_platform|lighthouse"](poly:"${poly}");
  relation["bridge"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'rail',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["railway"](poly:"${poly}");
  way["landuse"="railway"](poly:"${poly}");
  node["railway"="station"](poly:"${poly}");
  node["railway"="stop"](poly:"${poly}");
  node["railway"="halt"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'water',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["waterway"](poly:"${poly}");
  way["natural"="water"](poly:"${poly}");
  relation["natural"="water"](poly:"${poly}");
  way["natural"="wetland"](poly:"${poly}");
  relation["natural"="wetland"](poly:"${poly}");
  way["landuse"="reservoir"](poly:"${poly}");
  relation["landuse"="reservoir"](poly:"${poly}");
  way["waterway"="riverbank"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'landuse',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["landuse"](poly:"${poly}");
  relation["landuse"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'parks',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  way["leisure"~"park|garden|pitch|sports_centre|playground|recreation_ground|nature_reserve|golf_course|stadium|track|common|green|marina"](poly:"${poly}");
  relation["leisure"~"park|garden|pitch|sports_centre|playground|recreation_ground|nature_reserve|golf_course|stadium|track|common|green|marina"](poly:"${poly}");
  way["landuse"="recreation_ground"](poly:"${poly}");
  relation["landuse"="recreation_ground"](poly:"${poly}");
  way["landuse"="village_green"](poly:"${poly}");
  relation["landuse"="village_green"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'facilities',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  node["amenity"](poly:"${poly}");
  way["amenity"](poly:"${poly}");
  relation["amenity"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'parking',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  node["amenity"="parking"](poly:"${poly}");
  way["amenity"="parking"](poly:"${poly}");
  relation["amenity"="parking"](poly:"${poly}");
  node["parking"](poly:"${poly}");
  way["parking"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'transit',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  node["public_transport"](poly:"${poly}");
  way["public_transport"](poly:"${poly}");
  relation["public_transport"](poly:"${poly}");
  node["highway"="bus_stop"](poly:"${poly}");
  node["amenity"="bus_station"](poly:"${poly}");
  node["railway"="station"](poly:"${poly}");
  node["railway"="halt"](poly:"${poly}");
  node["railway"="stop"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'addresses',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  node["addr:housenumber"](poly:"${poly}");
  way["addr:housenumber"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'shops',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  node["shop"](poly:"${poly}");
  way["shop"](poly:"${poly}");
  relation["shop"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },

  {
    name: 'named-pois',
    queryTemplate: (poly) => `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT}];
(
  node["name"]["tourism"](poly:"${poly}");
  way["name"]["tourism"](poly:"${poly}");
  relation["name"]["tourism"](poly:"${poly}");
  node["name"]["historic"](poly:"${poly}");
  way["name"]["historic"](poly:"${poly}");
  relation["name"]["historic"](poly:"${poly}");
  node["name"]["office"](poly:"${poly}");
  way["name"]["office"](poly:"${poly}");
  relation["name"]["office"](poly:"${poly}");
  node["name"]["craft"](poly:"${poly}");
  way["name"]["craft"](poly:"${poly}");
  relation["name"]["craft"](poly:"${poly}");
  node["name"]["emergency"](poly:"${poly}");
  way["name"]["emergency"](poly:"${poly}");
  node["name"]["information"](poly:"${poly}");
  way["name"]["information"](poly:"${poly}");
  node["name"]["amenity"](poly:"${poly}");
);
out body; >; out skel qt;`,
  },
];

// ---------------------------------------------------------------------------
// Boundary polygon helpers
// ---------------------------------------------------------------------------

/**
 * Convert a GeoJSON ring (array of [lng, lat] pairs) to an Overpass poly
 * string (space-separated "lat lon" pairs).  Overpass requires the poly
 * filter to receive latitude first, then longitude.
 */
function coordsToPoly(ring: number[][]): string {
  return ring.map(([lng, lat]) => `${lat} ${lng}`).join(' ');
}

/**
 * Type guards for GeoJSON coordinate nesting.  A ring must be a closed loop
 * (≥4 [lng, lat] positions); polygons and multipolygons are one and two
 * levels of ring arrays respectively.
 */
function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function isRing(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length >= 4 && value.every((position) => isPosition(position));
}

function isPolygonCoordinates(value: unknown): value is number[][][] {
  return Array.isArray(value) && value.every((ring) => isRing(ring));
}

function isMultiPolygonCoordinates(value: unknown): value is number[][][][] {
  return Array.isArray(value) && value.every((polygon) => isPolygonCoordinates(polygon));
}

/**
 * Derive an Overpass poly string from a GeoJSON geometry object.
 * For MultiPolygon the largest ring (by area) is used.
 * Returns null for unsupported geometry types or malformed coordinates.
 */
function geometryToPoly(geometry: { type: string; coordinates: unknown }): string | null {
  if (geometry.type === 'Polygon' && isPolygonCoordinates(geometry.coordinates)) {
    return coordsToPoly(geometry.coordinates[0]);
  }
  if (geometry.type === 'MultiPolygon' && isMultiPolygonCoordinates(geometry.coordinates)) {
    let largestRing = geometry.coordinates[0][0];
    let largestArea = 0;
    for (const polygon of geometry.coordinates) {
      const ring = polygon[0];
      const n = ring.length - 1;
      if (n < 3) continue;
      // Shoelace formula
      let area = 0;
      for (let i = 0; i < n; i++) {
        area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
      }
      area = Math.abs(area) / 2;
      if (area > largestArea) {
        largestArea = area;
        largestRing = ring;
      }
    }
    return coordsToPoly(largestRing);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Overpass fetch with retry and fallback
// ---------------------------------------------------------------------------

interface OverpassResult {
  response: unknown;
  endpointUrl: string;
  /** Number of failed attempts before the successful response. */
  retryCount: number;
}

/**
 * Fetch from the Overpass API with exponential backoff per endpoint and a
 * fallback to the mirror endpoint when all retries are exhausted.
 */
async function fetchOverpass(query: string): Promise<OverpassResult> {
  let lastError: Error | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const res = await fetch(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'User-Agent': 'master-maps/1.0 (OSM acquisition for Auch, France; contact@ifthenelse.com)',
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: `data=${encodeURIComponent(query)}`,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
        }

        const data: unknown = await res.json();

        // Overpass may return a JSON error (HTTP 200) with a "remark" field.
        // Only treat "runtime error" / "timeout" remarks as failures; a remark
        // like "number of results" is informational.
        if (typeof data === 'object' && data !== null && 'remark' in data) {
          const { remark } = data;
          if (typeof remark === 'string' && remark !== '' && /error|timeout|abort/i.test(remark)) {
            throw new Error(`Overpass error: ${remark}`);
          }
        }

        return { response: data, endpointUrl: endpoint, retryCount: attempt };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        const tag = error.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';
        console.error(
          `  [${tag}] ${endpoint}  attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${error.message.slice(0, 200)}`,
        );

        if (attempt < MAX_RETRIES) {
          await sleep(BASE_DELAY_MS * 2 ** attempt);
        }
      }
    }
    // Brief cooldown before switching to fallback
    await sleep(500);
  }

  throw lastError ?? new Error('All Overpass endpoints exhausted');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Pause execution for `ms` milliseconds (abort-safe timer wrapper). */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// ---------------------------------------------------------------------------
// Manifest type
// ---------------------------------------------------------------------------

interface ThemeResult {
  query: string;
  endpointUrl: string | null;
  timestamp: string;
  recordCount: number;
  byteSize: number;
  sha256: string;
  retryCount: number;
  success: boolean;
  error: string | null;
}

interface OsmManifest {
  dataset: string;
  acquisitionTime: string;
  boundaryBbox: [number, number, number, number] | null;
  themeCount: number;
  themes: Record<string, ThemeResult>;
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
}

// ---------------------------------------------------------------------------
// Safeguard: validate the poly string before it is embedded in a query
// ---------------------------------------------------------------------------

/**
 * Validate that the poly string contains only finite floats and spaces.
 */
function validatePolyString(poly: string): void {
  if (!/^[\d. eE+\-]+$/.test(poly)) {
    throw new Error(`Invalid poly string: contains unexpected characters`);
  }
  const parts = poly.split(/\s+/);
  if (parts.length < 8) {
    throw new Error(`Poly string too short (${parts.length} tokens; need ≥8 for a polygon)`);
  }
  if (parts.length % 2 !== 0) {
    throw new Error(`Poly string has odd number of tokens (${parts.length})`);
  }
  // Verify every token is a parseable finite number
  for (const token of parts) {
    const n = Number.parseFloat(token);
    if (!Number.isFinite(n)) {
      throw new Error(`Invalid poly coordinate: ${token}`);
    }
  }
}

/**
 * Type guard: value is a Polygon/MultiPolygon-like object whose coordinates
 * pass the nesting checks for Polygon/MultiPolygon.
 */
function isValidBoundaryGeometry(
  value: unknown,
): value is { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || !('coordinates' in value)) return false;
  const { type, coordinates } = value;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return false;
  return type === 'Polygon' ? isPolygonCoordinates(coordinates) : isMultiPolygonCoordinates(coordinates);
}

function parseBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  const [west, south, east, north] = value;
  return [west, south, east, north];
}

interface ParsedBoundaryRecord {
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown };
  bbox: [number, number, number, number] | null;
}

/**
 * Extract a boundary geometry from any of the shapes the acquisition
 * pipeline writes: a source record `{ geometry, bbox }`, a GeoJSON Feature
 * `{ type, geometry }`, a FeatureCollection, or a bare Polygon/MultiPolygon.
 * Returns null when no recognized geometry is present.
 */
function parseBoundaryRecord(raw: unknown): ParsedBoundaryRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;

  // GeoJSON Feature or boundary source record: { geometry, bbox? }
  if ('geometry' in raw && isValidBoundaryGeometry(raw.geometry)) {
    return { geometry: raw.geometry, bbox: 'bbox' in raw ? parseBbox(raw.bbox) : null };
  }

  // FeatureCollection: use the first feature that carries a geometry
  if ('features' in raw && Array.isArray(raw.features)) {
    for (const feature of raw.features) {
      if (typeof feature === 'object' && feature !== null && 'geometry' in feature) {
        const geometry = feature.geometry;
        if (isValidBoundaryGeometry(geometry)) {
          return { geometry, bbox: 'bbox' in raw ? parseBbox(raw.bbox) : null };
        }
      }
    }
    return null;
  }

  // Bare Polygon/MultiPolygon at the top level
  if (isValidBoundaryGeometry(raw)) {
    return { geometry: raw, bbox: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== OSM Acquisition for Auch ===\n');

  // Ensure output directories exist
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(INTERMEDIATE_DIR, { recursive: true });

  // ---- Load boundary polygon ----
  console.log('Loading boundary polygon...');

  let boundaryGeometry: { type: string; coordinates: unknown } | null = null;
  let bbox: [number, number, number, number] | null = null;

  const candidatePaths = [
    path.join(INTERMEDIATE_DIR, 'boundary-source.json'),
    path.join(RAW_DIR, 'boundary.json'),
    path.join(INTERMEDIATE_DIR, 'boundary.json'),
    path.join(RAW_DIR, 'auch-boundary.geojson'),
  ];

  for (const filePath of candidatePaths) {
    try {
      const content = await readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      const record = parseBoundaryRecord(parsed);
      if (record) {
        boundaryGeometry = record.geometry;
        bbox = record.bbox;
        console.log(`  Loaded from ${filePath}  (type=${boundaryGeometry.type})`);
        break;
      }
    } catch {
      // file not found or unparseable — try next
      continue;
    }
  }

  if (!boundaryGeometry) {
    throw new Error(
      'Cannot find boundary polygon. Run scripts/data/discover-auch-boundary.ts first.\n' +
        `  Searched: ${candidatePaths.join(', ')}`,
    );
  }

  const polyStr = geometryToPoly(boundaryGeometry);
  if (!polyStr) {
    throw new Error(
      `Unsupported boundary geometry type: ${boundaryGeometry.type}. Expected Polygon or MultiPolygon.`,
    );
  }
  validatePolyString(polyStr);
  console.log(
    `  Poly string: ${polyStr.slice(0, 120)}... (${polyStr.split(/\s+/).length / 2} vertices)`,
  );

  // ---- Fetch each theme ----
  const manifest: OsmManifest = {
    dataset: 'osm-auch',
    acquisitionTime: new Date().toISOString(),
    boundaryBbox: bbox,
    themeCount: THEMES.length,
    themes: {},
    totalQueries: THEMES.length,
    successfulQueries: 0,
    failedQueries: 0,
  };

  for (const theme of THEMES) {
    console.log(`\n[${theme.name}]`);

    const query = theme.queryTemplate(polyStr);
    const rawPath = path.join(RAW_DIR, `osm-${theme.name}.json`);

    const result: ThemeResult = {
      query,
      endpointUrl: null,
      timestamp: '',
      recordCount: 0,
      byteSize: 0,
      sha256: '',
      retryCount: -1,
      success: false,
      error: null,
    };

    try {
      console.log(`  Query (${query.length} chars)...`);
      const { response, endpointUrl, retryCount } = await fetchOverpass(query);

      result.endpointUrl = endpointUrl;
      result.retryCount = retryCount;
      result.timestamp = new Date().toISOString();

      const rawJson = JSON.stringify(response);
      result.sha256 = crypto.createHash('sha256').update(rawJson, 'utf-8').digest('hex');
      result.byteSize = rawJson.length;

      const elements =
        typeof response === 'object' && response !== null && 'elements' in response
          ? response.elements
          : undefined;
      result.recordCount = Array.isArray(elements) ? elements.length : 0;

      // Write raw response
      await writeFile(rawPath, rawJson, 'utf-8');

      result.success = true;
      manifest.successfulQueries++;

      console.log(
        `  OK  ${result.recordCount} elements  ` +
          `${(result.byteSize / 1024).toFixed(1)} KiB  ` +
          `${endpointUrl}  retry=${retryCount}  sha256=${result.sha256.slice(0, 12)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.error = message;
      manifest.failedQueries++;
      console.error(`  FAIL  ${message}`);
    }

    manifest.themes[theme.name] = result;

    // Inter-request delay to avoid rate limiting
    if (THEMES.indexOf(theme) < THEMES.length - 1) {
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  }

  // ---- Write manifest ----
  manifest.acquisitionTime = new Date().toISOString();
  const manifestPath = path.join(INTERMEDIATE_DIR, 'osm-manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`\n  Manifest written to ${manifestPath}`);

  // ---- Summary ----
  console.log(`\n=== OSM Acquisition Complete ===`);
  console.log(`  Successful: ${manifest.successfulQueries} / ${manifest.totalQueries}`);
  console.log(`  Failed:     ${manifest.failedQueries}`);

  if (manifest.failedQueries > 0) {
    console.error(`\n  Failed themes:`);
    for (const [name, themeResult] of Object.entries(manifest.themes)) {
      if (!themeResult.success) {
        console.error(`    - ${name}: ${themeResult.error}`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\nFATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});