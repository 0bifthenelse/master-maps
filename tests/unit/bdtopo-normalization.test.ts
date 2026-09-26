import { describe, expect, it } from "vitest";
import { normalizeBdtopo, parseBdBoolean } from "../../scripts/data/normalizeBdtopo";

const boundary = [[
  [0.4, 43.4], [0.7, 43.4], [0.7, 43.7], [0.4, 43.7], [0.4, 43.4],
]];

const geometry = (type: string, coordinates: unknown) => ({ type, coordinates });

describe("BD TOPO field parsing", () => {
  it("parses Boolean enumerations without JavaScript truthiness", () => {
    expect(parseBdBoolean("Non")).toBe(false);
    expect(parseBdBoolean("False")).toBe(false);
    expect(parseBdBoolean("0")).toBe(false);
    expect(parseBdBoolean("Oui")).toBe(true);
    expect(parseBdBoolean(1)).toBe(true);
    expect(parseBdBoolean("unknown")).toBeUndefined();
  });

  it("uses metric line focus and preserves actual road width and strata", () => {
    const result = normalizeBdtopo([
      {
        sourceLayer: "bdtopo-roads.geojson",
        geometry: geometry("LineString", [[0.41, 43.5], [0.5, 43.5], [0.59, 43.5]]),
        properties: { cleabs: "TRONROUT/1", nature: "Route à 1 chaussée", largeur_de_chaussee: 4, position_par_rapport_au_sol: "1" },
      },
    ], [boundary]);
    expect(result).toHaveLength(1);
    const road = result[0];
    expect(road?.kind).toBe("road");
    expect(road?.lon).toBeCloseTo(0.5, 3);
    expect(road?.width).toBe(4);
    expect(road?.widthSource).toBe("explicit");
    expect(road?.bridge).toBe(true);
    expect(road?.stratum).toBe("bridge");
  });

  it("retains surfaces and suppressible fictive axes as distinct provenance", () => {
    const result = normalizeBdtopo([
      {
        sourceLayer: "bdtopo-water-surfaces.geojson",
        geometry: geometry("MultiPolygon", [[[[0.45, 43.45], [0.55, 43.45], [0.55, 43.55], [0.45, 43.45]]]]),
        properties: { cleabs: "SURF/1", nature: "Retenue" },
      },
      {
        sourceLayer: "bdtopo-water-lines.geojson",
        geometry: geometry("LineString", [[0.45, 43.5], [0.55, 43.5]]),
        properties: { cleabs: "TRON_EAU/1", nature: "Ecoulement naturel", fictif: "1" },
      },
    ], [boundary]);
    expect(result).toHaveLength(2);
    expect(result.find((feature) => feature.kind === "water" && feature.isSurface)?.isSurface).toBe(true);
    expect(result.find((feature) => feature.kind === "water" && feature.fictiveAxis)?.fictiveAxis).toBe(true);
  });

  it("derives watercourse width from the IGN width class and flags intermittent flows", () => {
    const [narrow, wide, unknown] = normalizeBdtopo([
      {
        sourceLayer: "bdtopo-water-lines.geojson",
        geometry: geometry("LineString", [[0.45, 43.5], [0.55, 43.5]]),
        properties: { cleabs: "TRON_EAU/2", nature: "Ecoulement naturel", classe_de_largeur: "Entre 0 et 5 m", persistance: "Intermittent" },
      },
      {
        sourceLayer: "bdtopo-water-lines.geojson",
        geometry: geometry("LineString", [[0.45, 43.5], [0.55, 43.5]]),
        properties: { cleabs: "TRON_EAU/3", nature: "Canal", classe_de_largeur: "Plus de 50 m", persistance: "Permanent" },
      },
      {
        sourceLayer: "bdtopo-water-lines.geojson",
        geometry: geometry("LineString", [[0.45, 43.5], [0.55, 43.5]]),
        properties: { cleabs: "TRON_EAU/4", nature: "Mare", classe_de_largeur: "Sans objet" },
      },
    ], [boundary]);
    expect(narrow?.width).toBe(2.5);
    expect(narrow?.widthInferred).toBe(false);
    expect(narrow?.intermittent).toBe(true);
    expect(wide?.width).toBe(60);
    expect(wide?.intermittent).toBe(false);
    expect(unknown?.width).toBeUndefined();
    expect(unknown?.widthInferred).toBe(true);
  });

  it("keeps zero-valued building heights and floor counts", () => {
    const [ground, tall] = normalizeBdtopo([
      {
        sourceLayer: "bdtopo-buildings.geojson",
        geometry: geometry("MultiPolygon", [[[[0.45, 43.45], [0.55, 43.45], [0.55, 43.55], [0.45, 43.45]]]]),
        properties: { cleabs: "BAT/1", hauteur: 0, nombre_d_etages: 0 },
      },
      {
        sourceLayer: "bdtopo-buildings.geojson",
        geometry: geometry("MultiPolygon", [[[[0.46, 43.45], [0.55, 43.45], [0.55, 43.55], [0.46, 43.45]]]]),
        properties: { cleabs: "BAT/2", hauteur: 12.5, nombre_d_etages: 3 },
      },
    ], [boundary]);
    expect(ground?.height).toBe(0);
    expect(ground?.levels).toBe(0);
    expect(ground?.heightSource).toBe("explicit");
    expect(tall?.height).toBe(12.5);
    expect(tall?.levels).toBe(3);
  });

  it("downgrades fictive and ruined records instead of claiming high confidence active state", () => {
    const [fictive, ruin, sound] = normalizeBdtopo([
      {
        sourceLayer: "bdtopo-roads.geojson",
        geometry: geometry("LineString", [[0.45, 43.5], [0.55, 43.5]]),
        properties: { cleabs: "TRONROUT/9", nature: "Chemin", fictif: 1 },
      },
      {
        sourceLayer: "bdtopo-buildings.geojson",
        geometry: geometry("MultiPolygon", [[[[0.45, 43.45], [0.55, 43.45], [0.55, 43.55], [0.45, 43.45]]]]),
        properties: { cleabs: "BAT/9", etat_de_l_objet: "En ruine" },
      },
      {
        sourceLayer: "bdtopo-roads.geojson",
        geometry: geometry("LineString", [[0.45, 43.5], [0.55, 43.5]]),
        properties: { cleabs: "TRONROUT/10", nature: "Chemin" },
      },
    ], [boundary]);
    expect(fictive?.confidence).toBe("medium");
    expect(ruin?.status).toBe("uncertain");
    expect(sound?.confidence).toBe("high");
    expect(sound?.status).toBe("active");
  });
});
