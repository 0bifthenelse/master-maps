import { describe, it, expect } from "vitest";

// Simplified provenance logic
const SOURCE_PRIORITY: Record<string, number> = {
  "admin": 1,
  "ign": 2,
  "osm": 3,
  "ban": 4,
  "sirene": 5,
  "business-website": 6,
  "google-maps": 7,
};

function resolvePropertyConflict(
  property: string,
  values: { source: string; value: unknown; priority: number }[]
): { winner: unknown; priority: number } {
  if (values.length === 0) throw new Error("No values to resolve");
  // Sort by priority (lower = higher priority)
  const sorted = [...values].sort((a, b) => a.priority - b.priority);
  return { winner: sorted[0].value, priority: sorted[0].priority };
}

describe("SOURCE_PRIORITY ordering", () => {
  it("admin outranks ign", () => {
    expect(SOURCE_PRIORITY.admin).toBeLessThan(SOURCE_PRIORITY.ign);
  });

  it("ign outranks osm", () => {
    expect(SOURCE_PRIORITY.ign).toBeLessThan(SOURCE_PRIORITY.osm);
  });

  it("osm outranks ban", () => {
    expect(SOURCE_PRIORITY.osm).toBeLessThan(SOURCE_PRIORITY.ban);
  });

  it("ban outranks sirene", () => {
    expect(SOURCE_PRIORITY.ban).toBeLessThan(SOURCE_PRIORITY.sirene);
  });

  it("business website outranks google maps", () => {
    expect(SOURCE_PRIORITY["business-website"]).toBeLessThan(SOURCE_PRIORITY["google-maps"]);
  });
});

describe("resolvePropertyConflict", () => {
  it("prefers higher-priority source", () => {
    const result = resolvePropertyConflict("name", [
      { source: "osm", value: "Auch", priority: 3 },
      { source: "admin", value: "Auch Ville", priority: 1 },
    ]);
    expect(result.winner).toBe("Auch Ville");
  });

  it("first source wins when same priority", () => {
    const result = resolvePropertyConflict("name", [
      { source: "osm", value: "Auch", priority: 3 },
      { source: "osm2", value: "Ville d'Auch", priority: 3 },
    ]);
    // Stable sort: first encountered
    expect(result.winner).toBe("Auch");
  });

  it("throws on empty", () => {
    expect(() => resolvePropertyConflict("name", [])).toThrow();
  });

  it("single source always wins", () => {
    const result = resolvePropertyConflict("name", [
      { source: "google-maps", value: "Nocibé Auch", priority: 7 },
    ]);
    expect(result.winner).toBe("Nocibé Auch");
  });
});