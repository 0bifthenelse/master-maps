#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { lambertToRender, wgs84ToRender } from "../../src/lib/geo/crs";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";

const execFileAsync = promisify(execFile);

export const STRATIFIED_SEED = 20260926;
export const SAMPLE_TARGET_TILES = 50;
export const SAMPLE_TARGET_COMMUNES = 20;
export const MAX_TILE_BYTES = 2 * 1024 * 1024;
export const GERS_DEPARTMENT_CODE = "32";
export const BOUNDARY_ON_EDGE_METRES = 1;
export const MINOR_ROAD_CLASSES = ["track", "path", "footway", "service", "unclassified"] as const;
export const QUADRANTS = ["nw", "ne", "sw", "se"] as const;
export const DENSITY_BINS = ["sparse", "low", "mid", "high", "dense"] as const;
export const SETTLEMENT_CLASSES = ["rural", "village", "town", "city"] as const;
export const RIVER_CLASSES = ["none", "watercourse", "surface"] as const;

export type Quadrant = (typeof QUADRANTS)[number];
export type DensityBin = (typeof DENSITY_BINS)[number];
export type SettlementClass = (typeof SETTLEMENT_CLASSES)[number];
export type RiverClass = (typeof RIVER_CLASSES)[number];
export type StratumKey = `${Quadrant}|${DensityBin}|${SettlementClass}|${RiverClass}|${"plain" | "minorRoad"}`;

export type Bbox = [number, number, number, number];

export interface TileRecord {
  tileId: string;
  lod: number;
  bounds: Bbox;
  featureCount: number;
  byteSize: number;
}

export interface CommuneRecord {
  codeInsee: string;
  name: string;
  population: number;
  /** Render-space centroid. */
  x: number;
  z: number;
}

export interface TileObservation {
  tileId: string;
  kinds: Record<string, number>;
  anchorCount: number;
  anchorsOutside: number;
  onEdgeAnchors: number;
  minorRoadShare: number;
  roadCount: number;
  maxAnchorDistanceMetres: number;
}

export interface Stratum {
  key: StratumKey;
  quadrant: Quadrant;
  density: DensityBin;
  settlement: SettlementClass;
  river: RiverClass;
  network: "plain" | "minorRoad";
  tileIds: string[];
}

export interface StratumVerdict {
  key: StratumKey;
  label: string;
  sampledTiles: number;
  expectedKinds: string[];
  missingKinds: string[];
  maxTileBytes: number;
  oversizedTiles: string[];
  anchorsChecked: number;
  anchorsOutside: number;
  onEdgeAnchors: number;
  communeAnchorsChecked: number;
  communeAnchorsOutside: number;
  failures: string[];
  passed: boolean;
}

export interface StratifiedReport {
  checkedAt: string;
  seed: number;
  datasetVersion: string;
  passed: boolean;
  population: {
    lod0TileCount: number;
    communeCount: number;
    tileKindTotals: Record<string, number>;
    manifestKinds: Record<string, number>;
    manifestMissingKinds: string[];
  };
  sampling: {
    sampledTiles: number;
    sampledCommunes: number;
    targetTiles: number;
    targetCommunes: number;
    observationsRead: number;
    missingTileFiles: number;
    missingTileFileExamples: string[];
    unreadableTileFiles: number;
    unreadableTileFileExamples: string[];
  };
  strata: StratumVerdict[];
  emptyStrata: string[];
  unknownStrata: string[];
  globalFailures: string[];
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function quadrantOf(bounds: Bbox): Quadrant {
  const cx = (bounds[0] + bounds[2]) / 2;
  const cz = (bounds[1] + bounds[3]) / 2;
  if (cz < 0) return cx < 0 ? "nw" : "ne";
  return cx < 0 ? "sw" : "se";
}

export function quantile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const position = clamp(fraction, 0, 1) * (sortedValues.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return sortedValues[low]! * (1 - weight) + sortedValues[high]! * weight;
}

export interface DensityEdges {
  sparseMax: number;
  lowMax: number;
  midMax: number;
  highMax: number;
}

export function densityEdges(featureCounts: number[]): DensityEdges {
  const sorted = [...featureCounts].sort((first, second) => first - second);
  return {
    sparseMax: quantile(sorted, 0.2),
    lowMax: quantile(sorted, 0.4),
    midMax: quantile(sorted, 0.6),
    highMax: quantile(sorted, 0.8),
  };
}

export function densityBin(featureCount: number, edges: DensityEdges): DensityBin {
  if (featureCount <= edges.sparseMax) return "sparse";
  if (featureCount <= edges.lowMax) return "low";
  if (featureCount <= edges.midMax) return "mid";
  if (featureCount <= edges.highMax) return "high";
  return "dense";
}

export function settlementClass(population: number): SettlementClass {
  if (population >= 10000) return "city";
  if (population >= 2000) return "town";
  if (population >= 500) return "village";
  return "rural";
}

export function stratumKey(parts: {
  quadrant: Quadrant;
  density: DensityBin;
  settlement: SettlementClass;
  river: RiverClass;
  network: "plain" | "minorRoad";
}): StratumKey {
  return `${parts.quadrant}|${parts.density}|${parts.settlement}|${parts.river}|${parts.network}`;
}

export function parseStratumKey(key: StratumKey): Omit<Stratum, "key" | "tileIds"> {
  const [quadrant, density, settlement, river, network] = key.split("|") as [Quadrant, DensityBin, SettlementClass, RiverClass, "plain" | "minorRoad"];
  return { quadrant, density, settlement, river, network };
}

export function tileIntersectsBounds(tile: TileRecord, point: [number, number]): boolean {
  return point[0] >= tile.bounds[0] && point[0] <= tile.bounds[2] && point[1] >= tile.bounds[1] && point[1] <= tile.bounds[3];
}

export function assignSettlement(
  tiles: TileRecord[],
  communes: CommuneRecord[],
): Map<string, SettlementClass> {
  const assignment = new Map<string, SettlementClass>();
  for (const commune of communes) {
    const host = tiles.find((tile) => tileIntersectsBounds(tile, [commune.x, commune.z]));
    if (host === undefined) continue;
    const current = assignment.get(host.tileId);
    const candidate = settlementClass(commune.population);
    if (current === undefined || SEVERITY[candidate] > SEVERITY[current]) assignment.set(host.tileId, candidate);
  }
  return assignment;
}

const SEVERITY: Record<SettlementClass, number> = { rural: 0, village: 1, town: 2, city: 3 };

export function classifyRiver(observation: Pick<TileObservation, "kinds">): RiverClass {
  const water = (observation.kinds["water"] ?? 0);
  if (water === 0) return "none";
  return water >= 12 ? "surface" : "watercourse";
}

export function classifyNetwork(minorRoadShare: number): "plain" | "minorRoad" {
  return minorRoadShare >= 0.5 ? "minorRoad" : "plain";
}

export interface StratumBuild {
  strata: Map<StratumKey, Stratum>;
  unknown: string[];
}

export function buildStrata(options: {
  tiles: TileRecord[];
  communes: CommuneRecord[];
  edges: DensityEdges;
  observations: Map<string, TileObservation>;
}): StratumBuild {
  const settlement = assignSettlement(options.tiles, options.communes);
  const strata = new Map<StratumKey, Stratum>();
  const unknown: string[] = [];
  for (const tile of options.tiles) {
    const observation = options.observations.get(tile.tileId);
    if (observation === undefined) continue;
    const settlementValue = settlement.get(tile.tileId) ?? "rural";
    const key = stratumKey({
      quadrant: quadrantOf(tile.bounds),
      density: densityBin(tile.featureCount, options.edges),
      settlement: settlementValue,
      river: classifyRiver(observation),
      network: classifyNetwork(observation.minorRoadShare),
    });
    const existing = strata.get(key);
    if (existing === undefined) {
      strata.set(key, {
        key,
        quadrant: quadrantOf(tile.bounds),
        density: densityBin(tile.featureCount, options.edges),
        settlement: settlementValue,
        river: classifyRiver(observation),
        network: classifyNetwork(observation.minorRoadShare),
        tileIds: [tile.tileId],
      });
      continue;
    }
    existing.tileIds.push(tile.tileId);
  }
  for (const tile of options.tiles) {
    if (!options.observations.has(tile.tileId)) unknown.push(tile.tileId);
  }
  return { strata, unknown };
}

export function expectedKindsFor(stratum: Omit<Stratum, "key" | "tileIds">, manifestKinds: Record<string, number>): string[] {
  const expected: string[] = [];
  if (stratum.density === "sparse" || stratum.density === "low") {
    expected.push("road");
  } else {
    expected.push("road", "building");
  }
  if (stratum.settlement !== "rural" || stratum.density !== "sparse") expected.push("address");
  if (stratum.river !== "none") expected.push("water");
  if (stratum.settlement === "city" || stratum.settlement === "town") {
    for (const rare of ["business", "poi"]) {
      if ((manifestKinds[rare] ?? 0) > 0) expected.push(rare);
    }
  }
  return [...new Set(expected)].sort();
}

export function isRareKind(kind: string): boolean {
  return kind === "business" || kind === "poi";
}

export function stratifiedSample(options: {
  tiles: TileRecord[];
  communes: CommuneRecord[];
  observations: Map<string, TileObservation>;
  edges: DensityEdges;
  targetTiles: number;
  targetCommunes: number;
  seed: number;
  manifestKinds: Record<string, number>;
}): { strata: Stratum[]; sampledTiles: string[]; sampledCommunes: string[]; unknown: string[] } {
  const built = buildStrata(options);
  const random = mulberry32(options.seed);
  const order = [...built.strata.keys()].sort();

  for (const key of order) {
    const stratum = built.strata.get(key)!;
    shuffleInPlace(stratum.tileIds, random);
  }

  const sampledTiles: string[] = [];
  const seen = new Set<string>();
  const cursors = new Map<string, number>();
  const takeNext = (key: string): boolean => {
    const stratum = built.strata.get(key)!;
    const cursor = cursors.get(key) ?? 0;
    while (cursor < stratum.tileIds.length) {
      const tileId = stratum.tileIds[cursor]!;
      cursors.set(key, cursor + 1);
      if (seen.has(tileId)) continue;
      seen.add(tileId);
      sampledTiles.push(tileId);
      return true;
    }
    return false;
  };

  for (const key of order) {
    if (sampledTiles.length >= options.targetTiles) break;
    takeNext(key);
  }

  let progressed = true;
  while (sampledTiles.length < options.targetTiles && progressed) {
    progressed = false;
    for (const key of order) {
      if (sampledTiles.length >= options.targetTiles) break;
      if (takeNext(key)) progressed = true;
    }
  }

  const communes = [...options.communes].sort((first, second) => first.codeInsee.localeCompare(second.codeInsee));
  shuffleInPlace(communes, random);
  const sampledCommunes = communes.slice(0, options.targetCommunes).map((commune) => commune.codeInsee);

  const strata = order
    .map((key) => built.strata.get(key)!)
    .map((stratum) => ({
      ...stratum,
      tileIds: stratum.tileIds.filter((tileId) => seen.has(tileId)),
    }))
    .filter((stratum) => stratum.tileIds.length > 0);

  return { strata, sampledTiles, sampledCommunes, unknown: built.unknown };
}

function shuffleInPlace<T>(values: T[], random: () => number): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const held = values[index]!;
    values[index] = values[target]!;
    values[target] = held;
  }
}

export function verifyStratum(options: {
  stratum: Stratum;
  manifestKinds: Record<string, number>;
  observations: Map<string, TileObservation>;
  tiles: Map<string, TileRecord>;
  communeChecks: { codeInsee: string; inside: boolean }[];
  onEdgeAnchors: number;
}): StratumVerdict {
  const expected = expectedKindsFor(options.stratum, options.manifestKinds);
  const presentKinds = new Set<string>();
  const failures: string[] = [];
  const oversizedTiles: string[] = [];
  const missingKinds: string[] = [];
  let maxTileBytes = 0;
  let anchorsChecked = 0;
  let anchorsOutside = 0;
  const onEdgeAnchors = options.onEdgeAnchors;

  for (const tileId of options.stratum.tileIds) {
    const observation = options.observations.get(tileId);
    const tile = options.tiles.get(tileId);
    if (observation === undefined || tile === undefined) {
      failures.push(`tile ${tileId} has no observation`);
      continue;
    }
    for (const [kind, count] of Object.entries(observation.kinds)) {
      if (count > 0) presentKinds.add(kind);
    }
    maxTileBytes = Math.max(maxTileBytes, tile.byteSize);
    if (tile.byteSize > MAX_TILE_BYTES) oversizedTiles.push(tileId);
    anchorsChecked += observation.anchorCount;
    anchorsOutside += observation.anchorsOutside;
  }

  for (const kind of expected) {
    if (!presentKinds.has(kind)) missingKinds.push(kind);
  }
  if (missingKinds.length > 0) {
    failures.push(`missing kinds: ${missingKinds.join(", ")}`);
  }
  if (oversizedTiles.length > 0) {
    failures.push(`tiles above ${MAX_TILE_BYTES} bytes: ${oversizedTiles.join(", ")}`);
  }
  if (anchorsOutside > options.onEdgeAnchors) {
    failures.push(
      `${anchorsOutside - options.onEdgeAnchors} of ${anchorsChecked} feature anchors more than ${BOUNDARY_ON_EDGE_METRES} m outside the department boundary (${options.onEdgeAnchors} on the edge ring)`,
    );
  }
  const communeOutside = options.communeChecks.filter((check) => !check.inside);
  if (communeOutside.length > 0) {
    failures.push(`commune centroids outside boundary: ${communeOutside.map((check) => check.codeInsee).join(", ")}`);
  }

  const parts = parseStratumKey(options.stratum.key);
  return {
    key: options.stratum.key,
    label: `${parts.quadrant}/${parts.density}/${parts.settlement}/${parts.river}/${parts.network}`,
    sampledTiles: options.stratum.tileIds.length,
    expectedKinds: expected,
    missingKinds,
    maxTileBytes,
    oversizedTiles,
    anchorsChecked,
    anchorsOutside,
    onEdgeAnchors,
    communeAnchorsChecked: options.communeChecks.length,
    communeAnchorsOutside: communeOutside.length,
    failures,
    passed: failures.length === 0,
  };
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

const ROOT = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const MAX_OBSERVATION_TILES = Number(process.env.QA_STRATIFIED_OBSERVATION_TILES ?? "600");
const MAX_ANCHORS_PER_TILE = 40;
const CANONICAL_KINDS = ["boundary", "building", "road", "water", "landuse", "poi", "business", "address", "transport", "structure", "place"] as const;

interface SlimTileEntry {
  tileId: string;
  lod: number;
  bounds: number[];
  featureCount: number;
  byteSize: number;
}

interface TileFeature {
  kind?: string;
  x?: number;
  z?: number;
  roadClass?: string;
  highway?: string;
}

export async function readTileManifest(generatedDir: string): Promise<TileRecord[]> {
  const raw = await fs.readFile(path.join(generatedDir, "tile-manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as SlimTileEntry[];
  return parsed.map((entry) => ({
    tileId: entry.tileId,
    lod: entry.lod,
    bounds: entry.bounds as Bbox,
    featureCount: entry.featureCount,
    byteSize: entry.byteSize,
  }));
}

export async function readManifestKinds(generatedDir: string): Promise<Record<string, number>> {
  const candidates = [
    path.join(generatedDir, "manifests", "coverage.json"),
    path.join(ROOT, "qa", "coverage.json"),
    path.join(generatedDir, "coverage.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, "utf8")) as { featureCounts?: Record<string, number> };
      if (parsed.featureCounts !== undefined) return parsed.featureCounts;
    } catch {
      continue;
    }
  }
  const manifest = JSON.parse(await fs.readFile(path.join(generatedDir, "manifest.json"), "utf8")) as {
    featureCounts?: Record<string, number>;
    datasetVersion?: string;
  };
  return manifest.featureCounts ?? {};
}

export async function readDatasetVersion(generatedDir: string): Promise<string> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(generatedDir, "manifest.json"), "utf8")) as { datasetVersion?: string };
    return manifest.datasetVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function mapRings(coords: number[][][][], project: (point: [number, number]) => [number, number]): number[][][][] {
  return coords.map((polygon) => polygon.map((ring) => ring.map((point) => project([point[0]!, point[1]!]))));
}

export function ringDistanceFunction(rings: number[][][][]): (point: [number, number]) => number {
  const segments: { ax: number; ay: number; dx: number; dy: number; len2: number }[] = [];
  for (const polygon of rings) {
    for (const ring of polygon) {
      for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index]!;
        const next = ring[(index + 1) % ring.length]!;
        const dx = next[0] - current[0];
        const dy = next[1] - current[1];
        segments.push({ ax: current[0], ay: current[1], dx, dy, len2: dx * dx + dy * dy });
      }
    }
  }
  return (point) => {
    let best = Infinity;
    for (const segment of segments) {
      const raw = segment.len2 === 0 ? 0 : ((point[0] - segment.ax) * segment.dx + (point[1] - segment.ay) * segment.dy) / segment.len2;
      const t = Math.max(0, Math.min(1, raw));
      const distance = Math.hypot(point[0] - (segment.ax + t * segment.dx), point[1] - (segment.ay + t * segment.dy));
      if (distance < best) best = distance;
    }
    return best;
  };
}

export async function readBoundaryIndex(rawDir: string): Promise<BoundaryIndex> {
  const raw = JSON.parse(await fs.readFile(path.join(rawDir, "gers-boundary.geojson"), "utf8")) as {
    features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }>;
  };
  const geometry = raw.features?.[0]?.geometry;
  if (geometry === undefined || !Array.isArray(geometry.coordinates)) throw new Error("raw gers-boundary.geojson has no geometry");
  const rings = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
  return createBoundaryIndex(mapRings(rings, wgs84ToRender));
}

export async function readBoundaryRings(rawDir: string): Promise<number[][][][]> {
  const raw = JSON.parse(await fs.readFile(path.join(rawDir, "gers-boundary.geojson"), "utf8")) as {
    features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }>;
  };
  const geometry = raw.features?.[0]?.geometry;
  if (geometry === undefined || !Array.isArray(geometry.coordinates)) throw new Error("raw gers-boundary.geojson has no geometry");
  const rings = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
  return mapRings(rings, wgs84ToRender);
}

async function findGpkg(rawDir: string): Promise<string | null> {
  const stack = [rawDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith(".gpkg")) return full;
    }
  }
  return null;
}

function isPoint(value: unknown): value is number[] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

export function polygonCentroid(coordinates: unknown): [number, number] | null {
  if (!Array.isArray(coordinates) || coordinates.length === 0) return null;
  let node = coordinates;
  while (Array.isArray(node) && node.length > 0 && !isPoint(node[0])) node = node[0] as unknown[];
  if (!Array.isArray(node) || !isPoint(node[0])) return null;
  const ring = node as number[][];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    if (!isPoint(current) || !isPoint(next)) return null;
    const cross = current[0] * next[1] - next[0] * current[1];
    area += cross;
    cx += (current[0] + next[0]) * cross;
    cy += (current[1] + next[1]) * cross;
  }
  if (Math.abs(area) < 1e-12) return null;
  const gx = cx / (3 * area);
  const gy = cy / (3 * area);
  return Number.isFinite(gx) && Number.isFinite(gy) ? [gx, gy] : null;
}

export async function readCommunes(rawDir: string): Promise<CommuneRecord[]> {
  const gpkg = await findGpkg(rawDir);
  if (gpkg === null) return [];
  const sql = "SELECT code_insee, nom_officiel, population, code_insee_du_departement, geometrie FROM commune";
  const { stdout } = await execFileAsync("ogr2ogr", ["-f", "GeoJSON", "/vsistdout/", "-sql", sql, gpkg], {
    maxBuffer: 512 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as {
    features?: Array<{ properties?: Record<string, unknown>; geometry?: { coordinates?: unknown } }>;
  };
  const records: CommuneRecord[] = [];
  for (const feature of parsed.features ?? []) {
    const properties = feature.properties ?? {};
    const code = String(properties["code_insee"] ?? "");
    if (!/^\d{5}$/.test(code)) continue;
    if (String(properties["code_insee_du_departement"] ?? "") !== GERS_DEPARTMENT_CODE) continue;
    const population = Number(properties["population"] ?? 0);
    const centroid = polygonCentroid(feature.geometry?.coordinates);
    if (centroid === null) continue;
    const render = lambertToRender(centroid);
    records.push({
      codeInsee: code,
      name: String(properties["nom_officiel"] ?? code),
      population: Number.isFinite(population) ? population : 0,
      x: render[0],
      z: render[1],
    });
  }
  return records.sort((first, second) => first.codeInsee.localeCompare(second.codeInsee));
}

export function observeFeatures(features: TileFeature[], boundary: BoundaryIndex | null, tileId: string, distanceToRing?: (point: [number, number]) => number): TileObservation {
  const kinds: Record<string, number> = {};
  let roadCount = 0;
  let minorRoadCount = 0;
  let anchorCount = 0;
  let anchorsOutside = 0;
  let onEdgeAnchors = 0;
  let maxAnchorDistanceMetres = 0;
  for (const feature of features) {
    const kind = feature.kind ?? "unknown";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (kind === "road") {
      roadCount += 1;
      const roadClass = feature.roadClass ?? feature.highway ?? "";
      if ((MINOR_ROAD_CLASSES as readonly string[]).includes(roadClass)) minorRoadCount += 1;
    }
    if (feature.x === undefined || feature.z === undefined) continue;
    if (anchorCount < MAX_ANCHORS_PER_TILE) {
      anchorCount += 1;
      if (boundary === null) continue;
      const point: [number, number] = [feature.x, feature.z];
      if (boundary.contains(point)) continue;
      anchorsOutside += 1;
      if (distanceToRing !== undefined) {
        const distance = distanceToRing(point);
        maxAnchorDistanceMetres = Math.max(maxAnchorDistanceMetres, distance);
        if (distance <= BOUNDARY_ON_EDGE_METRES) onEdgeAnchors += 1;
      }
    }
  }
  return {
    tileId,
    kinds,
    anchorCount,
    anchorsOutside,
    onEdgeAnchors,
    minorRoadShare: roadCount === 0 ? 0 : minorRoadCount / roadCount,
    roadCount,
    maxAnchorDistanceMetres,
  };
}

export async function observeTile(
  tile: TileRecord,
  tilesDir: string,
  boundary: BoundaryIndex,
  distanceToRing?: (point: [number, number]) => number,
): Promise<TileObservation> {
  const raw = await fs.readFile(path.join(tilesDir, `${tile.tileId}.json`), "utf8");
  return observeFeatures(JSON.parse(raw) as TileFeature[], boundary, tile.tileId, distanceToRing);
}

export function spreadObservationTargets(tiles: TileRecord[], limit: number): TileRecord[] {
  const buckets = new Map<string, TileRecord[]>();
  for (const tile of tiles) {
    const key = `${Math.floor(tile.bounds[0] / 65536)},${Math.floor(tile.bounds[1] / 65536)}`;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [tile]);
    else list.push(tile);
  }
  const keys = [...buckets.keys()].sort();
  const selected: TileRecord[] = [];
  let cursor = 0;
  while (selected.length < limit && keys.length > 0) {
    const position = cursor % keys.length;
    const list = buckets.get(keys[position]!)!;
    const tile = list.shift();
    if (tile !== undefined) selected.push(tile);
    if (list.length === 0) keys.splice(position, 1);
    cursor += 1;
  }
  return selected;
}

export async function runStratifiedQa(): Promise<StratifiedReport> {
  const generatedDir = path.join(ROOT, "generated");
  const tiles = await readTileManifest(generatedDir);
  const lod0 = tiles.filter((tile) => tile.lod === 0);
  const manifestKinds = await readManifestKinds(generatedDir);
  const datasetVersion = await readDatasetVersion(generatedDir);
  const communes = await readCommunes(path.join(ROOT, "raw"));
  const boundary = await readBoundaryIndex(path.join(ROOT, "raw"));
  const distanceToRing = ringDistanceFunction(await readBoundaryRings(path.join(ROOT, "raw")));

  const edges = densityEdges(lod0.map((tile) => tile.featureCount));
  const wanted = Math.min(lod0.length, MAX_OBSERVATION_TILES * 4);
  const candidates = spreadObservationTargets(lod0, wanted);
  const observations = new Map<string, TileObservation>();
  const missingTileFiles: string[] = [];
  const unreadableTileFiles: string[] = [];
  for (const tile of candidates) {
    if (observations.size >= MAX_OBSERVATION_TILES) break;
    try {
      observations.set(tile.tileId, await observeTile(tile, path.join(generatedDir, "tiles"), boundary, distanceToRing));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        missingTileFiles.push(tile.tileId);
        continue;
      }
      if (error instanceof SyntaxError) {
        unreadableTileFiles.push(tile.tileId);
        continue;
      }
      throw error;
    }
  }

  const sampled = stratifiedSample({
    tiles: lod0,
    communes,
    observations,
    edges,
    targetTiles: SAMPLE_TARGET_TILES,
    targetCommunes: SAMPLE_TARGET_COMMUNES,
    seed: STRATIFIED_SEED,
    manifestKinds,
  });

  const tileById = new Map(lod0.map((tile) => [tile.tileId, tile]));
  const communeByCode = new Map(communes.map((commune) => [commune.codeInsee, commune]));
  const sampledCommunes = sampled.sampledCommunes
    .map((code) => communeByCode.get(code))
    .filter((commune): commune is CommuneRecord => commune !== undefined);
  const communeChecks = sampledCommunes.map((commune) => ({
    codeInsee: commune.codeInsee,
    inside: boundary.contains([commune.x, commune.z]),
  }));

  const sampledSet = new Set(sampled.sampledTiles);
  const onEdgeAnchors = [...observations.values()]
    .filter((observation) => sampledSet.has(observation.tileId))
    .reduce((sum, observation) => sum + observation.onEdgeAnchors, 0);
  const strata: StratifiedReport["strata"] = sampled.strata.map((stratum) =>
    verifyStratum({ stratum, manifestKinds, observations, tiles: tileById, communeChecks, onEdgeAnchors }),
  );

  const tileKindTotals: Record<string, number> = {};
  for (const observation of observations.values()) {
    for (const [kind, count] of Object.entries(observation.kinds)) {
      tileKindTotals[kind] = (tileKindTotals[kind] ?? 0) + count;
    }
  }
  const manifestMissingKinds = CANONICAL_KINDS.filter((kind) => (manifestKinds[kind] ?? 0) === 0);

  const globalFailures: string[] = [];
  if (sampled.sampledTiles.length < SAMPLE_TARGET_TILES) {
    globalFailures.push(`sampled ${sampled.sampledTiles.length} tiles, target ${SAMPLE_TARGET_TILES}`);
  }
  if (sampled.sampledCommunes.length < SAMPLE_TARGET_COMMUNES) {
    globalFailures.push(`sampled ${sampled.sampledCommunes.length} communes, target ${SAMPLE_TARGET_COMMUNES}`);
  }
  if (communes.length === 0) globalFailures.push("no commune records available for settlement stratification");
  if (missingTileFiles.length > 0) {
    globalFailures.push(
      `${missingTileFiles.length} observation candidates are declared in tile-manifest.json but have no file under data/generated/tiles`,
    );
  }
  if (unreadableTileFiles.length > 0) {
    globalFailures.push(
      `${unreadableTileFiles.length} observation candidates could not be parsed as JSON`,
    );
  }
  if (manifestMissingKinds.length > 0) {
    globalFailures.push(`canonical kinds absent dataset-wide: ${manifestMissingKinds.join(", ")}`);
  }
  for (const stratum of strata) {
    for (const failure of stratum.failures) globalFailures.push(`[${stratum.label}] ${failure}`);
  }

  return {
    checkedAt: new Date().toISOString(),
    seed: STRATIFIED_SEED,
    datasetVersion,
    passed: globalFailures.length === 0,
    population: {
      lod0TileCount: lod0.length,
      communeCount: communes.length,
      tileKindTotals,
      manifestKinds,
      manifestMissingKinds: [...manifestMissingKinds],
    },
    sampling: {
      sampledTiles: sampled.sampledTiles.length,
      sampledCommunes: sampled.sampledCommunes.length,
      targetTiles: SAMPLE_TARGET_TILES,
      targetCommunes: SAMPLE_TARGET_COMMUNES,
      observationsRead: observations.size,
      missingTileFiles: missingTileFiles.length,
      missingTileFileExamples: missingTileFiles.slice(0, 20),
      unreadableTileFiles: unreadableTileFiles.length,
      unreadableTileFileExamples: unreadableTileFiles.slice(0, 20),
    },
    strata,
    emptyStrata: strata.filter((stratum) => stratum.sampledTiles === 0).map((stratum) => stratum.key),
    unknownStrata: sampled.unknown.slice(0, 20),
    globalFailures,
  };
}

export async function main(): Promise<void> {
  const report = await runStratifiedQa();
  const qaDir = path.join(ROOT, "qa");
  await fs.mkdir(qaDir, { recursive: true });
  const out = path.join(qaDir, "stratified-report.json");
  await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.error(
    `[qa-stratified] seed=${report.seed} tiles=${report.sampling.sampledTiles}/${report.sampling.targetTiles} communes=${report.sampling.sampledCommunes}/${report.sampling.targetCommunes} strata=${report.strata.length} observed=${report.sampling.observationsRead}`,
  );
  for (const failure of report.globalFailures.slice(0, 25)) console.error(`  - ${failure}`);
  if (report.globalFailures.length > 25) console.error(`  ... ${report.globalFailures.length - 25} more`);
  console.error(`[qa-stratified] wrote ${out} passed=${report.passed}`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("qa-stratified.ts")) {
  main().catch((error: unknown) => {
    console.error("[qa-stratified] Fatal:", error);
    process.exit(1);
  });
}
