#!/usr/bin/env tsx
/**
 * refresh.ts — Entry point for the full data acquisition and generation
 * pipeline.  Runs the deterministic sequence:
 *
 *   1. discover-auch-boundary   (fetch commune contour from geo.api.gouv.fr)
 *   2. fetch-osm                (Overpass queries for roads, buildings, etc.)
 *   3. fetch-addresses          (BAN department data for commune 32013)
 *   4. fetch-businesses         (SIRENE / Annuaire / Moli-scraped records)
 *   5. fetch-ign                (IGN Géoplateforme terrain / building sources)
 *   6. normalize                (raw → typed features, clip to boundary)
 *   7. deduplicate              (stable-ID merge with source-priority)
 *   8. build-tiles              (benchmark & write tiles)
 *   9. build-search-index       (accent-insensitive search index)
 *  10. validate                 (structural checks on final output)
 *
 * Uses bounded exponential retry for transient HTTP failures.
 * Caches successful responses within one refresh session.
 * Writes manifests and coverage report.
 *
 * Usage: tsx scripts/data/refresh.ts [--offline] [--force-ign]
 *   --offline   skip network, use cached raw data
 *   --force-ign retry IGN even if previously unavailable
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Script imports — module scripts created in the same directory
// ---------------------------------------------------------------------------

import { normalizeAll } from "./normalize";
import { deduplicateAll } from "./deduplicate";
import { buildTilesAll } from "./build-tiles";
import { buildIndexAll } from "./build-search-index";
import { validate } from "./validate";
import { deduplicateOsmElements, isOsmElement } from "./osmRelations";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function scriptsDir(): string {
  return path.resolve(__dirname ?? "scripts/data");
}

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

const ROOT = dataRoot();
const RAW_DIR = path.join(ROOT, "raw");
const INTERMEDIATE_DIR = path.join(ROOT, "intermediate");
const GENERATED_DIR = path.join(ROOT, "generated");
const TILES_DIR = path.join(GENERATED_DIR, "tiles");
const SEARCH_DIR = path.join(ROOT, "search");
const MANIFESTS_DIR = path.join(ROOT, "manifests");
const QA_DIR = path.join(ROOT, "qa");

interface RefreshOptions {
  offline: boolean;
  forceIgn: boolean;
}

function parseArgs(args: string[]): RefreshOptions {
  let offline = false;
  let forceIgn = false;
  for (const a of args) {
    if (a === "--offline") offline = true;
    else if (a === "--force-ign") forceIgn = true;
  }
  return { offline, forceIgn };
}

// ---------------------------------------------------------------------------
// Bounded exponential retry
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
  baseDelayMs = 1000,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(`[refresh] ${label} attempt ${attempt} failed: ${err}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label}: exhausting retries`);
}

// ---------------------------------------------------------------------------
// In-session response cache
// ---------------------------------------------------------------------------

const responseCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

async function ensureDirs(): Promise<void> {
  const dirs = [RAW_DIR, INTERMEDIATE_DIR, GENERATED_DIR, TILES_DIR, SEARCH_DIR, MANIFESTS_DIR, QA_DIR];
  for (const d of dirs) {
    await fs.mkdir(d, { recursive: true });
  }
}

/** Run a sibling script via tsx subprocess. */
async function runScript(scriptName: string, extraArgs: string[] = []): Promise<void> {
  const scriptPath = path.join(scriptsDir(), scriptName);
  const { stderr } = await execFileAsync("tsx", [scriptPath, ...extraArgs], {
    env: { ...process.env, MASTER_MAPS_DATA_DIR: ROOT },
  });
  if (stderr) process.stderr.write(stderr);
}

async function phaseDiscoverBoundary(offline: boolean): Promise<void> {
  const boundaryPath = path.join(RAW_DIR, "gers-boundary.geojson");
  if (offline) {
    await fs.access(boundaryPath);
    console.error("[refresh] Offline: Gers boundary present");
    return;
  }
  await withRetry(() => runScript("fetch-admin-express.ts"), "fetch-admin-express");
}

async function phaseFetchBdtopo(offline: boolean): Promise<void> {
  if (offline) {
    await fs.access(path.join(INTERMEDIATE_DIR, "bdtopo-manifest.json"));
    console.error("[refresh] Offline: BD TOPO manifest present");
    return;
  }
  await withRetry(() => runScript("fetch-bdtopo.ts"), "fetch-bdtopo", 2, 2000);
}

/**
 * Combine per-theme Overpass responses (raw/osm-*.json) into the single
 * raw/osm.json the normalizer consumes.  Offline mode uses cached theme
 * files when available; a previously written osm.json is left untouched.
 */
async function phaseMergeOsm(): Promise<void> {
  const osmPath = path.join(RAW_DIR, "osm.json");
  try {
    await fs.access(path.join(RAW_DIR, "osm-bulk.geojson"));
    console.error("[refresh] Bulk OSM has priority over cached Overpass dumps");
    try { await fs.unlink(path.join(INTERMEDIATE_DIR, "osm-manifest.json")); } catch { /* no stale manifest */ }
    return;
  } catch {
    // Use bounded Overpass theme data only when bulk data is unavailable.
  }
  const themeFiles: string[] = [];
  try {
    const dir = await fs.readdir(RAW_DIR, { withFileTypes: true });
    for (const entry of dir) {
      if (entry.isFile() && /^osm-[^/]+\.json$/.test(entry.name)) themeFiles.push(entry.name);
    }
  } catch {
    throw new Error("Cannot inspect raw OSM directory");
  }
  if (themeFiles.length === 0) {
    try {
      await fs.access(path.join(RAW_DIR, "osm-bulk.geojson"));
      console.error("[refresh] Bulk OSM GeoJSON present; no Overpass merge required");
      return;
    } catch {
      await fs.access(osmPath);
      console.error("[refresh] Existing OSM JSON present");
      return;
    }
  }
  themeFiles.sort();
  const mergedElements: Record<string, unknown>[] = [];
  let recordedAt = "";
  for (const name of themeFiles) {
    const content = JSON.parse(await fs.readFile(path.join(RAW_DIR, name), "utf8")) as {
      elements?: Record<string, unknown>[];
      timestamp?: string;
      osm3s?: { timestamp_osm_base?: string };
    };
    if (Array.isArray(content.elements)) mergedElements.push(...content.elements);
    recordedAt = content.timestamp ?? content.osm3s?.timestamp_osm_base ?? recordedAt;
  }
  const elements = deduplicateOsmElements(mergedElements.filter(isOsmElement));
  await fs.writeFile(osmPath, JSON.stringify({ elements, timestamp: recordedAt, themeFiles, queryCount: themeFiles.length, rawElementCount: mergedElements.length }, null, 2), "utf8");
  console.error(`[refresh] merge-osm: ${mergedElements.length} raw elements, ${elements.length} unique elements`);
}
async function phaseFetchOsm(offline: boolean): Promise<void> {
  if (offline) {
    await phaseMergeOsm();
    return;
  }
  await withRetry(() => runScript("fetch-osm.ts"), "fetch-osm", 3, 2000);
  await phaseMergeOsm();
}

async function phaseFetchAddresses(offline: boolean): Promise<void> {
  if (offline) {
    for (const name of ["ban-addresses.json", "addresses.json"]) {
      try {
        await fs.access(path.join(RAW_DIR, name));
        console.error(`[refresh] Offline: addresses data present (${name})`);
        return;
      } catch { /* try next */ }
    }
    throw new Error("Offline mode requires raw/ban-addresses.json");
  }
  await withRetry(() => runScript("fetch-addresses.ts"), "fetch-addresses", 3, 2000);
}

async function phaseFetchBusinesses(offline: boolean): Promise<void> {
  if (offline) {
    for (const name of ["businesses-sirene.json", "businesses.json"]) {
      try {
        await fs.access(path.join(RAW_DIR, name));
        console.error(`[refresh] Offline: businesses data present (${name})`);
        return;
      } catch { /* try next */ }
    }
    throw new Error("Offline mode requires raw/businesses-sirene.json");
  }
  try {
    await fs.access(path.join(scriptsDir(), "fetch-businesses.ts"));
    await withRetry(() => runScript("fetch-businesses.ts"), "fetch-businesses", 3, 2000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[refresh] fetch-businesses acquisition failed: ${message}`);
  }
}

async function phaseFetchIgn(offline: boolean, forceIgn: boolean): Promise<void> {
  if (offline) {
    try {
      const dir = await fs.readdir(RAW_DIR, { withFileTypes: true });
      for (const entry of dir) {
        if (entry.isFile() && /^ign-[^/]+\.json$/.test(entry.name) && entry.name !== "ign-capabilities.json") {
          console.error(`[refresh] Offline: IGN data present (${entry.name})`);
          return;
        }
      }
    } catch { /* empty dir */ }
    console.error("[refresh] Offline: no cached IGN — writing unavailable");
    return;
  }
  if (!forceIgn) {
    try {
      const existing = await fs.readFile(path.join(RAW_DIR, "ign.json"), "utf8");
      const parsed = JSON.parse(existing) as { unavailable?: boolean };
      if (parsed.unavailable) {
        console.error("[refresh] IGN previously unavailable (use --force-ign to retry)");
        return;
      }
    } catch { /* continue */ }
  }
  try {
    await fs.access(path.join(scriptsDir(), "fetch-ign.ts"));
    await withRetry(() => runScript("fetch-ign.ts"), "fetch-ign", 3, 2000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[refresh] fetch-ign acquisition failed: ${message}`);
  }
}

async function phaseNormalize(): Promise<void> {
  console.error("[refresh] normalize...");
  await normalizeAll(RAW_DIR, INTERMEDIATE_DIR);
}

async function phaseDeduplicate(): Promise<void> {
  console.error("[refresh] deduplicate...");
  await deduplicateAll(INTERMEDIATE_DIR, INTERMEDIATE_DIR);
}

async function phaseBuildTiles(): Promise<void> {
  console.error("[refresh] build-tiles...");
  await buildTilesAll(INTERMEDIATE_DIR, TILES_DIR);
}

async function phaseBuildSearchIndex(): Promise<void> {
  console.error("[refresh] build-search-index...");
  await buildIndexAll(TILES_DIR, SEARCH_DIR);
}

async function phaseValidate(): Promise<void> {
  console.error("[refresh] validate...");
  await validate(GENERATED_DIR);
}

// ---------------------------------------------------------------------------
// Manifest writing
// ---------------------------------------------------------------------------

interface FeatureSummary {
  totalFeatures: number;
  featureCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  layerAvailability: Record<string, boolean>;
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function sourceBbox(value: unknown): [number, number, number, number] | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.type === "FeatureCollection" && Array.isArray(record.features)) {
    const boxes = record.features.map((feature) => sourceBbox(feature));
    const valid = boxes.filter((box): box is [number, number, number, number] => box !== null);
    if (valid.length === 0) return null;
    return valid.reduce(
      (acc, box) => [
        Math.min(acc[0], box[0]),
        Math.min(acc[1], box[1]),
        Math.max(acc[2], box[2]),
        Math.max(acc[3], box[3]),
      ],
      valid[0],
    );
  }
  if (record.type === "Feature") return sourceBbox(record.geometry);
  const type = record.type;
  const coordinates = record.coordinates;
  if (
    typeof type !== "string"
    || !Array.isArray(coordinates)
  ) {
    return null;
  }
  const points: [number, number][] = [];
  const collect = (valueToScan: unknown): void => {
    if (!Array.isArray(valueToScan)) return;
    if (
      valueToScan.length >= 2
      && typeof valueToScan[0] === "number"
      && typeof valueToScan[1] === "number"
      && Number.isFinite(valueToScan[0])
      && Number.isFinite(valueToScan[1])
    ) {
      points.push([valueToScan[0], valueToScan[1]]);
      return;
    }
    for (const child of valueToScan) collect(child);
  };
  collect(coordinates);
  if (points.length === 0) return null;
  return points.reduce(
    (acc, point) => [
      Math.min(acc[0], point[0]),
      Math.min(acc[1], point[1]),
      Math.max(acc[2], point[0]),
      Math.max(acc[3], point[1]),
    ],
    [points[0][0], points[0][1], points[0][0], points[0][1]] as [number, number, number, number],
  );
}

async function collectFeatureSummary(): Promise<FeatureSummary> {
  const featureCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const layerAvailability: Record<string, boolean> = {};
  const directory = await fs.readdir(INTERMEDIATE_DIR, { withFileTypes: true });
  let totalFeatures = 0;
  const ignored = new Set(["provenance.json", "boundary-source.json", "ign-unavailable.json", "osm-manifest.json", "relation-issues.json"]);

  for (const entry of directory) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || ignored.has(entry.name)) continue;
    const parsed = await readOptionalJson(path.join(INTERMEDIATE_DIR, entry.name));
    if (!Array.isArray(parsed)) continue;
    for (const feature of parsed) {
      if (typeof feature !== "object" || feature === null) continue;
      const record = feature as Record<string, unknown>;
      const kind = typeof record.kind === "string" ? record.kind : "unknown";
      totalFeatures += 1;
      featureCounts[kind] = (featureCounts[kind] ?? 0) + 1;
      layerAvailability[kind] = true;
      if (Array.isArray(record.sourceRefs)) {
        for (const sourceRef of record.sourceRefs) {
          if (typeof sourceRef !== "object" || sourceRef === null) continue;
          const source = (sourceRef as Record<string, unknown>).source;
          if (typeof source !== "string" || source.length === 0) continue;
          sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
        }
      }
    }
  }

  return { totalFeatures, featureCounts, sourceCounts, layerAvailability };
}

async function failedSourceSummary(): Promise<{ failed: string[]; unresolved: string[] }> {
  const failed: string[] = [];
  const unresolved: string[] = [];
  const osmManifest = await readOptionalJson(path.join(INTERMEDIATE_DIR, "osm-manifest.json"));
  if (typeof osmManifest === "object" && osmManifest !== null) {
    const themes = (osmManifest as Record<string, unknown>).themes;
    if (typeof themes === "object" && themes !== null) {
      for (const [name, value] of Object.entries(themes)) {
        if (typeof value !== "object" || value === null) continue;
        const result = value as Record<string, unknown>;
        if (result.success === false) {
          failed.push(`osm:${name}: ${String(result.error ?? "acquisition failed")}`);
        }
      }
    }
  }

  const businessOsm = await readOptionalJson(path.join(RAW_DIR, "businesses-osm.json"));
  if (typeof businessOsm === "object" && businessOsm !== null) {
    const result = businessOsm as Record<string, unknown>;
    if (result.status !== "ok") {
      failed.push(`businesses-osm: ${String(result.error ?? "acquisition failed")}`);
    }
  }

  const ignUnavailable = await readOptionalJson(path.join(INTERMEDIATE_DIR, "ign-unavailable.json"));
  if (typeof ignUnavailable === "object" && ignUnavailable !== null) {
    const reason = (ignUnavailable as Record<string, unknown>).reason;
    if (typeof reason === "string" && reason.length > 0) unresolved.push(`ign: ${reason}`);
  }

  const relationIssues = await readOptionalJson(path.join(INTERMEDIATE_DIR, "relation-issues.json"));
  if (Array.isArray(relationIssues)) {
    for (const issue of relationIssues) {
      if (typeof issue !== "object" || issue === null) continue;
      const record = issue as Record<string, unknown>;
      unresolved.push(`osm:relation/${String(record.relationId)}: ${String(record.reason ?? "malformed relation")}`);
    }
  }
  return { failed, unresolved };
}

async function writeSourceManifest(): Promise<void> {
  const existing = await readOptionalJson(path.join(MANIFESTS_DIR, "sources.json"));
  const sources: Record<string, unknown>[] =
    typeof existing === "object"
    && existing !== null
    && Array.isArray((existing as Record<string, unknown>).sources)
      ? ((existing as Record<string, unknown>).sources as Record<string, unknown>[]).slice()
      : [];

  const osmManifest = await readOptionalJson(path.join(INTERMEDIATE_DIR, "osm-manifest.json"));
  if (typeof osmManifest === "object" && osmManifest !== null) {
    const themes = (osmManifest as Record<string, unknown>).themes;
    if (typeof themes === "object" && themes !== null) {
      for (const [name, value] of Object.entries(themes)) {
        if (typeof value !== "object" || value === null) continue;
        const result = value as Record<string, unknown>;
        sources.push({
          source: `OpenStreetMap / Overpass (${name})`,
          url: result.endpointUrl,
          timestamp: result.timestamp,
          license: "ODbL-1.0",
          recordCount: result.recordCount ?? 0,
          status: result.success === false ? "failed" : "ok",
          error: result.error ?? undefined,
        });
      }
    }
  }

  const sirene = await readOptionalJson(path.join(RAW_DIR, "businesses-sirene.json"));
  if (typeof sirene === "object" && sirene !== null) {
    const record = sirene as Record<string, unknown>;
    sources.push({
      source: "Annuaire des Entreprises / SIRENE",
      url: record.sourceUrl,
      timestamp: record.acquiredAt,
      license: record.license,
      recordCount: record.totalUniqueRecords ?? 0,
      status: "ok",
    });
  }

  const businessOsm = await readOptionalJson(path.join(RAW_DIR, "businesses-osm.json"));
  if (typeof businessOsm === "object" && businessOsm !== null) {
    const record = businessOsm as Record<string, unknown>;
    sources.push({
      source: "OpenStreetMap / Overpass (businesses)",
      url: Array.isArray(record.sourceUrls) ? record.sourceUrls[0] : undefined,
      timestamp: record.acquiredAt,
      license: record.license,
      recordCount: record.elementCount ?? 0,
      status: record.status === "ok" ? "ok" : "failed",
      error: record.error ?? undefined,
    });
  }

  const businessWeb = await readOptionalJson(path.join(RAW_DIR, "businesses-web.json"));
  if (typeof businessWeb === "object" && businessWeb !== null) {
    const results = (businessWeb as Record<string, unknown>).results;
    sources.push({
      source: "Verified business websites and directories",
      timestamp: (businessWeb as Record<string, unknown>).acquiredAt,
      recordCount: Array.isArray(results) ? results.length : 0,
      status: "ok",
    });
  }

  for (const fileName of ["boundary-source.json", "bdtopo-manifest.json", "osm-bulk-manifest.json"]) {
    const record = await readOptionalJson(path.join(INTERMEDIATE_DIR, fileName));
    if (typeof record !== "object" || record === null) continue;
    const value = record as Record<string, unknown>;
    sources.push({
      source: value.source ?? (fileName === "boundary-source.json" ? "IGN ADMIN EXPRESS COG" : "OpenStreetMap contributors via Geofabrik"),
      url: value.resource,
      edition: value.edition,
      timestamp: value.acquisitionTime ?? value.acquiredAt,
      license: value.license,
      crs: value.sourceCrs ?? value.crs,
      sha256: value.sha256 ?? value.sourceSha256,
      recordCount: value.recordCount ?? value.featureCount ?? 0,
      status: "ok",
    });
  }
  const { failed } = await failedSourceSummary();
  const uniqueSources = [...new Map(
    sources.map((source) => [
      `${String(source.source ?? "unknown")}|${String(source.url ?? "")}`,
      source,
    ]),
  ).values()];
  const manifest = {
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    sources: uniqueSources,
    failedSources: failed,
    transformation: {
      processingCrs: GERS_TERRITORY.processingCrs,
      renderOrigin: GERS_TERRITORY.renderOriginWgs84,
      coordinateSystem: "EPSG:2154 easting/northing relative to render origin; Three.js [x,0,z]",
      geometryContract: "source WGS84 geometry and derived Lambert-93 render geometry are both retained",
    },
  };
  await fs.writeFile(path.join(MANIFESTS_DIR, "sources.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.error("[refresh] Source manifest written");
}

async function writeCoverageReport(): Promise<void> {
  const summary = await collectFeatureSummary();
  const tileManifest = await readOptionalJson(path.join(GENERATED_DIR, "tile-manifest.json"));
  const tiles = Array.isArray(tileManifest) ? tileManifest as Array<Record<string, unknown>> : [];
  const actualMaxTileBytes = tiles.reduce((max, tile) => {
    const bytes = typeof tile.byteSize === "number" ? tile.byteSize : 0;
    return Math.max(max, bytes);
  }, 0);
  const { failed, unresolved } = await failedSourceSummary();
  const report = {
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    totalFeatures: summary.totalFeatures,
    featureCounts: summary.featureCounts,
    sourceCounts: summary.sourceCounts,
    categories: summary.featureCounts,
    sources: summary.sourceCounts,
    unresolved,
    failedSources: failed,
    budgets: {
      policy: "viewport working set and per-tile byte size; no global tile-count cap",
      maxTileBytesLimit: 8 * 1024 * 1024,
      actualTileCount: tiles.length,
      actualMaxTileBytes,
      withinBudget: actualMaxTileBytes <= 8 * 1024 * 1024,
    },
  };
  await fs.writeFile(path.join(MANIFESTS_DIR, "coverage.json"), JSON.stringify(report, null, 2), "utf8");
  console.error("[refresh] Coverage report written");
}

async function writeGenerationManifest(): Promise<void> {
  const summary = await collectFeatureSummary();
  const tileManifest = await readOptionalJson(path.join(GENERATED_DIR, "tile-manifest.json"));
  const tiles = Array.isArray(tileManifest) ? tileManifest as Array<Record<string, unknown>> : [];
  const boundary = await readOptionalJson(path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile));
  const boundaryBbox = sourceBbox(boundary);
  if (!boundaryBbox) throw new Error("Cannot write generation manifest without a valid Gers boundary bbox");
  const firstBounds = tiles[0]?.bounds;
  const tileSize = Array.isArray(firstBounds) && typeof firstBounds[2] === "number" && typeof firstBounds[0] === "number"
    ? firstBounds[2] - firstBounds[0] : 0;
  const lods = [...new Set(tiles.map((tile) => Number(tile.lod ?? 0)))].sort((a, b) => a - b).map((level) => ({
    level,
    tileSize: level === 0 ? GERS_TERRITORY.detailedTileSize : level === 1 ? GERS_TERRITORY.regionalTileSize : GERS_TERRITORY.overviewTileSize,
    tileCount: tiles.filter((tile) => Number(tile.lod ?? 0) === level).length,
  }));
  const manifest = {
    version: "0.1.0",
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    territoryCode: GERS_TERRITORY.code,
    territoryName: GERS_TERRITORY.name,
    interchangeCrs: GERS_TERRITORY.interchangeCrs,
    processingCrs: GERS_TERRITORY.processingCrs,
    renderOrigin: GERS_TERRITORY.renderOriginWgs84,
    boundary: boundaryBbox,
    projectionOrigin: GERS_TERRITORY.renderOriginWgs84,
    tileSize,
    tileCount: tiles.length,
    tileBounds: tiles.map((tile) => tile.bounds),
    lods,
    featureCounts: summary.featureCounts,
    layerAvailability: summary.layerAvailability,
    pipeline: [
      "fetch-admin-express", "fetch-bdtopo", "fetch-osm", "fetch-addresses",
      "fetch-businesses", "fetch-ign", "normalize", "deduplicate", "build-tiles",
      "build-search-index", "validate",
    ],
  };
  await fs.writeFile(path.join(GENERATED_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function refreshAll(options?: RefreshOptions): Promise<void> {
  const opts = options ?? { offline: false, forceIgn: false };
  console.error("[refresh] Starting Gers department 32 data refresh");
  const start = Date.now();
  await ensureDirs();
  console.error("[refresh] Phase 1/11: fetch-admin-express");
  await phaseDiscoverBoundary(opts.offline);
  console.error("[refresh] Phase 2/11: fetch-bdtopo");
  await phaseFetchBdtopo(opts.offline);
  console.error("[refresh] Phase 3/11: fetch-osm");
  await phaseFetchOsm(opts.offline);
  console.error("[refresh] Phase 4/11: fetch-addresses");
  await phaseFetchAddresses(opts.offline);
  console.error("[refresh] Phase 5/11: fetch-businesses");
  await phaseFetchBusinesses(opts.offline);
  console.error("[refresh] Phase 6/11: fetch-ign-elevation");
  await phaseFetchIgn(opts.offline, opts.forceIgn);
  console.error("[refresh] Phase 7/11: normalize");
  await phaseNormalize();
  console.error("[refresh] Phase 8/11: deduplicate");
  await phaseDeduplicate();
  console.error("[refresh] Phase 9/11: build-tiles");
  await phaseBuildTiles();
  console.error("[refresh] Phase 10/11: build-search-index");
  await phaseBuildSearchIndex();
  console.error("[refresh] Phase 11/11: validate");
  await phaseValidate();
  await writeSourceManifest();
  await writeCoverageReport();
  await writeGenerationManifest();
  console.error(`[refresh] Complete (${((Date.now() - start) / 1000).toFixed(1)}s)`);
}

// ---------------------------------------------------------------------------
// CLI entry — guarded so module import doesn't auto-run
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("refresh.ts")) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: tsx scripts/data/refresh.ts [--offline] [--force-ign]");
  } else {
    refreshAll(parseArgs(args)).catch((err) => {
      console.error("[refresh] Fatal:", err);
      process.exit(1);
    });
  }
}