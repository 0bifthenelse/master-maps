import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { querySearchIndex, resetSearchIndexCache } from "@/lib/data/searchServer";
import { SearchHitSchema } from "@/lib/data/searchTypes";
import { removeSearchFixture, writeSearchFixture } from "./search-fixture";

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
  it("returns no hits for an empty query", async () => {
    const { hits } = await querySearchIndex("", 10);
    expect(hits).toEqual([]);
  });

  it("returns no hits for a one character query", async () => {
    const { hits } = await querySearchIndex("a", 10);
    expect(hits).toEqual([]);
  });

  it("returns the accented cathedral record for cathedrale", async () => {
    const { hits } = await querySearchIndex("cathedrale", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.featureId).toBe("cathedrale-sainte-marie");
    expect(hits[0]?.matchType).toBe("prefix");
    expect(hits[0]?.score).toBe(505);
  });

  it("keeps the accent-insensitive tier for the full normalized name", async () => {
    const { hits } = await querySearchIndex("cathedrale sainte-marie", 10);
    expect(hits[0]?.featureId).toBe("cathedrale-sainte-marie");
    expect(hits[0]?.matchType).toBe("accent-insensitive");
  });

  it("keeps the exact tier for the raw accented name", async () => {
    const { hits } = await querySearchIndex("Cathédrale Sainte-Marie", 10);
    expect(hits[0]?.featureId).toBe("cathedrale-sainte-marie");
    expect(hits[0]?.matchType).toBe("exact");
  });

  it("returns NOCIBE through the edit distance tier for nocire", async () => {
    const { hits } = await querySearchIndex("nocire", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.featureId).toBe("nocibe-32013");
    expect(hits[0]?.matchType).toBe("edit-distance");
    expect(hits[0]?.score).toBe(130);
  });

  it("keeps rue pasteur on the token bucket instead of the rue bucket", async () => {
    const { hits } = await querySearchIndex("rue pasteur", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.featureId).toBe("rue-pasteur");
    expect(hits[0]?.matchType).toBe("accent-insensitive");
  });

  it("never returns more results than the requested limit", async () => {
    const { hits } = await querySearchIndex("rue", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("returns deterministic ordering across identical calls", async () => {
    const first = await querySearchIndex("boulevard", 10);
    const second = await querySearchIndex("boulevard", 10);
    expect(second.hits).toHaveLength(first.hits.length);
    expect(JSON.stringify(second.hits)).toBe(JSON.stringify(first.hits));
    expect(first.hits[0]?.featureId).toBe("boulevard-sadi-carnot");
  });

  it("returns hits that satisfy the shared hit schema", async () => {
    const { hits } = await querySearchIndex("rue", 10);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(SearchHitSchema.parse(hit)).toEqual(hit);
  });

  it("drops records whose category is absent", async () => {
    const { hits } = await querySearchIndex("nocire", 10);
    expect(hits[0]?.category).toBe("beauty");
    const { hits: plain } = await querySearchIndex("gers", 10);
    expect(plain[0]?.category).toBeUndefined();
  });
});
