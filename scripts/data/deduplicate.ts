#!/usr/bin/env tsx
/**
 * deduplicate.ts — Applies stable-ID and property-specific conflict rules
 * while retaining every source reference and disagreement.
 *
 * Deduplication strategy:
 *  1. Group features by stableId.
 *  2. Within each group, merge properties using source-priority policy:
 *     - Official/IGN geometry > casual directory geometry.
 *     - BAN > other address normalisation.
 *     - SIRENE/Annuaire > other business identity.
 *     - Official business website > public directory.
 *     - OSM supplies detailed geometry when current.
 *     - Google Maps only corroborates presence.
 *  3. Every conflict becomes a ProvenanceRecord entry.
 *  4. Features with identical stableId but contradictory geometry / position
 *     produce an "uncertain" status.
 *
 * Usage: tsx scripts/data/deduplicate.ts [--in-dir <path>] [--out-dir <path>]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Type stubs (mirrors normalize.ts; replaced by @/lib/data/schema.ts)
// ---------------------------------------------------------------------------

interface ProvenanceRecord {
  featureId: string;
  property: string;
  winner: string;
  contenders: string[];
  priority: number;
  timestamp: string;
}

interface SourceReference {
  source: string;
  url?: string;
  timestamp: string;
  license?: string;
  sha256?: string;
  recordCount?: number;
}

type FeatureKind =
  | "boundary" | "building" | "road" | "water" | "landuse"
  | "poi" | "business" | "address" | "transport";

interface MapFeature {
  kind: FeatureKind;
  stableId: string;
  sourceId?: string;
  name?: string;
  address?: string;
  lon: number;
  lat: number;
  x: number;
  z: number;
  geometry?: Record<string, unknown>;
  localGeometry?: Record<string, unknown>;
  provenance: ProvenanceRecord[];
  confidence: number;
  status: "active" | "uncertain" | "inferred" | "unresolved";
  sourceRefs: SourceReference[];
  // per-kind extras
  height?: number;
  heightInferred?: boolean;
  roadClass?: string;
  width?: number;
  widthInferred?: boolean;
  poiType?: string;
  banId?: string;
  siren?: string;
  siret?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

interface DupOptions {
  inDir: string;
  outDir: string;
}

function parseArgs(args: string[]): DupOptions {
  const root = dataRoot();
  let inDir = path.join(root, "intermediate");
  let outDir = path.join(root, "intermediate"); // dedup overwrites intermediate
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in-dir" && args[i + 1]) {
      inDir = args[++i]!;
    } else if (a === "--out-dir" && args[i + 1]) {
      outDir = args[++i]!;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/data/deduplicate.ts [--in-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { inDir, outDir };
}

// ---------------------------------------------------------------------------
// Source priority mapping
// ---------------------------------------------------------------------------

/** Higher number = higher priority. */
function sourcePriority(sourceName: string): number {
  const tiers: Record<string, number> = {
    "ign-geoplateforme": 100,
    "geo.api.gouv.fr": 90,
    "sirene": 80,
    "annuaire-entreprises": 75,
    "ban": 70,
    "official-website": 65,
    "osm": 60,
    "pagesjaunes": 40,
    "google-maps": 10,
  };
  return tiers[sourceName] ?? 50;
}

/** Pick the higher-priority value for a scalar property. */
function pickPriorityScalar(
  contenders: Array<{ source: string; value: unknown }>,
): { winner: unknown; contenders: string[] } {
  if (contenders.length === 0) return { winner: undefined, contenders: [] };
  if (contenders.length === 1) return { winner: contenders[0]!.value, contenders: [] };
  const sorted = [...contenders].sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source));
  return {
    winner: sorted[0]!.value,
    contenders: contenders.map((c) => `${c.source}=${JSON.stringify(c.value)}`),
  };
}

// ---------------------------------------------------------------------------
// Deduplication logic
// ---------------------------------------------------------------------------

/** Load all intermediate feature files from inDir. */
async function loadAllFeatures(inDir: string): Promise<MapFeature[]> {
  const dir = await fs.readdir(inDir, { withFileTypes: true });
  const features: MapFeature[] = [];
  const skipFiles = new Set(["provenance.json", "boundary-source.json", "ign-unavailable.json", "osm-manifest.json"]);
  for (const entry of dir) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || skipFiles.has(entry.name)) continue;
    const content = await fs.readFile(path.join(inDir, entry.name), "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) continue;
    features.push(...(parsed as MapFeature[]));
  }
  return features;
}

/**
 * Deduplicate a list of features by stableId, merging properties
 * with source-priority rules and recording every conflict.
 */
function deduplicateGroup(group: MapFeature[]): MapFeature | null {
  if (group.length === 0) return null;
  if (group.length === 1) return group[0]!;

  const base = { ...group[0]! };
  const provenance: ProvenanceRecord[] = [...(base.provenance ?? [])];
  const sourceRefs: SourceReference[] = [...(base.sourceRefs ?? [])];
  const seenSources = new Set(sourceRefs.map((s) => s.source));

  // Accumulate source refs
  for (let i = 1; i < group.length; i++) {
    const f = group[i]!;
    for (const sr of f.sourceRefs ?? []) {
      if (!seenSources.has(sr.source)) {
        seenSources.add(sr.source);
        sourceRefs.push(sr);
      }
    }
  }

  // Merge conflicting scalar properties
  const propertyConflicts = [
    "name", "address", "lon", "lat", "height", "roadClass", "width",
    "poiType", "banId", "siren", "siret", "buildingType",
  ] as const;

  for (const prop of propertyConflicts) {
    const contenders: Array<{ source: string; value: unknown }> = [];
    for (const f of group) {
      const val = (f as Record<string, unknown>)[prop];
      if (val !== undefined && val !== null) {
        const src = f.sourceRefs?.[0]?.source ?? "unknown";
        contenders.push({ source: src, value: val });
      }
    }
    const deduped = pickPriorityScalar(contenders);
    if (deduped.contenders.length > 0) {
      (base as Record<string, unknown>)[prop] = deduped.winner;
      provenance.push({
        featureId: base.stableId,
        property: prop,
        winner: `${contenders[0]?.source ?? "unknown"}=${JSON.stringify(deduped.winner)}`,
        contenders: deduped.contenders,
        priority: sourcePriority(contenders[0]?.source ?? "unknown"),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Geometry disagreement → mark uncertain
  const seenCoords = new Set<string>();
  for (const f of group) {
    seenCoords.add(`${f.lon.toFixed(5)},${f.lat.toFixed(5)}`);
  }
  if (seenCoords.size > 1) {
    base.confidence = Math.max(0.3, base.confidence - 0.3 * (seenCoords.size - 1));
    base.status = "uncertain";
  }

  base.provenance = provenance;
  base.sourceRefs = sourceRefs;
  return base;
}

/**
 * Main deduplication entry.
 * Groups features by stableId, deduplicates each group, returns merged list.
 */
export function deduplicateFeatures(features: MapFeature[]): MapFeature[] {
  const groups = new Map<string, MapFeature[]>();
  for (const f of features) {
    const list = groups.get(f.stableId) ?? [];
    list.push(f);
    // Assign a stableId if missing (should not happen after normalise)
    groups.set(f.stableId ?? `gen:${f.lon},${f.lat}`, list);
  }

  const result: MapFeature[] = [];
  for (const [_id, group] of groups) {
    const merged = deduplicateGroup(group);
    if (merged) result.push(merged);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

async function writeDedupedFeatures(features: MapFeature[], outDir: string): Promise<void> {
  const groups = new Map<string, MapFeature[]>();
  for (const f of features) {
    const list = groups.get(f.kind) ?? [];
    list.push(f);
    groups.set(f.kind, list);
  }
  for (const [kind, list] of groups) {
    await fs.writeFile(path.join(outDir, `${kind}.json`), JSON.stringify(list, null, 2), "utf8");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function deduplicateAll(inDir?: string, outDir?: string): Promise<void> {
  const root = dataRoot();
  const ind = inDir ?? path.join(root, "intermediate");
  const otd = outDir ?? path.join(root, "intermediate");
  await fs.mkdir(otd, { recursive: true });

  const features = await loadAllFeatures(ind);
  const deduped = deduplicateFeatures(features);

  await writeDedupedFeatures(deduped, otd);
  console.error(`[deduplicate] Merged ${features.length} → ${deduped.length} unique features`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("deduplicate.ts")) {
  const opts = parseArgs(process.argv.slice(2));
  deduplicateAll(opts.inDir, opts.outDir).catch((err) => {
    console.error("[deduplicate] Fatal:", err);
    process.exit(1);
  });
}