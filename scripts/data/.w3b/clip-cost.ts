import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { clipLineStringToPolygon, clipPolygonToBounds, pointInPolygon, isRingClosed, ensureRingClosed, ringArea, ringWindingOrder, pointInRing, normalizePolygonGeometry } from "../../../src/lib/geo/polygon";
import { readFileSync } from "node:fs";

function rect(x0: number, y0: number, x1: number, y1: number): any { return { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] }; }
function time(label: string, fn: () => void, denom: number, unit: string): void {
  fn(); fn();
  const t0 = performance.now();
  const reps = 3;
  for (let i = 0; i < reps; i++) fn();
  const dt = (performance.now() - t0) / reps;
  console.log(`${label}: ${dt.toFixed(1)} ms total, ${(dt / denom * 1000).toFixed(2)} us per ${unit}`);
}
async function load(file: string): Promise<any[]> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 }), crlfDelay: Infinity });
  const out: any[] = [];
  for await (const line of rl) { const i = line.indexOf("{"); if (i < 0) continue; const t = line.slice(i); out.push(JSON.parse(t.endsWith(",") ? t.slice(0, -1) : t)); }
  return out;
}
async function main(): Promise<void> {
  for (const file of ["data/intermediate/road-0001.json", "data/intermediate/water-0001.json", "data/intermediate/building-0001.json", "data/intermediate/poi-0001.json"]) {
    const features = await load(file);
    const lines = features.filter((f) => f.localGeometry?.type === "LineString" || f.localGeometry?.type === "MultiLineString");
    const polys = features.filter((f) => f.localGeometry?.type === "Polygon" || f.localGeometry?.type === "MultiPolygon");
    const points = features.filter((f) => f.localGeometry?.type === "Point");
    const lineVerts = lines.reduce((n: number, f) => n + (f.localGeometry.type === "LineString" ? f.localGeometry.coordinates.length : f.localGeometry.coordinates.reduce((m: number, c: any) => m + c.length, 0)), 0);
    const polyVerts = polys.reduce((n: number, f) => n + (f.localGeometry.type === "Polygon" ? f.localGeometry.coordinates.reduce((m: number, c: any) => m + c.length, 0) : f.localGeometry.coordinates.reduce((m: number, p: any) => m + p.reduce((k: number, c: any) => k + c.length, 0), 0)), 0);
    console.log(`\n${file}: ${features.length} features, lines ${lines.length} (${lineVerts} verts), polys ${polys.length} (${polyVerts} verts), points ${points.length}`);
    if (lines.length > 0) {
      time("  clipLineStringToPolygon x1 tile", () => { for (const f of lines) { const g = f.localGeometry; const ls = g.type === "LineString" ? [g.coordinates] : g.coordinates; for (const l of ls) clipLineStringToPolygon(l as any, rect(-20000, -20000, 4848, 4848)); } }, lines.length, "line feature");
      time("  clipLineStringToPolygon x4 tiles", () => { for (const f of lines) { const g = f.localGeometry; const ls = g.type === "LineString" ? [g.coordinates] : g.coordinates; for (const l of ls) { for (let k = 0; k < 4; k++) clipLineStringToPolygon(l as any, rect(-20000 + k * 2048, -20000, -20000 + (k + 1) * 2048, 4848)); } } }, lines.length, "line feature (4 tiles)");
      time("  pointInPolygon per line segment", () => { for (const f of lines) { const g = f.localGeometry; const ls = g.type === "LineString" ? [g.coordinates] : g.coordinates; for (const l of ls) for (let i = 1; i < l.length; i++) pointInPolygon([(l[i - 1][0] + l[i][0]) / 2, (l[i - 1][1] + l[i][1]) / 2] as any, rect(-20000, -20000, 4848, 4848)); } }, Math.max(1, lineVerts), "line segment");
    }
    if (polys.length > 0) {
      time("  clipPolygonToBounds x1 tile", () => { for (const f of polys) { const g = f.localGeometry; if (g.type === "Polygon") clipPolygonToBounds(g, { minX: -20000, minY: -20000, maxX: 4848, maxY: 4848 }); else for (const p of g.coordinates) clipPolygonToBounds({ type: "Polygon", coordinates: p }, { minX: -20000, minY: -20000, maxX: 4848, maxY: 4848 }); } }, polys.length, "polygon feature");
      const first = polys[0].localGeometry;
      const ring = (first.type === "Polygon" ? first.coordinates[0] : first.coordinates[0][0]) as any;
      console.log(`  sample polygon ring vertices ${ring.length}`);
      time("  clipEdge-like 4-pass clip only (no normalize)", () => { for (const f of polys) { const g = f.localGeometry; const r = (g.type === "Polygon" ? g.coordinates[0] : g.coordinates[0][0]) as any; let c = r.slice(); for (const [axis, limit, keepGreater] of [["x", -20000, true], ["x", 4848, false], ["y", -20000, true], ["y", 4848, false]] as const) { c = clipEdgeLocal(c, axis as "x" | "y", limit, keepGreater); } } }, polys.length, "polygon feature");
      time("  normalizePolygonGeometry only", () => { for (const f of polys) { const g = f.localGeometry; if (g.type === "Polygon") normalizePolygonGeometry(g); else for (const p of g.coordinates) normalizePolygonGeometry({ type: "Polygon", coordinates: p }); } }, polys.length, "polygon feature");
      void ring; void isRingClosed; void ensureRingClosed; void ringArea; void ringWindingOrder; void pointInRing; void readFileSync; void polyVerts;
    }
  }
}
function clipEdgeLocal(ring: any[], axis: "x" | "y", limit: number, keepGreater: boolean): any[] {
  const out: any[] = [];
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i], p = ring[(i + ring.length - 1) % ring.length];
    const cv = axis === "x" ? c[0] : c[1], pv = axis === "x" ? p[0] : p[1];
    const ci = keepGreater ? cv >= limit : cv <= limit, pi = keepGreater ? pv >= limit : pv <= limit;
    if (ci) { if (!pi) out.push(intersectLocal(p, c, axis, limit)); out.push(c); } else if (pi) out.push(intersectLocal(p, c, axis, limit));
  }
  return out;
}
function intersectLocal(s: any, e: any, axis: "x" | "y", limit: number): any {
  if (axis === "x") { const d = e[0] - s[0]; return Math.abs(d) <= 1e-10 ? [limit, s[1]] : [limit, s[1] + ((limit - s[0]) / d) * (e[1] - s[1])]; }
  const d = e[1] - s[1]; return Math.abs(d) <= 1e-10 ? [s[0], limit] : [s[0] + ((limit - s[1]) / d) * (e[0] - s[0]), limit];
}
void main();
