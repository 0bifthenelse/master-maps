import { intersection } from "polygon-clipping";

export type Position2D = [number, number];

export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PolygonGeometry {
  readonly type: "Polygon";
  coordinates: Position2D[][];
}

export interface MultiPolygonGeometry {
  readonly type: "MultiPolygon";
  coordinates: Position2D[][][];
}

export type Geometry2D = PolygonGeometry | MultiPolygonGeometry;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const EPSILON = 1e-10;
const MAX_COORD = 10_000_000;

export function isRingClosed(coordinates: Position2D[]): boolean {
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  return coordinates.length >= 4
    && first !== undefined
    && last !== undefined
    && first[0] === last[0]
    && first[1] === last[1];
}

export function ensureRingClosed(coordinates: Position2D[]): Position2D[] {
  if (coordinates.length === 0) return coordinates;
  const first = coordinates[0]!;
  const last = coordinates[coordinates.length - 1]!;
  if (first[0] === last[0] && first[1] === last[1]) return coordinates;
  return [...coordinates, [first[0], first[1]]];
}

export function ringArea(coordinates: Position2D[]): number {
  if (coordinates.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < coordinates.length; index += 1) {
    const first = coordinates[index]!;
    const second = coordinates[(index + 1) % coordinates.length]!;
    area += first[0] * second[1] - second[0] * first[1];
  }
  return area / 2;
}

export function ringWindingOrder(coordinates: Position2D[]): "cw" | "ccw" {
  return ringArea(coordinates) >= 0 ? "ccw" : "cw";
}

function pointOnSegment(point: Position2D, start: Position2D, end: Position2D): boolean {
  const cross = (point[1] - start[1]) * (end[0] - start[0])
    - (point[0] - start[0]) * (end[1] - start[1]);
  if (Math.abs(cross) > EPSILON) return false;
  return point[0] >= Math.min(start[0], end[0]) - EPSILON
    && point[0] <= Math.max(start[0], end[0]) + EPSILON
    && point[1] >= Math.min(start[1], end[1]) - EPSILON
    && point[1] <= Math.max(start[1], end[1]) + EPSILON;
}

export function pointInRing(point: Position2D, ring: Position2D[]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const previous = ring[(index + ring.length - 1) % ring.length]!;
    if (pointOnSegment(point, previous, current)) return true;
    if ((current[1] > point[1]) !== (previous[1] > point[1])) {
      const x = previous[0] + ((point[1] - previous[1]) * (current[0] - previous[0])) / (current[1] - previous[1]);
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

export function pointInPolygon(point: Position2D, polygon: PolygonGeometry): boolean {
  const exterior = polygon.coordinates[0];
  if (!exterior || !pointInRing(point, exterior)) return false;
  for (let index = 1; index < polygon.coordinates.length; index += 1) {
    if (pointInRing(point, polygon.coordinates[index]!)) return false;
  }
  return true;
}

export function pointInMultiPolygon(point: Position2D, multiPolygon: MultiPolygonGeometry): boolean {
  for (const coordinates of multiPolygon.coordinates) {
    if (pointInPolygon(point, { type: "Polygon", coordinates })) return true;
  }
  return false;
}

export function pointInGeometry(point: Position2D, geometry: Geometry2D): boolean {
  return geometry.type === "Polygon"
    ? pointInPolygon(point, geometry)
    : pointInMultiPolygon(point, geometry);
}

export function polygonRenderable(polygon: PolygonGeometry): ValidationResult {
  const errors: string[] = [];
  const rings = polygon?.coordinates;
  if (!rings || rings.length === 0) return { valid: false, errors: ["Polygon has no rings"] };
  const exterior = rings[0];
  if (!exterior || exterior.length < 4) {
    return { valid: false, errors: [`Exterior ring has fewer than 4 coordinates`] };
  }

  const validateRing = (ring: Position2D[], label: string): void => {
    if (ring.length < 4) errors.push(`${label} has fewer than 4 coordinates`);
    if (!isRingClosed(ring)) errors.push(`${label} is not closed`);
    for (let index = 0; index < ring.length; index += 1) {
      const point = ring[index]!;
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) errors.push(`${label} has a non-finite coordinate`);
      if (Math.abs(point[0]) > MAX_COORD || Math.abs(point[1]) > MAX_COORD) errors.push(`${label} exceeds coordinate bounds`);
      if (index > 0 && samePoint(point, ring[index - 1]!)) errors.push(`${label} has a consecutive duplicate`);
    }
    if (Math.abs(ringArea(ring)) <= EPSILON) errors.push(`${label} has zero area`);
  };

  validateRing(exterior, "Exterior ring");
  const exteriorArea = Math.abs(ringArea(exterior));
  for (let index = 1; index < rings.length; index += 1) {
    const hole = rings[index]!;
    const label = `Hole ring ${index}`;
    validateRing(hole, label);
    if (Math.abs(ringArea(hole)) >= exteriorArea) errors.push(`${label} is not smaller than the exterior`);
    const point = hole[0];
    if (point && !pointInRing(point, exterior)) errors.push(`${label} is outside the exterior`);
    if (Math.sign(ringArea(hole)) === Math.sign(ringArea(exterior))) errors.push(`${label} has the exterior winding`);
  }
  return { valid: errors.length === 0, errors };
}

export function multiPolygonRenderable(multiPolygon: MultiPolygonGeometry): ValidationResult {
  if (!multiPolygon || multiPolygon.coordinates.length === 0) {
    return { valid: false, errors: ["MultiPolygon has no polygons"] };
  }
  const errors: string[] = [];
  for (let index = 0; index < multiPolygon.coordinates.length; index += 1) {
    const result = polygonRenderable({ type: "Polygon", coordinates: multiPolygon.coordinates[index]! });
    errors.push(...result.errors.map((error) => `Polygon ${index}: ${error}`));
  }
  return { valid: errors.length === 0, errors };
}

export function geometryRenderable(geometry: Geometry2D): ValidationResult {
  return geometry.type === "Polygon" ? polygonRenderable(geometry) : multiPolygonRenderable(geometry);
}

function samePoint(first: Position2D, second: Position2D): boolean {
  return Math.abs(first[0] - second[0]) <= EPSILON && Math.abs(first[1] - second[1]) <= EPSILON;
}

function intersectAxis(start: Position2D, end: Position2D, axis: "x" | "y", limit: number): Position2D {
  if (axis === "x") {
    const denominator = end[0] - start[0];
    if (Math.abs(denominator) <= EPSILON) return [limit, start[1]];
    return [limit, start[1] + ((limit - start[0]) / denominator) * (end[1] - start[1])];
  }
  const denominator = end[1] - start[1];
  if (Math.abs(denominator) <= EPSILON) return [start[0], limit];
  return [start[0] + ((limit - start[1]) / denominator) * (end[0] - start[0]), limit];
}

function clipEdge(ring: Position2D[], axis: "x" | "y", limit: number, keepGreater: boolean): Position2D[] {
  if (ring.length === 0) return [];
  const output: Position2D[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const previous = ring[(index + ring.length - 1) % ring.length]!;
    const currentValue = axis === "x" ? current[0] : current[1];
    const previousValue = axis === "x" ? previous[0] : previous[1];
    const currentInside = keepGreater ? currentValue >= limit : currentValue <= limit;
    const previousInside = keepGreater ? previousValue >= limit : previousValue <= limit;
    if (currentInside) {
      if (!previousInside) output.push(intersectAxis(previous, current, axis, limit));
      output.push(current);
    } else if (previousInside) {
      output.push(intersectAxis(previous, current, axis, limit));
    }
  }
  return output;
}

function clipRingToBounds(ring: Position2D[], bounds: Bounds2D): Position2D[] {
  let clipped = ring.slice();
  for (const [axis, limit, keepGreater] of [
    ["x", bounds.minX, true],
    ["x", bounds.maxX, false],
    ["y", bounds.minY, true],
    ["y", bounds.maxY, false],
  ] as const) {
    clipped = clipEdge(clipped, axis, limit, keepGreater);
    if (clipped.length < 3) return [];
  }
  return clipped;
}

export function clipPolygonToBounds(polygon: PolygonGeometry, bounds: Bounds2D): PolygonGeometry | null {
  const exterior = clipRingToBounds(polygon.coordinates[0] ?? [], bounds);
  if (exterior.length < 3) return null;
  const rings: Position2D[][] = [ensureRingClosed(exterior)];
  for (let index = 1; index < polygon.coordinates.length; index += 1) {
    const hole = clipRingToBounds(polygon.coordinates[index]!, bounds);
    if (hole.length >= 3 && Math.abs(ringArea(hole)) > EPSILON) rings.push(ensureRingClosed(hole));
  }
  return normalizePolygonGeometry({ type: "Polygon", coordinates: rings }) as PolygonGeometry | null;
}

export function clipMultiPolygonToBounds(multiPolygon: MultiPolygonGeometry, bounds: Bounds2D): MultiPolygonGeometry | null {
  const polygons: Position2D[][][] = [];
  for (const coordinates of multiPolygon.coordinates) {
    const clipped = clipPolygonToBounds({ type: "Polygon", coordinates }, bounds);
    if (clipped) polygons.push(clipped.coordinates);
  }
  return polygons.length > 0 ? { type: "MultiPolygon", coordinates: polygons } : null;
}

export function clipGeometryToBounds(geometry: Geometry2D, bounds: Bounds2D): Geometry2D | null {
  return geometry.type === "Polygon"
    ? clipPolygonToBounds(geometry, bounds)
    : clipMultiPolygonToBounds(geometry, bounds);
}


function openRing(ring: Position2D[]): Position2D[] {
  const points = ring.slice();
  if (points.length > 1 && samePoint(points[0]!, points[points.length - 1]!)) points.pop();
  return points;
}

function cross(first: Position2D, second: Position2D): number {
  return first[0] * second[1] - first[1] * second[0];
}

function intersectionParameter(
  first: Position2D,
  second: Position2D,
  third: Position2D,
  fourth: Position2D,
): { first: number; point: Position2D } | null {
  const directionA: Position2D = [second[0] - first[0], second[1] - first[1]];
  const directionB: Position2D = [fourth[0] - third[0], fourth[1] - third[1]];
  const denominator = cross(directionA, directionB);
  if (Math.abs(denominator) <= EPSILON) return null;
  const offset: Position2D = [third[0] - first[0], third[1] - first[1]];
  const alpha = cross(offset, directionB) / denominator;
  const beta = cross(offset, directionA) / denominator;
  if (alpha <= EPSILON || alpha >= 1 - EPSILON || beta <= EPSILON || beta >= 1 - EPSILON) return null;
  return {
    first: alpha,
    point: [first[0] + alpha * directionA[0], first[1] + alpha * directionA[1]],
  };
}

export function clipLineStringToPolygon(line: Position2D[], polygon: PolygonGeometry): Position2D[][] {
  if (line.length < 2 || (polygon.coordinates[0]?.length ?? 0) < 3) return [];
  const output: Position2D[][] = [];
  let current: Position2D[] = [];
  const flush = (): void => {
    if (current.length >= 2) output.push(current);
    current = [];
  };
  for (let index = 0; index < line.length - 1; index += 1) {
    const start = line[index]!;
    const end = line[index + 1]!;
    const direction: Position2D = [end[0] - start[0], end[1] - start[1]];
    const parameters = [0, 1];
    for (const ring of polygon.coordinates) {
      const open = openRing(ring);
      for (let edge = 0; edge < open.length; edge += 1) {
        const result = intersectionParameter(start, end, open[edge]!, open[(edge + 1) % open.length]!);
        if (result) parameters.push(result.first);
      }
    }
    parameters.sort((first, second) => first - second);
    const unique: number[] = [];
    for (const parameter of parameters) {
      const bounded = Math.max(0, Math.min(1, parameter));
      if (unique.length === 0 || Math.abs(unique[unique.length - 1]! - bounded) > EPSILON) unique.push(bounded);
    }
    for (let interval = 0; interval < unique.length - 1; interval += 1) {
      const from = unique[interval]!;
      const to = unique[interval + 1]!;
      if (to - from <= EPSILON) continue;
      const middle: Position2D = [start[0] + direction[0] * (from + to) / 2, start[1] + direction[1] * (from + to) / 2];
      const fromPoint: Position2D = [start[0] + direction[0] * from, start[1] + direction[1] * from];
      const toPoint: Position2D = [start[0] + direction[0] * to, start[1] + direction[1] * to];
      if (pointInPolygon(middle, polygon)) {
        if (current.length === 0 || !samePoint(current[current.length - 1]!, fromPoint)) current.push(fromPoint);
        if (!samePoint(current[current.length - 1]!, toPoint)) current.push(toPoint);
      } else {
        flush();
      }
    }
  }
  flush();
  return output;
}

export function clipPolygonToPolygon(
  subject: PolygonGeometry,
  boundary: PolygonGeometry,
): PolygonGeometry | MultiPolygonGeometry | null {
  const clipped = intersection(subject.coordinates, boundary.coordinates);
  if (clipped.length === 0) return null;
  const polygons = clipped.map((rings) => rings.map((ring) => ensureRingClosed(ring)));
  const normalized = polygons
    .map((coordinates) => normalizePolygonGeometry({ type: "Polygon", coordinates }))
    .filter((geometry): geometry is PolygonGeometry => geometry?.type === "Polygon");
  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0]!;
  return { type: "MultiPolygon", coordinates: normalized.map((polygon) => polygon.coordinates) };
}

function cleanRing(ring: Position2D[]): Position2D[] {
  const result: Position2D[] = [];
  for (const point of ring) {
    if (result.length === 0 || !samePoint(result[result.length - 1]!, point)) result.push(point);
  }
  if (result.length > 1 && samePoint(result[0]!, result[result.length - 1]!)) result.pop();
  return result;
}

function normalizePolygon(rings: Position2D[][]): Position2D[][] | null {
  const exteriorInput = rings[0];
  if (!exteriorInput) return null;
  let exterior = ensureRingClosed(cleanRing(exteriorInput));
  if (exterior.length < 4 || Math.abs(ringArea(exterior)) <= EPSILON) return null;
  if (ringWindingOrder(exterior) === "cw") exterior = exterior.slice().reverse();
  const normalized: Position2D[][] = [exterior];
  for (let index = 1; index < rings.length; index += 1) {
    let hole = ensureRingClosed(cleanRing(rings[index]!));
    if (hole.length < 4 || Math.abs(ringArea(hole)) <= EPSILON) continue;
    if (ringWindingOrder(hole) === "ccw") hole = hole.slice().reverse();
    if (pointInRing(hole[0]!, exterior)) normalized.push(hole);
  }
  return normalized;
}

export function normalizePolygonGeometry(geometry: Geometry2D): Geometry2D | null {
  if (geometry.type === "Polygon") {
    const polygon = normalizePolygon(geometry.coordinates);
    return polygon ? { type: "Polygon", coordinates: polygon } : null;
  }
  const polygons: Position2D[][][] = [];
  for (const coordinates of geometry.coordinates) {
    const polygon = normalizePolygon(coordinates);
    if (polygon) polygons.push(polygon);
  }
  return polygons.length > 0 ? { type: "MultiPolygon", coordinates: polygons } : null;
}

export function isPolygon(geometry: Geometry2D): geometry is PolygonGeometry {
  return geometry.type === "Polygon";
}

export function isMultiPolygon(geometry: Geometry2D): geometry is MultiPolygonGeometry {
  return geometry.type === "MultiPolygon";
}

export function polygonBounds(geometry: Geometry2D): Bounds2D | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      minX = Math.min(minX, value[0]);
      minY = Math.min(minY, value[1]);
      maxX = Math.max(maxX, value[0]);
      maxY = Math.max(maxY, value[1]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
