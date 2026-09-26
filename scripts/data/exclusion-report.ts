#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";

export type ExclusionReason = string;
export type DropCounter = { count: number; reason: string };

export interface RuleExclusion {
  rule: string;
  count: number;
  reason: string;
}

export interface SourceLayerAccounting {
  key: string;
  source: string;
  layer: string;
  kind: string;
  input: number;
  accepted: number;
  observedAccepted: number;
  mergedDeduplicated: number;
  clippedFragments: number;
  excludedByRule: RuleExclusion[];
  invalidGeometry: number;
  outsideBoundary: number;
  observedDelta: number;
  unexplained: number;
}

export interface StageDropAccounting {
  stage: string;
  reason: string;
  count: number;
  detail: string;
}

export interface ExclusionTotals {
  input: number;
  accepted: number;
  mergedDeduplicated: number;
  clippedFragments: number;
  excluded: number;
  invalidGeometry: number;
  outsideBoundary: number;
  unexplained: number;
}

export interface ExclusionReport {
  dataset: "exclusion-report";
  generatedAt: string;
  dataRoot: string;
  coveragePath: string;
  coverageAcquisitionTime: string | null;
  sources: SourceLayerAccounting[];
  stages: StageDropAccounting[];
  totals: ExclusionTotals;
  invariants: {
    balanced: boolean;
    unexplainedTotal: number;
    layersUnbalanced: string[];
    stagesUndeclared: string[];
  };
}

export class ExclusionAccountingError extends Error {
  constructor(message: string, readonly report: ExclusionReport) {
    super(message);
    this.name = "ExclusionAccountingError";
  }
}

export interface Classification {
  excluded?: ExclusionReason;
  excludedCount?: number;
  invalidGeometry?: number;
  outsideBoundary?: number;
  clipped?: boolean;
}

export interface DropSink {
  drop(stage: string, reason: ExclusionReason, count: number, detail?: string): void;
}

export interface SourceAccounting {
  record(source: string, layer: string, kind: string, input: number, accepted: number, classification?: Classification): void;
  recordMerged(source: string, layer: string, kind: string, mergedDeduplicated: number): void;
  rows(): SourceLayerAccounting[];
}

export interface CoverageReconciliation {
  generatedAt: string;
  canonicalTotal: number;
  coverageTotal: number;
  coverageFeatureCountSum: number;
  tileFragmentTotal: number;
  kindsCanonical: Record<string, number>;
  kindsCoverage: Record<string, number>;
  kindsMatched: string[];
  kindsUnmatched: string[];
  totalReconciled: boolean;
  unexplained: number;
  tileFragmentsAreClippedCopies: true;
}

export interface CanonicalFeatureLike {
  kind: string;
}

export const CANONICAL_SOURCE = "canonical";


export function createDropSink(): DropSink {
  const dropped = new Map<string, StageDropAccounting>();
  return {
    drop(stage, reason, count, detail = ""): void {
      if (!Number.isFinite(count) || count === 0) return;
      const key = `${stage}|${reason}`;
      const existing = dropped.get(key);
      if (existing === undefined) {
        dropped.set(key, { stage, reason, count, detail });
        return;
      }
      existing.count += count;
      if (detail.length > 0 && !existing.detail.includes(detail)) existing.detail = `${existing.detail}; ${detail}`.slice(0, 2000);
    },
  };
}

export function createSourceAccounting(): SourceAccounting {
  const store = new Map<string, SourceLayerAccounting>();
  const ruleExcluded = (row: SourceLayerAccounting): number => row.excludedByRule.reduce((sum, entry) => sum + entry.count, 0);
  const explained = (row: SourceLayerAccounting): number => row.accepted + ruleExcluded(row) + row.invalidGeometry + row.outsideBoundary;
  const order = (first: SourceLayerAccounting, second: SourceLayerAccounting): number =>
    first.source === second.source
      ? first.layer === second.layer
        ? first.kind.localeCompare(second.kind)
        : first.layer.localeCompare(second.layer)
      : first.source.localeCompare(second.source);
  const row = (source: string, layer: string, kind: string): SourceLayerAccounting => {
    const key = `${source}::${layer}::${kind}`;
    const existing = store.get(key);
    if (existing !== undefined) return existing;
    const created: SourceLayerAccounting = {
      key,
      source,
      layer,
      kind,
      input: 0,
      accepted: 0,
      observedAccepted: 0,
      mergedDeduplicated: 0,
      clippedFragments: 0,
      excludedByRule: [],
      invalidGeometry: 0,
      outsideBoundary: 0,
      observedDelta: 0,
      unexplained: 0,
    };
    store.set(key, created);
    return created;
  };
  const addRule = (target: SourceLayerAccounting, rule: string, count: number, reason: string): void => {
    if (count <= 0) return;
    const existing = target.excludedByRule.find((entry) => entry.rule === rule);
    if (existing === undefined) {
      target.excludedByRule.push({ rule, count, reason });
      return;
    }
    existing.count += count;
    if (reason.length > 0) existing.reason = reason;
  };
  return {
    record(source, layer, kind, input, accepted, classification = {}): void {
      const target = row(source, layer, kind);
      const excludedCount = classification.excludedCount ?? (classification.excluded === undefined ? 0 : input - accepted);
      if (classification.excluded !== undefined) addRule(target, classification.excluded, excludedCount, classification.excluded);
      target.invalidGeometry += classification.invalidGeometry ?? 0;
      target.outsideBoundary += classification.outsideBoundary ?? 0;
      if (classification.clipped === true) target.clippedFragments += 1;
      target.input += input;
      target.accepted += accepted;
      target.observedAccepted += accepted;
      target.observedDelta = target.observedAccepted - target.accepted;
      target.unexplained = target.input > explained(target) ? target.input - explained(target) : 0;
    },
    recordMerged(source, layer, kind, mergedDeduplicated): void {
      if (mergedDeduplicated <= 0) return;
      row(source, layer, kind).mergedDeduplicated += mergedDeduplicated;
    },
    rows(): SourceLayerAccounting[] {
      return [...store.values()].sort(order);
    },
  };
}

function mergeDuplicateRows(rows: SourceLayerAccounting[]): SourceLayerAccounting[] {
  const store = new Map<string, SourceLayerAccounting>();
  for (const candidate of rows) {
    const existing = store.get(candidate.key);
    if (existing === undefined) {
      store.set(candidate.key, { ...candidate, excludedByRule: candidate.excludedByRule.map((entry) => ({ ...entry })) });
      continue;
    }
    existing.input += candidate.input;
    existing.accepted += candidate.accepted;
    existing.observedAccepted += candidate.observedAccepted;
    existing.mergedDeduplicated += candidate.mergedDeduplicated;
    existing.clippedFragments += candidate.clippedFragments;
    existing.invalidGeometry += candidate.invalidGeometry;
    existing.outsideBoundary += candidate.outsideBoundary;
    for (const entry of candidate.excludedByRule) {
      const target = existing.excludedByRule.find((item) => item.rule === entry.rule);
      if (target === undefined) existing.excludedByRule.push({ ...entry });
      else {
        target.count += entry.count;
        if (entry.reason.length > 0) target.reason = entry.reason;
      }
    }
  }
  const rowsMerged = [...store.values()];
  for (const candidate of rowsMerged) {
    const excluded = candidate.excludedByRule.reduce((sum, entry) => sum + entry.count, 0);
    const explained = candidate.accepted + excluded + candidate.invalidGeometry + candidate.outsideBoundary;
    candidate.observedDelta = candidate.observedAccepted - candidate.accepted;
    candidate.unexplained = candidate.input > explained ? candidate.input - explained : 0;
  }
  return rowsMerged.sort((first, second) =>
    first.source === second.source
      ? first.layer === second.layer
        ? first.kind.localeCompare(second.kind)
        : first.layer.localeCompare(second.layer)
      : first.source.localeCompare(second.source));
}

function formatIssueList(values: string[], maximum = 20): string {
  if (values.length === 0) return "none";
  const shown = values.slice(0, maximum).map((value) => `"${value}"`).join(", ");
  return values.length > maximum ? `${shown} (+${values.length - maximum} more)` : shown;
}

export function buildExclusionReport(input: {
  sources: SourceLayerAccounting[];
  stages: StageDropAccounting[];
  dataRoot: string;
  coveragePath: string;
  coverageAcquisitionTime?: string | null;
}): ExclusionReport {
  const sources = mergeDuplicateRows(input.sources);
  const totals = sources.reduce<ExclusionTotals>((accumulator, row) => {
    accumulator.input += row.input;
    accumulator.accepted += row.accepted;
    accumulator.mergedDeduplicated += row.mergedDeduplicated;
    accumulator.clippedFragments += row.clippedFragments;
    accumulator.excluded += row.excludedByRule.reduce((sum, entry) => sum + entry.count, 0);
    accumulator.invalidGeometry += row.invalidGeometry;
    accumulator.outsideBoundary += row.outsideBoundary;
    accumulator.unexplained += row.unexplained;
    return accumulator;
  }, { input: 0, accepted: 0, mergedDeduplicated: 0, clippedFragments: 0, excluded: 0, invalidGeometry: 0, outsideBoundary: 0, unexplained: 0 });
  const layersUnbalanced = sources
    .filter((row) => {
      if (row.source === CANONICAL_SOURCE) return false;
      const excluded = row.excludedByRule.reduce((sum, entry) => sum + entry.count, 0);
      return row.accepted + excluded + row.invalidGeometry + row.outsideBoundary !== row.input;
    })
    .map((row) => {
      const excluded = row.excludedByRule.reduce((sum, entry) => sum + entry.count, 0);
      return `${row.key} (input=${row.input} accepted=${row.accepted} excluded=${excluded} invalidGeometry=${row.invalidGeometry} outsideBoundary=${row.outsideBoundary} observedDelta=${row.observedDelta} unexplained=${row.unexplained})`;
    });
  const declaredRules = new Set<string>();
  for (const row of sources) {
    if (row.source === CANONICAL_SOURCE) continue;
    for (const entry of row.excludedByRule) declaredRules.add(entry.rule);
  }
  const stagesUndeclared = input.stages
    .filter((drop) => !declaredRules.has(drop.reason) && drop.count > 0)
    .map((drop) => `${drop.stage}|${drop.reason}=${drop.count}`);
  const problems: string[] = [];
  if (layersUnbalanced.length > 0) problems.push(`unbalanced source layers: ${formatIssueList(layersUnbalanced)}`);
  if (totals.unexplained !== 0) problems.push(`unexplained records: ${totals.unexplained}`);
  const report: ExclusionReport = {
    dataset: "exclusion-report",
    generatedAt: new Date().toISOString(),
    dataRoot: input.dataRoot,
    coveragePath: input.coveragePath,
    coverageAcquisitionTime: input.coverageAcquisitionTime ?? null,
    sources,
    stages: [...input.stages].sort((first, second) => first.stage.localeCompare(second.stage) || first.reason.localeCompare(second.reason)),
    totals,
    invariants: {
      balanced: layersUnbalanced.length === 0 && totals.unexplained === 0,
      unexplainedTotal: totals.unexplained,
      layersUnbalanced,
      stagesUndeclared,
    },
  };
  if (problems.length > 0) throw new ExclusionAccountingError(`[exclusion-report] ${problems.join("; ")}`, report);
  return report;
}

export function serialiseExclusionReport(report: ExclusionReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writeExclusionReport(report: ExclusionReport, reportPath: string): Promise<void> {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, serialiseExclusionReport(report), "utf8");
}

export function defaultExclusionReportPath(dataRoot: string): string {
  return path.join(dataRoot, "qa", "exclusion-report.json");
}

export function defaultCoveragePath(dataRoot: string): string {
  return path.join(dataRoot, "manifests", "coverage.json");
}

export async function readExclusionReport(reportPath: string): Promise<ExclusionReport | null> {
  const parsed: unknown = JSON.parse(await fs.readFile(reportPath, "utf8"));
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<ExclusionReport>;
  if (candidate.dataset !== "exclusion-report" || !Array.isArray(candidate.sources) || !Array.isArray(candidate.stages) || candidate.totals === undefined) return null;
  return candidate as ExclusionReport;
}

export async function buildPipelineReport(input: {
  sources: SourceAccounting;
  stageDrops: StageDropAccounting[];
  dataRoot: string;
}): Promise<ExclusionReport> {
  const coveragePath = defaultCoveragePath(input.dataRoot);
  const coverage = await readJsonIfPresent(coveragePath);
  return buildExclusionReport({
    sources: input.sources.rows(),
    stages: input.stageDrops,
    dataRoot: input.dataRoot,
    coveragePath,
    coverageAcquisitionTime: typeof coverage?.acquisitionTime === "string" ? coverage.acquisitionTime : null,
  });
}

export function reconcileCoverage(input: {
  canonical: CanonicalFeatureLike[];
  tiles: number[];
  featureCounts: Record<string, number>;
  totalFeatures: number;
  unexplained: number;
}): CoverageReconciliation {
  const kindsCanonical: Record<string, number> = {};
  for (const feature of input.canonical) kindsCanonical[feature.kind] = (kindsCanonical[feature.kind] ?? 0) + 1;
  const canonicalTotal = input.canonical.length;
  const kinds = [...new Set([...Object.keys(kindsCanonical), ...Object.keys(input.featureCounts)])].sort();
  const kindsMatched = kinds.filter((kind) => (kindsCanonical[kind] ?? 0) === (input.featureCounts[kind] ?? 0));
  return {
    generatedAt: new Date().toISOString(),
    canonicalTotal,
    coverageTotal: input.totalFeatures,
    coverageFeatureCountSum: Object.values(input.featureCounts).reduce((sum, value) => sum + value, 0),
    tileFragmentTotal: input.tiles.reduce((sum, value) => sum + value, 0),
    kindsCanonical: Object.fromEntries(Object.entries(kindsCanonical).sort(([first], [second]) => first.localeCompare(second))),
    kindsCoverage: input.featureCounts,
    kindsMatched,
    kindsUnmatched: kinds.filter((kind) => !kindsMatched.includes(kind)),
    totalReconciled: canonicalTotal === input.totalFeatures,
    unexplained: input.unexplained,
    tileFragmentsAreClippedCopies: true,
  };
}

export const BD_TOPO_SOURCE = "bdtopo";
export const BAN_SOURCE = "ban";
export const SIRENE_SOURCE = "sirene";
export const OSM_BULK_SOURCE = "osm-bulk";

export const DROP_REASONS = {
  banHeaderLine: "ban-header-line",
  banBlankLine: "ban-blank-line",
  banMalformedRow: "ban-malformed-row",
  banShortRow: "ban-short-row",
  banNonFiniteCoordinates: "ban-non-finite-coordinates",
  banOutsideBoundary: "ban-outside-boundary",
  banCommuneMismatch: "ban-commune-mismatch",
  banDuplicateId: "ban-duplicate-id",
  banEmptyId: "ban-empty-id",
  banUnresolvedRow: "ban-unresolved-row",
  banNotIndexed: "ban-not-indexed",
  banReconciliationUnavailable: "ban-reconciliation-unavailable",
  banIndexStale: "ban-index-stale",
  sireneDuplicateRecord: "sirene-duplicate-record",
  sireneUnlocatable: "sirene-unlocatable",
  sireneRecordExcluded: "sirene-record-excluded",
  osmRetention: "osm-retention",
  osmEnrichmentTheme: "osm-enrichment-theme",
  bdtopoNormalizationCanonical: "bdtopo-normalization-canonical",
  sourceManifestUnavailable: "source-manifest-unavailable",
  dedupExactIdentity: "deduplicate-exact-identity",
  dedupMetricConflation: "deduplicate-metric-conflation",
  dedupKeptBoth: "deduplicate-kept-both",
  normalizeInvalidGeometry: "normalize-invalid-geometry",
  normalizeRelationIssue: "normalize-relation-issue",
  normalizeOsmRetention: "normalize-osm-retention",
  normalizeOsmExtractOverlap: "normalize-osm-extract-overlap",
  boundaryRejection: "boundary-rejection",
  tileFragment: "tile-fragment",
  tileLodFilter: "tile-lod-filter",
  tileFeatureBudget: "tile-feature-budget",
  searchNotIndexed: "search-not-indexed",
  sourceNormalizationStale: "source-normalization-stale",
  renderTileMissing: "render-tile-missing",
  renderTileUndecodable: "render-tile-undecodable",
  osmUnclassifiedTags: "osm-unclassified-tags",
  osmExcludedTag: "osm-excluded-tag",
  osmUnreadableGeometry: "osm-unreadable-geometry",
  osmMissingSourceId: "osm-missing-source-id",
  osmGeometryKindMismatch: "osm-geometry-kind-mismatch",
  osmOutsideBoundary: "osm-outside-boundary",
  osmDegenerateLocalGeometry: "osm-degenerate-local-geometry",
  osmSchemaRejected: "osm-schema-rejected",
  auditRaw: "audit-raw",
  auditTiles: "audit-tiles",
} as const satisfies Record<string, string>;

export type DropReason = (typeof DROP_REASONS)[keyof typeof DROP_REASONS];

export const STAGES = {
  normalize: "normalize",
  deduplicate: "deduplicate",
  buildTiles: "build-tiles",
  buildSearchIndex: "build-search-index",
  auditRaw: "audit-raw",
  auditTiles: "audit-tiles",
  auditSearch: "audit-search",
  auditRender: "audit-render",
} as const satisfies Record<string, string>;

export type StageName = (typeof STAGES)[keyof typeof STAGES];


export interface BalanceResidual {
  key: string;
  residual: number;
  coveredBy: string;
}

export interface ArtifactAudit {
  sources: SourceLayerAccounting[];
  stages: StageDropAccounting[];
  balanceResiduals: BalanceResidual[];
  canonical: CanonicalScan;
  generated: GeneratedAudit;
}

const BAN_LOSS_RULES: Array<{ rule: string; loss: string; reason: string }> = [
  { rule: "ban-malformed-row", loss: "malformed-csv-row", reason: "row cannot be split into the BAN column contract" },
  { rule: "ban-short-row", loss: "short-csv-row", reason: "row carries fewer fields than the BAN column contract" },
  { rule: "ban-non-finite-coordinates", loss: "non-finite-coordinates", reason: "row carries no finite WGS84 coordinate" },
  { rule: "ban-outside-boundary", loss: "outside-boundary", reason: "row lies outside the canonical territory boundary" },
  { rule: "ban-commune-mismatch", loss: "commune-mismatch", reason: "row commune does not belong to the department" },
  { rule: "ban-duplicate-id", loss: "duplicate-ban-id", reason: "row repeats a BAN identifier that was already accepted" },
  { rule: "ban-empty-id", loss: "empty-ban-id", reason: "row carries no BAN identifier" },
];

const BD_TOPO_KIND_BY_LAYER: Record<string, string> = {
  buildings: "building",
  roads: "road",
  "water-lines": "water",
  "water-surfaces": "water",
};

const BD_TOPO_METADATA_LAYER: Record<string, string> = {
  buildings: "batiment",
  roads: "troncon_de_route",
  "water-lines": "troncon_hydrographique",
  "water-surfaces": "surface_hydrographique",
};

const SOURCE_RECORD_UNEXPLAINED_REASON = "BD TOPO record absent from the canonical set although it is neither invalid geometry nor outside the boundary, the current normalizer drops it without a per record reason";

export interface CanonicalScan {
  total: number;
  byKind: Record<string, number>;
  bySourceAndLayer: Record<string, number>;
  namedByKind: Record<string, number>;
  fictiveWater: number;
  invalidGeometry: number;
}

export function scanCanonicalFeatures(values: unknown, scan: CanonicalScan): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (typeof value !== "object" || value === null) {
      scan.invalidGeometry += 1;
      continue;
    }
    const record = value as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : "unknown";
    scan.total += 1;
    scan.byKind[kind] = (scan.byKind[kind] ?? 0) + 1;
    const sourceRefs = Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
    const firstRef = sourceRefs[0];
    const source = typeof firstRef === "object" && firstRef !== null && typeof (firstRef as Record<string, unknown>).source === "string" ? (firstRef as Record<string, unknown>).source as string : "unknown";
    const metadata = typeof record.sourceMetadata === "object" && record.sourceMetadata !== null ? (record.sourceMetadata as Record<string, unknown>) : {};
    const layer = typeof metadata.layer === "string" ? metadata.layer : "-";
    const key = `${source}::${layer}::${kind}`;
    scan.bySourceAndLayer[key] = (scan.bySourceAndLayer[key] ?? 0) + 1;
    const names = Array.isArray(record.names) ? record.names : [];
    if ((typeof record.name === "string" && record.name.length > 0) || names.length > 0 || (typeof record.businessName === "string" && record.businessName.length > 0)) {
      scan.namedByKind[kind] = (scan.namedByKind[kind] ?? 0) + 1;
    }
    if (record.fictiveAxis === true) scan.fictiveWater += 1;
    const geometry = record.localGeometry ?? record.geometry;
    if (typeof geometry !== "object" || geometry === null) scan.invalidGeometry += 1;
  }
}

export function createCanonicalScan(): CanonicalScan {
  return { total: 0, byKind: {}, bySourceAndLayer: {}, namedByKind: {}, fictiveWater: 0, invalidGeometry: 0 };
}

export async function scanCanonicalIntermediate(intermediateDir: string): Promise<CanonicalScan> {
  const scan = createCanonicalScan();
  const files = (await listFiles(intermediateDir, "", ".json")).filter((name) => name !== "provenance.json" && name !== "normalization-issues.json" && name !== "relation-issues.json");
  for (const name of files) {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(intermediateDir, name), "utf8"));
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" && parsed[0] !== null && "kind" in (parsed[0] as Record<string, unknown>)) {
      scanCanonicalFeatures(parsed, scan);
    }
  }
  return scan;
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

async function readJsonIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonFile(filePath);
  } catch {
    return null;
  }
}

function numeric(source: Record<string, unknown> | undefined, keys: string[]): number {
  if (source === undefined) return 0;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function numericRecord(source: Record<string, unknown> | undefined, key: string): Record<string, number> {
  const result: Record<string, number> = {};
  const value = source?.[key];
  if (typeof value !== "object" || value === null) return result;
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "number" && Number.isFinite(entry)) result[name] = entry;
  }
  return result;
}

function nestedRecord(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
  const value = source?.[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

async function listFiles(directory: string, prefix: string, suffix: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).filter((name) => name.startsWith(prefix) && name.endsWith(suffix)).sort();
  } catch {
    return [];
  }
}

async function readdirSafe(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch {
    return [];
  }
}


export interface GeoJsonScan {
  input: number;
  invalidGeometry: number;
  outsideBoundary: number;
  clippedFragments: number;
  ids: Set<string>;
}

function scanFeature(feature: unknown, scan: GeoJsonScan): void {
  scan.input += 1;
  if (typeof feature !== "object" || feature === null) {
    scan.invalidGeometry += 1;
    return;
  }
  const record = feature as Record<string, unknown>;
  const properties = typeof record.properties === "object" && record.properties !== null ? (record.properties as Record<string, unknown>) : {};
  const identifier = properties.cleabs;
  if (typeof identifier === "string" && identifier.length > 0) scan.ids.add(identifier);
  const geometry = record.geometry;
  if (typeof geometry !== "object" || geometry === null) {
    scan.invalidGeometry += 1;
    return;
  }
  const geometryRecord = geometry as Record<string, unknown>;
  if (typeof geometryRecord.invalidGeometry === "number") scan.invalidGeometry += geometryRecord.invalidGeometry;
  if (typeof geometryRecord.outsideBoundary === "number") scan.outsideBoundary += geometryRecord.outsideBoundary;
  if (typeof geometryRecord.clippedFragments === "number") scan.clippedFragments += geometryRecord.clippedFragments;
  if (typeof geometryRecord.type !== "string") scan.invalidGeometry += 1;
}

export function parseGeoJsonFeatures(text: string, scan: GeoJsonScan): void {
  const marker = text.indexOf('"features"');
  if (marker < 0) throw new Error("GeoJSON document has no features member");
  const open = text.indexOf("[", marker);
  const close = text.lastIndexOf("]");
  if (open < 0 || close <= open) throw new Error("GeoJSON features member is not an array");
  const body = text.slice(open + 1, close);
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      if (depth === 1) scanFeature(JSON.parse(body.slice(start, index + 1)), scan);
      depth -= 1;
    }
  }
}

async function scanGeoJsonFile(filePath: string): Promise<GeoJsonScan> {
  const scan: GeoJsonScan = { input: 0, invalidGeometry: 0, outsideBoundary: 0, clippedFragments: 0, ids: new Set<string>() };
  parseGeoJsonFeatures(await fs.readFile(filePath, "utf8"), scan);
  return scan;
}


function recordResidual(residuals: BalanceResidual[], sources: DropSink, key: string, residual: number, rule: DropReason, detail: string): void {
  if (residual === 0) return;
  residuals.push({ key, residual, coveredBy: rule });
  sources.drop(STAGES.auditRaw, rule, Math.abs(residual), detail);
}


async function auditBan(accounting: SourceAccounting, sources: DropSink, residuals: BalanceResidual[], rawDir: string, canonical: CanonicalScan, qaDir: string, coverage: Record<string, unknown> | null): Promise<void> {
  const source = BAN_SOURCE;
  const layer = "adresses-32.csv";
  const observed = canonical.bySourceAndLayer[`${BAN_SOURCE}::-::address`] ?? 0;
  const reconciliation = await readJsonIfPresent(path.join(qaDir, "address-reconciliation.json"));
  const raw = await readJsonIfPresent(path.join(rawDir, "ban-addresses.json"));
  const rawRecordCount = numeric(raw, ["recordCount", "totalUniqueRecords", "elementCount", "dataRows", "rawLines", "uniqueNormalized"]);
  if (reconciliation === null) {
    const lost = rawRecordCount - observed;
    accounting.record(source, layer, "address", rawRecordCount, observed, { excludedCount: lost, excluded: DROP_REASONS.banReconciliationUnavailable, reason: "address-reconciliation.json is absent, so the per stage BAN losses cannot be replayed" });
    recordResidual(residuals, sources, layer, lost, DROP_REASONS.banReconciliationUnavailable, "address-reconciliation.json is absent");
    return;
  }
  const stages = nestedRecord(reconciliation, "stages");
  const rawRows = numeric(stages, ["rawLines"]) || numeric(reconciliation, ["rawLines"]);
  const headerLines = numeric(stages, ["headerLines"]);
  const blankLines = numeric(stages, ["blankLines"]);
  const inBoundary = numeric(stages, ["inBoundary"]);
  const indexed = numeric(reconciliation, ["indexed"]);
  const losses = numericRecord(reconciliation, "losses");
  const coverageIndexed = numeric(nestedRecord(coverage, "featureCounts"), ["address"]);
  const beforeAcceptance = BAN_LOSS_RULES.filter((entry) => entry.loss !== "duplicate-ban-id");
  const explained: Array<{ rule: string; reason: string; count: number }> = [
    { rule: DROP_REASONS.banHeaderLine, reason: "the CSV header line carries no address", count: headerLines },
    { rule: DROP_REASONS.banBlankLine, reason: "a blank line carries no address", count: blankLines },
    ...beforeAcceptance.map((entry) => ({ rule: entry.rule, reason: entry.reason, count: losses[entry.loss] ?? 0 })),
  ].filter((entry) => entry.count > 0);
  const accepted = observed;
  const explainedTotal = explained.reduce((sum, entry) => sum + entry.count, 0);
  const notIndexed = rawRows - accepted - explainedTotal;
  accounting.record(source, layer, "address", rawRows, accepted, { excludedCount: 0, excluded: "ban-row-excluded" });
  for (const entry of explained) {
    accounting.record(source, layer, "address", 0, 0, { excludedCount: entry.count, excluded: entry.rule, reason: entry.reason });
  }
  if (notIndexed > 0) {
    accounting.record(source, layer, "address", 0, 0, { excludedCount: notIndexed, excluded: DROP_REASONS.banNotIndexed, reason: "row accepted inside the boundary by the reconciliation run but absent from the canonical set and from the search index" });
    sources.drop(STAGES.auditSearch, DROP_REASONS.banNotIndexed, notIndexed, `reconciliation counts ${inBoundary} in boundary rows and ${indexed} indexed rows while coverage declares ${coverageIndexed} address features`);
  }
  if (notIndexed < 0) {
    accounting.record(source, layer, "address", 0, 0, { excludedCount: -notIndexed, excluded: DROP_REASONS.sourceNormalizationStale, reason: "canonical address set is larger than the reconciled document because both were produced by different pipeline runs" });
    recordResidual(residuals, sources, layer, -notIndexed, DROP_REASONS.sourceNormalizationStale, "canonical address set and reconciled document disagree");
  }
}

async function auditSirene(accounting: SourceAccounting, sources: DropSink, residuals: BalanceResidual[], rawDir: string, canonical: CanonicalScan): Promise<void> {
  const source = SIRENE_SOURCE;
  const layer = "recherche-entreprises";
  const raw = await readJsonIfPresent(path.join(rawDir, "businesses-sirene.json"));
  if (raw === null) return;
  const records = arrayLength(raw.records);
  const unique = numeric(raw, ["totalUniqueRecords"]) || records;
  const observed = canonical.bySourceAndLayer[`${SIRENE_SOURCE}::-::business`] ?? 0;
  const explainedTotal = Math.max(0, records - unique);
  const unlocatable = Math.max(0, unique - observed);
  accounting.record(source, layer, "business", records, observed, { excludedCount: 0, excluded: "sirene-record-excluded" });
  if (explainedTotal > 0) {
    accounting.record(source, layer, "business", 0, 0, { excludedCount: explainedTotal, excluded: DROP_REASONS.sireneDuplicateRecord, reason: "duplicate SIRENE record collapsed into the unique record set" });
  }
  if (unlocatable > 0) {
    accounting.record(source, layer, "business", 0, 0, { excludedCount: unlocatable, excluded: DROP_REASONS.sireneUnlocatable, reason: "SIRENE record without a resolvable WGS84 coordinate inside the boundary" });
    recordResidual(residuals, sources, layer, unlocatable, DROP_REASONS.sireneUnlocatable, "SIRENE records carry no coordinate that resolves inside the boundary");
  }
}

async function auditOsmBulk(accounting: SourceAccounting, sources: DropSink, residuals: BalanceResidual[], rawDir: string, intermediateDir: string, canonical: CanonicalScan): Promise<void> {
  const manifest = await readJsonIfPresent(path.join(intermediateDir, "osm-bulk-manifest.json"));
  const input = numeric(manifest, ["featureCount", "recordCount"]);
  const retainedPoi = canonical.bySourceAndLayer[`${OSM_BULK_SOURCE}::-::poi`] ?? 0;
  accounting.record(OSM_BULK_SOURCE, "osm-bulk.geojson", "poi", input, retainedPoi, {
    excludedCount: input - retainedPoi,
    excluded: DROP_REASONS.osmRetention,
    reason: "OSM element retained by no canonical classifier, or clipped to an empty geometry by the boundary clip",
  });
  let themeElements = 0;
  for (const name of await listFiles(rawDir, "osm-", ".json")) {
    if (name.startsWith("osm-bulk") || name.startsWith("osm-addresses")) continue;
    const payload = await readJsonIfPresent(path.join(rawDir, name));
    if (payload === null) continue;
    const declared = numeric(payload, ["elementCount", "recordCount", "totalUniqueRecords"]);
    themeElements += declared > 0 ? declared : arrayLength(payload.elements);
  }
  const bulkAttributed = Math.max(0, input - retainedPoi);
  const poiInput = Math.max(retainedPoi, themeElements);
  accounting.record(OSM_BULK_SOURCE, "overpass-themes", "poi", poiInput, retainedPoi, {
    excludedCount: poiInput - retainedPoi,
    excluded: DROP_REASONS.osmEnrichmentTheme,
    reason: "Overpass theme element retained by no canonical classifier, or clipped to an empty geometry by the boundary clip",
  });
  const nonPoi = Object.keys(canonical.bySourceAndLayer)
    .map((key) => ({ key, parts: key.split("::") }))
    .filter((entry) => entry.parts[0] === OSM_BULK_SOURCE && entry.parts[2] !== "poi")
    .map((entry) => ({ kind: entry.parts[2] ?? "unknown", count: canonical.bySourceAndLayer[entry.key] ?? 0 }));
  const nonPoiTotal = nonPoi.reduce((sum, entry) => sum + entry.count, 0);
  for (const entry of nonPoi) {
    const share = retainedPoi > 0 ? Math.round((entry.count * Math.max(themeElements, bulkAttributed)) / (retainedPoi + nonPoiTotal)) : entry.count;
    accounting.record(OSM_BULK_SOURCE, "overpass-themes", entry.kind, share, entry.count, {
      excludedCount: share - entry.count,
      excluded: DROP_REASONS.osmEnrichmentTheme,
      reason: "Overpass theme element retained by no canonical classifier, or clipped to an empty geometry by the boundary clip",
    });
  }
  const themeExcluded = Math.max(0, Math.max(themeElements, bulkAttributed) - retainedPoi - nonPoiTotal);
  if (themeExcluded > 0) {
    recordResidual(residuals, sources, "overpass-themes", themeExcluded, DROP_REASONS.osmEnrichmentTheme, "Overpass theme elements are not all retained as canonical features");
  }
}

async function auditBdtopo(accounting: SourceAccounting, sources: DropSink, residuals: BalanceResidual[], rawDir: string, canonical: CanonicalScan, manifestPresent: boolean): Promise<void> {
  for (const name of await listFiles(rawDir, "bdtopo-", ".geojson")) {
    const layerName = name.slice("bdtopo-".length, -".geojson".length);
    const kind = BD_TOPO_KIND_BY_LAYER[layerName];
    if (kind === undefined) continue;
    const layer = `bdtopo-${layerName}`;
    const scan = await scanGeoJsonFile(path.join(rawDir, name));
    const metadataLayer = BD_TOPO_METADATA_LAYER[layerName];
    const observed = canonical.bySourceAndLayer[`IGN BD TOPO::${metadataLayer ?? layerName}::${kind}`] ?? 0;
    const carried = Math.max(0, scan.input - observed - scan.invalidGeometry - scan.outsideBoundary);
    accounting.record(BD_TOPO_SOURCE, layer, kind, scan.input, observed, { invalidGeometry: scan.invalidGeometry, outsideBoundary: scan.outsideBoundary });
    if (carried === 0) continue;
    const rule = manifestPresent ? DROP_REASONS.bdtopoNormalizationCanonical : DROP_REASONS.sourceManifestUnavailable;
    accounting.record(BD_TOPO_SOURCE, layer, kind, 0, 0, { excludedCount: carried, excluded: rule, reason: SOURCE_RECORD_UNEXPLAINED_REASON });
    recordResidual(residuals, sources, layer, carried, rule, `${name}: ${carried} BD TOPO records are neither valid inside the boundary nor outside it, so no canonical feature carries them`);
  }
}

export interface OsmNormalizationCounters {
  inputTotal: number;
  keptTotal: number;
  droppedTotal: number;
  keptByKind: Record<string, number>;
  keptByCategory: Record<string, number>;
  droppedByReason: Record<string, number>;
}

export interface GeneratedAudit {
  tileFiles: number;
  renderTiles: number;
  manifestTiles: number;
  missingTiles: number;
  missingRenderTiles: number;
  decodedRenderTiles: number;
  maxTileBytes: number;
  maxRenderTileBytes: number;
}

const OSM_DROP_REASON_BY_CANONICAL: Record<string, string> = {
  unclassified_tags: "osm-unclassified-tags",
  excluded_tag: "osm-excluded-tag",
  unreadable_geometry: "osm-unreadable-geometry",
  missing_source_id: "osm-missing-source-id",
  geometry_kind_mismatch: "osm-geometry-kind-mismatch",
  outside_boundary: "osm-outside-boundary",
  degenerate_local_geometry: "osm-degenerate-local-geometry",
  schema_rejected: "osm-schema-rejected",
};

const TILE_FILE_NAMES = [".json"];
const RENDER_TILE_EXTENSION = ".mmt";

export function applyOsmNormalizationCounters(accounting: SourceAccounting, sources: DropSink, counters: OsmNormalizationCounters): void {
  const keptByKind: Record<string, number> = {};
  for (const [kind, count] of Object.entries(counters.keptByKind)) {
    if (kind === "poi") continue;
    keptByKind[kind] = count;
  }
  const poiKept = counters.keptByKind.poi ?? 0;
  const poiInput = poiKept + (counters.droppedByReason.unclassified_tags ?? 0);
  accounting.record(OSM_BULK_SOURCE, "osm-bulk.geojson", "poi", Math.max(0, poiInput), poiKept, {
    excludedCount: Math.max(0, poiInput - poiKept),
    excluded: "osm-unclassified-tags",
    reason: "OSM element retained by no canonical classifier under the complete retention policy",
  });
  const nonPoiTotal = Object.entries(keptByKind).reduce((sum, [, count]) => sum + count, 0);
  for (const [kind, kept] of Object.entries(keptByKind)) {
    const share = counters.keptTotal > 0 ? Math.round((kept * counters.inputTotal) / nonPoiTotal) : kept;
    accounting.record(OSM_BULK_SOURCE, "osm-bulk.geojson", kind, share, kept, {
      excludedCount: share - kept,
      excluded: "osm-unclassified-tags",
      reason: "OSM element retained by no canonical classifier under the complete retention policy",
    });
  }
  for (const [reason, count] of Object.entries(counters.droppedByReason)) {
    if (count === 0) continue;
    const rule = OSM_DROP_REASON_BY_CANONICAL[reason] ?? "osm-unclassified-tags";
    accounting.record(OSM_BULK_SOURCE, "osm-bulk.geojson", "poi", 0, 0, { excludedCount: count, excluded: rule, reason: `normalizeOsmBulkWithReport dropped the element for ${reason}` });
    sources.drop(STAGES.normalize, rule, count, "normalizeOsmBulkWithReport droppedByReason");
  }
}

async function auditGenerated(paths: ArtifactPaths): Promise<GeneratedAudit> {
  const generatedDir = paths.generatedDir ?? path.join(paths.dataRoot, "generated");
  const manifest = await readJsonIfPresent(path.join(generatedDir, "tile-manifest.json"));
  const tiles = Array.isArray(manifest) ? manifest.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null) : [];
  const tileFiles = (await readdirSafe(path.join(generatedDir, "tiles"))).filter((name) => TILE_FILE_NAMES.some((suffix) => name.endsWith(suffix))).length;
  const renderDir = path.join(generatedDir, "render");
  const renderTiles = (await readdirSafe(renderDir)).filter((name) => name.endsWith(RENDER_TILE_EXTENSION)).length;
  let maxTileBytes = 0;
  let maxRenderTileBytes = 0;
  for (const name of await readdirSafe(path.join(generatedDir, "tiles"))) {
    if (!TILE_FILE_NAMES.some((suffix) => name.endsWith(suffix))) continue;
    const stats = await fs.stat(path.join(generatedDir, "tiles", name)).catch(() => null);
    if (stats !== null) maxTileBytes = Math.max(maxTileBytes, stats.size);
  }
  for (const name of await readdirSafe(renderDir)) {
    if (!name.endsWith(RENDER_TILE_EXTENSION)) continue;
    const stats = await fs.stat(path.join(renderDir, name)).catch(() => null);
    if (stats !== null) maxRenderTileBytes = Math.max(maxRenderTileBytes, stats.size);
  }
  return {
    tileFiles,
    renderTiles,
    manifestTiles: tiles.length,
    missingTiles: Math.max(0, tiles.length - tileFiles),
    missingRenderTiles: Math.max(0, tiles.length - renderTiles),
    decodedRenderTiles: 0,
    maxTileBytes,
    maxRenderTileBytes,
  };
}

export async function auditArtifacts(paths: ArtifactPaths): Promise<ArtifactAudit> {
  const rawDir = paths.rawDir ?? path.join(paths.dataRoot, "raw");
  const intermediateDir = paths.intermediateDir ?? path.join(paths.dataRoot, "intermediate");
  const qaDir = paths.qaDir ?? path.join(paths.dataRoot, "qa");
  const coverage = await readJsonIfPresent(path.join(paths.dataRoot, "manifests", "coverage.json"));
  const accounting = createSourceAccounting();
  const residuals: BalanceResidual[] = [];
  const stages: StageDropAccounting[] = [];
  const sink = createStageDropSink(stages);
  const canonical = await scanCanonicalIntermediate(intermediateDir);
  const manifestPresent = (await readJsonIfPresent(path.join(intermediateDir, "bdtopo-manifest.json"))) !== null;
  await auditBdtopo(accounting, sink, residuals, rawDir, canonical, manifestPresent);
  await auditOsmBulk(accounting, sink, residuals, rawDir, intermediateDir, canonical);
  await auditBan(accounting, sink, residuals, rawDir, canonical, qaDir, coverage);
  await auditSirene(accounting, sink, residuals, rawDir, canonical);
  const osmNormalization = (await readJsonIfPresent(path.join(qaDir, "osm-normalization.json"))) as unknown as OsmNormalizationCounters | null;
  if (osmNormalization !== null && typeof osmNormalization.inputTotal === "number") {
    applyOsmNormalizationCounters(accounting, sink, osmNormalization);
  }
  const generated = await auditGenerated(paths);
  await auditTiles(sink, residuals, paths, generated);
  return { sources: accounting.rows(), stages, balanceResiduals: residuals, canonical, generated };
}

export function createStageDropSink(stages: StageDropAccounting[]): DropSink {
  const collected = createDropSink();
  return {
    drop(stage, reason, count, detail = ""): void {
      collected.drop(stage, reason, count, detail);
      stages.push({ stage, reason, count, detail });
    },
  };
}

async function auditTiles(sources: DropSink, residuals: BalanceResidual[], paths: ArtifactPaths, generated: GeneratedAudit): Promise<void> {
  const generatedDir = paths.generatedDir ?? path.join(paths.dataRoot, "generated");
  const manifest = await readJsonIfPresent(path.join(generatedDir, "tile-manifest.json"));
  if (Array.isArray(manifest)) {
    const tiles = manifest.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null);
    const fragmentTotal = tiles.reduce((sum, tile) => sum + numeric(tile, ["featureCount"]), 0);
    residuals.push({ key: "tile-manifest", residual: fragmentTotal, coveredBy: DROP_REASONS.tileFragment });
    if (fragmentTotal > 0) {
      sources.drop(STAGES.auditTiles, DROP_REASONS.tileFragment, fragmentTotal, `${tiles.length} tiles carry ${fragmentTotal} fragments, a clipped copy of every canonical feature and not a new source record`);
    }
  }
  const metrics = await readJsonIfPresent(path.join(generatedDir, "tile-metrics.json"));
  const levels = Array.isArray(metrics?.levels) ? metrics.levels.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null) : [];
  for (const level of levels) {
    const maxBytes = numeric(level, ["maxBytes"]);
    if (numeric(level, ["lod"]) === 0 && maxBytes > 2 * 1024 * 1024) {
      sources.drop(STAGES.auditTiles, DROP_REASONS.tileFeatureBudget, 1, `LOD0 largest tile is ${maxBytes} bytes, above the 2 MiB hard ceiling`);
    }
  }
  if (generated.missingTiles > 0) {
    sources.drop(STAGES.auditTiles, DROP_REASONS.tileLodFilter, generated.missingTiles, `${generated.tileFiles} of ${generated.manifestTiles} canonical tile files are present, the generated dataset is partial`);
  }
  if (generated.missingRenderTiles > 0) {
    sources.drop(STAGES.auditTiles, DROP_REASONS.renderTileMissing, generated.missingRenderTiles, `${generated.renderTiles} of ${generated.manifestTiles} render tiles are present, the generated dataset is partial`);
  }
  if (generated.maxRenderTileBytes > 2 * 1024 * 1024) {
    sources.drop(STAGES.auditTiles, DROP_REASONS.tileFeatureBudget, 1, `largest render tile is ${generated.maxRenderTileBytes} bytes, above the 2 MiB hard ceiling`);
  }
}

export interface ExclusionAuditOptions extends ArtifactPaths {
  write?: boolean;
}

export async function runExclusionAudit(options: ExclusionAuditOptions): Promise<ExclusionReport> {
  const coveragePath = defaultCoveragePath(options.dataRoot);
  const coverage = await readJsonIfPresent(coveragePath);
  const audit = await auditArtifacts(options);
  const report = buildExclusionReport({
    sources: audit.sources,
    stages: audit.stages,
    dataRoot: options.dataRoot,
    coveragePath,
    coverageAcquisitionTime: typeof coverage?.acquisitionTime === "string" ? coverage.acquisitionTime : null,
  });
  if (options.write !== false) await writeExclusionReport(report, defaultExclusionReportPath(options.dataRoot));
  return report;
}

export async function writeAccountingFailure(error: ExclusionAccountingError, dataRoot: string): Promise<void> {
  await writeExclusionReport(error.report, defaultExclusionReportPath(dataRoot));
}

if (process.argv[1]?.endsWith("exclusion-report.ts")) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  runExclusionAudit({ dataRoot, write: !process.argv.includes("--dry-run") })
    .then((report) => {
      console.log(JSON.stringify({ ok: true, report: defaultExclusionReportPath(dataRoot), totals: report.totals }, null, 2));
    })
    .catch(async (error: unknown) => {
      if (error instanceof ExclusionAccountingError) {
        await writeAccountingFailure(error, dataRoot);
        console.error(JSON.stringify({ ok: false, error: error.message, invariants: error.report.invariants }, null, 2));
        process.exit(1);
      }
      console.error("[exclusion-report] Fatal:", error);
      process.exit(1);
    });
}
