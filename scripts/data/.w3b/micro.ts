import { MapFeatureSchema } from "../../../src/lib/data/schema";
import { clipPolygonToBounds, clipLineStringToPolygon, normalizePolygonGeometry } from "../../../src/lib/geo/polygon";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function countV(g: any): number {
  if (!g) return 0;
  if (g.type === "Point") return 1;
  if (g.type === "LineString") return g.coordinates.length;
  if (g.type === "MultiLineString") return g.coordinates.reduce((n: number, c: any) => n + c.length, 0);
  if (g.type === "Polygon") return g.coordinates.reduce((n: number, c: any) => n + c.length, 0);
  if (g.type === "MultiPolygon") return g.coordinates.reduce((n: number, p: any) => n + p.reduce((m: number, c: any) => m + c.length, 0), 0);
  return 0;
}
function simplifyRing(ring: number[][], t: number): number[][] {
  const open = ring.slice(0, -1);
  const out: number[][] = [open[0]!];
  for (let i = 1; i < open.length; i++) { const p = open[i], a = out[out.length - 1]; if (Math.hypot(p[0] - a[0], p[1] - a[1]) >= t) out.push(p); }
  out.push(out[0]);
  return out;
}
function simplify(g: any): any {
  if (g.type === "Polygon") return normalizePolygonGeometry({ type: "Polygon", coordinates: g.coordinates.map((r: any) => simplifyRing(r, 2)) });
  return g;
}

function clipPolys(g: any, b: number[], i: number): any {
  const rect = { minX: b[i], minY: b[i + 1], maxX: b[i + 2], maxY: b[i + 3] };
  if (g.type === "Polygon") return clipPolygonToBounds(g, rect);
  const out = [];
  for (const p of g.coordinates) { const c = clipPolygonToBounds({ type: "Polygon", coordinates: p }, rect); if (c) out.push(c); }
  return out.length ? out : null;
}
function rect(i: number): any { return { type: "Polygon", coordinates: [[[i * 2048, 0], [(i + 1) * 2048, 0], [(i + 1) * 2048, 2048], [i * 2048, 2048], [i * 2048, 0]]] }; }
function gb(g: any): number { let n = 0; const v = (c: any): void => { if (Array.isArray(c) && typeof c[0] === "number") { n += 2; return; } for (const k of c) v(k); }; if (g) v(g.coordinates); return n; }

async function main(): Promise<void> {
  const file = process.argv[2]!;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const raw: any[] = [];
  for await (const line of rl) {
    const first = line.indexOf("{");
    if (first < 0) continue;
    const t = line.slice(first);
    raw.push(JSON.parse(t.endsWith(",") ? t.slice(0, -1) : t));
  }
  console.log("features", raw.length, "rss", (process.memoryUsage.rss() / 1048576).toFixed(0), "MB", "vertices", raw.reduce((n: number, f: any) => n + countV(f.localGeometry), 0));
  function bench(label: string, fn: () => void) {
    for (let i = 0; i < 30; i++) fn();
    const t0 = performance.now();
    const reps = 5;
    for (let i = 0; i < reps; i++) fn();
    const dt = (performance.now() - t0) / reps;
    console.log(`${label}: ${dt.toFixed(1)} ms / ${raw.length} = ${(dt / raw.length * 1e6).toFixed(2)} us/feature`);
  }
  const bounds = [0, 0, 2048, 2048] as [number, number, number, number];
  const poly = raw.filter((f) => f.localGeometry?.type === "Polygon" || f.localGeometry?.type === "MultiPolygon");
  const lineF = raw.filter((f) => f.localGeometry?.type === "LineString" || f.localGeometry?.type === "MultiLineString");
  console.log("polygon features", poly.length, "avg vertices", (poly.reduce((n, f) => n + countV(f.localGeometry), 0) / Math.max(1, poly.length)).toFixed(1));
  bench("Zod MapFeatureSchema.parse", () => { for (const f of raw) MapFeatureSchema.parse(f); });
  bench("JSON.stringify", () => { for (const f of raw) JSON.stringify(f); });
  const boxes = [0,0,2048,2048, 2048,0,4096,2048, 0,2048,2048,4096, 2048,2048,4096,4096];
  bench("clipPolygonToBounds x1", () => { for (const f of poly) clipPolys(f.localGeometry, boxes, 0); });
  bench("clipPolygonToBounds x4", () => { for (const f of poly) for (let i = 0; i < 4; i++) clipPolys(f.localGeometry, boxes, i); });
  bench("clipLine x4", () => { for (const f of lineF) for (let i = 0; i < 4; i++) clipLineStringToPolygon(f.localGeometry.type === "LineString" ? f.localGeometry.coordinates : f.localGeometry.coordinates[0], rect(i)); });
  bench("simplify", () => { for (const f of poly) simplify(f.localGeometry); });
  bench("geometryBounds walk", () => { for (const f of raw) gb(f.localGeometry); });
  bench("normalizePolygonGeometry", () => { for (const f of poly) normalizePolygonGeometry(f.localGeometry.type === "Polygon" ? f.localGeometry : { type: "Polygon", coordinates: f.localGeometry.coordinates[0] }); });
  bench("structuredClone-like spread", () => { for (const f of raw) { const c = { ...f }; c.fragmentId = f.stableId + "@l0_1_1"; } });
  console.log("rss after", (process.memoryUsage.rss() / 1048576).toFixed(0), "MB");
}
void main();
