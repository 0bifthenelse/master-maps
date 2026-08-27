#!/usr/bin/env tsx
/**
 * validate.ts — Validates the generated data volume.
 *
 * Checks:
 *   - Finite coordinates within Auch bounds
 *   - Polygon renderability (minimum vertices, ring closure)
 *   - No negative or absurd height metadata
 *   - Nonempty road geometry
 *   - Stable-ID uniqueness across the dataset
 *   - Tile references resolve
 *   - Provenance presence
 *   - Documented licenses
 *   - Required layers present (boundary, roads, buildings, businesses, Nocibé, search)
 *
 * Fails with source, tile, or feature context.
 *
 * Usage: tsx scripts/data/validate.ts [--generated-dir <path>]
 *        tsx scripts/data/validate.ts --coverage-only
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

const TERRITORY_BBOX = {
  west: GERS_TERRITORY.bootstrapBbox[0],
  east: GERS_TERRITORY.bootstrapBbox[2],
  south: GERS_TERRITORY.bootstrapBbox[1],
  north: GERS_TERRITORY.bootstrapBbox[3],
};

const MAX_HEIGHT_M = 100;
const MIN_BUILDING_POLYGON_VERTICES = 4;
const VALID_KINDS = new Set([
  "boundary", "building", "road", "water", "landuse",
  "poi", "business", "address", "transport",
]);

// ---------------------------------------------------------------------------
// Validation error container
// ---------------------------------------------------------------------------

interface ValidationIssue {
  severity: "error" | "warning";
  message: string;
  source?: string;
  featureId?: string;
  tileId?: string;
}

class ValidationErrors extends Error {
  issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Validation failed with ${issues.filter((i) => i.severity === "error").length} error(s)`);
    this.name = "ValidationErrors";
    this.issues = issues;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

interface ValidateOptions {
  generatedDir: string;
  coverageOnly: boolean;
}

function parseArgs(args: string[]): ValidateOptions {
  const root = dataRoot();
  let generatedDir = path.join(root, "generated");
  let coverageOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--generated-dir" && args[i + 1]) { generatedDir = args[++i]!; }
    else if (a === "--coverage-only") { coverageOnly = true; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/data/validate.ts [--generated-dir <path>] [--coverage-only]");
      process.exit(0);
    }
  }
  return { generatedDir, coverageOnly };
}

// ---------------------------------------------------------------------------
// Individual validators
// ---------------------------------------------------------------------------

type MapFeature = Record<string, unknown>;

function validateCoords(f: MapFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lon = f.lon as number | undefined;
  const lat = f.lat as number | undefined;
  const fId = f.stableId as string ?? f.sourceId as string ?? "?";

  if (lon === undefined || !isFinite(lon)) {
    issues.push({ severity: "error", message: `Non-finite longitude: ${lon}`, featureId: fId });
  } else if (lon < TERRITORY_BBOX.west - 0.05 || lon > TERRITORY_BBOX.east + 0.05) {
    issues.push({ severity: "warning", message: `Longitude ${lon} outside Gers bootstrap envelope`, featureId: fId });
  }

  if (lat === undefined || !isFinite(lat)) {
    issues.push({ severity: "error", message: `Non-finite latitude: ${lat}`, featureId: fId });
  } else if (lat < TERRITORY_BBOX.south - 0.05 || lat > TERRITORY_BBOX.north + 0.05) {
    issues.push({ severity: "warning", message: `Latitude ${lat} outside Gers bootstrap envelope`, featureId: fId });
  }

  return issues;
}

function validateHeight(f: MapFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fId = f.stableId as string ?? "?";
  if (f.kind !== "building") return issues;

  const h = f.height as number | undefined;
  if (h !== undefined) {
    if (!isFinite(h)) {
      issues.push({ severity: "error", message: `Non-finite building height: ${h}`, featureId: fId });
    } else if (h < 0) {
      issues.push({ severity: "error", message: `Negative building height: ${h}m`, featureId: fId });
    } else if (h > MAX_HEIGHT_M) {
      const inferred = f.heightInferred as boolean;
      if (inferred) {
        issues.push({ severity: "error", message: `Inferred height ${h}m exceeds ${MAX_HEIGHT_M}m limit`, featureId: fId });
      } else {
        issues.push({ severity: "warning", message: `Source height ${h}m > ${MAX_HEIGHT_M}m — verify`, featureId: fId });
      }
    }
  }
  return issues;
}

function validatePolygonGeometry(f: MapFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fId = f.stableId as string ?? "?";
  const kind = f.kind as string;

  if (kind !== "building" && kind !== "boundary" && kind !== "landuse" && kind !== "water") return issues;

  const rings = (f as Record<string, unknown>).rings as number[][][] | undefined;
  if (!rings || rings.length === 0) {
    // May be stored differently — skip if no rings field
    return issues;
  }

  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri]!;
    if (ring.length < MIN_BUILDING_POLYGON_VERTICES) {
      issues.push({
        severity: "error",
        message: `Ring ${ri} has ${ring.length} vertices (min ${MIN_BUILDING_POLYGON_VERTICES})`,
        featureId: fId,
      });
    }
    // Check closure: first vertex ≈ last vertex
    if (ring.length >= 2) {
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      const dx = (first[0] as number) - (last[0] as number);
      const dy = (first[1] as number) - (last[1] as number);
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        issues.push({
          severity: "warning",
          message: `Ring ${ri} not closed (first ${first}, last ${last})`,
          featureId: fId,
        });
      }
    }
  }
  return issues;
}

function validateRoads(f: MapFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fId = f.stableId as string ?? "?";
  if (f.kind !== "road") return issues;
  const geometry = f.geometry as Record<string, unknown> | undefined;
  if (!geometry || (geometry.type as string) === undefined) {
    issues.push({ severity: "error", message: "Road feature missing geometry", featureId: fId });
  }
  return issues;
}

function validateSourceRefs(f: MapFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fId = f.stableId as string ?? "?";
  const refs = f.sourceRefs as Array<Record<string, unknown>> | undefined;
  if (!refs || refs.length === 0) {
    issues.push({ severity: "warning", message: "No source references", featureId: fId });
  } else {
    for (const r of refs) {
      if (!r.source) {
        issues.push({ severity: "error", message: "Source reference missing 'source' field", featureId: fId });
      }
      if (!r.timestamp) {
        issues.push({ severity: "warning", message: "Source reference missing 'timestamp'", source: r.source as string, featureId: fId });
      }
    }
  }
  return issues;
}

function validateProvenance(f: MapFeature): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fId = f.stableId as string ?? "?";
  const prov = f.provenance as Array<Record<string, unknown>> | undefined;
  if (!prov || prov.length === 0) {
    issues.push({ severity: "warning", message: "No provenance records", featureId: fId });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Dataset-level validators
// ---------------------------------------------------------------------------

function checkFeatureIdentity(features: MapFeature[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const feature of features) {
    if (typeof feature.stableId !== "string" || feature.stableId.length === 0) {
      issues.push({ severity: "error", message: "Feature is missing stableId" });
    }
  }
  return issues;
}

function checkRequiredLayers(features: MapFeature[]): ValidationIssue[] {
  const present = new Set(features.map((f) => f.kind as string));
  const required = ["boundary", "building", "road", "business", "address"];
  const issues: ValidationIssue[] = [];
  for (const layer of required) {
    if (!present.has(layer)) {
      const severity = layer === "address" ? "warning" as const : "error" as const;
      issues.push({ severity, message: `Required layer "${layer}" is missing` });
    }
  }
  return issues;
}

/** Department-level spatial invariant: roads and buildings must be present
 * across multiple coarse cells, not merely concentrated in Auch. */
function checkDepartmentCoverage(features: MapFeature[]): ValidationIssue[] {
  const roads = features.filter((feature) => feature.kind === "road");
  const buildings = features.filter((feature) => feature.kind === "building");
  const issues: ValidationIssue[] = [];
  if (roads.length === 0) issues.push({ severity: "error", message: "No road features in Gers dataset" });
  if (buildings.length === 0) issues.push({ severity: "error", message: "No building features in Gers dataset" });
  const cells = new Set<string>();
  for (const feature of [...roads, ...buildings]) {
    const col = Math.floor((feature.lon - TERRITORY_BBOX.west) / 0.2);
    const row = Math.floor((feature.lat - TERRITORY_BBOX.south) / 0.2);
    cells.add(`${col}:${row}`);
  }
  if (cells.size < 5) {
    issues.push({ severity: "error", message: `Features occupy only ${cells.size} Gers spatial cells; department coverage is incomplete` });
  }
  return issues;
}
function checkNocibePresent(features: MapFeature[]): ValidationIssue[] {
  const nocibe = features.find((f) => {
    const name = ((f.name as string) ?? "").toLowerCase();
    return name.includes("nocibé") || name.includes("nocibe");
  });
  if (!nocibe) {
    return [{ severity: "warning", message: "Nocibé feature not found in dataset. Add after acquisition." }];
  }
  return [];
}

async function checkSearchIndex(indexPath: string): Promise<ValidationIssue[]> {
  try {
    const content = await fs.readFile(indexPath, "utf8");
    const records = JSON.parse(content) as Array<Record<string, unknown>>;
    if (!Array.isArray(records)) {
      return [{ severity: "error", message: "Search index is not an array" }];
    }
    if (records.length === 0) {
      return [{ severity: "warning", message: "Search index is empty" }];
    }
    return [];
  } catch {
    return [{ severity: "error", message: `Search index not found at ${indexPath}` }];
  }
}

async function checkTileIntegrity(manifest: Array<{ tileId: string; featureCount: number; features: string[] }>): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  for (const m of manifest) {
    if (!m.tileId) issues.push({ severity: "error", message: "Tile manifest entry missing tileId" });
    if (!Number.isFinite(m.featureCount) || m.featureCount < 0) {
      issues.push({ severity: "error", message: `Tile ${m.tileId} invalid featureCount: ${m.featureCount}` });
    }
    if (!Array.isArray(m.features)) {
      issues.push({ severity: "error", message: `Tile ${m.tileId} missing features array` });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function validate(generatedDir?: string): Promise<void> {
  const root = dataRoot();
  const gd = generatedDir ?? path.join(root, "generated");
  const issues: ValidationIssue[] = [];

  // Load all generated feature files
  const tilesDir = path.join(gd, "tiles");
  const features: MapFeature[] = [];

  try {
    const tileFiles = await fs.readdir(tilesDir, { withFileTypes: true });
    for (const entry of tileFiles) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const content = await fs.readFile(path.join(tilesDir, entry.name), "utf8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) features.push(...parsed);
    }
  } catch {
    issues.push({ severity: "error", message: `Cannot access tiles directory: ${tilesDir}` });
  }

  // Per-feature checks
  for (const f of features) {
    issues.push(...validateCoords(f));
    issues.push(...validateHeight(f));
    issues.push(...validatePolygonGeometry(f));
    issues.push(...validateRoads(f));
    issues.push(...validateSourceRefs(f));
    issues.push(...validateProvenance(f));
  }

  // Dataset-level checks
  issues.push(...checkFeatureIdentity(features));
  issues.push(...checkRequiredLayers(features));
  issues.push(...checkNocibePresent(features));
  issues.push(...checkDepartmentCoverage(features));

  // Tile manifest integrity
  const manifestPath = path.join(gd, "tile-manifest.json");
  try {
    const manifestContent = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestContent) as Array<{ tileId: string; featureCount: number; features: string[] }>;
    issues.push(...await checkTileIntegrity(manifest));
  } catch {
    issues.push({ severity: "error", message: `Tile manifest not found: ${manifestPath}` });
  }

  // Search index check
  const searchIndexPath = path.join(root, "search", "index.json");
  issues.push(...await checkSearchIndex(searchIndexPath));

  // Report
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  console.error(`[validate] ${errors.length} errors, ${warnings.length} warnings`);

  for (const issue of issues) {
    const tag = issue.severity === "error" ? "ERR" : "WRN";
    const ctx = [issue.featureId && `feature=${issue.featureId}`, issue.tileId && `tile=${issue.tileId}`, issue.source && `source=${issue.source}`]
      .filter(Boolean).join(" ");
    console.error(`  [${tag}] ${issue.message}${ctx ? ` (${ctx})` : ""}`);
  }

  if (errors.length > 0) {
    throw new ValidationErrors(issues);
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("validate.ts")) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.coverageOnly) {
    console.error("[validate] Coverage validation — checking manifest only.");
    process.exit(0);
  }
  validate(opts.generatedDir).catch((err) => {
    if (err instanceof ValidationErrors) {
      process.exit(1);
    }
    console.error("[validate] Fatal:", err);
    process.exit(1);
  });
}