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

export function tessellatePolyline(points: readonly PolylinePoint[], options: TessellationOptions): TessellatedPolyline {
  const halfWidth = options.halfWidth;
  const miterLimit = options.miterLimit ?? 4;
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) throw new Error(`halfWidth must be positive and finite, got ${halfWidth}`);
  if (!Number.isFinite(miterLimit) || miterLimit < 1) throw new Error(`miterLimit must be finite and at least one, got ${miterLimit}`);
  const clean = removeConsecutiveDuplicates(points);
  if (clean.length < 2) return { left: [], right: [], indices: [], miterJoinCount: 0, bevelJoinCount: 0 };

  const directions: TessellatedVertex[] = [];
  const normals: TessellatedVertex[] = [];
  for (let index = 0; index < clean.length - 1; index += 1) {
    const direction = unitVector(clean[index + 1]![0] - clean[index]![0], clean[index + 1]![1] - clean[index]![1]);
    directions.push(direction);
    normals.push(leftNormal(direction));
  }

  const left: TessellatedVertex[] = [];
  const right: TessellatedVertex[] = [];
  let miterJoinCount = 0;
  let bevelJoinCount = 0;
  for (let index = 0; index < clean.length; index += 1) {
    if (index === 0) {
      left.push(offset(clean[index]!, normals[0]!, halfWidth));
      right.push(offset(clean[index]!, normals[0]!, -halfWidth));
      continue;
    }
    if (index === clean.length - 1) {
      const normal = normals[normals.length - 1]!;
      left.push(offset(clean[index]!, normal, halfWidth));
      right.push(offset(clean[index]!, normal, -halfWidth));
      continue;
    }

    const incoming = directions[index - 1]!;
    const outgoing = directions[index]!;
    const incomingNormal = normals[index - 1]!;
    const outgoingNormal = normals[index]!;
    const directionDot = dot(incoming, outgoing);
    const turn = incoming[0] * outgoing[1] - incoming[1] * outgoing[0];
    const normalSum: TessellatedVertex = [incomingNormal[0] + outgoingNormal[0], incomingNormal[1] + outgoingNormal[1]];
    const miterDirection = unitVector(normalSum[0], normalSum[1]);
    const denominator = dot(miterDirection, outgoingNormal);
    const miterLength = Math.abs(denominator) > 1e-6 ? halfWidth / denominator : Infinity;

    if (directionDot > 0 && Number.isFinite(miterLength) && Math.abs(miterLength) <= halfWidth * miterLimit) {
      left.push(offset(clean[index]!, miterDirection, miterLength));
      right.push(offset(clean[index]!, miterDirection, -miterLength));
      miterJoinCount += 1;
      continue;
    }

    bevelJoinCount += 1;
    if (directionDot <= -0.95) {
      left.push([clean[index]![0], clean[index]![1]]);
      right.push([clean[index]![0], clean[index]![1]]);
      continue;
    }
    const leftNormalForJoin = turn >= 0 ? incomingNormal : outgoingNormal;
    const rightNormalForJoin = turn >= 0 ? outgoingNormal : incomingNormal;
    left.push(offset(clean[index]!, leftNormalForJoin, halfWidth));
    right.push(offset(clean[index]!, rightNormalForJoin, -halfWidth));
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

function removeConsecutiveDuplicates(points: readonly PolylinePoint[]): TessellatedVertex[] {
  const result: TessellatedVertex[] = [];
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) throw new Error("Polyline coordinates must be finite");
    const previous = result[result.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) result.push([point[0], point[1]]);
  }
  return result;
}

function unitVector(x: number, z: number): TessellatedVertex {
  const length = Math.hypot(x, z);
  return length < 1e-9 ? [1, 0] : [x / length, z / length];
}

function leftNormal(direction: TessellatedVertex): TessellatedVertex {
  return [-direction[1], direction[0]];
}

function dot(first: TessellatedVertex, second: TessellatedVertex): number {
  return first[0] * second[0] + first[1] * second[1];
}

function offset(point: PolylinePoint, direction: TessellatedVertex, distance: number): TessellatedVertex {
  return [point[0] + direction[0] * distance, point[1] + direction[1] * distance];
}
