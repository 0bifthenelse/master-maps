import { BufferGeometry, Float32BufferAttribute } from "three";
import { tessellatePolyline, type PolylinePoint } from "./tessellatePolyline";

type CoordPair = [number, number];
interface LineStringRep { type: "LineString"; coordinates: CoordPair[]; }
interface MultiLineStringRep { type: "MultiLineString"; coordinates: CoordPair[][]; }

export interface RoadFeatureShape {
  kind: "road";
  stableId: string;
  width?: number;
  highway?: string;
  bridge?: boolean;
  tunnel?: boolean;
  name?: string;
  layer?: string;
  geometry: LineStringRep | MultiLineStringRep;
}

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
  totalLengthMetres: number;
}

const WIDTH_DEFAULTS: Record<string, number> = {
  motorway: 12, trunk: 9, primary: 9, secondary: 7, tertiary: 6,
  residential: 5, service: 3.5, pedestrian: 2, footway: 2,
  cycleway: 2, path: 1.5, track: 2.5, unclassified: 4,
};
const MITER_LIMIT = 4;

function resolveWidth(feature: RoadFeatureShape): number {
  if (feature.width !== undefined && feature.width > 0) return feature.width;
  return WIDTH_DEFAULTS[feature.highway ?? ""] ?? 4;
}

function buildPolylineGeometry(
  coordinates: CoordPair[],
  halfWidth: number,
  featureIndex: number,
): BufferGeometry {
  const strip = tessellatePolyline(coordinates as readonly PolylinePoint[], {
    halfWidth,
    miterLimit: MITER_LIMIT,
  });
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
    for (let index = 0; index < position.array.length; index += 1) {
      positions.push(position.array[index]!);
    }
    const featureIndex = geometry.getAttribute("featureIndex");
    if (featureIndex) {
      for (let index = 0; index < featureIndex.array.length; index += 1) {
        featureIndices.push(featureIndex.array[index]!);
      }
    } else {
      for (let index = 0; index < position.count; index += 1) featureIndices.push(0);
    }
    const sourceIndex = geometry.getIndex();
    if (sourceIndex) {
      for (let index = 0; index < sourceIndex.count; index += 1) {
        indices.push(sourceIndex.array[index]! + vertexOffset);
      }
    }
    vertexOffset += position.count;
  }
  if (positions.length === 0) return merged;
  merged.setAttribute("position", new Float32BufferAttribute(positions, 3));
  merged.setAttribute("featureIndex", new Float32BufferAttribute(featureIndices, 1));
  merged.setIndex(indices);
  return merged;
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

export function buildRoads(features: RoadFeatureShape[], layerFilter?: string): BuildResult {
  const geometries: BufferGeometry[] = [];
  let totalLengthMetres = 0;
  let renderedFeatureCount = 0;
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const feature = features[featureIndex]!;
    if (layerFilter !== undefined && feature.highway !== layerFilter) continue;
    const lines = feature.geometry.type === "LineString"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
    const halfWidth = resolveWidth(feature) / 2;
    let featureRendered = false;
    for (const line of lines) {
      if (line.length < 2) continue;
      totalLengthMetres += lineLength(line);
      const geometry = buildPolylineGeometry(line, halfWidth, featureIndex);
      if ((geometry.getAttribute("position")?.count ?? 0) === 0) continue;
      geometry.userData = {
        bridge: feature.bridge === true,
        tunnel: feature.tunnel === true,
        layer: feature.layer,
        sourceStableId: feature.stableId,
      };
      geometries.push(geometry);
      featureRendered = true;
    }
    if (featureRendered) renderedFeatureCount += 1;
  }
  const geometry = mergeGeometries(geometries);
  for (const intermediate of geometries) intermediate.dispose();
  return { geometry, featureCount: renderedFeatureCount, totalLengthMetres };
}

export default buildRoads;
