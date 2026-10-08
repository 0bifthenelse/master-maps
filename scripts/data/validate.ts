#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import type { Dirent } from "node:fs";
import {
  DatasetManifestSchema,
  MapFeatureSchema,
  SearchRecordSchema,
  TileManifestSchema,
  TileMetaFeatureSchema,
  type TileManifest,
  type TileMetaFeature,
} from "../../src/lib/data/schema";
import { GERS_TERRITORY } from "../../src/lib/data/territory";
import { reconcileCoverage, readExclusionReport, type CoverageReconciliation, type ExclusionReport } from "./exclusion-report";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";
import { BOUNDARY_TILE_ID } from "./build-tiles";
import { RANGE_STRIDE, RENDER_LAYER_KINDS, decodeRenderTile, renderLayerIndices, renderLayerRanges, renderLayerVertices, type DecodedRenderTile } from "../../src/lib/render/codec";

const MAX_HEIGHT_METRES = 100;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const REQUIRED_KINDS = ["boundary", "building", "road", "water", "landuse", "poi", "transport", "place", "business", "address"] as const;
const SEARCH_COVERED_KINDS = ["address", "business", "place", "poi", "road", "transport"] as const;
const FICTIVE_SOURCE_METADATA_FLAG = "fictif";

export interface ValidationScope {
  territoryCode: string;
  boundaryRawFile: string;
  root?: string;
  rawDir?: string;
}

interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  featureId?: string;
  tileId?: string;
}

interface ValidateOptions {
  generatedDir: string;
  coverageOnly: boolean;
}

class ValidationErrors extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(`Validation failed with ${issues.filter((issue) => issue.severity === "error").length} error(s)`);
    this.name = "ValidationErrors";
  }
}

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

function parseArgs(args: string[]): ValidateOptions {
  const root = dataRoot();
  let generatedDir = path.join(root, "generated");
  let coverageOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--generated-dir" && args[index + 1]) generatedDir = args[++index]!;
    else if (argument === "--coverage-only") coverageOnly = true;
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: tsx scripts/data/validate.ts [--generated-dir <path>] [--coverage-only]");
      process.exit(0);
    }
  }
  return { generatedDir, coverageOnly };
}

/** About a metre in degrees: roads and streams that are the border itself carry anchors on the line. */
const BORDER_TOLERANCE_DEGREES = 1e-5;

function onBorder(lon: number, lat: number, boundaryIndex: BoundaryIndex): boolean {
  const d = BORDER_TOLERANCE_DEGREES;
  return boundaryIndex.touches([[lon - d, lat], [lon + d, lat]]) || boundaryIndex.touches([[lon, lat - d], [lon, lat + d]]);
}

function coordinateIssues(feature: TileMetaFeature, boundaryIndex: BoundaryIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const featureId = feature.stableId;
  if (feature.lon === undefined || feature.lat === undefined || !Number.isFinite(feature.lon) || !Number.isFinite(feature.lat)) {
    issues.push({ severity: "error", message: "feature has no finite WGS84 anchor", featureId });
  } else if (feature.kind !== "boundary" && !boundaryIndex.contains([feature.lon, feature.lat]) && !onBorder(feature.lon, feature.lat, boundaryIndex)) {
    issues.push({ severity: "error", message: "feature anchor lies outside the Gers boundary", featureId });
  }
  if (feature.x === undefined || feature.z === undefined || !Number.isFinite(feature.x) || !Number.isFinite(feature.z)) {
    issues.push({ severity: "error", message: "feature has no finite local anchor", featureId });
  }
  if (feature.kind === "building" && feature.height !== undefined && feature.height > MAX_HEIGHT_METRES && feature.heightInferred) {
    issues.push({ severity: "error", message: `inferred height exceeds ${MAX_HEIGHT_METRES} metres`, featureId });
  }
  return issues;
}

function sourceIssues(feature: TileMetaFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (feature.sourceRefs.length === 0) issues.push({ severity: "error", message: "feature has no source reference", featureId: feature.stableId });
  if (feature.provenance.length === 0) issues.push({ severity: "error", message: "feature has no provenance", featureId: feature.stableId });
  return issues;
}

function requiredSourceIssues(features: TileMetaFeature[], scope?: ValidationScope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kinds = new Set(features.map((feature) => feature.kind));
  for (const kind of REQUIRED_KINDS) if (!kinds.has(kind)) issues.push({ severity: "error", message: `required layer ${kind} is absent` });
  for (const kind of ["building", "road", "water"] as const) {
    const canonical = features.some((feature) => feature.kind === kind && feature.sourceRefs.some((reference) => reference.source === "IGN BD TOPO" || (scope?.territoryCode === "32013" && reference.source === "osm-auch")));
    if (!canonical) issues.push({ severity: "error", message: scope === undefined ? `${kind} has no IGN BD TOPO geometry` : `${kind} has no canonical geometry source` });
  }
  return issues;
}
function tileIdentityIssues(tile: TileManifest, indexEntry: TileManifest | undefined, features: TileMetaFeature[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (tile.featureCount !== features.length) issues.push({ severity: "error", message: "manifest featureCount does not match payload", tileId: tile.tileId });
  const fragmentIds = features.map((feature) => feature.fragmentId ?? feature.stableId);
  if (new Set(fragmentIds).size !== fragmentIds.length) issues.push({ severity: "error", message: "duplicate fragment identity inside tile", tileId: tile.tileId });
  const manifestIds = indexEntry?.features;
  if (manifestIds === undefined) {
    issues.push({ severity: "warning", message: "tile-index.json carries no identity list for this tile", tileId: tile.tileId });
    return issues;
  }
  const identity = new Set(manifestIds);
  for (const feature of features) if (!identity.has(feature.stableId)) issues.push({ severity: "error", message: `tile omits ${feature.stableId} from manifest identity list`, tileId: tile.tileId });
  if (indexEntry.fragmentIds !== undefined && indexEntry.fragmentIds.length !== manifestIds.length) issues.push({ severity: "error", message: "tile-index.json fragment list length differs from its identity list", tileId: tile.tileId });
  return issues;
}

const RENDER_TILE_DECODE_SAMPLE = 50;

function renderStructureIssues(manifest: TileManifest, decoded: DecodedRenderTile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const tileId = manifest.tileId;
  if (decoded.header.tileId !== tileId) issues.push({ severity: "error", message: "render tile header does not carry its tile id", tileId });
  if (decoded.header.lod !== manifest.lod) issues.push({ severity: "error", message: `render tile LOD ${decoded.header.lod} disagrees with the manifest LOD ${manifest.lod}`, tileId });
  if (decoded.header.bounds.some((value, position) => Math.abs(value - manifest.bounds[position]!) > 1e-6)) issues.push({ severity: "error", message: "render tile bounds disagree with the manifest bounds", tileId });
  for (const layer of decoded.layers) {
    const vertices = renderLayerVertices(decoded.payload, layer);
    const indices = renderLayerIndices(decoded.payload, layer);
    const ranges = renderLayerRanges(decoded.payload, layer);
    const vertexCount = vertices.length / layer.stride;
    if (!Number.isInteger(vertexCount)) issues.push({ severity: "error", message: `layer ${layer.id} vertex data is not a whole number of vertices`, tileId });
    for (let vertex = 0; vertex < indices.length; vertex += 1) {
      if (indices[vertex]! >= vertexCount) {
        issues.push({ severity: "error", message: `layer ${layer.id} index ${indices[vertex]} exceeds the vertex count`, tileId });
        break;
      }
    }
    /* Line vertices are centrelines that may bleed a road's width past the tile edge. */
    const slack = RENDER_LAYER_KINDS[layer.id] === "line" ? 60 : 1e-3;
    for (let vertex = 0; vertex < vertices.length; vertex += layer.stride) {
      const x = vertices[vertex]!;
      const z = vertices[vertex + 2]!;
      if (!Number.isFinite(x) || !Number.isFinite(z) || x < manifest.bounds[0] - slack || x > manifest.bounds[2] + slack || z < manifest.bounds[1] - slack || z > manifest.bounds[3] + slack) {
        issues.push({ severity: "error", message: `layer ${layer.id} vertex lies outside the tile bounds`, tileId });
        break;
      }
    }
    for (let entry = 0; entry < ranges.length; entry += RANGE_STRIDE) {
      const indexStart = ranges[entry]!;
      const indexCount = ranges[entry + 1]!;
      const metaIndex = ranges[entry + 2]!;
      if (indexStart + indexCount > indices.length) {
        issues.push({ severity: "error", message: `layer ${layer.id} feature range runs past the index buffer`, tileId });
        break;
      }
      if (metaIndex >= decoded.meta.length) {
        issues.push({ severity: "error", message: `layer ${layer.id} feature range points at a missing meta entry`, tileId });
        break;
      }
    }
  }
  return issues;
}

async function renderTileIssues(generatedDir: string, manifests: TileManifest[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  const renderDir = path.join(generatedDir, "render");
  const sampleStride = Math.max(1, Math.floor(manifests.length / RENDER_TILE_DECODE_SAMPLE));
  let decoded = 0;
  for (let index = 0; index < manifests.length; index += 1) {
    const manifest = manifests[index]!;
    const filePath = path.join(renderDir, `${manifest.tileId}.mmt`);
    const stats = await fs.stat(filePath).catch(() => null);
    if (stats === null) {
      issues.push({ severity: "error", message: "render tile is missing", tileId: manifest.tileId });
      continue;
    }
    if (stats.size > MAX_TILE_BYTES) issues.push({ severity: "error", message: `render tile exceeds ${MAX_TILE_BYTES} byte hard limit`, tileId: manifest.tileId });
    if (index % sampleStride !== 0) continue;
    try {
      const buffer = await fs.readFile(filePath);
      const view = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
      const decodedTile = decodeRenderTile(view);
      issues.push(...renderStructureIssues(manifest, decodedTile));
      decoded += 1;
    } catch (error) {
      issues.push({ severity: "error", message: `render tile does not decode: ${error instanceof Error ? error.message : String(error)}`, tileId: manifest.tileId });
    }
  }
  if (manifests.length > 0 && decoded === 0) issues.push({ severity: "error", message: "no render tile could be decoded" });
  return issues;
}

function fictiveFlagIssues(features: TileMetaFeature[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const feature of features) {
    /* Only water carries the flag: fictive road segments are simply not drawn. */
    if (feature.kind !== "water") continue;
    const sourceFlag = (feature.sourceMetadata as Record<string, unknown> | undefined)?.[FICTIVE_SOURCE_METADATA_FLAG];
    if (sourceFlag === true && feature.fictiveAxis !== true) {
      issues.push({ severity: "error", message: `source marks the record as ${FICTIVE_SOURCE_METADATA_FLAG} but the canonical record lacks the fictiveAxis flag`, featureId: feature.stableId });
    }
  }
  return issues;
}

function exclusionReportIssues(report: ExclusionReport | null, dataRoot: string): ValidationIssue[] {
  if (report === null) return [{ severity: "error", message: `exclusion report is missing at ${path.join(dataRoot, "qa", "exclusion-report.json")}` }];
  const issues: ValidationIssue[] = [];
  if (report.totals.unexplained !== 0) issues.push({ severity: "error", message: `exclusion report declares ${report.totals.unexplained} unexplained records` });
  for (const row of report.sources) {
    if (row.source === "canonical") continue;
    const excluded = row.excludedByRule.reduce((sum, entry) => sum + entry.count, 0);
    if (row.accepted + excluded + row.invalidGeometry + row.outsideBoundary !== row.input) {
      issues.push({ severity: "error", message: `exclusion accounting is unbalanced for ${row.key}` });
    }
  }
  for (const entry of report.invariants.stagesUndeclared) issues.push({ severity: "warning", message: `stage drop without a source rule: ${entry}` });
  return issues;
}

function coverageIssues(reconciliation: CoverageReconciliation, coveragePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!reconciliation.totalReconciled) {
    issues.push({ severity: "error", message: `coverage totals do not reconcile: ${coveragePath} declares ${reconciliation.coverageTotal} features while tiles decode ${reconciliation.canonicalTotal}` });
  }
  for (const kind of reconciliation.kindsUnmatched) {
    issues.push({ severity: "error", message: `coverage kind ${kind} disagrees with canonical tile counts (${reconciliation.kindsCoverage[kind] ?? 0} declared, ${reconciliation.kindsCanonical[kind] ?? 0} decoded)` });
  }
  return issues;
}

interface CoverageSummary {
  totalFeatures: number;
  featureCounts: Record<string, number>;
}

async function readCoverage(coveragePath: string): Promise<CoverageSummary | null> {
  const parsed: unknown = JSON.parse(await fs.readFile(coveragePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  const featureCounts = candidate.featureCounts;
  if (typeof featureCounts !== "object" || featureCounts === null) return null;
  const counts: Record<string, number> = {};
  for (const [kind, value] of Object.entries(featureCounts as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) counts[kind] = value;
  }
  const declared = candidate.totalFeatures;
  return { totalFeatures: typeof declared === "number" ? declared : Object.values(counts).reduce((sum, value) => sum + value, 0), featureCounts: counts };
}

async function readTileIndexEntries(generatedDir: string, issues: ValidationIssue[]): Promise<Map<string, TileManifest>> {
  const index = new Map<string, TileManifest>();
  const indexPath = path.join(generatedDir, "tile-index.json");
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    issues.push({ severity: "warning", message: `tile-index.json is missing at ${indexPath}; per-tile identity checks are skipped` });
    return index;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    issues.push({ severity: "error", message: "tile-index.json is not an array" });
    return index;
  }
  for (const value of parsed) {
    const entry = TileManifestSchema.parse(value);
    index.set(entry.tileId, entry);
  }
  return index;
}

async function loadMetaFeatures(metaDir: string, tileId: string, issues: ValidationIssue[]): Promise<TileMetaFeature[]> {
  const parsed = JSON.parse(gunzipSync(await fs.readFile(path.join(metaDir, `${tileId}.json.gz`))).toString("utf8")) as unknown;
  if (!Array.isArray(parsed)) {
    issues.push({ severity: "error", message: "meta sidecar payload is not an array", tileId });
    return [];
  }
  const features: TileMetaFeature[] = [];
  for (const value of parsed) {
    try {
      features.push(TileMetaFeatureSchema.parse(value));
    } catch (error) {
      issues.push({ severity: "error", message: `invalid meta feature: ${error instanceof Error ? error.message : String(error)}`, tileId });
    }
  }
  return features;
}

async function loadTiles(generatedDir: string): Promise<{ features: TileMetaFeature[]; manifests: TileManifest[]; issues: ValidationIssue[] }> {
  const metaDir = path.join(generatedDir, "meta");
  const issues: ValidationIssue[] = [];
  const featuresById = new Map<string, { lod: number; feature: TileMetaFeature }>();
  const manifests: TileManifest[] = [];
  const manifestValue = JSON.parse(await fs.readFile(path.join(generatedDir, "tile-manifest.json"), "utf8")) as unknown;
  if (!Array.isArray(manifestValue)) issues.push({ severity: "error", message: "tile-manifest.json is not an array" });
  else for (const value of manifestValue) manifests.push(TileManifestSchema.parse(value));
  const manifestById = new Map(manifests.map((manifest) => [manifest.tileId, manifest]));
  const indexById = await readTileIndexEntries(generatedDir, issues);
  const present = new Set<string>();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(metaDir, { withFileTypes: true });
  } catch {
    return { features: [], manifests, issues: [...issues, { severity: "error", message: `cannot access ${metaDir}` }] };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json.gz")) continue;
    const tileId = entry.name.slice(0, -".json.gz".length);
    if (tileId === BOUNDARY_TILE_ID) {
      /* The territory outline lives outside the LOD grid: it has no manifest row, only its own sidecar and render tile. */
      for (const feature of await loadMetaFeatures(metaDir, tileId, issues)) featuresById.set(feature.stableId, { lod: -1, feature });
      continue;
    }
    const tile = manifestById.get(tileId);
    if (!tile) {
      issues.push({ severity: "error", message: "meta sidecar has no manifest entry", tileId });
      continue;
    }
    const stats = await fs.stat(path.join(metaDir, entry.name));
    if (stats.size > MAX_TILE_BYTES) issues.push({ severity: "error", message: `meta sidecar exceeds ${MAX_TILE_BYTES} byte hard limit`, tileId });
    present.add(tileId);
    let tileFeatures: TileMetaFeature[] = [];
    try {
      tileFeatures = await loadMetaFeatures(metaDir, tileId, issues);
    } catch (error) {
      issues.push({ severity: "error", message: `meta sidecar does not decode: ${error instanceof Error ? error.message : String(error)}`, tileId });
      continue;
    }
    for (const feature of tileFeatures) {
      const previous = featuresById.get(feature.stableId);
      if (!previous || tile.lod < previous.lod) featuresById.set(feature.stableId, { lod: tile.lod, feature });
    }
    issues.push(...tileIdentityIssues(tile, indexById.get(tileId), tileFeatures));
  }
  for (const manifest of manifests) {
    if (present.has(manifest.tileId)) continue;
    issues.push({ severity: "error", message: "manifest tile has no meta sidecar", tileId: manifest.tileId });
  }
  return { features: [...featuresById.values()].map((value) => value.feature), manifests, issues };
}

async function validateSearch(root: string, manifests: TileManifest[], features: TileMetaFeature[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, "search", "index.json"), "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [{ severity: "error", message: "search index is empty or not an array" }];
    const tileIds = new Set(manifests.map((manifest) => manifest.tileId));
    const indexedKinds = new Set<string>();
    for (const value of parsed) {
      const record = SearchRecordSchema.parse(value);
      indexedKinds.add(record.kind);
      if (!tileIds.has(record.tileId)) issues.push({ severity: "error", message: `search record points to missing tile ${record.tileId}`, featureId: record.featureId });
    }
    const present = new Set(features.map((feature) => feature.kind));
    for (const kind of SEARCH_COVERED_KINDS) {
      if (present.has(kind) && !indexedKinds.has(kind)) issues.push({ severity: "error", message: `search index holds no record for the named canonical kind ${kind}` });
    }
  } catch (error) {
    issues.push({ severity: "error", message: `invalid search index: ${error instanceof Error ? error.message : String(error)}` });
  }
  return issues;
}

function lodIssues(manifests: TileManifest[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const levels = new Set(manifests.map((manifest) => manifest.lod));
  for (const level of [0, 1, 2]) if (!levels.has(level)) issues.push({ severity: "error", message: `LOD${level} is absent` });
  const detailed = manifests.filter((manifest) => manifest.lod === 0).reduce((sum, manifest) => sum + manifest.featureCount, 0);
  const regional = manifests.filter((manifest) => manifest.lod === 1).reduce((sum, manifest) => sum + manifest.featureCount, 0);
  const overview = manifests.filter((manifest) => manifest.lod === 2).reduce((sum, manifest) => sum + manifest.featureCount, 0);
  if (detailed > 0 && regional >= detailed) issues.push({ severity: "error", message: "LOD1 is not reduced from LOD0" });
  if (regional > 0 && overview >= regional) issues.push({ severity: "error", message: "LOD2 is not reduced from LOD1" });
  return issues;
}
function append(target: ValidationIssue[], source: ValidationIssue[]): void {
  for (const issue of source) target.push(issue);
}

export async function validate(generatedDir?: string, scope?: ValidationScope): Promise<void> {
  const defaultRoot = dataRoot();
  const root = scope?.root ?? defaultRoot;
  const rawDir = scope?.rawDir ?? path.join(defaultRoot, "raw");
  const outputDir = generatedDir ?? path.join(root, "generated");
  const issues: ValidationIssue[] = [];
  const manifest = DatasetManifestSchema.parse(JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8")) as unknown);
  if (manifest.territoryCode !== (scope?.territoryCode ?? GERS_TERRITORY.code) || manifest.processingCrs !== GERS_TERRITORY.processingCrs || manifest.interchangeCrs !== GERS_TERRITORY.interchangeCrs) {
    issues.push({ severity: "error", message: "dataset manifest territory or CRS contract is incorrect" });
  }
  const boundaryGeometry = await readBoundaryGeometry(rawDir, scope);
  const boundaryIndex = createBoundaryIndex(boundaryGeometry);
  const loaded = await loadTiles(outputDir);
  append(issues, loaded.issues);
  const uniqueFeatures = [...new Map(loaded.features.map((feature) => [feature.stableId, feature])).values()];
  for (const feature of uniqueFeatures) {
    append(issues, coordinateIssues(feature, boundaryIndex));
    append(issues, sourceIssues(feature));
  }
  append(issues, requiredSourceIssues(uniqueFeatures, scope));
  append(issues, fictiveFlagIssues(uniqueFeatures));
  append(issues, await validateSearch(root, loaded.manifests, uniqueFeatures));
  append(issues, lodIssues(loaded.manifests));
  append(issues, await renderTileIssues(outputDir, loaded.manifests));
  const exclusion = await readExclusionReport(path.join(root, "qa", "exclusion-report.json")).catch(() => null);
  append(issues, exclusionReportIssues(exclusion, root));
  const report: { checkedAt: string; featureCount: number; tileCount: number; issues: ValidationIssue[]; reconciliation?: CoverageReconciliation } = { checkedAt: new Date().toISOString(), featureCount: uniqueFeatures.length, tileCount: loaded.manifests.length, issues };
  const coverage = await readCoverage(path.join(root, "manifests", "coverage.json"));
  if (coverage !== null) {
    const reconciliation = reconcileCoverage({
      canonical: uniqueFeatures,
      tiles: loaded.manifests.map((tile) => tile.featureCount),
      featureCounts: coverage.featureCounts,
      totalFeatures: coverage.totalFeatures,
      unexplained: exclusion?.totals.unexplained ?? 0,
    });
    issues.push(...coverageIssues(reconciliation, path.join(root, "manifests", "coverage.json")));
    report.reconciliation = reconciliation;
  }
  await fs.mkdir(path.join(root, "qa"), { recursive: true });
  await fs.writeFile(path.join(root, "qa", "validation-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  const errors = issues.filter((issue) => issue.severity === "error");
  console.error(`[validate] ${errors.length} errors, ${issues.length - errors.length} warnings`);
  if (errors.length > 0) throw new ValidationErrors(issues);
}

async function readBoundaryGeometry(root: string, scope?: ValidationScope): Promise<number[][][][]> {
  const parsed = JSON.parse(await fs.readFile(path.join(root, scope?.boundaryRawFile ?? GERS_TERRITORY.boundaryRawFile), "utf8")) as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }> };
  const geometry = parsed.features?.[0]?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) throw new Error(`raw ${scope?.territoryCode ?? GERS_TERRITORY.name} boundary is unavailable`);
  if (geometry.type === "Polygon") return [geometry.coordinates as number[][][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as number[][][][];
  throw new Error(`unsupported boundary geometry ${geometry.type}`);
}

if (process.argv[1]?.endsWith("validate.ts")) {
  const options = parseArgs(process.argv.slice(2));
  if (options.coverageOnly) process.exit(0);
  validate(options.generatedDir).catch((error: unknown) => {
    console.error("[validate] Fatal:", error);
    process.exit(1);
  });
}
