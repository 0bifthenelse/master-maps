/**
 * @file Geometry-derived camera focus coordinates.
 *
 * Given a feature's already-projected local geometry (metres, x = east,
 * z = north), computes the [x, z] point the camera should centre on:
 *
 *  - Point:                       the exact coordinate.
 *  - LineString:                  the length-weighted midpoint (the point at
 *                                  50% of the total polyline length), not the
 *                                  first vertex — a long street's first
 *                                  vertex can be far from its visual centre.
 *  - Polygon / MultiPolygon:       the area-weighted centroid of the exterior
 *                                  ring(s), matching how a human would read
 *                                  "the middle of the shape".
 *
 * @see PLAN §Phase 2 Step 2.7 — camera focus must derive from real geometry,
 *      not from a search-index anchor point.
 */

type LocalCoordinate = [number, number];

export type LocalGeometry =
  | { type: "Point"; coordinates: LocalCoordinate }
  | { type: "LineString"; coordinates: LocalCoordinate[] }
  | { type: "MultiLineString"; coordinates: LocalCoordinate[][] }
  | { type: "Polygon"; coordinates: LocalCoordinate[][] }
  | { type: "MultiPolygon"; coordinates: LocalCoordinate[][][] };

/** Length-weighted midpoint of a polyline: the point at 50% of total length. */
function lineStringMidpoint(coords: LocalCoordinate[]): LocalCoordinate {
  const first = coords[0];
  if (!first) throw new Error("lineStringMidpoint: empty coordinate list");
  if (coords.length === 1) return first;

  const segmentLengths: number[] = [];
  let totalLength = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    // Loop bound guarantees both indices exist.
    const [ax, az] = coords[i]!;
    const [bx, bz] = coords[i + 1]!;
    const length = Math.hypot(bx - ax, bz - az);
    segmentLengths.push(length);
    totalLength += length;
  }

  // Degenerate (coincident/colinear-zero-length) polyline: arithmetic mean.
  if (totalLength === 0) {
    const sum = coords.reduce<LocalCoordinate>(
      (acc, [x, z]) => [acc[0] + x, acc[1] + z],
      [0, 0],
    );
    return [sum[0] / coords.length, sum[1] / coords.length];
  }

  const halfLength = totalLength / 2;
  let accumulated = 0;
  for (let i = 0; i < segmentLengths.length; i++) {
    const segmentLength = segmentLengths[i]!;
    if (accumulated + segmentLength >= halfLength) {
      const t = segmentLength === 0 ? 0 : (halfLength - accumulated) / segmentLength;
      const [ax, az] = coords[i]!;
      const [bx, bz] = coords[i + 1]!;
      return [ax + (bx - ax) * t, az + (bz - az) * t];
    }
    accumulated += segmentLength;
  }

  return coords[coords.length - 1]!;
}
function lineStringLength(coords: LocalCoordinate[]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i += 1) {
    total += Math.hypot(
      coords[i + 1]![0] - coords[i]![0],
      coords[i + 1]![1] - coords[i]![1],
    );
  }
  return total;
}

function lineStringPointAtDistance(
  coords: LocalCoordinate[],
  distance: number,
): LocalCoordinate {
  const first = coords[0];
  if (!first) throw new Error("lineStringPointAtDistance: empty coordinate list");
  if (coords.length === 1) return first;
  let remaining = Math.max(0, distance);
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [ax, az] = coords[i]!;
    const [bx, bz] = coords[i + 1]!;
    const length = Math.hypot(bx - ax, bz - az);
    if (remaining <= length) {
      const t = length === 0 ? 0 : remaining / length;
      return [ax + (bx - ax) * t, az + (bz - az) * t];
    }
    remaining -= length;
  }
  return coords[coords.length - 1]!;
}

function multiLineStringMidpoint(lines: LocalCoordinate[][]): LocalCoordinate {
  let totalLength = 0;
  for (const line of lines) totalLength += lineStringLength(line);
  if (totalLength === 0) {
    const first = lines[0]?.[0];
    if (!first) throw new Error("multiLineStringMidpoint: empty geometry");
    return first;
  }

  const target = totalLength / 2;
  let accumulated = 0;
  for (const line of lines) {
    const length = lineStringLength(line);
    if (accumulated + length >= target) {
      return lineStringPointAtDistance(line, target - accumulated);
    }
    accumulated += length;
  }
  const lastLine = lines[lines.length - 1];
  if (!lastLine) throw new Error("multiLineStringMidpoint: empty geometry");
  return lastLine[lastLine.length - 1]!;
}

/** Area-weighted centroid of a single ring (shoelace formula); falls back to the arithmetic mean for a degenerate (zero-area) ring. */
function ringCentroid(ring: LocalCoordinate[]): { centroid: LocalCoordinate; area: number } {
  let signedArea = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < ring.length; i++) {
    // Loop bound guarantees ring[i]; modulo wraps within bounds for the closing edge.
    const [x0, z0] = ring[i]!;
    const [x1, z1] = ring[(i + 1) % ring.length]!;
    const cross = x0 * z1 - x1 * z0;
    signedArea += cross;
    cx += (x0 + x1) * cross;
    cz += (z0 + z1) * cross;
  }
  signedArea *= 0.5;

  if (signedArea === 0) {
    const sum = ring.reduce<LocalCoordinate>(
      (acc, [x, z]) => [acc[0] + x, acc[1] + z],
      [0, 0],
    );
    return { centroid: [sum[0] / ring.length, sum[1] / ring.length], area: 0 };
  }

  return {
    centroid: [cx / (6 * signedArea), cz / (6 * signedArea)],
    area: Math.abs(signedArea),
  };
}

/** Area-weighted centroid of a polygon's exterior ring (holes excluded). */
function polygonCentroid(rings: LocalCoordinate[][]): LocalCoordinate {
  const exterior = rings[0];
  if (!exterior) throw new Error("polygonCentroid: polygon has no exterior ring");
  return ringCentroid(exterior).centroid;
}

/** Area-weighted centroid across every polygon of a MultiPolygon. */
function multiPolygonCentroid(polygons: LocalCoordinate[][][]): LocalCoordinate {
  let totalArea = 0;
  let cx = 0;
  let cz = 0;
  for (const rings of polygons) {
    const exterior = rings[0];
    if (!exterior) continue;
    const { centroid, area } = ringCentroid(exterior);
    if (area === 0) continue;
    totalArea += area;
    cx += centroid[0] * area;
    cz += centroid[1] * area;
  }
  if (totalArea === 0) {
    // Every polygon degenerate: mean of their (degenerate) centroids.
    const sum = polygons.reduce<LocalCoordinate>((acc, rings) => {
      const exterior = rings[0];
      if (!exterior) return acc;
      const { centroid } = ringCentroid(exterior);
      return [acc[0] + centroid[0], acc[1] + centroid[1]];
    }, [0, 0]);
    return [sum[0] / polygons.length, sum[1] / polygons.length];
  }
  return [cx / totalArea, cz / totalArea];
}

/**
 * Compute the camera focus point [x, z] (local metres) for a feature's
 * projected local geometry.
 */
export function computeLocalFocus(geometry: LocalGeometry): LocalCoordinate {
  switch (geometry.type) {
    case "Point":
      return geometry.coordinates;
    case "LineString":
      return lineStringMidpoint(geometry.coordinates);
    case "MultiLineString":
      return multiLineStringMidpoint(geometry.coordinates);
    case "Polygon":
      return polygonCentroid(geometry.coordinates);
    case "MultiPolygon":
      return multiPolygonCentroid(geometry.coordinates);
    default: {
      const exhaustive: never = geometry;
      throw new Error(`computeLocalFocus: unsupported geometry type ${JSON.stringify(exhaustive)}`);
    }
  }
}
