import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatasetManifestSchema } from "@/lib/data/schema";
import { MappedFileCache, type FileVersion } from "@/lib/data/mappedCache";
import { parseTileManifestList, slimTileManifestEntries, tileManifestUnionBounds, type SlimTileManifestFields } from "@/lib/data/manifestSlim";

export const dynamic = "force-static";
const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MANIFEST_CACHE_ENTRIES = 4;

interface CachedManifest extends SlimTileManifestFields {
  datasetVersion: string;
  body: string;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function manifestVersion(dataRoot: string): Promise<FileVersion> {
  const [manifestStats, tileStats] = await Promise.all([
    stat(join(dataRoot, "generated", "manifest.json")),
    stat(join(dataRoot, "generated", "tile-manifest.json")),
  ]);
  return { mtimeMs: Math.max(manifestStats.mtimeMs, tileStats.mtimeMs), size: manifestStats.size + tileStats.size };
}

async function buildSlimManifest(dataRoot: string): Promise<CachedManifest> {
  const core = DatasetManifestSchema.parse(JSON.parse(await readFile(join(dataRoot, "generated", "manifest.json"), "utf8")) as unknown);
  const tiles = parseTileManifestList(JSON.parse(await readFile(join(dataRoot, "generated", "tile-manifest.json"), "utf8")) as unknown);
  if (!tiles.every((tile) => TILE_ID_RE.test(tile.tileId))) throw new Error("tile manifest contains an unsafe tile ID");
  if (tiles.length === 0) throw new Error("tile manifest is empty");
  const slimTiles = slimTileManifestEntries(tiles);
  const response = DatasetManifestSchema.parse({
    ...core,
    tileCount: tiles.length,
    tiles: slimTiles,
    layerAvailability: core.layerAvailability ?? {},
    bounds: tileManifestUnionBounds(tiles),
    tileIds: undefined,
    tileBounds: undefined,
    byteSizes: undefined,
    tileFeatureCounts: undefined,
  });
  return {
    datasetVersion: response.datasetVersion,
    tiles: slimTiles,
    bounds: response.bounds!,
    tileCount: tiles.length,
    body: JSON.stringify(response),
  };
}

const manifestCache = new MappedFileCache<CachedManifest>({
  maxEntries: MANIFEST_CACHE_ENTRIES,
  version: manifestVersion,
  load: buildSlimManifest,
  validate: (loaded) => loaded as CachedManifest,
});

export function resetManifestCache(): void {
  manifestCache.clear();
}

export async function GET(request: NextRequest) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  try {
    const current = await manifestCache.get(dataRoot);
    const headers: Record<string, string> = {
      "Cache-Control": "public, max-age=60",
      "Content-Type": "application/json",
      ETag: current.datasetVersion,
      "X-Dataset-Version": current.datasetVersion,
      Vary: "Accept-Encoding",
    };
    if (request.headers.get("if-none-match") === current.datasetVersion) return new NextResponse(null, { status: 304, headers });
    return new NextResponse(current.body, { status: 200, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = isMissing(error) || message.includes("ENOENT") ? 503 : 500;
    const code = status === 503 ? "DATASET_UNAVAILABLE" : "DATASET_INVALID";
    return NextResponse.json({ error: code, code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
