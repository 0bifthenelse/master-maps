import { describe, expect, it } from "vitest";
import { SearchEngine } from "@/lib/data/searchEngine";
import { SearchHitSchema } from "@/lib/data/searchTypes";
import { AUCH, CONDOM, FIXTURE_RECORDS } from "./search-fixture";

const engine = new SearchEngine(FIXTURE_RECORDS);
const top = (query: string, near?: [number, number]): string | undefined => engine.search(query, { limit: 10, ...(near === undefined ? {} : { near }) })[0]?.featureId;
const ids = (query: string, near?: [number, number]): string[] => engine.search(query, { limit: 10, ...(near === undefined ? {} : { near }) }).map((hit) => hit.featureId);

describe("SearchEngine: places", () => {
  it("puts the commune first for its own name", () => {
    expect(top("auch")).toBe("commune-auch");
    expect(top("Condom")).toBe("commune-condom");
  });

  it("matches saint/st and hyphenated or spaced spellings alike", () => {
    expect(top("saint clar")).toBe("commune-saint-clar");
    expect(top("st-clar")).toBe("commune-saint-clar");
    expect(top("Saint-Clar")).toBe("commune-saint-clar");
  });

  it("keeps a commune whose name is also a category word at the top", () => {
    expect(top("bars")).toBe("commune-bars");
  });
});

describe("SearchEngine: streets and addresses", () => {
  it("prefers the street nearest the view when the commune is not given", () => {
    expect(top("rue gambetta", AUCH)).toBe("street-gambetta-auch");
    expect(top("rue gambetta", CONDOM)).toBe("street-gambetta-condom");
  });

  it("uses a commune in the query over proximity", () => {
    expect(top("rue gambetta condom", AUCH)).toBe("street-gambetta-condom");
  });

  it("finds a numbered address, with or without the commune", () => {
    expect(top("12 rue gambetta auch")).toBe("address-12");
    expect(top("12 rue gambetta", AUCH)).toBe("address-12");
  });

  it("distinguishes bis/ter numbers", () => {
    expect(top("12 bis rue gambetta")).toBe("address-12-bis");
    expect(top("12bis rue gambetta")).toBe("address-12-bis");
  });

  it("falls back to the street when the number does not exist", () => {
    expect(top("999 rue gambetta auch")).toBe("street-gambetta-auch");
  });

  it("finds roads by number in any spelling", () => {
    expect(top("N124")).toBe("route-n124");
    expect(top("n 124")).toBe("route-n124");
    expect(top("rn124")).toBe("route-n124");
  });

  it("finds a street by its road number and commune", () => {
    expect(ids("n124 auch")).toContain("street-marne");
  });
});

describe("SearchEngine: businesses and categories", () => {
  it("combines a category word with a commune", () => {
    const hits = ids("pharmacie auch");
    expect(hits[0]).toBe("pharmacie-centre");
    expect(hits).not.toContain("pharmacie-gare-condom");
  });

  it("lists a bare category nearest first, in French or English, singular or plural", () => {
    expect(top("pharmacy", CONDOM)).toBe("pharmacie-gare-condom");
    expect(top("pharmacie", AUCH)).toBe("pharmacie-centre");
    expect(top("pharmacies", CONDOM)).toBe("pharmacie-gare-condom");
    expect(engine.search("pharmacy", { limit: 5, near: AUCH })[0]?.matchType).toBe("category");
  });

  it("favours the named kind of place in a longer query", () => {
    expect(top("hopital auch")).toBe("ch-auch");
  });

  it("lists stations for 'gare', not hamlets that happen to be called la Gare", () => {
    expect(top("gare", CONDOM)).toBe("gare-auch");
  });

  it("puts a brand ahead of its category", () => {
    expect(top("leclerc", CONDOM)).toBe("leclerc-auch");
  });

  it("finds a business by its street", () => {
    expect(top("boulangerie rue dessoles")).toBe("boulangerie-dupont");
  });

  it("completes a word still being typed", () => {
    expect(top("boulange", AUCH)).toBe("boulangerie-dupont");
    expect(top("cathed")).toBe("cathedrale-sainte-marie");
  });

  it("tolerates typos", () => {
    const [hit] = engine.search("nocire", { limit: 5 });
    expect(hit?.featureId).toBe("nocibe-auch");
    expect(hit?.matchType).toBe("edit-distance");
    expect(top("cathedrale saint marie")).toBe("cathedrale-sainte-marie");
  });

  it("searches aliases", () => {
    expect(top("prison eveche")).toBe("tour-armagnac");
  });
});

describe("SearchEngine: result shape", () => {
  it("never returns more results than the limit and is deterministic", () => {
    expect(engine.search("rue", { limit: 2 }).length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(engine.search("gambetta", { limit: 10, near: AUCH }))).toBe(JSON.stringify(engine.search("gambetta", { limit: 10, near: AUCH })));
  });

  it("returns hits with context, anchor and extent", () => {
    const [street] = engine.search("rue gambetta auch", { limit: 1 });
    expect(SearchHitSchema.parse(street)).toEqual(street);
    expect(street?.context).toBe("Auch");
    expect(street?.x).toBeCloseTo(100);
    expect(street?.bbox).toEqual([0, -5000, 250, -4900]);
  });

  it("returns nothing for an empty or stop-word-only query", () => {
    expect(engine.search("", { limit: 5 })).toEqual([]);
    expect(engine.search("   ", { limit: 5 })).toEqual([]);
  });
});

describe("SearchEngine.browseCategory", () => {
  it("lists a category family around a point, nearest first, within the radius", () => {
    const hits = engine.browseCategory({ category: "supermarket", near: AUCH, radius: 4000, limit: 20 });
    expect(hits.map((hit) => hit.featureId)).toEqual(["intermarche-auch", "leclerc-auch", "lidl-auch"]);
    expect(hits[0]?.matchType).toBe("category");
  });

  it("widens the search when the radius holds almost nothing", () => {
    const hits = engine.browseCategory({ category: "pharmacy", near: [CONDOM[0] + 20000, CONDOM[1]], radius: 1000, limit: 20 });
    expect(hits[0]?.featureId).toBe("pharmacie-gare-condom");
  });
});
