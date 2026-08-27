import { BufferGeometry, Float32BufferAttribute, Path, Shape, ShapeGeometry } from "three";
import type { BuildingFeature, Geometry } from "../data/schema";
import { mapShapeGeometryToWorld } from "./geometryCoordinates";

type CoordPair = [number, number];
type BuildingGeometry = Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;
export type BuildingFeatureShape = Omit<BuildingFeature, "geometry"> & { geometry: BuildingGeometry };

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
}

function ringToShape(ring: CoordPair[]): Shape {
  const shape = new Shape();
  const first = ring[0];
  if (!first || ring.length < 3) return shape;
  shape.moveTo(first[0], first[1]);
  for (let index = 1; index < ring.length; index += 1) shape.lineTo(ring[index]![0], ring[index]![1]);
  shape.closePath();
  return shape;
}

function addHoles(shape: Shape, holes: CoordPair[][]): void {
  for (const ring of holes) {
    if (ring.length < 3) continue;
    const hole = new Path();
    hole.moveTo(ring[0]![0], ring[0]![1]);
    for (let index = 1; index < ring.length; index += 1) hole.lineTo(ring[index]![0], ring[index]![1]);
    hole.closePath();
    shape.holes.push(hole);
  }
}


function buildPolygonWithHoles(polygon: CoordPair[][], featureIndex: number): BufferGeometry {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return new BufferGeometry();
  const shape = ringToShape(outer);
  addHoles(shape, polygon.slice(1));
  const geometry = mapShapeGeometryToWorld(new ShapeGeometry(shape));
  const position = geometry.getAttribute("position");
  if (position) geometry.setAttribute("featureIndex", new Float32BufferAttribute(new Float32Array(position.count).fill(featureIndex), 1));
  return geometry;
}

function mergeGeometries(geometries: BufferGeometry[]): BufferGeometry {
  const merged = new BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const featureIndices: number[] = [];
  let vertexOffset = 0;
  for (const geometry of geometries) {
    const position = geometry.getAttribute("position");
    if (!position) continue;
    for (let index = 0; index < position.array.length; index += 1) positions.push(position.array[index]!);
    const featureIndex = geometry.getAttribute("featureIndex");
    for (let index = 0; index < position.count; index += 1) featureIndices.push(featureIndex ? featureIndex.array[index]! : 0);
    const sourceIndex = geometry.getIndex();
    if (sourceIndex) for (let index = 0; index < sourceIndex.count; index += 1) indices.push(sourceIndex.array[index]! + vertexOffset);
    else for (let index = 0; index < position.count; index += 1) indices.push(index + vertexOffset);
    vertexOffset += position.count;
  }
  if (positions.length === 0) return merged;
  merged.setAttribute("position", new Float32BufferAttribute(positions, 3));
  merged.setAttribute("featureIndex", new Float32BufferAttribute(featureIndices, 1));
  merged.setIndex(indices);
  merged.computeVertexNormals();
  return merged;
}

export function buildBuildings(features: BuildingFeatureShape[]): BuildResult {
  const geometries: BufferGeometry[] = [];
  let featureCount = 0;
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const geometry = features[featureIndex]!.geometry;
    let rendered = false;
    if (geometry.type === "Polygon") {
      const mesh = buildPolygonWithHoles(geometry.coordinates, featureIndex);
      if (mesh.getAttribute("position")) { geometries.push(mesh); rendered = true; }
    } else {
      for (const polygon of geometry.coordinates) {
        const mesh = buildPolygonWithHoles(polygon, featureIndex);
        if (mesh.getAttribute("position")) { geometries.push(mesh); rendered = true; }
      }
    }
    if (rendered) featureCount += 1;
  }
  const geometry = mergeGeometries(geometries);
  for (const piece of geometries) piece.dispose();
  return { geometry, featureCount };
}

export { buildBuildings as default };
