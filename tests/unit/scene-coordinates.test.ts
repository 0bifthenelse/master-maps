import { describe, expect, it } from "vitest";
import { Matrix4, Shape, ShapeGeometry, Vector3 } from "three";
import { mapShapeGeometryToWorld } from "@/lib/scene/geometryCoordinates";
import { buildBuildings } from "@/lib/scene/buildBuildings";
import { buildPois } from "@/lib/scene/buildPois";
import buildWater from "@/lib/scene/buildWater";
import { buildRoads } from "@/lib/scene/buildRoads";
function coordinatesOf(geometry: {
  getAttribute: (name: string) => {
    count: number;
    getX: (index: number) => number;
    getY: (index: number) => number;
    getZ: (index: number) => number;
  };
}): [number, number, number][] {
  const position = geometry.getAttribute("position");
  return Array.from({ length: position.count }, (_, index) => [
    position.getX(index),
    position.getY(index),
    position.getZ(index),
  ]);
}

describe("shared local x/z scene coordinate contract", () => {
  it("maps positive local northing to positive world z with an upward front face", () => {
    const shape = new Shape();
    shape.moveTo(0, 0);
    shape.lineTo(4, 0);
    shape.lineTo(4, 3);
    shape.lineTo(0, 3);
    shape.closePath();

    const geometry = mapShapeGeometryToWorld(new ShapeGeometry(shape));
    const positions = coordinatesOf(geometry);
    const normals = geometry.getAttribute("normal");

    expect(Math.min(...positions.map((position) => position[1]))).toBeCloseTo(0, 6);
    expect(Math.max(...positions.map((position) => position[2]))).toBeCloseTo(3, 6);
    expect(positions.some((position) => position[2] > 0)).toBe(true);
    expect(Array.from({ length: normals.count }, (_, index) => normals.getY(index)).every((value) => value > 0.9)).toBe(true);
    geometry.dispose();
  });

  it("keeps holes in the same x/z orientation", () => {
    const shape = new Shape();
    shape.moveTo(0, 0);
    shape.lineTo(10, 0);
    shape.lineTo(10, 10);
    shape.lineTo(0, 10);
    shape.closePath();
    const hole = new Shape();
    hole.moveTo(3, 3);
    hole.lineTo(3, 7);
    hole.lineTo(7, 7);
    hole.lineTo(7, 3);
    hole.closePath();
    shape.holes.push(hole);

    const geometry = mapShapeGeometryToWorld(new ShapeGeometry(shape));
    const positions = coordinatesOf(geometry);
    expect(Math.min(...positions.map((position) => position[2]))).toBeCloseTo(0, 6);
    expect(Math.max(...positions.map((position) => position[2]))).toBeCloseTo(10, 6);
    const index = geometry.getIndex();
    expect(index).not.toBeNull();
    for (let offset = 0; offset < index!.count; offset += 3) {
      const triangle = [index!.getX(offset), index!.getX(offset + 1), index!.getX(offset + 2)]
        .map((vertex) => positions[vertex]);
      const centerX = triangle.reduce((sum, position) => sum + position[0], 0) / 3;
      const centerZ = triangle.reduce((sum, position) => sum + position[2], 0) / 3;
      expect(centerX >= 3 && centerX <= 7 && centerZ >= 3 && centerZ <= 7).toBe(false);
    }
    geometry.dispose();
  });

  it("uses the same positive northing for buildings, roads, water, and POIs", () => {
    const building = buildBuildings([{
      kind: "building",
      stableId: "building",
      geometry: { type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 3], [0, 3], [0, 0]]] },
    }]);
    const road = buildRoads([{
      kind: "road",
      stableId: "road",
      geometry: { type: "LineString", coordinates: [[0, 0], [0, 3]] },
      highway: "residential",
    }]);
    const water = buildWater([{
      kind: "water",
      stableId: "water",
      geometry: { type: "LineString", coordinates: [[0, 0], [0, 3]] },
      waterType: "stream",
    }]);
    const poi = buildPois([{
      kind: "poi",
      stableId: "poi",
      geometry: { type: "Point", coordinates: [0, 3] },
    }]);

    expect(Math.max(...coordinatesOf(building.geometry).map((position) => position[2]))).toBeGreaterThan(0);
    expect(Math.max(...coordinatesOf(road.geometry).map((position) => position[2]))).toBeGreaterThan(0);
    expect(Math.max(...coordinatesOf(water.geometry).map((position) => position[2]))).toBeGreaterThan(0);

    const matrix = new Matrix4();
    const markerPosition = new Vector3();
    poi.mesh.getMatrixAt(0, matrix);
    markerPosition.setFromMatrixPosition(matrix);
    expect(markerPosition.z).toBeCloseTo(3, 6);

    building.geometry.dispose();
    road.geometry.dispose();
    water.geometry.dispose();
    poi.mesh.material.dispose();
  });
});
