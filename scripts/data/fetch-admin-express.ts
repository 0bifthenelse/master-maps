#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GeometrySchema, type MultiPolygonGeometry, type PolygonGeometry } from "../../src/lib/data/schema";
import { acquireJson } from "./http-cache";
import { AUCH_DETAIL_SCOPE, GERS_TERRITORY } from "../../src/lib/data/territory";

type BoundaryGeometry = PolygonGeometry | MultiPolygonGeometry;
interface GeoJsonFeature { type: "Feature"; geometry: BoundaryGeometry; properties: Record<string, unknown> }
interface GeoJsonCollection { type: "FeatureCollection"; features: GeoJsonFeature[] }

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");
const SOURCE_URL = "https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ADMINEXPRESS-COG.LATEST:departement&OUTPUTFORMAT=application%2Fgeo%2Bjson&SRSNAME=EPSG%3A4326&CQL_FILTER=code_insee%3D%2732%27";

interface AdminExpressOptions {
  commune: string | null;
  forceRefresh: boolean;
}

function parseArgs(args: string[]): AdminExpressOptions {
  const index = args.indexOf("--commune");
  const commune = index < 0 ? null : args[index + 1];
  if (commune !== null && (commune === undefined || commune === "")) throw new Error("--commune requires an INSEE code argument");
  return { commune: commune ?? null, forceRefresh: args.includes("--force") };
}

function communeSourceUrl(commune: string): string {
  return `https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ADMINEXPRESS-COG.LATEST:commune&OUTPUTFORMAT=application%2Fgeo%2Bjson&SRSNAME=EPSG%3A4326&CQL_FILTER=code_insee%3D%27${encodeURIComponent(commune)}%27`;
}

function isBoundaryGeometry(value: unknown): value is BoundaryGeometry {
  const parsed = GeometrySchema.safeParse(value);
  return parsed.success && (parsed.data.type === "Polygon" || parsed.data.type === "MultiPolygon");
}

function assertCollection(value: unknown): asserts value is GeoJsonCollection {
  if (typeof value !== "object" || value === null) throw new Error("IGN Admin Express response is not a GeoJSON FeatureCollection");
  const candidate = value as { features?: unknown };
  if (!Array.isArray(candidate.features)) throw new Error("IGN Admin Express response is not a GeoJSON FeatureCollection");
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
async function main(options: AdminExpressOptions): Promise<void> {
  const commune = options.commune;
  const sourceUrl = commune === null ? SOURCE_URL : communeSourceUrl(commune);
  const code = commune === null ? GERS_TERRITORY.code : commune;
  const name = commune === null ? GERS_TERRITORY.name : AUCH_DETAIL_SCOPE.name;
  const boundaryRawFile = commune === null ? GERS_TERRITORY.boundaryRawFile : AUCH_DETAIL_SCOPE.boundaryRawFile;
  const boundarySourceFile = commune === null ? GERS_TERRITORY.boundarySourceFile : AUCH_DETAIL_SCOPE.boundarySourceFile;
  const missingGeometryMessage = commune === null
    ? "Admin Express did not return a valid department 32 geometry"
    : `Admin Express did not return a valid commune ${commune} geometry`;
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(INTERMEDIATE_DIR, { recursive: true });
  const acquisition = await acquireJson({ url: sourceUrl, forceRefresh: options.forceRefresh, maxBytes: 16 * 1024 * 1024, headers: { Accept: "application/geo+json,application/json" } });
  const payload: unknown = JSON.parse(acquisition.body);
  assertCollection(payload);
  const feature = payload.features.find((candidate) => String(candidate.properties.code_insee) === code);
  if (!feature || !isBoundaryGeometry(feature.geometry)) throw new Error(missingGeometryMessage);
  const parsedGeometry = GeometrySchema.parse(feature.geometry);
  if (!isBoundaryGeometry(parsedGeometry)) throw new Error(missingGeometryMessage);
  const geometry = parsedGeometry;
  const rawJson = JSON.stringify({ type: "FeatureCollection", crs: { type: "name", properties: { name: "EPSG:4326" } }, features: [{ ...feature, geometry }] }, null, 2) + "\n";
  const sha256 = createHash("sha256").update(rawJson).digest("hex");
  const acquisitionTime = new Date().toISOString();
  const bbox = computeBbox(geometry);
  await writeFile(path.join(RAW_DIR, boundaryRawFile), rawJson, "utf8");
  await writeFile(path.join(INTERMEDIATE_DIR, boundarySourceFile), JSON.stringify({ territory: { code, name }, source: "IGN ADMIN EXPRESS COG", resource: sourceUrl, edition: "LATEST", acquisitionTime, license: "Licence Ouverte / Open Licence 2.0", crs: "EPSG:4326", sha256, recordCount: 1, geometryType: geometry.type, bbox, rawFile: path.join(DATA_DIR, "raw", boundaryRawFile), fromCache: acquisition.fromCache, httpStatus: acquisition.httpStatus, bytesDownloaded: Buffer.byteLength(acquisition.body, "utf8"), requestCount: acquisition.requestCount, retryCount: acquisition.retryCount, rateLimitCount: acquisition.rateLimitCount }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, territory: name, code, edition: "LATEST", geometryType: geometry.type, bbox, sha256, recordCount: 1, fromCache: acquisition.fromCache, requestCount: acquisition.requestCount }, null, 2));
}

main(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, source: "IGN ADMIN EXPRESS COG", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
