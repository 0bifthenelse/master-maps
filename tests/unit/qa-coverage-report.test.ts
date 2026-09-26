import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createBoundaryIndex } from "../../scripts/data/boundaryIndex";
import {
  ADOPTED_KINDS,
  baseTileId,
  buildCellReport,
  buildDepartmentGrid,
  buildPercentiles,
  cellBounds,
  cellLabel,
  computeVerdicts,
  countEntriesByKind,
  decodeRenderTileMeta,
  featureKind,
  gridCellSize,
  gridIndexOf,
  quantileSorted,
  readSearchCounts,
  runCoverageReport,
  streamCanonicalFeatures,
  type CellReport,
  type PresenceInput,
} from "../../scripts/data/qa-coverage-report";

const ORIGIN: [number, number] = [-1000, -1000];
const CELL = 1000;

function presence(overrides: Partial<PresenceInput> = {}): PresenceInput {
  return {
    cell: 9,
    label: "r1c1",
    bounds: [0, 0, 1, 1],
    departmentSamplePoints: 64,
    declaredTiles: 4,
    renderTilesOnDisk: 4,
    uniqueFeatures: 10,
    counts: { road: 6, building: 4 },
    ...overrides,
  };
}

function report(overrides: Partial<CellReport> = {}): CellReport {
  return buildCellReport(presence({ counts: { road: 1 } }));
}

describe("grid assignment", () => {
  it("places points in the cell of their column and row", () => {
    expect(gridIndexOf([-999, -999], ORIGIN, 8, CELL)).toBe(0);
    expect(gridIndexOf([-1, -1], ORIGIN, 8, CELL)).toBe(0);
    expect(gridIndexOf([0, 0], ORIGIN, 8, CELL)).toBe(9);
    expect(gridIndexOf([6999, 6999], ORIGIN, 8, CELL)).toBe(63);
  });

  it("assigns cell edges by the lower bound and keeps points inside the grid", () => {
    expect(gridIndexOf([-1, -1], ORIGIN, 8, CELL)).toBe(gridIndexOf([-1000, -1000], ORIGIN, 8, CELL));
    expect(gridIndexOf([0, 0], ORIGIN, 8, CELL)).toBe(gridIndexOf([999, 999], ORIGIN, 8, CELL));
    expect(gridIndexOf([-99999, -99999], ORIGIN, 8, CELL)).toBe(0);
    expect(gridIndexOf([99999, 99999], ORIGIN, 8, CELL)).toBe(63);
  });

  it("gives every cell a distinct index and label", () => {
    const seen = new Set<number>();
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) seen.add(gridIndexOf([ORIGIN[0] + col * CELL + 1, ORIGIN[1] + row * CELL + 1], ORIGIN, 8, CELL));
    }
    expect(seen.size).toBe(64);
    expect(cellLabel(0, 8)).toBe("r0c0");
    expect(cellLabel(9, 8)).toBe("r1c1");
    expect(cellLabel(63, 8)).toBe("r7c7");
  });

  it("derives cell bounds that contain the cell centre", () => {
    const bounds = cellBounds(9, ORIGIN, 8, CELL);
    expect(bounds).toEqual([0, 0, 1000, 1000]);
    const centre: [number, number] = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    expect(gridIndexOf(centre, ORIGIN, 8, CELL)).toBe(9);
  });

  it("sizes cells so the department spans the grid with margin on the far edge", () => {
    const bounds: [number, number, number, number] = [0, 0, 4000, 2000];
    expect(gridCellSize(bounds, 8)).toBeCloseTo(4000 / 7);
    expect(gridCellSize([0, 0, 0, 0], 8)).toBe(4096);
  });

  it("resolves a subdivided tile id to its base tile", () => {
    expect(baseTileId("l0_63_27_s1_1_1")).toBe("l0_63_27");
    expect(baseTileId("l0_1_1")).toBe("l0_1_1");
    expect(baseTileId("boundary")).toBe("boundary");
  });
});

describe("department cell flags", () => {
  const square = [[[[-500, -500], [500, -500], [500, 500], [-500, 500]]]];

  it("marks only the cells that contain interior points", () => {
    const grid = buildDepartmentGrid({
      boundary: createBoundaryIndex(square),
      origin: [-1000, -1000],
      size: 8,
      cellSize: 250,
      samplesPerCellAxis: 8,
    });
    expect(grid.intersectingCells).toBe(16);
    const centre = gridIndexOf([0, 0], [-1000, -1000], 8, 250);
    expect(grid.flags[centre]).toBe(1);
    expect(grid.samplePointsPerCell[centre]).toBe(64);
    const outside = gridIndexOf([-950, -950], [-1000, -1000], 8, 250);
    expect(grid.flags[outside]).toBe(0);
    expect(grid.samplePointsPerCell[outside]).toBe(0);
    expect(grid.departmentBounds[0]).toBeGreaterThan(-500);
    expect(grid.departmentBounds[0]).toBeLessThan(0);
    expect(grid.departmentBounds[2]).toBeLessThan(500);
    expect(grid.departmentBounds[2]).toBeGreaterThan(0);
  });
});

describe("percentiles", () => {
  it("computes interpolated quantiles on a known series", () => {
    const values = [10, 20, 30, 40];
    const stats = buildPercentiles(values);
    expect(stats.count).toBe(4);
    expect(stats.totalBytes).toBe(100);
    expect(stats.minBytes).toBe(10);
    expect(stats.p25Bytes).toBeCloseTo(17.5);
    expect(stats.p50Bytes).toBeCloseTo(25);
    expect(stats.p75Bytes).toBeCloseTo(32.5);
    expect(stats.maxBytes).toBe(40);
    expect(stats.meanBytes).toBe(25);
  });

  it("returns zero statistics for an empty sample", () => {
    expect(buildPercentiles([])).toEqual({
      count: 0,
      totalBytes: 0,
      minBytes: 0,
      p25Bytes: 0,
      p50Bytes: 0,
      p75Bytes: 0,
      p90Bytes: 0,
      p95Bytes: 0,
      p99Bytes: 0,
      maxBytes: 0,
      meanBytes: 0,
    });
  });

  it("is insensitive to input order", () => {
    const ascending = buildPercentiles([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const shuffled = buildPercentiles([7, 1, 9, 3, 10, 2, 8, 4, 6, 5]);
    expect(shuffled).toEqual(ascending);
  });

  it("clamps fractions outside the unit interval", () => {
    const sorted = [4, 8, 12];
    expect(quantileSorted(sorted, -1)).toBe(4);
    expect(quantileSorted(sorted, 2)).toBe(12);
    expect(quantileSorted([], 0.5)).toBe(0);
  });
});

describe("cell presence and missing reasons", () => {
  it("reports every adopted kind with a zero default", () => {
    const cell = buildCellReport(presence({ counts: { road: 3 } }));
    for (const kind of ADOPTED_KINDS.filter((kind) => kind !== "road")) expect(cell.counts[kind]).toBe(0);
    expect(cell.counts["road"]).toBe(3);
    expect(cell.presentKinds).toEqual(["road"]);
    expect(cell.absentKinds).toContain("building");
  });

  it("blames a missing tile when the cell has no render tile on disk", () => {
    const cell = buildCellReport(presence({ renderTilesOnDisk: 0, declaredTiles: 12, counts: {} }));
    expect(cell.missing).toHaveLength(ADOPTED_KINDS.length);
    for (const entry of cell.missing) expect(entry.reason).toEqual({ type: "tile-absent", declaredTiles: 12, renderTilesOnDisk: 0 });
    expect(cell.absentKindsWithoutTiles).toEqual([...ADOPTED_KINDS]);
  });

  it("distinguishes an undeclared cell from a cell whose tiles are missing", () => {
    const cell = buildCellReport(presence({ declaredTiles: 0, renderTilesOnDisk: 0, counts: {} }));
    for (const entry of cell.missing) expect(entry.reason).toEqual({ type: "no-tiles-declared", renderTilesOnDisk: 0 });
    expect(cell.absentKindsWithoutTiles).toEqual([...ADOPTED_KINDS]);
  });

  it("attributes a kind gap to the distributed features when tiles are present", () => {
    const cell = buildCellReport(presence({ uniqueFeatures: 25, counts: { road: 25 } }));
    const business = cell.missing.find((entry) => entry.kind === "business");
    expect(business?.reason).toEqual({ type: "kind-absent-in-distributed-features", declaredTiles: 4, renderTilesOnDisk: 4, uniqueFeaturesInCell: 25 });
  });

  it("counts unique features per kind without double counting fragments", () => {
    const counts = countEntriesByKind(new Map([["ign-bdtopo:road/A", "road"], ["ign-bdtopo:road/A", "road"], ["ban:1", "address"]]));
    expect(counts).toEqual({ counts: { road: 1, address: 1 }, unique: 2 });
  });
});

describe("verdict rules", () => {
  const allKinds = Object.fromEntries(ADOPTED_KINDS.map((kind) => [kind, 10]));

  it("passes when every department cell has a tile and every adopted kind is present and searchable", () => {
    const cells = [report(), { ...report(), label: "r2c2" }];
    const verdict = computeVerdicts({
      cells,
      canonicalByKind: allKinds,
      searchability: ADOPTED_KINDS.map((kind) => ({ kind, canonical: 10, searchable: 5, ratio: 0.5 })),
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.missingCells).toEqual([]);
    expect(verdict.absentKinds).toEqual([]);
    expect(verdict.unsearchableKinds).toEqual([]);
  });

  it("fails a department cell that has no tile on disk", () => {
    const verdict = computeVerdicts({
      cells: [report(), { ...report(), label: "r3c3", renderTilesOnDisk: 0 }],
      canonicalByKind: allKinds,
      searchability: ADOPTED_KINDS.map((kind) => ({ kind, canonical: 10, searchable: 5, ratio: 0.5 })),
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.missingCells).toEqual(["r3c3"]);
    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toContain("r3c3");
  });

  it("ignores cells that do not intersect the department", () => {
    const verdict = computeVerdicts({
      cells: [{ ...report(), label: "r7c7", departmentSamplePoints: 0, renderTilesOnDisk: 0 }],
      canonicalByKind: allKinds,
      searchability: ADOPTED_KINDS.map((kind) => ({ kind, canonical: 10, searchable: 5, ratio: 0.5 })),
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.missingCells).toEqual([]);
  });

  it("fails each adopted kind that is absent dataset-wide", () => {
    const partial = { ...allKinds, landuse: 0, transport: 0, place: 0, structure: 0 };
    const verdict = computeVerdicts({
      cells: [report()],
      canonicalByKind: partial,
      searchability: ADOPTED_KINDS.map((kind) => ({ kind, canonical: partial[kind] ?? 0, searchable: 1, ratio: 1 })),
    });
    expect(verdict.absentKinds).toEqual(["landuse", "transport", "place", "structure"]);
    expect(verdict.failures.filter((failure) => failure.includes("absent dataset-wide"))).toHaveLength(4);
  });

  it("fails a present kind that has no searchable record", () => {
    const verdict = computeVerdicts({
      cells: [report()],
      canonicalByKind: allKinds,
      searchability: ADOPTED_KINDS.map((kind) => ({ kind, canonical: 10, searchable: kind === "building" ? 0 : 5, ratio: kind === "building" ? 0 : 0.5 })),
    });
    expect(verdict.unsearchableKinds).toEqual(["building"]);
    expect(verdict.failures.filter((failure) => failure.includes("searchability ratio of 0"))).toHaveLength(1);
  });

  it("does not call a kind unsearchable when the dataset has no such kind at all", () => {
    const verdict = computeVerdicts({
      cells: [report()],
      canonicalByKind: { ...allKinds, building: 0 },
      searchability: ADOPTED_KINDS.map((kind) => ({ kind, canonical: 0, searchable: 0, ratio: 0 })),
    });
    expect(verdict.unsearchableKinds).toEqual([]);
    expect(verdict.absentKinds).toEqual(["building"]);
  });
});

describe("feature kind parsing", () => {
  it("reads the source prefix of a stable id", () => {
    expect(featureKind("ign-bdtopo:road/TRONROUT1")).toBe("ign-bdtopo");
    expect(featureKind("boundary:department/32")).toBe("boundary");
    expect(featureKind("noseparator")).toBeNull();
    expect(featureKind(":leading")).toBeNull();
  });
});

describe("render tile meta decoding", () => {
  it("decodes tile id, bounds and feature entries", () => {
    const meta = JSON.stringify([
      { s: "osm-bulk:n1", k: "poi", c: "village", a: [10.5, 20.25] },
      { s: "ign-bdtopo:road/R1", k: "road", c: "residential", a: [-5, 6] },
    ]);
    const header = JSON.stringify({ tileId: "l0_2_3", lod: 0, bounds: [0, 0, 2048, 2048], featureMetaOffset: 0, featureMetaBytes: new TextEncoder().encode(meta).byteLength });
    const headerBytes = new TextEncoder().encode(header);
    const metaBytes = new TextEncoder().encode(meta);
    const buffer = new ArrayBuffer(12 + headerBytes.byteLength + metaBytes.byteLength);
    const view = new DataView(buffer);
    view.setUint32(0, 0x4d4d5431, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, headerBytes.byteLength, true);
    new Uint8Array(buffer, 12, headerBytes.byteLength).set(headerBytes);
    new Uint8Array(buffer, 12 + headerBytes.byteLength, metaBytes.byteLength).set(metaBytes);
    const decoded = decodeRenderTileMeta(buffer);
    expect(decoded?.tileId).toBe("l0_2_3");
    expect(decoded?.bounds).toEqual([0, 0, 2048, 2048]);
    expect(decoded?.entries).toEqual([
      { id: "osm-bulk:n1", kind: "poi", anchor: [10.5, 20.25] },
      { id: "ign-bdtopo:road/R1", kind: "road", anchor: [-5, 6] },
    ]);
  });

  it("returns null for a buffer that is not a render tile", () => {
    expect(decodeRenderTileMeta(new ArrayBuffer(4))).toBeNull();
    const buffer = new ArrayBuffer(16);
    new DataView(buffer).setUint32(0, 0xdeadbeef, true);
    expect(decodeRenderTileMeta(buffer)).toBeNull();
  });
});

describe("streaming readers", () => {
  it("reads search records per kind from a line delimited array", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-coverage-search-"));
    const file = path.join(dir, "index.json");
    await fs.writeFile(file, `[\n${JSON.stringify({ kind: "poi" })},\n${JSON.stringify({ kind: "poi" })},\n${JSON.stringify({ kind: "road" })}\n]\n`, "utf8");
    const counts = await readSearchCounts(file);
    expect(counts.present).toBe(true);
    expect(counts.total).toBe(3);
    expect(counts.perKind).toEqual({ poi: 2, road: 1 });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports a missing search index instead of throwing", async () => {
    const counts = await readSearchCounts(path.join(os.tmpdir(), "does-not-exist-index.json"));
    expect(counts).toEqual({ present: false, total: 0, perKind: {} });
  });

  it("reads canonical records with ids, kinds and coordinates across files", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-coverage-canonical-"));
    await fs.writeFile(
      path.join(dir, "road-0001.json"),
      `[\n{"stableId":"ign-bdtopo:road/A","kind":"road","lon":0.5,"lat":43.5,"x":100.5,"z":-200.25,"name":"R \\"cit\\"e"},\n` +
        `{"stableId":"ign-bdtopo:road/B","kind":"road","localGeometry":{"type":"Point","coordinates":[1,2]},"x":1,"z":2}\n]\n`,
      "utf8",
    );
    await fs.writeFile(path.join(dir, "provenance.json"), `[{"featureId":"x"}]`, "utf8");
    const seen: Array<{ id: string; kind: string; lon: number | null; lat: number | null; x: number | null; z: number | null }> = [];
    const scan = await streamCanonicalFeatures(dir, (feature) => seen.push({ ...feature }));
    expect(scan.files).toBe(1);
    expect(scan.malformed).toBe(0);
    expect(scan.records).toBe(2);
    expect(seen[0]).toMatchObject({ id: "ign-bdtopo:road/A", kind: "road", lon: 0.5, lat: 43.5, x: 100.5, z: -200.25 });
    expect(seen[1]).toMatchObject({ id: "ign-bdtopo:road/B", kind: "road", lon: null, x: 1, z: 2 });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("counts a truncated canonical file as malformed", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-coverage-truncated-"));
    await fs.writeFile(path.join(dir, "poi.json"), `[{"stableId":"osm-bulk:n1","kind":"poi","x":1,"z":2},{"stableId":"osm-bulk:n2","ki`, "utf8");
    const scan = await streamCanonicalFeatures(dir, () => undefined);
    expect(scan.files).toBe(1);
    expect(scan.malformed).toBe(1);
    expect(scan.records).toBe(1);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("end to end on a synthetic dataset", () => {
  async function synthetic(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-coverage-dataset-"));
    const generated = path.join(dir, "generated");
    const render = path.join(generated, "render");
    const intermediate = path.join(dir, "intermediate");
    const search = path.join(dir, "search");
    const raw = path.join(dir, "raw");
    await fs.mkdir(render, { recursive: true });
    await fs.mkdir(intermediate, { recursive: true });
    await fs.mkdir(search, { recursive: true });
    await fs.mkdir(raw, { recursive: true });
    const boundary = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[[0.2, 43.4], [0.9, 43.4], [0.9, 43.8], [0.2, 43.8], [0.2, 43.4]]] } }],
    };
    await fs.writeFile(path.join(raw, "gers-boundary.geojson"), JSON.stringify(boundary), "utf8");
    await fs.writeFile(
      path.join(generated, "manifest.json"),
      JSON.stringify({ datasetVersion: "test-1", territoryCode: "32", bounds: [-2000, -2000, 6000, 6000], featureCounts: { road: 4, poi: 2 } }),
      "utf8",
    );
    await fs.writeFile(path.join(generated, "tile-manifest.json"), JSON.stringify([
      { tileId: "l0_0_0", lod: 0, bounds: [-2000, -2000, 48, 48], featureCount: 1, byteSize: 10, features: [] },
      { tileId: "l1_0_0", lod: 1, bounds: [-2000, -2000, 6160, 6160], featureCount: 0, byteSize: 10, features: [] },
    ]), "utf8");
    await fs.writeFile(path.join(intermediate, "road.json"), JSON.stringify([
      { stableId: "ign-bdtopo:road/A", kind: "road", lon: 0.5, lat: 43.5, x: 0, z: 0 },
      { stableId: "ign-bdtopo:road/B", kind: "road", lon: 0.5, lat: 43.5, x: 1, z: 1 },
    ]), "utf8");
    await fs.writeFile(
      path.join(search, "index.json"),
      `[\n${JSON.stringify({ kind: "road" })}\n]\n`,
      "utf8",
    );
    return dir;
  }

  it("passes verdicts and counts cells from a dataset that covers the department", async () => {
    const dir = await synthetic();
    const report = await runCoverageReport({ dataRoot: dir, canonicalDir: path.join(dir, "intermediate") });
    expect(report.datasetVersion).toBe("test-1");
    expect(report.cells.length).toBeGreaterThan(0);
    expect(report.tiles.declared).toBe(2);
    expect(report.tiles.lod0Declared).toBe(1);
    expect(report.tiles.lod0RenderTilesOnDisk).toBe(0);
    expect(report.inputs.canonicalRecordsRead).toBe(2);
    expect(report.searchability.indexRecords).toBe(1);
    const road = report.searchability.perKind.find((entry) => entry.kind === "road");
    expect(road).toEqual({ kind: "road", canonical: 4, searchable: 1, ratio: 0.25 });
    expect(report.verdicts.failures.some((failure) => failure.includes("has 0 tiles on disk"))).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes a report whose cell list covers the department cells only", async () => {
    const dir = await synthetic();
    const report = await runCoverageReport({ dataRoot: dir, canonicalDir: path.join(dir, "intermediate") });
    expect(report.cells.length).toBe(report.grid.cellsIntersectingDepartment);
    expect(report.cells.length).toBeLessThan(64);
    for (const cell of report.cells) expect(cell.departmentSamplePoints).toBeGreaterThan(0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("coverage report artefact", () => {
  it("is written to data/qa with grid, kinds, percentiles and verdicts", async () => {
    const file = path.join("data", "qa", "coverage-report.json");
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    expect(parsed["grid"]).toBeDefined();
    expect(parsed["kinds"]).toBeDefined();
    expect(parsed["cells"]).toBeDefined();
    expect(parsed["lod0Payload"]).toBeDefined();
    expect(parsed["searchability"]).toBeDefined();
    const verdicts = parsed["verdicts"] as { passed: boolean; failures: string[] };
    expect(typeof verdicts.passed).toBe("boolean");
    expect(Array.isArray(verdicts.failures)).toBe(true);
    expect((await fs.stat(file)).size).toBeGreaterThan(0);
  });
});
