import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

/**
 * GET /api/map/search?q=<query>
 *
 * Searches the generated search index (data/generated/search/index.json).
 * Returns all records when q is empty or absent.
 *
 * The search is accent-insensitive and case-insensitive, matching against
 * the canonical name, normalised name, and registered aliases.
 *
 * Returns 503 with DATASET_UNAVAILABLE when the data volume is missing.
 */
export async function GET(request: NextRequest) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  const query = request.nextUrl.searchParams.get("q") ?? "";
  const searchPath = join(dataRoot, "generated", "search", "index.json");

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
        (entry.name as string) ?? (entry.normalizedName as string) ?? "",
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