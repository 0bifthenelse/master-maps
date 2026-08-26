import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

// Projection origin from scripts/data/normalize.ts
const PROJECTION_ORIGIN: [number, number] = [0.566553, 43.66256];

// --- Inline subset of DatasetManifestSchema fields the client needs ---

interface TileEntry {
  tileId: string;
  bounds: [number, number, number, number];
  featureCount: number;
  byteSize: number;
  features: string[];
}

interface AssembledManifest {
  datasetVersion: string;
  acquisitionTime: string;
  pipeline: string[];
  tileIds: string[];
  tiles: TileEntry[];
  featureCounts: Record<string, number>;
  byteSizes: Record<string, number>;
  layerAvailability: Record<string, boolean>;
  projectionOrigin: [number, number];
  /** Local projected bounds computed from tile entries */
  bounds: [number, number, number, number];
}

async function readJson<T>(absPath: string): Promise<T> {
  const content = await readFile(absPath, "utf-8");
  return JSON.parse(content) as T;
}

/**
 * GET /api/map/manifest
 *
 * Returns an assembled dataset manifest from existing source-backed files:
 *   data/generated/manifest.json       — version/acquisitionTime/pipeline
 *   data/generated/tile-manifest.json  — tile metadata
 *
 * Response includes tileIds, tiles, featureCounts, layerAvailability,
 * projection origin, and local projected bounds for camera setup.
 *
 * Returns 503 with DATASET_UNAVAILABLE when the data volume is missing.
 */
export async function GET(_request: NextRequest) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  const manifestPath = join(dataRoot, "generated", "manifest.json");
  const tileManifestPath = join(dataRoot, "generated", "tile-manifest.json");

  try {
    // Read core manifest for version metadata
    const core = await readJson<{
      version: string;
      acquisitionTime: string;
      pipeline: string[];
    }>(manifestPath);

    // Read tile-manifest for per-tile metadata
    const tileEntries = await readJson<TileEntry[]>(tileManifestPath);

    // Build feature counts and layer availability
    const featureCounts: Record<string, number> = {};
    const byteSizes: Record<string, number> = {};
    const layerAvailability: Record<string, boolean> = {};
    const tileIds: string[] = [];

    // Track overall projected bounds
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (const entry of tileEntries) {
      tileIds.push(entry.tileId);
      featureCounts[entry.tileId] = entry.featureCount;
      byteSizes[entry.tileId] = entry.byteSize;

      // Derive layer availability from feature stableId prefixes
      for (const id of entry.features) {
        const kind = id.includes(":") ? id.split(":")[0]! : "unknown";
        layerAvailability[kind] = true;
      }

      // Accumulate bounds
      const [tx0, tz0, tx1, tz1] = entry.bounds;
      if (tx0 < minX) minX = tx0;
      if (tz0 < minZ) minZ = tz0;
      if (tx1 > maxX) maxX = tx1;
      if (tz1 > maxZ) maxZ = tz1;
    }

    const assembled: AssembledManifest = {
      datasetVersion: core.version ?? "0.1.0",
      acquisitionTime: core.acquisitionTime,
      pipeline: core.pipeline ?? [],
      tileIds,
      tiles: tileEntries,
      featureCounts,
      byteSizes,
      layerAvailability,
      projectionOrigin: PROJECTION_ORIGIN,
      bounds: Number.isFinite(minX)
        ? [minX, minZ, maxX, maxZ]
        : [0, 0, 0, 0],
    };

    return NextResponse.json(assembled, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=3600, must-revalidate",
        "X-Dataset-Version": core.version ?? "unknown",
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