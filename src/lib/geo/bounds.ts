/**
 * 2D bounding box in local projected coordinates (x=east, z=north).
 * @remarks The `y` axis is always zero for visible map geometry per project contract.
 */
export interface Bounds2D {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A GeoJSON-like Geometry with a `type` and `coordinates` property. */
interface GeoJSONGeometry {
  type: string;
  coordinates: unknown;
}

/** A GeoJSON Feature-like object with an optional geometry. */
interface GeoJSONFeature {
  type?: string;
  geometry?: GeoJSONGeometry | null;
}

/** A GeoJSON FeatureCollection. */
interface GeoJSONFeatureCollection {
  type: string;
  features: GeoJSONFeature[];
}

/** A functional-feature shape carrying local projected coordinates. */
interface LocalFeature {
  kind: string;
  geometry?: {
    type: string;
    coordinates: unknown;
  };
}

// ── helpers ──────────────────────────────────────────────────────────

const _INF = Infinity;

function _safeFinite(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function _extentSingleCoord(
  coord: unknown,
  bounds: Bounds2D,
): Bounds2D {
  if (!Array.isArray(coord)) return bounds;
  const x = _safeFinite(coord[0]);
  const z = coord.length >= 2 ? _safeFinite(coord[1]) : 0;
  return {
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, z),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, z),
  };
}

function _extentCoords(
  coords: unknown,
  bounds: Bounds2D,
): Bounds2D {
  if (!Array.isArray(coords)) return bounds;
  // Determine nesting depth: first element is array → recursive
  if (coords.length > 0 && Array.isArray(coords[0] as unknown)) {
    return (coords as unknown[][]).reduce(
      (acc, ring) => _extentCoords(ring, acc),
      bounds,
    );
  }
  // Leaf: single coordinate pair
  return _extentSingleCoord(coords, bounds);
}

function _extentGeometry(
  geometry: GeoJSONGeometry | null | undefined,
  bounds: Bounds2D,
): Bounds2D {
  if (!geometry || !geometry.type || (geometry.type !== "GeometryCollection" && !Array.isArray(geometry.coordinates))) {
    return bounds;
  }

  switch (geometry.type) {
    case "Point":
      return _extentSingleCoord(geometry.coordinates, bounds);
    case "MultiPoint":
    case "LineString":
      return _extentCoords(geometry.coordinates, bounds);
    case "MultiLineString":
    case "Polygon":
      // Polygon: array of rings; MultiLineString: array of lines
      return _extentCoords(geometry.coordinates, bounds);
    case "MultiPolygon":
      return (geometry.coordinates as unknown as unknown[][][]).reduce(
        (acc, polygon) => _extentCoords(polygon, acc),
        bounds,
      );
    case "GeometryCollection":
      const geometries = (geometry as unknown as { geometries?: unknown }).geometries;
      if (Array.isArray(geometries)) {
        return geometries.reduce(
          (acc, geom) => _extentGeometry(geom as GeoJSONGeometry, acc),
          bounds,
        );
      }
      return bounds;
    default:
      return bounds;
  }
}

// ── public API ───────────────────────────────────────────────────────

/** Create an invalid bounds sentinel (maxX < minX). */
export function emptyBounds(): Bounds2D {
  return { minX: _INF, minY: _INF, maxX: -_INF, maxY: -_INF };
}

/** Test whether a bounds object is the empty sentinel. */
export function isEmptyBounds(b: Bounds2D): boolean {
  return b.minX > b.maxX || b.minY > b.maxY || !Number.isFinite(b.minX);
}

/**
 * Compute bounds from any GeoJSON object (Geometry, Feature, FeatureCollection).
 * Returns `emptyBounds()` if the input has no usable coordinates.
 */
export function computeGeoJsonBounds(
  input: GeoJSONGeometry | GeoJSONFeature | GeoJSONFeatureCollection | null | undefined,
): Bounds2D {
  const b = emptyBounds();
  if (!input) return b;

  if (input.type === "FeatureCollection") {
    const fc = input as GeoJSONFeatureCollection;
    if (!Array.isArray(fc.features)) return b;
    return fc.features.reduce(
      (acc, feat) => _extentGeometry(feat.geometry, acc),
      b,
    );
  }

  if (input.type === "Feature") {
    const feat = input as GeoJSONFeature;
    return computeGeoJsonBounds(feat.geometry ?? null);
  }

  // Geometry object
  return _extentGeometry(input as GeoJSONGeometry, b);
}

/**
 * Compute bounds from an array of local-projected features.
 * Operates on the optional `geometry` field of each feature.
 */
export function computeLocalBounds(features: LocalFeature[]): Bounds2D {
  return features.reduce(
    (acc, f) => {
      if (!f.geometry) return acc;
      return _extentGeometry(f.geometry, acc);
    },
    emptyBounds(),
  );
}

/**
 * Extend an existing bounds to include a point `[x, z]`.
 * Returns a new Bounds2D (does not mutate the input).
 */
export function extendBounds(bounds: Bounds2D, point: [number, number]): Bounds2D {
  const [x, z] = point;
  return {
    minX: Math.min(bounds.minX, x),
    minY: Math.min(bounds.minY, z),
    maxX: Math.max(bounds.maxX, x),
    maxY: Math.max(bounds.maxY, z),
  };
}

/** Test whether a point `[x, z]` lies inside (or on the edge of) the bounds. */
export function boundsContain(bounds: Bounds2D, point: [number, number]): boolean {
  if (isEmptyBounds(bounds)) return false;
  const [x, z] = point;
  return x >= bounds.minX && x <= bounds.maxX && z >= bounds.minY && z <= bounds.maxY;
}

/** Test whether two bounds rectangles intersect (share any interior or edge). */
export function boundsIntersect(a: Bounds2D, b: Bounds2D): boolean {
  if (isEmptyBounds(a) || isEmptyBounds(b)) return false;
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Compute the area of a bounds rectangle (width × height). Returns 0 for empty bounds. */
export function boundsArea(bounds: Bounds2D): number {
  if (isEmptyBounds(bounds)) return 0;
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxY - bounds.minY;
  return w * h;
}

/**
 * Compute the center point `[x, z]` of a bounds rectangle.
 * Returns `[NaN, NaN]` for empty bounds.
 */
export function boundsCenter(bounds: Bounds2D): [number, number] {
  if (isEmptyBounds(bounds)) return [NaN, NaN];
  return [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
  ];
}

/**
 * Compute the union of multiple bounds rectangles.
 * Returns `emptyBounds()` when the list is empty or all inputs are empty.
 */
export function unionBounds(boundsList: Bounds2D[]): Bounds2D {
  return boundsList.reduce(
    (acc, b) => {
      if (isEmptyBounds(b)) return acc;
      if (isEmptyBounds(acc)) return b;
      return {
        minX: Math.min(acc.minX, b.minX),
        minY: Math.min(acc.minY, b.minY),
        maxX: Math.max(acc.maxX, b.maxX),
        maxY: Math.max(acc.maxY, b.maxY),
      };
    },
    emptyBounds(),
  );
}