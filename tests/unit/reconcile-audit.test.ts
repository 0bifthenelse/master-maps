import { describe, expect, it } from "vitest";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  assembleReport,
  buildAuditRow,
  bucketTotal,
  canonicalFileMatches,
  countCsvGz,
  countFeatureCollectionText,
  indexExclusionArtefact,
  mergePipelineBuckets,
  namespaceOf,
  parseTagsCount,
  pointInRing,
  pointInsidePolygon,
  ReconcileAuditError,
  residualOf,
  scanCanonicalStore,
  totalOf,
  type AuditRow,
  type ExclusionRow,
  type Measurement,
  type RowSpec,
  type SourceIdentity,
} from "../../scripts/data/reconcile-audit";

const IDENTITY: SourceIdentity = {
  family: "test",
  name: "test source",
  license: "test license",
  edition: "2026-01-01",
  editionSource: "test",
  acquiredAt: "2026-01-01T00:00:00.000Z",
  sha256: "abc",
  localFile: "data/raw/test",
  bytes: 1,
};

const STORE_COMMAND = "streaming stableId scan of data/intermediate";

function spec(overrides: Partial<RowSpec> & { id: string; input: number | null; accepted: number | null }): RowSpec {
  return {
    source: "test",
    layer: "test-layer",
    kind: "test-kind",
    inputMeasurement: {
      value: overrides.input,
      command: "independent measurement",
      status: overrides.input === null ? "unavailable" : "measured",
      note: "test",
    },
    acceptedFrom: "canonical store",
    acceptedMeasurement: { value: overrides.accepted, command: STORE_COMMAND, status: "measured", note: "canonical store scan" },
    merged: 0,
    invalid: 0,
    outsideBoundary: 0,
    buckets: [],
    partialDataset: false,
    ...overrides,
  };
}

const reportBase = {
  dataRoot: "data",
  canonicalStore: { status: "measured" as const, files: 1, records: 10, byKind: {}, byStableIdNamespace: {}, newestMtime: null, scanCommand: "scan" },
  freshness: { canonicalNewestMtime: null, sources: [] },
  artefacts: [],
};

const family = (rows: AuditRow[]) => ({ family: "osm", identity: IDENTITY, rows, notes: "test" });

describe("residual arithmetic", () => {
  it("returns the input minus every accounted bucket", () => {
    expect(residualOf({ input: 100, accepted: 60, merged: 5, excluded: 20, invalid: 10, outsideBoundary: 5 })).toBe(0);
    expect(residualOf({ input: 100, accepted: 60, merged: 0, excluded: 20, invalid: 0, outsideBoundary: 0 })).toBe(20);
  });

  it("returns null when the input or the accepted count is unavailable", () => {
    expect(residualOf({ input: null, accepted: 10, merged: 0, excluded: 0, invalid: 0, outsideBoundary: 0 })).toBeNull();
    expect(residualOf({ input: 10, accepted: null, merged: 0, excluded: 0, invalid: 0, outsideBoundary: 0 })).toBeNull();
  });

  it("sums exclusion buckets into the excluded total", () => {
    expect(bucketTotal([
      { rule: "a", count: 3, reason: "a", origin: "policy" },
      { rule: "b", count: 4, reason: "b", origin: "policy" },
    ])).toBe(7);
  });
});

describe("audit row", () => {
  it("computes a zero residual when every input record is accounted for", () => {
    const row = buildAuditRow(spec({
      id: "ban::adresses-32.csv",
      input: 1000,
      accepted: 900,
      merged: 20,
      invalid: 5,
      outsideBoundary: 5,
      buckets: [{ rule: "ban-not-parsed", count: 70, reason: "the row carries no usable field", origin: "pipeline-artefact" }],
    }));
    expect(row.excluded).toBe(70);
    expect(row.unexplained).toBe(0);
    expect(row.unexplainedReasons).toEqual([]);
  });

  it("computes a positive residual and never hardcodes zero", () => {
    const row = buildAuditRow(spec({ id: "bdtopo::bdtopo-roads.geojson", input: 166798, accepted: 126784, buckets: [] }));
    expect(row.unexplained).toBe(40014);
    expect(row.unexplainedReasons.join(" ")).toContain("40014");
  });

  it("labels a partial dataset residual differently from an unattributable one", () => {
    const partial = buildAuditRow(spec({ id: "osm::highway", input: 100, accepted: 40, partialDataset: true }));
    expect(partial.unexplained).toBe(60);
    expect(partial.unexplainedReasons.join(" ")).toContain("in-flight rebuild");

    const unattributable = buildAuditRow(spec({ id: "osm::highway", input: 100, accepted: 40, partialDataset: false }));
    expect(unattributable.unexplainedReasons.join(" ")).toContain("no pipeline artefact attributes them");
  });

  it("reports a negative residual when the buckets exceed the independent input", () => {
    const row = buildAuditRow(spec({ id: "sirene::x", input: 10, accepted: 20, buckets: [] }));
    expect(row.unexplained).toBe(-10);
    expect(row.unexplainedReasons.join(" ")).toContain("exceed the independent input");
  });

  it("reports an unavailable input measurement as -1 with a reason", () => {
    const row = buildAuditRow(spec({
      id: "cadastre::batiments",
      input: null,
      accepted: 0,
      inputMeasurement: { value: null, command: "gzip -dc", status: "unavailable", note: "absent" },
    }));
    expect(row.unexplained).toBe(-1);
    expect(row.input.independent).toBeNull();
    expect(row.input.agrees).toBeNull();
    expect(row.unexplainedReasons.join(" ")).toContain("cannot be computed");
  });

  it("counts an independent boundary measurement once, as a named exclusion bucket", () => {
    const row = buildAuditRow(spec({
      id: "osm::amenity",
      input: 100,
      accepted: 50,
      partialDataset: true,
      boundaryMeasurements: [{ id: "amenity", method: "point in polygon", measured: 40, unexplained: 40 }],
    }));
    expect(row.excluded).toBe(40);
    expect(row.outsideBoundary).toBe(0);
    expect(row.unexplained).toBe(10);
    expect(row.excludedByRule.map((entry) => entry.rule)).toContain("outside-canonical-boundary-unclassified");
    expect(row.unexplainedReasons.join(" ")).toContain("point in polygon");
  });

  it("adds the per value residual on top of the row residual", () => {
    const row = buildAuditRow(spec({
      id: "osm::highway",
      input: 138252,
      accepted: 1000,
      partialDataset: true,
      valueResiduals: [{ value: "service", input: 78770, accepted: 3313, unexplained: 75457 }],
    }));
    expect(row.unexplained).toBe(137252 + 75457);
    expect(row.valueResiduals[0]?.value).toBe("service");
  });

  it("records agreement between the independent and the pipeline input count", () => {
    expect(buildAuditRow(spec({ id: "a", input: 10, accepted: 10, pipelineInput: 10 })).input.agrees).toBe(true);
    expect(buildAuditRow(spec({ id: "a", input: 10, accepted: 10, pipelineInput: 12 })).input.agrees).toBe(false);
  });

  it("marks a row measured by an independent command as measured", () => {
    const measurement: Measurement = { value: 441718, command: "ogrinfo -ro -q -sql \"SELECT COUNT(*) AS n FROM batiment\" data.gpkg", status: "measured", note: "raw GPKG layer" };
    const row = buildAuditRow(spec({ id: "bdtopo::x", input: 441718, accepted: 441718, inputMeasurement: measurement }));
    expect(row.inputMeasurement).toEqual(measurement);
    expect(row.accepted.from).toBe("canonical store");
  });
});

describe("artefact merge", () => {
  const exclusionRow: ExclusionRow = {
    key: "bdtopo::bdtopo-buildings.geojson::building",
    input: 397887,
    accepted: 305761,
    mergedDeduplicated: 12,
    invalidGeometry: 3,
    outsideBoundary: 4,
    excludedByRule: [
      { rule: "bdtopo-normalization-canonical", count: 92119, reason: "no canonical feature carries the record" },
      { rule: "zero-count-rule", count: 0, reason: "never counted" },
    ],
  };

  it("turns pipeline exclusion rules into attributed buckets and drops zero counts", () => {
    const merged = mergePipelineBuckets(exclusionRow, "data/qa/exclusion-report.json");
    expect(merged.buckets.map((entry) => entry.rule)).toEqual(["bdtopo-normalization-canonical", "deduplicate-merge"]);
    expect(bucketTotal(merged.buckets)).toBe(92119 + 12);
    expect(merged.merged).toBe(12);
    expect(merged.buckets[0]?.reason).toContain("data/qa/exclusion-report.json");
  });

  it("does not add a merge bucket when the pipeline reports no merge", () => {
    const merged = mergePipelineBuckets({ ...exclusionRow, mergedDeduplicated: 0 }, "artefact");
    expect(merged.buckets.map((entry) => entry.rule)).toEqual(["bdtopo-normalization-canonical"]);
  });

  it("keeps post stage BAN rules out of the buckets so the residual stays honest", () => {
    const merged = mergePipelineBuckets({
      key: "ban::adresses-32.csv::address",
      input: 100,
      accepted: 80,
      mergedDeduplicated: 0,
      invalidGeometry: 0,
      outsideBoundary: 5,
      excludedByRule: [
        { rule: "ban-header-line", count: 1, reason: "the CSV header line carries no address" },
        { rule: "ban-outside-boundary", count: 5, reason: "row outside the boundary" },
        { rule: "ban-not-indexed", count: 9, reason: "accepted but never indexed" },
        { rule: "source-normalization-stale", count: 7, reason: "produced by a different run" },
      ],
    }, "data/qa/exclusion-report.json");
    expect(merged.buckets.map((entry) => entry.rule).sort()).toEqual(["ban-header-line", "ban-outside-boundary"]);
  });

  it("indexes the exclusion report rows by key and tolerates a missing document", () => {
    const rows = indexExclusionArtefact({
      sources: [
        { key: "a::b::c", input: 1, accepted: 1, mergedDeduplicated: 0, invalidGeometry: 0, outsideBoundary: 0, excludedByRule: [] },
        { key: "d::e::f", input: 2, accepted: 2 },
        { notAKey: true },
      ],
    });
    expect(rows.get("a::b::c")?.input).toBe(1);
    expect(rows.get("d::e::f")?.excludedByRule).toEqual([]);
    expect(rows.size).toBe(2);
    expect(indexExclusionArtefact(null).size).toBe(0);
  });

  it("lets the merged pipeline buckets close a real residual", () => {
    const merged = mergePipelineBuckets({ ...exclusionRow, mergedDeduplicated: 0 }, "artefact");
    const row = buildAuditRow(spec({
      id: "bdtopo::bdtopo-buildings.geojson",
      input: exclusionRow.input,
      accepted: 305761,
      merged: merged.merged,
      invalid: exclusionRow.invalidGeometry,
      outsideBoundary: exclusionRow.outsideBoundary,
      buckets: merged.buckets,
    }));
    expect(row.unexplained).toBe(0);
  });
});

describe("report assembly", () => {
  it("accepts a fully accounted partial dataset", () => {
    const report = assembleReport({
      ...reportBase,
      families: [family([buildAuditRow(spec({ id: "osm::highway", input: 100, accepted: 40, partialDataset: true }))])],
      crossChecks: [{ id: "x", declared: 1, measured: 1, agrees: true, blocking: true, note: "" }],
    });
    expect(report.invariants.accounted).toBe(true);
    expect(report.invariants.unattributedResidual).toBe(60);
    expect(report.invariants.partialDatasetRows).toEqual(["osm::highway"]);
    expect(report.invariants.unattributableRows).toEqual([]);
  });

  it("throws with the report attached when a residual cannot be attributed", () => {
    let thrown: ReconcileAuditError | null = null;
    try {
      assembleReport({
        ...reportBase,
        families: [family([buildAuditRow(spec({ id: "cadastre::batiments", input: 100, accepted: 0, partialDataset: false }))])],
        crossChecks: [],
      });
    } catch (error) {
      thrown = error as ReconcileAuditError;
    }
    expect(thrown).toBeInstanceOf(ReconcileAuditError);
    expect(thrown?.report.invariants.accounted).toBe(false);
    expect(thrown?.report.invariants.unattributableRows).toEqual(["cadastre::batiments unexplained=100"]);
  });

  it("throws on a blocking cross check failure but not on an advisory one", () => {
    const rows = [buildAuditRow(spec({ id: "osm::highway", input: 100, accepted: 100, partialDataset: true }))];
    const advisory = assembleReport({
      ...reportBase,
      families: [family(rows)],
      crossChecks: [{ id: "advisory", declared: 1, measured: 2, agrees: false, blocking: false, note: "" }],
    });
    expect(advisory.invariants.advisoryDisagreements).toBe(1);
    expect(advisory.invariants.accounted).toBe(true);

    let thrown: ReconcileAuditError | null = null;
    try {
      assembleReport({
        ...reportBase,
        families: [family(rows)],
        crossChecks: [{ id: "blocking", declared: 1, measured: 2, agrees: false, blocking: true, note: "" }],
      });
    } catch (error) {
      thrown = error as ReconcileAuditError;
    }
    expect(thrown?.report.invariants.blockingCrossCheckFailures).toBe(1);
  });

  it("totals a family only when every input measurement is present", () => {
    expect(totalOf([buildAuditRow(spec({ id: "a", input: 10, accepted: 4 }))]).input).toBe(10);
    expect(totalOf([
      buildAuditRow(spec({ id: "a", input: 10, accepted: 4 })),
      buildAuditRow(spec({ id: "b", input: null, accepted: 1 })),
    ]).input).toBeNull();
  });
});

describe("independent parsers", () => {
  it("parses osmium tags-count output into per value counts", () => {
    const parsed = parseTagsCount('138252\t"highway"\t"residential"\n78770\t"highway"\t"service"\n', "osmium tags-count");
    expect(parsed.counts.residential).toBe(138252);
    expect(parsed.counts.service).toBe(78770);
    expect(parsed.total).toBe(217022);
  });

  it("counts every top level feature of a GeoJSON features array", () => {
    const document = '{"type":"FeatureCollection","features":[' +
      '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[]},"properties":{"nom":"A","commune":"32001"}},' +
      '{"type":"Feature","geometry":null,"properties":{"commune":"32002"}},\n' +
      '{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0]]]},"properties":{}}]}';
    const count = countFeatureCollectionText(document, "commune");
    expect(count.total).toBe(3);
    expect(count.invalid).toBe(1);
    expect(count.named).toBe(1);
    expect(count.withCommune).toBe(2);
  });

  it("classifies canonical store files and extracts the stableId namespace", () => {
    expect(canonicalFileMatches("road-0001.json")).toBe(true);
    expect(canonicalFileMatches("building.json")).toBe(true);
    expect(canonicalFileMatches("provenance.json")).toBe(false);
    expect(canonicalFileMatches("bdtopo-manifest.json")).toBe(false);
    expect(namespaceOf("ign-bdtopo:buildings/BATIMENT0000000311484551")).toBe("ign-bdtopo");
    expect(namespaceOf("ban:32002_0020_01955")).toBe("ban");
  });

  it("tests a point against a boundary polygon with a hole", () => {
    const polygon = { rings: [
      [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]],
    ] };
    expect(pointInsidePolygon([2, 2], polygon)).toBe(true);
    expect(pointInsidePolygon([5, 5], polygon)).toBe(false);
    expect(pointInsidePolygon([20, 20], polygon)).toBe(false);
    expect(pointInRing([2, 2], [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]])).toBe(true);
  });

  it("scans a canonical store directory for records, kinds, namespaces and tag values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-audit-"));
    try {
      writeFileSync(join(dir, "road-0001.json"), JSON.stringify([
        { stableId: "osm-bulk:w1", kind: "road", highway: "residential" },
        { stableId: "osm-bulk:w2", kind: "road", highway: "service" },
      ]));
      writeFileSync(join(dir, "address.json"), JSON.stringify([{ stableId: "ban:a1", kind: "address" }]));
      writeFileSync(join(dir, "provenance.json"), JSON.stringify([{ stableId: "should:not:be:counted" }]));
      const store = await scanCanonicalStore(dir, ["highway"]);
      expect(store.status).toBe("measured");
      expect(store.records).toBe(3);
      expect(store.byKind.road).toBe(2);
      expect(store.byStableIdNamespace["osm-bulk"]).toBe(2);
      expect(store.fieldValues["road|highway"]?.residential).toBe(1);
      expect(store.scanCommand).toContain("highway");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an absent canonical store rather than an empty measured one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-audit-empty-"));
    try {
      const store = await scanCanonicalStore(join(dir, "missing"), ["highway"]);
      expect(store.status).toBe("absent");
      expect(store.records).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts physical lines, blank lines and non finite coordinates of a gzipped csv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reconcile-audit-csv-"));
    try {
      const file = join(dir, "adresses-32.csv.gz");
      const descriptor = openSync(file, "w");
      writeSync(descriptor, gzipSync(Buffer.from("id;code_insee;lon;lat\na;32001;0.1;43.1\nb;32002;0.2;43.2\n\nc;32003;nan;43.3\n", "utf8")));
      closeSync(descriptor);
      const count = await countCsvGz(file);
      expect(count.physicalLines).toBe(5);
      expect(count.dataRows).toBe(4);
      expect(count.blankLines).toBe(1);
      expect(count.nonEmptyIds).toBe(3);
      expect(count.nonFiniteCoordinates).toBe(1);
      expect(count.communeCodes["32001"]).toBe(1);
      expect(count.headerFields).toEqual(["id", "code_insee", "lon", "lat"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
