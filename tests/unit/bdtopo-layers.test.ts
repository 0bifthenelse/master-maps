import { describe, expect, it } from "vitest";
import { MapFeatureSchema } from "../../src/lib/data/schema";
import { normalizeBdtopo } from "../../scripts/data/normalizeBdtopo";
import { ADOPTED_OUTPUT_FILES, BD_TOPO_LAYERS, layerNameForOutput } from "../../scripts/data/bdtopoLayers";

const boundary = [[
  [0.4, 43.4], [0.7, 43.4], [0.7, 43.7], [0.4, 43.7], [0.4, 43.4],
]];

const geometry = (type: string, coordinates: unknown) => ({ type, coordinates });
const square = (west: number, south: number, east: number, north: number) => [
  [west, south], [east, south], [east, north], [west, north], [west, south],
];
const multiPolygon = (west: number, south: number, east: number, north: number) => [[square(west, south, east, north)]];

function normalizeOne(sourceLayer: string, properties: Record<string, unknown>, geom: unknown): MapFeatureSchema {
  const features = normalizeBdtopo([{ sourceLayer, geometry: geom, properties }], [boundary], { edition: "2026-06-15" });
  expect(features).toHaveLength(1);
  return MapFeatureSchema.parse(features[0]);
}

describe("BD TOPO adopted layer table", () => {
  it("covers every W1-T02 ADOPT layer with a unique output file", () => {
    const required = [
      "troncon_de_voie_ferree", "equipement_de_transport", "piste_d_aerodrome", "aerodrome", "cimetiere",
      "construction_surfacique", "construction_lineaire", "reservoir", "terrain_de_sport", "pylone",
      "ligne_electrique", "plan_d_eau", "cours_d_eau", "detail_hydrographique", "canalisation",
      "zone_d_habitation", "lieu_dit_non_habite", "detail_orographique", "toponymie", "erp",
      "foret_publique", "zone_de_vegetation", "parc_ou_reserve", "zone_d_activite_ou_d_interet",
      "commune", "point_de_repere",
    ];
    const layers = new Set(BD_TOPO_LAYERS.map((spec) => spec.layer));
    for (const layer of required) expect(layers, layer).toContain(layer);
    expect(new Set(ADOPTED_OUTPUT_FILES).size).toBe(ADOPTED_OUTPUT_FILES.length);
    expect(ADOPTED_OUTPUT_FILES.every((file) => file.startsWith("bdtopo-") && file.endsWith(".geojson"))).toBe(true);
  });

  it("gates vegetation by area and excludes the standalone hedge layer", () => {
    const vegetation = BD_TOPO_LAYERS.find((spec) => spec.layer === "zone_de_vegetation");
    expect(vegetation?.filter).toMatch(/ST_Area\(geometrie\) >= 2000/);
    expect(vegetation?.filter).not.toMatch(/Haie/);
    expect(BD_TOPO_LAYERS.map((spec) => spec.layer)).not.toContain("haie");
  });

  it("records the IGN edition on every source reference", () => {
    const feature = normalizeOne("bdtopo-rail.geojson", { cleabs: "TRONFERR1" }, geometry("LineString", [[0.5, 43.5], [0.55, 43.5]]));
    expect(feature.sourceRefs[0]?.source).toBe("IGN BD TOPO");
    expect(feature.sourceRefs[0]?.license).toBe("Licence Ouverte / Open Licence 2.0");
    expect(feature.sourceRefs[0]?.url).toContain("edition 2026-06-15");
    expect(feature.provenance[0]?.winner).toBe("IGN BD TOPO");
  });
});

describe("BD TOPO layer to canonical kind mapping", () => {
  it("maps rail sections to transport lines with rail geometry, never point POIs", () => {
    const feature = normalizeOne("bdtopo-rail.geojson", {
      cleabs: "TRONFERR0000000042247040",
      nature: "LGV",
      usage: "Voyageur",
      nombre_de_voies: 2,
      position_par_rapport_au_sol: "0",
    }, geometry("LineString", [[0.5, 43.5], [0.6, 43.5]]));
    expect(feature.kind).toBe("transport");
    if (feature.kind !== "transport") throw new Error("expected transport");
    expect(feature.transportType).toBe("rail");
    expect(feature.geometry.type).toBe("LineString");
    expect(feature.stableId).toBe("ign-bdtopo:troncon_de_voie_ferree/TRONFERR0000000042247040");
    expect(feature.sourceMetadata?.nature).toBe("LGV");
    expect(feature.sourceMetadata?.lanes).toBe(2);
  });

  it("keeps fictive water axes in canonical data marked as fictive", () => {
    const feature = normalizeOne("bdtopo-water-lines.geojson", {
      cleabs: "TRON_EAU1",
      nature: "Ecoulement naturel",
      fictif: 1,
      persistance: "Intermittent",
      classe_de_largeur: "Entre 5 et 15 m",
    }, geometry("LineString", [[0.45, 43.5], [0.55, 43.5]]));
    expect(feature.kind).toBe("water");
    if (feature.kind !== "water") throw new Error("expected water");
    expect(feature.fictiveAxis).toBe(true);
    expect(feature.intermittent).toBe(true);
    expect(feature.width).toBe(10);
    expect(feature.widthInferred).toBe(false);
    expect(feature.isSurface).toBe(false);
  });

  it("maps settlement polygons to places carrying their IGN importance", () => {
    const feature = normalizeOne("bdtopo-settlements.geojson", {
      cleabs: "PAIHABIT1",
      nature: "Lieu-dit habite",
      toponyme: "Auch",
      importance: "6",
    }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.55, 43.55)));
    expect(feature.kind).toBe("place");
    if (feature.kind !== "place") throw new Error("expected place");
    expect(feature.placeType).toBe("hamlet");
    expect(feature.importance).toBe(6);
    expect(feature.name).toBe("Auch");
    expect(feature.geometry.type).toBe("MultiPolygon");
  });

  it("maps ERP records to POIs typed by their public-access category", () => {
    const feature = normalizeOne("bdtopo-public-places.geojson", {
      cleabs: "ERP_____1",
      categorie: "5",
      libelle: "MAIRIE",
      activite_principale: "Hotel de ville",
      public: true,
      ouvert: true,
    }, geometry("Point", [0.5, 43.5]));
    expect(feature.kind).toBe("poi");
    if (feature.kind !== "poi") throw new Error("expected poi");
    expect(feature.poiType).toBe("erp:5");
    expect(feature.name).toBe("MAIRIE");
    expect(feature.category).toBe("Hotel de ville");
    expect(feature.sourceMetadata?.publicAccess).toBe(true);
  });

  it("maps linear constructions to structures with their nature as structure type", () => {
    const feature = normalizeOne("bdtopo-linear-structures.geojson", {
      cleabs: "CONSLINE1",
      nature: "Pont",
      importance: "5",
    }, geometry("LineString", [[0.5, 43.5], [0.55, 43.5]]));
    expect(feature.kind).toBe("structure");
    if (feature.kind !== "structure") throw new Error("expected structure");
    expect(feature.structureType).toBe("bridge");
    expect(feature.geometry.type).toBe("LineString");
  });

  it("maps vegetation polygons to landuse subtypes", () => {
    const woods = normalizeOne("bdtopo-vegetation.geojson", { cleabs: "ZONEVEGE1", nature: "Bois" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.55, 43.55)));
    const vines = normalizeOne("bdtopo-vegetation.geojson", { cleabs: "ZONEVEGE2", nature: "Vigne" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.55, 43.55)));
    const forest = normalizeOne("bdtopo-vegetation.geojson", { cleabs: "ZONEVEGE3", nature: "Forêt fermée de feuillus" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.55, 43.55)));
    expect(woods.kind === "landuse" && woods.landuseType).toBe("wood");
    expect(vines.kind === "landuse" && vines.landuseType).toBe("vineyard");
    expect(forest.kind === "landuse" && forest.landuseType).toBe("forest");
  });

  it("maps uninhabited place names to places", () => {
    const feature = normalizeOne("bdtopo-uninhabited-places.geojson", {
      cleabs: "PAIE_NAT1",
      nature: "Lieu-dit non habite",
      toponyme: "la Bache",
      importance: "5",
    }, geometry("Point", [0.5, 43.5]));
    expect(feature.kind).toBe("place");
    if (feature.kind !== "place") throw new Error("expected place");
    expect(feature.placeType).toBe("locality");
    expect(feature.name).toBe("la Bache");
    expect(feature.importance).toBe(5);
  });

  it("maps aerodromes to transport with their ICAO reference", () => {
    const feature = normalizeOne("bdtopo-airports.geojson", {
      cleabs: "AERODROM1",
      categorie: "Autre",
      usage: "Privé",
      toponyme: "Berdoues",
      code_icao: "LF3226",
      altitude: 302,
    }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.5, 43.5)));
    expect(feature.kind).toBe("transport");
    if (feature.kind !== "transport") throw new Error("expected transport");
    expect(feature.transportType).toBe("aerodrome");
    expect(feature.ref).toBe("LF3226");
    expect(feature.name).toBe("Berdoues");
  });

  it("maps toponymy rows to places keyed by their referenced object", () => {
    const feature = normalizeOne("bdtopo-toponymy.geojson", {
      classe_de_l_objet: "Zone d'habitation",
      graphie_du_toponyme: "Auch",
      cleabs_de_l_objet: "PAIHABIT9",
    }, geometry("Point", [0.5, 43.5]));
    expect(feature.kind).toBe("place");
    if (feature.kind !== "place") throw new Error("expected place");
    expect(feature.placeType).toBe("settlement");
    expect(feature.sourceId).toBe("Zone d'habitation/PAIHABIT9");
    expect(feature.stableId).toBe("ign-bdtopo:toponymie/Zone d'habitation/PAIHABIT9");
  });

  it("maps hydrographic details to POIs and canalisations to water lines", () => {
    const spring = normalizeOne("bdtopo-hydro-details.geojson", { cleabs: "PAIHYDRO1", nature: "Source" }, geometry("Point", [0.5, 43.5]));
    const fountain = normalizeOne("bdtopo-hydro-details.geojson", { cleabs: "PAIHYDRO2", nature: "Fontaine" }, geometry("Point", [0.5, 43.5]));
    const canal = normalizeOne("bdtopo-canalisations.geojson", { cleabs: "CANALISA1", nature: "Hydrocarbures", position_par_rapport_au_sol: "1" }, geometry("LineString", [[0.5, 43.5], [0.55, 43.5]]));
    expect(spring.kind === "poi" && spring.poiType).toBe("spring");
    expect(fountain.kind === "poi" && fountain.poiType).toBe("fountain");
    expect(canal.kind).toBe("water");
    if (canal.kind !== "water") throw new Error("expected water");
    expect(canal.isSurface).toBe(false);
    expect(canal.fictiveAxis).toBe(false);
  });

  it("maps transport equipment, cemeteries, sports grounds and reserves to their canonical kinds", () => {
    const parking = normalizeOne("bdtopo-transport-equipment.geojson", { cleabs: "EQ1", nature: "Parking", importance: "6" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.46, 43.46)));
    const station = normalizeOne("bdtopo-transport-equipment.geojson", { cleabs: "EQ2", nature: "Gare voyageurs" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.46, 43.46)));
    const toll = normalizeOne("bdtopo-transport-equipment.geojson", { cleabs: "EQ3", nature: "Péage" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.46, 43.46)));
    const cemetery = normalizeOne("bdtopo-cemeteries.geojson", { cleabs: "CIM1", nature: "Civil" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.46, 43.46)));
    const tennis = normalizeOne("bdtopo-sports-grounds.geojson", { cleabs: "TERR1", nature: "Terrain de tennis" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.46, 43.46)));
    const natura = normalizeOne("bdtopo-protected-areas.geojson", { cleabs: "PARC1", nature: "Site Natura 2000" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.46, 43.46)));
    expect(parking.kind === "transport" && parking.transportType).toBe("parking");
    expect(station.kind === "transport" && station.transportType).toBe("station");
    expect(toll.kind === "transport" && toll.transportType).toBe("toll");
    expect(cemetery.kind === "landuse" && cemetery.landuseType).toBe("cemetery");
    expect(tennis.kind === "landuse" && tennis.landuseType).toBe("sports");
    expect(natura.kind === "landuse" && natura.landuseType).toBe("reserve");
  });

  it("marks search-only adoption so renderers can skip those layers", () => {
    const pylons = normalizeOne("bdtopo-pylons.geojson", { cleabs: "PYLONE1", hauteur: 28, numero: "10" }, geometry("Point", [0.5, 43.5]));
    const markers = normalizeOne("bdtopo-reference-points.geojson", { cleabs: "PR1", libelle: "1 D0090", route: "D90", numero: "1" }, geometry("Point", [0.5, 43.5]));
    const mairie = normalizeOne("bdtopo-activity-areas.geojson", { cleabs: "SURFACTI1", categorie: "Administratif ou militaire", nature: "Mairie", toponyme: "Mairie" }, geometry("MultiPolygon", multiPolygon(0.45, 43.45, 0.46, 43.46)));
    expect(pylons.kind === "poi" && pylons.sourceMetadata?.adoption).toBe("search");
    expect(markers.kind === "poi" && markers.poiType).toBe("reference_point");
    expect(markers.name).toBe("1 D0090");
    expect(mairie.sourceMetadata?.adoption).toBeUndefined();
  });

  it("drops records without an identity and files outside the adopted table", () => {
    const withoutKey = normalizeBdtopo([
      { sourceLayer: "bdtopo-airports.geojson", geometry: geometry("Point", [0.5, 43.5]), properties: { toponyme: "Nowhere" } },
      { sourceLayer: "bdtopo-hedges.geojson", geometry: geometry("LineString", [[0.5, 43.5], [0.55, 43.5]]), properties: { cleabs: "HAIE1" } },
    ], [boundary]);
    expect(withoutKey).toHaveLength(0);
  });
});

describe("BD TOPO output file to layer name", () => {
  it("resolves every adopted export and rejects unknown ones", () => {
    for (const file of ADOPTED_OUTPUT_FILES) expect(layerNameForOutput(file), file).toBeDefined();
    expect(layerNameForOutput("bdtopo-hedges.geojson")).toBeUndefined();
    expect(layerNameForOutput("bdtopo-roads.geojson")).toBe("roads");
  });
});
