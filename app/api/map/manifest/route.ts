import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

/**
 * GET /api/map/manifest
 *
 * Returns the generated dataset manifest (data/generated/manifest.json).
 * Sets content-type, dataset-version, and cache-control headers.
 * Returns 503 with DATASET_UNAVAILABLE when the data volume is missing.
 */
export async function GET(_request: NextRequest) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  const manifestPath = join(dataRoot, "generated", "manifest.json");

  try {
    const content = await readFile(manifestPath, "utf-8");

    // Extract version for cache header without fully re-parsing
    let version: string = "unknown";
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (typeof parsed.datasetVersion === "string") {
        version = parsed.datasetVersion;
      } else if (typeof parsed.acquisitionTime === "string") {
        version = parsed.acquisitionTime;
      }
    } catch {
      // version remains "unknown" if manifest is malformed
    }

    return new NextResponse(content, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600, must-revalidate",
        "X-Dataset-Version": version,
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