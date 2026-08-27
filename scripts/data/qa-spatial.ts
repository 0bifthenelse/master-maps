#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fromLambert93, toLambert93, wgs84ToRender } from "../../src/lib/geo/crs";

type Point = [number, number];
interface Feature { stableId?: string; geometry?: { coordinates?: unknown }; localGeometry?: { coordinates?: unknown }; x?: number; z?: number; [key: string]: unknown; }
interface TileEntry { tileId: string; features: string[]; }
const ROOT = process.env.MASTER_MAPS_DATA_DIR ?? "data";

function points(value: unknown): Point[] {
  const result: Point[] = [];
  const visit = (candidate: unknown): void => {
    if (!Array.isArray(candidate)) return;
    if (candidate.length >= 2 && typeof candidate[0] === "number" && typeof candidate[1] === "number") {
      result.push([candidate[0], candidate[1]]);
      return;
    }
    for (const child of candidate) visit(child);
  };
  visit(value);
  return result;
}

async function loadIntermediate(): Promise<Feature[]> {
  const result: Feature[] = [];
  for (const entry of await fs.readdir(path.join(ROOT, "intermediate"), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "provenance.json") continue;
    const parsed = JSON.parse(await fs.readFile(path.join(ROOT, "intermediate", entry.name), "utf8")) as unknown;
    if (Array.isArray(parsed)) result.push(...parsed as Feature[]);
  }
  return result;
}

async function loadTileFragments(stableId: string): Promise<Array<{ tileId: string; feature: Feature }>> {
  const result: Array<{ tileId: string; feature: Feature }> = [];
  const tileDir = path.join(ROOT, "generated", "tiles");
  for (const entry of await fs.readdir(tileDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const tileId = entry.name.slice(0, -5);
    const parsed = JSON.parse(await fs.readFile(path.join(tileDir, entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const feature of parsed as Feature[]) {
      if (feature.stableId === stableId || feature.parentStableId === stableId) result.push({ tileId, feature });
    }
  }
  return result;
}

async function main(): Promise<void> {
  const requestedId = process.argv[2];
  const features = await loadIntermediate();
  const sample = features.flatMap((feature) => points(feature.geometry?.coordinates)).slice(0, 1000);
  let worstRoundTripMetres = 0;
  for (const source of sample) {
    const roundTrip = fromLambert93(toLambert93(source));
    worstRoundTripMetres = Math.max(worstRoundTripMetres, Math.hypot((roundTrip[0] - source[0]) * 80_000, (roundTrip[1] - source[1]) * 111_000));
  }
  let worstResidualMetres = 0;
  let residualComparisons = 0;
  for (const feature of features) {
    const source = points(feature.geometry?.coordinates);
    const normalized = points(feature.localGeometry?.coordinates);
    const count = Math.min(source.length, normalized.length);
    for (let index = 0; index < count; index += 1) {
      const expected = wgs84ToRender(source[index]);
      worstResidualMetres = Math.max(worstResidualMetres, Math.hypot(expected[0] - normalized[index][0], expected[1] - normalized[index][1]));
      residualComparisons += 1;
    }
  }
  const diagnostics: Record<string, unknown> = {
    territory: "Gers",
    sampledSourceVertices: sample.length,
    worstCrsRoundTripMetres: worstRoundTripMetres,
    worstDetailedGeometryResidualMetres: worstResidualMetres,
    residualComparisons,
  };
  if (requestedId) {
    const feature = features.find((candidate) => candidate.stableId === requestedId);
    if (!feature) throw new Error(`Stable ID not found: ${requestedId}`);
    diagnostics.feature = {
      stableId: requestedId,
      sourceCoordinates: feature.geometry?.coordinates ?? null,
      normalizedCoordinates: feature.localGeometry?.coordinates ?? null,
      tileFragments: await loadTileFragments(requestedId),
      renderAnchor: [feature.x ?? null, feature.z ?? null],
    };
  }
  const reportPath = path.join(ROOT, "qa", "spatial-report.json");
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(diagnostics, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, report: reportPath, ...diagnostics }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
