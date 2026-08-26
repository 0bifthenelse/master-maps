#!/usr/bin/env tsx
/**
 * build-search-index.ts — Writes an accent-insensitive search index with:
 *   - canonical name, normalized name, source-backed aliases
 *   - feature type, category, tile ID, feature ID, focus coordinates
 *
 * Accent-insensitive normalisation: NFD decompose, remove combining marks,
 * lower case, then tokenise.
 *
 * Scoring tiers (higher first):
 *   1. Exact canonical match (accent/case insensitive)
 *   2. Prefix match
 *   3. Containment match
 *   4. Edit-distance (bounded)
 *
 * Usage: tsx scripts/data/build-search-index.ts [--in-dir <path>] [--out-dir <path>]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Type stubs
// ---------------------------------------------------------------------------

interface SearchRecord {
  /** Stable feature ID */
  featureId: string;
  /** Canonical display name */
  canonicalName: string;
  /** Accent/case-normalized search key */
  normalizedName: string;
  /** Additional aliases for searching */
  aliases: string[];
  /** Feature kind */
  kind: string;
  /** Optional sub-category */
  category?: string;
  /** Tile ID containing this feature */
  tileId?: string;
  /** Focus coordinate (west, south, east, north or lon, lat) */
  focusLon: number;
  focusLat: number;
  /** Priority boost (higher = ranked first among ties) */
  boost: number;
}

interface TileManifest {
  tileId: string;
  featureCount: number;
  features: string[];
}

interface MapFeature {
  kind: string;
  stableId: string;
  name?: string;
  address?: string;
  lon: number;
  lat: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

interface IndexOptions {
  inDir: string;
  outDir: string;
}

function parseArgs(args: string[]): IndexOptions {
  const root = dataRoot();
  let inDir = path.join(root, "generated", "tiles");
  let outDir = path.join(root, "search");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in-dir" && args[i + 1]) { inDir = args[++i]!; }
    else if (a === "--out-dir" && args[i + 1]) { outDir = args[++i]!; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/data/build-search-index.ts [--in-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { inDir, outDir };
}

// ---------------------------------------------------------------------------
// Unicode accent normalisation
// ---------------------------------------------------------------------------

/** Remove combining diacritical marks (NFD + strip \u0300-\u036f). */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Lowercase, strip accents, collapse whitespace. */
function normalizedKey(s: string): string {
  return stripAccents(s).toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreMatch(query: string, target: string, boost: number): number {
  const nq = normalizedKey(query);
  const nt = normalizedKey(target);
  if (nt === nq) return 1000 + boost;               // exact match
  if (nt.startsWith(nq)) return 500 + boost;         // prefix
  if (nt.includes(nq)) return 100 + boost;           // containment
  return 0;
}

/**
 * Levenshtein distance, bounded — return -1 if distance exceeds maxDist.
 */
function boundedEditDistance(a: string, b: string, maxDist: number): number {
  const na = normalizedKey(a);
  const nb = normalizedKey(b);
  if (Math.abs(na.length - nb.length) > maxDist) return -1;

  const rows = na.length + 1;
  const cols = nb.length + 1;
  const matrix: number[][] = [];

  for (let i = 0; i < rows; i++) {
    matrix[i] = [i];
    for (let j = 1; j < cols; j++) {
      if (i === 0) {
        matrix[i]![j] = j;
      } else {
        const cost = na[i - 1] === nb[j - 1] ? 0 : 1;
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j]! + 1,       // deletion
          matrix[i]![j - 1]! + 1,       // insertion
          matrix[i - 1]![j - 1]! + cost, // substitution
        );
      }
      // Early prune if all values in this row exceed maxDist
      if (i === rows - 1 && matrix[i]![j]! <= maxDist) {
        // continue — we have at least one viable path
      }
    }
  }

  const dist = matrix[na.length]![nb.length]!;
  return dist <= maxDist ? dist : -1;
}

// ---------------------------------------------------------------------------
// Index building
// ---------------------------------------------------------------------------

/** Load features from tile files and the tile manifest. */
async function loadData(
  tilesDir: string,
): Promise<{ features: MapFeature[]; tileMap: Map<string, string> }> {
  const dir = await fs.readdir(tilesDir, { withFileTypes: true });
  const features: MapFeature[] = [];
  const tileMap = new Map<string, string>(); // featureId → tileId

  for (const entry of dir) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const tileId = entry.name.replace(/\.json$/, "");
    const content = await fs.readFile(path.join(tilesDir, entry.name), "utf8");
    const parsed = JSON.parse(content);
    // Could be array of features (tile) or a manifest
    if (Array.isArray(parsed)) {
      for (const f of parsed as MapFeature[]) {
        features.push(f);
        tileMap.set(f.stableId, tileId);
      }
    }
  }
  return { features, tileMap };
}

/** Generate known aliases for a feature. */
function generateAliases(feature: MapFeature): string[] {
  const aliases: string[] = [];
  if (feature.address) {
    const addrKey = normalizedKey(feature.address);
    if (addrKey) aliases.push(addrKey);
  }
  // Extract street number from address
  const addr = feature.address ?? "";
  const numMatch = addr.match(/^(\d+)/);
  if (numMatch && feature.name) {
    aliases.push(`${numMatch[1]} ${normalizedKey(feature.name)}`);
  }
  return aliases.filter(Boolean);
}

/**
 * Build the complete search index.
 */
export function buildSearchIndex(
  features: MapFeature[],
  tileMap: Map<string, string>,
  outputPath: string,
): SearchRecord[] {
  const records: SearchRecord[] = [];

  for (const f of features) {
    const name = f.name ?? f.stableId;
    const normalized = normalizedKey(name);
    const aliases = generateAliases(f);

    // Boost business and POI features
    let boost = 0;
    const kind = f.kind;
    if (kind === "business") boost = 200;
    else if (kind === "poi") boost = 100;
    else if (kind === "address") boost = 50;
    else if (kind === "building") boost = 10;

    const tileId = tileMap.get(f.stableId);
    records.push({
      featureId: f.stableId,
      canonicalName: name,
      normalizedName: normalized,
      aliases,
      kind,
      category: (f as Record<string, string>).category ?? (f as Record<string, string>).poiType ?? undefined,
      tileId,
      focusLon: f.lon,
      focusLat: f.lat,
      boost,
    });
  }

  // Write the index file
  const indexPath = outputPath;
  // write in caller — just return

  return records;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildIndexAll(
  inDir?: string,
  outDir?: string,
): Promise<void> {
  const root = dataRoot();
  const ind = inDir ?? path.join(root, "generated", "tiles");
  const otd = outDir ?? path.join(root, "search");

  await fs.mkdir(otd, { recursive: true });

  const { features, tileMap } = await loadData(ind);
  const records = buildSearchIndex(features, tileMap, path.join(otd, "index.json"));

  await fs.writeFile(path.join(otd, "index.json"), JSON.stringify(records, null, 2), "utf8");
  console.error(`[search-index] Wrote ${records.length} search records to ${otd}/index.json`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("build-search-index.ts")) {
  const opts = parseArgs(process.argv.slice(2));
  buildIndexAll(opts.inDir, opts.outDir).catch((err) => {
    console.error("[search-index] Fatal:", err);
    process.exit(1);
  });
}