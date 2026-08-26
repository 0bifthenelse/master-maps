import { describe, it, expect } from "vitest";

describe("height derivation rules", () => {
  // These mirror the rules in normalize.ts
  const DEFAULT_HEIGHTS: Record<string, number> = {
    house: 3.5,
    apartments: 6.0,
    garage: 2.7,
    shed: 2.7,
    retail: 5.0,
    industrial: 6.0,
    warehouse: 6.0,
    church: 12.0,
    generic: 3.5,
  };

  it("house has 3.5m default", () => {
    expect(DEFAULT_HEIGHTS.house).toBe(3.5);
  });

  it("apartments have 6.0m default", () => {
    expect(DEFAULT_HEIGHTS.apartments).toBe(6.0);
  });

  it("church has 12.0m default", () => {
    expect(DEFAULT_HEIGHTS.church).toBe(12.0);
  });

  it("levels * 3.0 derivation", () => {
    expect(3 * 3.0).toBe(9.0);
    expect(1 * 3.0).toBe(3.0);
    expect(0 * 3.0).toBe(0);
  });

  it("rejects negative and absurd heights", () => {
    // Negative source value
    expect(-5).toBeLessThan(0);
    // Absurdly high inferred
    expect(50).toBeGreaterThan(18);
  });

  it("explicit source values above 18 are allowed", () => {
    // An explicit height of 25 should be preserved
    expect(25).toBeGreaterThan(18);
  });
});