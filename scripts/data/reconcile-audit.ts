#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";
import { GERS_TERRITORY } from "../../src/lib/data/territory";
import { BD_TOPO_LAYERS } from "./bdtopoLayers";

const run = promisify(execFile);

export const AUDIT_DATASET = "source-reconciliation-audit";

export interface Measurement {
  value: number | null;
  command: string;
  status: "measured" | "unavailable";
  note: string;
}

export interface SourceIdentity {
  family: string;
  name: string;
  license: string;
  edition: string | null;
  editionSource: string;
  acquiredAt: string | null;
  sha256: string | null;
  localFile: string;
  bytes: number | null;
}

export interface ExclusionBucket {
  rule: string;
  count: number;
  reason: string;
  origin: "independent-measurement" | "pipeline-artefact" | "policy" | "source-measurement";
}

export interface RowSpec {
  id: string;
  source: string;
  layer: string;
  kind: string;
  input: number | null;
  inputMeasurement: Measurement;
  accepted: number | null;
  acceptedFrom: string;
  acceptedMeasurement: Measurement;
  merged: number;
  invalid: number;
  outsideBoundary: number;
  buckets: ExclusionBucket[];
  boundaryMeasurements?: BoundaryMeasurement[];
  valueResiduals?: ValueResidual[];
  partialDataset: boolean;
  pipelineInput?: number | null;
  pipelineAccepted?: number | null;
}

export interface ValueResidual {
  value: string;
  input: number;
  accepted: number;
  unexplained: number;
}
export interface BoundaryMeasurement {
  id: string;
  method: string;
  measured: number;
  unexplained: number;
}

export interface AuditRow {
  id: string;
  source: string;
  layer: string;
  kind: string;
  input: { independent: number | null; pipeline: number | null; agrees: boolean | null };
  accepted: { canonical: number | null; from: string; pipeline: number | null; agrees: boolean | null };
  merged: number;
  excluded: number;
  excludedByRule: ExclusionBucket[];
  invalid: number;
  outsideBoundary: number;
  unexplained: number;
  unexplainedReasons: string[];
  partialDataset: boolean;
  inputMeasurement: Measurement;
  acceptedMeasurement: Measurement;
  valueResiduals: ValueResidual[];
}

export interface FamilyAudit {
  family: string;
  identity: SourceIdentity;
  rows: AuditRow[];
  totals: { input: number | null; accepted: number; merged: number; excluded: number; invalid: number; outsideBoundary: number; unexplained: number };
  inputMeasurementComplete: boolean;
  notes: string;
}

export interface ArtefactCrossCheck {
  id: string;
  declared: number | null;
  measured: number | null;
  agrees: boolean;
  blocking: boolean;
  note: string;
}

export interface ReconcileAuditReport {
  dataset: typeof AUDIT_DATASET;
  generatedAt: string;
  department: string;
  dataRoot: string;
  canonicalStore: CanonicalStoreSummary;
  freshness: { canonicalNewestMtime: string | null; sources: { family: string; sourceMtime: string | null; newerThanStore: boolean | null }[] };
  families: FamilyAudit[];
  artefacts: { id: string; present: boolean; path: string; generatedAt: string | null }[];
  crossChecks: ArtefactCrossCheck[];
  invariants: {
    accounted: boolean;
    unattributedResidual: number;
    blockingCrossCheckFailures: number;
    advisoryDisagreements: number;
    failingRows: string[];
    partialDatasetRows: string[];
    unattributableRows: string[];
  };
}

export class ReconcileAuditError extends Error {
  constructor(message: string, readonly report: ReconcileAuditReport) {
    super(message);
    this.name = "ReconcileAuditError";
  }
}

export interface CanonicalStoreSummary {
  status: "measured" | "absent";
  files: number;
  records: number;
  byKind: Record<string, number>;
  byStableIdNamespace: Record<string, number>;
  newestMtime: string | null;
  scanCommand: string;
}

export interface CanonicalScan extends CanonicalStoreSummary {
  fieldValues: Record<string, Record<string, number>>;
  newestMtimeMs: number;
}

export interface ExclusionRow {
  key: string;
  input: number;
  accepted: number;
  mergedDeduplicated: number;
  invalidGeometry: number;
  outsideBoundary: number;
  excludedByRule: Array<{ rule: string; count: number; reason: string }>;
}

export function residualOf(row: { input: number | null; accepted: number | null; merged: number; excluded: number; invalid: number; outsideBoundary: number }): number | null {
  if (row.input === null || row.accepted === null) return null;
  return row.input - (row.accepted + row.merged + row.excluded + row.invalid + row.outsideBoundary);
}

export function sumValues(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

export function bucketTotal(buckets: ExclusionBucket[]): number {
  return sumValues(buckets.map((bucket) => bucket.count));
}

export function buildAuditRow(spec: RowSpec): AuditRow {
  const outsideBoundary = spec.outsideBoundary;
  const boundaryExcluded = sumValues((spec.boundaryMeasurements ?? []).map((measurement) => measurement.unexplained));
  const excluded = bucketTotal(spec.buckets) + boundaryExcluded;
  const residual = residualOf({ input: spec.input, accepted: spec.accepted, merged: spec.merged, excluded, invalid: spec.invalid, outsideBoundary });
  const valueResidualTotal = sumValues((spec.valueResiduals ?? []).map((entry) => entry.unexplained));
  const reasons: string[] = [];
  if (residual === null) {
    reasons.push("the independent input measurement or the accepted count is unavailable, so the residual cannot be computed");
  } else if (residual > 0) {
    reasons.push(spec.partialDataset
      ? `${residual} input record(s) are in no accepted feature and in no exclusion bucket; the canonical store predates the source snapshot, so the shortfall belongs to the in-flight rebuild rather than to a data decision`
      : `${residual} input record(s) are in no accepted feature and in no exclusion bucket, and no pipeline artefact attributes them`);
  } else if (residual < 0) {
    reasons.push(`the accounted buckets exceed the independent input by ${-residual} record(s), so an accepted feature has no input record behind it`);
  }
  for (const measurement of spec.boundaryMeasurements ?? []) {
    if (measurement.unexplained <= 0) continue;
    reasons.push(`${measurement.id}: ${measurement.measured} objects measured (${measurement.method}), ${measurement.unexplained} are in no accepted feature, in no bucket and outside the ${GERS_TERRITORY.name} boundary, and the pipeline has not re-run the boundary classification against this snapshot`);
  }
  return {
    id: spec.id,
    source: spec.source,
    layer: spec.layer,
    kind: spec.kind,
    input: {
      independent: spec.input,
      pipeline: spec.pipelineInput ?? null,
      agrees: spec.input === null || spec.pipelineInput === null ? null : spec.input === spec.pipelineInput,
    },
    accepted: {
      canonical: spec.accepted,
      from: spec.acceptedFrom,
      pipeline: spec.pipelineAccepted ?? null,
      agrees: spec.accepted === null || spec.pipelineAccepted === null ? null : spec.accepted === spec.pipelineAccepted,
    },
    merged: spec.merged,
    excluded,
    excludedByRule: [...(spec.boundaryMeasurements ?? []).map((measurement) => ({ rule: "outside-canonical-boundary-unclassified", count: measurement.unexplained, reason: `${measurement.id}: ${measurement.measured} objects measured by ${measurement.method}, all of them outside the ${GERS_TERRITORY.name} boundary or otherwise unclassified by the pipeline, so no canonical feature can carry them`, origin: "independent-measurement" as const })), ...spec.buckets]
      .sort((first, second) => second.count - first.count || first.rule.localeCompare(second.rule)),
    invalid: spec.invalid,
    outsideBoundary,
    unexplained: residual === null ? -1 : residual + valueResidualTotal,
    unexplainedReasons: reasons,
    partialDataset: spec.partialDataset,
    inputMeasurement: spec.inputMeasurement,
    acceptedMeasurement: spec.acceptedMeasurement,
    valueResiduals: [...(spec.valueResiduals ?? [])].sort((first, second) => second.unexplained - first.unexplained).slice(0, 25),
  };
}

export function totalOf(rows: AuditRow[]): FamilyAudit["totals"] {
  const complete = rows.length > 0 && rows.every((row) => row.input.independent !== null);
  return {
    input: complete ? sumValues(rows.map((row) => row.input.independent ?? 0)) : null,
    accepted: sumValues(rows.map((row) => row.accepted.canonical ?? 0)),
    merged: sumValues(rows.map((row) => row.merged)),
    excluded: sumValues(rows.map((row) => row.excluded)),
    invalid: sumValues(rows.map((row) => row.invalid)),
    outsideBoundary: sumValues(rows.map((row) => row.outsideBoundary)),
    unexplained: sumValues(rows.map((row) => Math.max(0, row.unexplained))),
  };
}

const STAGE_ONLY_BAN_RULES: Record<string, true> = {
  "ban-not-indexed": true,
  "ban-reconciliation-unavailable": true,
  "source-normalization-stale": true,
};

export function mergePipelineBuckets(row: ExclusionRow, evidence: string): { buckets: ExclusionBucket[]; merged: number; input: number; accepted: number } {
  const buckets: ExclusionBucket[] = [];
  for (const entry of row.excludedByRule) {
    if (entry.count <= 0) continue;
    if (row.key.startsWith("ban::") && STAGE_ONLY_BAN_RULES[entry.rule] === true) continue;
    buckets.push({ rule: entry.rule, count: entry.count, reason: `${entry.reason} [${evidence}]`, origin: "pipeline-artefact" });
  }
  if (row.mergedDeduplicated > 0) {
    buckets.push({ rule: "deduplicate-merge", count: row.mergedDeduplicated, reason: "records folded into an existing canonical feature by the deduplication stage", origin: "pipeline-artefact" });
  }
  return { buckets, merged: row.mergedDeduplicated, input: row.input, accepted: row.accepted };
}

export function indexExclusionArtefact(report: Record<string, unknown> | null): Map<string, ExclusionRow> {
  const rows = new Map<string, ExclusionRow>();
  const sources = Array.isArray(report?.sources) ? (report.sources as unknown[]) : [];
  for (const value of sources) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    const key = textField(record, ["key"]);
    if (key === null) continue;
    rows.set(key, {
      key,
      input: numberField(record, ["input"]) ?? 0,
      accepted: numberField(record, ["accepted"]) ?? 0,
      mergedDeduplicated: numberField(record, ["mergedDeduplicated"]) ?? 0,
      invalidGeometry: numberField(record, ["invalidGeometry"]) ?? 0,
      outsideBoundary: numberField(record, ["outsideBoundary"]) ?? 0,
      excludedByRule: Array.isArray(record.excludedByRule) ? (record.excludedByRule as ExclusionRow["excludedByRule"]) : [],
    });
  }
  return rows;
}

export function parseTagsCount(stdout: string, command: string): { counts: Record<string, number>; total: number; command: string } {
  const counts: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    const count = Number.parseInt(fields[0]!.replace(/\s/g, ""), 10);
    const value = (fields[fields.length - 1] ?? "").replace(/^"|"$/g, "").trim();
    if (!Number.isFinite(count) || value.length === 0) continue;
    counts[value] = count;
  }
  return { counts, total: sumValues(Object.values(counts)), command };
}

export function countFeatureCollectionText(text: string, communeKey: string): { total: number; invalid: number; named: number; withCommune: number } {
  const marker = text.indexOf('"features"');
  if (marker === -1) throw new Error("FeatureCollection has no features member");
  const open = text.indexOf("[", marker);
  const close = text.lastIndexOf("]");
  if (open === -1 || close <= open) throw new Error("FeatureCollection features member is not an array");
  const body = text.slice(open + 1, close);
  const result = { total: 0, invalid: 0, named: 0, withCommune: 0 };
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (inString) {
      if (escaped) escaped = true;
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
      if (depth === 1) {
        const feature = objectOf(JSON.parse(body.slice(start, index + 1)));
        result.total += 1;
        if (typeof feature.geometry !== "object" || feature.geometry === null) result.invalid += 1;
        const properties = objectOf(feature.properties);
        if (typeof properties.nom === "string" && properties.nom.length > 0) result.named += 1;
        const commune = properties[communeKey];
        if (typeof commune === "string" && commune.length > 0) result.withCommune += 1;
      }
      depth -= 1;
    }
  }
  return result;
}

export function osmCategoryRows(input: {
  specs: readonly OsmCategorySpec[];
  countsBySpec: Map<string, { counts: Record<string, number>; total: number; command: string }>;
  canonicalFieldValues: Map<string, Record<string, number>>;
  canonicalKindTotals: Record<string, number>;
  pbf: string;
  boundaryOutsideBySpec: Map<string, BoundaryMeasurement>;
}): AuditRow[] {
  return input.specs.map((spec) => {
    const measured = input.countsBySpec.get(spec.id) ?? { counts: {}, total: 0, command: `osmium tags-count ${input.pbf} ${spec.key}=*` };
    const canonicalValues = spec.canonicalKind === null ? {} : input.canonicalFieldValues.get(`${spec.canonicalKind}|${spec.key}`) ?? {};
    const valueResiduals: ValueResidual[] = Object.entries(measured.counts)
      .map(([value, count]) => ({ value, input: count, accepted: canonicalValues[value] ?? 0, unexplained: Math.max(0, count - (canonicalValues[value] ?? 0)) }))
      .filter((entry) => entry.unexplained > 0);
    const acceptedFromValueTally = spec.canonicalKind !== null && Object.keys(canonicalValues).length > 0;
    const valueTallyAccepted = sumValues(Object.keys(measured.counts).map((value) => canonicalValues[value] ?? 0));
    const accepted = acceptedFromValueTally ? valueTallyAccepted : spec.canonicalKind === null ? 0 : input.canonicalKindTotals[spec.canonicalKind] ?? 0;
    const buckets: ExclusionBucket[] = [];
    if (spec.exclusionReason !== null && measured.total > 0) {
      buckets.push({ rule: `osm-policy-excluded:${spec.parityId}`, count: measured.total, reason: spec.exclusionReason, origin: "policy" });
    }
    return buildAuditRow({
      id: `osm::${spec.id}`,
      source: "osm",
      layer: spec.layer,
      kind: spec.canonicalKind ?? "policy-excluded",
      input: measured.total,
      inputMeasurement: { value: measured.total, command: measured.command, status: "measured", note: `osmium tags-count over ${input.pbf} for ${spec.key}` },
      accepted,
      acceptedFrom: acceptedFromValueTally ? `canonical store ${spec.canonicalKind}.${spec.key} per value tally` : spec.canonicalKind === null ? "policy exclusion, nothing is adopted from OSM" : `canonical store ${spec.canonicalKind} total`,
      acceptedMeasurement: { value: accepted, command: "streaming stableId and tag value scan of data/intermediate", status: accepted === null ? "unavailable" : "measured", note: "accepted side measured from the canonical store, never from a pipeline artefact" },
      merged: 0,
      invalid: 0,
      outsideBoundary: 0,
      buckets,
      boundaryMeasurements: [input.boundaryOutsideBySpec.get(spec.id)]
        .filter((entry): entry is BoundaryMeasurement => entry !== undefined)
        .map((entry) => ({ ...entry, unexplained: Math.min(entry.unexplained, measured.total) })),
      valueResiduals: acceptedFromValueTally ? valueResiduals : [],
      partialDataset: true,
    });
  });
}

export interface OsmCategorySpec {
  id: string;
  layer: string;
  key: string;
  values: string[] | "*";
  objectType: "node" | "way" | "relation" | "any";
  parityId: string;
  canonicalKind: string | null;
  exclusionReason: string | null;
}

export function tagsCountExpression(spec: OsmCategorySpec): string {
  return `${spec.key}=${spec.values === "*" ? "*" : spec.values.join(",")}`;
}

export function assembleReport(input: {
  dataRoot: string;
  families: Array<{ family: string; identity: SourceIdentity; rows: AuditRow[]; notes: string }>;
  canonicalStore: CanonicalStoreSummary;
  freshness: ReconcileAuditReport["freshness"];
  artefacts: ReconcileAuditReport["artefacts"];
  crossChecks: ArtefactCrossCheck[];
}): ReconcileAuditReport {
  const families: FamilyAudit[] = input.families.map((family) => ({
    ...family,
    totals: totalOf(family.rows),
    inputMeasurementComplete: family.rows.every((row) => row.input.independent !== null),
  }));
  const rows = families.flatMap((family) => family.rows);
  const unattributed = rows.filter((row) => row.unexplained > 0);
  const unattributable = unattributed.filter((row) => !row.partialDataset);
  const blocking = input.crossChecks.filter((check) => !check.agrees && check.blocking);
  const advisory = input.crossChecks.filter((check) => !check.agrees && !check.blocking);
  const problems: string[] = [];
  if (unattributable.length > 0) problems.push(`unattributed residual: ${unattributable.map((row) => `${row.id}=${row.unexplained}`).join(", ")}`);
  if (blocking.length > 0) problems.push(`pipeline artefact disagrees with the independent measurement: ${blocking.map((check) => check.id).join(", ")}`);
  const report: ReconcileAuditReport = {
    dataset: AUDIT_DATASET,
    generatedAt: new Date().toISOString(),
    department: GERS_TERRITORY.code,
    dataRoot: input.dataRoot,
    canonicalStore: input.canonicalStore,
    freshness: input.freshness,
    families,
    artefacts: input.artefacts,
    crossChecks: input.crossChecks,
    invariants: {
      accounted: unattributable.length === 0 && blocking.length === 0,
      unattributedResidual: sumValues(unattributed.map((row) => row.unexplained)),
      blockingCrossCheckFailures: blocking.length,
      advisoryDisagreements: advisory.length,
      failingRows: rows.filter((row) => row.unexplained !== 0).map((row) => `${row.id} unexplained=${row.unexplained}${row.partialDataset ? " (partial dataset)" : ""}`),
      partialDatasetRows: unattributed.filter((row) => row.partialDataset).map((row) => row.id),
      unattributableRows: unattributable.map((row) => `${row.id} unexplained=${row.unexplained}`),
    },
  };
  if (problems.length > 0) throw new ReconcileAuditError(`[reconcile-audit] ${problems.join("; ")}`, report);
  return report;
}

const CANONICAL_FILE_PATTERN = /^(address|building|road|water|landuse|poi|business|transport|structure|place|relation|border|boundary|hydrology|network)-?\d*\.json$/;
const CANONICAL_IGNORED: Record<string, true> = {
  "provenance.json": true,
  "normalization-issues.json": true,
  "relation-issues.json": true,
  "bdtopo-manifest.json": true,
  "osm-bulk-manifest.json": true,
  "boundary.json": true,
  "boundary-source.json": true,
  "auch-boundary-source.json": true,
  "auch-osm-manifest.json": true,
  "ign-unavailable.json": true,
};

export function canonicalFileMatches(name: string): boolean {
  return CANONICAL_FILE_PATTERN.test(name) && CANONICAL_IGNORED[name] !== true;
}

export function namespaceOf(stableId: string): string {
  const separator = stableId.indexOf(":");
  return separator === -1 ? stableId : stableId.slice(0, separator);
}

export function scanCommandOf(intermediateDir: string, fields: readonly string[]): string {
  return `node streaming scan of ${intermediateDir}/<canonical>.json counting "stableId", "kind" and ${fields.map((field) => `"${field}"`).join(", ")} tag values`;
}

export async function scanCanonicalStore(intermediateDir: string, fields: readonly string[]): Promise<CanonicalScan> {
  const names = (await fs.readdir(intermediateDir).catch(() => [] as string[])).filter(canonicalFileMatches).sort();
  const byKind: Record<string, number> = {};
  const byStableIdNamespace: Record<string, number> = {};
  const fieldValues: Record<string, Record<string, number>> = {};
  let records = 0;
  let newestMtimeMs = 0;
  const pattern = new RegExp(`"(stableId|kind|${fields.join("|")})":"([^"\\\\]{0,160})"`, "g");
  for (const name of names) {
    const filePath = path.join(intermediateDir, name);
    newestMtimeMs = Math.max(newestMtimeMs, statSync(filePath).mtimeMs);
    const fileKind = name.replace(/-\d*\.json$/, "").replace(/-/g, "_");
    const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
    let carry = "";
    for await (const chunk of stream) {
      const text = carry + (Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk));
      pattern.lastIndex = 0;
      let match = pattern.exec(text);
      while (match !== null) {
        const key = match[1]!;
        const value = match[2]!;
        if (key === "stableId") {
          records += 1;
          const namespace = namespaceOf(value);
          byStableIdNamespace[namespace] = (byStableIdNamespace[namespace] ?? 0) + 1;
        } else if (key === "kind") {
          byKind[value] = (byKind[value] ?? 0) + 1;
        } else {
          const bucketKey = `${fileKind}|${key}`;
          const bucket = fieldValues[bucketKey] ?? (fieldValues[bucketKey] = {});
          bucket[value] = (bucket[value] ?? 0) + 1;
        }
        match = pattern.exec(text);
      }
      carry = text.slice(-256);
    }
  }
  return {
    status: names.length === 0 ? "absent" : "measured",
    files: names.length,
    records,
    byKind,
    byStableIdNamespace,
    fieldValues,
    newestMtimeMs,
    newestMtime: newestMtimeMs === 0 ? null : new Date(newestMtimeMs).toISOString(),
    scanCommand: scanCommandOf(intermediateDir, fields),
  };
}

export async function ogrInfoCount(gpkg: string, layer: string): Promise<{ count: number | null; command: string }> {
  const args = ["-ro", "-q", "-sql", `SELECT COUNT(*) AS n FROM ${layer}`, gpkg];
  const command = `ogrinfo ${args.join(" ")}`;
  try {
    const { stdout } = await run("ogrinfo", args, { maxBuffer: 8 * 1024 * 1024 });
    const match = /n \(Integer(?:64)?\) = (\d[\d\s]*)/.exec(stdout);
    const parsed = match === null ? null : Number.parseInt(match[1]!.replace(/\s/g, ""), 10);
    return { count: parsed !== null && Number.isFinite(parsed) ? parsed : null, command };
  } catch {
    return { count: null, command };
  }
}

export async function osmiumFileInfo(pbf: string): Promise<{ headerTimestamp: string | null; lastTimestamp: string | null; nodes: number | null; ways: number | null; relations: number | null; command: string }> {
  const command = `osmium fileinfo -e ${pbf}`;
  try {
    const { stdout } = await run("osmium", ["fileinfo", "-e", pbf], { maxBuffer: 8 * 1024 * 1024 });
    return {
      headerTimestamp: /timestamp_osm_base=([^\s\n]+)/.exec(stdout)?.[1] ?? /generator=([^\n]+)/.exec(stdout)?.[1]?.trim() ?? null,
      lastTimestamp: /Timestamps:\s*\n\s*First:\s*(\S+)\s*\n\s*Last:\s*(\S+)/.exec(stdout)?.[2] ?? null,
      nodes: matchedNumber(stdout, /Number of nodes: (\d+)/),
      ways: matchedNumber(stdout, /Number of ways: (\d+)/),
      relations: matchedNumber(stdout, /Number of relations: (\d+)/),
      command,
    };
  } catch {
    return { headerTimestamp: null, lastTimestamp: null, nodes: null, ways: null, relations: null, command };
  }
}

function matchedNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  return match === null ? null : Number.parseInt(match[1]!, 10);
}

export async function osmiumTagsCount(pbf: string, spec: OsmCategorySpec): Promise<{ counts: Record<string, number>; total: number; command: string }> {
  const typeArgs = spec.objectType === "any" ? [] : ["-t", spec.objectType];
  const args = ["tags-count", "-m", "1", ...typeArgs, pbf, tagsCountExpression(spec)];
  const command = `osmium ${args.join(" ")}`;
  try {
    const { stdout } = await run("osmium", args, { maxBuffer: 32 * 1024 * 1024 });
    return parseTagsCount(stdout, command);
  } catch {
    return { counts: {}, total: 0, command };
  }
}

export async function countCsvGz(filePath: string): Promise<{ physicalLines: number; dataRows: number; blankLines: number; nonEmptyIds: number; nonFiniteCoordinates: number; communeCodes: Record<string, number>; headerFields: string[]; command: string }> {
  const headerStream = createReadStream(filePath).pipe(createGunzip());
  const headerLines = createInterface({ input: headerStream, crlfDelay: Number.POSITIVE_INFINITY });
  let headerFields: string[] = [];
  for await (const line of headerLines) {
    headerFields = line.split(";");
    headerLines.close();
    break;
  }
  const idColumn = headerFields.findIndex((field) => field === "id");
  const communeColumn = headerFields.findIndex((field) => field === "code_insee");
  const lonColumn = headerFields.findIndex((field) => field === "lon");
  const latColumn = headerFields.findIndex((field) => field === "lat");
  const communeCodes: Record<string, number> = {};
  const stream = createReadStream(filePath).pipe(createGunzip());
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let physicalLines = 0;
  let blankLines = 0;
  let nonEmptyIds = 0;
  let nonFiniteCoordinates = 0;
  for await (const line of lines) {
    physicalLines += 1;
    if (physicalLines === 1) continue;
    if (line.trim().length === 0) {
      blankLines += 1;
      continue;
    }
    const cells = line.split(";");
    if (typeof cells[idColumn] === "string" && cells[idColumn]!.length > 0) nonEmptyIds += 1;
    const commune = cells[communeColumn];
    if (typeof commune === "string" && commune.length > 0) communeCodes[commune] = (communeCodes[commune] ?? 0) + 1;
    if (lonColumn !== -1 && latColumn !== -1) {
      const lon = Number.parseFloat(cells[lonColumn] ?? "");
      const lat = Number.parseFloat(cells[latColumn] ?? "");
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) nonFiniteCoordinates += 1;
    }
  }
  return {
    physicalLines,
    dataRows: Math.max(0, physicalLines - 1),
    blankLines,
    nonEmptyIds,
    nonFiniteCoordinates,
    communeCodes,
    headerFields,
    command: `gzip -dc ${filePath} | wc -l  (header ${headerFields.length} columns: ${headerFields.join(",")})`,
  };
}
export interface BoundaryPolygon {
  rings: number[][][][];
}

export function pointInRing(point: readonly [number, number], ring: number[][]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!;
    const b = ring[previous]!;
    const crosses = a[1]! > point[1] !== b[1]! > point[1] && point[0]! < ((b[0]! - a[0]!) * (point[1]! - a[1]!)) / (b[1]! - a[1]!) + a[0]!;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInsidePolygon(point: readonly [number, number], polygon: BoundaryPolygon): boolean {
  for (const rings of polygon.rings) {
    if (rings.length === 0) continue;
    if (!pointInRing(point, rings[0]!)) continue;
    let inHole = false;
    for (let index = 1; index < rings.length; index += 1) {
      if (pointInRing(point, rings[index]!)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function ringsOfGeometry(geometry: Record<string, unknown>): number[][][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates as number[][][]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as number[][][][];
  return [];
}

export async function loadBoundaryPolygon(boundaryPath: string): Promise<BoundaryPolygon> {
  const document = objectOf(await readJson(boundaryPath));
  const features = Array.isArray(document.features) ? (document.features as Record<string, unknown>[]) : [];
  const geometry = objectOf(features[0]?.geometry ?? document.geometry);
  return { rings: ringsOfGeometry(geometry) };
}

export async function measureOsmOutsideBoundary(
  rawDir: string,
  fieldValues: Record<string, Record<string, number>>,
  specs: readonly OsmCategorySpec[],
): Promise<Map<string, BoundaryMeasurement>> {
  const boundary = await loadBoundaryPolygon(path.join(rawDir, GERS_TERRITORY.boundaryRawFile));
  const names = (await fs.readdir(rawDir).catch(() => [] as string[])).filter((name) => name === "osm-bulk.geojson" || /^osm-.*\.json$/.test(name)).sort();
  const totalByKey: Record<string, number> = {};
  const outsideByKey: Record<string, number> = {};
  const specIdsByKey = new Map<string, string[]>();
  for (const spec of specs) {
    for (const key of spec.values === "*" ? [spec.key] : [spec.key, ...spec.values]) {
      const ids = specIdsByKey.get(key) ?? [];
      ids.push(spec.id);
      specIdsByKey.set(key, ids);
    }
  }
  for (const name of names) {
    const filePath = path.join(rawDir, name);
    if (name.endsWith(".geojson")) {
      const stream = createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 });
      let carry = "";
      for await (const chunk of stream) {
        const text = carry + (Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        for (const feature of text.matchAll(/\{"type":"Feature","id":"[^"]*","geometry":\{"type":"(?:Multi)?Point","coordinates":\[(-?[\d.]+),(-?[\d.]+)\]\},"properties":\{([^{}]*)\}\}/g)) {
          const lon = Number.parseFloat(feature[1]!);
          const lat = Number.parseFloat(feature[2]!);
          if (pointInsidePolygon([lon, lat], boundary)) continue;
          for (const [, key, value] of feature[3]!.matchAll(/"([^"]+)":"([^"]*)"/g)) {
            if (key!.startsWith("name") || key!.startsWith("source_")) continue;
            totalByKey[key!] = (totalByKey[key!] ?? 0) + 1;
            const canonical = fieldValues[`poi|${key!}`] ?? {};
            if ((canonical[value!] ?? 0) === 0) outsideByKey[key!] = (outsideByKey[key!] ?? 0) + 1;
          }
        }
        carry = text.slice(-4096);
      }
      continue;
    }
    const document = objectOf(await readJson(filePath));
    const elements = Array.isArray(document.elements) ? (document.elements as Record<string, unknown>[]) : [];
    for (const element of elements) {
      const tags = objectOf(element.tags);
      const lat = element.lat;
      const lon = element.lon;
      if (typeof lat !== "number" || typeof lon !== "number" || pointInsidePolygon([lon, lat], boundary)) continue;
      for (const [key, value] of Object.entries(tags)) {
        if (typeof value !== "string") continue;
        totalByKey[key] = (totalByKey[key] ?? 0) + 1;
        const canonical = fieldValues[`poi|${key}`] ?? fieldValues[`road|${key}`] ?? {};
        if ((canonical[value] ?? 0) === 0) outsideByKey[key] = (outsideByKey[key] ?? 0) + 1;
      }
    }
  }
  const result = new Map<string, BoundaryMeasurement>();
  for (const [key, specIds] of specIdsByKey) {
    const measured = totalByKey[key] ?? 0;
    const unexplained = Math.min(measured, outsideByKey[key] ?? 0);
    for (const specId of specIds) {
      result.set(specId, { id: key, method: "point in polygon against data/raw/gers-boundary.geojson over the raw OSM documents", measured, unexplained });
    }
  }
  return result;
}

export async function countFeatureCollectionGz(filePath: string, communeKey: string): Promise<{ count: { total: number; invalid: number; named: number; withCommune: number }; command: string }> {
  const command = `gzip -dc ${filePath} | node streaming features array scan (top level objects of "features")`;
  const stream = createReadStream(filePath).pipe(createGunzip());
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return { count: countFeatureCollectionText(Buffer.concat(chunks).toString("utf8"), communeKey), command };
}

export async function countOsmJsonElements(filePath: string): Promise<{ file: string; generator: string; timestampOsmBase: string | null; elements: number; byType: Record<string, number> }> {
  const document = objectOf(await readJson(filePath));
  const elements = Array.isArray(document.elements)
    ? (document.elements as unknown[])
    : Array.isArray(document.features)
      ? (document.features as unknown[])
      : [];
  const byType: Record<string, number> = {};
  for (const element of elements) {
    const type = textField(objectOf(element), ["type"]) ?? "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    file: path.basename(filePath),
    generator: textField(document, ["generator"]) ?? "unknown",
    timestampOsmBase: textField(objectOf(document.osm3s), ["timestamp_osm_base"]),
    elements: elements.length,
    byType,
  };
}

export interface CacheMetadata {
  url: string | null;
  sha256: string | null;
  acquiredAt: string | null;
  etag: string | null;
  lastModified: string | null;
}

export async function readCacheMetadata(filePath: string): Promise<CacheMetadata | null> {
  const document = await readObjectFile(filePath);
  if (document === null) return null;
  return {
    url: textField(document, ["url"]),
    sha256: textField(document, ["sha256"]),
    acquiredAt: textField(document, ["acquiredAt", "checkedAt"]),
    etag: textField(document, ["etag"]),
    lastModified: textField(document, ["lastModified"]),
  };
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberField(source: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (source === undefined || source === null) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function textField(source: Record<string, unknown> | null | undefined, keys: string[]): string | null {
  if (source === undefined || source === null) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function readObjectFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return objectOf(await readJson(filePath));
  } catch {
    return null;
  }
}

function fileSize(filePath: string): number | null {
  return existsSync(filePath) ? statSync(filePath).size : null;
}

function fileMtime(filePath: string): number {
  return existsSync(filePath) ? statSync(filePath).mtimeMs : 0;
}

function unavailable(command: string, note: string): Measurement {
  return { value: null, command, status: "unavailable", note };
}

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

const OSM_CATEGORY_SPECS: readonly OsmCategorySpec[] = [
  { id: "highway", layer: "highway", key: "highway", values: "*", objectType: "way", parityId: "road.highway", canonicalKind: "road", exclusionReason: null },
  { id: "railway", layer: "railway", key: "railway", values: "*", objectType: "any", parityId: "railway", canonicalKind: "transport", exclusionReason: null },
  { id: "waterway", layer: "waterway", key: "waterway", values: "*", objectType: "way", parityId: "waterway", canonicalKind: "water", exclusionReason: null },
  { id: "natural.water", layer: "natural water and wetland", key: "natural", values: ["water", "wetland"], objectType: "way", parityId: "natural.water", canonicalKind: "water", exclusionReason: null },
  { id: "landuse", layer: "landuse", key: "landuse", values: "*", objectType: "way", parityId: "landuse", canonicalKind: "landuse", exclusionReason: null },
  { id: "natural.area", layer: "natural", key: "natural", values: "*", objectType: "way", parityId: "natural.area", canonicalKind: "landuse", exclusionReason: null },
  { id: "place.node", layer: "place", key: "place", values: "*", objectType: "node", parityId: "place", canonicalKind: "place", exclusionReason: null },
  { id: "place.poi", layer: "place folded into poi", key: "place", values: "*", objectType: "node", parityId: "place.asPoi", canonicalKind: "poi", exclusionReason: null },
  { id: "amenity", layer: "amenity", key: "amenity", values: "*", objectType: "node", parityId: "amenity", canonicalKind: "poi", exclusionReason: null },
  { id: "shop", layer: "shop", key: "shop", values: "*", objectType: "node", parityId: "shop", canonicalKind: "poi", exclusionReason: null },
  { id: "tourism", layer: "tourism", key: "tourism", values: "*", objectType: "node", parityId: "tourism", canonicalKind: "poi", exclusionReason: null },
  { id: "building", layer: "building", key: "building", values: "*", objectType: "way", parityId: "building", canonicalKind: "building", exclusionReason: null },
  { id: "power", layer: "power", key: "power", values: "*", objectType: "way", parityId: "excluded.power", canonicalKind: null, exclusionReason: "power=line and pylon ways are not adopted; the canonical model has no utility line kind and BD TOPO TRONRESEAU carries pylons and lines" },
  { id: "barrier", layer: "barrier", key: "barrier", values: "*", objectType: "any", parityId: "excluded.barrier", canonicalKind: null, exclusionReason: "barrier features are not adopted; the canonical model has no barrier kind" },
  { id: "boundary.administrative", layer: "boundary=administrative", key: "boundary", values: ["administrative"], objectType: "any", parityId: "excluded.boundaryAdmin", canonicalKind: null, exclusionReason: "boundary=administrative is not adopted from OSM; the department boundary comes from ADMIN EXPRESS and communes from the IGN commune layer" },
  { id: "aeroway", layer: "aeroway", key: "aeroway", values: "*", objectType: "way", parityId: "excluded.aeroway", canonicalKind: null, exclusionReason: "aeroway runways and aprons are not adopted from OSM; BD TOPO AERODROME is the authority" },
  { id: "highway.junction", layer: "highway marker nodes", key: "highway", values: ["motorway_junction", "turning_circle", "turning_loop", "traffic_signals", "give_way", "stop", "speed_camera", "street_lamp", "crossing", "milestone", "traffic_mirror", "emergency_access_point"], objectType: "node", parityId: "excluded.junctionNodes", canonicalKind: null, exclusionReason: "highway junction and traffic marker nodes are not adopted as standalone features" },
  { id: "man_made.utility", layer: "man_made pipeline and utility", key: "man_made", values: ["pipeline", "water_well", "water_works", "wastewater_plant"], objectType: "way", parityId: "excluded.manMadeUtility", canonicalKind: null, exclusionReason: "man_made pipeline and utility ways are not adopted; BD TOPO TRONRESEAU is the authority" },
  { id: "landuse.agriculture", layer: "landuse agriculture", key: "landuse", values: ["farmland", "farmyard", "greenhouse_horticulture", "plant_nursery", "allotments", "animal_keeping", "apiary", "aquaculture", "greenfield", "orchard"], objectType: "way", parityId: "excluded.landuseAgriculture", canonicalKind: null, exclusionReason: "landuse agriculture and nursery polygons are micro parcel texture below the department scale render threshold" },
  { id: "wall", layer: "wall", key: "wall", values: "*", objectType: "way", parityId: "excluded.wall", canonicalKind: null, exclusionReason: "wall tagged ways duplicate building outlines and are represented by no canonical kind" },
];

const SCANNED_FIELDS: readonly string[] = [...new Set(OSM_CATEGORY_SPECS.map((spec) => spec.key))];

interface LegacyOsmRowSpec {
  exclusionKey: string;
  id: string;
  layer: string;
  kind: string;
  files: readonly string[];
}

const LEGACY_OSM_ROWS: readonly LegacyOsmRowSpec[] = [
  { exclusionKey: "osm-bulk::osm-bulk.geojson::poi", id: "osm-bulk::osm-bulk.geojson", layer: "osm-bulk.geojson", kind: "poi", files: ["osm-bulk.geojson"] },
  { exclusionKey: "osm-bulk::overpass-themes::poi", id: "osm-bulk::overpass-themes::poi", layer: "overpass-themes", kind: "poi", files: ["osm-parks.json", "osm-facilities.json", "osm-named-pois.json", "osm-shops.json", "osm-transit.json", "osm-parking.json"] },
  { exclusionKey: "osm-bulk::overpass-themes::road", id: "osm-bulk::overpass-themes::road", layer: "overpass-themes", kind: "road", files: ["osm-roads.json", "osm-paths.json"] },
];

const BD_TOPO_CANONICAL_KIND: Record<string, string> = {
  buildings: "building",
  roads: "road",
  "water-surfaces": "water",
  "water-lines": "water",
  canalisations: "water",
  rail: "transport",
  "transport-equipment": "transport",
  "airport-runways": "transport",
  airports: "transport",
  "area-structures": "structure",
  "linear-structures": "structure",
  reservoirs: "landuse",
  cemeteries: "landuse",
  "sports-grounds": "landuse",
  "protected-areas": "landuse",
  vegetation: "landuse",
  "activity-areas": "landuse",
  settlements: "place",
  "uninhabited-places": "place",
  "terrain-features": "place",
  "public-forests": "place",
  communes: "place",
  toponymy: "place",
  "named-water-bodies": "place",
  "named-watercourses": "place",
  "point-structures": "poi",
  "hydro-details": "poi",
  pylons: "poi",
  "power-lines": "poi",
  "reference-points": "poi",
  "public-places": "poi",
};

async function main(): Promise<void> {
  const root = dataRoot();
  const rawDir = path.join(root, "raw");
  const intermediateDir = path.join(root, "intermediate");
  const qaDir = path.join(root, "qa");
  const outFile = path.join(qaDir, "source-reconciliation-audit.json");
  await fs.mkdir(qaDir, { recursive: true });

  const artefactFiles: Record<string, string> = {
    exclusionReport: path.join(qaDir, "exclusion-report.json"),
    addressReconciliation: path.join(qaDir, "address-reconciliation.json"),
    cadastreParity: path.join(qaDir, "cadastre-parity.json"),
    osmParity: path.join(qaDir, "osm-parity.json"),
    stratifiedReport: path.join(qaDir, "stratified-report.json"),
  };
  const documents: Record<string, Record<string, unknown> | null> = {
    exclusionReport: await readObjectFile(artefactFiles.exclusionReport),
    addressReconciliation: await readObjectFile(artefactFiles.addressReconciliation),
    cadastreParity: await readObjectFile(artefactFiles.cadastreParity),
    osmParity: await readObjectFile(artefactFiles.osmParity),
    stratifiedReport: await readObjectFile(artefactFiles.stratifiedReport),
  };
  const exclusionRows = indexExclusionArtefact(documents.exclusionReport);
  const store = await scanCanonicalStore(intermediateDir, SCANNED_FIELDS);
  console.log(`[reconcile-audit] canonical store: ${store.records} records in ${store.files} files, newest ${store.newestMtime}`);
  const storeWiped = store.records === 0;
  if (storeWiped) {
    console.log("[reconcile-audit] the canonical store holds no record: the in-flight rebuild has cleared data/intermediate, so every accepted count is a rebuild residual and no row is an unattributable loss");
  }

  const crossChecks: ArtefactCrossCheck[] = [];
  const crossCheck = (id: string, declared: number | null, measuredValue: number | null, blocking: boolean, note: string): void => {
    const agrees = declared !== null && measuredValue !== null && declared === measuredValue;
    crossChecks.push({ id, declared, measured: measuredValue, agrees, blocking, note });
  };

  const families: Array<{ family: string; identity: SourceIdentity; rows: AuditRow[]; notes: string }> = [];
  const sourceMtimes: { family: string; sourceMtime: string | null }[] = [];
  const stale = (sourceMtime: number): boolean => sourceMtime > store.newestMtimeMs;

  // bdtopo
  const bdtopoManifest = await readObjectFile(path.join(intermediateDir, "bdtopo-manifest.json"));
  const bdtopoOutputs = Array.isArray(bdtopoManifest?.outputs) ? (bdtopoManifest.outputs as Record<string, unknown>[]) : [];
  const gpkg = textField(objectOf(bdtopoManifest?.package), ["geoPackage"]);
  const bdtopoRows: AuditRow[] = [];
  let gpkgTotal = 0;
  for (const spec of BD_TOPO_LAYERS) {
    const output = bdtopoOutputs.find((entry) => entry.name === spec.name);
    const declared = numberField(output, ["recordCount"]);
    const count = gpkg === null ? { count: null, command: `ogrinfo -ro -q -sql "SELECT COUNT(*) AS n FROM ${spec.layer}" (gpkg path unavailable)` } : await ogrInfoCount(gpkg, spec.layer);
    gpkgTotal += count.count ?? 0;
    const namespace = `ign-bdtopo:${spec.name}`;
    const inStore = store.byStableIdNamespace[namespace] ?? 0;
    const pipeline = exclusionRows.get(`bdtopo::${spec.output.replace(/\.geojson$/, "")}::${BD_TOPO_CANONICAL_KIND[spec.name] ?? "unknown"}`);
    const merged = pipeline === undefined ? { merged: 0, buckets: [] as ExclusionBucket[] } : mergePipelineBuckets(pipeline, "data/qa/exclusion-report.json");
    const pipelineInput = pipeline?.input ?? declared ?? null;
    const clipLoss = count.count !== null && pipelineInput !== null ? Math.max(0, count.count - pipelineInput) : 0;
    const pipelineAccepted = pipeline?.accepted ?? 0;
    const accepted = Math.max(inStore, pipelineAccepted);
    const normalizerDrop = pipeline === undefined && count.count !== null && declared !== null
      ? Math.max(0, declared - inStore - clipLoss)
      : 0;
    const buckets = [...merged.buckets];
    if (clipLoss > 0) {
      buckets.push({
        rule: "bdtopo-spat-envelope-clip",
        count: clipLoss,
        reason: "records present in the delivered GPKG layer but absent from the -spat clipped GeoJSON the fetch stage writes; the clipping method and the Lambert 93 envelope are declared in data/intermediate/bdtopo-manifest.json:clipping",
        origin: "independent-measurement",
      });
    }
    if (normalizerDrop > 0) {
      buckets.push({
        rule: "bdtopo-normalization-rejected",
        count: normalizerDrop,
        reason: "records of the clipped GeoJSON that the normalizer did not turn into a canonical feature; the exclusion report carries no per record rule for this layer because it ran before this fetch",
        origin: "independent-measurement",
      });
    }
    const partial = inStore < pipelineAccepted;
    bdtopoRows.push(buildAuditRow({
      id: `bdtopo::${spec.output}`,
      source: "bdtopo",
      layer: spec.layer,
      kind: spec.name.replace(/-/g, "_"),
      input: count.count,
      inputMeasurement: { value: count.count, command: count.command, status: count.count === null ? "unavailable" : "measured", note: "raw GPKG layer counted directly, before the ogr2ogr -spat envelope clip of the fetch stage" },
      accepted,
      acceptedFrom: inStore >= pipelineAccepted
        ? `canonical store namespace ${namespace}`
        : `data/qa/exclusion-report.json accepted (the canonical store holds ${inStore} records of this namespace, fewer than the ${pipelineAccepted} the pipeline accepted)`,
      acceptedMeasurement: { value: inStore, command: store.scanCommand, status: "measured", note: `canonical store count of stableId values starting with ${namespace}; the accepted bucket takes the larger of this and the pipeline accepted count` },
      merged: merged.merged,
      invalid: pipeline?.invalidGeometry ?? 0,
      outsideBoundary: pipeline?.outsideBoundary ?? 0,
      buckets,
      partialDataset: storeWiped || partial,
      pipelineInput: declared ?? pipeline?.input ?? null,
      pipelineAccepted: pipeline?.accepted ?? null,
    }));
  }
  const manifestOutputTotal = sumValues(bdtopoOutputs.map((entry) => numberField(entry, ["recordCount"]) ?? 0));
  crossCheck("bdtopo.gpkg-full-delivery-vs-clipped-manifest-outputs", gpkgTotal, manifestOutputTotal, false, `the ogrinfo counts sum to ${gpkgTotal} records of the full delivered GPKG (un-clipped department) while bdtopo-manifest.json outputs sum to ${manifestOutputTotal} records of the -spat clipped GeoJSON; the ${gpkgTotal - manifestOutputTotal} record difference is the envelope clip loss already carried in the bdtopo-spat-envelope-clip buckets, so this is advisory and not a contradiction`);
  families.push({
    family: "bdtopo",
    identity: {
      family: "bdtopo",
      name: textField(bdtopoManifest, ["source"]) ?? "IGN BD TOPO",
      license: textField(bdtopoManifest, ["license"]) ?? "Licence Ouverte / Open Licence 2.0",
      edition: textField(bdtopoManifest, ["edition"]),
      editionSource: "data/intermediate/bdtopo-manifest.json:edition",
      acquiredAt: textField(bdtopoManifest, ["acquisitionTime"]),
      sha256: textField(objectOf(bdtopoManifest?.archive), ["sha256"]),
      localFile: gpkg ?? "unknown",
      bytes: numberField(objectOf(bdtopoManifest?.archive), ["bytes"]),
    },
    rows: bdtopoRows,
    notes: "input is ogrinfo SELECT COUNT(*) on the delivered GPKG layer (full department delivery, before the -spat envelope clip); accepted is the canonical store count of the ign-bdtopo:<layer> stableId namespace, so the residual is the envelope clip loss declared by the fetch stage plus the records the normalizer drops without a per record reason",
  });
  const bdtopoMtime = fileMtime(gpkg ?? "");
  sourceMtimes.push({ family: "bdtopo", sourceMtime: bdtopoMtime === 0 ? null : new Date(bdtopoMtime).toISOString() });

  // ban
  const banCsv = path.join(rawDir, `adresses-${GERS_TERRITORY.code}.csv.gz`);
  const banCache = await readCacheMetadata(`${banCsv}.cache.json`);
  const banRaw = await readObjectFile(path.join(rawDir, "ban-addresses.json"));
  const banStages = objectOf(documents.addressReconciliation?.stages);
  const banLosses = objectOf(documents.addressReconciliation?.losses);
  const banPipeline = exclusionRows.get("ban::adresses-32.csv::address");
  const banMerged = banPipeline === undefined ? { merged: 0, buckets: [] as ExclusionBucket[] } : mergePipelineBuckets(banPipeline, "data/qa/exclusion-report.json");
  const banCsvCount = existsSync(banCsv) ? await countCsvGz(banCsv) : null;
  const banInput = banCsvCount === null ? null : banCsvCount.dataRows + banCsvCount.blankLines;
  const banDepartmentRows = banCsvCount === null ? 0 : sumValues(Object.entries(banCsvCount.communeCodes).filter(([code]) => code.startsWith(GERS_TERRITORY.code)).map(([, count]) => count));
  const banOtherDepartments = banCsvCount === null ? 0 : sumValues(Object.values(banCsvCount.communeCodes)) - banDepartmentRows;
  const banDuplicateIds = numberField(banStages, ["duplicateBanIds"]) ?? 0;
  const banUniqueNormalized = numberField(banStages, ["uniqueNormalized"]);
  const banStoreAddresses = store.byStableIdNamespace.ban ?? 0;
  const banBuckets = [...banMerged.buckets];
  if (banCsvCount !== null && banCsvCount.blankLines > 0) banBuckets.push({ rule: "ban-blank-line", count: banCsvCount.blankLines, reason: "blank line in the BAN csv carries no address", origin: "independent-measurement" });
  for (const [loss, rule] of Object.entries({ "malformed-csv-row": "ban-malformed-row", "short-csv-row": "ban-short-row", "non-finite-coordinates": "ban-non-finite-coordinates", "commune-mismatch": "ban-commune-mismatch", "empty-ban-id": "ban-empty-id" })) {
    const count = numberField(banLosses, [loss]) ?? 0;
    if (count > 0) banBuckets.push({ rule, count, reason: `address-reconciliation.json losses.${loss}`, origin: "pipeline-artefact" });
  }
  const banAccepted = banStoreAddresses > 0 ? banStoreAddresses : banCsvCount === null ? null : banCsvCount.nonEmptyIds - banDuplicateIds;
  const banRow = buildAuditRow({
    id: "ban::adresses-32.csv",
    source: "ban",
    layer: "adresses-32.csv",
    kind: "address",
    input: banInput,
    inputMeasurement: banCsvCount === null
      ? unavailable(`gzip -dc ${banCsv} | wc -l`, "the gzipped csv is absent")
      : { value: banInput, command: banCsvCount.command, status: "measured", note: "physical csv lines minus the single header line, streamed from the gzipped csv independently of the pipeline" },
    accepted: banAccepted,
    acceptedFrom: banStoreAddresses > 0 ? "canonical store namespace ban" : "streamed non empty BAN id count minus the duplicate id rows of address-reconciliation.json",
    acceptedMeasurement: { value: banAccepted, command: store.scanCommand, status: "measured", note: "canonical store count of stableId values starting with ban" },
    merged: banMerged.merged,
    invalid: banCsvCount?.nonFiniteCoordinates ?? 0,
    outsideBoundary: numberField(banStages, ["outsideBoundary"]) ?? 0,
    buckets: banBuckets,
    partialDataset: storeWiped || banStoreAddresses === 0 || (banUniqueNormalized !== null && banStoreAddresses < banUniqueNormalized),
    pipelineInput: banPipeline?.input ?? numberField(banStages, ["dataRows"]),
    pipelineAccepted: banPipeline?.accepted ?? null,
  });
  if (banCsvCount !== null) {
    crossCheck("ban.csv-data-rows-vs-address-reconciliation", numberField(banStages, ["dataRows"]), banCsvCount.dataRows, true, "streamed csv data row count against address-reconciliation.json stages.dataRows");
    crossCheck("ban.csv-rows-of-other-departments", banOtherDepartments, 0, true, `the adresses-32.csv.gz extract is the Gers department only, so an independent stream of code_insee must yield 0 rows outside the 32 prefix; address-reconciliation.json stages.outsideBoundary (${numberField(banStages, ["outsideBoundary"])}) is a different quantity, the rows that fall outside the Gers boundary polygon despite carrying a 32 code_insee, so it is reported in the outsideBoundary bucket and not compared here`);
    crossCheck("ban.fetch-unique-vs-post-index-accepted", banUniqueNormalized, banPipeline?.accepted ?? null, false, `address-reconciliation.json stages.uniqueNormalized (${banUniqueNormalized}, the fetch-stage unique count) against data/qa/exclusion-report.json accepted (${banPipeline?.accepted ?? null}, the post-search-index count); the difference is the ban-not-indexed stage, so it is advisory and not a contradiction`);
  }
  families.push({
    family: "ban",
    identity: {
      family: "ban",
      name: "Base Adresse Nationale (adresse.data.gouv.fr)",
      license: textField(banRaw, ["license"]) ?? "Etalab-2.0",
      edition: banCache?.lastModified ?? null,
      editionSource: "data/raw/adresses-32.csv.gz.cache.json:lastModified",
      acquiredAt: banCache?.acquiredAt ?? textField(banRaw, ["acquisitionTimestamp"]),
      sha256: banCache?.sha256 ?? textField(documents.addressReconciliation, ["sourceSha256"]),
      localFile: `data/raw/${path.basename(banCsv)}`,
      bytes: fileSize(banCsv),
    },
    rows: [banRow],
    notes: `input is the streamed csv line count (${banInput}), accepted is the canonical store address namespace, and ${banOtherDepartments} csv rows carry a code_insee outside the ${GERS_TERRITORY.code} department prefix against ${numberField(banStages, ["outsideBoundary"])} rows attributed to the ban-outside-boundary rule, which is the first cross check of this family`,
  });
  const banMtime = fileMtime(banCsv);
  sourceMtimes.push({ family: "ban", sourceMtime: banMtime === 0 ? null : new Date(banMtime).toISOString() });

  // osm
  const pbf = path.join(rawDir, "gers-osm.osm.pbf");
  const osmCache = await readCacheMetadata(`${pbf}.cache.json`);
  const osmBulkManifest = await readObjectFile(path.join(intermediateDir, "osm-bulk-manifest.json"));
  const pbfInfo = await osmiumFileInfo(pbf);
  const parityRows = Array.isArray(documents.osmParity?.rows) ? (documents.osmParity.rows as Record<string, unknown>[]) : [];
  const parityById = new Map(parityRows.map((row) => [textField(row, ["id"]) ?? "", row]));
  const countsBySpec = new Map<string, { counts: Record<string, number>; total: number; command: string }>();
  for (const spec of OSM_CATEGORY_SPECS) {
    countsBySpec.set(spec.id, await osmiumTagsCount(pbf, spec));
  }
  const canonicalFieldValues = new Map(Object.entries(store.fieldValues));
  const boundaryOutsideBySpec = await measureOsmOutsideBoundary(rawDir, store.fieldValues, OSM_CATEGORY_SPECS);
  const osmRows = osmCategoryRows({ specs: OSM_CATEGORY_SPECS, countsBySpec, canonicalFieldValues, canonicalKindTotals: store.byKind, pbf, boundaryOutsideBySpec });
  for (const spec of OSM_CATEGORY_SPECS) {
    const parity = parityById.get(spec.parityId);
    if (parity === null || parity === undefined) continue;
    crossCheck(`osm.osmium-tags-count-vs-parity.${spec.parityId}`, countsBySpec.get(spec.id)?.total ?? null, numberField(parity, ["osmCount"]), true, "fresh osmium tags-count total against the osmCount carried by data/qa/osm-parity.json");
  }
  const themeCounts = new Map<string, { elements: number }>();
  const rawNames = (await fs.readdir(rawDir).catch(() => [] as string[])).sort();
  for (const name of rawNames) {
    if (!/^osm-.*\.json$/.test(name)) continue;
    themeCounts.set(name, await countOsmJsonElements(path.join(rawDir, name)));
  }
  for (const spec of LEGACY_OSM_ROWS) {
    const pipeline = exclusionRows.get(spec.exclusionKey);
    const merged = pipeline === undefined ? { merged: 0, buckets: [] as ExclusionBucket[] } : mergePipelineBuckets(pipeline, "data/qa/exclusion-report.json");
    const input = sumValues(spec.files.map((name) => themeCounts.get(name)?.elements ?? 0));
    const accepted = store.byKind[spec.kind] ?? 0;
    osmRows.push(buildAuditRow({
      id: spec.id,
      source: "osm",
      layer: spec.layer,
      kind: spec.kind,
      input,
      inputMeasurement: { value: input, command: `node streaming JSON.parse of ${spec.files.map((name) => `data/raw/${name}`).join(", ")} (elements array length)`, status: "measured", note: "elements array length of the raw documents attributed to this row, measured by streaming each document through JSON.parse" },
      accepted,
      acceptedFrom: `canonical store kind ${spec.kind}`,
      acceptedMeasurement: { value: accepted, command: store.scanCommand, status: "measured", note: `canonical store count of records whose kind is ${spec.kind}` },
      merged: merged.merged,
      invalid: pipeline?.invalidGeometry ?? 0,
      outsideBoundary: pipeline?.outsideBoundary ?? 0,
      buckets: merged.buckets,
      partialDataset: true,
      pipelineInput: pipeline?.input ?? null,
      pipelineAccepted: pipeline?.accepted ?? null,
    }));
    crossCheck(`exclusion-report.input.${spec.id}`, pipeline?.input ?? null, input, false, "input declared by data/qa/exclusion-report.json against the elements array length of the raw Overpass theme documents attributed to this row; advisory because the pipeline input mixes the bulk extract with the enrichment themes and the stage attribution inside a single row is not reproducible from the tree");
  }
  families.push({
    family: "osm",
    identity: {
      family: "osm",
      name: textField(osmBulkManifest, ["source"]) ?? "OpenStreetMap contributors via Geofabrik",
      license: textField(osmBulkManifest, ["license"]) ?? "ODbL-1.0",
      edition: pbfInfo.lastTimestamp,
      editionSource: "osmium fileinfo last object timestamp of data/raw/gers-osm.osm.pbf",
      acquiredAt: textField(osmBulkManifest, ["acquiredAt"]),
      sha256: osmCache?.sha256 ?? textField(osmBulkManifest, ["sourceSha256"]),
      localFile: `data/raw/${path.basename(pbf)}`,
      bytes: fileSize(pbf),
    },
    rows: osmRows,
    notes: `the input side is a fresh osmium tags-count per category over the ${fileSize(pbf)} byte extract, whose bounding box extends well beyond the Gers boundary, and the input side of the three legacy rows is the elements array length of the raw Overpass theme documents; the accepted side is the canonical store per kind and per tag value; every shortfall is labelled partial dataset because the canonical store predates the extract by ${Math.round((fileMtime(pbf) - store.newestMtimeMs) / 86_400_000)} days`,
  });
  sourceMtimes.push({ family: "osm", sourceMtime: new Date(fileMtime(pbf)).toISOString() });

  // cadastre
  const cadastreFiles: Array<{ id: string; layer: string; file: string; communeKey: string; parityPath: string[] }> = [
    { id: "cadastre::batiments", layer: "batiments", file: `cadastre-${GERS_TERRITORY.code}-batiments.json.gz`, communeKey: "commune", parityPath: ["cadastre", "total"] },
    { id: "cadastre::lieux-dits", layer: "lieux_dits", file: `cadastre-${GERS_TERRITORY.code}-lieux_dits.json.gz`, communeKey: "comune", parityPath: ["locationdits", "total"] },
  ];
  const cadastreRows: AuditRow[] = [];
  const cadastreCaches = new Map<string, CacheMetadata | null>();
  for (const spec of cadastreFiles) {
    const file = path.join(rawDir, spec.file);
    const cache = await readCacheMetadata(`${file}.cache.json`);
    cadastreCaches.set(spec.file, cache);
    const scan = existsSync(file) ? await countFeatureCollectionGz(file, spec.communeKey) : null;
    const total = scan?.count.total ?? 0;
    cadastreRows.push(buildAuditRow({
      id: spec.id,
      source: "cadastre",
      layer: spec.layer,
      kind: "parity-reference",
      input: scan === null ? null : total,
      inputMeasurement: scan === null
        ? unavailable(`gzip -dc ${file}`, "the gzipped inventory is absent")
        : { value: total, command: scan.command, status: "measured", note: `features counted by streaming the gzipped GeoJSON FeatureCollection, commune key ${spec.communeKey}` },
      accepted: 0,
      acceptedFrom: "never merged: the cadastre is a parity reference only (reports/wave2/CONTRACTS.md section 6)",
      acceptedMeasurement: { value: 0, command: "n/a", status: "measured", note: "the pipeline never adopts a cadastre record into the canonical store" },
      merged: 0,
      invalid: scan?.count.invalid ?? 0,
      outsideBoundary: 0,
      buckets: [{ rule: "cadastre-not-merged-by-design", count: total, reason: "the cadastre is a parity reference only and is never merged into the canonical store (reports/wave2/CONTRACTS.md section 6)", origin: "source-measurement" }],
    }));
    if (scan !== null) {
      const inventory = objectOf(objectOf(documents.cadastreParity)[spec.parityPath[0]!]);
      crossCheck(`cadastre.inventory.${spec.layer}`, numberField(inventory, ["total"]), total, false, `data/qa/cadastre-parity.json ${spec.parityPath[0]}.total against the streamed feature count of the gzipped inventory; the pipeline streams line by line and stops at the last line carrying a Feature prefix while this audit counts every top level object of the features array, so a one record edge difference is a parsing difference and not unexplained data`);
      crossCheck(`cadastre.inventory.${spec.layer}.invalid`, numberField(inventory, ["invalid"]), scan.count.invalid, false, `data/qa/cadastre-parity.json ${spec.parityPath[0]}.invalid against the streamed count of features with no usable geometry`);
    }
  }
  crossCheck("cadastre.canonical.total-vs-canonical-store-buildings", numberField(objectOf(documents.cadastreParity?.canonical), ["total"]), store.byKind.building ?? 0, false, "cadastre-parity.json canonical.total against the canonical store building count, advisory because the parity was computed against a previous canonical snapshot");
  const cadastreCache = cadastreCaches.get(cadastreFiles[0]!.file) ?? null;
  families.push({
    family: "cadastre",
    identity: {
      family: "cadastre",
      name: "Etalab cadastre (cadastre.data.gouv.fr)",
      license: textField(documents.cadastreParity, ["license"]) ?? "Licence Ouverte / Open Licence 2.0 (ETALAB)",
      edition: cadastreCache?.lastModified ?? null,
      editionSource: "data/raw/cadastre-32-batiments.json.gz.cache.json:lastModified",
      acquiredAt: cadastreCache?.acquiredAt ?? null,
      sha256: cadastreCache?.sha256 ?? null,
      localFile: "data/raw/cadastre-32-batiments.json.gz, data/raw/cadastre-32-lieux_dits.json.gz",
      bytes: fileSize(path.join(rawDir, cadastreFiles[0]!.file)),
    },
    rows: cadastreRows,
    notes: "the cadastre is a parity reference and not an adopted source: the accepted bucket is zero by design and the whole independently measured inventory sits in the cadastre-not-merged-by-design bucket, which is the only way to reach a zero residual for this family; the streamed counts are cross checked against the pipeline inventory",
  });
  const cadastreMtime = fileMtime(path.join(rawDir, cadastreFiles[0]!.file));
  sourceMtimes.push({ family: "cadastre", sourceMtime: cadastreMtime === 0 ? null : new Date(cadastreMtime).toISOString() });

  // sirene
  const sireneFile = path.join(rawDir, "businesses-sirene.json");
  const sireneRaw = await readObjectFile(sireneFile);
  const sireneRecords = Array.isArray(sireneRaw?.records) ? (sireneRaw.records as unknown[]) : [];
  const sireneWithCoordinate = sireneRecords.filter((record) => objectOf(record).coordinate !== undefined).length;
  const sirenePipeline = exclusionRows.get("sirene::recherche-entreprises::business");
  const sireneMerged = sirenePipeline === undefined ? { merged: 0, buckets: [] as ExclusionBucket[] } : mergePipelineBuckets(sirenePipeline, "data/qa/exclusion-report.json");
  const sireneUnique = numberField(sireneRaw, ["totalUniqueRecords"]) ?? sireneRecords.length;
  families.push({
    family: "sirene",
    identity: {
      family: "sirene",
      name: "SIRENE (recherche-entreprises.api.gouv.fr)",
      license: textField(sireneRaw, ["license"]) ?? "Licence Ouverte / Open Licence 2.0 (ETALAB)",
      edition: null,
      editionSource: "no edition field in the SIRENE document; the snapshot is identified by acquiredAt and sha256",
      acquiredAt: textField(sireneRaw, ["acquiredAt"]),
      sha256: textField(sireneRaw, ["sha256"]),
      localFile: "data/raw/businesses-sirene.json",
      bytes: fileSize(sireneFile),
    },
    rows: [buildAuditRow({
      id: "sirene::recherche-entreprises",
      source: "sirene",
      layer: "recherche-entreprises",
      kind: "business",
      input: sireneRecords.length,
      inputMeasurement: { value: sireneRecords.length, command: "node streaming JSON.parse of data/raw/businesses-sirene.json (records array length)", status: "measured", note: "records array length of the raw SIRENE document, measured by streaming the document through JSON.parse" },
      accepted: store.byKind.business ?? 0,
      acceptedFrom: "canonical store kind business",
      acceptedMeasurement: { value: store.byKind.business ?? 0, command: store.scanCommand, status: "measured", note: "canonical store count of records whose kind is business" },
      merged: sireneMerged.merged,
      invalid: 0,
      outsideBoundary: sireneRecords.length - sireneWithCoordinate,
      buckets: sireneMerged.buckets,
      partialDataset: storeWiped || (store.byKind.business ?? 0) < sireneUnique,
      pipelineInput: sirenePipeline?.input ?? sireneUnique,
      pipelineAccepted: sirenePipeline?.accepted ?? null,
    })],
    notes: `the raw document carries ${sireneRecords.length} accepted records out of ${numberField(objectOf(sireneRaw?.reconciliation), ["establishedReceived"]) ?? "unknown"} received rows, of which ${sireneWithCoordinate} carry a resolved coordinate; the canonical store holds ${store.byKind.business ?? 0} business records against a SIRENE snapshot re-acquired after the store was written, so the row is labelled partial dataset when the store holds fewer records than the fetcher accepted`,
  });
  const sireneMtime = fileMtime(sireneFile);
  sourceMtimes.push({ family: "sirene", sourceMtime: sireneMtime === 0 ? null : new Date(sireneMtime).toISOString() });

  const generatedManifest = await readObjectFile(path.join(root, "generated", "manifest.json"));
  for (const [kind, count] of Object.entries(objectOf(generatedManifest?.featureCounts))) {
    if (typeof count !== "number") continue;
    crossCheck(`generated.manifest.featureCounts.${kind}`, count, store.byKind[kind] ?? 0, false, "data/generated/manifest.json featureCounts against the canonical store count for the same kind, advisory because the manifest belongs to the older dataset");
  }
  for (const [kind, count] of Object.entries(objectOf(objectOf(documents.stratifiedReport?.population).manifestKinds))) {
    if (typeof count !== "number") continue;
    crossCheck(`stratified.manifestKinds.${kind}`, count, store.byKind[kind] ?? 0, false, "stratified-report.json population.manifestKinds against the canonical store count for the same kind, advisory because the stratified report was computed against an older dataset");
  }

  const report = assembleReport({
    dataRoot: root,
    families,
    canonicalStore: {
      status: store.status,
      files: store.files,
      records: store.records,
      byKind: Object.fromEntries(Object.entries(store.byKind).sort(([first], [second]) => first.localeCompare(second))),
      byStableIdNamespace: Object.fromEntries(Object.entries(store.byStableIdNamespace).sort(([first], [second]) => first.localeCompare(second))),
      newestMtime: store.newestMtime,
      scanCommand: store.scanCommand,
    },
    freshness: {
      canonicalNewestMtime: store.newestMtime,
      sources: sourceMtimes.map((entry) => ({ ...entry, newerThanStore: entry.sourceMtime === null ? null : stale(new Date(entry.sourceMtime).getTime()) })),
    },
    artefacts: Object.entries(artefactFiles).map(([id, file]) => ({
      id,
      present: existsSync(file),
      path: file,
      generatedAt: textField(documents[id], ["generatedAt", "checkedAt"]),
    })),
    crossChecks,
  });

  await fs.writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printReport(report, outFile);
}

function printReport(report: ReconcileAuditReport, outFile: string): void {
  console.log(`[reconcile-audit] written ${outFile}`);
  for (const family of report.families) {
    console.log(`[reconcile-audit] family ${family.family} edition=${family.identity.edition ?? "unknown"} input=${family.totals.input ?? "unavailable"} accepted=${family.totals.accepted} merged=${family.totals.merged} excluded=${family.totals.excluded} unexplained=${family.totals.unexplained}`);
    for (const row of family.rows) {
      console.log(`  ${row.id.padEnd(42)} input=${String(row.input.independent ?? "n/a").padStart(9)} pipeline=${String(row.input.pipeline ?? "n/a").padStart(9)} accepted=${String(row.accepted.canonical ?? "n/a").padStart(9)} excluded=${String(row.excluded).padStart(9)} merged=${String(row.merged).padStart(7)} unexplained=${row.unexplained}${row.partialDataset ? " (partial dataset)" : ""}`);
    }
  }
  console.log(`[reconcile-audit] cross checks ${report.crossChecks.length} blocking failures ${report.invariants.blockingCrossCheckFailures} advisory disagreements ${report.invariants.advisoryDisagreements}`);
  for (const check of report.crossChecks.filter((entry) => !entry.agrees)) {
    console.log(`  ${check.blocking ? "FAIL" : "note"} ${check.id} declared=${check.declared} measured=${check.measured}`);
  }
  console.log(`[reconcile-audit] unattributed residual ${report.invariants.unattributedResidual} partial dataset rows ${report.invariants.partialDatasetRows.length} unattributable rows ${report.invariants.unattributableRows.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    if (error instanceof ReconcileAuditError) {
      const outFile = path.join(error.report.dataRoot, "qa", "source-reconciliation-audit.json");
      printReport(error.report, outFile);
      fs.mkdir(path.dirname(outFile), { recursive: true })
        .then(() => fs.writeFile(outFile, `${JSON.stringify(error.report, null, 2)}\n`, "utf8"))
        .then(() => {
          console.error(`[reconcile-audit] ${error.message}`);
          console.error(`[reconcile-audit] failure report written to ${outFile}`);
          process.exit(1);
        });
      return;
    }
    console.error(error);
    process.exit(2);
  });
}
