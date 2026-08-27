import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatasetManifestSchema, TileManifestSchema, type DatasetManifest, type TileManifest } from "@/lib/data/schema";

export const dynamic = "force-static";
const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export async function GET(_request: NextRequest) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  const manifestPath = join(dataRoot, "generated", "manifest.json");
  const tileManifestPath = join(dataRoot, "generated", "tile-manifest.json");
  try {
    const core = DatasetManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
    const rawTiles = JSON.parse(await readFile(tileManifestPath, "utf8")) as unknown;
    if (!Array.isArray(rawTiles)) throw new Error("tile manifest must be an array");
    const tiles: TileManifest[] = rawTiles.map((value) => TileManifestSchema.parse(value));
    const tileIds = tiles.map((tile) => tile.tileId);
    if (!tileIds.every((tileId) => TILE_ID_RE.test(tileId))) throw new Error("tile manifest contains an unsafe tile ID");
    if (tiles.length === 0) throw new Error("tile manifest is empty");
    const bounds = tiles.reduce<[number, number, number, number]>((accumulator, tile) => [
      Math.min(accumulator[0], tile.bounds[0]),
      Math.min(accumulator[1], tile.bounds[1]),
      Math.max(accumulator[2], tile.bounds[2]),
      Math.max(accumulator[3], tile.bounds[3]),
    ], tiles[0]!.bounds);
    const byteSizes = Object.fromEntries(tiles.map((tile) => [tile.tileId, tile.byteSize]));
    const tileFeatureCounts = Object.fromEntries(tiles.map((tile) => [tile.tileId, tile.featureCount]));
    const response: DatasetManifest = DatasetManifestSchema.parse({
      ...core,
      tileCount: tiles.length,
      tileIds,
      tiles,
      tileBounds: tiles.map((tile) => tile.bounds),
      byteSizes: { ...(core.byteSizes ?? {}), ...byteSizes },
      tileFeatureCounts,
      layerAvailability: core.layerAvailability ?? {},
      bounds,
    });
    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "public, max-age=3600, must-revalidate", "X-Dataset-Version": response.datasetVersion },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("ENOENT") ? 503 : 500;
    return NextResponse.json({ error: status === 503 ? "DATASET_UNAVAILABLE" : "DATASET_INVALID", code: status === 503 ? "DATASET_UNAVAILABLE" : "DATASET_INVALID" }, { status });
  }
}
