import { wgs84ToRender } from "../../src/lib/geo/crs";

type Point = [number, number];
type Geometry =
  | { type: "Point"; coordinates: Point }
  | { type: "LineString"; coordinates: Point[] }
  | { type: "Polygon"; coordinates: Point[][] };

export function normalizeOsmBulk(features: Record<string, unknown>[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const raw of features) {
    const geometry = parseGeometry(raw.geometry);
    const properties = isRecord(raw.properties) ? raw.properties : {};
    if (!geometry) continue;
    const point = anchor(geometry);
    const kind = typeof properties.highway === "string" ? "road" : "poi";
    if (kind === "poi" && geometry.type !== "Point") continue;
    const [x, z] = wgs84ToRender(point);
    const sourceId = text(raw.id) ?? text(properties["@id"] ?? properties.osm_id)
      ?? `bulk-${hash(`${point[0]},${point[1]},${properties.name ?? ""}`)}`;
    const stableId = `osm:${sourceId}`;
    const sourceRef = {
      source: "osm",
      url: "https://download.geofabrik.de/europe/france/midi-pyrenees.html",
      timestamp: new Date().toISOString(),
      license: "ODbL-1.0",
    };
    const base = {
      kind,
      stableId,
      sourceId: stableId,
      name: text(properties.name),
      lon: point[0],
      lat: point[1],
      x,
      z,
      geometry,
      localGeometry: localize(geometry),
      provenance: [{ featureId: stableId, property: "geometry", winner: "osm", contenders: ["osm"], priority: 60, timestamp: sourceRef.timestamp }],
      confidence: 0.8,
      status: "active" as const,
      sourceRefs: [sourceRef],
    };
    if (kind === "road") result.push({ ...base, roadClass: text(properties.highway) ?? "path", highway: text(properties.highway), width: 2, widthInferred: true });
    else result.push({ ...base, poiType: text(properties.amenity ?? properties.shop ?? properties.tourism) ?? "poi", category: text(properties.amenity ?? properties.shop), phone: text(properties.phone), website: text(properties.website), openingHours: text(properties.opening_hours) });
  }
  return result;
}

function parseGeometry(value: unknown): Geometry | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "Point" && isPoint(value.coordinates)) return { type: "Point", coordinates: value.coordinates };
  if (value.type === "LineString" && isLine(value.coordinates)) return { type: "LineString", coordinates: value.coordinates };
  if (value.type === "Polygon" && isPolygon(value.coordinates)) return { type: "Polygon", coordinates: value.coordinates };
  return null;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function isPoint(value: unknown): value is Point { return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number"; }
function isLine(value: unknown): value is Point[] { return Array.isArray(value) && value.length >= 2 && value.every(isPoint); }
function isPolygon(value: unknown): value is Point[][] { return Array.isArray(value) && value.length > 0 && value.every(isLine); }
function anchor(geometry: Geometry): Point {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return geometry.coordinates[0]!;
  return geometry.coordinates[0]![0]!;
}
function localize(geometry: Geometry): Record<string, unknown> {
  const map = (point: Point): Point => wgs84ToRender(point);
  if (geometry.type === "Point") return { type: "Point", coordinates: map(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(map) };
  return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(map)) };
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function hash(value: string): string { let result = 2166136261; for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619); return (result >>> 0).toString(16); }
