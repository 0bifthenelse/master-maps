export type PolylinePoint = readonly [number, number];
export type TessellatedVertex = [number, number];

export interface TessellatedPolyline {
  left: TessellatedVertex[];
  right: TessellatedVertex[];
  indices: number[];
  miterJoinCount: number;
  bevelJoinCount: number;
}

export interface TessellationOptions {
  halfWidth: number;
  miterLimit?: number;
}

/**
 * Builds one indexed strip for one source polyline. The returned left/right
 * vertices are shared by adjacent segments. A MultiLineString must call this
 * function once per component, never with components concatenated.
 */
export function tessellatePolyline(
  points: readonly PolylinePoint[],
  options: TessellationOptions,
): TessellatedPolyline {
  const halfWidth = options.halfWidth;
  const miterLimit = options.miterLimit ?? 4;
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) {
    throw new Error(`halfWidth must be positive and finite, got ${halfWidth}`);
  }
  if (!Number.isFinite(miterLimit) || miterLimit < 1) {
    throw new Error(`miterLimit must be finite and at least one, got ${miterLimit}`);
  }
  const clean = removeConsecutiveDuplicates(points);
  if (clean.length < 2) {
    return { left: [], right: [], indices: [], miterJoinCount: 0, bevelJoinCount: 0 };
  }

  const left: TessellatedVertex[] = [];
  const right: TessellatedVertex[] = [];
  let miterJoinCount = 0;
  let bevelJoinCount = 0;

  for (let index = 0; index < clean.length; index += 1) {
    const previous = clean[Math.max(0, index - 1)]!;
    const current = clean[index]!;
    const next = clean[Math.min(clean.length - 1, index + 1)]!;
    const incoming = unitVector(current[0] - previous[0], current[1] - previous[1]);
    const outgoing = unitVector(next[0] - current[0], next[1] - current[1]);
    const previousNormal = leftNormal(incoming);
    const nextNormal = leftNormal(outgoing);

    if (index === 0 || index === clean.length - 1) {
      const normal = index === 0 ? nextNormal : previousNormal;
      left.push(offset(current, normal, halfWidth));
      right.push(offset(current, normal, -halfWidth));
      continue;
    }

    const sumX = previousNormal[0] + nextNormal[0];
    const sumZ = previousNormal[1] + nextNormal[1];
    const miterDirection = unitVector(sumX, sumZ);
    const denominator = dot(miterDirection, nextNormal);
    const miterLength = Math.abs(denominator) > 1e-6 ? halfWidth / denominator : Infinity;

    if (Number.isFinite(miterLength) && Math.abs(miterLength) <= halfWidth * miterLimit) {
      left.push(offset(current, miterDirection, miterLength));
      right.push(offset(current, miterDirection, -miterLength));
      miterJoinCount += 1;
    } else {
      // The averaged normal produces a bounded bevel fallback. It preserves
      // the source vertex and cannot create a spike at an acute turn.
      const bevelNormal = Math.abs(sumX) + Math.abs(sumZ) > 1e-6
        ? miterDirection
        : nextNormal;
      left.push(offset(current, bevelNormal, halfWidth));
      right.push(offset(current, bevelNormal, -halfWidth));
      bevelJoinCount += 1;
    }
  }

  const indices: number[] = [];
  for (let index = 0; index < clean.length - 1; index += 1) {
    const leftStart = index * 2;
    const rightStart = leftStart + 1;
    const leftEnd = leftStart + 2;
    const rightEnd = leftStart + 3;
    indices.push(leftStart, rightStart, leftEnd, rightStart, rightEnd, leftEnd);
  }
  return { left, right, indices, miterJoinCount, bevelJoinCount };
}

function removeConsecutiveDuplicates(points: readonly PolylinePoint[]): PolylinePoint[] {
  const result: PolylinePoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      throw new Error("Polyline coordinates must be finite");
    }
    const previous = result[result.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) result.push(point);
  }
  return result;
}

function unitVector(x: number, z: number): TessellatedVertex {
  const length = Math.hypot(x, z);
  if (length < 1e-9) return [1, 0];
  return [x / length, z / length];
}

function leftNormal(direction: TessellatedVertex): TessellatedVertex {
  return [-direction[1], direction[0]];
}

function dot(a: TessellatedVertex, b: TessellatedVertex): number {
  return a[0] * b[0] + a[1] * b[1];
}

function offset(point: PolylinePoint, direction: TessellatedVertex, distance: number): TessellatedVertex {
  return [point[0] + direction[0] * distance, point[1] + direction[1] * distance];
}
