import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { queryCategory, querySearchIndex, resetSearchIndexCache, SearchIndexError } from "@/lib/data/searchServer";
import { SearchHitSchema } from "@/lib/data/searchTypes";
import { AUCH, CONDOM, removeSearchFixture, writeSearchFixture } from "./search-fixture";

let dataRoot = "";
let previousDataDir: string | undefined;

beforeAll(async () => {
  dataRoot = await writeSearchFixture();
  previousDataDir = process.env.MASTER_MAPS_DATA_DIR;
  process.env.MASTER_MAPS_DATA_DIR = dataRoot;
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.MASTER_MAPS_DATA_DIR;
  else process.env.MASTER_MAPS_DATA_DIR = previousDataDir;
  await removeSearchFixture(dataRoot);
});

beforeEach(() => {
  resetSearchIndexCache();
});

describe("querySearchIndex", () => {
  it("returns no hits for an empty or one character query", async () => {
    expect((await querySearchIndex("", 10)).hits).toEqual([]);
    expect((await querySearchIndex("a", 10)).hits).toEqual([]);
  });

  it("finds the accented cathedral from an unaccented prefix", async () => {
    const { hits } = await querySearchIndex("cathedrale", 10);
    expect(hits[0]?.featureId).toBe("cathedrale-sainte-marie");
  });

  it("reports an exact match for the name as written", async () => {
    const { hits } = await querySearchIndex("Cathédrale Sainte-Marie", 10);
    expect(hits[0]?.matchType).toBe("exact");
    const { hits: folded } = await querySearchIndex("cathedrale sainte marie", 10);
    expect(folded[0]?.matchType).toBe("accent-insensitive");
  });

  it("biases toward the view centre it is given", async () => {
    expect((await querySearchIndex("rue gambetta", 5, AUCH)).hits[0]?.featureId).toBe("street-gambetta-auch");
    expect((await querySearchIndex("rue gambetta", 5, CONDOM)).hits[0]?.featureId).toBe("street-gambetta-condom");
  });

  it("serves repeated queries identically from its cache", async () => {
    const first = await querySearchIndex("gambetta", 10, AUCH);
    const second = await querySearchIndex("gambetta", 10, [AUCH[0] + 120, AUCH[1] - 80]);
    expect(JSON.stringify(second.hits)).toBe(JSON.stringify(first.hits));
  });

  it("returns hits that satisfy the shared hit schema", async () => {
    const { hits } = await querySearchIndex("rue", 10);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(SearchHitSchema.parse(hit)).toEqual(hit);
  });

  it("reports a missing dataset", async () => {
    process.env.MASTER_MAPS_DATA_DIR = `${dataRoot}-missing`;
    try {
      await expect(querySearchIndex("auch", 5)).rejects.toBeInstanceOf(SearchIndexError);
    } finally {
      process.env.MASTER_MAPS_DATA_DIR = dataRoot;
    }
  });
});

describe("queryCategory", () => {
  it("lists a category around a point", async () => {
    const { hits } = await queryCategory("pharmacy", CONDOM, 3000, 10);
    expect(hits[0]?.featureId).toBe("pharmacie-gare-condom");
    expect(hits.every((hit) => hit.category === "pharmacy")).toBe(true);
  });
});
