import { describe, it, expect } from "vitest";

// Simplified stable ID logic
function generateStableId(
  sourceType: string,
  sourceId: string | undefined,
  kind: string,
  name: string,
  coordLng: number,
  coordLat: number,
  geomHash?: string
): string {
  if (sourceId) return `${sourceType}:${sourceId}`;

  const roundedLng = coordLng.toFixed(4);
  const roundedLat = coordLat.toFixed(4);
  const raw = `${kind}:${name}:${roundedLng}:${roundedLat}:${geomHash ?? ""}`;

  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 33) ^ raw.charCodeAt(i);
  }
  return `${sourceType}:h:${Math.abs(hash >>> 0).toString(36)}`;
}

describe("generateStableId", () => {
  it("preserves source ID when available", () => {
    expect(generateStableId("osm", "way/123", "building", "House", 0.5, 43.6))
      .toBe("osm:way/123");
  });

  it("produces deterministic hash without source ID", () => {
    const a = generateStableId("osm", undefined, "building", "Same", 0.5, 43.6);
    const b = generateStableId("osm", undefined, "building", "Same", 0.5, 43.6);
    expect(a).toBe(b);
  });

  it("different coordinates produce different IDs", () => {
    const a = generateStableId("osm", undefined, "building", "Same", 0.5, 43.6);
    const b = generateStableId("osm", undefined, "building", "Same", 0.6, 43.7);
    expect(a).not.toBe(b);
  });

  it("different kinds produce different IDs", () => {
    const a = generateStableId("osm", undefined, "building", "Same", 0.5, 43.6);
    const b = generateStableId("osm", undefined, "road", "Same", 0.5, 43.6);
    expect(a).not.toBe(b);
  });

  it("includes geomHash when provided", () => {
    const withHash = generateStableId("osm", undefined, "building", "B", 0.5, 43.6, "abc123");
    const without = generateStableId("osm", undefined, "building", "B", 0.5, 43.6);
    expect(withHash).not.toBe(without);
  });

  it("different source types prefix differently", () => {
    const a = generateStableId("osm", undefined, "building", "Test", 0, 0);
    const b = generateStableId("ban", undefined, "building", "Test", 0, 0);
    expect(a.startsWith("osm:")).toBe(true);
    expect(b.startsWith("ban:")).toBe(true);
  });
});