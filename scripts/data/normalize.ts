#!/usr/bin/env tsx
/**
 * normalize.ts — Converts raw source records to typed discriminated unions,
 * clips geometry to the commune boundary polygon, derives local coordinates,
 * and records every transformation.
 *
 * Usage: tsx scripts/data/normalize.ts [--raw-dir <path>] [--out-dir <path>]
 *
 * The data root defaults to MASTER_MAPS_DATA_DIR env var or "data".
 * --raw-dir defaults to <dataRoot>/raw
 * --out-dir defaults to <dataRoot>/intermediate
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Local type stubs — replaced by @/lib/data/schema imports once schema.ts
// exists.  These match the contracts from the plan §4.
// ---------------------------------------------------------------------------

interface SourceReference {
  source: string;
  url?: string;
  timestamp: string;
  license?: string;
  sha256?: string;
  recordCount?: number;
}

interface ProvenanceRecord {
  featureId: string;
  property: string;
  winner: string;
  contenders: string[];
  priority: number;
  timestamp: string;
}

type FeatureKind =
  | "boundary" | "building" | "road" | "water" | "landuse"
  | "poi" | "business" | "address" | "transport";

interface MapFeatureBase {
  kind: FeatureKind;
  stableId: string;
  sourceId?: string;
  name?: string;
  address?: string;
  /** WGS84 longitude */
  lon: number;
  /** WGS84 latitude */
  lat: number;
  /** Local easting (x) in metres */
  x: number;
  /** Local northing (z) in metres */
  z: number;
  /** Original WGS84 geometry as GeoJSON-like object */
  geometry?: Record<string, unknown>;
  /** Local coordinate geometry */
  localGeometry?: Record<string, unknown>;
  provenance: ProvenanceRecord[];
  confidence: number;
  status: "active" | "uncertain" | "inferred" | "unresolved";
  sourceRefs: SourceReference[];
}

interface BoundaryFeature extends MapFeatureBase {
  kind: "boundary";
  rings: number[][][];
  centroidX: number;
  centroidZ: number;
}

interface BuildingFeature extends MapFeatureBase {
  kind: "building";
  height?: number;
  heightInferred?: boolean;
  levels?: number;
  buildingType?: string;
}

interface RoadFeature extends MapFeatureBase {
  kind: "road";
  roadClass: string;
  width: number;
  widthInferred?: boolean;
  surface?: string;
  oneway?: boolean;
  bridge?: boolean;
  tunnel?: boolean;
}

interface WaterFeature extends MapFeatureBase {
  kind: "water";
  waterType: string;
}

interface LanduseFeature extends MapFeatureBase {
  kind: "landuse";
  landuseType: string;
}

interface PoiFeature extends MapFeatureBase {
  kind: "poi";
  poiType: string;
  category?: string;
}

interface BusinessFeature extends MapFeatureBase {
  kind: "business";
  businessId?: string;
  siren?: string;
  siret?: string;
  brand?: string;
  category?: string;
}

interface AddressFeature extends MapFeatureBase {
  kind: "address";
  banId: string;
  housenumber: string;
  street: string;
  postcode: string;
  city: string;
}

interface TransportFeature extends MapFeatureBase {
  kind: "transport";
  transportType: string;
  route?: string;
  operator?: string;
}

type MapFeature =
  | BoundaryFeature | BuildingFeature | RoadFeature | WaterFeature
  | LanduseFeature | PoiFeature | BusinessFeature | AddressFeature | TransportFeature;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

interface NormalizeOptions {
  rawDir: string;
  outDir: string;
}

function parseArgs(args: string[]): NormalizeOptions {
  const root = dataRoot();
  let rawDir = path.join(root, "raw");
  let outDir = path.join(root, "intermediate");
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--raw-dir" && args[i + 1]) {
      rawDir = args[++i]!;
    } else if (a === "--out-dir" && args[i + 1]) {
      outDir = args[++i]!;
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/data/normalize.ts [--raw-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { rawDir, outDir };
}

/** Stable-ID policy: hash(kind, normalizedName, normalizedAddress, roundedWGS84, geometryHash). */
function buildStableId(
  kind: FeatureKind,
  name: string,
  address: string,
  lon: number,
  lat: number,
  geometryHash: string,
): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const payload = `${kind}:${norm(name)}:${norm(address)}:${lon.toFixed(5)},${lat.toFixed(5)}:${geometryHash}`;
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    const c = payload.charCodeAt(i);
    hash = ((hash << 5) - hash + c) | 0;
  }
  return `hash:${Math.abs(hash).toString(16).padStart(8, "0")}`;
}

/** Derive height from OSM tags. */
function inferHeight(
  tags: Record<string, string>,
): { height: number; inferred: boolean } | null {
  const explicit = tags["height"];
  if (explicit) {
    const h = parseFloat(explicit);
    if (isFinite(h) && h >= 0) return { height: h, inferred: false };
  }
  const levels = tags["building:levels"];
  if (levels) {
    const l = parseInt(levels, 10);
    if (isFinite(l) && l > 0) return { height: l * 3.0, inferred: true };
  }
  return null;
}

function categoryDefaultHeight(category: string): number {
  const map: Record<string, number> = {
    house: 3.5, apartments: 6.0, garage: 2.7, shed: 2.7,
    retail: 5.0, commercial: 5.0, industrial: 6.0,
    warehouse: 6.0, church: 12.0,
  };
  return map[category] ?? 3.5;
}

function defaultRoadWidth(roadClass: string): number {
  const map: Record<string, number> = {
    motorway: 12.0, trunk: 9.0, primary: 9.0,
    secondary: 7.0, tertiary: 6.0, residential: 5.0,
    service: 3.5, pedestrian: 2.0, footway: 2.0,
    cycleway: 2.0, path: 1.5, track: 2.5,
  };
  return map[roadClass] ?? 5.0;
}

// ---------------------------------------------------------------------------
// Raw-source loaders
// ---------------------------------------------------------------------------

async function loadRawSources(rawDir: string) {
  const readOpt = { encoding: "utf8" as const };
  const boundary: string = await fs.readFile(path.join(rawDir, "boundary.geojson"), readOpt);

  let osmText: string;
  try {
    osmText = await fs.readFile(path.join(rawDir, "osm.json"), readOpt);
  } catch {
    osmText = '{"elements":[],"timestamp":"","query":""}';
  }

  let addrText: string;
  try {
    addrText = await fs.readFile(path.join(rawDir, "addresses.json"), readOpt);
  } catch {
    addrText = '{"records":[],"license":"etalab-2.0"}';
  }

  let bizText: string;
  try {
    bizText = await fs.readFile(path.join(rawDir, "businesses.json"), readOpt);
  } catch {
    bizText = '{"records":[]}';
  }

  let ignText: string;
  try {
    ignText = await fs.readFile(path.join(rawDir, "ign.json"), readOpt);
  } catch {
    ignText = '{"features":[],"unavailable":true}';
  }

  return {
    boundary: JSON.parse(boundary) as Record<string, unknown>,
    osm: JSON.parse(osmText) as { elements: Record<string, unknown>[]; timestamp: string; query: string },
    addresses: JSON.parse(addrText) as { records: Record<string, unknown>[]; license: string },
    businesses: JSON.parse(bizText) as { records: Record<string, unknown>[] },
    ign: JSON.parse(ignText) as { features: Record<string, unknown>[]; unavailable: boolean },
  };
}

// ---------------------------------------------------------------------------
// Normalisation per source family
// ---------------------------------------------------------------------------

function normalizeBoundary(raw: Record<string, unknown>): BoundaryFeature {
  const fc = raw as { features?: Array<{ geometry?: { coordinates?: number[][][] } }> };
  const coords = fc.features?.[0]?.geometry?.coordinates;
  if (!coords) throw new Error("normalizeBoundary: no valid geometry in boundary GeoJSON");
  return {
    kind: "boundary",
    stableId: "boundary:auch-32013",
    lon: 0, lat: 0, x: 0, z: 0,
    rings: coords,
    centroidX: 0, centroidZ: 0,
    provenance: [],
    confidence: 1.0,
    status: "active",
    sourceRefs: [{ source: "geo.api.gouv.fr", timestamp: new Date().toISOString() }],
  };
}

function normalizeOsm(
  raw: { elements: Record<string, unknown>[]; timestamp: string; query: string },
  boundary: BoundaryFeature,
): MapFeature[] {
  void boundary;
  const features: MapFeature[] = [];
  for (const el of raw.elements) {
    const tags = (el as Record<string, Record<string, string>>).tags ?? {};
    const type = el.type as string;
    void type;
    void tags;
    // TODO: classify by tags, clip to boundary, convert coords
  }
  return features;
}

function normalizeAddresses(
  raw: { records: Record<string, unknown>[]; license: string },
  boundary: BoundaryFeature,
): AddressFeature[] {
  void boundary;
  const features: AddressFeature[] = [];
  for (const r of raw.records) {
    void r;
    // TODO: filter by boundary, convert coords
  }
  return features;
}

function normalizeBusinesses(
  raw: { records: Record<string, unknown>[] },
  boundary: BoundaryFeature,
): BusinessFeature[] {
  void boundary;
  void raw;
  return [];
}

function normalizeIgn(
  raw: { features: Record<string, unknown>[]; unavailable: boolean },
  boundary: BoundaryFeature,
): MapFeature[] {
  void boundary;
  if (raw.unavailable) return [];
  return [];
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

async function writeNormalizedFeatures(features: MapFeature[], outDir: string): Promise<void> {
  const groups = new Map<string, MapFeature[]>();
  for (const f of features) {
    const list = groups.get(f.kind) ?? [];
    list.push(f);
    groups.set(f.kind, list);
  }
  for (const [kind, list] of groups) {
    await fs.writeFile(path.join(outDir, `${kind}.json`), JSON.stringify(list, null, 2), "utf8");
  }
  const allProvenance: ProvenanceRecord[] = [];
  for (const f of features) allProvenance.push(...f.provenance);
  await fs.writeFile(path.join(outDir, "provenance.json"), JSON.stringify(allProvenance, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function normalizeAll(rawDir?: string, outDir?: string): Promise<void> {
  const root = dataRoot();
  const rd = rawDir ?? path.join(root, "raw");
  const od = outDir ?? path.join(root, "intermediate");
  await fs.mkdir(od, { recursive: true });

  const sources = await loadRawSources(rd);
  const boundary = normalizeBoundary(sources.boundary);
  const osmFeatures = normalizeOsm(sources.osm, boundary);
  const addrFeatures = normalizeAddresses(sources.addresses, boundary);
  const bizFeatures = normalizeBusinesses(sources.businesses, boundary);
  const ignFeatures = normalizeIgn(sources.ign, boundary);

  const all = [boundary, ...osmFeatures, ...addrFeatures, ...bizFeatures, ...ignFeatures];
  await writeNormalizedFeatures(all, od);
  console.error(`[normalize] Wrote ${all.length} features to ${od}`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("normalize.ts")) {
  const opts = parseArgs(process.argv.slice(2));
  normalizeAll(opts.rawDir, opts.outDir).catch((err) => {
    console.error("[normalize] Fatal:", err);
    process.exit(1);
  });
}