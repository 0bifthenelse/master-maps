type Point = [number, number];
type Ring = Point[];
type PolygonRings = Ring[];

interface Edge {
  start: Point;
  end: Point;
  minY: number;
  maxY: number;
}

interface IndexedRing {
  edges: Edge[];
  bins: Map<number, Edge[]>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const BIN_COUNT = 256;
const EPSILON = 1e-12;

export interface BoundaryIndex {
  contains(point: Point): boolean;
  lineInside(points: Point[]): boolean;
  lineOutside(points: Point[]): boolean;
  polygonInside(rings: PolygonRings): boolean;
  polygonOutside(rings: PolygonRings): boolean;
  /** True when any vertex is inside or any segment touches the boundary. */
  touches(points: Point[]): boolean;
}

export function createBoundaryIndex(polygons: PolygonRings[]): BoundaryIndex {
  const rings = polygons.flatMap((polygon) => polygon);
  const values = rings.flatMap((ring) => ring.flatMap((point) => point));
  const minY = Math.min(...values.filter((_, index) => index % 2 === 1));
  const maxY = Math.max(...values.filter((_, index) => index % 2 === 1));
  const span = Math.max(maxY - minY, EPSILON);
  const indexed = polygons.map((polygon) => polygon.map((ring) => createRingIndex(ring, minY, span)));
  const boundaryBins = new Map<number, Edge[]>();
  for (const polygon of indexed) {
    for (const ring of polygon) {
      for (const [bin, edges] of ring.bins) {
        boundaryBins.set(bin, [...(boundaryBins.get(bin) ?? []), ...edges]);
      }
    }
  }

  const binFor = (value: number): number => Math.max(0, Math.min(BIN_COUNT - 1, Math.floor(((value - minY) / span) * BIN_COUNT)));

  const ringContains = (point: Point, ring: IndexedRing): boolean => {
    if (point[0] < ring.minX || point[0] > ring.maxX || point[1] < ring.minY || point[1] > ring.maxY) return false;
    let inside = false;
    for (const edge of ring.bins.get(binFor(point[1])) ?? []) {
      const { start, end } = edge;
      if ((start[1] > point[1]) !== (end[1] > point[1])
        && point[0] < ((end[0] - start[0]) * (point[1] - start[1])) / (end[1] - start[1]) + start[0]) {
        inside = !inside;
      }
    }
    return inside;
  };

  const intersects = (first: Point, second: Point, edge: Edge): boolean => {
    const segmentMinY = Math.min(first[1], second[1]);
    const segmentMaxY = Math.max(first[1], second[1]);
    if (segmentMaxY < edge.minY || segmentMinY > edge.maxY) return false;
    const segmentMinX = Math.min(first[0], second[0]);
    const segmentMaxX = Math.max(first[0], second[0]);
    const edgeMinX = Math.min(edge.start[0], edge.end[0]);
    const edgeMaxX = Math.max(edge.start[0], edge.end[0]);
    if (segmentMaxX < edgeMinX || segmentMinX > edgeMaxX) return false;
    const orientation = (a: Point, b: Point, c: Point): number =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const firstTurn = orientation(first, second, edge.start);
    const secondTurn = orientation(first, second, edge.end);
    const thirdTurn = orientation(edge.start, edge.end, first);
    const fourthTurn = orientation(edge.start, edge.end, second);
    const onSegment = (a: Point, b: Point, c: Point): boolean =>
      Math.min(a[0], b[0]) - EPSILON <= c[0] && c[0] <= Math.max(a[0], b[0]) + EPSILON
      && Math.min(a[1], b[1]) - EPSILON <= c[1] && c[1] <= Math.max(a[1], b[1]) + EPSILON;
    if (Math.abs(firstTurn) <= EPSILON && onSegment(first, second, edge.start)) return true;
    if (Math.abs(secondTurn) <= EPSILON && onSegment(first, second, edge.end)) return true;
    if (Math.abs(thirdTurn) <= EPSILON && onSegment(edge.start, edge.end, first)) return true;
    if (Math.abs(fourthTurn) <= EPSILON && onSegment(edge.start, edge.end, second)) return true;
    return (firstTurn > 0) !== (secondTurn > 0) && (thirdTurn > 0) !== (fourthTurn > 0);
  };

  const segmentIntersectsBoundary = (first: Point, second: Point): boolean => {
    const segmentMinY = Math.min(first[1], second[1]);
    const segmentMaxY = Math.max(first[1], second[1]);
    if (segmentMaxY < minY || segmentMinY > maxY) return false;
    const firstBin = binFor(segmentMinY);
    const lastBin = binFor(segmentMaxY);
    const candidates = new Set<Edge>();
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      for (const edge of boundaryBins.get(bin) ?? []) candidates.add(edge);
    }
    for (const edge of candidates) if (intersects(first, second, edge)) return true;
    return false;
  };

  const contains = (point: Point): boolean => {
    for (const polygon of indexed) {
      const outer = polygon[0];
      if (!outer || !ringContains(point, outer)) continue;
      if (polygon.slice(1).some((hole) => ringContains(point, hole))) continue;
      return true;
    }
    return false;
  };

  const lineInside = (points: Point[]): boolean =>
    points.length >= 2
    && points.every(contains)
    && points.slice(0, -1).every((point, index) => !segmentIntersectsBoundary(point, points[index + 1]!));

  const lineOutside = (points: Point[]): boolean =>
    points.length >= 2
    && points.every((point) => !contains(point))
    && points.slice(0, -1).every((point, index) => !segmentIntersectsBoundary(point, points[index + 1]!));

  const polygonInside = (rings: PolygonRings): boolean => {
    if (rings.length === 0 || !rings.every((ring) => ring.length >= 3 && ring.every(contains))) return false;
    return rings.every((ring) => ring.every((point, index) => {
      const next = ring[(index + 1) % ring.length]!;
      return !segmentIntersectsBoundary(point, next);
    }));
  };

  const polygonOutside = (rings: PolygonRings): boolean =>
    rings.length > 0
    && rings.every((ring) => ring.length >= 3 && ring.every((point) => !contains(point)))
    && rings.every((ring) => ring.every((point, index) => {
      const next = ring[(index + 1) % ring.length]!;
      return !segmentIntersectsBoundary(point, next);
    }));

  const touches = (points: Point[]): boolean =>
    points.some(contains)
    || points.slice(0, -1).some((point, index) => segmentIntersectsBoundary(point, points[index + 1]!));

  return { contains, lineInside, lineOutside, polygonInside, polygonOutside, touches };
}

function createRingIndex(ring: Ring, globalMinY: number, globalSpan: number): IndexedRing {
  const points = ring.length > 1 && samePoint(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring.slice();
  const edges: Edge[] = [];
  const bins = new Map<number, Edge[]>();
  const values = points.flatMap((point) => point);
  const minX = Math.min(...values.filter((_, index) => index % 2 === 0));
  const maxX = Math.max(...values.filter((_, index) => index % 2 === 0));
  const minY = Math.min(...values.filter((_, index) => index % 2 === 1));
  const maxY = Math.max(...values.filter((_, index) => index % 2 === 1));
  const binFor = (value: number): number => Math.max(0, Math.min(BIN_COUNT - 1, Math.floor(((value - globalMinY) / globalSpan) * BIN_COUNT)));

  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    const edge: Edge = { start, end, minY: Math.min(start[1], end[1]), maxY: Math.max(start[1], end[1]) };
    edges.push(edge);
    const firstBin = binFor(edge.minY);
    const lastBin = binFor(edge.maxY);
    for (let bin = firstBin; bin <= lastBin; bin += 1) {
      const list = bins.get(bin) ?? [];
      list.push(edge);
      bins.set(bin, list);
    }
  }
  return { edges, bins, minX, minY, maxX, maxY };
}

function samePoint(first: Point, second: Point): boolean {
  return Math.abs(first[0] - second[0]) <= EPSILON && Math.abs(first[1] - second[1]) <= EPSILON;
}
