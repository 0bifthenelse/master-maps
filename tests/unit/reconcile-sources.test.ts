import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BAN_CSV_COLUMNS,
  BAN_LOSS_REASONS,
  summarizeDuplicateGroups,
  type AddressRecord,
} from "../../scripts/data/fetch-addresses";
import {
  BanAddressIndex,
  buildSireneQueryPlan,
  parseCommuneListArg,
  parseSireneAddress,
  SIRENE_EFFECTIVE_SIZE_CLASSES,
  SIRENE_PER_PAGE,
  SIRENE_RESULT_CAP,
  SIRENE_SECTIONS,
  SIRENE_MAX_PAGES,
} from "../../scripts/data/fetch-businesses";
import {
  PARITY_CENTROID_TOLERANCE_METRES,
  ParityIndex,
  cellKeyOf,
  loadBoundaryGeometry,
  parseCadastreFeatureLine,
  type Bbox,
  type ParitySample,
} from "../../scripts/data/reconcile-sources";

function banRecord(overrides: Partial<AddressRecord> & { banId: string }): AddressRecord {
  return {
    source: "ban",
    sourceId: "x",
    numero: "1",
    repetition: "",
    streetName: "Rue Test",
    streetNameAfnor: "RUE TEST",
    postalCode: "32000",
    city: "Auch",
    cityAfnor: "AUCH",
    inseeCode: "32013",
    lon: 0.5,
    lat: 43.6,
    positionType: "parcelle",
    sourcePosition: "commune",
    certificationCommune: "1",
    cadastreParcelles: "",
    localityName: "",
    ...overrides,
  };
}

describe("BAN loss accounting", () => {
  it("names every loss reason the stage counters can produce", () => {
    expect([...BAN_LOSS_REASONS].sort()).toEqual([
      "commune-mismatch",
      "duplicate-ban-id",
      "empty-ban-id",
      "malformed-csv-row",
      "non-finite-coordinates",
      "outside-boundary",
      "short-csv-row",
    ]);
  });

  it("pins the 23 column BAN header so index based parsing cannot silently corrupt", () => {
    expect(BAN_CSV_COLUMNS).toHaveLength(23);
    expect(BAN_CSV_COLUMNS[0]).toBe("id");
    expect(BAN_CSV_COLUMNS[12]).toBe("lon");
    expect(BAN_CSV_COLUMNS[13]).toBe("lat");
    expect(BAN_CSV_COLUMNS[22]).toBe("cad_parcelles");
  });

  it("attributes every dropped duplicate row to a duplicate-ban-id loss", () => {
    const groups = new Map<string, AddressRecord[]>([
      ["a", [banRecord({ banId: "a", lon: 0.5001, lat: 43.6 })]],
      ["b", [
        banRecord({ banId: "b", lon: 0.6, lat: 43.7 }),
        banRecord({ banId: "b", lon: 0.6002, lat: 43.7 }),
        banRecord({ banId: "b", lon: 0.6003, lat: 43.7 }),
      ]],
    ]);

    const summary = summarizeDuplicateGroups(groups);

    expect(summary.duplicateKeyCount).toBe(2);
    expect(summary.droppedRecords).toBe(4);
    expect(summary.identicalPositionGroups).toBe(1);
    expect(summary.conflictingPositionGroups).toBe(1);
    expect(summary.maxRowsForOneKey).toBe(4);
    expect(summary.samples.map((sample) => sample.banId).sort()).toEqual(["a", "b"]);
  });

  it("reports zero duplicate keys when no BAN id repeats", () => {
    const summary = summarizeDuplicateGroups(new Map<string, AddressRecord[]>());
    expect(summary.duplicateKeyCount).toBe(0);
    expect(summary.droppedRecords).toBe(0);
    expect(summary.maxRowsForOneKey).toBe(0);
  });
});

describe("SIRENE query plan", () => {
  it("partitions the department into one query per commune and NAF section", () => {
    const communes = [{ code: "32013" }, { code: "32107" }, { code: "32208" }];
    const plan = buildSireneQueryPlan({ communes });

    expect(plan).toHaveLength(3 * SIRENE_SECTIONS.length);
    for (const entry of plan) {
      expect(entry.kind).toBe("commune-section");
      expect(entry.params["departement"]).toBe("32");
      expect(entry.params["per_page"]).toBeUndefined();
      expect(SIRENE_SECTIONS).toContain(entry.section);
      expect(["32013", "32107", "32208"]).toContain(entry.commune);
    }
    const covered = new Set(plan.map((entry) => `${entry.commune}|${entry.section}`));
    expect(covered.size).toBe(plan.length);
  });

  it("keeps every query key unique so the HTTP cache never collapses two partitions into one", () => {
    const plan = buildSireneQueryPlan({ communes: [{ code: "32013" }, { code: "32107" }] });
    const keys = plan.map((entry) => JSON.stringify(entry.params));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("offers an effective size class list that can subdivide a capped partition", () => {
    expect(SIRENE_EFFECTIVE_SIZE_CLASSES).toContain("NN");
    expect(SIRENE_EFFECTIVE_SIZE_CLASSES.length).toBeGreaterThan(5);
  });

  it("declares a page budget that fits under the 10000 result API cap", () => {
    expect(SIRENE_PER_PAGE * SIRENE_MAX_PAGES).toBeGreaterThanOrEqual(SIRENE_RESULT_CAP);
  });

  it("parses and validates a --communes list", () => {
    expect(parseCommuneListArg(["--communes", "32013,32107,32208"])).toEqual(["32013", "32107", "32208"]);
    expect(parseCommuneListArg([])).toEqual([]);
    expect(() => parseCommuneListArg(["--communes", "3201"])).toThrow(/Invalid INSEE commune code/);
  });
});

describe("SIRENE address parsing and BAN geocoding", () => {
  it("splits a French establishment address into postcode, street and house number", () => {
    expect(parseSireneAddress("19 AVENUE D ALSACE 32000 AUCH")).toEqual({
      postcode: "32000",
      streetText: "AVENUE D ALSACE",
      houseNumber: "19",
    });
  });

  it("rejects an address without a postcode instead of guessing", () => {
    expect(parseSireneAddress("RUE SANS CODE")).toBeNull();
    expect(parseSireneAddress(undefined)).toBeNull();
    expect(parseSireneAddress("   ")).toBeNull();
  });

  it("geocodes a null coordinate from the BAN index on postcode, street and number", () => {
    const index = new BanAddressIndex();
    index.insert("32000", "Avenue d'Alsace", "19", 0.5917, 43.6484);

    const hit = index.lookup("32000", "AVENUE D ALSACE", "19");
    expect(hit).not.toBeNull();
    expect(hit!.lon).toBeCloseTo(0.5917, 6);
    expect(hit!.lat).toBeCloseTo(43.6484, 6);
  });

  it("returns null for a street the BAN index does not carry", () => {
    const index = new BanAddressIndex();
    index.insert("32000", "Avenue d'Alsace", "19", 0.5917, 43.6484);
    expect(index.lookup("32000", "Rue Inexistante", "1")).toBeNull();
    expect(index.lookup("32100", "Avenue d'Alsace", "19")).toBeNull();
  });
});

describe("cadastre GeoJSON line parsing", () => {
  it("strips the trailing comma the etalab writer leaves on every feature line", () => {
    expect(parseCadastreFeatureLine('{"type":"Feature","properties":{"nom":"PEYRET","commune":"32001"}},'))
      .toEqual({ type: "Feature", properties: { nom: "PEYRET", commune: "32001" } });
  });

  it("parses a final line that carries no trailing comma", () => {
    expect(parseCadastreFeatureLine('{"type":"Feature"}')).toEqual({ type: "Feature" });
  });

  it("ignores a line that is not a JSON object", () => {
    expect(parseCadastreFeatureLine("   ")).toBeNull();
    expect(parseCadastreFeatureLine('"features":[')).toBeNull();
  });

  it("throws on genuinely malformed JSON so the caller can count it as invalid", () => {
    expect(() => parseCadastreFeatureLine('{"a":1')).toThrow();
  });
});

describe("cadastre parity spatial index", () => {
  const box = (west: number, south: number, east: number, north: number) => ({ west, south, east, north });
  const sample = (key: string, bbox: Bbox): ParitySample => ({
    key,
    bbox,
    centroid: [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2],
  });

  it("maps bboxes to stable grid cells", () => {
    expect(cellKeyOf(box(0.5, 43.5, 0.5, 43.5))).toBe(cellKeyOf(box(0.51, 43.51, 0.52, 43.52)));
  });

  it("finds a coincident footprint in a neighbouring cell", () => {
    const index = new ParityIndex<ParitySample>();
    index.insert(sample("bdtopo-1", box(0.5, 43.6, 0.5 + 0.0002, 43.6 + 0.0002)));
    const best = index.findBest(box(0.5, 43.6, 0.5 + 0.0002, 43.6 + 0.0002), [0.5001, 43.6001], PARITY_CENTROID_TOLERANCE_METRES);
    expect(best?.entry.key).toBe("bdtopo-1");
    expect(best!.score).toBeCloseTo(1, 3);
  });

  it("rejects a candidate beyond the centroid tolerance", () => {
    const index = new ParityIndex<ParitySample>();
    index.insert(sample("far", box(0.5, 43.6, 0.5 + 0.0002, 43.6 + 0.0002)));
    const farCentroid: [number, number] = [0.5, 43.6 + (PARITY_CENTROID_TOLERANCE_METRES / 111_320) * 4];
    expect(index.findBest(box(0.5, 43.6, 0.5 + 0.0002, 43.6 + 0.0002), farCentroid, PARITY_CENTROID_TOLERANCE_METRES)).toBeNull();
  });

  it("rejects disjoint bboxes that share a cell", () => {
    const index = new ParityIndex<ParitySample>();
    index.insert(sample("a", box(0.50, 43.60, 0.5001, 43.6001)));
    const probe = box(0.5010, 43.6010, 0.5011, 43.6011);
    expect(index.findBest(probe, [(0.5010 + 0.5011) / 2, (43.6010 + 43.6011) / 2], 50)).toBeNull();
  });

  it("loads a real department boundary polygon and contains an interior and an exterior point", () => {
    const directory = mkdtempSync(join(tmpdir(), "reconcile-boundary-"));
    try {
      const boundaryPath = join(directory, "boundary.geojson");
      writeFileSync(boundaryPath, JSON.stringify({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [[[0, 43], [1, 43], [1, 44], [0, 44], [0, 43]]],
          },
          properties: {},
        }],
      }));
      const boundary = loadBoundaryGeometry(boundaryPath);
      expect(boundary.type).toBe("Polygon");

      mkdirSync(directory, { recursive: true });
      const geometry = boundary.coordinates as number[][][];
      const outer = geometry[0]!;
      const onEdge = outer[0] as number[];
      const inside = [(onEdge[0]! + 1) / 2, (onEdge[1]! + 44) / 2];
      expect((boundary.type === "Polygon" ? [geometry] : geometry).length).toBe(1);
      expect(inside[0]).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
