import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SearchRecordSchema, type SearchRecord } from "@/lib/data/schema";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const dataRoot = process.env.MASTER_MAPS_DATA_DIR ?? "data";
  const query = request.nextUrl.searchParams.get("q") ?? "";
  if (query.length > 256) return NextResponse.json({ error: "QUERY_TOO_LONG", code: "QUERY_TOO_LONG" }, { status: 400 });
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 8192) return NextResponse.json({ error: "QUERY_TOO_LARGE", code: "QUERY_TOO_LARGE" }, { status: 413 });
  try {
    const parsed = JSON.parse(await readFile(join(dataRoot, "search", "index.json"), "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("search index is not an array");
    const records: SearchRecord[] = parsed.map((entry) => SearchRecordSchema.parse(entry));
    if (!query) return NextResponse.json(records);
    const normalizedQuery = normalizeText(query);
    const results = records.filter((record) => normalizeText(record.canonicalName).includes(normalizedQuery)
      || record.aliases.some((alias) => normalizeText(alias).includes(normalizedQuery))
      || record.normalizedName.includes(normalizedQuery));
    return NextResponse.json(results);
  } catch (error) {
    const status = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT" ? 503 : 500;
    return NextResponse.json({ error: status === 503 ? "DATASET_UNAVAILABLE" : "DATASET_INVALID", code: status === 503 ? "DATASET_UNAVAILABLE" : "DATASET_INVALID" }, { status });
  }
}

function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
