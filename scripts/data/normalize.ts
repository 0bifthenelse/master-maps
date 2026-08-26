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
}

interface LanduseFeature extends MapFeatureBase {
  kind: "landuse";
  landuseType: string;
}

interface PoiFeature extends MapFeatureBase {
  kind: "poi";
  poiType: string;
  category?: string;
}

interface BusinessFeature extends MapFeatureBase {
  kind: "business";
  businessId?: string;
  siren?: string;
  siret?: string;
  brand?: string;
  category?: string;
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

/** Simple bbox check for fast rejection. */
function likelyInsideBoundary(lon: number, lat: number): boolean {
  return lon >= 0.47 && lon <= 0.66 && lat >= 43.60 && lat <= 43.72;
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
    provenance: [],
    confidence: 1.0,
    status: "active",
    sourceRefs,
  };
}

function normalizeOsm(
  raw: { elements: Record<string, unknown>[]; timestamp: string; query: string },
  boundary: BoundaryFeature,
): MapFeature[] {
  const boundaryRings = boundary.rings;
  const now = new Date().toISOString();
  const features: MapFeature[] = [];
  if (!raw.elements?.length) return features;

  const nodeCoords = new Map<number, [number, number]>();
  for (const el of raw.elements) {
    if (el.type === "node" && typeof el.id === "number") {
      const lon = el.lon as number;
      const lat = el.lat as number;
      if (isFinite(lon) && isFinite(lat)) {
        nodeCoords.set(el.id, [lon, lat]);
      }
    }
  }

  function resolveWayNodes(el: Record<string, unknown>): [number, number][] | null {
    const nodes = el.nodes as number[] | undefined;
    if (!nodes?.length) return null;
    const coords: [number, number][] = [];
    for (const id of nodes) {
      const c = nodeCoords.get(id);
      if (c) coords.push(c);
      else return null;
    }
    return coords.length >= 2 ? coords : null;
  }

  for (const el of raw.elements) {
    const tags = (el.tags ?? {}) as Record<string, string>;
    const elType = el.type as string;
    const elId = el.id as number;
    const sourceId = `osm:${elType}/${elId}`;

    const hasMeaningfulTag = Object.keys(tags).length > 0 && (
      tags.building || tags.highway || tags.waterway ||
      tags.landuse || tags.shop || tags.amenity ||
      tags.tourism || tags.historic || tags.office ||
      tags.craft || tags.railway || tags.public_transport ||
      tags["addr:housenumber"] || tags.natural === "water" ||
      tags.natural === "wetland" || tags.leisure
    );
    if (!hasMeaningfulTag) continue;

    let kind: FeatureKind | null = null;
    let poiType: string | undefined;
    let roadClass: string | undefined;
    let waterType: string | undefined;
    let landuseType: string | undefined;
    let transportType: string | undefined;

    const poiKey = tags.shop || tags.amenity || tags.tourism || tags.historic || tags.office || tags.craft;
    if (tags.name && poiKey) {
      kind = "poi";
      poiType = tags.shop ?? tags.amenity ?? tags.tourism ?? tags.historic ?? tags.office ?? tags.craft ?? "other";
    }
    if (!kind && tags.building) kind = "building";
    if (!kind && tags.highway) { kind = "road"; roadClass = tags.highway; }
    if (!kind && (tags.waterway || tags.natural === "water" || tags.natural === "wetland")) {
      kind = "water";
      waterType = tags.waterway ?? (tags.natural === "water" ? "water" : "wetland");
    }
    if (!kind && tags.landuse) { kind = "landuse"; landuseType = tags.landuse; }
    if (!kind && (tags.railway || tags.public_transport)) {
      kind = "transport";
      transportType = tags.railway ?? tags.public_transport ?? "other";
    }
    if (!kind && tags["addr:housenumber"]) kind = "address";
    if (!kind && tags.leisure) { kind = "landuse"; landuseType = tags.leisure; }
    if (!kind) continue;

    let coords: [number, number][] | null = null;
    let lon = 0, lat = 0;

    if (elType === "node") {
      lon = el.lon as number;
      lat = el.lat as number;
      coords = [[lon, lat]];
    } else if (elType === "way") {
      coords = resolveWayNodes(el);
      if (!coords) continue;
      if (kind === "building" || kind === "landuse" || kind === "water") {
        let sx = 0, sy = 0;
        for (const [x, y] of coords) { sx += x; sy += y; }
        lon = sx / coords.length;
        lat = sy / coords.length;
      } else {
        lon = coords[0][0];
        lat = coords[0][1];
      }
    } else {
      continue;
    }

    if (!isFinite(lon) || !isFinite(lat)) continue;
    if (!likelyInsideBoundary(lon, lat)) continue;
    if (!pointInPolygon(lon, lat, boundaryRings)) continue;

    const [lx, lz] = forward(lon, lat);
    const sourceRefs: SourceReference[] = [{ source: "osm", timestamp: raw.timestamp || now }];

    let geometry: Record<string, unknown> | undefined;
    let localGeometry: Record<string, unknown> | undefined;
    if (coords.length === 1) {
      geometry = { type: "Point", coordinates: [coords[0][0], coords[0][1]] };
      localGeometry = { type: "Point", coordinates: forward(coords[0][0], coords[0][1]) };
    } else if (coords.length >= 2) {
      const isClosed = coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
      if (isClosed && (kind === "building" || kind === "landuse" || kind === "water")) {
        geometry = { type: "Polygon", coordinates: [coords] };
        localGeometry = { type: "Polygon", coordinates: [coords.map(([x, y]) => forward(x, y))] };
      } else {
        geometry = { type: "LineString", coordinates: coords };
        localGeometry = { type: "LineString", coordinates: coords.map(([x, y]) => forward(x, y)) };
      }
    }

    const name = tags.name ?? "";
    const address = [
      tags["addr:housenumber"] ?? "",
      tags["addr:street"] ?? "",
      tags["addr:postcode"] ?? "",
    ].filter(Boolean).join(", ");
    const geomHash = coordHash(coords, coords.length);
    const stableId = buildStableId(kind, name, address, lon, lat, geomHash);

    const base = {
      kind,
      stableId,
      sourceId,
      name: name || undefined,
      address: address || undefined,
      lon,
      lat,
      x: lx,
      z: lz,
      geometry,
      localGeometry,
      provenance: [] as ProvenanceRecord[],
      confidence: 0.9,
      status: "active" as const,
      sourceRefs,
    };

    switch (kind) {
      case "building": {
        const h = inferHeight(tags);
        features.push({
          ...base,
          kind: "building",
          height: h?.height ?? categoryDefaultHeight(tags.building ?? "house"),
          heightInferred: h ? h.inferred : true,
          levels: tags["building:levels"] ? parseInt(tags["building:levels"], 10) : undefined,
          buildingType: tags.building || undefined,
        } as BuildingFeature);
        break;
      }
      case "road": {
        const w = tags.width ? parseFloat(tags.width) : undefined;
        features.push({
          ...base,
          kind: "road",
          roadClass: roadClass ?? "unclassified",
          width: isFinite(w ?? NaN) ? w : defaultRoadWidth(roadClass ?? "unclassified"),
          widthInferred: !isFinite(w ?? NaN),
          surface: tags.surface || undefined,
          oneway: tags.oneway === "yes",
          bridge: tags.bridge === "yes",
          tunnel: tags.tunnel === "yes" || tags.tunnel === "yes",
        } as RoadFeature);
        break;
      }
      case "water":
        features.push({ ...base, kind: "water", waterType: waterType ?? "water" } as WaterFeature);
        break;
      case "landuse":
        features.push({ ...base, kind: "landuse", landuseType: landuseType ?? "other" } as LanduseFeature);
        break;
      case "poi":
        features.push({ ...base, kind: "poi", poiType: poiType ?? "other", category: tags.shop ?? tags.amenity ?? tags.tourism ?? undefined } as PoiFeature);
        break;
      case "transport":
        features.push({ ...base, kind: "transport", transportType: transportType ?? "other", route: tags.route ?? undefined, operator: tags.operator ?? undefined } as TransportFeature);
        break;
      case "address":
        features.push({ ...base, kind: "address", banId: sourceId, housenumber: tags["addr:housenumber"] ?? "", street: tags["addr:street"] ?? "", postcode: tags["addr:postcode"] ?? "", city: tags["addr:city"] ?? "Auch" } as AddressFeature);
        break;
    }
  }

  return features;
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
    if (!likelyInsideBoundary(lon, lat)) continue;
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
      provenance: [],
      confidence: 0.95,
      status: "active",
      sourceRefs: [{ source: "ban", timestamp: now, license: raw.license ?? "etalab-2.0" }],
    });
  }

  return features;
}

function normalizeBusinesses(
  raw: { records?: Record<string, unknown>[] },
  boundary: BoundaryFeature,
): BusinessFeature[] {
  if (!raw.records?.length) return [];
  const boundaryRings = boundary.rings;
  const now = new Date().toISOString();
  const features: BusinessFeature[] = [];

  for (const r of raw.records) {
    const coord = r.coordinate as { lon?: number; lat?: number } | undefined;
    let lon = coord?.lon ?? 0;
    let lat = coord?.lat ?? 0;
    if (!isFinite(lon) || !isFinite(lat)) continue;
    if (!likelyInsideBoundary(lon, lat)) continue;
    if (!pointInPolygon(lon, lat, boundaryRings)) continue;

    const [lx, lz] = forward(lon, lat);
    const legalName = String(r.legalName ?? r.tradingName ?? "");
    const siret = String(r.siret ?? "");
    const siren = String(r.siren ?? "");
    const name = legalName;
    const brand = String(r.tradingName ?? "") || undefined;
    const geomHash = coordHash([[lon, lat]], 1);
    const stableId = buildStableId("business", name, siret, lon, lat, geomHash);

    features.push({
      kind: "business",
      stableId,
      businessId: siret || undefined,
      siren: siren || undefined,
      siret: siret || undefined,
      brand,
      name: name || undefined,
      lon,
      lat,
      x: lx,
      z: lz,
      geometry: { type: "Point", coordinates: [lon, lat] },
      localGeometry: { type: "Point", coordinates: [lx, lz] },
      provenance: [],
      confidence: 0.9,
      status: "active",
      sourceRefs: [{ source: "sirene", timestamp: now }],
    });
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
    if (!likelyInsideBoundary(lon, lat)) continue;
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
      provenance: [],
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
  const osmFeatures = normalizeOsm(sources.osm, boundary);
  const addrFeatures = normalizeAddresses(sources.addresses, boundary);
  const bizFeatures = normalizeBusinesses(sources.businesses, boundary);
  const ignFeatures = normalizeIgn(sources.ign, boundary);

  const all: MapFeature[] = [boundary, ...osmFeatures, ...addrFeatures, ...bizFeatures, ...ignFeatures];
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