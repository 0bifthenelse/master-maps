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

  it("retains complete Auch geometry classifications", () => {
    const config = {
      sourceName: "osm-auch",
      sourceUrl: "https://download.geofabrik.de/europe/france/midi-pyrenees.html",
      stableIdPrefix: "osm-auch:",
      priority: 65,
      retention: "complete" as const,
    };
    const polygon = { type: "Polygon" as const, coordinates: [[[0.5, 43.6], [0.6, 43.6], [0.6, 43.7], [0.5, 43.7], [0.5, 43.6]]] };
    const features = normalizeOsmBulk([
      { id: "way/1", geometry: polygon, properties: { building: "yes", name: "Hall", height: "12 m", "building:levels": "3", "roof:shape": "gabled" } },
      { id: "way/2", geometry: { type: "LineString", coordinates: [[0.5, 43.6], [0.6, 43.7]] }, properties: { highway: "tertiary", lanes: "2", bridge: "yes" } },
      { id: "way/3", geometry: polygon, properties: { natural: "water", name: "Le Gers" } },
      { id: "way/4", geometry: polygon, properties: { landuse: "residential" } },
      { id: "way/5", geometry: { type: "LineString", coordinates: [[0.5, 43.6], [0.6, 43.7]] }, properties: { railway: "rail" } },
      { id: "node/6", geometry: { type: "Point", coordinates: [0.55, 43.65] }, properties: { name: "NOCIBE", shop: "beauty" } },
      { id: "node/7", geometry: { type: "Point", coordinates: [0.55, 43.65] }, properties: { name: "Unnamed" } },
    ], undefined, config);
    expect(features.map((feature) => feature.kind)).toEqual(["building", "road", "water", "landuse", "transport", "poi"]);
    expect(features[0]).toMatchObject({ stableId: "osm-auch:way/1", height: 12, heightSource: "explicit", buildingType: "yes" });
    expect(features[1]).toMatchObject({ lanes: 2, bridge: true, provenance: [{ winner: "osm-auch", priority: 65 }] });
    expect(features[2]).toMatchObject({ waterType: "water", isSurface: true });
  });
});
