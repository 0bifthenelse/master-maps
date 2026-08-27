import { renderToWgs84, wgs84ToRender } from "../../src/lib/geo/crs";
import { clipLineStringToPolygon, clipPolygonToPolygon, normalizePolygonGeometry, type PolygonGeometry } from "../../src/lib/geo/polygon";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";
import type { Geometry, MapFeature } from "../../src/lib/data/schema";

export interface BulkBoundary {
  polygons: PolygonGeometry[];
  index: BoundaryIndex;
}

type Coordinate = [number, number];
type AreaGeometry = Extract<Geometry, { type: "Polygon" | "MultiPolygon" }>;

const ENRICHMENT_HIGHWAYS = new Set([
  "path", "footway", "cycleway", "bridleway", "track", "pedestrian", "steps", "corridor", "via_ferrata",
]);
const SOURCE_URL = "https://download.geofabrik.de/europe/france/midi-pyrenees.html";
const SOURCE_TIMESTAMP = new Date().toISOString();

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
  return text(raw.id) ?? text(properties["@id"]) ?? text(properties.osm_id);
}

function isNamedPoi(properties: Record<string, unknown>): boolean {
  return text(properties.name) !== undefined
    && ["amenity", "shop", "tourism", "historic", "office", "craft", "leisure", "public_transport", "railway", "building", "place"].some((key) => text(properties[key]) !== undefined);
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
export function normalizeOsmBulk(features: Record<string, unknown>[], boundary?: BulkBoundary): MapFeature[] {
  const result: MapFeature[] = [];
  for (const raw of features) {
    const sourceGeometry = parseGeometry(raw.geometry);

    const properties = record(raw.properties) ? raw.properties : {};
    if (!sourceGeometry) continue;
    const highway = text(properties.highway);
    const namedRoad = highway !== undefined && text(properties.name) !== undefined;
    const isRoad = highway !== undefined && (ENRICHMENT_HIGHWAYS.has(highway) || namedRoad);
    const isPoi = isNamedPoi(properties);
    if (!isRoad && !isPoi) continue;
    const sourceId = stableSourceId(raw, properties);
    if (!sourceId) continue;
    const clipToBoundary = (): Geometry | null => {
      if (!boundary) return sourceGeometry;
      if (sourceGeometry.type === "Point") return boundary.index.contains(sourceGeometry.coordinates) ? sourceGeometry : null;
      if (sourceGeometry.type === "LineString" || sourceGeometry.type === "MultiLineString") {
        const vertices = sourceGeometry.type === "LineString" ? sourceGeometry.coordinates : sourceGeometry.coordinates.flat();
        if (!boundary.index.touches(vertices)) return null;
        const lines = (sourceGeometry.type === "LineString" ? [sourceGeometry.coordinates] : sourceGeometry.coordinates)
          .flatMap((line) => boundary.polygons.flatMap((polygon) => clipLineStringToPolygon(line, polygon)));
        if (lines.length === 0) return null;
        return lines.length === 1 ? { type: "LineString", coordinates: lines[0]! } : { type: "MultiLineString", coordinates: lines };
      }
      const rings = sourceGeometry.type === "Polygon" ? [sourceGeometry.coordinates] : sourceGeometry.coordinates;
      const polygons = rings.flatMap((coordinates) => boundary.polygons.flatMap((polygon) => {
        const clipped = clipPolygonToPolygon({ type: "Polygon", coordinates }, polygon);
        if (!clipped) return [];
        return clipped.type === "Polygon" ? [clipped.coordinates] : clipped.coordinates;
      }));
      if (polygons.length === 0) return null;
      return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0]! } : { type: "MultiPolygon", coordinates: polygons };
    };
    const effectiveSourceGeometry = clipToBoundary();
    if (!effectiveSourceGeometry) continue;
    const localSourceGeometry = localize(effectiveSourceGeometry);
    if (!localSourceGeometry) continue;
    const localAnchor = geometryAnchor(localSourceGeometry);
    const anchor = effectiveSourceGeometry.type === "Point" ? effectiveSourceGeometry.coordinates : renderToWgs84(localAnchor);
    const stableId = `osm-bulk:${sourceId}`;
    const reference = { source: "osm-bulk", url: sourceObjectUrl(sourceId) ?? SOURCE_URL, timestamp: SOURCE_TIMESTAMP, license: "ODbL-1.0" };
    const common = {
      stableId,
      sourceId,
      name: text(properties.name),
      lon: anchor[0],
      lat: anchor[1],
      x: localAnchor[0],
      z: localAnchor[1],
      confidence: "medium" as const,
      status: "active" as const,
      sourceRefs: [reference],
      provenance: [{ featureId: stableId, property: "geometry", winner: "osm-bulk", contenders: ["osm-bulk"], priority: 60, timestamp: SOURCE_TIMESTAMP }],
      sourceMetadata: metadata({ sourceId, sourceObjectUrl: sourceObjectUrl(sourceId), enrichmentOnly: namedRoad && !ENRICHMENT_HIGHWAYS.has(highway ?? ""), tags: properties["@id"], highway, amenity: properties.amenity, shop: properties.shop, tourism: properties.tourism }),
    };
    if (isRoad && localSourceGeometry.type !== "Point") {
      const width = parseWidth(properties.width);
      const bridge = parseBoolean(properties.bridge);
      const tunnel = parseBoolean(properties.tunnel);
      const layer = text(properties.layer);
      result.push({
        ...common,
        kind: "road",
        geometry: effectiveSourceGeometry,
        localGeometry: localSourceGeometry,
        highway,
        roadClass: highway,
        width,
        widthInferred: width === undefined,
        widthSource: width === undefined ? "inferred_default" : "explicit",
        bridge,
        tunnel,
        stratum: tunnel ? "tunnel" : bridge ? "bridge" : "normal",
        layer,
      });
      continue;
    }
    const poiGeometry = { type: "Point", coordinates: anchor } as const;
    const poiLocal = { type: "Point", coordinates: localAnchor } as const;
    result.push({
      ...common,
      kind: "poi",
      geometry: poiGeometry,
      sourceGeometry,
      localGeometry: poiLocal,
      poiType: text(properties.place) ?? text(properties.amenity) ?? text(properties.shop) ?? text(properties.tourism) ?? text(properties.historic) ?? text(properties.railway) ?? "poi",
      category: text(properties.amenity) ?? text(properties.shop) ?? text(properties.tourism) ?? text(properties.place),
      website: text(properties.website) ?? text(properties["contact:website"]),
      phone: text(properties.phone) ?? text(properties["contact:phone"]),
      openingHours: text(properties.opening_hours),
      operator: text(properties.operator),
    });
  }
  return result;
}
