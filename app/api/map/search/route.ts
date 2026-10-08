import { NextRequest, NextResponse } from "next/server";
import { CATEGORY_BY_ID } from "@/lib/data/categories";
import { normalizeSearchText } from "@/lib/data/search";
import { SearchIndexError, queryCategory, querySearchIndex } from "@/lib/data/searchServer";
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
  type SearchHit,
} from "@/lib/data/searchTypes";

export const dynamic = "force-dynamic";

const CATEGORY_LIMIT_MAX = 60;
const RADIUS_DEFAULT = 3000;
const RADIUS_MAX = 60_000;

/**
 * GET /api/map/search
 *   ?q=pharmacie auch[&limit=12][&near=x,z]   free-text search, biased toward `near`
 *   ?category=pharmacy&near=x,z[&radius=m]     places of a category around a point
 * `near` is in the map's local metres (Lambert-93 relative to the render origin).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 8192) return NextResponse.json({ error: "QUERY_TOO_LARGE", code: "QUERY_TOO_LARGE" }, { status: 413 });
  const near = parseNear(params.get("near"));
  if (near === "invalid") return NextResponse.json({ error: "INVALID_NEAR", code: "INVALID_NEAR" }, { status: 400 });

  const category = params.get("category");
  if (category !== null) {
    if (!CATEGORY_BY_ID.has(category)) return NextResponse.json({ error: "UNKNOWN_CATEGORY", code: "UNKNOWN_CATEGORY" }, { status: 400 });
    if (near === undefined) return NextResponse.json({ error: "NEAR_REQUIRED", code: "NEAR_REQUIRED" }, { status: 400 });
    const radius = clamp(Number(params.get("radius") ?? RADIUS_DEFAULT), 100, RADIUS_MAX, RADIUS_DEFAULT);
    const limit = parseLimit(params.get("limit"), CATEGORY_LIMIT_MAX);
    return respond(request, () => queryCategory(category, near, radius, limit), `c-${category}-${near.join(",")}-${radius}-${limit}`);
  }

  const query = params.get("q") ?? "";
  if (query.length > SEARCH_MAX_QUERY_LENGTH) return NextResponse.json({ error: "QUERY_TOO_LONG", code: "QUERY_TOO_LONG" }, { status: 400 });
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length < SEARCH_MIN_QUERY_LENGTH) return NextResponse.json([]);
  const limit = parseLimit(params.get("limit"));
  return respond(request, () => querySearchIndex(query, limit, near), `q-${normalizedQuery}-${limit}-${near?.map((value) => Math.round(value / 1000)).join(",") ?? ""}`);
}

async function respond(request: NextRequest, run: () => Promise<{ hits: SearchHit[]; version: string }>, key: string): Promise<NextResponse> {
  try {
    const { hits, version } = await run();
    const etag = `W/"${version}-${encodeURIComponent(key)}"`;
    if (request.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" } });
    }
    return NextResponse.json(hits, { headers: { "Cache-Control": "public, max-age=0, must-revalidate", ETag: etag } });
  } catch (error) {
    const code = error instanceof SearchIndexError ? error.code : "DATASET_INVALID";
    const status = code === "DATASET_UNAVAILABLE" ? 503 : 500;
    return NextResponse.json({ error: code, code }, { status });
  }
}

function parseNear(raw: string | null): [number, number] | undefined | "invalid" {
  if (raw === null || raw === "") return undefined;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 2 || !parts.every((value) => Number.isFinite(value) && Math.abs(value) < 1e7)) return "invalid";
  return [parts[0]!, parts[1]!];
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function parseLimit(raw: string | null, max = SEARCH_LIMIT_MAX): number {
  if (raw === null) return SEARCH_LIMIT_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(Math.max(parsed, 1), max);
}
