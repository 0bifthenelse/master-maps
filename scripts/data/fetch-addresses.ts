/**
 * @file fetch-addresses.ts
 * Fetches BAN addresses in Gers department 32, retaining
 * only positions inside the complete authoritative department boundary.
 *
 * BAN bulk data: https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/
 * Department 32 CSV: adresses-32.csv.gz (semicolon-delimited, gzip-compressed)
 * JSON bulk format is not yet available (planned).
 *
 * Output: data/raw/ban-addresses.json
 * Each record is a normalized address object with:
 *   - banId: the BAN permanent ID
 *   - source: "ban"
 *   - sourceId: the BAN id field
 *   - number, repetition, streetName
 *   - postalCode, city, inseeCode
 *   - lon, lat (WGS84)
 *   - positionType, sourcePosition, certification
 *   - cadastreParcels
 *
 * Also writes to data/manifests/sources.json the acquisition metadata.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { GERS_TERRITORY } from "../../src/lib/data/territory";
/**
 * MASTER_MAPS_DATA_DIR - configured data root, defaults to "data"
 */
const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";

/**
 * BAN department URL for Gers (32)
 * CSV.gz available; JSON bulk not yet published.
 */
const BAN_CSV_GZ_URL =
  "https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-32.csv.gz";


/**
 * Authoritative department boundary file produced by fetch-admin-express.ts.
 */
const BOUNDARY_RAW_PATH = path.join(DATA_DIR, "raw", GERS_TERRITORY.boundaryRawFile);

/**
 * Output paths
 */
const RAW_OUTPUT_PATH = path.join(DATA_DIR, "raw", "ban-addresses.json");
const SOURCES_MANIFEST_PATH = path.join(
  DATA_DIR,
  "manifests",
  "sources.json",
);


/**
 * Known BAN license string
 * BAN data is under Etalab Open License 2.0 (equivalent to Open Licence 2.0)
 */
const BAN_LICENSE = "Etalab-2.0";

interface Boundary {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][] | number[][][][];
}

/**
 * Parsed BAN CSV row (all fields as strings from CSV).
 */
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

/**
 * Normalized address output record
 */
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

/**
 * Source manifest metadata entry
 */
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
}

// ---------------------------------------------------------------------------
// Boundary loading
// ---------------------------------------------------------------------------

/**
 * Load the complete Admin Express COG department boundary. Missing or
 * malformed authoritative geometry is a hard acquisition failure.
 */
async function loadBoundary(): Promise<Boundary> {
  const cached = await readFile(BOUNDARY_RAW_PATH, "utf8");
  const parsed = JSON.parse(cached) as {
    geometry?: Boundary;
    features?: Array<{ geometry?: Boundary }>;
    type?: string;
  };
  const geometry = parsed.features?.[0]?.geometry ?? parsed.geometry
    ?? (parsed.type === "Polygon" || parsed.type === "MultiPolygon" ? parsed as unknown as Boundary : undefined);
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
    throw new Error(`Invalid Gers boundary in ${BOUNDARY_RAW_PATH}`);
  }
  return geometry;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray casting)
// ---------------------------------------------------------------------------

/**
 * Check if a point [lon, lat] is inside a polygon ring using ray casting.
 * Handles points on boundary conservatively (returns true).
 */
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

    // Check if point lies on segment
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

    // Ray cast: horizontal ray to the right
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
/**
 * Map parsed CSV fields to BanCsvRow by numerical index.
 *
 * BAN CSV column order (adresses-XX.csv):
 *  0:id, 1:id_fantoir, 2:numero, 3:rep, 4:nom_voie,
 *  5:code_postal, 6:code_insee, 7:nom_commune,
 *  8:code_insee_ancienne_commune, 9:nom_ancienne_commune,
 * 10:x, 11:y, 12:lon, 13:lat, 14:type_position,
 * 15:alias, 16:nom_ld, 17:libelle_acheminement,
 * 18:nom_afnor, 19:source_position, 20:source_nom_voie,
 * 21:certification_commune, 22:cad_parcelles
 */
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

// ---------------------------------------------------------------------------
// Address normalization
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main acquisition flow
// ---------------------------------------------------------------------------

async function acquireAddresses(): Promise<{
  records: AddressRecord[];
  sha256: string;
  acquisitionTimestamp: string;
  etag: string;
  totalInDepartment: number;
  totalInBoundary: number;
}> {
  // 1. Download BAN CSV.gz for department 32
  console.log(
    `Downloading BAN addresses for department 32 from ${BAN_CSV_GZ_URL} ...`,
  );

  const response = await fetch(BAN_CSV_GZ_URL);
  if (!response.ok) {
    throw new Error(
      `BAN download failed: ${response.status} ${response.statusText}`,
    );
  }

  const etag = response.headers.get("etag") ?? "";
  const acquisitionTimestamp = new Date().toISOString();

  // Read the full gzip payload
  const arrayBuffer = await response.arrayBuffer();
  const compressedBuffer = Buffer.from(arrayBuffer);

  // 2. Load boundary polygon
  console.log("Loading Gers department boundary...");
  const boundary = await loadBoundary();

  // 3. Decompress and parse CSV line-by-line
  const hash = createHash("sha256");
  hash.update(compressedBuffer);

  const gunzip = createGunzip();
  const source = Readable.from([compressedBuffer]);

  const rl = readline.createInterface({
    input: source.pipe(gunzip),
    crlfDelay: Infinity,
  });

  let headerParsed = false;
  const allAddresses: AddressRecord[] = [];
  let totalDepartment = 0;
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
    totalDepartment++;

    // BAN already supplies the complete department. Boundary containment is
    // the final geographic guard and works across every polygon component.

    // Filter by boundary polygon
    const lon = Number.parseFloat(row.lon);
    const lat = Number.parseFloat(row.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      continue;
    }

    if (!pointInBoundary([lon, lat], boundary)) {
      continue;
    }
    totalInBoundary++;

    // Normalize and collect
    allAddresses.push(normalizeAddress(row));
  }

  const sha256Hex = hash.digest("hex");

  console.log(`Department 32 total CSV rows: ${totalDepartment}`);
  console.log(`Within Gers boundary: ${totalInBoundary}`);
  return {
    records: allAddresses,
    sha256: sha256Hex,
    acquisitionTimestamp,
    etag,
    totalInDepartment: totalDepartment,
    totalInBoundary: totalInBoundary,
  };
}

// ---------------------------------------------------------------------------
// Manifest writing
// ---------------------------------------------------------------------------

/**
 * Write or update sources.json manifest with a new source entry.
 * Replaces any existing "ban" entry.
 */
async function writeSourceManifest(
  entry: SourceManifestEntry,
): Promise<void> {
  const manifestPath = SOURCES_MANIFEST_PATH;
  let manifest: { sources: SourceManifestEntry[] } = { sources: [] };

  try {
    const { readFile } = await import("node:fs/promises");
    const existing = await readFile(manifestPath, "utf-8");
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed.sources)) {
      manifest = parsed as { sources: SourceManifestEntry[] };
      // Remove stale ban entry
      manifest.sources = manifest.sources.filter(
        (s: SourceManifestEntry) => s.source !== "ban",
      );
    }
  } catch {
    // File does not exist yet
  }

  manifest.sources.push(entry);

  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== BAN Address Acquisition: Department 32 (Gers) ===");

  // Ensure output directories exist
  await mkdir(path.join(DATA_DIR, "raw"), { recursive: true });
  await mkdir(path.join(DATA_DIR, "manifests"), { recursive: true });

  // Run acquisition
  const result = await acquireAddresses();

  // Write raw JSON output
  const outputPayload = {
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
  };

  await writeFile(
    RAW_OUTPUT_PATH,
    JSON.stringify(outputPayload, null, 2),
    "utf-8",
  );
  console.log(
    `Written ${result.records.length} addresses to ${RAW_OUTPUT_PATH}`,
  );

  // Write source manifest
  const manifestEntry: SourceManifestEntry = {
    source: "ban",
    url: BAN_CSV_GZ_URL,
    parameters: {
      department: GERS_TERRITORY.code,
      format: "csv",
      boundaryFilter: "IGN ADMIN EXPRESS COG department geometry",
    },
    timestamp: result.acquisitionTimestamp,
    license: BAN_LICENSE,
    etag: result.etag,
    sha256: result.sha256,
    recordCount: result.records.length,
    crs: "WGS84 (EPSG:4326)",
    transformation: "none (native WGS84 lon/lat)",
  };
  await writeSourceManifest(manifestEntry);
  console.log(`Source manifest updated at ${SOURCES_MANIFEST_PATH}`);

  console.log("=== Acquisition complete ===");
}

main().catch((err) => {
  console.error("Fatal error during BAN address acquisition:", err);
  process.exit(1);
});