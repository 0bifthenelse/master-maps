#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

type Ring = [number, number][];
type BoundaryGeometry =
  | { type: "Polygon"; coordinates: Ring[] }
  | { type: "MultiPolygon"; coordinates: Ring[][] };
interface GeoJsonFeature { type: "Feature"; geometry: BoundaryGeometry; properties: Record<string, unknown>; }
interface GeoJsonCollection { type: "FeatureCollection"; features: GeoJsonFeature[]; }

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");
const WFS_URL = "https://data.geopf.fr/wfs/ows";
const SOURCE_URL = `${WFS_URL}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ADMINEXPRESS-COG.LATEST:departement&OUTPUTFORMAT=application%2Fgeo%2Bjson&SRSNAME=EPSG%3A4326&CQL_FILTER=code_insee%3D%2732%27`;

function isCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2
    && typeof value[0] === "number" && Number.isFinite(value[0])
    && typeof value[1] === "number" && Number.isFinite(value[1]);
}

function isBoundaryGeometry(value: unknown): value is BoundaryGeometry {
  if (typeof value !== "object" || value === null || !("type" in value) || !("coordinates" in value)) return false;
  if (value.type === "Polygon") return isPolygon(value.coordinates);
  if (value.type === "MultiPolygon") return Array.isArray(value.coordinates) && value.coordinates.length > 0
    && value.coordinates.every((polygon) => isPolygon(polygon));
  return false;
}

function isPolygon(value: unknown): value is Ring[] {
  return Array.isArray(value) && value.length > 0
    && value.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isCoordinate));
}

function assertCollection(value: unknown): asserts value is GeoJsonCollection {
  if (typeof value !== "object" || value === null || !Array.isArray(value.features)) {
    throw new Error("IGN Admin Express response is not a GeoJSON FeatureCollection");
  }
}

function computeBbox(geometry: BoundaryGeometry): [number, number, number, number] {
  const values: number[] = [];
  const visit = (value: unknown): void => {
    if (isCoordinate(value)) { values.push(value[0], value[1]); return; }
    if (Array.isArray(value)) for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  if (values.length === 0) throw new Error("IGN Admin Express geometry has no coordinates");
  let west = values[0];
  let south = values[1];
  let east = values[0];
  let north = values[1];
  for (let index = 2; index < values.length; index += 2) {
    west = Math.min(west, values[index]);
    east = Math.max(east, values[index]);
    south = Math.min(south, values[index + 1]);
    north = Math.max(north, values[index + 1]);
  }
  return [west, south, east, north];
}

async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(INTERMEDIATE_DIR, { recursive: true });
  const response = await fetch(SOURCE_URL, { headers: { Accept: "application/geo+json,application/json" } });
  if (!response.ok) throw new Error(`Admin Express WFS failed: HTTP ${response.status} ${response.statusText}`);
  const payload: unknown = await response.json();
  assertCollection(payload);
  const feature = payload.features.find((candidate) => String(candidate.properties.code_insee) === GERS_TERRITORY.code);
  if (!feature || !isBoundaryGeometry(feature.geometry)) throw new Error("Admin Express did not return department 32 geometry");
  const rawJson = JSON.stringify({
    type: "FeatureCollection",
    crs: { type: "name", properties: { name: "EPSG:4326" } },
    features: [feature],
  }, null, 2) + "\n";
  const sha256 = createHash("sha256").update(rawJson).digest("hex");
  const timestamp = new Date().toISOString();
  const bbox = computeBbox(feature.geometry);
  await writeFile(path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile), rawJson, "utf8");
  await writeFile(path.join(INTERMEDIATE_DIR, GERS_TERRITORY.boundarySourceFile), JSON.stringify({
    territory: { code: GERS_TERRITORY.code, name: GERS_TERRITORY.name },
    source: "IGN ADMIN EXPRESS COG",
    resource: SOURCE_URL,
    edition: "LATEST",
    acquisitionTime: timestamp,
    license: "Licence Ouverte / Open Licence 2.0",
    crs: "EPSG:4326",
    sha256,
    recordCount: 1,
    geometryType: feature.geometry.type,
    bbox,
    rawFile: `data/raw/${GERS_TERRITORY.boundaryRawFile}`,
  }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, territory: GERS_TERRITORY.name, code: GERS_TERRITORY.code, edition: "LATEST", geometryType: feature.geometry.type, bbox, sha256, recordCount: 1 }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, source: "IGN ADMIN EXPRESS COG", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
