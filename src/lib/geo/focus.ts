type LocalCoordinate = [number, number];

export type LocalGeometry =
  | { type: "Point"; coordinates: LocalCoordinate }
  | { type: "LineString"; coordinates: LocalCoordinate[] }
  | { type: "MultiLineString"; coordinates: LocalCoordinate[][] }
  | { type: "Polygon"; coordinates: LocalCoordinate[][] }
  | { type: "MultiPolygon"; coordinates: LocalCoordinate[][][] };

function lineStringLength(coords: LocalCoordinate[]): number {
  let total = 0;
  for (let index = 0; index < coords.length - 1; index += 1) {
    total += Math.hypot(coords[index + 1]![0] - coords[index]![0], coords[index + 1]![1] - coords[index]![1]);
  }
  return total;
}

function pointAtDistance(coords: LocalCoordinate[], distance: number): LocalCoordinate {
  const first = coords[0];
  if (!first) throw new Error("pointAtDistance: empty coordinate list");
  let remaining = Math.max(0, distance);
  for (let index = 0; index < coords.length - 1; index += 1) {
    const start = coords[index]!;
    const end = coords[index + 1]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length;
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    remaining -= length;
  }
  return coords[coords.length - 1]!;
}

function lineStringMidpoint(coords: LocalCoordinate[]): LocalCoordinate {
  if (coords.length === 0) throw new Error("lineStringMidpoint: empty coordinate list");
  const total = lineStringLength(coords);
  if (total === 0) {
    const sum = coords.reduce<LocalCoordinate>((accumulator, point) => [accumulator[0] + point[0], accumulator[1] + point[1]], [0, 0]);
    return [sum[0] / coords.length, sum[1] / coords.length];
  }
  return pointAtDistance(coords, total / 2);
}

function multiLineStringMidpoint(lines: LocalCoordinate[][]): LocalCoordinate {
  let total = 0;
  for (const line of lines) total += lineStringLength(line);
  if (total === 0) {
    for (const line of lines) if (line[0]) return line[0];
    throw new Error("multiLineStringMidpoint: empty geometry");
  }
  let passed = 0;
  for (const line of lines) {
    const length = lineStringLength(line);
    if (passed + length >= total / 2) return pointAtDistance(line, total / 2 - passed);
    passed += length;
  }
  const last = lines[lines.length - 1];
  if (!last || !last[last.length - 1]) throw new Error("multiLineStringMidpoint: empty geometry");
  return last[last.length - 1]!;
}

function ringContribution(ring: LocalCoordinate[]): { area: number; centroid: LocalCoordinate } {
  if (ring.length < 3) return { area: 0, centroid: [0, 0] };
  let signedArea = 0;
  let centroidX = 0;
  let centroidZ = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index]!;
    const second = ring[(index + 1) % ring.length]!;
    const cross = first[0] * second[1] - second[0] * first[1];
    signedArea += cross;
    centroidX += (first[0] + second[0]) * cross;
    centroidZ += (first[1] + second[1]) * cross;
  }
  signedArea /= 2;
  const area = Math.abs(signedArea);
  if (area <= 1e-9) {
    const sum = ring.reduce<LocalCoordinate>((accumulator, point) => [accumulator[0] + point[0], accumulator[1] + point[1]], [0, 0]);
    return { area: 0, centroid: [sum[0] / ring.length, sum[1] / ring.length] };
  }
  return { area, centroid: [centroidX / (6 * signedArea), centroidZ / (6 * signedArea)] };
}

function polygonCentroid(rings: LocalCoordinate[][]): LocalCoordinate {
  const exterior = rings[0];
  if (!exterior) throw new Error("polygonCentroid: polygon has no exterior ring");
  const outer = ringContribution(exterior);
  let weight = outer.area;
  let x = outer.centroid[0] * outer.area;
  let z = outer.centroid[1] * outer.area;
  for (const hole of rings.slice(1)) {
    const contribution = ringContribution(hole);
    weight -= contribution.area;
    x -= contribution.centroid[0] * contribution.area;
    z -= contribution.centroid[1] * contribution.area;
  }
  if (weight <= 1e-9) return outer.centroid;
  return [x / weight, z / weight];
}

function multiPolygonCentroid(polygons: LocalCoordinate[][][]): LocalCoordinate {
  let weight = 0;
  let x = 0;
  let z = 0;
  for (const polygon of polygons) {
    const centroid = polygonCentroid(polygon);
    const outer = polygon[0];
    if (!outer) continue;
    const outerContribution = ringContribution(outer);
    let polygonWeight = outerContribution.area;
    for (const hole of polygon.slice(1)) polygonWeight -= ringContribution(hole).area;
    if (polygonWeight <= 1e-9) continue;
    weight += polygonWeight;
    x += centroid[0] * polygonWeight;
    z += centroid[1] * polygonWeight;
  }
  if (weight <= 1e-9) {
    const first = polygons[0]?.[0]?.[0];
    if (!first) throw new Error("multiPolygonCentroid: empty geometry");
    return first;
  }
  return [x / weight, z / weight];
}

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
  }
}
