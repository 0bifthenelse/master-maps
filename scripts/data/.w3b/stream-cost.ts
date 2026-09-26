import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { gzip, gzipSync } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const gz = promisify(gzip);
const file = "data/intermediate/road-0001.json";
async function main(): Promise<void> {
  let n = 0, bytes = 0;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  let t0 = performance.now();
  for await (const line of rl) { n++; bytes += line.length; }
  console.log(`readline 20000 lines (${(bytes/1048576).toFixed(1)}MB): ${(performance.now()-t0).toFixed(0)} ms`);
  t0 = performance.now();
  const rl2 = createInterface({ input: createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  for await (const line of rl2) { const i = line.indexOf("{"); if (i >= 0) JSON.parse(line.slice(i, line.endsWith(",") ? line.length-1 : line.length)); }
  console.log(`readline+JSON.parse: ${(performance.now()-t0).toFixed(0)} ms`);
  const raw = await import("node:fs/promises").then((m) => m.readFile(file, "utf8"));
  t0 = performance.now();
  for (let i = 0; i < 20; i++) gzipSync(Buffer.from(raw), { level: 9 });
  const t9 = (performance.now() - t0) / 20;
  t0 = performance.now();
  for (let i = 0; i < 20; i++) gzipSync(Buffer.from(raw), { level: 6 });
  const t6 = (performance.now() - t0) / 20;
  const b9 = gzipSync(Buffer.from(raw), { level: 9 });
  const b6 = gzipSync(Buffer.from(raw), { level: 6 });
  console.log(`gzipSync level9: ${t9.toFixed(0)} ms -> ${(b9.length/1048576).toFixed(2)}MB; level6: ${t6.toFixed(0)} ms -> ${(b6.length/1048576).toFixed(2)}MB (level6 is ${((b6.length/b9.length-1)*100).toFixed(1)}% bigger, ${(t9/t6).toFixed(2)}x faster)`);
  const buf = Buffer.from(raw);
  t0 = performance.now();
  for (let i = 0; i < 5; i++) await gz(buf, { level: 9 });
  console.log(`async gzip level9: ${((performance.now()-t0)/5).toFixed(0)} ms (threadpool)`);
  t0 = performance.now();
  const sink = createWriteStream("/tmp/w3b-sink.txt");
  let written = 0;
  for (let i = 0; i < 20000; i++) { const s = JSON.stringify({ a: 1, b: "x".repeat(60) }); written += s.length; if (!sink.write(s + "\n")) await new Promise((r) => sink.once("drain", r)); }
  await new Promise<void>((r) => sink.end(() => r()));
  console.log(`20000 writeSinkLine: ${(performance.now()-t0).toFixed(0)} ms for ${(written/1048576).toFixed(1)}MB`);
  void fileURLToPath; void n;
}
void main();
