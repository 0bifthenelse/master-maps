import type { Bbox, Coordinate } from "./schema";

/** Production geographic scope for Master Maps. */
export const GERS_TERRITORY = {
  code: "32",
  name: "Gers",
  country: "France",
  interchangeCrs: "EPSG:4326",
  processingCrs: "EPSG:2154",
  boundaryRawFile: "gers-boundary.geojson",
  boundarySourceFile: "boundary-source.json",
  /** Fixed metric origin, chosen inside Gers for stable render coordinates. */
  renderOriginWgs84: [0.586, 43.695] as Coordinate,
  /** WGS84 extent used only as a bootstrap/query envelope, never as truth. */
  bootstrapBbox: [-0.28231439, 43.31084725, 1.20324919, 44.08001153] as Bbox,
  detailedTileSize: 2048,
  regionalTileSize: 8192,
  overviewTileSize: 32768,
  tileMargin: 1,
} as const;

export type TerritoryConfig = typeof GERS_TERRITORY;

export function isGersDepartmentCode(value: unknown): boolean {
  return String(value).padStart(2, "0") === GERS_TERRITORY.code;
}
