import type { BufferGeometry } from "three";

export type LocalCoordinate = readonly [number, number];

/** Convert a local [x, z] map point to a Three.js [x, y, z] position. */
export function localToWorldPosition(
  [x, z]: LocalCoordinate,
  y = 0,
): [number, number, number] {
  return [x, y, z];
}

/**
 * Map ShapeGeometry's temporary XY coordinates into the map's XZ plane.
 * ShapeGeometry emits triangles facing +Z in XY space. Reversing each
 * triangle after mapping preserves a visible +Y front face without changing
 * the source x/z coordinates.
 */
export function mapShapeGeometryToWorld(
  geometry: BufferGeometry,
): BufferGeometry {
  const position = geometry.getAttribute("position");
  if (!position) return geometry;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getY(i);
    position.setXYZ(i, x, 0, z);
  }

  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i + 2 < index.count; i += 3) {
      const second = index.getX(i + 1);
      const third = index.getX(i + 2);
      index.setX(i + 1, third);
      index.setX(i + 2, second);
    }
    index.needsUpdate = true;
  } else {
    for (let i = 0; i + 2 < position.count; i += 3) {
      swapVertex(position, i + 1, i + 2);
    }
  }

  geometry.computeVertexNormals();
  return geometry;
}

function swapVertex(
  position: NonNullable<BufferGeometry["attributes"]["position"]>,
  first: number,
  second: number,
): void {
  const firstX = position.getX(first);
  const firstY = position.getY(first);
  const firstZ = position.getZ(first);
  position.setXYZ(first, position.getX(second), position.getY(second), position.getZ(second));
  position.setXYZ(second, firstX, firstY, firstZ);
}
