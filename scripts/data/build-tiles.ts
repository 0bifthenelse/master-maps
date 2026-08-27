#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MapFeatureSchema, TileManifestSchema, type Geometry, type MapFeature, type TileManifest } from "../../src/lib/data/schema";
import { clipLineStringToPolygon, clipPolygonToBounds, normalizePolygonGeometry, type PolygonGeometry } from "../../src/lib/geo/polygon";

interface TileOptions { inDir: string; outDir: string; forceSize?: number; benchmarkOnly: boolean }
export interface TileBuildResult { tileMap: Map<string, MapFeature[]>; manifest: TileManifest[] }
type Point = [number, number];
type Bounds = [number, number, number, number];

const LOD_LEVELS = [
  { level: 0 as const, size: 2048 },
  { level: 1 as const, size: 8192 },
  { level: 2 as const, size: 32768 },
] as const;
const LOD1_SIMPLIFY_TOLERANCE = 2;
const LOD2_SIMPLIFY_TOLERANCE = 25;
const DETAILED_TARGET_BYTES = 1024 * 1024;
const DETAILED_HARD_LIMIT_BYTES = 2 * 1024 * 1024;
const IGNORED_FILES = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);

function dataRoot(): string { return process.env.MASTER_MAPS_DATA_DIR ?? "data"; }

function parseArgs(args: string[]): TileOptions {
  const root = dataRoot();
  let inDir = path.join(root, "intermediate");
  let outDir = path.join(root, "generated", "tiles");
  let forceSize: number | undefined;
  let benchmarkOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--in-dir" && args[index + 1]) inDir = args[++index]!;
    else if (argument === "--out-dir" && args[index + 1]) outDir = args[++index]!;
    else if (argument === "--tile-size" && args[index + 1]) forceSize = Number(args[++index]);
    else if (argument === "--benchmark-only") benchmarkOnly = true;
  }
  return { inDir, outDir, forceSize, benchmarkOnly };
}

function geometryBounds(geometry: Geometry | undefined): Bounds | null {
  if (!geometry) return null;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      minX = Math.min(minX, value[0]);
      minZ = Math.min(minZ, value[1]);
      maxX = Math.max(maxX, value[0]);
      maxZ = Math.max(maxZ, value[1]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return Number.isFinite(minX) ? [minX, minZ, maxX, maxZ] : null;
}

function tileId(level: number, col: number, row: number): string { return `l${level}_${col}_${row}`; }
function tileBounds(size: number, col: number, row: number, originX: number, originZ: number): Bounds {
  return [originX + col * size, originZ + row * size, originX + (col + 1) * size, originZ + (row + 1) * size];
}
function intersects(first: Bounds, second: Bounds): boolean {
  return first[0] <= second[2] && first[2] >= second[0] && first[1] <= second[3] && first[3] >= second[1];
}
function expandedBounds(bounds: Bounds, amount: number): Bounds { return [bounds[0] - amount, bounds[1] - amount, bounds[2] + amount, bounds[3] + amount]; }

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

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const ratio = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + ratio * dx), point[1] - (start[1] + ratio * dz));
}

function simplifyLine(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [startIndex, endIndex] = pending.pop()!;
    let greatest = tolerance;
    let split = -1;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = pointToSegmentDistance(points[index]!, points[startIndex]!, points[endIndex]!);
      if (distance > greatest) { greatest = distance; split = index; }
    }
    if (split >= 0) {
      keep[split] = 1;
      pending.push([startIndex, split], [split, endIndex]);
    }
  }
  return points.filter((_point, index) => keep[index] === 1);
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
    const coordinates = geometry.coordinates.map((ring) => simplifyRing(ring, tolerance)).filter((ring): ring is Point[] => ring !== null);
    return coordinates.length > 0 ? normalizePolygonGeometry({ type: "Polygon", coordinates }) : null;
  }
  const polygons = geometry.coordinates.map((coordinates) => simplifyGeometry({ type: "Polygon", coordinates }, tolerance));
  const valid = polygons.filter((polygon): polygon is Extract<Geometry, { type: "Polygon" }> => polygon?.type === "Polygon").map((polygon) => polygon.coordinates);
  return valid.length > 0 ? normalizePolygonGeometry({ type: "MultiPolygon", coordinates: valid }) : null;
}

function polygonArea(polygon: Point[][]): number {
  const outer = polygon[0];
  if (!outer) return 0;
  const ringArea = (ring: Point[]): number => Math.abs(ring.reduce((sum, point, index) => {
    const next = ring[(index + 1) % ring.length]!;
    return sum + point[0] * next[1] - next[0] * point[1];
  }, 0)) / 2;
  return Math.max(0, ringArea(outer) - polygon.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0));
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
  const ranks: Record<string, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, residential: 5, unclassified: 6, service: 7, track: 8, path: 9, footway: 9 };
  return ranks[feature.kind === "road" ? feature.roadClass ?? feature.highway ?? "" : ""] ?? 10;
}

function keepAtLod(feature: MapFeature, lod: 0 | 1 | 2): boolean {
  if (lod === 0 || feature.kind === "boundary") return true;
  if (lod === 1) {
    if (feature.kind === "building") return featureArea(feature) >= 25 || feature.name !== undefined;
    if (feature.kind === "road") return roadRank(feature) <= 5 || feature.name !== undefined;
    if (feature.kind === "water") return feature.isSurface === true ? featureArea(feature) >= 100 : lineLength(feature.localGeometry ?? feature.geometry) >= 100;
    if (feature.kind === "poi" || feature.kind === "business") return feature.name !== undefined || feature.businessName !== undefined;
    if (feature.kind === "landuse") return featureArea(feature) >= 500 || feature.name !== undefined;
    return false;
  }
  if (feature.kind === "road") return roadRank(feature) <= 3 || feature.name !== undefined;
  if (feature.kind === "water") return feature.isSurface === true ? featureArea(feature) >= 1_000 : lineLength(feature.localGeometry ?? feature.geometry) >= 500;
  if (feature.kind === "poi") return ["city", "town", "village", "municipality", "townhall"].includes(feature.poiType) || feature.category === "townhall";
  if (feature.kind === "landuse") return feature.name !== undefined && featureArea(feature) >= 1_000;
  if (feature.kind === "building") return feature.name !== undefined;
  return false;
}

function generalizedFeature(feature: MapFeature, lod: 0 | 1 | 2): MapFeature | null {
  if (!keepAtLod(feature, lod)) return null;
  if (lod === 0 || !feature.localGeometry) return feature;
  const simplified = simplifyGeometry(feature.localGeometry, lod === 1 ? LOD1_SIMPLIFY_TOLERANCE : LOD2_SIMPLIFY_TOLERANCE);
  return simplified ? MapFeatureSchema.parse({ ...feature, localGeometry: simplified }) : null;
}

function clipGeometry(geometry: Geometry, bounds: Bounds, bleed: number): Geometry | null {
  if (geometry.type === "Point") return geometry.coordinates[0] >= bounds[0] && geometry.coordinates[0] <= bounds[2] && geometry.coordinates[1] >= bounds[1] && geometry.coordinates[1] <= bounds[3] ? geometry : null;
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const clip = expandedBounds(bounds, bleed);
    const rectangle: PolygonGeometry = { type: "Polygon", coordinates: [[[clip[0], clip[1]], [clip[2], clip[1]], [clip[2], clip[3]], [clip[0], clip[3]], [clip[0], clip[1]]]] };
    const lines = (geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates).flatMap((line) => clipLineStringToPolygon(line, rectangle));
    return lines.length === 0 ? null : lines.length === 1 ? { type: "LineString", coordinates: lines[0]! } : { type: "MultiLineString", coordinates: lines };
  }
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const clipped: Point[][][] = [];
  for (const coordinates of polygons) {
    const polygon = clipPolygonToBounds({ type: "Polygon", coordinates }, { minX: bounds[0], minY: bounds[1], maxX: bounds[2], maxY: bounds[3] });
    if (polygon) clipped.push(polygon.coordinates);
  }
  return clipped.length === 0 ? null : clipped.length === 1 ? { type: "Polygon", coordinates: clipped[0]! } : { type: "MultiPolygon", coordinates: clipped };
}

function featureFragment(feature: MapFeature, bounds: Bounds, tile: string, lod: 0 | 1 | 2): MapFeature | null {
  const geometry = feature.localGeometry ?? (feature.x !== undefined && feature.z !== undefined ? { type: "Point", coordinates: [feature.x, feature.z] as Point } : undefined);
  if (!geometry) return null;
  const featureBounds = geometryBounds(geometry);
  if (!featureBounds || !intersects(featureBounds, bounds)) return null;
  const bleed = lod === 0 && (feature.kind === "road" || feature.kind === "water") && (geometry.type === "LineString" || geometry.type === "MultiLineString") ? roadWidth(feature) / 2 + 1 : 0;
  const clipped = clipGeometry(geometry, bounds, bleed);
  if (!clipped) return null;
  const wasClipped = JSON.stringify(clipped) !== JSON.stringify(geometry);
  if (!wasClipped) return MapFeatureSchema.parse({ ...feature, fragmentId: `${feature.stableId}@${tile}` });
  return MapFeatureSchema.parse({ ...feature, localGeometry: clipped, parentStableId: feature.stableId, fragmentOf: feature.stableId, fragmentId: `${feature.stableId}@${tile}` });
}

function assignToTiles(features: MapFeature[], size: number, level: 0 | 1 | 2, originX: number, originZ: number): Map<string, MapFeature[]> {
  const tileMap = new Map<string, MapFeature[]>();
  for (const sourceFeature of features) {
    const feature = generalizedFeature(MapFeatureSchema.parse(sourceFeature), level);
    if (!feature) continue;
    const geometry = feature.localGeometry ?? (feature.x !== undefined && feature.z !== undefined ? { type: "Point", coordinates: [feature.x, feature.z] as Point } : undefined);
    const bounds = geometryBounds(geometry);
    if (!bounds) continue;
    const bleed = level === 0 && (feature.kind === "road" || feature.kind === "water") && (geometry?.type === "LineString" || geometry?.type === "MultiLineString") ? roadWidth(feature) / 2 + 1 : 0;
    const expanded = expandedBounds(bounds, bleed);
    const minCol = Math.floor((expanded[0] - originX) / size);
    const maxCol = Math.floor((expanded[2] - originX) / size);
    const minRow = Math.floor((expanded[1] - originZ) / size);
    const maxRow = Math.floor((expanded[3] - originZ) / size);
    for (let row = minRow; row <= maxRow; row += 1) for (let col = minCol; col <= maxCol; col += 1) {
      const id = tileId(level, col, row);
      const clipped = featureFragment(feature, tileBounds(size, col, row, originX, originZ), id, level);
      if (clipped) tileMap.set(id, [...(tileMap.get(id) ?? []), clipped]);
    }
  }
  return tileMap;
}

function manifestsForTileMap(tileMap: Map<string, MapFeature[]>, level: 0 | 1 | 2, size: number, originX: number, originZ: number): { manifests: TileManifest[]; sizes: number[] } {
  const manifests: TileManifest[] = [];
  const sizes: number[] = [];
  for (const [id, features] of tileMap) {
    const match = id.match(/^l\d+_(-?\d+)_(-?\d+)$/);
    if (!match) throw new Error(`Invalid generated tile ID ${id}`);
    const payload = JSON.stringify(features);
    const byteSize = Buffer.byteLength(payload);
    sizes.push(byteSize);
    manifests.push(TileManifestSchema.parse({ tileId: id, lod: level, bounds: tileBounds(size, Number(match[1]), Number(match[2]), originX, originZ), featureCount: features.length, byteSize, features: features.map((feature) => feature.stableId), fragmentIds: features.map((feature) => feature.fragmentId ?? feature.stableId) }));
  }
  return { manifests, sizes };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))]!;
}

export async function buildTiles(features: MapFeature[], tileSize: number, originX = 0, originZ = 0): Promise<TileBuildResult> {
  const tileMap = assignToTiles(features, tileSize, 0, originX, originZ);
  return { tileMap, manifest: manifestsForTileMap(tileMap, 0, tileSize, originX, originZ).manifests };
}

interface TileAccumulator {
  tileId: string;
  bounds: Bounds;
  featureCount: number;
  byteSize: number;
  features: string[];
  fragmentIds: string[];
}
async function splitOversizedTile(accumulator: TileAccumulator, level: 0 | 1 | 2, size: number, originX: number, originZ: number, outDir: string): Promise<TileAccumulator[]> {
  if (size <= 1) {
    if (accumulator.byteSize > DETAILED_HARD_LIMIT_BYTES) throw new Error(`${accumulator.tileId} exceeds the hard limit at minimum subdivision`);
    return [accumulator];
  }
  const parsed = JSON.parse(await fs.readFile(path.join(outDir, `${accumulator.tileId}.json`), "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Generated tile ${accumulator.tileId} is not an array`);
  const features = parsed.map((value) => MapFeatureSchema.parse(value));
  const match = accumulator.tileId.match(new RegExp(`^l${level}_(-?\\d+)_(-?\\d+)`));
  if (!match) throw new Error(`Invalid generated tile ID ${accumulator.tileId}`);
  const childSize = size / 2;
  const baseSize = level === 0 ? 2048 : level === 1 ? 8192 : 32768;
  const splitLimit = level === 0 ? DETAILED_TARGET_BYTES : DETAILED_HARD_LIMIT_BYTES;
  const subdivision = Math.round(Math.log2(baseSize / size)) + 1;
  const childAccumulators: TileAccumulator[] = [];
  for (let rowOffset = 0; rowOffset < 2; rowOffset += 1) {
    for (let colOffset = 0; colOffset < 2; colOffset += 1) {
      const col = Number(match[1]) * 2 + colOffset;
      const row = Number(match[2]) * 2 + rowOffset;
      const childId = `${tileId(level, col, row)}_s${subdivision}_${rowOffset}_${colOffset}`;
      const childBounds = tileBounds(childSize, col, row, originX, originZ);
      const childFeatures = features.flatMap((feature) => {
        const fragment = featureFragment(feature, childBounds, childId, level);
        return fragment ? [fragment] : [];
      });
      if (childFeatures.length === 0) continue;
      const encoded = JSON.stringify(childFeatures);
      const child: TileAccumulator = {
        tileId: childId,
        bounds: childBounds,
        featureCount: childFeatures.length,
        byteSize: Buffer.byteLength(`${encoded}\n`),
        features: childFeatures.map((feature) => feature.stableId),
        fragmentIds: childFeatures.map((feature) => feature.fragmentId ?? feature.stableId),
      };
      await fs.writeFile(path.join(outDir, `${childId}.json`), `${encoded}\n`, "utf8");
      if (child.byteSize > splitLimit) {
        childAccumulators.push(...await splitOversizedTile(child, level, childSize, originX, originZ, outDir));
      } else {
        childAccumulators.push(child);
      }
    }
  }
  await fs.unlink(path.join(outDir, `${accumulator.tileId}.json`));
  return childAccumulators;
}

async function streamLevel(inDir: string, outDir: string, level: 0 | 1 | 2, size: number, originX: number, originZ: number): Promise<{ manifests: TileManifest[]; sizes: number[] }> {
  const accumulators = new Map<string, TileAccumulator>();
  const entries = (await fs.readdir(inDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !IGNORED_FILES.has(entry.name)).sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    const parsed = JSON.parse(await fs.readFile(path.join(inDir, entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      const feature = generalizedFeature(MapFeatureSchema.parse(value), level);
      if (!feature) continue;
      const geometry = feature.localGeometry ?? (feature.x !== undefined && feature.z !== undefined ? { type: "Point", coordinates: [feature.x, feature.z] as Point } : undefined);
      const geometryBox = geometryBounds(geometry);
      if (!geometryBox) continue;
      const bleed = level === 0 && (feature.kind === "road" || feature.kind === "water") && (geometry?.type === "LineString" || geometry?.type === "MultiLineString") ? roadWidth(feature) / 2 + 1 : 0;
      const expanded = expandedBounds(geometryBox, bleed);
      const minCol = Math.floor((expanded[0] - originX) / size);
      const maxCol = Math.floor((expanded[2] - originX) / size);
      const minRow = Math.floor((expanded[1] - originZ) / size);
      const maxRow = Math.floor((expanded[3] - originZ) / size);
      for (let row = minRow; row <= maxRow; row += 1) for (let col = minCol; col <= maxCol; col += 1) {
        const id = tileId(level, col, row);
        const fragment = featureFragment(feature, tileBounds(size, col, row, originX, originZ), id, level);
        if (!fragment) continue;
        const encoded = JSON.stringify(fragment);
        const separator = accumulators.has(id) && accumulators.get(id)!.featureCount > 0 ? ",\n" : "";
        const tilePath = path.join(outDir, `${id}.json`);
        let accumulator = accumulators.get(id);
        if (!accumulator) {
          accumulator = { tileId: id, bounds: tileBounds(size, col, row, originX, originZ), featureCount: 0, byteSize: 1, features: [], fragmentIds: [] };
          accumulators.set(id, accumulator);
          await fs.writeFile(tilePath, "[", "utf8");
        }
        await fs.appendFile(tilePath, `${separator}${encoded}`, "utf8");
        accumulator.featureCount += 1;
        accumulator.byteSize += Buffer.byteLength(`${separator}${encoded}`);
        accumulator.features.push(fragment.stableId);
        accumulator.fragmentIds.push(fragment.fragmentId ?? fragment.stableId);
      }
    }
  }
  const manifests: TileManifest[] = [];
  const sizes: number[] = [];
  for (const accumulator of [...accumulators.values()].sort((first, second) => first.tileId.localeCompare(second.tileId))) {
    await fs.appendFile(path.join(outDir, `${accumulator.tileId}.json`), "\n]\n", "utf8");
    accumulator.byteSize += Buffer.byteLength("\n]\n");
    const splitLimit = level === 0 ? DETAILED_TARGET_BYTES : DETAILED_HARD_LIMIT_BYTES;
    const finalAccumulators = accumulator.byteSize > splitLimit
      ? await splitOversizedTile(accumulator, level, size, originX, originZ, outDir)
      : [accumulator];
    for (const finalAccumulator of finalAccumulators) {
      if (finalAccumulator.byteSize > DETAILED_HARD_LIMIT_BYTES) throw new Error(`${finalAccumulator.tileId} exceeds ${DETAILED_HARD_LIMIT_BYTES} bytes`);
      sizes.push(finalAccumulator.byteSize);
      manifests.push(TileManifestSchema.parse({ ...finalAccumulator, lod: level }));
    }
  }
  return { manifests, sizes };
}

async function boundaryBounds(inDir: string): Promise<Bounds> {
  const parsed = JSON.parse(await fs.readFile(path.join(inDir, "boundary.json"), "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("boundary.json is not an array");
  const boundary = parsed.map((value) => MapFeatureSchema.parse(value)).find((feature) => feature.kind === "boundary");
  const bounds = geometryBounds(boundary?.localGeometry);
  if (!bounds) throw new Error("Boundary feature has no local geometry bounds");
  return bounds;
}

export async function buildTilesAll(inDir?: string, outDir?: string, forceSize?: number): Promise<void> {
  const root = dataRoot();
  const sourceDir = inDir ?? path.join(root, "intermediate");
  const outputDir = outDir ?? path.join(root, "generated", "tiles");
  await fs.mkdir(outputDir, { recursive: true });
  const bounds = await boundaryBounds(sourceDir);
  for (const entry of await fs.readdir(outputDir, { withFileTypes: true })) if (entry.isFile() && entry.name.endsWith(".json")) await fs.unlink(path.join(outputDir, entry.name));
  const originX = Math.floor(bounds[0] / 2048) * 2048;
  const originZ = Math.floor(bounds[1] / 2048) * 2048;
  const levels = forceSize ? [{ level: 0 as const, size: forceSize }] : LOD_LEVELS;
  const allManifests: TileManifest[] = [];
  const metrics: TileMetric[] = [];
  for (const level of levels) {
    const result = await streamLevel(sourceDir, outputDir, level.level, level.size, originX, originZ);
    allManifests.push(...result.manifests);
    const maxBytes = result.sizes.length > 0 ? Math.max(...result.sizes) : 0;
    metrics.push({ lod: level.level, tileCount: result.sizes.length, totalBytes: result.sizes.reduce((sum, bytes) => sum + bytes, 0), maxBytes, medianBytes: percentile(result.sizes, 0.5), p95Bytes: percentile(result.sizes, 0.95) });
    console.error(`[tiles] LOD ${level.level}: ${result.sizes.length} tiles, max ${(maxBytes / 1024).toFixed(1)} KiB, median ${(percentile(result.sizes, 0.5) / 1024).toFixed(1)} KiB, p95 ${(percentile(result.sizes, 0.95) / 1024).toFixed(1)} KiB`);
  }
  await fs.writeFile(path.join(outputDir, "..", "tile-manifest.json"), JSON.stringify(allManifests.map((manifest) => TileManifestSchema.parse(manifest)), null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(outputDir, "..", "tile-metrics.json"), JSON.stringify({ detailedTargetBytes: DETAILED_TARGET_BYTES, detailedHardLimitBytes: DETAILED_HARD_LIMIT_BYTES, levels: metrics }, null, 2) + "\n", "utf8");
}

if (process.argv[1]?.endsWith("build-tiles.ts")) {
  const options = parseArgs(process.argv.slice(2));
  if (options.benchmarkOnly) console.log(JSON.stringify({ levels: LOD_LEVELS, detailedTargetBytes: DETAILED_TARGET_BYTES, detailedHardLimitBytes: DETAILED_HARD_LIMIT_BYTES }));
  else buildTilesAll(options.inDir, options.outDir, options.forceSize).catch((error: unknown) => {
    console.error(`[tiles] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
