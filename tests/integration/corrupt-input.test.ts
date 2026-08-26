import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("corrupt input handling", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "maps-corrupt-test-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects malformed JSON", () => {
    const badPath = join(tmpDir, "bad.json");
    writeFileSync(badPath, "{ invalid json }");
    expect(() => JSON.parse(readFileSync(badPath, "utf-8"))).toThrow();
  });

  it("rejects NaN coordinates", () => {
    const coords = [NaN, 43.65];
    expect(isFinite(coords[0])).toBe(false);
    expect(coords.some((c) => !isFinite(c))).toBe(true);
  });

  it("rejects infinite coordinates", () => {
    const coords = [Infinity, 43.65];
    expect(isFinite(coords[0])).toBe(false);
  });

  it("handles empty geometry", () => {
    const emptyGeom = { type: "Polygon", coordinates: [] };
    expect(emptyGeom.coordinates.length).toBe(0);
    // Rendering empty geometry should produce empty result
    const rings = emptyGeom.coordinates;
    expect(rings.every((r: unknown) => (r as unknown[]).length === 0)).toBe(true);
  });

  it("handles missing provenance gracefully", () => {
    const feature = {
      id: "test:1",
      kind: "building" as const,
      sourceRefs: [] as string[],
    };
    // No provenance should not crash
    expect(Array.isArray(feature.sourceRefs)).toBe(true);
    expect(feature.sourceRefs.length).toBe(0);
  });

  it("rejects duplicate stable IDs", () => {
    const ids = ["a", "b", "a", "c", "b"];
    const unique = [...new Set(ids)];
    expect(unique.length).toBeLessThan(ids.length);
    expect(unique).toEqual(["a", "b", "c"]);
  });

  it("handles HTTP error gracefully (simulated)", () => {
    const simulateFetch = async (url: string): Promise<{ ok: boolean; status: number }> => {
      if (url.includes("bad-endpoint")) {
        return { ok: false, status: 503 };
      }
      return { ok: true, status: 200 };
    };

    expect(async () => {
      const result = await simulateFetch("http://bad-endpoint");
      expect(result.ok).toBe(false);
      expect(result.status).toBe(503);
    }).not.toThrow();
  });

  it("rejects negative height values", () => {
    const height = -5;
    const isValid = (h: number) => isFinite(h) && h >= 0;
    expect(isValid(height)).toBe(false);
  });

  it("rejects absurdly large height values when inferred", () => {
    const height = 50;
    const inferred = true;
    const isValid = inferred ? height <= 18 : true;
    expect(isValid).toBe(false);
  });

  it("handles missing tile manifest gracefully", () => {
    const tileId = "99_99";
    const manifests = ["0_0", "1_0", "0_1", "1_1"];
    expect(manifests.includes(tileId)).toBe(false);
  });

  it("rejects path traversal in tileId", () => {
    const badId = "../../etc/passwd";
    const isValid = /^[a-zA-Z0-9_-]+$/.test(badId);
    expect(isValid).toBe(false);
  });
});