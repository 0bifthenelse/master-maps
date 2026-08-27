import { describe, expect, it } from "vitest";
import { normalizeOsmBulk } from "../../scripts/data/normalizeOsmBulk";

describe("bulk OSM normalization", () => {
  it("anchors and localizes point and line features", () => {
    const features = normalizeOsmBulk([
      {
        id: "node/1",
        geometry: { type: "Point", coordinates: [0.6, 43.7] },
        properties: { name: "Town Hall", amenity: "townhall" },
      },
      {
        id: "way/2",
        geometry: { type: "LineString", coordinates: [[0.6, 43.7], [0.61, 43.7]] },
        properties: { highway: "path", name: "Riverside Path" },
      },
    ]);
    expect(features).toHaveLength(2);
    expect(features[0]).toMatchObject({ kind: "poi", lon: 0.6, lat: 43.7 });
    expect(features[1]).toMatchObject({ kind: "road", lon: expect.closeTo(0.605, 5), lat: expect.closeTo(43.7, 5) });
    expect(features[1]?.localGeometry).toEqual({
      type: "LineString",
      coordinates: [expect.any(Array), expect.any(Array)],
    });
  });
});
