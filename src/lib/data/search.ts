/**
 * Text handling shared by the search index builder and the search server.
 * Both sides run names and queries through the same tokenizer, so accents,
 * hyphens, apostrophes, abbreviations ("St", "Av") and road numbers
 * ("D 930" / "D930") always meet in the same form.
 */

export const MAX_EDIT_DISTANCE = 2;

const PUNCTUATION_PATTERN = /[^a-z0-9&]+/g;

function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Lowercase, accent-free form of a whole string (spacing and hyphens kept). */
export function normalizeSearchText(value: string): string {
  return stripAccents(value).replace(/œ/gi, "oe").replace(/æ/gi, "ae").toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

/** Folded form used to compare whole names: punctuation becomes single spaces. */
export function foldSearchText(value: string): string {
  return normalizeSearchText(value).replace(PUNCTUATION_PATTERN, " ").trim();
}

/** Raw folded words, no abbreviation expansion or stop-word removal. */
export function tokenizeSearchText(value: string): string[] {
  const folded = foldSearchText(value);
  return folded === "" ? [] : folded.split(" ");
}

/** Abbreviations found in French street and place names and in what people type. */
const ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = {
  st: ["saint"],
  ste: ["sainte"],
  sts: ["saints"],
  stes: ["saintes"],
  av: ["avenue"],
  ave: ["avenue"],
  bd: ["boulevard"],
  bld: ["boulevard"],
  bvd: ["boulevard"],
  boul: ["boulevard"],
  che: ["chemin"],
  chem: ["chemin"],
  rte: ["route"],
  pl: ["place"],
  imp: ["impasse"],
  all: ["allee"],
  res: ["residence"],
  resid: ["residence"],
  fbg: ["faubourg"],
  sq: ["square"],
  crs: ["cours"],
  prom: ["promenade"],
  esp: ["esplanade"],
  gd: ["grand"],
  gde: ["grande"],
  mt: ["mont"],
  nd: ["notre", "dame"],
  ctre: ["centre"],
  za: ["zone", "artisanale"],
  zi: ["zone", "industrielle"],
  zac: ["zone", "activite"],
  ld: ["lieu", "dit"],
  rpt: ["rond", "point"],
  hlm: ["hlm"],
};

/** Words that carry no meaning on their own in French or English place names. */
const STOP_WORDS = new Set([
  "de", "du", "des", "la", "le", "les", "l", "d", "a", "au", "aux", "et", "en", "sur", "sous", "un", "une",
  "the", "of", "in", "near", "at", "and", "on",
]);

/** Road numbering prefixes: national, departmental, motorway, communal, European. */
const ROAD_PREFIXES = new Set(["n", "d", "a", "rn", "rd", "c", "vc", "cr", "e"]);

const HOUSE_SUFFIXES = new Set(["bis", "ter", "quater", "quinquies", "a", "b", "c", "d", "e", "f"]);

export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token);
}

/**
 * Index and query tokens: folded words with abbreviations expanded, road
 * numbers joined ("d 930" → "d930") and stop words removed (unless nothing
 * else is left).
 */
export function searchTokens(value: string): string[] {
  const raw = tokenizeSearchText(value);
  const joined: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index]!;
    const next = raw[index + 1];
    if (ROAD_PREFIXES.has(token) && next !== undefined && /^\d{1,4}[a-z]?$/.test(next)) {
      joined.push(`${token === "rn" ? "n" : token === "rd" ? "d" : token}${next}`);
      index += 1;
      continue;
    }
    const roadRef = /^(rn|rd)(\d{1,4}[a-z]?)$/.exec(token);
    if (roadRef !== null) {
      joined.push(`${roadRef[1] === "rn" ? "n" : "d"}${roadRef[2]}`);
      continue;
    }
    const expansion = ABBREVIATIONS[token];
    if (expansion !== undefined) joined.push(...expansion);
    else joined.push(token);
  }
  const meaningful = joined.filter((token) => !STOP_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : joined;
}

/** "12", "12 bis", "12b" → canonical house number "12 bis" / "12 b". */
export function canonicalHouseNumber(value: string): string {
  const tokens = tokenizeSearchText(value.replace(/^(\d+)([a-z]+)$/i, "$1 $2"));
  return tokens.join(" ");
}

export interface ParsedQuery {
  /** Folded words of the whole query, before stop-word removal (category phrases need them). */
  words: string[];
  /** Search tokens excluding the house number. */
  tokens: string[];
  /** Canonical house number when the query starts with one ("12 bis rue …"). */
  houseNumber?: string;
  /** Folded query without the house number, for whole-name comparison. */
  folded: string;
}

export function parseSearchQuery(query: string): ParsedQuery {
  const words = tokenizeSearchText(query.replace(/^\s*(\d{1,4})(bis|ter|quater|[a-f])\b/i, "$1 $2"));
  let houseNumber: string | undefined;
  let rest = words;
  const first = words[0];
  if (first !== undefined && /^\d{1,4}$/.test(first) && words.length > 1) {
    const second = words[1]!;
    if (HOUSE_SUFFIXES.has(second) && words.length > 2) {
      houseNumber = `${first} ${second}`;
      rest = words.slice(2);
    } else if (!/^\d/.test(second)) {
      houseNumber = first;
      rest = words.slice(1);
    }
  }
  const restText = rest.join(" ");
  return { words, tokens: searchTokens(restText), ...(houseNumber === undefined ? {} : { houseNumber }), folded: searchTokens(restText).join(" ") };
}

/** Singular/plural variants of a query token ("pharmacies" ↔ "pharmacie", "chateaux" ↔ "chateau"). */
export function tokenVariants(token: string): string[] {
  const variants = new Set<string>();
  if (token.length > 3 && /[sx]$/.test(token)) variants.add(token.slice(0, -1));
  if (token.length > 4 && token.endsWith("aux")) variants.add(`${token.slice(0, -3)}al`);
  if (token.length > 2 && !/[sx]$/.test(token) && !/^\d/.test(token)) variants.add(`${token}s`);
  variants.delete(token);
  return [...variants];
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

/** Edits tolerated for a query token of this length: none below 4 letters, two from 7. */
export function allowedEdits(length: number): number {
  if (length < 4) return 0;
  if (length < 7) return 1;
  return MAX_EDIT_DISTANCE;
}
