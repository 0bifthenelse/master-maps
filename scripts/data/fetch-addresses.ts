import { createReadStream, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { acquireFile, type AcquisitionOutcome } from "./http-cache";
import { AUCH_DETAIL_SCOPE, GERS_TERRITORY } from "../../src/lib/data/territory";

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const BAN_CSV_GZ_URL =
  "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-32.csv.gz";
const BAN_CSV_GZ_PATH = path.join(RAW_DIR, "adresses-32.csv.gz");
const GERS_BOUNDARY_PATH = path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile);
const AUCH_BOUNDARY_PATH = path.join(RAW_DIR, AUCH_DETAIL_SCOPE.boundaryRawFile);
const GERS_OUTPUT_PATH = path.join(RAW_DIR, "ban-addresses.json");
const AUCH_OUTPUT_PATH = path.join(RAW_DIR, "ban-addresses-auch.json");
const SOURCES_MANIFEST_PATH = path.join(DATA_DIR, "manifests", "sources.json");
const ADDRESS_RECONCILIATION_PATH = path.join(DATA_DIR, "qa", "address-reconciliation.json");
const BAN_LICENSE = "Etalab-2.0";
const BAN_CRS = "WGS84 (EPSG:4326)";
const BAN_TRANSFORMATION = "none (native WGS84 lon/lat)";

export const BAN_CSV_COLUMNS = [
  "id",
  "id_fantoir",
  "numero",
  "rep",
  "nom_voie",
  "code_postal",
  "code_insee",
  "nom_commune",
  "code_insee_ancienne_commune",
  "nom_ancienne_commune",
  "x",
  "y",
  "lon",
  "lat",
  "type_position",
  "alias",
  "nom_ld",
  "libelle_acheminement",
  "nom_afnor",
  "source_position",
  "source_nom_voie",
  "certification_commune",
  "cad_parcelles",
] as const;

export const BAN_LOSS_REASONS = [
  "malformed-csv-row",
  "short-csv-row",
  "non-finite-coordinates",
  "outside-boundary",
  "commune-mismatch",
  "duplicate-ban-id",
  "empty-ban-id",
] as const;

export type BanLossReason = (typeof BAN_LOSS_REASONS)[number];

export interface AddressCounters {
  rawLines: number;
  headerLines: number;
  blankLines: number;
  dataRows: number;
  parsed: number;
  malformedRows: number;
  shortRows: number;
  communeRejected: number;
  nonFiniteCoordinates: number;
  outsideBoundary: number;
  inBoundary: number;
  normalized: number;
  duplicateBanIds: number;
  emptyBanIds: number;
  uniqueNormalized: number;
}

export interface AddressDuplicates {
  duplicateKeyCount: number;
  droppedRecords: number;
  identicalPositionGroups: number;
  conflictingPositionGroups: number;
  maxRowsForOneKey: number;
  samples: Array<{ banId: string; rows: number; distinctPositions: number }>;
}

export interface AddressReconciliation {
  dataset: "ban-address-reconciliation";
  department: string;
  scope: string;
  generatedAt: string;
  license: string;
  sourceUrl: string;
  sourceSha256: string;
  boundary: string;
  stages: AddressCounters;
  indexed: number;
  losses: Record<BanLossReason, number>;
  duplicates: AddressDuplicates;
  upstream: {
    csvDataRows: number;
    sourceRecordCount: number;
    searchIndexAddressEntries: number;
    indexedMatchesSource: boolean;
  };
  unexplained: number;
}

interface Boundary {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

interface BanCsvRow {
  id: string;
  idFantoir: string;
  numero: string;
  rep: string;
  nomVoie: string;
  codePostal: string;
  codeInsee: string;
  nomCommune: string;
  lon: string;
  lat: string;
  typePosition: string;
  nomLd: string;
  libelleAcheminement: string;
  nomAfnor: string;
  sourcePosition: string;
  sourceNomVoie: string;
  certificationCommune: string;
  cadParcelles: string;
}

export interface AddressRecord {
  banId: string;
  source: string;
  sourceId: string;
  numero: string;
  repetition: string;
  streetName: string;
  streetNameAfnor: string;
  postalCode: string;
  city: string;
  cityAfnor: string;
  inseeCode: string;
  lon: number;
  lat: number;
  positionType: string;
  sourcePosition: string;
  certificationCommune: string;
  cadastreParcelles: string;
  localityName: string;
}

interface SourceManifestEntry {
  source: string;
  url: string;
  parameters: Record<string, unknown>;
  timestamp: string;
  license: string;
  etag?: string;
  sha256: string;
  recordCount: number;
  crs: string;
  transformation: string;
  fromCache?: boolean;
  httpStatus?: number;
  bytesDownloaded?: number;
  requestCount?: number;
  retryCount?: number;
  rateLimitCount?: number;
  filteredRecordCount?: number;
  retainedRecordCount?: number;
}

interface SourcesManifestFile {
  sources: SourceManifestEntry[];
  [key: string]: unknown;
}

function isSourcesManifestFile(value: unknown): value is SourcesManifestFile {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { sources?: unknown }).sources);
}

async function loadBoundary(boundaryPath: string): Promise<Boundary> {
  const cached = await readFile(boundaryPath, "utf8");
  const parsed = JSON.parse(cached) as {
    geometry?: Boundary;
    features?: Array<{ geometry?: Boundary }>;
    type?: string;
  };
  const geometry = parsed.features?.[0]?.geometry ?? parsed.geometry
    ?? (parsed.type === "Polygon" || parsed.type === "MultiPolygon" ? parsed as unknown as Boundary : undefined);
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
    throw new Error(`Invalid boundary geometry in ${boundaryPath}`);
  }
  return geometry;
}

function pointInRing(
  point: readonly [number, number],
  ring: number[][],
): boolean {
  const [px, py] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[i]![0];
    const ay = ring[i]![1];
    const bx = ring[j]![0];
    const by = ring[j]![1];

    const cross = (py - ay) * (bx - ax) - (px - ax) * (by - ay);
    if (Math.abs(cross) < 1e-12) {
      if (
        px >= Math.min(ax, bx) &&
        px <= Math.max(ax, bx) &&
        py >= Math.min(ay, by) &&
        py <= Math.max(ay, by)
      ) {
        return true;
      }
    }

    if (
      ay > py !== by > py &&
      px < ((bx - ax) * (py - ay)) / (by - ay) + ax
    ) {
      inside = !inside;
    }
  }

  return inside;
}

type PolygonRings = number[][][];

function pointInPolygon(point: readonly [number, number], rings: PolygonRings): boolean {
  const outerRing = rings[0];
  if (!outerRing || !pointInRing(point, outerRing)) return false;
  for (const innerRing of rings.slice(1)) {
    if (pointInRing(point, innerRing)) return false;
  }
  return true;
}

function pointInBoundary(point: readonly [number, number], boundary: Boundary): boolean {
  const polygons: PolygonRings[] = boundary.type === "Polygon"
    ? [boundary.coordinates]
    : boundary.coordinates;
  return polygons.some((rings) => pointInPolygon(point, rings));
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (inQuotes && line[index + 1] === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === ";" && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsvRow(fields: string[]): BanCsvRow {
  return {
    id: fields[0] ?? "",
    idFantoir: fields[1] ?? "",
    numero: fields[2] ?? "",
    rep: fields[3] ?? "",
    nomVoie: fields[4] ?? "",
    codePostal: fields[5] ?? "",
    codeInsee: fields[6] ?? "",
    nomCommune: fields[7] ?? "",
    lon: fields[12] ?? "",
    lat: fields[13] ?? "",
    typePosition: fields[14] ?? "",
    nomLd: fields[16] ?? "",
    libelleAcheminement: fields[17] ?? "",
    nomAfnor: fields[18] ?? "",
    sourcePosition: fields[19] ?? "",
    sourceNomVoie: fields[20] ?? "",
    certificationCommune: fields[21] ?? "",
    cadParcelles: fields[22] ?? "",
  };
}

function normalizeAddress(row: BanCsvRow): AddressRecord {
  const lon = Number.parseFloat(row.lon);
  const lat = Number.parseFloat(row.lat);

  return {
    banId: row.id,
    source: "ban",
    sourceId: row.idFantoir,
    numero: row.numero,
    repetition: row.rep,
    streetName: row.nomVoie,
    streetNameAfnor: row.nomAfnor,
    postalCode: row.codePostal,
    city: row.nomCommune,
    cityAfnor: row.libelleAcheminement,
    inseeCode: row.codeInsee,
    lon: Number.isFinite(lon) ? lon : 0,
    lat: Number.isFinite(lat) ? lat : 0,
    positionType: row.typePosition,
    sourcePosition: row.sourcePosition,
    certificationCommune: row.certificationCommune,
    cadastreParcelles: row.cadParcelles,
    localityName: row.nomLd,
  };
}

function positionSignature(record: AddressRecord): string {
  return [
    record.lon,
    record.lat,
    record.positionType,
    record.sourcePosition,
    record.certificationCommune,
    record.cadastreParcelles,
  ].join("|");
}

function newCounters(): AddressCounters {
  return {
    rawLines: 0,
    headerLines: 0,
    blankLines: 0,
    dataRows: 0,
    parsed: 0,
    malformedRows: 0,
    shortRows: 0,
    communeRejected: 0,
    nonFiniteCoordinates: 0,
    outsideBoundary: 0,
    inBoundary: 0,
    normalized: 0,
    duplicateBanIds: 0,
    emptyBanIds: 0,
    uniqueNormalized: 0,
  };
}

function newLosses(): Record<BanLossReason, number> {
  const losses = {} as Record<BanLossReason, number>;
  for (const reason of BAN_LOSS_REASONS) losses[reason] = 0;
  return losses;
}

export function summarizeBanDuplicates(records: AddressRecord[]): AddressDuplicates {
  const groups = new Map<string, AddressRecord[]>();
  for (const record of records) {
    const bucket = groups.get(record.banId);
    if (bucket === undefined) groups.set(record.banId, [record]);
    else bucket.push(record);
  }
  let duplicateKeyCount = 0;
  let droppedRecords = 0;
  let identicalPositionGroups = 0;
  let conflictingPositionGroups = 0;
  let maxRowsForOneKey = 0;
  const samples: AddressDuplicates["samples"] = [];
  for (const [banId, rows] of groups) {
    if (rows.length < 2) continue;
    duplicateKeyCount += 1;
    droppedRecords += rows.length - 1;
    if (rows.length > maxRowsForOneKey) maxRowsForOneKey = rows.length;
    const distinctPositions = new Set(rows.map(positionSignature));
    if (distinctPositions.size === 1) identicalPositionGroups += 1;
    else conflictingPositionGroups += 1;
    if (samples.length < 10) {
      samples.push({ banId, rows: rows.length, distinctPositions: distinctPositions.size });
    }
  }
  return {
    duplicateKeyCount,
    droppedRecords,
    identicalPositionGroups,
    conflictingPositionGroups,
    maxRowsForOneKey,
    samples,
  };
}

export function summarizeDuplicateGroups(groups: Map<string, AddressRecord[]>): AddressDuplicates {
  let droppedRecords = 0;
  let identicalPositionGroups = 0;
  let conflictingPositionGroups = 0;
  let maxRowsForOneKey = 0;
  const samples: AddressDuplicates["samples"] = [];
  for (const [banId, dropped] of groups) {
    droppedRecords += dropped.length;
    const totalRows = dropped.length + 1;
    if (totalRows > maxRowsForOneKey) maxRowsForOneKey = totalRows;
    const distinctPositions = new Set(dropped.map(positionSignature));
    if (distinctPositions.size === 1) identicalPositionGroups += 1;
    else conflictingPositionGroups += 1;
    if (samples.length < 10) {
      samples.push({ banId, rows: totalRows, distinctPositions: distinctPositions.size });
    }
  }
  return {
    duplicateKeyCount: groups.size,
    droppedRecords,
    identicalPositionGroups,
    conflictingPositionGroups,
    maxRowsForOneKey,
    samples,
  };
}

export function countIndexedAddresses(dataDir: string = DATA_DIR): { count: number; present: boolean } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(dataDir, "search", "index.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { count: 0, present: false };
    let count = 0;
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "address") count += 1;
    }
    return { count, present: true };
  } catch {
    return { count: 0, present: false };
  }
}

export function readBanLossCounters(
  reconciliationPath: string = ADDRESS_RECONCILIATION_PATH,
): { stages: AddressCounters; indexed: number; losses: Record<BanLossReason, number>; unexplained: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reconciliationPath, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<AddressReconciliation>;
  if (typeof candidate.stages !== "object" || candidate.stages === null) return null;
  if (typeof candidate.losses !== "object" || candidate.losses === null) return null;
  return {
    stages: candidate.stages as AddressCounters,
    indexed: typeof candidate.indexed === "number" ? candidate.indexed : 0,
    losses: candidate.losses as Record<BanLossReason, number>,
    unexplained: typeof candidate.unexplained === "number" ? candidate.unexplained : 0,
  };
}

function parseCommuneArg(argv: string[]): string | null {
  const index = argv.indexOf("--commune");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || !/^\d{5}$/.test(value)) {
    throw new Error("--commune requires a five digit INSEE code, for example --commune 32013");
  }
  return value;
}

function parseDataDirArg(argv: string[]): string {
  const index = argv.indexOf("--data-dir");
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined ? DATA_DIR : value;
}

function hasForceArg(argv: string[]): boolean {
  return argv.includes("--force");
}

interface AcquiredAddresses {
  records: AddressRecord[];
  counters: AddressCounters;
  losses: Record<BanLossReason, number>;
  duplicates: AddressDuplicates;
  sha256: string;
  acquisitionTimestamp: string;
  etag: string;
  acquisition: AcquisitionOutcome;
}

async function acquireAddresses(
  commune: string | null,
  forceRefresh: boolean,
  dataDir: string,
): Promise<AcquiredAddresses> {
  const rawDir = path.join(dataDir, "raw");
  const csvPath = path.join(rawDir, path.basename(BAN_CSV_GZ_PATH));
  const boundaryPath = commune === null
    ? path.join(rawDir, GERS_TERRITORY.boundaryRawFile)
    : path.join(rawDir, AUCH_DETAIL_SCOPE.boundaryRawFile);
  const scopeLabel = commune === null ? "Gers department" : `commune ${commune}`;

  const acquisition = await acquireFile({
    url: BAN_CSV_GZ_URL,
    destination: csvPath,
    forceRefresh,
  });
  console.log(`Acquired BAN CSV (sha256 ${acquisition.sha256.slice(0, 16)}, fromCache ${acquisition.fromCache})`);
  console.log(`Loading ${scopeLabel} boundary from ${boundaryPath} ...`);
  const boundary = await loadBoundary(boundaryPath);

  const source = createReadStream(csvPath);
  const gunzip = createGunzip();
  source.on("error", () => gunzip.destroy());
  const rl = readline.createInterface({
    input: source.pipe(gunzip),
    crlfDelay: Infinity,
  });

  const counters = newCounters();
  const losses = newLosses();
  const uniqueRecords: AddressRecord[] = [];
  const seenBanIds = new Set<string>();
  const duplicateGroups = new Map<string, AddressRecord[]>();
  let headerValidated = false;

  for await (const rawLine of rl) {
    counters.rawLines += 1;
    const line = rawLine.trim();
    if (line === "") {
      counters.blankLines += 1;
      continue;
    }

    const fields = parseCsvLine(line);

    if (!headerValidated) {
      counters.headerLines += 1;
      const header = fields.map((field) => field.trim());
      if (header.length !== BAN_CSV_COLUMNS.length) {
        throw new Error(`BAN CSV header has ${header.length} columns, expected ${BAN_CSV_COLUMNS.length}`);
      }
      for (let index = 0; index < BAN_CSV_COLUMNS.length; index += 1) {
        if (header[index] !== BAN_CSV_COLUMNS[index]) {
          throw new Error(
            `BAN CSV column ${index} is "${header[index]}" but "${BAN_CSV_COLUMNS[index]}" was expected; refusing index based parsing`,
          );
        }
      }
      headerValidated = true;
      continue;
    }

    counters.dataRows += 1;

    if (fields.length !== BAN_CSV_COLUMNS.length) {
      counters.shortRows += 1;
      losses["short-csv-row"] += 1;
      continue;
    }

    const row = parseCsvRow(fields);
    if (row.id.trim() === "" && row.idFantoir.trim() === "") {
      counters.malformedRows += 1;
      losses["malformed-csv-row"] += 1;
      continue;
    }
    counters.parsed += 1;

    if (commune !== null && row.codeInsee !== commune) {
      counters.communeRejected += 1;
      losses["commune-mismatch"] += 1;
      continue;
    }

    const lon = Number.parseFloat(row.lon);
    const lat = Number.parseFloat(row.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      counters.nonFiniteCoordinates += 1;
      losses["non-finite-coordinates"] += 1;
      continue;
    }

    if (!pointInBoundary([lon, lat], boundary)) {
      counters.outsideBoundary += 1;
      losses["outside-boundary"] += 1;
      continue;
    }
    counters.inBoundary += 1;

    const record = normalizeAddress(row);
    if (record.banId.trim() === "") {
      counters.emptyBanIds += 1;
      losses["empty-ban-id"] += 1;
      continue;
    }
    counters.normalized += 1;

    if (seenBanIds.has(record.banId)) {
      counters.duplicateBanIds += 1;
      losses["duplicate-ban-id"] += 1;
      const group = duplicateGroups.get(record.banId);
      if (group === undefined) duplicateGroups.set(record.banId, [record]);
      else group.push(record);
      continue;
    }
    seenBanIds.add(record.banId);
    uniqueRecords.push(record);
  }

  counters.uniqueNormalized = uniqueRecords.length;

  if (counters.rawLines !== counters.dataRows + counters.headerLines + counters.blankLines) {
    throw new Error(
      `BAN line accounting does not close: rawLines ${counters.rawLines} vs header ${counters.headerLines} + data ${counters.dataRows} + blank ${counters.blankLines}`,
    );
  }

  console.log(`Raw CSV lines: ${counters.rawLines} (data rows ${counters.dataRows})`);
  if (commune !== null) {
    console.log(`Rejected by commune ${commune} INSEE filter: ${counters.communeRejected}`);
  }
  console.log(`Within ${scopeLabel} boundary: ${counters.inBoundary}`);
  console.log(`Unique normalized addresses: ${counters.uniqueNormalized}`);

  return {
    records: uniqueRecords,
    counters,
    losses,
    duplicates: summarizeDuplicateGroups(duplicateGroups),
    sha256: acquisition.sha256,
    acquisitionTimestamp: acquisition.acquiredAt,
    etag: acquisition.etag ?? "",
    acquisition,
  };
}

async function writeSourceManifest(entry: SourceManifestEntry): Promise<void> {
  let manifest: SourcesManifestFile = { sources: [] };

  try {
    const existing = await readFile(SOURCES_MANIFEST_PATH, "utf-8");
    const parsed: unknown = JSON.parse(existing);
    if (isSourcesManifestFile(parsed)) {
      parsed.sources = parsed.sources.filter(
        (candidate) => candidate.source !== entry.source,
      );
      manifest = parsed;
    }
  } catch {
    manifest = { sources: [] };
  }

  manifest.sources.push(entry);

  await mkdir(path.dirname(SOURCES_MANIFEST_PATH), { recursive: true });
  await writeFile(
    SOURCES_MANIFEST_PATH,
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const commune = parseCommuneArg(argv);
  const forceRefresh = hasForceArg(argv);
  const dataDir = parseDataDirArg(argv);
  console.log(
    `=== BAN Address Acquisition: ${commune === null ? `Department ${GERS_TERRITORY.code} (Gers)` : `Commune ${commune}`} ===`,
  );

  const rawDir = path.join(dataDir, "raw");
  await mkdir(rawDir, { recursive: true });
  await mkdir(path.join(dataDir, "manifests"), { recursive: true });
  await mkdir(path.join(dataDir, "qa"), { recursive: true });

  const result = await acquireAddresses(commune, forceRefresh, dataDir);
  const duplicates = result.duplicates;

  const outputPath = commune === null
    ? path.join(rawDir, "ban-addresses.json")
    : path.join(rawDir, "ban-addresses-auch.json");
  const commonPayload = {
    dataset: "ban",
    department: GERS_TERRITORY.code,
    acquisitionTimestamp: result.acquisitionTimestamp,
    license: BAN_LICENSE,
    sourceUrl: BAN_CSV_GZ_URL,
    recordCount: result.records.length,
    reconciliation: {
      stages: result.counters,
      losses: result.losses,
      duplicates,
    },
    addresses: result.records,
    sha256: result.sha256,
    fromCache: result.acquisition.fromCache,
    httpStatus: result.acquisition.httpStatus,
    bytesDownloaded: result.acquisition.bytesDownloaded,
    requestCount: result.acquisition.requestCount,
    retryCount: result.acquisition.retryCount,
    rateLimitCount: result.acquisition.rateLimitCount,
  };
  const outputPayload = commune === null
    ? {
        ...commonPayload,
        stats: {
          departmentTotal: result.counters.parsed,
          boundaryFiltered: result.counters.inBoundary,
          uniqueNormalized: result.counters.uniqueNormalized,
        },
      }
    : {
        ...commonPayload,
        commune,
        stats: {
          departmentTotal: result.counters.parsed,
          communeFiltered: result.counters.communeRejected,
          boundaryFiltered: result.counters.inBoundary,
          uniqueNormalized: result.counters.uniqueNormalized,
        },
      };

  await writeFile(outputPath, JSON.stringify(outputPayload, null, 2), "utf-8");
  console.log(`Written ${result.records.length} addresses to ${outputPath}`);

  const boundaryPath = commune === null
    ? path.join(rawDir, GERS_TERRITORY.boundaryRawFile)
    : path.join(rawDir, AUCH_DETAIL_SCOPE.boundaryRawFile);
  const searchIndex = countIndexedAddresses(dataDir);
  const reconciliation: AddressReconciliation = {
    dataset: "ban-address-reconciliation",
    department: GERS_TERRITORY.code,
    scope: commune === null ? `departement ${GERS_TERRITORY.code}` : `commune ${commune}`,
    generatedAt: new Date().toISOString(),
    license: BAN_LICENSE,
    sourceUrl: BAN_CSV_GZ_URL,
    sourceSha256: result.sha256,
    boundary: boundaryPath,
    stages: result.counters,
    indexed: searchIndex.count,
    losses: result.losses,
    duplicates,
    upstream: {
      csvDataRows: result.counters.dataRows,
      sourceRecordCount: result.records.length,
      searchIndexAddressEntries: searchIndex.count,
      indexedMatchesSource: searchIndex.count === result.counters.uniqueNormalized,
    },
    unexplained: result.counters.malformedRows,
  };
  await writeFile(
    ADDRESS_RECONCILIATION_PATH,
    `${JSON.stringify(reconciliation, null, 2)}\n`,
    "utf-8",
  );
  console.log(`Address reconciliation written to ${ADDRESS_RECONCILIATION_PATH}`);

  const manifestEntry: SourceManifestEntry = {
    source: commune === null ? "ban" : "ban-auch",
    url: BAN_CSV_GZ_URL,
    parameters: commune === null
      ? {
          department: GERS_TERRITORY.code,
          format: "csv",
          boundaryFilter: "IGN ADMIN EXPRESS COG department geometry",
        }
      : {
          department: GERS_TERRITORY.code,
          commune,
          format: "csv",
          boundaryFilter: "IGN ADMIN EXPRESS COG commune geometry",
        },
    timestamp: result.acquisitionTimestamp,
    license: BAN_LICENSE,
    etag: result.etag,
    sha256: result.sha256,
    recordCount: result.records.length,
    crs: BAN_CRS,
    transformation: BAN_TRANSFORMATION,
    fromCache: result.acquisition.fromCache,
    httpStatus: result.acquisition.httpStatus,
    bytesDownloaded: result.acquisition.bytesDownloaded,
    requestCount: result.acquisition.requestCount,
    retryCount: result.acquisition.retryCount,
    rateLimitCount: result.acquisition.rateLimitCount,
    filteredRecordCount: result.counters.parsed - result.counters.inBoundary,
    retainedRecordCount: result.counters.inBoundary,
  };
  await writeSourceManifest(manifestEntry);
  console.log(`Source manifest updated at ${SOURCES_MANIFEST_PATH}`);

  if (result.counters.uniqueNormalized !== result.records.length) {
    throw new Error(
      `Address normalization lost records: uniqueNormalized ${result.counters.uniqueNormalized} vs emitted ${result.records.length}`,
    );
  }

  console.log("=== Acquisition complete ===");
}

if (process.argv[1]?.endsWith("fetch-addresses.ts")) {
  main().catch((err) => {
    console.error("Fatal error during BAN address acquisition:", err);
    process.exit(1);
  });
}
