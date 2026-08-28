#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { intersection } from "polygon-clipping";
import { MapFeatureSchema, type Geometry, type MapFeature, type ProvenanceRecord, type SourceReference } from "../../src/lib/data/schema";
import { wgs84ToRender } from "../../src/lib/geo/crs";

const BUCKET_SIZE_METRES = 100;
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

interface DupOptions {
  inDir: string;
  outDir: string;
}

type LocalPoint = [number, number];
type LocalLine = LocalPoint[];
type LocalPolygon = LocalLine[];

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

function parseArgs(args: string[]): DupOptions {
  const root = dataRoot();
  let inDir = path.join(root, "intermediate");
  let outDir = path.join(root, "intermediate");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--in-dir" && args[index + 1]) inDir = args[++index]!;
    if (argument === "--out-dir" && args[index + 1]) outDir = args[++index]!;
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: tsx scripts/data/deduplicate.ts [--in-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { inDir, outDir };
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

export function deduplicateFeatures(features: MapFeature[]): MapFeature[] {
  const groups: MapFeature[][] = [];
  const exact = new Map<string, number>();
  const buckets = new Map<string, number[]>();
  for (const input of features) {
    const feature = MapFeatureSchema.parse(input);
    let groupIndex = exact.get(feature.stableId);
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
              break;
            }
          }
        }
      }
    }
    if (groupIndex === undefined) {
      groupIndex = groups.length;
      groups.push([feature]);
    } else {
      groups[groupIndex]!.push(feature);
    }
    exact.set(feature.stableId, groupIndex);
    if (coordinateValue) {
      const key = bucketKey(feature.kind, coordinateValue[0], coordinateValue[1]);
      const list = buckets.get(key) ?? [];
      if (!list.includes(groupIndex)) list.push(groupIndex);
      buckets.set(key, list);
    }
  }
  return groups.map(mergeGroup);
}

async function readFeatures(inDir: string): Promise<MapFeature[]> {
  const result: MapFeature[] = [];
  const ignored = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);
  for (const entry of await fs.readdir(inDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || ignored.has(entry.name)) continue;
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(inDir, entry.name), "utf8"));
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
  const preserved = new Set(["boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);
  for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !preserved.has(entry.name)) await fs.unlink(path.join(outDir, entry.name));
  }
  const groups = new Map<string, MapFeature[]>();
  for (const feature of features) {
    const list = groups.get(feature.kind) ?? [];
    list.push(MapFeatureSchema.parse(feature));
    groups.set(feature.kind, list);
  }
  for (const [kind, list] of groups) {
    for (let offset = 0; offset < list.length; offset += 20_000) {
      const suffix = offset === 0 ? "" : `-${String(offset / 20_000).padStart(4, "0")}`;
      await writeJsonArray(path.join(outDir, `${kind}${suffix}.json`), list.slice(offset, offset + 20_000));
    }
  }
  function* provenanceRecords(): Iterable<unknown> {
    for (const feature of features) yield* feature.provenance;
  }
  await writeJsonArray(path.join(outDir, "provenance.json"), provenanceRecords());
}

export async function deduplicateAll(inDir?: string, outDir?: string): Promise<void> {
  const root = dataRoot();
  const sourceDir = inDir ?? path.join(root, "intermediate");
  const destinationDir = outDir ?? path.join(root, "intermediate");
  const input = await readFeatures(sourceDir);
  const output = deduplicateFeatures(input);
  await writeFeatures(output, destinationDir);
  console.error(`[deduplicate] Merged ${input.length} canonical features to ${output.length}`);
}

if (process.argv[1]?.endsWith("deduplicate.ts")) {
  const options = parseArgs(process.argv.slice(2));
  deduplicateAll(options.inDir, options.outDir).catch((error: unknown) => {
    console.error("[deduplicate] Fatal:", error);
    process.exit(1);
  });
}
