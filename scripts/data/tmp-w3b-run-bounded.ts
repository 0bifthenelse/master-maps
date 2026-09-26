import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deduplicateStreaming } from "./deduplicate";

async function main(): Promise<void> {
  const inDir = process.argv[2]!;
  const outDir = process.argv[3]!;
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const stats = await deduplicateStreaming(inDir, outDir);
  let peakRss = 0;
  try {
    const status = fs.readFileSync(`/proc/${process.pid}/status`, "utf8");
    const match = /VmHWM:\s+(\d+) kB/.exec(status);
    if (match) peakRss = Number(match[1]) * 1024;
  } catch {}
  const kinds = new Map<string, number>();
  for (const name of fs.readdirSync(outDir).sort()) {
    if (!name.endsWith(".json") || name === "provenance.json") continue;
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(outDir, name), "utf8"));
    if (Array.isArray(parsed)) kinds.set(name, (kinds.get(name) ?? 0) + parsed.length);
  }
  const rows = stats;
  fs.writeFileSync(
    path.join(os.tmpdir(), "w3b-bounded-stats.json"),
    JSON.stringify({ stats: rows, peakRssBytes: peakRss, wallMs: Date.now() - started, kinds: Object.fromEntries(kinds) }, null, 2)
  );
  console.error(`BOUNDED ${JSON.stringify(rows)} peakRssBytes=${peakRss} wallMs=${Date.now() - started}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
