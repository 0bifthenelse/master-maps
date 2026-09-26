import { clipPolygonToBounds } from "../../../src/lib/geo/polygon";
import { readFileSync } from "node:fs";
const parsed = JSON.parse(readFileSync("data/intermediate/boundary.json", "utf8"));
const b = parsed[0];
const g = b.localGeometry ?? b.geometry;
console.log("boundary geometry type", g.type, "parts", g.type === "MultiPolygon" ? g.coordinates.length : 1, "rings", g.type === "MultiPolygon" ? g.coordinates[0].length : g.coordinates[0].length);
const poly = g.type === "MultiPolygon" ? { type: "Polygon", coordinates: g.coordinates[0] } : g;
const t0 = performance.now();
let out = 0;
for (let i = 0; i < 20; i++) {
  const c = clipPolygonToBounds(poly, { minX: -70000 + i * 2048, minY: -40000, maxX: -70000 + (i + 1) * 2048, maxY: -20000 });
  out = c ? c.coordinates[0].length : 0;
}
const dt = (performance.now() - t0) / 20;
console.log(`clipPolygonToBounds(boundary ring) = ${dt.toFixed(1)} ms per tile -> ${(dt * 2400 / 1000 / 60).toFixed(1)} min for the 2400 boundary tiles at LOD0; rss ${(process.memoryUsage.rss()/1048576).toFixed(0)}MB; clipped ring ${out}`);
