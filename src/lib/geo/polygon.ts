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