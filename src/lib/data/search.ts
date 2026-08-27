import type { SearchRecord } from "./schema";

export type { SearchRecord } from "./schema";

export interface SearchResult {
  record: SearchRecord;
  score: number;
  matchType: "exact" | "accent-insensitive" | "prefix" | "contains" | "edit-distance";
  matchedTerm: string;
}

const PUNCTUATION_PATTERN = /[\s\-–—/\\,;:.!?()[\]{}<>"'«»]+/g;
const MAX_EDIT_DISTANCE = 2;

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalize(value: string): string {
  return stripAccents(value).toLowerCase().trim();
}

function tokenize(value: string): string[] {
  return normalize(value).split(PUNCTUATION_PATTERN).filter((token) => token.length > 0);
}

function levenshteinBounded(first: string, second: string, maxDistance: number): number {
  if (Math.abs(first.length - second.length) > maxDistance) return maxDistance + 1;
  let previous = new Uint8Array(second.length + 1);
  let current = new Uint8Array(second.length + 1);
  for (let index = 0; index <= second.length; index += 1) previous[index] = index;
  for (let row = 1; row <= first.length; row += 1) {
    current[0] = row;
    let rowMinimum = current[0]!;
    for (let column = 1; column <= second.length; column += 1) {
      const cost = first[row - 1] === second[column - 1] ? 0 : 1;
      const value = Math.min(current[column - 1]! + 1, previous[column]! + 1, previous[column - 1]! + cost);
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }
  return previous[second.length]!;
}

function nameScore(query: string, term: string): { score: number; matchType: SearchResult["matchType"] } | null {
  const normalizedQuery = normalize(query);
  const normalizedTerm = normalize(term);
  if (term === query) return { score: 1000, matchType: "exact" };
  if (normalizedTerm === normalizedQuery) return { score: 900, matchType: "accent-insensitive" };
  if (normalizedTerm.startsWith(normalizedQuery)) return { score: 500, matchType: "prefix" };
  if (normalizedTerm.includes(normalizedQuery)) return { score: 300, matchType: "contains" };
  return null;
}

export function searchIndex(query: string, records: SearchRecord[], maxResults = 10): SearchResult[] {
  const rawQuery = query.trim();
  const normalizedQuery = normalize(rawQuery);
  if (!normalizedQuery || records.length === 0) return [];
  const queryTokens = tokenize(rawQuery);
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const terms = [record.canonicalName, record.normalizedName, ...record.aliases];
    let best: { score: number; matchType: SearchResult["matchType"]; term: string } | null = null;
    for (const term of terms) {
      const direct = nameScore(rawQuery, term);
      const tokenMatch = direct === null && queryTokens.some((token) => normalize(term).startsWith(token) || normalize(term).includes(token));
      const candidate = direct ?? (tokenMatch ? { score: 300, matchType: "contains" as const } : null);
      if (candidate && (!best || candidate.score > best.score)) best = { ...candidate, term };
    }
    if (best) {
      seen.add(record.featureId);
      results.push({ record, score: best.score + record.boost, matchType: best.matchType, matchedTerm: best.term });
    }
  }
  if (normalizedQuery.length >= 2) {
    for (const record of records) {
      if (seen.has(record.featureId)) continue;
      let bestDistance = MAX_EDIT_DISTANCE + 1;
      let bestTerm = record.canonicalName;
      for (const term of [record.canonicalName, ...record.aliases]) {
        const distance = levenshteinBounded(normalize(term), normalizedQuery, MAX_EDIT_DISTANCE);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestTerm = term;
        }
      }
      if (bestDistance <= MAX_EDIT_DISTANCE) {
        results.push({ record, score: 100 + (MAX_EDIT_DISTANCE - bestDistance + 1) * 10 + record.boost, matchType: "edit-distance", matchedTerm: bestTerm });
      }
    }
  }
  results.sort((first, second) => second.score - first.score || first.record.canonicalName.localeCompare(second.record.canonicalName));
  return results.slice(0, maxResults);
}
