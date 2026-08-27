#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MapFeatureSchema, SearchRecordSchema, TileManifestSchema, type MapFeature, type SearchRecord } from "../../src/lib/data/schema";

interface IndexOptions {
  inDir: string;
  outDir: string;
}

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

function parseArgs(args: string[]): IndexOptions {
  const root = dataRoot();
  let inDir = path.join(root, "generated", "tiles");
  let outDir = path.join(root, "search");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--in-dir" && args[index + 1]) inDir = args[++index]!;
    else if (argument === "--out-dir" && args[index + 1]) outDir = args[++index]!;
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: tsx scripts/data/build-search-index.ts [--in-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { inDir, outDir };
}

function normalizedKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function tileLevel(tileId: string): number {
  return Number(tileId.match(/^l(\d+)_/)?.[1] ?? 99);
}

async function loadDataFromTiles(tilesDir: string): Promise<{ features: MapFeature[]; tileMap: Map<string, string> }> {
  const features: MapFeature[] = [];
  const tileMap = new Map<string, { tileId: string; lod: number }>();
  for (const entry of await fs.readdir(tilesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const tileId = entry.name.replace(/\.json$/, "");
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(tilesDir, entry.name), "utf8"));
    if (!Array.isArray(parsed)) continue;
    const lod = tileLevel(tileId);
    for (const value of parsed) {
      const feature = MapFeatureSchema.parse(value);
      features.push(feature);
      const previous = tileMap.get(feature.stableId);
      if (!previous || lod < previous.lod) tileMap.set(feature.stableId, { tileId, lod });
    }
  }
  return { features, tileMap: new Map([...tileMap].map(([stableId, value]) => [stableId, value.tileId])) };
}

async function loadData(tilesDir: string): Promise<{ features: MapFeature[]; tileMap: Map<string, string> }> {
  const intermediateDir = path.join(tilesDir, "..", "..", "intermediate");
  try {
    await fs.access(intermediateDir);
  } catch {
    return loadDataFromTiles(tilesDir);
  }
  const ignored = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);
  const featuresById = new Map<string, MapFeature>();
  const entries = (await fs.readdir(intermediateDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !ignored.has(entry.name))
    .sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    const parsed = JSON.parse(await fs.readFile(path.join(intermediateDir, entry.name), "utf8")) as unknown;
    if (!Array.isArray(parsed)) continue;
    for (const value of parsed) {
      const feature = MapFeatureSchema.parse(value);
      if (!featuresById.has(feature.stableId)) featuresById.set(feature.stableId, feature);
    }
  }
  const rawManifest = JSON.parse(await fs.readFile(path.join(tilesDir, "..", "tile-manifest.json"), "utf8")) as unknown;
  if (!Array.isArray(rawManifest)) throw new Error("tile manifest is not an array");
  const manifests = rawManifest.map((value) => TileManifestSchema.parse(value)).sort((first, second) => first.lod - second.lod || first.tileId.localeCompare(second.tileId));
  const tileMap = new Map<string, string>();
  for (const manifest of manifests) {
    for (const stableId of manifest.features) if (featuresById.has(stableId) && !tileMap.has(stableId)) tileMap.set(stableId, manifest.tileId);
  }
  return { features: [...featuresById.values()], tileMap };
}

function aliases(feature: MapFeature): string[] {
  const candidates: string[] = [];
  if (feature.address) candidates.push(feature.address);
  if (feature.kind === "business") candidates.push(feature.businessName, feature.brand ?? "", feature.legalName ?? "");
  if (feature.kind === "road" && feature.name) candidates.push(feature.name);
  return [...new Set(candidates.map(normalizedKey).filter((value) => value.length > 0))];
}

function featureName(feature: MapFeature): string | undefined {
  if (feature.name) return feature.name;
  if (feature.kind === "business") return feature.businessName;
  return feature.displayName;
}

function boostFor(feature: MapFeature): number {
  if (feature.kind === "business") return 200;
  if (feature.kind === "poi") return 100;
  if (feature.kind === "address") return 50;
  if (feature.kind === "building") return 10;
  return 0;
}

function categoryFor(feature: MapFeature): string | undefined {
  if (feature.kind === "business") return feature.category ?? feature.nafLabel ?? feature.nafCode;
  if (feature.kind === "poi") return feature.category ?? feature.poiType;
  if (feature.kind === "road") return feature.roadClass ?? feature.highway;
  if (feature.kind === "water") return feature.waterType;
  return undefined;
}

export function buildSearchIndex(features: MapFeature[], tileMap: Map<string, string>, _outputPath: string): SearchRecord[] {
  const unique = new Map<string, MapFeature>();
  for (const feature of features) if (!unique.has(feature.stableId)) unique.set(feature.stableId, feature);
  const records: SearchRecord[] = [];
  for (const feature of unique.values()) {
    const name = featureName(feature);
    const tileId = tileMap.get(feature.stableId);
    if (!name || !tileId || feature.lon === undefined || feature.lat === undefined) continue;
    records.push(SearchRecordSchema.parse({
      featureId: feature.stableId,
      canonicalName: name,
      normalizedName: normalizedKey(name),
      aliases: aliases(feature),
      kind: feature.kind,
      category: categoryFor(feature),
      tileId,
      focusLon: feature.lon,
      focusLat: feature.lat,
      boost: boostFor(feature),
    }));
  }
  return records.sort((first, second) => first.canonicalName.localeCompare(second.canonicalName) || first.featureId.localeCompare(second.featureId));
}

async function writeJsonArray(filePath: string, values: Iterable<unknown>): Promise<void> {
  const handle = await fs.open(filePath, "w");
  let buffer = "";
  let first = true;
  try {
    await handle.write("[");
    for (const value of values) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) continue;
      buffer += `${first ? "" : ",\n"}${encoded}`;
      first = false;
      if (buffer.length >= 1024 * 1024) {
        await handle.write(buffer);
        buffer = "";
      }
    }
    await handle.write(`${buffer}\n]\n`);
  } finally {
    await handle.close();
  }
}

export async function buildIndexAll(inDir?: string, outDir?: string): Promise<void> {
  const root = dataRoot();
  const sourceDir = inDir ?? path.join(root, "generated", "tiles");
  const destinationDir = outDir ?? path.join(root, "search");
  await fs.mkdir(destinationDir, { recursive: true });
  const { features, tileMap } = await loadData(sourceDir);
  const records = buildSearchIndex(features, tileMap, path.join(destinationDir, "index.json"));
  await writeJsonArray(path.join(destinationDir, "index.json"), records);
  console.error(`[search-index] Wrote ${records.length} canonical search records to ${destinationDir}/index.json`);
}

if (process.argv[1]?.endsWith("build-search-index.ts")) {
  const options = parseArgs(process.argv.slice(2));
  buildIndexAll(options.inDir, options.outDir).catch((error: unknown) => {
    console.error("[search-index] Fatal:", error);
    process.exit(1);
  });
}
