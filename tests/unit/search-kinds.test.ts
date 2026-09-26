import { describe, expect, it } from "vitest";
import { buildSearchIndex } from "../../scripts/data/build-search-index";
import type { MapFeature } from "@/lib/data/schema";

function feature(overrides: Partial<MapFeature> & Pick<MapFeature, "stableId" | "kind" | "geometry">): MapFeature {
  return {
    lon: 0.5,
    lat: 43.6,
    confidence: "medium",
    status: "active",
    names: [],
    provenance: [],
    sourceRefs: [],
    ...overrides,
  } as MapFeature;
}

const TILE_MAP = new Map<string, string>([
  ["place-auch", "l0_0_17"],
  ["place-hameau", "l0_0_17"],
  ["transport-gare", "l0_0_18"],
  ["transport-bus", "l0_0_18"],
  ["road-named", "l0_0_19"],
  ["poi-named", "l0_0_19"],
  ["business-named", "l0_0_20"],
  ["address-full", "l0_0_20"],
  ["place-unnamed", "l0_0_17"],
]);

const FEATURES: MapFeature[] = [
  feature({ stableId: "place-auch", kind: "place", geometry: { type: "Point", coordinates: [0.5, 43.6] }, name: "Auch", placeType: "commune", importance: 6, population: 22000 }),
  feature({ stableId: "place-hameau", kind: "place", geometry: { type: "Point", coordinates: [0.5, 43.6] }, name: "Sainte-Marie", placeType: "lieu_dit_non_habite" }),
  feature({ stableId: "transport-gare", kind: "transport", geometry: { type: "Point", coordinates: [0.5, 43.6] }, name: "Gare d'Auch", transportType: "station", publicTransport: "station" }),
  feature({ stableId: "transport-bus", kind: "transport", geometry: { type: "Point", coordinates: [0.5, 43.6] }, name: "Arret du Marche", transportType: "bus_stop" }),
  feature({ stableId: "road-named", kind: "road", geometry: { type: "Point", coordinates: [0.5, 43.6] }, name: "Boulevard Carnot", roadClass: "secondary" }),
  feature({ stableId: "poi-named", kind: "poi", geometry: { type: "Point", coordinates: [0.5, 43.6] }, name: "Tour d'Armagnac", poiType: "monument" }),
  feature({ stableId: "business-named", kind: "business", geometry: { type: "Point", coordinates: [0.5, 43.6] }, businessName: "NOCIBE", category: "beauty" }),
  feature({ stableId: "address-full", kind: "address", geometry: { type: "Point", coordinates: [0.5, 43.6] }, street: "Rue Nationale", housenumber: "12", postcode: "32000", city: "Auch" }),
  feature({ stableId: "place-unnamed", kind: "place", geometry: { type: "Point", coordinates: [0.5, 43.6] }, placeType: "detail_orographique" }),
];

const RECORDS = buildSearchIndex(FEATURES, TILE_MAP, "unused");

function byId(stableId: string) {
  const record = RECORDS.find((candidate) => candidate.featureId === stableId);
  if (!record) throw new Error(`missing record for ${stableId}`);
  return record;
}

describe("buildSearchIndex place and transport coverage", () => {
  it("indexes every named place, transport, poi, business, address and road record", () => {
    const indexed = new Set(RECORDS.map((record) => record.featureId));
    for (const stableId of ["place-auch", "place-hameau", "transport-gare", "transport-bus", "road-named", "poi-named", "business-named", "address-full"]) {
      expect(indexed.has(stableId)).toBe(true);
    }
  });

  it("skips a place record with no resolvable name", () => {
    expect(RECORDS.some((record) => record.featureId === "place-unnamed")).toBe(false);
  });

  it("ranks a higher importance settlement above a lesser one", () => {
    expect(byId("place-auch").boost).toBeGreaterThan(byId("place-hameau").boost);
  });

  it("boosts a station above a bus stop", () => {
    expect(byId("transport-gare").boost).toBeGreaterThan(byId("transport-bus").boost);
  });

  it("exposes the place type as the record category", () => {
    expect(byId("place-auch").category).toBe("commune");
    expect(byId("place-hameau").category).toBe("lieu_dit_non_habite");
  });

  it("exposes the transport classification as the record category", () => {
    expect(byId("transport-gare").category).toBe("station");
    expect(byId("transport-bus").category).toBe("bus_stop");
  });

  it("composes a searchable name for an address that only has its street parts", () => {
    const record = byId("address-full");
    expect(record.canonicalName).toBe("12 Rue Nationale 32000 Auch");
    expect(record.normalizedName).toContain("rue nationale");
  });

  it("keeps the address street as an alias for street only queries", () => {
    expect(byId("address-full").aliases).toContain("rue nationale");
  });

  it("keeps the transport name as an alias", () => {
    expect(byId("transport-gare").aliases).toContain("gare d'auch");
  });
});
