#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeAll } from "./normalize";
import { deduplicateAll } from "./deduplicate";
import { buildTilesAll } from "./build-tiles";
import { buildIndexAll } from "./build-search-index";
import { validate } from "./validate";
import { runSpatialQa } from "./qa-spatial";
import { deduplicateOsmElements, isOsmElement } from "./osmRelations";
import { MapFeatureSchema, TileManifestSchema, type MapFeature } from "../../src/lib/data/schema";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

const execFileAsync = promisify(execFile);
const ROOT = process.env.MASTER_MAPS_DATA_DIR ?? "data";
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

interface FeatureSummary {
  totalFeatures: number;
  featureCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  layerAvailability: Record<string, boolean>;
}

function parseArgs(args: string[]): RefreshOptions {
  return { offline: args.includes("--offline"), forceIgn: args.includes("--force-ign") };
}

async function ensureDirs(): Promise<void> {
  for (const directory of [RAW_DIR, INTERMEDIATE_DIR, GENERATED_DIR, TILES_DIR, SEARCH_DIR, MANIFESTS_DIR, QA_DIR]) await fs.mkdir(directory, { recursive: true });
}

async function withRetry<T>(operation: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastError: unknown = undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const delay = 1000 * 2 ** (attempt - 1);
      console.error(`[refresh] ${label} failed on attempt ${attempt}, retrying in ${delay}ms`);
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, delay);
      await wait.promise;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

async function runScript(scriptName: string, args: string[] = []): Promise<void> {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), scriptName);
  const result = await execFileAsync("tsx", [scriptPath, ...args], { env: { ...process.env, MASTER_MAPS_DATA_DIR: ROOT }, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

async function phaseBoundary(offline: boolean): Promise<void> {
  const boundaryPath = path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile);
  if (offline) {
    await fs.access(boundaryPath);
    return;
  }
  await withRetry(() => runScript("fetch-admin-express.ts"), "Admin Express");
}

async function phaseBdtopo(offline: boolean): Promise<void> {
  const manifestPath = path.join(INTERMEDIATE_DIR, "bdtopo-manifest.json");
  if (offline) {
    await fs.access(manifestPath);
    return;
  }
  await withRetry(() => runScript("fetch-bdtopo.ts"), "BD TOPO", 2);
}

async function phaseOsm(offline: boolean): Promise<void> {
  if (offline) return;
  await withRetry(() => runScript("fetch-osm.ts"), "Geofabrik OSM", 2);
}

async function mergeOverpassThemes(): Promise<void> {
  const bulkPath = path.join(RAW_DIR, "osm-bulk.geojson");
  try {
    await fs.access(bulkPath);
    return;
  } catch {
    /* Overpass merge is used only when the preferred bulk extract is unavailable. */
  }
  const names = (await fs.readdir(RAW_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^osm-[^/]+\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    await fs.access(path.join(RAW_DIR, "osm.json"));
    return;
  }
  const merged: import("./osmRelations").OsmElement[] = [];
  let timestamp = "";
  for (const name of names) {
    const parsed = JSON.parse(await fs.readFile(path.join(RAW_DIR, name), "utf8")) as { elements?: Record<string, unknown>[]; timestamp?: string; osm3s?: { timestamp_osm_base?: string } };
    if (Array.isArray(parsed.elements)) merged.push(...parsed.elements.filter(isOsmElement));
    timestamp = parsed.timestamp ?? parsed.osm3s?.timestamp_osm_base ?? timestamp;
  }
  const elements = deduplicateOsmElements(merged);
  if (elements.length === 0) throw new Error("Overpass fallback produced no OSM elements");
  await fs.writeFile(path.join(RAW_DIR, "osm.json"), JSON.stringify({ elements, timestamp, themeFiles: names }, null, 2) + "\n", "utf8");
}

async function phaseAddresses(offline: boolean): Promise<void> {
  const addressPath = path.join(RAW_DIR, "ban-addresses.json");
  if (offline) {
    await fs.access(addressPath);
    return;
  }
  await withRetry(() => runScript("fetch-addresses.ts"), "BAN", 2);
}

async function phaseBusinesses(offline: boolean): Promise<void> {
  const businessPath = path.join(RAW_DIR, "businesses-sirene.json");
  if (offline) {
    await fs.access(businessPath);
    return;
  }
  await withRetry(() => runScript("fetch-businesses.ts"), "businesses", 2);
}

async function phaseOptionalIgn(offline: boolean, forceIgn: boolean): Promise<void> {
  if (offline && !forceIgn) return;
  try {
    await withRetry(() => runScript("fetch-ign.ts"), "optional IGN elevation", 2);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await fs.writeFile(path.join(INTERMEDIATE_DIR, "ign-unavailable.json"), JSON.stringify({ sourceFamily: "ign-geoplateforme", reason, checkedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
    console.error(`[refresh] Optional IGN elevation unavailable: ${reason}`);
  }
}

async function readFeatureFiles(directory: string): Promise<MapFeature[]> {
  const ignored = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);
  const features: MapFeature[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || ignored.has(entry.name)) continue;
    const parsed = JSON.parse(await fs.readFile(path.join(directory, entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) features.push(MapFeatureSchema.parse(value));
  }
  return features;
}

async function collectFeatureSummary(): Promise<FeatureSummary> {
  const features = await readFeatureFiles(INTERMEDIATE_DIR);
  const featureCounts: Record<string, number> = {};
  const sourceCounts: Record<string, number> = {};
  const layerAvailability: Record<string, boolean> = {};
  for (const feature of features) {
    featureCounts[feature.kind] = (featureCounts[feature.kind] ?? 0) + 1;
    layerAvailability[feature.kind] = true;
    for (const reference of feature.sourceRefs) sourceCounts[reference.source] = (sourceCounts[reference.source] ?? 0) + 1;
  }
  return { totalFeatures: features.length, featureCounts, sourceCounts, layerAvailability };
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown; } catch { return null; }
}

function sourceBbox(value: unknown): [number, number, number, number] | null {
  if (typeof value !== "object" || value === null || !("features" in value) || !Array.isArray(value.features)) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    if (candidate.length >= 2 && typeof candidate[0] === "number" && typeof candidate[1] === "number") {
      west = Math.min(west, candidate[0]);
      south = Math.min(south, candidate[1]);
      east = Math.max(east, candidate[0]);
      north = Math.max(north, candidate[1]);
      return;
    }
    for (const child of candidate) visit(child);
  };
  for (const feature of value.features) if (typeof feature === "object" && feature !== null && "geometry" in feature && typeof feature.geometry === "object" && feature.geometry !== null && "coordinates" in feature.geometry) visit(feature.geometry.coordinates);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

function firstUrl(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.find((entry): entry is string => typeof entry === "string");
}
function sourceRecordCount(record: Record<string, unknown>): number | undefined {
  const direct = record.recordCount ?? record.featureCount;
  if (typeof direct === "number" && Number.isInteger(direct) && direct >= 0) return direct;
  if (!Array.isArray(record.outputs)) return undefined;
  const total = record.outputs.reduce((sum, value) => {
    if (typeof value !== "object" || value === null) return sum;
    const count = (value as Record<string, unknown>).recordCount;
    return typeof count === "number" && Number.isInteger(count) && count >= 0 ? sum + count : sum;
  }, 0);
  return total > 0 ? total : undefined;
}

async function writeSourceManifest(): Promise<void> {
  const records: Record<string, unknown>[] = [];
  const boundary = await readOptionalJson(path.join(INTERMEDIATE_DIR, "boundary-source.json"));
  const bdtopo = await readOptionalJson(path.join(INTERMEDIATE_DIR, "bdtopo-manifest.json"));
  const osm = await readOptionalJson(path.join(INTERMEDIATE_DIR, "osm-bulk-manifest.json"));
  for (const value of [boundary, bdtopo, osm]) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    records.push({ source: record.source, url: record.resource ?? record.download ?? record.catalog, edition: record.edition, timestamp: record.acquisitionTime ?? record.acquiredAt, license: record.license, sha256: record.sha256 ?? record.sourceSha256, recordCount: sourceRecordCount(record), status: "ok" });
  }
  for (const name of ["ban-addresses.json", "businesses-sirene.json", "businesses-osm.json", "businesses-web.json"]) {
    const value = await readOptionalJson(path.join(RAW_DIR, name));
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const url = typeof record.sourceUrl === "string" ? record.sourceUrl : firstUrl(record.sourceUrls);
    const resultCount = record.recordCount ?? record.totalUniqueRecords ?? record.elementCount ?? (Array.isArray(record.results) ? record.results.length : undefined);
    records.push({ source: name.replace(/\.json$/, ""), url, timestamp: record.acquisitionTimestamp ?? record.acquiredAt, license: record.license, sha256: typeof record.sha256 === "string" ? record.sha256 : undefined, recordCount: resultCount, status: record.status ?? "ok" });
  }
  const ignUnavailable = await readOptionalJson(path.join(INTERMEDIATE_DIR, "ign-unavailable.json"));
  const failedSources: Array<{ name: string; error?: string }> = [];
  if (typeof ignUnavailable === "object" && ignUnavailable !== null) {
    const marker = ignUnavailable as Record<string, unknown>;
    failedSources.push({ name: "ign-geoplateforme", error: String(marker.reason ?? "unavailable") });
  }
  const businessesOsm = await readOptionalJson(path.join(RAW_DIR, "businesses-osm.json"));
  if (typeof businessesOsm === "object" && businessesOsm !== null) {
    const marker = businessesOsm as Record<string, unknown>;
    if (marker.status !== "ok") failedSources.push({ name: "businesses-osm", error: String(marker.error ?? "optional source unavailable") });
  }
  const normalizationIssues = await readOptionalJson(path.join(INTERMEDIATE_DIR, "normalization-issues.json"));
  if (Array.isArray(normalizationIssues) && normalizationIssues.length > 0) failedSources.push({ name: "invalid-source-geometries", error: `${normalizationIssues.length} source records were excluded` });
  await fs.writeFile(path.join(MANIFESTS_DIR, "sources.json"), JSON.stringify({ datasetVersion: "0.1.0", acquisitionTime: new Date().toISOString(), territory: { code: GERS_TERRITORY.code, name: GERS_TERRITORY.name }, sources: records, failedSources, transformation: { interchangeCrs: GERS_TERRITORY.interchangeCrs, processingCrs: GERS_TERRITORY.processingCrs, renderOriginWgs84: GERS_TERRITORY.renderOriginWgs84, coordinateSystem: "EPSG:2154 easting/northing relative to render origin; Three.js [x,0,z]" } }, null, 2) + "\n", "utf8");
}

async function writeGenerationManifest(): Promise<void> {
  const summary = await collectFeatureSummary();
  const rawBoundary = await readOptionalJson(path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile));
  const boundary = sourceBbox(rawBoundary);
  if (!boundary) throw new Error("Cannot write manifest without a complete Gers boundary");
  const tileValues = await readOptionalJson(path.join(GENERATED_DIR, "tile-manifest.json"));
  if (!Array.isArray(tileValues) || tileValues.length === 0) throw new Error("Cannot write manifest without generated tiles");
  const tiles = tileValues.map((value) => TileManifestSchema.parse(value));
  const tileBounds = tiles.map((tile) => tile.bounds);
  const bounds = tiles.reduce<[number, number, number, number]>((accumulator, tile) => [Math.min(accumulator[0], tile.bounds[0]), Math.min(accumulator[1], tile.bounds[1]), Math.max(accumulator[2], tile.bounds[2]), Math.max(accumulator[3], tile.bounds[3])], tileBounds[0]!);
  const lods = [0, 1, 2].map((level) => ({ level, tileSize: level === 0 ? GERS_TERRITORY.detailedTileSize : level === 1 ? GERS_TERRITORY.regionalTileSize : GERS_TERRITORY.overviewTileSize, tileCount: tiles.filter((tile) => tile.lod === level).length }));
  const sources = await readOptionalJson(path.join(MANIFESTS_DIR, "sources.json"));
  const sourceRecords = typeof sources === "object" && sources !== null && Array.isArray((sources as Record<string, unknown>).sources) ? (sources as Record<string, unknown>).sources : undefined;
  const failedSources = typeof sources === "object" && sources !== null && Array.isArray((sources as Record<string, unknown>).failedSources)
    ? (sources as Record<string, unknown>).failedSources
    : undefined;
  const manifest = {
    version: "0.1.0",
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    territoryCode: GERS_TERRITORY.code,
    territoryName: GERS_TERRITORY.name,
    interchangeCrs: GERS_TERRITORY.interchangeCrs,
    processingCrs: GERS_TERRITORY.processingCrs,
    renderOrigin: GERS_TERRITORY.renderOriginWgs84,
    boundary,
    projectionOrigin: GERS_TERRITORY.renderOriginWgs84,
    bounds,
    tileSize: GERS_TERRITORY.detailedTileSize,
    tileCount: tiles.length,
    tileIds: tiles.map((tile) => tile.tileId),
    tileBounds,
    lods,
    featureCounts: summary.featureCounts,
    layerAvailability: summary.layerAvailability,
    pipeline: ["fetch-admin-express", "fetch-bdtopo", "fetch-osm", "fetch-addresses", "fetch-businesses", "fetch-ign", "normalize", "deduplicate", "build-tiles", "build-search-index", "qa-spatial", "validate"],
    sources: sourceRecords,
    failedSources,
  };
  await fs.writeFile(path.join(GENERATED_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

async function writeCoverageReport(): Promise<void> {
  const summary = await collectFeatureSummary();
  const tileValues = await readOptionalJson(path.join(GENERATED_DIR, "tile-manifest.json"));
  const sources = await readOptionalJson(path.join(MANIFESTS_DIR, "sources.json"));
  const tiles = Array.isArray(tileValues) ? tileValues.map((value) => TileManifestSchema.parse(value)) : [];
  const bytes = tiles.map((tile) => tile.byteSize).sort((first, second) => first - second);
  const maxTileBytes = bytes.length > 0 ? bytes[bytes.length - 1]! : 0;
  const report = {
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    boundary: sourceBbox(await readOptionalJson(path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile))) ?? GERS_TERRITORY.bootstrapBbox,
    projectionOrigin: GERS_TERRITORY.renderOriginWgs84,
    tileSize: GERS_TERRITORY.detailedTileSize,
    tileCount: tiles.length,
    totalFeatures: summary.totalFeatures,
    featureCounts: summary.featureCounts,
    sourceCounts: summary.sourceCounts,
    categories: summary.featureCounts,
    sources: summary.sourceCounts,
    unresolved: [],
    failedSources: (() => {
      const sourceManifest = sources;
      return typeof sourceManifest === "object" && sourceManifest !== null && Array.isArray((sourceManifest as Record<string, unknown>).failedSources)
        ? (sourceManifest as Record<string, unknown>).failedSources
        : [];
    })(),
    budgets: { tileBudgetBytes: 1024 * 1024, maxTileBytes: 2 * 1024 * 1024, totalTileCount: tiles.length, passes: maxTileBytes <= 2 * 1024 * 1024, largestTileBytes: maxTileBytes, policy: "LOD0 target 1 MiB and hard ceiling 2 MiB; coarser LODs are generalized" },
  };
  await fs.writeFile(path.join(MANIFESTS_DIR, "coverage.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
}

export async function refreshAll(options: RefreshOptions = { offline: false, forceIgn: false }): Promise<void> {
  const started = Date.now();
  await ensureDirs();
  console.error("[refresh] Gers department 32");
  await phaseBoundary(options.offline);
  await phaseBdtopo(options.offline);
  await phaseOsm(options.offline);
  await mergeOverpassThemes();
  await phaseAddresses(options.offline);
  await phaseBusinesses(options.offline);
  await phaseOptionalIgn(options.offline, options.forceIgn);
  await normalizeAll(RAW_DIR, INTERMEDIATE_DIR);
  await deduplicateAll(INTERMEDIATE_DIR, INTERMEDIATE_DIR);
  await buildTilesAll(INTERMEDIATE_DIR, TILES_DIR);
  await buildIndexAll(TILES_DIR, SEARCH_DIR);
  await writeSourceManifest();
  await writeCoverageReport();
  await writeGenerationManifest();
  await runSpatialQa();
  await validate(GENERATED_DIR);
  console.error(`[refresh] complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1]?.endsWith("refresh.ts")) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) console.log("Usage: tsx scripts/data/refresh.ts [--offline] [--force-ign]");
  else refreshAll(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error("[refresh] Fatal:", error);
    process.exit(1);
  });
}
