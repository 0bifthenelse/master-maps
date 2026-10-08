#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { availableParallelism } from "node:os";
import { createInterface } from "node:readline";
import * as path from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { FeatureBaseSchema, MapFeatureSchema, TileManifestSchema, type Bbox, type Geometry, type MapFeature, type TileManifest } from "../../src/lib/data/schema";
import { clipPolygonToBounds, ensureRingClosed, ringArea, ringWindingOrder } from "../../src/lib/geo/polygon";
import { simplifyLine } from "../../src/lib/geo/simplify";
import { buildRenderTile, RENDER_LAYER_BUDGET_BYTES } from "../../src/lib/render/buildRenderTile";
import { encodeRenderTile } from "../../src/lib/render/codec";

const gzipAsync = promisify(gzip);
const envNumber = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
const RENDER_GZIP_LEVEL = envNumber("MASTER_MAPS_TILE_GZIP_LEVEL", 9);
const META_GZIP_LEVEL = envNumber("MASTER_MAPS_TILE_META_GZIP_LEVEL", 6);
const ZLIB_CONCURRENCY = envNumber("MASTER_MAPS_TILE_ZLIB_CONCURRENCY", 4);
const AUDIT_EVERY = envNumber("MASTER_MAPS_TILE_AUDIT_SAMPLE", 64);
const ZOD_AUDIT_PER_TILE = envNumber("MASTER_MAPS_TILE_ZOD_AUDIT", 2);
const META_BYTES_PER_FEATURE_ESTIMATE = 1200;
const RENDER_HEADER_UPPER_BYTES = 8192;
const RENDER_BYTES_PER_GEOMETRY_POINT = 96;
const RENDER_BYTES_PER_FEATURE = 512;

interface TileOptions { inDir: string; outDir: string; renderOutDir: string; metaOutDir: string; datasetVersion: string; forceSize?: number; benchmarkOnly: boolean; emitJsonTiles: boolean; quiet: boolean }
export interface TileBuildResult { tileMap: Map<string, MapFeature[]>; manifest: TileManifest[] }
type Point = [number, number];
type Bounds = [number, number, number, number];
type TileIndexEntry = TileManifest;
interface RenderTileWrite { bytes: number; featureCount: number }
interface EmittedTile { tileId: string; slim: string; index: string; jsonBytes: number; renderBytes: number; metaBytes: number }
interface TileMetric {
  lod: number;
  tileCount: number;
  totalBytes: number;
  maxBytes: number;
  medianBytes: number;
  p95Bytes: number;
  renderTileBudgetBytes: number;
  maxRenderBytes: number;
  medianRenderBytes: number;
  p95RenderBytes: number;
  metaTileBudgetBytes: number;
  maxMetaBytes: number;
  medianMetaBytes: number;
  p95MetaBytes: number;
  totalMetaBytes: number;
}

const LOD_LEVELS = [
  { level: 0 as const, size: 2048 },
  { level: 1 as const, size: 8192 },
  { level: 2 as const, size: 32768 },
] as const;
const LOD1_SIMPLIFY_TOLERANCE = 2;
const LOD2_SIMPLIFY_TOLERANCE = 25;
const DETAILED_TARGET_BYTES = 1024 * 1024;
const DETAILED_HARD_LIMIT_BYTES = 2 * 1024 * 1024;
const META_TILE_HARD_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_DATASET_VERSION = "0.1.0";
const BOUNDARY_TILE_ID = "boundary";
const IGNORED_FILES: ReadonlySet<string> = new Set([
  "provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json",
  "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json",
  "auch-boundary-source.json", "auch-osm-manifest.json", "osm-normalization.json",
]);
const GEOMETRY_TYPES: ReadonlySet<string> = new Set(["Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);
/* Field allow-lists come from the schemas themselves so the audit never drifts from them. */
const BASE_FEATURE_FIELDS: ReadonlySet<string> = new Set(["kind", ...Object.keys(FeatureBaseSchema.shape)]);
const KIND_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.fromEntries(MapFeatureSchema.options.map((option) => {
  const shape = option.shape as Record<string, unknown> & { kind: { value: string } };
  return [shape.kind.value, new Set(Object.keys(shape).filter((key) => !BASE_FEATURE_FIELDS.has(key) && key !== "kind"))];
}));

function parseFeatureRecords(text: string): MapFeature[] {
  const records: MapFeature[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (character === 92) escaped = true;
      else if (character === 34) inString = false;
      continue;
    }
    if (character === 34) inString = true;
    else if (character === 123) {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === 125) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        records.push(JSON.parse(text.slice(start, index + 1)) as MapFeature);
        start = -1;
      }
    }
  }
  if (depth !== 0 || start >= 0) throw new SyntaxError("unterminated JSON record in intermediate feature file");
  return records;
}

function dataRoot(): string { return process.env.MASTER_MAPS_DATA_DIR ?? "data"; }

function parseArgs(args: string[]): TileOptions {
  const root = dataRoot();
  let inDir = path.join(root, "intermediate");
  let outDir = path.join(root, "generated", "tiles");
  let renderOutDir = path.join(root, "generated", "render");
  let metaOutDir = path.join(root, "generated", "meta");
  let datasetVersion = DEFAULT_DATASET_VERSION;
  let forceSize: number | undefined;
  let benchmarkOnly = false;
  let emitJsonTiles = false;
  let quiet = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--in-dir" && args[index + 1]) inDir = args[++index]!;
    else if (argument === "--out-dir" && args[index + 1]) outDir = args[++index]!;
    else if (argument === "--render-out-dir" && args[index + 1]) renderOutDir = args[++index]!;
    else if (argument === "--meta-out-dir" && args[index + 1]) metaOutDir = args[++index]!;
    else if (argument === "--dataset-version" && args[index + 1]) datasetVersion = args[++index]!;
    else if (argument === "--tile-size" && args[index + 1]) forceSize = Number(args[++index]);
    else if (argument === "--emit-json-tiles") emitJsonTiles = true;
    else if (argument === "--quiet") quiet = true;
    else if (argument === "--benchmark-only") benchmarkOnly = true;
  }
  return { inDir, outDir, renderOutDir, metaOutDir, datasetVersion, forceSize, benchmarkOnly, emitJsonTiles, quiet };
}

function geometryBounds(geometry: Geometry, box: Bbox = [Infinity, Infinity, -Infinity, -Infinity]): Bbox {
  const stack: unknown[] = [geometry.coordinates];
  while (stack.length > 0) {
    const value = stack.pop();
    if (!Array.isArray(value)) continue;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      const x = value[0] as number;
      const z = value[1] as number;
      if (x < box[0]) box[0] = x;
      if (z < box[1]) box[1] = z;
      if (x > box[2]) box[2] = x;
      if (z > box[3]) box[3] = z;
      continue;
    }
    for (const child of value) stack.push(child);
  }
  return box;
}

function featureGeometry(feature: MapFeature): Geometry | undefined {
  if (feature.localGeometry) return feature.localGeometry;
  if (feature.x !== undefined && feature.z !== undefined) return { type: "Point", coordinates: [feature.x, feature.z] };
  return feature.geometry;
}

function geometryPointCount(geometry: Geometry): number {
  if (geometry.type === "Point") return 1;
  if (geometry.type === "LineString") return geometry.coordinates.length;
  if (geometry.type === "MultiLineString" || geometry.type === "Polygon") {
    let total = 0;
    for (const line of geometry.coordinates) total += line.length;
    return total;
  }
  let total = 0;
  for (const polygon of geometry.coordinates) for (const ring of polygon) total += ring.length;
  return total;
}

function tileId(level: number, col: number, row: number): string { return `l${level}_${col}_${row}`; }
function tileBounds(size: number, col: number, row: number, originX: number, originZ: number): Bounds {
  return [originX + col * size, originZ + row * size, originX + (col + 1) * size, originZ + (row + 1) * size];
}
function tileColumnRow(tile: string): { col: number; row: number } {
  const match = /^l\d+_(-?\d+)_(-?\d+)/.exec(tile);
  if (match === null) throw new Error(`Invalid generated tile ID ${tile}`);
  return { col: Number(match[1]), row: Number(match[2]) };
}
function subdivisionOf(level: 0 | 1 | 2, size: number): number {
  const base = level === 0 ? 2048 : level === 1 ? 8192 : 32768;
  return Math.round(Math.log2(base / size)) + 1;
}

function roadWidth(feature: MapFeature): number {
  if (feature.kind === "road" && feature.width !== undefined && feature.width > 0) return feature.width;
  if (feature.kind === "water" && feature.width !== undefined && feature.width > 0) return feature.width;
  if (feature.kind === "road") {
    const defaults: Record<string, number> = { motorway: 12, trunk: 9, primary: 8, secondary: 7, tertiary: 6, residential: 5, service: 3.5, track: 2.5, path: 2, footway: 2 };
    return defaults[feature.roadClass ?? feature.highway ?? ""] ?? 4;
  }
  if (feature.kind === "water") {
    const defaults: Record<string, number> = { river: 10, canal: 6, stream: 2, brook: 2, ditch: 1.5, drain: 1.5 };
    return defaults[feature.waterType ?? ""] ?? 3;
  }
  return 0;
}

function pointInRing(ring: Point[], x: number, z: number): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index]!;
    const prior = ring[previous]!;
    const cross = (z - prior[1]) * (current[0] - prior[0]) - (x - prior[0]) * (current[1] - prior[1]);
    if (Math.abs(cross) <= 1e-9
      && x >= Math.min(prior[0], current[0]) - 1e-9 && x <= Math.max(prior[0], current[0]) + 1e-9
      && z >= Math.min(prior[1], current[1]) - 1e-9 && z <= Math.max(prior[1], current[1]) + 1e-9) return true;
    if ((current[1] > z) !== (prior[1] > z)) {
      const crossing = prior[0] + ((z - prior[1]) * (current[0] - prior[0])) / (current[1] - prior[1]);
      if (x < crossing) inside = !inside;
    }
  }
  return inside;
}

function normalizeRings(rings: Point[][]): Point[][] | null {
  const exteriorInput = rings[0];
  if (exteriorInput === undefined || exteriorInput.length < 4) return null;
  const cleaned: Point[] = [];
  for (const point of exteriorInput) {
    const last = cleaned[cleaned.length - 1];
    if (last === undefined || Math.abs(last[0] - point[0]) > 1e-10 || Math.abs(last[1] - point[1]) > 1e-10) cleaned.push(point);
  }
  if (cleaned.length > 1) {
    const first = cleaned[0]!;
    const last = cleaned[cleaned.length - 1]!;
    if (Math.abs(first[0] - last[0]) <= 1e-10 && Math.abs(first[1] - last[1]) <= 1e-10) cleaned.pop();
  }
  const closedExterior = ensureRingClosed(cleaned) as Point[];
  if (closedExterior.length < 4 || Math.abs(ringArea(closedExterior)) <= 1e-10) return null;
  const normalized: Point[][] = [ringWindingOrder(closedExterior) === "cw" ? closedExterior.slice().reverse() : closedExterior];
  for (let index = 1; index < rings.length; index += 1) {
    const raw = rings[index]!;
    if (raw.length < 4) continue;
    const holeClean: Point[] = [];
    for (const point of raw) {
      const last = holeClean[holeClean.length - 1];
      if (last === undefined || Math.abs(last[0] - point[0]) > 1e-10 || Math.abs(last[1] - point[1]) > 1e-10) holeClean.push(point);
    }
    if (holeClean.length < 3) continue;
    if (holeClean.length > 1) {
      const first = holeClean[0]!;
      const last = holeClean[holeClean.length - 1]!;
      if (Math.abs(first[0] - last[0]) <= 1e-10 && Math.abs(first[1] - last[1]) <= 1e-10) holeClean.pop();
    }
    const closedHole = ensureRingClosed(holeClean) as Point[];
    if (closedHole.length < 4 || Math.abs(ringArea(closedHole)) <= 1e-10) continue;
    const oriented = ringWindingOrder(closedHole) === "ccw" ? closedHole.slice().reverse() : closedHole;
    if (pointInRing(normalized[0]!, oriented[0]![0], oriented[0]![1])) normalized.push(oriented);
  }
  return normalized;
}

function simplifyRing(ring: Point[], tolerance: number): Point[] | null {
  if (ring.length < 4) return null;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  const open = first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring.slice();
  if (open.length < 3) return null;
  const simplified = simplifyLine([...open, open[0]!], tolerance);
  if (simplified.length < 4) return null;
  const simplifiedFirst = simplified[0]!;
  const simplifiedLast = simplified[simplified.length - 1]!;
  if (simplifiedFirst[0] !== simplifiedLast[0] || simplifiedFirst[1] !== simplifiedLast[1]) simplified.push([simplifiedFirst[0], simplifiedFirst[1]]);
  return simplified.length >= 4 ? simplified : null;
}

function simplifyGeometry(geometry: Geometry, tolerance: number): Geometry | null {
  if (geometry.type === "Point") return geometry;
  if (geometry.type === "LineString") {
    const coordinates = simplifyLine(geometry.coordinates, tolerance);
    return coordinates.length >= 2 ? { type: "LineString", coordinates } : null;
  }
  if (geometry.type === "MultiLineString") {
    const coordinates = geometry.coordinates.map((line) => simplifyLine(line, tolerance)).filter((line) => line.length >= 2);
    return coordinates.length > 0 ? { type: "MultiLineString", coordinates } : null;
  }
  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates.map((ring) => simplifyRing(ring, tolerance)).filter((ring): ring is Point[] => ring !== null);
    if (rings.length === 0) return null;
    const normalized = normalizeRings(rings);
    return normalized === null ? null : { type: "Polygon", coordinates: normalized };
  }
  const polygons: Point[][][] = [];
  for (const coordinates of geometry.coordinates) {
    const rings = coordinates.map((ring) => simplifyRing(ring, tolerance)).filter((ring): ring is Point[] => ring !== null);
    if (rings.length === 0) continue;
    const normalized = normalizeRings(rings);
    if (normalized !== null) polygons.push(normalized);
  }
  if (polygons.length === 0) return null;
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };
}

function polygonArea(polygon: Point[][]): number {
  const outer = polygon[0];
  if (!outer) return 0;
  const ringAreaOf = (ring: Point[]): number => Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  return Math.max(0, ringAreaOf(outer) - polygon.slice(1).reduce((sum, ring) => sum + ringAreaOf(ring), 0));
}

function featureArea(feature: MapFeature): number {
  const geometry = feature.localGeometry;
  if (!geometry) return 0;
  if (geometry.type === "Polygon") return polygonArea(geometry.coordinates);
  if (geometry.type === "MultiPolygon") return geometry.coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  return 0;
}

function lineLength(geometry: Geometry): number {
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.type === "MultiLineString" ? geometry.coordinates : [];
  return lines.reduce((total, line) => total + line.reduce((sum, point, index) => index === 0 ? sum : sum + Math.hypot(point[0] - line[index - 1]![0], point[1] - line[index - 1]![1]), 0), 0);
}

function roadRank(feature: MapFeature): number {
  const ranks: Record<string, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, unclassified: 6, service: 7, track: 8, path: 9, footway: 9, cycleway: 9, steps: 9 };
  return ranks[feature.kind === "road" ? feature.roadClass ?? feature.highway ?? "" : ""] ?? 10;
}

/* LOD0 (2 km tiles, street level and closer) keeps everything. LOD1 (8 km
   tiles, town level) keeps the road network down to local roads, water,
   land cover and named places but only the largest buildings, which are
   sub-pixel at that scale anyway. LOD2 (32 km tiles, department overview)
   keeps the skeleton: main roads, rivers, forests, communes and towns. */
function keepAtLod(feature: MapFeature, lod: 0 | 1 | 2): boolean {
  if (lod === 0 || feature.kind === "boundary") return true;
  if (feature.kind === "place" && feature.placeType === "commune") return true;
  if (lod === 1) {
    if (feature.kind === "building") return featureArea(feature) >= 1_500;
    if (feature.kind === "road") return roadRank(feature) <= 7;
    if (feature.kind === "water") return feature.isSurface === true ? featureArea(feature) >= 400 : lineLength(feature.localGeometry ?? feature.geometry) >= 150;
    if (feature.kind === "poi" || feature.kind === "business") return feature.name !== undefined;
    if (feature.kind === "landuse") return featureArea(feature) >= 2_000;
    if (feature.kind === "transport") return feature.transportType !== "bus_stop" || feature.name !== undefined;
    if (feature.kind === "structure") return featureArea(feature) >= 1_000;
    if (feature.kind === "place") return (feature.importance ?? 6) <= 5;
    return false;
  }
  if (feature.kind === "road") return roadRank(feature) <= 4;
  if (feature.kind === "water") return feature.isSurface === true ? featureArea(feature) >= 20_000 : lineLength(feature.localGeometry ?? feature.geometry) >= 1_500 && (feature.name !== undefined || (feature.width ?? 0) >= 5);
  if (feature.kind === "landuse") return featureArea(feature) >= 150_000 && ["forest", "wood", "vineyard", "orchard", "reserve", "industrial", "residential"].includes(feature.landuseType);
  if (feature.kind === "place") return (feature.importance ?? 6) <= 3;
  if (feature.kind === "transport") return feature.transportType === "rail" || feature.transportType === "station" || feature.transportType === "aerodrome" || feature.transportType === "runway";
  return false;
}

function generalizedFeature(feature: MapFeature, lod: 0 | 1 | 2): MapFeature | null {
  if (!keepAtLod(feature, lod)) return null;
  if (lod === 0 || !feature.localGeometry) return feature;
  const simplified = simplifyGeometry(feature.localGeometry, lod === 1 ? LOD1_SIMPLIFY_TOLERANCE : LOD2_SIMPLIFY_TOLERANCE);
  return simplified === null ? null : ({ ...feature, localGeometry: simplified } as MapFeature);
}

function clipLineToBounds(line: Point[], bounds: Bounds, bleed: number): Point[][] {
  if (line.length < 2) return [];
  const minX = bounds[0] - bleed;
  const maxX = bounds[2] + bleed;
  const minZ = bounds[1] - bleed;
  const maxZ = bounds[3] + bleed;
  const output: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => {
    if (current.length >= 2) output.push(current);
    current = [];
  };
  const pushDistinct = (x: number, z: number): void => {
    const last = current[current.length - 1];
    if (last === undefined || last[0] !== x || last[1] !== z) current.push([x, z]);
  };
  for (let index = 1; index < line.length; index += 1) {
    const start = line[index - 1]!;
    const end = line[index]!;
    const directionX = end[0] - start[0];
    const directionZ = end[1] - start[1];
    let from = 0;
    let to = 1;
    if (directionX !== 0) {
      const first = (minX - start[0]) / directionX;
      const second = (maxX - start[0]) / directionX;
      from = Math.max(from, Math.min(first, second));
      to = Math.min(to, Math.max(first, second));
    }
    if (directionZ !== 0) {
      const first = (minZ - start[1]) / directionZ;
      const second = (maxZ - start[1]) / directionZ;
      from = Math.max(from, Math.min(first, second));
      to = Math.min(to, Math.max(first, second));
    }
    if (to - from <= 1e-10) continue;
    if (from > 0) pushDistinct(start[0] + directionX * from, start[1] + directionZ * from);
    else pushDistinct(start[0], start[1]);
    const leaveX = start[0] + directionX * to;
    const leaveZ = start[1] + directionZ * to;
    if (to < 1) {
      current.push([leaveX, leaveZ]);
      flush();
    } else {
      current.push(end);
    }
  }
  flush();
  return output;
}

function clipGeometry(geometry: Geometry, bounds: Bounds, bleed: number): Geometry | null {
  if (geometry.type === "Point") {
    const minX = bounds[0] - bleed;
    const maxX = bounds[2] + bleed;
    const minZ = bounds[1] - bleed;
    const maxZ = bounds[3] + bleed;
    const [x, z] = geometry.coordinates;
    return x >= minX && x <= maxX && z >= minZ && z <= maxZ ? geometry : null;
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const source = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    const lines: Point[][] = [];
    for (const line of source) for (const clipped of clipLineToBounds(line, bounds, bleed)) lines.push(clipped);
    if (lines.length === 0) return null;
    return lines.length === 1 ? { type: "LineString", coordinates: lines[0]! } : { type: "MultiLineString", coordinates: lines };
  }
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const clipped: Point[][][] = [];
  for (const coordinates of polygons) {
    const polygon = clipPolygonToBounds({ type: "Polygon", coordinates }, { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] });
    if (polygon !== null) clipped.push(polygon.coordinates);
  }
  if (clipped.length === 0) return null;
  return clipped.length === 1 ? { type: "Polygon", coordinates: clipped[0]! } : { type: "MultiPolygon", coordinates: clipped };
}

function featureFragment(feature: MapFeature, bounds: Bounds, tile: string, lod: 0 | 1 | 2, memo: Map<number, string>): MapFeature | null {
  const geometry = featureGeometry(feature);
  if (geometry === undefined) return null;
  const featureBounds = geometryBounds(geometry);
  if (featureBounds[0] > bounds[2] || featureBounds[2] < bounds[0] || featureBounds[1] > bounds[3] || featureBounds[3] < bounds[1]) return null;
  const bleed = lod === 0 && (feature.kind === "road" || feature.kind === "water") && (geometry.type === "LineString" || geometry.type === "MultiLineString") ? roadWidth(feature) / 2 + 1 : 0;
  const fragmentId = `${feature.stableId}@${tile}`;
  const contained = featureBounds[0] >= bounds[0] - bleed && featureBounds[2] <= bounds[2] + bleed
    && featureBounds[1] >= bounds[1] - bleed && featureBounds[3] <= bounds[3] + bleed;
  if (contained && geometry.type === "Point") return { ...feature, fragmentId } as MapFeature;
  if (contained && geometryPointCount(geometry) <= 2) return { ...feature, fragmentId } as MapFeature;
  const clipped = clipGeometry(geometry, bounds, bleed);
  if (clipped === null) return null;
  if (contained) {
    const identity = memo.get(0);
    if (identity !== undefined) return { ...feature, fragmentId: identity } as MapFeature;
  }
  let clippedJson: string | undefined;
  if (geometryPointCount(clipped) === geometryPointCount(geometry)) {
    const cached = memo.get(1);
    if (cached === undefined) {
      clippedJson = JSON.stringify(clipped);
      memo.set(1, clippedJson);
    } else clippedJson = cached;
  }
  const wasClipped = clippedJson === undefined ? JSON.stringify(clipped) !== JSON.stringify(geometry) : clippedJson !== JSON.stringify(geometry);
  return wasClipped
    ? ({ ...feature, localGeometry: clipped, parentStableId: feature.stableId, fragmentOf: feature.stableId, fragmentId } as MapFeature)
    : ({ ...feature, fragmentId } as MapFeature);
}

function assignToTiles(features: MapFeature[], size: number, level: 0 | 1 | 2, originX: number, originZ: number): Map<string, MapFeature[]> {
  const tileMap = new Map<string, MapFeature[]>();
  for (const sourceFeature of features) {
    const feature = generalizedFeature(sourceFeature, level);
    if (feature === null) continue;
    const geometry = featureGeometry(feature);
    if (geometry === undefined) continue;
    const bounds = geometryBounds(geometry);
    if (!Number.isFinite(bounds[0])) continue;
    const bleed = level === 0 && (feature.kind === "road" || feature.kind === "water") && (geometry.type === "LineString" || geometry.type === "MultiLineString") ? roadWidth(feature) / 2 + 1 : 0;
    const minCol = Math.floor((bounds[0] - bleed - originX) / size);
    const maxCol = Math.floor((bounds[2] + bleed - originX) / size);
    const minRow = Math.floor((bounds[1] - bleed - originZ) / size);
    const maxRow = Math.floor((bounds[3] + bleed - originZ) / size);
    const memo = new Map<number, string>();
    for (let row = minRow; row <= maxRow; row += 1) for (let col = minCol; col <= maxCol; col += 1) {
      const id = tileId(level, col, row);
      const fragment = featureFragment(feature, tileBounds(size, col, row, originX, originZ), id, level, memo);
      if (fragment === null) continue;
      const bucket = tileMap.get(id);
      if (bucket === undefined) tileMap.set(id, [fragment]);
      else bucket.push(fragment);
    }
  }
  return tileMap;
}

function manifestsForTileMap(tileMap: Map<string, MapFeature[]>, level: 0 | 1 | 2, size: number, originX: number, originZ: number): TileManifest[] {
  const manifests: TileManifest[] = [];
  for (const [id, features] of tileMap) {
    const { col, row } = tileColumnRow(id);
    const payload = JSON.stringify(features);
    manifests.push(TileManifestSchema.parse({
      tileId: id,
      lod: level,
      bounds: tileBounds(size, col, row, originX, originZ),
      featureCount: features.length,
      byteSize: Buffer.byteLength(payload),
      features: features.map((feature) => feature.stableId),
      fragmentIds: features.map((feature) => feature.fragmentId ?? feature.stableId),
    }));
  }
  return manifests;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

function stripGeometryFields(feature: MapFeature): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...feature };
  delete copy.geometry;
  delete copy.localGeometry;
  delete copy.sourceGeometry;
  return copy;
}

function structuralCheck(feature: MapFeature): string | undefined {
  if (typeof feature !== "object" || feature === null) return "record is not an object";
  const allowed = KIND_FIELDS[feature.kind];
  if (allowed === undefined) return `unknown kind ${JSON.stringify(feature.kind)}`;
  if (typeof feature.stableId !== "string" || feature.stableId.length === 0) return "missing stableId";
  for (const field of ["geometry", "localGeometry", "sourceGeometry"] as const) {
    const value = feature[field];
    if (value === undefined || value === null) continue;
    if (!GEOMETRY_TYPES.has(value.type)) return `unsupported ${field} type ${JSON.stringify(value.type)}`;
    if (geometryBounds(value)[0] === Infinity) return `${field} has no coordinates`;
  }
  for (const key of Object.keys(feature)) {
    if (BASE_FEATURE_FIELDS.has(key) || allowed.has(key)) continue;
    return `field ${key} does not belong to kind ${feature.kind}`;
  }
  return undefined;
}

function renderBudgetUpperBound(features: MapFeature[]): number {
  let points = 0;
  for (const feature of features) {
    if (feature.kind === "boundary" || (feature.kind === "water" && feature.fictiveAxis === true)) continue;
    const geometry = featureGeometry(feature);
    if (geometry !== undefined) points += geometryPointCount(geometry);
  }
  return RENDER_HEADER_UPPER_BYTES + points * RENDER_BYTES_PER_GEOMETRY_POINT + features.length * RENDER_BYTES_PER_FEATURE;
}

class GzipPool {
  private active = 0;
  private readonly waiting: Array<{ buffer: Buffer; resolve: (value: Buffer) => void; reject: (error: Error) => void }> = [];

  constructor(private readonly concurrency: number, private readonly level: number) {}

  compress(buffer: Buffer): Promise<Buffer> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return this.run(buffer);
    }
    return new Promise<Buffer>((resolve, reject) => { this.waiting.push({ buffer, resolve, reject }); });
  }

  private async run(buffer: Buffer): Promise<Buffer> {
    try {
      const compressed = await gzipAsync(buffer, { level: this.level });
      this.active -= 1;
      this.pump();
      return compressed;
    } catch (error) {
      this.active -= 1;
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const waiter of this.waiting.splice(0)) waiter.reject(failure);
      throw failure;
    }
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      this.active += 1;
      this.run(waiter.buffer).then(waiter.resolve, waiter.reject);
    }
  }
}

interface BuildContext {
  outDir: string;
  renderDir: string;
  metaDir: string;
  emitJsonTiles: boolean;
  datasetVersion: string;
  renderGzip: GzipPool;
  metaGzip: GzipPool;
  layerBytes: Map<string, number>;
  startedAt: number;
  boundaryRenderBytes: number;
  boundaryMetaBytes: number;
  cheapChecked: number;
  cheapFailures: number;
  zodChecked: number;
  zodFailures: number;
  auditFailures: string[];
}

interface LevelPass {
  context: BuildContext;
  open: Map<string, MapFeature[]>;
  featuresRead: number;
  tiles: string[];
  renderBytes: number[];
  metaBytes: number[];
  jsonBytes: number[];
}

class JsonArrayWriter {
  private handle: fs.FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private first = true;

  constructor(private readonly filePath: string) {}

  push(value: string): void {
    this.queue = this.queue.then(async () => {
      if (this.handle === undefined) {
        this.handle = await fs.open(this.filePath, "w");
        await this.handle.write("[");
      }
      await this.handle.write(this.first ? `\n${value}` : `,\n${value}`);
      this.first = false;
    });
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.handle === undefined) return;
    await this.handle.write(this.first ? "]\n" : "\n]\n");
    await this.handle.close();
    this.handle = undefined;
  }
}

async function mergeTileJsonArrays(target: string, parts: string[]): Promise<void> {
  const handle = await fs.open(target, "w");
  try {
    await handle.write("[");
    const lines: string[][] = [];
    for (const part of parts) {
      const text = await fs.readFile(part, "utf8");
      const values = text.split("\n").map((line) => line.trim().replace(/,$/, "")).filter((line) => line.startsWith("{"));
      lines.push(values);
    }
    const positions = new Array<number>(lines.length).fill(0);
    let written = 0;
    for (;;) {
      let bestPart = -1;
      for (let part = 0; part < lines.length; part += 1) {
        const candidate = lines[part]![positions[part]!];
        if (candidate === undefined) continue;
        if (bestPart < 0 || candidate < lines[bestPart]![positions[bestPart]!]!) bestPart = part;
      }
      if (bestPart < 0) break;
      const value = lines[bestPart]![positions[bestPart]!]!;
      positions[bestPart] += 1;
      await handle.write(written === 0 ? `\n${value}` : `,\n${value}`);
      written += 1;
    }
    await handle.write(written === 0 ? "]\n" : "\n]\n");
  } finally {
    await handle.close();
    for (const part of parts) await fs.rm(part, { force: true });
  }
}

async function writeRenderTile(context: BuildContext, features: MapFeature[], tile: string, lod: number, bounds: Bounds, includeBoundary: boolean): Promise<RenderTileWrite> {
  const input = buildRenderTile(features, { tileId: tile, lod, bounds, datasetVersion: context.datasetVersion, includeBoundary });
  const payload = Buffer.from(encodeRenderTile(input));
  const compressed = await context.renderGzip.compress(payload);
  await Promise.all([
    fs.writeFile(path.join(context.renderDir, `${tile}.mmt`), payload),
    fs.writeFile(path.join(context.renderDir, `${tile}.mmt.gz`), compressed),
  ]);
  for (const layer of input.layers) {
    const bytes = layer.vertices.byteLength + layer.indices.byteLength + layer.ranges.byteLength + (layer.edges?.byteLength ?? 0);
    context.layerBytes.set(layer.id, (context.layerBytes.get(layer.id) ?? 0) + bytes);
  }
  return { bytes: payload.byteLength, featureCount: input.meta.length };
}

async function writeMetaTile(context: BuildContext, metaJson: string, tile: string): Promise<number> {
  const compressed = await context.metaGzip.compress(Buffer.from(metaJson, "utf8"));
  await fs.writeFile(path.join(context.metaDir, `${tile}.json.gz`), compressed);
  return compressed.byteLength;
}

function zodAuditTile(context: BuildContext, tile: string, features: MapFeature[]): void {
  if (ZOD_AUDIT_PER_TILE <= 0 || features.length === 0) return;
  const step = Math.max(1, Math.floor(features.length / ZOD_AUDIT_PER_TILE));
  for (let index = 0; index < features.length; index += step) {
    context.zodChecked += 1;
    const result = MapFeatureSchema.safeParse(features[index]!);
    if (result.success) continue;
    context.zodFailures += 1;
    if (context.auditFailures.length < 20) context.auditFailures.push(`${tile} ${features[index]!.stableId}: ${result.error.issues[0]?.message ?? "invalid"}`);
  }
}

async function emitFinalTile(context: BuildContext, features: MapFeature[], tile: string, level: 0 | 1 | 2, size: number, col: number, row: number, originX: number, originZ: number, featuresJson: string, jsonBytes: number): Promise<EmittedTile> {
  const bounds = tileBounds(size, col, row, originX, originZ);
  if (jsonBytes > DETAILED_HARD_LIMIT_BYTES) throw new Error(`${tile} exceeds ${DETAILED_HARD_LIMIT_BYTES} bytes`);
  zodAuditTile(context, tile, features);
  const renderWrite = await writeRenderTile(context, features, tile, level, bounds, false);
  if (renderWrite.bytes > RENDER_LAYER_BUDGET_BYTES) throw new Error(`${tile} render tile exceeds ${RENDER_LAYER_BUDGET_BYTES} bytes`);
  const metaBytes = await writeMetaTile(context, JSON.stringify(features.map(stripGeometryFields)), tile);
  if (metaBytes > META_TILE_HARD_LIMIT_BYTES) throw new Error(`${tile} meta sidecar exceeds ${META_TILE_HARD_LIMIT_BYTES} bytes`);
  if (context.emitJsonTiles) await fs.writeFile(path.join(context.outDir, `${tile}.json`), `${featuresJson}\n`, "utf8");
  const base = { tileId: tile, lod: level, bounds, featureCount: features.length, byteSize: jsonBytes };
  const slim = JSON.stringify(TileManifestSchema.parse(base));
  const index = JSON.stringify(TileManifestSchema.parse({
    ...base,
    features: features.map((feature) => feature.stableId),
    fragmentIds: features.map((feature) => feature.fragmentId ?? feature.stableId),
  }));
  return { tileId: tile, slim, index, jsonBytes, renderBytes: renderWrite.bytes, metaBytes };
}

async function emitTile(context: BuildContext, features: MapFeature[], tile: string, level: 0 | 1 | 2, size: number, col: number, row: number, originX: number, originZ: number): Promise<EmittedTile[]> {
  const featuresJson = JSON.stringify(features);
  const jsonBytes = Buffer.byteLength(featuresJson);
  const splitLimit = level === 0 ? DETAILED_TARGET_BYTES : DETAILED_HARD_LIMIT_BYTES;
  const metaEstimate = features.length * META_BYTES_PER_FEATURE_ESTIMATE;
  let metaBytes = metaEstimate;
  if (metaEstimate > META_TILE_HARD_LIMIT_BYTES * 0.8) metaBytes = Buffer.byteLength(JSON.stringify(features.map(stripGeometryFields)));
  if (jsonBytes <= splitLimit && renderBudgetUpperBound(features) <= RENDER_LAYER_BUDGET_BYTES && metaBytes <= META_TILE_HARD_LIMIT_BYTES) {
    return [await emitFinalTile(context, features, tile, level, size, col, row, originX, originZ, featuresJson, jsonBytes)];
  }
  if (size <= 1) return [await emitFinalTile(context, features, tile, level, size, col, row, originX, originZ, featuresJson, jsonBytes)];
  const childSize = size / 2;
  const subdivision = subdivisionOf(level, size) + 1;
  const emissions: EmittedTile[] = [];
  for (let rowOffset = 0; rowOffset < 2; rowOffset += 1) {
    for (let colOffset = 0; colOffset < 2; colOffset += 1) {
      const childCol = col * 2 + colOffset;
      const childRow = row * 2 + rowOffset;
      const childId = `${tileId(level, childCol, childRow)}_s${subdivision}_${rowOffset}_${colOffset}`;
      const childBounds = tileBounds(childSize, childCol, childRow, originX, originZ);
      const memo = new Map<number, string>();
      const childFeatures: MapFeature[] = [];
      for (const feature of features) {
        const fragment = featureFragment(feature, childBounds, childId, level, memo);
        if (fragment !== null) childFeatures.push(fragment);
      }
      if (childFeatures.length === 0) continue;
      emissions.push(...await emitTile(context, childFeatures, childId, level, childSize, childCol, childRow, originX, originZ));
    }
  }
  if (emissions.length === 0 && features.length > 0) {
    return [await emitFinalTile(context, features, tile, level, size, col, row, originX, originZ, featuresJson, jsonBytes)];
  }
  return emissions;
}


async function streamLevel(context: BuildContext, files: string[], level: 0 | 1 | 2, size: number, originX: number, originZ: number, log: (message: string) => void, entries: Map<string, EmittedTile>): Promise<LevelPass> {
  const pass: LevelPass = {
    context,
    open: new Map(),
    featuresRead: 0,
    tiles: [],
    renderBytes: [],
    metaBytes: [],
    jsonBytes: [],
  };
  const open = pass.open;
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 }), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of lines) {
      for (const parsed of parseFeatureRecords(line)) {
        pass.featuresRead += 1;
        if (AUDIT_EVERY > 0 && pass.featuresRead % AUDIT_EVERY === 0) {
          context.cheapChecked += 1;
          const problem = structuralCheck(parsed);
          if (problem !== undefined) {
            context.cheapFailures += 1;
            if (context.auditFailures.length < 20) context.auditFailures.push(`${file}: ${problem}`);
          }
        }
        const feature = generalizedFeature(parsed, level);
        if (feature === null) continue;
        const geometry = featureGeometry(feature);
        if (geometry === undefined) continue;
        const bounds = geometryBounds(geometry);
        if (!Number.isFinite(bounds[0])) continue;
        const bleed = level === 0 && (feature.kind === "road" || feature.kind === "water") && (geometry.type === "LineString" || geometry.type === "MultiLineString") ? roadWidth(feature) / 2 + 1 : 0;
        const minCol = Math.floor((bounds[0] - bleed - originX) / size);
        const maxCol = Math.floor((bounds[2] + bleed - originX) / size);
        const minRow = Math.floor((bounds[1] - bleed - originZ) / size);
        const maxRow = Math.floor((bounds[3] + bleed - originZ) / size);
        const memo = new Map<number, string>();
        for (let row = minRow; row <= maxRow; row += 1) for (let col = minCol; col <= maxCol; col += 1) {
          const id = tileId(level, col, row);
          const fragment = featureFragment(feature, tileBounds(size, col, row, originX, originZ), id, level, memo);
          if (fragment === null) continue;
          const bucket = open.get(id);
          if (bucket === undefined) open.set(id, [fragment]);
          else bucket.push(fragment);
        }
      }
    }
    log(`[tiles] LOD ${level} ${file}: ${pass.featuresRead} features read, ${open.size} tiles buffered, rss ${(process.memoryUsage.rss() / 2 ** 20).toFixed(0)} MiB, elapsed ${((Date.now() - context.startedAt) / 1000).toFixed(0)}s`);
  }
  await flushOpenTiles(pass, level, size, originX, originZ, entries);
  return pass;
}

async function flushOpenTiles(pass: LevelPass, level: 0 | 1 | 2, size: number, originX: number, originZ: number, entries: Map<string, EmittedTile>): Promise<void> {
  if (pass.open.size === 0) return;
  const ids = [...pass.open.keys()].sort((first, second) => first.localeCompare(second));
  const context = pass.context;
  for (const tile of ids) {
    const features = pass.open.get(tile)!;
    const { col, row } = tileColumnRow(tile);
    for (const emission of await emitTile(context, features, tile, level, size, col, row, originX, originZ)) {
      entries.set(emission.tileId, emission);
      pass.tiles.push(emission.tileId);
      pass.renderBytes.push(emission.renderBytes);
      pass.metaBytes.push(emission.metaBytes);
      pass.jsonBytes.push(emission.jsonBytes);
    }
  }
  pass.open.clear();
}

export async function buildTiles(features: MapFeature[], tileSize: number, originX = 0, originZ = 0): Promise<TileBuildResult> {
  const tileMap = assignToTiles(features, tileSize, 0, originX, originZ);
  return { tileMap, manifest: manifestsForTileMap(tileMap, 0, tileSize, originX, originZ) };
}

export async function buildTilesAll(inDir?: string, outDir?: string, forceSize?: number, renderOutDir?: string, datasetVersion = DEFAULT_DATASET_VERSION, metaOutDir?: string, emitJsonTiles = false, options: { quiet?: boolean } = {}): Promise<void> {
  const root = dataRoot();
  const sourceDir = inDir ?? path.join(root, "intermediate");
  const outputDir = outDir ?? path.join(root, "generated", "tiles");
  const renderDir = renderOutDir ?? path.join(root, "generated", "render");
  const metaDir = metaOutDir ?? path.join(root, "generated", "meta");
  const generatedDir = path.join(outputDir, "..");
  const log = (message: string): void => { if (options.quiet !== true) console.error(message); };
  const startedAt = Date.now();
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(renderDir, { recursive: true });
  await fs.mkdir(metaDir, { recursive: true });
  const entries = (await fs.readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".json") && !IGNORED_FILES.has(entry.name))
    .map((entry) => entry.name)
    .sort((first, second) => first.localeCompare(second));
  const boundaryFile = entries.find((name) => name === "boundary.json") ?? entries.find((name) => name.startsWith("boundary"));
  if (boundaryFile === undefined) throw new Error("intermediate directory has no boundary file");
  const boundary = await readBoundaryFeature(path.join(sourceDir, boundaryFile));
  const boundaryGeometry = boundary.localGeometry ?? boundary.geometry;
  const boundaryBox = geometryBounds(boundaryGeometry);
  if (!Number.isFinite(boundaryBox[0])) throw new Error("Boundary feature has no local geometry bounds");
  const originX = Math.floor(boundaryBox[0] / 2048) * 2048;
  const originZ = Math.floor(boundaryBox[1] / 2048) * 2048;
  const context: BuildContext = {
    outDir: outputDir,
    renderDir,
    metaDir,
    emitJsonTiles,
    datasetVersion,
    renderGzip: new GzipPool(ZLIB_CONCURRENCY, RENDER_GZIP_LEVEL),
    metaGzip: new GzipPool(ZLIB_CONCURRENCY, META_GZIP_LEVEL),
    layerBytes: new Map(),
    startedAt,
    boundaryRenderBytes: 0,
    boundaryMetaBytes: 0,
    cheapChecked: 0,
    cheapFailures: 0,
    zodChecked: 0,
    zodFailures: 0,
    auditFailures: [],
  };
  await clearDirectory(outputDir, [".json"]);
  await clearDirectory(renderDir, [".mmt", ".mmt.gz"]);
  await clearDirectory(metaDir, [".json.gz"]);
  const boundaryWrite = await writeRenderTile(context, [boundary], BOUNDARY_TILE_ID, 0, boundaryBox as Bounds, true);
  context.boundaryRenderBytes = boundaryWrite.bytes;
  context.boundaryMetaBytes = await writeMetaTile(context, JSON.stringify([stripGeometryFields(boundary)]), BOUNDARY_TILE_ID);
  if (context.boundaryMetaBytes > META_TILE_HARD_LIMIT_BYTES) throw new Error(`${BOUNDARY_TILE_ID} meta sidecar exceeds ${META_TILE_HARD_LIMIT_BYTES} bytes`);
  const levels = forceSize ? [{ level: 0 as const, size: forceSize }] : LOD_LEVELS;
  const featureFiles = entries.filter((name) => name !== boundaryFile);
  const slimParts: string[] = [];
  const indexParts: string[] = [];
  const metrics: TileMetric[] = [];
  for (const level of levels) {
    const started = Date.now();
    const entriesByTile = new Map<string, EmittedTile>();
    const result = await streamLevel(context, featureFiles.map((name) => path.join(sourceDir, name)), level.level, level.size, originX, originZ, log, entriesByTile);
    const slimPath = path.join(generatedDir, `tile-manifest.lod${level.level}.json`);
    const indexPath = path.join(generatedDir, `tile-index.lod${level.level}.json`);
    const slimWriter = new JsonArrayWriter(slimPath);
    const indexWriter = new JsonArrayWriter(indexPath);
    for (const tile of result.tiles) {
      const entry = entriesByTile.get(tile)!;
      slimWriter.push(entry.slim);
      indexWriter.push(entry.index);
    }
    await slimWriter.close();
    await indexWriter.close();
    slimParts.push(slimPath);
    indexParts.push(indexPath);
    const metric: TileMetric = {
      lod: level.level,
      tileCount: result.tiles.length,
      totalBytes: sum(result.jsonBytes),
      maxBytes: maxOf(result.jsonBytes),
      medianBytes: percentile(result.jsonBytes, 0.5),
      p95Bytes: percentile(result.jsonBytes, 0.95),
      renderTileBudgetBytes: RENDER_LAYER_BUDGET_BYTES,
      maxRenderBytes: maxOf(result.renderBytes),
      medianRenderBytes: percentile(result.renderBytes, 0.5),
      p95RenderBytes: percentile(result.renderBytes, 0.95),
      metaTileBudgetBytes: META_TILE_HARD_LIMIT_BYTES,
      maxMetaBytes: maxOf(result.metaBytes),
      medianMetaBytes: percentile(result.metaBytes, 0.5),
      p95MetaBytes: percentile(result.metaBytes, 0.95),
      totalMetaBytes: sum(result.metaBytes),
    };
    metrics.push(metric);
    log(`[tiles] LOD ${level.level}: ${metric.tileCount} tiles, max ${(metric.maxBytes / 1024).toFixed(1)} KiB, median ${(metric.medianBytes / 1024).toFixed(1)} KiB, p95 ${(metric.p95Bytes / 1024).toFixed(1)} KiB, render max ${(metric.maxRenderBytes / 1024).toFixed(1)} KiB, meta max ${(metric.maxMetaBytes / 1024).toFixed(1)} KiB, meta total ${(metric.totalMetaBytes / 2 ** 20).toFixed(1)} MiB, json tiles ${emitJsonTiles ? "on" : "off"}, ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  await mergeTileJsonArrays(path.join(generatedDir, "tile-manifest.json"), slimParts);
  await mergeTileJsonArrays(path.join(generatedDir, "tile-index.json"), indexParts);
  await fs.writeFile(path.join(generatedDir, "tile-metrics.json"), `${JSON.stringify({
    detailedTargetBytes: DETAILED_TARGET_BYTES,
    detailedHardLimitBytes: DETAILED_HARD_LIMIT_BYTES,
    renderTileBudgetBytes: RENDER_LAYER_BUDGET_BYTES,
    metaTileHardLimitBytes: META_TILE_HARD_LIMIT_BYTES,
    datasetVersion,
    jsonTiles: emitJsonTiles,
    compression: { renderGzipLevel: RENDER_GZIP_LEVEL, metaGzipLevel: META_GZIP_LEVEL, zlibConcurrency: ZLIB_CONCURRENCY },
    validation: {
      structuralSampleEvery: AUDIT_EVERY,
      structuralChecked: context.cheapChecked,
      structuralFailures: context.cheapFailures,
      zodSamplePerTile: ZOD_AUDIT_PER_TILE,
      zodChecked: context.zodChecked,
      zodFailures: context.zodFailures,
      failures: context.auditFailures,
    },
    boundaryRenderTile: { tileId: BOUNDARY_TILE_ID, bytes: context.boundaryRenderBytes },
    boundaryMetaTile: { tileId: BOUNDARY_TILE_ID, bytes: context.boundaryMetaBytes },
    renderLayerBytes: Object.fromEntries([...context.layerBytes.entries()].sort(([first], [second]) => first.localeCompare(second))),
    levels: metrics,
  }, null, 2)}\n`, "utf8");
  log(`[tiles] total ${sum(metrics.map((metric) => metric.tileCount))} tiles, projected json ${(sum(metrics.map((metric) => metric.totalBytes)) / 2 ** 30).toFixed(2)} GiB, render ${(sum(metrics.map((metric) => metric.maxRenderBytes)) / 1024).toFixed(1)} KiB max, meta ${(sum(metrics.map((metric) => metric.totalMetaBytes)) / 2 ** 20).toFixed(1)} MiB, structural audit ${context.cheapChecked} checked / ${context.cheapFailures} failures, zod audit ${context.zodChecked} checked / ${context.zodFailures} failures, wall ${((Date.now() - startedAt) / 1000).toFixed(0)}s, peak rss ${(process.memoryUsage.rss() / 2 ** 20).toFixed(0)} MiB`);
  if (context.cheapFailures > 0 || context.zodFailures > 0) {
    throw new Error(`schema audit failed: ${context.cheapFailures} structural, ${context.zodFailures} zod (see data/generated/tile-metrics.json)`);
  }
}



function sum(values: number[]): number { let total = 0; for (const value of values) total += value; return total; }
function maxOf(values: number[]): number { let top = 0; for (const value of values) if (value > top) top = value; return top; }

async function clearDirectory(directory: string, suffixes: string[]): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!(entry.isFile() || entry.isSymbolicLink())) continue;
    if (suffixes.some((suffix) => entry.name.endsWith(suffix))) await fs.rm(path.join(directory, entry.name), { force: true });
  }
}

async function readBoundaryFeature(filePath: string): Promise<Extract<MapFeature, { kind: "boundary" }>> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${path.basename(filePath)} is not an array`);
  for (const value of parsed) {
    if (typeof value === "object" && value !== null && !Array.isArray(value) && (value as { kind?: unknown }).kind === "boundary") {
      return value as Extract<MapFeature, { kind: "boundary" }>;
    }
  }
  throw new Error(`${path.basename(filePath)} has no boundary feature`);
}

if (process.argv[1]?.endsWith("build-tiles.ts")) {
  const options = parseArgs(process.argv.slice(2));
  if (options.benchmarkOnly) {
    console.log(JSON.stringify({
      levels: LOD_LEVELS,
      detailedTargetBytes: DETAILED_TARGET_BYTES,
      detailedHardLimitBytes: DETAILED_HARD_LIMIT_BYTES,
      renderGzipLevel: RENDER_GZIP_LEVEL,
      metaGzipLevel: META_GZIP_LEVEL,
      zlibConcurrency: ZLIB_CONCURRENCY,
      zlibThreads: availableParallelism(),
      structuralSampleEvery: AUDIT_EVERY,
      zodSamplePerTile: ZOD_AUDIT_PER_TILE,
    }));
  } else {
    buildTilesAll(options.inDir, options.outDir, options.forceSize, options.renderOutDir, options.datasetVersion, options.metaOutDir, options.emitJsonTiles, { quiet: options.quiet }).catch((error: unknown) => {
      console.error(`[tiles] Fatal: ${error instanceof Error ? error.stack : String(error)}`);
      process.exitCode = 1;
    });
  }
}
