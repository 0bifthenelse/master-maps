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
