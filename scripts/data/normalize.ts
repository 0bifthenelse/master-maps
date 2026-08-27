#!/usr/bin/env tsx
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MapFeatureSchema,
  type AddressFeature,
  type BoundaryFeature,
  type BusinessFeature,
  type FeatureKind,
  type Geometry,
  type MapFeature,
  type SourceReference,
} from "../../src/lib/data/schema";
import {
  renderToWgs84,
  wgs84ToRender,
} from "../../src/lib/geo/crs";
import { computeLocalFocus, type LocalGeometry } from "../../src/lib/geo/focus";
import {
  clipLineStringToPolygon,
  clipPolygonToPolygon,
  normalizePolygonGeometry,
  type PolygonGeometry,
} from "../../src/lib/geo/polygon";
import { GERS_TERRITORY } from "../../src/lib/data/territory";
import {
  deduplicateOsmElements,
  isOsmElement,
  reconstructMultipolygonRelation,
  type OsmElement,
  type OsmRelationElement,
  type OsmWayElement,
  type RelationIssue,
} from "./osmRelations";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";
import { normalizeBdtopo } from "./normalizeBdtopo";
import { normalizeOsmBulk } from "./normalizeOsmBulk";

type Coordinate = [number, number];

type RawOsm = {
  elements: Record<string, unknown>[];
  timestamp: string;
  query: string;
};

type RawBoundary = {
  features?: Array<{ geometry?: unknown; properties?: Record<string, unknown> }>;
};

type RawSources = {
  boundary: RawBoundary;
  osm: RawOsm;
  osmBulk: { features?: Record<string, unknown>[] };
  bdtopoFiles: string[];
  addresses: { addresses?: Record<string, unknown>[]; license?: string };
  businesses: { records?: Record<string, unknown>[]; sourceUrl?: string; license?: string; acquiredAt?: string };
  businessesOsm: { status?: string; body?: unknown };
  businessesWeb: { results?: Record<string, unknown>[] };
  ign: { features: Record<string, unknown>[]; unavailable: boolean };
};

type OsmGeometry =
  | { type: "Point"; coordinates: Coordinate }
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] }
  | { type: "Polygon"; coordinates: Coordinate[][] }
  | { type: "MultiPolygon"; coordinates: Coordinate[][][] };

export interface OsmNormalizationResult {
  features: MapFeature[];
  relationIssues: RelationIssue[];
}

interface NormalizeOptions {
  rawDir: string;
  outDir: string;
}

interface TagClassification {
  kind: Exclude<FeatureKind, "boundary" | "business" | "address">;
  poiType?: string;
  roadClass?: string;
  waterType?: string;
  landuseType?: string;
  transportType?: string;
}

const SOURCE_TIMESTAMP = new Date().toISOString();
const OSM_URL = "https://www.openstreetmap.org";
const BAN_URL = "https://adresse.data.gouv.fr";
const BUSINESS_URL = "https://recherche-entreprises.api.gouv.fr";

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

function parseArgs(args: string[]): NormalizeOptions {
  const root = dataRoot();
  let rawDir = path.join(root, "raw");
  let outDir = path.join(root, "intermediate");
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--raw-dir" && args[index + 1]) rawDir = args[++index]!;
    if (argument === "--out-dir" && args[index + 1]) outDir = args[++index]!;
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: tsx scripts/data/normalize.ts [--raw-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { rawDir, outDir };
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function coordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  if (typeof value[0] !== "number" || typeof value[1] !== "number") return null;
  return Number.isFinite(value[0]) && Number.isFinite(value[1]) ? [value[0], value[1]] : null;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["yes", "true", "1", "oui"].includes(normalized)) return true;
  if (["no", "false", "0", "non"].includes(normalized)) return false;
  return undefined;
}

function parseWidth(value: unknown): number | undefined {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*m?\s*$/i.test(value)
      ? Number.parseFloat(value)
      : NaN;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
}

function metadata(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function toGeometry(value: unknown): Geometry | null {
  if (typeof value !== "object" || value === null || !("type" in value) || !("coordinates" in value)) return null;
  const type = (value as { type?: unknown }).type;
  const coordinates = (value as { coordinates?: unknown }).coordinates;
  if (type === "Point") {
    const point = coordinate(coordinates);
    return point ? { type: "Point", coordinates: point } : null;
  }
  if (type === "LineString" && Array.isArray(coordinates)) {
    const points = coordinates.map(coordinate);
    return points.length >= 2 && points.every((point): point is Coordinate => point !== null)
      ? { type: "LineString", coordinates: points }
      : null;
  }
  if (type === "MultiLineString" && Array.isArray(coordinates)) {
    const lines = coordinates.map((line) => Array.isArray(line) ? line.map(coordinate) : []);
    return lines.length > 0 && lines.every((candidate) => candidate.length >= 2 && candidate.every((point): point is Coordinate => point !== null))
      ? { type: "MultiLineString", coordinates: lines as Coordinate[][] }
      : null;
  }
  if (type === "Polygon" && Array.isArray(coordinates)) {
    const rings = coordinates.map((ring) => Array.isArray(ring) ? ring.map(coordinate) : []);
    if (!rings.length || !rings.every((ring) => ring.length >= 3 && ring.every((point): point is Coordinate => point !== null))) return null;
    const closed = rings.map((ring) => {
      const first = ring[0]!;
      const last = ring[ring.length - 1]!;
      return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
    });
    return closed.every((ring) => ring.length >= 4) ? { type: "Polygon", coordinates: closed } : null;
  }
  if (type === "MultiPolygon" && Array.isArray(coordinates)) {
    const polygons = coordinates.map((polygon) => toGeometry({ type: "Polygon", coordinates: polygon }));
    return polygons.length > 0 && polygons.every((polygon): polygon is Extract<Geometry, { type: "Polygon" }> => polygon?.type === "Polygon")
      ? { type: "MultiPolygon", coordinates: polygons.map((polygon) => polygon.coordinates) }
      : null;
  }
  return null;
}

function localizeGeometry(geometry: Geometry): Geometry | null {
  const mapPoint = (point: Coordinate): Coordinate => wgs84ToRender(point);
  if (geometry.type === "Point") return { type: "Point", coordinates: mapPoint(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(mapPoint) };
  if (geometry.type === "MultiLineString") return { type: "MultiLineString", coordinates: geometry.coordinates.map((line) => line.map(mapPoint)) };
  const local = geometry.type === "Polygon"
    ? { type: "Polygon" as const, coordinates: geometry.coordinates.map((ring) => ring.map(mapPoint)) }
    : { type: "MultiPolygon" as const, coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(mapPoint))) };
  return normalizePolygonGeometry(local);
}

function asLocalGeometry(geometry: Geometry): LocalGeometry {
  const local = localizeGeometry(geometry);
  if (!local) throw new Error(`Degenerate geometry cannot be localized: ${geometry.type}`);
  return local as LocalGeometry;
}

function boundaryPolygons(boundary: BoundaryFeature | { geometry?: unknown; rings?: Coordinate[][]; polygons?: Coordinate[][][] }): PolygonGeometry[] {
  const geometry = toGeometry(boundary.geometry);
  if (geometry?.type === "Polygon") return [{ type: "Polygon", coordinates: geometry.coordinates }];
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.map((coordinates) => ({ type: "Polygon", coordinates }));
  if (boundary.polygons) return boundary.polygons.map((coordinates) => ({ type: "Polygon", coordinates }));
  if (boundary.rings) return [{ type: "Polygon", coordinates: boundary.rings }];
  throw new Error("Boundary has no Polygon or MultiPolygon geometry");
}

function boundaryFromRaw(raw: RawBoundary): BoundaryFeature {
  const rawFeature = raw.features?.find((candidate) => candidate.geometry !== undefined);
  const geometry = toGeometry(rawFeature?.geometry);
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) {
    throw new Error("Admin Express boundary is missing a valid Polygon or MultiPolygon");
  }
  const localGeometry = localizeGeometry(geometry);
  if (!localGeometry || (localGeometry.type !== "Polygon" && localGeometry.type !== "MultiPolygon")) {
    throw new Error("Admin Express boundary could not be localized");
  }
  const localFocus = computeLocalFocus(localGeometry as LocalGeometry);
  const [lon, lat] = renderToWgs84(localFocus);
  const stableId = `boundary:department/${GERS_TERRITORY.code}`;
  const feature = {
    kind: "boundary",
    stableId,
    sourceId: `admin-express:${GERS_TERRITORY.code}`,
    territoryCode: GERS_TERRITORY.code,
    geometry,
    localGeometry,
    lon,
    lat,
    x: localFocus[0],
    z: localFocus[1],
    confidence: "high",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: "IGN ADMIN EXPRESS COG", contenders: ["IGN ADMIN EXPRESS COG"], priority: 100, timestamp: SOURCE_TIMESTAMP }],
    sourceRefs: [{ source: "IGN ADMIN EXPRESS COG", url: "https://data.geopf.fr/wfs/ows", timestamp: SOURCE_TIMESTAMP, license: "Licence Ouverte / Open Licence 2.0" }],
  };
  return parseFeature(feature, stableId) as BoundaryFeature;
}

function parseFeature(value: unknown, stableId: string): MapFeature {
  const result = MapFeatureSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid normalized feature ${stableId}: ${result.error.message}`);
  return result.data;
}

function buildStableId(kind: FeatureKind, name: string, address: string, coordinateValue: Coordinate): string {
  const payload = `${kind}|${name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()}|${address.toLowerCase()}|${coordinateValue[0].toFixed(7)}|${coordinateValue[1].toFixed(7)}`;
  let hash = 2166136261;
  for (const character of payload) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `hash:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function addBaseFeature(
  kind: Exclude<FeatureKind, "boundary" | "business" | "address">,
  stableId: string,
  name: string | undefined,
  geometry: Geometry,
  source: SourceReference,
  extra: Record<string, unknown> = {},
): MapFeature {
  const localGeometry = localizeGeometry(geometry);
  if (!localGeometry) throw new Error(`Feature ${stableId} has degenerate geometry`);
  const localFocus = computeLocalFocus(localGeometry as LocalGeometry);
  const [lon, lat] = renderToWgs84(localFocus);
  return parseFeature({
    kind,
    stableId,
    sourceId: stableId,
    name,
    geometry,
    localGeometry,
    lon,
    lat,
    x: localFocus[0],
    z: localFocus[1],
    confidence: "medium",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: source.source, contenders: [source.source], priority: 60, timestamp: source.timestamp }],
    sourceRefs: [source],
    ...extra,
  }, stableId);
}

function classifyTags(tags: Record<string, string>): TagClassification | null {
  if (tags.name && tags.place) return { kind: "poi", poiType: tags.place };
  if (tags.building) return { kind: "building" };
  if (tags.waterway || tags.natural === "water" || tags.natural === "wetland" || tags.landuse === "reservoir") {
    return { kind: "water", waterType: tags.waterway ?? (tags.natural === "water" ? "water" : tags.natural ?? "reservoir") };
  }
  if (tags.landuse) return { kind: "landuse", landuseType: tags.landuse };
  if (tags.leisure) return { kind: "landuse", landuseType: tags.leisure };
  if (tags.highway) return { kind: "road", roadClass: tags.highway };
  if (tags.railway || tags.public_transport) return { kind: "transport", transportType: tags.railway ?? tags.public_transport ?? "other" };
  const poiType = tags.shop ?? tags.amenity ?? tags.tourism ?? tags.historic ?? tags.office ?? tags.craft;
  if (tags.name && poiType) return { kind: "poi", poiType };
  if (tags["addr:housenumber"]) return { kind: "address" };
  return null;
}

function areaGeometry(geometry: Geometry): geometry is Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> {
  return geometry.type === "Polygon" || geometry.type === "MultiPolygon";
}

function clipAreaGeometry(
  geometry: Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>,
  boundaries: PolygonGeometry[],
  boundaryIndex: BoundaryIndex,
): Extract<Geometry, { type: "Polygon" | "MultiPolygon" }> | null {
  const sourcePolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (sourcePolygons.every((polygon) => boundaryIndex.polygonInside(polygon))) return geometry;
  if (sourcePolygons.every((polygon) => boundaryIndex.polygonOutside(polygon))) return null;
  const polygons: Coordinate[][][] = [];
  for (const polygon of sourcePolygons) {
    for (const boundary of boundaries) {
      const clipped = clipPolygonToPolygon({ type: "Polygon", coordinates: polygon }, boundary);
      if (!clipped) continue;
      if (clipped.type === "Polygon") polygons.push(clipped.coordinates);
      else polygons.push(...clipped.coordinates);
    }
  }
  if (polygons.length === 0) return null;
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };
}

function clipLineGeometry(points: Coordinate[], boundaries: PolygonGeometry[], boundaryIndex: BoundaryIndex): Extract<Geometry, { type: "LineString" | "MultiLineString" }> | null {
  if (boundaryIndex.lineInside(points)) return { type: "LineString", coordinates: points };
  if (boundaryIndex.lineOutside(points)) return null;
  const clipped = boundaries.flatMap((boundary) => clipLineStringToPolygon(points, boundary));
  if (clipped.length === 0) return null;
  return clipped.length === 1 ? { type: "LineString", coordinates: clipped[0]! } : { type: "MultiLineString", coordinates: clipped };
}

function normalizeOsmGeometry(
  geometry: Geometry,
  classification: TagClassification,
  boundaries: PolygonGeometry[],
  boundaryIndex: BoundaryIndex,
): Geometry | null {
  if (geometry.type === "Point") return boundaryIndex.contains(geometry.coordinates) ? geometry : null;
  if (classification.kind === "building" || classification.kind === "landuse" || (classification.kind === "water" && geometry.type !== "LineString" && geometry.type !== "MultiLineString")) {
    if (!areaGeometry(geometry)) return null;
    return clipAreaGeometry(geometry, boundaries, boundaryIndex);
  }
  if (classification.kind === "road" || classification.kind === "water" || classification.kind === "transport") {
    if (geometry.type === "LineString") return clipLineGeometry(geometry.coordinates, boundaries, boundaryIndex);
    if (geometry.type === "MultiLineString") {
      const lines = geometry.coordinates.flatMap((line) => {
        const clipped = clipLineGeometry(line, boundaries, boundaryIndex);
        return clipped?.type === "LineString" ? [clipped.coordinates] : clipped?.coordinates ?? [];
      });
      return lines.length === 0 ? null : lines.length === 1 ? { type: "LineString", coordinates: lines[0]! } : { type: "MultiLineString", coordinates: lines };
    }
    return null;
  }
  const localFocus = computeLocalFocus(asLocalGeometry(geometry));
  const focus = renderToWgs84(localFocus);
  return boundaryIndex.contains(focus) ? { type: "Point", coordinates: focus } : null;
}

function osmFeature(
  elementType: "way" | "relation" | "node",
  elementId: number,
  tags: Record<string, string>,
  classification: TagClassification,
  sourceGeometry: Geometry,
  boundaryPolygons: PolygonGeometry[],
  boundaryIndex: BoundaryIndex,
  timestamp: string,
): MapFeature | null {
  const geometry = normalizeOsmGeometry(sourceGeometry, classification, boundaryPolygons, boundaryIndex);
  if (!geometry) return null;
  const localGeometry = localizeGeometry(geometry);
  if (!localGeometry) return null;
  const localFocus = computeLocalFocus(localGeometry as LocalGeometry);
  const [lon, lat] = renderToWgs84(localFocus);
  const stableId = `osm:${elementType}/${elementId}`;
  const source: SourceReference = { source: "osm", url: `${OSM_URL}/${elementType}/${elementId}`, timestamp, license: "ODbL-1.0" };
  const name = text(tags.name);
  const address = [tags["addr:housenumber"], tags["addr:street"], tags["addr:postcode"]].filter(Boolean).join(", ");
  const base = {
    stableId,
    sourceId: stableId,
    name,
    address: address || undefined,
    geometry,
    localGeometry,
    lon,
    lat,
    x: localFocus[0],
    z: localFocus[1],
    confidence: "medium",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: "osm", contenders: ["osm"], priority: 60, timestamp }],
    sourceRefs: [source],
    sourceMetadata: { tags },
  };
  if (classification.kind === "building") {
    const explicitHeight = parseWidth(tags.height);
    const levels = Number.parseInt(tags["building:levels"] ?? "", 10);
    return parseFeature({
      ...base,
      kind: "building",
      height: explicitHeight ?? (Number.isFinite(levels) && levels > 0 ? levels * 3 : undefined),
      heightInferred: explicitHeight === undefined,
      heightSource: explicitHeight !== undefined ? "explicit" : Number.isFinite(levels) && levels > 0 ? "inferred_from_levels" : undefined,
      levels: Number.isFinite(levels) && levels >= 0 ? levels : undefined,
      buildingType: tags.building,
    }, stableId);
  }
  if (classification.kind === "road") {
    const width = parseWidth(tags.width);
    const bridge = parseBoolean(tags.bridge);
    const tunnel = parseBoolean(tags.tunnel);
    const layer = text(tags.layer);
    return parseFeature({
      ...base,
      kind: "road",
      highway: classification.roadClass,
      roadClass: classification.roadClass,
      width,
      widthInferred: width === undefined,
      widthSource: width === undefined ? "inferred_default" : "explicit",
      bridge,
      tunnel,
      stratum: tunnel === true ? "tunnel" : bridge === true ? "bridge" : "normal",
      layer,
      oneway: parseBoolean(tags.oneway),
    }, stableId);
  }
  if (classification.kind === "water") {
    const width = parseWidth(tags.width ?? tags["water:width"]);
    return parseFeature({ ...base, kind: "water", waterType: classification.waterType, width, widthInferred: width === undefined, sourceMetadata: { tags } }, stableId);
  }
  if (classification.kind === "landuse") return parseFeature({ ...base, kind: "landuse", landuseType: classification.landuseType ?? "other" }, stableId);
  if (classification.kind === "poi") {
    const isArea = geometry.type === "Polygon" || geometry.type === "MultiPolygon";
    const pointGeometry: Geometry = { type: "Point", coordinates: [lon, lat] };
    const pointLocal: Geometry = { type: "Point", coordinates: localFocus };
    return parseFeature({
      ...base,
      kind: "poi",
      geometry: isArea ? pointGeometry : geometry,
      sourceGeometry: isArea ? geometry : undefined,
      localGeometry: isArea ? pointLocal : localGeometry,
      poiType: classification.poiType ?? "poi",
      category: tags.shop ?? tags.amenity ?? tags.tourism,
      website: tags.website ?? tags["contact:website"],
      phone: tags.phone ?? tags["contact:phone"],
      openingHours: tags.opening_hours,
      operator: tags.operator,
      wheelchair: tags.wheelchair,
    }, stableId);
  }
  if (classification.kind === "transport") return parseFeature({ ...base, kind: "transport", transportType: classification.transportType ?? "other", route: tags.route, operator: tags.operator }, stableId);
  return parseFeature({
    ...base,
    kind: "address",
    banId: stableId,
    housenumber: tags["addr:housenumber"] ?? "",
    street: tags["addr:street"] ?? "unknown",
    postcode: tags["addr:postcode"],
    city: tags["addr:city"] ?? GERS_TERRITORY.name,
  }, stableId);
}

export function normalizeOsmWithReport(raw: RawOsm, boundary: BoundaryFeature | { geometry?: unknown; rings?: Coordinate[][]; polygons?: Coordinate[][][] }): OsmNormalizationResult {
  const boundaries = boundaryPolygons(boundary);
  const boundaryIndex = createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates));
  const elements = deduplicateOsmElements(raw.elements.filter(isOsmElement));
  const timestamp = raw.timestamp || SOURCE_TIMESTAMP;
  const nodeCoordinates = new Map<number, Coordinate>();
  const ways = new Map<number, OsmWayElement>();
  const relations: OsmRelationElement[] = [];
  for (const element of elements) {
    if (element.type === "node") nodeCoordinates.set(element.id, [element.lon, element.lat]);
    else if (element.type === "way") ways.set(element.id, element);
    else relations.push(element);
  }
  const features: MapFeature[] = [];
  const relationIssues: RelationIssue[] = [];
  const relationWayIds = new Set<number>();
  for (const relation of relations) {
    const tags = relation.tags ?? {};
    const classification = classifyTags(tags);
    const areaRelation = classification?.kind === "building" || classification?.kind === "water" || classification?.kind === "landuse";
    const namedAreaPoi = classification?.kind === "poi" && relation.members.some((member) => member.role === "outer" || member.role === "inner");
    if (!classification || (!areaRelation && !namedAreaPoi)) continue;
    const reconstructed = reconstructMultipolygonRelation(relation, ways, nodeCoordinates);
    if ("reason" in reconstructed) {
      relationIssues.push(reconstructed);
      continue;
    }
    const feature = osmFeature("relation", relation.id, tags, classification, reconstructed.geometry, boundaries, boundaryIndex, timestamp);
    if (feature) features.push(feature);
    if (feature && areaRelation) for (const wayId of reconstructed.memberWayIds) relationWayIds.add(wayId);
  }
  for (const element of elements) {
    if (element.type === "relation") continue;
    const tags = element.tags ?? {};
    const classification = classifyTags(tags);
    if (!classification) continue;
    let geometry: Geometry | null = null;
    if (element.type === "node") {
      geometry = { type: "Point", coordinates: [element.lon, element.lat] };
    } else {
      if (relationWayIds.has(element.id) && (classification.kind === "building" || classification.kind === "water" || classification.kind === "landuse")) continue;
      const points: Coordinate[] = [];
      let complete = true;
      for (const nodeId of element.nodes) {
        const point = nodeCoordinates.get(nodeId);
        if (!point) {
          complete = false;
          break;
        }
        points.push(point);
      }
      if (complete && points.length >= 2) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        const closed = first[0] === last[0] && first[1] === last[1];
        const areaKind = classification.kind === "building" || classification.kind === "water" || classification.kind === "landuse" || classification.kind === "poi";
        geometry = closed && areaKind
          ? { type: "Polygon", coordinates: [points] }
          : { type: "LineString", coordinates: points };
      }
    }
    if (!geometry) continue;
    const feature = osmFeature(element.type, element.id, tags, classification, geometry, boundaries, boundaryIndex, timestamp);
    if (feature) features.push(feature);
  }
  return { features, relationIssues };
}

export function normalizeOsm(raw: RawOsm, boundary: BoundaryFeature): MapFeature[] {
  return normalizeOsmWithReport(raw, boundary).features;
}

function normalizeAddresses(raw: { addresses?: Record<string, unknown>[]; license?: string }, boundary: BoundaryFeature): AddressFeature[] {
  const boundaries = boundaryPolygons(boundary);
  const boundaryIndex = createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates));
  const features: AddressFeature[] = [];
  for (const record of raw.addresses ?? []) {
    const longitude = numberValue(record.lon);
    const latitude = numberValue(record.lat);
    if (longitude === undefined || latitude === undefined || !boundaryIndex.contains([longitude, latitude])) continue;
    const housenumber = text(record.numero) ?? "";
    const street = text(record.streetName ?? record.street) ?? "unknown street";
    const postcode = text(record.postalCode) ?? "";
    const city = text(record.city) ?? GERS_TERRITORY.name;
    const banId = text(record.banId);
    if (!banId) continue;
    const name = `${housenumber} ${street}`.trim();
    const stableId = `ban:${banId}`;
    const local = wgs84ToRender([longitude, latitude]);
    const feature = parseFeature({
      kind: "address",
      stableId,
      sourceId: banId,
      banId,
      housenumber,
      street,
      postcode,
      city,
      name,
      lon: longitude,
      lat: latitude,
      x: local[0],
      z: local[1],
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      localGeometry: { type: "Point", coordinates: local },
      confidence: "high",
      status: "active",
      provenance: [{ featureId: stableId, property: "geometry", winner: "ban", contenders: ["ban"], priority: 70, timestamp: SOURCE_TIMESTAMP }],
      sourceRefs: [{ source: "ban", url: BAN_URL, timestamp: SOURCE_TIMESTAMP, license: raw.license ?? "Etalab-2.0" }],
    }, stableId);
    features.push(feature as AddressFeature);
  }
  return features;
}

function normalizedText(value: string | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function metricDistance(first: Coordinate, second: Coordinate): number {
  const a = wgs84ToRender(first);
  const b = wgs84ToRender(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function addressEvidence(first: string | undefined, second: string | undefined): boolean {
  const a = normalizedText(first);
  const b = normalizedText(second);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const firstTokens = new Set(a.split(" ").filter((token) => token.length > 2));
  return b.split(" ").filter((token) => token.length > 2).some((token) => firstTokens.has(token));
}

function cleanString(value: unknown): string | undefined {
  return text(value);
}

export function normalizeBusinesses(
  raw: { records?: Record<string, unknown>[]; sourceUrl?: string; license?: string; acquiredAt?: string },
  boundary: BoundaryFeature,
  osmRaw: { status?: string; body?: unknown },
  webRaw: { results?: Record<string, unknown>[] },
): BusinessFeature[] {
  const boundaries = boundaryPolygons(boundary);
  const boundaryIndex = createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates));
  const features: BusinessFeature[] = [];
  const propertySource = new Map<string, Map<string, string>>();
  const now = raw.acquiredAt ?? SOURCE_TIMESTAMP;
  const sourceRef = (source: string, url: string | undefined, timestamp: string, license: string | undefined): SourceReference => ({ source, url, timestamp, license });
  const addSource = (feature: BusinessFeature, reference: SourceReference): void => {
    if (!feature.sourceRefs.some((candidate) => candidate.source === reference.source && candidate.url === reference.url)) feature.sourceRefs.push(reference);
  };
  const priority = (source: string): number => source === "official-website" ? 90 : source === "sirene" ? 80 : source === "annuaire-entreprises" ? 75 : source === "osm" ? 60 : 40;
  const mergeField = (feature: BusinessFeature, property: keyof BusinessFeature, value: string | undefined, source: string, timestamp: string): void => {
    if (!value) return;
    const sources = propertySource.get(feature.stableId) ?? new Map<string, string>();
    const current = feature[property];
    const currentSource = sources.get(String(property)) ?? "unknown";
    if (typeof current !== "string" || priority(source) > priority(currentSource)) {
      (feature as unknown as Record<string, unknown>)[String(property)] = value;
      sources.set(String(property), source);
      propertySource.set(feature.stableId, sources);
    }
  };
  const match = (candidate: BusinessFeature): BusinessFeature | undefined => features.find((feature) => {
    if (candidate.siret) return feature.siret === candidate.siret;
    return !feature.siret
      && normalizedText(candidate.businessName) === normalizedText(feature.businessName)
      && addressEvidence(candidate.address, feature.address)
      && metricDistance([candidate.lon!, candidate.lat!], [feature.lon!, feature.lat!]) <= 150;
  });
  const merge = (candidate: BusinessFeature): void => {
    const existing = match(candidate);
    if (!existing) {
      features.push(candidate);
      const sources = new Map<string, string>();
      const source = candidate.sourceRefs[0]?.source ?? "unknown";
      for (const property of ["businessName", "legalName", "brand", "category", "nafCode", "nafLabel", "address", "website", "phone", "openingHours", "operator", "wheelchair"] as const) {
        if (candidate[property]) sources.set(property, source);
      }
      propertySource.set(candidate.stableId, sources);
      return;
    }
    const reference = candidate.sourceRefs[0];
    if (reference) addSource(existing, reference);
    const source = reference?.source ?? "unknown";
    for (const property of ["address", "brand", "category", "nafCode", "nafLabel", "website", "phone", "openingHours", "operator", "wheelchair"] as const) {
      mergeField(existing, property, candidate[property] as string | undefined, source, reference?.timestamp ?? now);
    }
  };
  for (const record of raw.records ?? []) {
    const coordinateValue = record.coordinate;
    const coordinateRecord = typeof coordinateValue === "object" && coordinateValue !== null ? coordinateValue as Record<string, unknown> : {};
    const longitude = numberValue(coordinateRecord.lon);
    const latitude = numberValue(coordinateRecord.lat);
    const businessName = cleanString(record.tradingName) ?? cleanString(record.legalName);
    if (longitude === undefined || latitude === undefined || !businessName || !boundaryIndex.contains([longitude, latitude])) continue;
    const siret = cleanString(record.siret);
    const stableId = siret ? `business:siret/${siret}` : buildStableId("business", businessName, cleanString(record.address) ?? "", [longitude, latitude]);
    const local = wgs84ToRender([longitude, latitude]);
    const source = sourceRef("sirene", raw.sourceUrl ?? BUSINESS_URL, cleanString(record.acquiredAt) ?? now, raw.license ?? "Licence Ouverte / Open Licence 2.0");
    merge(parseFeature({
      kind: "business",
      stableId,
      sourceId: siret,
      businessId: siret,
      siret,
      siren: cleanString(record.siren),
      businessName,
      legalName: cleanString(record.legalName),
      brand: cleanString(record.tradingName),
      category: cleanString(record.nafLabel),
      nafCode: cleanString(record.nafCode),
      nafLabel: cleanString(record.nafLabel),
      name: businessName,
      address: cleanString(record.address),
      lon: longitude,
      lat: latitude,
      x: local[0],
      z: local[1],
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      localGeometry: { type: "Point", coordinates: local },
      confidence: "high",
      status: cleanString(record.administrativeStatus) === "A" || !record.administrativeStatus ? "active" : "uncertain",
      provenance: [{ featureId: stableId, property: "identity", winner: "sirene", contenders: ["sirene"], priority: 80, timestamp: source.timestamp }],
      sourceRefs: [source],
      administrativeStatus: cleanString(record.administrativeStatus),
      creationDate: cleanString(record.creationDate),
    }, stableId) as BusinessFeature);
  }
  const body = osmRaw.body;
  const elements = typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).elements)
    ? (body as { elements: Record<string, unknown>[] }).elements
    : [];
  for (const element of elements) {
    const tags = typeof element.tags === "object" && element.tags !== null ? element.tags as Record<string, string> : {};
    const businessName = cleanString(tags.name);
    const pointValue = element.type === "node" ? element : element.center;
    const pointRecord = typeof pointValue === "object" && pointValue !== null ? pointValue as Record<string, unknown> : {};
    const longitude = numberValue(pointRecord.lon);
    const latitude = numberValue(pointRecord.lat);
    if (!businessName || longitude === undefined || latitude === undefined || !boundaryIndex.contains([longitude, latitude])) continue;
    const local = wgs84ToRender([longitude, latitude]);
    const elementType = cleanString(element.type) ?? "element";
    const elementId = numberValue(element.id) ?? 0;
    const stableId = `business:osm/${elementType}/${elementId}`;
    const source = sourceRef("osm", `${OSM_URL}/${elementType}/${elementId}`, SOURCE_TIMESTAMP, "ODbL-1.0");
    merge(parseFeature({
      kind: "business",
      stableId,
      sourceId: stableId,
      businessId: stableId,
      businessName,
      name: businessName,
      brand: cleanString(tags.brand),
      category: cleanString(tags.shop) ?? cleanString(tags.office) ?? cleanString(tags.craft) ?? cleanString(tags.amenity),
      address: [cleanString(tags["addr:housenumber"]), cleanString(tags["addr:street"]), cleanString(tags["addr:postcode"])].filter((value): value is string => value !== undefined).join(", ") || undefined,
      phone: cleanString(tags.phone) ?? cleanString(tags["contact:phone"]),
      website: cleanString(tags.website) ?? cleanString(tags["contact:website"]),
      openingHours: cleanString(tags.opening_hours),
      operator: cleanString(tags.operator),
      wheelchair: cleanString(tags.wheelchair),
      lon: longitude,
      lat: latitude,
      x: local[0],
      z: local[1],
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      localGeometry: { type: "Point", coordinates: local },
      confidence: "medium",
      status: "active",
      provenance: [{ featureId: stableId, property: "identity", winner: "osm", contenders: ["osm"], priority: 60, timestamp: source.timestamp }],
      sourceRefs: [source],
    }, stableId) as BusinessFeature);
  }
  for (const result of webRaw.results ?? []) {
    if (result.status !== "ok") continue;
    const businessName = cleanString(result.name) ?? cleanString(result.title);
    if (!businessName) continue;
    const coordinateValue = result.coordinate;
    const coordinateRecord = typeof coordinateValue === "object" && coordinateValue !== null ? coordinateValue as Record<string, unknown> : {};
    const longitude = numberValue(coordinateRecord.lon);
    const latitude = numberValue(coordinateRecord.lat);
    const existing = features.find((feature) => normalizedText(feature.businessName) === normalizedText(businessName)
      && (!longitude || !latitude || metricDistance([feature.lon!, feature.lat!], [longitude, latitude]) <= 150));
    if (!existing) continue;
    const sourceId = cleanString(result.sourceId) ?? "official-website";
    const source = sourceId.includes("pagesjaunes") ? "pagesjaunes" : "official-website";
    const reference = sourceRef(source, cleanString(result.url), cleanString(result.acquiredAt) ?? now, undefined);
    addSource(existing, reference);
    mergeField(existing, "address", cleanString(result.address), source, reference.timestamp);
    mergeField(existing, "phone", cleanString(result.phone), source, reference.timestamp);
    mergeField(existing, "website", cleanString(result.url), source, reference.timestamp);
  }
  return features;
}

function normalizeIgn(raw: { features: Record<string, unknown>[]; unavailable: boolean }, boundary: BoundaryFeature): MapFeature[] {
  if (raw.unavailable) return [];
  const boundaries = boundaryPolygons(boundary);
  const boundaryIndex = createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates));
  const result: MapFeature[] = [];
  for (const item of raw.features) {
    const geometry = toGeometry(item.geometry);
    if (!geometry) continue;
    const clipped = normalizeOsmGeometry(geometry, { kind: "building" }, boundaries, boundaryIndex);
    if (!clipped || (clipped.type !== "Polygon" && clipped.type !== "MultiPolygon")) continue;
    const feature = addBaseFeature("building", `ign:${text(item.id) ?? buildStableId("building", text(item.name) ?? "", "", computeLocalFocus(asLocalGeometry(clipped)))}`, text(item.name), clipped, { source: "ign-geoplateforme", timestamp: SOURCE_TIMESTAMP }, { buildingType: text(item.nature) });
    result.push(feature);
  }
  return result;
}

async function readJson(filePath: string, required: boolean): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (required) throw new Error(`Required source file missing or invalid: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function loadRawSources(rawDir: string): Promise<RawSources> {
  const boundary = await readJson(path.join(rawDir, GERS_TERRITORY.boundaryRawFile), true);
  if (typeof boundary !== "object" || boundary === null) throw new Error("Admin Express boundary is not an object");
  const osmParsed = await readJson(path.join(rawDir, "osm.json"), false);
  let osm: RawOsm = typeof osmParsed === "object" && osmParsed !== null && Array.isArray((osmParsed as Record<string, unknown>).elements)
    ? osmParsed as unknown as RawOsm
    : { elements: [], timestamp: "", query: "" };
  const bulkParsed = await readJson(path.join(rawDir, "osm-bulk.geojson"), false);
  const osmBulk = typeof bulkParsed === "object" && bulkParsed !== null && Array.isArray((bulkParsed as Record<string, unknown>).features)
    ? bulkParsed as { features: Record<string, unknown>[] }
    : { features: [] };
  if ((osmBulk.features?.length ?? 0) > 0) osm = { elements: [], timestamp: "bulk", query: "geofabrik-enrichment" };
  const files = await fs.readdir(rawDir, { withFileTypes: true });
  const bdtopoFiles = files
    .filter((entry) => entry.isFile() && /^bdtopo-(buildings|roads|water-surfaces|water-lines)\.geojson$/.test(entry.name))
    .map((entry) => path.join(rawDir, entry.name));
  if (bdtopoFiles.length === 0) throw new Error("No canonical BD TOPO exports found");
  const addresses = (await readJson(path.join(rawDir, "ban-addresses.json"), true)) as { addresses?: Record<string, unknown>[]; license?: string };
  const businesses = ((await readJson(path.join(rawDir, "businesses-sirene.json"), false)) ?? { records: [] }) as RawSources["businesses"];
  const businessesOsm = ((await readJson(path.join(rawDir, "businesses-osm.json"), false)) ?? { status: "missing" }) as RawSources["businessesOsm"];
  const businessesWeb = ((await readJson(path.join(rawDir, "businesses-web.json"), false)) ?? { results: [] }) as RawSources["businessesWeb"];
  const ign: RawSources["ign"] = { features: [], unavailable: true };
  const intermediateDir = path.join(dataRoot(), "intermediate");
  const ignUnavailable = await readJson(path.join(intermediateDir, "ign-unavailable.json"), false);
  for (const entry of files) {
    if (!entry.isFile() || !/^ign-[^/]+\.json$/.test(entry.name) || entry.name === "ign-capabilities.json") continue;
    const parsed = await readJson(path.join(rawDir, entry.name), false);
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>).features)) {
      ign.features.push(...(parsed as { features: Record<string, unknown>[] }).features);
      ign.unavailable = false;
    }
  }
  if (typeof ignUnavailable === "object" && ignUnavailable !== null && text((ignUnavailable as Record<string, unknown>).reason)) {
    ign.features = [];
    ign.unavailable = true;
  }
  return { boundary: boundary as RawBoundary, osm, osmBulk, bdtopoFiles, addresses, businesses, businessesOsm, businessesWeb, ign };
}

async function writeJsonArray(filePath: string, values: Iterable<unknown>): Promise<void> {
  const handle = await fs.open(filePath, "w");
  let buffer = "";
  let first = true;
  try {
    await handle.write("[");
    for (const value of values) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) continue;
      buffer += `${first ? "" : ",\n"}${encoded}`;
      first = false;
      if (buffer.length >= 1024 * 1024) {
        await handle.write(buffer);
        buffer = "";
      }
    }
    await handle.write(`${buffer}\n]\n`);
  } finally {
    await handle.close();
  }
}

async function writeNormalizedFeatures(features: MapFeature[], outDir: string): Promise<void> {
  const preserved = new Set(["boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);
  for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !preserved.has(entry.name)) await fs.unlink(path.join(outDir, entry.name));
  }
  const groups = new Map<string, MapFeature[]>();
  for (const feature of features) {
    const parsed = MapFeatureSchema.parse(feature);
    const list = groups.get(parsed.kind) ?? [];
    list.push(parsed);
    groups.set(parsed.kind, list);
  }
  for (const [kind, list] of groups) {
    const chunkSize = 20_000;
    for (let offset = 0; offset < list.length; offset += chunkSize) {
      const suffix = offset === 0 ? "" : `-${String(offset / chunkSize).padStart(4, "0")}`;
      await writeJsonArray(path.join(outDir, `${kind}${suffix}.json`), list.slice(offset, offset + chunkSize));
    }
  }
  function* provenanceRecords(): Iterable<unknown> {
    for (const feature of features) yield* feature.provenance;
  }
  await writeJsonArray(path.join(outDir, "provenance.json"), provenanceRecords());
}

function canonicalGeometry(geometry: Geometry): Geometry {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return geometry;
  const normalized = normalizePolygonGeometry(geometry);
  if (!normalized) throw new Error(`Area geometry has no non-degenerate polygon`);
  return normalized;
}

function canonicalFeature(feature: MapFeature): MapFeature {
  const sourceGeometry = feature.sourceGeometry ? canonicalGeometry(feature.sourceGeometry) : undefined;
  const candidate = { ...feature, geometry: canonicalGeometry(feature.geometry), localGeometry: feature.localGeometry ? canonicalGeometry(feature.localGeometry) : undefined, sourceGeometry };
  const parsed = MapFeatureSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`Invalid normalized feature: ${parsed.error.message}`);
  return parsed.data;
}
export async function normalizeAll(rawDir?: string, outDir?: string): Promise<void> {
  const root = dataRoot();
  const sourceDir = rawDir ?? path.join(root, "raw");
  const destinationDir = outDir ?? path.join(root, "intermediate");
  await fs.mkdir(destinationDir, { recursive: true });
  const sources = await loadRawSources(sourceDir);
  const boundary = boundaryFromRaw(sources.boundary);
  const boundaries = boundaryPolygons(boundary);
  const osmResult = normalizeOsmWithReport(sources.osm, boundary);
  const bdtopoFeatures: MapFeature[] = [];
  for (const filePath of sources.bdtopoFiles) {
    const parsed = await readJson(filePath, true);
    if (typeof parsed !== "object" || parsed === null || !("features" in parsed) || !Array.isArray(parsed.features)) throw new Error(`Invalid BD TOPO export ${filePath}`);
    const sourceLayer = path.basename(filePath);
    const sourceFeatures = parsed.features.map((feature) => {
      if (typeof feature !== "object" || feature === null) return {};
      return { ...feature, sourceLayer };
    });
    const normalizedFeatures = normalizeBdtopo(sourceFeatures, boundaries.map((polygon) => polygon.coordinates));
    for (const feature of normalizedFeatures) bdtopoFeatures.push(feature);
  }
  const osmBulkFeatures = normalizeOsmBulk(sources.osmBulk.features ?? [], { polygons: boundaries, index: createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates)) });
  const addressFeatures = normalizeAddresses(sources.addresses, boundary);
  const businessFeatures = normalizeBusinesses(sources.businesses, boundary, sources.businessesOsm, sources.businessesWeb);
  const ignFeatures = normalizeIgn(sources.ign, boundary);
  const invalidFeatures: Array<{ stableId: string; kind: string; error: string }> = [];
  const features: MapFeature[] = [];
  const candidates = [boundary].concat(bdtopoFeatures, osmBulkFeatures, osmResult.features, addressFeatures, businessFeatures, ignFeatures);
  for (const feature of candidates) {
    try {
      features.push(canonicalFeature(feature));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (feature.kind === "boundary") throw error;
      invalidFeatures.push({ stableId: feature.stableId, kind: feature.kind, error: reason });
    }
  }
  await fs.writeFile(path.join(destinationDir, "normalization-issues.json"), JSON.stringify(invalidFeatures, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(destinationDir, "relation-issues.json"), JSON.stringify(osmResult.relationIssues, null, 2) + "\n", "utf8");
  await writeNormalizedFeatures(features, destinationDir);
  const counts = new Map<string, number>();
  for (const feature of features) counts.set(feature.kind, (counts.get(feature.kind) ?? 0) + 1);
  console.error(`[normalize] Wrote ${features.length} canonical features to ${destinationDir}`);
  for (const [kind, count] of counts) console.error(`[normalize] ${kind}: ${count}`);
}

if (process.argv[1]?.endsWith("normalize.ts")) {
  const options = parseArgs(process.argv.slice(2));
  normalizeAll(options.rawDir, options.outDir).catch((error: unknown) => {
    console.error("[normalize] Fatal:", error);
    process.exit(1);
  });
}
