import { BufferGeometry, Float32BufferAttribute, Path, Shape, ShapeGeometry } from "three";
import type { Geometry, WaterFeature } from "../data/schema";
import { mapShapeGeometryToWorld } from "./geometryCoordinates";
import { tessellatePolyline, type PolylinePoint } from "./tessellatePolyline";

type CoordPair = [number, number];
type WaterGeometry = Extract<Geometry, { type: "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon" }>;
export type WaterFeatureShape = Omit<WaterFeature, "geometry"> & { geometry: WaterGeometry };

export interface WaterStratumResult {
  stratum: "surface" | "linear";
  geometry: BufferGeometry;
  featureCount: number;
  areaMetres: number;
  lineLengthMetres: number;
}

export interface BuildResult {
  geometry: BufferGeometry;
  strata: WaterStratumResult[];
  featureCount: number;
  areaMetres: number;
  lineLengthMetres: number;
}

const WATERWAY_WIDTH_DEFAULTS: Record<string, number> = {
  river: 10, stream: 2, brook: 2, canal: 6, ditch: 1.5, drain: 1.5, tidal_channel: 6, default: 3,
};
const STRATA: readonly ("surface" | "linear")[] = ["surface", "linear"];

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
    const path = new Path();
    path.moveTo(ring[0]![0], ring[0]![1]);
    for (let index = 1; index < ring.length; index += 1) path.lineTo(ring[index]![0], ring[index]![1]);
    path.closePath();
    shape.holes.push(path);
  }
}

function buildSurfaceGeometry(rings: CoordPair[][], featureIndex: number): BufferGeometry {
  const outer = rings[0];
  if (!outer || outer.length < 3) return new BufferGeometry();
  const shape = ringToShape(outer);
  addHoles(shape, rings.slice(1));
  const geometry = mapShapeGeometryToWorld(new ShapeGeometry(shape));
  const position = geometry.getAttribute("position");
  if (!position) return new BufferGeometry();
  geometry.setAttribute("featureIndex", new Float32BufferAttribute(new Float32Array(position.count).fill(featureIndex), 1));
  return geometry;
}

function ringArea(ring: CoordPair[]): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index]!;
    const second = ring[(index + 1) % ring.length]!;
    area += first[0] * second[1] - second[0] * first[1];
  }
  return Math.abs(area) / 2;
}

function polygonArea(rings: CoordPair[][]): number {
  const outer = rings[0];
  return outer ? Math.max(0, ringArea(outer) - rings.slice(1).reduce((sum, ring) => sum + ringArea(ring), 0)) : 0;
}

function waterwayWidth(feature: WaterFeatureShape): number {
  if (feature.width !== undefined && feature.width > 0) return feature.width;
  return WATERWAY_WIDTH_DEFAULTS[feature.waterType ?? "default"] ?? WATERWAY_WIDTH_DEFAULTS.default!;
}

function lineLength(line: CoordPair[]): number {
  let length = 0;
  for (let index = 0; index < line.length - 1; index += 1) length += Math.hypot(line[index + 1]![0] - line[index]![0], line[index + 1]![1] - line[index]![1]);
  return length;
}

function buildWaterwayGeometry(line: CoordPair[], halfWidth: number, featureIndex: number): BufferGeometry {
  const strip = tessellatePolyline(line as readonly PolylinePoint[], { halfWidth, miterLimit: 4 });
  if (strip.left.length === 0) return new BufferGeometry();
  const positions: number[] = [];
  const featureIndices: number[] = [];
  for (let index = 0; index < strip.left.length; index += 1) {
    const left = strip.left[index]!;
    const right = strip.right[index]!;
    positions.push(left[0], 0, left[1], right[0], 0, right[1]);
    featureIndices.push(featureIndex, featureIndex);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("featureIndex", new Float32BufferAttribute(featureIndices, 1));
  geometry.setIndex(strip.indices);
  return geometry;
}

function mergeGeometries(geometries: BufferGeometry[]): BufferGeometry {
  const merged = new BufferGeometry();
  const positions: number[] = [];
  const featureIndices: number[] = [];
  const indices: number[] = [];
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
  return merged;
}

export function buildWater(features: WaterFeatureShape[]): BuildResult {
  const pieces = new Map<"surface" | "linear", BufferGeometry[]>();
  const featureIds = new Map<"surface" | "linear", Set<string>>();
  const areas = new Map<"surface" | "linear", number>();
  const lengths = new Map<"surface" | "linear", number>();
  for (const stratum of STRATA) {
    pieces.set(stratum, []);
    featureIds.set(stratum, new Set());
    areas.set(stratum, 0);
    lengths.set(stratum, 0);
  }
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const feature = features[featureIndex]!;
    if (feature.fictiveAxis === true) continue;
    const geometry = feature.geometry;
    const surface = geometry.type === "Polygon" || geometry.type === "MultiPolygon";
    const stratum = surface ? "surface" : "linear";
    let rendered = false;
    if (geometry.type === "Polygon") {
      areas.set(stratum, areas.get(stratum)! + polygonArea(geometry.coordinates));
      const mesh = buildSurfaceGeometry(geometry.coordinates, featureIndex);
      if (mesh.getAttribute("position")) { pieces.get(stratum)!.push(mesh); rendered = true; }
    } else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates) {
        areas.set(stratum, areas.get(stratum)! + polygonArea(polygon));
        const mesh = buildSurfaceGeometry(polygon, featureIndex);
        if (mesh.getAttribute("position")) { pieces.get(stratum)!.push(mesh); rendered = true; }
      }
    } else {
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      for (const line of lines) {
        lengths.set(stratum, lengths.get(stratum)! + lineLength(line));
        const ribbon = buildWaterwayGeometry(line, waterwayWidth(feature) / 2, featureIndex);
        if (ribbon.getAttribute("position")) { pieces.get(stratum)!.push(ribbon); rendered = true; }
      }
    }
    if (rendered) featureIds.get(stratum)!.add(feature.stableId);
  }
  const strata: WaterStratumResult[] = STRATA.map((stratum) => {
    const geometry = mergeGeometries(pieces.get(stratum)!);
    for (const piece of pieces.get(stratum)!) piece.dispose();
    return { stratum, geometry, featureCount: featureIds.get(stratum)!.size, areaMetres: areas.get(stratum)!, lineLengthMetres: lengths.get(stratum)! };
  });
  const geometry = mergeGeometries(strata.map((stratum) => stratum.geometry));
  return {
    geometry,
    strata,
    featureCount: strata.reduce((sum, stratum) => sum + stratum.featureCount, 0),
    areaMetres: strata.reduce((sum, stratum) => sum + stratum.areaMetres, 0),
    lineLengthMetres: strata.reduce((sum, stratum) => sum + stratum.lineLengthMetres, 0),
  };
}

export default buildWater;
