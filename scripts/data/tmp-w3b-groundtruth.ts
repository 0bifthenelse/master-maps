import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deduplicateAllInMemory, deduplicateStreaming, createDedupAccounting } from "./deduplicate";
import type { SourceLayerAccounting } from "./exclusion-report";

const SRC = "/tmp/w3b-in";
const SKIP = new Set([
  "provenance.json", "boundary-source.json", "auch-boundary-source.json", "bdtopo-manifest.json",
  "ign-unavailable.json", "osm-manifest.json", "auch-osm-manifest.json", "osm-bulk-manifest.json",
  "relation-issues.json", "normalization-issues.json",
]);

function rowsSignature(rows: SourceLayerAccounting[]): string[] {
  return rows
    .map((row) =>
      [row.source, row.layer, row.kind, row.input, row.accepted, row.mergedDeduplicated,
        row.excludedByRule.map((e) => `${e.rule}=${e.count}`).sort().join("+")].join("|"))
    .sort();
}

async function canonicalMultiset(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith(".json") || name === "provenance.json") continue;
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) out.push(JSON.stringify(value, Object.keys(value as object).sort()));
  }
  return out.sort();
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "w3b-gt-"));
  const all = await fs.readdir(SRC);
  const names: string[] = [];
  for (const n of all) {
    if (!n.endsWith(".json") || SKIP.has(n)) continue;
    const stat = await fs.stat(path.join(SRC, n));
    if (stat.size === 0) { console.log("SKIP empty", n); continue; }
    names.push(n);
  }
  names.sort();
  const byKind = new Map<string, string[]>();
  for (const name of names) {
    const kind = name.replace(/-\d{4}\.json$/, "").replace(/\.json$/, "");
    const list = byKind.get(kind) ?? [];
    list.push(name);
    byKind.set(kind, list);
  }
  const report: Record<string, unknown>[] = [];
  for (const [kind, files] of [...byKind.entries()].sort()) {
    const inDir = path.join(root, `in-${kind}`);
    const refOut = path.join(root, `ref-${kind}`);
    const boundedOut = path.join(root, `bounded-${kind}`);
    for (const dir of [inDir, refOut, boundedOut]) await fs.mkdir(dir);
    for (const name of files) await fs.link(path.join(SRC, name), path.join(inDir, name));

    const refAccounting = createDedupAccounting();
    const refStats = { peak: 0, ms: 0 };
    const t0 = Date.now();
    await deduplicateAllInMemory(inDir, refOut, refAccounting);
    refStats.ms = Date.now() - t0;
    refStats.peak = Number(/VmHWM:\s+(\d+) kB/.exec(fsSyncReadStatus())?.[1] ?? 0) * 1024;

    const boundedAccounting = createDedupAccounting();
    const b0 = Date.now();
    const stats = await deduplicateStreaming(inDir, boundedOut, boundedAccounting);
    const boundedMs = Date.now() - b0;

    const refCanon = await canonicalMultiset(refOut);
    const boundedCanon = await canonicalMultiset(boundedOut);
    const refIds = refCanon.map((v) => (JSON.parse(v) as { stableId: string }).stableId).sort();
    const boundedIds = boundedCanon.map((v) => (JSON.parse(v) as { stableId: string }).stableId).sort();
    const rowsRef = rowsSignature(refAccounting.sources.rows());
    const rowsBounded = rowsSignature(boundedAccounting.sources.rows());
    report.push({
      kind,
      input: stats.input,
      referenceEmitted: refCanon.length,
      boundedEmitted: boundedCanon.length,
      featuresIdentical: JSON.stringify(refCanon) === JSON.stringify(boundedCanon),
      stableIdMultisetIdentical: JSON.stringify(refIds) === JSON.stringify(boundedIds),
      accountingRowsIdentical: JSON.stringify(rowsRef) === JSON.stringify(rowsBounded),
      referencePeakRssBytes: refStats.peak,
      referenceMs: refStats.ms,
      boundedMs,
      rowDeltas: rowsRef.length === rowsBounded.length ? rowsRef.filter((r, i) => r !== rowsBounded[i]).slice(0, 5) : ["ROW_COUNT_DIFFERS"],
    });
    console.log(JSON.stringify(report[report.length - 1]));
    for (const dir of [inDir, refOut, boundedOut]) await fs.rm(dir, { recursive: true, force: true });
  }
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log("REPORT", path.join(root, "report.json"));
  const totals = report.reduce(
    (acc, r) => ({
      input: acc.input + (r.input as number),
      referenceEmitted: acc.referenceEmitted + (r.referenceEmitted as number),
      boundedEmitted: acc.boundedEmitted + (r.boundedEmitted as number),
      featuresIdentical: acc.featuresIdentical && (r.featuresIdentical as boolean),
      stableIdMultisetIdentical: acc.stableIdMultisetIdentical && (r.stableIdMultisetIdentical as boolean),
      accountingRowsIdentical: acc.accountingRowsIdentical && (r.accountingRowsIdentical as boolean),
    }),
    { input: 0, referenceEmitted: 0, boundedEmitted: 0, featuresIdentical: true, stableIdMultisetIdentical: true, accountingRowsIdentical: true }
  );
  console.log("TOTALS", JSON.stringify(totals));
}

function fsSyncReadStatus(): string {
  // eslint-disable-next-line
  return readFileSync(`/proc/${process.pid}/status`, "utf8");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
