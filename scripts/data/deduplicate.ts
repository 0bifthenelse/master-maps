#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { intersection } from "polygon-clipping";
import { MapFeatureSchema, type Geometry, type MapFeature, type ProvenanceRecord, type SourceReference } from "../../src/lib/data/schema";
import {
  createDropSink,
  createSourceAccounting,
  DROP_REASONS,
  STAGES,
  type DropSink,
  type SourceAccounting,
} from "./exclusion-report";
import { wgs84ToRender } from "../../src/lib/geo/crs";
import * as os from "node:os";
import { createReadStream } from "node:fs";
import readline from "node:readline";

const BUCKET_SIZE_METRES = 100;

const OUTPUT_CHUNK_SIZE = 20_000;
const SCAN_BAND_CELLS = 4;
export const DEDUP_REACH_CELLS = 2;
const TEMP_PREFIX = "master-maps-dedup-";
const LINE_MATCH_DISTANCE_METRES = 4;
const BUILDING_MIN_IOU = 0.35;
const WATER_MIN_IOU = 0.25;
const SOURCE_PRIORITY: Record<string, number> = {
  "IGN BD TOPO": 100,
  "IGN ADMIN EXPRESS COG": 100,
  "sirene": 80,
  "annuaire-entreprises": 75,
  "ban": 70,
  "osm-auch": 65,
  "osm": 60,
  "osm-bulk": 55,
  "pagesjaunes": 40,
};

type LocalPoint = [number, number];
type LocalLine = LocalPoint[];
type LocalPolygon = LocalLine[];

const SOURCE_LAYER_BY_KIND: Record<string, string> = {
  building: "batiment",
  road: "troncon_de_route",
  water: "troncon_hydrographique",
};

export interface DedupAccounting {
  sources: SourceAccounting;
  drops: DropSink;
}

export function createDedupAccounting(): DedupAccounting {
  return { sources: createSourceAccounting(), drops: createDropSink() };
}

function sourceKeyOf(feature: MapFeature): string {
  return feature.sourceRefs[0]?.source ?? "unknown";
}

function layerOf(feature: MapFeature): string {
  const layer = (feature.sourceMetadata as { layer?: unknown } | undefined)?.layer;
  return typeof layer === "string" ? layer : SOURCE_LAYER_BY_KIND[feature.kind] ?? "-";
}

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

interface DupOptions {
  inDir: string;
  outDir: string;
  memoryMode: boolean;
}

function parseArgs(args: string[]): DupOptions {
  const root = dataRoot();
  let inDir = path.join(root, "intermediate");
  let outDir = path.join(root, "intermediate");
  let memoryMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--in-dir" && args[index + 1]) inDir = args[++index]!;
    if (argument === "--out-dir" && args[index + 1]) outDir = args[++index]!;
    if (argument === "--memory") memoryMode = true;
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: tsx scripts/data/deduplicate.ts [--in-dir <path>] [--out-dir <path>] [--memory]");
      console.log("  default    bounded memory spatial scan, temp bands under os.tmpdir()");
      console.log("  --memory   legacy single pass in RAM, kept as the equivalence reference");
      process.exit(0);
    }
  }
  return { inDir, outDir, memoryMode };
}

function sourceName(feature: MapFeature): string {
  return feature.sourceRefs[0]?.source ?? "unknown";
}

function sourcePriority(feature: MapFeature): number {
  return SOURCE_PRIORITY[sourceName(feature)] ?? 50;
}

function hasUsableGeometry(feature: MapFeature): boolean {
  const geometry = feature.geometry;
  const hasFiniteCoordinate = (coordinate: readonly number[]): boolean =>
    coordinate.length >= 2 && Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]);
  const hasLine = (line: readonly (readonly number[])[]): boolean =>
    line.length >= 2 && line.every(hasFiniteCoordinate);
  const hasPolygon = (polygon: readonly (readonly (readonly number[])[])[]): boolean =>
    polygon.length >= 1 && polygon.every((ring) => ring.length >= 4 && ring.every(hasFiniteCoordinate));

  switch (geometry.type) {
    case "Point":
      return hasFiniteCoordinate(geometry.coordinates);
    case "LineString":
      return hasLine(geometry.coordinates);
    case "MultiLineString":
      return geometry.coordinates.length >= 1 && geometry.coordinates.every(hasLine);
    case "Polygon":
      return hasPolygon(geometry.coordinates);
    case "MultiPolygon":
      return geometry.coordinates.length >= 1 && geometry.coordinates.every(hasPolygon);
  }
  return false;
}

function geometryPriority(feature: MapFeature): number {
  if (["building", "road", "water"].includes(feature.kind) && sourceName(feature) === "osm-auch" && hasUsableGeometry(feature)) return 110;
  if (["building", "road", "water"].includes(feature.kind) && sourceName(feature) === "IGN BD TOPO") return 100;
  return sourcePriority(feature);
}

function normalized(value: string | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function coordinateOf(feature: MapFeature): LocalPoint | null {
  if (typeof feature.x === "number" && typeof feature.z === "number") return [feature.x, feature.z];
  if (typeof feature.lon === "number" && typeof feature.lat === "number") return wgs84ToRender([feature.lon, feature.lat]);
  return null;
}

function localGeometryOf(feature: MapFeature): Geometry | null {
  return feature.localGeometry ?? null;
}

function geometryBounds(feature: MapFeature): [number, number, number, number] | null {
  const geometry = localGeometryOf(feature);
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

function boundsOverlap(first: [number, number, number, number], second: [number, number, number, number]): boolean {
  return first[0] <= second[2] && first[2] >= second[0] && first[1] <= second[3] && first[3] >= second[1];
}

function ringArea(ring: LocalLine): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index]!;
    const second = ring[(index + 1) % ring.length]!;
    area += first[0] * second[1] - second[0] * first[1];
  }
  return area / 2;
}

function polygonArea(polygon: LocalPolygon): number {
  const outer = polygon[0];
  if (!outer) return 0;
  const holes = polygon.slice(1).reduce((sum, ring) => sum + Math.abs(ringArea(ring)), 0);
  return Math.max(0, Math.abs(ringArea(outer)) - holes);
}

function polygonsOf(feature: MapFeature): LocalPolygon[] {
  const geometry = localGeometryOf(feature);
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates as LocalPolygon];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as LocalPolygon[];
  return [];
}

function areaOf(feature: MapFeature): number {
  return polygonsOf(feature).reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}

function polygonIoU(first: MapFeature, second: MapFeature): number {
  const firstPolygons = polygonsOf(first);
  const secondPolygons = polygonsOf(second);
  if (firstPolygons.length === 0 || secondPolygons.length === 0) return 0;
  try {
    const firstGeometry = firstPolygons as [LocalLine[]];
    const secondGeometry = secondPolygons as [LocalLine[]];
    const intersectionPolygons = intersection(firstGeometry, secondGeometry);
    const intersectionArea = intersectionPolygons.reduce((sum, polygon) => sum + polygonArea(polygon as LocalPolygon), 0);
    const unionArea = areaOf(first) + areaOf(second) - intersectionArea;
    return unionArea > 0 ? intersectionArea / unionArea : 0;
  } catch {
    return 0;
  }
}

function lineComponents(feature: MapFeature): LocalLine[] {
  const geometry = localGeometryOf(feature);
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates as LocalLine];
  if (geometry.type === "MultiLineString") return geometry.coordinates as LocalLine[];
  return [];
}

function pointToSegmentDistance(point: LocalPoint, start: LocalPoint, end: LocalPoint): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const ratio = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + ratio * dx), point[1] - (start[1] + ratio * dz));
}

function sampleLines(lines: LocalLine[]): LocalPoint[] {
  const samples: LocalPoint[] = [];
  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      const start = line[index]!;
      const end = line[index + 1]!;
      samples.push(start, [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]);
    }
    const last = line[line.length - 1];
    if (last) samples.push(last);
  }
  return samples;
}

function nearestLineDistance(point: LocalPoint, lines: LocalLine[]): number {
  let nearest = Infinity;
  for (const line of lines) {
    for (let index = 0; index < line.length - 1; index += 1) {
      nearest = Math.min(nearest, pointToSegmentDistance(point, line[index]!, line[index + 1]!));
    }
  }
  return nearest;
}

function lineHausdorffDistance(first: MapFeature, second: MapFeature): number {
  const firstLines = lineComponents(first);
  const secondLines = lineComponents(second);
  if (firstLines.length === 0 || secondLines.length === 0) return Infinity;
  let maximum = 0;
  for (const point of sampleLines(firstLines)) maximum = Math.max(maximum, nearestLineDistance(point, secondLines));
  for (const point of sampleLines(secondLines)) maximum = Math.max(maximum, nearestLineDistance(point, firstLines));
  return maximum;
}

function addressEvidence(first: string | undefined, second: string | undefined): boolean {
  const a = normalized(first);
  const b = normalized(second);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const tokens = new Set(a.split(" ").filter((token) => token.length > 2));
  return b.split(" ").filter((token) => token.length > 2).some((token) => tokens.has(token));
}

function pointDistance(first: MapFeature, second: MapFeature): number {
  const a = coordinateOf(first);
  const b = coordinateOf(second);
  return a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity;
}

function semanticWaterMatch(first: MapFeature, second: MapFeature): boolean {
  const firstSurface = first.localGeometry?.type === "Polygon" || first.localGeometry?.type === "MultiPolygon";
  const secondSurface = second.localGeometry?.type === "Polygon" || second.localGeometry?.type === "MultiPolygon";
  if (firstSurface !== secondSurface) return false;
  const firstType = normalized(first.waterType);
  const secondType = normalized(second.waterType);
  return !firstType || !secondType || firstType === secondType || (firstType.includes("river") && secondType.includes("river"));
}

function compatibleRoadClass(first: MapFeature, second: MapFeature): boolean {
  const a = normalized(first.roadClass ?? first.highway);
  const b = normalized(second.roadClass ?? second.highway);
  return a !== "" && b !== "" && (a === b || (a === "track" && b === "path") || (a === "path" && b === "track"));
}

function canConflate(first: MapFeature, second: MapFeature): boolean {
  if (first.kind !== second.kind || first.kind === "boundary") return false;
  if (sourceName(first) === sourceName(second)) return false;
  if (first.kind === "business") {
    if (first.siret && second.siret) return first.siret === second.siret;
    return !first.siret
      && !second.siret
      && normalized(first.businessName) !== ""
      && normalized(first.businessName) === normalized(second.businessName)
      && addressEvidence(first.address, second.address)
      && pointDistance(first, second) <= 150;
  }
  if (first.kind === "address") {
    if (first.banId && second.banId) return first.banId === second.banId;
    return normalized(first.name) === normalized(second.name) && pointDistance(first, second) <= 15;
  }
  const firstBounds = geometryBounds(first);
  const secondBounds = geometryBounds(second);
  if (!firstBounds || !secondBounds || !boundsOverlap(firstBounds, secondBounds)) return false;
  if (first.kind === "building") {
    const distance = pointDistance(first, second);
    return polygonIoU(first, second) >= BUILDING_MIN_IOU && distance <= 20;
  }
  if (first.kind === "road") {
    const namesAgree = normalized(first.name) !== "" && normalized(first.name) === normalized(second.name);
    const canonicalPair = sourceName(first) === "IGN BD TOPO" || sourceName(second) === "IGN BD TOPO";
    if (!namesAgree && !compatibleRoadClass(first, second) && !canonicalPair) return false;
    return lineHausdorffDistance(first, second) <= LINE_MATCH_DISTANCE_METRES;
  }
  if (first.kind === "water") {
    if (!semanticWaterMatch(first, second)) return false;
    const firstSurface = first.localGeometry?.type === "Polygon" || first.localGeometry?.type === "MultiPolygon";
    if (firstSurface) return polygonIoU(first, second) >= WATER_MIN_IOU && pointDistance(first, second) <= 50;
    return lineHausdorffDistance(first, second) <= 10;
  }
  return false;
}

function appendUniqueReferences(group: MapFeature[]): SourceReference[] {
  const references: SourceReference[] = [];
  const seen = new Set<string>();
  for (const feature of group) {
    for (const reference of feature.sourceRefs) {
      const key = `${reference.source}|${reference.url ?? ""}|${reference.sha256 ?? ""}|${reference.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      references.push(reference);
    }
  }
  return references;
}

function mergeGroup(group: MapFeature[]): MapFeature {
  const ordered = [...group].sort((first, second) => geometryPriority(second) - geometryPriority(first));
  const winner = ordered[0]!;
  const merged: Record<string, unknown> = { ...winner };
  const provenance: ProvenanceRecord[] = group.flatMap((feature) => feature.provenance);
  const scalarFields = [
    "name", "address", "lon", "lat", "x", "z", "height", "heightInferred", "heightSource", "levels",
    "roadClass", "highway", "width", "widthInferred", "widthSource", "waterType", "fictiveAxis", "poiType",
    "buildingType", "roofType", "wallType", "landuseType", "transportType", "structureType", "placeType", "importance",
    "businessName", "legalName", "brand", "category", "nafCode", "nafLabel", "siret", "siren", "businessId",
    "website", "phone", "openingHours", "operator", "wheelchair", "administrativeStatus", "creationDate",
  ] as const;
  for (const field of scalarFields) {
    const contenders = group.flatMap((feature) => {
      const value = feature[field];
      return value === undefined || value === null || value === "" ? [] : [{ feature, value }];
    });
    if (contenders.length === 0) continue;
    const fieldWinner = [...contenders].sort((first, second) => sourcePriority(second.feature) - sourcePriority(first.feature))[0]!;
    merged[field] = fieldWinner.value;
    const values = new Set(contenders.map((contender) => JSON.stringify(contender.value)));
    if (values.size > 1) {
      provenance.push({
        featureId: winner.stableId,
        property: field,
        winner: `${sourceName(fieldWinner.feature)}=${JSON.stringify(fieldWinner.value)}`,
        contenders: contenders.map((contender) => `${sourceName(contender.feature)}=${JSON.stringify(contender.value)}`),
        priority: sourcePriority(fieldWinner.feature),
        timestamp: fieldWinner.feature.sourceRefs[0]?.timestamp ?? new Date().toISOString(),
      });
    }
  }
  const refs = appendUniqueReferences(group);
  const geometryWinner = ordered.find(hasUsableGeometry) ?? winner;
  merged.geometry = geometryWinner.geometry;
  merged.localGeometry = geometryWinner.localGeometry;
  merged.sourceGeometry = geometryWinner.sourceGeometry;
  if (geometryWinner.lon !== undefined) merged.lon = geometryWinner.lon;
  if (geometryWinner.lat !== undefined) merged.lat = geometryWinner.lat;
  if (geometryWinner.x !== undefined) merged.x = geometryWinner.x;
  if (geometryWinner.z !== undefined) merged.z = geometryWinner.z;
  provenance.push({
    featureId: winner.stableId,
    property: "geometry",
    winner: sourceName(geometryWinner),
    contenders: [...new Set(group.map(sourceName))],
    priority: geometryPriority(geometryWinner),
    timestamp: geometryWinner.sourceRefs[0]?.timestamp ?? new Date().toISOString(),
  });
  merged.sourceRefs = refs;
  merged.provenance = provenance;
  merged.confidence = group.length > 1 ? "medium" : winner.confidence;
  merged.status = group.length > 1 && pointDistance(winner, geometryWinner) > 5 ? "uncertain" : winner.status;
  return MapFeatureSchema.parse(merged);
}

function bucketKey(kind: string, x: number, z: number): string {
  return `${kind}:${Math.floor(x / BUCKET_SIZE_METRES)}:${Math.floor(z / BUCKET_SIZE_METRES)}`;
}

export function deduplicateFeatures(features: MapFeature[], accounting?: DedupAccounting): MapFeature[] {
  const groups: MapFeature[][] = [];
  const exact = new Map<string, number>();
  const buckets = new Map<string, number[]>();
  const inputByKey = new Map<string, number>();
  const acceptedByKey = new Map<string, number>();
  const mergedByKey = new Map<string, number>();
  const exactIdentities = new Map<string, Set<string>>();
  const count = (store: Map<string, number>, source: string, layer: string, kind: string, delta: number): void => {
    if (accounting === undefined || delta === 0) return;
    const key = `${source}::${layer}::${kind}`;
    store.set(key, (store.get(key) ?? 0) + delta);
  };
  for (const input of features) {
    const feature = MapFeatureSchema.parse(input);
    const source = sourceKeyOf(feature);
    const layer = layerOf(feature);
    count(inputByKey, source, layer, feature.kind, 1);
    let groupIndex = exact.get(feature.stableId);
    let exactIdentity = false;
    let metricConflation = false;
    const coordinateValue = coordinateOf(feature);
    if (groupIndex === undefined && coordinateValue) {
      const xBucket = Math.floor(coordinateValue[0] / BUCKET_SIZE_METRES);
      const zBucket = Math.floor(coordinateValue[1] / BUCKET_SIZE_METRES);
      for (let dx = -1; dx <= 1 && groupIndex === undefined; dx += 1) {
        for (let dz = -1; dz <= 1 && groupIndex === undefined; dz += 1) {
          const candidates = buckets.get(bucketKey(feature.kind, (xBucket + dx) * BUCKET_SIZE_METRES, (zBucket + dz) * BUCKET_SIZE_METRES)) ?? [];
          for (const candidateIndex of candidates) {
            const candidateGroup = groups[candidateIndex];
            if (candidateGroup?.some((candidate) => canConflate(candidate, feature))) {
              groupIndex = candidateIndex;
              metricConflation = !candidateGroup.some((candidate) => candidate.stableId === feature.stableId);
              break;
            }
          }
        }
      }
    }
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      groups.push([feature]);
      count(acceptedByKey, source, layer, feature.kind, 1);
    } else {
      groups[groupIndex]!.push(feature);
      count(mergedByKey, source, layer, feature.kind, 1);
      if (metricConflation) {
        accounting?.drops.drop(STAGES.deduplicate, DROP_REASONS.dedupMetricConflation, 1, `${feature.stableId} conflated into ${groups[groupIndex]![0]!.stableId}`);
      } else {
        exactIdentity = true;
        accounting?.drops.drop(STAGES.deduplicate, DROP_REASONS.dedupExactIdentity, 1, `${feature.stableId} repeats an identity already grouped`);
      }
    }
    if (exactIdentity) {
      const key = `${source}::${layer}::${feature.kind}`;
      const identities = exactIdentities.get(key) ?? new Set<string>();
      identities.add(feature.stableId);
      exactIdentities.set(key, identities);
    }
    exact.set(feature.stableId, groupIndex);
    if (coordinateValue) {
      const key = bucketKey(feature.kind, coordinateValue[0], coordinateValue[1]);
      const list = buckets.get(key) ?? [];
      if (!list.includes(groupIndex)) list.push(groupIndex);
      buckets.set(key, list);
    }
  }
  if (accounting !== undefined) {
    for (const [key, input] of inputByKey) {
      const [source = "unknown", layer = "-", kind = "unknown"] = key.split("::");
      const accepted = acceptedByKey.get(key) ?? 0;
      const merged = mergedByKey.get(key) ?? 0;
      const identical = exactIdentities.get(key)?.size ?? 0;
      const metric = Math.max(0, merged - identical);
      accounting.sources.record(source, layer, kind, input, accepted, { excludedCount: merged, excluded: DROP_REASONS.dedupExactIdentity, reason: "duplicate canonical identity collapsed into the group winner" });
      if (metric > 0) {
        accounting.sources.record(source, layer, kind, 0, 0, { excludedCount: metric, excluded: DROP_REASONS.dedupMetricConflation, reason: "metric conflation collapsed a second source record into the group winner" });
      }
      accounting.sources.recordMerged(source, layer, kind, merged);
    }
  }
  return groups.map(mergeGroup);
}

export const DEDUP_INPUT_SIDECARS = new Set([
  "provenance.json",
  "boundary-source.json",
  "auch-boundary-source.json",
  "bdtopo-manifest.json",
  "ign-unavailable.json",
  "osm-manifest.json",
  "auch-osm-manifest.json",
  "osm-bulk-manifest.json",
  "osm-normalization.json",
  "relation-issues.json",
  "normalization-issues.json",
]);

export const DEDUP_PRESERVED_SIDECARS = new Set([
  "boundary-source.json",
  "auch-boundary-source.json",
  "bdtopo-manifest.json",
  "ign-unavailable.json",
  "osm-manifest.json",
  "auch-osm-manifest.json",
  "osm-bulk-manifest.json",
  "osm-normalization.json",
  "relation-issues.json",
  "normalization-issues.json",
]);

export const DEDUP_TEMP_ROOT = process.env.MASTER_MAPS_DEDUP_TMP ?? os.tmpdir();

async function listFeatureFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || DEDUP_INPUT_SIDECARS.has(entry.name)) continue;
    names.push(entry.name);
  }
  return names.sort();
}

interface LiveGroup {
  features: MapFeature[];
  cells: Set<string>;
  retireRow: number;
}

export interface DedupStreamStats {
  input: number;
  groups: number;
  emitted: number;
  inputBytes: number;
  outputBytes: number;
  peakBands: number;
  widthCells: number;
  depthCells: number;
  bandCells: number;
}

function cellOf(feature: MapFeature): [number, number] | null {
  const coordinate = coordinateOf(feature);
  if (!coordinate) return null;
  return [Math.floor(coordinate[0] / BUCKET_SIZE_METRES), Math.floor(coordinate[1] / BUCKET_SIZE_METRES)];
}

function accountKey(source: string, layer: string, kind: string): string {
  return `${source}::${layer}::${kind}`;
}

function moveFile(from: string, to: string): Promise<void> {
  return fs.rename(from, to).catch(async (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.copyFile(from, to);
    await fs.unlink(from);
  });
}

class BandSpool {
  private readonly appenders = new Map<number, fs.FileHandle>();
  private readonly buffers = new Map<number, string>();

  constructor(private readonly dir: string, private readonly openLimit = 48) {}

  async append(band: number, payload: string): Promise<void> {
    const buffer = (this.buffers.get(band) ?? "") + payload;
    if (buffer.length >= 1 << 20) {
      await this.write(band, buffer);
      return;
    }
    this.buffers.set(band, buffer);
  }

  private async write(band: number, payload: string): Promise<void> {
    this.buffers.set(band, "");
    let handle = this.appenders.get(band);
    if (handle === undefined) {
      if (this.appenders.size >= this.openLimit) {
        const [oldest] = this.appenders.keys();
        const stale = oldest === undefined ? undefined : this.appenders.get(oldest);
        if (oldest !== undefined) this.appenders.delete(oldest);
        if (stale !== undefined) await stale.close();
      }
      handle = await fs.open(path.join(this.dir, `band-${band}.ndjson`), "a");
      this.appenders.set(band, handle);
    }
    await handle.write(payload);
  }

  async close(): Promise<void> {
    for (const [band, buffer] of [...this.buffers]) {
      if (buffer.length > 0) await this.write(band, buffer);
    }
    this.buffers.clear();
    for (const handle of this.appenders.values()) await handle.close();
    this.appenders.clear();
  }
}

class ChunkSink {
  private readonly open = new Map<string, { chunk: number; handle: fs.FileHandle }>();
  private readonly nextChunk = new Map<string, number>();

  constructor(private readonly dir: string) {}

  private async openChunk(kind: string): Promise<fs.FileHandle> {
    const chunk = this.nextChunk.get(kind) ?? 0;
    this.nextChunk.set(kind, chunk + 1);
    const previous = this.open.get(kind);
    if (previous !== undefined) {
      await previous.handle.write("\n]\n");
      await previous.handle.close();
    }
    const handle = await fs.open(path.join(this.dir, `${kind}#${String(chunk).padStart(6, "0")}.json`), "w");
    await handle.write("[");
    this.open.set(kind, { chunk, handle });
    return handle;
  }

  async append(feature: MapFeature, sequence: number): Promise<void> {
    const chunk = Math.floor(sequence / OUTPUT_CHUNK_SIZE);
    const state = this.open.get(feature.kind);
    if (state === undefined || state.chunk !== chunk) {
      const handle = await this.openChunk(feature.kind);
      await handle.write(JSON.stringify(feature));
      return;
    }
    await state.handle.write(`,\n${JSON.stringify(feature)}`);
  }

  async close(): Promise<void> {
    for (const { handle } of this.open.values()) {
      await handle.write("\n]\n");
      await handle.close();
    }
    this.open.clear();
  }
}

function scanCompactJson(text: string, from: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") depth += 1;
    else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function isCompleteJsonObject(text: string): boolean {
  if (text.charCodeAt(0) !== 123) return false;
  if (scanCompactJson(text, 0) !== text.length) return false;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

export async function* featureRecords(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 22 });
  let pending = "";
  for await (const piece of stream) {
    let buffer = pending.length === 0 ? (piece as string) : pending + (piece as string);
    pending = "";
    for (;;) {
      const start = buffer.indexOf("{");
      if (start < 0) {
        if (!/^[[\],\s]*$/.test(buffer)) throw new Error(`unexpected JSON before a record in ${file}: ${buffer.slice(0, 80)}`);
        buffer = "";
        break;
      }
      if (start > 0 && !/^[[\],\s]*$/.test(buffer.slice(0, start))) {
        throw new Error(`unexpected JSON before a record in ${file}: ${buffer.slice(0, 80)}`);
      }
      const stop = scanCompactJson(buffer, start);
      if (stop < 0) {
        pending = buffer.slice(start);
        break;
      }
      const record = buffer.slice(start, stop);
      if (!isCompleteJsonObject(record)) throw new Error(`unparseable JSON record in ${file}: ${record.slice(0, 80)}`);
      buffer = buffer.slice(stop);
      if (buffer.length > 0 && !/^[[\],\s]/.test(buffer)) {
        throw new Error(`two JSON records with no separator in ${file}: ${buffer.slice(0, 80)}`);
      }
      yield record;
    }
  }
  if (pending.trim().length > 0) throw new Error(`truncated JSON record at end of ${file}: ${pending.slice(0, 80)}`);
}

async function* textLines(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let pending = "";
  for await (const piece of stream) {
    pending += piece as string;
    let start = 0;
    for (;;) {
      const stop = pending.indexOf("\n", start);
      if (stop < 0) break;
      yield pending.slice(start, stop);
      start = stop + 1;
    }
    pending = pending.slice(start);
  }
  if (pending.length > 0) yield pending;
}

export function encodeSpoolRecord(order: number, cellX: number, cellZ: number, raw: string): string {
  return JSON.stringify({ v: order, x: cellX, z: cellZ, j: raw }).replace(/[\r\n]/g, " ");
}

export interface SpoolRecord {
  readonly v: number;
  readonly x: number;
  readonly z: number;
  readonly j: string;
}

export function decodeSpoolRecord(line: string): SpoolRecord {
  const value = JSON.parse(line) as Partial<SpoolRecord> | null;
  if (value === null || typeof value !== "object") throw new Error(`malformed spool record: ${line.slice(0, 80)}`);
  if (typeof value.v !== "number" || typeof value.x !== "number" || typeof value.z !== "number" || typeof value.j !== "string") {
    throw new Error(`malformed spool record: ${line.slice(0, 80)}`);
  }
  return { v: value.v, x: value.x, z: value.z, j: value.j };
}

export async function deduplicateStreaming(
  inDir: string,
  outDir: string,
  accounting: DedupAccounting = createDedupAccounting()
): Promise<DedupStreamStats> {
  const workDir = await fs.mkdtemp(path.join(DEDUP_TEMP_ROOT, TEMP_PREFIX));
  try {
    return await runScan(inDir, outDir, accounting, workDir);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

async function runScan(
  inDir: string,
  outDir: string,
  accounting: DedupAccounting,
  workDir: string
): Promise<DedupStreamStats> {
  const accounted = new Map<string, number>();
  const reachById = new Map<string, number>();
  const spool = new BandSpool(workDir);
  let total = 0;
  let inputBytes = 0;
  let minCellX = Infinity;
  let maxCellX = -Infinity;
  let minCellZ = Infinity;
  let maxCellZ = -Infinity;
  try {
    for (const name of await listFeatureFiles(inDir)) {
      for await (const raw of featureRecords(path.join(inDir, name))) {
        const feature = MapFeatureSchema.parse(JSON.parse(raw) as unknown);
        const key = accountKey(sourceKeyOf(feature), layerOf(feature), feature.kind);
        accounted.set(key, (accounted.get(key) ?? 0) + 1);
        total += 1;
        inputBytes += raw.length;
        const cell = cellOf(feature);
        const identity = feature.stableId;
        if (cell === null) {
          reachById.set(identity, Number.MAX_SAFE_INTEGER);
          await spool.append(Number.MAX_SAFE_INTEGER, `${encodeSpoolRecord(0, 0, 0, raw)}\n`);
          continue;
        }
        if (cell[0] < minCellX) minCellX = cell[0];
        if (cell[0] > maxCellX) maxCellX = cell[0];
        if (cell[1] < minCellZ) minCellZ = cell[1];
        if (cell[1] > maxCellZ) maxCellZ = cell[1];
        const known = reachById.get(identity);
        if (known === undefined || cell[1] > known) reachById.set(identity, cell[1]);
        await spool.append(Math.floor(cell[1] / SCAN_BAND_CELLS), `${encodeSpoolRecord(total, cell[0], cell[1], raw)}\n`);
      }
    }
  } finally {
    await spool.close();
  }

  const width = Number.isFinite(minCellX) ? maxCellX - minCellX + 1 : 1;
  const depth = Number.isFinite(minCellZ) ? maxCellZ - minCellZ + 1 : 1;
  const retireRowFor = (identity: string, cellZ: number): number => {
    const reach = reachById.get(identity) ?? cellZ;
    if (reach >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
    return reach + DEDUP_REACH_CELLS;
  };

  for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !DEDUP_PRESERVED_SIDECARS.has(entry.name)) {
      await fs.unlink(path.join(outDir, entry.name));
    }
  }
  const sink = new ChunkSink(workDir);
  const provenance = await fs.open(path.join(workDir, "provenance.ndjson"), "w");
  const exact = new Map<string, number>();
  const groups = new Map<number, LiveGroup>();
  const buckets = new Map<string, number[]>();
  const acceptedByKey = new Map<string, number>();
  const mergedByKey = new Map<string, number>();
  const exactIdentities = new Map<string, Set<string>>();
  const pending: { retire: number; id: number; generation: number }[] = [];
  const generations = new Map<number, number>();
  let nextId = 0;
  let sequence = 0;
  let emitted = 0;
  let outputBytes = 0;

  const emit = async (id: number): Promise<void> => {
    const group = groups.get(id);
    if (group === undefined) return;
    const merged = mergeGroup(group.features);
    const encoded = JSON.stringify(merged);
    await sink.append(merged, sequence);
    outputBytes += encoded.length;
    sequence += 1;
    emitted += 1;
    let provenanceBuffer = "";
    for (const record of merged.provenance) {
      provenanceBuffer += `${JSON.stringify(record)}\n`;
      if (provenanceBuffer.length >= 1 << 20) {
        await provenance.write(provenanceBuffer);
        provenanceBuffer = "";
      }
    }
    if (provenanceBuffer.length > 0) await provenance.write(provenanceBuffer);
    groups.delete(id);
    for (const cell of group.cells) {
      const list = buckets.get(cell);
      if (list === undefined) continue;
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) buckets.delete(cell);
    }
  };

  const pushRetire = (id: number, retire: number): void => {
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    let at = pending.length;
    pending.push({ retire, id, generation });
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (pending[parent]!.retire <= pending[at]!.retire) break;
      const swap = pending[parent]!;
      pending[parent] = pending[at]!;
      pending[at] = swap;
      at = parent;
    }
  };

  const popRetire = (): { retire: number; id: number; generation: number } | undefined => {
    if (pending.length === 0) return undefined;
    const top = pending[0]!;
    const last = pending.pop()!;
    if (pending.length > 0) {
      pending[0] = last;
      let at = 0;
      for (;;) {
        const left = at * 2 + 1;
        const right = left + 1;
        let smallest = at;
        if (left < pending.length && pending[left]!.retire < pending[smallest]!.retire) smallest = left;
        if (right < pending.length && pending[right]!.retire < pending[smallest]!.retire) smallest = right;
        if (smallest === at) break;
        const swap = pending[at]!;
        pending[at] = pending[smallest]!;
        pending[smallest] = swap;
        at = smallest;
      }
    }
    return top;
  };

  const sweep = async (front: number): Promise<void> => {
    for (;;) {
      const next = popRetire();
      if (next === undefined || next.retire > front) {
        if (next !== undefined) pushRetire(next.id, next.retire);
        return;
      }
      if (generations.get(next.id) === next.generation) await emit(next.id);
    }
  };

  const accept = async (raw: string, cellX: number, cellZ: number, anchored: boolean): Promise<void> => {
    const feature = MapFeatureSchema.parse(JSON.parse(raw) as unknown);
    const source = sourceKeyOf(feature);
    const layer = layerOf(feature);
    const key = accountKey(source, layer, feature.kind);
    let found = exact.get(feature.stableId);
    let metricConflation = false;
    if (found === undefined && anchored) {
      search: for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          const candidates = buckets.get(`${feature.kind}:${cellX + dx}:${cellZ + dz}`);
          if (candidates === undefined) continue;
          for (const candidateId of candidates) {
            const group = groups.get(candidateId);
            if (group === undefined) continue;
            if (group.features.some((candidate) => canConflate(candidate, feature))) {
              found = candidateId;
              metricConflation = !group.features.some((candidate) => candidate.stableId === feature.stableId);
              break search;
            }
          }
        }
      }
    }
    const group = found === undefined ? undefined : groups.get(found);
    if (found === undefined) {
      const id = nextId;
      nextId += 1;
      const retireOrder = retireRowFor(feature.stableId, cellZ);
      groups.set(id, { features: [feature], cells: new Set<string>(), retireRow: retireOrder });
      pushRetire(id, retireOrder);
      acceptedByKey.set(key, (acceptedByKey.get(key) ?? 0) + 1);
      exact.set(feature.stableId, id);
      if (anchored) {
        const bucket = `${feature.kind}:${cellX}:${cellZ}`;
        const list = buckets.get(bucket) ?? [];
        list.push(id);
        buckets.set(bucket, list);
        groups.get(id)?.cells.add(bucket);
      }
      return;
    }
    if (group === undefined) {
      const identities = exactIdentities.get(key) ?? new Set<string>();
      identities.add(feature.stableId);
      exactIdentities.set(key, identities);
      accounting.drops.drop(STAGES.deduplicate, DROP_REASONS.dedupExactIdentity, 1, `${feature.stableId} repeats an identity already merged and emitted`);
      mergedByKey.set(key, (mergedByKey.get(key) ?? 0) + 1);
      return;
    }
    if (metricConflation) {
      accounting.drops.drop(STAGES.deduplicate, DROP_REASONS.dedupMetricConflation, 1, `${feature.stableId} conflated into ${group.features[0]!.stableId}`);
    } else {
      const identities = exactIdentities.get(key) ?? new Set<string>();
      identities.add(feature.stableId);
      exactIdentities.set(key, identities);
      accounting.drops.drop(STAGES.deduplicate, DROP_REASONS.dedupExactIdentity, 1, `${feature.stableId} repeats an identity already grouped`);
    }
    mergedByKey.set(key, (mergedByKey.get(key) ?? 0) + 1);
    if (!anchored) return;
    group.features.push(feature);
    exact.set(feature.stableId, found);
    const retirement = retireRowFor(feature.stableId, cellZ);
    if (retirement > group.retireRow) {
      group.retireRow = retirement;
      pushRetire(found, retirement);
    }
    const bucket = `${feature.kind}:${cellX}:${cellZ}`;
    const list = buckets.get(bucket) ?? [];
    if (!list.includes(found)) list.push(found);
    buckets.set(bucket, list);
    group.cells.add(bucket);
  };

  const bandNames = (await fs.readdir(workDir)).filter((name) => name.startsWith("band-")).sort((first, second) =>
    Number(first.slice(5, -6)) - Number(second.slice(5, -6))
  );
  let peakBands = 0;
  for (const name of bandNames) {
    const records: { order: number; cellX: number; cellZ: number; raw: string; anchored: boolean }[] = [];
    for await (const line of textLines(path.join(workDir, name))) {
      if (line.length === 0) continue;
      const decoded = decodeSpoolRecord(line);
      records.push({ order: decoded.v, cellX: decoded.x, cellZ: decoded.z, raw: decoded.j, anchored: decoded.v > 0 });
    }
    records.sort((first, second) => {
      if (first.anchored !== second.anchored) return first.anchored ? -1 : 1;
      if (!first.anchored) return 0;
      const a = (first.cellZ - minCellZ) * width + (first.cellX - minCellX);
      const b = (second.cellZ - minCellZ) * width + (second.cellX - minCellX);
      return a === b ? first.order - second.order : a - b;
    });
    peakBands = Math.max(peakBands, records.length);
    let front = Number.NEGATIVE_INFINITY;
    for (const record of records) {
      if (record.anchored) {
        if (record.cellZ > front) {
          await sweep(record.cellZ - 1);
          front = record.cellZ;
        }
      }
      await accept(record.raw, record.cellX, record.cellZ, record.anchored);
    }
  }
  for (const id of [...groups.keys()]) await emit(id);
  await sink.close();
  await provenance.close();

  for (const [key, input] of accounted) {
    const [source = "unknown", layer = "-", kind = "unknown"] = key.split("::");
    const accepted = acceptedByKey.get(key) ?? 0;
    const merged = mergedByKey.get(key) ?? 0;
    const identical = exactIdentities.get(key)?.size ?? 0;
    const metric = Math.max(0, merged - identical);
    accounting.sources.record(source, layer, kind, input, accepted, {
      excludedCount: merged,
      excluded: DROP_REASONS.dedupExactIdentity,
      reason: "duplicate canonical identity collapsed into the group winner",
    });
    if (metric > 0) {
      accounting.sources.record(source, layer, kind, 0, 0, {
        excludedCount: metric,
        excluded: DROP_REASONS.dedupMetricConflation,
        reason: "metric conflation collapsed a second source record into the group winner",
      });
    }
    accounting.sources.recordMerged(source, layer, kind, merged);
  }

  const staged = path.join(workDir, "staged");
  await fs.mkdir(staged, { recursive: true });
  for (const name of await fs.readdir(workDir)) {
    if (name.endsWith(".json") && name.includes("#")) {
      const kind = name.slice(0, name.indexOf("#"));
      const chunk = Number(name.slice(name.indexOf("#") + 1, name.length - 5));
      const suffix = chunk === 0 ? "" : `-${String(chunk).padStart(4, "0")}`;
      await moveFile(path.join(workDir, name), path.join(staged, `${kind}${suffix}.json`));
    }
  }
  for (const name of await fs.readdir(staged)) await moveFile(path.join(staged, name), path.join(outDir, name));
  await fs.rm(staged, { recursive: true, force: true });
  await writeProvenance(path.join(workDir, "provenance.ndjson"), path.join(outDir, "provenance.json"));

  return { input: total, groups: nextId, emitted, inputBytes, outputBytes, peakBands, widthCells: width, depthCells: depth, bandCells: SCAN_BAND_CELLS };
}

async function writeProvenance(source: string, destination: string): Promise<void> {
  const reader = readline.createInterface({ input: createReadStream(source), crlfDelay: Infinity });
  const handle = await fs.open(destination, "w");
  let buffer = "[";
  let first = true;
  try {
    for await (const line of reader) {
      if (line.length === 0) continue;
      buffer += `${first ? "" : ",\n"}${line}`;
      first = false;
      if (buffer.length >= 1 << 20) {
        await handle.write(buffer);
        buffer = "";
      }
    }
    await handle.write(`${buffer}\n]\n`);
  } finally {
    await handle.close();
  }
}

async function readFeatures(inDir: string): Promise<MapFeature[]> {
  const result: MapFeature[] = [];
  for (const name of await listFeatureFiles(inDir)) {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(inDir, name), "utf8"));
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) result.push(MapFeatureSchema.parse(value));
  }
  return result;
}

async function writeJsonArray(filePath: string, values: Iterable<unknown>): Promise<void> {
  const handle = await fs.open(filePath, "w");
  let buffer = "";
  let first = true;
  try {
    await handle.write("[");
    for (const value of values) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) continue;
      buffer += `${first ? "" : ",\n"}${encoded}`;
      first = false;
      if (buffer.length >= 1024 * 1024) {
        await handle.write(buffer);
        buffer = "";
      }
    }
    await handle.write(`${buffer}\n]\n`);
  } finally {
    await handle.close();
  }
}

async function writeFeatures(features: MapFeature[], outDir: string): Promise<void> {
  for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !DEDUP_PRESERVED_SIDECARS.has(entry.name)) await fs.unlink(path.join(outDir, entry.name));
  }
  const groups = new Map<string, MapFeature[]>();
  for (const feature of features) {
    const list = groups.get(feature.kind) ?? [];
    list.push(MapFeatureSchema.parse(feature));
    groups.set(feature.kind, list);
  }
  for (const [kind, list] of groups) {
    for (let offset = 0; offset < list.length; offset += OUTPUT_CHUNK_SIZE) {
      const suffix = offset === 0 ? "" : `-${String(offset / OUTPUT_CHUNK_SIZE).padStart(4, "0")}`;
      await writeJsonArray(path.join(outDir, `${kind}${suffix}.json`), list.slice(offset, offset + OUTPUT_CHUNK_SIZE));
    }
  }
  function* provenanceRecords(): Iterable<unknown> {
    for (const feature of features) yield* feature.provenance;
  }
  await writeJsonArray(path.join(outDir, "provenance.json"), provenanceRecords());
}

export async function deduplicateAll(
  inDir?: string,
  outDir?: string,
  accounting: DedupAccounting = createDedupAccounting()
): Promise<DedupAccounting> {
  const root = dataRoot();
  const sourceDir = inDir ?? path.join(root, "intermediate");
  const destinationDir = outDir ?? path.join(root, "intermediate");
  if (process.env.MASTER_MAPS_DEDUP_INMEMORY === "1") return deduplicateAllInMemory(sourceDir, destinationDir, accounting);
  const stats = await deduplicateStreaming(sourceDir, destinationDir, accounting);
  console.error(
    `[deduplicate] bounded-memory scan grouped ${stats.input} canonical features into ${stats.groups} identities, emitted ${stats.emitted} ` +
      `(bands=${stats.bandCells} cells wide=${stats.widthCells} deep=${stats.depthCells}, ${megabytes(stats.inputBytes)} in, ${megabytes(stats.outputBytes)} out)`
  );
  return accounting;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

if (process.argv[1]?.endsWith("deduplicate.ts")) {
  const options = parseArgs(process.argv.slice(2));
  const run = options.memoryMode
    ? deduplicateAllInMemory(options.inDir, options.outDir)
    : deduplicateAll(options.inDir, options.outDir);
  run.catch((error: unknown) => {
    console.error("[deduplicate] Fatal:", error);
    process.exit(1);
  });
}

export async function deduplicateAllInMemory(
  inDir?: string,
  outDir?: string,
  accounting: DedupAccounting = createDedupAccounting()
): Promise<DedupAccounting> {
  const root = dataRoot();
  const sourceDir = inDir ?? path.join(root, "intermediate");
  const destinationDir = outDir ?? path.join(root, "intermediate");
  const input = await readFeatures(sourceDir);
  const output = deduplicateFeatures(input, accounting);
  await writeFeatures(output, destinationDir);
  console.error(`[deduplicate] in-memory reference merged ${input.length} canonical features to ${output.length}`);
  return accounting;
}
