#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clipLineStringToPolygon, clipPolygonToPolygon, type PolygonGeometry } from "../../src/lib/geo/polygon";

interface MapFeature {
  kind: string;
  stableId: string;
  x: number;
  z: number;
  geometry?: Record<string, unknown>;
  localGeometry?: LocalGeometry;
  [key: string]: unknown;
}
type Point = [number, number];
type LocalGeometry =
  | { type: "Point"; coordinates: Point }
  | { type: "LineString"; coordinates: Point[] }
  | { type: "MultiLineString"; coordinates: Point[][] }
  | { type: "Polygon"; coordinates: Point[][] }
  | { type: "MultiPolygon"; coordinates: Point[][][] };
interface TileManifest {
  tileId: string;
  lod: number;
  bounds: [number, number, number, number];
  featureCount: number;
  byteSize: number;
  features: string[];
  fragmentOf?: string;
}
interface TileOptions { inDir: string; outDir: string; forceSize?: number; benchmarkOnly: boolean; }

const LOD_LEVELS = [
  { level: 0, size: 2048 },
  { level: 1, size: 8192 },
  { level: 2, size: 32768 },
] as const;

function dataRoot(): string { return process.env.MASTER_MAPS_DATA_DIR ?? "data"; }
function parseArgs(args: string[]): TileOptions {
  const root = dataRoot();
  let inDir = path.join(root, "intermediate");
  let outDir = path.join(root, "generated", "tiles");
  let forceSize: number | undefined;
  let benchmarkOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--in-dir" && args[index + 1]) inDir = args[++index];
    else if (argument === "--out-dir" && args[index + 1]) outDir = args[++index];
    else if (argument === "--tile-size" && args[index + 1]) forceSize = Number(args[++index]);
    else if (argument === "--benchmark-only") benchmarkOnly = true;
  }
  return { inDir, outDir, forceSize, benchmarkOnly };
}

function boundsOfGeometry(geometry: LocalGeometry | undefined): [number, number, number, number] | null {
  if (!geometry) return null;
  const values: Point[] = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      values.push([value[0], value[1]]);
      return;
    }
    for (const child of value) collect(child);
  };
  collect(geometry.coordinates);
  if (values.length === 0) return null;
  return [
    Math.min(...values.map((point) => point[0])),
    Math.min(...values.map((point) => point[1])),
    Math.max(...values.map((point) => point[0])),
    Math.max(...values.map((point) => point[1])),
  ];
}

function intersects(first: [number, number, number, number], second: [number, number, number, number]): boolean {
  return first[0] <= second[2] && first[2] >= second[0] && first[1] <= second[3] && first[3] >= second[1];
}
function tileId(level: number, col: number, row: number): string { return `l${level}_${col}_${row}`; }
function tileBounds(level: number, col: number, row: number, size: number, originX: number, originZ: number): [number, number, number, number] {
  return [originX + col * size, originZ + row * size, originX + (col + 1) * size, originZ + (row + 1) * size];
}

function clipGeometry(geometry: LocalGeometry, bounds: [number, number, number, number]): LocalGeometry | null {
  const rectangle: PolygonGeometry = {
    type: "Polygon",
    coordinates: [[
      [bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]], [bounds[0], bounds[1]],
    ]],
  };
  if (geometry.type === "Point") {
    return geometry.coordinates[0] >= bounds[0] && geometry.coordinates[0] <= bounds[2]
      && geometry.coordinates[1] >= bounds[1] && geometry.coordinates[1] <= bounds[3] ? geometry : null;
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    const clipped = lines.flatMap((line) => clipLineStringToPolygon(line, rectangle));
    if (clipped.length === 0) return null;
    return clipped.length === 1 ? { type: "LineString", coordinates: clipped[0] } : { type: "MultiLineString", coordinates: clipped };
  }
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const clipped = polygons.flatMap((polygon) => {
    const result = clipPolygonToPolygon({ type: "Polygon", coordinates: polygon }, rectangle);
    if (!result) return [];
    return result.type === "Polygon" ? [result.coordinates] : result.coordinates;
  });
  if (clipped.length === 0) return null;
  return clipped.length === 1 ? { type: "Polygon", coordinates: clipped[0] } : { type: "MultiPolygon", coordinates: clipped };
}

function featureFragment(
  feature: MapFeature,
  bounds: [number, number, number, number],
  sourceBounds: [number, number, number, number],
): MapFeature | null {
  const localGeometry = feature.localGeometry ?? { type: "Point", coordinates: [feature.x, feature.z] as Point };
  if (sourceBounds[0] >= bounds[0] && sourceBounds[1] >= bounds[1]
    && sourceBounds[2] <= bounds[2] && sourceBounds[3] <= bounds[3]) return feature;
  const clipped = clipGeometry(localGeometry, bounds);
  if (!clipped) return null;
  const fragment = { ...feature, localGeometry: clipped };
  const fragmentBounds = boundsOfGeometry(clipped);
  if (fragmentBounds && fragmentBounds[0] !== bounds[0] || fragmentBounds && fragmentBounds[1] !== bounds[1]
      || fragmentBounds && fragmentBounds[2] !== bounds[2] || fragmentBounds && fragmentBounds[3] !== bounds[3]) {
    fragment.parentStableId = feature.stableId;
  }
  return fragment;
}

function assignToTiles(features: MapFeature[], size: number, level: number, originX: number, originZ: number): Map<string, MapFeature[]> {
  const tileMap = new Map<string, MapFeature[]>();
  for (const feature of features) {
    const featureBounds = boundsOfGeometry(feature.localGeometry) ?? [feature.x, feature.z, feature.x, feature.z];
    const minCol = Math.floor((featureBounds[0] - originX) / size);
    const maxCol = Math.floor((featureBounds[2] - originX) / size);
    const minRow = Math.floor((featureBounds[1] - originZ) / size);
    const maxRow = Math.floor((featureBounds[3] - originZ) / size);
    for (let row = minRow; row <= maxRow; row += 1) {
      for (let col = minCol; col <= maxCol; col += 1) {
        const bounds = tileBounds(level, col, row, size, originX, originZ);
        const fragment = featureFragment(feature, bounds, featureBounds);
        if (!fragment) continue;
        const id = tileId(level, col, row);
        const list = tileMap.get(id) ?? [];
        list.push(fragment);
        tileMap.set(id, list);
      }
    }
  }
  return tileMap;
}

export async function buildTiles(features: MapFeature[], tileSize: number, originX = 0, originZ = 0): Promise<{ tileMap: Map<string, MapFeature[]>; manifest: TileManifest[] }> {
  const tileMap = assignToTiles(features, tileSize, 0, originX, originZ);
  const manifest: TileManifest[] = [];
  for (const [id, list] of tileMap) {
    const [, colText, rowText] = id.match(/^l0_(-?\d+)_(-?\d+)$/) ?? [];
    const col = Number(colText);
    const row = Number(rowText);
    manifest.push({ tileId: id, lod: 0, bounds: tileBounds(0, col, row, tileSize, originX, originZ), featureCount: list.length, byteSize: Buffer.byteLength(JSON.stringify(list)), features: list.map((feature) => feature.stableId) });
  }
  return { tileMap, manifest };
}

async function loadFeatures(inDir: string): Promise<MapFeature[]> {
  const features: MapFeature[] = [];
  const skipFiles = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json"]);
  for (const entry of await fs.readdir(inDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || skipFiles.has(entry.name)) continue;
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(inDir, entry.name), "utf8"));
    if (Array.isArray(parsed)) features.push(...parsed as MapFeature[]);
  }
  return features;
}

export async function buildTilesAll(inDir?: string, outDir?: string, forceSize?: number): Promise<void> {
  const root = dataRoot();
  const features = await loadFeatures(inDir ?? path.join(root, "intermediate"));
  if (features.length === 0) throw new Error("No normalized features found; refusing to write an empty tile set");
  const outputDir = outDir ?? path.join(root, "generated", "tiles");
  await fs.mkdir(outputDir, { recursive: true });
  for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      await fs.unlink(path.join(outputDir, entry.name));
    }
  }
  const boundary = features.find((feature) => feature.kind === "boundary");
  const boundaryBounds = boundsOfGeometry(boundary?.localGeometry);
  if (!boundaryBounds) throw new Error("Boundary feature has no local geometry bounds");
  const levels = forceSize ? [{ level: 0, size: forceSize }] : LOD_LEVELS;
  const originX = Math.floor(boundaryBounds[0] / 2048) * 2048;
  const originZ = Math.floor(boundaryBounds[1] / 2048) * 2048;
  const allManifest: TileManifest[] = [];
  for (const level of levels) {
    const tileMap = assignToTiles(features, level.size, level.level, originX, originZ);
    let largest = 0;
    for (const [id, list] of tileMap) {
      const payload = JSON.stringify(list);
      largest = Math.max(largest, Buffer.byteLength(payload));
      await fs.writeFile(path.join(outputDir, `${id}.json`), payload, "utf8");
      const match = id.match(/^l\d+_(-?\d+)_(-?\d+)$/);
      if (!match) throw new Error(`Invalid generated tile ID ${id}`);
      const bounds = tileBounds(level.level, Number(match[1]), Number(match[2]), level.size, originX, originZ);
      allManifest.push({ tileId: id, lod: level.level, bounds, featureCount: list.length, byteSize: Buffer.byteLength(payload), features: list.map((feature) => feature.stableId) });
    }
    console.error(`[tiles] LOD ${level.level}: ${tileMap.size} tiles, largest ${(largest / 1024).toFixed(1)} KiB`);
  }
  await fs.writeFile(path.join(outputDir, "..", "tile-manifest.json"), JSON.stringify(allManifest, null, 2) + "\n", "utf8");
}

if (process.argv[1]?.endsWith("build-tiles.ts")) {
  const options = parseArgs(process.argv.slice(2));
  if (options.benchmarkOnly) console.log(JSON.stringify({ levels: LOD_LEVELS }));
  else buildTilesAll(options.inDir, options.outDir, options.forceSize).catch((error: unknown) => {
    console.error(`[tiles] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
