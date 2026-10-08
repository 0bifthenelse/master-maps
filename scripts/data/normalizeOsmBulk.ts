import { renderToWgs84, wgs84ToRender } from "../../src/lib/geo/crs";
import { categoryForOsmTags } from "../../src/lib/data/categories";
import { clipLineStringToPolygon, clipPolygonToPolygon, normalizePolygonGeometry, type PolygonGeometry } from "../../src/lib/geo/polygon";
import type { BoundaryIndex } from "./boundaryIndex";
import { MapFeatureSchema, type Geometry, type MapFeature } from "../../src/lib/data/schema";

export interface BulkBoundary {
  polygons: PolygonGeometry[];
  index: BoundaryIndex;
}

type Coordinate = [number, number];
type AreaGeometry = Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;

const SOURCE_URL = "https://download.geofabrik.de/europe/france/midi-pyrenees.html";
const SOURCE_TIMESTAMP = new Date().toISOString();

export type OsmRetention = "complete";

export interface OsmNormalizeConfig {
  sourceName: string;
  sourceUrl: string;
  stableIdPrefix: string;
  priority: number;
  retention: OsmRetention;
}

const DEFAULT_OSM_NORMALIZE_CONFIG: OsmNormalizeConfig = {
  sourceName: "osm-bulk",
  sourceUrl: SOURCE_URL,
  stableIdPrefix: "osm-bulk:",
  priority: 60,
  retention: "complete",
};

export type CompleteKind = "building" | "water" | "landuse" | "road" | "transport" | "poi" | "place";

export type OsmDropReason =
  | "unclassified_tags"
  | "excluded_tag"
  | "unreadable_geometry"
  | "missing_source_id"
  | "geometry_kind_mismatch"
  | "outside_boundary"
  | "degenerate_local_geometry"
  | "schema_rejected";

export const OSM_DROP_REASONS: readonly OsmDropReason[] = [
  "unclassified_tags",
  "excluded_tag",
  "unreadable_geometry",
  "missing_source_id",
  "geometry_kind_mismatch",
  "outside_boundary",
  "degenerate_local_geometry",
  "schema_rejected",
];

export interface OsmNormalizeReport {
  inputTotal: number;
  keptTotal: number;
  droppedTotal: number;
  keptByKind: Record<string, number>;
  keptByCategory: Record<string, number>;
  droppedByReason: Record<OsmDropReason, number>;
}

export interface OsmNormalizeResult {
  features: MapFeature[];
  report: OsmNormalizeReport;
}

type GeometryMode = "areal" | "linear" | "point" | "any";

interface CompleteClassification {
  kind: CompleteKind;
  subtype: string;
  mode: GeometryMode;
}

const ROAD_HIGHWAY = new Set([
  "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
  "tertiary", "tertiary_link", "unclassified", "residential", "living_street", "service", "road", "busway",
  "track", "path", "footway", "cycleway", "bridleway", "pedestrian", "steps", "corridor", "via_ferrata",
]);
const ROAD_POINT_HIGHWAY = new Set(["mini_roundabout", "motorway_junction"]);
const TRANSPORT_POINT_HIGHWAY = new Set(["bus_stop", "stop"]);
const TRAFFIC_POLE_HIGHWAY = new Set([
  "crossing", "give_way", "traffic_signals", "street_lamp", "speed_camera", "turning_circle", "turning_loop", "milestone", "elevator",
]);
const EXCLUDED_HIGHWAY = new Set(["construction", "proposed", "raceway", "rest_area", "bus_stop:condition", "platform"]);

const RAILWAY_LINEAR = new Set(["rail", "light_rail", "subway", "tram", "narrow_gauge", "monorail", "funicular", "miniature", "preserved"]);
const RAILWAY_POINT_TRANSPORT: Record<string, string> = { station: "station", halt: "halt", stop: "halt", train_station_entrance: "station", subway_entrance: "station" };
const RAILWAY_POINT_POI = new Set(["level_crossing", "crossing", "switch", "signal", "buffer_stop", "derail", "traverser", "turntable", "crane", "signal_box", "gantry", "radio", "siding", "spur", "yard"]);
const RAILWAY_EXCLUDED = new Set(["abandoned", "disused", "razed", "proposed", "construction", "was", "removed", "demolished", "destroyed", "damaged", "unused", "closed", "obstructed"]);

const PUBLIC_TRANSPORT_TRANSPORT: Record<string, string> = { platform: "platform", stop_position: "platform", station: "station", stop_area: "station" };
const PUBLIC_TRANSPORT_EXCLUDED = new Set(["proposed", "construction", "disused", "abandoned"]);

const AEROWAY_TRANSPORT: Record<string, string> = { runway: "runway", taxiway: "runway", aerodrome: "aerodrome", airport: "aerodrome", heliport: "aerodrome" };
const AEROWAY_POINT_POI = new Set(["gate"]);
const AEROWAY_EXCLUDED = new Set(["apron", "terminal", "hangar", "windsock", "navigationaid", "beacon", "lighting", "windsock"]);

const WATERWAY_LINEAR = new Set(["river", "canal", "stream", "ditch", "drain", "riverbank"]);
const WATERWAY_POINT_POI = new Set(["dam", "weir", "lock_gate", "waterfall", "spring", "drinking_water", "water_point", "wash"]);

const NATURAL_WATER_AREA = new Set(["water", "wetland"]);
const NATURAL_AREA: Record<string, string> = { wood: "wood", forest: "forest", scrub: "scrub", heath: "heath", vineyard: "vineyard", orchard: "orchard", grassland: "grassland" };
const NATURAL_POINT_POI = new Set(["spring", "tree", "cave_entrance", "beach", "sand", "rock", "boulder"]);

const LEISURE_LANDUSE: Record<string, string> = {
  pitch: "sports",
  sports_centre: "sports",
  sports_hall: "sports",
  stadium: "sports",
  golf_course: "sports",
  nature_reserve: "reserve",
};
const LEISURE_POINT_POI = new Set(["horse_riding", "fishing", "fitness_station", "picnic_table", "outdoor_seating", "slipway", "swimming_pool", "bird_hide"]);
const LEISURE_AREAL_ONLY = new Set(Object.keys(LEISURE_LANDUSE));

const MAN_MADE_STRUCTURE = new Set(["bridge", "works"]);
/* Landmarks a map reader navigates by: Gers windmills, water towers and masts. */
const MAN_MADE_LANDMARK = new Set(["windmill", "water_tower", "tower", "mast", "lighthouse", "chimney", "silo", "watermill", "wastewater_plant", "water_works", "observatory"]);

const BARRIER_GATE = new Set(["gate", "stile", "lift_gate", "swing_gate", "kissing_gate", "wicket_gate", "bump_gate"]);

const POI_TAGS = ["shop", "amenity", "tourism", "historic", "office", "craft", "healthcare", "emergency", "information"] as const;

const PLACE_IMPORTANCE: Record<string, number> = {
  continent: 1, country: 1, state: 2, region: 2, province: 2, county: 3, municipality: 2, city: 1, town: 2,
  borough: 3, suburb: 4, quarter: 5, village: 3, neighbourhood: 5, city_block: 5, locality: 5, square: 5,
  islet: 5, hamlet: 6, isolated_dwelling: 6, farm: 6,
};

const PLACE_KINDS = new Set(Object.keys(PLACE_IMPORTANCE));

interface GeometryOutcome {
  ok: boolean;
  geometry?: Geometry;
  reason: OsmDropReason;
}

function resolveGeometry(geometry: Geometry, mode: GeometryMode): GeometryOutcome {
  const keep: GeometryOutcome = { ok: true, geometry, reason: "unclassified_tags" };
  const reject: GeometryOutcome = { ok: false, reason: "geometry_kind_mismatch" };
  if (mode === "point" || mode === "any") return keep;
  if (mode === "linear") {
    return geometry.type === "LineString" || geometry.type === "MultiLineString" ? keep : reject;
  }
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return keep;
  if (geometry.type !== "LineString") return reject;
  const ring = closedRing(geometry.coordinates);
  return ring === null ? reject : { ok: true, geometry: { type: "Polygon", coordinates: [ring] }, reason: "unclassified_tags" };
}

function poiTagValue(properties: Record<string, unknown>): string | undefined {
  for (const key of POI_TAGS) {
    const value = text(properties[key]);
    if (value !== undefined && value !== "no") return value;
  }
  return undefined;
}

function classifyCompleteTags(properties: Record<string, unknown>): CompleteClassification | OsmDropReason {
  const building = text(properties.building);
  if (building !== undefined || text(properties["building:part"]) !== undefined) {
    /* A shop, church or town hall is often mapped on its building outline.
       BD TOPO already supplies the footprint, so the OSM object is kept for
       what only it carries: the named place people search for. */
    const poi = poiTagValue(properties);
    if (poi !== undefined && text(properties.name) !== undefined) return { kind: "poi", subtype: poi, mode: "any" };
    return { kind: "building", subtype: building ?? "part", mode: "areal" };
  }
  const place = text(properties.place);
  if (place !== undefined) {
    return PLACE_KINDS.has(place) ? { kind: "place", subtype: place, mode: "any" } : "excluded_tag";
  }
  if (text(properties.boundary) !== undefined) return "excluded_tag";
  const highway = text(properties.highway);
  if (highway !== undefined && TRANSPORT_POINT_HIGHWAY.has(highway)) return { kind: "transport", subtype: "bus_stop", mode: "point" };
  if (highway !== undefined && EXCLUDED_HIGHWAY.has(highway)) return "excluded_tag";
  const railway = text(properties.railway);
  if (railway !== undefined) {
    if (RAILWAY_LINEAR.has(railway)) return { kind: "transport", subtype: "rail", mode: "linear" };
    const station = RAILWAY_POINT_TRANSPORT[railway];
    if (station !== undefined) return { kind: "transport", subtype: station, mode: "point" };
    if (RAILWAY_POINT_POI.has(railway)) return { kind: "poi", subtype: railway, mode: "point" };
    return RAILWAY_EXCLUDED.has(railway) ? "excluded_tag" : "unclassified_tags";
  }
  const publicTransport = text(properties["public_transport"]);
  if (publicTransport !== undefined) {
    const transport = PUBLIC_TRANSPORT_TRANSPORT[publicTransport];
    if (transport !== undefined) return { kind: "transport", subtype: transport, mode: "any" };
    return PUBLIC_TRANSPORT_EXCLUDED.has(publicTransport) ? "excluded_tag" : "unclassified_tags";
  }
  const aeroway = text(properties.aeroway);
  if (aeroway !== undefined) {
    const transport = AEROWAY_TRANSPORT[aeroway];
    if (transport !== undefined) return { kind: "transport", subtype: transport, mode: "any" };
    if (AEROWAY_POINT_POI.has(aeroway)) return { kind: "poi", subtype: aeroway, mode: "point" };
    return AEROWAY_EXCLUDED.has(aeroway) ? "excluded_tag" : "unclassified_tags";
  }
  const waterway = text(properties.waterway);
  if (waterway !== undefined) {
    if (WATERWAY_LINEAR.has(waterway)) return { kind: "water", subtype: waterway, mode: "any" };
    if (WATERWAY_POINT_POI.has(waterway)) return { kind: "poi", subtype: waterway, mode: "point" };
    return "excluded_tag";
  }
  const landuse = text(properties.landuse);
  if (landuse !== undefined) {
    if (landuse === "reservoir" || landuse === "basin") return { kind: "water", subtype: landuse, mode: "areal" };
    return { kind: "landuse", subtype: landuse, mode: "areal" };
  }
  const natural = text(properties.natural);
  if (natural !== undefined) {
    if (NATURAL_WATER_AREA.has(natural)) return { kind: "water", subtype: natural, mode: "areal" };
    const area = NATURAL_AREA[natural];
    if (area !== undefined) return { kind: "landuse", subtype: area, mode: "areal" };
    if (NATURAL_POINT_POI.has(natural)) return { kind: "poi", subtype: natural, mode: "point" };
    return "excluded_tag";
  }
  const leisure = text(properties.leisure);
  if (leisure !== undefined) {
    if (LEISURE_AREAL_ONLY.has(leisure)) return { kind: "landuse", subtype: LEISURE_LANDUSE[leisure]!, mode: "areal" };
    return LEISURE_POINT_POI.has(leisure) ? { kind: "poi", subtype: leisure, mode: "point" } : { kind: "landuse", subtype: leisure, mode: "any" };
  }
  const manMade = text(properties["man_made"]);
  if (manMade !== undefined) {
    if (MAN_MADE_STRUCTURE.has(manMade) || MAN_MADE_LANDMARK.has(manMade)) return { kind: "poi", subtype: manMade, mode: "any" };
    return "excluded_tag";
  }
  if (highway !== undefined) {
    if (ROAD_HIGHWAY.has(highway)) return { kind: "road", subtype: highway, mode: "linear" };
    if (ROAD_POINT_HIGHWAY.has(highway)) return { kind: "road", subtype: highway, mode: "point" };
    if (TRAFFIC_POLE_HIGHWAY.has(highway)) return { kind: "poi", subtype: highway, mode: "point" };
    return "unclassified_tags";
  }
  const barrier = text(properties.barrier);
  if (barrier !== undefined) {
    return BARRIER_GATE.has(barrier) ? { kind: "poi", subtype: barrier, mode: "point" } : "excluded_tag";
  }
  if (text(properties.power) !== undefined) return "excluded_tag";
  for (const key of POI_TAGS) {
    const value = text(properties[key]);
    if (value !== undefined) return { kind: "poi", subtype: value, mode: "point" };
  }
  return "unclassified_tags";
}

function clipGeometryToBoundary(sourceGeometry: Geometry, boundary: BulkBoundary | undefined): Geometry | null {
  if (!boundary) return sourceGeometry;
  if (sourceGeometry.type === "Point") return boundary.index.contains(sourceGeometry.coordinates) ? sourceGeometry : null;
  if (sourceGeometry.type === "LineString" || sourceGeometry.type === "MultiLineString") {
    const vertices = sourceGeometry.type === "LineString" ? sourceGeometry.coordinates : sourceGeometry.coordinates.flat();
    const sourceLines = sourceGeometry.type === "LineString" ? [sourceGeometry.coordinates] : sourceGeometry.coordinates;
    /* Almost every way lies well inside the department: skip the exact clip for those. */
    if (sourceLines.every((line) => boundary.index.lineInside(line))) return sourceGeometry;
    if (!boundary.index.touches(vertices)) return null;
    const lines = sourceLines
      .flatMap((line) => boundary.polygons.flatMap((polygon) => clipLineStringToPolygon(line, polygon)));
    if (lines.length === 0) return null;
    return lines.length === 1 ? { type: "LineString", coordinates: lines[0]! } : { type: "MultiLineString", coordinates: lines };
  }
  const rings = sourceGeometry.type === "Polygon" ? [sourceGeometry.coordinates] : sourceGeometry.coordinates;
  if (rings.every((polygon) => boundary.index.polygonInside(polygon))) return sourceGeometry;
  if (rings.every((polygon) => boundary.index.polygonOutside(polygon))) return null;
  const polygons = rings.flatMap((coordinates) => boundary.polygons.flatMap((polygon) => {
    const clipped = clipPolygonToPolygon({ type: "Polygon", coordinates }, polygon);
    if (!clipped) return [];
    return clipped.type === "Polygon" ? [clipped.coordinates] : clipped.coordinates;
  }));
  if (polygons.length === 0) return null;
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };
}

function parseLanes(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const candidate = Number.parseInt(value.trim(), 10);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : undefined;
}

function parseMaxSpeed(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(\d+)(?:\.\d+)?/);
  if (!match) return undefined;
  const candidate = Number.parseInt(match[1]!, 10);
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function parsePopulation(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const candidate = Number.parseInt(value.trim().replace(/[^\d]/g, ""), 10);
  return Number.isInteger(candidate) && candidate >= 0 ? candidate : undefined;
}

function completeFeature(
  raw: Record<string, unknown>,
  properties: Record<string, unknown>,
  sourceGeometry: Geometry,
  boundary: BulkBoundary | undefined,
  config: OsmNormalizeConfig,
): { feature: MapFeature | null; reason: OsmDropReason } {
  const classification = classifyCompleteTags(properties);
  if (typeof classification === "string") return { feature: null, reason: classification };
  const resolved = resolveGeometry(sourceGeometry, classification.mode);
  if (!resolved.ok || !resolved.geometry) return { feature: null, reason: resolved.reason };
  const sourceId = stableSourceId(raw, properties);
  if (!sourceId) return { feature: null, reason: "missing_source_id" };
  const effective = clipGeometryToBoundary(resolved.geometry, boundary);
  if (!effective) return { feature: null, reason: "outside_boundary" };
  const isPoint = classification.mode === "point";
  const anchor = isPoint && effective.type === "Point"
    ? effective.coordinates
    : anchorFor(effective, geometryAnchor(localize(effective) ?? effective), boundary);
  const localAnchor = wgs84ToRender(anchor);
  const stableId = `${config.stableIdPrefix}${sourceId}`;
  const objectUrl = sourceObjectUrl(sourceId);
  const base = {
    stableId,
    sourceId,
    name: text(properties.name),
    lon: anchor[0],
    lat: anchor[1],
    x: localAnchor[0],
    z: localAnchor[1],
    confidence: "medium" as const,
    status: "active" as const,
    sourceGeometry: effective,
    sourceRefs: [{ source: config.sourceName, url: objectUrl ?? config.sourceUrl, timestamp: SOURCE_TIMESTAMP, license: "ODbL-1.0" }],
    provenance: [{ featureId: stableId, property: "geometry", winner: config.sourceName, contenders: [config.sourceName], priority: config.priority, timestamp: SOURCE_TIMESTAMP }],
  };
  const sourceMetadata = metadata({
    sourceId,
    sourceObjectUrl: objectUrl,
    tags: text(properties["@id"]) ?? text(raw.id),
    highway: properties.highway,
    railway: properties.railway,
    publicTransport: properties["public_transport"],
    place: properties.place,
    aeroway: properties.aeroway,
    waterway: properties.waterway,
    natural: properties.natural,
    landuse: properties.landuse,
    leisure: properties.leisure,
    manMade: properties["man_made"],
    barrier: properties.barrier,
    amenity: properties.amenity,
    shop: properties.shop,
    tourism: properties.tourism,
    historic: properties.historic,
    office: properties.office,
    craft: properties.craft,
    healthcare: properties.healthcare,
    brand: properties.brand,
    cuisine: properties.cuisine,
    email: properties.email ?? properties["contact:email"],
    ref: properties.ref,
    altName: properties["alt_name"],
    occitanName: properties["name:oc"],
    wikipedia: properties.wikipedia,
    wikidata: properties.wikidata,
    religion: properties.religion,
    sport: properties.sport,
  });
  const geometry: Geometry = isPoint ? { type: "Point", coordinates: anchor } : effective;
  const localGeometry: Geometry = isPoint
    ? { type: "Point", coordinates: localAnchor }
    : localize(effective) ?? geometry;
  if (classification.kind === "building") {
    const height = parseWidth(properties.height);
    const levels = Number.parseInt(text(properties["building:levels"]) ?? "", 10);
    const validLevels = Number.isFinite(levels) && levels >= 0 ? levels : undefined;
    const inferredHeight = height ?? (validLevels !== undefined && validLevels > 0 ? validLevels * 3 : 3);
    const heightSource = height !== undefined ? "explicit" : validLevels !== undefined && validLevels > 0 ? "inferred_from_levels" : "inferred_default";
    return { feature: parseCompleteFeature({
      ...base,
      kind: "building",
      geometry,
      localGeometry,
      height: inferredHeight,
      heightInferred: height === undefined,
      heightSource,
      levels: validLevels,
      buildingType: classification.subtype,
      roofType: text(properties["roof:shape"]),
      wallType: text(properties["building:material"]),
      buildingColour: text(properties["building:colour"]),
      roofColour: text(properties["roof:colour"]),
      startDate: text(properties["start_date"]),
      sourceMetadata,
    }), reason: "unclassified_tags" };
  }
  if (classification.kind === "water") {
    const width = parseWidth(properties.width ?? properties["water:width"]);
    const salt = text(properties.salt);
    return { feature: parseCompleteFeature({
      ...base,
      kind: "water",
      geometry,
      localGeometry,
      waterType: classification.subtype,
      width,
      widthInferred: width === undefined,
      isSurface: geometry.type === "Polygon" || geometry.type === "MultiPolygon",
      intermittent: parseBoolean(properties.intermittent),
      salt: salt === "yes" || salt === "no" ? salt : undefined,
      tidal: parseBoolean(properties.tidal),
      sourceMetadata,
    }), reason: "unclassified_tags" };
  }
  if (classification.kind === "landuse") {
    return { feature: parseCompleteFeature({
      ...base,
      kind: "landuse",
      geometry,
      localGeometry,
      landuseType: classification.subtype,
      sourceMetadata,
    }), reason: "unclassified_tags" };
  }
  if (classification.kind === "road") {
    const width = parseWidth(properties.width);
    const bridge = parseBoolean(properties.bridge);
    const tunnel = parseBoolean(properties.tunnel);
    return { feature: parseCompleteFeature({
      ...base,
      kind: "road",
      geometry,
      localGeometry,
      highway: classification.subtype,
      roadClass: classification.subtype,
      ref: text(properties.ref),
      width,
      widthInferred: width === undefined,
      widthSource: width === undefined ? "inferred_default" : "explicit",
      lanes: parseLanes(properties.lanes),
      surface: text(properties.surface),
      maxSpeed: parseMaxSpeed(properties.maxspeed),
      bridge,
      tunnel,
      stratum: tunnel ? "tunnel" : bridge ? "bridge" : "normal",
      layer: text(properties.layer),
      oneway: parseBoolean(properties.oneway),
      lit: parseBoolean(properties.lit),
      sidewalk: text(properties.sidewalk),
      sourceMetadata,
    }), reason: "unclassified_tags" };
  }
  if (classification.kind === "transport") {
    return { feature: parseCompleteFeature({
      ...base,
      kind: "transport",
      geometry,
      localGeometry,
      transportType: classification.subtype,
      line: text(properties.line),
      route: text(properties.route),
      network: text(properties.network),
      operator: text(properties.operator),
      ref: text(properties.ref),
      publicTransport: text(properties["public_transport"]),
      wheelchair: text(properties.wheelchair),
      sourceMetadata,
    }), reason: "unclassified_tags" };
  }
  if (classification.kind === "place") {
    return { feature: parseCompleteFeature({
      ...base,
      kind: "place",
      geometry,
      localGeometry,
      placeType: classification.subtype,
      importance: PLACE_IMPORTANCE[classification.subtype],
      population: parsePopulation(properties.population),
      sourceMetadata,
    }), reason: "unclassified_tags" };
  }
  return { feature: parseCompleteFeature({
    ...base,
    kind: "poi",
    geometry,
    localGeometry,
    poiType: classification.subtype,
    category: categoryForOsmTags(properties) ?? text(properties.amenity) ?? text(properties.shop) ?? text(properties.tourism) ?? text(properties.historic) ?? text(properties.office) ?? text(properties.craft) ?? text(properties.healthcare) ?? text(properties["man_made"]) ?? text(properties.leisure) ?? text(properties.natural),
    address: osmAddress(properties),
    website: text(properties.website) ?? text(properties["contact:website"]),
    phone: text(properties.phone) ?? text(properties["contact:phone"]),
    openingHours: text(properties["opening_hours"]),
    wheelchair: text(properties.wheelchair),
    operator: text(properties.operator),
    sourceMetadata,
  }), reason: "unclassified_tags" };
}

/** "12 Rue Gambetta, 32000 Auch" from the addr:* tags, when they say enough. */
export function osmAddress(properties: Record<string, unknown>): string | undefined {
  const street = text(properties["addr:street"]) ?? text(properties["addr:place"]);
  if (street === undefined) return undefined;
  const line = [text(properties["addr:housenumber"]), street].filter((part) => part !== undefined).join(" ");
  const locality = [text(properties["addr:postcode"]), text(properties["addr:city"])].filter((part) => part !== undefined).join(" ");
  return locality.length > 0 ? `${line}, ${locality}` : line;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function coordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) ? [value[0], value[1]] : null;
}

function line(value: unknown): Coordinate[] | null {
  if (!Array.isArray(value)) return null;
  const points = value.map(coordinate);
  return points.length >= 2 && points.every((point): point is Coordinate => point !== null)
    ? points
    : null;
}

function closedRing(value: unknown): Coordinate[] | null {
  const points = line(value);
  if (!points || points.length < 4) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) return null;
  return points;
}

function ring(value: unknown): Coordinate[] | null {
  const points = line(value);
  if (!points || points.length < 3) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
  return points.length >= 4 ? points : null;
}

function polygon(value: unknown): Coordinate[][] | null {
  if (!Array.isArray(value)) return null;
  const rings = value.map(ring);
  return rings.length > 0 && rings.every((candidate): candidate is Coordinate[] => candidate !== null) ? rings : null;
}

function parseGeometry(value: unknown): Geometry | null {
  if (!record(value) || typeof value.type !== "string") return null;
  if (value.type === "Point") {
    const point = coordinate(value.coordinates);
    return point ? { type: "Point", coordinates: point } : null;
  }
  if (value.type === "LineString") {
    const points = line(value.coordinates);
    return points ? { type: "LineString", coordinates: points } : null;
  }
  if (value.type === "MultiLineString" && Array.isArray(value.coordinates)) {
    const lines = value.coordinates.map(line);
    return lines.length > 0 && lines.every((candidate): candidate is Coordinate[] => candidate !== null)
      ? { type: "MultiLineString", coordinates: lines }
      : null;
  }
  if (value.type === "Polygon") {
    const rings = polygon(value.coordinates);
    return rings ? { type: "Polygon", coordinates: rings } : null;
  }
  if (value.type === "MultiPolygon" && Array.isArray(value.coordinates)) {
    const polygons = value.coordinates.map(polygon);
    return polygons.length > 0 && polygons.every((candidate): candidate is Coordinate[][] => candidate !== null)
      ? { type: "MultiPolygon", coordinates: polygons }
      : null;
  }
  return null;
}


function localize(geometry: Geometry): Geometry | null {
  const mapPoint = (point: Coordinate): Coordinate => wgs84ToRender(point);
  if (geometry.type === "Point") return { type: "Point", coordinates: mapPoint(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(mapPoint) };
  if (geometry.type === "MultiLineString") return { type: "MultiLineString", coordinates: geometry.coordinates.map((points) => points.map(mapPoint)) };
  const mapped: AreaGeometry = geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: geometry.coordinates.map((points) => points.map(mapPoint)) }
    : { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((points) => points.map(mapPoint))) };
  return normalizePolygonGeometry(mapped);
}


function lineLength(points: Coordinate[]): number {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1]![0] - points[index]![0], points[index + 1]![1] - points[index]![1]);
  }
  return total;
}

function linePointAt(points: Coordinate[], distance: number): Coordinate {
  let remaining = distance;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length;
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    remaining -= length;
  }
  return points[points.length - 1]!;
}

function ringContribution(points: Coordinate[]): { area: number; centroid: Coordinate } {
  let signedArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index]!;
    const second = points[(index + 1) % points.length]!;
    const cross = first[0] * second[1] - second[0] * first[1];
    signedArea += cross;
    x += (first[0] + second[0]) * cross;
    y += (first[1] + second[1]) * cross;
  }
  signedArea /= 2;
  const area = Math.abs(signedArea);
  if (area <= 1e-9) {
    const sum = points.reduce<Coordinate>((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
    return { area: 0, centroid: [sum[0] / points.length, sum[1] / points.length] };
  }
  return { area, centroid: [x / (6 * signedArea), y / (6 * signedArea)] };
}

function polygonAnchor(rings: Coordinate[][]): Coordinate {
  const outer = rings[0];
  if (!outer) throw new Error("OSM polygon has no exterior ring");
  const outerContribution = ringContribution(outer);
  let area = outerContribution.area;
  let x = outerContribution.centroid[0] * area;
  let y = outerContribution.centroid[1] * area;
  for (const hole of rings.slice(1)) {
    const contribution = ringContribution(hole);
    area -= contribution.area;
    x -= contribution.centroid[0] * contribution.area;
    y -= contribution.centroid[1] * contribution.area;
  }
  return area > 1e-9 ? [x / area, y / area] : outerContribution.centroid;
}

function geometryAnchor(geometry: Geometry): Coordinate {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return linePointAt(geometry.coordinates, lineLength(geometry.coordinates) / 2);
  if (geometry.type === "MultiLineString") {
    const total = geometry.coordinates.reduce((sum, points) => sum + lineLength(points), 0);
    if (total <= 1e-9) return geometry.coordinates[0]?.[0] ?? [0, 0];
    let passed = 0;
    for (const points of geometry.coordinates) {
      const length = lineLength(points);
      if (passed + length >= total / 2) return linePointAt(points, total / 2 - passed);
      passed += length;
    }
    const last = geometry.coordinates[geometry.coordinates.length - 1];
    return last?.[last.length - 1] ?? [0, 0];
  }
  if (geometry.type === "Polygon") return polygonAnchor(geometry.coordinates);
  let totalArea = 0;
  let x = 0;
  let y = 0;
  for (const polygon of geometry.coordinates) {
    const anchor = polygonAnchor(polygon);
    const outer = polygon[0];
    if (!outer) continue;
    const outerArea = ringContribution(outer).area;
    const holeArea = polygon.slice(1).reduce((sum, hole) => sum + ringContribution(hole).area, 0);
    const area = Math.max(0, outerArea - holeArea);
    totalArea += area;
    x += anchor[0] * area;
    y += anchor[1] * area;
  }
  return totalArea > 1e-9 ? [x / totalArea, y / totalArea] : geometry.coordinates[0]?.[0]?.[0] ?? [0, 0];
}


function geometryPoints(geometry: Geometry): Coordinate[] {
  const points: Coordinate[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      points.push([value[0], value[1]]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return points;
}

function anchorFor(geometry: Geometry, localAnchor: Coordinate, boundary: BulkBoundary | undefined): Coordinate {
  const candidate = geometry.type === "Point" ? geometry.coordinates : renderToWgs84(localAnchor);
  if (!boundary || boundary.index.contains(candidate)) return candidate;
  return geometryPoints(geometry).find((point) => boundary.index.contains(point)) ?? candidate;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["yes", "true", "1"].includes(normalized)) return true;
  if (["no", "false", "0"].includes(normalized)) return false;
  return undefined;
}

function parseWidth(value: unknown): number | undefined {
  const candidate = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*m?\s*$/i.test(value) ? Number.parseFloat(value) : NaN;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
}

function metadata(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function stableSourceId(raw: Record<string, unknown>, properties: Record<string, unknown>): string | null {
  return text(raw.id) ?? text(properties["@id"]) ?? text(properties.osm_id) ?? null;
}

function sourceObjectUrl(sourceId: string): string | undefined {
  const compact = sourceId.match(/^([nwr](\d+))$/i);
  if (compact) {
    const prefix = compact[1]![0]!.toLowerCase();
    const type = prefix === "n" ? "node" : prefix === "w" ? "way" : "relation";
    return `https://www.openstreetmap.org/${type}/${compact[1]!.slice(1)}`;
  }
  return /^(node|way|relation)\/\d+$/.test(sourceId) ? `https://www.openstreetmap.org/${sourceId}` : undefined;
}

function parseCompleteFeature(value: unknown): MapFeature | null {
  const result = MapFeatureSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function emptyOsmNormalizeReport(): OsmNormalizeReport {
  const droppedByReason = {} as Record<OsmDropReason, number>;
  for (const reason of OSM_DROP_REASONS) droppedByReason[reason] = 0;
  return { inputTotal: 0, keptTotal: 0, droppedTotal: 0, keptByKind: {}, keptByCategory: {}, droppedByReason };
}

export function featureCategory(feature: MapFeature): string {
  if (feature.kind === "road") return `road:${feature.roadClass ?? feature.highway ?? "unknown"}`;
  if (feature.kind === "landuse") return `landuse:${feature.landuseType}`;
  if (feature.kind === "water") return `water:${feature.waterType ?? "water"}`;
  if (feature.kind === "transport") return `transport:${feature.transportType}`;
  if (feature.kind === "place") return `place:${feature.placeType}`;
  if (feature.kind === "poi") return `poi:${feature.poiType}`;
  if (feature.kind === "building") return `building:${feature.buildingType ?? "yes"}`;
  return feature.kind;
}

export interface BulkFeatureOutcome {
  feature: MapFeature | null;
  reason: OsmDropReason;
}

export function normalizeOsmBulkFeature(
  raw: Record<string, unknown>,
  boundary: BulkBoundary | undefined,
  config: OsmNormalizeConfig | undefined,
  report: OsmNormalizeReport,
): BulkFeatureOutcome {
  const resolved = config ?? DEFAULT_OSM_NORMALIZE_CONFIG;
  report.inputTotal += 1;
  const sourceGeometry = parseGeometry(raw.geometry);
  const properties = record(raw.properties) ? raw.properties : {};
  if (!sourceGeometry) {
    report.droppedByReason.unreadable_geometry += 1;
    report.droppedTotal += 1;
    return { feature: null, reason: "unreadable_geometry" };
  }
  const { feature, reason } = completeFeature(raw, properties, sourceGeometry, boundary, resolved);
  if (feature === null) {
    report.droppedByReason[reason] += 1;
    report.droppedTotal += 1;
    return { feature: null, reason };
  }
  report.keptTotal += 1;
  report.keptByKind[feature.kind] = (report.keptByKind[feature.kind] ?? 0) + 1;
  const category = featureCategory(feature);
  report.keptByCategory[category] = (report.keptByCategory[category] ?? 0) + 1;
  return { feature, reason: "schema_rejected" };
}

export function normalizeOsmBulkWithReport(
  features: Record<string, unknown>[],
  boundary?: BulkBoundary,
  config?: OsmNormalizeConfig,
): OsmNormalizeResult {
  const report = emptyOsmNormalizeReport();
  const output: MapFeature[] = [];
  for (const raw of features) {
    const outcome = normalizeOsmBulkFeature(raw, boundary, config, report);
    if (outcome.feature !== null) output.push(outcome.feature);
  }
  return { features: output, report };
}

export function normalizeOsmBulk(features: Record<string, unknown>[], boundary?: BulkBoundary, config?: OsmNormalizeConfig): MapFeature[] {
  return normalizeOsmBulkWithReport(features, boundary, config).features;
}
