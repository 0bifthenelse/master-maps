import { renderToWgs84, wgs84ToRender } from "../../src/lib/geo/crs";
import type {
  BuildingFeature,
  MapFeature,
  RoadFeature,
  WaterFeature,
} from "../../src/lib/data/schema";
import { clipLineStringToPolygon, clipPolygonToPolygon, normalizePolygonGeometry, type PolygonGeometry } from "../../src/lib/geo/polygon";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";

type Coordinate = [number, number];
type NormalizedGeometry =
  | { type: "Point"; coordinates: Coordinate }
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] }
  | { type: "Polygon"; coordinates: Coordinate[][] }
  | { type: "MultiPolygon"; coordinates: Coordinate[][][] };

interface SourceFeature {
  type?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown>;
  sourceLayer?: unknown;
}

const SOURCE_URL = "https://geoservices.ign.fr/bdtopo";
const SOURCE_NAME = "IGN BD TOPO";
const SOURCE_TIMESTAMP = new Date().toISOString();

export function parseBdBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "oui", "vrai"].includes(normalized)) return true;
  if (["0", "false", "no", "non", "faux"].includes(normalized)) return false;
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function coordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = value[0];
  const latitude = value[1];
  if (typeof longitude !== "number" || typeof latitude !== "number") return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}

function closeRing(value: unknown): Coordinate[] | null {
  if (!Array.isArray(value)) return null;
  const points: Coordinate[] = [];
  for (const item of value) {
    const point = coordinate(item);
    if (!point) return null;
    points.push(point);
  }
  if (points.length < 3) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
  return points.length >= 4 ? points : null;
}

function line(value: unknown): Coordinate[] | null {
  if (!Array.isArray(value)) return null;
  const points: Coordinate[] = [];
  for (const item of value) {
    const point = coordinate(item);
    if (!point) return null;
    points.push(point);
  }
  return points.length >= 2 ? points : null;
}

function polygon(value: unknown): Coordinate[][] | null {
  if (!Array.isArray(value)) return null;
  const rings: Coordinate[][] = [];
  for (const item of value) {
    const ring = closeRing(item);
    if (!ring) return null;
    rings.push(ring);
  }
  return rings.length > 0 ? rings : null;
}

function asGeometry(value: SourceFeature["geometry"]): NormalizedGeometry | null {
  if (!value || typeof value.type !== "string") return null;
  switch (value.type) {
    case "Point": {
      const point = coordinate(value.coordinates);
      return point ? { type: "Point", coordinates: point } : null;
    }
    case "LineString": {
      const points = line(value.coordinates);
      return points ? { type: "LineString", coordinates: points } : null;
    }
    case "MultiLineString": {
      if (!Array.isArray(value.coordinates)) return null;
      const lines = value.coordinates.map(line);
      return lines.every((candidate): candidate is Coordinate[] => candidate !== null)
        ? { type: "MultiLineString", coordinates: lines }
        : null;
    }
    case "Polygon": {
      const rings = polygon(value.coordinates);
      return rings ? { type: "Polygon", coordinates: rings } : null;
    }
    case "MultiPolygon": {
      if (!Array.isArray(value.coordinates)) return null;
      const polygons = value.coordinates.map(polygon);
      return polygons.every((candidate): candidate is Coordinate[][] => candidate !== null)
        ? { type: "MultiPolygon", coordinates: polygons }
        : null;
    }
    default:
      return null;
  }
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

function ringContribution(ring: Coordinate[]): { area: number; centroid: Coordinate } {
  if (ring.length < 3) return { area: 0, centroid: [0, 0] };
  let signedArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index]!;
    const second = ring[(index + 1) % ring.length]!;
    const cross = first[0] * second[1] - second[0] * first[1];
    signedArea += cross;
    x += (first[0] + second[0]) * cross;
    y += (first[1] + second[1]) * cross;
  }
  signedArea /= 2;
  const area = Math.abs(signedArea);
  if (area <= 1e-9) {
    const sum = ring.reduce<Coordinate>((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
    return { area: 0, centroid: [sum[0] / ring.length, sum[1] / ring.length] };
  }
  return { area, centroid: [x / (6 * signedArea), y / (6 * signedArea)] };
}

function areaAnchor(rings: Coordinate[][]): Coordinate {
  const outer = rings[0];
  if (!outer) throw new Error("BD TOPO polygon has no exterior ring");
  const outerContribution = ringContribution(outer);
  let weight = outerContribution.area;
  let x = outerContribution.centroid[0] * weight;
  let y = outerContribution.centroid[1] * weight;
  for (const hole of rings.slice(1)) {
    const contribution = ringContribution(hole);
    weight -= contribution.area;
    x -= contribution.centroid[0] * contribution.area;
    y -= contribution.centroid[1] * contribution.area;
  }
  return weight > 1e-9 ? [x / weight, y / weight] : outerContribution.centroid;
}

export function geometryAnchor(geometry: NormalizedGeometry): Coordinate {
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
  if (geometry.type === "Polygon") return areaAnchor(geometry.coordinates);
  let totalArea = 0;
  let x = 0;
  let y = 0;
  for (const polygon of geometry.coordinates) {
    const anchor = areaAnchor(polygon);
    const outer = polygon[0];
    if (!outer) continue;
    const outerArea = ringContribution(outer).area;
    const holeArea = polygon.slice(1).reduce((sum, hole) => sum + ringContribution(hole).area, 0);
    const area = Math.max(0, outerArea - holeArea);
    totalArea += area;
    x += anchor[0] * area;
    y += anchor[1] * area;
  }
  if (totalArea <= 1e-9) return geometry.coordinates[0]?.[0]?.[0] ?? [0, 0];
  return [x / totalArea, y / totalArea];
}

function localize(geometry: NormalizedGeometry): NormalizedGeometry | null {
  const mapPoint = (point: Coordinate): Coordinate => wgs84ToRender(point);
  if (geometry.type === "Point") return { type: "Point", coordinates: mapPoint(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(mapPoint) };
  if (geometry.type === "MultiLineString") return { type: "MultiLineString", coordinates: geometry.coordinates.map((points) => points.map(mapPoint)) };
  if (geometry.type === "Polygon") return normalizePolygonGeometry({ type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(mapPoint)) }) as NormalizedGeometry | null;
  return normalizePolygonGeometry({ type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(mapPoint))) }) as NormalizedGeometry | null;
}

function clipToBoundary(geometry: NormalizedGeometry, boundaries: PolygonGeometry[], boundaryIndex: BoundaryIndex): NormalizedGeometry | null {
  if (geometry.type === "Point") return boundaryIndex.contains(geometry.coordinates) ? geometry : null;
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const sourceLines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    if (sourceLines.every((points) => boundaryIndex.lineInside(points))) return geometry;
    if (sourceLines.every((points) => boundaryIndex.lineOutside(points))) return null;
    const clipped = sourceLines.flatMap((points) => boundaries.flatMap((boundary) => clipLineStringToPolygon(points, boundary)));
    if (clipped.length === 0) return null;
    return clipped.length === 1 ? { type: "LineString", coordinates: clipped[0]! } : { type: "MultiLineString", coordinates: clipped };
  }
  const sourcePolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (sourcePolygons.every((rings) => boundaryIndex.polygonInside(rings))) return geometry;
  if (sourcePolygons.every((rings) => boundaryIndex.polygonOutside(rings))) return null;
  const clipped: Coordinate[][][] = [];
  for (const rings of sourcePolygons) {
    for (const boundary of boundaries) {
      const intersection = clipPolygonToPolygon({ type: "Polygon", coordinates: rings }, boundary);
      if (!intersection) continue;
      if (intersection.type === "Polygon") clipped.push(intersection.coordinates);
      else clipped.push(...intersection.coordinates);
    }
  }
  if (clipped.length === 0) return null;
  return clipped.length === 1 ? { type: "Polygon", coordinates: clipped[0]! } : { type: "MultiPolygon", coordinates: clipped };
}

function metadata(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

function roadClass(nature: string | undefined): string {
  const normalized = nature?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (normalized === "type autoroutier") return "motorway";
  if (normalized === "route a 2 chaussees") return "trunk";
  if (normalized === "route a 1 chaussee" || normalized === "bretelle") return "secondary";
  if (normalized === "rond-point") return "tertiary";
  if (normalized === "chemin" || normalized === "route empierree") return "track";
  if (normalized === "sentier" || normalized === "escalier") return "path";
  return "unclassified";
}

function sourceLayerName(value: unknown): "building" | "road" | "water-surface" | "water-line" | null {
  const layer = text(value)?.toLowerCase();
  if (layer === "bdtopo-buildings.geojson") return "building";
  if (layer === "bdtopo-roads.geojson") return "road";
  if (layer === "bdtopo-water-surfaces.geojson") return "water-surface";
  if (layer === "bdtopo-water-lines.geojson") return "water-line";
  return null;
}

export function normalizeBdtopo(sourceFeatures: Record<string, unknown>[], boundaryPolygons: number[][][][]): MapFeature[] {
  const boundaries: PolygonGeometry[] = boundaryPolygons.map((coordinates) => ({ type: "Polygon", coordinates: coordinates as Coordinate[][] }));
  const boundaryIndex = createBoundaryIndex(boundaryPolygons as Coordinate[][][][]);
  const result: MapFeature[] = [];
  for (const candidate of sourceFeatures as SourceFeature[]) {
    const layer = sourceLayerName(candidate.sourceLayer);
    if (!layer) continue;
    const sourceGeometry = asGeometry(candidate.geometry);
    if (!sourceGeometry) continue;
    const clipped = clipToBoundary(sourceGeometry, boundaries, boundaryIndex);
    if (!clipped) continue;
    const localGeometry = localize(clipped);
    if (!localGeometry) continue;
    const localAnchor = geometryAnchor(localGeometry);
    const [lon, lat] = renderToWgs84(localAnchor);
    const properties = candidate.properties ?? {};
    const sourceId = text(properties.cleabs);
    if (!sourceId) continue;
    const stableId = `ign-bdtopo:${layer}/${sourceId}`;
    const featureName = layer === "road"
      ? text(properties.nom_voie_ban_gauche) ?? text(properties.nom_voie_ban_droite)
      : layer === "water-line"
        ? text(properties.cpx_toponyme_de_cours_d_eau) ?? text(properties.cpx_toponyme_d_entite_de_transition)
        : text(properties.cpx_toponyme_de_plan_d_eau) ?? text(properties.cpx_toponyme_de_cours_d_eau);
    const common = {
      stableId,
      sourceId,
      name: featureName,
      lon,
      lat,
      x: localAnchor[0],
      z: localAnchor[1],
      geometry: clipped,
      localGeometry,
      confidence: "high" as const,
      status: "active" as const,
      provenance: [{ featureId: stableId, property: "geometry", winner: SOURCE_NAME, contenders: [SOURCE_NAME], priority: 100, timestamp: SOURCE_TIMESTAMP }],
      sourceRefs: [{ source: SOURCE_NAME, url: SOURCE_URL, timestamp: SOURCE_TIMESTAMP, license: "Licence Ouverte / Open Licence 2.0" }],
    };
    if (layer === "building") {
      const height = numeric(properties.hauteur);
      const levels = typeof properties.nombre_d_etages === "number" && Number.isInteger(properties.nombre_d_etages) && properties.nombre_d_etages >= 0
        ? properties.nombre_d_etages
        : undefined;
      const feature: BuildingFeature = {
        ...common,
        kind: "building",
        height,
        heightSource: height === undefined ? undefined : "explicit",
        levels,
        buildingType: text(properties.nature),
        sourceMetadata: metadata({
          layer: "batiment",
          officialId: sourceId,
          nature: properties.nature,
          usage1: properties.usage_1,
          usage2: properties.usage_2,
          height: properties.hauteur,
          floors: properties.nombre_d_etages,
        }),
      };
      result.push(feature);
      continue;
    }
    if (layer === "road") {
      const position = text(properties.position_par_rapport_au_sol);
      const bridge = position === "1";
      const tunnel = position === "-1";
      const width = numeric(properties.largeur_de_chaussee);
      const feature: RoadFeature = {
        ...common,
        kind: "road",
        highway: roadClass(text(properties.nature)),
        roadClass: roadClass(text(properties.nature)),
        width,
        widthInferred: width === undefined,
        widthSource: width === undefined ? "inferred_default" : "explicit",
        bridge,
        tunnel,
        stratum: tunnel ? "tunnel" : bridge ? "bridge" : "normal",
        layer: position,
        sourceMetadata: metadata({
          layer: "troncon_de_route",
          officialId: sourceId,
          nature: properties.nature,
          importance: properties.importance,
          positionParRapportAuSol: position,
          fictif: parseBdBoolean(properties.fictif),
          width: properties.largeur_de_chaussee,
          namesLeft: properties.nom_voie_ban_gauche,
          namesRight: properties.nom_voie_ban_droite,
        }),
      };
      result.push(feature);
      continue;
    }
    const fictiveAxis = layer === "water-line" ? parseBdBoolean(properties.fictif) === true : false;
    const feature: WaterFeature = {
      ...common,
      kind: "water",
      waterType: text(properties.nature),
      width: undefined,
      widthInferred: layer === "water-line",
      fictiveAxis,
      isSurface: layer === "water-surface",
      sourceMetadata: metadata({
        layer: layer === "water-surface" ? "surface_hydrographique" : "troncon_hydrographique",
        officialId: sourceId,
        nature: properties.nature,
        fictif: parseBdBoolean(properties.fictif),
        widthClass: properties.classe_de_largeur,
        positionParRapportAuSol: properties.position_par_rapport_au_sol,
        persistence: properties.persistance,
      }),
    };
    result.push(feature);
  }
  return result;
}
