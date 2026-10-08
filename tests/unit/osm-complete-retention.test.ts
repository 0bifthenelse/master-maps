import { describe, expect, it } from "vitest";
import { OSM_DROP_REASONS, normalizeOsmBulkWithReport } from "../../scripts/data/normalizeOsmBulk";

const polygon = {
  type: "Polygon" as const,
  coordinates: [[[0.5, 43.6], [0.6, 43.6], [0.6, 43.7], [0.5, 43.7], [0.5, 43.6]]],
};
const line = { type: "LineString" as const, coordinates: [[0.5, 43.6], [0.6, 43.7]] as [number, number][] };
const closedWay = {
  type: "LineString" as const,
  coordinates: [[0.5, 43.6], [0.6, 43.6], [0.6, 43.7], [0.5, 43.7], [0.5, 43.6]] as [number, number][],
};
const point = { type: "Point" as const, coordinates: [0.55, 43.65] as [number, number] };

function run(features: Record<string, unknown>[]) {
  return normalizeOsmBulkWithReport(features, undefined, {
    sourceName: "osm-bulk",
    sourceUrl: "https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf",
    stableIdPrefix: "osm-bulk:",
    priority: 60,
    retention: "complete",
  });
}

describe("adopted OSM tag taxonomy", () => {
  it("keeps every highway class as a road", () => {
    const classes = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "service", "track", "path", "footway", "cycleway", "pedestrian", "steps", "bridleway", "living_street"];
    const result = run(classes.map((highway, index) => ({ id: `way/${index}`, geometry: line, properties: { highway } })));
    expect(result.features).toHaveLength(classes.length);
    expect(result.features.every((feature) => feature.kind === "road")).toBe(true);
    expect(new Set(result.features.map((feature) => feature.roadClass))).toEqual(new Set(classes));
    expect(result.report.droppedByReason.unclassified_tags).toBe(0);
  });

  it("leaves the public road network to BD TOPO when the pipeline asks it to", () => {
    const classes = ["primary", "residential", "unclassified", "service", "track", "footway", "cycleway", "steps"];
    const result = normalizeOsmBulkWithReport(classes.map((highway, index) => ({ id: `way/${index}`, geometry: line, properties: { highway } })), undefined, {
      sourceName: "osm-bulk",
      sourceUrl: "https://download.openstreetmap.fr/extracts/europe/france/midi_pyrenees/gers-latest.osm.pbf",
      stableIdPrefix: "osm-bulk:",
      priority: 60,
      retention: "complete",
      roadNetworkFromBdtopo: true,
    });
    expect(result.features.map((feature) => (feature.kind === "road" ? feature.roadClass : null))).toEqual(["service", "track", "footway", "cycleway", "steps"]);
    expect(result.report.droppedByReason.excluded_tag).toBe(3);
  });

  it("maps railway lines to transport rail and stations to transport points", () => {
    const result = run([
      { id: "way/1", geometry: line, properties: { railway: "rail", name: "Ligne d'Auch" } },
      { id: "node/2", geometry: point, properties: { railway: "station", name: "Gare d'Auch" } },
      { id: "node/3", geometry: point, properties: { railway: "halt" } },
    ]);
    expect(result.features.map((feature) => [feature.kind, "transportType" in feature ? feature.transportType : null])).toEqual([
      ["transport", "rail"],
      ["transport", "station"],
      ["transport", "halt"],
    ]);
    expect(result.features[0]?.geometry.type).toBe("LineString");
    expect(result.features[1]?.geometry.type).toBe("Point");
  });

  it("keeps unnamed bus stops and platforms as transport", () => {
    const result = run([
      { id: "node/1", geometry: point, properties: { highway: "bus_stop", public_transport: "platform" } },
      { id: "node/2", geometry: point, properties: { public_transport: "stop_position" } },
    ]);
    expect(result.features.map((feature) => feature.kind)).toEqual(["transport", "transport"]);
    expect(result.features.map((feature) => "transportType" in feature ? feature.transportType : null)).toEqual(["bus_stop", "platform"]);
    expect(result.features.every((feature) => feature.name === undefined)).toBe(true);
  });

  it("keeps place nodes as kind place with importance", () => {
    const result = run([
      { id: "node/1", geometry: point, properties: { place: "village", name: "Auch", population: "21327" } },
      { id: "node/2", geometry: point, properties: { place: "isolated_dwelling" } },
    ]);
    expect(result.features.map((feature) => feature.kind)).toEqual(["place", "place"]);
    expect(result.features[0]).toMatchObject({ placeType: "village", importance: 3, population: 21327 });
    expect(result.features[1]).toMatchObject({ placeType: "isolated_dwelling", importance: 6 });
  });

  it("closes a closed-way forest LineString into a landuse polygon", () => {
    const result = run([{ id: "way/1", geometry: closedWay, properties: { landuse: "forest", name: "Bois du Chapitre" } }]);
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.kind).toBe("landuse");
    expect(result.features[0]?.geometry.type).toBe("Polygon");
    expect(result.features[0]?.landuseType).toBe("forest");
  });

  it("maps natural wood, scrub, heath, vineyard and orchard to landuse", () => {
    const values = ["wood", "scrub", "heath", "vineyard", "orchard"];
    const result = run(values.map((natural, index) => ({ id: `way/${index}`, geometry: polygon, properties: { natural } })));
    expect(result.features.map((feature) => feature.kind)).toEqual(values.map(() => "landuse"));
    expect(result.features.map((feature) => "landuseType" in feature ? feature.landuseType : null)).toEqual(values);
  });

  it("maps leisure park, garden, playground, sports_centre and pitch to landuse", () => {
    const values = ["park", "garden", "playground", "sports_centre", "pitch"];
    const result = run(values.map((leisure, index) => ({ id: `way/${index}`, geometry: polygon, properties: { leisure } })));
    expect(result.features.map((feature) => feature.kind)).toEqual(values.map(() => "landuse"));
    expect(result.features.map((feature) => "landuseType" in feature ? feature.landuseType : null)).toEqual(["park", "garden", "playground", "sports", "sports"]);
  });

  it("maps aeroway runways and aerodromes to transport", () => {
    const result = run([
      { id: "way/1", geometry: line, properties: { aeroway: "runway", name: "Piste de Auch" } },
      { id: "way/2", geometry: polygon, properties: { aeroway: "aerodrome" } },
    ]);
    expect(result.features.map((feature) => feature.kind)).toEqual(["transport", "transport"]);
    expect(result.features.map((feature) => "transportType" in feature ? feature.transportType : null)).toEqual(["runway", "aerodrome"]);
  });

  it("keeps waterway lines as water and man_made bridge and works as points", () => {
    const result = run([
      { id: "way/1", geometry: line, properties: { waterway: "stream", name: "Le Gers" } },
      { id: "way/2", geometry: line, properties: { man_made: "bridge" } },
      { id: "way/3", geometry: polygon, properties: { man_made: "works" } },
    ]);
    expect(result.features.map((feature) => feature.kind)).toEqual(["water", "poi", "poi"]);
    expect(result.features[0]?.waterType).toBe("stream");
  });

  it("keeps amenity, shop and tourism features even without a name", () => {
    const result = run([
      { id: "node/1", geometry: point, properties: { amenity: "bench" } },
      { id: "node/2", geometry: point, properties: { shop: "bakery" } },
      { id: "node/3", geometry: point, properties: { tourism: "picnic_site" } },
    ]);
    expect(result.features.map((feature) => feature.kind)).toEqual(["poi", "poi", "poi"]);
    expect(result.features.map((feature) => "poiType" in feature ? feature.poiType : null)).toEqual(["bench", "bakery", "picnic_site"]);
  });

  it("excludes power, non-gate barriers, admin boundaries and disused railways", () => {
    const result = run([
      { id: "way/1", geometry: line, properties: { power: "line" } },
      { id: "node/2", geometry: point, properties: { power: "tower" } },
      { id: "way/3", geometry: line, properties: { barrier: "wall" } },
      { id: "node/4", geometry: point, properties: { barrier: "cattle_grid" } },
      { id: "way/5", geometry: polygon, properties: { boundary: "administrative", admin_level: "8" } },
      { id: "way/6", geometry: line, properties: { railway: "abandoned" } },
      { id: "way/7", geometry: line, properties: { highway: "construction" } },
      { id: "node/8", geometry: point, properties: { barrier: "gate" } },
    ]);
    expect(result.features.map((feature) => feature.stableId)).toEqual(["osm-bulk:node/8"]);
    expect(result.report.droppedByReason.excluded_tag).toBe(7);
  });

  it("counts every dropped feature in droppedByReason and balances the totals", () => {
    const result = run([
      { id: "way/1", geometry: line, properties: { highway: "residential" } },
      { id: "node/2", geometry: point, properties: { boundary: "administrative" } },
      { id: "way/3", geometry: point, properties: { natural: "wood" } },
      { id: "way/4", geometry: { type: "LineString", coordinates: [[0.5, 43.6], [0.6, 43.7]] }, properties: { source: "survey" } },
      { id: "way/5", geometry: polygon, properties: { highway: "path" } },
      { id: "way/6", geometry: polygon, properties: { landuse: "forest" } },
      { id: "way/7", geometry: polygon, properties: {} },
    ]);
    expect(result.report.inputTotal).toBe(7);
    expect(result.report.keptTotal).toBe(2);
    expect(result.report.droppedTotal).toBe(5);
    expect(result.report.droppedByReason).toEqual({
      unclassified_tags: 2,
      excluded_tag: 1,
      unreadable_geometry: 0,
      missing_source_id: 0,
      geometry_kind_mismatch: 2,
      outside_boundary: 0,
      degenerate_local_geometry: 0,
      schema_rejected: 0,
    });
    const summed = OSM_DROP_REASONS.reduce((total, reason) => total + result.report.droppedByReason[reason], 0);
    expect(summed).toBe(result.report.droppedTotal);
    expect(result.report.keptByCategory["road:residential"]).toBe(1);
  });

  it("drops a record with no source id", () => {
    const result = run([{ id: "", geometry: line, properties: { highway: "residential" } }]);
    expect(result.features).toHaveLength(0);
    expect(result.report.droppedByReason.missing_source_id).toBe(1);
  });

  it("drops features whose geometry is unreadable", () => {
    const result = run([
      { id: "way/1", geometry: { type: "LineString", coordinates: [["a", "b"], ["c", "d"]] }, properties: { highway: "residential" } },
      { id: "way/2", geometry: null, properties: { highway: "residential" } },
    ]);
    expect(result.features).toHaveLength(0);
    expect(result.report.droppedByReason.unreadable_geometry).toBe(2);
  });
});
