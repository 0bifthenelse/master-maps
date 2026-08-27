import { fromLambert93, toLambert93 } from "./crs";

export type Coordinate = [number, number];
type Ring = Coordinate[];

export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: Ring[];
}

export interface GeoJSONMultiPolygon {
  type: "MultiPolygon";
  coordinates: Ring[][];
}

export type GeoJSONGeometry = GeoJSONPolygon | GeoJSONMultiPolygon;

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry | null;
  properties?: Record<string, unknown>;
}

export type BoundaryInput = GeoJSONFeature | GeoJSONGeometry | Ring;

/** Compatibility API backed by EPSG:2154, not a local approximation. */
export class LocalProjection {
  private readonly originCoordinate: Coordinate;
  private readonly originLambert: Coordinate;

  constructor(origin: Coordinate) {
    const [longitude, latitude] = origin;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error(`Projection origin must be finite: [${longitude}, ${latitude}]`);
    }
    if (longitude < -180 || longitude > 180) {
      throw new Error(`Longitude out of range: ${longitude}`);
    }
    if (latitude < -90 || latitude > 90) {
      throw new Error(`Latitude out of range: ${latitude}`);
    }
    this.originCoordinate = [longitude, latitude];
    this.originLambert = toLambert93(this.originCoordinate);
  }

  get origin(): Coordinate {
    return [...this.originCoordinate];
  }

  forward(lng: number, lat: number): Coordinate {
    const [x, y] = toLambert93([lng, lat]);
    return [x - this.originLambert[0], y - this.originLambert[1]];
  }

  reverse(x: number, z: number): Coordinate {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      throw new Error(`Local coordinate must be finite: [${x}, ${z}]`);
    }
    return fromLambert93([this.originLambert[0] + x, this.originLambert[1] + z]);
  }

  forwardBatch(coords: Coordinate[]): Coordinate[] {
    return coords.map(([lng, lat]) => this.forward(lng, lat));
  }

  reverseBatch(coords: Coordinate[]): Coordinate[] {
    return coords.map(([x, z]) => this.reverse(x, z));
  }
}

export function computeCenter(boundary: BoundaryInput): Coordinate {
  if (isFeature(boundary)) {
    if (!boundary.geometry) throw new Error("Boundary geometry is null");
    return geometryCenter(boundary.geometry);
  }
  if (isGeometry(boundary)) return geometryCenter(boundary);
  return ringMean(boundary);
}

function geometryCenter(geometry: GeoJSONGeometry): Coordinate {
  if (geometry.type === "Polygon") return polygonCentroid(geometry.coordinates);
  return multiPolygonCentroid(geometry.coordinates);
}

function polygonCentroid(rings: Ring[]): Coordinate {
  const exterior = rings[0];
  if (!exterior || exterior.length < 3) {
    throw new Error("Polygon exterior ring must have at least 3 coordinates");
  }
  const contribution = ringContribution(exterior);
  if (contribution.area === 0) return ringMean(exterior);
  return [contribution.cx / (6 * contribution.area), contribution.cy / (6 * contribution.area)];
}

function multiPolygonCentroid(polygons: Ring[][]): Coordinate {
  let totalArea = 0;
  let totalX = 0;
  let totalY = 0;
  for (const rings of polygons) {
    const exterior = rings[0];
    if (!exterior || exterior.length < 3) continue;
    const contribution = ringContribution(exterior);
    if (contribution.area === 0) continue;
    const weight = Math.abs(contribution.area);
    totalArea += weight;
    totalX += (contribution.cx / (6 * contribution.area)) * weight;
    totalY += (contribution.cy / (6 * contribution.area)) * weight;
  }
  if (totalArea === 0) throw new Error("MultiPolygon has zero total area");
  return [totalX / totalArea, totalY / totalArea];
}

function ringContribution(ring: Ring): { area: number; cx: number; cy: number } {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x0, y0] = ring[index]!;
    const [x1, y1] = ring[index + 1]!;
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  const [x0, y0] = ring[ring.length - 1]!;
  const [x1, y1] = ring[0]!;
  const cross = x0 * y1 - x1 * y0;
  area += cross;
  cx += (x0 + x1) * cross;
  cy += (y0 + y1) * cross;
  return { area: area / 2, cx, cy };
}

function ringMean(ring: Ring): Coordinate {
  const closes = ring.length > 1
    && ring[ring.length - 1]![0] === ring[0]![0]
    && ring[ring.length - 1]![1] === ring[0]![1];
  const count = closes ? ring.length - 1 : ring.length;
  if (count === 0) throw new Error("Cannot compute center of empty ring");
  let longitude = 0;
  let latitude = 0;
  for (let index = 0; index < count; index += 1) {
    longitude += ring[index]![0];
    latitude += ring[index]![1];
  }
  return [longitude / count, latitude / count];
}

function isFeature(input: BoundaryInput): input is GeoJSONFeature {
  return typeof input === "object" && input !== null && !Array.isArray(input) && input.type === "Feature";

}

function isGeometry(input: BoundaryInput): input is GeoJSONGeometry {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    && (input.type === "Polygon" || input.type === "MultiPolygon");
}
