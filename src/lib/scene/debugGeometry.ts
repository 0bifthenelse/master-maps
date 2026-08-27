import type { BufferGeometry } from "three";

export interface GeometryDebugSnapshot {
  vertexCount: number;
  indexCount: number;
  positions: Array<[number, number, number]>;
}

export function snapshotBufferGeometry(geometry: BufferGeometry, maxVertices = 4096): GeometryDebugSnapshot {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const positions: Array<[number, number, number]> = [];
  if (position) {
    const limit = Math.min(position.count, maxVertices);
    for (let vertex = 0; vertex < limit; vertex += 1) positions.push([position.getX(vertex), position.getY(vertex), position.getZ(vertex)]);
  }
  return { vertexCount: position?.count ?? 0, indexCount: index?.count ?? 0, positions };
}
