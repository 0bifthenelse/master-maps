import { describe, expect, it } from "vitest";
import { normalizeOsmWithReport } from "../../scripts/data/normalize";
import buildWater from "@/lib/scene/buildWater";

type Point = [number, number];

function boundary() {
  const rings: Point[][] = [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]];
  return {
    kind: "boundary" as const,
    stableId: "boundary",
    lon: 0,
    lat: 0,
    x: 0,
    z: 0,
    rings,
    centroidX: 0,
    centroidZ: 0,
    geometry: { type: "Polygon", coordinates: rings },
    localGeometry: { type: "Polygon", coordinates: rings },
    provenance: [],
    confidence: 1,
    status: "active" as const,
    sourceRefs: [],
  };
}

describe("normalization geometry eligibility", () => {
  it("preserves and clips an open waterway LineString", () => {
    const raw = {
      timestamp: "2026-08-27T00:00:00Z",
      query: "fixture",
      elements: [
        { type: "node", id: 1, lon: -5, lat: 5 },
        { type: "node", id: 2, lon: 5, lat: 5 },
        { type: "node", id: 3, lon: 15, lat: 5 },
        { type: "way", id: 100, nodes: [1, 2, 3], tags: { waterway: "river", name: "Test River" } },
      ],
    };

    const result = normalizeOsmWithReport(raw, boundary());
    const water = result.features.find((feature) => feature.kind === "water");
    expect(water).toBeDefined();
    expect(water?.geometry).toEqual({
      type: "LineString",
      coordinates: [[0, 5], [5, 5], [10, 5]],
    });
    expect(water?.localGeometry?.type).toBe("LineString");
    expect(result.relationIssues).toEqual([]);

    const localGeometry = water?.localGeometry as { type: "LineString"; coordinates: Point[] };
    const rendered = buildWater([{
      kind: "water",
      stableId: water!.stableId,
      geometry: localGeometry,
      waterType: "river",
    }]);
    expect(rendered.lineLengthMetres).toBeGreaterThan(0);
    expect(rendered.geometry.getAttribute("position").count).toBeGreaterThan(0);
    rendered.geometry.dispose();
  });

  it("clips a building polygon at the source boundary", () => {
    const raw = {
      timestamp: "2026-08-27T00:00:00Z",
      query: "fixture",
      elements: [
        { type: "node", id: 1, lon: -5, lat: 2 },
        { type: "node", id: 2, lon: 5, lat: 2 },
        { type: "node", id: 3, lon: 5, lat: 8 },
        { type: "node", id: 4, lon: -5, lat: 8 },
        { type: "way", id: 101, nodes: [1, 2, 3, 4, 1], tags: { building: "yes" } },
      ],
    };

    const result = normalizeOsmWithReport(raw, boundary());
    const building = result.features.find((feature) => feature.kind === "building");
    expect(building?.geometry.type).toBe("Polygon");
    const coordinates = (building?.geometry.coordinates as Point[][][]).flat();
    expect(coordinates.every(([lon, lat]) => lon >= 0 && lon <= 10 && lat >= 0 && lat <= 10)).toBe(true);
  });
});
