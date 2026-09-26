import { describe, expect, it } from "vitest";
import {
  buildParityRow,
  compareOsmParity,
  summarizeParity,
  type CanonicalTally,
  type OsmCategorySpec,
} from "../../scripts/data/parity-osm";

function tally(osmByField: Record<string, Record<string, number>>, total = 0, osm = 0): CanonicalTally {
  return { total, osm, byField: {}, osmByField };
}

function spec(overrides: Partial<OsmCategorySpec> & Pick<OsmCategorySpec, "id" | "canonical">): OsmCategorySpec {
  return {
    label: overrides.id,
    key: "highway",
    values: "*",
    objectType: "way",
    ...overrides,
  };
}

describe("OSM parity comparison", () => {
  it("marks a fully matched category as represented", () => {
    const row = buildParityRow(
      spec({ id: "road", canonical: { kind: "road", field: "roadClass", origin: "osm" } }),
      new Map([["track", 100], ["service", 40]]),
      new Map([["road", tally({ roadClass: { track: 100, service: 40 } }, 140, 140)]]),
    );
    expect(row.verdict).toBe("represented");
    expect(row.osmCount).toBe(140);
    expect(row.canonicalCount).toBe(140);
    expect(row.ratio).toBe(1);
    expect(row.reason).toBeUndefined();
  });

  it("separates osm-sourced canonical counts from other sources", () => {
    const row = buildParityRow(
      spec({ id: "road", canonical: { kind: "road", field: "roadClass", origin: "osm" } }),
      new Map([["track", 100]]),
      new Map([["road", { total: 200, osm: 100, byField: { roadClass: { track: 100 } }, osmByField: { roadClass: { track: 100 } } }]]),
    );
    expect(row.canonicalCount).toBe(100);
    expect(row.verdict).toBe("represented");
  });

  it("marks a zero canonical count against a non-empty extract as missing", () => {
    const row = buildParityRow(
      spec({ id: "landuse", canonical: { kind: "landuse", field: "landuseType", origin: "osm" } }),
      new Map([["forest", 21285], ["farmland", 15273]]),
      new Map(),
    );
    expect(row.verdict).toBe("missing");
    expect(row.osmCount).toBe(36558);
    expect(row.canonicalCount).toBe(0);
    expect(row.ratio).toBe(0);
    expect(row.reason).toContain("no kind landuse feature");
  });

  it("counts a category absent from the extract as represented with nothing to do", () => {
    const row = buildParityRow(
      spec({ id: "absent", key: "aeroway", canonical: { kind: "transport", field: "transportType", origin: "osm" } }),
      new Map(),
      new Map(),
    );
    expect(row.verdict).toBe("represented");
    expect(row.osmCount).toBe(0);
    expect(row.reason).toContain("no object with this key");
  });

  it("reports a partial match as partially-represented below the 0.95 threshold", () => {
    const row = buildParityRow(
      spec({ id: "road", canonical: { kind: "road", field: "roadClass", origin: "osm" } }),
      new Map([["service", 78770], ["track", 27775]]),
      new Map([["road", tally({ roadClass: { service: 3313, track: 26488 } }, 54410, 54410)]]),
    );
    expect(row.verdict).toBe("partially-represented");
    expect(row.osmCount).toBe(106545);
    expect(row.canonicalCount).toBe(29801);
    expect(row.ratio).toBeCloseTo(0.2797, 3);
    expect(row.reason).toContain("retention, clipping or dedup");
  });

  it("never reports a zero canonical count as represented when the extract is non-empty", () => {
    for (const origin of ["osm", "all"] as const) {
      const row = buildParityRow(
        spec({ id: "place", canonical: { kind: "place", field: "placeType", origin } }),
        new Map([["village", 468]]),
        new Map(),
      );
      expect(row.canonicalCount).toBe(0);
      expect(row.verdict).not.toBe("represented");
    }
  });

  it("keeps an excluded category excluded even when canonical holds a few objects", () => {
    const row = buildParityRow(
      spec({
        id: "excluded.barrier",
        key: "barrier",
        objectType: "any",
        canonical: { kind: "structure", field: "structureType", origin: "osm" },
        exclusionReason: "barrier is not adopted",
      }),
      new Map([["fence", 50000]]),
      new Map([["poi", tally({ poiType: { fence: 5 } }, 5, 5)]]),
    );
    expect(row.verdict).toBe("excluded-by-policy");
    expect(row.canonicalCount).toBe(0);
    expect(row.reason).toBe("barrier is not adopted");
  });

  it("routes a zero covered by an adoption note to adopted-from-other-source instead of missing", () => {
    const row = buildParityRow(
      spec({
        id: "building",
        key: "building",
        canonical: { kind: "building", field: "buildingType", origin: "osm" },
        adoptionNote: "adopted from BD TOPO batiment",
      }),
      new Map([["yes", 315950]]),
      new Map([["building", { total: 305761, osm: 0, byField: { buildingType: { yes: 305761 } }, osmByField: {} }]]),
    );
    expect(row.verdict).toBe("adopted-from-other-source");
    expect(row.canonicalCount).toBe(0);
    expect(row.reason).toBe("adopted from BD TOPO batiment");
  });

  it("sums only the canonical values observed in the extract, not every value of the field", () => {
    const row = buildParityRow(
      spec({ id: "shop", key: "shop", objectType: "node", canonical: { kind: "poi", field: "poiType", origin: "osm" } }),
      new Map([["bakery", 82], ["hairdresser", 72]]),
      new Map([["poi", tally({ poiType: { bakery: 82, hairdresser: 72, bench: 787 } }, 941, 941)]]),
    );
    expect(row.canonicalCount).toBe(154);
    expect(row.osmCount).toBe(154);
  });

  it("lists every unexplained zero in missing and counts each verdict once", () => {
    const specs = [
      spec({ id: "landuse", canonical: { kind: "landuse", field: "landuseType", origin: "osm" } }),
      spec({ id: "place", canonical: { kind: "place", field: "placeType", origin: "osm" } }),
      spec({ id: "road", canonical: { kind: "road", field: "roadClass", origin: "osm" } }),
      spec({ id: "excluded.power", key: "power", canonical: { kind: "structure", field: "structureType", origin: "osm" }, exclusionReason: "not adopted" }),
    ];
    const counts = new Map([
      ["landuse", new Map([["forest", 21285]])],
      ["place", new Map([["village", 468]])],
      ["road", new Map([["track", 100]])],
      ["excluded.power", new Map([["line", 6391]])],
    ]);
    const tallies = new Map([["road", tally({ roadClass: { track: 100 } }, 100, 100)]]);
    const { rows, missing } = compareOsmParity(specs, counts, tallies);
    expect(missing).toEqual(["landuse", "place"]);
    expect(rows).toHaveLength(4);
    expect(summarizeParity(rows, missing)).toEqual({
      represented: 1,
      partiallyRepresented: 0,
      missing: 2,
      excluded: 1,
      adoptedFromOtherSource: 0,
    });
  });

  it("produces no missing entry when a spec has no osmium data at all", () => {
    const { rows, missing } = compareOsmParity(
      [spec({ id: "landuse", canonical: { kind: "landuse", field: "landuseType", origin: "osm" } })],
      new Map(),
      new Map(),
    );
    expect(missing).toEqual([]);
    expect(rows[0]?.verdict).toBe("represented");
  });
});
