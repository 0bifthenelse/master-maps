import { describe, expect, it } from "vitest";
import { conflateBusinesses, nameSimilarity } from "../../scripts/data/conflate";
import { categoryFamily, categoryForFreeText, categoryForNaf, categoryForOsmTags, categoryIntents, nafIsPlace } from "@/lib/data/categories";
import { capitaliseCompounds, displayCase, displayStreetName, tidyLabel } from "@/lib/data/displayText";
import { formatDay, openState, parseOpeningHours } from "@/lib/data/openingHours";
import type { BusinessFeature, PoiFeature } from "@/lib/data/schema";

describe("category taxonomy", () => {
  it("maps NAF codes and OSM tags onto the same category", () => {
    expect(categoryForNaf("47.73Z")).toBe("pharmacy");
    expect(categoryForOsmTags({ amenity: "pharmacy" })).toBe("pharmacy");
    expect(categoryForNaf("10.71C")).toBe("bakery");
    expect(categoryForOsmTags({ shop: "bakery" })).toBe("bakery");
    expect(categoryForNaf("56.10A")).toBe("restaurant");
    expect(categoryForOsmTags({ amenity: "restaurant" })).toBe("restaurant");
  });

  it("drops holding companies and other non-places", () => {
    expect(nafIsPlace("64.20Z")).toBe(false);
    expect(nafIsPlace("68.20B")).toBe(false);
    expect(nafIsPlace("47.73Z")).toBe(true);
  });

  it("reads category words in French or English, singular or plural", () => {
    expect(categoryIntents(["pharmacie", "auch"]).map((intent) => intent.category)).toEqual(["pharmacy"]);
    expect(categoryIntents(["pharmacies"])[0]?.category).toBe("pharmacy");
    expect(categoryIntents(["station", "service"])[0]).toEqual({ category: "fuel", consumed: [0, 1] });
    expect(categoryIntents(["auch"])).toEqual([]);
  });

  it("prefers whole words to prefixes and still completes a word being typed", () => {
    expect(categoryIntents(["gare"])[0]?.category).toBe("train_station");
    expect(categoryIntents(["restau"])[0]?.category).toBe("restaurant");
  });

  it("classifies a free-text label by what the place is, not where it is", () => {
    expect(categoryForFreeText("Le Relais de la Gare")).toBeUndefined();
    expect(categoryForFreeText("Hôtel de la Poste")).toBe("hotel");
    expect(categoryForFreeText("Hôtel de Ville")).toBe("town_hall");
    expect(categoryForFreeText("Station d'épuration")).toBe("utility");
    expect(categoryForFreeText("Station Dyneff")).toBeUndefined();
    expect(categoryForFreeText("Gare SNCF")).toBe("train_station");
  });

  it("widens chips to their neighbouring categories", () => {
    expect(categoryFamily("bank")).toEqual(["bank", "atm"]);
    expect(categoryFamily("pharmacy")).toEqual(["pharmacy"]);
  });
});

describe("OSM and SIRENE conflation", () => {
  const poi = (name: string, x: number): PoiFeature => ({
    kind: "poi", stableId: `osm:${name}:${x}`, poiType: "pharmacy", category: "pharmacy", name, x, z: 0,
    geometry: { type: "Point", coordinates: [0.58, 43.64] }, localGeometry: { type: "Point", coordinates: [x, 0] },
    phone: "+33 5 62 00 00 00", openingHours: "Mo-Sa 09:00-19:00", names: [], confidence: "high", status: "active", provenance: [], sourceRefs: [{ source: "osm", timestamp: "2026" }],
  });
  const business = (name: string, x: number): BusinessFeature => ({
    kind: "business", stableId: `business:${name}:${x}`, businessName: name, siret: "12345678900011", category: "pharmacy", x: x + 40, z: 0,
    geometry: { type: "Point", coordinates: [0.58, 43.64] }, names: [], confidence: "high", status: "active", provenance: [], sourceRefs: [{ source: "sirene", timestamp: "2026" }],
  });

  it("measures name similarity by shared words, ignoring legal forms", () => {
    expect(nameSimilarity("E.Leclerc", "SAS Leclerc E")).toBe(1);
    expect(nameSimilarity("Pharmacie du Centre", "Pharmacie Occitane")).toBe(0.5);
  });

  it("merges the same shop known to both sources, keeping OSM's position and details", () => {
    const result = conflateBusinesses([poi("Pharmacie du Centre", 100)], [business("Pharmacie du Centre", 100)]);
    expect(result.merged).toBe(1);
    expect(result.pois).toHaveLength(0);
    expect(result.businesses[0]).toMatchObject({ siret: "12345678900011", x: 100, phone: "+33 5 62 00 00 00", openingHours: "Mo-Sa 09:00-19:00" });
    expect(result.businesses[0]!.sourceRefs.map((reference) => reference.source).sort()).toEqual(["osm", "sirene"]);
  });

  it("puts a merged business on the anchor of an OSM POI mapped as a building", () => {
    const building: PoiFeature = {
      ...poi("Préfecture du Gers", 100),
      lon: 0.5867, lat: 43.6468,
      geometry: { type: "Polygon", coordinates: [[[0.5866, 43.6467], [0.5868, 43.6467], [0.5868, 43.6469], [0.5866, 43.6469], [0.5866, 43.6467]]] },
      localGeometry: { type: "Polygon", coordinates: [[[90, -10], [110, -10], [110, 10], [90, 10], [90, -10]]] },
    };
    const merged = conflateBusinesses([building], [business("Préfecture du Gers", 150)]).businesses[0]!;
    expect(merged.geometry).toEqual({ type: "Point", coordinates: [0.5867, 43.6468] });
    expect(merged.localGeometry).toEqual({ type: "Point", coordinates: [100, 0] });
    expect(merged).toMatchObject({ lon: 0.5867, lat: 43.6468, x: 100, z: 0 });
  });

  it("lets an exact name match reach further than a similar one", () => {
    expect(conflateBusinesses([poi("Préfecture du Gers", 100)], [business("Prefecture du Gers", 310)]).merged).toBe(1);
    expect(conflateBusinesses([poi("Pharmacie du Centre Ville", 100)], [business("Pharmacie du Centre", 310)]).merged).toBe(0);
  });

  it("keeps namesakes apart when they are too far apart or named differently", () => {
    const far = conflateBusinesses([poi("Pharmacie du Centre", 100)], [business("Pharmacie du Centre", 5000)]);
    expect(far.merged).toBe(0);
    const other = conflateBusinesses([poi("Pharmacie du Centre", 100)], [business("Pharmacie Occitane", 100)]);
    expect(other.merged).toBe(0);
    expect(other.pois).toHaveLength(1);
  });
});

describe("opening hours", () => {
  const week = parseOpeningHours("Mo-Fr 09:00-12:00,14:00-19:00; Sa 09:00-12:00")!;
  /* 2026-10-05 is a Monday. */
  const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 9, 5 + day, hour, minute);

  it("parses day ranges and split shifts", () => {
    expect(formatDay(week[0]!)).toBe("09:00–12:00, 14:00–19:00");
    expect(formatDay(week[5]!)).toBe("09:00–12:00");
    expect(formatDay(week[6]!)).toBe("Closed");
  });

  it("says whether a place is open now and when that changes", () => {
    expect(openState(week, at(0, 10))).toEqual({ open: true, detail: "Closes 12:00" });
    expect(openState(week, at(0, 13))).toEqual({ open: false, detail: "Opens 14:00" });
    expect(openState(week, at(5, 13)).open).toBe(false);
    expect(openState(week, at(6, 11))).toEqual({ open: false, detail: "Opens Mon 09:00" });
  });

  it("handles round-the-clock and unparseable values", () => {
    expect(formatDay(parseOpeningHours("24/7")![3]!)).toBe("Open 24 hours");
    expect(parseOpeningHours("sur rendez-vous")).toBeNull();
  });
});

describe("displayCase", () => {
  it("title-cases single-case names the French way and trusts mixed case", () => {
    expect(displayCase("chemin du bigourdan")).toBe("Chemin du Bigourdan");
    expect(displayCase("RUE DE L'ÉGLISE")).toBe("Rue de l'Église");
    expect(displayCase("SAINT-JEAN-POUTGE")).toBe("Saint-Jean-Poutge");
    expect(displayCase("Rue Gambetta")).toBe("Rue Gambetta");
  });
});

describe("tidyLabel", () => {
  it("drops a parenthesis cut off by a field limit and dangling separators, keeping whole ones", () => {
    expect(tidyLabel("CLINIQUE VETERINAIRE (PLACE DU")).toBe("CLINIQUE VETERINAIRE");
    expect(tidyLabel("Adapei du Gers - Ludotheque /")).toBe("Adapei du Gers - Ludotheque");
    expect(tidyLabel("Musée (annexe)")).toBe("Musée (annexe)");
    expect(tidyLabel("Saint-Clar")).toBe("Saint-Clar");
    expect(tidyLabel(" / ")).toBe("/");
  });
});

describe("displayStreetName", () => {
  it("spells out abbreviated street types and capitalises compound names", () => {
    expect(displayStreetName("Che du Moulin")).toBe("Chemin du Moulin");
    expect(displayStreetName("R Gambetta")).toBe("Rue Gambetta");
    expect(displayStreetName("Pl Jean Jaures")).toBe("Place Jean Jaures");
    expect(displayStreetName("Vc 3")).toBe("Voie communale 3");
    expect(displayStreetName("Boulevard Sadi-carnot")).toBe("Boulevard Sadi-Carnot");
    expect(displayStreetName("Route de l'Isle-jourdain")).toBe("Route de l'Isle-Jourdain");
    expect(displayStreetName("rue des écoles")).toBe("Rue des Écoles");
    expect(displayStreetName("Rd 930")).toBe("Rd 930");
  });

  it("leaves particles of compound place names alone", () => {
    expect(capitaliseCompounds("Saint-Martin-d'Armagnac")).toBe("Saint-Martin-d'Armagnac");
    expect(capitaliseCompounds("Saint-Jean-de-Luz")).toBe("Saint-Jean-de-Luz");
    expect(capitaliseCompounds("Lieu-dit les Cabanes")).toBe("Lieu-dit les Cabanes");
    expect(capitaliseCompounds("Bel-air")).toBe("Bel-Air");
  });
});
