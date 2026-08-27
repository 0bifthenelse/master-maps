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
});
