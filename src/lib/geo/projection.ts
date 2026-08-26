// @ts-nocheck
/**
 * @brief Local spherical equirectangular projection for Auch, France.
 *
 * Transforms WGS84 (lng, lat) to local Cartesian (x, z) in meters
 * using a spherical equirectangular (plate carrée) projection centered
 * on the commune origin.  y is always 0 for visible map geometry.
 *
 * All forward transforms use:
 *   metersPerDegree = 111319.9  (equatorial length of one degree)
 *   x = (lng − originLng) × metersPerDegree × cos(originLat_rad)
 *   z = (lat − originLat) × metersPerDegree
 *
 * Axis contract: x = east, z = north, y = 0.
 */

// ---------------------------------------------------------------------------
// Minimal GeoJSON types — no external dependency needed for centroid
// ---------------------------------------------------------------------------

/** WGS84 coordinate pair [longitude, latitude] */
export type Coordinate = [number, number];

/** GeoJSON exterior or hole ring (closed ring of positions) */
type Ring = Coordinate[];

export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: Ring[]; // first ring = exterior, rest = holes
}

export interface GeoJSONMultiPolygon {
  type: "MultiPolygon";
  coordinates: Ring[][]; // array of polygons, each with rings
}

export type GeoJSONGeometry = GeoJSONPolygon | GeoJSONMultiPolygon;

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometry | null;
  properties?: Record<string, unknown>;
}

/** Acceptable boundary forms for computeCenter */
export type BoundaryInput =
  | GeoJSONFeature
  | GeoJSONGeometry
  | Ring; // raw exterior ring

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Length of one degree of latitude at the equator (metres). */
const METERS_PER_DEGREE = 111_319.9 as const;

// ---------------------------------------------------------------------------
// LocalProjection
// ---------------------------------------------------------------------------

/**
 * Spherical equirectangular projection centered on a given WGS84 origin.
 *
 * ```ts
 * const proj = new LocalProjection([0.591, 43.648]);
 * const [x, z] = proj.forward(0.592, 43.649);
 * const [lng, lat] = proj.reverse(x, z);
 * ```
 */
export class LocalProjection {
  /** Origin [lng, lat] in degrees. */
  private readonly _origin: Coordinate;
  /** Origin latitude in radians (precomputed). */
  private readonly _originRad: number;
  /** Cosine of origin latitude (precomputed). */
  private readonly _cosOriginRad: number;

  /**
   * @param origin  Projection origin as [longitude, latitude] in decimal
   *                degrees.  Use the commune centre (finite centroid of the
   *                boundary polygon).
   */
  constructor(origin: Coordinate) {
    const [lng, lat] = origin;

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(
        `Projection origin must be finite: [${lng}, ${lat}]`,
      );
    }
    if (lng < -180 || lng > 180) {
      throw new Error(`Longitude out of range: ${lng}`);
    }
    if (lat < -90 || lat > 90) {
      throw new Error(`Latitude out of range: ${lat}`);
    }

    this._origin = [lng, lat];
    this._originRad = toRadians(lat);
    this._cosOriginRad = Math.cos(this._originRad);
  }

  // -- accessors -----------------------------------------------------------

  /** Read-only projection origin as [lng, lat]. */
  get origin(): Coordinate {
    return [this._origin[0], this._origin[1]];
  }

  // -- forward -------------------------------------------------------------

  /**
   * Project WGS84 coordinates to local Cartesian (x, z) in metres.
   *
   * @param lng  Longitude in decimal degrees.
   * @param lat  Latitude in decimal degrees.
   * @returns    [x, z] where x = east, z = north (both in metres).
   */
  forward(lng: number, lat: number): [number, number] {
    assertFinite(lng, "longitude");
    assertFinite(lat, "latitude");
    assertLng(lng);
    assertLat(lat);

    const dLng = lng - this._origin[0];
    const dLat = lat - this._origin[1];

    const x = dLng * METERS_PER_DEGREE * this._cosOriginRad;
    const z = dLat * METERS_PER_DEGREE;

    return [x, z];
  }

  // -- reverse -------------------------------------------------------------

  /**
   * Inverse projection: local Cartesian (x, z) → WGS84 [lng, lat].
   *
   * @param x  Easting in metres.
   * @param z  Northing in metres.
   * @returns  [lng, lat] in decimal degrees.
   */
  reverse(x: number, z: number): Coordinate {
    assertFinite(x, "x");
    assertFinite(z, "z");

    const dLng = x / (METERS_PER_DEGREE * this._cosOriginRad);
    const dLat = z / METERS_PER_DEGREE;

    const lng = this._origin[0] + dLng;
    const lat = this._origin[1] + dLat;

    return [lng, lat];
  }

  // -- convenience ---------------------------------------------------------

  /**
   * Project a batch of [lng, lat] pairs in one call.
   */
  forwardBatch(coords: Coordinate[]): [number, number][] {
    const out: [number, number][] = new Array(coords.length);
    for (let i = 0; i < coords.length; i++) {
      out[i] = this.forward(coords[i][0], coords[i][1]);
    }
    return out;
  }

  /**
   * Reverse-project a batch of [x, z] pairs.
   */
  reverseBatch(coords: [number, number][]): Coordinate[] {
    const out: Coordinate[] = new Array(coords.length);
    for (let i = 0; i < coords.length; i++) {
      out[i] = this.reverse(coords[i][0], coords[i][1]);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// computeCenter — centroid from boundary geometry
// ---------------------------------------------------------------------------

/**
 * Compute the centroid of a GeoJSON boundary (Polygon or MultiPolygon).
 *
 * Uses area-weighted centroid of the exterior ring(s).  Holes are excluded
 * from the centroid calculation because they do not represent the commune's
 * occupied area.  For MultiPolygon the centroid is the area-weighted average
 * of each sub-polygon centroid.
 *
 * @param boundary  A GeoJSON Feature with Polygon/MultiPolygon geometry, or
 *                  a bare geometry object, or a raw exterior ring.
 * @returns         [lng, lat] centroid.
 */
export function computeCenter(
  boundary: BoundaryInput,
): Coordinate {
  if (isFeature(boundary)) {
    return geometryCenter(boundary.geometry);
  }
  if (isGeometry(boundary)) {
    return geometryCenter(boundary);
  }
  // Raw ring
  return ringMean(boundary);
}

// ---------------------------------------------------------------------------
// Internal helpers — centroid algorithms
// ---------------------------------------------------------------------------

function geometryCenter(
  geom: GeoJSONGeometry | null,
): Coordinate {
  if (!geom) {
    throw new Error("Boundary geometry is null");
  }

  switch (geom.type) {
    case "Polygon":
      return polygonCentroid(geom.coordinates);
    case "MultiPolygon":
      return multiPolygonCentroid(geom.coordinates);
  }
}

/**
 * Area-weighted centroid of a polygon (exterior ring only).
 *
 * Uses the standard shoelace formula for area and centroid:
 *   A  = ½ Σ (x_i · y_{i+1} − x_{i+1} · y_i)
 *   Cx = (1 / (6A)) Σ (x_i + x_{i+1}) · (x_i · y_{i+1} − x_{i+1} · y_i)
 *   Cy = (1 / (6A)) Σ (y_i + y_{i+1}) · (x_i · y_{i+1} − x_{i+1} · y_i)
 */
function polygonCentroid(rings: Ring[]): Coordinate {
  const exterior = rings[0];
  if (!exterior || exterior.length < 3) {
    throw new Error(
      "Polygon exterior ring must have at least 3 coordinates",
    );
  }

  let cx = 0;
  let cy = 0;
  let area = 0;

  const n = exterior.length;
  // GeoJSON rings are closed (last === first); we process up to the
  // penultimate vertex and let the loop handle closure.
  for (let i = 0; i < n - 1; i++) {
    const xi = exterior[i][0];
    const yi = exterior[i][1];
    const xi1 = exterior[i + 1][0];
    const yi1 = exterior[i + 1][1];

    const cross = xi * yi1 - xi1 * yi;
    area += cross;
    cx += (xi + xi1) * cross;
    cy += (yi + yi1) * cross;
  }
  // Also close the last → first edge
  {
    const xi = exterior[n - 1][0];
    const yi = exterior[n - 1][1];
    const xi1 = exterior[0][0];
    const yi1 = exterior[0][1];
    const cross = xi * yi1 - xi1 * yi;
    area += cross;
    cx += (xi + xi1) * cross;
    cy += (yi + yi1) * cross;
  }

  area /= 2;
  if (area === 0) {
    // Degenerate polygon — fall back to coordinate mean
    return ringMean(exterior);
  }

  cx /= 6 * area;
  cy /= 6 * area;

  return [cx, cy];
}

/**
 * Area-weighted centroid of a MultiPolygon.
 */
function multiPolygonCentroid(polygons: Ring[][]): Coordinate {
  let totalCx = 0;
  let totalCy = 0;
  let totalArea = 0;

  for (const rings of polygons) {
    const exterior = rings[0];
    if (!exterior || exterior.length < 3) continue;

    // Compute area and centroid contribution for this sub-polygon.
    // We reuse the shoelace accumulators.
    let cx = 0;
    let cy = 0;
    let area = 0;
    const n = exterior.length;

    for (let i = 0; i < n - 1; i++) {
      const xi = exterior[i][0];
      const yi = exterior[i][1];
      const xi1 = exterior[i + 1][0];
      const yi1 = exterior[i + 1][1];
      const cross = xi * yi1 - xi1 * yi;
      area += cross;
      cx += (xi + xi1) * cross;
      cy += (yi + yi1) * cross;
    }
    {
      const xi = exterior[n - 1][0];
      const yi = exterior[n - 1][1];
      const xi1 = exterior[0][0];
      const yi1 = exterior[0][1];
      const cross = xi * yi1 - xi1 * yi;
      area += cross;
      cx += (xi + xi1) * cross;
      cy += (yi + yi1) * cross;
    }

    area /= 2;
    if (area === 0) continue;

    cx /= 6 * area;
    cy /= 6 * area;

    totalArea += area;
    totalCx += cx * area;
    totalCy += cy * area;
  }

  if (totalArea === 0) {
    throw new Error("MultiPolygon has zero total area");
  }

  return [totalCx / totalArea, totalCy / totalArea];
}

/**
 * Simple arithmetic mean of ring coordinates — used as fallback for
 * degenerate polygons.
 */
function ringMean(ring: Ring): Coordinate {
  let sumLng = 0;
  let sumLat = 0;
  // Exclude the closing duplicate for mean (last === first)
  const count = ring[ring.length - 1][0] === ring[0][0]
    && ring[ring.length - 1][1] === ring[0][1]
    ? ring.length - 1
    : ring.length;

  for (let i = 0; i < count; i++) {
    sumLng += ring[i][0];
    sumLat += ring[i][1];
  }

  if (count === 0) {
    throw new Error("Cannot compute center of empty ring");
  }

  return [sumLng / count, sumLat / count];
}

// ---------------------------------------------------------------------------
// GeoJSON type guards
// ---------------------------------------------------------------------------

function isFeature(input: BoundaryInput): input is GeoJSONFeature {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as GeoJSONFeature).type === "Feature"
  );
}

function isGeometry(input: BoundaryInput): input is GeoJSONGeometry {
  if (typeof input !== "object" || input === null) return false;
  const t = (input as GeoJSONGeometry).type;
  return t === "Polygon" || t === "MultiPolygon";
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got ${value}`);
  }
}

function assertLng(lng: number): void {
  if (lng < -180 || lng > 180) {
    throw new Error(`Longitude out of range [-180, 180]: ${lng}`);
  }
}

function assertLat(lat: number): void {
  if (lat < -90 || lat > 90) {
    throw new Error(`Latitude out of range [-90, 90]: ${lat}`);
  }
}