import { CATEGORY_BY_ID, categoryFamily, categoryIntents } from "./categories";
import type { SearchRecord } from "./schema";
import {
  allowedEdits,
  canonicalHouseNumber,
  foldSearchText,
  isStopWord,
  levenshteinBounded,
  parseSearchQuery,
  searchTokens,
  tokenizeSearchText,
  tokenVariants,
} from "./search";
import type { SearchHit } from "./searchTypes";
import { wgs84ToRender } from "@/lib/geo/crs";

/**
 * In-memory search over the canonical search records.
 *
 * Every record is reduced to a bag of tokens tagged with the field they came
 * from (its name, aliases, street, commune, codes, category words, house
 * number). A query matches a record when every query token matches one of
 * the record's tokens (exactly, by plural, by prefix while typing, or within
 * one or two typos), so "pharmacie auch", "12 bis rue gambetta auch",
 * "st clar" and "N124" all resolve the way people expect. Ranking blends how
 * well the words matched, how much of the name they cover, the record's
 * importance and its distance from the current view.
 */

export const FIELD = { NAME: 0, ALIAS: 1, STREET: 2, COMMUNE: 3, CODE: 4, CATEGORY: 5, NUMBER: 6 } as const;
type Field = (typeof FIELD)[keyof typeof FIELD];
const FIELD_WEIGHT: readonly number[] = [1, 0.9, 0.72, 0.78, 0.85, 0.6, 1];

const PREFIX_EXPANSION_LIMIT = 6000;
const PROXIMITY_BONUS = 180;
const PROXIMITY_SCALE_KM = 15;
const DUPLICATE_RADIUS_METRES = 150;
const MISS_PENALTY = 380;
/** Below this share of a category carrying the query word in its names, the word is a brand, not a generic term. */
const BRAND_SHARE = 0.3;

type LocalPoint = [number, number];

export interface TextSearchOptions {
  limit: number;
  /** Local metres of the current view centre; nearer results rank higher. */
  near?: LocalPoint;
}

export interface CategorySearchOptions {
  category: string;
  near: LocalPoint;
  radius: number;
  limit: number;
}

interface Candidate {
  record: number;
  score: number;
  matchType: SearchHit["matchType"];
  /** Every query word matched the record's own name or aliases. */
  named?: boolean;
  /** The words are the record's whole name. */
  exact?: boolean;
}

interface TokenQuery {
  matches: Map<number, number>;
  /** Restrict to one field (house numbers only match house numbers). */
  only?: Field;
}

function lowerBound(sorted: readonly string[], value: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function recordTokenFields(record: SearchRecord): Map<string, Field> {
  const tokens = new Map<string, Field>();
  const add = (text: string | undefined, field: Field): void => {
    if (text === undefined || text === "") return;
    for (const token of field === FIELD.NUMBER ? tokenizeSearchText(text) : searchTokens(text)) {
      const previous = tokens.get(token);
      if (previous === undefined || FIELD_WEIGHT[field]! > FIELD_WEIGHT[previous]!) tokens.set(token, field);
    }
  };
  if (record.kind === "address" && record.street !== undefined) {
    add(record.street, FIELD.NAME);
    if (record.housenumber !== undefined) add(canonicalHouseNumber(record.housenumber), FIELD.NUMBER);
  } else {
    add(record.canonicalName, FIELD.NAME);
  }
  for (const alias of record.aliases) add(alias, FIELD.ALIAS);
  if (record.brand !== undefined) add(record.brand, FIELD.ALIAS);
  if (record.kind !== "address") add(record.street, FIELD.STREET);
  add(record.commune, FIELD.COMMUNE);
  add(record.postcode, FIELD.CODE);
  if (record.ref !== undefined) for (const ref of record.ref.split(/[;,]/)) add(ref, FIELD.CODE);
  const definition = record.category === undefined ? undefined : CATEGORY_BY_ID.get(record.category);
  if (definition !== undefined && definition.id !== "other") {
    for (const term of definition.terms) add(term, FIELD.CATEGORY);
    add(definition.label, FIELD.CATEGORY);
  }
  return tokens;
}

export class SearchEngine {
  readonly records: readonly SearchRecord[];
  private readonly vocabulary: string[];
  private readonly vocabularyId: Map<string, number>;
  private readonly byLength: Map<number, number[]>;
  private readonly postingStart: Uint32Array;
  private readonly postings: Uint32Array;
  private readonly tokenStart: Uint32Array;
  private readonly tokenIds: Uint32Array;
  private readonly tokenFields: Uint8Array;
  private readonly nameTokenCount: Uint16Array;
  private readonly nameKey: string[];
  private readonly anchorX: Float64Array;
  private readonly anchorZ: Float64Array;
  private readonly byCategory: Map<string, number[]>;
  private readonly seen: Uint32Array;
  private generation = 0;

  constructor(records: readonly SearchRecord[]) {
    this.records = records;
    const perRecord = records.map(recordTokenFields);
    const vocabularySet = new Set<string>();
    for (const tokens of perRecord) for (const token of tokens.keys()) vocabularySet.add(token);
    this.vocabulary = [...vocabularySet].sort();
    this.vocabularyId = new Map(this.vocabulary.map((token, index) => [token, index]));
    this.byLength = new Map();
    for (let index = 0; index < this.vocabulary.length; index += 1) {
      const length = this.vocabulary[index]!.length;
      const bucket = this.byLength.get(length);
      if (bucket === undefined) this.byLength.set(length, [index]);
      else bucket.push(index);
    }

    let total = 0;
    for (const tokens of perRecord) total += tokens.size;
    this.tokenStart = new Uint32Array(records.length + 1);
    this.tokenIds = new Uint32Array(total);
    this.tokenFields = new Uint8Array(total);
    this.nameTokenCount = new Uint16Array(records.length);
    const postingCount = new Uint32Array(this.vocabulary.length + 1);
    let cursor = 0;
    for (let record = 0; record < records.length; record += 1) {
      this.tokenStart[record] = cursor;
      let names = 0;
      for (const [token, field] of perRecord[record]!) {
        const id = this.vocabularyId.get(token)!;
        this.tokenIds[cursor] = id;
        this.tokenFields[cursor] = field;
        postingCount[id + 1]! += 1;
        if (field === FIELD.NAME) names += 1;
        cursor += 1;
      }
      this.nameTokenCount[record] = names;
    }
    this.tokenStart[records.length] = cursor;
    for (let index = 1; index < postingCount.length; index += 1) postingCount[index]! += postingCount[index - 1]!;
    this.postingStart = postingCount.slice();
    this.postings = new Uint32Array(total);
    const fill = postingCount.slice();
    for (let record = 0; record < records.length; record += 1) {
      for (let at = this.tokenStart[record]!; at < this.tokenStart[record + 1]!; at += 1) {
        const id = this.tokenIds[at]!;
        this.postings[fill[id]!] = record;
        fill[id]! += 1;
      }
    }

    this.nameKey = records.map((record) => searchTokens(record.kind === "address" && record.street !== undefined ? record.street : record.canonicalName).join(" "));
    this.anchorX = new Float64Array(records.length);
    this.anchorZ = new Float64Array(records.length);
    this.byCategory = new Map();
    records.forEach((record, index) => {
      let anchor: LocalPoint;
      if (record.x !== undefined && record.z !== undefined) anchor = [record.x, record.z];
      else {
        try {
          anchor = wgs84ToRender([record.focusLon, record.focusLat]);
        } catch {
          anchor = [Number.NaN, Number.NaN];
        }
      }
      this.anchorX[index] = anchor[0];
      this.anchorZ[index] = anchor[1];
      if (record.category !== undefined && CATEGORY_BY_ID.has(record.category)) {
        const bucket = this.byCategory.get(record.category);
        if (bucket === undefined) this.byCategory.set(record.category, [index]);
        else bucket.push(index);
      }
    });
    this.seen = new Uint32Array(records.length);
  }

  get vocabularySize(): number {
    return this.vocabulary.length;
  }

  /* -------------------------------------------------------------- */
  /*  Token expansion                                                */
  /* -------------------------------------------------------------- */

  private expandToken(token: string, last: boolean): Map<number, number> {
    const matches = new Map<number, number>();
    const put = (id: number | undefined, quality: number): void => {
      if (id === undefined) return;
      if (quality > (matches.get(id) ?? 0)) matches.set(id, quality);
    };
    put(this.vocabularyId.get(token), 1);
    for (const variant of tokenVariants(token)) put(this.vocabularyId.get(variant), 0.93);
    const numeric = /^\d+$/.test(token);
    if ((last && (!numeric || token.length >= 3)) || (!numeric && token.length >= 3)) {
      let count = 0;
      for (let id = lowerBound(this.vocabulary, token); id < this.vocabulary.length && count < PREFIX_EXPANSION_LIMIT; id += 1) {
        const word = this.vocabulary[id]!;
        if (!word.startsWith(token)) break;
        count += 1;
        if (word === token) continue;
        const ratio = token.length / word.length;
        put(id, last ? 0.68 + 0.22 * ratio : 0.5 + 0.2 * ratio);
      }
    }
    const edits = numeric ? 0 : allowedEdits(token.length);
    if (edits > 0) {
      for (let length = token.length - edits; length <= token.length + edits; length += 1) {
        for (const id of this.byLength.get(length) ?? []) {
          const word = this.vocabulary[id]!;
          if (word[0] !== token[0] && !(word[0] === token[1] && word[1] === token[0])) continue;
          const distance = levenshteinBounded(token, word, edits);
          if (distance > 0 && distance <= edits) put(id, distance === 1 ? 0.62 : 0.45);
        }
      }
      /* A typo inside a word still being typed: "boulangeir" → "boulangerie". */
      if (last && token.length >= 5) {
        for (const [length, ids] of this.byLength) {
          if (length <= token.length) continue;
          for (const id of ids) {
            const word = this.vocabulary[id]!;
            if (word[0] !== token[0]) continue;
            if (levenshteinBounded(token, word.slice(0, token.length), 1) === 1) put(id, 0.5);
          }
        }
      }
    }
    return matches;
  }

  private postingSize(matches: Map<number, number>): number {
    let size = 0;
    for (const id of matches.keys()) size += this.postingStart[id + 1]! - this.postingStart[id]!;
    return size;
  }

  /* -------------------------------------------------------------- */
  /*  Matching                                                       */
  /* -------------------------------------------------------------- */

  private distanceKm(record: number, near: LocalPoint | undefined): number {
    if (near === undefined) return Number.NaN;
    const dx = this.anchorX[record]! - near[0];
    const dz = this.anchorZ[record]! - near[1];
    return Math.hypot(dx, dz) / 1000;
  }

  private match(queries: TokenQuery[], folded: string, rawQuery: string, near: LocalPoint | undefined, allowedMisses: number): Candidate[] {
    if (queries.length === 0) return [];
    let seed = -1;
    let seedSize = Number.POSITIVE_INFINITY;
    queries.forEach((query, index) => {
      if (query.matches.size === 0) return;
      const size = this.postingSize(query.matches);
      if (size < seedSize) {
        seed = index;
        seedSize = size;
      }
    });
    if (seed < 0) return [];
    const empty = queries.filter((query) => query.matches.size === 0).length;
    if (empty > allowedMisses) return [];

    this.generation += 1;
    const stamp = this.generation;
    const results: Candidate[] = [];
    const matchedNames = new Set<number>();
    for (const id of queries[seed]!.matches.keys()) {
      for (let at = this.postingStart[id]!; at < this.postingStart[id + 1]!; at += 1) {
        const record = this.postings[at]!;
        if (this.seen[record] === stamp) continue;
        this.seen[record] = stamp;
        const start = this.tokenStart[record]!;
        const end = this.tokenStart[record + 1]!;
        let sum = 0;
        let misses = 0;
        let approximate = false;
        let partial = false;
        let usesContext = false;
        let named = true;
        matchedNames.clear();
        for (const query of queries) {
          let best = 0;
          let bestToken = -1;
          let bestField: number = FIELD.NAME;
          let bestQuality = 0;
          for (let cursor = start; cursor < end; cursor += 1) {
            const field = this.tokenFields[cursor]!;
            if (query.only !== undefined && field !== query.only) continue;
            const quality = query.matches.get(this.tokenIds[cursor]!);
            if (quality === undefined) continue;
            const weighted = quality * FIELD_WEIGHT[field]!;
            if (weighted > best) {
              best = weighted;
              bestToken = this.tokenIds[cursor]!;
              bestField = field;
              bestQuality = quality;
            }
          }
          if (best === 0) {
            misses += 1;
            if (misses > allowedMisses) break;
            continue;
          }
          sum += best;
          if (bestField === FIELD.NAME) matchedNames.add(bestToken);
          else usesContext = true;
          if (bestField !== FIELD.NAME && bestField !== FIELD.ALIAS) named = false;
          if (bestQuality < 0.66) approximate = true;
          else if (bestQuality < 0.93) partial = true;
        }
        if (misses > allowedMisses) continue;
        const text = sum / queries.length;
        const names = this.nameTokenCount[record]!;
        const coverage = names === 0 ? 0 : Math.min(1, matchedNames.size / names);
        const exact = folded !== "" && this.nameKey[record] === folded;
        const distance = this.distanceKm(record, near);
        const proximity = Number.isFinite(distance) ? PROXIMITY_BONUS * Math.exp(-distance / PROXIMITY_SCALE_KM) : 0;
        const recordData = this.records[record]!;
        const score = 1000 * text + 300 * coverage + (exact ? 220 : 0) + recordData.boost + proximity - misses * MISS_PENALTY;
        let matchType: SearchHit["matchType"];
        if (exact && !approximate && !partial) matchType = recordData.canonicalName === rawQuery.trim() ? "exact" : "accent-insensitive";
        else if (approximate) matchType = "edit-distance";
        else if (partial) matchType = "prefix";
        else matchType = usesContext || coverage < 1 ? "contains" : "accent-insensitive";
        results.push({ record, score, matchType, named: named && misses === 0, exact });
      }
    }
    return results;
  }

  private tokenQueries(tokens: readonly string[], houseNumber: string | undefined): TokenQuery[] {
    const queries: TokenQuery[] = tokens.map((token, index) => ({ matches: this.expandToken(token, index === tokens.length - 1) }));
    if (houseNumber !== undefined) {
      for (const part of tokenizeSearchText(houseNumber)) {
        const matches = new Map<number, number>();
        const id = this.vocabularyId.get(part);
        if (id !== undefined) matches.set(id, 1);
        queries.push({ matches, only: FIELD.NUMBER });
      }
    }
    return queries;
  }

  /* -------------------------------------------------------------- */
  /*  Public queries                                                 */
  /* -------------------------------------------------------------- */

  search(query: string, options: TextSearchOptions): SearchHit[] {
    const parsed = parseSearchQuery(query);
    if (parsed.tokens.length === 0) return [];
    const near = options.near;
    const limit = Math.max(1, options.limit);

    let candidates: Candidate[] = [];
    if (parsed.houseNumber !== undefined) {
      candidates = this.match(this.tokenQueries(parsed.tokens, parsed.houseNumber), parsed.folded, query, near, 0);
      /* Number not in the address base: fall back to the street itself. */
      if (candidates.length === 0) {
        const withoutNumber = parseSearchQuery(parsed.words.slice(parsed.houseNumber.split(" ").length).join(" "));
        candidates = this.match(this.tokenQueries(withoutNumber.tokens, undefined), withoutNumber.folded, query, near, 0);
      }
    } else {
      candidates = this.match(this.tokenQueries(parsed.tokens, undefined), parsed.folded, query, near, 0);
    }

    const browse = parsed.houseNumber === undefined ? this.categoryBrowse(parsed.words) : null;
    if (browse !== null) candidates = this.mergeCategory(candidates, browse, near);

    /* Nothing matched every word: allow one word to miss (an extra word, a wrong commune). */
    if (candidates.length === 0 && parsed.tokens.length >= 2 && browse === null) {
      candidates = this.match(this.tokenQueries(parsed.tokens, parsed.houseNumber), parsed.folded, query, near, 1);
    }

    /* "12 rue …" means number 12 itself before 12 bis or 12 ter. */
    if (parsed.houseNumber !== undefined) {
      for (const candidate of candidates) {
        const number = this.records[candidate.record]!.housenumber;
        if (number !== undefined && canonicalHouseNumber(number) === parsed.houseNumber) candidate.score += 80;
      }
    }

    return this.finish(candidates, limit);
  }

  /** Categories a query names and nothing else ("pharmacies", "gare", "boulangerie"). */
  private categoryBrowse(words: readonly string[]): Set<string> | null {
    const meaningful = words.map((word, index) => ({ word, index })).filter(({ word }) => !isStopWord(word));
    if (meaningful.length === 0) return null;
    const intents = categoryIntents(words);
    if (intents.length === 0) return null;
    const consumed = new Set(intents.flatMap((intent) => intent.consumed));
    if (!meaningful.every(({ index }) => consumed.has(index))) return null;
    const categories = new Set<string>();
    for (const intent of intents) for (const id of categoryFamily(intent.category)) categories.add(id);
    return categories.size === 0 ? null : categories;
  }

  /**
   * A category browse lists that category nearest-first. Places whose whole
   * name is the query (a commune called "Bars" for "bars") keep the head of
   * the list. When the words are specific within the category — a brand such
   * as "leclerc" rather than the generic "pharmacie" most pharmacies carry —
   * the places named that way come first.
   */
  private mergeCategory(textual: Candidate[], categories: Set<string>, near: LocalPoint | undefined): Candidate[] {
    const merged = new Map<number, Candidate>();
    const named = new Set<number>();
    for (const candidate of textual) {
      if (candidate.named !== true) continue;
      named.add(candidate.record);
      const record = this.records[candidate.record]!;
      if (candidate.exact === true && (record.category === undefined || !categories.has(record.category))) {
        merged.set(candidate.record, { ...candidate, score: 4000 + record.boost });
      }
    }
    let total = 0;
    let namedInCategory = 0;
    for (const category of categories) {
      for (const record of this.byCategory.get(category) ?? []) {
        total += 1;
        if (named.has(record)) namedInCategory += 1;
      }
    }
    const specific = total > 0 && namedInCategory / total < BRAND_SHARE;
    for (const category of categories) {
      for (const record of this.byCategory.get(category) ?? []) {
        if (merged.has(record)) continue;
        const distance = this.distanceKm(record, near);
        const data = this.records[record]!;
        const score = 2000 + (specific && named.has(record) ? 1500 : 0) + data.boost * 0.2 - (Number.isFinite(distance) ? distance * 12 : 0);
        merged.set(record, { record, score, matchType: "category" });
      }
    }
    return [...merged.values()];
  }

  /** Places of one category (and its family) around a point, nearest first. */
  browseCategory(options: CategorySearchOptions): SearchHit[] {
    const categories = categoryFamily(options.category);
    const found: Array<{ record: number; distance: number }> = [];
    for (const category of categories) {
      for (const record of this.byCategory.get(category) ?? []) {
        const distance = this.distanceKm(record, options.near) * 1000;
        if (Number.isFinite(distance)) found.push({ record, distance });
      }
    }
    found.sort((first, second) => first.distance - second.distance || this.records[first.record]!.canonicalName.localeCompare(this.records[second.record]!.canonicalName));
    let chosen = found.filter((entry) => entry.distance <= options.radius);
    if (chosen.length < 3) chosen = found.filter((entry) => entry.distance <= Math.max(options.radius * 4, 30_000)).slice(0, Math.min(options.limit, 12));
    return this.finish(chosen.map((entry) => ({ record: entry.record, score: Math.round(10_000 - entry.distance / 10), matchType: "category" as const })), options.limit, false);
  }

  private finish(candidates: Candidate[], limit: number, sort = true): SearchHit[] {
    if (sort) {
      candidates.sort((first, second) => second.score - first.score
        || this.records[first.record]!.canonicalName.localeCompare(this.records[second.record]!.canonicalName)
        || this.records[first.record]!.featureId.localeCompare(this.records[second.record]!.featureId));
    }
    const hits: SearchHit[] = [];
    const kept: number[] = [];
    for (const candidate of candidates) {
      if (hits.length >= limit) break;
      const record = this.records[candidate.record]!;
      const key = foldSearchText(record.canonicalName);
      const duplicate = kept.some((other) => {
        const otherRecord = this.records[other]!;
        if (otherRecord.featureId === record.featureId) return true;
        if (foldSearchText(otherRecord.canonicalName) !== key) return false;
        return Math.hypot(this.anchorX[other]! - this.anchorX[candidate.record]!, this.anchorZ[other]! - this.anchorZ[candidate.record]!) < DUPLICATE_RADIUS_METRES;
      });
      if (duplicate) continue;
      kept.push(candidate.record);
      hits.push(toSearchHit(record, Math.round(candidate.score * 10) / 10, candidate.matchType, this.anchorX[candidate.record]!, this.anchorZ[candidate.record]!));
    }
    return hits;
  }
}

function toSearchHit(record: SearchRecord, score: number, matchType: SearchHit["matchType"], x: number, z: number): SearchHit {
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
  if (record.context !== undefined) hit.context = record.context;
  if (Number.isFinite(x) && Number.isFinite(z)) {
    hit.x = Math.round(x * 100) / 100;
    hit.z = Math.round(z * 100) / 100;
  }
  if (record.bbox !== undefined) hit.bbox = record.bbox;
  return hit;
}
