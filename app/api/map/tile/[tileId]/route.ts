import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { MapFeatureSchema, TileDataSchema, TileManifestSchema, type TileData } from "@/lib/data/schema";

const MAX_TILE_SIZE = 2 * 1024 * 1024;
const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const dynamic = "force-static";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tileId: string }> },
) {
  const { tileId } = await params;
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  if (!tileId || tileId.length > 128 || !TILE_ID_RE.test(tileId) || tileId.includes("..")) {
    return NextResponse.json({ error: "INVALID_TILE_ID", code: "INVALID_TILE_ID" }, { status: 400 });
  }
  const tilePath = join(dataRoot, "generated", "tiles", `${tileId}.json`);
  const tileManifestPath = join(dataRoot, "generated", "tile-manifest.json");
  try {
    const fileStats = await stat(tilePath);
    if (fileStats.size > MAX_TILE_SIZE) return NextResponse.json({ error: "TILE_TOO_LARGE", size: fileStats.size, limit: MAX_TILE_SIZE }, { status: 413 });
  } catch (error) {
    if (isMissing(error)) return NextResponse.json({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" }, { status: 503 });
    throw error;
  }
  try {
    const rawManifest = JSON.parse(await readFile(tileManifestPath, "utf8")) as unknown;
    if (!Array.isArray(rawManifest)) throw new Error("tile manifest is not an array");
    const manifest = rawManifest.map((entry) => TileManifestSchema.parse(entry)).find((entry) => entry.tileId === tileId);
    if (!manifest) return NextResponse.json({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" }, { status: 503 });
    const rawFeatures = JSON.parse(await readFile(tilePath, "utf8")) as unknown;
    if (!Array.isArray(rawFeatures)) throw new Error("tile payload is not an array");
    const features = rawFeatures.map((feature) => MapFeatureSchema.parse(feature));
    if (features.length !== manifest.featureCount) throw new Error(`tile ${tileId} feature count mismatch`);
    const response: TileData = TileDataSchema.parse({ manifest, features });
    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "public, max-age=3600, must-revalidate", "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("ENOENT") ? 503 : 500;
    return NextResponse.json({ error: status === 503 ? "DATASET_UNAVAILABLE" : "DATASET_INVALID", code: status === 503 ? "DATASET_UNAVAILABLE" : "DATASET_INVALID" }, { status });
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
