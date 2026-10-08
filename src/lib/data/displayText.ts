const LOWERCASE_PARTICLES = new Set(["de", "du", "des", "la", "le", "les", "et", "sur", "en", "aux", "au", "sous", "à", "a", "d", "l", "lès", "les"]);

/**
 * French title case for names that arrive in a single case ("CHEMIN DE LA
 * RIVIERE", "chemin du bigourdan"). Names already mixing cases are trusted
 * as written.
 */
export function displayCase(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const hasLower = /[a-zß-ÿ]/.test(trimmed);
  const hasUpper = /[A-ZÀ-Þ]/.test(trimmed);
  if (hasLower && hasUpper) return trimmed;
  if (!hasLower && !hasUpper) return trimmed;
  return trimmed.toLowerCase().split(" ").map((word, index) => {
    const capitalised = word.replace(/(^|[-'’])(\p{L})/gu, (_, separator: string, letter: string) => `${separator}${letter.toUpperCase()}`);
    if (index === 0) return capitalised;
    if (LOWERCASE_PARTICLES.has(word)) return word;
    /* Elisions stay lowercase inside a name: "de l'Église", "Chemin d'Auch". */
    return capitalised.replace(/^(L|D)(['’])/u, (_, letter: string, quote: string) => `${letter.toLowerCase()}${quote}`);
  }).join(" ");
}

/**
 * Trim what a source's field limit or export left on a label: a parenthesis
 * cut off mid-way ("Clinique Vétérinaire (place du") and dangling separators
 * ("Adapei du Gers - Ludothèque /"). Complete parentheticals stay.
 */
export function tidyLabel(value: string): string {
  const tidied = value
    .replace(/\s*\([^)]*$/, "")
    .replace(/^[\s\-–—,;:/_]+|[\s\-–—,;:/_]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return tidied === "" ? value.trim() : tidied;
}

/** Street types the address registers abbreviate, spelled out as on a street sign. */
const STREET_TYPES: Readonly<Record<string, string>> = {
  r: "Rue", rue: "Rue", av: "Avenue", ave: "Avenue", bd: "Boulevard", bld: "Boulevard", che: "Chemin", chem: "Chemin", ch: "Chemin",
  rte: "Route", pl: "Place", imp: "Impasse", all: "Allée", sq: "Square", prom: "Promenade", rpt: "Rond-Point", res: "Résidence",
  lot: "Lotissement", crs: "Cours", fg: "Faubourg", fbg: "Faubourg", qu: "Quai", pkg: "Parking", ham: "Hameau", sen: "Sentier",
  rle: "Ruelle", rlle: "Ruelle", tra: "Traverse", pass: "Passage", esp: "Esplanade", cr: "Chemin rural", vc: "Voie communale",
};

const COMPOUND_PARTICLES = new Set(["de", "du", "des", "d", "la", "le", "les", "l", "sur", "sous", "en", "et", "lès", "lez", "ès", "à", "aux", "au", "dit"]);

/** Each part of a compound proper name capitalised: "Sadi-carnot" → "Sadi-Carnot"; "Saint-Jean-de-Luz" is unchanged. */
export function capitaliseCompounds(value: string): string {
  return value.replace(/([\p{Lu}][\p{Ll}'’]*)-(\p{Ll}+)/gu, (match, before: string, after: string) => (
    COMPOUND_PARTICLES.has(after) ? match : `${before}-${after[0]!.toUpperCase()}${after.slice(1)}`
  ));
}

/** A street name as signposted: the abbreviated type spelled out ("Che du Moulin" → "Chemin du Moulin") and its compounds capitalised. */
export function displayStreetName(value: string): string {
  const words = displayCase(value).split(" ");
  const type = STREET_TYPES[words[0]!.replace(/\.$/, "").toLowerCase()];
  if (type !== undefined && words.length > 1) words[0] = type;
  return capitaliseCompounds(words.join(" "));
}
