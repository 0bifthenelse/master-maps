// @ts-nocheck
/**
 * Polygon utility functions for the Auch map project.
 *
 * All functions work with 2D positions [x, y] in local projected coordinates
 * (meters) using the standard Euclidean plane. Exterior-ring winding follows
 * the GeoJSON convention: CCW for outer rings, CW for holes.
 *
 * Axis contract: x = easting, y = northing (the caller maps the project's
 * "x=east, z=north" convention to x,y for polygon operations).
 *
 * @module @/lib/geo/polygon
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A 2D position in projected local coordinates (meters). */
export type Position2D = [number, number];

/** Axis-aligned bounding rectangle in local coordinates. */
export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** GeoJSON-compatible Polygon geometry in local coordinates. */
export interface PolygonGeometry {
  readonly type: "Polygon";
  coordinates: Position2D[][];
}

/** GeoJSON-compatible MultiPolygon geometry in local coordinates. */
export interface MultiPolygonGeometry {
  readonly type: "MultiPolygon";
  coordinates: Position2D[][][];
}

/** Discriminated union of flat 2D geometries. */
export type Geometry2D = PolygonGeometry | MultiPolygonGeometry;

/** Result of a renderability or validity check. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Floating-point equality tolerance for area, on-edge, and degenerate checks. */
const EPSILON = 1e-10;

/** Maximum coordinate magnitude sanity check (10 000 km from origin). */
const MAX_COORD = 10_000_000;

// ---------------------------------------------------------------------------
// Ring queries
// ---------------------------------------------------------------------------

/**
 * Returns true when the first and last positions are the same (closed ring).
 */
export function isRingClosed(coordinates: Position2D[]): boolean {
  if (coordinates.length < 2) return false;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  return first[0] === last[0] && first[1] === last[1];
}

/**
 * Returns a closed copy of the ring.  Appends a copy of the first vertex
 * when the original ring is not already closed.  Returns the original array
 * unchanged when already closed.
 */
export function ensureRingClosed(coordinates: Position2D[]): Position2D[] {
  if (coordinates.length < 2) return coordinates;
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) {
    return coordinates;
  }
  return [...coordinates, [first[0], first[1]]];
}

/**
 * Signed area of a single ring using the shoelace formula.
 *
 * Positive result = counter-clockwise winding (in standard +y-up coords).
 * Negative result = clockwise winding.
 * The calculation is invariant to whether the ring is explicitly closed.
 */
export function ringArea(coordinates: Position2D[]): number {
  const n = coordinates.length;
  if (n < 3) return 0;

  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = coordinates[i];
    const [x2, y2] = coordinates[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/**
 * Determines winding order from signed area.
 *
 * In standard math coords (y-up): positive area → CCW, negative area → CW.
 * Zero area (colinear/degenerate) returns "ccw" as a safe default.
 */
export function ringWindingOrder(
  coordinates: Position2D[],
): "cw" | "ccw" {
  return ringArea(coordinates) >= 0 ? "ccw" : "cw";
}

// ---------------------------------------------------------------------------
// Point-in-polygon tests
// ---------------------------------------------------------------------------

/**
 * Standard ray-casting point-in-ring test.
 *
 * Casts a horizontal ray to the right (+x) and counts edge crossings.
 * Odd count → inside, even → outside.  Strict inequality on the upper
 * endpoint avoids double-counting vertex crossings.
 */
export function pointInRing(
  point: Position2D,
  ring: Position2D[],
): boolean {
  if (ring.length < 3) return false;

  const [px, py] = point;
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];

    // Straddle test: edge crosses the horizontal line at py.
    // Use strict > on yi and >= on yj so a vertex exactly at py is counted
    // only on the upward crossing, eliminating double-count.
    if ((yi > py) !== (yj > py)) {
      // Compute x-coordinate where the edge crosses py.
      const intersectX =
        xi + (py - yi) * (xj - xi) / (yj - yi);

      if (px < intersectX) {
        inside = !inside;
      }
    }
  }

  return inside;
}

/**
 * Point-in-polygon for a Polygon geometry.
 *
 * The point must be inside the exterior ring AND outside every interior
 * ring (hole).
 */
export function pointInPolygon(
  point: Position2D,
  polygon: PolygonGeometry,
): boolean {
  const [exteriorRing, ...holes] = polygon.coordinates;

  if (!pointInRing(point, exteriorRing)) return false;

  for (const hole of holes) {
    if (pointInRing(point, hole)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Point-in-ring test for MultiPolygon
// ---------------------------------------------------------------------------

/**
 * Point-in-MultiPolygon: inside at least one constituent polygon and
 * outside all of its holes.
 */
export function pointInMultiPolygon(
  point: Position2D,
  multiPolygon: MultiPolygonGeometry,
): boolean {
  for (const polyCoords of multiPolygon.coordinates) {
    if (pointInPolygon(point, { type: "Polygon", coordinates: polyCoords })) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Point-in-geometry dispatcher
// ---------------------------------------------------------------------------

/**
 * Return true when the point lies inside the given 2D geometry (works for
 * both Polygon and MultiPolygon).
 */
export function pointInGeometry(
  point: Position2D,
  geometry: Geometry2D,
): boolean {
  if (geometry.type === "Polygon") {
    return pointInPolygon(point, geometry);
  }
  return pointInMultiPolygon(point, geometry);
}

// ---------------------------------------------------------------------------
// Renderability validation
// ---------------------------------------------------------------------------

/**
 * Checks whether a single Polygon is renderable.
 *
 * Validates: non-empty rings, ring closure, minimum vertex count,
 * non-zero area, no duplicate consecutive points, finite coordinates,
 * and no coordinate magnitude exceeding the sanity bound.
 */
export function polygonRenderable(
  polygon: PolygonGeometry,
): ValidationResult {
  const errors: string[] = [];

  if (!polygon || !polygon.coordinates || polygon.coordinates.length === 0) {
    errors.push("Polygon has no rings");
    return { valid: false, errors };
  }

  polygon.coordinates.forEach((ring, i) => {
    const label = i === 0 ? "Exterior ring" : `Hole ring ${i}`;

    if (ring.length < 3) {
      errors.push(`${label} has fewer than 3 coordinates (got ${ring.length})`);
      return;
    }

    if (!isRingClosed(ring)) {
      errors.push(`${label} is not closed`);
    }

    const absArea = Math.abs(ringArea(ring));
    if (absArea < EPSILON) {
      errors.push(`${label} has zero area`);
    }

    for (let j = 0; j < ring.length; j++) {
      const [x, y] = ring[j];
      if (!isFinite(x) || !isFinite(y)) {
        errors.push(`${label} vertex ${j} has non-finite coordinate (${x}, ${y})`);
      }
      if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
        errors.push(`${label} vertex ${j} coordinate magnitude exceeds sanity bound`);
      }
    }

    for (let j = 0; j < ring.length - 1; j++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[j + 1];
      if (x1 === x2 && y1 === y2) {
        errors.push(`${label} has duplicate consecutive point at index ${j}`);
      }
    }
  });

  // Check that holes have opposite winding to exterior
  if (polygon.coordinates.length >= 2) {
    const extArea = ringArea(polygon.coordinates[0]);
    for (let i = 1; i < polygon.coordinates.length; i++) {
      const holeArea = ringArea(polygon.coordinates[i]);
      if (extArea * holeArea > 0) {
        errors.push(
          `Hole ring ${i} has same winding direction as exterior ring; should be opposite`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Checks whether a MultiPolygon is renderable by validating each
 * constituent Polygon.
 */
export function multiPolygonRenderable(
  multiPolygon: MultiPolygonGeometry,
): ValidationResult {
  const errors: string[] = [];

  if (!multiPolygon || !multiPolygon.coordinates) {
    errors.push("MultiPolygon is null or undefined");
    return { valid: false, errors };
  }

  if (multiPolygon.coordinates.length === 0) {
    errors.push("MultiPolygon has no polygons");
    return { valid: false, errors };
  }

  multiPolygon.coordinates.forEach((polyCoords, i) => {
    const result = polygonRenderable({
      type: "Polygon",
      coordinates: polyCoords,
    });
    result.errors.forEach((e) => errors.push(`Polygon ${i}: ${e}`));
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Convenience validators that dispatch on geometry type.
 */
export function geometryRenderable(
  geometry: Geometry2D,
): ValidationResult {
  if (geometry.type === "Polygon") return polygonRenderable(geometry);
  return multiPolygonRenderable(geometry);
}

// ---------------------------------------------------------------------------
// Clipping — Sutherland–Hodgman against axis-aligned bounding rectangle
// ---------------------------------------------------------------------------

/**
 * Compute the intersection of segment [p1 → p2] with a clipping line
 * parallel to the chosen axis at `limit`.
 */
function intersect(
  p1: Position2D,
  p2: Position2D,
  axis: "x" | "y",
  limit: number,
): Position2D {
  if (axis === "x") {
    const t = (limit - p1[0]) / (p2[0] - p1[0]);
    return [limit, p1[1] + t * (p2[1] - p1[1])];
  } else {
    const t = (limit - p1[1]) / (p2[1] - p1[1]);
    return [p1[0] + t * (p2[0] - p1[0]), limit];
  }
}

/**
 * Clip a single ring against one clipping-line edge.
 *
 * `keepGreater`: true keeps points where coord[axis] >= limit (right or top
 * clip edge); false keeps coord[axis] <= limit (left or bottom clip edge).
 */
function clipEdge(
  ring: Position2D[],
  axis: "x" | "y",
  limit: number,
  keepGreater: boolean,
): Position2D[] {
  const result: Position2D[] = [];
  const n = ring.length;
  if (n === 0) return result;

  for (let i = 0; i < n; i++) {
    const current = ring[i];
    const previous = ring[(i + n - 1) % n];

    const currentInside = keepGreater
      ? current[axis] >= limit
      : current[axis] <= limit;
    const previousInside = keepGreater
      ? previous[axis] >= limit
      : previous[axis] <= limit;

    if (currentInside) {
      if (!previousInside) {
        result.push(intersect(previous, current, axis, limit));
      }
      result.push(current);
    } else if (previousInside) {
      result.push(intersect(previous, current, axis, limit));
    }
  }

  return result;
}

/**
 * Clip a ring against an axis-aligned bounding rectangle.
 * Clips against left, right, bottom, and top edges in sequence.
 */
function clipRingToBounds(
  ring: Position2D[],
  bounds: Bounds2D,
): Position2D[] {
  if (ring.length < 3) return [];

  let clipped = ring;

  clipped = clipEdge(clipped, "x", bounds.minX, true);
  if (clipped.length < 3) return [];

  clipped = clipEdge(clipped, "x", bounds.maxX, false);
  if (clipped.length < 3) return [];

  clipped = clipEdge(clipped, "y", bounds.minY, true);
  if (clipped.length < 3) return [];

  clipped = clipEdge(clipped, "y", bounds.maxY, false);
  if (clipped.length < 3) return [];

  return clipped;
}

/**
 * Clip a Polygon to an axis-aligned bounding rectangle.
 *
 * Returns null when the clipped polygon has fewer than 3 vertices (i.e.
 * the polygon does not intersect the bounds).
 */
export function clipPolygonToBounds(
  polygon: PolygonGeometry,
  bounds: Bounds2D,
): PolygonGeometry | null {
  const exterior = clipRingToBounds(polygon.coordinates[0], bounds);
  if (exterior.length < 3) return null;

  const holes: Position2D[][] = [];
  for (let i = 1; i < polygon.coordinates.length; i++) {
    const hole = clipRingToBounds(polygon.coordinates[i], bounds);
    if (hole.length >= 3) {
      holes.push(ensureRingClosed(hole));
    }
  }

  return {
    type: "Polygon",
    coordinates: [ensureRingClosed(exterior), ...holes],
  };
}

/**
 * Clip a MultiPolygon to an axis-aligned bounding rectangle.
 *
 * Returns null when no constituent polygon survives clipping.
 */
export function clipMultiPolygonToBounds(
  multiPolygon: MultiPolygonGeometry,
  bounds: Bounds2D,
): MultiPolygonGeometry | null {
  const clipped: Position2D[][][] = [];

  for (const polyCoords of multiPolygon.coordinates) {
    const poly = clipPolygonToBounds(
      { type: "Polygon", coordinates: polyCoords },
      bounds,
    );
    if (poly) {
      clipped.push(poly.coordinates);
    }
  }

  if (clipped.length === 0) return null;

  return { type: "MultiPolygon", coordinates: clipped };
}

/**
 * Dispatch clipping to Polygon or MultiPolygon.
 */
export function clipGeometryToBounds(
  geometry: Geometry2D,
  bounds: Bounds2D,
): Geometry2D | null {
  if (geometry.type === "Polygon") return clipPolygonToBounds(geometry, bounds);
  return clipMultiPolygonToBounds(geometry, bounds);
}
// ---------------------------------------------------------------------------
// Clipping against an arbitrary simple polygon
// ---------------------------------------------------------------------------

const CLIP_EPSILON = 1e-10;

interface ClipNode {
  point: Position2D;
  intersection: boolean;
  alpha: number;
  entry: boolean;
  visited: boolean;
  next: ClipNode;
  prev: ClipNode;
  neighbor: ClipNode | null;
}

interface IntersectionRecord {
  subjectEdge: number;
  clipEdge: number;
  subjectAlpha: number;
  clipAlpha: number;
  point: Position2D;
  subjectNode: ClipNode | null;
  clipNode: ClipNode | null;
}

interface RingCycle {
  vertices: ClipNode[];
}

function positionEqual(a: Position2D, b: Position2D): boolean {
  return Math.abs(a[0] - b[0]) <= CLIP_EPSILON
    && Math.abs(a[1] - b[1]) <= CLIP_EPSILON;
}

function closeRingForIntersection(ring: Position2D[]): Position2D[] {
  const points = ring.slice();
  if (points.length > 1 && positionEqual(points[0], points[points.length - 1])) {
    points.pop();
  }
  return points;
}

function createNode(
  point: Position2D,
  intersection: boolean,
  alpha = 0,
): ClipNode {
  const node = {
    point,
    intersection,
    alpha,
    entry: false,
    visited: false,
    next: null as unknown as ClipNode,
    prev: null as unknown as ClipNode,
    neighbor: null,
  };
  node.next = node;
  node.prev = node;
  return node;
}

function createRingCycle(ring: Position2D[]): RingCycle {
  const points = closeRingForIntersection(ring);
  const vertices = points.map((point) => createNode(point, false));
  for (let i = 0; i < vertices.length; i += 1) {
    const previous = vertices[(i + vertices.length - 1) % vertices.length];
    const next = vertices[(i + 1) % vertices.length];
    vertices[i].prev = previous;
    vertices[i].next = next;
  }
  return { vertices };
}

function cross2d(a: Position2D, b: Position2D): number {
  return a[0] * b[1] - a[1] * b[0];
}

function intersectionParameter(
  a: Position2D,
  b: Position2D,
  c: Position2D,
  d: Position2D,
): { first: number; second: number; point: Position2D } | null {
  const r: Position2D = [b[0] - a[0], b[1] - a[1]];
  const s: Position2D = [d[0] - c[0], d[1] - c[1]];
  const denominator = cross2d(r, s);
  if (Math.abs(denominator) <= CLIP_EPSILON) return null;

  const cMinusA: Position2D = [c[0] - a[0], c[1] - a[1]];
  const first = cross2d(cMinusA, s) / denominator;
  const second = cross2d(cMinusA, r) / denominator;
  if (
    first <= CLIP_EPSILON
    || first >= 1 - CLIP_EPSILON
    || second <= CLIP_EPSILON
    || second >= 1 - CLIP_EPSILON
  ) {
    return null;
  }

  return {
    first,
    second,
    point: [a[0] + first * r[0], a[1] + first * r[1]],
  };
}

function collectIntersections(
  subject: Position2D[],
  clip: Position2D[],
): IntersectionRecord[] {
  const records: IntersectionRecord[] = [];
  for (let subjectEdge = 0; subjectEdge < subject.length; subjectEdge += 1) {
    const subjectStart = subject[subjectEdge];
    const subjectEnd = subject[(subjectEdge + 1) % subject.length];
    for (let clipEdge = 0; clipEdge < clip.length; clipEdge += 1) {
      const clipStart = clip[clipEdge];
      const clipEnd = clip[(clipEdge + 1) % clip.length];
      const intersection = intersectionParameter(
        subjectStart,
        subjectEnd,
        clipStart,
        clipEnd,
      );
      if (!intersection) continue;
      records.push({
        subjectEdge,
        clipEdge,
        subjectAlpha: intersection.first,
        clipAlpha: intersection.second,
        point: intersection.point,
        subjectNode: null,
        clipNode: null,
      });
    }
  }
  return records;
}

function insertIntersections(
  cycle: RingCycle,
  records: IntersectionRecord[],
  side: "subject" | "clip",
): void {
  for (let edge = 0; edge < cycle.vertices.length; edge += 1) {
    const edgeRecords = records
      .filter((record) => (side === "subject" ? record.subjectEdge : record.clipEdge) === edge)
      .sort((a, b) => {
        const aAlpha = side === "subject" ? a.subjectAlpha : a.clipAlpha;
        const bAlpha = side === "subject" ? b.subjectAlpha : b.clipAlpha;
        return aAlpha - bAlpha;
      });
    let cursor = cycle.vertices[edge];
    for (const record of edgeRecords) {
      const alpha = side === "subject" ? record.subjectAlpha : record.clipAlpha;
      const node = createNode(record.point, true, alpha);
      node.prev = cursor;
      node.next = cursor.next;
      cursor.next.prev = node;
      cursor.next = node;
      cursor = node;
      if (side === "subject") record.subjectNode = node;
      else record.clipNode = node;
    }
  }
}

function midpoint(a: Position2D, b: Position2D): Position2D {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function markEntries(
  records: IntersectionRecord[],
  subjectPolygon: PolygonGeometry,
  clipPolygon: PolygonGeometry,
): void {
  for (const record of records) {
    const subjectNode = record.subjectNode;
    const clipNode = record.clipNode;
    if (!subjectNode || !clipNode) continue;

    const subjectBefore = midpoint(subjectNode.prev.point, subjectNode.point);
    const subjectAfter = midpoint(subjectNode.point, subjectNode.next.point);
    subjectNode.entry =
      !pointInPolygon(subjectBefore, clipPolygon)
      && pointInPolygon(subjectAfter, clipPolygon);

    const clipBefore = midpoint(clipNode.prev.point, clipNode.point);
    const clipAfter = midpoint(clipNode.point, clipNode.next.point);
    clipNode.entry =
      !pointInPolygon(clipBefore, subjectPolygon)
      && pointInPolygon(clipAfter, subjectPolygon);

    subjectNode.neighbor = clipNode;
    clipNode.neighbor = subjectNode;
  }
}

function traceIntersection(start: ClipNode): Position2D[] {
  const points: Position2D[] = [];
  let node = start;
  let onSubject = true;
  const maxSteps = 100000;

  for (let step = 0; step < maxSteps; step += 1) {
    if (node.intersection) {
      if (node.visited) {
        if (node === start && onSubject) break;
        return points;
      }
      node.visited = true;

      if (!node.entry && node.neighbor) {
        const neighbor = node.neighbor;
        onSubject = !onSubject;
        if (points.length === 0 || !positionEqual(points[points.length - 1], neighbor.point)) {
          points.push(neighbor.point);
        }
        if (neighbor === start && onSubject) break;
        node = neighbor.next;
        continue;
      }
    }

    if (points.length === 0 || !positionEqual(points[points.length - 1], node.point)) {
      points.push(node.point);
    }
    node = node.next;
    if (node === start && onSubject) break;
  }

  if (points.length > 1 && positionEqual(points[0], points[points.length - 1])) {
    points.pop();
  }
  return points;
}

function simpleRingIntersection(
  subjectRing: Position2D[],
  clipRing: Position2D[],
): Position2D[][] {
  const subject = closeRingForIntersection(subjectRing);
  const clip = closeRingForIntersection(clipRing);
  if (subject.length < 3 || clip.length < 3) return [];

  const records = collectIntersections(subject, clip);
  if (records.length === 0) {
    if (pointInRing(subject[0], clip)) return [subject];
    if (pointInRing(clip[0], subject)) return [clip];
    return [];
  }

  const subjectCycle = createRingCycle(subject);
  const clipCycle = createRingCycle(clip);
  insertIntersections(subjectCycle, records, "subject");
  insertIntersections(clipCycle, records, "clip");
  markEntries(
    records,
    { type: "Polygon", coordinates: [subject] },
    { type: "Polygon", coordinates: [clip] },
  );

  const output: Position2D[][] = [];
  for (const record of records) {
    const node = record.subjectNode;
    if (!node || !node.entry || node.visited) continue;
    const ring = traceIntersection(node);
    if (ring.length >= 3 && Math.abs(ringArea(ring)) > EPSILON) {
      output.push(ring);
    }
  }
  return output;
}

/**
 * Clip a LineString to a Polygon, retaining every inside segment.
 * A line that enters the polygon more than once is returned as multiple
 * LineStrings instead of retaining remote source geometry.
 */
export function clipLineStringToPolygon(
  line: Position2D[],
  polygon: PolygonGeometry,
): Position2D[][] {
  if (line.length < 2 || polygon.coordinates[0]?.length < 3) return [];

  const boundaries = polygon.coordinates;
  const clippedLines: Position2D[][] = [];
  let current: Position2D[] = [];

  const flush = (): void => {
    if (current.length >= 2) clippedLines.push(current);
    current = [];
  };

  for (let segmentIndex = 0; segmentIndex < line.length - 1; segmentIndex += 1) {
    const start = line[segmentIndex];
    const end = line[segmentIndex + 1];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const parameters = [0, 1];

    for (const boundary of boundaries) {
      const closed = closeRingForIntersection(boundary);
      for (let edgeIndex = 0; edgeIndex < closed.length; edgeIndex += 1) {
        const boundaryStart = closed[edgeIndex];
        const boundaryEnd = closed[(edgeIndex + 1) % closed.length];
        const intersection = intersectionParameter(start, end, boundaryStart, boundaryEnd);
        if (intersection) parameters.push(intersection.first);
      }
    }

    parameters.sort((a, b) => a - b);
    const uniqueParameters: number[] = [];
    for (const parameter of parameters) {
      const bounded = Math.max(0, Math.min(1, parameter));
      if (
        uniqueParameters.length === 0
        || Math.abs(uniqueParameters[uniqueParameters.length - 1] - bounded) > CLIP_EPSILON
      ) {
        uniqueParameters.push(bounded);
      }
    }

    for (let intervalIndex = 0; intervalIndex < uniqueParameters.length - 1; intervalIndex += 1) {
      const from = uniqueParameters[intervalIndex];
      const to = uniqueParameters[intervalIndex + 1];
      if (to - from <= CLIP_EPSILON) continue;
      const midpointParameter = (from + to) / 2;
      const middle: Position2D = [
        start[0] + dx * midpointParameter,
        start[1] + dy * midpointParameter,
      ];
      const fromPoint: Position2D = [
        start[0] + dx * from,
        start[1] + dy * from,
      ];
      const toPoint: Position2D = [
        start[0] + dx * to,
        start[1] + dy * to,
      ];

      if (pointInPolygon(middle, polygon)) {
        if (
          current.length === 0
          || !positionEqual(current[current.length - 1], fromPoint)
        ) {
          current.push(fromPoint);
        }
        if (!positionEqual(current[current.length - 1], toPoint)) current.push(toPoint);
      } else {
        flush();
      }
    }
  }
  flush();
  return clippedLines;
}

/**
 * Intersect a source polygon with a simple polygon boundary while preserving
 * source holes. This is used by normalization before local projection.
 */
export function clipPolygonToPolygon(
  subject: PolygonGeometry,
  boundary: PolygonGeometry,
): PolygonGeometry | MultiPolygonGeometry | null {
  const subjectOuter = subject.coordinates[0];
  const boundaryOuter = boundary.coordinates[0];
  if (!subjectOuter || !boundaryOuter) return null;

  const outerParts = simpleRingIntersection(subjectOuter, boundaryOuter);
  if (outerParts.length === 0) return null;

  const polygons: PolygonGeometry[] = outerParts.map((outer) => ({
    type: "Polygon",
    coordinates: [ensureRingClosed(outer)],
  }));

  for (const subjectHole of subject.coordinates.slice(1)) {
    const holeParts = simpleRingIntersection(subjectHole, boundaryOuter);
    for (const hole of holeParts) {
      const closedHole = ensureRingClosed(hole);
      const owner = polygons.find((polygon) =>
        pointInRing(closedHole[0], closeRingForIntersection(polygon.coordinates[0])),
      );
      if (owner) owner.coordinates.push(closedHole);
    }
  }

  const normalized = polygons
    .map((polygon) => normalizePolygonGeometry(polygon))
    .filter((polygon): polygon is PolygonGeometry => polygon !== null && polygon.type === "Polygon");
  if (normalized.length === 0) return null;
  if (normalized.length === 1) return normalized[0];
  return {
    type: "MultiPolygon",
    coordinates: normalized.map((polygon) => polygon.coordinates),
  };
}


// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a single polygon's coordinate array.
 *
 * - Closes every ring.
 * - Ensures exterior ring is CCW.
 * - Ensures holes (interior rings) are CW.
 * - Removes degenerate rings (fewer than 3 vertices, zero area).
 * - Returns null when no valid ring remains.
 */
function normalizePolygon(rings: Position2D[][]): Position2D[][] | null {
  if (!rings || rings.length === 0) return null;

  const normalized: Position2D[][] = [];

  // --- Exterior ring -------------------------------------------------------
  let exterior = ensureRingClosed(rings[0]);
  if (exterior.length < 3) return null;
  if (Math.abs(ringArea(exterior)) < EPSILON) return null;
  if (ringWindingOrder(exterior) === "cw") {
    exterior = exterior.slice().reverse();
  }
  normalized.push(exterior);

  // --- Interior rings (holes) ----------------------------------------------
  for (let i = 1; i < rings.length; i++) {
    let hole = ensureRingClosed(rings[i]);
    if (hole.length < 3) continue;
    if (Math.abs(ringArea(hole)) < EPSILON) continue;
    if (ringWindingOrder(hole) === "ccw") {
      hole = hole.slice().reverse();
    }
    normalized.push(hole);
  }

  return normalized;
}

/**
 * Normalise a Polygon or MultiPolygon geometry.
 *
 * - Closes every ring.
 * - Enforces correct winding (CCW exterior, CW holes).
 * - Removes degenerate rings (too few vertices, zero area).
 * - Removes empty polygons from MultiPolygon.
 *
 * Returns null when the geometry is entirely degenerate or invalid.
 */
export function normalizePolygonGeometry(
  geometry: Geometry2D,
): Geometry2D | null {
  if (geometry.type === "Polygon") {
    const normalized = normalizePolygon(geometry.coordinates);
    if (!normalized) return null;
    return { type: "Polygon", coordinates: normalized };
  }

  if (geometry.type === "MultiPolygon") {
    const normalized: Position2D[][][] = [];
    for (const polyCoords of geometry.coordinates) {
      const norm = normalizePolygon(polyCoords);
      if (norm) {
        normalized.push(norm);
      }
    }
    if (normalized.length === 0) return null;
    return { type: "MultiPolygon", coordinates: normalized };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Returns true when the geometry type is Polygon. */
export function isPolygon(g: Geometry2D): g is PolygonGeometry {
  return g.type === "Polygon";
}

/** Returns true when the geometry type is MultiPolygon. */
export function isMultiPolygon(g: Geometry2D): g is MultiPolygonGeometry {
  return g.type === "MultiPolygon";
}

/**
 * Compute the axis-aligned bounding box of a Polygon or MultiPolygon.
 * Returns null for empty or degenerate geometry.
 */
export function polygonBounds(geometry: Geometry2D): Bounds2D | null {
  const coords: Position2D[] = [];

  if (geometry.type === "Polygon") {
    for (const ring of geometry.coordinates) {
      for (const p of ring) coords.push(p);
    }
  } else {
    for (const poly of geometry.coordinates) {
      for (const ring of poly) {
        for (const p of ring) coords.push(p);
      }
    }
  }

  if (coords.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [x, y] of coords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  return { minX, minY, maxX, maxY };
}