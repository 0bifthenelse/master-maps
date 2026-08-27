import { describe, expect, it } from "vitest";
import { normalizeBusinesses } from "../../scripts/data/normalize";

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

describe("business source normalization", () => {
  it("retains identity, activity, address, and provenance fields", () => {
    const businesses = normalizeBusinesses({
      sourceUrl: "https://recherche-entreprises.api.gouv.fr",
      license: "Licence Ouverte / Open Licence 2.0",
      acquiredAt: "2026-08-27T00:00:00Z",
      records: [{
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
      }],
    }, boundary, { status: "error", body: null }, { results: [] });

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
  });
});
