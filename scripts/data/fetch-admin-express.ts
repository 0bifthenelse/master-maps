#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GeometrySchema, type MultiPolygonGeometry, type PolygonGeometry } from "../../src/lib/data/schema";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

type BoundaryGeometry = PolygonGeometry | MultiPolygonGeometry;
interface GeoJsonFeature { type: "Feature"; geometry: BoundaryGeometry; properties: Record<string, unknown> }
interface GeoJsonCollection { type: "FeatureCollection"; features: GeoJsonFeature[] }

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");
const SOURCE_URL = "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ADMINEXPRESS-COG.LATEST:departement&OUTPUTFORMAT=application%2Fgeo%2Bjson&SRSNAME=EPSG%3A4326&CQL_FILTER=code_insee%3D%2732%27";

function isBoundaryGeometry(value: unknown): value is BoundaryGeometry {
  const parsed = GeometrySchema.safeParse(value);
  return parsed.success && (parsed.data.type === "Polygon" || parsed.data.type === "MultiPolygon");
}

function assertCollection(value: unknown): asserts value is GeoJsonCollection {
  if (typeof value !== "object" || value === null || !Array.isArray(value.features)) throw new Error("IGN Admin Express response is not a GeoJSON FeatureCollection");
}

function computeBbox(geometry: BoundaryGeometry): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      west = Math.min(west, value[0]);
      south = Math.min(south, value[1]);
      east = Math.max(east, value[0]);
      north = Math.max(north, value[1]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  if (![west, south, east, north].every(Number.isFinite)) throw new Error("IGN Admin Express geometry has no finite coordinates");
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
  if (!feature || !isBoundaryGeometry(feature.geometry)) throw new Error("Admin Express did not return a valid department 32 geometry");
  const geometry = GeometrySchema.parse(feature.geometry);
  const rawJson = JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "EPSG:4326" } }, features: [{ ...feature, geometry }] }, null, 2) + "\n";
  const sha256 = createHash("sha256").update(rawJson).digest("hex");
  const acquisitionTime = new Date().toISOString();
  const bbox = computeBbox(geometry);
  await writeFile(path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile), rawJson, "utf8");
  await writeFile(path.join(INTERMEDIATE_DIR, GERS_TERRITORY.boundarySourceFile), JSON.stringify({ territory: { code: GERS_TERRITORY.code, name: GERS_TERRITORY.name }, source: "IGN ADMIN EXPRESS COG", resource: SOURCE_URL, edition: "LATEST", acquisitionTime, license: "Licence Ouverte / Open Licence 2.0", crs: "EPSG:4326", sha256, recordCount: 1, geometryType: geometry.type, bbox, rawFile: path.join(DATA_DIR, "raw", GERS_TERRITORY.boundaryRawFile) }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, territory: GERS_TERRITORY.name, code: GERS_TERRITORY.code, edition: "LATEST", geometryType: geometry.type, bbox, sha256, recordCount: 1 }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, source: "IGN ADMIN EXPRESS COG", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
