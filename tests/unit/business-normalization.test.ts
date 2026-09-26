import { describe, expect, it } from "vitest";
import { normalizeBusinesses, type BusinessSources } from "../../scripts/data/normalize";

const boundary = {
  kind: "boundary" as const,
  stableId: "boundary",
  lon: 0,
  lat: 0,
  x: 0,
  z: 0,
  rings: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
  centroidX: 0,
  centroidZ: 0,
  geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  localGeometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  provenance: [],
  confidence: 1,
  status: "active" as const,
  sourceRefs: [],
};

function sireneSources(records: Array<Record<string, unknown>>): BusinessSources {
  return {
    file: "",
    header: {
      sourceUrl: "https://recherche-entreprises.api.gouv.fr/search",
      license: "Licence Ouverte / Open Licence 2.0",
      acquiredAt: "2026-09-26T00:00:00Z",
    },
    records,
    osm: { status: "error", body: null },
    web: { results: [] },
  };
}

describe("business source normalization", () => {
  it("retains identity, activity, address, and provenance fields", async () => {
    const businesses = await normalizeBusinesses(sireneSources([{
      siret: "12345678901234",
      siren: "123456789",
      legalName: "Example Legal Name",
      tradingName: "Example Shop",
      nafCode: "47.75Z",
      nafLabel: "Retail",
      address: "1 Rue Source 32000 Auch",
      coordinate: { lon: 5, lat: 5 },
      administrativeStatus: "A",
      creationDate: "2020-01-02",
    }]), boundary);

    expect(businesses).toHaveLength(1);
    expect(businesses[0]).toMatchObject({
      businessName: "Example Shop",
      legalName: "Example Legal Name",
      brand: "Example Shop",
      category: "Retail",
      nafCode: "47.75Z",
      nafLabel: "Retail",
      address: "1 Rue Source 32000 Auch",
      siret: "12345678901234",
      siren: "123456789",
      administrativeStatus: "A",
      creationDate: "2020-01-02",
      status: "active",
    });
    expect(businesses[0].sourceRefs).toContainEqual(expect.objectContaining({ source: "sirene" }));
    expect(businesses[0].sourceRefs[0]?.url).toBe("https://recherche-entreprises.api.gouv.fr/search");
  });
});

describe("department wide SIRENE records", () => {
  it("keeps a record geocoded through the BAN address match", async () => {
    const businesses = await normalizeBusinesses(sireneSources([{
      siret: "35378389700013",
      siren: "353783897",
      legalName: "ASSOCIE SNC CAHUZAC",
      tradingName: "CAHUZAC",
      nafCode: "47.73Z",
      nafLabel: "Commerce de detail d alimentation generale",
      address: "19 AVENUE D ALSACE 32000 AUCH",
      coordinate: { lon: 5, lat: 5 },
      administrativeStatus: "A",
    }]), boundary);

    expect(businesses).toHaveLength(1);
    expect(businesses[0]).toMatchObject({
      stableId: "business:siret/35378389700013",
      siret: "35378389700013",
      businessName: "CAHUZAC",
      nafCode: "47.73Z",
      nafLabel: "Commerce de detail d alimentation generale",
      address: "19 AVENUE D ALSACE 32000 AUCH",
    });
  });

  it("drops a department wide record that still has no coordinate after BAN geocoding", async () => {
    const businesses = await normalizeBusinesses(sireneSources([{
      siret: "99999999900011",
      legalName: "SANS COORDONNEES",
      nafCode: "01.11Z",
      address: "1 LIEU DIT 32230 Touget",
      coordinate: null,
    }]), boundary);

    expect(businesses).toHaveLength(0);
  });

  it("keeps one feature per SIRET when the same establishment is returned by two partitions", async () => {
    const shared = {
      siret: "35378389700013",
      legalName: "ASSOCIE SNC CAHUZAC",
      nafCode: "47.73Z",
      coordinate: { lon: 5, lat: 5 },
    };
    const businesses = await normalizeBusinesses(sireneSources([
      { ...shared, tradingName: "CAHUZAC", acquiredFromQuery: { q: "commune 32013", page: 1 } },
      { ...shared, tradingName: "CAHUZAC", acquiredFromQuery: { q: "departement 32 section G", page: 7 } },
    ]), boundary);

    expect(businesses).toHaveLength(1);
  });

  it("keeps distinct establishments with the same trading name at different addresses", async () => {
    const businesses = await normalizeBusinesses(sireneSources([
      { siret: "11111111100011", tradingName: "BOULANGERIE", nafCode: "10.71C", coordinate: { lon: 1, lat: 1 } },
      { siret: "22222222200022", tradingName: "BOULANGERIE", nafCode: "10.71C", coordinate: { lon: 9, lat: 9 } },
    ]), boundary);

    expect(businesses.map((business) => business.stableId)).toEqual([
      "business:siret/11111111100011",
      "business:siret/22222222200022",
    ]);
  });
});
