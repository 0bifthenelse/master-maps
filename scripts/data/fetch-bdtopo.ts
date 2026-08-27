#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { GERS_TERRITORY } from "../../src/lib/data/territory";
import { toLambert93 } from "../../src/lib/geo/crs";

const execFileAsync = promisify(execFile);
const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");
const PACKAGE_DIR = path.join(RAW_DIR, "bdtopo");
const CAPABILITIES_URL = "https://data.geopf.fr/telechargement/capabilities";
const RESOURCE_URL = "https://data.geopf.fr/telechargement/resource/BDTOPO";
const LICENSE = "Licence Ouverte / Open Licence 2.0";
const DEPARTMENT_ZONE = `D${GERS_TERRITORY.code.padStart(3, "0")}`;

interface GeoJsonFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
}
interface GeoJsonCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}
interface LayerSpec {
  name: "buildings" | "roads" | "water-surfaces" | "water-lines";
  layer: string;
  output: string;
}
interface SelectedResource {
  title: string;
  edition: string;
  resourceUrl: string;
  downloadUrl: string;
  archiveBytes?: number;
}

const LAYERS: readonly LayerSpec[] = [
  { name: "buildings", layer: "batiment", output: "bdtopo-buildings.geojson" },
  { name: "roads", layer: "troncon_de_route", output: "bdtopo-roads.geojson" },
  { name: "water-surfaces", layer: "surface_hydrographique", output: "bdtopo-water-surfaces.geojson" },
  { name: "water-lines", layer: "troncon_hydrographique", output: "bdtopo-water-lines.geojson" },
];

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function tagValue(block: string, tag: string): string | undefined {
  const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
  const match = block.match(expression);
  return match?.[1] ? decodeXml(match[1].trim()) : undefined;
}

function attributeValue(block: string, tag: string, attribute: string): string | undefined {
  const expression = new RegExp(`<${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, "i");
  const match = block.match(expression);
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function entryBlocks(xml: string): string[] {
  return [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((match) => match[0]);
}

function resourceTitle(value: string): boolean {
  return new RegExp(`^BDTOPO_\\d+-\\d+_TOUSTHEMES_GPKG_LAMB93_${DEPARTMENT_ZONE}_\\d{4}-\\d{2}-\\d{2}$`, "i").test(value);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Accept: "application/atom+xml, application/xml" } });
  if (!response.ok) throw new Error(`IGN catalog request failed: HTTP ${response.status} ${response.statusText} (${url})`);
  return response.text();
}

async function discoverDownloadUrl(): Promise<SelectedResource> {
  const override = process.env.BDTOPO_EDITION?.trim();
  const capabilitiesUrl = `${CAPABILITIES_URL}?zone=${DEPARTMENT_ZONE}&page=1&limit=50&lang=fre`;
  const capabilities = await fetchText(capabilitiesUrl);
  const hasProduct = entryBlocks(capabilities).some((entry) => tagValue(entry, "title")?.toLowerCase().includes("bd topo"));
  if (!hasProduct) throw new Error(`Official IGN capabilities has no BDTOPO product for ${DEPARTMENT_ZONE}`);
  const catalogUrl = `${RESOURCE_URL}?zone=${DEPARTMENT_ZONE}&format=GPKG&lang=fre&page=1&limit=50`;
  const catalog = await fetchText(catalogUrl);
  const candidates = entryBlocks(catalog).flatMap((entry) => {
    const title = tagValue(entry, "title");
    const edition = tagValue(entry, "gpf_dl:editionDate") ?? title?.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
    if (!title || !edition || !resourceTitle(title)) return [];
    return [{ title, edition, resourceUrl: `${RESOURCE_URL}/${encodeURIComponent(title)}` }];
  });
  const selected = candidates
    .filter((candidate) => !override || candidate.edition === override || candidate.title === override)
    .sort((first, second) => second.edition.localeCompare(first.edition))[0];
  if (!selected) {
    throw new Error(`Official IGN catalog has no ${DEPARTMENT_ZONE} BDTOPO GPKG edition${override ? ` matching ${override}` : ""}`);
  }
  const resourceXml = await fetchText(selected.resourceUrl);
  const downloadEntry = entryBlocks(resourceXml).find((entry) => {
    const type = attributeValue(entry, "link", "type");
    const href = attributeValue(entry, "link", "href");
    return type?.toLowerCase() === "application/x-7z-compressed" && href !== undefined;
  });
  const downloadUrl = downloadEntry ? attributeValue(downloadEntry, "link", "href") : undefined;
  if (!downloadUrl) throw new Error(`IGN resource metadata has no 7z download for ${selected.title}`);
  const length = downloadEntry ? attributeValue(downloadEntry, "link", "gpf_dl:length") : undefined;
  return { ...selected, downloadUrl, archiveBytes: length ? Number(length) : undefined };
}

async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(buffer);
    bytes += buffer.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function download(url: string, target: string): Promise<{ sha256: string; bytes: number }> {
  const response = await fetch(url, { headers: { Accept: "application/octet-stream" } });
  if (!response.ok || !response.body) throw new Error(`BD TOPO download failed: HTTP ${response.status} ${response.statusText}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const hashing = new Transform({
    transform(chunk: Buffer | string, _encoding, callback): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      bytes += buffer.length;
      callback(null, buffer);
    },
  });
  const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(body, hashing, createWriteStream(target));
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
  const result = await execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024 });
  return result.stdout;
}

async function lambertBounds(boundaryPath: string): Promise<[number, number, number, number]> {
  const parsed = JSON.parse(await readFile(boundaryPath, "utf8")) as { features?: Array<{ geometry?: { coordinates?: unknown } }> };
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      const [x, y] = toLambert93([value[0], value[1]]);
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(parsed.features?.[0]?.geometry?.coordinates);
  if (![west, south, east, north].every(Number.isFinite)) throw new Error("Gers boundary has no finite coordinates");
  return [west, south, east, north];
}

function layerNames(listing: string): string[] {
  return listing.split(/\r?\n/)
    .map((line) => line.match(/^\s*\d+:\s*([^\s(]+)/)?.[1])
    .filter((name): name is string => name !== undefined);
}

function validateGeoJson(content: string, label: string): GeoJsonCollection {
  const parsed = JSON.parse(content) as { type?: unknown; features?: unknown };
  if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features) || parsed.features.length === 0) {
    throw new Error(`${label} did not produce a non-empty GeoJSON FeatureCollection`);
  }
  return parsed as unknown as GeoJsonCollection;
}

async function main(): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  await mkdir(INTERMEDIATE_DIR, { recursive: true });
  await mkdir(PACKAGE_DIR, { recursive: true });
  const resource = await discoverDownloadUrl();
  const archivePath = path.join(RAW_DIR, path.basename(resource.downloadUrl));
  let archive: { sha256: string; bytes: number };
  if (process.env.BDTOPO_USE_CACHE === "1") {
    await access(archivePath);
    archive = await hashFile(archivePath);
  } else {
    const partialPath = `${archivePath}.part`;
    try { await unlink(partialPath); } catch { /* no stale partial */ }
    console.log(`Downloading official IGN BD TOPO ${resource.edition}`);
    archive = await download(resource.downloadUrl, partialPath);
    await rename(partialPath, archivePath);
  }
  if (resource.archiveBytes !== undefined && Number.isFinite(resource.archiveBytes) && archive.bytes !== resource.archiveBytes) {
    throw new Error(`BD TOPO archive size mismatch: catalog=${resource.archiveBytes}, downloaded=${archive.bytes}`);
  }
  let gpkgFiles = await findFiles(PACKAGE_DIR, ".gpkg");
  if (gpkgFiles.length > 0 && !gpkgFiles.some((filePath) => filePath.includes(`ED${resource.edition}`))) {
    await rm(PACKAGE_DIR, { recursive: true, force: true });
    await mkdir(PACKAGE_DIR, { recursive: true });
    gpkgFiles = [];
  }
  if (gpkgFiles.length === 0) {
    await execFileAsync("7z", ["x", "-y", `-o${PACKAGE_DIR}`, archivePath], { maxBuffer: 4 * 1024 * 1024 });
    gpkgFiles = await findFiles(PACKAGE_DIR, ".gpkg");
  }
  if (gpkgFiles.length !== 1) throw new Error(`BD TOPO archive must expose exactly one GeoPackage, found ${gpkgFiles.length}`);
  const gpkg = gpkgFiles[0]!;
  const listing = await commandOutput("ogrinfo", ["-ro", "-q", gpkg]);
  const availableLayers = new Set(layerNames(listing));
  const missing = LAYERS.filter((spec) => !availableLayers.has(spec.layer)).map((spec) => spec.layer);
  if (missing.length > 0) throw new Error(`BD TOPO package is missing required canonical layers: ${missing.join(", ")}`);
  const boundaryPath = path.join(RAW_DIR, GERS_TERRITORY.boundaryRawFile);
  const sourceBounds = await lambertBounds(boundaryPath);
  const outputs: Array<Record<string, unknown>> = [];
  for (const spec of LAYERS) {
    const outputPath = path.join(RAW_DIR, spec.output);
    try { await unlink(outputPath); } catch { /* first acquisition */ }
    await execFileAsync("ogr2ogr", [
      "-f", "GeoJSON", outputPath, gpkg, spec.layer,
      "-spat", ...sourceBounds.map((value) => String(value)),
      "-t_srs", "EPSG:4326",
      "-lco", "RFC7946=YES",
    ], { maxBuffer: 4 * 1024 * 1024 });
    const content = await readFile(outputPath, "utf8");
    const parsed = validateGeoJson(content, spec.layer);
    const schema = await commandOutput("ogrinfo", ["-ro", "-so", gpkg, spec.layer]);
    outputs.push({
      name: spec.name,
      layer: spec.layer,
      file: path.relative(process.cwd(), outputPath),
      recordCount: parsed.features.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      schema,
    });
  }
  const timestamp = new Date().toISOString();
  const manifest = {
    source: "IGN BD TOPO",
    territory: GERS_TERRITORY,
    catalog: catalogUrlFor(resource),
    edition: resource.edition,
    resource: resource.resourceUrl,
    download: resource.downloadUrl,
    acquisitionTime: timestamp,
    license: LICENSE,
    sourceCrs: "EPSG:2154",
    interchangeCrs: "EPSG:4326",
    archive: { file: path.relative(process.cwd(), archivePath), ...archive },
    package: { geoPackage: path.relative(process.cwd(), gpkg), layers: availableLayers.size },
    clipping: { method: "ogr2ogr -spat for Lambert-93 envelope, canonical polygon clipping during normalization", boundary: path.relative(process.cwd(), boundaryPath), sourceBoundsLambert93: sourceBounds },
  };
  await writeFile(path.join(INTERMEDIATE_DIR, "bdtopo-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, edition: resource.edition, archive, layers: outputs.map((output) => ({ name: output.name, layer: output.layer, recordCount: output.recordCount })) }, null, 2));
}

function catalogUrlFor(resource: SelectedResource): string {
  return `${CAPABILITIES_URL}?zone=${DEPARTMENT_ZONE}&format=GPKG&lang=fre&page=1&limit=50`;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, source: "IGN BD TOPO", error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
