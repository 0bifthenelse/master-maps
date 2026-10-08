export type BdtopoAdoption = "render" | "search";

export interface BdtopoLayerSpec {
  name: BdtopoLayerName;
  layer: string;
  output: string;
  adoption: BdtopoAdoption;
  filter?: string;
}

const VEGETATION_MIN_AREA_SQM = 2_000;
const VEGETATION_NATURES = "'Bois','Forêt fermée de feuillus','Forêt fermée mixte','Forêt fermée de conifères','Forêt ouverte','Lande ligneuse','Peupleraie','Vigne','Verger'";

export const BD_TOPO_LAYERS = [
  { name: "buildings", layer: "batiment", output: "bdtopo-buildings.geojson", adoption: "render" },
  { name: "roads", layer: "troncon_de_route", output: "bdtopo-roads.geojson", adoption: "render" },
  { name: "water-surfaces", layer: "surface_hydrographique", output: "bdtopo-water-surfaces.geojson", adoption: "render" },
  { name: "water-lines", layer: "troncon_hydrographique", output: "bdtopo-water-lines.geojson", adoption: "render" },
  { name: "rail", layer: "troncon_de_voie_ferree", output: "bdtopo-rail.geojson", adoption: "render" },
  { name: "transport-equipment", layer: "equipement_de_transport", output: "bdtopo-transport-equipment.geojson", adoption: "render" },
  { name: "airport-runways", layer: "piste_d_aerodrome", output: "bdtopo-airport-runways.geojson", adoption: "render" },
  { name: "airports", layer: "aerodrome", output: "bdtopo-airports.geojson", adoption: "render" },
  { name: "canalisations", layer: "canalisation", output: "bdtopo-canalisations.geojson", adoption: "render" },
  { name: "cemeteries", layer: "cimetiere", output: "bdtopo-cemeteries.geojson", adoption: "render" },
  { name: "area-structures", layer: "construction_surfacique", output: "bdtopo-area-structures.geojson", adoption: "render" },
  { name: "linear-structures", layer: "construction_lineaire", output: "bdtopo-linear-structures.geojson", adoption: "render" },
  { name: "reservoirs", layer: "reservoir", output: "bdtopo-reservoirs.geojson", adoption: "render" },
  { name: "sports-grounds", layer: "terrain_de_sport", output: "bdtopo-sports-grounds.geojson", adoption: "render" },
  { name: "protected-areas", layer: "parc_ou_reserve", output: "bdtopo-protected-areas.geojson", adoption: "render" },
  { name: "point-structures", layer: "construction_ponctuelle", output: "bdtopo-point-structures.geojson", adoption: "search" },
  { name: "pylons", layer: "pylone", output: "bdtopo-pylons.geojson", adoption: "search" },
  { name: "power-lines", layer: "ligne_electrique", output: "bdtopo-power-lines.geojson", adoption: "search" },
  { name: "hydro-details", layer: "detail_hydrographique", output: "bdtopo-hydro-details.geojson", adoption: "search" },
  { name: "named-water-bodies", layer: "plan_d_eau", output: "bdtopo-named-water-bodies.geojson", adoption: "search" },
  { name: "named-watercourses", layer: "cours_d_eau", output: "bdtopo-named-watercourses.geojson", adoption: "search" },
  { name: "terrain-features", layer: "detail_orographique", output: "bdtopo-terrain-features.geojson", adoption: "search" },
  { name: "public-places", layer: "erp", output: "bdtopo-public-places.geojson", adoption: "search" },
  { name: "settlements", layer: "zone_d_habitation", output: "bdtopo-settlements.geojson", adoption: "render" },
  { name: "uninhabited-places", layer: "lieu_dit_non_habite", output: "bdtopo-uninhabited-places.geojson", adoption: "search" },
  { name: "public-forests", layer: "foret_publique", output: "bdtopo-public-forests.geojson", adoption: "search" },
  { name: "activity-areas", layer: "zone_d_activite_ou_d_interet", output: "bdtopo-activity-areas.geojson", adoption: "render" },
  { name: "communes", layer: "commune", output: "bdtopo-communes.geojson", adoption: "render", filter: "code_insee_du_departement = '32'" },
  { name: "reference-points", layer: "point_de_repere", output: "bdtopo-reference-points.geojson", adoption: "search" },
  { name: "toponymy", layer: "toponymie", output: "bdtopo-toponymy.geojson", adoption: "search" },
  { name: "vegetation", layer: "zone_de_vegetation", output: "bdtopo-vegetation.geojson", adoption: "render", filter: `nature IN (${VEGETATION_NATURES}) AND ST_Area(geometrie) >= ${VEGETATION_MIN_AREA_SQM}` },
] as const satisfies readonly BdtopoLayerSpec[];

export type BdtopoLayerName = (typeof BD_TOPO_LAYERS)[number]["name"];

export const ADOPTED_LAYERS: ReadonlyMap<string, BdtopoLayerSpec> = new Map(BD_TOPO_LAYERS.map((spec) => [spec.output, spec]));

export const ADOPTED_OUTPUT_FILES: readonly string[] = BD_TOPO_LAYERS.map((spec) => spec.output);

export function layerNameForOutput(output: string): BdtopoLayerName | undefined {
  return ADOPTED_LAYERS.get(output)?.name;
}
