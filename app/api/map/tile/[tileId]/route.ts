import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// 750 KiB tile budget plus safety margin — matches loadTile.ts default
const MAX_TILE_SIZE = 768 * 1024;

// Tile IDs are grid coordinates or stable slugs: alphanumeric, underscore, hyphen
const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const dynamic = "force-static";

/**
 * GET /api/map/tile/[tileId]
 *
 * Returns a single generated tile from data/generated/tiles/{tileId}.json.
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

  try {
    // Check file size before reading
    const stats = await stat(tilePath);
    if (stats.size > MAX_TILE_SIZE) {
      return NextResponse.json(
        { error: "TILE_TOO_LARGE", size: stats.size, limit: MAX_TILE_SIZE },
        { status: 413 },
      );
    }

    const content = await readFile(tilePath, "utf-8");

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, must-revalidate",
        "Content-Length": String(stats.size),
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