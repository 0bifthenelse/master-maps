import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as crypto from "node:crypto";

async function* records(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let buffer = "";
  let scanned = 0;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for await (const piece of stream) {
    buffer += piece as string;
    while (scanned < buffer.length) {
      const c = buffer[scanned]!;
      scanned += 1;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "{") { if (depth === 0) start = scanned - 1; depth += 1; continue; }
      if (c === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) { yield buffer.slice(start, scanned); start = -1; }
      }
    }
    if (start >= 0) { buffer = buffer.slice(start); scanned -= start; start = 0; }
    else { buffer = ""; scanned = 0; }
  }
}

async function main(): Promise<void> {
  const dir = process.argv[2]!;
  const digest = crypto.createHash("sha256");
  const perKind = new Map<string, number>();
  let total = 0;
  for (const name of (await fs.readdir(dir)).sort()) {
    if (!name.endsWith(".json") || name === "provenance.json") continue;
    const kind = name.replace(/-\d{4}\.json$/, "").replace(/\.json$/, "");
    let count = 0;
    for await (const raw of records(`${dir}/${name}`)) {
      const id = /"stableId":"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? "";
      digest.update(`${id}\n`);
      count += 1;
      total += 1;
    }
    perKind.set(kind, (perKind.get(kind) ?? 0) + count);
  }
  console.log(JSON.stringify({ dir, total, perKind: Object.fromEntries([...perKind.entries()].sort()), stableIdMultisetSha256: digest.digest("hex") }));
}

main().catch((error: unknown) => { console.error(error); process.exit(1); });
