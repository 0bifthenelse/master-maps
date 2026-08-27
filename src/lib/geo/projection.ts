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

export class LocalProjection {
  private readonly originCoordinate: Coordinate;
  private readonly originLambert: Coordinate;

  constructor(origin: Coordinate) {
    const [longitude, latitude] = origin;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      throw new Error(`Projection origin must be finite: [${longitude}, ${latitude}]`);
    }
    if (longitude < -180 || longitude > 180) throw new Error(`Longitude out of range: ${longitude}`);
    if (latitude < -90 || latitude > 90) throw new Error(`Latitude out of range: ${latitude}`);
    this.originCoordinate = [longitude, latitude];
    this.originLambert = toLambert93(this.originCoordinate);
  }

  get origin(): Coordinate {
    return [...this.originCoordinate];
  }

  forward(longitude: number, latitude: number): Coordinate {
    const [easting, northing] = toLambert93([longitude, latitude]);
    return [easting - this.originLambert[0], northing - this.originLambert[1]];
  }

  reverse(x: number, z: number): Coordinate {
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error(`Local coordinate must be finite: [${x}, ${z}]`);
    return fromLambert93([this.originLambert[0] + x, this.originLambert[1] + z]);
  }

  forwardBatch(coords: Coordinate[]): Coordinate[] {
    return coords.map(([longitude, latitude]) => this.forward(longitude, latitude));
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
  return ringCentroid([boundary]).centroid;
}

function geometryCenter(geometry: GeoJSONGeometry): Coordinate {
  if (geometry.type === "Polygon") return polygonCentroid(geometry.coordinates);
  let totalWeight = 0;
  let totalX = 0;
  let totalY = 0;
  for (const polygon of geometry.coordinates) {
    const contribution = polygonContribution(polygon);
    totalWeight += contribution.weight;
    totalX += contribution.x;
    totalY += contribution.y;
  }
  if (totalWeight <= 0) throw new Error("MultiPolygon has no positive area");
  return fromLambert93([totalX / totalWeight, totalY / totalWeight]);
}

function polygonCentroid(rings: Ring[]): Coordinate {
  const contribution = polygonContribution(rings);
  if (contribution.weight <= 0) throw new Error("Polygon has no positive area");
  return fromLambert93([contribution.x / contribution.weight, contribution.y / contribution.weight]);
}

function polygonContribution(rings: Ring[]): { weight: number; x: number; y: number } {
  const exterior = rings[0];
  if (!exterior || exterior.length < 3) return { weight: 0, x: 0, y: 0 };
  const outer = ringCentroid([exterior]);
  let weight = outer.area;
  let x = outer.centroid[0] * outer.area;
  let y = outer.centroid[1] * outer.area;
  for (const hole of rings.slice(1)) {
    const contribution = ringCentroid([hole]);
    weight -= contribution.area;
    x -= contribution.centroid[0] * contribution.area;
    y -= contribution.centroid[1] * contribution.area;
  }
  if (weight <= 0) return { weight: outer.area, x: outer.centroid[0] * outer.area, y: outer.centroid[1] * outer.area };
  return { weight, x, y };
}

function ringCentroid(rings: [Ring]): { centroid: Coordinate; area: number } {
  const source = rings[0]!;
  const projected = source.map(toLambert93);
  let signedArea = 0;
  let centroidX = 0;
  let centroidY = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const first = projected[index]!;
    const second = projected[(index + 1) % projected.length]!;
    const cross = first[0] * second[1] - second[0] * first[1];
    signedArea += cross;
    centroidX += (first[0] + second[0]) * cross;
    centroidY += (first[1] + second[1]) * cross;
  }
  signedArea /= 2;
  const area = Math.abs(signedArea);
  if (area <= 1e-9) {
    const sum = projected.reduce<Coordinate>((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
    return {
      centroid: [sum[0] / projected.length, sum[1] / projected.length],
      area: 0,
    };
  }
  return {
    centroid: [centroidX / (6 * signedArea), centroidY / (6 * signedArea)],
    area,
  };
}

function isFeature(input: BoundaryInput): input is GeoJSONFeature {
  return typeof input === "object" && input !== null && !Array.isArray(input) && input.type === "Feature";
}

function isGeometry(input: BoundaryInput): input is GeoJSONGeometry {
  return typeof input === "object"
    && input !== null
    && !Array.isArray(input)
    && (input.type === "Polygon" || input.type === "MultiPolygon");
}
