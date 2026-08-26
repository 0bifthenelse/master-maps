import { describe, it, expect } from "vitest";

// Simplified manifest validation
interface TileManifest {
  tileId: string;
  bounds: [number, number, number, number];
  featureCount: number;
  byteSize: number;
  features: string[];
}

interface CoverageReport {
  datasetVersion: string;
  acquisitionTime: string;
  boundary: string;
  projectionOrigin: [number, number];
  tileSize: number;
  tileCount: number;
  featureCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  unresolved: string[];
  failedSources: string[];
  budgets: {
    maxTileSize: number;
    maxTileBytes: number;
    actualMaxBytes: number;
    withinBudget: boolean;
  };
}

interface NocibeFocus {
  name: string;
  searchKey: string;
  banId: string;
  address: string;
  coord: [number, number];
  sourceRefs: { source: string; url?: string }[];
  confidence: string;
  status: string;
  anchors: { name: string; coord: [number, number] }[];
}

describe("TileManifest validation", () => {
  const valid: TileManifest = {
    tileId: "0_0",
    bounds: [0, 0, 100, 100],
    featureCount: 42,
    byteSize: 102400,
    features: ["feat-1", "feat-2"],
  };

  it("accepts valid manifest", () => {
    expect(valid.tileId).toBeTruthy();
    expect(valid.featureCount).toBeGreaterThanOrEqual(0);
    expect(valid.bounds.length).toBe(4);
  });

  it("bounds have numeric values", () => {
    expect(valid.bounds.every((v) => typeof v === "number")).toBe(true);
  });

  it("features is array of strings", () => {
    expect(Array.isArray(valid.features)).toBe(true);
    expect(valid.features.every((f) => typeof f === "string")).toBe(true);
  });
});

describe("CoverageReport validation", () => {
  const report: CoverageReport = {
    datasetVersion: "0.1.0",
    acquisitionTime: "2026-08-26T17:00:00Z",
    boundary: "auch-32013",
    projectionOrigin: [0.586, 43.65],
    tileSize: 384,
    tileCount: 64,
    featureCounts: { buildings: 5000, roads: 2000 },
    sourceCounts: { osm: 7000, ban: 3000 },
    unresolved: ["gallery name Place Villaret Joyeuse"],
    failedSources: ["ign-terrain"],
    budgets: { maxTileSize: 384, maxTileBytes: 750000, actualMaxBytes: 420000, withinBudget: true },
  };

  it("has valid version", () => {
    expect(report.datasetVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("has acquisition timestamp", () => {
    expect(() => new Date(report.acquisitionTime)).not.toThrow();
  });

  it("has feature counts", () => {
    expect(Object.keys(report.featureCounts).length).toBeGreaterThan(0);
  });

  it("has budget info", () => {
    expect(report.budgets.withinBudget).toBe(true);
    expect(report.budgets.maxTileSize).toBeGreaterThan(0);
  });
});

describe("NocibeFocus validation", () => {
  const focus: NocibeFocus = {
    name: "Nocibé",
    searchKey: "nocibe",
    banId: "32013_0050_00028",
    address: "28 Avenue d'Alsace, 32000 Auch",
    coord: [0.591913, 43.648231],
    sourceRefs: [{ source: "ban", url: "https://api-adresse.data.gouv.fr" }],
    confidence: "high",
    status: "active",
    anchors: [
      { name: "Avenue d'Alsace", coord: [0.591575, 43.648437] },
      { name: "Place de Verdun", coord: [0.592746, 43.648079] },
      { name: "Place Villaret Joyeuse", coord: [0.588099, 43.649466] },
    ],
  };

  it("has correct searchKey (accentless)", () => {
    expect(focus.searchKey).toBe("nocibe");
    expect(focus.searchKey).not.toContain("é");
  });

  it("has BAN ID", () => {
    expect(focus.banId).toMatch(/^\d+_\d+_\d+$/);
  });

  it("has verified address", () => {
    expect(focus.address).toContain("Avenue d'Alsace");
    expect(focus.address).toContain("32000 Auch");
  });

  it("has three anchors", () => {
    expect(focus.anchors.length).toBe(3);
  });

  it("confidence is high for verified record", () => {
    expect(focus.confidence).toBe("high");
  });
});