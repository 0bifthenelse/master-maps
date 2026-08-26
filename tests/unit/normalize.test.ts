import { describe, it, expect } from "vitest";

type SourceReference = {
  source: string;
  url?: string;
  timestamp: string;
  license?: string;
};

type Status = "active" | "uncertain" | "inferred" | "unresolved";

interface BuildingFeature {
  id: string;
  kind: "building";
  name?: string;
  height?: number;
  levels?: number;
  sourceRefs: SourceReference[];
  status: Status;
}

// Simplified normalization rules from the plan
function normalizeHeight(
  explicitHeight: number | undefined,
  levels: number | undefined,
  buildingType: string | undefined
): { height: number; inferred: boolean } {
  // Explicit finite height >= 0
  if (explicitHeight !== undefined && explicitHeight >= 0 && isFinite(explicitHeight)) {
    return { height: explicitHeight, inferred: false };
  }

  // Derive from levels
  if (levels !== undefined && levels > 0 && isFinite(levels)) {
    const derived = levels * 3.0;
    if (derived <= 18) {
      return { height: derived, inferred: true };
    }
  }

  // Category defaults
  const defaults: Record<string, number> = {
    house: 3.5,
    apartments: 6.0,
    garage: 2.7,
    shed: 2.7,
    retail: 5.0,
    industrial: 6.0,
    warehouse: 6.0,
    church: 12.0,
  };

  const def = buildingType ? defaults[buildingType] : undefined;
  return { height: def ?? 3.5, inferred: true };
}

function normalizeRoadWidth(highway: string, explicitWidth?: number): { width: number; inferred: boolean } {
  if (explicitWidth !== undefined && explicitWidth > 0 && isFinite(explicitWidth)) {
    return { width: explicitWidth, inferred: false };
  }

  const defaults: Record<string, number> = {
    motorway: 12,
    trunk: 9,
    primary: 9,
    secondary: 7,
    tertiary: 6,
    residential: 5,
    service: 3.5,
    pedestrian: 2,
    footway: 2,
    cycleway: 2,
    path: 1.5,
    track: 2.5,
  };

  return { width: defaults[highway] ?? 5, inferred: true };
}

describe("normalizeHeight", () => {
  it("uses explicit height when given", () => {
    const r = normalizeHeight(15, undefined, undefined);
    expect(r.height).toBe(15);
    expect(r.inferred).toBe(false);
  });

  it("derives from levels when no explicit height", () => {
    const r = normalizeHeight(undefined, 4, undefined);
    expect(r.height).toBe(12);
    expect(r.inferred).toBe(true);
  });

  it("uses category default when no height or levels", () => {
    const r = normalizeHeight(undefined, undefined, "house");
    expect(r.height).toBe(3.5);
    expect(r.inferred).toBe(true);
  });

  it("rejects negative explicit height", () => {
    const r = normalizeHeight(-1, undefined, undefined);
    expect(r.height).toBeGreaterThanOrEqual(0);
    expect(r.inferred).toBe(true);
  });

  it("rejects non-finite explicit height", () => {
    const r = normalizeHeight(Infinity, undefined, undefined);
    expect(isFinite(r.height)).toBe(true);
    expect(r.inferred).toBe(true);
  });

  it("derived height above 18 is capped", () => {
    const r = normalizeHeight(undefined, 10, undefined); // 30m derived
    expect(r.height).toBeLessThanOrEqual(18);
    expect(r.inferred).toBe(true);
  });

  it("uses generic default when no type", () => {
    const r = normalizeHeight(undefined, undefined, undefined);
    expect(r.height).toBe(3.5);
    expect(r.inferred).toBe(true);
  });

  it("explicit height trumps levels", () => {
    const r = normalizeHeight(20, 5, undefined);
    expect(r.height).toBe(20);
    expect(r.inferred).toBe(false);
  });
});

describe("normalizeRoadWidth", () => {
  it("uses explicit width when given", () => {
    const r = normalizeRoadWidth("residential", 8);
    expect(r.width).toBe(8);
    expect(r.inferred).toBe(false);
  });

  it("defaults for motorway", () => {
    const r = normalizeRoadWidth("motorway");
    expect(r.width).toBe(12);
    expect(r.inferred).toBe(true);
  });

  it("defaults for footway", () => {
    const r = normalizeRoadWidth("footway");
    expect(r.width).toBe(2);
    expect(r.inferred).toBe(true);
  });

  it("defaults for path", () => {
    const r = normalizeRoadWidth("path");
    expect(r.width).toBe(1.5);
    expect(r.inferred).toBe(true);
  });

  it("unknown highway gets 5m default", () => {
    const r = normalizeRoadWidth("unknown_type");
    expect(r.width).toBe(5);
    expect(r.inferred).toBe(true);
  });
});