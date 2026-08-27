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
  [key: string]: unknown;
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
/** Higher number = higher priority for the named field's canonical value. */
function sourcePriority(sourceName: string): number {
  if (sourceName === "IGN BD TOPO" || sourceName === "ign-bdtopo") return 100;
  if (sourceName === "IGN ADMIN EXPRESS COG") return 100;
  if (sourceName === "geo.api.gouv.fr") return 90;
  if (sourceName === "sirene") return 80;
  if (sourceName === "annuaire-entreprises") return 75;
  if (sourceName === "ban") return 70;
  if (sourceName === "official-website") return 90;
  if (sourceName === "osm") return 60;
  if (sourceName === "pagesjaunes") return 40;
  if (sourceName === "google-maps") return 10;
  return 50;
}

function geometrySourcePriority(feature: MapFeature): number {
  const source = feature.sourceRefs?.[0]?.source ?? "unknown";
  if (feature.kind === "address") return source === "ban" ? 100 : sourcePriority(source);
  if (feature.kind === "business") return source === "ban" ? 90 : sourcePriority(source);
  if (feature.kind === "building" || feature.kind === "road" || feature.kind === "water") {
    return source === "IGN BD TOPO" || source === "ign-bdtopo" ? 100 : sourcePriority(source);
  }
  return sourcePriority(source);
}

function pickPriorityScalar(
  contenders: Array<{ source: string; value: unknown }>,
): { winner: unknown; winnerSource: string; contenders: string[] } {
  if (contenders.length === 0) {
    return { winner: undefined, winnerSource: "unknown", contenders: [] };
  }
  const sorted = [...contenders].sort((a, b) => sourcePriority(b.source) - sourcePriority(a.source));
  return {
    winner: sorted[0]!.value,
    winnerSource: sorted[0]!.source,
    contenders: contenders.length > 1
      ? contenders.map((c) => `${c.source}=${JSON.stringify(c.value)}`)
      : [],
  };
}

// ---------------------------------------------------------------------------
// Deduplication logic
// ---------------------------------------------------------------------------

/** Load all intermediate feature files from inDir. */
async function loadAllFeatures(inDir: string): Promise<MapFeature[]> {
  const dir = await fs.readdir(inDir, { withFileTypes: true });
  const features: MapFeature[] = [];
  const skipFiles = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json"]);

  for (const entry of dir) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || skipFiles.has(entry.name)) continue;
    const content = await fs.readFile(path.join(inDir, entry.name), "utf8");
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) continue;
    features.push(...(parsed as MapFeature[]));
  }
  return features;
}
function normalizedName(value: string | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const geometryBoundsCache = new WeakMap<MapFeature, [number, number, number, number] | null>();

function geometryBounds(feature: MapFeature): [number, number, number, number] | null {
  const cached = geometryBoundsCache.get(feature);
  if (cached !== undefined) return cached;
  const geometry = feature.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    geometryBoundsCache.set(feature, null);
    return null;
  }
  const points: number[][] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      points.push([value[0], value[1]]);
      return;
    }
    for (const child of value) collect(child);
  };
  collect(geometry.coordinates);
  if (points.length === 0) {
    geometryBoundsCache.set(feature, null);
    return null;
  }
  const bounds: [number, number, number, number] = [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])),
  ];
  geometryBoundsCache.set(feature, bounds);
  return bounds;
}

function boundsOverlap(first: [number, number, number, number], second: [number, number, number, number]): boolean {
  return first[0] <= second[2] && first[2] >= second[0] && first[1] <= second[3] && first[3] >= second[1];
}

function canConflate(first: MapFeature, second: MapFeature): boolean {
  if (first.kind !== second.kind || first.kind === "boundary") return false;
  const firstSource = first.sourceRefs?.[0]?.source ?? "unknown";
  const secondSource = second.sourceRefs?.[0]?.source ?? "unknown";
  if (firstSource === secondSource) return false;
  if (first.kind === "business") {
    if (first.siret && second.siret) return first.siret === second.siret;
    return normalizedName(first.name) === normalizedName(second.name)
      && Math.hypot(first.x - second.x, first.z - second.z) <= 150;
  }
  if (first.kind === "address") {
    if (first.banId && second.banId) return first.banId === second.banId;
    return normalizedName(first.name) === normalizedName(second.name)
      && Math.hypot(first.x - second.x, first.z - second.z) <= 15;
  }
  const firstBounds = geometryBounds(first);
  const secondBounds = geometryBounds(second);
  if (!firstBounds || !secondBounds || !boundsOverlap(firstBounds, secondBounds)) return false;
  if (first.kind === "building") {
    return Math.hypot(first.x - second.x, first.z - second.z) <= 25;
  }
  if (first.kind === "road") {
    const namesAgree = normalizedName(first.name) !== "" && normalizedName(first.name) === normalizedName(second.name);
    const classesAgree = first.roadClass !== undefined && first.roadClass === second.roadClass;
    return namesAgree || (classesAgree && Math.hypot(first.x - second.x, first.z - second.z) <= 30);
  }
  if (first.kind === "water") {
    return first.waterType === second.waterType || firstSource.includes("IGN") || secondSource.includes("IGN");
  }
  return false;
}

/**
 * Deduplicate a list of features by stableId, merging properties
 * with source-priority rules and recording every conflict.
 */
function deduplicateGroup(group: MapFeature[]): MapFeature | null {
  if (group.length === 0) return null;
  const ordered = [...group].sort((first, second) =>
    geometrySourcePriority(second) - geometrySourcePriority(first));
  const base = { ...ordered[0]! };
  const provenance: ProvenanceRecord[] = [...(base.provenance ?? [])];
  const geometryWinner = ordered.find((feature) => feature.geometry !== undefined);
  if (geometryWinner?.geometry !== undefined) {
    base.geometry = geometryWinner.geometry;
    base.localGeometry = geometryWinner.localGeometry;
    base.sourceGeometry = geometryWinner.sourceGeometry;
    if (group.length > 1) {
      provenance.push({
        featureId: base.stableId,
        property: "geometry",
        winner: geometryWinner.sourceRefs?.[0]?.source ?? "unknown",
        contenders: group.map((feature) => feature.sourceRefs?.[0]?.source ?? "unknown"),
        priority: geometrySourcePriority(geometryWinner),
        timestamp: new Date().toISOString(),
      });
    }
  }
  const sourceRefs: SourceReference[] = [];
  const seenReferences = new Set<string>();

  for (const feature of group) {
    for (const reference of feature.sourceRefs ?? []) {
      const key = `${reference.source}|${reference.url ?? ""}|${reference.sha256 ?? ""}`;
      if (seenReferences.has(key)) continue;
      seenReferences.add(key);
      sourceRefs.push(reference);
    }
  }

  const propertyConflicts = [
    "name", "address", "lon", "lat", "height", "roadClass", "width",
    "poiType", "banId", "siren", "siret", "buildingType", "businessId",
    "businessName", "legalName", "brand", "category", "nafCode", "nafLabel",
    "website", "phone", "openingHours", "operator", "wheelchair",
    "administrativeStatus", "creationDate",
  ] as const;

  for (const prop of propertyConflicts) {
    const contenders: Array<{ source: string; value: unknown }> = [];
    for (const feature of group) {
      const value = feature[prop];
      if (value !== undefined && value !== null && value !== "") {
        const source = feature.sourceRefs?.[0]?.source ?? "unknown";
        contenders.push({ source, value });
      }
    }
    if (contenders.length === 0) continue;

    const deduped = pickPriorityScalar(contenders);
    (base as Record<string, unknown>)[prop] = deduped.winner;
    if (deduped.contenders.length === 0) continue;

    provenance.push({
      featureId: base.stableId,
      property: prop,
      winner: `${deduped.winnerSource}=${JSON.stringify(deduped.winner)}`,
      contenders: deduped.contenders,
      priority: sourcePriority(deduped.winnerSource),
      timestamp: new Date().toISOString(),
    });
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
 * Deduplication entry point. Stable IDs are exact matches; all other
 * cross-source merges must pass the conservative conflation predicate.
 */
/**
 * Conflates only same-kind records passing conservative identity and spatial
 * tests; stable IDs remain a fast exact-match path.
 */
export function deduplicateFeatures(features: MapFeature[]): MapFeature[] {
  const groups: MapFeature[][] = [];
  const exactGroup = new Map<string, number>();
  const buckets = new Map<string, number[]>();
  const bucketSources = new Map<string, Set<string>>();
  const bucketSize = 100;
  const bucketFor = (feature: MapFeature): [number, number] => [
    Math.floor(feature.x / bucketSize),
    Math.floor(feature.z / bucketSize),
  ];
  const sourceFor = (feature: MapFeature): string => feature.sourceRefs?.[0]?.source ?? "unknown";
  for (const feature of features) {
    let groupIndex = exactGroup.get(feature.stableId);
    const source = sourceFor(feature);
    if (groupIndex === undefined) {
      const [col, row] = bucketFor(feature);
      for (let rowOffset = -1; rowOffset <= 1 && groupIndex === undefined; rowOffset += 1) {
        for (let colOffset = -1; colOffset <= 1 && groupIndex === undefined; colOffset += 1) {
          const bucket = `${feature.kind}:${col + colOffset}:${row + rowOffset}`;
          for (const otherSource of bucketSources.get(bucket) ?? []) {
            if (otherSource === source) continue;
            const candidates = buckets.get(`${bucket}:${otherSource}`) ?? [];
            groupIndex = candidates.find((candidate) => groups[candidate]!.some((existing) => canConflate(existing, feature)));
            if (groupIndex !== undefined) break;
          }
        }
      }
    }
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      groups.push([feature]);
    } else {
      groups[groupIndex]!.push(feature);
    }
    exactGroup.set(feature.stableId, groupIndex);
    const [col, row] = bucketFor(feature);
    const bucket = `${feature.kind}:${col}:${row}`;
    const key = `${bucket}:${source}`;
    buckets.set(key, [...(buckets.get(key) ?? []), groupIndex]);
    const sources = bucketSources.get(bucket) ?? new Set<string>();
    sources.add(source);
    bucketSources.set(bucket, sources);
  }
  return groups.flatMap((group) => {
    const merged = deduplicateGroup(group);
    return merged ? [merged] : [];
  });
}
async function writeJsonArray(filePath: string, values: Iterable<unknown>): Promise<void> {
  const handle = await fs.open(filePath, "w");
  let buffer = "[";
  let first = true;
  try {
    for (const value of values) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) continue;
      if (!first) buffer += ",\n";
      buffer += encoded;
      first = false;
      if (buffer.length >= 1024 * 1024) {
        await handle.write(buffer);
        buffer = "";
      }
    }
    await handle.write(`${buffer}\n]\n`);
  } finally {
    await handle.close();
  }
}

async function writeDedupedFeatures(features: MapFeature[], outDir: string): Promise<void> {
  const preserved = new Set([
    "boundary-source.json",
    "bdtopo-manifest.json",
    "ign-unavailable.json",
    "osm-manifest.json",
    "osm-bulk-manifest.json",
    "relation-issues.json",
  ]);
  for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !preserved.has(entry.name)) {
      await fs.unlink(path.join(outDir, entry.name));
    }
  }

  const groups = new Map<string, MapFeature[]>();
  for (const feature of features) {
    const list = groups.get(feature.kind) ?? [];
    list.push(feature);
    groups.set(feature.kind, list);
  }
  const chunkSize = 20_000;
  for (const [kind, list] of groups) {
    for (let offset = 0; offset < list.length; offset += chunkSize) {
      const suffix = offset === 0 ? "" : `-${String(offset / chunkSize).padStart(4, "0")}`;
      await writeJsonArray(path.join(outDir, `${kind}${suffix}.json`), list.slice(offset, offset + chunkSize));
    }
  }
  function* provenanceRecords(): Iterable<ProvenanceRecord> {
    for (const feature of features) {
      yield* feature.provenance;
    }
  }
  await writeJsonArray(path.join(outDir, "provenance.json"), provenanceRecords());
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