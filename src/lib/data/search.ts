// @ts-nocheck
/**
 * Accent-insensitive search index for the Auch map data.
 *
 * Unicode NFD normalization strips combining diacritical marks (e.g. é → e).
 * Tokenization splits on whitespace and punctuation. Scoring ranks:
 *   1. Exact canonical match / exact accent-insensitive match
 *   2. Prefix match (query is prefix of canonical or normalized name)
 *   3. Contains match (query appears within canonical or normalized name)
 *   4. Edit-distance match (within bounded Levenshtein window)
 *
 * "Nocibé", "Nocibe", "nocib", and a one-character typo all resolve to Nocibé.
 */

// ---- Local fallback types (converge when schema.ts lands) ----
export interface SearchRecord {
  id: string;
  canonicalName: string;
  normalizedName: string;
  aliases: string[];
  featureType: string;
  category: string;
  tileId: string;
  featureId: string;
  focusLon: number;
  focusLat: number;
}

export interface SearchResult {
  record: SearchRecord;
  score: number;
  matchType: "exact" | "accent-insensitive" | "prefix" | "contains" | "edit-distance";
  matchedTerm: string;
}

// ---- Normalization ----
const PUNCTUATION_PATTERN = /[\s\-–—/\\,;:.!?()[\]{}<>"'«»]+/g;

/**
 * Strip combining diacritical marks via Unicode NFD decomposition.
 * é → e + combining acute → stripped to just e.
 */
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalize(s: string): string {
  return stripAccents(s).toLowerCase().trim();
}

function tokenize(s: string): string[] {
  return normalize(s)
    .split(PUNCTUATION_PATTERN)
    .filter((t) => t.length > 0);
}

// ---- Edit distance (Levenshtein, bounded) ----
/**
 * Compute Levenshtein distance with an early bail at `maxDist + 1`.
 * Returns the exact distance if ≤ maxDist, or > maxDist otherwise.
 */
function levenshteinBounded(a: string, b: string, maxDist: number): number {
  // Early length difference check
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > maxDist) return maxDist + 1;

  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use two-row technique (O(min(a,b)) memory)
  let prev = new Uint8Array(b.length + 1);
  let curr = new Uint8Array(b.length + 1);

  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = curr[j - 1] + 1;
      const ins = prev[j] + 1;
      const sub = prev[j - 1] + cost;
      const min = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      curr[j] = min;
      if (min < rowMin) rowMin = min;
    }

    // Swap rows
    [prev, curr] = [curr, prev];

    // Bail if whole row exceeds maxDist
    if (rowMin > maxDist) return maxDist + 1;
  }

  return prev[b.length];
}

// ---- Scoring ----
enum MatchScore {
  EXACT = 1000,
  ACCENT_INSENSITIVE = 900,
  PREFIX = 500,
  CONTAINS = 300,
  EDIT_DISTANCE = 100,
}

const MAX_EDIT_DISTANCE = 2;
const MAX_EDIT_CANDIDATES = 50; // bounded candidate set for edit-distance

export function searchIndex(
  query: string,
  records: SearchRecord[],
  maxResults: number = 10
): SearchResult[] {
  if (!query || query.length === 0) return [];

  const rawQuery = query.trim();
  const normalizedQuery = normalize(rawQuery);
  const queryTokens = tokenize(rawQuery);

  if (normalizedQuery.length === 0) return [];
  if (records.length === 0) return [];

  interface Scored extends SearchResult {
    record: SearchRecord;
  }

  const results: Scored[] = [];
  const seenIds = new Set<string>();

  // Phase 1: exact, accent-insensitive, prefix, contains — linear scan
  for (const record of records) {
    const canonical = record.canonicalName;
    const normalized = record.normalizedName;
    const allNames = [canonical, normalized, ...record.aliases];

    let bestScore = -1;
    let bestMatchType: SearchResult["matchType"] = "contains";
    let bestMatchedTerm = "";

    for (const name of allNames) {
      const nName = normalize(name);

      // Exact canonical match
      if (name === rawQuery) {
        if (MatchScore.EXACT > bestScore) {
          bestScore = MatchScore.EXACT;
          bestMatchType = "exact";
          bestMatchedTerm = name;
        }
        continue;
      }

      // Exact accent-insensitive match
      if (nName === normalizedQuery) {
        if (MatchScore.ACCENT_INSENSITIVE > bestScore) {
          bestScore = MatchScore.ACCENT_INSENSITIVE;
          bestMatchType = "accent-insensitive";
          bestMatchedTerm = name;
        }
        continue;
      }

      // Prefix match — any token starts with query, or name starts with query
      if (nName.startsWith(normalizedQuery) || queryTokens.some((qt) => nName.startsWith(qt))) {
        if (MatchScore.PREFIX > bestScore) {
          bestScore = MatchScore.PREFIX;
          bestMatchType = "prefix";
          bestMatchedTerm = name;
        }
        continue;
      }

      // Contains match
      if (nName.includes(normalizedQuery) || queryTokens.some((qt) => nName.includes(qt))) {
        if (MatchScore.CONTAINS > bestScore) {
          bestScore = MatchScore.CONTAINS;
          bestMatchType = "contains";
          bestMatchedTerm = name;
        }
        continue;
      }

      // Token-level contains
      const nameTokens = tokenize(name);
      for (const nt of nameTokens) {
        if (normalizedQuery.includes(nt) || nt.includes(normalizedQuery)) {
          if (MatchScore.CONTAINS > bestScore) {
            bestScore = MatchScore.CONTAINS;
            bestMatchType = "contains";
            bestMatchedTerm = name;
          }
          break;
        }
      }
    }

    if (bestScore >= 0) {
      seenIds.add(record.id);
      results.push({
        record,
        score: bestScore,
        matchType: bestMatchType,
        matchedTerm: bestMatchedTerm,
      });
    }
  }

  // Phase 2: edit-distance — only for queries of length ≥ 2, bounded candidate set
  if (normalizedQuery.length >= 2) {
    // Collect unscored records, bounded
    const unscored: SearchRecord[] = [];
    for (const record of records) {
      if (!seenIds.has(record.id)) {
        unscored.push(record);
        if (unscored.length >= MAX_EDIT_CANDIDATES) break;
      }
    }

    for (const record of unscored) {
      const normalized = record.normalizedName;
      const distance = levenshteinBounded(normalized, normalizedQuery, MAX_EDIT_DISTANCE);

      if (distance <= MAX_EDIT_DISTANCE) {
        // Score inversely proportional to distance
        const score = MatchScore.EDIT_DISTANCE + (MAX_EDIT_DISTANCE - distance + 1) * 10;
        results.push({
          record,
          score,
          matchType: "edit-distance",
          matchedTerm: record.canonicalName,
        });
      }
    }

    // Also check aliases for edit-distance matches
    const aliasRecords = unscored.filter((r) => r.aliases.length > 0);
    for (const record of aliasRecords) {
      if (seenIds.has(record.id)) continue;
      for (const alias of record.aliases) {
        const nAlias = normalize(alias);
        const distance = levenshteinBounded(nAlias, normalizedQuery, MAX_EDIT_DISTANCE);
        if (distance <= MAX_EDIT_DISTANCE) {
          const score = MatchScore.EDIT_DISTANCE + (MAX_EDIT_DISTANCE - distance + 1) * 10;
          results.push({
            record,
            score,
            matchType: "edit-distance",
            matchedTerm: alias,
          });
          seenIds.add(record.id);
          break;
        }
      }
    }
  }

  // Sort: descending score, then ascending canonical name for stability
  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.record.canonicalName.localeCompare(b.record.canonicalName);
  });

  return results.slice(0, maxResults);
}