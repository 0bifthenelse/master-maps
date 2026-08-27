import { describe, expect, it } from "vitest";
import {
  deduplicateOsmElements,
  reconstructMultipolygonRelation,
  type OsmElement,
  type OsmNodeElement,
  type OsmRelationElement,
  type OsmWayElement,
} from "../../scripts/data/osmRelations";

type Point = [number, number];

function nodes(points: Point[]): Map<number, Point> {
  return new Map(points.map((point, index) => [index + 1, point]));
}

function way(id: number, nodeIds: number[]): OsmWayElement {
  return { type: "way", id, nodes: nodeIds };
}

function relation(id: number, members: OsmRelationElement["members"]): OsmRelationElement {
  return { type: "relation", id, members, tags: { type: "multipolygon", building: "yes" } };
}

function area(ring: Point[]): number {
  let total = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    total += ring[index][0] * ring[index + 1][1] - ring[index + 1][0] * ring[index][1];
  }
  return total / 2;
}

describe("OSM multipolygon reconstruction", () => {
  it("joins reversed member segments and preserves an inner hole", () => {
    const pointMap = nodes([
      [0, 0], [10, 0], [10, 10], [0, 10],
      [2, 2], [2, 4], [4, 4], [4, 2],
    ]);
    const wayMap = new Map<number, OsmWayElement>([
      [101, way(101, [1, 2])],
      [102, way(102, [3, 2])],
      [103, way(103, [3, 4])],
      [104, way(104, [4, 1])],
      [105, way(105, [5, 6, 7, 8, 5])],
    ]);
    const result = reconstructMultipolygonRelation(
      relation(900, [
        { type: "way", ref: 101, role: "outer" },
        { type: "way", ref: 102, role: "outer" },
        { type: "way", ref: 103, role: "outer" },
        { type: "way", ref: 104, role: "outer" },
        { type: "way", ref: 105, role: "inner" },
        { type: "way", ref: 101, role: "outer" },
      ]),
      wayMap,
      pointMap,
    );

    expect("geometry" in result).toBe(true);
    if (!("geometry" in result)) return;
    expect(result.geometry.type).toBe("Polygon");
    expect(result.geometry.coordinates).toHaveLength(2);
    expect(result.memberWayIds).toEqual([101, 102, 103, 104, 105]);
    expect(area(result.geometry.coordinates[0])).toBeGreaterThan(0);
    expect(area(result.geometry.coordinates[1])).toBeLessThan(0);
  });

  it("returns multiple outer rings as a MultiPolygon", () => {
    const pointMap = nodes([
      [0, 0], [4, 0], [4, 4], [0, 4],
      [10, 0], [14, 0], [14, 4], [10, 4],
    ]);
    const wayMap = new Map<number, OsmWayElement>([
      [201, way(201, [1, 2, 3, 4, 1])],
      [202, way(202, [5, 6, 7, 8, 5])],
    ]);
    const result = reconstructMultipolygonRelation(
      relation(901, [
        { type: "way", ref: 201, role: "outer" },
        { type: "way", ref: 202, role: "outer" },
      ]),
      wayMap,
      pointMap,
    );

    expect("geometry" in result).toBe(true);
    if (!("geometry" in result)) return;
    expect(result.geometry.type).toBe("MultiPolygon");
    expect(result.geometry.coordinates).toHaveLength(2);
  });

  it("reports a missing member instead of fabricating a ring", () => {
    const pointMap = nodes([[0, 0], [1, 0], [1, 1]]);
    const result = reconstructMultipolygonRelation(
      relation(902, [{ type: "way", ref: 999, role: "outer" }]),
      new Map(),
      pointMap,
    );

    expect("reason" in result).toBe(true);
    if (!("reason" in result)) return;
    expect(result.relationId).toBe(902);
    expect(result.reason).toContain("missing member way");
  });

  it("deduplicates repeated typed OSM elements while merging tags", () => {
    const first: OsmNodeElement = { type: "node", id: 1, lon: 0, lat: 0 };
    const second: OsmNodeElement = { type: "node", id: 1, lon: 0, lat: 0, tags: { name: "A" } };
    const result = deduplicateOsmElements([first, second] as OsmElement[]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "node", id: 1, tags: { name: "A" } });
  });
});
