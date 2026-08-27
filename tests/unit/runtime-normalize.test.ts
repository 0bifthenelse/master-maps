import { describe, expect, it } from "vitest";
import { LocalProjection } from "@/lib/geo/projection";
import {
  clipToBoundary,
  deriveLocalCoords,
  normalizeBusiness,
  normalizeWater,
  type Geometry,
} from "@/lib/data/normalize";

const square: Geometry = {
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
};
const source = { source: "osm", timestamp: "2026-08-27T00:00:00Z" };

describe("runtime normalization geometry contract", () => {
  it("clips points, lines, and polygons to the actual boundary", () => {
    expect(clipToBoundary({ type: "Point", coordinates: [20, 20] }, square)).toBeNull();
    expect(clipToBoundary({ type: "LineString", coordinates: [[-5, 5], [15, 5]] }, square)).toEqual({
      type: "LineString",
      coordinates: [[0, 5], [10, 5]],
    });
    expect(clipToBoundary({
      type: "Polygon",
      coordinates: [[[-5, 2], [5, 2], [5, 8], [-5, 8], [-5, 2]]],
    }, square)).toEqual({
      type: "Polygon",
      coordinates: [[[0, 2], [5, 2], [5, 8], [0, 8], [0, 2]]],
    });
  });

  it("keeps north-positive local projection and renders open water", () => {
    const projection = new LocalProjection([0, 0]);
    const local = deriveLocalCoords({ type: "LineString", coordinates: [[0, 0], [0, 1]] }, projection);
    expect(local).toEqual({
      type: "LineString",
      coordinates: [[0, 0], [0, expect.any(Number)]],
    });
    expect(local.type === "LineString" ? local.coordinates[1][1] : 0).toBeGreaterThan(0);

    const water = normalizeWater({
      id: "way/river",
      tags: { waterway: "river", name: "Gers" },
      geometry: { type: "LineString", coordinates: [[-5, 5], [15, 5]] },
    }, source, square, projection);
    expect(water?.geometry).toEqual({ type: "LineString", coordinates: [[0, 5], [10, 5]] });
    expect(water?.widthMetadata).toEqual({ width: 10, widthSource: "category_default" });
  });

  it("retains verified business metadata", () => {
    const business = normalizeBusiness({
      siret: "12345678901234",
      siren: "123456789",
      denomination: "Example Legal Name",
      denominationUniteLegale: "Example Legal Name",
      enseigne1: "Example Shop",
      longitude: 5,
      latitude: 5,
      libelleActivitePrincipale: "Retail",
      activitePrincipale: "47.75Z",
      numeroVoie: "28",
      typeVoie: "avenue",
      libelleVoie: "d'Alsace",
      codePostal: "32000",
      libelleCommune: "Auch",
    }, { source: "sirene", timestamp: "2026-08-27T00:00:00Z" }, square);
    expect(business).toMatchObject({
      businessName: "Example Shop",
      legalName: "Example Legal Name",
      siret: "12345678901234",
      siren: "123456789",
      category: "Retail",
      address: "28 avenue d'Alsace, 32000, Auch",
    });
  });
});
