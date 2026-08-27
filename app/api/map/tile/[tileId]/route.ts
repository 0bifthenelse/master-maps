import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const MAX_TILE_SIZE = 8 * 1024 * 1024;

// Tile IDs are grid coordinates or stable slugs: alphanumeric, underscore, hyphen
const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const dynamic = "force-static";

/**
 * Inline type for the tile-manifest entry embedded in the tile response.
 * Matches TileManifestFallback in src/lib/data/loadTile.ts.
 */
interface TileManifestEntry {
  tileId: string;
  bounds: [number, number, number, number];
  featureCount: number;
  byteSize: number;
  features: string[];
}

/**
 * Inline type for the tile response envelope.
 * Matches TileResponseFallback in src/lib/data/loadTile.ts.
 */
interface TileResponse {
  manifest: TileManifestEntry;
  features: unknown[];
  metadata?: Record<string, unknown>;
}

/**
 * GET /api/map/tile/[tileId]
 *
 * Returns a tile envelope { manifest, features, metadata? } matching the
 * contract expected by src/lib/data/loadTile.ts.
 *
 * The tile-manifest entry is sourced from data/generated/tile-manifest.json,
 * and features are the raw feature array from data/generated/tiles/{tileId}.json.
 *
 * Security:
 *  - Rejects slashes, path-traversal patterns, and unexpected characters in tileId.
 *  - Enforces a maximum uncompressed tile size.
 *  - Only reads from the fixed tiles subdirectory under the configured data root.
 *
 * Returns 503 with DATASET_UNAVAILABLE when the tile or data volume is missing.
 * Returns 400 with INVALID_TILE_ID for malformed tile identifiers.
 * Returns 413 with TILE_TOO_LARGE when the file exceeds the budget.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ tileId: string }> },
) {
  const { tileId } = await params;
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";

  // Validate tileId: no slashes, no path traversal, alphanumeric safe chars only
  if (
    !tileId ||
    tileId.length > 128 ||
    !TILE_ID_RE.test(tileId) ||
    tileId.includes("..") ||
    tileId.includes("/") ||
    tileId.includes("\\") ||
    tileId.includes("\0")
  ) {
    return NextResponse.json(
      { error: "INVALID_TILE_ID" },
      { status: 400 },
    );
  }

  const tilePath = join(dataRoot, "generated", "tiles", `${tileId}.json`);
  const tileManifestPath = join(dataRoot, "generated", "tile-manifest.json");

  try {
    // Check file size before reading
    const stats = await stat(tilePath);
    if (stats.size > MAX_TILE_SIZE) {
      return NextResponse.json(
        { error: "TILE_TOO_LARGE", size: stats.size, limit: MAX_TILE_SIZE },
        { status: 413 },
      );
    }

    // Read and parse tile-manifest to get the manifest entry for this tile
    const manifestContent = await readFile(tileManifestPath, "utf-8");
    const allManifests = JSON.parse(manifestContent) as TileManifestEntry[];
    const manifest = allManifests.find((m) => m.tileId === tileId);

    if (!manifest) {
      return NextResponse.json(
        { error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" },
        { status: 503 },
      );
    }

    // Read raw features array from the tile file
    const tileContent = await readFile(tilePath, "utf-8");
    const features = JSON.parse(tileContent);

    if (!Array.isArray(features)) {
      // Tile content is not a feature array — unexpected but serve
      return NextResponse.json(
        {
          manifest,
          features: [],
          metadata: { raw: features },
        } satisfies TileResponse,
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=3600, must-revalidate",
          },
        },
      );
    }

    // Build the response envelope matching loadTile.ts contract
    const response: TileResponse = {
      manifest,
      features,
    };

    return NextResponse.json(response, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, must-revalidate",
      },
    });
  } catch {
    return NextResponse.json(
      {
        error: "DATASET_UNAVAILABLE",
        code: "DATASET_UNAVAILABLE",
      },
      { status: 503 },
    );
  }
}