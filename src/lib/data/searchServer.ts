import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SearchRecordSchema, type SearchRecord } from "./schema";
import { SearchEngine } from "./searchEngine";
import { parseSearchQuery } from "./search";
import { SEARCH_LIMIT_MAX, SEARCH_MIN_QUERY_LENGTH, type SearchHit } from "./searchTypes";

export type SearchIndexErrorCode = "DATASET_UNAVAILABLE" | "DATASET_INVALID";

export class SearchIndexError extends Error {
  readonly code: SearchIndexErrorCode;

  constructor(code: SearchIndexErrorCode, message: string) {
    super(message);
    this.name = "SearchIndexError";
    this.code = code;
  }
}

interface LoadedSearchIndex {
  version: string;
  engine: SearchEngine;
  hits: Map<string, SearchHit[]>;
}

const HIT_CACHE_CAPACITY = 128;
/** Proximity only needs to be coarse; rounding the view centre lets nearby views share cached answers. */
const NEAR_CACHE_GRID_METRES = 1000;

let loaded: LoadedSearchIndex | null = null;
let loading: Promise<LoadedSearchIndex> | null = null;

export function resetSearchIndexCache(): void {
  loaded = null;
  loading = null;
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSearchIndex(filePath: string, version: string): Promise<LoadedSearchIndex> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isEnoent(error)) throw new SearchIndexError("DATASET_UNAVAILABLE", `search index missing at ${filePath}`);
    throw new SearchIndexError("DATASET_INVALID", `search index unreadable at ${filePath}: ${errorText(error)}`);
  }
  if (!Array.isArray(parsed)) throw new SearchIndexError("DATASET_INVALID", "search index is not an array");
  const records: SearchRecord[] = [];
  try {
    for (const entry of parsed) records.push(SearchRecordSchema.parse(entry));
  } catch (error) {
    throw new SearchIndexError("DATASET_INVALID", `search index record invalid: ${errorText(error)}`);
  }
  return { version, engine: new SearchEngine(records), hits: new Map() };
}

async function currentSearchIndex(): Promise<LoadedSearchIndex> {
  const filePath = join(process.env.MASTER_MAPS_DATA_DIR ?? "data", "search", "index.json");
  let version: string;
  try {
    const stats = await stat(filePath);
    version = `${stats.mtimeMs}-${stats.size}`;
  } catch (error) {
    if (isEnoent(error)) throw new SearchIndexError("DATASET_UNAVAILABLE", `search index missing at ${filePath}`);
    throw new SearchIndexError("DATASET_INVALID", `search index stat failed at ${filePath}: ${errorText(error)}`);
  }
  if (loaded && loaded.version === version) return loaded;
  if (loading === null) {
    loading = loadSearchIndex(filePath, version)
      .then((index) => {
        loaded = index;
        return index;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(Math.max(Math.trunc(limit), 1), SEARCH_LIMIT_MAX);
}

function cached(index: LoadedSearchIndex, key: string, compute: () => SearchHit[]): SearchHit[] {
  const hit = index.hits.get(key);
  if (hit !== undefined) {
    index.hits.delete(key);
    index.hits.set(key, hit);
    return hit;
  }
  const hits = compute();
  if (index.hits.size >= HIT_CACHE_CAPACITY) {
    const oldest = index.hits.keys().next();
    if (!oldest.done) index.hits.delete(oldest.value);
  }
  index.hits.set(key, hits);
  return hits;
}

function snap(near: [number, number] | undefined): [number, number] | undefined {
  if (near === undefined) return undefined;
  return [Math.round(near[0] / NEAR_CACHE_GRID_METRES) * NEAR_CACHE_GRID_METRES, Math.round(near[1] / NEAR_CACHE_GRID_METRES) * NEAR_CACHE_GRID_METRES];
}

/** Free-text search. `near` (local metres) biases ranking toward the current view. */
export async function querySearchIndex(rawQuery: string, limit: number, near?: [number, number]): Promise<{ hits: SearchHit[]; version: string }> {
  const index = await currentSearchIndex();
  const parsed = parseSearchQuery(rawQuery);
  const significant = parsed.words.join(" ");
  if (significant.length < SEARCH_MIN_QUERY_LENGTH || parsed.tokens.length === 0) return { hits: [], version: index.version };
  const boundedLimit = clampLimit(limit);
  const centre = snap(near);
  const key = `q|${rawQuery.trim().toLowerCase()}|${boundedLimit}|${centre?.join(",") ?? ""}`;
  const hits = cached(index, key, () => index.engine.search(rawQuery, { limit: boundedLimit, ...(centre === undefined ? {} : { near: centre }) }));
  return { hits, version: index.version };
}

/** Places of a category (and its close family) around a point, nearest first. */
export async function queryCategory(category: string, near: [number, number], radius: number, limit: number): Promise<{ hits: SearchHit[]; version: string }> {
  const index = await currentSearchIndex();
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 60);
  const key = `c|${category}|${Math.round(near[0])},${Math.round(near[1])}|${Math.round(radius)}|${boundedLimit}`;
  const hits = cached(index, key, () => index.engine.browseCategory({ category, near, radius, limit: boundedLimit }));
  return { hits, version: index.version };
}
