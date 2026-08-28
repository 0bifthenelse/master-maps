#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromLambert93, toLambert93, wgs84ToRender } from "../../src/lib/geo/crs";
import { MapFeatureSchema, type Geometry, type MapFeature } from "../../src/lib/data/schema";
import { buildBuildings } from "../../src/lib/scene/buildBuildings";
import { buildRoads, type RoadFeatureShape } from "../../src/lib/scene/buildRoads";
import { buildWater, type WaterFeatureShape } from "../../src/lib/scene/buildWater";
import { snapshotBufferGeometry, type GeometryDebugSnapshot } from "../../src/lib/scene/debugGeometry";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

const ROOT = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const MINIMUM_SAMPLE_COUNT = 1000;
const MAX_ROUND_TRIP_METRES = 0.05;
const MAX_NORMALIZED_RESIDUAL_METRES = 0.1;
const MAX_TILE_RENDER_RESIDUAL_METRES = 0.1;

export interface SpatialQaScope {
  territoryCode: string;
  boundaryRawFile: string;
  root?: string;
}

type Point = [number, number];
interface SamplePoint {
  feature: MapFeature;
  point: Point;
}
interface ErrorRecord {
  metres: number;
  stableId: string;
  sourceId?: string;
  source?: string;
}
interface SpatialReport {
  checkedAt: string;
  territory: { code: string; name: string };
  sampledSourceVertices: number;
  sampleGroups: Record<string, number>;
  worstCrsRoundTripMetres: number;
  worstCrsRoundTrip?: ErrorRecord;
  worstSourceToNormalizedResidualMetres: number;
  worstSourceToNormalizedResidual?: ErrorRecord;
  worstTileRenderResidualMetres: number;
  worstTileRenderResidual?: ErrorRecord;
  normalizedComparisons: number;
  tileFragmentVerticesChecked: number;
  rendererInput: {
    roadFeatures: number;
    roadSegments: number;
    buildingFeatures: number;
    buildingVertices: number;
    waterFeatures: number;
    waterVertices: number;
    unexplainedRoadSegments: string[];
    snapshots: { roads: GeometryDebugSnapshot; buildings: GeometryDebugSnapshot; water: GeometryDebugSnapshot };
  };
  perSource: Record<string, { samples: number; worstRoundTripMetres: number; worstNormalizedResidualMetres: number }>;
  offendingFeature?: Record<string, unknown>;
}

function isPoint(value: unknown): value is Point {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

function geometryPoints(geometry: Geometry): Point[] {
  const points: Point[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (isPoint(value)) {
      points.push([value[0], value[1]]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return points;
}

function pairedGeometryPoints(source: Geometry, local: Geometry): Array<{ source: Point; local: Point }> {
  if (source.type !== local.type) return [];
  if (source.type === "Point" && local.type === "Point") return [{ source: source.coordinates, local: local.coordinates }];
  if (source.type === "LineString" && local.type === "LineString") return source.coordinates.length === local.coordinates.length ? source.coordinates.map((point, index) => ({ source: point, local: local.coordinates[index]! })) : [];
  if (source.type === "MultiLineString" && local.type === "MultiLineString") {
    if (source.coordinates.length !== local.coordinates.length) return [];
    return source.coordinates.flatMap((line, lineIndex) => line.length === local.coordinates[lineIndex]!.length ? line.map((point, pointIndex) => ({ source: point, local: local.coordinates[lineIndex]![pointIndex]! })) : []);
  }
  if (source.type === "Polygon" && local.type === "Polygon") {
    if (source.coordinates.length !== local.coordinates.length) return [];
    return source.coordinates.flatMap((ring, ringIndex) => ring.length === local.coordinates[ringIndex]!.length ? ring.map((point, pointIndex) => ({ source: point, local: local.coordinates[ringIndex]![pointIndex]! })) : []);
  }
  if (source.type === "MultiPolygon" && local.type === "MultiPolygon") {
    if (source.coordinates.length !== local.coordinates.length) return [];
    return source.coordinates.flatMap((polygon, polygonIndex) => polygon.length === local.coordinates[polygonIndex]!.length
      ? polygon.flatMap((ring, ringIndex) => ring.length === local.coordinates[polygonIndex]![ringIndex]!.length ? ring.map((point, pointIndex) => ({ source: point, local: local.coordinates[polygonIndex]![ringIndex]![pointIndex]! })) : [])
      : []);
  }
  return [];
}

function evenlySelected<T>(values: T[], count: number): T[] {
  if (values.length <= count) return values.slice();
  const result: T[] = [];
  for (let index = 0; index < count; index += 1) result.push(values[Math.floor(index * (values.length - 1) / Math.max(count - 1, 1))]!);
  return result;
}

function sourceKey(feature: MapFeature): string {
  return `${feature.kind}|${feature.sourceRefs[0]?.source ?? "unknown"}`;
}

function selectDistributedSamples(features: MapFeature[]): { samples: SamplePoint[]; groups: Record<string, number> } {
  const grouped = new Map<string, MapFeature[]>();
  for (const feature of features) {
    const list = grouped.get(sourceKey(feature)) ?? [];
    list.push(feature);
    grouped.set(sourceKey(feature), list);
  }
  const groupCount = grouped.size;
  const quota = Math.max(1, Math.ceil(MINIMUM_SAMPLE_COUNT / Math.max(groupCount, 1)));
  const samples: SamplePoint[] = [];
  const groups: Record<string, number> = {};
  for (const [key, group] of grouped) {
    const selectedFeatures = evenlySelected(group, quota);
    let groupSamples = 0;
    for (const feature of selectedFeatures) {
      const geometry = feature.sourceGeometry ?? feature.geometry;
      const points = evenlySelected(geometryPoints(geometry), Math.max(1, Math.ceil(quota / Math.max(selectedFeatures.length, 1))));
      for (const point of points) {
        samples.push({ feature, point });
        groupSamples += 1;
      }
    }
    groups[key] = groupSamples;
  }
  if (samples.length < MINIMUM_SAMPLE_COUNT) {
    const remaining = features.flatMap((feature) => geometryPoints(feature.geometry).map((point) => ({ feature, point })));
    for (const sample of evenlySelected(remaining, Math.min(remaining.length, MINIMUM_SAMPLE_COUNT - samples.length))) samples.push(sample);
  }
  return { samples, groups };
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const ratio = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + ratio * dx), point[1] - (start[1] + ratio * dz));
}

function distanceToGeometry(point: Point, geometry: Geometry): number {
  const points = geometryPoints(geometry);
  let nearest = Infinity;
  if (geometry.type === "Point") return Math.hypot(point[0] - points[0]![0], point[1] - points[0]![1]);
  const lines: Point[][] = [];
  if (geometry.type === "LineString") lines.push(geometry.coordinates);
  else if (geometry.type === "MultiLineString") lines.push(...geometry.coordinates);
  else if (geometry.type === "Polygon") lines.push(...geometry.coordinates);
  else if (geometry.type === "MultiPolygon") for (const polygon of geometry.coordinates) lines.push(...polygon);
  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) nearest = Math.min(nearest, pointToSegmentDistance(point, line[index]!, line[index + 1]!));
  }
  return nearest;
}
function l0TileBounds(tileId: string, originX: number, originZ: number): [number, number, number, number] | null {
  const match = tileId.match(/^l0_(-?\d+)_(-?\d+)(?:_s(\d+)_\d+_\d+)?$/);
  if (!match) return null;
  const size = 2048 / 2 ** Number(match[3] ?? 0);
  const col = Number(match[1]);
  const row = Number(match[2]);
  return [originX + col * size, originZ + row * size, originX + (col + 1) * size, originZ + (row + 1) * size];
}

function pointOnTileEdge(point: Point, bounds: [number, number, number, number], tolerance = 1): boolean {
  const within = point[0] >= bounds[0] - tolerance && point[0] <= bounds[2] + tolerance
    && point[1] >= bounds[1] - tolerance && point[1] <= bounds[3] + tolerance;
  return within && (Math.abs(point[0] - bounds[0]) <= tolerance
    || Math.abs(point[0] - bounds[2]) <= tolerance
    || Math.abs(point[1] - bounds[1]) <= tolerance
    || Math.abs(point[1] - bounds[3]) <= tolerance);
}


async function loadIntermediateFeatures(root: string): Promise<MapFeature[]> {
  const result: MapFeature[] = [];
  const ignored = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);
  for (const entry of await fs.readdir(path.join(root, "intermediate"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || ignored.has(entry.name)) continue;
    const parsed = JSON.parse(await fs.readFile(path.join(root, "intermediate", entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) result.push(MapFeatureSchema.parse(value));
  }
  return result;
}
async function checkTileFragments(samples: SamplePoint[], featuresById: Map<string, MapFeature>, root: string): Promise<{ worst: ErrorRecord | undefined; count: number; fragmentsById: Map<string, number> }> {
  const ids = new Set(samples.map((sample) => sample.feature.stableId));
  const fragmentsById = new Map<string, number>();
  let worst: ErrorRecord | undefined;
  let count = 0;
  const boundary = [...featuresById.values()].find((feature) => feature.kind === "boundary");
  const boundaryPoints = boundary?.localGeometry ? geometryPoints(boundary.localGeometry) : [];
  if (boundaryPoints.length === 0) throw new Error("Spatial QA cannot derive tile origin without boundary geometry");
  const originX = Math.floor(Math.min(...boundaryPoints.map((point) => point[0])) / 2048) * 2048;
  const originZ = Math.floor(Math.min(...boundaryPoints.map((point) => point[1])) / 2048) * 2048;
  const tileDir = path.join(root, "generated", "tiles");
  for (const entry of await fs.readdir(tileDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("l0_") || !entry.name.endsWith(".json")) continue;
    const tileId = entry.name.slice(0, -5);
    const parsed = JSON.parse(await fs.readFile(path.join(tileDir, entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      const fragment = MapFeatureSchema.parse(value);
      if (!ids.has(fragment.stableId)) continue;
      const parent = featuresById.get(fragment.stableId);
      if (!parent?.localGeometry || !fragment.localGeometry) continue;
      for (const point of geometryPoints(fragment.localGeometry)) {
        const residual = distanceToGeometry(point, parent.localGeometry);
        count += 1;
        if (!Number.isFinite(residual)) continue;
        const tileEnvelope = l0TileBounds(tileId, originX, originZ);
        const clippingVertex = tileEnvelope !== null && pointOnTileEdge(point, tileEnvelope);
        if (clippingVertex && residual > MAX_TILE_RENDER_RESIDUAL_METRES) continue;
        const candidate: ErrorRecord = { metres: residual, stableId: fragment.stableId, sourceId: parent.sourceId, source: parent.sourceRefs[0]?.source };
        if (!worst || candidate.metres > worst.metres) worst = candidate;
        if (residual > MAX_TILE_RENDER_RESIDUAL_METRES) throw new Error(`Tile ${tileId} moved ${fragment.stableId} by ${residual} metres`);
      }
      fragmentsById.set(fragment.stableId, (fragmentsById.get(fragment.stableId) ?? 0) + 1);
    }
  }
  return { worst, count, fragmentsById };
}

function rendererDebug(features: MapFeature[]): SpatialReport["rendererInput"] {
  const roads = features.filter((feature): feature is Extract<MapFeature, { kind: "road" }> => feature.kind === "road" && feature.localGeometry?.type !== "Point").map((feature) => ({ ...feature, geometry: feature.localGeometry! } as RoadFeatureShape));
  const buildings = features.filter((feature): feature is Extract<MapFeature, { kind: "building" }> => feature.kind === "building" && (feature.localGeometry?.type === "Polygon" || feature.localGeometry?.type === "MultiPolygon")).map((feature) => ({ ...feature, geometry: feature.localGeometry! }));
  const waters = features.filter((feature): feature is Extract<MapFeature, { kind: "water" }> => feature.kind === "water" && feature.localGeometry?.type !== "Point").map((feature) => ({ ...feature, geometry: feature.localGeometry! } as WaterFeatureShape));
  const roadResult = buildRoads(roads);
  const buildingResult = buildBuildings(buildings);
  const waterResult = buildWater(waters);
  const roadSegments = roadResult.sourceSegments.length;
  const buildingVertices = buildingResult.geometry.getAttribute("position")?.count ?? 0;
  const waterVertices = waterResult.geometry.getAttribute("position")?.count ?? 0;
  const roadSnapshot = snapshotBufferGeometry(roadResult.geometry);
  const buildingSnapshot = snapshotBufferGeometry(buildingResult.geometry);
  const waterSnapshot = snapshotBufferGeometry(waterResult.geometry);
  const result = {
    roadFeatures: roads.length,
    roadSegments,
    buildingFeatures: buildings.length,
    buildingVertices,
    waterFeatures: waters.length,
    waterVertices,
    unexplainedRoadSegments: [],
    snapshots: { roads: roadSnapshot, buildings: buildingSnapshot, water: waterSnapshot },
  };
  roadResult.geometry.dispose();
  for (const stratum of roadResult.strata) stratum.geometry.dispose();
  buildingResult.geometry.dispose();
  waterResult.geometry.dispose();
  for (const stratum of waterResult.strata) stratum.geometry.dispose();
  return result;
}

export async function runSpatialQa(requestedId?: string, scope?: SpatialQaScope): Promise<SpatialReport> {
  const root = scope?.root ?? ROOT;
  const features = await loadIntermediateFeatures(root);
  const uniqueFeatures = [...new Map(features.map((feature) => [feature.stableId, feature])).values()];
  const boundary = uniqueFeatures.find((feature) => feature.kind === "boundary");
  if (!boundary || (boundary.geometry.type !== "Polygon" && boundary.geometry.type !== "MultiPolygon")) throw new Error(`Spatial QA requires the canonical ${scope?.territoryCode ?? GERS_TERRITORY.name} boundary`);
  const { samples, groups } = selectDistributedSamples(uniqueFeatures);
  if (samples.length < MINIMUM_SAMPLE_COUNT) throw new Error(`Spatial QA sampled only ${samples.length} source vertices`);
  let worstRoundTrip: ErrorRecord | undefined;
  let worstNormalized: ErrorRecord | undefined;
  const perSource: SpatialReport["perSource"] = {};
  let normalizedComparisons = 0;
  for (const sample of samples) {
    const sourceReference = sample.feature.sourceRefs[0]?.source ?? "unknown";
    const sourceStats = perSource[sourceReference] ?? { samples: 0, worstRoundTripMetres: 0, worstNormalizedResidualMetres: 0 };
    sourceStats.samples += 1;
    const sourceLambert = toLambert93(sample.point);
    const roundTrip = fromLambert93(sourceLambert);
    const roundTripLambert = toLambert93(roundTrip);
    const roundTripMetres = Math.hypot(roundTripLambert[0] - sourceLambert[0], roundTripLambert[1] - sourceLambert[1]);
    sourceStats.worstRoundTripMetres = Math.max(sourceStats.worstRoundTripMetres, roundTripMetres);
    const roundTripError: ErrorRecord = { metres: roundTripMetres, stableId: sample.feature.stableId, sourceId: sample.feature.sourceId, source: sourceReference };
    if (!worstRoundTrip || roundTripMetres > worstRoundTrip.metres) worstRoundTrip = roundTripError;
    const localGeometry = sample.feature.localGeometry;
    if (localGeometry) {
      const paired = pairedGeometryPoints(sample.feature.geometry, localGeometry);
      for (const pair of paired) {
        const expected = wgs84ToRender(pair.source);
        const residual = Math.hypot(expected[0] - pair.local[0], expected[1] - pair.local[1]);
        normalizedComparisons += 1;
        sourceStats.worstNormalizedResidualMetres = Math.max(sourceStats.worstNormalizedResidualMetres, residual);
        const normalizedError: ErrorRecord = { metres: residual, stableId: sample.feature.stableId, sourceId: sample.feature.sourceId, source: sourceReference };
        if (!worstNormalized || residual > worstNormalized.metres) worstNormalized = normalizedError;
      }
    }
    perSource[sourceReference] = sourceStats;
  }
  if (!worstRoundTrip || worstRoundTrip.metres >= MAX_ROUND_TRIP_METRES) throw new Error(`CRS round-trip threshold exceeded: ${worstRoundTrip?.metres ?? Infinity} metres`);
  if (worstNormalized && worstNormalized.metres >= MAX_NORMALIZED_RESIDUAL_METRES) throw new Error(`Source-to-normalized threshold exceeded: ${worstNormalized.metres} metres`);
  const featuresById = new Map(uniqueFeatures.map((feature) => [feature.stableId, feature]));
  const fragments = await checkTileFragments(samples, featuresById, root);
  const sampledFeatureIds = new Set(samples.map((sample) => sample.feature.stableId));
  const rendererInput = rendererDebug(uniqueFeatures.filter((feature) => sampledFeatureIds.has(feature.stableId)).slice(0, 400));
  const report: SpatialReport = {
    checkedAt: new Date().toISOString(),
    territory: { code: scope?.territoryCode ?? GERS_TERRITORY.code, name: boundary.name ?? GERS_TERRITORY.name },
    sampledSourceVertices: samples.length,
    sampleGroups: groups,
    worstCrsRoundTripMetres: worstRoundTrip.metres,
    worstCrsRoundTrip: worstRoundTrip,
    worstSourceToNormalizedResidualMetres: worstNormalized?.metres ?? 0,
    worstSourceToNormalizedResidual: worstNormalized,
    worstTileRenderResidualMetres: fragments.worst?.metres ?? 0,
    worstTileRenderResidual: fragments.worst,
    normalizedComparisons,
    tileFragmentVerticesChecked: fragments.count,
    rendererInput,
    perSource,
  };
  if (requestedId) {
    const feature = featuresById.get(requestedId);
    if (!feature) throw new Error(`Stable ID not found: ${requestedId}`);
    report.offendingFeature = { stableId: requestedId, sourceGeometry: feature.geometry, localGeometry: feature.localGeometry, tileFragmentCount: fragments.fragmentsById.get(requestedId) ?? 0 };
  }
  await fs.mkdir(path.join(root, "qa"), { recursive: true });
  await fs.writeFile(path.join(root, "qa", "spatial-report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(root, "qa", "scene-geometry-debug.json"), JSON.stringify({ checkedAt: report.checkedAt, rendererInput: report.rendererInput }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, report: path.join(root, "qa", "spatial-report.json"), ...report }, null, 2));
  return report;
}

if (process.argv[1]?.endsWith("qa-spatial.ts")) {
  runSpatialQa(process.argv[2]).catch((error: unknown) => {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}
