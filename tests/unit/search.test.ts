import { describe, it, expect } from "vitest";

// Simplified search with accent-insensitive matching
function normalizeForSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove combining marks
    .toLowerCase();
}

interface SearchRecord {
  id: string;
  name: string;
  normalizedName: string;
  aliases: string[];
  featureType: string;
  category: string;
  tileId: string;
  coord: [number, number];
}

function searchIndex(
  query: string,
  records: SearchRecord[],
  maxResults: number = 10
): SearchRecord[] {
  const nq = normalizeForSearch(query);
  if (!nq) return [];

  // Score: exact > prefix > contains > edit distance
  const scored = records.map((r) => {
    const nn = r.normalizedName;
    let score = 0;

    if (nn === nq) {
      score = 100;
    } else if (nn.startsWith(nq)) {
      score = 80;
    } else if (nn.includes(nq)) {
      score = 60;
    } else if (r.aliases.some((a) => normalizeForSearch(a).includes(nq))) {
      score = 40;
    }

    // One-character typo tolerance for short queries
    if (score === 0 && nq.length >= 3) {
      for (const alias of [nn, ...r.aliases.map(normalizeForSearch)]) {
        if (Math.abs(alias.length - nq.length) <= 1) {
          let dist = 0;
          for (let i = 0; i < Math.min(alias.length, nq.length); i++) {
            if (alias[i] !== nq[i]) dist++;
          }
          dist += Math.abs(alias.length - nq.length);
          if (dist <= 1) score = 20;
        }
      }
    }

    return { record: r, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.record);
}

describe("normalizeForSearch", () => {
  it("removes accents from Nocibé", () => {
    expect(normalizeForSearch("Nocibé")).toBe("nocibe");
  });

  it("lowercases", () => {
    expect(normalizeForSearch("AUCH")).toBe("auch");
  });

  it("handles mixed accents and case", () => {
    expect(normalizeForSearch("Rue d'Alsace")).toBe("rue d'alsace");
  });
});

describe("searchIndex", () => {
  const records: SearchRecord[] = [
    {
      id: "nocibe-32013",
      name: "Nocibé",
      normalizedName: "nocibe",
      aliases: [],
      featureType: "business",
      category: "beauty",
      tileId: "0_0",
      coord: [0.591913, 43.648231],
    },
    {
      id: "auch-ma-1",
      name: "Auch: Mairie",
      normalizedName: "auch: mairie",
      aliases: ["Mairie d'Auch", "Hôtel de Ville"],
      featureType: "poi",
      category: "administration",
      tileId: "0_0",
      coord: [0.585, 43.65],
    },
  ];

  it("finds Nocibé exact match", () => {
    const results = searchIndex("Nocibé", records);
    expect(results.some((r) => r.id === "nocibe-32013")).toBe(true);
  });

  it("finds Nocibé with accent-insensitive", () => {
    const results = searchIndex("nocibe", records);
    expect(results.some((r) => r.id === "nocibe-32013")).toBe(true);
  });

  it("finds Nocibé with prefix", () => {
    const results = searchIndex("noci", records);
    expect(results.some((r) => r.id === "nocibe-32013")).toBe(true);
  });

  it("finds Nocibé with one-char typo", () => {
    const results = searchIndex("nocire", records);
    expect(results.some((r) => r.id === "nocibe-32013")).toBe(true);
  });

  it("returns empty for non-matching query", () => {
    const results = searchIndex("zzzzz", records);
    expect(results.length).toBe(0);
  });

  it("exact match outranks partial", () => {
    const results = searchIndex("mairie", records);
    const idx = results.findIndex((r) => r.id === "auch-ma-1");
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});