import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import {
  MapFeatureSchema,
  TileManifestSchema,
  TileMetaDataSchema,
  TileDataSchema,
  type TileData,
  type TileManifest,
  type TileMetaData,
} from "@/lib/data/schema";
import { MappedFileCache } from "@/lib/data/mappedCache";

const MAX_TILE_SIZE = 2 * 1024 * 1024;
const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TILE_CACHE_ENTRIES = 64;
const TILE_NOT_INDEXED = "TILE_NOT_INDEXED";

/* Read on every request: the data can be refreshed without rebuilding the app. */
export const dynamic = "force-dynamic";

interface TileManifestIndex {
  byId: Map<string, TileManifest>;
  legacyPaths: Map<string, TileManifest>;
}

let datasetVersion: string | null = null;
let datasetVersionLoading: Promise<string> | null = null;
let manifestIndex: MappedFileCache<TileManifestIndex> | null = null;

const tileCache = new MappedFileCache<TileMetaData | TileData>({
  maxEntries: TILE_CACHE_ENTRIES,
  version: async (tilePath) => {
    const stats = await stat(tilePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  },
  load: async (tilePath) => {
    const gzipped = tilePath.endsWith(".json.gz");
    const tileId = tilePath.slice(tilePath.lastIndexOf("/") + 1, gzipped ? -".json.gz".length : -".json".length);
    const manifest = (await tileManifestIndex()).byId.get(tileId);
    if (!manifest) throw Object.assign(new Error(`tile ${tileId} is absent from the tile manifest`), { code: TILE_NOT_INDEXED });
    const raw = await readFile(tilePath);
    const parsed = JSON.parse((gzipped ? gunzipSync(raw) : raw).toString("utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("tile payload is not an array");
    if (gzipped) {
      const features = parsed as Record<string, unknown>[];
      if (features.length !== manifest.featureCount) throw new Error(`tile ${tileId} feature count mismatch`);
      return TileMetaDataSchema.parse({ manifest, features });
    }
    const features = parsed.map((feature) => MapFeatureSchema.parse(feature));
    if (features.length !== manifest.featureCount) throw new Error(`tile ${tileId} feature count mismatch`);
    return TileDataSchema.parse({ manifest, features });
  },
  validate: (loaded) => loaded as TileMetaData | TileData,
});

async function tileManifestIndex(): Promise<TileManifestIndex> {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  if (manifestIndex === null) {
    manifestIndex = new MappedFileCache<TileManifestIndex>({
      maxEntries: 1,
      version: async (path) => {
        const stats = await stat(path);
        return { mtimeMs: stats.mtimeMs, size: stats.size };
      },
      load: async (path) => {
        const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (!Array.isArray(raw)) throw new Error("tile manifest must be an array");
        const index: TileManifestIndex = { byId: new Map(), legacyPaths: new Map() };
        for (const entry of raw) {
          const manifest = TileManifestSchema.parse(entry);
          index.byId.set(manifest.tileId, manifest);
          if (manifest.byteSize > 0) index.legacyPaths.set(join(dataRoot, "generated", "tiles", `${manifest.tileId}.json`), manifest);
        }
        return index;
      },
      validate: (loaded) => loaded as TileManifestIndex,
    });
  }
  return manifestIndex.get(join(dataRoot, "generated", "tile-manifest.json"));
}

export function resetTileRouteCache(): void {
  tileCache.clear();
  manifestIndex?.clear();
  datasetVersion = null;
  datasetVersionLoading = null;
}

async function currentDatasetVersion(dataRoot: string): Promise<string> {
  if (datasetVersion !== null) return datasetVersion;
  if (datasetVersionLoading === null) {
    datasetVersionLoading = readFile(join(dataRoot, "generated", "manifest.json"), "utf8")
      .then((raw) => {
        const parsed = JSON.parse(raw) as { datasetVersion?: unknown };
        if (typeof parsed.datasetVersion !== "string" || parsed.datasetVersion.length === 0) throw new Error("dataset manifest has no datasetVersion");
        datasetVersion = parsed.datasetVersion;
        return parsed.datasetVersion;
      })
      .finally(() => {
        datasetVersionLoading = null;
      });
  }
  return datasetVersionLoading;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isUnindexed(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === TILE_NOT_INDEXED;
}

function unavailable(): NextResponse {
  return NextResponse.json({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" }, { status: 503 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tileId: string }> },
) {
  const { tileId } = await params;
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  if (!tileId || tileId.length > 128 || !TILE_ID_RE.test(tileId) || tileId.includes("..")) {
    return NextResponse.json({ error: "INVALID_TILE_ID", code: "INVALID_TILE_ID" }, { status: 400 });
  }
  const metaPath = join(dataRoot, "generated", "meta", `${tileId}.json.gz`);
  const legacyPath = join(dataRoot, "generated", "tiles", `${tileId}.json`);
  let tilePath = metaPath;
  let version: string;
  try {
    const metaStats = await stat(metaPath);
    if (metaStats.size > MAX_TILE_SIZE) return NextResponse.json({ error: "TILE_TOO_LARGE", size: metaStats.size, limit: MAX_TILE_SIZE }, { status: 413 });
    version = await currentDatasetVersion(dataRoot);
  } catch (metaError) {
    if (!isMissing(metaError)) throw metaError;
    tilePath = legacyPath;
    try {
      const legacyStats = await stat(legacyPath);
      if (legacyStats.size > MAX_TILE_SIZE) return NextResponse.json({ error: "TILE_TOO_LARGE", size: legacyStats.size, limit: MAX_TILE_SIZE }, { status: 413 });
      version = await currentDatasetVersion(dataRoot);
    } catch (legacyError) {
      if (isMissing(legacyError) || isUnindexed(legacyError)) return unavailable();
      throw legacyError;
    }
  }
  try {
    const data = await tileCache.get(tilePath);
    const headers: Record<string, string> = {
      "Cache-Control": "public, max-age=3600, must-revalidate",
      "Content-Type": "application/json",
      ETag: version,
      "X-Dataset-Version": version,
      Vary: "Accept-Encoding",
    };
    if (request.headers.get("if-none-match") === version) return new NextResponse(null, { status: 304, headers });
    /* The cached entry is the DECOMPRESSED tile, so the body is plain JSON and
       declaring gzip here makes the browser fail to decode it. */
    return new NextResponse(JSON.stringify(data), { status: 200, headers });
  } catch (error) {
    if (isMissing(error) || isUnindexed(error)) return unavailable();
    return NextResponse.json({ error: "DATASET_INVALID", code: "DATASET_INVALID" }, { status: 500 });
  }
}
