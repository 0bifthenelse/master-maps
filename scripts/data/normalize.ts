#!/usr/bin/env tsx
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  MapFeatureSchema,
  type AddressFeature,
  type BoundaryFeature,
  type BusinessFeature,
  type PoiFeature,
  type FeatureKind,
  type Geometry,
  type MapFeature,
  type ProvenanceRecord,
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
  type OsmRelationElement,
  type OsmWayElement,
  type RelationIssue,
} from "./osmRelations";
import { ADOPTED_LAYERS } from "./bdtopoLayers";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";
import { normalizeBdtopo, settlementAnchors } from "./normalizeBdtopo";
import { categoryForNaf, categoryForOsmTags, nafIsPlace } from "../../src/lib/data/categories";
import { capitaliseCompounds, displayCase, displayStreetName, tidyLabel } from "../../src/lib/data/displayText";
import { conflateBusinesses } from "./conflate";
import {
  emptyOsmNormalizeReport,
  normalizeOsmBulkFeature,
  type BulkBoundary,
  type OsmNormalizeConfig,
  type OsmNormalizeReport,
} from "./normalizeOsmBulk";

type Coordinate = [number, number];

type RawOsm = {
  elements: Record<string, unknown>[];
  timestamp: string;
  query: string;
};

type RawBoundary = {
  features?: Array<{ geometry?: unknown; properties?: Record<string, unknown> }>;
};

interface TagClassification {
  kind: Exclude<FeatureKind, "boundary" | "business" | "address">;
  poiType?: string;
  roadClass?: string;
  waterType?: string;
  landuseType?: string;
  transportType?: string;
}

export interface NormalizeScope {
  boundaryRawFile: string;
  osmExtractFile?: string;
  bdtopoDir?: string;
}

export interface OsmNormalizationResult {
  features: MapFeature[];
  relationIssues: RelationIssue[];
}

const LINE_READ_SIZE = 1 << 20;

export type BulkInputBoundary = BulkBoundary;

export interface NormalizeAllOptions {
  emit?: (feature: MapFeature) => void;
  rss?: () => number;
}

export interface FeatureCounts {
  total: number;
  byKind: Record<string, number>;
}

export interface JsonObjectStream extends AsyncIterable<Record<string, unknown>> {
  close: () => void;
}

export interface OsmBulkStream extends AsyncIterable<MapFeature> {
  report: OsmNormalizeReport;
  close: () => void;
}

export interface AddressSourceInput {
  file: string;
  license?: string;
  addresses?: Record<string, unknown>[];
}

export interface BusinessSourceInput {
  file: string;
  header: Record<string, unknown> | null;
  records?: Record<string, unknown>[];
}

export interface BusinessSources extends BusinessSourceInput {
  osm: Record<string, unknown>;
  web: Record<string, unknown>;
}



interface RawSources {
  boundary: RawBoundary;
  osm: RawOsm;
  osmBulkFile: string | null;
  bdtopoFiles: string[];
  addressFile: string;
  addressLicense: string | undefined;
  businessFile: string;
  businessHeader: Record<string, unknown> | null;
  businessesOsm: Record<string, unknown>;
  businessesWeb: Record<string, unknown>;
  ign: { features: Record<string, unknown>[]; unavailable: boolean };
  osmExtractFile: string | null;
}


const PRESERVED_INTERMEDIATE_FILES: ReadonlySet<string> = new Set([
  "auch-boundary-source.json",
  "auch-osm-manifest.json",
  "boundary-source.json",
  "bdtopo-manifest.json",
  "ign-unavailable.json",
  "normalization-issues.json",
  "osm-bulk-manifest.json",
  "osm-manifest.json",
  "relation-issues.json",
]);

const CHUNK_SIZE = 20_000;
const BUFFER_WRITE_BATCH = 256;
const WINDOW_SIZE = 4096;
const MAX_JSON_ERROR_DETAIL = 240;
const INVALID_ISSUE_LIMIT = 10_000;
export const FEATURE_BATCH_SIZE = 256;

const SOURCE_TIMESTAMP = new Date().toISOString();
const OSM_URL = "https://www.openstreetmap.org";
const BAN_URL = "https://adresse.data.gouv.fr";
const BUSINESS_URL = "https://recherche-entreprises.api.gouv.fr";
const AUCH_OSM_CONFIG: OsmNormalizeConfig = {
  sourceName: "osm-auch",
  sourceUrl: "https://download.geofabrik.de/europe/france/midi-pyrenees.html",
  stableIdPrefix: "osm-auch:",
  priority: 65,
  retention: "complete",
  roadNetworkFromBdtopo: true,
};

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

function parseArgs(args: string[]): { rawDir: string; outDir: string } {
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

function rssBytes(): number {
  return process.memoryUsage().rss;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)}MB`;
}

function jsonErrorDetail(text: string): string {
  return text.length <= MAX_JSON_ERROR_DETAIL ? text : `${text.slice(0, MAX_JSON_ERROR_DETAIL)}...`;
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

function boundaryFromRaw(raw: RawBoundary, scope?: NormalizeScope): BoundaryFeature {
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
  let context: { stableId: string; sourceId: string; territoryCode: string; name: string | undefined };
  if (scope === undefined) {
    context = { stableId: `boundary:department/${GERS_TERRITORY.code}`, sourceId: `admin-express:${GERS_TERRITORY.code}`, territoryCode: GERS_TERRITORY.code, name: undefined };
  } else {
    const properties = rawFeature?.properties ?? {};
    const communeCode = text(properties.code_insee) ?? text(properties.code);
    if (!communeCode) throw new Error("Commune boundary is missing an INSEE code property");
    context = { stableId: `boundary:commune/${communeCode}`, sourceId: `admin-express:${communeCode}`, territoryCode: communeCode, name: text(properties.nom_officiel) ?? text(properties.nom) };
  }
  const feature = {
    kind: "boundary",
    stableId: context.stableId,
    sourceId: context.sourceId,
    territoryCode: context.territoryCode,
    name: context.name,
    geometry,
    localGeometry,
    lon,
    lat,
    x: localFocus[0],
    z: localFocus[1],
    confidence: "high",
    status: "active",
    provenance: [{ featureId: context.stableId, property: "geometry", winner: "IGN ADMIN EXPRESS COG", contenders: ["IGN ADMIN EXPRESS COG"], priority: 100, timestamp: SOURCE_TIMESTAMP }],
    sourceRefs: [{ source: "IGN ADMIN EXPRESS COG", url: "https://data.geopf.fr/wfs/ows", timestamp: SOURCE_TIMESTAMP, license: "Licence Ouverte / Open Licence 2.0" }],
  };
  return parseFeature(feature, context.stableId) as BoundaryFeature;
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
  for (let cursor = 0; cursor < relations.length; cursor += FEATURE_BATCH_SIZE) {
    const end = Math.min(relations.length, cursor + FEATURE_BATCH_SIZE);
    for (let position = cursor; position < end; position += 1) {
      const relation = relations[position]!;
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
  }
  for (let cursor = 0; cursor < elements.length; cursor += FEATURE_BATCH_SIZE) {
    const end = Math.min(elements.length, cursor + FEATURE_BATCH_SIZE);
    for (let position = cursor; position < end; position += 1) {
      const element = elements[position]!;
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
  }
  return { features, relationIssues };
}

export function normalizeOsm(raw: RawOsm, boundary: BoundaryFeature): MapFeature[] {
  return normalizeOsmWithReport(raw, boundary).features;
}

function positionLabel(state: JsonScanner, readPath: string): string {
  return `${readPath} at character ${state.cursor}`;
}

class TruncatedJsonError extends Error {
  constructor(message: string) {
    super(`Truncated JSON document: ${message}`);
    this.name = "TruncatedJsonError";
  }
}

interface JsonScanner {
  text: string;
  cursor: number;
  closed: boolean;
  pull: () => string | null;
  release?: () => void;
}

function fillScanner(state: JsonScanner): boolean {
  if (state.cursor < state.text.length) return true;
  const next = state.pull();
  if (next === null) return false;
  state.text = state.text.length === 0 ? next : state.text + next;
  return true;
}

function compactScanner(state: JsonScanner): void {
  if (state.cursor === 0) return;
  state.text = state.text.slice(state.cursor);
  state.cursor = 0;
}

function jsonValueComplete(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function skipWhitespace(state: JsonScanner): boolean {
  for (;;) {
    while (state.cursor < state.text.length) {
      const code = state.text.charCodeAt(state.cursor);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        state.cursor += 1;
        continue;
      }
      return true;
    }
    if (!fillScanner(state)) return false;
  }
}

function scanValue(state: JsonScanner, readPath: string): string {
  while (state.cursor >= state.text.length) {
    if (!fillScanner(state)) throw new TruncatedJsonError(positionLabel(state, readPath));
  }
  const start = state.cursor;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (;;) {
    while (state.cursor < state.text.length) {
      const code = state.text.charCodeAt(state.cursor);
      if (inString) {
        if (escaped) {
          escaped = false;
          state.cursor += 1;
          continue;
        }
        if (code === 0x5c) {
          escaped = true;
          state.cursor += 1;
          continue;
        }
        state.cursor += 1;
        if (code === 0x22) {
          inString = false;
          if (depth === 0) return state.text.slice(start, state.cursor);
        }
        continue;
      }
      if (code === 0x22) {
        inString = true;
        state.cursor += 1;
        continue;
      }
      if (code === 0x7b || code === 0x5b) {
        depth += 1;
        state.cursor += 1;
        continue;
      }
      if (code === 0x7d || code === 0x5d) {
        if (depth === 0) return state.text.slice(start, state.cursor);
        depth -= 1;
        state.cursor += 1;
        if (depth === 0) return state.text.slice(start, state.cursor);
        continue;
      }
      if (depth === 0 && (code === 0x2c || code === 0x5d)) {
        return state.text.slice(start, state.cursor);
      }
      if (depth === 0 && (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d)) {
        const candidate = state.text.slice(start, state.cursor).trim();
        if (jsonValueComplete(candidate)) return candidate;
        state.cursor += 1;
        continue;
      }
      state.cursor += 1;
    }
    if (!fillScanner(state)) {
      if (inString || depth > 0) throw new TruncatedJsonError(positionLabel(state, readPath));
      const value = state.text.slice(start, state.cursor).trim();
      if (value.length === 0 || !jsonValueComplete(value)) throw new TruncatedJsonError(positionLabel(state, readPath));
      return value;
    }
  }
}

function nextValue(state: JsonScanner, readPath: string): string | null {
  compactScanner(state);
  for (;;) {
    if (!skipWhitespace(state)) return null;
    const code = state.text.charCodeAt(state.cursor);
    if (code === 0x2c || code === 0x3a) {
      state.cursor += 1;
      continue;
    }
    if (code === 0x5b) {
      state.cursor += 1;
      continue;
    }
    if (code === 0x5d) {
      state.cursor += 1;
      state.closed = true;
      return "]";
    }
    return scanValue(state, readPath);
  }
}

function seekFirstArray(state: JsonScanner, readPath: string): boolean {
  for (;;) {
    if (!skipWhitespace(state)) return false;
    const code = state.text.charCodeAt(state.cursor);
    if (code === 0x5b) {
      state.cursor += 1;
      return true;
    }
    if (code === 0x7b || code === 0x7d || code === 0x2c || code === 0x3a) {
      state.cursor += 1;
      continue;
    }
    scanValue(state, readPath);
  }
}

function seekArrayField(state: JsonScanner, field: string, readPath: string): boolean {
  let depth = 0;
  let pendingKey: string | null = null;
  for (;;) {
    if (!skipWhitespace(state)) return false;
    const code = state.text.charCodeAt(state.cursor);
    if (byte(code) === "brace-open" || byte(code) === "bracket-open") {
      if (code === 0x5b && pendingKey === field && depth === 1) {
        state.cursor += 1;
        return true;
      }
      depth += 1;
      state.cursor += 1;
      pendingKey = null;
      continue;
    }
    if (byte(code) === "brace-close") {
      depth -= 1;
      state.cursor += 1;
      if (depth <= 0) return false;
      continue;
    }
    if (byte(code) === "comma" || byte(code) === "colon") {
      state.cursor += 1;
      continue;
    }
    const token = scanValue(state, readPath);
    if (code === 0x22) pendingKey = token.slice(1, -1);
    else pendingKey = null;
  }
}

function byte(code: number): "brace-open" | "bracket-open" | "brace-close" | "comma" | "colon" | "other" {
  if (code === 0x7b) return "brace-open";
  if (code === 0x5b) return "bracket-open";
  if (code === 0x7d || code === 0x5d) return "brace-close";
  if (code === 0x2c) return "comma";
  if (code === 0x3a) return "colon";
  return "other";
}

function scannerFromChunks(chunks: Iterable<string>): JsonScanner {
  const iterator = chunks[Symbol.iterator]();
  return {
    text: "",
    cursor: 0,
    closed: false,
    pull: () => {
      const next = iterator.next();
      return next.done ? null : String(next.value);
    },
  };
}

function scannerFromLines(filePath: string): JsonScanner {
  const handle = openSync(filePath, "r");
  let closed = false;
  const release = (): void => {
    if (closed) return;
    closed = true;
    closeSync(handle);
  };
  const buffer = Buffer.allocUnsafe(LINE_READ_SIZE);
  let position = 0;
  let pending = "";
  let done = false;
  return {
    text: "",
    cursor: 0,
    closed: false,
    release,
    pull: () => {
      if (pending.length > 0) {
        const line = pending;
        pending = "";
        return line;
      }
      if (done) return null;
      const read = readSync(handle, buffer, 0, buffer.length, position);
      if (read === 0) {
        done = true;
        release();
        return null;
      }
      position += read;
      const decoded = buffer.toString("utf8", 0, read);
      const lastBreak = decoded.lastIndexOf("\n");
      const complete = lastBreak < 0 ? "" : decoded.slice(0, lastBreak + 1);
      pending = lastBreak < 0 ? decoded : decoded.slice(lastBreak + 1);
      if (complete.length === 0) return decoded;
      return complete;
    },
  };
}

function parseJsonObject(chunk: string, readPath: string, scanner: JsonScanner): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(chunk);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (error) {
    throw new SyntaxError(`Invalid JSON value in ${positionLabel(scanner, readPath)}: ${jsonErrorDetail(error instanceof Error ? error.message : String(error))}`);
  }
}

export function createJsonStringStream(chunks: Iterable<string>, readPath = "<string>"): AsyncIterable<string | Record<string, unknown>> {
  const scanner = scannerFromChunks(chunks);
  let located = false;
  return {
    [Symbol.asyncIterator](): AsyncIterator<string | Record<string, unknown>> {
      return {
        next: async (): Promise<IteratorResult<string | Record<string, unknown>>> => {
          if (!located) {
            located = true;
            if (!seekFirstArray(scanner, readPath)) return { done: true, value: undefined };
          }
          const chunk = nextValue(scanner, readPath);
          if (chunk === null) {
            if (!scanner.closed) throw new TruncatedJsonError(positionLabel(scanner, readPath));
            return { done: true, value: undefined };
          }
          if (chunk === "]") return { done: true, value: undefined };
          if (chunk === "," || chunk === ":") return this.next();
          try {
            return { done: false, value: JSON.parse(chunk) as string | Record<string, unknown> };
          } catch (error) {
            throw new SyntaxError(`Invalid JSON value in ${positionLabel(scanner, readPath)}: ${jsonErrorDetail(error instanceof Error ? error.message : String(error))}`);
          }
        },
        [Symbol.asyncIterator](): AsyncIterator<string | Record<string, unknown>> {
          return this;
        },
      };
    },
  };
}

export function streamJsonArray(filePath: string, field?: string): JsonObjectStream {
  const scanner = scannerFromLines(filePath);
  let located = field === undefined;
  return {
    close: () => scanner.release?.(),
    [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
      return {
        next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
          if (!located) {
            located = true;
            if (field !== undefined && !seekArrayField(scanner, field, filePath)) return { done: true, value: undefined };
          }
          for (;;) {
            const chunk = nextValue(scanner, filePath);
            if (chunk === null) {
              if (!scanner.closed) throw new TruncatedJsonError(positionLabel(scanner, filePath));
              return { done: true, value: undefined };
            }
            if (chunk === "]") return { done: true, value: undefined };
            if (chunk === "," || chunk === ":") continue;
            if (chunk === "[") continue;
            return { done: false, value: parseJsonObject(chunk, filePath, scanner) };
          }
        },
        [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
          return this;
        },
      };
    },
  };
}

export function streamFeatureCollection(filePath: string): JsonObjectStream {
  const scanner = scannerFromLines(filePath);
  let located = false;
  return {
    close: () => scanner.release?.(),
    [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
      return {
        next: async (): Promise<IteratorResult<Record<string, unknown>>> => {
          if (!located) {
            located = true;
            if (!seekFeatureArray(scanner, filePath)) throw new Error(`Invalid GeoJSON FeatureCollection: ${filePath}`);
          }
          for (;;) {
            const chunk = nextValue(scanner, filePath);
            if (chunk === null) {
              if (!scanner.closed) throw new TruncatedJsonError(positionLabel(scanner, filePath));
              return { done: true, value: undefined };
            }
            if (chunk === "]") return { done: true, value: undefined };
            if (chunk === "," || chunk === ":") continue;
            if (chunk === "[") continue;
            return { done: false, value: parseJsonObject(chunk, filePath, scanner) };
          }
        },
        [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
          return this;
        },
      };
    },
  };
}

function seekFeatureArray(scanner: JsonScanner, readPath: string): boolean {
  for (;;) {
    if (!skipWhitespace(scanner)) return false;
    const code = scanner.text.charCodeAt(scanner.cursor);
    if (code === 0x5b) {
      scanner.cursor += 1;
      return true;
    }
    if (byte(code) === "other") scanValue(scanner, readPath);
    else scanner.cursor += 1;
    if (byte(code) === "brace-close") continue;
  }
}

export function streamOsmBulk(filePath: string, boundary: BulkInputBoundary, config?: OsmNormalizeConfig): OsmBulkStream {
  const report = emptyOsmNormalizeReport();
  const scanner = scannerFromLines(filePath);
  let located = false;
  return {
    report,
    close: () => scanner.release?.(),
    [Symbol.asyncIterator](): AsyncIterator<MapFeature> {
      return {
        next: async (): Promise<IteratorResult<MapFeature>> => {
          if (!located) {
            located = true;
            if (!seekFeatureArray(scanner, filePath)) throw new Error(`Invalid GeoJSON FeatureCollection: ${filePath}`);
          }
          for (;;) {
            const chunk = nextValue(scanner, filePath);
            if (chunk === null) {
              if (!scanner.closed) throw new TruncatedJsonError(positionLabel(scanner, filePath));
              return { done: true, value: undefined };
            }
            if (chunk === "]") return { done: true, value: undefined };
            if (chunk === "," || chunk === ":") continue;
            if (chunk === "[") continue;
            const outcome = normalizeOsmBulkFeature(parseJsonObject(chunk, filePath, scanner), boundary, config, report);
            if (outcome.feature !== null) return { done: false, value: outcome.feature };
          }
        },
        [Symbol.asyncIterator](): AsyncIterator<MapFeature> {
          return this;
        },
      };
    },
  };
}

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

class FeatureChunkWriter {
  private readonly handles = new Map<string, number>();
  private readonly buffers = new Map<string, string[]>();
  private readonly counts = new Map<string, number>();
  private readonly directory: string;
  private total = 0;

  constructor(directory: string) {
    this.directory = directory;
  }

  kinds(): string[] {
    return [...this.counts.keys()];
  }

  recordCount(kind: string): number {
    return this.counts.get(kind) ?? 0;
  }

  totalCount(): number {
    return this.total;
  }

  private flush(kind: string, force: boolean): void {
    const buffered = this.buffers.get(kind);
    if (buffered === undefined || buffered.length === 0) return;
    if (!force && buffered.length < BUFFER_WRITE_BATCH) return;
    const handle = this.handles.get(kind);
    if (handle === undefined) return;
    writeSync(handle, buffered.join(""));
    buffered.length = 0;
  }

  private openChunk(kind: string, count: number): void {
    const existing = this.handles.get(kind);
    if (existing !== undefined) {
      this.flush(kind, true);
      writeSync(existing, "\n]\n");
      closeSync(existing);
    }
    const suffix = count === 0 ? "" : `-${String(count / CHUNK_SIZE).padStart(4, "0")}`;
    const handle = openSync(path.join(this.directory, `${kind}${suffix}.json`), "w");
    this.handles.set(kind, handle);
    this.buffers.set(kind, ["["]);
  }

  push(feature: MapFeature): void {
    const kind = feature.kind;
    const count = this.counts.get(kind) ?? 0;
    if (this.handles.get(kind) === undefined || count % CHUNK_SIZE === 0) this.openChunk(kind, count);
    const buffered = this.buffers.get(kind)!;
    buffered.push(count % CHUNK_SIZE === 0 ? "\n" : ",\n", JSON.stringify(feature));
    this.counts.set(kind, count + 1);
    this.total += 1;
    this.flush(kind, false);
  }

  close(): void {
    for (const kind of this.handles.keys()) {
      this.flush(kind, true);
      const handle = this.handles.get(kind)!;
      writeSync(handle, "\n]\n");
      closeSync(handle);
    }
    this.handles.clear();
    this.buffers.clear();
  }
}

async function writeJsonArray(filePath: string, values: AsyncIterable<unknown> | Iterable<unknown>): Promise<void> {
  const handle = await fs.open(filePath, "w");
  let buffer = "";
  let first = true;
  try {
    await handle.write("[");
    for await (const value of values) {
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

async function readJson(filePath: string, required: boolean): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if (required) throw new Error(`Required source file missing or invalid: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOsmBulkReport(report: OsmNormalizeReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function collectOsmObjectIds(filePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const stream = streamJsonArray(filePath, "features");
  try {
    for await (const feature of stream) {
      if (!isRecord(feature.properties)) continue;
      const properties = feature.properties as Record<string, unknown>;
      const type = text(properties["@type"]);
      const id = numberValue(properties["@id"]);
      if (type === undefined || id === undefined) continue;
      ids.add(`${type}/${id}`);
    }
  } finally {
    stream.close();
  }
  return ids;
}

function canonicalOsmObjectIds(sourceId: string | undefined): string[] {
  if (sourceId === undefined) return [];
  if (/^(node|way|relation)\/\d+$/.test(sourceId)) return [sourceId];
  if (/^[nwr]\d+$/.test(sourceId)) {
    const prefix = sourceId[0]!;
    const type = prefix === "n" ? "node" : prefix === "w" ? "way" : "relation";
    return [`${type}/${sourceId.slice(1)}`];
  }
  if (/^a\d+$/.test(sourceId)) return [`way/${sourceId.slice(1)}`, `relation/${sourceId.slice(1)}`];
  return [];
}

async function loadRawSources(rawDir: string, scope?: NormalizeScope, intermediateDir = path.join(dataRoot(), "intermediate")): Promise<RawSources> {
  const boundary = await readJson(path.join(rawDir, scope?.boundaryRawFile ?? GERS_TERRITORY.boundaryRawFile), true);
  if (typeof boundary !== "object" || boundary === null) throw new Error("Admin Express boundary is not an object");
  const osmParsed = await readJson(path.join(rawDir, "osm.json"), false);
  const osm: RawOsm = typeof osmParsed === "object" && osmParsed !== null && Array.isArray((osmParsed as Record<string, unknown>).elements)
    ? osmParsed as unknown as RawOsm
    : { elements: [], timestamp: "", query: "" };
  const files = await fs.readdir(rawDir, { withFileTypes: true });
  const bdtopoDir = scope?.bdtopoDir ?? rawDir;
  const bdtopoEntries = bdtopoDir === rawDir ? files : await fs.readdir(bdtopoDir, { withFileTypes: true });
  const bdtopoFiles = bdtopoEntries
    .filter((entry) => entry.isFile() && ADOPTED_LAYERS.has(entry.name))
    .map((entry) => path.join(bdtopoDir, entry.name))
    .sort();
  if (bdtopoFiles.length === 0) throw new Error("No canonical BD TOPO exports found");
  const addressFile = scope === undefined ? "ban-addresses.json" : "ban-addresses-auch.json";
  const addressPath = path.join(rawDir, addressFile);
  const businessFile = path.join(rawDir, "businesses-sirene.json");
  const addressHeader = await readObjectHeader(addressPath, true);
  const businessHeader = await readObjectHeader(businessFile, true);
  const businessesOsm = (await readJson(path.join(rawDir, "businesses-osm.json"), false)) as Record<string, unknown> ?? {};
  const businessesWeb = (await readJson(path.join(rawDir, "businesses-web.json"), false)) as Record<string, unknown> ?? {};
  const ign: RawSources["ign"] = { features: [], unavailable: true };
  const ignUnavailable = await readJson(path.join(intermediateDir, "ign-unavailable.json"), false);
  let osmExtractFile: string | null = null;
  if (scope?.osmExtractFile !== undefined) {
    const extractPath = path.join(rawDir, scope.osmExtractFile);
    const stats = await fs.stat(extractPath);
    if (!stats.isFile()) throw new Error(`OSM extract is not a file: ${extractPath}`);
    osmExtractFile = extractPath;
  }
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
  const bulkPath = path.join(rawDir, "osm-bulk.geojson");
  const bulkStats = await fs.stat(bulkPath).catch(() => null);
  const osmBulkFile = bulkStats?.isFile() === true && bulkStats.size > 0 ? bulkPath : null;
  return {
    boundary: boundary as RawBoundary,
    osm: osm.elements.length > 0 ? osm : { elements: [], timestamp: osmBulkFile === null ? osm.timestamp : "bulk", query: osmBulkFile === null ? osm.query : "geofabrik-enrichment" },
    osmBulkFile,
    bdtopoFiles,
    addressFile: addressPath,
    addressLicense: text(addressHeader.license),
    businessFile,
    businessHeader,
    businessesOsm,
    businessesWeb,
    ign,
    osmExtractFile,
  };
}

async function readObjectHeader(filePath: string, required: boolean): Promise<Record<string, unknown>> {
  const stream = streamJsonArray(filePath);
  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await iterator.next();
      if (step.done) return {};
      return step.value;
    }
  } catch (error) {
    if (required) throw new Error(`Required source file missing or invalid: ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  } finally {
    stream.close();
  }
}


function sameGeometry(first: Geometry, second: Geometry): boolean {
  if (first.type !== second.type) return false;
  if (first.type === "Point" && second.type === "Point") {
    return first.coordinates[0] === second.coordinates[0] && first.coordinates[1] === second.coordinates[1];
  }
  return JSON.stringify(first) === JSON.stringify(second);
}

function canonicalGeometry(geometry: Geometry): Geometry {
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") return geometry;
  const normalized = normalizePolygonGeometry(geometry);
  if (!normalized) throw new Error("Area geometry has no non-degenerate polygon");
  return normalized;
}

/** Kinds whose source labels sometimes arrive in capitals (BD TOPO public places, ERP, SIRENE signs). */
const TITLE_CASED_KINDS = new Set(["poi", "business", "landuse", "building", "transport", "structure"]);

function canonicalLabel(kind: string, value: string): string {
  const tidied = tidyLabel(value);
  /* Streets read as signposted ("Che du Moulin" is "Chemin du Moulin"), places with every compound part capitalised. */
  if (kind === "road") return displayStreetName(tidied);
  if (kind === "place") return capitaliseCompounds(tidied);
  return TITLE_CASED_KINDS.has(kind) && !/[a-zß-ÿ]/.test(tidied) && /[A-Z]{3}/.test(tidied) ? displayCase(tidied) : tidied;
}

function canonicalFeature(input: MapFeature): MapFeature {
  const name = input.name === undefined ? undefined : canonicalLabel(input.kind, input.name);
  const businessName = input.kind === "business" ? canonicalLabel(input.kind, input.businessName) : undefined;
  const street = input.kind === "address" && input.street !== undefined ? displayStreetName(input.street) : undefined;
  const feature = (name !== input.name || (input.kind === "business" && businessName !== input.businessName) || (input.kind === "address" && street !== input.street))
    ? { ...input, ...(name === undefined ? {} : { name }), ...(businessName === undefined ? {} : { businessName }), ...(street === undefined ? {} : { street }) } as MapFeature
    : input;
  const geometry = canonicalGeometry(feature.geometry);
  const localGeometry = feature.localGeometry ? canonicalGeometry(feature.localGeometry) : undefined;
  const source = feature.sourceGeometry === undefined ? undefined : canonicalGeometry(feature.sourceGeometry);
  const redundant = source !== undefined && sameGeometry(geometry, source);
  const candidate = { ...feature, geometry, localGeometry, sourceGeometry: redundant ? undefined : source };
  const parsed = MapFeatureSchema.safeParse(candidate);
  if (!parsed.success) throw new Error(`Invalid normalized feature: ${parsed.error.message}`);
  return parsed.data;
}

export function normalizeAddresses(source: AddressSourceInput, boundary: BoundaryFeature): AddressFeature[] {
  const features: AddressFeature[] = [];
  normalizeAddressesInto(source, boundary, (feature) => features.push(feature));
  return features;
}

async function normalizeAddressesInto(source: AddressSourceInput, boundary: BoundaryFeature, emit: (feature: AddressFeature) => void): Promise<void> {
  const boundaries = boundaryPolygons(boundary);
  const boundaryIndex = createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates));
  const stream = source.addresses === undefined ? streamJsonArray(source.file, "addresses") : null;
  const pending: AddressFeature[] = [];
  const flush = (): void => {
    for (const feature of pending) emit(feature);
    pending.length = 0;
  };
  const consume = async function* (): AsyncGenerator<Record<string, unknown>> {
    if (source.addresses !== undefined) yield* source.addresses;
    if (stream !== null) {
      for await (const record of stream) yield record;
    }
  };
  try {
    for await (const record of consume()) {
      const longitude = numberValue(record.lon);
      const latitude = numberValue(record.lat);
      if (longitude === undefined || latitude === undefined || !boundaryIndex.contains([longitude, latitude])) continue;
      const housenumber = [text(record.numero), text(record.repetition)].filter((part) => part !== undefined).join(" ");
      const rawStreet = text(record.streetName ?? record.street) ?? text(record.localityName);
      const street = rawStreet === undefined ? "unknown street" : displayStreetName(rawStreet);
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
        sourceRefs: [{ source: "ban", url: BAN_URL, timestamp: SOURCE_TIMESTAMP, license: source.license ?? "Etalab-2.0" }],
      }, stableId);
      pending.push(feature as AddressFeature);
      if (pending.length >= FEATURE_BATCH_SIZE) flush();
    }
  } finally {
    stream?.close();
  }
  flush();
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

interface BusinessSourceFactory {
  now: string;
  create(kind: "sirene" | "osm", url: string | undefined, timestamp: string, license: string | undefined): SourceReference;
}

function businessSources(header: Record<string, unknown> | null): BusinessSourceFactory {
  const now = cleanString(header?.acquiredAt) ?? SOURCE_TIMESTAMP;
  const sourceUrl = cleanString(header?.sourceUrl) ?? BUSINESS_URL;
  const license = cleanString(header?.license) ?? "Licence Ouverte / Open Licence 2.0";
  return {
    now,
    create: (kind, url, timestamp, licenseOverride) => ({ source: kind, url: url ?? sourceUrl, timestamp, license: licenseOverride ?? license }),
  };
}

function sireneBusiness(raw: Record<string, unknown>, factory: BusinessSourceFactory): BusinessFeature {
  const coordinateRecord = isRecord(raw["coordinate"]) ? raw["coordinate"] : {};
  const longitude = numberValue(coordinateRecord.lon);
  const latitude = numberValue(coordinateRecord.lat);
  const businessName = cleanString(raw.tradingName) ?? cleanString(raw.legalName);
  if (longitude === undefined || latitude === undefined || !businessName) throw new Error("SIRENE record has no coordinate and name");
  const nafCode = cleanString(raw.nafCode);
  if (!nafIsPlace(nafCode)) throw new Error("SIRENE record describes a legal vehicle, not a place");
  if (cleanString(raw.administrativeStatus) !== undefined && cleanString(raw.administrativeStatus) !== "A") throw new Error("SIRENE establishment is closed");
  const siret = cleanString(raw.siret);
  const stableId = siret ? `business:siret/${siret}` : buildStableId("business", businessName, cleanString(raw.address) ?? "", [longitude, latitude]);
  const local = wgs84ToRender([longitude, latitude]);
  const source = factory.create("sirene", undefined, cleanString(raw.acquiredAt) ?? factory.now, undefined);
  return parseFeature({
    kind: "business",
    stableId,
    sourceId: siret,
    businessId: siret,
    siret,
    siren: cleanString(raw.siren),
    businessName,
    legalName: cleanString(raw.legalName),
    brand: cleanString(raw.signName),
    category: categoryForNaf(nafCode) ?? cleanString(raw.nafLabel),
    nafCode,
    nafLabel: cleanString(raw.nafLabel),
    name: businessName,
    address: cleanString(raw.address),
    lon: longitude,
    lat: latitude,
    x: local[0],
    z: local[1],
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    localGeometry: { type: "Point", coordinates: local },
    confidence: "high",
    status: cleanString(raw.administrativeStatus) === "A" || raw.administrativeStatus === undefined ? ("active" as const) : ("uncertain" as const),
    provenance: [{ featureId: stableId, property: "identity", winner: "sirene", contenders: ["sirene"], priority: 80, timestamp: source.timestamp }],
    sourceRefs: [source],
    administrativeStatus: cleanString(raw.administrativeStatus),
    creationDate: cleanString(raw.creationDate),
  }, stableId) as BusinessFeature;
}

function osmBusiness(element: Record<string, unknown>, factory: BusinessSourceFactory): BusinessFeature {
  const tags = isRecord(element.tags) ? element.tags as Record<string, string> : {};
  const businessName = cleanString(tags.name);
  if (!businessName) throw new Error("OSM business element has no name");
  const pointValue = element.type === "node" ? element : isRecord(element.center) ? element.center : undefined;
  const pointRecord = pointValue !== undefined ? pointValue : {};
  const longitude = numberValue(pointRecord.lon);
  const latitude = numberValue(pointRecord.lat);
  if (longitude === undefined || latitude === undefined) throw new Error("OSM business element has no coordinate");
  const local = wgs84ToRender([longitude, latitude]);
  const elementType = cleanString(element.type) ?? "element";
  const elementId = numberValue(element.id) ?? 0;
  const stableId = `business:osm/${elementType}/${elementId}`;
  const source = factory.create("osm", `${OSM_URL}/${elementType}/${elementId}`, factory.now, "ODbL-1.0");
  return parseFeature({
    kind: "business",
    stableId,
    sourceId: stableId,
    businessId: stableId,
    businessName,
    name: businessName,
    brand: cleanString(tags.brand),
    category: categoryForOsmTags(tags) ?? cleanString(tags.shop) ?? cleanString(tags.office) ?? cleanString(tags.craft) ?? cleanString(tags.amenity),
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
  }, stableId) as BusinessFeature;
}

class BusinessNormalizer {
  private readonly features: BusinessFeature[] = [];
  private readonly indexBySiret = new Map<string, number>();
  private readonly indexByName = new Map<string, number[]>();
  private readonly propertySource = new Map<string, Map<string, string>>();

  constructor(private readonly boundaryIndex: BoundaryIndex) {}

  private static priority(source: string): number {
    if (source === "official-website") return 90;
    if (source === "sirene") return 80;
    if (source === "annuaire-entreprises") return 75;
    if (source === "osm") return 60;
    return 40;
  }

  private match(candidate: BusinessFeature): number | undefined {
    if (candidate.siret) {
      const index = this.indexBySiret.get(candidate.siret);
      return index === undefined ? undefined : index;
    }
    const candidates = this.indexByName.get(normalizedText(candidate.businessName)) ?? [];
    for (const index of candidates) {
      const feature = this.features[index]!;
      if (feature.siret) continue;
      if (addressEvidence(candidate.address, feature.address)
        && metricDistance([candidate.lon!, candidate.lat!], [feature.lon!, feature.lat!]) <= 150) return index;
    }
    return undefined;
  }

  private addSource(feature: BusinessFeature, reference: SourceReference): void {
    if (!feature.sourceRefs.some((candidate) => candidate.source === reference.source && candidate.url === reference.url)) feature.sourceRefs.push(reference);
  }

  private mergeField(feature: BusinessFeature, property: keyof BusinessFeature, value: string | undefined, source: string): void {
    if (!value) return;
    const sources = this.propertySource.get(feature.stableId) ?? new Map<string, string>();
    const current = feature[property];
    const currentSource = sources.get(String(property)) ?? "unknown";
    if (typeof current !== "string" || BusinessNormalizer.priority(source) > BusinessNormalizer.priority(currentSource)) {
      (feature as unknown as Record<string, unknown>)[String(property)] = value;
      sources.set(String(property), source);
      this.propertySource.set(feature.stableId, sources);
    }
  }

  accept(candidate: BusinessFeature): void {
    if (!this.boundaryIndex.contains([candidate.lon!, candidate.lat!])) return;
    const existing = this.match(candidate);
    if (existing === undefined) {
      const index = this.features.length;
      this.features.push(candidate);
      if (candidate.siret) this.indexBySiret.set(candidate.siret, index);
      const nameKey = normalizedText(candidate.businessName);
      const list = this.indexByName.get(nameKey) ?? [];
      list.push(index);
      this.indexByName.set(nameKey, list);
      const sources = new Map<string, string>();
      const source = candidate.sourceRefs[0]?.source ?? "unknown";
      for (const property of ["businessName", "legalName", "brand", "category", "nafCode", "nafLabel", "address", "website", "phone", "openingHours", "operator", "wheelchair"] as const) {
        if (candidate[property]) sources.set(property, source);
      }
      this.propertySource.set(candidate.stableId, sources);
      return;
    }
    const target = this.features[existing]!;
    const reference = candidate.sourceRefs[0];
    if (reference) this.addSource(target, reference);
    const source = reference?.source ?? "unknown";
    for (const property of ["address", "brand", "category", "nafCode", "nafLabel", "website", "phone", "openingHours", "operator", "wheelchair"] as const) {
      this.mergeField(target, property, candidate[property] as string | undefined, source);
    }
  }

  enrichWeb(raw: Record<string, unknown>): void {
    if (raw.status !== "ok") return;
    const businessName = cleanString(raw.name) ?? cleanString(raw.title);
    if (!businessName) return;
    const coordinateRecord = isRecord(raw.coordinate) ? raw.coordinate : {};
    const longitude = numberValue(coordinateRecord.lon);
    const latitude = numberValue(coordinateRecord.lat);
    const candidates = this.indexByName.get(normalizedText(businessName)) ?? [];
    for (const index of candidates) {
      const feature = this.features[index]!;
      if (longitude !== undefined && latitude !== undefined && metricDistance([feature.lon!, feature.lat!], [longitude, latitude]) > 150) continue;
      const sourceId = cleanString(raw.sourceId) ?? "official-website";
      const source = sourceId.includes("pagesjaunes") ? "pagesjaunes" : "official-website";
      const reference: SourceReference = { source, url: cleanString(raw.url), timestamp: cleanString(raw.acquiredAt) ?? SOURCE_TIMESTAMP, license: undefined };
      this.addSource(feature, reference);
      this.mergeField(feature, "address", cleanString(raw.address), source);
      this.mergeField(feature, "phone", cleanString(raw.phone), source);
      this.mergeField(feature, "website", cleanString(raw.url), source);
      return;
    }
  }

  results(): BusinessFeature[] {
    return this.features;
  }
}

export async function normalizeBusinesses(sources: BusinessSources, boundary: BoundaryFeature, osmRaw?: Record<string, unknown>, webRaw?: Record<string, unknown>): Promise<BusinessFeature[]> {

  const input: BusinessSources = { file: sources.file, header: sources.header, osm: sources.osm ?? osmRaw ?? {}, web: sources.web ?? webRaw ?? {} };
  const boundaries = boundaryPolygons(boundary);
  const boundaryIndex = createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates));
  const factory = businessSources(sources.header);
  const normalizer = new BusinessNormalizer(boundaryIndex);
  const recordStream = sources.records === undefined ? streamJsonArray(sources.file, "records") : null;
  const inMemory = sources.records ?? [];
  if (recordStream === null) {
    for (const record of inMemory) {
      try {
        normalizer.accept(sireneBusiness(record, factory));
      } catch {
        continue;
      }
    }
  } else {
    try {
      for await (const record of recordStream) {
        try {
          normalizer.accept(sireneBusiness(record, factory));
        } catch {
          continue;
        }
      }
    } finally {
      recordStream.close();
    }
  }
  const body = input.osm.body;
  const elements = isRecord(body) && Array.isArray((body as Record<string, unknown>).elements)
    ? (body as { elements: Record<string, unknown>[] }).elements
    : [];
  for (const element of elements) {
    try {
      normalizer.accept(osmBusiness(element, factory));
    } catch {
      continue;
    }
  }
  const results = Array.isArray(input.web.results) ? input.web.results.filter(isRecord) : [];
  for (const value of results) normalizer.enrichWeb(value);
  return normalizer.results();
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

async function clearStaleIntermediateFiles(outDir: string): Promise<void> {
  for (const entry of await fs.readdir(outDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json") && !PRESERVED_INTERMEDIATE_FILES.has(entry.name)) await fs.unlink(path.join(outDir, entry.name));
  }
}

async function writeNormalizedFeatures(outDir: string, writer: FeatureChunkWriter): Promise<void> {
  const pending: ProvenanceRecord[] = [];
  for (const kind of writer.kinds()) {
    const chunkCount = Math.max(1, Math.ceil(writer.recordCount(kind) / CHUNK_SIZE));
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const suffix = chunk === 0 ? "" : `-${String(chunk).padStart(4, "0")}`;
      const parsed: unknown = JSON.parse(await fs.readFile(path.join(outDir, `${kind}${suffix}.json`), "utf8"));
      if (!Array.isArray(parsed)) continue;
      for (const value of parsed) {
        if (!isRecord(value) || !Array.isArray(value.provenance)) continue;
        for (const record of value.provenance) pending.push(record as ProvenanceRecord);
      }
    }
  }
  await writeJsonArray(path.join(outDir, "provenance.json"), pending);
}

function logPhase(phase: string, rss: () => number): void {
  console.error(`[normalize] ${phase} rss=${megabytes(rss())}`);
}

export async function normalizeAll(rawDir?: string, outDir?: string, scope?: NormalizeScope, options: NormalizeAllOptions = {}): Promise<FeatureCounts> {
  const root = dataRoot();
  const sourceDir = rawDir ?? path.join(root, "raw");
  const destinationDir = outDir ?? path.join(root, "intermediate");
  const rss = options.rss ?? rssBytes;
  const emit = options.emit;
  await fs.mkdir(destinationDir, { recursive: true });
  logPhase("sources begin", rss);
  const sources = await loadRawSources(sourceDir, scope, destinationDir);
  const boundary = boundaryFromRaw(sources.boundary, scope);
  const boundaries = boundaryPolygons(boundary);
  const boundaryIndex = createBoundaryIndex(boundaries.map((polygon) => polygon.coordinates));
  const bdtopoManifest = await readJson(path.join(destinationDir, "bdtopo-manifest.json"), false);
  const bdtopoEdition = typeof bdtopoManifest === "object" && bdtopoManifest !== null ? text((bdtopoManifest as Record<string, unknown>).edition) : undefined;
  const osmResult = normalizeOsmWithReport(sources.osm, boundary);
  await fs.writeFile(path.join(destinationDir, "relation-issues.json"), `${JSON.stringify(osmResult.relationIssues, null, 2)}\n`, "utf8");
  logPhase("sources ready", rss);

  await clearStaleIntermediateFiles(destinationDir);
  const writer = new FeatureChunkWriter(destinationDir);
  const invalidFeatures: Array<{ stableId: string; kind: string; error: string }> = [];
  let invalidTruncated = false;
  const counts: Record<string, number> = {};
  let total = 0;
  const accept = (candidate: MapFeature): void => {
    try {
      const feature = canonicalFeature(candidate);
      counts[feature.kind] = (counts[feature.kind] ?? 0) + 1;
      total += 1;
      writer.push(feature);
      emit?.(feature);
    } catch (error) {
      if (candidate.kind === "boundary") throw error;
      if (invalidFeatures.length < INVALID_ISSUE_LIMIT) {
        invalidFeatures.push({ stableId: candidate.stableId, kind: candidate.kind, error: error instanceof Error ? error.message : String(error) });
      } else {
        invalidTruncated = true;
      }
    }
  };

  accept(boundary);

  for (const feature of osmResult.features) accept(feature);
  logPhase(`osm overpass ${osmResult.features.length}`, rss);

  const bdtopoBoundaryRings = boundaries.map((polygon) => polygon.coordinates);
  const chefLieuAnchors = new Map<string, Coordinate>();
  for (const filePath of sources.bdtopoFiles.filter((file) => path.basename(file) === "bdtopo-settlements.geojson")) {
    const stream = streamFeatureCollection(filePath);
    try {
      let batch: Record<string, unknown>[] = [];
      for await (const feature of stream) {
        batch.push(feature);
        if (batch.length >= FEATURE_BATCH_SIZE) {
          settlementAnchors(batch, chefLieuAnchors);
          batch = [];
        }
      }
      settlementAnchors(batch, chefLieuAnchors);
    } finally {
      stream.close();
    }
  }
  logPhase(`bdtopo chef-lieu anchors ${chefLieuAnchors.size}`, rss);
  for (const filePath of sources.bdtopoFiles) {
    const sourceLayer = path.basename(filePath);
    let produced = 0;
    let batch: Record<string, unknown>[] = [];
    const stream = streamFeatureCollection(filePath);
    try {
      for await (const feature of stream) {
        batch.push({ ...feature, sourceLayer });
        if (batch.length < FEATURE_BATCH_SIZE) continue;
        for (const item of normalizeBdtopo(batch, bdtopoBoundaryRings, { edition: bdtopoEdition, chefLieuAnchors })) accept(item);
        produced += batch.length;
        batch = [];
      }
    } finally {
      stream.close();
    }
    if (batch.length > 0) {
      for (const item of normalizeBdtopo(batch, bdtopoBoundaryRings, { edition: bdtopoEdition, chefLieuAnchors })) accept(item);
      produced += batch.length;
    }
    logPhase(`bdtopo ${sourceLayer} ${produced}`, rss);
  }

  const heldOsmPois: PoiFeature[] = [];
  const extractObjectIds = sources.osmExtractFile === null ? null : await collectOsmObjectIds(sources.osmExtractFile);
  if (sources.osmBulkFile !== null) {
    const bulk = streamOsmBulk(sources.osmBulkFile, { polygons: boundaries, index: boundaryIndex });
    for await (const feature of bulk) {
      if (extractObjectIds !== null && canonicalOsmObjectIds(feature.sourceId).some((id) => extractObjectIds.has(id))) continue;
      /* Named OSM places wait for the SIRENE pass so a shop known to both is merged, not doubled. */
      if (feature.kind === "poi" && feature.name !== undefined) {
        heldOsmPois.push(feature);
        continue;
      }
      accept(feature);
    }
    await fs.writeFile(path.join(destinationDir, "osm-normalization.json"), normalizeOsmBulkReport(bulk.report), "utf8");
    logPhase(`osm bulk kept ${bulk.report.keptTotal} dropped ${bulk.report.droppedTotal}`, rss);
  }

  if (sources.osmExtractFile !== null) {
    const extract = streamOsmBulk(sources.osmExtractFile, { polygons: boundaries, index: boundaryIndex }, AUCH_OSM_CONFIG);
    for await (const feature of extract) accept(feature);
    logPhase(`osm extract kept ${extract.report.keptTotal}`, rss);
  }

  await normalizeAddressesInto({ file: sources.addressFile, license: sources.addressLicense }, boundary, accept as (feature: AddressFeature) => void);
  logPhase("addresses", rss);

  const conflated = conflateBusinesses(heldOsmPois, await normalizeBusinesses({ file: sources.businessFile, header: sources.businessHeader, osm: sources.businessesOsm, web: sources.businessesWeb }, boundary));
  for (const feature of conflated.pois) accept(feature);
  for (const feature of conflated.businesses) accept(feature);
  heldOsmPois.length = 0;
  logPhase(`businesses ${conflated.businesses.length}, merged with OSM ${conflated.merged}, OSM-only places ${conflated.pois.length}`, rss);

  for (const feature of normalizeIgn(sources.ign, boundary)) accept(feature);

  writer.close();
  await fs.writeFile(path.join(destinationDir, "normalization-issues.json"), `${JSON.stringify(invalidFeatures, null, 2)}\n`, "utf8");
  if (invalidTruncated) console.error(`[normalize] normalization-issues.json truncated at ${INVALID_ISSUE_LIMIT} entries`);
  logPhase("features written", rss);
  await writeNormalizedFeatures(destinationDir, writer);
  logPhase("provenance written", rss);
  console.error(`[normalize] Wrote ${total} canonical features to ${destinationDir}`);
  for (const [kind, count] of Object.entries(counts).sort(([first], [second]) => first.localeCompare(second))) console.error(`[normalize] ${kind}: ${count}`);
  return { total, byKind: counts };
}

if (process.argv[1]?.endsWith("normalize.ts")) {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  normalizeAll(options.rawDir, options.outDir).then((counts) => {
    console.error(`[normalize] wall=${((Date.now() - started) / 1000).toFixed(1)}s peakRss=${megabytes(rssBytes())}`);
    return counts;
  }).catch((error: unknown) => {
    console.error("[normalize] Fatal:", error);
    process.exit(1);
  });
}
