import { describe, expect, it } from "vitest";
import {
  buildExclusionReport,
  createDropSink,
  createSourceAccounting,
  DROP_REASONS,
  createStageDropSink,
  ExclusionAccountingError,
  parseGeoJsonFeatures,
  reconcileCoverage,
  scanCanonicalFeatures,
  createCanonicalScan,
  type GeoJsonScan,
} from "../../scripts/data/exclusion-report";

const REPORT_INPUT = { dataRoot: "data", coveragePath: "data/manifests/coverage.json" };

function balancedRows() {
  const accounting = createSourceAccounting();
  accounting.record("bdtopo", "bdtopo-buildings", "building", 1000, 800, { excludedCount: 200, excluded: "bdtopo-normalization-canonical", reason: "no canonical feature carries the record" });
  accounting.record("ban", "adresses-32.csv", "address", 500, 400, { excludedCount: 0, excluded: "ban-row-excluded" });
  accounting.record("ban", "adresses-32.csv", "address", 0, 0, { excludedCount: 60, excluded: "ban-outside-boundary", reason: "row lies outside the canonical territory boundary" });
  accounting.record("ban", "adresses-32.csv", "address", 0, 0, { excludedCount: 40, excluded: "ban-duplicate-id", reason: "row repeats a BAN identifier" });
  return accounting.rows();
}

describe("exclusion accounting invariants", () => {
  it("balances input against accepted, excluded, invalid and outside records", () => {
    const report = buildExclusionReport({ ...REPORT_INPUT, sources: balancedRows(), stages: [] });
    for (const row of report.sources) {
      const excluded = row.excludedByRule.reduce((sum, entry) => sum + entry.count, 0);
      expect(row.accepted + excluded + row.invalidGeometry + row.outsideBoundary).toBe(row.input);
      expect(row.unexplained).toBe(0);
    }
    expect(report.totals.input).toBe(1500);
    expect(report.totals.accepted).toBe(1200);
    expect(report.totals.excluded).toBe(300);
    expect(report.totals.unexplained).toBe(0);
    expect(report.invariants.balanced).toBe(true);
  });

  it("fails the run and still exposes the report when records are unexplained", () => {
    const accounting = createSourceAccounting();
    accounting.record("bdtopo", "bdtopo-roads", "road", 900, 500, { excludedCount: 100, excluded: "bdtopo-normalization-canonical", reason: "no canonical feature carries the record" });
    let thrown: ExclusionAccountingError | null = null;
    try {
      buildExclusionReport({ ...REPORT_INPUT, sources: accounting.rows(), stages: [] });
    } catch (error) {
      thrown = error as ExclusionAccountingError;
    }
    expect(thrown).not.toBeNull();
    expect(thrown?.report.totals.unexplained).toBe(300);
    expect(thrown?.report.invariants.balanced).toBe(false);
    expect(thrown?.report.invariants.layersUnbalanced.join(" ")).toContain("bdtopo::bdtopo-roads::road");
  });

  it("reports a stage drop that no source rule explains without failing the build", () => {
    const stages = [{ stage: "normalize", reason: DROP_REASONS.osmUnclassifiedTags, count: 42, detail: "overpass" }];
    const report = buildExclusionReport({ ...REPORT_INPUT, sources: balancedRows(), stages });
    expect(report.invariants.stagesUndeclared).toEqual(["normalize|osm-unclassified-tags=42"]);
    expect(report.invariants.balanced).toBe(true);
  });


  it("merges duplicate rows for the same source layer key", () => {
    const first = createSourceAccounting();
    first.record("ban", "adresses-32.csv", "address", 100, 90, { excludedCount: 10, excluded: "ban-duplicate-id", reason: "duplicate" });
    const second = createSourceAccounting();
    second.record("ban", "adresses-32.csv", "address", 50, 40, { excludedCount: 10, excluded: "ban-duplicate-id", reason: "duplicate" });
    const report = buildExclusionReport({ ...REPORT_INPUT, sources: [...first.rows(), ...second.rows()], stages: [] });
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.input).toBe(150);
    expect(report.sources[0]?.excludedByRule[0]?.count).toBe(20);
    expect(report.sources[0]?.unexplained).toBe(0);
  });
});

describe("canonical scan", () => {
  it("counts kinds, sources, names and fictive water records", () => {
    const scan = createCanonicalScan();
    scanCanonicalFeatures([
      { kind: "water", name: "Lac", sourceRefs: [{ source: "IGN BD TOPO" }], sourceMetadata: { layer: "troncon_hydrographique", fictif: true }, fictiveAxis: true, geometry: { type: "Point", coordinates: [0, 43] } },
      { kind: "road", sourceRefs: [{ source: "IGN BD TOPO" }], sourceMetadata: { layer: "troncon_de_route" }, geometry: { type: "LineString", coordinates: [[0, 43], [1, 44]] } },
    ], scan);
    expect(scan.total).toBe(2);
    expect(scan.byKind).toEqual({ water: 1, road: 1 });
    expect(scan.bySourceAndLayer["IGN BD TOPO::troncon_hydrographique::water"]).toBe(1);
    expect(scan.namedByKind.water).toBe(1);
    expect(scan.fictiveWater).toBe(1);
  });
});

describe("geojson feature scan", () => {
  it("counts features and geometry counters without loading the whole document as json", () => {
    const scan: GeoJsonScan = { input: 0, invalidGeometry: 0, outsideBoundary: 0, clippedFragments: 0, ids: new Set<string>() };
    const document = `{"type":"FeatureCollection","features":[\n{"type":"Feature","properties":{"cleabs":"A1"},"geometry":{"type":"Polygon","coordinates":[]}},\n{"type":"Feature","properties":{},"geometry":{"type":"Point","outsideBoundary":1,"clippedFragments":2}}\n]}`;
    parseGeoJsonFeatures(document, scan);
    expect(scan.input).toBe(2);
    expect(scan.outsideBoundary).toBe(1);
    expect(scan.clippedFragments).toBe(2);
    expect(scan.ids.has("A1")).toBe(true);
  });
});

describe("stage drop accounting", () => {
  it("accumulates repeated stage drops by reason code and matches the source rule", () => {
    const accounting = createSourceAccounting();
    accounting.record("osm-bulk", "osm-bulk.geojson", "poi", 100, 20, { excludedCount: 80, excluded: DROP_REASONS.osmUnclassifiedTags, reason: "no canonical classifier retains the element" });
    accounting.record("osm-bulk", "osm-bulk.geojson", "poi", 0, 0, { excludedCount: 0, excluded: DROP_REASONS.osmExcludedTag, reason: "no canonical classifier retains the element" });
    const stages: Array<{ stage: string; reason: string; count: number; detail: string }> = [];
    const stageSink = createStageDropSink(stages);
    stageSink.drop("normalize", DROP_REASONS.osmUnclassifiedTags, 3, "batch one");
    stageSink.drop("normalize", DROP_REASONS.osmUnclassifiedTags, 4, "batch two");
    expect(stages).toHaveLength(2);
    const report = buildExclusionReport({ ...REPORT_INPUT, sources: accounting.rows(), stages: [{ stage: "normalize", reason: DROP_REASONS.osmUnclassifiedTags, count: 7, detail: "normalizeOsmBulkWithReport droppedByReason" }] });
    expect(report.sources[0]?.excludedByRule[0]?.count).toBe(80);
    expect(report.invariants.stagesUndeclared).toEqual([]);
  });
});


describe("coverage reconciliation", () => {
  it("reconciles coverage totals and per kind counts with decoded tiles", () => {
    const reconciliation = reconcileCoverage({
      canonical: [{ kind: "building" }, { kind: "road" }, { kind: "road" }],
      tiles: [1, 2],
      featureCounts: { building: 1, road: 2 },
      totalFeatures: 3,
      unexplained: 0,
    });
    expect(reconciliation.totalReconciled).toBe(true);
    expect(reconciliation.kindsUnmatched).toEqual([]);
    expect(reconciliation.tileFragmentTotal).toBe(3);
  });

  it("flags a coverage kind that disagrees with the canonical counts", () => {
    const reconciliation = reconcileCoverage({
      canonical: [{ kind: "building" }],
      tiles: [1],
      featureCounts: { building: 2 },
      totalFeatures: 2,
      unexplained: 0,
    });
    expect(reconciliation.totalReconciled).toBe(false);
    expect(reconciliation.kindsUnmatched).toEqual(["building"]);
  });
});
