#!/usr/bin/env tsx

import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from 'node:child_process';
import { AUCH_DETAIL_SCOPE } from "../../src/lib/data/territory";
import { promisify } from 'node:util';
import { acquireFile, acquireJson, type AcquisitionOutcome } from "./http-cache";


const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? 'data';
const RAW_DIR = path.join(DATA_DIR, 'raw');
const INTERMEDIATE_DIR = path.join(DATA_DIR, 'intermediate');

const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass.kumi.systems/api/interpreter';
const OVERPASS_ENDPOINTS = [OVERPASS_PRIMARY, OVERPASS_FALLBACK] as const;

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 150_000;
const INTER_REQUEST_DELAY_MS = 1_500;
const OVERPASS_QUERY_TIMEOUT = 120;


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



interface OverpassResult {
  response: unknown;
  endpointUrl: string;
  retryCount: number;
}

async function fetchOverpass(query: string): Promise<OverpassResult> {
  let lastError: Error | null = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const acquired = await acquireJson({
          url: endpoint,
          method: "POST",
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
          maxBytes: 64 * 1024 * 1024,
          headers: {
            "User-Agent": "master-maps/1.0 (OSM acquisition for Gers department, France; contact@ifthenelse.com)",
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
        });
        const data: unknown = JSON.parse(acquired.body);
        if (typeof data === "object" && data !== null && "remark" in data) {
          const remark = data.remark;
          if (typeof remark === "string" && remark !== "" && /error|timeout|abort/i.test(remark)) throw new Error(`Overpass error: ${remark}`);
        }
        return { response: data, endpointUrl: endpoint, retryCount: attempt + acquired.retryCount };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const tag = lastError.name === "AbortError" ? "TIMEOUT" : "ERROR";
        console.error(`  [${tag}] ${endpoint}  attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${lastError.message.slice(0, 200)}`);
        if (attempt < MAX_RETRIES) await sleep(BASE_DELAY_MS * 2 ** attempt);
      } finally {
        clearTimeout(timeoutId);
      }
    }
    await sleep(500);
  }
  throw lastError ?? new Error("All Overpass endpoints exhausted");
}


function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}


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


function geometryBbox(geometry: { coordinates: unknown }): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      west = Math.min(west, value[0]);
      south = Math.min(south, value[1]);
      east = Math.max(east, value[0]);
      north = Math.max(north, value[1]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  if (![west, south, east, north].every(Number.isFinite)) throw new Error("Gers boundary has no finite coordinates");
  return [west, south, east, north];
}

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

function parseBoundaryRecord(raw: unknown): ParsedBoundaryRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;

  if ('geometry' in raw && isValidBoundaryGeometry(raw.geometry)) {
    return { geometry: raw.geometry, bbox: 'bbox' in raw ? parseBbox(raw.bbox) : null };
  }

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

  if (isValidBoundaryGeometry(raw)) {
    return { geometry: raw, bbox: null };
  }

  return null;
}
const execFileAsync = promisify(execFile);
const OSM_BULK_URL = "https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf";

async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return hash.digest("hex");
}

interface OsmBulkOutput {
  file: string;
  sha256: string;
  recordCount: number;
}

interface OsmBulkReuseManifest {
  source: string;
  resource: string;
  acquiredAt: string;
  license: string;
  crs: string;
  sourceSha256: string;
  boundarySha256: string;
  featureCount: number;
  boundary: string;
  method: string;
  outputs: OsmBulkOutput[];
}

function isOsmBulkOutput(value: unknown): value is OsmBulkOutput {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.file === "string"
    && typeof record.sha256 === "string"
    && typeof record.recordCount === "number"
    && Number.isInteger(record.recordCount)
    && record.recordCount >= 0;
}

function isOsmBulkOutputArray(value: unknown): value is OsmBulkOutput[] {
  return Array.isArray(value) && value.length > 0 && value.every(isOsmBulkOutput);
}

function parseReuseManifest(raw: unknown): OsmBulkReuseManifest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const source = record.source;
  const resource = record.resource;
  const acquiredAt = record.acquiredAt;
  const license = record.license;
  const crs = record.crs;
  const sourceSha256 = record.sourceSha256;
  const boundarySha256 = record.boundarySha256;
  const featureCount = record.featureCount;
  const boundary = record.boundary;
  const method = record.method;
  const outputs = record.outputs;
  if (typeof source !== "string" || typeof resource !== "string" || typeof acquiredAt !== "string" || typeof license !== "string" || typeof crs !== "string") return null;
  if (typeof sourceSha256 !== "string" || typeof boundarySha256 !== "string" || typeof boundary !== "string" || typeof method !== "string") return null;
  if (typeof featureCount !== "number" || !Number.isInteger(featureCount) || featureCount < 0) return null;
  if (!isOsmBulkOutputArray(outputs)) return null;
  return { source, resource, acquiredAt, license, crs, sourceSha256, boundarySha256, featureCount, boundary, method, outputs };
}

async function readReuseManifest(manifestPath: string): Promise<OsmBulkReuseManifest | null> {
  try {
    return parseReuseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch {
    return null;
  }
}

async function outputsExist(outputs: OsmBulkOutput[]): Promise<boolean> {
  for (const output of outputs) {
    try {
      await access(output.file);
    } catch {
      return false;
    }
  }
  return true;
}

async function writeReuseManifest(manifestPath: string, previous: OsmBulkReuseManifest, boundarySha256: string, outcome: AcquisitionOutcome): Promise<void> {
  await writeFile(manifestPath, JSON.stringify({
    source: previous.source,
    resource: previous.resource,
    acquiredAt: previous.acquiredAt,
    license: previous.license,
    crs: previous.crs,
    sourceSha256: previous.sourceSha256,
    boundarySha256,
    featureCount: previous.featureCount,
    boundary: previous.boundary,
    method: previous.method,
    outputs: previous.outputs,
    bytesDownloaded: outcome.bytesDownloaded,
    fromCache: outcome.fromCache,
    httpStatus: outcome.httpStatus,
    requestCount: outcome.requestCount,
    retryCount: outcome.retryCount,
  }, null, 2) + "\n", "utf8");
}

function fileinfoCount(value: unknown, label: string, filePath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`osmium fileinfo ${label} count is invalid for ${filePath}`);
  return value;
}

async function osmiumObjectCount(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync("osmium", ["fileinfo", "-e", "--json", filePath], { maxBuffer: 2 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) throw new Error(`osmium fileinfo produced no report for ${filePath}`);
  const data: unknown = parsed.data;
  if (typeof data !== "object" || data === null || !("count" in data)) throw new Error(`osmium fileinfo report has no data count section for ${filePath}`);
  const count: unknown = data.count;
  if (typeof count !== "object" || count === null || !("nodes" in count) || !("ways" in count) || !("relations" in count)) throw new Error(`osmium fileinfo report has incomplete object counts for ${filePath}`);
  return fileinfoCount(count.nodes, "nodes", filePath)
    + fileinfoCount(count.ways, "ways", filePath)
    + fileinfoCount(count.relations, "relations", filePath);
}

async function fetchBulkOsm(forceRefresh: boolean): Promise<void> {
  const pbfPath = path.join(RAW_DIR, "midi-pyrenees-latest.osm.pbf");
  const boundaryPath = path.join(RAW_DIR, "gers-boundary.geojson");
  const extractPath = path.join(RAW_DIR, "gers-osm.osm.pbf");
  const filteredPath = path.join(RAW_DIR, "gers-osm-enrichment.osm.pbf");
  const geojsonPath = path.join(RAW_DIR, "osm-bulk.geojson");
  const manifestPath = path.join(INTERMEDIATE_DIR, "osm-bulk-manifest.json");
  const outcome = await acquireFile({ url: OSM_BULK_URL, destination: pbfPath, forceRefresh, headers: { Accept: "application/octet-stream" } });
  const sourceSha256 = outcome.sha256;
  const boundarySha256 = await hashFile(boundaryPath);
  const previous = await readReuseManifest(manifestPath);
  if (!forceRefresh && previous !== null && previous.sourceSha256 === sourceSha256 && previous.boundarySha256 === boundarySha256 && await outputsExist(previous.outputs)) {
    console.log(`Bulk OSM extract unchanged: reusing ${previous.outputs.length} osmium outputs (fromCache=${outcome.fromCache}, httpStatus=${outcome.httpStatus}, bytesDownloaded=${outcome.bytesDownloaded})`);
    await writeReuseManifest(manifestPath, previous, boundarySha256, outcome);
    return;
  }
  await execFileAsync("osmium", ["extract", "-p", boundaryPath, pbfPath, "-o", extractPath, "--overwrite"], { maxBuffer: 2 * 1024 * 1024 });
  await execFileAsync("osmium", [
    "tags-filter", extractPath, "-o", filteredPath, "--overwrite",
    "w/highway=path,footway,cycleway,bridleway,track,pedestrian,steps",
    "n/amenity", "n/shop", "n/tourism", "n/historic", "n/name",
    "w/amenity", "w/shop", "w/tourism", "w/historic", "w/name",
    "r/amenity", "r/shop", "r/tourism", "r/historic", "r/name",
  ], { maxBuffer: 2 * 1024 * 1024 });
  await execFileAsync("osmium", ["export", filteredPath, "-o", geojsonPath, "--overwrite", "--add-unique-id", "type_id"], { maxBuffer: 2 * 1024 * 1024 });
  const geojson = JSON.parse(await readFile(geojsonPath, "utf8")) as { features?: unknown[] };
  if (!Array.isArray(geojson.features) || geojson.features.length === 0) {
    throw new Error("Geofabrik extract produced no features inside the Gers boundary");
  }
  const outputs: OsmBulkOutput[] = [
    { file: extractPath, sha256: await hashFile(extractPath), recordCount: await osmiumObjectCount(extractPath) },
    { file: filteredPath, sha256: await hashFile(filteredPath), recordCount: await osmiumObjectCount(filteredPath) },
    { file: geojsonPath, sha256: await hashFile(geojsonPath), recordCount: geojson.features.length },
  ];
  await writeFile(manifestPath, JSON.stringify({
    source: "OpenStreetMap contributors via Geofabrik",
    resource: OSM_BULK_URL,
    acquiredAt: new Date().toISOString(),
    license: "ODbL-1.0",
    crs: "EPSG:4326",
    sourceSha256,
    boundarySha256,
    featureCount: geojson.features.length,
    boundary: boundaryPath,
    method: "osmium extract and export",
    outputs,
    bytesDownloaded: outcome.bytesDownloaded,
    fromCache: outcome.fromCache,
    httpStatus: outcome.httpStatus,
    requestCount: outcome.requestCount,
    retryCount: outcome.retryCount,
  }, null, 2) + "\n", "utf8");
  console.log(`Bulk OSM extract: ${geojson.features.length} features`);
}


interface AuchOsmManifest {
  source: string;
  resource: string;
  sourceSha256: string;
  boundarySha256: string;
  extractSha256: string;
  geojsonSha256: string;
  extractFile: string;
  geojsonFile: string;
  featureCount: number;
  acquiredAt: string;
  checkedAt: string;
  bytesDownloaded: number;
  fromCache: boolean;
  httpStatus: number;
  requestCount: number;
  retryCount: number;
  extractSkipped: boolean;
  exportSkipped: boolean;
}

function parseAuchOsmManifest(value: unknown): AuchOsmManifest | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const strings = ["source", "resource", "sourceSha256", "boundarySha256", "extractSha256", "geojsonSha256", "extractFile", "geojsonFile", "acquiredAt", "checkedAt"];
  if (!strings.every((key) => typeof record[key] === "string")) return null;
  const numbers = ["featureCount", "bytesDownloaded", "httpStatus", "requestCount", "retryCount"];
  if (!numbers.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))) return null;
  if (typeof record.fromCache !== "boolean" || typeof record.extractSkipped !== "boolean" || typeof record.exportSkipped !== "boolean") return null;
  return record as unknown as AuchOsmManifest;
}

async function readAuchOsmManifest(filePath: string): Promise<AuchOsmManifest | null> {
  try {
    return parseAuchOsmManifest(JSON.parse(await readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

async function acquireAuchOsm(forceRefresh: boolean): Promise<void> {
  const upstreamPath = path.join(RAW_DIR, "midi-pyrenees-latest.osm.pbf");
  const boundaryPath = path.join(RAW_DIR, AUCH_DETAIL_SCOPE.boundaryRawFile);
  const extractPath = path.join(RAW_DIR, AUCH_DETAIL_SCOPE.osmExtractFile);
  const geojsonPath = path.join(RAW_DIR, AUCH_DETAIL_SCOPE.osmGeojsonFile);
  const manifestPath = path.join(INTERMEDIATE_DIR, "auch-osm-manifest.json");
  const outcome = await acquireFile({ url: OSM_BULK_URL, destination: upstreamPath, forceRefresh, headers: { Accept: "application/octet-stream" } });
  const boundarySha256 = await hashFile(boundaryPath);
  const previous = await readAuchOsmManifest(manifestPath);
  const outputFiles = [extractPath, geojsonPath];
  const reusable = !forceRefresh && previous !== null
    && previous.sourceSha256 === outcome.sha256
    && previous.boundarySha256 === boundarySha256
    && previous.extractSha256 === await hashFile(extractPath).catch(() => "")
    && previous.geojsonSha256 === await hashFile(geojsonPath).catch(() => "")
    && await outputsExist(outputFiles.map((file) => ({ file, sha256: "", recordCount: 0 })));
  if (reusable && previous !== null) {
    await writeFile(manifestPath, JSON.stringify({
      ...previous,
      checkedAt: outcome.checkedAt,
      bytesDownloaded: outcome.bytesDownloaded,
      fromCache: outcome.fromCache,
      httpStatus: outcome.httpStatus,
      requestCount: outcome.requestCount,
      retryCount: outcome.retryCount,
      extractSkipped: true,
      exportSkipped: true,
    }, null, 2) + "\n", "utf8");
    console.log(`Auch OSM extract unchanged: reusing both osmium outputs (fromCache=${outcome.fromCache}, httpStatus=${outcome.httpStatus}, bytesDownloaded=${outcome.bytesDownloaded})`);
    return;
  }
  await execFileAsync("osmium", ["extract", "-p", boundaryPath, "-s", "smart", upstreamPath, "-o", extractPath, "--overwrite", "--set-bounds"], { maxBuffer: 2 * 1024 * 1024 });
  await execFileAsync("osmium", ["export", extractPath, "-o", geojsonPath, "-O", "--add-unique-id", "type_id", "-a", "type,id", "--geometry-types", "point,linestring,polygon"], { maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(await readFile(geojsonPath, "utf8")) as { features?: unknown[] };
  if (!Array.isArray(parsed.features) || parsed.features.length === 0) throw new Error("Auch OSM extract produced no features inside the commune boundary");
  await writeFile(manifestPath, JSON.stringify({
    source: "OpenStreetMap contributors via Geofabrik",
    resource: OSM_BULK_URL,
    sourceSha256: outcome.sha256,
    boundarySha256,
    extractSha256: await hashFile(extractPath),
    geojsonSha256: await hashFile(geojsonPath),
    extractFile: extractPath,
    geojsonFile: geojsonPath,
    featureCount: parsed.features.length,
    acquiredAt: outcome.acquiredAt,
    checkedAt: outcome.checkedAt,
    bytesDownloaded: outcome.bytesDownloaded,
    fromCache: outcome.fromCache,
    httpStatus: outcome.httpStatus,
    requestCount: outcome.requestCount,
    retryCount: outcome.retryCount,
    extractSkipped: false,
    exportSkipped: false,
  }, null, 2) + "\n", "utf8");
  console.log(`Auch OSM extract: ${parsed.features.length} features`);
}


interface FetchOsmOptions {
  forceRefresh: boolean;
  auch: boolean;
}

function parseArgs(args: string[]): FetchOsmOptions {
  return {
    forceRefresh: args.includes("--force") || args.includes("--force-osm-pbf"),
    auch: args.includes("--auch"),
  };
}

async function main(): Promise<void> {
  const { forceRefresh, auch } = parseArgs(process.argv.slice(2));

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(INTERMEDIATE_DIR, { recursive: true });
  if (auch) {
    await acquireAuchOsm(forceRefresh);
    return;
  }
  await mkdir(INTERMEDIATE_DIR, { recursive: true });
  if (process.env.OSM_USE_OVERPASS !== "1") {
    await fetchBulkOsm(forceRefresh);
    return;
  }

  console.log("Loading the complete Gers boundary...");
  let boundaryGeometry: { type: string; coordinates: unknown } | null = null;
  let bbox: [number, number, number, number] | null = null;
  const candidatePaths = [
    path.join(RAW_DIR, "gers-boundary.geojson"),
    path.join(INTERMEDIATE_DIR, "boundary-source.json"),
  ];
  for (const filePath of candidatePaths) {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
      const record = parseBoundaryRecord(parsed);
      if (record) {
        boundaryGeometry = record.geometry;
        bbox = record.bbox;
        console.log(`  Loaded from ${filePath} (type=${boundaryGeometry.type})`);
        break;
      }
    } catch {
      continue;
    }
  }
  if (!boundaryGeometry) throw new Error(`Cannot find Gers boundary. Searched: ${candidatePaths.join(", ")}`);
  const boundaryBbox = bbox ?? geometryBbox(boundaryGeometry);
  const [west, south, east, north] = boundaryBbox;
  const bboxSelector = `bbox:${south},${west},${north},${east}`;
  console.log(`  Overpass fallback selector: ${bboxSelector}`);

  const manifest: OsmManifest = {
    dataset: "osm-gers",
    acquisitionTime: new Date().toISOString(),
    boundaryBbox,
    themeCount: THEMES.length,
    themes: {},
    totalQueries: THEMES.length,
    successfulQueries: 0,
    failedQueries: 0,
  };

  for (const theme of THEMES) {
    console.log(`\n[${theme.name}]`);
    const query = theme.queryTemplate("").replace(/\(poly:""\)/g, `(${bboxSelector})`);
    if (query.includes('poly:"')) throw new Error(`Overpass theme ${theme.name} did not use the bbox selector`);
    const rawPath = path.join(RAW_DIR, `osm-${theme.name}.json`);
    const result: ThemeResult = {
      query,
      endpointUrl: null,
      timestamp: "",
      recordCount: 0,
      byteSize: 0,
      sha256: "",
      retryCount: -1,
      success: false,
      error: null,
    };
    try {
      const { response, endpointUrl, retryCount } = await fetchOverpass(query);
      result.endpointUrl = endpointUrl;
      result.retryCount = retryCount;
      result.timestamp = new Date().toISOString();
      const rawJson = JSON.stringify(response);
      result.sha256 = crypto.createHash("sha256").update(rawJson, "utf8").digest("hex");
      result.byteSize = Buffer.byteLength(rawJson);
      const elements = typeof response === "object" && response !== null && "elements" in response ? response.elements : undefined;
      result.recordCount = Array.isArray(elements) ? elements.length : 0;
      await writeFile(rawPath, rawJson, "utf8");
      result.success = true;
      manifest.successfulQueries += 1;
      console.log(`  OK  ${result.recordCount} elements  ${(result.byteSize / 1024).toFixed(1)} KiB  ${endpointUrl}`);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      manifest.failedQueries += 1;
      console.error(`  FAIL  ${result.error}`);
    }
    manifest.themes[theme.name] = result;
    if (THEMES.indexOf(theme) < THEMES.length - 1) await sleep(INTER_REQUEST_DELAY_MS);
  }

  manifest.acquisitionTime = new Date().toISOString();
  await writeFile(path.join(INTERMEDIATE_DIR, "osm-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`\n=== OSM Acquisition Complete ===`);
  console.log(`  Successful: ${manifest.successfulQueries} / ${manifest.totalQueries}`);
  console.log(`  Failed:     ${manifest.failedQueries}`);
  if (manifest.failedQueries > 0) process.exit(1);
}
main().catch((error: unknown) => {
  console.error(`[fetch-osm] Fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
