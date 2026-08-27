#!/usr/bin/env tsx
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DatasetManifestSchema,
  MapFeatureSchema,
  SearchRecordSchema,
  TileManifestSchema,
  type MapFeature,
  type TileManifest,
} from "../../src/lib/data/schema";
import { GERS_TERRITORY } from "../../src/lib/data/territory";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";

const MAX_HEIGHT_METRES = 100;
const MAX_TILE_BYTES = 2 * 1024 * 1024;
const REQUIRED_KINDS = ["boundary", "building", "road", "water", "business", "address"] as const;

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


function geometryVertices(geometry: MapFeature["geometry"]): Array<[number, number]> {
  const vertices: Array<[number, number]> = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      vertices.push([value[0], value[1]]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return vertices;
}

function coordinateIssues(feature: MapFeature, boundaryIndex: BoundaryIndex): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const featureId = feature.stableId;
  if (feature.lon === undefined || feature.lat === undefined || !Number.isFinite(feature.lon) || !Number.isFinite(feature.lat)) {
    issues.push({ severity: "error", message: "feature has no finite WGS84 anchor", featureId });
  } else if (!boundaryIndex.contains([feature.lon, feature.lat]) && feature.kind !== "boundary") {
    const vertexInside = boundaryIndex.touches(geometryVertices(feature.geometry));
    if (!vertexInside) issues.push({ severity: "error", message: "feature anchor lies outside the Gers boundary", featureId });
  }
  if (feature.x === undefined || feature.z === undefined || !Number.isFinite(feature.x) || !Number.isFinite(feature.z)) {
    issues.push({ severity: "error", message: "feature has no finite local anchor", featureId });
  }
  if (feature.kind === "building" && feature.height !== undefined && feature.height > MAX_HEIGHT_METRES && feature.heightInferred) {
    issues.push({ severity: "error", message: `inferred height exceeds ${MAX_HEIGHT_METRES} metres`, featureId });
  }
  return issues;
}

function sourceIssues(feature: MapFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (feature.sourceRefs.length === 0) issues.push({ severity: "error", message: "feature has no source reference", featureId: feature.stableId });
  if (feature.provenance.length === 0) issues.push({ severity: "error", message: "feature has no provenance", featureId: feature.stableId });
  return issues;
}

function requiredSourceIssues(features: MapFeature[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const kinds = new Set(features.map((feature) => feature.kind));
  for (const kind of REQUIRED_KINDS) if (!kinds.has(kind)) issues.push({ severity: "error", message: `required layer ${kind} is absent` });
  for (const kind of ["building", "road", "water"] as const) {
    const canonical = features.some((feature) => feature.kind === kind && feature.sourceRefs.some((reference) => reference.source === "IGN BD TOPO"));
    if (!canonical) issues.push({ severity: "error", message: `${kind} has no IGN BD TOPO geometry` });
  }
  return issues;
}

function tileIdentityIssues(tile: TileManifest, features: MapFeature[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (tile.featureCount !== features.length) issues.push({ severity: "error", message: "manifest featureCount does not match payload", tileId: tile.tileId });
  const fragmentIds = features.map((feature) => feature.fragmentId ?? feature.stableId);
  if (new Set(fragmentIds).size !== fragmentIds.length) issues.push({ severity: "error", message: "duplicate fragment identity inside tile", tileId: tile.tileId });
  const manifestIds = new Set(tile.features);
  for (const feature of features) if (!manifestIds.has(feature.stableId)) issues.push({ severity: "error", message: `tile omits ${feature.stableId} from manifest identity list`, tileId: tile.tileId });
  return issues;
}

async function loadTiles(generatedDir: string): Promise<{ features: MapFeature[]; manifests: TileManifest[]; issues: ValidationIssue[] }> {
  const tilesDir = path.join(generatedDir, "tiles");
  const issues: ValidationIssue[] = [];
  const featuresById = new Map<string, { lod: number; feature: MapFeature }>();
  const manifests: TileManifest[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(tilesDir, { withFileTypes: true });
  } catch {
    return { features: [], manifests, issues: [{ severity: "error", message: `cannot access ${tilesDir}` }] };
  }
  const manifestValue = JSON.parse(await fs.readFile(path.join(generatedDir, "tile-manifest.json"), "utf8")) as unknown;
  if (!Array.isArray(manifestValue)) issues.push({ severity: "error", message: "tile-manifest.json is not an array" });
  else for (const value of manifestValue) manifests.push(TileManifestSchema.parse(value));
  const manifestById = new Map(manifests.map((manifest) => [manifest.tileId, manifest]));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const tileId = entry.name.slice(0, -5);
    const tile = manifestById.get(tileId);
    if (!tile) {
      issues.push({ severity: "error", message: "tile file has no manifest entry", tileId });
      continue;
    }
    const filePath = path.join(tilesDir, entry.name);
    const stats = await fs.stat(filePath);
    if (stats.size > MAX_TILE_BYTES) issues.push({ severity: "error", message: `tile exceeds ${MAX_TILE_BYTES} byte hard limit`, tileId });
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      issues.push({ severity: "error", message: "tile payload is not an array", tileId });
      continue;
    }
    const tileFeatures: MapFeature[] = [];
    for (const value of parsed) {
      try {
        const feature = MapFeatureSchema.parse(value);
        tileFeatures.push(feature);
        const previous = featuresById.get(feature.stableId);
        if (!previous || tile.lod < previous.lod) featuresById.set(feature.stableId, { lod: tile.lod, feature });
      } catch (error) {
        issues.push({ severity: "error", message: `invalid canonical feature: ${error instanceof Error ? error.message : String(error)}`, tileId });
      }
    }
    issues.push(...tileIdentityIssues(tile, tileFeatures));
  }
  return { features: [...featuresById.values()].map((value) => value.feature), manifests, issues };
}

async function validateSearch(root: string, manifests: TileManifest[]): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, "search", "index.json"), "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return [{ severity: "error", message: "search index is empty or not an array" }];
    const tileIds = new Set(manifests.map((manifest) => manifest.tileId));
    for (const value of parsed) {
      const record = SearchRecordSchema.parse(value);
      if (!tileIds.has(record.tileId)) issues.push({ severity: "error", message: `search record points to missing tile ${record.tileId}`, featureId: record.featureId });
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

export async function validate(generatedDir?: string): Promise<void> {
  const root = dataRoot();
  const outputDir = generatedDir ?? path.join(root, "generated");
  const issues: ValidationIssue[] = [];
  const manifest = DatasetManifestSchema.parse(JSON.parse(await fs.readFile(path.join(outputDir, "manifest.json"), "utf8")) as unknown);
  if (manifest.territoryCode !== GERS_TERRITORY.code || manifest.processingCrs !== GERS_TERRITORY.processingCrs || manifest.interchangeCrs !== GERS_TERRITORY.interchangeCrs) {
    issues.push({ severity: "error", message: "dataset manifest territory or CRS contract is incorrect" });
  }
  const boundaryGeometry = await readBoundaryGeometry(root);
  const boundaryIndex = createBoundaryIndex(boundaryGeometry);
  const loaded = await loadTiles(outputDir);
  issues.push(...loaded.issues);
  const uniqueFeatures = [...new Map(loaded.features.map((feature) => [feature.stableId, feature])).values()];
  for (const feature of uniqueFeatures) {
    issues.push(...coordinateIssues(feature, boundaryIndex));
    issues.push(...sourceIssues(feature));
    if (feature.kind === "road" && feature.localGeometry && ![ "LineString", "MultiLineString", "Polygon", "MultiPolygon" ].includes(feature.localGeometry.type)) issues.push({ severity: "error", message: "road geometry is neither linear nor areal", featureId: feature.stableId });
  }
  issues.push(...requiredSourceIssues(uniqueFeatures));
  issues.push(...await validateSearch(root, loaded.manifests));
  issues.push(...lodIssues(loaded.manifests));
  const report = { checkedAt: new Date().toISOString(), featureCount: uniqueFeatures.length, tileCount: loaded.manifests.length, issues };
  await fs.mkdir(path.join(root, "qa"), { recursive: true });
  await fs.writeFile(path.join(root, "qa", "validation-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  const errors = issues.filter((issue) => issue.severity === "error");
  console.error(`[validate] ${errors.length} errors, ${issues.length - errors.length} warnings`);
  if (errors.length > 0) throw new ValidationErrors(issues);
}

async function readBoundaryGeometry(root: string): Promise<number[][][][]> {
  const parsed = JSON.parse(await fs.readFile(path.join(root, "raw", GERS_TERRITORY.boundaryRawFile), "utf8")) as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }> };
  const geometry = parsed.features?.[0]?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) throw new Error("raw Gers boundary is unavailable");
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
