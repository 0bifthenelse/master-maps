type Point = readonly [number, number];

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx * dx + dz * dz;
  if (lengthSquared === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  const ratio = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared));
  return Math.hypot(point[0] - (start[0] + ratio * dx), point[1] - (start[1] + ratio * dz));
}

/** Douglas–Peucker simplification of a polyline, keeping both ends. */
export function simplifyLine<T extends Point>(points: readonly T[], tolerance: number): T[] {
  if (points.length <= 2 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const pending: Array<[number, number]> = [[0, points.length - 1]];
  while (pending.length > 0) {
    const [startIndex, endIndex] = pending.pop()!;
    let greatest = tolerance;
    let split = -1;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const distance = pointToSegmentDistance(points[index]!, points[startIndex]!, points[endIndex]!);
      if (distance > greatest) {
        greatest = distance;
        split = index;
      }
    }
    if (split >= 0) {
      keep[split] = 1;
      pending.push([startIndex, split], [split, endIndex]);
    }
  }
  return points.filter((_point, index) => keep[index] === 1);
}
