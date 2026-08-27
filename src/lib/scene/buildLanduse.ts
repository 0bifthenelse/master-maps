import {
  BufferGeometry,
  Float32BufferAttribute,
  Path,
  Shape,
  ShapeGeometry,
} from "three";
import type { LanduseFeature } from "@/lib/data/schema";
import { mapShapeGeometryToWorld } from "./geometryCoordinates";

type Coordinate = [number, number];
export type LanduseFeatureShape = Pick<LanduseFeature, "kind" | "stableId" | "geometry" | "name" | "landuseType">;

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
  areaMetres: number;
  typesPresent: Set<string>;
}

function ringToShape(outerRing: Coordinate[]): Shape {
  const shape = new Shape();
  const first = outerRing[0];
  if (!first || outerRing.length < 3) return shape;
  shape.moveTo(first[0], first[1]);
  for (const point of outerRing.slice(1)) shape.lineTo(point[0], point[1]);
  shape.closePath();
  return shape;
}

function addHoles(shape: Shape, holes: Coordinate[][]): void {
  for (const ring of holes) {
    const first = ring[0];
    if (!first || ring.length < 3) continue;
    const path = new Path();
    path.moveTo(first[0], first[1]);
    for (const point of ring.slice(1)) path.lineTo(point[0], point[1]);
    path.closePath();
    shape.holes.push(path);
  }
}

function landuseTypeHash(type: string): number {
  let hash = 0;
  for (const character of type) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(hash) % 100;
}

function buildGeometryForShape(shape: Shape, featureIndex: number, landuseType: string): BufferGeometry {
  const geometry = mapShapeGeometryToWorld(new ShapeGeometry(shape));
  const count = geometry.getAttribute("position")?.count ?? 0;
  const featureIndices = new Float32BufferAttribute(new Float32Array(count).fill(featureIndex), 1);
  featureIndices.name = "featureIndex";
  geometry.setAttribute("featureIndex", featureIndices);
  const typeAttribute = new Float32BufferAttribute(new Float32Array(count).fill(landuseTypeHash(landuseType)), 1);
  typeAttribute.name = "landuseType";
  geometry.setAttribute("landuseType", typeAttribute);
  return geometry;
}

function ringArea(ring: Coordinate[]): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index]!;
    const second = ring[(index + 1) % ring.length]!;
    area += first[0] * second[1] - second[0] * first[1];
  }
  return Math.abs(area) / 2;
}

function polygonArea(rings: Coordinate[][]): number {
  const [outer, ...holes] = rings;
  if (!outer) return 0;
  return Math.max(0, ringArea(outer) - holes.reduce((sum, hole) => sum + ringArea(hole), 0));
}

function mergeGeometries(geometries: BufferGeometry[]): BufferGeometry {
  if (geometries.length === 0) return new BufferGeometry();
  if (geometries.length === 1) return geometries[0]!;

  const merged = new BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const featureIndices: number[] = [];
  const landuseTypes: number[] = [];
  let vertexOffset = 0;

  for (const geometry of geometries) {
    const position = geometry.getAttribute("position");
    if (!position) continue;
    for (let index = 0; index < position.array.length; index += 1) positions.push(position.array[index]!);

    const featureIndex = geometry.getAttribute("featureIndex");
    if (featureIndex) for (let index = 0; index < featureIndex.array.length; index += 1) featureIndices.push(featureIndex.array[index]!);
    else for (let index = 0; index < position.count; index += 1) featureIndices.push(0);

    const type = geometry.getAttribute("landuseType");
    if (type) for (let index = 0; index < type.array.length; index += 1) landuseTypes.push(type.array[index]!);
    else for (let index = 0; index < position.count; index += 1) landuseTypes.push(0);

    const index = geometry.getIndex();
    if (index) for (let offset = 0; offset < index.array.length; offset += 1) indices.push(index.array[offset]! + vertexOffset);
    else for (let offset = 0; offset < position.count; offset += 1) indices.push(offset + vertexOffset);
    vertexOffset += position.count;
  }

  merged.setAttribute("position", new Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.setAttribute("featureIndex", new Float32BufferAttribute(featureIndices, 1));
  merged.setAttribute("landuseType", new Float32BufferAttribute(landuseTypes, 1));
  return merged;
}

export function buildLanduse(features: LanduseFeatureShape[]): BuildResult {
  if (features.length === 0) return { geometry: new BufferGeometry(), featureCount: 0, areaMetres: 0, typesPresent: new Set() };

  const geometries: BufferGeometry[] = [];
  const typesPresent = new Set<string>();
  let totalArea = 0;

  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const feature = features[featureIndex]!;
    const landuseType = feature.landuseType ?? "unknown";
    typesPresent.add(landuseType);
    const polygons = feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [];
    for (const coordinates of polygons) {
      totalArea += polygonArea(coordinates);
      const outer = coordinates[0];
      if (!outer || outer.length < 3) continue;
      const shape = ringToShape(outer);
      addHoles(shape, coordinates.slice(1));
      geometries.push(buildGeometryForShape(shape, featureIndex, landuseType));
    }
  }

  const geometry = mergeGeometries(geometries);
  if (geometries.length > 1) for (const intermediate of geometries) intermediate.dispose();
  return { geometry, featureCount: features.length, areaMetres: totalArea, typesPresent };
}

export default buildLanduse;
