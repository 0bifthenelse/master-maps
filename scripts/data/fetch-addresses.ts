import { createReadStream } from "node:fs";
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
const BAN_LICENSE = "Etalab-2.0";
const BAN_CRS = "WGS84 (EPSG:4326)";
const BAN_TRANSFORMATION = "none (native WGS84 lon/lat)";

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

interface AddressRecord {
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

function parseCommuneArg(argv: string[]): string | null {
  const index = argv.indexOf("--commune");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || !/^\d{5}$/.test(value)) {
    throw new Error("--commune requires a five digit INSEE code, for example --commune 32013");
  }
  return value;
}

function hasForceArg(argv: string[]): boolean {
  return argv.includes("--force");
}

async function acquireAddresses(commune: string | null, forceRefresh: boolean): Promise<{
  records: AddressRecord[];
  sha256: string;
  acquisitionTimestamp: string;
  etag: string;
  totalInDepartment: number;
  totalInBoundary: number;
  communeRejected: number;
  acquisition: AcquisitionOutcome;
}> {
  const acquisition = await acquireFile({
    url: BAN_CSV_GZ_URL,
    destination: BAN_CSV_GZ_PATH,
    forceRefresh,
  });
  console.log(`Acquiring BAN addresses from ${BAN_CSV_GZ_URL} ...`);
  const boundaryPath = commune === null ? GERS_BOUNDARY_PATH : AUCH_BOUNDARY_PATH;
  const scopeLabel = commune === null ? "Gers department" : `commune ${commune}`;
  console.log(`Loading ${scopeLabel} boundary from ${boundaryPath} ...`);
  const boundary = await loadBoundary(boundaryPath);

  const source = createReadStream(BAN_CSV_GZ_PATH);
  const gunzip = createGunzip();
  source.on("error", () => gunzip.destroy());
  const rl = readline.createInterface({
    input: source.pipe(gunzip),
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  const allAddresses: AddressRecord[] = [];
  let totalDepartment = 0;
  let communeRejected = 0;
  let totalInBoundary = 0;

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;

    const fields = parseCsvLine(line);

    if (!headerParsed) {
      headerParsed = true;
      continue;
    }

    const row = parseCsvRow(fields);
    totalDepartment += 1;

    if (commune !== null && row.codeInsee !== commune) {
      communeRejected += 1;
      continue;
    }

    const lon = Number.parseFloat(row.lon);
    const lat = Number.parseFloat(row.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      continue;
    }

    if (!pointInBoundary([lon, lat], boundary)) {
      continue;
    }
    totalInBoundary += 1;

    allAddresses.push(normalizeAddress(row));
  }

  console.log(`Total CSV rows: ${totalDepartment}`);
  if (commune !== null) {
    console.log(`Rejected by commune ${commune} INSEE filter: ${communeRejected}`);
  }
  console.log(`Within ${scopeLabel} boundary: ${totalInBoundary}`);

  return {
    records: allAddresses,
    sha256: acquisition.sha256,
    acquisitionTimestamp: acquisition.acquiredAt,
    etag: acquisition.etag ?? "",
    totalInDepartment: totalDepartment,
    totalInBoundary: totalInBoundary,
    communeRejected: communeRejected,
    acquisition,
  };
}

async function writeSourceManifest(
  entry: SourceManifestEntry,
): Promise<void> {
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
  console.log(
    `=== BAN Address Acquisition: ${commune === null ? `Department ${GERS_TERRITORY.code} (Gers)` : `Commune ${commune}`} ===`,
  );

  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(path.join(DATA_DIR, "manifests"), { recursive: true });

  const result = await acquireAddresses(commune, forceRefresh);

  const outputPath = commune === null ? GERS_OUTPUT_PATH : AUCH_OUTPUT_PATH;
  const outputPayload = commune === null
    ? {
        dataset: "ban",
        department: GERS_TERRITORY.code,
        acquisitionTimestamp: result.acquisitionTimestamp,
        license: BAN_LICENSE,
        sourceUrl: BAN_CSV_GZ_URL,
        recordCount: result.records.length,
        stats: {
          departmentTotal: result.totalInDepartment,
          boundaryFiltered: result.totalInBoundary,
        },
        addresses: result.records,
        sha256: result.sha256,
        fromCache: result.acquisition.fromCache,
        httpStatus: result.acquisition.httpStatus,
        bytesDownloaded: result.acquisition.bytesDownloaded,
        requestCount: result.acquisition.requestCount,
        retryCount: result.acquisition.retryCount,
        rateLimitCount: result.acquisition.rateLimitCount,
      }
    : {
        dataset: "ban",
        department: GERS_TERRITORY.code,
        commune,
        acquisitionTimestamp: result.acquisitionTimestamp,
        license: BAN_LICENSE,
        sourceUrl: BAN_CSV_GZ_URL,
        recordCount: result.records.length,
        stats: {
          departmentTotal: result.totalInDepartment,
          communeFiltered: result.communeRejected,
          boundaryFiltered: result.totalInBoundary,
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

  await writeFile(
    outputPath,
    JSON.stringify(outputPayload, null, 2),
    "utf-8",
  );
  console.log(
    `Written ${result.records.length} addresses to ${outputPath}`,
  );

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
    filteredRecordCount: result.totalInDepartment - result.totalInBoundary,
    retainedRecordCount: result.totalInBoundary,
  };
  await writeSourceManifest(manifestEntry);
  console.log(`Source manifest updated at ${SOURCES_MANIFEST_PATH}`);

  console.log("=== Acquisition complete ===");
}

main().catch((err) => {
  console.error("Fatal error during BAN address acquisition:", err);
  process.exit(1);
});
