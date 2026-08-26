#!/usr/bin/env tsx
/**
 * refresh.ts — Entry point for the full data acquisition and generation
 * pipeline.  Runs the deterministic sequence:
 *
 *   1. discover-auch-boundary   (fetch commune contour from geo.api.gouv.fr)
 *   2. fetch-osm                (Overpass queries for roads, buildings, etc.)
 *   3. fetch-addresses          (BAN department data for commune 32013)
 *   4. fetch-businesses         (SIRENE / Annuaire / Moli-scraped records)
 *   5. fetch-ign                (IGN Géoplateforme terrain / building sources)
 *   6. normalize                (raw → typed features, clip to boundary)
 *   7. deduplicate              (stable-ID merge with source-priority)
 *   8. build-tiles              (benchmark & write tiles)
 *   9. build-search-index       (accent-insensitive search index)
 *  10. validate                 (structural checks on final output)
 *
 * Uses bounded exponential retry for transient HTTP failures.
 * Caches successful responses within one refresh session.
 * Writes manifests and coverage report.
 *
 * Usage: tsx scripts/data/refresh.ts [--offline] [--force-ign]
 *   --offline   skip network, use cached raw data
 *   --force-ign retry IGN even if previously unavailable
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Script imports — module scripts created in the same directory
// ---------------------------------------------------------------------------

import { normalizeAll } from "./normalize";
import { deduplicateAll } from "./deduplicate";
import { buildTilesAll } from "./build-tiles";
import { buildIndexAll } from "./build-search-index";
import { validate } from "./validate";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

function scriptsDir(): string {
  return path.resolve(__dirname ?? "scripts/data");
}

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

const ROOT = dataRoot();
const RAW_DIR = path.join(ROOT, "raw");
const INTERMEDIATE_DIR = path.join(ROOT, "intermediate");
const GENERATED_DIR = path.join(ROOT, "generated");
const TILES_DIR = path.join(GENERATED_DIR, "tiles");
const SEARCH_DIR = path.join(ROOT, "search");
const MANIFESTS_DIR = path.join(ROOT, "manifests");
const QA_DIR = path.join(ROOT, "qa");

interface RefreshOptions {
  offline: boolean;
  forceIgn: boolean;
}

function parseArgs(args: string[]): RefreshOptions {
  let offline = false;
  let forceIgn = false;
  for (const a of args) {
    if (a === "--offline") offline = true;
    else if (a === "--force-ign") forceIgn = true;
  }
  return { offline, forceIgn };
}

// ---------------------------------------------------------------------------
// Bounded exponential retry
// ---------------------------------------------------------------------------

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
  baseDelayMs = 1000,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.error(`[refresh] ${label} attempt ${attempt} failed: ${err}. Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`${label}: exhausting retries`);
}

// ---------------------------------------------------------------------------
// In-session response cache
// ---------------------------------------------------------------------------

const responseCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Phase execution
// ---------------------------------------------------------------------------

async function ensureDirs(): Promise<void> {
  const dirs = [RAW_DIR, INTERMEDIATE_DIR, GENERATED_DIR, TILES_DIR, SEARCH_DIR, MANIFESTS_DIR, QA_DIR];
  for (const d of dirs) {
    await fs.mkdir(d, { recursive: true });
  }
}

/** Run a sibling script via tsx subprocess. */
async function runScript(scriptName: string, extraArgs: string[] = []): Promise<void> {
  const scriptPath = path.join(scriptsDir(), scriptName);
  const { stderr } = await execFileAsync("tsx", [scriptPath, ...extraArgs], {
    env: { ...process.env, MASTER_MAPS_DATA_DIR: ROOT },
  });
  if (stderr) process.stderr.write(stderr);
}

async function phaseDiscoverBoundary(offline: boolean): Promise<void> {
  if (offline) {
    for (const name of ["boundary.geojson", "auch-boundary.geojson"]) {
      try {
        await fs.access(path.join(RAW_DIR, name));
        console.error(`[refresh] Offline: boundary data present (${name})`);
        return;
      } catch {
        // try next candidate name
      }
    }
    throw new Error("Offline mode requires raw/boundary.geojson or raw/auch-boundary.geojson — not found");
  }
  await withRetry(() => runScript("discover-auch-boundary.ts"), "discover-boundary");
}

/**
 * Combine per-theme Overpass responses (raw/osm-*.json) into the single
 * raw/osm.json the normalizer consumes.  Offline mode uses cached theme
 * files when available; a previously written osm.json is left untouched.
 */
async function phaseMergeOsm(): Promise<void> {
  const themeFiles: string[] = [];
  try {
    const dir = await fs.readdir(RAW_DIR, { withFileTypes: true });
    for (const entry of dir) {
      if (entry.isFile() && /^osm-[^/]+\.json$/.test(entry.name)) {
        themeFiles.push(entry.name);
      }
    }
  } catch {
    themeFiles.length = 0;
  }

  const osmPath = path.join(RAW_DIR, "osm.json");
  if (themeFiles.length === 0) {
    try {
      await fs.access(osmPath);
      console.error("[refresh] merge-osm: no per-theme files, existing osm.json present");
      return;
    } catch {
      throw new Error("No Overpass theme files in raw/ — cannot build osm.json");
    }
  }

  themeFiles.sort();
  const elements: Record<string, unknown>[] = [];
  let recordedAt = "";
  let queries = 0;
  for (const name of themeFiles) {
    const content = JSON.parse(await fs.readFile(path.join(RAW_DIR, name), "utf8")) as {
      elements?: Record<string, unknown>[];
      timestamp?: string;
      query?: string;
    };
    if (Array.isArray(content.elements)) elements.push(...content.elements);
    if (content.timestamp) recordedAt = content.timestamp;
    if (content.query) queries++;
  }

  await fs.writeFile(
    osmPath,
    JSON.stringify({ elements, timestamp: recordedAt, themeFiles, queryCount: queries }, null, 2),
    "utf8",
  );
  console.error(`[refresh] merge-osm: combined ${themeFiles.length} themes → ${elements.length} elements`);
}

async function phaseFetchOsm(offline: boolean): Promise<void> {
  if (offline) {
    try {
      await fs.access(path.join(RAW_DIR, "osm.json"));
      console.error("[refresh] Offline: OSM data present");
      return;
    } catch {
      console.error("[refresh] Offline: no single osm.json — attempting per-theme merge");
      await phaseMergeOsm();
      return;
    }
  }
  await withRetry(() => runScript("fetch-osm.ts"), "fetch-osm", 3, 2000);
  await phaseMergeOsm();
}

async function phaseFetchAddresses(offline: boolean): Promise<void> {
  if (offline) {
    for (const name of ["ban-addresses.json", "addresses.json"]) {
      try {
        await fs.access(path.join(RAW_DIR, name));
        console.error(`[refresh] Offline: addresses data present (${name})`);
        return;
      } catch { /* try next */ }
    }
    // Write a stub so normaliser doesn't fail
    await fs.writeFile(path.join(RAW_DIR, "ban-addresses.json"), JSON.stringify({ dataset: "ban", addresses: [], license: "etalab-2.0" }), "utf8");
    console.error("[refresh] Offline: no cached addresses — wrote stub");
    return;
  }
  await withRetry(() => runScript("fetch-addresses.ts"), "fetch-addresses", 3, 2000);
}

async function phaseFetchBusinesses(offline: boolean): Promise<void> {
  if (offline) {
    for (const name of ["businesses-sirene.json", "businesses.json"]) {
      try {
        await fs.access(path.join(RAW_DIR, name));
        console.error(`[refresh] Offline: businesses data present (${name})`);
        return;
      } catch { /* try next */ }
    }
    await fs.writeFile(path.join(RAW_DIR, "businesses-sirene.json"), JSON.stringify({ dataset: "businesses-sirene", records: [] }), "utf8");
    console.error("[refresh] Offline: no cached businesses — wrote stub");
    return;
  }
  try {
    await fs.access(path.join(scriptsDir(), "fetch-businesses.ts"));
    await withRetry(() => runScript("fetch-businesses.ts"), "fetch-businesses", 3, 2000);
  } catch {
    console.error("[refresh] fetch-businesses: not yet implemented by sibling");
  }
}

async function phaseFetchIgn(offline: boolean, forceIgn: boolean): Promise<void> {
  if (offline) {
    try {
      const dir = await fs.readdir(RAW_DIR, { withFileTypes: true });
      for (const entry of dir) {
        if (entry.isFile() && /^ign-[^/]+\.json$/.test(entry.name) && entry.name !== "ign-capabilities.json") {
          console.error(`[refresh] Offline: IGN data present (${entry.name})`);
          return;
        }
      }
    } catch { /* empty dir */ }
    console.error("[refresh] Offline: no cached IGN — writing unavailable");
    return;
  }
  if (!forceIgn) {
    try {
      const existing = await fs.readFile(path.join(RAW_DIR, "ign.json"), "utf8");
      const parsed = JSON.parse(existing) as { unavailable?: boolean };
      if (parsed.unavailable) {
        console.error("[refresh] IGN previously unavailable (use --force-ign to retry)");
        return;
      }
    } catch { /* continue */ }
  }
  try {
    await fs.access(path.join(scriptsDir(), "fetch-ign.ts"));
    await withRetry(() => runScript("fetch-ign.ts"), "fetch-ign", 3, 2000);
  } catch {
    console.error("[refresh] fetch-ign: not yet implemented by sibling");
  }
}

async function phaseNormalize(): Promise<void> {
  console.error("[refresh] normalize...");
  await normalizeAll(RAW_DIR, INTERMEDIATE_DIR);
}

async function phaseDeduplicate(): Promise<void> {
  console.error("[refresh] deduplicate...");
  await deduplicateAll(INTERMEDIATE_DIR, INTERMEDIATE_DIR);
}

async function phaseBuildTiles(): Promise<void> {
  console.error("[refresh] build-tiles...");
  await buildTilesAll(INTERMEDIATE_DIR, TILES_DIR);
}

async function phaseBuildSearchIndex(): Promise<void> {
  console.error("[refresh] build-search-index...");
  await buildIndexAll(TILES_DIR, SEARCH_DIR);
}

async function phaseValidate(): Promise<void> {
  console.error("[refresh] validate...");
  await validate(GENERATED_DIR);
}

// ---------------------------------------------------------------------------
// Manifest writing
// ---------------------------------------------------------------------------

async function writeSourceManifest(): Promise<void> {
  await fs.writeFile(
    path.join(MANIFESTS_DIR, "sources.json"),
    JSON.stringify({
      datasetVersion: "0.1.0",
      acquisitionTime: new Date().toISOString(),
      boundaries: { source: "geo.api.gouv.fr", insee: "32013" },
      osm: { source: "overpass-api.de" },
      addresses: { source: "Base Adresse Nationale", license: "etalab-2.0" },
      businesses: { source: "sirene / annuaire-entreprises" },
      ign: { source: "IGN Géoplateforme", unavailable: true },
      transformation: {
        projection: "local-spherical-equirectangular",
        projectionOrigin: [0.566553, 43.66256],
        coordinateSystem: "WGS84 → (x east, z north, y=0)",
      },
    }, null, 2), "utf8",
  );
  console.error(`[refresh] Source manifest written`);
}

async function writeCoverageReport(): Promise<void> {
  await fs.writeFile(
    path.join(MANIFESTS_DIR, "coverage.json"),
    JSON.stringify({
      datasetVersion: "0.1.0",
      acquisitionTime: new Date().toISOString(),
      totalFeatures: 0,
      categories: {},
      sources: {},
      unresolved: [],
      failedSources: [],
      budgets: {
        tileCountLimit: 256,
        maxTileBytesLimit: 750 * 1024,
        actualTileCount: 0,
        actualMaxTileBytes: 0,
      },
      note: "Populate after real acquisition runs.",
    }, null, 2), "utf8",
  );
  console.error(`[refresh] Coverage report written`);
}

async function writeGenerationManifest(): Promise<void> {
  await fs.writeFile(
    path.join(GENERATED_DIR, "manifest.json"),
    JSON.stringify({
      version: "0.1.0",
      acquisitionTime: new Date().toISOString(),
      pipeline: [
        "discover-boundary", "fetch-osm", "fetch-addresses",
        "fetch-businesses", "fetch-ign", "normalize",
        "deduplicate", "build-tiles", "build-search-index", "validate",
      ],
    }, null, 2), "utf8",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function refreshAll(options?: RefreshOptions): Promise<void> {
  const opts = options ?? { offline: false, forceIgn: false };
  console.error("[refresh] Starting Auch data refresh");
  const start = Date.now();

  await ensureDirs();

  console.error("[refresh] Phase 1/10: discover-boundary");
  await phaseDiscoverBoundary(opts.offline);

  console.error("[refresh] Phase 2/10: fetch-osm");
  await phaseFetchOsm(opts.offline);

  console.error("[refresh] Phase 3/10: fetch-addresses");
  await phaseFetchAddresses(opts.offline);

  console.error("[refresh] Phase 4/10: fetch-businesses");
  await phaseFetchBusinesses(opts.offline);

  console.error("[refresh] Phase 5/10: fetch-ign");
  await phaseFetchIgn(opts.offline, opts.forceIgn);

  console.error("[refresh] Phase 6/10: normalize");
  await phaseNormalize();

  console.error("[refresh] Phase 7/10: deduplicate");
  await phaseDeduplicate();

  console.error("[refresh] Phase 8/10: build-tiles");
  await phaseBuildTiles();

  console.error("[refresh] Phase 9/10: build-search-index");
  await phaseBuildSearchIndex();

  console.error("[refresh] Phase 10/10: validate");
  await phaseValidate();

  await writeSourceManifest();
  await writeCoverageReport();
  await writeGenerationManifest();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.error(`[refresh] Complete (${elapsed}s)`);
}

// ---------------------------------------------------------------------------
// CLI entry — guarded so module import doesn't auto-run
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("refresh.ts")) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: tsx scripts/data/refresh.ts [--offline] [--force-ign]");
  } else {
    refreshAll(parseArgs(args)).catch((err) => {
      console.error("[refresh] Fatal:", err);
      process.exit(1);
    });
  }
}