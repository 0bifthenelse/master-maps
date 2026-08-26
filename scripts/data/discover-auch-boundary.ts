#!/usr/bin/env tsx
/**
 * discover-auch-boundary.ts
 *
 * Fetches the Auch commune boundary from geo.api.gouv.fr,
 * verifies INSEE code 32013, stores raw GeoJSON, computes
 * the authoritative WGS84 bbox, and writes a source record.
 *
 * Uses MASTER_MAPS_DATA_DIR env var (default "data") for paths.
 *
 * Exits with structured error on any failure.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

/* ── Local types (mirror schema.ts contracts; replaced by import
      when the canonical schema file exists) ─────────────────────── */

interface SourceReference {
  source: string;
  url?: string;
  timestamp: string;
  license?: string;
  sha256?: string;
  recordCount?: number;
}

/* ── Helpers ────────────────────────────────────────────────────── */

function fail(message: string, code = 1): never {
  // Write structured error to stderr as JSON for programmatic consumption
  const error = { ok: false, code, message, source: "discover-auch-boundary" };
  console.error(JSON.stringify(error, null, 2));
  process.exit(code);
}

interface GeoJsonFeature {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: Record<string, unknown>;
}

interface GeoJsonCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

function isFeatureCollection(raw: unknown): raw is GeoJsonCollection {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  return obj["type"] === "FeatureCollection" && Array.isArray(obj["features"]);
}

/**
 * Compute the bbox [west, south, east, north] from GeoJSON geometry.
 * Supports Polygon and MultiPolygon coordinates (handles the outer
 * ring of each polygon, which is sufficient for bbox computation).
 */
function computeBbox(geometry: GeoJsonFeature["geometry"]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const coords = geometry.coordinates as unknown[];

  function scanRing(ring: number[][]) {
    for (const pt of ring) {
      const lon = pt[0] as number;
      const lat = pt[1] as number;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }

  function scanPolygon(polyCoords: unknown[]) {
    for (const ring of polyCoords) {
      scanRing(ring as number[][]);
    }
  }

  if (geometry.type === "Polygon") {
    scanPolygon(coords);
  } else if (geometry.type === "MultiPolygon") {
    for (const poly of coords) {
      scanPolygon(poly as unknown[]);
    }
  } else {
    fail(`Unsupported geometry type: ${geometry.type}`, 3);
  }

  if (!isFinite(minLon) || !isFinite(minLat) || !isFinite(maxLon) || !isFinite(maxLat)) {
    fail("Computed non-finite bbox from geometry", 4);
  }

  return [minLon, minLat, maxLon, maxLat];
}

/* ── Main ───────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const dataDir = process.env["MASTER_MAPS_DATA_DIR"] ?? "data";
  const rawDir = path.join(dataDir, "raw");
  const intermediateDir = path.join(dataDir, "intermediate");

  // Ensure directories exist
  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(intermediateDir, { recursive: true });

  // ── 1. Fetch the geo.api.gouv.fr endpoint ─────────────────────
  const url =
    "https://geo.api.gouv.fr/communes?codePostal=32000&fields=nom,code,codeDepartement,codeRegion,geometry&format=geojson&geometry=contour";

  const response = await fetch(url);
  if (!response.ok) {
    fail(
      `HTTP ${response.status} ${response.statusText} from ${url}`,
      10,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !contentType.includes("geojson")) {
    fail(`Unexpected content-type: ${contentType}`, 11);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    fail(`Failed to parse response JSON: ${(err as Error).message}`, 12);
  }

  // ── 2. Validate FeatureCollection ──────────────────────────────
  if (!isFeatureCollection(raw)) {
    fail("Response is not a GeoJSON FeatureCollection", 13);
  }

  if (raw.features.length === 0) {
    fail("FeatureCollection is empty — no commune found for code postal 32000", 14);
  }

  // ── 3. Find the Auch feature (code 32013) ──────────────────────
  const feature = raw.features.find(
    (f) => String(f.properties["code"]) === "32013",
  );

  if (!feature) {
    fail(
      `No feature with INSEE code 32013 (Auch) in the response. ` +
        `Found codes: ${raw.features.map((f) => f.properties["code"]).join(", ")}`,
      15,
    );
  }

  const communeName = feature.properties["nom"] as string | undefined;
  if (!communeName || communeName.toLowerCase() !== "auch") {
    fail(`Unexpected commune name: "${communeName ?? "(missing)"}" for code 32013`, 16);
  }

  // ── 4. Write raw GeoJSON ───────────────────────────────────────
  const rawJson = JSON.stringify(raw, null, 2);
  const rawPath = path.join(rawDir, "auch-boundary.geojson");
  await fs.writeFile(rawPath, rawJson, "utf-8");

  // SHA-256 of stored raw file
  const sha256 = createHash("sha256").update(rawJson).digest("hex");

  // ── 5. Compute authoritative bbox ──────────────────────────────
  const bbox = computeBbox(feature.geometry);
  const [west, south, east, north] = bbox;

  // ── 6. Write source record ─────────────────────────────────────
  const timestamp = new Date().toISOString();

  const sourceRecord: SourceReference = {
    source: "geo.api.gouv.fr",
    url,
    timestamp,
    license: "etalab-2.0",
    sha256,
    recordCount: raw.features.length,
  };

  const boundarySource: BoundarySourceRecord = {
    source: sourceRecord,
    commune: {
      code: "32013",
      nom: "Auch",
      codeDepartement: String(feature.properties["codeDepartement"] ?? ""),
      codeRegion: String(feature.properties["codeRegion"] ?? ""),
    },
    bbox: { west, south, east, north },
    rawFile: "data/raw/auch-boundary.geojson",
  };

  const sourcePath = path.join(intermediateDir, "boundary-source.json");
  await fs.writeFile(sourcePath, JSON.stringify(boundarySource, null, 2), "utf-8");

  // ── 7. Report success to stdout ────────────────────────────────
  const report = {
    ok: true,
    commune: { code: "32013", nom: "Auch" },
    bbox: { west, south, east, north },
    rawFile: rawPath,
    sourceFile: sourcePath,
    sha256,
    featureCount: raw.features.length,
  };

  console.log(JSON.stringify(report, null, 2));
}

/* ── Additional local type ──────────────────────────────────────── */

interface BoundarySourceRecord {
  source: SourceReference;
  commune: {
    code: string;
    nom: string;
    codeDepartement: string;
    codeRegion: string;
  };
  bbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  rawFile: string;
}

/* ── Entry point ────────────────────────────────────────────────── */

main().catch((err: unknown) => {
  fail((err as Error).message ?? String(err), 99);
});