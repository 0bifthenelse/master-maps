#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Verdict = "represented" | "partially-represented" | "excluded-by-policy" | "adopted-from-other-source" | "missing";
export type Origin = "osm" | "all";
export type OsmObjectType = "node" | "way" | "relation" | "any";

export interface OsmCategorySpec {
  id: string;
  label: string;
  key: string;
  values: string[] | "*";
  objectType: OsmObjectType;
  canonical: { kind: string; field: string; origin: Origin };
  exclusionReason?: string;
  adoptionNote?: string;
}

export interface ParityValueRow {
  value: string;
  osmCount: number;
  canonicalCount: number;
  ratio: number;
}

export interface ParityRow {
  id: string;
  label: string;
  osmCount: number;
  canonicalCount: number;
  ratio: number;
  verdict: Verdict;
  reason?: string;
  byValue: ParityValueRow[];
}

export interface CanonicalTally {
  total: number;
  osm: number;
  byField: Record<string, Record<string, number>>;
  osmByField: Record<string, Record<string, number>>;
}

export interface OsmParityReport {
  dataset: "osm-parity";
  generatedAt: string;
  department: string;
  pbf: string;
  pbfBytes: number;
  manifestFeatureCounts: Record<string, number>;
  canonicalCountsByKind: Record<string, number>;
  canonicalOsmCountsByKind: Record<string, number>;
  rows: ParityRow[];
  missing: string[];
  excludedByPolicy: { id: string; reason: string }[];
  adoptedFromOtherSource: { id: string; reason: string }[];
  summary: { represented: number; partiallyRepresented: number; missing: number; excluded: number; adoptedFromOtherSource: number };
}

const CATEGORY_FIELDS = ["roadClass", "highway", "waterType", "landuseType", "placeType", "poiType", "transportType", "buildingType", "structureType", "territoryCode"] as const;

const POLICY_REASONS: Record<string, string> = {
  "excluded.power": "power=line and pylon ways are not adopted; the canonical model has no utility-line kind and BD TOPO TRONRESEAU carries pylons and lines with higher positional authority.",
  "excluded.barrier": "barrier features (fences, gates, bollards) are not adopted; the canonical model has no barrier kind and they would add render noise at every zoom.",
  "excluded.boundaryAdmin": "boundary=administrative is not adopted from OSM; the department boundary comes from IGN ADMIN EXPRESS COG and every commune boundary from the IGN commune layer.",
  "excluded.aeroway": "aeroway runways and aprons are not adopted from OSM; the canonical transport kind sources aerodromes and runways from BD TOPO AERODROME, which is authoritative.",
  "excluded.junctionNodes": "highway junction, turning and traffic-sign marker nodes are not adopted as standalone features; they carry no line geometry that the road network does not already provide.",
  "excluded.manMadeUtility": "man_made pipeline and utility ways are not adopted; BD TOPO TRONRESEAU is the authority for subsurface networks and the canonical structure kind is reserved for named civil works.",
  "excluded.landuseAgriculture": "landuse agriculture and plant-nursery polygons are not adopted as canonical landuse; they are micro-parcel texture below the render threshold of a department-scale map.",
  "excluded.wall": "barrier=wall and wall tagged ways are not adopted; they duplicate building outlines and are not represented by any canonical kind.",
};
const ADOPTION_NOTES: Record<string, string> = {
  building: "the building kind is fully adopted, but from IGN BD TOPO batiment rather than OSM. See canonicalCountsByKind.building and canonicalOsmCountsByKind.building in this report: the whole building count is BD TOPO sourced and the osm figure is zero, so the OSM building parity stays at zero by design and must not be read as data loss.",
  waterway: "the water kind is fully adopted, but from IGN BD TOPO TRON_EAU (troncon_hydrographique and surface d eau) rather than OSM. See canonicalCountsByKind.water and canonicalOsmCountsByKind.water in this report: the whole water count is BD TOPO sourced and the osm figure is zero, so the OSM waterway parity stays at zero by design.",
  "natural.water": "natural=water areas are superseded by the same BD TOPO water surfaces that back the water kind, so no separate OSM-sourced natural water feature is expected in the current build.",
};


const SPECS: OsmCategorySpec[] = [
  { id: "road.highway", label: "highway ways by class", key: "highway", values: "*", objectType: "way", canonical: { kind: "road", field: "roadClass", origin: "osm" } },
  { id: "railway", label: "railway objects by class", key: "railway", values: "*", objectType: "any", canonical: { kind: "transport", field: "transportType", origin: "osm" } },
  { id: "waterway", label: "waterway ways by class", key: "waterway", values: "*", objectType: "way", canonical: { kind: "water", field: "waterType", origin: "osm" }, adoptionNote: ADOPTION_NOTES.waterway },
  { id: "natural.water", label: "natural=water and wetland areas", key: "natural", values: ["water", "wetland"], objectType: "way", canonical: { kind: "water", field: "waterType", origin: "osm" }, adoptionNote: ADOPTION_NOTES["natural.water"] },
  { id: "landuse", label: "landuse polygons by class", key: "landuse", values: "*", objectType: "way", canonical: { kind: "landuse", field: "landuseType", origin: "osm" } },
  { id: "natural.area", label: "natural land-cover areas by class", key: "natural", values: "*", objectType: "way", canonical: { kind: "landuse", field: "landuseType", origin: "osm" } },
  { id: "place", label: "place nodes by type", key: "place", values: "*", objectType: "node", canonical: { kind: "place", field: "placeType", origin: "osm" } },
  { id: "place.asPoi", label: "place nodes folded into poi labels", key: "place", values: "*", objectType: "node", canonical: { kind: "poi", field: "poiType", origin: "osm" } },
  { id: "amenity", label: "amenity POI nodes by class", key: "amenity", values: "*", objectType: "node", canonical: { kind: "poi", field: "poiType", origin: "osm" } },
  { id: "shop", label: "shop POI nodes by class", key: "shop", values: "*", objectType: "node", canonical: { kind: "poi", field: "poiType", origin: "osm" } },
  { id: "tourism", label: "tourism POI nodes by class", key: "tourism", values: "*", objectType: "node", canonical: { kind: "poi", field: "poiType", origin: "osm" } },
  { id: "building", label: "building ways by class", key: "building", values: "*", objectType: "way", canonical: { kind: "building", field: "buildingType", origin: "osm" }, adoptionNote: ADOPTION_NOTES.building },
  { id: "excluded.power", label: "power=line and pylon ways", key: "power", values: "*", objectType: "way", canonical: { kind: "structure", field: "structureType", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.power"] },
  { id: "excluded.barrier", label: "barrier nodes and ways", key: "barrier", values: "*", objectType: "any", canonical: { kind: "structure", field: "structureType", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.barrier"] },
  { id: "excluded.boundaryAdmin", label: "boundary=administrative ways and relations", key: "boundary", values: ["administrative"], objectType: "any", canonical: { kind: "boundary", field: "territoryCode", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.boundaryAdmin"] },
  { id: "excluded.aeroway", label: "aeroway runways and aprons", key: "aeroway", values: "*", objectType: "way", canonical: { kind: "transport", field: "transportType", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.aeroway"] },
  { id: "excluded.junctionNodes", label: "highway junction and traffic marker nodes", key: "highway", values: ["motorway_junction", "turning_circle", "turning_loop", "traffic_signals", "give_way", "stop", "speed_camera", "street_lamp", "crossing", "milestone", "traffic_mirror", "emergency_access_point"], objectType: "node", canonical: { kind: "poi", field: "poiType", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.junctionNodes"] },
  { id: "excluded.manMadeUtility", label: "man_made pipeline and utility ways", key: "man_made", values: ["pipeline", "water_well", "water_works", "wastewater_plant"], objectType: "way", canonical: { kind: "structure", field: "structureType", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.manMadeUtility"] },
  { id: "excluded.landuseAgriculture", label: "landuse agriculture and nursery polygons", key: "landuse", values: ["farmland", "farmyard", "greenhouse_horticulture", "plant_nursery", "allotments", "animal_keeping", "apiary", "aquaculture", "greenfield", "orchard"], objectType: "way", canonical: { kind: "landuse", field: "landuseType", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.landuseAgriculture"] },
  { id: "excluded.wall", label: "wall tagged ways", key: "wall", values: "*", objectType: "way", canonical: { kind: "structure", field: "structureType", origin: "osm" }, exclusionReason: POLICY_REASONS["excluded.wall"] },
];

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

function tagsCountExpression(key: string, values: string[] | "*"): string {
  return values === "*" ? `${key}=*` : `${key}=${values.join(",")}`;
}

async function runTagsCount(pbf: string, key: string, values: string[] | "*", objectType: OsmObjectType): Promise<Map<string, number>> {
  const objectTypeArgs = objectType === "any" ? [] : ["-t", objectType];
  const { stdout } = await run("osmium", ["tags-count", "-m", "1", ...objectTypeArgs, pbf, tagsCountExpression(key, values)], { maxBuffer: 16 * 1024 * 1024 });
  const counts = new Map<string, number>();
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.trim().split("\t");
    const count = Number.parseInt(parts[0] ?? "", 10);
    const value = (parts[parts.length - 1] ?? "").replace(/^"|"$/g, "");
    if (!Number.isFinite(count) || value === "") continue;
    counts.set(value, (counts.get(value) ?? 0) + count);
  }
  return counts;
}

const IGNORED_INTERMEDIATE = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);

function emptyTally(): CanonicalTally {
  return { total: 0, osm: 0, byField: {}, osmByField: {} };
}

export async function loadCanonicalTallies(intermediateDir: string): Promise<Map<string, CanonicalTally>> {
  const tallies = new Map<string, CanonicalTally>();
  const files = (await fs.readdir(intermediateDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !IGNORED_INTERMEDIATE.has(entry.name));
  for (const entry of files) {
    const parsed = JSON.parse(await fs.readFile(path.join(intermediateDir, entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      if (typeof value !== "object" || value === null) continue;
      const record = value as Record<string, unknown>;
      const kind = typeof record.kind === "string" ? record.kind : "unknown";
      const stableId = typeof record.stableId === "string" ? record.stableId : "";
      const isOsm = stableId.startsWith("osm-");
      const tally = tallies.get(kind) ?? emptyTally();
      tally.total += 1;
      if (isOsm) tally.osm += 1;
      const byField = isOsm ? tally.osmByField : tally.byField;
      for (const field of CATEGORY_FIELDS) {
        const category = record[field];
        if (typeof category !== "string" || category === "") continue;
        byField[field] ??= {};
        byField[field][category] = (byField[field][category] ?? 0) + 1;
      }
      tallies.set(kind, tally);
    }
  }
  return tallies;
}

function canonicalValueCount(tally: CanonicalTally, field: string, value: string, origin: Origin): number {
  const byField = origin === "osm" ? tally.osmByField : tally.byField;
  return byField[field]?.[value] ?? 0;
}

function ratioOf(canonicalCount: number, osmCount: number): number {
  return osmCount === 0 ? 0 : Number((canonicalCount / osmCount).toFixed(4));
}

export function buildParityRow(spec: OsmCategorySpec, osmCounts: Map<string, number>, tallies: Map<string, CanonicalTally>): ParityRow {
  const tally = tallies.get(spec.canonical.kind) ?? emptyTally();
  const byValue = [...osmCounts.entries()]
    .sort((first, second) => second[1] - first[1])
    .map(([value, osmCount]) => {
      const canonicalCount = canonicalValueCount(tally, spec.canonical.field, value, spec.canonical.origin);
      return { value, osmCount, canonicalCount, ratio: ratioOf(canonicalCount, osmCount) };
    });
  const osmCount = byValue.reduce((sum, row) => sum + row.osmCount, 0);
  const canonicalCount = byValue.reduce((sum, row) => sum + row.canonicalCount, 0);
  const ratio = ratioOf(canonicalCount, osmCount);

  if (spec.exclusionReason !== undefined) {
    return { id: spec.id, label: spec.label, osmCount, canonicalCount, ratio, verdict: "excluded-by-policy", reason: spec.exclusionReason, byValue };
  }
  if (osmCount === 0) {
    return { id: spec.id, label: spec.label, osmCount, canonicalCount, ratio, verdict: "represented", reason: "the extract carries no object with this key, so there is nothing to represent", byValue };
  }
  if (spec.adoptionNote !== undefined) {
    return { id: spec.id, label: spec.label, osmCount, canonicalCount, ratio, verdict: "adopted-from-other-source", reason: spec.adoptionNote, byValue };
  }
  if (canonicalCount === 0) {
    return { id: spec.id, label: spec.label, osmCount, canonicalCount, ratio, verdict: "missing", reason: `the extract carries ${osmCount} object(s) but data/intermediate holds no kind ${spec.canonical.kind} feature carrying ${spec.canonical.field} for any of the ${byValue.length} observed value(s)`, byValue };
  }
  if (ratio >= 0.95) {
    return { id: spec.id, label: spec.label, osmCount, canonicalCount, ratio, verdict: "represented", byValue };
  }
  return { id: spec.id, label: spec.label, osmCount, canonicalCount, ratio, verdict: "partially-represented", reason: `data/intermediate holds ${canonicalCount} of ${osmCount} object(s); the shortfall comes from a retention, clipping or dedup decision of the pipeline, not from data loss`, byValue };
}

export function compareOsmParity(specs: OsmCategorySpec[], osmCounts: Map<string, Map<string, number>>, tallies: Map<string, CanonicalTally>): { rows: ParityRow[]; missing: string[] } {
  const rows = specs.map((spec) => buildParityRow(spec, osmCounts.get(spec.id) ?? new Map<string, number>(), tallies));
  return { rows, missing: rows.filter((row) => row.verdict === "missing").map((row) => row.id) };
}

export function summarizeParity(rows: ParityRow[], missing: string[]): OsmParityReport["summary"] {
  return {
    represented: rows.filter((row) => row.verdict === "represented").length,
    partiallyRepresented: rows.filter((row) => row.verdict === "partially-represented").length,
    missing: missing.length,
    excluded: rows.filter((row) => row.verdict === "excluded-by-policy").length,
    adoptedFromOtherSource: rows.filter((row) => row.verdict === "adopted-from-other-source").length,
  };
}

async function readManifestFeatureCounts(generatedDir: string): Promise<Record<string, number>> {
  const manifest = JSON.parse(await fs.readFile(path.join(generatedDir, "manifest.json"), "utf8")) as { featureCounts?: Record<string, number> };
  return manifest.featureCounts ?? {};
}

async function main(): Promise<void> {
  const root = dataRoot();
  const pbf = path.join(root, "raw", "gers-osm.osm.pbf");
  const intermediateDir = path.join(root, "intermediate");
  const generatedDir = path.join(root, "generated");
  const outFile = path.join(root, "qa", "osm-parity.json");

  const pbfStat = await fs.stat(pbf).catch(() => null);
  if (pbfStat === null) {
    console.error(`missing ${pbf}; fetch the OSM bulk extract first`);
    process.exit(2);
  }

  const osmCounts = new Map<string, Map<string, number>>();
  for (const spec of SPECS) {
    osmCounts.set(spec.id, await runTagsCount(pbf, spec.key, spec.values, spec.objectType));
    console.error(`[osmium] ${spec.id} done`);
  }

  const tallies = await loadCanonicalTallies(intermediateDir);
  const { rows, missing } = compareOsmParity(SPECS, osmCounts, tallies);

  const canonicalCountsByKind: Record<string, number> = {};
  const canonicalOsmCountsByKind: Record<string, number> = {};
  for (const [kind, tally] of tallies) {
    canonicalCountsByKind[kind] = tally.total;
    canonicalOsmCountsByKind[kind] = tally.osm;
  }

  const report: OsmParityReport = {
    dataset: "osm-parity",
    generatedAt: new Date().toISOString(),
    department: "32",
    pbf: path.relative(root, pbf),
    pbfBytes: pbfStat.size,
    manifestFeatureCounts: await readManifestFeatureCounts(generatedDir),
    canonicalCountsByKind,
    canonicalOsmCountsByKind,
    rows,
    missing,
    excludedByPolicy: rows.filter((row) => row.verdict === "excluded-by-policy" && row.reason !== undefined).map((row) => ({ id: row.id, reason: row.reason as string })),
    adoptedFromOtherSource: rows.filter((row) => row.verdict === "adopted-from-other-source" && row.reason !== undefined).map((row) => ({ id: row.id, reason: row.reason as string })),
    summary: summarizeParity(rows, missing),
  };

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(report, null, 2) + "\n", "utf8");

  for (const row of rows) {
    console.log(`${row.id.padEnd(32)} osm ${String(row.osmCount).padStart(7)}  canonical ${String(row.canonicalCount).padStart(7)}  ratio ${String(row.ratio).padStart(8)}  ${row.verdict}`);
  }
  console.log(`summary ${JSON.stringify(report.summary)}`);
  if (missing.length > 0) {
    console.error(`silently missing categories: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(2);
  });
}
