import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET } from "../../app/api/map/search/route";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, SEARCH_MAX_QUERY_LENGTH } from "@/lib/data/searchTypes";
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

const BASE_URL = "http://localhost:3000/api/map/search";

function searchRequest(searchParams: string, headers?: Record<string, string>): NextRequest {
  return new NextRequest(`${BASE_URL}${searchParams}`, { headers });
}

describe("GET /api/map/search", () => {
  it("answers 200 with an empty array for a missing query", async () => {
    const response = await GET(searchRequest(""));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("answers 200 with an empty array for a query shorter than the minimum", async () => {
    const response = await GET(searchRequest("?q=a"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("answers 400 for an oversized query", async () => {
    const response = await GET(searchRequest(`?q=${"a".repeat(SEARCH_MAX_QUERY_LENGTH + 1)}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "QUERY_TOO_LONG", code: "QUERY_TOO_LONG" });
  });

  it("answers with a bounded hit array and an ETag for a normal query", async () => {
    const response = await GET(searchRequest("?q=cathedrale&limit=5"));
    expect(response.status).toBe(200);
    const hits = (await response.json()) as unknown[];
    expect(Array.isArray(hits)).toBe(true);
    expect(hits.length).toBeLessThanOrEqual(5);
    expect(hits[0]).toMatchObject({ featureId: "cathedrale-sainte-marie" });
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("etag")).toMatch(/^W\/".+"$/);
  });

  it("answers 304 without a body when the ETag matches", async () => {
    const first = await GET(searchRequest("?q=cathedrale&limit=5"));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await GET(searchRequest("?q=cathedrale&limit=5", { "if-none-match": etag! }));
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("falls back to the default limit for a non numeric limit", async () => {
    const response = await GET(searchRequest("?q=rue&limit=abc"));
    expect(response.status).toBe(200);
    const hits = (await response.json()) as unknown[];
    expect(hits.length).toBeLessThanOrEqual(SEARCH_LIMIT_DEFAULT);
  });

  it("clamps the limit into the supported range", async () => {
    const low = await GET(searchRequest("?q=rue&limit=0"));
    expect(((await low.json()) as unknown[]).length).toBeLessThanOrEqual(1);
    const high = await GET(searchRequest(`?q=rue&limit=${SEARCH_LIMIT_MAX + 10}`));
    expect(((await high.json()) as unknown[]).length).toBeLessThanOrEqual(SEARCH_LIMIT_MAX);
  });

  it("answers 503 when the dataset is missing", async () => {
    process.env.MASTER_MAPS_DATA_DIR = `${dataRoot}-missing`;
    try {
      const response = await GET(searchRequest("?q=cathedrale"));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "DATASET_UNAVAILABLE", code: "DATASET_UNAVAILABLE" });
    } finally {
      process.env.MASTER_MAPS_DATA_DIR = dataRoot;
    }
  });
});
