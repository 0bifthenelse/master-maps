import { NextRequest, NextResponse } from "next/server";
import { normalizeSearchText } from "@/lib/data/search";
import { SearchIndexError, querySearchIndex } from "@/lib/data/searchServer";
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_MAX_QUERY_LENGTH,
  SEARCH_MIN_QUERY_LENGTH,
} from "@/lib/data/searchTypes";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q") ?? "";
  if (query.length > SEARCH_MAX_QUERY_LENGTH) return NextResponse.json({ error: "QUERY_TOO_LONG", code: "QUERY_TOO_LONG" }, { status: 400 });
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 8192) return NextResponse.json({ error: "QUERY_TOO_LARGE", code: "QUERY_TOO_LARGE" }, { status: 413 });
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length < SEARCH_MIN_QUERY_LENGTH) return NextResponse.json([]);
  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  try {
    const { hits, version } = await querySearchIndex(query, limit);
    const etag = `W/"${version}-${normalizedQuery}-${limit}"`;
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

function parseLimit(raw: string | null): number {
  if (raw === null) return SEARCH_LIMIT_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(Math.max(parsed, 1), SEARCH_LIMIT_MAX);
}
