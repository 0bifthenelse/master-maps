import {
  BufferGeometry,
  Float32BufferAttribute,
  Path,
  Shape,
  ShapeGeometry,
} from "three";
import { mapShapeGeometryToWorld } from "./geometryCoordinates";
import { tessellatePolyline, type PolylinePoint } from "./tessellatePolyline";

type CoordPair = [number, number];
interface LineStringRep { type: "LineString"; coordinates: CoordPair[]; }
interface MultiLineStringRep { type: "MultiLineString"; coordinates: CoordPair[][]; }
interface PolygonRep { type: "Polygon"; coordinates: CoordPair[][]; }
interface MultiPolygonRep { type: "MultiPolygon"; coordinates: CoordPair[][][]; }
type WaterGeometry = LineStringRep | MultiLineStringRep | PolygonRep | MultiPolygonRep;

export interface WaterFeatureShape {
  kind: "water";
  stableId: string;
  geometry: WaterGeometry;
  name?: string;
  waterType?: string;
  width?: number;
  widthInferred?: boolean;
  /** BD TOPO fictive hydrographic axes are metadata, not visible surfaces. */
  fictiveAxis?: boolean;
}

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
  areaMetres: number;
  lineLengthMetres: number;
}

const WATERWAY_WIDTH_DEFAULTS: Record<string, number> = {
  river: 10, stream: 2, brook: 2, canal: 6, ditch: 1.5, drain: 1.5,
  tidal_channel: 6, default: 3,
};

function ringToShape(ring: CoordPair[]): Shape {
  const shape = new Shape();
  if (ring.length < 3) return shape;
  shape.moveTo(ring[0]![0], ring[0]![1]);
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

function buildSurfaceGeometry(rings: CoordPair[][], featureIndex: number): BufferGeometry {
  const [outer, ...holes] = rings;
  if (!outer || outer.length < 3) return new BufferGeometry();
  const shape = ringToShape(outer);
  addHoles(shape, holes);
  const geometry = mapShapeGeometryToWorld(new ShapeGeometry(shape));
  const position = geometry.getAttribute("position");
  if (!position) return new BufferGeometry();
  geometry.setAttribute(
    "featureIndex",
    new Float32BufferAttribute(new Float32Array(position.count).fill(featureIndex), 1),
  );
  return geometry;
}

function polygonArea(rings: CoordPair[][]): number {
  const outer = rings[0];
  if (!outer || outer.length < 3) return 0;
  const signedArea = (ring: CoordPair[]): number => {
    let area = 0;
    for (let index = 0; index < ring.length; index += 1) {
      const next = (index + 1) % ring.length;
      area += ring[index]![0] * ring[next]![1] - ring[next]![0] * ring[index]![1];
    }
    return Math.abs(area) / 2;
  };
  return Math.max(0, signedArea(outer) - rings.slice(1).reduce((sum, ring) => sum + signedArea(ring), 0));
}

function waterwayWidth(feature: WaterFeatureShape): number {
  if (feature.width !== undefined && feature.width > 0) return feature.width;
  return WATERWAY_WIDTH_DEFAULTS[feature.waterType ?? "default"] ?? WATERWAY_WIDTH_DEFAULTS.default!;
}

function lineLength(coordinates: CoordPair[]): number {
  let length = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const current = coordinates[index]!;
    const next = coordinates[index + 1]!;
    length += Math.hypot(next[0] - current[0], next[1] - current[1]);
  }
  return length;
}

function buildWaterwayGeometry(
  coordinates: CoordPair[],
  halfWidth: number,
  featureIndex: number,
): BufferGeometry {
  const strip = tessellatePolyline(coordinates as readonly PolylinePoint[], { halfWidth, miterLimit: 4 });
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
  if (geometries.length === 0) return new BufferGeometry();
  if (geometries.length === 1) return geometries[0]!;
  const merged = new BufferGeometry();
  const positions: number[] = [];
  const featureIndices: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;
  for (const geometry of geometries) {
    const position = geometry.getAttribute("position");
    if (!position) continue;
    for (let index = 0; index < position.array.length; index += 1) {
      positions.push(position.array[index]!);
    }
    const featureIndex = geometry.getAttribute("featureIndex");
    for (let index = 0; index < position.count; index += 1) {
      featureIndices.push(featureIndex ? featureIndex.array[index]! : 0);
    }
    const sourceIndex = geometry.getIndex();
    if (sourceIndex) {
      for (let index = 0; index < sourceIndex.count; index += 1) {
        indices.push(sourceIndex.array[index]! + vertexOffset);
      }
    }
    vertexOffset += position.count;
  }
  merged.setAttribute("position", new Float32BufferAttribute(positions, 3));
  merged.setAttribute("featureIndex", new Float32BufferAttribute(featureIndices, 1));
  merged.setIndex(indices);
  return merged;
}

export function buildWater(features: WaterFeatureShape[]): BuildResult {
  const geometries: BufferGeometry[] = [];
  let areaMetres = 0;
  let lineLengthMetres = 0;
  let featureCount = 0;
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const feature = features[featureIndex]!;
    if (feature.fictiveAxis) continue;
    const geometry = feature.geometry;
    let rendered = false;
    if (geometry.type === "Polygon") {
      areaMetres += polygonArea(geometry.coordinates);
      const surface = buildSurfaceGeometry(geometry.coordinates, featureIndex);
      if (surface.getAttribute("position")) { geometries.push(surface); rendered = true; }
    } else if (geometry.type === "MultiPolygon") {
      for (const polygon of geometry.coordinates) {
        areaMetres += polygonArea(polygon);
        const surface = buildSurfaceGeometry(polygon, featureIndex);
        if (surface.getAttribute("position")) { geometries.push(surface); rendered = true; }
      }
    } else {
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      for (const line of lines) {
        lineLengthMetres += lineLength(line);
        const ribbon = buildWaterwayGeometry(line, waterwayWidth(feature) / 2, featureIndex);
        if (ribbon.getAttribute("position")) { geometries.push(ribbon); rendered = true; }
      }
    }
    if (rendered) featureCount += 1;
  }
  const geometry = mergeGeometries(geometries);
  if (geometries.length > 1) for (const intermediate of geometries) intermediate.dispose();
  return { geometry, featureCount, areaMetres, lineLengthMetres };
}

export default buildWater;
