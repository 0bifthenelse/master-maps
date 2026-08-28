import type { SearchHit } from "./searchTypes";

export const MAX_EDIT_DISTANCE = 2;

const PUNCTUATION_PATTERN = /[\s\-\u2013\u2014/\\,;:.!?()[\]{}<>"'«»]+/g;

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeSearchText(value: string): string {
  return stripAccents(value).toLowerCase().trim();
}

export function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value).split(PUNCTUATION_PATTERN).filter((token) => token.length > 0);
}

export function levenshteinBounded(first: string, second: string, maxDistance: number): number {
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

export function scoreTerm(
  rawQuery: string,
  normalizedQuery: string,
  term: string,
  normalizedTerm: string,
): { score: number; matchType: SearchHit["matchType"] } | null {
  if (term === rawQuery) return { score: 1000, matchType: "exact" };
  if (normalizedTerm === normalizedQuery) return { score: 900, matchType: "accent-insensitive" };
  if (normalizedTerm.startsWith(normalizedQuery)) return { score: 500, matchType: "prefix" };
  if (normalizedTerm.includes(normalizedQuery)) return { score: 300, matchType: "contains" };
  return null;
}

export function editDistanceScore(distance: number): number {
  return 100 + (MAX_EDIT_DISTANCE - distance + 1) * 10;
}
