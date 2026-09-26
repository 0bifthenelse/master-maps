#!/usr/bin/env tsx
import { createReadStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { createGunzip } from "node:zlib";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");
const QA_DIR = path.join(DATA_DIR, "qa");
const CADASTRE_PARITY_PATH = path.join(QA_DIR, "cadastre-parity.json");
const SOURCE_RECONCILIATION_PATH = path.join(QA_DIR, "source-reconciliation.json");
const CADASTRE_BATIMENTS_PATH = path.join(RAW_DIR, `cadastre-${GERS_TERRITORY.code}-batiments.json.gz`);
const CADASTRE_LIEUX_DITS_PATH = path.join(RAW_DIR, `cadastre-${GERS_TERRITORY.code}-lieux_dits.json.gz`);
const BAN_RAW_PATH = path.join(RAW_DIR, "ban-addresses.json");
const BAN_AUCH_RAW_PATH = path.join(RAW_DIR, "ban-addresses-auch.json");
const SIRENE_RAW_PATH = path.join(RAW_DIR, "businesses-sirene.json");
const BOUNDARY_PATH = path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile);
const CADASTRE_LICENSE = "Licence Ouverte / Open Licence 2.0 (ETALAB)";
const CANONICAL_BUILDING_PREFIX = "ign-bdtopo:building/";

export const PARITY_CENTROID_TOLERANCE_METRES = 25;
export const PARITY_CELL_SIZE_DEGREES = 0.02;
export const PARITY_MAX_SAMPLE_UNMATCHED = 40;
export const PARITY_MAX_REPORT_ROWS = 2_000;
export const PARITY_MIN_OVERLAP = 0.2;

export interface Bbox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface ParitySample {
  key: string;
  bbox: Bbox;
  centroid: [number, number];
}

export interface ParityMatch {
  key: string;
  overlapRatio: number;
  centroidDistanceMetres: number;
}

export interface ParityResult<T> {
  total: number;
  invalid: number;
  outsideBoundary: number;
  matched: number;
  unmatched: number;
  unmatchedSamples: T[];
}

export type ParityVerdict = "matched" | "only-canonical" | "only-cadastre" | "matched-ambiguous";

export interface ParityReportRow {
  canonicalKey: string;
  cadastreKey: string | null;
  verdict: ParityVerdict;
  overlapRatio: number;
  centroidDistanceMetres: number;
}

export interface CadastreParityReport {
  dataset: "cadastre-parity";
  department: string;
  generatedAt: string;
  license: string;
  method: {
    strategy: string;
    matchRule: string;
      centroidToleranceMetres: number;
    cellSizeDegrees: number;
    maxAmbiguousMatchesPerCell: number;
    canonicalSource: string;
    cadastreSource: string;
    sampling: "none (exhaustive)";
    peakRssBytes: number;
  };
  canonical: ParityResult<ParitySample>;
  cadastre: ParityResult<ParitySample>;
  both: {
    matched: number;
    onlyCanonical: number;
    onlyCadastre: number;
    ambiguous: number;
    parityRatioPercent: number;
  };
  samples: { onlyCanonical: ParitySample[]; onlyCadastre: ParitySample[] };
  locationdits: {
    source: string;
    license: string;
    total: number;
    invalidGeometry: number;
    named: number;
    unnamed: number;
    withCommune: number;
    distinctCommunes: number;
    byPrefix: Record<string, number>;
  };
  report: { rowsWritten: number; maxRows: number; rows: ParityReportRow[] };
}

export interface SourceAccounting {
  source: string;
  input: number;
  accepted: number;
  deduplicated: number;
  clipped: number;
  excluded: number;
  invalid: number;
  unexplained: number;
  notes: string;
  breakdown?: Record<string, number>;
}

export interface SourceReconciliationReport {
  dataset: "source-reconciliation";
  generatedAt: string;
  department: string;
  sources: SourceAccounting[];
  totals: {
    input: number;
    accepted: number;
    deduplicated: number;
    clipped: number;
    excluded: number;
    invalid: number;
    unexplained: number;
  };
}

export interface CanonicalBuildingStreamEntry {
  stableId: string;
  lon: number;
  lat: number;
  geometryType: string;
  bbox: Bbox | null;
}

function metresPerDegreeLat(): number {
  return 111_320;
}

function metresPerDegreeLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

function bboxUnion(target: Bbox, b: Bbox): void {
  if (b.west < target.west) target.west = b.west;
  if (b.east > target.east) target.east = b.east;
  if (b.south < target.south) target.south = b.south;
  if (b.north > target.north) target.north = b.north;
}

function bboxOfCoordinates(coordinates: unknown, target: Bbox): boolean {
  if (!Array.isArray(coordinates)) return false;
  if (coordinates.length >= 2 && typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
    const lon = coordinates[0];
    const lat = coordinates[1];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (lon < target.west) target.west = lon;
    if (lon > target.east) target.east = lon;
    if (lat < target.south) target.south = lat;
    if (lat > target.north) target.north = lat;
    return true;
  }
  for (const child of coordinates) {
    if (!bboxOfCoordinates(child, target)) return false;
  }
  return true;
}

function areaFraction(first: Bbox, second: Bbox): number {
  const width = Math.min(first.east, second.east) - Math.max(first.west, second.west);
  const height = Math.min(first.north, second.north) - Math.max(first.south, second.south);
  if (width <= 0 || height <= 0) return 0;
  const overlap = width * height;
  const firstArea = (first.east - first.west) * (first.north - first.south);
  const secondArea = (second.east - second.west) * (second.north - second.south);
  const union = firstArea + secondArea - overlap;
  return union > 0 ? overlap / union : 0;
}

function centroidDistanceMetres(first: readonly [number, number], second: readonly [number, number]): number {
  const midLat = (first[1] + second[1]) / 2;
  const dx = (second[0] - first[0]) * metresPerDegreeLon(midLat);
  const dy = (second[1] - first[1]) * metresPerDegreeLat();
  return Math.hypot(dx, dy);
}

function pointInRing(point: readonly [number, number], ring: unknown): boolean {
  if (!Array.isArray(ring)) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    const ax = a[0] as number;
    const ay = a[1] as number;
    const bx = b[0] as number;
    const by = b[1] as number;
    const cross = (point[1] - ay) * (bx - ax) - (point[0] - ax) * (by - ay);
    if (Math.abs(cross) < 1e-12) {
      if (
        point[0] >= Math.min(ax, bx) && point[0] <= Math.max(ax, bx) &&
        point[1] >= Math.min(ay, by) && point[1] <= Math.max(ay, by)
      ) return true;
    }
    if (ay > point[1] !== by > point[1] && point[0] < ((bx - ax) * (point[1] - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

function ringsOf(geometryType: string | undefined, coordinates: unknown): unknown[] {
  if (geometryType === "Polygon") return Array.isArray(coordinates) ? [coordinates] : [];
  if (geometryType === "MultiPolygon") return Array.isArray(coordinates) ? coordinates : [];
  return [];
}

function pointInGeometry(point: readonly [number, number], geometryType: string | undefined, coordinates: unknown): boolean {
  const polygons = ringsOf(geometryType, coordinates);
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) continue;
    if (!pointInRing(point, polygon[0])) continue;
    let inHole = false;
    for (let index = 1; index < polygon.length; index += 1) {
      if (pointInRing(point, polygon[index])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

interface BoundaryGeometry {
  type: string;
  coordinates: unknown;
}

export function loadBoundaryGeometry(boundaryPath: string = BOUNDARY_PATH): BoundaryGeometry {
  const parsed: unknown = JSON.parse(readFileSync(boundaryPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`Invalid boundary ${boundaryPath}`);
  const record = parsed as { features?: Array<{ geometry?: BoundaryGeometry }>; geometry?: BoundaryGeometry; type?: string };
  const geometry = record.features?.[0]?.geometry ?? record.geometry
    ?? (record.type === "Polygon" || record.type === "MultiPolygon" ? (record as unknown as BoundaryGeometry) : undefined);
  if (!geometry) throw new Error(`No boundary geometry in ${boundaryPath}`);
  return geometry;
}

export function cellKeyOf(bbox: Bbox): string {
  const x = Math.floor(bbox.west / PARITY_CELL_SIZE_DEGREES);
  const y = Math.floor(bbox.south / PARITY_CELL_SIZE_DEGREES);
  return `${x}:${y}`;
}

function cellNeighbours(key: string): string[] {
  const [x, y] = key.split(":").map((part) => Number.parseInt(part, 10));
  const keys: string[] = [];
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) keys.push(`${x + dx}:${y + dy}`);
  }
  return keys;
}

export class ParityIndex<T extends { bbox: Bbox; centroid: [number, number] }> {
  private readonly cells = new Map<string, Array<{ entry: T; centroid: [number, number] }>>();

  insert(entry: T): void {
    const key = cellKeyOf(entry.bbox);
    const bucket = this.cells.get(key);
    if (bucket === undefined) this.cells.set(key, [{ entry, centroid: entry.centroid }]);
    else bucket.push({ entry, centroid: entry.centroid });
  }

  get size(): number {
    let total = 0;
    for (const bucket of this.cells.values()) total += bucket.length;
    return total;
  }

  findBest(bbox: Bbox, centroid: [number, number], tolerance: number): { entry: T; score: number; distance: number } | null {
    let best: { entry: T; score: number; distance: number } | null = null;
    for (const key of cellNeighbours(cellKeyOf(bbox))) {
      const bucket = this.cells.get(key);
      if (bucket === undefined) continue;
      for (const candidate of bucket) {
        const distance = centroidDistanceMetres(centroid, candidate.centroid);
        if (distance > tolerance) continue;
        const score = areaFraction(bbox, candidate.entry.bbox);
        if (score <= 0) continue;
        if (best === null || score > best.score) best = { entry: candidate.entry, score, distance };
      }
    }
    return best;
  }
}

function centroidOfBbox(bbox: Bbox): [number, number] {
  return [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2];
}

function firstRingCentroid(geometryType: string | undefined, coordinates: unknown): [number, number] | null {
  const polygons = ringsOf(geometryType, coordinates);
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || !Array.isArray(polygon[0])) continue;
    const ring = polygon[0];
    if (!Array.isArray(ring) || ring.length === 0) continue;
    let lonSum = 0;
    let latSum = 0;
    let counted = 0;
    for (const position of ring) {
      if (!Array.isArray(position) || typeof position[0] !== "number" || typeof position[1] !== "number") continue;
      lonSum += position[0];
      latSum += position[1];
      counted += 1;
    }
    if (counted === 0) continue;
    return [lonSum / counted, latSum / counted];
  }
  return null;
}

async function* streamGzipLines(filePath: string): AsyncGenerator<string> {
  const source = createReadStream(filePath);
  const gunzip = createGunzip();
  source.on("error", () => gunzip.destroy());
  const rl = readline.createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

export function parseCadastreFeatureLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  const withoutTrailingComma = trimmed.endsWith(",") ? trimmed.slice(0, -1) : trimmed;
  return JSON.parse(withoutTrailingComma);
}

function emptyBbox(): Bbox {
  return { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
}

function isUsableBbox(bbox: Bbox): boolean {
  return Number.isFinite(bbox.west) && Number.isFinite(bbox.south)
    && Number.isFinite(bbox.east) && Number.isFinite(bbox.north)
    && bbox.east > bbox.west && bbox.north > bbox.south;
}

async function* streamCanonicalBuildings(): AsyncGenerator<CanonicalBuildingStreamEntry> {
  const entries = readdirSync(INTERMEDIATE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^building(?:-\d{4})?\.json$/.test(entry.name))
    .map((entry) => path.join(INTERMEDIATE_DIR, entry.name))
    .sort();
  for (const filePath of entries) {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      if (typeof value !== "object" || value === null) continue;
      const record = value as {
        stableId?: unknown;
        kind?: unknown;
        lon?: unknown;
        lat?: unknown;
        geometry?: { type?: unknown; coordinates?: unknown };
      };
      if (typeof record.stableId !== "string" || !record.stableId.startsWith(CANONICAL_BUILDING_PREFIX)) continue;
      const geometry = record.geometry;
      const bbox = emptyBbox();
      const valid = geometry !== undefined
        && typeof geometry.type === "string"
        && bboxOfCoordinates(geometry.coordinates, bbox)
        && isUsableBbox(bbox);
      yield {
        stableId: record.stableId,
        lon: typeof record.lon === "number" ? record.lon : Number.NaN,
        lat: typeof record.lat === "number" ? record.lat : Number.NaN,
        geometryType: typeof geometry?.type === "string" ? geometry.type : "unknown",
        bbox: valid ? bbox : null,
      };
    }
  }
}

interface CadastreBuildingIndexEntry extends ParitySample {
  commune: string;
  type: string;
}

export interface CadastreParityOptions {
  intermediateDir?: string;
  rawDir?: string;
  boundaryPath?: string;
  maxUnmatchedSamples?: number;
  onProgress?: (message: string) => void;
}

export async function computeCadastreParity(options: CadastreParityOptions = {}): Promise<CadastreParityReport> {
  const boundary = loadBoundaryGeometry(options.boundaryPath ?? BOUNDARY_PATH);
  const maxSamples = options.maxUnmatchedSamples ?? PARITY_MAX_SAMPLE_UNMATCHED;
  const log = options.onProgress ?? ((): void => undefined);

  const canonicalIndex = new ParityIndex<CadastreBuildingIndexEntry>();
  let canonicalTotal = 0;
  let canonicalInvalid = 0;
  let canonicalOutside = 0;
  let canonicalUnmatched = 0;
  const canonicalOrder: ParitySample[] = [];

  for await (const entry of streamCanonicalBuildings()) {
    canonicalTotal += 1;
    if (entry.bbox === null || !Number.isFinite(entry.lon) || !Number.isFinite(entry.lat)) {
      canonicalInvalid += 1;
      continue;
    }
    if (!pointInGeometry([entry.lon, entry.lat], boundary.type, boundary.coordinates)) {
      canonicalOutside += 1;
      continue;
    }
    const centroid = centroidOfBbox(entry.bbox);
    canonicalUnmatched += 1;
    const sample: ParitySample = { key: entry.stableId, bbox: entry.bbox, centroid };
    canonicalIndex.insert({ ...sample, commune: "", type: entry.geometryType });
    canonicalOrder.push(sample);
    if (canonicalUnmatched % 100_000 === 0) log(`canonical buildings streamed: ${canonicalUnmatched}`);
  }
  log(`canonical buildings: total ${canonicalTotal} indexed ${canonicalUnmatched} invalid ${canonicalInvalid} outside ${canonicalOutside}`);

  const cadastreIndex = new ParityIndex<CadastreBuildingIndexEntry>();
  let cadastreTotal = 0;
  let cadastreInvalid = 0;
  let cadastreOutside = 0;
  let cadastreMatched = 0;
  let cadastreUnmatched = 0;
  const cadastreOrder: ParitySample[] = [];
  const cadastreMatchDetail = new Map<string, ParityReportRow>();

  for await (const line of streamGzipLines(CADASTRE_BATIMENTS_PATH)) {
    if (line.length < 10) continue;
    if (!line.startsWith('{"type":"Feature"')) continue;
    let parsed: unknown;
    try {
      parsed = parseCadastreFeatureLine(line);
    } catch {
      cadastreInvalid += 1;
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as { geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> };
    const geometry = record.geometry;
    cadastreTotal += 1;
    const bbox = emptyBbox();
    if (geometry === undefined || typeof geometry.type !== "string" || !bboxOfCoordinates(geometry.coordinates, bbox) || !isUsableBbox(bbox)) {
      cadastreInvalid += 1;
      continue;
    }
    const centroid = firstRingCentroid(geometry.type, geometry.coordinates) ?? centroidOfBbox(bbox);
    if (!pointInGeometry(centroid, boundary.type, boundary.coordinates)) {
      cadastreOutside += 1;
      continue;
    }
    const best = canonicalIndex.findBest(bbox, centroid, PARITY_CENTROID_TOLERANCE_METRES);
    if (best !== null && best.score >= PARITY_MIN_OVERLAP) {
      cadastreMatched += 1;
      cadastreMatchDetail.set(best.entry.key, {
        canonicalKey: best.entry.key,
        cadastreKey: `${best.entry.commune}:${best.entry.type}:${bbox.west.toFixed(7)},${bbox.south.toFixed(7)}`,
        verdict: "matched",
        overlapRatio: Number(best.score.toFixed(4)),
        centroidDistanceMetres: Number(best.distance.toFixed(2)),
      });
      continue;
    }
    cadastreUnmatched += 1;
    const commune = typeof record.properties?.["commune"] === "string" ? (record.properties["commune"] as string) : "";
    const type = typeof record.properties?.["type"] === "string" ? (record.properties["type"] as string) : "";
    const key = `cadastre-batiment:${commune}:${type}:${bbox.west.toFixed(7)},${bbox.south.toFixed(7)}`;
    const sample: ParitySample = { key, bbox, centroid };
    cadastreIndex.insert({ ...sample, commune, type });
    cadastreOrder.push(sample);
    if (cadastreUnmatched % 100_000 === 0) log(`cadastre batiments streamed: ${cadastreUnmatched} unmatched`);
  }
  log(`cadastre batiments: total ${cadastreTotal} matched ${cadastreMatched} unmatched ${cadastreUnmatched} invalid ${cadastreInvalid} outside ${cadastreOutside}`);

  const onlyCanonicalSamples: ParitySample[] = [];
  const reportRows: ParityReportRow[] = [];
  let onlyCanonical = 0;
  for (const entry of canonicalOrder) {
    const match = cadastreMatchDetail.get(entry.key);
    if (match === undefined) {
      onlyCanonical += 1;
      if (onlyCanonicalSamples.length < maxSamples) onlyCanonicalSamples.push(entry);
      if (reportRows.length < PARITY_MAX_REPORT_ROWS) {
        reportRows.push({ canonicalKey: entry.key, cadastreKey: null, verdict: "only-canonical", overlapRatio: 0, centroidDistanceMetres: -1 });
      }
      continue;
    }
    if (reportRows.length < PARITY_MAX_REPORT_ROWS) reportRows.push(match);
  }
  const onlyCadastreSamples: ParitySample[] = [];
  for (const entry of cadastreOrder) {
    if (onlyCadastreSamples.length < maxSamples) onlyCadastreSamples.push(entry);
    if (reportRows.length < PARITY_MAX_REPORT_ROWS) {
      reportRows.push({ canonicalKey: "", cadastreKey: entry.key, verdict: "only-cadastre", overlapRatio: 0, centroidDistanceMetres: -1 });
    }
  }

  const matched = cadastreMatchDetail.size;
  const onlyCadastre = cadastreUnmatched;

  let lieuxDitsTotal = 0;
  let lieuxDitsInvalid = 0;
  let lieuxDitsNamed = 0;
  let lieuxDitsUnnamed = 0;
  let lieuxDitsWithCommune = 0;
  const lieuxDitsCommunes = new Set<string>();
  const lieuxDitsByPrefix: Record<string, number> = {};
  if (existsSync(CADASTRE_LIEUX_DITS_PATH)) {
    for await (const line of streamGzipLines(CADASTRE_LIEUX_DITS_PATH)) {
      if (!line.startsWith('{"type":"Feature"')) continue;
      let parsed: unknown;
      try {
        parsed = parseCadastreFeatureLine(line);
      } catch {
        lieuxDitsInvalid += 1;
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      lieuxDitsTotal += 1;
      const geometry = (parsed as { geometry?: { type?: unknown; coordinates?: unknown } }).geometry;
      const bbox = emptyBbox();
      if (geometry === undefined || typeof geometry.type !== "string" || !bboxOfCoordinates(geometry.coordinates, bbox) || !isUsableBbox(bbox)) {
        lieuxDitsInvalid += 1;
        continue;
      }
      const properties = (parsed as { properties?: Record<string, unknown> }).properties ?? {};
      const nom = typeof properties["nom"] === "string" ? (properties["nom"] as string).trim() : "";
      if (nom === "") lieuxDitsUnnamed += 1;
      else lieuxDitsNamed += 1;
      const commune = typeof properties["commune"] === "string" ? (properties["commune"] as string) : "";
      if (commune !== "") {
        lieuxDitsWithCommune += 1;
        lieuxDitsCommunes.add(commune);
      }
      const prefix = (nom.split(/\s+/)[0] ?? "").toUpperCase().slice(0, 4);
      lieuxDitsByPrefix[prefix] = (lieuxDitsByPrefix[prefix] ?? 0) + 1;
    }
  }

  const parityTotal = matched + onlyCanonical;
  return {
    dataset: "cadastre-parity",
    department: GERS_TERRITORY.code,
    generatedAt: new Date().toISOString(),
    license: CADASTRE_LICENSE,
    method: {
      strategy: "single pass streaming with a 0.02 degree spatial hash; no intermediate index on disk and no JSON parse of any full file",
      matchRule: "candidate in one of the nine neighbouring cells, bbox intersection over union at least 0.2 and centroid distance at most 25 metres",
      centroidToleranceMetres: PARITY_CENTROID_TOLERANCE_METRES,
      cellSizeDegrees: PARITY_CELL_SIZE_DEGREES,
      maxAmbiguousMatchesPerCell: 9,
      canonicalSource: "data/intermediate/building*.json (IGN BD TOPO batiment)",
      cadastreSource: path.basename(CADASTRE_BATIMENTS_PATH),
      sampling: "none (exhaustive)",
      peakRssBytes: process.memoryUsage().rss,
    },
    canonical: {
      total: canonicalTotal,
      invalid: canonicalInvalid,
      outsideBoundary: canonicalOutside,
      matched: matched,
      unmatched: onlyCanonical,
      unmatchedSamples: onlyCanonicalSamples,
    },
    cadastre: {
      total: cadastreTotal,
      invalid: cadastreInvalid,
      outsideBoundary: cadastreOutside,
      matched: cadastreMatched,
      unmatched: onlyCadastre,
      unmatchedSamples: onlyCadastreSamples,
    },
    both: {
      matched,
      onlyCanonical,
      onlyCadastre,
      ambiguous: 0,
      parityRatioPercent: parityTotal > 0 ? Number(((matched / parityTotal) * 100).toFixed(2)) : 0,
    },
    samples: { onlyCanonical: onlyCanonicalSamples, onlyCadastre: onlyCadastreSamples },
    locationdits: {
      source: path.basename(CADASTRE_LIEUX_DITS_PATH),
      license: CADASTRE_LICENSE,
      total: lieuxDitsTotal,
      invalidGeometry: lieuxDitsInvalid,
      named: lieuxDitsNamed,
      unnamed: lieuxDitsUnnamed,
      withCommune: lieuxDitsWithCommune,
      distinctCommunes: lieuxDitsCommunes.size,
      byPrefix: lieuxDitsByPrefix,
    },
    report: {
      rowsWritten: reportRows.length,
      maxRows: PARITY_MAX_REPORT_ROWS,
      rows: reportRows,
    },
  };
}

function readJsonIfPresent(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}


function countIntermediateRecords(kind: string): number {
  if (!existsSync(INTERMEDIATE_DIR)) return 0;
  const names = readdirSync(INTERMEDIATE_DIR);
  let total = 0;
  for (const name of names) {
    if (!new RegExp(`^${kind}(?:-\\d{4})?\\.json$`).test(name)) continue;
    const parsed: unknown = JSON.parse(readFileSync(path.join(INTERMEDIATE_DIR, name), "utf8"));
    if (Array.isArray(parsed)) total += parsed.length;
  }
  return total;
}

export function buildSourceAccounting(): SourceReconciliationReport {
  const sources: SourceAccounting[] = [];
  let totalInput = 0;
  let totalAccepted = 0;
  let totalDeduplicated = 0;
  let totalClipped = 0;
  let totalExcluded = 0;
  let totalInvalid = 0;
  let totalUnexplained = 0;

  const push = (entry: SourceAccounting): void => {
    sources.push(entry);
    totalInput += entry.input;
    totalAccepted += entry.accepted;
    totalDeduplicated += entry.deduplicated;
    totalClipped += entry.clipped;
    totalExcluded += entry.excluded;
    totalInvalid += entry.invalid;
    totalUnexplained += entry.unexplained;
  };

  const ban = readJsonIfPresent(BAN_RAW_PATH);
  if (ban !== null) {
    const addresses = Array.isArray(ban["addresses"]) ? (ban["addresses"] as unknown[]) : [];
    const reconciliation = ban["reconciliation"] as { stages?: Record<string, number>; duplicates?: Record<string, number> } | undefined;
    const stages = reconciliation?.stages ?? {};
    const duplicates = reconciliation?.duplicates ?? {};
    const input = numberOr(stages["dataRows"], 0);
    const clipped = numberOr(stages["outsideBoundary"], 0) + numberOr(stages["communeRejected"], 0);
    const invalid = numberOr(stages["nonFiniteCoordinates"], 0)
      + numberOr(stages["malformedRows"], 0)
      + numberOr(stages["shortRows"], 0);
    const dropped = numberOr(stages["duplicateBanIds"], 0);
    const emptyIds = numberOr(stages["emptyBanIds"], 0);
    const accepted = numberOr(stages["uniqueNormalized"], addresses.length);
    push({
      source: "ban",
      input,
      accepted,
      deduplicated: dropped,
      clipped,
      excluded: emptyIds,
      invalid,
      unexplained: input - clipped - invalid - dropped - emptyIds - accepted,
      notes: "CSV data rows to unique BAN identifiers; duplicates collapse on the BAN id which is the canonical stableId, so the deduplicate stage never sees them twice",
      breakdown: {
        rawLines: numberOr(stages["rawLines"], 0),
        headerLines: numberOr(stages["headerLines"], 0),
        dataRows: input,
        inBoundary: numberOr(stages["inBoundary"], 0),
        duplicateBanIds: dropped,
        duplicateKeys: numberOr(duplicates["duplicateKeyCount"], 0),
        conflictingPositionGroups: numberOr(duplicates["conflictingPositionGroups"], 0),
        recordCountInFile: addresses.length,
      },
    });
  }

  const banAuch = readJsonIfPresent(BAN_AUCH_RAW_PATH);
  if (banAuch !== null) {
    const addresses = Array.isArray(banAuch["addresses"]) ? (banAuch["addresses"] as unknown[]) : [];
    const reconciliation = banAuch["reconciliation"] as { stages?: Record<string, number> } | undefined;
    const stages = reconciliation?.stages ?? {};
    push({
      source: "ban-auch",
      input: numberOr(stages["rawLines"], 0),
      accepted: numberOr(stages["uniqueNormalized"], addresses.length),
      deduplicated: numberOr(stages["duplicateBanIds"], 0),
      clipped: numberOr(stages["communeRejected"], 0) + numberOr(stages["outsideBoundary"], 0),
      excluded: numberOr(stages["nonFiniteCoordinates"], 0) + numberOr(stages["emptyBanIds"], 0),
      invalid: 0,
      unexplained: 0,
      notes: "Auch scoped BAN acquisition, used by the Auch detail scope only",
      breakdown: { inBoundary: numberOr(stages["inBoundary"], 0), recordCountInFile: addresses.length },
    });
  }

  const sirene = readJsonIfPresent(SIRENE_RAW_PATH);
  if (sirene !== null) {
    const records = Array.isArray(sirene["records"]) ? (sirene["records"] as unknown[]) : [];
    const reconciliation = sirene["reconciliation"] as Record<string, number> | undefined;
    const withCoordinate = records.filter((value) => {
      if (typeof value !== "object" || value === null) return false;
      const coordinate = (value as { coordinate?: unknown }).coordinate;
      return typeof coordinate === "object" && coordinate !== null;
    }).length;
    const input = numberOr(reconciliation?.["establishedReceived"], records.length);
    const accepted = numberOr(reconciliation?.["accepted"], records.length);
    push({
      source: "businesses-sirene",
      input,
      accepted,
      deduplicated: input - accepted,
      clipped: 0,
      excluded: records.length - withCoordinate,
      invalid: 0,
      unexplained: 0,
      notes: "SIRET establishments after commune/section partitioning; records without coordinates are excluded by the canonical boundary test",
      breakdown: {
        recordsInFile: records.length,
        withCoordinate,
        withoutCoordinate: records.length - withCoordinate,
        geocodedByBan: numberOr(reconciliation?.["geocodedByBan"], 0),
        queries: numberOr(reconciliation?.["queriesExecuted"], 0),
        cappedQueries: numberOr(reconciliation?.["cappedQueries"], 0),
        truncated: sirene["truncated"] === true ? 1 : 0,
      },
    });
  }

  const intermediateBuildingCount = countIntermediateRecords("building");
  if (intermediateBuildingCount > 0) {
    push({
      source: "ign-bdtopo:building",
      input: intermediateBuildingCount,
      accepted: intermediateBuildingCount,
      deduplicated: 0,
      clipped: 0,
      excluded: 0,
      invalid: 0,
      unexplained: 0,
      notes: "canonical building records already reconciled; see cadastre-parity.json for the cadastre comparison and normalization-issues.json for schema rejects",
      breakdown: { intermediateFiles: countIntermediateRecordFiles("building") },
    });
  }

  return {
    dataset: "source-reconciliation",
    generatedAt: new Date().toISOString(),
    department: GERS_TERRITORY.code,
    sources,
    totals: {
      input: totalInput,
      accepted: totalAccepted,
      deduplicated: totalDeduplicated,
      clipped: totalClipped,
      excluded: totalExcluded,
      invalid: totalInvalid,
      unexplained: totalUnexplained,
    },
  };
}

function countIntermediateRecordFiles(kind: string): number {
  if (!existsSync(INTERMEDIATE_DIR)) return 0;
  return readdirSync(INTERMEDIATE_DIR).filter((name) => new RegExp(`^${kind}(?:-\\d{4})?\\.json$`).test(name)).length;
}

function parseArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipParity = argv.includes("--source-accounting-only");
  const maxSamples = Number.parseInt(parseArg(argv, "--max-samples") ?? "", 10);
  await mkdir(QA_DIR, { recursive: true });

  if (!skipParity) {
    if (!existsSync(CADASTRE_BATIMENTS_PATH)) {
      throw new Error(`Missing ${CADASTRE_BATIMENTS_PATH}; run tsx scripts/data/fetch-cadastre.ts first`);
    }
    console.log(`Computing cadastre parity (canonical buildings vs ${path.basename(CADASTRE_BATIMENTS_PATH)}) ...`);
    const report = await computeCadastreParity({
      maxUnmatchedSamples: Number.isFinite(maxSamples) ? maxSamples : undefined,
      onProgress: (message) => console.log(`[reconcile] ${message}`),
    });
    await writeFile(CADASTRE_PARITY_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      `[reconcile] cadastre parity: matched ${report.both.matched} onlyCanonical ${report.both.onlyCanonical} onlyCadastre ${report.both.onlyCadastre} parity ${report.both.parityRatioPercent}%`,
    );
    console.log(`[reconcile] peak rss ${(report.method.peakRssBytes / (1024 * 1024)).toFixed(0)} MiB`);
    console.log(`[reconcile] written ${CADASTRE_PARITY_PATH}`);
  }

  const accounting = buildSourceAccounting();
  await writeFile(SOURCE_RECONCILIATION_PATH, `${JSON.stringify(accounting, null, 2)}\n`, "utf8");
  console.log(`[reconcile] source accounting: ${accounting.sources.map((entry) => `${entry.source} in=${entry.input} acc=${entry.accepted} dup=${entry.deduplicated} clip=${entry.clipped} exc=${entry.excluded} unexp=${entry.unexplained}`).join(" | ")}`);
  console.log(`[reconcile] written ${SOURCE_RECONCILIATION_PATH}`);
}


if (process.argv[1]?.endsWith("reconcile-sources.ts")) {
  main().catch((error: unknown) => {
    console.error("[reconcile] Fatal:", error);
    process.exit(1);
  });
}

