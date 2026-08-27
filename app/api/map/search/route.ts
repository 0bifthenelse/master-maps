import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

/**
 * GET /api/map/search?q=<query>
 *
 * Searches the generated search index at data/search/index.json.
 * Returns all records when q is empty or absent.
 *
 * The search is accent-insensitive and case-insensitive, matching against
 * the canonical name, normalised name, and registered aliases.
 *
 * Returns 503 with DATASET_UNAVAILABLE when the data volume is missing.
 * Returns 400 with QUERY_TOO_LONG for queries exceeding 256 characters.
 * Returns 413 with QUERY_TOO_LARGE for requests above 8 KiB total.
 */
export async function GET(request: NextRequest) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";

  // The build pipeline (build-search-index.ts) writes to data/search/,
  // not data/generated/search/.
  const searchPath = join(dataRoot, "search", "index.json");

  const query = request.nextUrl.searchParams.get("q") ?? "";

  // Size protections
  if (query.length > 256) {
    return NextResponse.json(
      { error: "QUERY_TOO_LONG", code: "QUERY_TOO_LONG" },
      { status: 400 },
    );
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const len = parseInt(contentLength, 10);
    if (!isNaN(len) && len > 8192) {
      return NextResponse.json(
        { error: "QUERY_TOO_LARGE", code: "QUERY_TOO_LARGE" },
        { status: 413 },
      );
    }
  }

  try {
    const content = await readFile(searchPath, "utf-8");
    const searchIndex = JSON.parse(content) as Record<string, unknown>[];

    if (!query) {
      return NextResponse.json(searchIndex, {
        status: 200,
        headers: {
          "Cache-Control": "public, max-age=3600, must-revalidate",
        },
      });
    }

    // Accent-insensitive, case-insensitive matching via NFD decomposition
    const normalizeText = (text: string): string =>
      text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

    const normalizedQuery = normalizeText(query);

    const results = searchIndex.filter((entry: Record<string, unknown>) => {
      const name = normalizeText(
        (entry.canonicalName as string) ?? (entry.normalizedName as string) ?? "",
      );
      if (name.includes(normalizedQuery)) return true;

      const normalizedName =
        typeof entry.normalizedName === "string"
          ? normalizeText(entry.normalizedName)
          : "";
      if (
        normalizedName &&
        normalizedName !== name &&
        normalizedName.includes(normalizedQuery)
      )
        return true;

      const aliases = entry.aliases as string[] | undefined;
      if (Array.isArray(aliases)) {
        return aliases.some((a) =>
          normalizeText(a).includes(normalizedQuery),
        );
      }

      return false;
    });

    return NextResponse.json(results, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=3600, must-revalidate",
        "X-Search-Results": String(results.length),
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