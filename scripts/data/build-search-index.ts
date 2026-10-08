#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CATEGORY_BY_ID, categoryDefinition } from "../../src/lib/data/categories";
import { MapFeatureSchema, SearchRecordSchema, TileManifestSchema, type Geometry, type MapFeature, type SearchRecord, type TileManifest } from "../../src/lib/data/schema";
import { displayCase } from "../../src/lib/data/displayText";
import { foldSearchText, normalizeSearchText } from "../../src/lib/data/search";
import { renderToWgs84, transformGeometryToRender, wgs84ToRender } from "../../src/lib/geo/crs";
import { canonicalCategory, geometryAnchor } from "../../src/lib/render/buildRenderTile";

/**
 * Builds the search index: one record per thing a person looks for.
 *
 * - Communes, hamlets and named places, ranked by population and importance.
 * - Streets merged per commune (a street is one result, not one per segment),
 *   with the extent to frame when chosen.
 * - Road numbers (N124, D930) merged across the department.
 * - Every BAN address as "12 bis Rue Gambetta" in "32000 Auch".
 * - Businesses, POIs, stations, named buildings, areas and rivers, each with
 *   its commune, street and category so "pharmacie auch" or "boulangerie rue
 *   dessoles" find it.
 */

interface IndexOptions {
  inDir: string;
  outDir: string;
}

type Point = [number, number];
type Box = [number, number, number, number];

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

function parseArgs(args: string[]): IndexOptions {
  const root = dataRoot();
  let inDir = path.join(root, "generated", "tiles");
  let outDir = path.join(root, "search");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--in-dir" && args[index + 1]) inDir = args[++index]!;
    else if (argument === "--out-dir" && args[index + 1]) outDir = args[++index]!;
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: tsx scripts/data/build-search-index.ts [--in-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { inDir, outDir };
}

/* ------------------------------------------------------------------ */
/*  Loading                                                            */
/* ------------------------------------------------------------------ */

async function loadDataFromTiles(tilesDir: string): Promise<{ features: MapFeature[]; manifests: TileManifest[] }> {
  const features = new Map<string, MapFeature>();
  for (const entry of await fs.readdir(tilesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(tilesDir, entry.name), "utf8"));
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      const feature = MapFeatureSchema.parse(value);
      if (!features.has(feature.stableId)) features.set(feature.stableId, feature);
    }
  }
  return { features: [...features.values()], manifests: await loadManifests(tilesDir) };
}

const TILE_INDEX_CANDIDATES = ["tile-index.json", "tile-manifest.json"];

async function loadManifests(tilesDir: string): Promise<TileManifest[]> {
  const generatedDir = path.join(tilesDir, "..");
  for (const name of TILE_INDEX_CANDIDATES) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(generatedDir, name), "utf8")) as unknown;
      if (!Array.isArray(raw)) throw new Error(`${name} must be an array`);
      return raw.map((value) => TileManifestSchema.parse(value)).sort((first, second) => first.lod - second.lod || first.tileId.localeCompare(second.tileId));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return [];
}

const IGNORED_INTERMEDIATE = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);

async function loadData(tilesDir: string): Promise<{ features: MapFeature[]; manifests: TileManifest[] }> {
  const intermediateDir = path.join(tilesDir, "..", "..", "intermediate");
  try {
    await fs.access(intermediateDir);
  } catch {
    return loadDataFromTiles(tilesDir);
  }
  const featuresById = new Map<string, MapFeature>();
  const entries = (await fs.readdir(intermediateDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !IGNORED_INTERMEDIATE.has(entry.name))
    .sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    const parsed = JSON.parse(await fs.readFile(path.join(intermediateDir, entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      const feature = MapFeatureSchema.parse(value);
      if (!featuresById.has(feature.stableId)) featuresById.set(feature.stableId, feature);
    }
  }
  return { features: [...featuresById.values()], manifests: await loadManifests(tilesDir) };
}

/* ------------------------------------------------------------------ */
/*  Geometry                                                           */
/* ------------------------------------------------------------------ */

function localGeometry(feature: MapFeature): Geometry | null {
  if (feature.localGeometry !== undefined) return feature.localGeometry;
  try {
    return transformGeometryToRender(feature.geometry);
  } catch {
    if (feature.x !== undefined && feature.z !== undefined) return { type: "Point", coordinates: [feature.x, feature.z] };
    return null;
  }
}

function eachPoint(geometry: Geometry, visit: (point: Point) => void): void {
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates as Point);
      return;
    case "LineString":
      for (const point of geometry.coordinates) visit(point as Point);
      return;
    case "MultiLineString":
    case "Polygon":
      for (const line of geometry.coordinates) for (const point of line) visit(point as Point);
      return;
    case "MultiPolygon":
      for (const polygon of geometry.coordinates) for (const ring of polygon) for (const point of ring) visit(point as Point);
  }
}

function boundsOf(geometry: Geometry): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  eachPoint(geometry, ([x, z]) => {
    if (x < box[0]) box[0] = x;
    if (z < box[1]) box[1] = z;
    if (x > box[2]) box[2] = x;
    if (z > box[3]) box[3] = z;
  });
  return box;
}

function lineLength(geometry: Geometry): number {
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
  let total = 0;
  for (const line of lines) for (let index = 1; index < line.length; index += 1) total += Math.hypot(line[index]![0] - line[index - 1]![0], line[index]![1] - line[index - 1]![1]);
  return total;
}

function anchorOf(feature: MapFeature, geometry: Geometry): Point {
  if (feature.x !== undefined && feature.z !== undefined) return [feature.x, feature.z];
  if (feature.lon !== undefined && feature.lat !== undefined && feature.localGeometry === undefined) {
    try {
      return wgs84ToRender([feature.lon, feature.lat]);
    } catch {
      /* fall through to the geometry */
    }
  }
  return geometryAnchor(geometry);
}

function unionBox(first: Box | undefined, second: Box): Box {
  if (first === undefined) return [...second] as Box;
  return [Math.min(first[0], second[0]), Math.min(first[1], second[1]), Math.max(first[2], second[2]), Math.max(first[3], second[3])];
}

function boxGap(first: Box, second: Box): number {
  const dx = Math.max(0, first[0] - second[2], second[0] - first[2]);
  const dz = Math.max(0, first[1] - second[3], second[1] - first[3]);
  return Math.hypot(dx, dz);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundBox(box: Box): Box {
  return [round(box[0]), round(box[1]), round(box[2]), round(box[3])];
}

/* ------------------------------------------------------------------ */
/*  Communes                                                           */
/* ------------------------------------------------------------------ */

interface Commune {
  name: string;
  code?: string;
  postcode?: string;
  population?: number;
  anchor: Point;
  box: Box;
  rings: Point[][];
}

const LOCATOR_CELL = 2000;

function pointInRings(point: Point, rings: readonly Point[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const current = ring[index]!;
      const prior = ring[previous]!;
      if ((current[1] > point[1]) !== (prior[1] > point[1]) && point[0] < ((prior[0] - current[0]) * (point[1] - current[1])) / (prior[1] - current[1]) + current[0]) inside = !inside;
    }
  }
  return inside;
}

/** Which commune a point lies in, by polygon, else the nearest chef-lieu. */
class CommuneLocator {
  private readonly cells = new Map<string, Commune[]>();

  constructor(readonly communes: readonly Commune[]) {
    for (const commune of communes) {
      if (commune.rings.length === 0) continue;
      for (let cx = Math.floor(commune.box[0] / LOCATOR_CELL); cx <= Math.floor(commune.box[2] / LOCATOR_CELL); cx += 1) {
        for (let cz = Math.floor(commune.box[1] / LOCATOR_CELL); cz <= Math.floor(commune.box[3] / LOCATOR_CELL); cz += 1) {
          const key = `${cx}:${cz}`;
          const bucket = this.cells.get(key);
          if (bucket === undefined) this.cells.set(key, [commune]);
          else bucket.push(commune);
        }
      }
    }
  }

  locate(point: Point): Commune | undefined {
    const bucket = this.cells.get(`${Math.floor(point[0] / LOCATOR_CELL)}:${Math.floor(point[1] / LOCATOR_CELL)}`) ?? [];
    for (const commune of bucket) {
      if (point[0] < commune.box[0] || point[0] > commune.box[2] || point[1] < commune.box[1] || point[1] > commune.box[3]) continue;
      if (pointInRings(point, commune.rings)) return commune;
    }
    let best: Commune | undefined;
    let bestDistance = 4000;
    for (const commune of this.communes) {
      const distance = Math.hypot(commune.anchor[0] - point[0], commune.anchor[1] - point[1]);
      if (distance < bestDistance) {
        best = commune;
        bestDistance = distance;
      }
    }
    return best;
  }
}

function communeRings(geometry: Geometry): Point[][] {
  if (geometry.type === "Polygon") return geometry.coordinates as Point[][];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat() as Point[][];
  return [];
}

function metadataText(feature: MapFeature, key: string): string | undefined {
  const value = feature.sourceMetadata?.[key];
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Display text                                                       */
/* ------------------------------------------------------------------ */

const SIRENE_STREET_TYPES: Readonly<Record<string, string>> = {
  AV: "AVENUE", AVE: "AVENUE", BD: "BOULEVARD", BLD: "BOULEVARD", PL: "PLACE", CHE: "CHEMIN", CHEM: "CHEMIN", CH: "CHEMIN",
  RTE: "ROUTE", IMP: "IMPASSE", ALL: "ALLEE", RES: "RESIDENCE", CRS: "COURS", FBG: "FAUBOURG", SQ: "SQUARE", QU: "QUAI",
  PROM: "PROMENADE", HAM: "HAMEAU", LOT: "LOTISSEMENT", CTRE: "CENTRE", RPT: "ROND-POINT", PASS: "PASSAGE", SENT: "SENTIER",
  CHS: "CHAUSSEE", MTE: "MONTEE", VLA: "VILLA", DOM: "DOMAINE", ZA: "ZONE ARTISANALE", ZI: "ZONE INDUSTRIELLE",
  ZAC: "ZONE D'AMENAGEMENT CONCERTE", ESP: "ESPLANADE", R: "RUE", VC: "VOIE COMMUNALE", CR: "CHEMIN RURAL",
};

interface ParsedPostal {
  number?: string;
  street?: string;
  postcode?: string;
  city?: string;
}

/** Split a SIRENE or OSM address string into number, street, postcode and city. */
export function parsePostalAddress(address: string): ParsedPostal {
  const text = address.replace(/\s+/g, " ").trim();
  const withComma = /^(.*?),\s*(\d{5})\s+(.+)$/.exec(text);
  const plain = withComma ?? /^(.*?)\s*(\d{5})\s+([^\d]+)$/.exec(text);
  const line = plain ? plain[1]!.trim() : text;
  const postcode = plain?.[2];
  const city = plain?.[3]?.trim();
  const numbered = /^(\d{1,4})\s*(BIS|TER|QUATER|[A-D])?\b\s*(.*)$/i.exec(line);
  let number: string | undefined;
  let street = line;
  if (numbered !== null && numbered[3] !== undefined && numbered[3] !== "") {
    number = numbered[2] === undefined ? numbered[1] : `${numbered[1]} ${numbered[2].toLowerCase()}`;
    street = numbered[3];
  }
  street = street.trim();
  if (/^LD\s/i.test(street)) street = street.replace(/^LD\s+/i, "");
  const first = street.split(" ")[0]?.toUpperCase();
  if (first !== undefined && SIRENE_STREET_TYPES[first] !== undefined && street === street.toUpperCase()) street = `${SIRENE_STREET_TYPES[first]}${street.slice(first.length)}`;
  return {
    ...(number === undefined ? {} : { number }),
    ...(street === "" ? {} : { street }),
    ...(postcode === undefined ? {} : { postcode }),
    ...(city === undefined ? {} : { city }),
  };
}

/* ------------------------------------------------------------------ */
/*  Drafts                                                             */
/* ------------------------------------------------------------------ */

interface Draft {
  featureId: string;
  name: string;
  kind: MapFeature["kind"];
  category?: string;
  aliases: Set<string>;
  context?: string;
  commune?: string;
  postcode?: string;
  street?: string;
  housenumber?: string;
  ref?: string;
  brand?: string;
  anchor: Point;
  box?: Box;
  boost: number;
  /** Which duplicate wins when two records describe the same place. */
  richness: number;
}

const ROAD_CLASS_BOOST: Readonly<Record<string, number>> = {
  motorway: 60, trunk: 55, primary: 45, secondary: 35, tertiary: 25, residential: 15, unclassified: 10, pedestrian: 15, living_street: 12,
};

const ROAD_CLASS_RANK: Readonly<Record<string, number>> = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, unclassified: 6, pedestrian: 6, living_street: 6, service: 7, track: 8, cycleway: 9, path: 9, steps: 9,
};

const PLACE_LABEL: Readonly<Record<string, string>> = {
  hamlet: "Hamlet", settlement: "Hamlet", locality: "Locality", village: "Village", town: "Town", city: "Town", suburb: "District",
  quarter: "District", neighbourhood: "Neighbourhood", isolated_dwelling: "Farmstead", farm: "Farmstead", wood: "Wood", forest: "Forest",
  peak: "Hill", valley: "Valley", col: "Pass", named_area: "Area", water_body: "Lake", watercourse: "River", island: "Island",
};

const PLACE_BOOST: Readonly<Record<string, number>> = {
  town: 120, city: 130, village: 100, suburb: 80, quarter: 70, neighbourhood: 60, hamlet: 70, settlement: 70, isolated_dwelling: 50, farm: 50,
  locality: 50, named_area: 55, water_body: 55, watercourse: 55, forest: 50, wood: 45, peak: 50, col: 45,
};

const TRANSPORT_BOOST: Readonly<Record<string, number>> = {
  station: 110, halt: 90, aerodrome: 110, airport: 110, bus_station: 80, bus_stop: 25, platform: 25, runway: 20, parking: 30,
};

const LANDMARK_GROUPS = new Set(["landmark", "culture", "religion"]);

function placeBoost(feature: Extract<MapFeature, { kind: "place" }>): number {
  if (feature.placeType === "commune") {
    const population = feature.population ?? 0;
    return Math.min(320, Math.round(150 + 35 * Math.log10(population + 10)));
  }
  const base = PLACE_BOOST[feature.placeType] ?? 40;
  return Math.max(0, base - Math.max(0, (feature.importance ?? 6) - 3) * 4);
}

function poiBoost(category: string): number {
  const definition = categoryDefinition(category);
  if (definition.id === "train_station" || definition.id === "airport" || definition.id === "hospital") return 115;
  if (LANDMARK_GROUPS.has(definition.group)) return 100;
  if (definition.group === "emergency" || definition.group === "public" || definition.group === "education") return 85;
  if (definition.id === "other") return 45;
  return 70;
}

/** Keep everything a record needs; drop empty and duplicate aliases. */
function aliasesOf(draft: Draft): string[] {
  const own = foldSearchText(draft.name);
  const seen = new Set<string>([own]);
  const out: string[] = [];
  for (const alias of draft.aliases) {
    const key = foldSearchText(alias);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
  }
  return out.slice(0, 8);
}

interface StreetGroup {
  names: Map<string, number>;
  kindClass: string | undefined;
  refs: Set<string>;
  commune?: Commune;
  box?: Box;
  length: number;
  members: Array<{ id: string; anchor: Point; length: number }>;
}

interface RouteGroup {
  ref: string;
  names: Map<string, number>;
  kindClass: string | undefined;
  communes: Set<string>;
  box?: Box;
  length: number;
  members: Array<{ id: string; anchor: Point; length: number }>;
}

const ROUTE_REF = /^(A|N|D|E)\s?(\d{1,4}[A-Z]?)$/i;
/** Shorter route groups are border slivers of roads that run in a neighbouring department. */
const MIN_ROUTE_METRES = 300;

/**
 * Numbers a road carried before it was transferred and renumbered. People and
 * older signs still use them, so they stay searchable: the national road from
 * Auch to Toulouse is now the departmental D1124 in BD TOPO and OpenStreetMap.
 */
export const FORMER_ROUTE_NUMBERS: Readonly<Record<string, readonly string[]>> = {
  D1124: ["N124"],
};

/** BD TOPO kilometre markers: survey references, not places anyone looks for. */
const SKIPPED_SOURCES = ["ign-bdtopo:point_de_repere/"];

/** How well a spelling is written: accents and mixed case beat all-caps or stripped text. */
function nameQuality(name: string): number {
  let score = 0;
  if (/[à-ÿÀ-Þ]/.test(name)) score += 2;
  if (/[a-z]/.test(name) && /[A-Z]/.test(name)) score += 1;
  if (/[-'’]/.test(name)) score += 1;
  if (!/[a-z]/.test(name)) score -= 2;
  return score;
}

function betterClass(current: string | undefined, candidate: string | undefined): string | undefined {
  if (candidate === undefined) return current;
  if (current === undefined) return candidate;
  return (ROAD_CLASS_RANK[candidate] ?? 10) < (ROAD_CLASS_RANK[current] ?? 10) ? candidate : current;
}

function mostCommon(names: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [name, count] of names) {
    /* Prefer properly cased spellings over all-caps ones. */
    const score = count + (/[a-z]/.test(name) ? 0.5 : 0);
    if (score > bestCount || (score === bestCount && name < best)) {
      best = name;
      bestCount = score;
    }
  }
  return best;
}

/** The member nearest the group's middle, so the label lands on the street itself. */
function representative(members: Array<{ id: string; anchor: Point; length: number }>, box: Box): { id: string; anchor: Point } {
  const centre: Point = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  let best = members[0]!;
  let bestDistance = Infinity;
  for (const member of members) {
    const distance = Math.hypot(member.anchor[0] - centre[0], member.anchor[1] - centre[1]) - Math.min(member.length, 200) * 0.05;
    if (distance < bestDistance) {
      best = member;
      bestDistance = distance;
    }
  }
  return best;
}

function formatKm(metres: number): string {
  const km = metres / 1000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

/* ------------------------------------------------------------------ */
/*  Build                                                              */
/* ------------------------------------------------------------------ */

export function buildSearchIndex(features: MapFeature[], tiles: Map<string, string> | readonly TileManifest[], _outputPath: string): SearchRecord[] {
  const unique = new Map<string, MapFeature>();
  for (const feature of features) if (!unique.has(feature.stableId)) unique.set(feature.stableId, feature);

  /* Communes first: everything else is placed in one. */
  const communes: Commune[] = [];
  const geometryCache = new Map<string, Geometry>();
  const geometryFor = (feature: MapFeature): Geometry | null => {
    const cached = geometryCache.get(feature.stableId);
    if (cached !== undefined) return cached;
    const geometry = localGeometry(feature);
    if (geometry !== null && feature.kind !== "building" && feature.kind !== "address") geometryCache.set(feature.stableId, geometry);
    return geometry;
  };
  for (const feature of unique.values()) {
    if (feature.kind !== "place" || feature.placeType !== "commune" || feature.name === undefined) continue;
    const geometry = geometryFor(feature);
    if (geometry === null) continue;
    communes.push({
      name: feature.name,
      ...(metadataText(feature, "communeCode") === undefined ? {} : { code: metadataText(feature, "communeCode") }),
      ...(metadataText(feature, "postcode") === undefined ? {} : { postcode: metadataText(feature, "postcode") }),
      ...(feature.population === undefined ? {} : { population: feature.population }),
      anchor: anchorOf(feature, geometry),
      box: boundsOf(geometry),
      rings: communeRings(geometry),
    });
  }
  const locator = new CommuneLocator(communes);
  const communeKeys = new Set(communes.map((commune) => foldSearchText(commune.name)));

  /* Postcodes and street spellings from the address base. */
  const postcodeVotes = new Map<Commune, Map<string, number>>();
  const banStreets = new Map<string, string>();
  for (const feature of unique.values()) {
    if (feature.kind !== "address") continue;
    if (feature.postcode !== undefined) {
      banStreets.set(`${feature.postcode}|${foldSearchText(feature.street)}`, feature.street);
      const geometry = geometryFor(feature);
      if (geometry === null) continue;
      const commune = locator.locate(anchorOf(feature, geometry));
      if (commune === undefined) continue;
      const votes = postcodeVotes.get(commune) ?? new Map<string, number>();
      votes.set(feature.postcode, (votes.get(feature.postcode) ?? 0) + 1);
      postcodeVotes.set(commune, votes);
    }
  }
  for (const [commune, votes] of postcodeVotes) {
    if (commune.postcode !== undefined) continue;
    let best = "";
    let bestCount = 0;
    for (const [postcode, count] of votes) if (count > bestCount) [best, bestCount] = [postcode, count];
    if (best !== "") commune.postcode = best;
  }

  const drafts: Draft[] = [];
  const streets = new Map<string, StreetGroup>();
  const routes = new Map<string, RouteGroup>();
  const waters = new Map<string, Array<{ names: Map<string, number>; box: Box; length: number; members: Array<{ id: string; anchor: Point; length: number }>; communes: Set<string>; waterType?: string }>>();

  for (const feature of unique.values()) {
    if (SKIPPED_SOURCES.some((prefix) => feature.stableId.startsWith(prefix))) continue;
    const geometry = geometryFor(feature);
    if (geometry === null) continue;
    const anchor = anchorOf(feature, geometry);
    if (!Number.isFinite(anchor[0]) || !Number.isFinite(anchor[1])) continue;
    const commune = feature.kind === "place" && feature.placeType === "commune" ? undefined : locator.locate(anchor);
    const name = feature.kind === "business" ? feature.businessName : feature.name;

    switch (feature.kind) {
      case "boundary": {
        drafts.push({
          featureId: feature.stableId, name: "Gers", kind: "boundary", aliases: new Set(["Département du Gers", "Gers department", feature.territoryCode]),
          context: "Department · Occitanie", anchor, box: boundsOf(geometry), boost: 330, richness: 9,
        });
        break;
      }
      case "place": {
        if (name === undefined) break;
        if (feature.placeType === "commune") {
          const self = communes.find((candidate) => candidate.name === name && candidate.anchor[0] === anchor[0] && candidate.anchor[1] === anchor[1]);
          const population = feature.population;
          const parts = ["Commune", self?.postcode, population === undefined ? undefined : `${population.toLocaleString("en-GB")} inhabitants`].filter((part): part is string => part !== undefined);
          drafts.push({
            featureId: feature.stableId, name: displayCase(name), kind: "place", category: "commune", aliases: new Set(feature.names),
            context: parts.join(" · "), commune: name, ...(self?.postcode === undefined ? {} : { postcode: self.postcode }),
            anchor, box: boundsOf(geometry), boost: placeBoost(feature), richness: 9,
          });
          break;
        }
        /* The chef-lieu settlement repeats its commune's name; the commune already answers. */
        if (communeKeys.has(foldSearchText(name)) && commune !== undefined && foldSearchText(commune.name) === foldSearchText(name)) break;
        const label = PLACE_LABEL[feature.placeType] ?? "Place";
        drafts.push({
          featureId: feature.stableId, name: displayCase(name), kind: "place", category: feature.placeType, aliases: new Set([...feature.names, ...(metadataText(feature, "altName") ?? "").split(";").filter(Boolean)]),
          context: commune === undefined ? label : `${label} · ${commune.name}`, ...(commune === undefined ? {} : { commune: commune.name }),
          anchor, ...(geometry.type === "Point" ? {} : { box: boundsOf(geometry) }), boost: placeBoost(feature), richness: 3,
        });
        break;
      }
      case "road": {
        const length = lineLength(geometry);
        const box = boundsOf(geometry);
        const refs = (feature.ref ?? "").split(/[;,/]/).map((ref) => ref.trim().toUpperCase().replace(/\s+/g, "")).filter((ref) => ref !== "");
        for (const ref of refs) {
          const match = ROUTE_REF.exec(ref);
          if (match === null) continue;
          const key = `${match[1]!.toUpperCase()}${match[2]!.toUpperCase()}`;
          const group = routes.get(key) ?? { ref: key, names: new Map(), kindClass: undefined, communes: new Set(), length: 0, members: [] };
          group.kindClass = betterClass(group.kindClass, feature.roadClass ?? feature.highway);
          if (commune !== undefined) group.communes.add(commune.name);
          group.box = unionBox(group.box, box);
          group.length += length;
          group.members.push({ id: feature.stableId, anchor, length });
          if (name !== undefined) group.names.set(name, (group.names.get(name) ?? 0) + 1);
          routes.set(key, group);
        }
        if (name === undefined) break;
        const key = `${foldSearchText(name)}|${commune?.code ?? commune?.name ?? "?"}`;
        const group = streets.get(key) ?? { names: new Map(), kindClass: undefined, refs: new Set(), ...(commune === undefined ? {} : { commune }), length: 0, members: [] };
        group.names.set(name, (group.names.get(name) ?? 0) + 1);
        group.kindClass = betterClass(group.kindClass, feature.roadClass ?? feature.highway);
        for (const ref of refs) {
          group.refs.add(ref);
          for (const former of FORMER_ROUTE_NUMBERS[ref] ?? []) group.refs.add(former);
        }
        group.box = unionBox(group.box, box);
        group.length += length;
        group.members.push({ id: feature.stableId, anchor, length });
        streets.set(key, group);
        break;
      }
      case "water": {
        if (name === undefined) break;
        const key = foldSearchText(name);
        const box = boundsOf(geometry);
        const length = geometry.type === "Polygon" || geometry.type === "MultiPolygon" ? 0 : lineLength(geometry);
        const clusters = waters.get(key) ?? [];
        let cluster = clusters.find((candidate) => boxGap(candidate.box, box) < 2500);
        if (cluster === undefined) {
          cluster = { names: new Map(), box, length: 0, members: [], communes: new Set(), ...(feature.waterType === undefined ? {} : { waterType: feature.waterType }) };
          clusters.push(cluster);
          waters.set(key, clusters);
        }
        cluster.names.set(name, (cluster.names.get(name) ?? 0) + 1);
        cluster.box = unionBox(cluster.box, box);
        cluster.length += length;
        cluster.members.push({ id: feature.stableId, anchor, length: Math.max(length, 1) });
        if (commune !== undefined) cluster.communes.add(commune.name);
        break;
      }
      case "address": {
        if (feature.housenumber === undefined || feature.housenumber === "") break;
        const city = feature.city ?? commune?.name;
        drafts.push({
          featureId: feature.stableId, name: `${feature.housenumber} ${feature.street}`, kind: "address", aliases: new Set(),
          context: [feature.postcode, city].filter(Boolean).join(" "), ...(city === undefined ? {} : { commune: city }),
          ...(feature.postcode === undefined ? {} : { postcode: feature.postcode }), street: feature.street, housenumber: feature.housenumber,
          anchor, boost: 20, richness: 1,
        });
        break;
      }
      case "business": {
        const category = canonicalCategory(feature);
        const postal = feature.address === undefined ? {} : parsePostalAddress(feature.address);
        let street = postal.street;
        if (street !== undefined) {
          const postcode = postal.postcode ?? commune?.postcode;
          street = (postcode === undefined ? undefined : banStreets.get(`${postcode}|${foldSearchText(street)}`)) ?? displayCase(street);
        }
        const communeName = commune?.name ?? (postal.city === undefined ? undefined : displayCase(postal.city));
        const line = street === undefined ? undefined : [postal.number, street].filter(Boolean).join(" ");
        const conflated = feature.sourceMetadata?.conflatedWith !== undefined || feature.sourceRefs.some((reference) => reference.source.startsWith("osm"));
        drafts.push({
          featureId: feature.stableId, name: displayCase(feature.businessName), kind: "business", category,
          aliases: new Set([feature.legalName, feature.name].filter((value): value is string => value !== undefined && value !== "").map(displayCase)),
          context: [line, communeName].filter(Boolean).join(", "), ...(communeName === undefined ? {} : { commune: communeName }),
          ...(postal.postcode ?? commune?.postcode ? { postcode: postal.postcode ?? commune?.postcode } : {}),
          ...(street === undefined ? {} : { street }), ...(feature.brand === undefined ? {} : { brand: feature.brand }),
          anchor, boost: 60 + (feature.phone ? 6 : 0) + (feature.website ? 6 : 0) + (feature.openingHours ? 8 : 0) + (feature.brand ? 10 : 0) + (conflated ? 8 : 0), richness: 8,
        });
        break;
      }
      case "poi": {
        if (name === undefined) break;
        const category = canonicalCategory(feature);
        const postal = feature.address === undefined ? {} : parsePostalAddress(feature.address);
        const street = postal.street === undefined ? undefined : displayCase(postal.street);
        const line = street === undefined ? undefined : [postal.number, street].filter(Boolean).join(" ");
        const extra = ["altName", "occitanName", "brand"].map((key) => metadataText(feature, key)).filter((value): value is string => value !== undefined);
        drafts.push({
          featureId: feature.stableId, name: displayCase(name), kind: "poi", category, aliases: new Set([...feature.names, ...extra]),
          context: [line, commune?.name].filter(Boolean).join(", "), ...(commune === undefined ? {} : { commune: commune.name }),
          ...(street === undefined ? {} : { street }), anchor, ...(geometry.type === "Point" ? {} : { box: boundsOf(geometry) }),
          boost: poiBoost(category) + (feature.website || feature.phone ? 5 : 0), richness: 7,
        });
        break;
      }
      case "transport": {
        if (name === undefined) break;
        const category = feature.publicTransport ?? feature.transportType;
        drafts.push({
          featureId: feature.stableId, name: displayCase(name), kind: "transport", category: feature.transportType === "station" || category === "station" ? "station" : category,
          aliases: new Set([name, ...feature.names]), context: commune?.name ?? "", ...(commune === undefined ? {} : { commune: commune.name }),
          ...(feature.ref === undefined ? {} : { ref: feature.ref }), anchor, boost: TRANSPORT_BOOST[feature.transportType] ?? TRANSPORT_BOOST[category] ?? 15, richness: 6,
        });
        break;
      }
      case "landuse":
      case "building":
      case "structure": {
        if (name === undefined) break;
        const category = feature.kind === "landuse" ? canonicalCategory(feature) : feature.kind === "building" ? feature.buildingType : feature.structureType;
        const usable = category === "other" && feature.kind === "landuse" ? feature.landuseType : category;
        drafts.push({
          featureId: feature.stableId, name: displayCase(name), kind: feature.kind, ...(usable === undefined ? {} : { category: usable }), aliases: new Set(feature.names),
          context: commune?.name ?? "", ...(commune === undefined ? {} : { commune: commune.name }), anchor,
          ...(geometry.type === "Point" ? {} : { box: boundsOf(geometry) }), boost: feature.kind === "landuse" ? 45 : feature.kind === "building" ? 40 : 35,
          richness: feature.kind === "landuse" ? 3 : feature.kind === "building" ? 4 : 2,
        });
        break;
      }
    }
  }

  for (const group of streets.values()) {
    const box = group.box!;
    const rep = representative(group.members, box);
    const name = displayCase(mostCommon(group.names));
    drafts.push({
      featureId: rep.id, name, kind: "road", ...(group.kindClass === undefined ? {} : { category: group.kindClass }), aliases: new Set(),
      context: group.commune?.name ?? "", ...(group.commune === undefined ? {} : { commune: group.commune.name, ...(group.commune.postcode === undefined ? {} : { postcode: group.commune.postcode }) }),
      ...(group.refs.size === 0 ? {} : { ref: [...group.refs].sort().join(";") }),
      anchor: rep.anchor, box, boost: 30 + (ROAD_CLASS_BOOST[group.kindClass ?? ""] ?? 0) + Math.min(20, Math.round(Math.log2(Math.max(1, group.length / 50)) * 3)), richness: 5,
    });
  }

  for (const group of routes.values()) {
    if (group.length < MIN_ROUTE_METRES) continue;
    const box = group.box!;
    const rep = representative(group.members, box);
    const names = [...group.names.entries()].sort((first, second) => second[1] - first[1]).slice(0, 4).map(([value]) => displayCase(value));
    const former = FORMER_ROUTE_NUMBERS[group.ref] ?? [];
    const network = group.ref[0] === "A" ? 220 : group.ref[0] === "N" || former.some((value) => value.startsWith("N")) ? 200 : group.ref[0] === "E" ? 180 : 130;
    drafts.push({
      featureId: rep.id, name: group.ref, kind: "road", ...(group.kindClass === undefined ? {} : { category: group.kindClass }), aliases: new Set([...former, ...names]),
      context: `${former.length > 0 ? `Former ${former.join(", ")} · ` : ""}${formatKm(group.length)} · ${group.communes.size} commune${group.communes.size === 1 ? "" : "s"}`, ref: [group.ref, ...former].join(";"),
      anchor: rep.anchor, box, boost: network + (ROAD_CLASS_BOOST[group.kindClass ?? ""] ?? 0), richness: 5,
    });
  }

  for (const clusters of waters.values()) {
    for (const cluster of clusters) {
      const rep = representative(cluster.members, cluster.box);
      const communesCrossed = [...cluster.communes];
      const context = cluster.length > 3000 ? `${formatKm(cluster.length)}${communesCrossed.length > 1 ? ` · ${communesCrossed.length} communes` : ""}` : communesCrossed.slice(0, 2).join(", ");
      drafts.push({
        featureId: rep.id, name: displayCase(mostCommon(cluster.names)), kind: "water", ...(cluster.waterType === undefined ? {} : { category: cluster.waterType }), aliases: new Set(),
        context, ...(communesCrossed.length === 1 ? { commune: communesCrossed[0]! } : {}), anchor: rep.anchor, box: cluster.box,
        boost: 55 + Math.min(45, Math.round(cluster.length / 2000)), richness: 4,
      });
    }
  }

  const deduplicated = deduplicate(drafts);
  const tileFor = tileResolver(tiles);
  const records: SearchRecord[] = [];
  for (const draft of deduplicated) {
    const tileId = tileFor(draft.featureId, draft.anchor);
    if (tileId === undefined) continue;
    let lon: number;
    let lat: number;
    try {
      [lon, lat] = renderToWgs84(draft.anchor);
    } catch {
      continue;
    }
    const aliases = aliasesOf(draft);
    const category = draft.category;
    records.push(SearchRecordSchema.parse({
      featureId: draft.featureId,
      canonicalName: draft.name,
      normalizedName: normalizeSearchText(draft.name),
      aliases,
      kind: draft.kind,
      ...(category === undefined ? {} : { category }),
      tileId,
      focusLon: Math.round(lon * 1e6) / 1e6,
      focusLat: Math.round(lat * 1e6) / 1e6,
      boost: Math.max(0, Math.round(draft.boost)),
      ...(draft.context === undefined || draft.context === "" ? {} : { context: draft.context }),
      ...(draft.commune === undefined ? {} : { commune: draft.commune }),
      ...(draft.postcode === undefined ? {} : { postcode: draft.postcode }),
      ...(draft.street === undefined ? {} : { street: draft.street }),
      ...(draft.housenumber === undefined ? {} : { housenumber: draft.housenumber }),
      ...(draft.ref === undefined ? {} : { ref: draft.ref }),
      ...(draft.brand === undefined ? {} : { brand: draft.brand }),
      x: round(draft.anchor[0]),
      z: round(draft.anchor[1]),
      ...(draft.box === undefined || !Number.isFinite(draft.box[0]) ? {} : { bbox: roundBox(draft.box) }),
    }));
  }
  return records.sort((first, second) => first.canonicalName.localeCompare(second.canonicalName) || first.featureId.localeCompare(second.featureId));
}

/**
 * The same place often arrives from several sources (a BD TOPO town hall, an
 * OSM amenity and a SIRENE establishment). Records with the same name within
 * a short distance collapse into the richest one, keeping the others' names
 * as aliases.
 */
function deduplicate(drafts: Draft[]): Draft[] {
  const CELL = 1000;
  const grid = new Map<string, Draft[]>();
  const kept: Draft[] = [];
  const ordered = drafts.slice().sort((first, second) => second.richness - first.richness || second.boost - first.boost || first.featureId.localeCompare(second.featureId));
  for (const draft of ordered) {
    if (draft.kind === "address" || draft.kind === "road" || draft.kind === "boundary" || draft.kind === "water") {
      kept.push(draft);
      continue;
    }
    const radius = draft.kind === "place" ? 1500 : 150;
    const key = foldSearchText(draft.name);
    const cx = Math.floor(draft.anchor[0] / CELL);
    const cz = Math.floor(draft.anchor[1] / CELL);
    const reach = Math.ceil(radius / CELL);
    let twin: Draft | undefined;
    for (let dx = -reach; dx <= reach && twin === undefined; dx += 1) {
      for (let dz = -reach; dz <= reach && twin === undefined; dz += 1) {
        for (const other of grid.get(`${cx + dx}:${cz + dz}`) ?? []) {
          if (foldSearchText(other.name) !== key) continue;
          if ((draft.kind === "place") !== (other.kind === "place")) continue;
          if (Math.hypot(other.anchor[0] - draft.anchor[0], other.anchor[1] - draft.anchor[1]) > radius) continue;
          twin = other;
          break;
        }
      }
    }
    if (twin !== undefined) {
      for (const alias of draft.aliases) twin.aliases.add(alias);
      /* Keep the best-written spelling of the shared name ("Cathédrale Sainte-Marie" over "Cathedrale Sainte Marie"). */
      if (nameQuality(draft.name) > nameQuality(twin.name)) twin.name = draft.name;
      if (twin.category === undefined || !CATEGORY_BY_ID.has(twin.category) || twin.category === "other") {
        if (draft.category !== undefined && CATEGORY_BY_ID.has(draft.category) && draft.category !== "other") twin.category = draft.category;
      }
      if ((twin.context === undefined || twin.context === "") && draft.context !== undefined) twin.context = draft.context;
      twin.boost = Math.max(twin.boost, draft.boost);
      continue;
    }
    kept.push(draft);
    const cellKey = `${cx}:${cz}`;
    const bucket = grid.get(cellKey);
    if (bucket === undefined) grid.set(cellKey, [draft]);
    else bucket.push(draft);
  }
  return kept;
}

/** Tile holding a feature: its LOD0 tile containing the anchor when possible. */
function tileResolver(tiles: Map<string, string> | readonly TileManifest[]): (featureId: string, anchor: Point) => string | undefined {
  if (tiles instanceof Map) return (featureId) => tiles.get(featureId);
  const lod0 = tiles.filter((manifest) => manifest.lod === 0);
  const byFeature = new Map<string, TileManifest[]>();
  for (const manifest of lod0) {
    for (const stableId of manifest.features ?? []) {
      const bucket = byFeature.get(stableId);
      if (bucket === undefined) byFeature.set(stableId, [manifest]);
      else bucket.push(manifest);
    }
  }
  const contains = (manifest: TileManifest, anchor: Point): boolean => anchor[0] >= manifest.bounds[0] && anchor[0] <= manifest.bounds[2] && anchor[1] >= manifest.bounds[1] && anchor[1] <= manifest.bounds[3];
  return (featureId, anchor) => {
    const holding = byFeature.get(featureId);
    if (holding !== undefined && holding.length > 0) return (holding.find((manifest) => contains(manifest, anchor)) ?? holding[0]!).tileId;
    return lod0.find((manifest) => contains(manifest, anchor))?.tileId;
  };
}

async function writeJsonArray(filePath: string, values: Iterable<unknown>): Promise<void> {
  const handle = await fs.open(filePath, "w");
  let buffer = "";
  let first = true;
  try {
    await handle.write("[");
    for (const value of values) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) continue;
      buffer += `${first ? "" : ",\n"}${encoded}`;
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

export async function buildIndexAll(inDir?: string, outDir?: string): Promise<void> {
  const root = dataRoot();
  const sourceDir = inDir ?? path.join(root, "generated", "tiles");
  const destinationDir = outDir ?? path.join(root, "search");
  await fs.mkdir(destinationDir, { recursive: true });
  const { features, manifests } = await loadData(sourceDir);
  const records = buildSearchIndex(features, manifests, path.join(destinationDir, "index.json"));
  await writeJsonArray(path.join(destinationDir, "index.json"), records);
  const byKind = new Map<string, number>();
  for (const record of records) byKind.set(record.kind, (byKind.get(record.kind) ?? 0) + 1);
  console.error(`[search-index] Wrote ${records.length} search records to ${destinationDir}/index.json (${[...byKind].map(([kind, count]) => `${kind} ${count}`).join(", ")})`);
}

if (process.argv[1]?.endsWith("build-search-index.ts")) {
  const options = parseArgs(process.argv.slice(2));
  buildIndexAll(options.inDir, options.outDir).catch((error: unknown) => {
    console.error("[search-index] Fatal:", error);
    process.exit(1);
  });
}
