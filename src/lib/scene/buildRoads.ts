import { BufferGeometry, Float32BufferAttribute } from "three";
import type { Geometry, RoadFeature } from "../data/schema";
import { tessellatePolyline, type PolylinePoint } from "./tessellatePolyline";

type CoordPair = [number, number];
type RoadGeometry = Extract<Geometry, { type: "LineString" | "MultiLineString" }>;
export type RoadFeatureShape = Omit<RoadFeature, "geometry"> & { geometry: RoadGeometry };
export type RoadStratum = "tunnel" | "normal" | "bridge";

export interface RoadStratumResult {
  stratum: RoadStratum;
  geometry: BufferGeometry;
  featureCount: number;
  totalLengthMetres: number;
}

export interface BuildResult {
  geometry: BufferGeometry;
  strata: RoadStratumResult[];
  sourceSegments: SourceSegment[];
  featureCount: number;
  totalLengthMetres: number;
}
export interface SourceSegment {
  stableId: string;
  start: CoordPair;
  end: CoordPair;
  stratum: RoadStratum;
}

const WIDTH_DEFAULTS: Record<string, number> = {
  motorway: 12, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
  residential: 5, service: 3.5, pedestrian: 2, footway: 2,
  cycleway: 2, path: 1.5, track: 2.5, unclassified: 4,
};
const STRATA: readonly RoadStratum[] = ["tunnel", "normal", "bridge"];

function resolveWidth(feature: RoadFeatureShape): number {
  return feature.width !== undefined && feature.width > 0
    ? feature.width
    : WIDTH_DEFAULTS[feature.highway ?? feature.roadClass ?? ""] ?? WIDTH_DEFAULTS.unclassified!;
}

function resolveStratum(feature: RoadFeatureShape): RoadStratum {
  if (feature.stratum) return feature.stratum;
  if (feature.tunnel === true || feature.layer === "-1") return "tunnel";
  if (feature.bridge === true || feature.layer === "1") return "bridge";
  return "normal";
}

function buildPolylineGeometry(coordinates: CoordPair[], halfWidth: number, featureIndex: number): BufferGeometry {
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

function lineLength(coordinates: CoordPair[]): number {
  let length = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) length += Math.hypot(coordinates[index + 1]![0] - coordinates[index]![0], coordinates[index + 1]![1] - coordinates[index]![1]);
  return length;
}

export function buildRoads(features: RoadFeatureShape[], layerFilter?: string): BuildResult {
  const byStratum = new Map<RoadStratum, BufferGeometry[]>();
  const featureCounts = new Map<RoadStratum, Set<string>>();
  const lengths = new Map<RoadStratum, number>();
  const sourceSegments: SourceSegment[] = [];
  for (const stratum of STRATA) {
    byStratum.set(stratum, []);
    featureCounts.set(stratum, new Set());
    lengths.set(stratum, 0);
  }
  for (let featureIndex = 0; featureIndex < features.length; featureIndex += 1) {
    const feature = features[featureIndex]!;
    if (layerFilter !== undefined && feature.highway !== layerFilter && feature.roadClass !== layerFilter) continue;
    const stratum = resolveStratum(feature);
    const lines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    const halfWidth = resolveWidth(feature) / 2;
    for (const line of lines) {
      if (line.length < 2) continue;
      for (let segmentIndex = 0; segmentIndex < line.length - 1; segmentIndex += 1) {
        sourceSegments.push({ stableId: feature.stableId, start: line[segmentIndex]!, end: line[segmentIndex + 1]!, stratum });
      }
      const geometry = buildPolylineGeometry(line, halfWidth, featureIndex);
      if ((geometry.getAttribute("position")?.count ?? 0) === 0) continue;
      byStratum.get(stratum)!.push(geometry);
      featureCounts.get(stratum)!.add(feature.stableId);
      lengths.set(stratum, lengths.get(stratum)! + lineLength(line));
    }
  }
  const strata: RoadStratumResult[] = [];
  for (const stratum of STRATA) {
    const pieces = byStratum.get(stratum)!;
    const geometry = mergeGeometries(pieces);
    for (const piece of pieces) piece.dispose();
    strata.push({ stratum, geometry, featureCount: featureCounts.get(stratum)!.size, totalLengthMetres: lengths.get(stratum)! });
  }
  const geometry = mergeGeometries(strata.map((stratum) => stratum.geometry));
  return {
    geometry,
    strata,
    sourceSegments,
    featureCount: strata.reduce((sum, stratum) => sum + stratum.featureCount, 0),
    totalLengthMetres: strata.reduce((sum, stratum) => sum + stratum.totalLengthMetres, 0),
  };
}

export default buildRoads;
