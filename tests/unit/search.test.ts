import { describe, expect, it } from "vitest";
import { editDistanceScore, levenshteinBounded, MAX_EDIT_DISTANCE, normalizeSearchText, scoreTerm, tokenizeSearchText } from "@/lib/data/search";

describe("normalizeSearchText", () => {
  it("removes accents from Nocibé", () => {
    expect(normalizeSearchText("Nocibé")).toBe("nocibe");
  });

  it("lowercases AUCH", () => {
    expect(normalizeSearchText("AUCH")).toBe("auch");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSearchText("  Rue Pasteur  ")).toBe("rue pasteur");
  });
});

describe("tokenizeSearchText", () => {
  it("splits on punctuation and whitespace", () => {
    expect(tokenizeSearchText("Boulevard Sadi-Carnot, Auch")).toEqual(["boulevard", "sadi", "carnot", "auch"]);
  });
});

describe("scoreTerm", () => {
  it("ranks exact above accent-insensitive above prefix above contains", () => {
    const term = "Cathédrale Sainte-Marie";
    const normalizedTerm = "cathedrale sainte-marie";
    const exact = scoreTerm("Cathédrale Sainte-Marie", "cathedrale sainte-marie", term, normalizedTerm);
    const accent = scoreTerm("Cathedrale Sainte-Marie", "cathedrale sainte-marie", term, normalizedTerm);
    const prefix = scoreTerm("cathedrale", "cathedrale", term, normalizedTerm);
    const contains = scoreTerm("marie", "marie", term, normalizedTerm);
    expect(exact).toEqual({ score: 1000, matchType: "exact" });
    expect(accent).toEqual({ score: 900, matchType: "accent-insensitive" });
    expect(prefix).toEqual({ score: 500, matchType: "prefix" });
    expect(contains).toEqual({ score: 300, matchType: "contains" });
    expect(exact && accent && prefix && contains).toBeTruthy();
    expect(exact!.score).toBeGreaterThan(accent!.score);
    expect(accent!.score).toBeGreaterThan(prefix!.score);
    expect(prefix!.score).toBeGreaterThan(contains!.score);
  });

  it("returns null when no tier matches", () => {
    expect(scoreTerm("nocire", "nocire", "Rue Pasteur", "rue pasteur")).toBeNull();
  });
});

describe("editDistanceScore", () => {
  it("keeps the fixed tier ladder", () => {
    expect(MAX_EDIT_DISTANCE).toBe(2);
    expect(editDistanceScore(0)).toBe(130);
    expect(editDistanceScore(1)).toBe(120);
    expect(editDistanceScore(MAX_EDIT_DISTANCE)).toBe(110);
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
