import { describe, expect, it } from "vitest";
import {
  allowedEdits,
  canonicalHouseNumber,
  levenshteinBounded,
  normalizeSearchText,
  parseSearchQuery,
  searchTokens,
  tokenizeSearchText,
  tokenVariants,
} from "@/lib/data/search";

describe("normalizeSearchText", () => {
  it("removes accents, lowercases and trims", () => {
    expect(normalizeSearchText("  Nocibé AUCH ")).toBe("nocibe auch");
  });

  it("folds ligatures and curly apostrophes", () => {
    expect(normalizeSearchText("Cœur d’Armagnac")).toBe("coeur d'armagnac");
  });
});

describe("tokenizeSearchText", () => {
  it("splits on punctuation, hyphens and apostrophes", () => {
    expect(tokenizeSearchText("Boulevard Sadi-Carnot, Auch")).toEqual(["boulevard", "sadi", "carnot", "auch"]);
    expect(tokenizeSearchText("Rue d'Alsace")).toEqual(["rue", "d", "alsace"]);
  });
});

describe("searchTokens", () => {
  it("treats hyphenated and spaced names alike", () => {
    expect(searchTokens("Saint-Jean-Poutge")).toEqual(searchTokens("saint jean poutge"));
  });

  it("expands the abbreviations people type and sources use", () => {
    expect(searchTokens("St Clar")).toEqual(["saint", "clar"]);
    expect(searchTokens("av de la Marne")).toEqual(["avenue", "marne"]);
    expect(searchTokens("bd Sadi Carnot")).toEqual(["boulevard", "sadi", "carnot"]);
  });

  it("joins road numbers whatever the spacing", () => {
    expect(searchTokens("D 930")).toEqual(["d930"]);
    expect(searchTokens("RN124")).toEqual(["n124"]);
    expect(searchTokens("N124")).toEqual(["n124"]);
  });

  it("drops stop words unless nothing else is left", () => {
    expect(searchTokens("Place de la Libération")).toEqual(["place", "liberation"]);
    expect(searchTokens("Le")).toEqual(["le"]);
  });
});

describe("parseSearchQuery", () => {
  it("reads a leading house number", () => {
    const parsed = parseSearchQuery("12 rue Gambetta Auch");
    expect(parsed.houseNumber).toBe("12");
    expect(parsed.tokens).toEqual(["rue", "gambetta", "auch"]);
  });

  it("keeps bis/ter suffixes, spaced or glued", () => {
    expect(parseSearchQuery("12 bis rue Gambetta").houseNumber).toBe("12 bis");
    expect(parseSearchQuery("12bis rue Gambetta").houseNumber).toBe("12 bis");
  });

  it("does not mistake a postcode or a lone number for a house number", () => {
    expect(parseSearchQuery("32000 Auch").houseNumber).toBeUndefined();
    expect(parseSearchQuery("124").houseNumber).toBeUndefined();
  });
});

describe("canonicalHouseNumber", () => {
  it("normalises glued suffixes", () => {
    expect(canonicalHouseNumber("12B")).toBe("12 b");
    expect(canonicalHouseNumber("3 bis")).toBe("3 bis");
  });
});

describe("tokenVariants", () => {
  it("offers singular and plural forms", () => {
    expect(tokenVariants("pharmacies")).toContain("pharmacie");
    expect(tokenVariants("restaurant")).toContain("restaurants");
    expect(tokenVariants("chateaux")).toContain("chateau");
  });

  it("leaves numbers alone", () => {
    expect(tokenVariants("32000")).toEqual([]);
  });
});

describe("levenshteinBounded", () => {
  it("measures the true distance within the bound", () => {
    expect(levenshteinBounded("nocire", "nocibe", 2)).toBe(1);
    expect(levenshteinBounded("nocirx", "nocibe", 2)).toBe(2);
  });

  it("returns maxDistance + 1 past the bound", () => {
    expect(levenshteinBounded("kartoffel", "nocibe", 2)).toBe(3);
    expect(levenshteinBounded("abc", "nocibe", 2)).toBe(3);
  });
});

describe("allowedEdits", () => {
  it("scales typo tolerance with word length", () => {
    expect(allowedEdits(3)).toBe(0);
    expect(allowedEdits(5)).toBe(1);
    expect(allowedEdits(9)).toBe(2);
  });
});
