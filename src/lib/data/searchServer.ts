import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SearchRecordSchema, type SearchRecord } from "./schema";
import {
  editDistanceScore,
  levenshteinBounded,
  MAX_EDIT_DISTANCE,
  normalizeSearchText,
  scoreTerm,
  tokenizeSearchText,
} from "./search";
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
  records: SearchRecord[];
  normalizedTerms: string[][];
  buckets: Map<string, number[]>;
  hits: Map<string, SearchHit[]>;
}

const BUCKET_PREFIX_LENGTH = 3;
const WHOLE_PREFIX_BUCKET_LIMIT = 4096;
const FUZZY_CANDIDATE_LIMIT = 5000;
const HIT_CACHE_CAPACITY = 64;

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
  const normalizedTerms = records.map((record) => [
    record.normalizedName,
    ...record.aliases.map((alias) => normalizeSearchText(alias)),
  ]);
  return { version, records, normalizedTerms, buckets: buildBuckets(normalizedTerms), hits: new Map() };
}

function buildBuckets(normalizedTerms: string[][]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  for (let recordIndex = 0; recordIndex < normalizedTerms.length; recordIndex += 1) {
    const terms = normalizedTerms[recordIndex];
    if (!terms) continue;
    for (const term of terms) {
      addBucketEntry(buckets, term.slice(0, BUCKET_PREFIX_LENGTH), recordIndex);
      for (const token of tokenizeSearchText(term)) {
        if (token.length < 2) continue;
        addBucketEntry(buckets, token.slice(0, BUCKET_PREFIX_LENGTH), recordIndex);
      }
    }
  }
  return buckets;
}

function addBucketEntry(buckets: Map<string, number[]>, key: string, recordIndex: number): void {
  if (!key) return;
  const bucket = buckets.get(key);
  if (bucket === undefined) {
    buckets.set(key, [recordIndex]);
    return;
  }
  if (bucket[bucket.length - 1] !== recordIndex) bucket.push(recordIndex);
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

export async function querySearchIndex(rawQuery: string, limit: number): Promise<{ hits: SearchHit[]; version: string }> {
  const index = await currentSearchIndex();
  const normalizedQuery = normalizeSearchText(rawQuery);
  if (normalizedQuery.length < SEARCH_MIN_QUERY_LENGTH) return { hits: [], version: index.version };
  const boundedLimit = clampLimit(limit);
  const cacheKey = `${normalizedQuery}|${boundedLimit}`;
  const cachedHits = index.hits.get(cacheKey);
  if (cachedHits) {
    index.hits.delete(cacheKey);
    index.hits.set(cacheKey, cachedHits);
    return { hits: cachedHits, version: index.version };
  }
  const hits = computeHits(index, rawQuery, normalizedQuery, boundedLimit);
  storeHits(index, cacheKey, hits);
  return { hits, version: index.version };
}

function storeHits(index: LoadedSearchIndex, key: string, hits: SearchHit[]): void {
  if (index.hits.size >= HIT_CACHE_CAPACITY) {
    const oldest = index.hits.keys().next();
    if (!oldest.done) index.hits.delete(oldest.value);
  }
  index.hits.set(key, hits);
}

interface ScoredMatch {
  recordIndex: number;
  score: number;
  matchType: SearchHit["matchType"];
}

function computeHits(index: LoadedSearchIndex, rawQuery: string, normalizedQuery: string, limit: number): SearchHit[] {
  const candidates = selectCandidates(index, normalizedQuery);
  if (candidates.size === 0) return [];
  const matches: ScoredMatch[] = [];
  for (const recordIndex of candidates) {
    const record = index.records[recordIndex];
    const terms = index.normalizedTerms[recordIndex];
    if (!record || !terms) continue;
    const best = bestDirectScore(index, recordIndex, rawQuery, normalizedQuery, terms);
    if (best) matches.push({ recordIndex, score: best.score + record.boost, matchType: best.matchType });
  }
  if (matches.length < limit && normalizedQuery.length >= 4 && candidates.size <= FUZZY_CANDIDATE_LIMIT) {
    appendFuzzyMatches(index, matches, candidates, normalizedQuery);
  }
  matches.sort((first, second) => {
    const firstRecord = index.records[first.recordIndex]!;
    const secondRecord = index.records[second.recordIndex]!;
    return second.score - first.score || firstRecord.canonicalName.localeCompare(secondRecord.canonicalName);
  });
  return matches.slice(0, limit).map((match) => toSearchHit(index.records[match.recordIndex]!, match.score, match.matchType));
}

function selectCandidates(index: LoadedSearchIndex, normalizedQuery: string): Set<number> {
  const wholePrefixKey = normalizedQuery.slice(0, BUCKET_PREFIX_LENGTH);
  const keys = new Set<string>([wholePrefixKey]);
  for (const token of tokenizeSearchText(normalizedQuery)) {
    if (token.length < 2) continue;
    keys.add(token.slice(0, BUCKET_PREFIX_LENGTH));
  }
  let seed: number[] | null = null;
  for (const key of keys) {
    const bucket = index.buckets.get(key);
    if (!bucket || bucket.length === 0) continue;
    if (seed === null || bucket.length < seed.length) seed = bucket;
  }
  const candidates = new Set<number>(seed ?? []);
  const wholePrefixBucket = index.buckets.get(wholePrefixKey);
  if (wholePrefixBucket && wholePrefixBucket.length <= WHOLE_PREFIX_BUCKET_LIMIT) {
    for (const recordIndex of wholePrefixBucket) candidates.add(recordIndex);
  }
  return candidates;
}

function bestDirectScore(
  index: LoadedSearchIndex,
  recordIndex: number,
  rawQuery: string,
  normalizedQuery: string,
  terms: string[],
): { score: number; matchType: SearchHit["matchType"] } | null {
  let best: { score: number; matchType: SearchHit["matchType"] } | null = null;
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    const normalizedTerm = terms[termIndex];
    if (normalizedTerm === undefined) continue;
    const scored = scoreTerm(rawQuery, normalizedQuery, rawTermAt(index, recordIndex, termIndex, normalizedTerm), normalizedTerm);
    if (scored && (best === null || scored.score > best.score)) best = scored;
  }
  return best;
}

function rawTermAt(index: LoadedSearchIndex, recordIndex: number, termIndex: number, normalizedTerm: string): string {
  const record = index.records[recordIndex]!;
  if (termIndex === 0) return record.canonicalName;
  return record.aliases[termIndex - 1] ?? normalizedTerm;
}

function appendFuzzyMatches(index: LoadedSearchIndex, matches: ScoredMatch[], candidates: Set<number>, normalizedQuery: string): void {
  const matched = new Set(matches.map((match) => match.recordIndex));
  for (const recordIndex of candidates) {
    if (matched.has(recordIndex)) continue;
    const record = index.records[recordIndex];
    const terms = index.normalizedTerms[recordIndex];
    if (!record || !terms) continue;
    let bestDistance = MAX_EDIT_DISTANCE + 1;
    for (const normalizedTerm of terms) {
      const distance = levenshteinBounded(normalizedTerm, normalizedQuery, MAX_EDIT_DISTANCE);
      if (distance < bestDistance) bestDistance = distance;
    }
    if (bestDistance <= MAX_EDIT_DISTANCE) {
      matches.push({ recordIndex, score: editDistanceScore(bestDistance) + record.boost, matchType: "edit-distance" });
    }
  }
}

function toSearchHit(record: SearchRecord, score: number, matchType: SearchHit["matchType"]): SearchHit {
  const hit: SearchHit = {
    featureId: record.featureId,
    canonicalName: record.canonicalName,
    kind: record.kind,
    tileId: record.tileId,
    focusLon: record.focusLon,
    focusLat: record.focusLat,
    score,
    matchType,
  };
  if (record.category !== undefined) hit.category = record.category;
  return hit;
}
