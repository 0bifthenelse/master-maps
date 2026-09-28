import { createReadStream, readdirSync } from "node:fs";
async function* records(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  let buffer = ""; let scanned = 0; let depth = 0; let start = -1; let inString = false; let escaped = false;
  for await (const piece of stream) {
    buffer = buffer.length === 0 ? (piece as string) : buffer + (piece as string);
    while (scanned < buffer.length) {
      const c = buffer[scanned]!; scanned += 1;
      if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; continue; }
      if (c === '"') { inString = true; continue; }
      if (c === "{") { if (depth === 0) start = scanned - 1; depth += 1; continue; }
      if (c === "}") { depth -= 1; if (depth === 0 && start >= 0) { yield buffer.slice(start, scanned); start = -1; } }
    }
    buffer = start >= 0 ? buffer.slice(start) : ""; scanned = 0; start = buffer.length === 0 ? -1 : 0;
  }
}
(async () => {
  for (const file of readdirSync("data/intermediate").filter(f => f.endsWith(".json")).sort()) {
    let n = 0;
    try {
      for await (const raw of records(`data/intermediate/${file}`)) { n += 1; JSON.parse(raw); }
    } catch (e) {
      console.log("BAD", file, "record", n, String(e).slice(0, 100));
    }
  }
  console.log("done");
})();
