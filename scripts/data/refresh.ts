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
import { AUCH_DETAIL_SCOPE, GERS_TERRITORY } from "../../src/lib/data/territory";
const execFileAsync = promisify(execFile);

const DATA_ROOT = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const ACQUISITION_INTERMEDIATE_DIR = path.join(DATA_ROOT, "intermediate");

interface RefreshPaths {
  scope: "gers" | "auch";
  rawDir: string;
  intermediateDir: string;
  generatedDir: string;
  tilesDir: string;
  searchDir: string;
  manifestsDir: string;
  qaDir: string;
  boundaryFile: string;
  territoryCode: string;
  territoryName: string;
}

function createPaths(scope: "gers" | "auch"): RefreshPaths {
  const outputRoot = scope === "auch" ? path.join(DATA_ROOT, "auch") : DATA_ROOT;
  return {
    scope,
    rawDir: path.join(DATA_ROOT, "raw"),
    intermediateDir: path.join(outputRoot, "intermediate"),
    generatedDir: path.join(outputRoot, "generated"),
    tilesDir: path.join(outputRoot, "generated", "tiles"),
    searchDir: path.join(outputRoot, "search"),
    manifestsDir: path.join(outputRoot, "manifests"),
    qaDir: path.join(outputRoot, "qa"),
    boundaryFile: scope === "auch" ? AUCH_DETAIL_SCOPE.boundaryRawFile : GERS_TERRITORY.boundaryRawFile,
    territoryCode: scope === "auch" ? AUCH_DETAIL_SCOPE.code : GERS_TERRITORY.code,
    territoryName: scope === "auch" ? AUCH_DETAIL_SCOPE.name : GERS_TERRITORY.name,
  };
}

interface RefreshOptions {
  offline: boolean;
  forceIgn: boolean;
  force: Set<string>;
  scope: "gers" | "auch";
}

const VALID_FORCE_SOURCES = new Set(["admin-express", "bdtopo", "osm", "ban", "businesses", "ign"]);

interface FeatureSummary {
  totalFeatures: number;
  featureCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  layerAvailability: Record<string, boolean>;
}

function parseArgs(args: string[]): RefreshOptions {
  const force = new Set<string>();
  for (const argument of args) {
    if (!argument.startsWith("--force=")) continue;
    for (const source of argument.slice("--force=".length).split(",").map((value) => value.trim()).filter(Boolean)) {
      if (!VALID_FORCE_SOURCES.has(source)) throw new Error(`Unsupported force source "${source}"`);
      force.add(source);
    }
  }
  const scopeArgument = args.find((argument) => argument.startsWith("--scope="));
  const scopeValue = scopeArgument?.slice("--scope=".length) ?? "gers";
  if (scopeValue !== "gers" && scopeValue !== "auch") throw new Error(`Unsupported scope "${scopeValue}"`);
  return { offline: args.includes("--offline"), forceIgn: args.includes("--force-ign"), force, scope: scopeValue };
}

async function ensureDirs(paths: RefreshPaths): Promise<void> {
  for (const directory of [
    paths.rawDir,
    ACQUISITION_INTERMEDIATE_DIR,
    paths.intermediateDir,
    paths.generatedDir,
    paths.tilesDir,
    paths.searchDir,
    paths.manifestsDir,
    paths.qaDir,
  ]) await fs.mkdir(directory, { recursive: true });

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

async function runScript(paths: RefreshPaths, scriptName: string, args: string[] = []): Promise<void> {
  const scriptPath = path.join(path.dirname(new URL(import.meta.url).pathname), scriptName);
  const result = await execFileAsync("tsx", [scriptPath, ...args], { env: { ...process.env, MASTER_MAPS_DATA_DIR: DATA_ROOT }, maxBuffer: 16 * 1024 * 1024 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

}
function forceArgs(options: RefreshOptions, source: string): string[] {
  return options.force.has(source) ? ["--force"] : [];
}
async function phaseBoundary(paths: RefreshPaths, options: RefreshOptions): Promise<void> {
  const boundaryPath = path.join(paths.rawDir, paths.boundaryFile);
  const args = paths.scope === "auch" ? ["--commune", AUCH_DETAIL_SCOPE.code, ...forceArgs(options, "admin-express")] : forceArgs(options, "admin-express");
  if (options.offline) {
    await fs.access(boundaryPath);
    return;
  }
  await withRetry(() => runScript(paths, "fetch-admin-express.ts", args), "Admin Express");

}
async function phaseBdtopo(paths: RefreshPaths, options: RefreshOptions): Promise<void> {
  const manifestPath = path.join(paths.intermediateDir, "bdtopo-manifest.json");
  if (options.offline) {
    await fs.access(manifestPath);
    return;
  }
  const args = paths.scope === "auch" ? ["--scope=auch", ...forceArgs(options, "bdtopo")] : forceArgs(options, "bdtopo");
  await withRetry(() => runScript(paths, "fetch-bdtopo.ts", args), "BD TOPO", 2);

}
async function phaseOsm(paths: RefreshPaths, options: RefreshOptions): Promise<void> {
  if (options.offline) {
    if (paths.scope === "auch") {
      await fs.access(path.join(paths.rawDir, AUCH_DETAIL_SCOPE.osmExtractFile));
      await fs.access(path.join(paths.rawDir, AUCH_DETAIL_SCOPE.osmGeojsonFile));
    }
    return;
  }
  const args = paths.scope === "auch" ? ["--auch", ...forceArgs(options, "osm")] : forceArgs(options, "osm");
  await withRetry(() => runScript(paths, "fetch-osm.ts", args), "Geofabrik OSM", 2);

}
async function mergeOverpassThemes(paths: RefreshPaths): Promise<void> {
  if (paths.scope === "auch") return;
  const bulkPath = path.join(paths.rawDir, "osm-bulk.geojson");
  try {
    await fs.access(bulkPath);
    return;
  } catch {
  }
  const names = (await fs.readdir(paths.rawDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^osm-[^/]+\.json$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (names.length === 0) {
    await fs.access(path.join(paths.rawDir, "osm.json"));
    return;
  }
  const merged: import("./osmRelations").OsmElement[] = [];
  let timestamp = "";
  for (const name of names) {
    const parsed = JSON.parse(await fs.readFile(path.join(paths.rawDir, name), "utf8")) as { elements?: Record<string, unknown>[]; timestamp?: string; osm3s?: { timestamp_osm_base?: string } };
    if (Array.isArray(parsed.elements)) merged.push(...parsed.elements.filter(isOsmElement));
    timestamp = parsed.timestamp ?? parsed.osm3s?.timestamp_osm_base ?? timestamp;
  }
  const elements = deduplicateOsmElements(merged);
  if (elements.length === 0) throw new Error("Overpass fallback produced no OSM elements");
  await fs.writeFile(path.join(paths.rawDir, "osm.json"), JSON.stringify({ elements, timestamp, themeFiles: names }, null, 2) + "\n", "utf8");
}

async function phaseAddresses(paths: RefreshPaths, options: RefreshOptions): Promise<void> {
  const addressPath = path.join(paths.rawDir, paths.scope === "auch" ? "ban-addresses-auch.json" : "ban-addresses.json");
  if (options.offline) {
    await fs.access(addressPath);
    return;
  }
  const args = paths.scope === "auch" ? ["--commune", AUCH_DETAIL_SCOPE.code, ...forceArgs(options, "ban")] : forceArgs(options, "ban");
  await withRetry(() => runScript(paths, "fetch-addresses.ts", args), "BAN", 2);

}
async function phaseBusinesses(paths: RefreshPaths, options: RefreshOptions): Promise<void> {
  const businessPath = path.join(paths.rawDir, "businesses-sirene.json");
  if (options.offline) {
    await fs.access(businessPath);
    return;
  }
  const args = paths.scope === "auch" ? ["--commune", AUCH_DETAIL_SCOPE.code, ...forceArgs(options, "businesses")] : ["--departement", ...forceArgs(options, "businesses")];
  await withRetry(() => runScript(paths, "fetch-businesses.ts", args), "businesses", 2);
}
async function phaseOptionalIgn(paths: RefreshPaths, options: RefreshOptions): Promise<void> {
  if (paths.scope === "auch" || (options.offline && !options.forceIgn)) return;
  const args = options.forceIgn || options.force.has("ign") ? ["--force"] : [];
  try {
    await withRetry(() => runScript(paths, "fetch-ign.ts", args), "optional IGN elevation", 2);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await fs.writeFile(path.join(paths.intermediateDir, "ign-unavailable.json"), JSON.stringify({ sourceFamily: "ign-geoplateforme", reason, checkedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
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

async function collectFeatureSummary(paths: RefreshPaths): Promise<FeatureSummary> {
  const features = await readFeatureFiles(paths.intermediateDir);
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

async function writeSourceManifest(paths: RefreshPaths): Promise<void> {
  const records: Record<string, unknown>[] = [];
  const acquisitionManifest = await readOptionalJson(path.join(DATA_ROOT, "manifests", "sources.json"));
  const previousSources = typeof acquisitionManifest === "object" && acquisitionManifest !== null && Array.isArray((acquisitionManifest as Record<string, unknown>).sources)
    ? (acquisitionManifest as Record<string, unknown>).sources.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null)
    : [];
  const previousFor = (source: string): Record<string, unknown> | undefined => previousSources.find((value) => value.source === source);
  const appendManifest = (value: unknown, fallbackSource: string): void => {
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    const source = typeof record.source === "string" ? record.source : fallbackSource;
    const previous = previousFor(source);
    records.push({
      source,
      url: typeof (record.resource ?? record.download ?? record.catalog ?? record.url) === "string" ? record.resource ?? record.download ?? record.catalog ?? record.url : undefined,
      edition: record.edition,
      timestamp: typeof (record.acquisitionTime ?? record.acquiredAt) === "string" ? record.acquisitionTime ?? record.acquiredAt : new Date().toISOString(),
      license: record.license,
      sha256: typeof (record.sha256 ?? record.sourceSha256) === "string" ? record.sha256 ?? record.sourceSha256 : undefined,
      recordCount: sourceRecordCount(record) ?? 0,
      status: "ok",
      cached: record.fromCache === true || previous?.fromCache === true,
      fromCache: record.fromCache,
      etag: record.etag,
      lastModified: record.lastModified,
      bytesDownloaded: record.bytesDownloaded,
      requestCount: record.requestCount,
      retryCount: record.retryCount,
      rateLimitCount: record.rateLimitCount,
      filteredRecordCount: record.filteredRecordCount,
      retainedRecordCount: record.retainedRecordCount,
    });
  };
  const boundaryFile = paths.scope === "auch" ? AUCH_DETAIL_SCOPE.boundarySourceFile : "boundary-source.json";
  const boundary = await readOptionalJson(path.join(ACQUISITION_INTERMEDIATE_DIR, boundaryFile));
  const bdtopo = await readOptionalJson(path.join(paths.intermediateDir, "bdtopo-manifest.json"));
  const osm = paths.scope === "auch"
    ? await readOptionalJson(path.join(ACQUISITION_INTERMEDIATE_DIR, "auch-osm-manifest.json"))
    : await readOptionalJson(path.join(ACQUISITION_INTERMEDIATE_DIR, "osm-bulk-manifest.json"));
  appendManifest(boundary, paths.scope === "auch" ? "admin-express-32013" : "admin-express");
  appendManifest(bdtopo, paths.scope === "auch" ? "bdtopo-auch" : "bdtopo");
  appendManifest(osm, paths.scope === "auch" ? "osm-auch" : "osm");
  const rawNames = paths.scope === "auch"
    ? ["ban-addresses-auch.json", "businesses-sirene.json", "businesses-osm.json", "businesses-web.json"]
    : ["ban-addresses.json", "businesses-sirene.json", "businesses-osm.json", "businesses-web.json"];
  for (const name of rawNames) {
    const value = await readOptionalJson(path.join(paths.rawDir, name));
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const source = name.replace(/\.json$/, "");
    const previous = previousFor(source);
    const url = typeof record.sourceUrl === "string" ? record.sourceUrl : firstUrl(record.sourceUrls);
    const resultCountValue = record.recordCount ?? record.totalUniqueRecords ?? record.elementCount ?? (Array.isArray(record.results) ? record.results.length : undefined);
    const resultCount = typeof resultCountValue === "number" && Number.isInteger(resultCountValue) && resultCountValue >= 0 ? resultCountValue : 0;
    records.push({
      source,
      url,
      timestamp: record.acquisitionTimestamp ?? record.acquiredAt,
      license: record.license,
      sha256: typeof record.sha256 === "string" ? record.sha256 : undefined,
      recordCount: resultCount,
      status: record.status ?? "ok",
      cached: record.fromCache === true || previous?.fromCache === true,
      fromCache: record.fromCache,
      bytesDownloaded: record.bytesDownloaded,
      requestCount: record.requestCount,
      retryCount: record.retryCount,
      rateLimitCount: record.rateLimitCount,
      retainedRecordCount: record.retainedRecordCount,
    });
  }
  const ignUnavailable = await readOptionalJson(path.join(paths.intermediateDir, "ign-unavailable.json"));
  const failedSources: Array<{ name: string; error?: string }> = [];
  if (typeof ignUnavailable === "object" && ignUnavailable !== null) {
    const marker = ignUnavailable as Record<string, unknown>;
    failedSources.push({ name: "ign-geoplateforme", error: String(marker.reason ?? "unavailable") });
  }
  const businessesOsm = await readOptionalJson(path.join(paths.rawDir, "businesses-osm.json"));
  if (typeof businessesOsm === "object" && businessesOsm !== null) {
    const marker = businessesOsm as Record<string, unknown>;
    if (marker.status !== "ok") failedSources.push({ name: "businesses-osm", error: String(marker.error ?? "optional source unavailable") });
  }
  const normalizationIssues = await readOptionalJson(path.join(paths.intermediateDir, "normalization-issues.json"));
  if (Array.isArray(normalizationIssues) && normalizationIssues.length > 0) failedSources.push({ name: "invalid-source-geometries", error: `${normalizationIssues.length} source records were excluded` });
  const output = {
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    territory: { code: paths.territoryCode, name: paths.territoryName },
    sources: records,
    failedSources,
    transformation: { interchangeCrs: GERS_TERRITORY.interchangeCrs, processingCrs: GERS_TERRITORY.processingCrs, renderOriginWgs84: GERS_TERRITORY.renderOriginWgs84, coordinateSystem: "EPSG:2154 easting/northing relative to render origin; Three.js [x,0,z]" },
  };
  const acquisition = records.map((record) => ({
    source: record.source,
    url: record.url,
    sha256: record.sha256,
    fromCache: record.fromCache === true || record.cached === true,
    bytesDownloaded: typeof record.bytesDownloaded === "number" ? record.bytesDownloaded : 0,
    requestCount: typeof record.requestCount === "number" ? record.requestCount : 0,
    retryCount: typeof record.retryCount === "number" ? record.retryCount : 0,
    rateLimitCount: typeof record.rateLimitCount === "number" ? record.rateLimitCount : 0,
    sourceVersion: typeof record.etag === "string" ? record.etag : typeof record.lastModified === "string" ? record.lastModified : typeof record.edition === "string" ? record.edition : "unknown",
    retainedRecordCount: typeof record.retainedRecordCount === "number" ? record.retainedRecordCount : (typeof record.recordCount === "number" ? record.recordCount : 0),
    durationMs: 0,
  }));
  await fs.writeFile(path.join(paths.manifestsDir, "acquisition.json"), JSON.stringify(acquisition, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(paths.manifestsDir, "sources.json"), JSON.stringify(output, null, 2) + "\n", "utf8");
}

async function writeGenerationManifest(paths: RefreshPaths): Promise<void> {
  const summary = await collectFeatureSummary(paths);
  const rawBoundary = await readOptionalJson(path.join(paths.rawDir, paths.boundaryFile));
  const boundary = sourceBbox(rawBoundary);
  if (!boundary) throw new Error(`Cannot write manifest without a complete ${paths.territoryName} boundary`);
  const tileValues = await readOptionalJson(path.join(paths.generatedDir, "tile-manifest.json"));
  if (!Array.isArray(tileValues) || tileValues.length === 0) throw new Error("Cannot write manifest without generated tiles");
  const tiles = tileValues.map((value) => TileManifestSchema.parse(value));
  const tileBounds = tiles.map((tile) => tile.bounds);
  const bounds = tiles.reduce<[number, number, number, number]>((accumulator, tile) => [Math.min(accumulator[0], tile.bounds[0]), Math.min(accumulator[1], tile.bounds[1]), Math.max(accumulator[2], tile.bounds[2]), Math.max(accumulator[3], tile.bounds[3])], tileBounds[0]!);
  const lods = [0, 1, 2].map((level) => ({ level, tileSize: level === 0 ? GERS_TERRITORY.detailedTileSize : level === 1 ? GERS_TERRITORY.regionalTileSize : GERS_TERRITORY.overviewTileSize, tileCount: tiles.filter((tile) => tile.lod === level).length }));
  const sources = await readOptionalJson(path.join(paths.manifestsDir, "sources.json"));
  const sourceRecords = typeof sources === "object" && sources !== null && Array.isArray((sources as Record<string, unknown>).sources) ? (sources as Record<string, unknown>).sources : undefined;
  const failedSources = typeof sources === "object" && sources !== null && Array.isArray((sources as Record<string, unknown>).failedSources)
    ? (sources as Record<string, unknown>).failedSources
    : undefined;
  const manifest = {
    version: "0.1.0",
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    territoryCode: paths.territoryCode,
    territoryName: paths.territoryName,
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
  await fs.writeFile(path.join(paths.generatedDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
}
async function writeCoverageReport(paths: RefreshPaths): Promise<void> {
  const summary = await collectFeatureSummary(paths);
  const tileValues = await readOptionalJson(path.join(paths.generatedDir, "tile-manifest.json"));
  const sources = await readOptionalJson(path.join(paths.manifestsDir, "sources.json"));
  const tiles = Array.isArray(tileValues) ? tileValues.map((value) => TileManifestSchema.parse(value)) : [];
  const bytes = tiles.map((tile) => tile.byteSize).sort((first, second) => first - second);
  const maxTileBytes = bytes.length > 0 ? bytes[bytes.length - 1]! : 0;
  const failedSources = typeof sources === "object" && sources !== null && Array.isArray((sources as Record<string, unknown>).failedSources)
    ? (sources as Record<string, unknown>).failedSources
    : [];
  const report = {
    datasetVersion: "0.1.0",
    acquisitionTime: new Date().toISOString(),
    boundary: sourceBbox(await readOptionalJson(path.join(paths.rawDir, paths.boundaryFile))) ?? GERS_TERRITORY.bootstrapBbox,
    projectionOrigin: GERS_TERRITORY.renderOriginWgs84,
    tileSize: GERS_TERRITORY.detailedTileSize,
    tileCount: tiles.length,
    totalFeatures: summary.totalFeatures,
    featureCounts: summary.featureCounts,
    sourceCounts: summary.sourceCounts,
    categories: summary.featureCounts,
    sources: summary.sourceCounts,
    unresolved: [],
    failedSources,
    budgets: { tileBudgetBytes: 1024 * 1024, maxTileBytes: 2 * 1024 * 1024, totalTileCount: tiles.length, passes: maxTileBytes <= 2 * 1024 * 1024, largestTileBytes: maxTileBytes, policy: "LOD0 target 1 MiB and hard ceiling 2 MiB; coarser LODs are generalized" },
  };
  await fs.writeFile(path.join(paths.manifestsDir, "coverage.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
}

export async function refreshAll(options: RefreshOptions = { offline: false, forceIgn: false, force: new Set<string>(), scope: "gers" }): Promise<void> {
  const started = Date.now();
  const paths = createPaths(options.scope);
  await ensureDirs(paths);
  console.error(`[refresh] ${paths.territoryName} ${paths.territoryCode}`);
  await phaseBoundary(paths, options);
  await phaseBdtopo(paths, options);
  await phaseOsm(paths, options);
  await mergeOverpassThemes(paths);
  await phaseAddresses(paths, options);
  await phaseBusinesses(paths, options);
  await phaseOptionalIgn(paths, options);
  const normalizeScope = paths.scope === "auch"
    ? { boundaryRawFile: AUCH_DETAIL_SCOPE.boundaryRawFile, osmExtractFile: AUCH_DETAIL_SCOPE.osmGeojsonFile, bdtopoDir: path.join(paths.rawDir, AUCH_DETAIL_SCOPE.bdtopoOutputDir) }
    : undefined;
  await normalizeAll(paths.rawDir, paths.intermediateDir, normalizeScope);
  await deduplicateAll(paths.intermediateDir, paths.intermediateDir);
  await buildTilesAll(paths.intermediateDir, paths.tilesDir);
  await buildIndexAll(paths.tilesDir, paths.searchDir);
  await writeSourceManifest(paths);
  await writeCoverageReport(paths);
  await writeGenerationManifest(paths);
  const validationScope = paths.scope === "auch" ? { territoryCode: paths.territoryCode, boundaryRawFile: paths.boundaryFile, root: path.dirname(paths.generatedDir), rawDir: paths.rawDir } : undefined;
  await runSpatialQa(undefined, validationScope);
  await validate(paths.generatedDir, validationScope);
}

if (process.argv[1]?.endsWith("refresh.ts")) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) console.log("Usage: tsx scripts/data/refresh.ts [--offline] [--force-ign] [--force=<source[,source]>] [--scope=auch]");
  else refreshAll(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error("[refresh] Fatal:", error);
    process.exit(1);
  });
}
