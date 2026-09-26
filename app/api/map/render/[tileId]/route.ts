import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";

export const dynamic = "force-dynamic";

const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const MAX_TILE_ID_LENGTH = 128;
const GZIP_SUFFIX = ".mmt.gz";
const PLAIN_SUFFIX = ".mmt";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const VOLATILE_CACHE_CONTROL = "no-store";
const RENDER_TILE_CONTENT_TYPE = "application/octet-stream";

export function isValidRenderTileId(tileId: string | undefined): boolean {
  if (tileId === undefined || tileId.length === 0 || tileId.length > MAX_TILE_ID_LENGTH) return false;
  if (tileId.includes("..") || tileId.includes("/") || tileId.includes("\\")) return false;
  if (tileId.endsWith(".json") || tileId.endsWith(".mmt") || tileId.endsWith(".gz")) return false;
  return TILE_ID_RE.test(tileId);
}

export function isPinnedToDatasetVersion(requestVersion: string | null, datasetVersion: string): boolean {
  return requestVersion !== null && requestVersion.length > 0 && requestVersion === datasetVersion;
}

export function renderCacheControl(pinned: boolean): string {
  return pinned ? IMMUTABLE_CACHE_CONTROL : VOLATILE_CACHE_CONTROL;
}

let datasetVersion: string | null = null;
let datasetVersionLoading: Promise<string> | null = null;

export function resetRenderVersionCache(): void {
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

function errorResponse(status: 500 | 503, code: "DATASET_UNAVAILABLE" | "DATASET_INVALID", headers: Record<string, string>): NextResponse {
  return NextResponse.json({ error: code, code }, { status, headers });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tileId: string }> },
) {
  const { tileId } = await params;
  if (!isValidRenderTileId(tileId)) return NextResponse.json({ error: "INVALID_TILE_ID", code: "INVALID_TILE_ID" }, { status: 400 });

  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  let version: string;
  try {
    version = await currentDatasetVersion(dataRoot);
  } catch (error) {
    if (isMissing(error)) return errorResponse(503, "DATASET_UNAVAILABLE", { "Cache-Control": VOLATILE_CACHE_CONTROL });
    return errorResponse(500, "DATASET_INVALID", { "Cache-Control": VOLATILE_CACHE_CONTROL });
  }

  const pinned = isPinnedToDatasetVersion(request.nextUrl.searchParams.get("v"), version);
  const baseHeaders: Record<string, string> = {
    "Cache-Control": renderCacheControl(pinned),
    "Content-Type": RENDER_TILE_CONTENT_TYPE,
    "X-Dataset-Version": version,
    Vary: "Accept-Encoding",
  };

  const renderDir = join(dataRoot, "generated", "render");
  const gzipPath = join(renderDir, `${tileId}${GZIP_SUFFIX}`);
  const plainPath = join(renderDir, `${tileId}${PLAIN_SUFFIX}`);
  let payloadPath: string;
  let encoding: string | null;
  try {
    const gzipStats = await stat(gzipPath);
    payloadPath = gzipPath;
    encoding = "gzip";
    baseHeaders["Content-Length"] = String(gzipStats.size);
  } catch (error) {
    if (!isMissing(error)) return errorResponse(500, "DATASET_INVALID", baseHeaders);
    try {
      const plainStats = await stat(plainPath);
      payloadPath = plainPath;
      encoding = null;
      baseHeaders["Content-Length"] = String(plainStats.size);
    } catch (plainError) {
      if (isMissing(plainError)) return errorResponse(503, "DATASET_UNAVAILABLE", { "Cache-Control": VOLATILE_CACHE_CONTROL, "X-Dataset-Version": version });
      return errorResponse(500, "DATASET_INVALID", baseHeaders);
    }
  }
  if (encoding !== null) baseHeaders["Content-Encoding"] = encoding;

  const stream = createReadStream(payloadPath);
  try {
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: baseHeaders });
  } catch (error) {
    stream.destroy();
    return errorResponse(500, "DATASET_INVALID", baseHeaders);
  }
}
