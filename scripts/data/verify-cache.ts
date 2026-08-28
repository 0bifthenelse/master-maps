import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_ROOT = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const MANIFEST_PATH = path.join(DATA_ROOT, "intermediate", "auch-osm-manifest.json");

interface AuchOsmManifest {
  resource: string;
  fromCache: boolean;
  bytesDownloaded: number;
  httpStatus: number;
  extractSkipped: boolean;
  exportSkipped: boolean;
}

function parseManifest(value: unknown): AuchOsmManifest {
  if (typeof value !== "object" || value === null) throw new Error(`Invalid Auch OSM manifest at ${MANIFEST_PATH}`);
  const record = value as Record<string, unknown>;
  if (typeof record.resource !== "string" || !record.resource.includes("geofabrik")) throw new Error("Auch OSM manifest has no Geofabrik source");
  if (typeof record.fromCache !== "boolean" || typeof record.bytesDownloaded !== "number" || typeof record.httpStatus !== "number" || typeof record.extractSkipped !== "boolean" || typeof record.exportSkipped !== "boolean") throw new Error("Auch OSM manifest lacks cache verification fields");
  return {
    resource: record.resource,
    fromCache: record.fromCache,
    bytesDownloaded: record.bytesDownloaded,
    httpStatus: record.httpStatus,
    extractSkipped: record.extractSkipped,
    exportSkipped: record.exportSkipped,
  };
}

async function readManifest(): Promise<AuchOsmManifest> {
  return parseManifest(JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as unknown);
}

async function runAuchOsm(): Promise<void> {
  try {
    await execFileAsync("npx", ["tsx", "scripts/data/fetch-osm.ts", "--auch"], { cwd: ROOT, env: process.env, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`fetch-osm.ts --auch failed: ${detail}`);
  }
}

function printTable(first: AuchOsmManifest, second: AuchOsmManifest): void {
  console.log("run  fromCache  bytesDownloaded  httpStatus  extractSkipped  exportSkipped");
  for (const [label, manifest] of [["1", first], ["2", second]] as const) {
    console.log(`${label}    ${String(manifest.fromCache).padEnd(9)} ${String(manifest.bytesDownloaded).padEnd(16)} ${String(manifest.httpStatus).padEnd(11)} ${String(manifest.extractSkipped).padEnd(14)} ${manifest.exportSkipped}`);
  }
}

async function main(): Promise<void> {
  await runAuchOsm();
  const first = await readManifest();
  await runAuchOsm();
  const second = await readManifest();
  printTable(first, second);
  if (!second.fromCache || second.bytesDownloaded !== 0 || second.httpStatus !== 304 || !second.extractSkipped || !second.exportSkipped) {
    throw new Error("Warm cache proof failed: the second Auch OSM run did not revalidate without downloading and skip both osmium stages");
  }
}

main().catch((error: unknown) => {
  console.error(`[verify-cache] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
