import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

// Projection origin from scripts/data/normalize.ts
const PROJECTION_ORIGIN: [number, number] = [0.566553, 43.66256];
const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

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
  tileFeatureCounts: Record<string, number>;
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
    const core = await readJson<{
      version?: string;
      datasetVersion?: string;
      acquisitionTime: string;
      pipeline?: string[];
      featureCounts?: Record<string, number>;
      layerAvailability?: Record<string, boolean>;
      projectionOrigin?: [number, number];
    }>(manifestPath);

    // Read tile-manifest for per-tile metadata
    const tileEntries = await readJson<TileEntry[]>(tileManifestPath);

    const featureCounts: Record<string, number> = { ...(core.featureCounts ?? {}) };
    const byteSizes: Record<string, number> = {};
    const tileFeatureCounts: Record<string, number> = {};
    const layerAvailability: Record<string, boolean> = { ...(core.layerAvailability ?? {}) };
    const tileIds: string[] = [];

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (const entry of tileEntries) {
      if (!TILE_ID_RE.test(entry.tileId)) {
        throw new Error(`Invalid tile ID in manifest: ${entry.tileId}`);
      }
      tileIds.push(entry.tileId);
      tileFeatureCounts[entry.tileId] = entry.featureCount;
      byteSizes[entry.tileId] = entry.byteSize;

      const [tx0, tz0, tx1, tz1] = entry.bounds;
      minX = Math.min(minX, tx0);
      minZ = Math.min(minZ, tz0);
      maxX = Math.max(maxX, tx1);
      maxZ = Math.max(maxZ, tz1);
    }

    const datasetVersion = core.version ?? core.datasetVersion ?? "0.1.0";
    const assembled: AssembledManifest = {
      datasetVersion,
      acquisitionTime: core.acquisitionTime,
      pipeline: core.pipeline ?? [],
      tileIds,
      tiles: tileEntries,
      featureCounts,
      byteSizes,
      layerAvailability,
      tileFeatureCounts,
      projectionOrigin: core.projectionOrigin ?? PROJECTION_ORIGIN,
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