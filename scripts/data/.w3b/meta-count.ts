import { readFileSync, readdirSync } from "node:fs";
import { decodeRenderTile } from "../../../src/lib/render/codec";
const dir = "/tmp/generated-backup-w3b/render";
const files = readdirSync(dir).filter((f) => f.endsWith(".mmt") && f !== "boundary.mmt");
let meta = 0, features = 0, bytes = 0, layers = 0, verts = 0;
for (const f of files) {
  const buf = readFileSync(`${dir}/${f}`);
  const d = decodeRenderTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  meta += d.meta.length; features += d.header.featureMetaBytes; bytes += buf.byteLength;
  for (const l of d.layers) { layers++; verts += l.positionLength / 12; }
}
console.log(`render tiles ${files.length}: meta entries ${meta}, index entries ${layers}, vertices ${verts}, bytes ${(bytes/1048576).toFixed(1)}MB, meta avg per tile ${(meta/files.length).toFixed(0)}`);
const l0 = files.filter((f) => f.startsWith("l0_")).length;
const l1 = files.filter((f) => f.startsWith("l1_")).length;
const l2 = files.filter((f) => f.startsWith("l2_")).length;
console.log(`l0 ${l0} l1 ${l1} l2 ${l2}`);
let gz = 0, raw = 0;
for (const f of readdirSync("/tmp/generated-backup-w3b/meta")) { try { gz += readFileSync(`/tmp/generated-backup-w3b/meta/${f}`).length; } catch {} }
console.log(`meta sidecar gz bytes ${(gz/1048576).toFixed(2)}MB`);
let mmtgz = 0;
for (const f of readdirSync(dir)) if (f.endsWith(".gz")) mmtgz += readFileSync(`${dir}/${f}`).length;
console.log(`mmt.gz total ${(mmtgz/1048576).toFixed(1)}MB, mmt raw ${(bytes/1048576).toFixed(1)}MB, gz/raw ${(mmtgz/bytes*100).toFixed(1)}%`);
void raw;
