#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { toLambert93 } from "../../src/lib/geo/crs";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");
const PACKAGE_DIR = path.join(RAW_DIR, "bdtopo");
const CAPABILITIES_URL = "https://data.geopf.fr/telechargement/resource/BDTOPO";
const LICENSE = "Licence Ouverte / Open Licence 2.0";

interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
}
interface GeoJsonCollection { type: "FeatureCollection"; features: GeoJsonFeature[]; }
interface LayerSpec { name: string; patterns: RegExp[]; output: string; }

const LAYERS: LayerSpec[] = [
  { name: "buildings", patterns: [/^batiment$/i, /batiment/i], output: "bdtopo-buildings.geojson" },
  { name: "roads", patterns: [/troncon.*route/i, /route/i], output: "bdtopo-roads.geojson" },
  { name: "water-surfaces", patterns: [/surface.*hydro/i], output: "bdtopo-water-surfaces.geojson" },
  { name: "water-lines", patterns: [/cours.*eau/i, /hydro.*troncon/i], output: "bdtopo-water-lines.geojson" },
  { name: "bridges", patterns: [/pont/i], output: "bdtopo-bridges.geojson" },
  { name: "tunnels", patterns: [/passage/i], output: "bdtopo-tunnels.geojson" },
];

async function discoverDownloadUrl(): Promise<{ edition: string; url: string }> {
  const explicit = process.env.BDTOPO_EDITION;
  const editions = explicit
    ? [explicit]
    : Array.from({ length: 3 }, (_, yearOffset) => new Date().getUTCFullYear() - yearOffset)
      .flatMap((year) => [12, 9, 6, 3].map((month) => `${year}-${String(month).padStart(2, "0")}-15`));
  for (const edition of editions) {
    const stem = `BDTOPO_3-5_TOUSTHEMES_GPKG_LAMB93_D032_${edition}`;
    const resourceUrl = `https://data.geopf.fr/telechargement/resource/BDTOPO/${stem}`;
    const response = await fetch(resourceUrl, { headers: { Accept: "application/atom+xml,application/xml" } });
    if (!response.ok) continue;
    return {
      edition,
      url: `https://data.geopf.fr/telechargement/download/BDTOPO/${stem}/${stem}.7z`,
    };
  }
  throw new Error("Official IGN distribution contained no current D032 BD TOPO package");
}

async function download(url: string, target: string): Promise<{ sha256: string; bytes: number }> {
  const response = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!response.ok || !response.body) throw new Error(`BD TOPO download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    hash.update(buffer);
    chunks.push(buffer);
    bytes += buffer.length;
  }
  await writeFile(target, Buffer.concat(chunks));
  return { sha256: hash.digest("hex"), bytes };
}

async function findFiles(directory: string, suffix: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await findFiles(entryPath, suffix));
    else if (entry.name.toLowerCase().endsWith(suffix)) result.push(entryPath);
  }
  return result;
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, { maxBuffer: 8 * 1024 * 1024 });
  return result.stdout;
}

async function lambertBounds(boundaryPath: string): Promise<[number, number, number, number]> {
  const parsed = JSON.parse(await readFile(boundaryPath, "utf8")) as {
    features?: Array<{ geometry?: { coordinates?: unknown } }>;
  };
  const points: Array<[number, number]> = [];
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      points.push(toLambert93([value[0], value[1]]));
      return;
    }
    for (const child of value) collect(child);
  };
  collect(parsed.features?.[0]?.geometry?.coordinates);
  if (points.length === 0) throw new Error("Gers boundary has no coordinates");
  return [
    Math.min(...points.map((point) => point[0])),
    Math.min(...points.map((point) => point[1])),
    Math.max(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])),
  ];
}

async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(INTERMEDIATE_DIR, { recursive: true });
  await mkdir(PACKAGE_DIR, { recursive: true });
  const resource = await discoverDownloadUrl();
  const archivePath = path.join(RAW_DIR, `${path.basename(resource.url)}`);
  let packageInfo = { sha256: "", bytes: 0 };
  try {
    await access(archivePath);
    const cached = await readFile(archivePath);
    packageInfo = { sha256: createHash("sha256").update(cached).digest("hex"), bytes: cached.length };
  } catch {
    console.log(`Downloading BD TOPO ${resource.edition} (${resource.url})`);
    packageInfo = await download(resource.url, archivePath);
  }
  const extracted = await findFiles(PACKAGE_DIR, ".gpkg");
  if (extracted.length === 0) {
    await execFileAsync("7z", ["x", "-y", `-o${PACKAGE_DIR}`, archivePath], { maxBuffer: 2 * 1024 * 1024 });
  }
  const gpkg = (await findFiles(PACKAGE_DIR, ".gpkg"))[0];
  if (!gpkg) throw new Error("BD TOPO archive contained no GeoPackage");
  const layerListing = await commandOutput("ogrinfo", ["-ro", "-q", gpkg]);
  const layerNames = layerListing.split(/\r?\n/).map((line) => line.trim().replace(/^\d+:\s*/, "").replace(/\s+\(.*\)$/, "")).filter(Boolean);
  const outputs: Array<{ name: string; layer: string; file: string; recordCount: number; sha256: string }> = [];
  const boundaryPath = path.join(RAW_DIR, "gers-boundary.geojson");
  const sourceBounds = await lambertBounds(boundaryPath);
  for (const spec of LAYERS) {
    const layer = layerNames.find((candidate) => spec.patterns.some((pattern) => pattern.test(candidate)));
    if (!layer) continue;
    const outputPath = path.join(RAW_DIR, spec.output);
    try { await unlink(outputPath); } catch { /* first acquisition */ }
    await execFileAsync("ogr2ogr", [
      "-f", "GeoJSON", outputPath, gpkg, layer,
      "-spat", ...sourceBounds.map((value) => String(value)),
      "-t_srs", "EPSG:4326",
    ], { maxBuffer: 2 * 1024 * 1024 });
    const content = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(content) as GeoJsonCollection;
    outputs.push({ name: spec.name, layer, file: `data/raw/${spec.output}`, recordCount: parsed.features.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
  if (outputs.length < 3) throw new Error(`BD TOPO package exposed too few required layers: ${outputs.map((output) => output.name).join(", ")}`);
  const timestamp = new Date().toISOString();
  await writeFile(path.join(INTERMEDIATE_DIR, "bdtopo-manifest.json"), JSON.stringify({
    source: "IGN BD TOPO",
    territory: GERS_TERRITORY,
    edition: resource.edition,
    resource: resource.url,
    acquisitionTime: timestamp,
    license: LICENSE,
    sourceCrs: "EPSG:2154",
    interchangeCrs: "EPSG:4326",
    archive: { file: `data/raw/${path.basename(archivePath)}`, ...packageInfo },
    layers: outputs,
    note: "GeoPackage remains the source-coordinate archive; GeoJSON exports are WGS84 interchange copies.",
  }, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, edition: resource.edition, sourceCrs: "EPSG:2154", layers: outputs }, null, 2));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, source: "IGN BD TOPO", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
