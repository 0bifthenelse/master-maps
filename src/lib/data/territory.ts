import type { Bbox, Coordinate } from "./schema";

export const GERS_TERRITORY = {
  code: "32",
  name: "Gers",
  country: "France",
  interchangeCrs: "EPSG:4326",
  processingCrs: "EPSG:2154",
  boundaryRawFile: "gers-boundary.geojson",
  boundarySourceFile: "boundary-source.json",
  renderOriginWgs84: [0.586, 43.695] as Coordinate,
  bootstrapBbox: [-0.28231439, 43.31084725, 1.20324919, 44.08001153] as Bbox,
  detailedTileSize: 2048,
  regionalTileSize: 8192,
  overviewTileSize: 32768,
  tileMargin: 1,
} as const;

export const AUCH_DETAIL_SCOPE = {
  code: "32013",
  name: "Auch",
  parentCode: GERS_TERRITORY.code,
  boundaryRawFile: "auch-boundary.geojson",
  boundarySourceFile: "auch-boundary-source.json",
  osmExtractFile: "auch-osm.osm.pbf",
  osmGeojsonFile: "auch-osm.geojson",
  bdtopoOutputDir: "auch",
  outputRoot: "data/auch",
  sourceName: "osm-auch",
} as const;

export type TerritoryConfig = typeof GERS_TERRITORY;

export function isGersDepartmentCode(value: unknown): boolean {
  return String(value).padStart(2, "0") === GERS_TERRITORY.code;
}
