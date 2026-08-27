import proj4 from "proj4";
import { GERS_TERRITORY } from "@/lib/data/territory";
import type { Coordinate, Geometry } from "@/lib/data/schema";

export const WGS84_CRS = "EPSG:4326" as const;
export const LAMBERT93_CRS = "EPSG:2154" as const;

// Official EPSG:2154 definition consumed by proj4. Transformation mathematics
// remain in the maintained proj4 implementation, not in this application.
proj4.defs(
  LAMBERT93_CRS,
  "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs",
);

export type LambertCoordinate = [number, number];
export type LocalCoordinate = [number, number];

export const RENDER_ORIGIN_LAMBERT93: LambertCoordinate = toLambert93(
  GERS_TERRITORY.renderOriginWgs84,
);

export function toLambert93([lon, lat]: Coordinate): LambertCoordinate {
  assertFinitePair([lon, lat], "WGS84 coordinate");
  const [x, y] = proj4(WGS84_CRS, LAMBERT93_CRS, [lon, lat]);
  return [x, y];
}

export function fromLambert93([x, y]: LambertCoordinate): Coordinate {
  assertFinitePair([x, y], "Lambert-93 coordinate");
  const [lon, lat] = proj4(LAMBERT93_CRS, WGS84_CRS, [x, y]);
  return [lon, lat];
}

/** Render contract: x=easting, z=northing, y=scene elevation. */
export function lambertToRender([easting, northing]: LambertCoordinate): LocalCoordinate {
  assertFinitePair([easting, northing], "Lambert-93 coordinate");
  return [easting - RENDER_ORIGIN_LAMBERT93[0], northing - RENDER_ORIGIN_LAMBERT93[1]];
}

export function renderToLambert([x, z]: LocalCoordinate): LambertCoordinate {
  assertFinitePair([x, z], "render coordinate");
  return [x + RENDER_ORIGIN_LAMBERT93[0], z + RENDER_ORIGIN_LAMBERT93[1]];
}

export function wgs84ToRender(coordinate: Coordinate): LocalCoordinate {
  return lambertToRender(toLambert93(coordinate));
}

export function renderToWgs84(coordinate: LocalCoordinate): Coordinate {
  return fromLambert93(renderToLambert(coordinate));
}

export function transformGeometryToRender(geometry: Geometry): Geometry {
  return mapGeometry(geometry, wgs84ToRender);
}

export function transformGeometryToLambert93(geometry: Geometry): Geometry {
  return mapGeometry(geometry, toLambert93);
}

function mapGeometry<T extends Geometry>(geometry: T, map: (point: Coordinate) => Coordinate): T {
  const mapPoint = (point: Coordinate): Coordinate => map(point);
  switch (geometry.type) {
    case "Point":
      return { type: "Point", coordinates: mapPoint(geometry.coordinates) } as T;
    case "LineString":
      return { type: "LineString", coordinates: geometry.coordinates.map(mapPoint) } as T;
    case "MultiLineString":
      return { type: "MultiLineString", coordinates: geometry.coordinates.map((line) => line.map(mapPoint)) } as T;
    case "Polygon":
      return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(mapPoint)) } as T;
    case "MultiPolygon":
      return {
        type: "MultiPolygon",
        coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(mapPoint))),
      } as T;
  }
}

function assertFinitePair(pair: readonly number[], label: string): void {
  if (pair.length !== 2 || !pair.every(Number.isFinite)) {
    throw new Error(`${label} must contain two finite numbers`);
  }
}
