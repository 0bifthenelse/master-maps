import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { deduplicateAllInMemory, deduplicateStreaming, createDedupAccounting } from "./deduplicate";
import type { SourceLayerAccounting } from "./exclusion-report";

const SRC = "/tmp/w3b-in";

function peakRss(): number {
  return Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync(`/proc/${process.pid}/status`, "utf8"))?.[1] ?? 0) * 1024;
}

function rowsSignature(rows: SourceLayerAccounting[]): string[] {
  return rows
    .map((row) =>
      [row.source, row.layer, row.kind, row.input, row.accepted, row.mergedDeduplicated,
        row.excludedByRule.map((e) => `${e.rule}=${e.count}`).sort().join("+")].join("|"))
    .sort();
}

async function stableIdsOf(dir: string): Promise<string[]> {
  const ids: string[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith(".json") || name === "provenance.json") continue;
    const parsed: unknown = JSON.parse(await fs.readFile(`${dir}/${name}`, "utf8"));
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) ids.push((value as { stableId: string }).stableId);
  }
  return ids.sort();
}

async function countsByKind(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith(".json") || name === "provenance.json") continue;
    const parsed: unknown = JSON.parse(await fs.readFile(`${dir}/${name}`, "utf8"));
    if (!Array.isArray(parsed)) continue;
    out[name.replace(/-\d{4}\.json$/, "").replace(/\.json$/, "")] = (out[name.replace(/-\d{4}\.json$/, "").replace(/\.json$/, "")] ?? 0) + parsed.length;
  }
  return out;
}

async function main(): Promise<void> {
  const mode = process.argv[2]!;
  const outDir = process.argv[3]!;
  await fs.mkdir(outDir, { recursive: true });
  const started = Date.now();
  if (mode === "reference") {
    const accounting = createDedupAccounting();
    await deduplicateAllInMemory(SRC, outDir, accounting);
    await fs.writeFile(`${outDir}/../rows-reference.json`, JSON.stringify(rowsSignature(accounting.sources.rows()), null, 1));
    await fs.writeFile(`${outDir}/../ids-reference.json`, JSON.stringify(await stableIdsOf(outDir)));
  } else {
    const accounting = createDedupAccounting();
    const stats = await deduplicateStreaming(SRC, outDir, accounting);
    await fs.writeFile(`${outDir}/../rows-bounded.json`, JSON.stringify(rowsSignature(accounting.sources.rows()), null, 1));
    await fs.writeFile(`${outDir}/../ids-bounded.json`, JSON.stringify(await stableIdsOf(outDir)));
    console.log("BOUNDED_STATS", JSON.stringify(stats));
  }
  console.log("PEAK_RSS_BYTES", peakRss(), "WALL_MS", Date.now() - started, "MODE", mode);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
