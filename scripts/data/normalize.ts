#!/usr/bin/env tsx
/**
 * normalize.ts — Converts raw source records to typed discriminated unions,
 * clips geometry to the commune boundary polygon, derives local coordinates,
 * and records every transformation.
 *
 * Reads files produced by the fetch-* siblings and writes per-kind JSON
 * files to the intermediate directory for the deduplication and tiling
 * stages.
 *
 * Usage: tsx scripts/data/normalize.ts [--raw-dir <path>] [--out-dir <path>]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  clipLineStringToPolygon,
  clipPolygonToPolygon,
  type PolygonGeometry,
} from "../../src/lib/geo/polygon";
import {
  deduplicateOsmElements,
  isOsmElement,
  reconstructMultipolygonRelation,
  type OsmElement,
  type OsmRelationElement,
  type OsmWayElement,
  type RelationIssue,
} from "./osmRelations";

// ---------------------------------------------------------------------------
// Type stubs — matches schema contracts from the plan §4
// ---------------------------------------------------------------------------

interface SourceReference {
  source: string;
  url?: string;
  timestamp: string;
  license?: string;
  sha256?: string;
  recordCount?: number;
}

interface ProvenanceRecord {
  featureId: string;
  property: string;
  winner: string;
  contenders: string[];
  priority: number;
  timestamp: string;
}

type FeatureKind =
  | "boundary" | "building" | "road" | "water" | "landuse"
  | "poi" | "business" | "address" | "transport";

interface MapFeatureBase {
  kind: FeatureKind;
  stableId: string;
  sourceId?: string;
  name?: string;
  address?: string;
  /** WGS84 longitude */
  lon: number;
  /** WGS84 latitude */
  lat: number;
  /** Local easting (x) in metres */
  x: number;
  /** Local northing (z) in metres */
  z: number;
  /** Original WGS84 geometry as GeoJSON-like object */
  geometry?: Record<string, unknown>;
  /** Local coordinate geometry */
  localGeometry?: Record<string, unknown>;
  provenance: ProvenanceRecord[];
  confidence: number;
  status: "active" | "uncertain" | "inferred" | "unresolved";
  sourceRefs: SourceReference[];
}

interface BoundaryFeature extends MapFeatureBase {
  kind: "boundary";
  rings: number[][][];
  centroidX: number;
  centroidZ: number;
}

interface BuildingFeature extends MapFeatureBase {
  kind: "building";
  height?: number;
  heightInferred?: boolean;
  levels?: number;
  buildingType?: string;
}

interface RoadFeature extends MapFeatureBase {
  kind: "road";
  roadClass: string;
  width: number;
  widthInferred?: boolean;
  surface?: string;
  oneway?: boolean;
  bridge?: boolean;
  tunnel?: boolean;
}

interface WaterFeature extends MapFeatureBase {
  kind: "water";
  waterType: string;
  width?: number;
  widthInferred?: boolean;
}

interface LanduseFeature extends MapFeatureBase {
  kind: "landuse";
  landuseType: string;
}

interface PoiFeature extends MapFeatureBase {
  kind: "poi";
  poiType: string;
  category?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  operator?: string;
  wheelchair?: string;
}

interface BusinessFeature extends MapFeatureBase {
  kind: "business";
  businessId?: string;
  siren?: string;
  siret?: string;
  brand?: string;
  businessName: string;
  legalName?: string;
  category?: string;
  nafCode?: string;
  nafLabel?: string;
  website?: string;
  phone?: string;
  openingHours?: string;
  operator?: string;
  wheelchair?: string;
  administrativeStatus?: string;
  creationDate?: string;
}

interface AddressFeature extends MapFeatureBase {
  kind: "address";
  banId: string;
  housenumber: string;
  street: string;
  postcode: string;
  city: string;
}

interface TransportFeature extends MapFeatureBase {
  kind: "transport";
  transportType: string;
  route?: string;
  operator?: string;
}

type MapFeature =
  | BoundaryFeature | BuildingFeature | RoadFeature | WaterFeature
  | LanduseFeature | PoiFeature | BusinessFeature | AddressFeature | TransportFeature;

// ---------------------------------------------------------------------------
// Projection — local spherical equirectangular (matches src/lib/geo/projection)
// ---------------------------------------------------------------------------

const METERS_PER_DEGREE = 111_319.9;
/** Origin chosen as approximate Auch centre (finely from boundary centroid). */
const PROJECTION_ORIGIN: [number, number] = [0.566553, 43.66256];
const COS_ORIGIN_LAT = Math.cos(PROJECTION_ORIGIN[1] * Math.PI / 180);

function forward(lon: number, lat: number): [number, number] {
  const dLng = lon - PROJECTION_ORIGIN[0];
  const dLat = lat - PROJECTION_ORIGIN[1];
  return [dLng * METERS_PER_DEGREE * COS_ORIGIN_LAT, dLat * METERS_PER_DEGREE];
}

// ---------------------------------------------------------------------------
// Point-in-polygon (ray casting, WGS84)
// ---------------------------------------------------------------------------

function pointInRing(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[i][0], ay = ring[i][1];
    const bx = ring[j][0], by = ring[j][1];
    if ((ay > py) !== (by > py) &&
        px < ((bx - ax) * (py - ay)) / (by - ay) + ax) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(px: number, py: number, rings: number[][][]): boolean {
  if (!rings.length || !rings[0].length) return false;
  if (!pointInRing(px, py, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(px, py, rings[i])) return false;
  }
  return true;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dataRoot(): string {
  return process.env.MASTER_MAPS_DATA_DIR ?? "data";
}

interface NormalizeOptions {
  rawDir: string;
  outDir: string;
}

function parseArgs(args: string[]): NormalizeOptions {
  const root = dataRoot();
  let rawDir = path.join(root, "raw");
  let outDir = path.join(root, "intermediate");
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw-dir" && args[i + 1]) {
      rawDir = args[++i];
    } else if (a === "--out-dir" && args[i + 1]) {
      outDir = args[++i];
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: tsx scripts/data/normalize.ts [--raw-dir <path>] [--out-dir <path>]");
      process.exit(0);
    }
  }
  return { rawDir, outDir };
}

function buildStableId(
  kind: FeatureKind,
  name: string,
  address: string,
  lon: number,
  lat: number,
  geometryHash: string,
): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const payload = `${kind}:${norm(name)}:${norm(address)}:${lon.toFixed(5)},${lat.toFixed(5)}:${geometryHash}`;
  let hash = 0;
  for (let i = 0; i < payload.length; i++) {
    hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
  }
  return `hash:${Math.abs(hash).toString(16).padStart(8, "0")}`;
}

function coordHash(coords: unknown[], len: number): string {
  const end = Math.min(len, 20);
  let h = 0;
  for (let i = 0; i < end; i++) {
    const c = coords[i] as number[];
    if (c && c.length >= 2) {
      h = ((h << 5) - h + ~~(c[0] * 1e5)) | 0;
      h = ((h << 5) - h + ~~(c[1] * 1e5)) | 0;
    }
  }
  return Math.abs(h).toString(16).padStart(4, "0");
}

function inferHeight(tags: Record<string, string>): { height: number; inferred: boolean } | null {
  const explicit = tags["height"];
  if (explicit) {
    const h = parseFloat(explicit);
    if (isFinite(h) && h >= 0) return { height: h, inferred: false };
  }
  const levels = tags["building:levels"];
  if (levels) {
    const l = parseInt(levels, 10);
    if (isFinite(l) && l > 0) return { height: l * 3.0, inferred: true };
  }
  return null;
}

function categoryDefaultHeight(category: string): number {
  const map: Record<string, number> = {
    house: 3.5, apartments: 6.0, garage: 2.7, shed: 2.7,
    retail: 5.0, commercial: 5.0, industrial: 6.0,
    warehouse: 6.0, church: 12.0,
  };
  return map[category] ?? 3.5;
}

function defaultRoadWidth(roadClass: string): number {
  const map: Record<string, number> = {
    motorway: 12.0, trunk: 9.0, primary: 9.0,
    secondary: 7.0, tertiary: 6.0, residential: 5.0,
    service: 3.5, pedestrian: 2.0, footway: 2.0,
    cycleway: 2.0, path: 1.5, track: 2.5,
  };
  return map[roadClass] ?? 5.0;
}

function computePolygonCentroid(rings: number[][][]): [number, number] {
  const ring = rings[0];
  if (!ring || ring.length < 3) return [0, 0];
  let cx = 0, cy = 0, area = 0;
  const n = ring.length - 1;
  for (let i = 0; i < n; i++) {
    const x0 = ring[i][0], y0 = ring[i][1];
    const x1 = ring[i + 1][0], y1 = ring[i + 1][1];
    const a = x0 * y1 - x1 * y0;
    area += a;
    cx += (x0 + x1) * a;
    cy += (y0 + y1) * a;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) return [ring[0][0], ring[0][1]];
  cx /= (6 * area);
  cy /= (6 * area);
  return [cx, cy];
}

// ---------------------------------------------------------------------------
// Raw-source loaders
// ---------------------------------------------------------------------------

async function loadRawSources(rawDir: string) {
  const readOpt = { encoding: "utf8" as const };

  let boundaryRaw: string;
  try {
    boundaryRaw = await fs.readFile(path.join(rawDir, "auch-boundary.geojson"), readOpt);
  } catch {
    boundaryRaw = '{"type":"FeatureCollection","features":[]}';
  }

  let osmRaw: string;
  try {
    osmRaw = await fs.readFile(path.join(rawDir, "osm.json"), readOpt);
  } catch {
    osmRaw = '{"elements":[],"timestamp":"","query":""}';
  }

  let addrRaw: string;
  try {
    addrRaw = await fs.readFile(path.join(rawDir, "ban-addresses.json"), readOpt);
  } catch {
    addrRaw = '{"addresses":[],"license":"etalab-2.0"}';
  }

  let bizSireneRaw: string;
  try {
    bizSireneRaw = await fs.readFile(path.join(rawDir, "businesses-sirene.json"), readOpt);
  } catch {
    bizSireneRaw = '{"records":[]}';
  }
  let bizOsmRaw: string;
  try {
    bizOsmRaw = await fs.readFile(path.join(rawDir, "businesses-osm.json"), readOpt);
  } catch {
    bizOsmRaw = '{"status":"missing","body":null}';
  }

  let bizWebRaw: string;
  try {
    bizWebRaw = await fs.readFile(path.join(rawDir, "businesses-web.json"), readOpt);
  } catch {
    bizWebRaw = '{"results":[]}';
  }

  let ignFeatures: Record<string, unknown>[] = [];
  let ignUnavailable = true;
  try {
    const dir = await fs.readdir(rawDir, { withFileTypes: true });
    for (const entry of dir) {
      if (entry.isFile() && /^ign-[^/]+\.json$/.test(entry.name) && entry.name !== "ign-capabilities.json") {
        const content = await fs.readFile(path.join(rawDir, entry.name), readOpt);
        const parsed = JSON.parse(content) as { features?: Record<string, unknown>[]; type?: string };
        if (Array.isArray(parsed.features)) {
          for (const f of parsed.features) {
            if (f?.geometry) ignFeatures.push(f);
          }
          ignUnavailable = false;
        } else if (parsed.type === "FeatureCollection" && Array.isArray(parsed.features)) {
          for (const f of parsed.features as Record<string, unknown>[]) {
            if (f?.geometry) ignFeatures.push(f);
          }
          ignUnavailable = false;
        }
      }
    }
    try {
      const intermediateDir = path.join(dataRoot(), "intermediate");
      const unavailContent = await fs.readFile(path.join(intermediateDir, "ign-unavailable.json"), readOpt);
      const unavail = JSON.parse(unavailContent) as { reason?: string };
      if (unavail.reason) {
        ignUnavailable = true;
        ignFeatures = [];
      }
    } catch { /* no marker */ }
  } catch { /* ign dir unreadable */ }

  return {
    boundary: JSON.parse(boundaryRaw) as Record<string, unknown>,
    osm: JSON.parse(osmRaw) as { elements: Record<string, unknown>[]; timestamp: string; query: string },
    addresses: JSON.parse(addrRaw) as { addresses?: Record<string, unknown>[]; license?: string },
    businesses: JSON.parse(bizSireneRaw) as { records?: Record<string, unknown>[] },
    businessesOsm: JSON.parse(bizOsmRaw) as { status?: string; body?: unknown },
    businessesWeb: JSON.parse(bizWebRaw) as { results?: Record<string, unknown>[] },
    ign: { features: ignFeatures, unavailable: ignUnavailable },
  };
}

// ---------------------------------------------------------------------------
// Normalisation per source family
// ---------------------------------------------------------------------------

function normalizeBoundary(raw: Record<string, unknown>): BoundaryFeature {
  const fc = raw as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }> };
  const feature = fc.features?.[0];
  if (!feature?.geometry) throw new Error("normalizeBoundary: no valid geometry in boundary GeoJSON");

  let rings: number[][][];
  const geom = feature.geometry;
  if (geom.type === "Polygon") {
    rings = geom.coordinates as number[][][];
  } else if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates as number[][][][];
    rings = polys.reduce((a, b) => (b[0]?.length ?? 0) > (a[0]?.length ?? 0) ? b : a, polys[0] ?? []);
  } else {
    throw new Error(`normalizeBoundary: unsupported geometry type: ${geom.type}`);
  }

  const centroid = computePolygonCentroid(rings);
  const [cx, cy] = centroid;
  const [lx, lz] = forward(cx, cy);
  const now = new Date().toISOString();
  const sourceRefs: SourceReference[] = [
    { source: "geo.api.gouv.fr", timestamp: now, license: "etalab-2.0" },
  ];

  return {
    kind: "boundary",
    stableId: "boundary:auch-32013",
    lon: cx,
    lat: cy,
    x: lx,
    z: lz,
    rings,
    centroidX: lx,
    centroidZ: lz,
    geometry: { type: "Polygon", coordinates: rings },
    localGeometry: { type: "Polygon", coordinates: rings.map(r => r.map(p => forward(p[0], p[1]))) },
    provenance: [{
      featureId: "boundary:auch-32013",
      property: "geometry",
      winner: "geo.api.gouv.fr",
      contenders: ["geo.api.gouv.fr"],
      priority: 90,
      timestamp: now,
    }],
    confidence: 1.0,
    status: "active",
    sourceRefs,
  };
}

export interface OsmNormalizationResult {
  features: MapFeature[];
  relationIssues: RelationIssue[];
}

type OsmNormalizedGeometry =
  | { type: "Point"; coordinates: [number, number] }
  | { type: "LineString"; coordinates: [number, number][] }
  | { type: "MultiLineString"; coordinates: [number, number][][] }
  | { type: "Polygon"; coordinates: [number, number][][] }
  | { type: "MultiPolygon"; coordinates: [number, number][][][] };

interface OsmTagClassification {
  kind: FeatureKind;
  poiType?: string;
  roadClass?: string;
  waterType?: string;
  landuseType?: string;
  transportType?: string;
}

export function normalizeOsmWithReport(
  raw: { elements: Record<string, unknown>[]; timestamp: string; query: string },
  boundary: BoundaryFeature,
): OsmNormalizationResult {
  const boundaryRings = boundary.rings as [number, number][][];
  const boundaryPolygon: PolygonGeometry = {
    type: "Polygon",
    coordinates: boundaryRings,
  };
  const now = new Date().toISOString();
  const elements = deduplicateOsmElements(raw.elements.filter(isOsmElement));
  const features: MapFeature[] = [];
  const relationIssues: RelationIssue[] = [];
  const nodeCoords = new Map<number, [number, number]>();
  const ways = new Map<number, OsmWayElement>();
  const relations: OsmRelationElement[] = [];

  for (const element of elements) {
    if (element.type === "node") {
      nodeCoords.set(element.id, [element.lon, element.lat]);
    } else if (element.type === "way") {
      ways.set(element.id, element);
    } else {
      relations.push(element);
    }
  }

  const classifyTags = (tags: Record<string, string>): OsmTagClassification | null => {
    if (tags.building) return { kind: "building" };
    if (
      tags.waterway
      || tags.natural === "water"
      || tags.natural === "wetland"
      || tags.landuse === "reservoir"
    ) {
      return {
        kind: "water",
        waterType: tags.waterway ?? (tags.natural === "water" ? "water" : tags.natural ?? "reservoir"),
      };
    }
    if (tags.landuse) return { kind: "landuse", landuseType: tags.landuse };
    if (tags.leisure) return { kind: "landuse", landuseType: tags.leisure };
    if (tags.highway) return { kind: "road", roadClass: tags.highway };
    if (tags.railway || tags.public_transport) {
      return {
        kind: "transport",
        transportType: tags.railway ?? tags.public_transport ?? "other",
      };
    }
    const poiType =
      tags.shop
      ?? tags.amenity
      ?? tags.tourism
      ?? tags.historic
      ?? tags.office
      ?? tags.craft;
    if (tags.name && poiType) {
      return { kind: "poi", poiType };
    }
    if (tags["addr:housenumber"]) return { kind: "address" };
    return null;
  };

  const localizeGeometry = (geometry: OsmNormalizedGeometry): Record<string, unknown> => {
    switch (geometry.type) {
      case "Point":
        return { type: "Point", coordinates: forward(geometry.coordinates[0], geometry.coordinates[1]) };
      case "LineString":
        return {
          type: "LineString",
          coordinates: geometry.coordinates.map(([lon, lat]) => forward(lon, lat)),
        };
      case "MultiLineString":
        return {
          type: "MultiLineString",
          coordinates: geometry.coordinates.map((line) => line.map(([lon, lat]) => forward(lon, lat))),
        };
      case "Polygon":
        return {
          type: "Polygon",
          coordinates: geometry.coordinates.map((ring) => ring.map(([lon, lat]) => forward(lon, lat))),
        };
      case "MultiPolygon":
        return {
          type: "MultiPolygon",
          coordinates: geometry.coordinates.map((polygon) =>
            polygon.map((ring) => ring.map(([lon, lat]) => forward(lon, lat)))),
        };
    }
  };

  const geometryAnchor = (geometry: OsmNormalizedGeometry): [number, number] => {
    if (geometry.type === "Point") return geometry.coordinates;
    const points: [number, number][] = [];
    const collect = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      if (
        value.length >= 2
        && typeof value[0] === "number"
        && typeof value[1] === "number"
      ) {
        points.push([value[0], value[1]]);
        return;
      }
      for (const child of value) collect(child);
    };
    collect(geometry.coordinates);
    if (points.length === 0) return [0, 0];
    let lon = 0;
    let lat = 0;
    for (const point of points) {
      lon += point[0];
      lat += point[1];
    }
    return [lon / points.length, lat / points.length];
  };

  const clipAreaGeometry = (
    geometry: Extract<OsmNormalizedGeometry, { type: "Polygon" | "MultiPolygon" }>,
  ): Extract<OsmNormalizedGeometry, { type: "Polygon" | "MultiPolygon" }> | null => {
    const polygons: [number, number][][][] = [];
    const sourcePolygons = geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates;
    for (const sourcePolygon of sourcePolygons) {
      const clipped = clipPolygonToPolygon(
        { type: "Polygon", coordinates: sourcePolygon },
        boundaryPolygon,
      );
      if (!clipped) continue;
      if (clipped.type === "Polygon") {
        polygons.push(clipped.coordinates);
      } else {
        polygons.push(...clipped.coordinates);
      }
    }
    if (polygons.length === 0) return null;
    if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
    return { type: "MultiPolygon", coordinates: polygons };
  };

  const clipLineGeometry = (
    coordinates: [number, number][],
  ): Extract<OsmNormalizedGeometry, { type: "LineString" | "MultiLineString" }> | null => {
    const clippedLines = clipLineStringToPolygon(coordinates, boundaryPolygon);
    if (clippedLines.length === 0) return null;
    if (clippedLines.length === 1) return { type: "LineString", coordinates: clippedLines[0] };
    return { type: "MultiLineString", coordinates: clippedLines };
  };

  const parseWidth = (tags: Record<string, string>): number | undefined => {
    const value = Number.parseFloat(tags.width ?? tags["water:width"] ?? "");
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };

  const addNormalizedFeature = (
    elementType: "way" | "relation",
    elementId: number,
    tags: Record<string, string>,
    classification: OsmTagClassification,
    sourceGeometry: OsmNormalizedGeometry,
  ): void => {
    const [lon, lat] = geometryAnchor(sourceGeometry);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const name = tags.name ?? "";
    const address = [
      tags["addr:housenumber"] ?? "",
      tags["addr:street"] ?? "",
      tags["addr:postcode"] ?? "",
    ].filter(Boolean).join(", ");
    const featureGeometry: OsmNormalizedGeometry =
      classification.kind === "poi"
        || classification.kind === "address"
        ? { type: "Point", coordinates: [lon, lat] }
        : sourceGeometry;
    const [x, z] = forward(lon, lat);
    const sourceId = `osm:${elementType}/${elementId}`;
    const sourceTimestamp = raw.timestamp || now;
    const base = {
      kind: classification.kind,
      stableId: sourceId,
      sourceId,
      name: name || undefined,
      address: address || undefined,
      lon,
      lat,
      x,
      z,
      geometry: featureGeometry,
      sourceGeometry: featureGeometry.type !== sourceGeometry.type ? sourceGeometry : undefined,
      localGeometry: localizeGeometry(featureGeometry),
      provenance: [{
        featureId: sourceId,
        property: "geometry",
        winner: "osm",
        contenders: ["osm"],
        priority: 60,
        timestamp: sourceTimestamp,
      }],
      confidence: 0.9,
      status: "active" as const,
      sourceRefs: [{
        source: "osm",
        url: `https://www.openstreetmap.org/${elementType}/${elementId}`,
        timestamp: sourceTimestamp,
        license: "ODbL-1.0",
      }],
    };

    if (classification.kind === "building") {
      const height = inferHeight(tags);
      features.push({
        ...base,
        kind: "building",
        height: height?.height ?? categoryDefaultHeight(tags.building ?? "house"),
        heightInferred: height ? height.inferred : true,
        levels: tags["building:levels"] ? Number.parseInt(tags["building:levels"], 10) : undefined,
        buildingType: tags.building || undefined,
      } as BuildingFeature);
      return;
    }
    if (classification.kind === "road") {
      const width = parseWidth(tags);
      features.push({
        ...base,
        kind: "road",
        roadClass: classification.roadClass ?? "unclassified",
        highway: classification.roadClass ?? "unclassified",
        width: width ?? defaultRoadWidth(classification.roadClass ?? "unclassified"),
        widthInferred: width === undefined,
        surface: tags.surface || undefined,
        oneway: tags.oneway === "yes",
        bridge: tags.bridge === "yes",
        tunnel: tags.tunnel === "yes",
      } as RoadFeature);
      return;
    }
    if (classification.kind === "water") {
      const width = parseWidth(tags);
      features.push({
        ...base,
        kind: "water",
        waterType: classification.waterType ?? "water",
        width,
        widthInferred: width === undefined,
      } as WaterFeature);
      return;
    }
    if (classification.kind === "landuse") {
      features.push({
        ...base,
        kind: "landuse",
        landuseType: classification.landuseType ?? "other",
      } as LanduseFeature);
      return;
    }
    if (classification.kind === "poi") {
      features.push({
        ...base,
        kind: "poi",
        poiType: classification.poiType ?? "other",
        category: tags.shop ?? tags.amenity ?? tags.tourism ?? undefined,
        website: tags.website ?? tags["contact:website"] ?? undefined,
        phone: tags.phone ?? tags["contact:phone"] ?? undefined,
        openingHours: tags.opening_hours ?? undefined,
        operator: tags.operator ?? undefined,
        wheelchair: tags.wheelchair ?? undefined,
      } as PoiFeature);
      return;
    }
    if (classification.kind === "transport") {
      features.push({
        ...base,
        kind: "transport",
        transportType: classification.transportType ?? "other",
        route: tags.route ?? undefined,
        operator: tags.operator ?? undefined,
      } as TransportFeature);
      return;
    }
    features.push({
      ...base,
      kind: "address",
      banId: sourceId,
      housenumber: tags["addr:housenumber"] ?? "",
      street: tags["addr:street"] ?? "",
      postcode: tags["addr:postcode"] ?? "",
      city: tags["addr:city"] ?? "Auch",
    } as AddressFeature);
  };

  const relationWayIds = new Set<number>();
  for (const relation of relations) {
    const tags = relation.tags ?? {};
    const classification = classifyTags(tags);
    const isAreaRelation =
      classification?.kind === "building"
      || classification?.kind === "water"
      || classification?.kind === "landuse";
    const isNamedPoiRelation =
      classification?.kind === "poi"
      && relation.members.some((member) => member.role === "outer" || member.role === "inner");
    if (!classification || (!isAreaRelation && !isNamedPoiRelation)) continue;

    const reconstructed = reconstructMultipolygonRelation(relation, ways, nodeCoords);
    if ("reason" in reconstructed) {
      relationIssues.push(reconstructed);
      continue;
    }
    const clipped = clipAreaGeometry(reconstructed.geometry);
    if (!clipped) continue;
    addNormalizedFeature("relation", relation.id, tags, classification, clipped);
    if (isAreaRelation) {
      for (const wayId of reconstructed.memberWayIds) relationWayIds.add(wayId);
    }

  }
  const resolveWayNodes = (way: OsmWayElement): [number, number][] | null => {
    const coordinates: [number, number][] = [];
    for (const nodeId of way.nodes) {
      const coordinate = nodeCoords.get(nodeId);
      if (!coordinate) return null;
      coordinates.push(coordinate);
    }
    return coordinates.length >= 2 ? coordinates : null;
  };

  for (const element of elements) {
    if (element.type === "relation") continue;
    const tags = element.tags ?? {};
    const classification = classifyTags(tags);
    if (!classification) continue;

    let coordinates: [number, number][];
    if (element.type === "node") {
      coordinates = [[element.lon, element.lat]];
    } else {
      if (
        relationWayIds.has(element.id)
        && (classification.kind === "building"
          || classification.kind === "water"
          || classification.kind === "landuse")
      ) {
        continue;
      }
      const resolved = resolveWayNodes(element);
      if (!resolved) continue;
      coordinates = resolved;
    }

    let geometry: OsmNormalizedGeometry | null = null;
    if (coordinates.length === 1) {
      const point = coordinates[0];
      if (!pointInPolygon(point[0], point[1], boundary.rings)) continue;
      geometry = { type: "Point", coordinates: point };
    } else {
      const first = coordinates[0];
      const last = coordinates[coordinates.length - 1];
      const isClosed = first[0] === last[0] && first[1] === last[1];
      if (
        isClosed
        && (classification.kind === "building"
          || classification.kind === "water"
          || classification.kind === "landuse")
      ) {
        geometry = clipAreaGeometry({ type: "Polygon", coordinates: [coordinates] });
      } else if (
        classification.kind === "road"
        || classification.kind === "water"
        || classification.kind === "transport"
      ) {
        geometry = clipLineGeometry(coordinates);
      } else {
        const anchor = geometryAnchor({ type: "LineString", coordinates });
        if (!pointInPolygon(anchor[0], anchor[1], boundary.rings)) continue;
        geometry = { type: "Point", coordinates: anchor };
      }
    }
    if (geometry) addNormalizedFeature(element.type, element.id, tags, classification, geometry);
  }

  return { features, relationIssues };
}

export function normalizeOsm(
  raw: { elements: Record<string, unknown>[]; timestamp: string; query: string },
  boundary: BoundaryFeature,
): MapFeature[] {
  return normalizeOsmWithReport(raw, boundary).features;
}

function normalizeAddresses(
  raw: { addresses?: Record<string, unknown>[]; license?: string },
  boundary: BoundaryFeature,
): AddressFeature[] {
  if (!raw.addresses?.length) return [];
  const boundaryRings = boundary.rings;
  const now = new Date().toISOString();
  const features: AddressFeature[] = [];

  for (const r of raw.addresses) {
    const lon = r.lon as number;
    const lat = r.lat as number;
    if (!isFinite(lon) || !isFinite(lat)) continue;
    if (!pointInPolygon(lon, lat, boundaryRings)) continue;

    const [lx, lz] = forward(lon, lat);
    const housenumber = String(r.numero ?? "");
    const street = String(r.streetName ?? r.street ?? "");
    const postcode = String(r.postalCode ?? "");
    const city = String(r.city ?? "Auch");
    const banId = String(r.banId ?? "");
    const name = [housenumber, street].filter(Boolean).join(" ");
    const geomHash = coordHash([[lon, lat]], 1);
    const stableId = buildStableId("address", name, `${street} ${postcode}`, lon, lat, geomHash);

    features.push({
      kind: "address",
      stableId,
      banId,
      housenumber,
      street,
      postcode,
      city,
      name: name || undefined,
      lon,
      lat,
      x: lx,
      z: lz,
      geometry: { type: "Point", coordinates: [lon, lat] },
      localGeometry: { type: "Point", coordinates: [lx, lz] },
      provenance: [{
        featureId: stableId,
        property: "geometry",
        winner: "ban",
        contenders: ["ban"],
        priority: 70,
        timestamp: now,
      }],
      confidence: 0.95,
      status: "active",
      sourceRefs: [{ source: "ban", timestamp: now, license: raw.license ?? "etalab-2.0" }],
    });
  }

  return features;
}

export function normalizeBusinesses(
  raw: {
    records?: Record<string, unknown>[];
    sourceUrl?: string;
    license?: string;
    acquiredAt?: string;
  },
  boundary: BoundaryFeature,
  osmRaw: { status?: string; body?: unknown },
  webRaw: { results?: Record<string, unknown>[] },
): BusinessFeature[] {
  const boundaryRings = boundary.rings;
  const now = new Date().toISOString();
  const features: BusinessFeature[] = [];
  const propertySources = new Map<string, Map<string, string>>();

  const cleanString = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const normalizedName = (value: string): string =>
    value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  const coordinateFrom = (value: unknown): [number, number] | null => {
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const lon = typeof record.lon === "number" ? record.lon : null;
    const lat = typeof record.lat === "number" ? record.lat : null;
    return lon !== null && lat !== null && Number.isFinite(lon) && Number.isFinite(lat)
      ? [lon, lat]
      : null;
  };

  const sourcePriority = (source: string): number => {
    if (source === "official-website") return 90;
    if (source === "sirene") return 80;
    if (source === "annuaire-entreprises") return 75;
    if (source === "osm") return 60;
    if (source === "pagesjaunes") return 40;
    return 50;
  };

  const sourceReference = (
    source: string,
    url: string | undefined,
    timestamp: string,
    license: string | undefined,
  ): SourceReference => ({
    source,
    url,
    timestamp,
    license,
  });

  const addSourceReference = (feature: BusinessFeature, reference: SourceReference): void => {
    if (
      !feature.sourceRefs.some((existing) =>
        existing.source === reference.source && existing.url === reference.url)
    ) {
      feature.sourceRefs.push(reference);
    }
  };

  const addPropertySource = (feature: BusinessFeature, property: string, source: string): void => {
    const sources = propertySources.get(feature.stableId) ?? new Map<string, string>();
    sources.set(property, source);
    propertySources.set(feature.stableId, sources);
  };

  const mergeField = (
    feature: BusinessFeature,
    property: keyof BusinessFeature,
    value: string | undefined,
    source: string,
    timestamp: string,
  ): void => {
    if (!value) return;
    const key = String(property);
    const current = feature[property];
    const currentSource = propertySources.get(feature.stableId)?.get(key) ?? "unknown";
    if (current === undefined || current === null || current === "") {
      (feature as Record<string, unknown>)[key] = value;
      addPropertySource(feature, key, source);
      return;
    }
    if (current === value) return;
    if (sourcePriority(source) <= sourcePriority(currentSource)) return;
    (feature as Record<string, unknown>)[key] = value;
    addPropertySource(feature, key, source);
    feature.provenance.push({
      featureId: feature.stableId,
      property: key,
      winner: `${source}=${value}`,
      contenders: [`${currentSource}=${String(current)}`, `${source}=${value}`],
      priority: sourcePriority(source),
      timestamp,
    });
  };

  const insideBoundary = (lon: number, lat: number): boolean =>
    pointInPolygon(lon, lat, boundaryRings);

  const distanceMetres = (
    first: [number, number],
    second: [number, number],
  ): number => {
    const dx = (first[0] - second[0]) * 111_319.9 * Math.cos(43.65 * Math.PI / 180);
    const dz = (first[1] - second[1]) * 111_319.9;
    return Math.sqrt(dx * dx + dz * dz);
  };

  const findMatch = (candidate: BusinessFeature): BusinessFeature | undefined => {
    const candidateName = normalizedName(candidate.businessName);
    return features.find((feature) => {
      if (candidate.siret && feature.siret && candidate.siret === feature.siret) return true;
      if (candidateName && candidateName === normalizedName(feature.businessName)) {
        return distanceMetres([candidate.lon, candidate.lat], [feature.lon, feature.lat]) <= 150;
      }
      return false;
    });
  };

  const mergeCandidate = (candidate: BusinessFeature): void => {
    const match = findMatch(candidate);
    if (!match) {
      features.push(candidate);
      const sources = new Map<string, string>();
      for (const property of [
        "businessName", "legalName", "brand", "category", "nafCode", "nafLabel",
        "address", "website", "phone", "openingHours", "operator", "wheelchair",
      ]) {
        if ((candidate as Record<string, unknown>)[property] !== undefined) {
          sources.set(property, candidate.sourceRefs[0]?.source ?? "unknown");
        }
      }
      propertySources.set(candidate.stableId, sources);
      return;
    }

    const incomingSource = candidate.sourceRefs[0]?.source ?? "unknown";
    addSourceReference(match, candidate.sourceRefs[0]);
    for (const property of [
      "address", "brand", "category", "nafCode", "nafLabel", "website",
      "phone", "openingHours", "operator", "wheelchair",
    ] as Array<keyof BusinessFeature>) {
      mergeField(
        match,
        property,
        candidate[property] as string | undefined,
        incomingSource,
        candidate.sourceRefs[0]?.timestamp ?? now,
      );
    }
  };

  for (const record of raw.records ?? []) {
    const coordinate = coordinateFrom(record.coordinate);
    const businessName = cleanString(record.tradingName) ?? cleanString(record.legalName);
    if (!coordinate || !businessName || !insideBoundary(coordinate[0], coordinate[1])) continue;

    const [lon, lat] = coordinate;
    const siret = cleanString(record.siret);
    const siren = cleanString(record.siren);
    const legalName = cleanString(record.legalName);
    const tradingName = cleanString(record.tradingName);
    const address = cleanString(record.address);
    const nafCode = cleanString(record.nafCode);
    const nafLabel = cleanString(record.nafLabel);
    const [x, z] = forward(lon, lat);
    const stableId = siret
      ? `business:siret/${siret}`
      : buildStableId("business", businessName, address ?? "", lon, lat, coordHash([[lon, lat]], 1));
    const timestamp = cleanString(record.acquiredAt) ?? raw.acquiredAt ?? now;
    const feature: BusinessFeature = {
      kind: "business",
      stableId,
      businessId: siret,
      siren,
      siret,
      brand: tradingName,
      businessName,
      legalName,
      category: nafLabel,
      nafCode,
      nafLabel,
      name: businessName,
      address,
      lon,
      lat,
      x,
      z,
      geometry: { type: "Point", coordinates: [lon, lat] },
      localGeometry: { type: "Point", coordinates: [x, z] },
      provenance: [{
        featureId: stableId,
        property: "identity",
        winner: "sirene",
        contenders: ["sirene"],
        priority: 80,
        timestamp,
      }],
      confidence: 0.95,
      status: record.administrativeStatus === "A" || !record.administrativeStatus
        ? "active"
        : "uncertain",
      sourceRefs: [
        sourceReference(
          "sirene",
          raw.sourceUrl ?? "https://recherche-entreprises.api.gouv.fr",
          timestamp,
          raw.license ?? "Licence Ouverte / Open Licence 2.0",
        ),
      ],
      administrativeStatus: cleanString(record.administrativeStatus),
      creationDate: cleanString(record.creationDate),
    };
    mergeCandidate(feature);
  }

  const osmBody = osmRaw.body;
  const osmElements =
    typeof osmBody === "object"
    && osmBody !== null
    && Array.isArray((osmBody as Record<string, unknown>).elements)
      ? (osmBody as { elements: Record<string, unknown>[] }).elements
      : [];
  for (const element of osmElements) {
    const tags = element.tags as Record<string, string> | undefined;
    const businessName = cleanString(tags?.name);
    if (!businessName) continue;
    const coordinate =
      element.type === "node"
        ? coordinateFrom(element)
        : coordinateFrom(element.center);
    if (!coordinate || !insideBoundary(coordinate[0], coordinate[1])) continue;
    const [lon, lat] = coordinate;
    const [x, z] = forward(lon, lat);
    const elementType = cleanString(element.type) ?? "element";
    const elementId = typeof element.id === "number" ? element.id : 0;
    const timestamp = now;
    const feature: BusinessFeature = {
      kind: "business",
      stableId: `business:${elementType}/${elementId}`,
      businessId: undefined,
      businessName,
      name: businessName,
      brand: cleanString(tags?.brand),
      category: cleanString(tags?.shop) ?? cleanString(tags?.office) ?? cleanString(tags?.craft) ?? cleanString(tags?.amenity),
      address: [
        cleanString(tags?.["addr:housenumber"]),
        cleanString(tags?.["addr:street"]),
        cleanString(tags?.["addr:postcode"]),
      ].filter((value): value is string => value !== undefined).join(", ") || undefined,
      phone: cleanString(tags?.phone) ?? cleanString(tags?.["contact:phone"]),
      website: cleanString(tags?.website) ?? cleanString(tags?.["contact:website"]),
      openingHours: cleanString(tags?.opening_hours),
      operator: cleanString(tags?.operator),
      wheelchair: cleanString(tags?.wheelchair),
      lon,
      lat,
      x,
      z,
      geometry: { type: "Point", coordinates: [lon, lat] },
      localGeometry: { type: "Point", coordinates: [x, z] },
      provenance: [{
        featureId: `business:${elementType}/${elementId}`,
        property: "identity",
        winner: "osm",
        contenders: ["osm"],
        priority: 60,
        timestamp,
      }],
      confidence: 0.85,
      status: "active",
      sourceRefs: [
        sourceReference(
          "osm",
          `https://www.openstreetmap.org/${elementType}/${elementId}`,
          timestamp,
          "ODbL-1.0",
        ),
      ],
    };
    mergeCandidate(feature);
  }

  for (const result of webRaw.results ?? []) {
    if (result.status !== "ok") continue;
    const sourceId = cleanString(result.sourceId) ?? "web:business";
    const businessName = cleanString(result.name) ?? cleanString(result.title);
    if (!businessName) continue;
    const coordinate = coordinateFrom(result.coordinate);
    const match = features.find((feature) =>
      normalizedName(feature.businessName) === normalizedName(businessName)
      && (!coordinate || distanceMetres([feature.lon, feature.lat], coordinate) <= 150));
    if (!match) continue;
    const source = sourceId.includes("pagesjaunes") ? "pagesjaunes" : "official-website";
    const timestamp = cleanString(result.acquiredAt) ?? now;
    const url = cleanString(result.url);
    addSourceReference(match, sourceReference(source, url, timestamp, undefined));
    mergeField(match, "address", cleanString(result.address), source, timestamp);
    mergeField(match, "phone", cleanString(result.phone), source, timestamp);
    if (source === "official-website" && url) {
      mergeField(match, "website", url, source, timestamp);
    }
  }

  return features;
}

function normalizeIgn(
  raw: { features: Record<string, unknown>[]; unavailable: boolean },
  boundary: BoundaryFeature,
): MapFeature[] {
  if (raw.unavailable || !raw.features?.length) return [];
  const features: MapFeature[] = [];
  const now = new Date().toISOString();
  const boundaryRings = boundary.rings;

  for (const f of raw.features) {
    const geom = f.geometry as { type?: string; coordinates?: unknown } | undefined;
    const props = f.properties as Record<string, unknown> ?? {};
    if (!geom?.type) continue;

    let coords: [number, number][] = [];
    let lon = 0, lat = 0;

    if (geom.type === "Point") {
      const c = geom.coordinates as number[];
      if (c.length >= 2 && isFinite(c[0]) && isFinite(c[1])) {
        coords = [[c[0], c[1]]];
        lon = c[0]; lat = c[1];
      }
    } else if (geom.type === "Polygon") {
      const rings = geom.coordinates as number[][][];
      if (rings[0]?.length) {
        coords = rings[0];
        let sx = 0, sy = 0;
        for (const [x, y] of coords) { sx += x; sy += y; }
        lon = sx / coords.length;
        lat = sy / coords.length;
      }
    } else continue;

    if (!isFinite(lon) || !isFinite(lat)) continue;
    if (!pointInPolygon(lon, lat, boundaryRings)) continue;

    const [lx, lz] = forward(lon, lat);
    const name = String(props.name ?? "");
    const geomHash = coordHash(coords, coords.length);
    const stableId = buildStableId("building", name, "", lon, lat, geomHash);

    features.push({
      kind: "building",
      stableId,
      name: name || undefined,
      lon,
      lat,
      x: lx,
      z: lz,
      geometry: geom as Record<string, unknown>,
      localGeometry: coords.length >= 2 ? {
        type: geom.type === "Point" ? "Point" as const : "Polygon" as const,
        coordinates: geom.type === "Point" ? forward(lon, lat) : [coords.map(([x, y]) => forward(x, y))],
      } : undefined,
      provenance: [{
        featureId: stableId,
        property: "geometry",
        winner: "ign-geoplateforme",
        contenders: ["ign-geoplateforme"],
        priority: 100,
        timestamp: now,
      }],
      confidence: 0.85,
      status: "active",
      sourceRefs: [{ source: "ign-geoplateforme", timestamp: now }],
    } as BuildingFeature);
  }

  return features;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

async function writeNormalizedFeatures(features: MapFeature[], outDir: string): Promise<void> {
  const groups = new Map<string, MapFeature[]>();
  for (const f of features) {
    const list = groups.get(f.kind) ?? [];
    list.push(f);
    groups.set(f.kind, list);
  }
  for (const [kind, list] of groups) {
    await fs.writeFile(path.join(outDir, `${kind}.json`), JSON.stringify(list, null, 2), "utf8");
  }
  const allProvenance: ProvenanceRecord[] = [];
  for (const f of features) allProvenance.push(...f.provenance);
  await fs.writeFile(path.join(outDir, "provenance.json"), JSON.stringify(allProvenance, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function normalizeAll(rawDir?: string, outDir?: string): Promise<void> {
  const root = dataRoot();
  const rd = rawDir ?? path.join(root, "raw");
  const od = outDir ?? path.join(root, "intermediate");
  await fs.mkdir(od, { recursive: true });

  const sources = await loadRawSources(rd);
  const boundary = normalizeBoundary(sources.boundary);
  const osmResult = normalizeOsmWithReport(sources.osm, boundary);
  const addrFeatures = normalizeAddresses(sources.addresses, boundary);
  const bizFeatures = normalizeBusinesses(
    sources.businesses,
    boundary,
    sources.businessesOsm,
    sources.businessesWeb,
  );
  const ignFeatures = normalizeIgn(sources.ign, boundary);

  await fs.writeFile(
    path.join(od, "relation-issues.json"),
    JSON.stringify(osmResult.relationIssues, null, 2),
    "utf8",
  );
  const all: MapFeature[] = [boundary, ...osmResult.features, ...addrFeatures, ...bizFeatures, ...ignFeatures];
  await writeNormalizedFeatures(all, od);
  console.error(`[normalize] Wrote ${all.length} features to ${od}`);
  const kindCounts = new Map<string, number>();
  for (const f of all) kindCounts.set(f.kind, (kindCounts.get(f.kind) ?? 0) + 1);
  for (const [k, c] of kindCounts) console.error(`[normalize]  ${k}: ${c}`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (process.argv[1]?.endsWith("normalize.ts")) {
  const opts = parseArgs(process.argv.slice(2));
  normalizeAll(opts.rawDir, opts.outDir).catch((err) => {
    console.error("[normalize] Fatal:", err);
    process.exit(1);
  });
}