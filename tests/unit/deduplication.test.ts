import { describe, it, expect } from "vitest";

interface SourceRef {
  source: string;
  value: string;
}

interface Feature {
  id: string;
  name: string;
  coord: [number, number];
  sourceRefs: SourceRef[];
}

// Deduplication: stable identity by source ID or hash
function stableIdForFeature(
  sourceType: string,
  sourceId: string | undefined,
  kind: string,
  name: string,
  coord: [number, number]
): string {
  if (sourceId) return `${sourceType}:${sourceId}`;

  // Hash-based when no durable ID
  const str = `${kind}:${name}:${coord[0].toFixed(4)}:${coord[1].toFixed(4)}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return `${sourceType}:hash:${Math.abs(hash).toString(16)}`;
}

function deduplicate(features: Feature[]): Feature[] {
  const seen = new Set<string>();
  return features.filter((f) => {
    const key = f.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

describe("stableIdForFeature", () => {
  it("uses source:sourceId when durable ID given", () => {
    const id = stableIdForFeature("osm", "way/12345", "building", "Test", [0, 0]);
    expect(id).toBe("osm:way/12345");
  });

  it("generates hash-based ID when no sourceId", () => {
    const id = stableIdForFeature("osm", undefined, "building", "Test", [0.5919, 43.6482]);
    expect(id).toMatch(/^osm:hash:[0-9a-f]+$/);
  });

  it("same inputs give same hash", () => {
    const a = stableIdForFeature("osm", undefined, "building", "Test", [0.5919, 43.6482]);
    const b = stableIdForFeature("osm", undefined, "building", "Test", [0.5919, 43.6482]);
    expect(a).toBe(b);
  });

  it("different coords give different hash", () => {
    const a = stableIdForFeature("osm", undefined, "building", "Test", [0.5919, 43.6482]);
    const b = stableIdForFeature("osm", undefined, "building", "Test", [0.5000, 43.6000]);
    expect(a).not.toBe(b);
  });
});

describe("deduplicate", () => {
  it("removes duplicate IDs", () => {
    const items: Feature[] = [
      { id: "a", name: "A", coord: [0, 0], sourceRefs: [] },
      { id: "b", name: "B", coord: [1, 1], sourceRefs: [] },
      { id: "a", name: "A dup", coord: [0, 0], sourceRefs: [] },
    ];
    const result = deduplicate(items);
    expect(result.length).toBe(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
  });

  it("unique IDs pass through", () => {
    const items: Feature[] = [
      { id: "a", name: "A", coord: [0, 0], sourceRefs: [] },
      { id: "b", name: "B", coord: [1, 1], sourceRefs: [] },
    ];
    expect(deduplicate(items).length).toBe(2);
  });
});