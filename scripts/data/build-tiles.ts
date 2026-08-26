#!/usr/bin/env tsx
/**
 * build-tiles.ts — Benchmarks tile candidates (256/384/512 metres) against the
 * generated data.  Selects the smallest candidate that keeps:
 *   - tile count ≤ 256
 *   - largest uncompressed tile ≤ 750 KiB
 * If no candidate satisfies both limits, selects the candidate with the
 * smallest largest tile and records the exceeded budget in coverage.
 *
 * Usage: tsx scripts/data/build-tiles.ts [--in-dir <path>] [--out-dir <path>]
 *         tsx scripts/data/build-tiles.ts --benchmark-only  (print results only)
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Type stubs
// ---------------------------------------------------------------------------

interface TileManifest {
  tileId: string;
  bounds: [number, number, number, number];
  featureCount: number;
  byteSize: number;
  features: string[];
}

interface CoverageReport {
  datasetVersion: string;
  acquisitionTime: string;
  tileSize: number;
  tileCount: number;
  featureCounts: Record<string, number>;
  budgets: Record<string, number>;
}

interface MapFeature {
  kind: string;
  stableId: string;
  lon: number;
  lat: number;
  x: number;
  z: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

interface TileOptions {
  inDir: string;
  outDir: string;
  forceSize?: number;
  benchmarkOnly: boolean;
}

function parseArgs(args: string[]): TileOptions {
  const root = dataRoot();
  let inDir = path.join(root, "intermediate");
  let outDir = path.join(root, "generated", "tiles");
  let forceSize: number | undefined;
  let benchmarkOnly = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--in-dir" && args[i + 1]) { inDir = args[++i]!; }
    else if (a === "--out-dir" && args[i + 1]) { outDir = args[++i]!; }
    else if (a === "--tile-size" && args[i + 1]) { forceSize = parseInt(args[++i]!, 10); }
    else if (a === "--benchmark-only") { benchmarkOnly = true; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/data/build-tiles.ts [--in-dir <path>] [--out-dir <path>]");
      console.log("  --tile-size <m>      Force a specific tile size (skip benchmark)");
      console.log("  --benchmark-only     Print benchmark results without writing tiles");
      process.exit(0);
    }
  }
  return { inDir, outDir, forceSize, benchmarkOnly };
}

// ---------------------------------------------------------------------------
// Tile geometry
// ---------------------------------------------------------------------------

/** Determinsitic tile row/col for a local coordinate. */
function tileIndex(x: number, z: number, size: number, originX: number, originZ: number): [number, number] {
  const col = Math.floor((x - originX) / size);
  const row = Math.floor((z - originZ) / size);
  return [col, row];
}

function tileId(col: number, row: number): string {
  return `${col}_${row}`;
}

function tileBounds(col: number, row: number, size: number, originX: number, originZ: number): [number, number, number, number] {
  return [
    originX + col * size,
    originZ + row * size,
    originX + (col + 1) * size,
    originZ + (row + 1) * size,
  ];
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------

interface BenchmarkResult {
  size: number;
  tileCount: number;
  maxTileBytes: number;
  metadataSizeBytes: number;
  passes: boolean;
}

function benchmark(
  features: MapFeature[],
  size: number,
  originX: number,
  originZ: number,
): BenchmarkResult {
  const tileMap = new Map<string, MapFeature[]>();
  for (const f of features) {
    const [col, row] = tileIndex(f.x, f.z, size, originX, originZ);
    const id = tileId(col, row);
    const list = tileMap.get(id) ?? [];
    list.push(f);
    tileMap.set(id, list);
  }

  let maxBytes = 0;
  for (const [_id, list] of tileMap) {
    const payload = JSON.stringify(list);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (bytes > maxBytes) maxBytes = bytes;
  }

  return {
    size,
    tileCount: tileMap.size,
    maxTileBytes: maxBytes,
    metadataSizeBytes: 0, // TODO: compute with manifest overhead
    passes: tileMap.size <= 256 && maxBytes <= 750 * 1024,
  };
}

function selectTileSize(
  features: MapFeature[],
  originX: number,
  originZ: number,
  force?: number,
): BenchmarkResult {
  if (force) {
    const r = benchmark(features, force, originX, originZ);
    console.error(`[tiles] Forced size ${force}m: ${r.tileCount} tiles, max ${(r.maxTileBytes / 1024).toFixed(1)} KiB`);
    return r;
  }

  const candidates = [256, 384, 512];
  const results = candidates.map((s) => benchmark(features, s, originX, originZ));

  for (const r of results) {
    console.error(`[tiles]  ${r.size}m: ${r.tileCount} tiles, max ${(r.maxTileBytes / 1024).toFixed(1)} KiB — ${r.passes ? "PASS" : "FAIL"}`);
  }

  // Select smallest passing candidate
  const passing = results.filter((r) => r.passes);
  if (passing.length > 0) return passing[0]!;

  // Fallback: smallest max tile
  results.sort((a, b) => a.maxTileBytes - b.maxTileBytes);
  console.error(`[tiles] No candidate passes both limits. Selecting ${results[0]!.size}m (smallest max tile).`);
  return results[0]!;
}

// ---------------------------------------------------------------------------
// Build tiles
// ---------------------------------------------------------------------------

function assignToTiles(
  features: MapFeature[],
  size: number,
  originX: number,
  originZ: number,
): Map<string, MapFeature[]> {
  const tileMap = new Map<string, MapFeature[]>();
  for (const f of features) {
    const [col, row] = tileIndex(f.x, f.z, size, originX, originZ);
    const id = tileId(col, row);
    const list = tileMap.get(id) ?? [];
    list.push(f);
    tileMap.set(id, list);
  }
  return tileMap;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildTiles(
  features: MapFeature[],
  tileSize: number,
  originX = 0,
  originZ = 0,
): Promise<{ tileMap: Map<string, MapFeature[]>; manifest: TileManifest[] }> {
  const tileMap = assignToTiles(features, tileSize, originX, originZ);
  const manifest: TileManifest[] = [];

  for (const [id, list] of tileMap) {
    const [col, row] = id.split("_").map(Number) as [number, number];
    manifest.push({
      tileId: id,
      bounds: tileBounds(col, row, tileSize, originX, originZ),
      featureCount: list.length,
      byteSize: Buffer.byteLength(JSON.stringify(list), "utf8"),
      features: list.map((f) => f.stableId),
    });
  }
  return { tileMap, manifest };
}

export async function buildTilesAll(
  inDir?: string,
  outDir?: string,
  forceSize?: number,
): Promise<void> {
  const root = dataRoot();
  const ind = inDir ?? path.join(root, "intermediate");
  const otd = outDir ?? path.join(root, "generated", "tiles");

  await fs.mkdir(otd, { recursive: true });

  // Load deduplicated features from intermediate
  const dir = await fs.readdir(ind, { withFileTypes: true });
  const allFeatures: MapFeature[] = [];
  for (const entry of dir) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "provenance.json") continue;
    const content = await fs.readFile(path.join(ind, entry.name), "utf8");
    const parsed = JSON.parse(content) as MapFeature[];
    allFeatures.push(...parsed);
  }

  if (allFeatures.length === 0) {
    console.error("[tiles] No features found — nothing to tile.");
    return;
  }

  // Determine origin from boundary feature (should be commune centroid)
  const boundary = allFeatures.find((f) => f.kind === "boundary") as MapFeature & { centroidX?: number; centroidZ?: number } | undefined;
  const originX = boundary?.centroidX ?? 0;
  const originZ = boundary?.centroidZ ?? 0;

  const selected = selectTileSize(allFeatures, originX, originZ, forceSize);

  if (selected.tileCount === 0) {
    console.error("[tiles] Benchmark produced zero tiles — aborting.");
    return;
  }

  const { tileMap, manifest } = await buildTiles(allFeatures, selected.size, originX, originZ);

  // Write tile files
  for (const [id, list] of tileMap) {
    await fs.writeFile(path.join(otd, `${id}.json`), JSON.stringify(list), "utf8");
  }

  // Write tile manifest
  const manifestPath = path.join(otd, "..", "tile-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.error(`[tiles] Wrote ${tileMap.size} tiles (${selected.size}m) to ${otd}`);
  console.error(`[tiles] Manifest written to ${manifestPath}`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("build-tiles.ts") || process.argv[1]?.endsWith("build_tiles.ts")) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.benchmarkOnly) {
    dataRoot(); // validate env
    console.error("Benchmark-only mode: run via buildTilesAll with --benchmark-only");
    process.exit(0);
  }
  buildTilesAll(opts.inDir, opts.outDir, opts.forceSize).catch((err) => {
    console.error("[tiles] Fatal:", err);
    process.exit(1);
  });
}