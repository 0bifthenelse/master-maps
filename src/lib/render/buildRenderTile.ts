import { ShapeUtils, Vector2 } from "three";
import type { Geometry, MapFeature } from "../data/schema";
import { tessellatePolyline, type PolylinePoint } from "../scene/tessellatePolyline";
import { RENDER_LAYER_IDS, type FeatureMeta, type RenderBounds, type RenderLayerId, type RenderTileInput } from "./codec";

export const DEFAULT_BUILDING_HEIGHT_METRES = 7;
export const RENDER_LAYER_BUDGET_BYTES = 2 * 1024 * 1024;
export const BUILDING_FOOTPRINT_LAYER: RenderLayerId = "buildings";

const ROAD_WIDTH_DEFAULTS: Readonly<Record<string, number>> = {
  motorway: 12, trunk: 9, primary: 8, secondary: 7, tertiary: 6,
  residential: 5, service: 3.5, pedestrian: 2, footway: 2,
  cycleway: 2, path: 1.5, track: 2.5, unclassified: 4, roundabout: 6, steps: 2, ford: 4,
};
const WATER_WIDTH_DEFAULTS: Readonly<Record<string, number>> = {
  river: 10, stream: 2, brook: 2, canal: 6, ditch: 1.5, drain: 1.5, tidal_channel: 6, default: 3,
};
const TRANSPORT_WIDTH_DEFAULTS: Readonly<Record<string, number>> = {
  rail: 4, station: 6, halt: 4, bus_stop: 3, platform: 6, runway: 30, port: 8, default: 4,
};
const TRANSPORT_AREA_TYPES: ReadonlySet<string> = new Set(["aerodrome", "parking", "port", "station", "halt", "platform", "bus_stop", "roundabout", "toll"]);
const STRUCTURE_POINT_TYPES: ReadonlySet<string> = new Set([
  "pylone", "poste_de_transformation", "borne", "arbre", "monument", "chateau_eau", "reservoir",
]);
const EXTRA_META_KEYS: Readonly<Record<string, readonly string[]>> = {
  building: ["levels", "heightSource", "heightInferred", "buildingType", "roofType", "startDate"],
  road: ["surface", "stratum", "oneway", "lanes", "lit", "bridge", "tunnel"],
  water: ["waterType", "intermittent", "tidal", "salt", "fictiveAxis", "isSurface"],
  landuse: ["area"],
  poi: ["poiType", "category", "website", "phone", "openingHours", "wheelchair"],
  business: ["poiType", "category", "nafCode", "nafLabel", "website", "phone", "openingHours", "wheelchair"],
  address: ["street", "housenumber", "postcode", "city"],
  transport: ["transportType", "line", "route", "network", "operator", "ref", "wheelchair"],
  structure: ["height", "heightSource"],
  place: ["importance", "population"],
  boundary: ["territoryCode"],
};
const BRIDGE_LIFT_METRES = 0.6;
const TUNNEL_DEPTH_METRES = -1;
const POINT_LAYER_Y = 2;
const STRUCTURE_DEFAULT_WIDTH_METRES = 4;
const STRUCTURE_MAX_WIDTH_METRES = 40;

interface MeshBuilder {
  positions: number[];
  indices: number[];
  ranges: number[];
}

export interface BuildRenderTileOptions {
  tileId: string;
  lod: number;
  bounds: RenderBounds;
  datasetVersion: string;
  includeBoundary?: boolean;
}

type PointCoordinates = readonly [number, number];
type RingCoordinates = readonly PointCoordinates[];
type PolygonCoordinates = readonly RingCoordinates[];
export function buildRenderTile(features: MapFeature[], options: BuildRenderTileOptions): RenderTileInput {
  const meta: FeatureMeta[] = [];
  const meshes = new Map<RenderLayerId, MeshBuilder>();
  const meshFor = (id: RenderLayerId): MeshBuilder => {
    const existing = meshes.get(id);
    if (existing) return existing;
    const created: MeshBuilder = { positions: [], indices: [], ranges: [] };
    meshes.set(id, created);
    return created;
  };
  const metaIndexFor = (feature: MapFeature, extra: Record<string, unknown>): number => {
    const geometry = localGeometry(feature);
    meta.push(buildMeta(feature, geometryAnchor(geometry), extra));
    return meta.length - 1;
  };
  for (const feature of features) {
    const extra = collectExtra(feature, EXTRA_META_KEYS[feature.kind]);
    if (feature.kind === "boundary" && options.includeBoundary === false) continue;
    if (feature.kind === "water" && feature.fictiveAxis === true) continue;
    if (feature.kind === "building") {
      emitBuilding(meshFor(BUILDING_FOOTPRINT_LAYER), feature, metaIndexFor(feature, extra));
      continue;
    }
    if (feature.kind === "road") {
      emitRoad(meshFor(roadLayerFor(feature)), feature, metaIndexFor(feature, extra));
      continue;
    }
    if (feature.kind === "water") {
      emitWater(meshFor, feature, metaIndexFor, extra);
      continue;
    }
    if (feature.kind === "landuse") {
      emitPolygons(meshFor(landuseLayerFor(feature.landuseType)), localGeometry(feature), metaIndexFor(feature, extra));
      continue;
    }
    if (feature.kind === "transport") {
      emitTransport(meshFor, feature, metaIndexFor, extra);
      continue;
    }
    if (feature.kind === "structure") {
      emitStructure(meshFor, feature, metaIndexFor, extra);
      continue;
    }
    if (feature.kind === "poi" || feature.kind === "business") {
      emitFeaturePoint(meshFor("poi"), feature, metaIndexFor(feature, extra));
      continue;
    }
    if (feature.kind === "address") {
      emitFeaturePoint(meshFor("address"), feature, metaIndexFor(feature, extra));
      continue;
    }
    if (feature.kind === "place") {
      emitFeaturePoint(meshFor("place"), feature, metaIndexFor(feature, extra));
      continue;
    }
    emitPolygons(meshFor("boundary"), localGeometry(feature), metaIndexFor(feature, extra));
  }
  return {
    tileId: options.tileId,
    lod: options.lod,
    bounds: options.bounds,
    datasetVersion: options.datasetVersion,
    layers: RENDER_LAYER_IDS
      .filter((id) => (meshes.get(id)?.positions.length ?? 0) > 0)
      .map((id) => {
        const mesh = meshes.get(id)!;
        return {
          id,
          positions: new Float32Array(mesh.positions),
          indices: new Uint32Array(mesh.indices),
          ranges: new Uint32Array(mesh.ranges),
        };
      }),
    meta,
  };
}

export function roadLayerFor(feature: Extract<MapFeature, { kind: "road" }>): RenderLayerId {
  if (feature.stratum === "tunnel" || feature.tunnel === true || feature.layer === "-1") return "road_tunnel";
  if (feature.stratum === "bridge" || feature.bridge === true || feature.layer === "1") return "road_bridge";
  return "road_normal";
}

export function landuseLayerFor(landuseType: string): RenderLayerId {
  return landuseType === "habitat" || landuseType === "zone_d_habitation" || landuseType === "residential" ? "habitat" : "landuse";
}

export function resolveRoadWidth(feature: Extract<MapFeature, { kind: "road" }>): number {
  if (feature.width !== undefined && feature.width > 0) return feature.width;
  return ROAD_WIDTH_DEFAULTS[feature.roadClass ?? feature.highway ?? ""] ?? ROAD_WIDTH_DEFAULTS.unclassified!;
}

export function resolveWaterWidth(feature: Extract<MapFeature, { kind: "water" }>): number {
  if (feature.width !== undefined && feature.width > 0) return feature.width;
  return WATER_WIDTH_DEFAULTS[feature.waterType ?? ""] ?? WATER_WIDTH_DEFAULTS.default!;
}

function resolveTransportWidth(transportType: string): number {
  return TRANSPORT_WIDTH_DEFAULTS[transportType] ?? TRANSPORT_WIDTH_DEFAULTS.default!;
}

function emitBuilding(mesh: MeshBuilder, feature: Extract<MapFeature, { kind: "building" }>, metaIndex: number): void {
  const height = feature.height !== undefined && feature.height > 0 ? feature.height : DEFAULT_BUILDING_HEIGHT_METRES;
  for (const polygon of geometryPolygons(localGeometry(feature))) extrudePolygon(mesh, polygon, height, metaIndex);
}

function emitRoad(mesh: MeshBuilder, feature: Extract<MapFeature, { kind: "road" }>, metaIndex: number): void {
  const layer = roadLayerFor(feature);
  const y = layer === "road_bridge" ? BRIDGE_LIFT_METRES : layer === "road_tunnel" ? TUNNEL_DEPTH_METRES : 0;
  const halfWidth = resolveRoadWidth(feature) / 2;
  for (const line of geometryLines(localGeometry(feature))) emitRibbon(mesh, line, halfWidth, y, metaIndex);
}

function emitWater(meshFor: (id: RenderLayerId) => MeshBuilder, feature: Extract<MapFeature, { kind: "water" }>, metaIndexFor: (feature: MapFeature, extra: Record<string, unknown>) => number, extra: Record<string, unknown>): void {
  if (feature.fictiveAxis === true) return;
  const geometry = localGeometry(feature);
  const metaIndex = metaIndexFor(feature, extra);
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    emitPolygons(meshFor("water_surface"), geometry, metaIndex);
    return;
  }
  const mesh = meshFor("water_line");
  const halfWidth = resolveWaterWidth(feature) / 2;
  for (const line of geometryLines(geometry)) emitRibbon(mesh, line, halfWidth, 0, metaIndex);
}

function emitTransport(meshFor: (id: RenderLayerId) => MeshBuilder, feature: Extract<MapFeature, { kind: "transport" }>, metaIndexFor: (feature: MapFeature, extra: Record<string, unknown>) => number, extra: Record<string, unknown>): void {
  const geometry = localGeometry(feature);
  if (geometry.type === "Point") {
    const mesh = meshFor("transport_area");
    mesh.positions.push(geometry.coordinates[0], POINT_LAYER_Y, geometry.coordinates[1]);
    mesh.ranges.push(mesh.indices.length, 0, metaIndexFor(feature, extra));
    return;
  }
  const metaIndex = metaIndexFor(feature, extra);
  const area = geometry.type === "Polygon" || geometry.type === "MultiPolygon" || TRANSPORT_AREA_TYPES.has(feature.transportType);
  if (area) {
    emitPolygons(meshFor("transport_area"), geometry, metaIndex);
    return;
  }
  const mesh = meshFor("transport_line");
  const halfWidth = resolveTransportWidth(feature.transportType) / 2;
  for (const line of geometryLines(geometry)) emitRibbon(mesh, line, halfWidth, 0, metaIndex);
}

function emitStructure(meshFor: (id: RenderLayerId) => MeshBuilder, feature: Extract<MapFeature, { kind: "structure" }>, metaIndexFor: (feature: MapFeature, extra: Record<string, unknown>) => number, extra: Record<string, unknown>): void {
  const geometry = localGeometry(feature);
  if (geometry.type === "Point") {
    if (STRUCTURE_POINT_TYPES.has(feature.structureType) || feature.height !== undefined) {
      meshFor("structures_point").positions.push(geometry.coordinates[0], POINT_LAYER_Y, geometry.coordinates[1]);
      meshFor("structures_point").ranges.push(meshFor("structures_point").indices.length, 0, metaIndexFor(feature, extra));
    }
    return;
  }
  const metaIndex = metaIndexFor(feature, extra);
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
    emitPolygons(meshFor("structure_area"), geometry, metaIndex);
    return;
  }
  const halfWidth = Math.min(feature.height !== undefined && feature.height > 0 ? feature.height : STRUCTURE_DEFAULT_WIDTH_METRES, STRUCTURE_MAX_WIDTH_METRES) / 2;
  const mesh = meshFor("structure_line");
  for (const line of geometryLines(geometry)) emitRibbon(mesh, line, halfWidth, 0, metaIndex);
}

function emitFeaturePoint(mesh: MeshBuilder, feature: MapFeature, metaIndex: number): void {
  const geometry = localGeometry(feature);
  if (geometry.type !== "Point") return;
  mesh.positions.push(geometry.coordinates[0], POINT_LAYER_Y, geometry.coordinates[1]);
  mesh.ranges.push(mesh.indices.length, 0, metaIndex);
}

function emitPolygons(mesh: MeshBuilder, geometry: Geometry | undefined, metaIndex: number): void {
  for (const polygon of geometryPolygons(geometry)) emitPolygon(mesh, polygon, metaIndex);
}

function emitPolygon(mesh: MeshBuilder, polygon: PolygonCoordinates, metaIndex: number): void {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return;
  const contour = ringToVector2(outer);
  const holes: Vector2[][] = polygon.slice(1).flatMap((ring) => (ring.length >= 3 ? [ringToVector2(ring)] : []));
  const indexOffset = mesh.indices.length;
  const vertexOffset = mesh.positions.length / 3;
  const ringVertices: Vector2[] = [...contour, ...holes.flat()];
  for (const face of ShapeUtils.triangulateShape(contour, holes)) {
    const [a, b, c] = face;
    for (const corner of [a!, b!, c!]) {
      const vertex = ringVertices[corner]!;
      mesh.positions.push(vertex.x, 0, vertex.y);
    }
    mesh.indices.push(vertexOffset + a!, vertexOffset + c!, vertexOffset + b!);
  }
  mesh.ranges.push(indexOffset, mesh.indices.length - indexOffset, metaIndex);
}

function extrudePolygon(mesh: MeshBuilder, polygon: PolygonCoordinates, height: number, metaIndex: number): void {
  const outer = polygon[0];
  if (!outer || outer.length < 3) return;
  const contour = ringToVector2(outer);
  const holes: Vector2[][] = polygon.slice(1).flatMap((ring) => (ring.length >= 3 ? [ringToVector2(ring)] : []));
  const indexOffset = mesh.indices.length;
  const vertexOffset = mesh.positions.length / 3;
  const ringVertices: Vector2[] = [...contour, ...holes.flat()];
  const contourCount = contour.length;
  for (const vertex of ringVertices) mesh.positions.push(vertex.x, 0, vertex.y);
  for (const vertex of ringVertices) mesh.positions.push(vertex.x, height, vertex.y);
  for (const face of ShapeUtils.triangulateShape(contour, holes)) {
    const [a, b, c] = face;
    mesh.indices.push(vertexOffset + a!, vertexOffset + c!, vertexOffset + b!);
    mesh.indices.push(vertexOffset + contourCount + a!, vertexOffset + contourCount + b!, vertexOffset + contourCount + c!);
  }
  for (let index = 0; index < contourCount; index += 1) {
    const next = (index + 1) % contourCount;
    pushWallQuad(mesh, vertexOffset + index, vertexOffset + next, contourCount);
  }
  for (const hole of holes) {
    const start = vertexOffset + contourCount;
    for (let index = 0; index < hole.length; index += 1) {
      const next = (index + 1) % hole.length;
      pushWallQuad(mesh, start + index, start + next, hole.length);
    }
  }
  mesh.ranges.push(indexOffset, mesh.indices.length - indexOffset, metaIndex);
}

function pushWallQuad(mesh: MeshBuilder, bottomA: number, bottomB: number, ringCount: number): void {
  const topA = bottomA + ringCount;
  const topB = bottomB + ringCount;
  mesh.indices.push(bottomA, topB, bottomB, bottomA, topA, topB);
}

function emitRibbon(mesh: MeshBuilder, line: readonly PointCoordinates[], halfWidth: number, y: number, metaIndex: number): void {
  if (line.length < 2 || !(halfWidth > 0)) return;
  const strip = tessellatePolyline(line as readonly PolylinePoint[], { halfWidth, miterLimit: 4 });
  if (strip.indices.length === 0) return;
  const indexOffset = mesh.indices.length;
  const vertexOffset = mesh.positions.length / 3;
  for (let index = 0; index < strip.left.length; index += 1) {
    const left = strip.left[index]!;
    const right = strip.right[index]!;
    mesh.positions.push(left[0], y, left[1], right[0], y, right[1]);
  }
  for (const index of strip.indices) mesh.indices.push(vertexOffset + index);
  mesh.ranges.push(indexOffset, strip.indices.length, metaIndex);
}

function ringToVector2(ring: RingCoordinates): Vector2[] {
  const points = ring.map(([x, z]) => new Vector2(x, z));
  if (points.length > 2 && points[points.length - 1]!.equals(points[0]!)) points.pop();
  return points;
}

function localGeometry(feature: MapFeature): Geometry {
  if (feature.localGeometry) return feature.localGeometry;
  if (feature.x !== undefined && feature.z !== undefined) return { type: "Point", coordinates: [feature.x, feature.z] };
  return feature.geometry;
}

function geometryPolygons(geometry: Geometry | undefined): PolygonCoordinates[] {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  return [];
}

function geometryLines(geometry: Geometry | undefined): readonly PointCoordinates[][] {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function geometryAnchor(geometry: Geometry | undefined): [number, number] {
  if (!geometry) return [0, 0];
  if (geometry.type === "Point") {
    const [x, z] = geometry.coordinates;
    return [x, z];
  }
  if (geometry.type === "LineString") {
    const [x, z] = geometry.coordinates[0] ?? [0, 0];
    return [x, z];
  }
  if (geometry.type === "Polygon") {
    const first = geometry.coordinates[0]?.[0] ?? [0, 0];
    return [first[0], first[1]];
  }
  if (geometry.type === "MultiPolygon") {
    const first = geometry.coordinates[0]?.[0]?.[0] ?? [0, 0];
    return [first[0], first[1]];
  }
  const [x, z] = geometry.coordinates[0]?.[0] ?? [0, 0];
  return [x, z];
}

function buildMeta(feature: MapFeature, anchor: [number, number], extra: Record<string, unknown>): FeatureMeta {
  const entry: FeatureMeta = { s: feature.fragmentId ?? feature.stableId, k: feature.kind, c: featureCategory(feature), a: anchor };
  const name = feature.name ?? feature.displayName;
  if (name !== undefined) entry.n = name;
  if (feature.kind === "building" || feature.kind === "structure") {
    if (feature.height !== undefined) entry.h = feature.height;
  } else if (feature.kind === "road") {
    entry.w = resolveRoadWidth(feature);
  } else if (feature.kind === "water") {
    entry.w = resolveWaterWidth(feature);
  } else if (feature.kind === "transport") {
    entry.w = resolveTransportWidth(feature.transportType);
  }
  if (Object.keys(extra).length > 0) entry.p = extra;
  return entry;
}

function featureCategory(feature: MapFeature): string {
  switch (feature.kind) {
    case "building": return feature.buildingType ?? "yes";
    case "road": return feature.roadClass ?? feature.highway ?? "road";
    case "water": return feature.waterType ?? (feature.isSurface === true ? "surface" : "water");
    case "landuse": return feature.landuseType;
    case "poi": return feature.poiType;
    case "business": return feature.poiType ?? feature.category ?? "business";
    case "address": return "address";
    case "transport": return feature.transportType;
    case "structure": return feature.structureType;
    case "place": return feature.placeType;
    case "boundary": return feature.territoryCode;
  }
}

function collectExtra(feature: MapFeature, keys: readonly string[] | undefined): Record<string, unknown> {
  const record = feature as unknown as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const key of keys ?? []) {
    const value = record[key];
    if (value !== undefined && value !== null) extra[key] = value;
  }
  return extra;
}
