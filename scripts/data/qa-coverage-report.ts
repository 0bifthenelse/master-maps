#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import { wgs84ToRender } from "../../src/lib/geo/crs";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";

export const GRID_SIZE = 8;
export const CELL_SAMPLES_PER_AXIS = 8;
export const GERS_DEPARTMENT_CODE = "32";
export const ADOPTED_KINDS = [
  "boundary",
  "building",
  "road",
  "water",
  "landuse",
  "poi",
  "transport",
  "place",
  "address",
  "business",
  "structure",
] as const;
export const IGNORED_CANONICAL_FILES = new Set([
  "provenance.json",
  "boundary-source.json",
  "bdtopo-manifest.json",
  "ign-unavailable.json",
  "osm-manifest.json",
  "osm-bulk-manifest.json",
  "relation-issues.json",
  "normalization-issues.json",
  "auch-boundary-source.json",
  "auch-osm-manifest.json",
]);
const SAMPLES_PER_CELL = CELL_SAMPLES_PER_AXIS * CELL_SAMPLES_PER_AXIS;
const RENDER_TILE_PREFIX_BYTES = 12;
const RENDER_TILE_MAGIC = 0x4d4d5431;

export type AdoptedKind = (typeof ADOPTED_KINDS)[number];
export type Bbox = [number, number, number, number];
export type Point = [number, number];
export type CellId = number;
export type LodCounts = Record<number, number>;
export type KindCounts = Record<string, number>;
export type KindDistributionSource = "tile-manifest" | "render-tiles" | "canonical-records";

export interface SlimTileValue {
  tileId: string;
  lod: number;
  bounds: Bbox;
  featureCount: number;
  byteSize: number;
  features?: string[];
}

export interface DatasetManifestSummary {
  datasetVersion: string;
  territoryCode: string;
  bounds: Bbox;
  featureCounts: KindCounts;
  tileCount: number;
}

export interface RenderTileEntry {
  id: string;
  kind: string;
  anchor: Point;
}

export interface RenderTileSummary {
  tileId: string;
  lod: number;
  bounds: Bbox;
  bytes: number;
  kinds: KindCounts;
  uniqueFeatures: number;
  entries: RenderTileEntry[];
}

export interface TileCounts {
  declared: number;
  byLod: LodCounts;
  canonicalFeatureIdsDeclared: number;
  manifestBytes: number;
  renderFilesOnDisk: number;
  renderBytesOnDisk: number;
  lod0Declared: number;
  lod0RenderTilesOnDisk: number;
  lod0DeclaredMissingOnDisk: number;
  renderTilesWithoutDeclaration: number;
  renderTilesDecoded: number;
  renderTilesUndecodable: number;
}

export type MissingReason =
  | { type: "no-tiles-declared"; renderTilesOnDisk: number }
  | { type: "tile-absent"; declaredTiles: number; renderTilesOnDisk: 0 }
  | { type: "kind-absent-in-distributed-features"; declaredTiles: number; renderTilesOnDisk: number; uniqueFeaturesInCell: number };

export interface MissingEntry {
  kind: AdoptedKind;
  reason: MissingReason;
}

export interface CellReport {
  cell: CellId;
  label: string;
  bounds: Bbox;
  departmentSamplePoints: number;
  declaredTiles: number;
  renderTilesOnDisk: number;
  uniqueFeatures: number;
  counts: KindCounts;
  presentKinds: AdoptedKind[];
  absentKinds: AdoptedKind[];
  absentKindsWithoutTiles: AdoptedKind[];
  missing: MissingEntry[];
}

export interface Percentiles {
  count: number;
  totalBytes: number;
  minBytes: number;
  p25Bytes: number;
  p50Bytes: number;
  p75Bytes: number;
  p90Bytes: number;
  p95Bytes: number;
  p99Bytes: number;
  maxBytes: number;
  meanBytes: number;
}

export interface SearchabilityEntry {
  kind: string;
  canonical: number;
  searchable: number;
  ratio: number;
}

export interface Verdict {
  passed: boolean;
  failures: string[];
  missingCells: string[];
  absentKinds: string[];
  unsearchableKinds: string[];
}

export interface CoverageReport {
  checkedAt: string;
  datasetVersion: string;
  grid: {
    size: number;
    cellSize: number;
    bounds: Bbox;
    origin: Point;
    departmentBounds: Bbox | null;
    cellsIntersectingDepartment: number;
    samplesPerCellAxis: number;
    samplesPerCell: number;
  };
  inputs: {
    manifest: string;
    manifestPresent: boolean;
    tileManifest: string;
    coverage: string | null;
    coverageCandidates: string[];
    boundary: string | null;
    renderDir: string;
    searchIndex: string | null;
    searchRecords: number;
    kindDistributionSource: KindDistributionSource;
    canonicalDir: string | null;
    canonicalFiles: number;
    canonicalBytes: number;
    canonicalRecordsRead: number;
    canonicalFilesMalformed: number;
  };
  tiles: TileCounts;
  kinds: {
    canonical: KindCounts;
    canonicalSource: string;
    adoptedKindTotals: KindCounts;
    cellsWithKind: Record<string, number>;
    renderTileKinds: KindCounts;
  };
  cells: CellReport[];
  lod0Payload: Percentiles;
  lod0PayloadTiles: { smallest: string; largest: string };
  searchability: {
    indexRecords: number;
    perKind: SearchabilityEntry[];
  };
  verdicts: Verdict;
}

export interface DepartmentGrid {
  flags: Uint8Array;
  samplePointsPerCell: number[];
  intersectingCells: number;
  departmentBounds: Bbox;
}

export interface PresenceInput {
  cell: CellId;
  label: string;
  bounds: Bbox;
  departmentSamplePoints: number;
  declaredTiles: number;
  renderTilesOnDisk: number;
  uniqueFeatures: number;
  counts: KindCounts;
}

export interface FeatureScratch {
  id: string;
  kind: string;
  lon: number | null;
  lat: number | null;
  x: number | null;
  z: number | null;
}

export interface CanonicalScan {
  files: number;
  bytes: number;
  malformed: number;
  records: number;
}

export interface SearchCounts {
  present: boolean;
  total: number;
  perKind: KindCounts;
}

export interface RunOptions {
  dataRoot: string;
  manifestPath?: string;
  tileManifestPath?: string;
  coverageCandidates?: string[];
  boundaryDir?: string;
  renderDir?: string;
  searchIndexPath?: string;
  canonicalDir?: string | null;
  departmentGrid?: DepartmentGrid | null;
  boundary?: { index: BoundaryIndex; file: string } | null;
}

const BACKSLASH = 92;
const NEWLINE = 10;
const TAB = 9;
const BRACE_OPEN = 123;
const BRACE_CLOSE = 125;
const QUOTE = 34;
const FIELD_PATTERN = /"(stableId|kind|fragmentId|parentStableId)"\s*:\s*"([^"]*)"|"(lon|lat|x|z)"\s*:\s*(-?[0-9.eE+-]+)/g;
const RENDER_META_PATTERN = /"s"\s*:\s*"([^"]*)"|"k"\s*:\s*"([^"]*)"|"a"\s*:\s*\[\s*(-?[0-9.eE+-]+)\s*,\s*(-?[0-9.eE+-]+)\s*\]/g;

export function baseTileId(tileId: string): string {
  return tileId.replace(/_s\d+_\d+_\d+$/, "");
}

export function gridCellSize(departmentBounds: Bbox, size: number): number {
  const spanX = departmentBounds[2] - departmentBounds[0];
  const spanZ = departmentBounds[3] - departmentBounds[1];
  if (!Number.isFinite(spanX) || !Number.isFinite(spanZ) || spanX <= 0 || spanZ <= 0) return 4096;
  return Math.max(spanX, spanZ) / (size - 1);
}

export function gridIndexOf(point: Point, origin: Point, size: number, cellSize: number): CellId {
  const col = Math.min(size - 1, Math.max(0, Math.floor((point[0] - origin[0]) / cellSize)));
  const row = Math.min(size - 1, Math.max(0, Math.floor((point[1] - origin[1]) / cellSize)));
  return row * size + col;
}

export function cellBounds(cell: CellId, origin: Point, size: number, cellSize: number): Bbox {
  const col = cell % size;
  const row = Math.floor(cell / size);
  return [origin[0] + col * cellSize, origin[1] + row * cellSize, origin[0] + (col + 1) * cellSize, origin[1] + (row + 1) * cellSize];
}

export function cellLabel(cell: CellId, size: number): string {
  return `r${Math.floor(cell / size)}c${cell % size}`;
}

export function featureKind(featureId: string): string | null {
  const separator = featureId.indexOf(":");
  return separator <= 0 ? null : featureId.slice(0, separator);
}


export function quantileSorted(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(Math.max(fraction, 0), 1) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  const weight = position - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

export function buildPercentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((first, second) => first - second);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    totalBytes: total,
    minBytes: quantileSorted(sorted, 0),
    p25Bytes: quantileSorted(sorted, 0.25),
    p50Bytes: quantileSorted(sorted, 0.5),
    p75Bytes: quantileSorted(sorted, 0.75),
    p90Bytes: quantileSorted(sorted, 0.9),
    p95Bytes: quantileSorted(sorted, 0.95),
    p99Bytes: quantileSorted(sorted, 0.99),
    maxBytes: quantileSorted(sorted, 1),
    meanBytes: sorted.length === 0 ? 0 : total / sorted.length,
  };
}

export function countEntriesByKind(entries: ReadonlyMap<string, string>): { counts: KindCounts; unique: number } {
  const counts: KindCounts = {};
  for (const [, kind] of entries) {
    if (kind.length === 0) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return { counts, unique: entries.size };
}

export function absentReason(input: PresenceInput): MissingReason {
  if (input.declaredTiles === 0) return { type: "no-tiles-declared", renderTilesOnDisk: input.renderTilesOnDisk };
  if (input.renderTilesOnDisk === 0) return { type: "tile-absent", declaredTiles: input.declaredTiles, renderTilesOnDisk: 0 };
  return {
    type: "kind-absent-in-distributed-features",
    declaredTiles: input.declaredTiles,
    renderTilesOnDisk: input.renderTilesOnDisk,
    uniqueFeaturesInCell: input.uniqueFeatures,
  };
}

export function buildCellReport(input: PresenceInput): CellReport {
  const counts: KindCounts = {};
  for (const kind of ADOPTED_KINDS) counts[kind] = input.counts[kind] ?? 0;
  for (const [kind, value] of Object.entries(input.counts)) if (!(kind in counts)) counts[kind] = value;
  const presentKinds = ADOPTED_KINDS.filter((kind) => (counts[kind] ?? 0) > 0);
  const absentKinds = ADOPTED_KINDS.filter((kind) => (counts[kind] ?? 0) === 0);
  return {
    cell: input.cell,
    label: input.label,
    bounds: input.bounds,
    departmentSamplePoints: input.departmentSamplePoints,
    declaredTiles: input.declaredTiles,
    renderTilesOnDisk: input.renderTilesOnDisk,
    uniqueFeatures: input.uniqueFeatures,
    counts,
    presentKinds: [...presentKinds],
    absentKinds: [...absentKinds],
    absentKindsWithoutTiles: absentKinds.filter((kind) => input.renderTilesOnDisk === 0),
    missing: absentKinds.map((kind) => ({ kind, reason: absentReason(input) })),
  };
}

export function computeVerdicts(input: {
  cells: CellReport[];
  canonicalByKind: KindCounts;
  searchability: SearchabilityEntry[];
}): Verdict {
  const missingCells = input.cells
    .filter((cell) => cell.departmentSamplePoints > 0 && cell.renderTilesOnDisk === 0)
    .map((cell) => cell.label);
  const absentKinds = ADOPTED_KINDS.filter((kind) => (input.canonicalByKind[kind] ?? 0) === 0);
  const unsearchableKinds = input.searchability
    .filter((entry) => entry.canonical > 0 && entry.ratio === 0)
    .map((entry) => entry.kind);
  const failures: string[] = [];
  for (const cell of input.cells) {
    if (cell.departmentSamplePoints <= 0 || cell.renderTilesOnDisk > 0) continue;
    failures.push(
      `grid cell ${cell.label} intersects the department (${cell.departmentSamplePoints}/${SAMPLES_PER_CELL} sample points inside) but has 0 tiles on disk out of ${cell.declaredTiles} declared`,
    );
  }
  for (const kind of absentKinds) failures.push(`adopted kind "${kind}" is absent dataset-wide (0 canonical features)`);
  for (const kind of unsearchableKinds) {
    const entry = input.searchability.find((candidate) => candidate.kind === kind);
    failures.push(
      `kind "${kind}" has a searchability ratio of 0 (${entry?.searchable ?? 0} of ${entry?.canonical ?? 0} canonical features searchable)`,
    );
  }
  return { passed: failures.length === 0, failures, missingCells, absentKinds: [...absentKinds], unsearchableKinds };
}

export function buildDepartmentGrid(options: {
  boundary: BoundaryIndex;
  origin: Point;
  size: number;
  cellSize: number;
  samplesPerCellAxis: number;
}): DepartmentGrid {
  const { boundary, origin, size, cellSize, samplesPerCellAxis } = options;
  const flags = new Uint8Array(size * size);
  const samplePointsPerCell = new Array<number>(size * size).fill(0);
  const departmentBounds: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let intersectingCells = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      let inside = 0;
      for (let sy = 0; sy < samplesPerCellAxis; sy += 1) {
        const z = origin[1] + (row + (sy + 0.5) / samplesPerCellAxis) * cellSize;
        for (let sx = 0; sx < samplesPerCellAxis; sx += 1) {
          const x = origin[0] + (col + (sx + 0.5) / samplesPerCellAxis) * cellSize;
          if (!boundary.contains([x, z])) continue;
          inside += 1;
          if (x < departmentBounds[0]) departmentBounds[0] = x;
          if (z < departmentBounds[1]) departmentBounds[1] = z;
          if (x > departmentBounds[2]) departmentBounds[2] = x;
          if (z > departmentBounds[3]) departmentBounds[3] = z;
        }
      }
      const cell = row * size + col;
      samplePointsPerCell[cell] = inside;
      if (inside > 0) {
        flags[cell] = 1;
        intersectingCells += 1;
      }
    }
  }
  if (intersectingCells === 0) return { flags, samplePointsPerCell, intersectingCells, departmentBounds: [0, 0, 0, 0] };
  return { flags, samplePointsPerCell, intersectingCells, departmentBounds };
}

export function decodeRenderTileMeta(buffer: ArrayBuffer): { tileId: string; lod: number; bounds: Bbox; entries: Array<{ id: string; kind: string; anchor: Point }> } | null {
  if (buffer.byteLength < RENDER_TILE_PREFIX_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== RENDER_TILE_MAGIC) return null;
  const headerBytes = view.getUint32(8, true);
  const payloadStart = RENDER_TILE_PREFIX_BYTES + headerBytes;
  if (headerBytes === 0 || payloadStart > buffer.byteLength) return null;
  let header: { tileId?: string; lod?: number; bounds?: Bbox; featureMetaOffset?: number; featureMetaBytes?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, RENDER_TILE_PREFIX_BYTES, headerBytes))) as typeof header;
  } catch {
    return null;
  }
  const entries: Array<{ id: string; kind: string; anchor: Point }> = [];
  const metaOffset = payloadStart + (header.featureMetaOffset ?? 0);
  const metaBytes = header.featureMetaBytes ?? 0;
  if (metaBytes > 0 && metaOffset + metaBytes <= buffer.byteLength) {
    const text = new TextDecoder().decode(new Uint8Array(buffer, metaOffset, metaBytes));
    RENDER_META_PATTERN.lastIndex = 0;
    let id = "";
    let kind = "";
    let anchor: Point = [0, 0];
    for (let match = RENDER_META_PATTERN.exec(text); match !== null; match = RENDER_META_PATTERN.exec(text)) {
      if (match[1] !== undefined) id = match[1];
      else if (match[2] !== undefined) kind = match[2];
      else {
        anchor = [Number(match[3]), Number(match[4])];
        entries.push({ id, kind, anchor });
        id = "";
        kind = "";
      }
    }
  }
  return { tileId: String(header.tileId ?? ""), lod: Number(header.lod ?? 0), bounds: (header.bounds ?? [0, 0, 0, 0]) as Bbox, entries };
}

function absorbFeatureObject(object: string, scratch: FeatureScratch): void {
  FIELD_PATTERN.lastIndex = 0;
  for (let match = FIELD_PATTERN.exec(object); match !== null; match = FIELD_PATTERN.exec(object)) {
    const key = match[1] ?? match[3];
    if (key === "stableId") {
      if (scratch.id.length === 0) scratch.id = match[2] ?? "";
    } else if (key === "kind") {
      if (scratch.kind.length === 0) scratch.kind = match[2] ?? "";
    } else if (key === "lon") {
      if (scratch.lon === null) scratch.lon = Number(match[4]);
    } else if (key === "lat") {
      if (scratch.lat === null) scratch.lat = Number(match[4]);
    } else if (key === "x") {
      if (scratch.x === null) scratch.x = Number(match[4]);
    } else if (key === "z") {
      if (scratch.z === null) scratch.z = Number(match[4]);
    }
  }
}

export async function streamCanonicalFeatures(
  directory: string,
  onFeature: (feature: FeatureScratch) => void,
): Promise<CanonicalScan> {
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !IGNORED_CANONICAL_FILES.has(entry.name))
    .sort((first, second) => first.name.localeCompare(second.name));
  const scan: CanonicalScan = { files: 0, bytes: 0, malformed: 0, records: 0 };
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat === null) continue;
    scan.files += 1;
    scan.bytes += stat.size;
    const stream = (await fs.open(filePath, "r")).createReadStream({ highWaterMark: 4 << 20 });
    const scratch: FeatureScratch = { id: "", kind: "", lon: null, lat: null, x: null, z: null };
    let object = "";
    let depth = 0;
    let inString = false;
    let escaped = false;
    let truncated = false;
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      for (let index = 0; index < buffer.length && !truncated; index += 1) {
        const byte = buffer[index]!;
        if (inString) {
          object += String.fromCharCode(byte);
          if (escaped) escaped = false;
          else if (byte === BACKSLASH) escaped = true;
          else if (byte === QUOTE) inString = false;
          continue;
        }
        if (byte === QUOTE) {
          inString = true;
          object += '"';
          continue;
        }
        if (byte === BRACE_OPEN) {
          if (depth === 0) {
            object = "";
            scratch.id = "";
            scratch.kind = "";
            scratch.lon = null;
            scratch.lat = null;
            scratch.x = null;
            scratch.z = null;
          }
          depth += 1;
          object += "{";
          continue;
        }
        if (byte === BRACE_CLOSE) {
          if (depth === 0) {
            truncated = true;
            break;
          }
          depth -= 1;
          object += "}";
          if (depth === 0) {
            absorbFeatureObject(object, scratch);
            scan.records += 1;
            onFeature(scratch);
          }
          continue;
        }
        if (byte === NEWLINE || byte === TAB) continue;
        object += String.fromCharCode(byte);
      }
    }
    if (depth !== 0 || inString || truncated) scan.malformed += 1;
  }
  return scan;
}

export async function readSearchCounts(filePath: string): Promise<SearchCounts> {
  const perKind: KindCounts = {};
  let total = 0;
  const present = (await fs.stat(filePath).catch(() => null)) !== null;
  if (!present) return { present: false, total: 0, perKind };
  const stream = (await fs.open(filePath, "r")).createReadStream({ encoding: "utf8", highWaterMark: 1 << 20 });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const record = line.trim().replace(/,$/, "");
    if (!record.startsWith("{")) continue;
    let kind: unknown;
    try {
      kind = (JSON.parse(record) as { kind?: unknown }).kind;
    } catch {
      continue;
    }
    if (typeof kind !== "string") continue;
    perKind[kind] = (perKind[kind] ?? 0) + 1;
    total += 1;
  }
  return { present: true, total, perKind };
}

export async function readTileManifest(filePath: string): Promise<{ tiles: SlimTileValue[]; bytes: number }> {
  const raw = await fs.readFile(filePath, "utf8");
  return { tiles: JSON.parse(raw) as SlimTileValue[], bytes: Buffer.byteLength(raw) };
}

export async function readDatasetManifest(filePath: string): Promise<DatasetManifestSummary | null> {
  const parsed = await fs
    .readFile(filePath, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => null);
  if (parsed === null) return null;
  const tileIds = parsed["tileIds"];
  return {
    datasetVersion: String(parsed["datasetVersion"] ?? "unknown"),
    territoryCode: String(parsed["territoryCode"] ?? ""),
    bounds: (parsed["bounds"] ?? [0, 0, 0, 0]) as Bbox,
    featureCounts: (parsed["featureCounts"] ?? {}) as KindCounts,
    tileCount: Number(parsed["tileCount"] ?? (Array.isArray(tileIds) ? tileIds.length : 0)),
  };
}

export async function readCoverageFeatureCounts(candidates: string[]): Promise<{ path: string | null; featureCounts: KindCounts }> {
  for (const candidate of candidates) {
    const parsed = await fs
      .readFile(candidate, "utf8")
      .then((raw) => JSON.parse(raw) as Record<string, unknown>)
      .catch(() => null);
    const featureCounts = parsed?.["featureCounts"];
    if (featureCounts === undefined || featureCounts === null) continue;
    return { path: candidate, featureCounts: featureCounts as KindCounts };
  }
  return { path: null, featureCounts: {} };
}

export async function readBoundaryIndex(rawDir: string): Promise<{ index: BoundaryIndex; file: string } | null> {
  for (const name of ["gers-boundary.geojson", "auch-boundary.geojson"]) {
    const filePath = path.join(rawDir, name);
    const parsed = await fs
      .readFile(filePath, "utf8")
      .then((raw) => JSON.parse(raw) as { features?: Array<{ geometry?: { type?: string; coordinates?: number[][][][] } }> })
      .catch(() => null);
    const geometry = parsed?.features?.[0]?.geometry;
    if (geometry === undefined || !Array.isArray(geometry.coordinates)) continue;
    const rings = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
    const projected = rings.map((polygon) =>
      polygon.map((ring) =>
        ring.map((point) => {
          const render = wgs84ToRender([point[0]!, point[1]!]);
          return [render[0], render[1]] as Point;
        }),
      ),
    );
    const bounds: Bbox = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of projected) {
      for (const ring of polygon) {
        for (const point of ring) {
          if (point[0] < bounds[0]) bounds[0] = point[0];
          if (point[1] < bounds[1]) bounds[1] = point[1];
          if (point[0] > bounds[2]) bounds[2] = point[0];
          if (point[1] > bounds[3]) bounds[3] = point[1];
        }
      }
    }
    return { index: createBoundaryIndex(projected), file: filePath, bounds };
  }
  return null;
}

export async function readRenderTiles(renderDir: string): Promise<{ bytes: Map<string, number>; tiles: RenderTileSummary[]; undecodable: number }> {
  const bytes = new Map<string, number>();
  const tiles: RenderTileSummary[] = [];
  const names = (await fs.readdir(renderDir).catch(() => [] as string[])).sort();
  let undecodable = 0;
  for (const name of names) {
    if (!name.endsWith(".mmt")) continue;
    const tileId = name.slice(0, -4);
    const filePath = path.join(renderDir, name);
    const buffer = await fs.readFile(filePath).then((raw) => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer).catch(() => null);
    if (buffer === null) {
      undecodable += 1;
      continue;
    }
    bytes.set(tileId, buffer.byteLength);
    const decoded = decodeRenderTileMeta(buffer);
    if (decoded === null) {
      undecodable += 1;
      continue;
    }
    const byId = new Map(decoded.entries.map((entry) => [entry.id, entry.kind]));
    const { counts, unique } = countEntriesByKind(byId);
    tiles.push({ tileId, lod: decoded.lod, bounds: decoded.bounds, bytes: buffer.byteLength, kinds: counts, uniqueFeatures: unique, entries: decoded.entries });
  }
  return { bytes, tiles, undecodable };
}

export async function runCoverageReport(options: RunOptions): Promise<CoverageReport> {
  const { dataRoot } = options;
  const generatedDir = path.join(dataRoot, "generated");
  const manifestPath = options.manifestPath ?? path.join(generatedDir, "manifest.json");
  const tileManifestPath = options.tileManifestPath ?? path.join(generatedDir, "tile-manifest.json");
  const coverageCandidates = options.coverageCandidates ?? [
    path.join(dataRoot, "qa", "coverage.json"),
    path.join(dataRoot, "manifests", "coverage.json"),
    path.join(generatedDir, "manifests", "coverage.json"),
    path.join(generatedDir, "coverage.json"),
  ];
  const boundaryDir = options.boundaryDir ?? path.join(dataRoot, "raw");
  const renderDir = options.renderDir ?? path.join(generatedDir, "render");
  const searchIndexPath = options.searchIndexPath ?? path.join(dataRoot, "search", "index.json");
  const canonicalDir = options.canonicalDir === undefined ? path.join(dataRoot, "intermediate") : options.canonicalDir;

  const manifest = await readDatasetManifest(manifestPath);
  const coverage = await readCoverageFeatureCounts(coverageCandidates);
  const { tiles, bytes: manifestBytes } = await readTileManifest(tileManifestPath);
  const boundary = options.boundary === undefined ? await readBoundaryIndex(boundaryDir) : options.boundary;
  const render = await readRenderTiles(renderDir);
  const search = await readSearchCounts(searchIndexPath);

  const departmentBounds: Bbox = boundary?.bounds ?? ([-70231.9302214493, -42730.09092569724, 49458.569977949606, 42748.00865555834] as Bbox);
  const origin: Point = [departmentBounds[0], departmentBounds[1]];
  const cellSize = gridCellSize(departmentBounds, GRID_SIZE);
  const gridBounds: Bbox = [origin[0], origin[1], origin[0] + GRID_SIZE * cellSize, origin[1] + GRID_SIZE * cellSize];
  const department = options.departmentGrid
    ?? (boundary === null
      ? null
      : buildDepartmentGrid({ boundary: boundary.index, origin, size: GRID_SIZE, cellSize, samplesPerCellAxis: CELL_SAMPLES_PER_AXIS }));

  const cellCount = GRID_SIZE * GRID_SIZE;
  const declaredTiles = new Int32Array(cellCount);
  const renderTilesOnDisk = new Int32Array(cellCount);
  const entriesByCell = new Map<CellId, Map<string, string>>();
  const byLod: LodCounts = {};
  const tileCell = new Map<string, CellId>();
  for (const tile of tiles) {
    byLod[tile.lod] = (tile.lod in byLod ? byLod[tile.lod]! : 0) + 1;
    if (tile.lod !== 0) continue;
    const cell = gridIndexOf([(tile.bounds[0] + tile.bounds[2]) / 2, (tile.bounds[1] + tile.bounds[3]) / 2], origin, GRID_SIZE, cellSize);
    declaredTiles[cell] += 1;
    tileCell.set(tile.tileId, cell);
  }
  const baseCell = new Map<string, CellId>();
  for (const [tileId, cell] of tileCell) baseCell.set(baseTileId(tileId), cell);
  for (const tileId of render.bytes.keys()) {
    const cell = baseCell.get(baseTileId(tileId));
    if (cell !== undefined) renderTilesOnDisk[cell] += 1;
  }

  const kindDistributionSource: KindDistributionSource = render.tiles.length > 0 ? "render-tiles" : "canonical-records";
  const scan: CanonicalScan = { files: 0, bytes: 0, malformed: 0, records: 0 };
  if (canonicalDir !== null) {
    const result = await streamCanonicalFeatures(canonicalDir, (feature) => {
      if (feature.kind.length === 0 || feature.id.length === 0) return;
      const point = feature.lon !== null && feature.lat !== null
        ? wgs84ToRender([feature.lon, feature.lat])
        : feature.x !== null && feature.z !== null
          ? ([feature.x, feature.z] as Point)
          : null;
      if (point === null) return;
      const cell = gridIndexOf(point, origin, GRID_SIZE, cellSize);
      const map = entriesByCell.get(cell) ?? new Map<string, string>();
      map.set(feature.id, feature.kind);
      entriesByCell.set(cell, map);
    });
    scan.files = result.files;
    scan.bytes = result.bytes;
    scan.malformed = result.malformed;
    scan.records = result.records;
  }
  for (const tile of render.tiles) {
    if (tile.lod !== 0) continue;
    for (const entry of tile.entries) {
      const cell = gridIndexOf(entry.anchor, origin, GRID_SIZE, cellSize);
      const map = entriesByCell.get(cell) ?? new Map<string, string>();
      if (!map.has(entry.id)) map.set(entry.id, entry.kind);
      entriesByCell.set(cell, map);
    }
  }


  const canonical: KindCounts = coverage.path === null ? {} : { ...coverage.featureCounts };
  if (manifest !== null) for (const [kind, count] of Object.entries(manifest.featureCounts)) canonical[kind] = Math.max(canonical[kind] ?? 0, count);
  for (const kind of ADOPTED_KINDS) if (canonical[kind] === undefined) canonical[kind] = 0;

  const cells: CellReport[] = [];
  const cellsWithKind: KindCounts = {};
  const renderTileKinds: KindCounts = {};
  for (const tile of render.tiles) for (const [kind, count] of Object.entries(tile.kinds)) renderTileKinds[kind] = (renderTileKinds[kind] ?? 0) + count;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if ((department?.flags[cell] ?? 0) === 0) continue;
    const distribution = countEntriesByKind(entriesByCell.get(cell) ?? new Map<string, string>());
    for (const [kind, count] of Object.entries(distribution.counts)) if (count > 0) cellsWithKind[kind] = (cellsWithKind[kind] ?? 0) + 1;
    cells.push(buildCellReport({
      cell,
      label: cellLabel(cell, GRID_SIZE),
      bounds: cellBounds(cell, origin, GRID_SIZE, cellSize),
      departmentSamplePoints: department?.samplePointsPerCell[cell] ?? 0,
      declaredTiles: declaredTiles[cell] ?? 0,
      renderTilesOnDisk: renderTilesOnDisk[cell] ?? 0,
      uniqueFeatures: distribution.unique,
      counts: distribution.counts,
    }));
  }

  const lod0Pairs: Array<[string, number]> = [];
  for (const [tileId, size] of render.bytes) if (/^l0_/.test(tileId)) lod0Pairs.push([tileId, size]);
  lod0Pairs.sort((first, second) => first[1] - second[1]);
  const lod0Declared = byLod[0] ?? 0;

  const kinds = [...new Set([...Object.keys(canonical), ...Object.keys(search.perKind), ...ADOPTED_KINDS])].sort();
  const perKind: SearchabilityEntry[] = kinds.map((kind) => {
    const count = canonical[kind] ?? 0;
    const searchable = search.perKind[kind] ?? 0;
    return { kind, canonical: count, searchable, ratio: count === 0 ? 0 : searchable / count };
  });

  const report: CoverageReport = {
    checkedAt: new Date().toISOString(),
    datasetVersion: manifest?.datasetVersion ?? "unknown",
    grid: {
      size: GRID_SIZE,
      cellSize,
      bounds: gridBounds,
      origin,
      departmentBounds: boundary?.bounds ?? null,
      cellsIntersectingDepartment: department?.intersectingCells ?? 0,
      samplesPerCellAxis: CELL_SAMPLES_PER_AXIS,
      samplesPerCell: SAMPLES_PER_CELL,
    },
    inputs: {
      manifest: manifestPath,
      manifestPresent: manifest !== null,
      tileManifest: tileManifestPath,
      coverage: coverage.path,
      coverageCandidates,
      boundary: boundary?.file ?? null,
      renderDir,
      searchIndex: search.present ? searchIndexPath : null,
      searchRecords: search.total,
      kindDistributionSource,
      canonicalDir: scan.files > 0 ? canonicalDir : null,
      canonicalFiles: scan.files,
      canonicalBytes: scan.bytes,
      canonicalRecordsRead: scan.records,
      canonicalFilesMalformed: scan.malformed,
    },
    tiles: {
      declared: tiles.length,
      byLod,
      canonicalFeatureIdsDeclared: tiles.reduce((sum, tile) => sum + (tile.features?.length ?? 0), 0),
      manifestBytes,
      renderFilesOnDisk: render.bytes.size,
      renderBytesOnDisk: [...render.bytes.values()].reduce((sum, value) => sum + value, 0),
      lod0Declared,
      lod0RenderTilesOnDisk: lod0Pairs.length,
      lod0DeclaredMissingOnDisk: lod0Declared - lod0Pairs.length,
      renderTilesWithoutDeclaration: [...render.bytes.keys()].filter((tileId) => !baseCell.has(baseTileId(tileId))).length,
      renderTilesDecoded: render.tiles.length,
      renderTilesUndecodable: render.undecodable,
    },
    kinds: {
      canonical,
      canonicalSource: coverage.path ?? (manifest === null ? "none" : manifestPath),
      adoptedKindTotals: Object.fromEntries(ADOPTED_KINDS.map((kind) => [kind, canonical[kind] ?? 0])),
      cellsWithKind,
      renderTileKinds,
    },
    cells,
    lod0Payload: buildPercentiles(lod0Pairs.map(([, size]) => size)),
    lod0PayloadTiles: { smallest: lod0Pairs[0]?.[0] ?? "", largest: lod0Pairs[lod0Pairs.length - 1]?.[0] ?? "" },
    searchability: { indexRecords: search.total, perKind },
    verdicts: { passed: true, failures: [], missingCells: [], absentKinds: [], unsearchableKinds: [] },
  };
  report.verdicts = computeVerdicts({ cells, canonicalByKind: canonical, searchability: perKind });
  return report;
}

export async function main(): Promise<void> {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  const report = await runCoverageReport({ dataRoot });
  const qaDir = path.join(dataRoot, "qa");
  await fs.mkdir(qaDir, { recursive: true });
  const out = path.join(qaDir, "coverage-report.json");
  await fs.writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.error(
    `[qa-coverage] datasetVersion=${report.datasetVersion} declaredTiles=${report.tiles.declared} renderTilesOnDisk=${report.tiles.renderFilesOnDisk} kindSource=${report.inputs.kindDistributionSource}`,
  );
  console.error(
    `[qa-coverage] cellSize=${report.grid.cellSize} cells=${report.cells.length}/${GRID_SIZE * GRID_SIZE} departmentCells=${report.grid.cellsIntersectingDepartment} lod0mmt=${report.lod0Payload.count}/${report.tiles.lod0Declared} searchRecords=${report.searchability.indexRecords}`,
  );
  for (const cell of report.cells) {
    console.error(
      `  cell ${cell.label} declared=${cell.declaredTiles} onDisk=${cell.renderTilesOnDisk} features=${cell.uniqueFeatures} kinds=${cell.presentKinds.length}/${ADOPTED_KINDS.length} absent=[${cell.absentKinds.join(",")}]`,
    );
  }
  for (const entry of report.searchability.perKind) {
    console.error(`  kind ${entry.kind} canonical=${entry.canonical} searchable=${entry.searchable} ratio=${entry.ratio.toFixed(4)} cells=${report.kinds.cellsWithKind[entry.kind] ?? 0}`);
  }
  console.error(
    `[qa-coverage] lod0 p25=${report.lod0Payload.p25Bytes} p50=${report.lod0Payload.p50Bytes} p95=${report.lod0Payload.p95Bytes} max=${report.lod0Payload.maxBytes}`,
  );
  for (const failure of report.verdicts.failures.slice(0, 40)) console.error(`  FAIL ${failure}`);
  if (report.verdicts.failures.length > 40) console.error(`  ... ${report.verdicts.failures.length - 40} more failures`);
  console.error(`[qa-coverage] wrote ${out} passed=${report.verdicts.passed}`);
  if (!report.verdicts.passed) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("qa-coverage-report.ts")) {
  main().catch((error: unknown) => {
    console.error("[qa-coverage] Fatal:", error);
    process.exit(1);
  });
}
