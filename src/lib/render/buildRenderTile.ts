import { ShapeUtils, Vector2 } from "three";
import type { Geometry, MapFeature } from "../data/schema";
import { categoryForOsmValue, CATEGORY_BY_ID } from "../data/categories";
import { simplifyLine } from "../geo/simplify";
import {
  LAYER_KIND_STRIDE,
  RENDER_LAYER_IDS,
  RENDER_LAYER_KINDS,
  type FeatureMeta,
  type RenderBounds,
  type RenderLayerId,
  type RenderTileInput,
} from "./codec";
import {
  BOUNDARY_STYLES,
  BUILDING_STYLES,
  LANDCOVER_STYLES,
  RAIL_STYLES,
  ROAD_DRAW_RANK,
  ROAD_STYLES,
  STRUCTURE_STYLES,
  TRANSPORT_AREA_STYLES,
  WATER_AREA_STYLES,
  WATER_LINE_STYLES,
  buildingStyle,
  landcoverStyle,
  roadStyle,
  styleIndex,
} from "./styles";

export const DEFAULT_BUILDING_HEIGHT_METRES = 7;
export const RENDER_LAYER_BUDGET_BYTES = 2 * 1024 * 1024;

const ROAD_WIDTH_DEFAULTS: Readonly<Record<string, number>> = {
  motorway: 14, trunk: 10, primary: 8, secondary: 7, tertiary: 6,
  residential: 5, unclassified: 4.5, service: 3.5, track: 3, path: 1.5,
  cycleway: 2, steps: 2, pedestrian: 3, ferry: 2,
};
const WATER_WIDTH_DEFAULTS: Readonly<Record<string, number>> = {
  river: 12, stream: 2.5, canal: 6, ditch: 1.5, intermittent: 1.5,
};
const RAIL_HALF_WIDTH = 1.6;
const STRUCTURE_HALF_WIDTH = 1.5;
const BOUNDARY_HALF_WIDTH = 1;
const OVERVIEW_BORDER_TOLERANCE_METRES = 90;
const BRIDGE_LIFT_METRES = 0.4;
const TUNNEL_DEPTH_METRES = -0.4;
/** Sharper turns than this (cosine of the half angle) are split instead of mitered. */
const MITER_COSINE_LIMIT = 0.35;
/** A clipped polygon edge closer than this to a tile edge is a cut, not an outline. */
const TILE_EDGE_EPSILON = 0.05;

export interface BuildRenderTileOptions {
  tileId: string;
  lod: number;
  bounds: RenderBounds;
  datasetVersion: string;
  includeBoundary?: boolean;
}

type Point = readonly [number, number];
type Ring = readonly Point[];
type Polygon = readonly Ring[];

class LayerBuilder {
  readonly vertices: number[] = [];
  readonly indices: number[] = [];
  readonly ranges: number[] = [];
  readonly edges: number[] = [];
  private openIndex = 0;
  private openVertex = 0;

  constructor(readonly id: RenderLayerId, readonly stride: number) {}

  get vertexCount(): number {
    return this.vertices.length / this.stride;
  }

  begin(): void {
    this.openIndex = this.indices.length;
    this.openVertex = this.vertexCount;
  }

  /** Close the feature opened by begin(); empty features leave no row. */
  end(metaIndex: number): void {
    const indexCount = this.indices.length - this.openIndex;
    const vertexCount = this.vertexCount - this.openVertex;
    if (indexCount === 0) {
      /* Drop any orphan vertices so no range ever has to own them. */
      this.vertices.length = this.openVertex * this.stride;
      return;
    }
    this.ranges.push(this.openIndex, indexCount, metaIndex, this.openVertex, vertexCount);
  }
}

interface PendingLine {
  rank: number;
  emit: () => void;
}

export function buildRenderTile(features: MapFeature[], options: BuildRenderTileOptions): RenderTileInput {
  const meta: FeatureMeta[] = [];
  const layers = new Map<RenderLayerId, LayerBuilder>();
  const layer = (id: RenderLayerId): LayerBuilder => {
    let existing = layers.get(id);
    if (existing === undefined) {
      existing = new LayerBuilder(id, LAYER_KIND_STRIDE[RENDER_LAYER_KINDS[id]]);
      layers.set(id, existing);
    }
    return existing;
  };
  const bounds = options.includeBoundary === true ? null : options.bounds;
  /* Roads are emitted minor-first so a national road always paints over the
     lane that joins it. */
  const pendingRoads: PendingLine[] = [];

  for (const feature of features) {
    if (feature.kind === "boundary" && options.includeBoundary === false) continue;
    const geometry = localGeometry(feature);
    const metaIndex = meta.push(buildMeta(feature, geometry)) - 1;
    switch (feature.kind) {
      case "building": {
        const height = buildingHeight(feature);
        const style = styleIndex(BUILDING_STYLES, buildingStyle(feature.buildingType, String(feature.sourceMetadata?.usage1 ?? "")), "generic");
        const target = layer("building");
        target.begin();
        for (const polygon of polygons(geometry)) emitExtrusion(target, polygon, height, style, bounds);
        target.end(metaIndex);
        break;
      }
      case "road": {
        /* BD TOPO "fictif" segments only keep the network connected across squares and car parks. */
        if (feature.sourceMetadata?.fictif === true) break;
        const style = roadStyle(feature.roadClass ?? feature.highway);
        const halfWidth = resolveRoadWidth(feature) / 2;
        const id: RenderLayerId = roadLayerFor(feature);
        const y = id === "road_bridge" ? BRIDGE_LIFT_METRES : id === "road_tunnel" ? TUNNEL_DEPTH_METRES : 0;
        pendingRoads.push({
          rank: ROAD_DRAW_RANK[style],
          emit: () => {
            const target = layer(id);
            target.begin();
            for (const line of lines(geometry)) emitPolyline(target, line, false, halfWidth, ROAD_STYLES.indexOf(style), y);
            target.end(metaIndex);
          },
        });
        break;
      }
      case "water": {
        if (feature.fictiveAxis === true) break;
        if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
          const target = layer("water_area");
          const style = styleIndex(WATER_AREA_STYLES, waterAreaStyle(feature.waterType), "water");
          target.begin();
          for (const polygon of polygons(geometry)) emitFill(target, polygon, style);
          target.end(metaIndex);
        } else {
          const target = layer("water_line");
          const style = waterLineStyle(feature);
          target.begin();
          for (const line of lines(geometry)) emitPolyline(target, line, false, resolveWaterWidth(feature) / 2, WATER_LINE_STYLES.indexOf(style), 0);
          target.end(metaIndex);
        }
        break;
      }
      case "landuse": {
        const style = LANDCOVER_STYLES.indexOf(landcoverStyle(feature.landuseType, feature.category));
        const target = layer("landcover");
        target.begin();
        for (const polygon of polygons(geometry)) emitFill(target, polygon, style);
        target.end(metaIndex);
        break;
      }
      case "transport": {
        if (geometry.type === "Point") break;
        if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
          const target = layer("transport_area");
          const style = styleIndex(TRANSPORT_AREA_STYLES, transportAreaStyle(feature.transportType), "other");
          target.begin();
          for (const polygon of polygons(geometry)) emitFill(target, polygon, style);
          target.end(metaIndex);
        } else {
          const target = layer("rail");
          const runway = feature.transportType === "runway";
          const style = styleIndex(RAIL_STYLES, runway ? "runway" : feature.transportType === "disused" ? "disused" : "rail", "rail");
          target.begin();
          for (const line of lines(geometry)) emitPolyline(target, line, false, runway ? 15 : RAIL_HALF_WIDTH, style, 0.2);
          target.end(metaIndex);
        }
        break;
      }
      case "structure": {
        if (geometry.type === "Point") break;
        const style = styleIndex(STRUCTURE_STYLES, structureStyle(feature.structureType), "other");
        if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
          const target = layer("structure_area");
          target.begin();
          for (const polygon of polygons(geometry)) emitFill(target, polygon, style);
          target.end(metaIndex);
        } else {
          const target = layer("structure_line");
          target.begin();
          for (const line of lines(geometry)) emitPolyline(target, line, false, STRUCTURE_HALF_WIDTH, style, 0.3);
          target.end(metaIndex);
        }
        break;
      }
      case "place": {
        if (feature.placeType !== "commune") break;
        const target = layer("boundary");
        target.begin();
        for (const polygon of polygons(geometry)) {
          for (const ring of polygon) emitOutline(target, ring, BOUNDARY_HALF_WIDTH, BOUNDARY_STYLES.indexOf("commune"), 0.1, bounds);
        }
        target.end(metaIndex);
        break;
      }
      case "boundary": {
        const fill = layer("landcover");
        fill.begin();
        for (const polygon of polygons(geometry)) emitFill(fill, polygon, LANDCOVER_STYLES.indexOf("territory"));
        fill.end(metaIndex);
        const outline = layer("boundary");
        outline.begin();
        for (const polygon of polygons(geometry)) {
          for (const ring of polygon) {
            emitOutline(outline, ring, BOUNDARY_HALF_WIDTH * 2, BOUNDARY_STYLES.indexOf("department"), 0.2, null);
            /* River-traced stretches meander below a pixel at department scale; a generalised copy keeps the overview line clean. */
            emitOutline(outline, simplifyLine(ring, OVERVIEW_BORDER_TOLERANCE_METRES), BOUNDARY_HALF_WIDTH * 2, BOUNDARY_STYLES.indexOf("department_overview"), 0.2, null);
          }
        }
        outline.end(metaIndex);
        break;
      }
      default:
        /* Points (POIs, businesses, addresses) live in the meta table only;
           the overlay draws them as screen-space markers. */
        break;
    }
  }
  pendingRoads.sort((first, second) => first.rank - second.rank);
  for (const road of pendingRoads) road.emit();

  return {
    tileId: options.tileId,
    lod: options.lod,
    bounds: options.bounds,
    datasetVersion: options.datasetVersion,
    layers: RENDER_LAYER_IDS
      .map((id) => layers.get(id))
      .filter((builder): builder is LayerBuilder => builder !== undefined && builder.indices.length > 0)
      .map((builder) => ({
        id: builder.id,
        vertices: new Float32Array(builder.vertices),
        indices: new Uint32Array(builder.indices),
        ranges: new Uint32Array(builder.ranges),
        ...(builder.edges.length > 0 ? { edges: new Uint32Array(builder.edges) } : {}),
      })),
    meta,
  };
}

/* ------------------------------------------------------------------ */
/*  Classification                                                     */
/* ------------------------------------------------------------------ */

export function roadLayerFor(feature: Extract<MapFeature, { kind: "road" }>): RenderLayerId {
  if (feature.stratum === "tunnel" || feature.tunnel === true || feature.layer === "-1") return "road_tunnel";
  if (feature.stratum === "bridge" || feature.bridge === true || feature.layer === "1") return "road_bridge";
  return "road";
}

export function resolveRoadWidth(feature: Extract<MapFeature, { kind: "road" }>): number {
  if (feature.width !== undefined && feature.width > 0) return Math.min(feature.width, 40);
  return ROAD_WIDTH_DEFAULTS[roadStyle(feature.roadClass ?? feature.highway)] ?? ROAD_WIDTH_DEFAULTS.unclassified!;
}

export function resolveWaterWidth(feature: Extract<MapFeature, { kind: "water" }>): number {
  if (feature.width !== undefined && feature.width > 0) return Math.min(feature.width, 80);
  return WATER_WIDTH_DEFAULTS[waterLineStyle(feature)] ?? WATER_WIDTH_DEFAULTS.stream!;
}

function folded(value: string | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function waterLineStyle(feature: Extract<MapFeature, { kind: "water" }>): (typeof WATER_LINE_STYLES)[number] {
  const type = folded(feature.waterType);
  if (feature.intermittent === true) return "intermittent";
  if (/canal/.test(type)) return "canal";
  if (/fosse|ditch|drain|rigole/.test(type)) return "ditch";
  if (/river|riviere|fleuve/.test(type) || (feature.width ?? 0) >= 8 || (feature.name !== undefined && /^(la |le |l')?(baise|gers|adour|save|gimone|arrats|osse|douze|midour|arros|auloue|lizet|izaute|bouès|boues|auvignon|aulouste)\b/i.test(feature.name))) return "river";
  return "stream";
}

function waterAreaStyle(type: string | undefined): (typeof WATER_AREA_STYLES)[number] {
  const value = folded(type);
  if (/reservoir|retenue|basin|bassin|lac/.test(value)) return "reservoir";
  if (/piscine|pool/.test(value)) return "pool";
  if (/wetland|marais|marecage/.test(value)) return "wetland";
  return "water";
}

function transportAreaStyle(type: string): (typeof TRANSPORT_AREA_STYLES)[number] {
  const value = folded(type);
  if (/parking/.test(value)) return "parking";
  if (/runway|piste/.test(value)) return "runway";
  if (/aerodrome|airport|aeroport/.test(value)) return "aerodrome";
  if (/rail|gare|station/.test(value)) return "rail";
  return "other";
}

function structureStyle(type: string): (typeof STRUCTURE_STYLES)[number] {
  if (type === "bridge") return "bridge";
  if (type === "dam" || type === "lock") return "dam";
  if (/wall|fence/.test(type)) return "wall";
  return "other";
}

function buildingHeight(feature: Extract<MapFeature, { kind: "building" }>): number {
  if (feature.height !== undefined && feature.height > 0) return Math.min(feature.height, 120);
  const levels = feature.levels ?? feature.buildingLevels;
  if (levels !== undefined && levels > 0) return levels * 3 + 1;
  return DEFAULT_BUILDING_HEIGHT_METRES;
}

/** Canonical category id for a point-like feature, from either source vocabulary. */
export function canonicalCategory(feature: MapFeature): string {
  const candidates: (string | undefined)[] = [];
  if (feature.kind === "poi") candidates.push(feature.category, feature.poiType);
  else if (feature.kind === "business") candidates.push(feature.category, feature.poiType);
  else if (feature.kind === "landuse") candidates.push(feature.category);
  for (const value of candidates) {
    if (value === undefined) continue;
    if (CATEGORY_BY_ID.has(value)) return value;
    const mapped = categoryForOsmValue(value);
    if (mapped !== undefined) return mapped;
  }
  return "other";
}

/* ------------------------------------------------------------------ */
/*  Meta                                                               */
/* ------------------------------------------------------------------ */

function buildMeta(feature: MapFeature, geometry: Geometry): FeatureMeta {
  const anchor: [number, number] = feature.x !== undefined && feature.z !== undefined
    ? [round(feature.x), round(feature.z)]
    : geometryAnchor(geometry);
  const entry: FeatureMeta = { s: feature.stableId, k: feature.kind, c: metaCategory(feature), a: anchor };
  const name = feature.name ?? feature.displayName;
  if (name !== undefined && name.trim() !== "") entry.n = name.trim();
  switch (feature.kind) {
    case "building":
      entry.h = round(buildingHeight(feature));
      break;
    case "structure":
      if (feature.height !== undefined) entry.h = round(feature.height);
      break;
    case "road":
      entry.w = round(resolveRoadWidth(feature));
      if (feature.ref !== undefined) entry.r = feature.ref;
      break;
    case "water":
      entry.w = round(resolveWaterWidth(feature));
      break;
    case "transport":
      if (feature.ref !== undefined) entry.r = feature.ref;
      break;
    case "place":
      entry.p = compact({ pop: feature.population, imp: feature.importance, code: feature.sourceMetadata?.communeCode });
      break;
    case "address":
      entry.p = compact({ hn: feature.housenumber, st: feature.street, pc: feature.postcode, city: feature.city });
      break;
    case "business":
      if (entry.n === undefined) entry.n = feature.businessName;
      entry.p = compact({ brand: feature.brand });
      break;
    default:
      break;
  }
  return entry;
}

function metaCategory(feature: MapFeature): string {
  switch (feature.kind) {
    case "building": return feature.buildingType ?? "building";
    case "road": return roadStyle(feature.roadClass ?? feature.highway);
    case "water": return feature.isSurface === true ? waterAreaStyle(feature.waterType) : waterLineStyle(feature);
    case "landuse": return feature.category !== undefined ? canonicalCategory(feature) : feature.landuseType;
    case "poi":
    case "business": return canonicalCategory(feature);
    case "address": return "address";
    case "transport": return feature.transportType;
    case "structure": return feature.structureType;
    case "place": return feature.placeType;
    case "boundary": return feature.territoryCode;
  }
}

function compact(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ */
/*  Geometry access                                                    */
/* ------------------------------------------------------------------ */

function localGeometry(feature: MapFeature): Geometry {
  if (feature.localGeometry) return feature.localGeometry;
  if (feature.x !== undefined && feature.z !== undefined) return { type: "Point", coordinates: [feature.x, feature.z] };
  return feature.geometry;
}

function polygons(geometry: Geometry): Polygon[] {
  if (geometry.type === "Polygon") return [geometry.coordinates as unknown as Polygon];
  if (geometry.type === "MultiPolygon") return geometry.coordinates as unknown as Polygon[];
  return [];
}

function lines(geometry: Geometry): Point[][] {
  if (geometry.type === "LineString") return [geometry.coordinates as unknown as Point[]];
  if (geometry.type === "MultiLineString") return geometry.coordinates as unknown as Point[][];
  return [];
}

/** Area-weighted centroid of the largest ring, or the line midpoint. */
export function geometryAnchor(geometry: Geometry): [number, number] {
  if (geometry.type === "Point") return [round(geometry.coordinates[0]), round(geometry.coordinates[1])];
  const polys = polygons(geometry);
  if (polys.length > 0) {
    let best: Ring | undefined;
    let bestArea = -1;
    for (const polygon of polys) {
      const ring = polygon[0];
      if (ring === undefined) continue;
      const area = Math.abs(signedArea(ring));
      if (area > bestArea) {
        bestArea = area;
        best = ring;
      }
    }
    if (best !== undefined) return ringCentroid(best);
  }
  const all = lines(geometry);
  let longest: Point[] = [];
  for (const line of all) if (line.length > longest.length) longest = line;
  if (longest.length === 0) return [0, 0];
  const half = polylineLength(longest) / 2;
  let walked = 0;
  for (let index = 1; index < longest.length; index += 1) {
    const from = longest[index - 1]!;
    const to = longest[index]!;
    const step = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (walked + step >= half && step > 0) {
      const t = (half - walked) / step;
      return [round(from[0] + (to[0] - from[0]) * t), round(from[1] + (to[1] - from[1]) * t)];
    }
    walked += step;
  }
  return [round(longest[0]![0]), round(longest[0]![1])];
}

function polylineLength(line: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < line.length; index += 1) total += Math.hypot(line[index]![0] - line[index - 1]![0], line[index]![1] - line[index - 1]![1]);
  return total;
}

function signedArea(ring: Ring): number {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, z1] = ring[index]!;
    const [x2, z2] = ring[(index + 1) % ring.length]!;
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}

function ringCentroid(ring: Ring): [number, number] {
  const area = signedArea(ring);
  if (Math.abs(area) < 1e-6) {
    const [x, z] = ring[0] ?? [0, 0];
    return [round(x), round(z)];
  }
  let cx = 0;
  let cz = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const [x1, z1] = ring[index]!;
    const [x2, z2] = ring[(index + 1) % ring.length]!;
    const cross = x1 * z2 - x2 * z1;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  return [round(cx / (6 * area)), round(cz / (6 * area))];
}

/** Drop non-finite points, consecutive duplicates and the closing repeat. */
function cleanRing(ring: Ring): Point[] {
  const points: Point[] = [];
  for (const point of ring) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const last = points[points.length - 1];
    if (last !== undefined && last[0] === point[0] && last[1] === point[1]) continue;
    points.push(point);
  }
  if (points.length > 1) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) points.pop();
  }
  return points;
}

function cleanLine(line: readonly Point[]): Point[] {
  const points: Point[] = [];
  for (const point of line) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
    const last = points[points.length - 1];
    if (last !== undefined && Math.abs(last[0] - point[0]) < 1e-3 && Math.abs(last[1] - point[1]) < 1e-3) continue;
    points.push(point);
  }
  return points;
}

/** True when a segment runs along the tile edge, i.e. it was made by clipping. */
export function onTileEdge(a: Point, b: Point, bounds: RenderBounds | null): boolean {
  if (bounds === null) return false;
  const [minX, minZ, maxX, maxZ] = bounds;
  const near = (value: number, edge: number): boolean => Math.abs(value - edge) <= TILE_EDGE_EPSILON;
  return (near(a[0], minX) && near(b[0], minX))
    || (near(a[0], maxX) && near(b[0], maxX))
    || (near(a[1], minZ) && near(b[1], minZ))
    || (near(a[1], maxZ) && near(b[1], maxZ));
}

/* ------------------------------------------------------------------ */
/*  Emitters                                                           */
/* ------------------------------------------------------------------ */

function emitFill(target: LayerBuilder, polygon: Polygon, style: number): void {
  const rings = polygon.map(cleanRing).filter((ring) => ring.length >= 3);
  const contour = rings[0];
  if (contour === undefined) return;
  const holes = rings.slice(1);
  const base = target.vertexCount;
  const flat: Point[] = [...contour, ...holes.flat()];
  for (const [x, z] of flat) target.vertices.push(x, 0, z, style);
  const faces = ShapeUtils.triangulateShape(contour.map(toVector), holes.map((ring) => ring.map(toVector)));
  for (const [a, b, c] of faces) target.indices.push(base + a!, base + b!, base + c!);
}

function toVector(point: Point): Vector2 {
  return new Vector2(point[0], point[1]);
}

function emitExtrusion(target: LayerBuilder, polygon: Polygon, height: number, style: number, bounds: RenderBounds | null): void {
  const rings = polygon.map(cleanRing).filter((ring) => ring.length >= 3);
  const contour = rings[0];
  if (contour === undefined) return;
  const holes = rings.slice(1);
  const ordered = [contour, ...holes];
  const total = ordered.reduce((sum, ring) => sum + ring.length, 0);
  const base = target.vertexCount;
  for (const ring of ordered) for (const [x, z] of ring) target.vertices.push(x, 0, z, height, style);
  for (const ring of ordered) for (const [x, z] of ring) target.vertices.push(x, height, z, height, style);
  const top = base + total;
  const faces = ShapeUtils.triangulateShape(contour.map(toVector), holes.map((ring) => ring.map(toVector)));
  for (const [a, b, c] of faces) target.indices.push(top + a!, top + b!, top + c!);
  let ringOffset = 0;
  for (const ring of ordered) {
    for (let index = 0; index < ring.length; index += 1) {
      const next = (index + 1) % ring.length;
      if (onTileEdge(ring[index]!, ring[next]!, bounds)) continue;
      const bottomA = base + ringOffset + index;
      const bottomB = base + ringOffset + next;
      const topA = top + ringOffset + index;
      const topB = top + ringOffset + next;
      target.indices.push(bottomA, bottomB, topB, bottomA, topB, topA);
      target.edges.push(topA, topB);
    }
    ringOffset += ring.length;
  }
}

/** A polygon ring drawn as a line, skipping the stretches that only exist because of tile clipping. */
function emitOutline(target: LayerBuilder, ring: Ring, halfWidth: number, style: number, y: number, bounds: RenderBounds | null): void {
  const points = cleanRing(ring);
  if (points.length < 2) return;
  const cuts: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    if (onTileEdge(points[index]!, points[(index + 1) % points.length]!, bounds)) cuts.push(index);
  }
  if (cuts.length === 0) {
    emitPolyline(target, points, true, halfWidth, style, y);
    return;
  }
  /* Walk the ring from just after a cut, collecting runs between cuts. */
  const cutSet = new Set(cuts);
  const start = (cuts[0]! + 1) % points.length;
  let run: Point[] = [points[start]!];
  for (let step = 0; step < points.length; step += 1) {
    const index = (start + step) % points.length;
    const next = (index + 1) % points.length;
    if (cutSet.has(index)) {
      if (run.length >= 2) emitPolyline(target, run, false, halfWidth, style, y);
      run = [points[next]!];
      continue;
    }
    run.push(points[next]!);
  }
  if (run.length >= 2) emitPolyline(target, run, false, halfWidth, style, y);
}

/**
 * Emit a polyline as a ribbon of vertex pairs. Each vertex keeps its
 * centreline position; the extrusion vector (miter-scaled normal, plus the
 * tangent at a square cap) is multiplied by the on-screen half width in the
 * shader.
 */
export function emitPolyline(target: LayerBuilder, input: readonly Point[], closed: boolean, halfWidth: number, style: number, y: number): void {
  const points = cleanLine(input);
  if (closed && points.length > 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    if (Math.abs(first[0] - last[0]) < 1e-3 && Math.abs(first[1] - last[1]) < 1e-3) points.pop();
  }
  const count = points.length;
  if (count < 2 || !(halfWidth > 0)) return;
  const segmentCount = closed ? count : count - 1;
  const directions: [number, number][] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const from = points[index]!;
    const to = points[(index + 1) % count]!;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    directions.push(length > 0 ? [(to[0] - from[0]) / length, (to[1] - from[1]) / length] : [1, 0]);
  }
  let distance = 0;
  let previousPair = -1;
  /* Left vertex = normal + cap, right vertex = -normal + cap; the cap
     (a tangent) is shared so a square end extends both sides equally. */
  const pushPair = (point: Point, nx: number, nz: number, along: number, cx = 0, cz = 0): number => {
    const pair = target.vertexCount;
    target.vertices.push(point[0], y, point[1], nx + cx, nz + cz, halfWidth, style, along);
    target.vertices.push(point[0], y, point[1], -nx + cx, -nz + cz, halfWidth, style, along);
    return pair;
  };
  const link = (pair: number): void => {
    if (previousPair >= 0) {
      const l0 = previousPair;
      const r0 = previousPair + 1;
      const l1 = pair;
      const r1 = pair + 1;
      target.indices.push(l0, r0, l1, r0, r1, l1);
    }
    previousPair = pair;
  };
  const vertexTotal = closed ? count + 1 : count;
  for (let step = 0; step < vertexTotal; step += 1) {
    const index = step % count;
    const point = points[index]!;
    if (step > 0) {
      const from = points[(step - 1) % count]!;
      distance += Math.hypot(point[0] - from[0], point[1] - from[1]);
    }
    const incoming = closed ? directions[(index - 1 + count) % count]! : step > 0 ? directions[step - 1]! : undefined;
    const outgoing = closed ? directions[index % segmentCount]! : step < count - 1 ? directions[step]! : undefined;
    if (incoming === undefined && outgoing !== undefined) {
      /* Square start cap: half a width behind the first point. */
      link(pushPair(point, -outgoing[1], outgoing[0], distance, -outgoing[0], -outgoing[1]));
      continue;
    }
    if (outgoing === undefined && incoming !== undefined) {
      link(pushPair(point, -incoming[1], incoming[0], distance, incoming[0], incoming[1]));
      continue;
    }
    const nIn: [number, number] = [-incoming![1], incoming![0]];
    const nOut: [number, number] = [-outgoing![1], outgoing![0]];
    let mx = nIn[0] + nOut[0];
    let mz = nIn[1] + nOut[1];
    const length = Math.hypot(mx, mz);
    const cosine = length > 1e-6 ? (mx / length) * nOut[0] + (mz / length) * nOut[1] : 0;
    if (cosine < MITER_COSINE_LIMIT) {
      /* A hairpin: finish the incoming segment and restart the outgoing one
         at the same point instead of letting the miter shoot out. */
      link(pushPair(point, nIn[0], nIn[1], distance));
      link(pushPair(point, nOut[0], nOut[1], distance));
      continue;
    }
    mx /= length * cosine;
    mz /= length * cosine;
    link(pushPair(point, mx, mz, distance));
  }
}
