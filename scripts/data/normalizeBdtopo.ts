import { wgs84ToRender } from "../../src/lib/geo/crs";
import { clipLineStringToPolygon, clipPolygonToPolygon } from "../../src/lib/geo/polygon";
import type { PolygonGeometry } from "../../src/lib/geo/polygon";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";

interface SourceFeature {
  type?: string;
  geometry?: { type?: string; coordinates?: unknown } | null;
  properties?: Record<string, unknown>;
  sourceLayer?: string;
}

type Coordinate = [number, number];
type NormalizedGeometry =
  | { type: "Point"; coordinates: Coordinate }
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] }
  | { type: "Polygon"; coordinates: Coordinate[][] }
  | { type: "MultiPolygon"; coordinates: Coordinate[][][] };

export function normalizeBdtopo(
  sourceFeatures: Record<string, unknown>[],
  boundaryPolygons: number[][][][],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const boundaries: PolygonGeometry[] = boundaryPolygons.map((coordinates) => ({ type: "Polygon", coordinates }));
  const boundaryIndex = createBoundaryIndex(boundaryPolygons);
  for (const candidate of sourceFeatures as SourceFeature[]) {
    const geometry = asGeometry(candidate.geometry);
    if (!geometry) continue;
    const sourceLayer = candidate.sourceLayer ?? "bdtopo";
    const clipped = clipToBoundary(geometry, boundaries, boundaryIndex);
    if (!clipped) continue;
    const anchor = geometryAnchor(clipped);
    const [x, z] = wgs84ToRender(anchor);
    const properties = candidate.properties ?? {};
    const sourceId = String(properties.cleabs ?? properties.id ?? properties.identifiant ?? "");
    if (!sourceId) continue;
    const stableId = `ign-bdtopo:${sourceLayer}/${sourceId}`;
    const featureBase = {
      stableId,
      sourceId,
      name: text(properties.nom ?? properties.name),
      lon: anchor[0],
      lat: anchor[1],
      x,
      z,
      geometry: clipped,
      localGeometry: localize(clipped),
      provenance: [{
        featureId: stableId,
        property: "geometry",
        winner: "IGN BD TOPO",
        contenders: ["IGN BD TOPO"],
        priority: 100,
        timestamp: new Date().toISOString(),
      }],
      confidence: 1,
      status: "active" as const,
      sourceRefs: [{
        source: "IGN BD TOPO",
        url: "https://geoservices.ign.fr/bdtopo",
        timestamp: new Date().toISOString(),
        license: "Licence Ouverte / Open Licence 2.0",
      }],
    };
    if (sourceLayer.includes("building")) {
      result.push({ ...featureBase, kind: "building", buildingType: text(properties.nature ?? properties.usage) });
    } else if (sourceLayer.includes("road")) {
      result.push({
        ...featureBase,
        kind: "road",
        roadClass: text(properties.nature ?? properties.classement) ?? "unclassified",
        highway: text(properties.nature ?? properties.classement) ?? "unclassified",
        width: numeric(properties.largeur ?? properties.width),
        widthInferred: numeric(properties.largeur ?? properties.width) === undefined,
        bridge: Boolean(properties.franchissement ?? properties.bridge),
        tunnel: Boolean(properties.tunnel ?? properties.souterrain),
      });
    } else if (sourceLayer.includes("water")) {
      result.push({
        ...featureBase,
        kind: "water",
        waterType: text(properties.nature ?? properties.type) ?? "water",
        width: numeric(properties.largeur ?? properties.width),
        widthInferred: numeric(properties.largeur ?? properties.width) === undefined,
        fictiveAxis: sourceLayer.includes("lines") && Boolean(properties.fictif ?? properties.fictive),
      });
    }
  }
  return result;
}

function asGeometry(value: SourceFeature["geometry"]): NormalizedGeometry | null {
  if (!value || !value.type || value.coordinates === undefined) return null;
  if (value.type === "Point" && isCoordinate(value.coordinates)) return { type: "Point", coordinates: value.coordinates };
  if (value.type === "LineString" && isLine(value.coordinates)) return { type: "LineString", coordinates: value.coordinates };
  if (value.type === "MultiLineString" && Array.isArray(value.coordinates) && value.coordinates.every(isLine)) return { type: "MultiLineString", coordinates: value.coordinates };
  if (value.type === "Polygon" && isPolygon(value.coordinates)) return { type: "Polygon", coordinates: value.coordinates };
  if (value.type === "MultiPolygon" && Array.isArray(value.coordinates) && value.coordinates.every(isPolygon)) return { type: "MultiPolygon", coordinates: value.coordinates };
  return null;
}

function isCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number";
}
function isLine(value: unknown): value is Coordinate[] {
  return Array.isArray(value) && value.length >= 2 && value.every(isCoordinate);
}
function isPolygon(value: unknown): value is Coordinate[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isLine);
}
function geometryAnchor(geometry: NormalizedGeometry): Coordinate {
  if (geometry.type === "Point") return geometry.coordinates;
  const first = geometry.type === "LineString" ? geometry.coordinates[0]
    : geometry.type === "MultiLineString" ? geometry.coordinates[0]?.[0]
      : geometry.type === "MultiPolygon" ? geometry.coordinates[0]?.[0]?.[0]
        : geometry.coordinates[0]?.[0];
  if (!first) throw new Error(`BD TOPO geometry ${geometry.type} has no anchor`);
  return first;
}
function clipToBoundary(geometry: NormalizedGeometry, boundaries: PolygonGeometry[], boundaryIndex: BoundaryIndex): NormalizedGeometry | null {
  if (geometry.type === "Point") return boundaryIndex.contains(geometry.coordinates) ? geometry : null;
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const sourceLines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    if (sourceLines.every((line) => boundaryIndex.lineInside(line))) return geometry;
    if (sourceLines.every((line) => boundaryIndex.lineOutside(line))) return null;
    const lines = boundaries.flatMap((boundary) => sourceLines.flatMap((line) => clipLineStringToPolygon(line, boundary)));
    if (lines.length === 0) return null;
    return lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines };
  }
  const sourcePolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (sourcePolygons.every((polygon) => boundaryIndex.polygonInside(polygon))) return geometry;
  if (sourcePolygons.every((polygon) => boundaryIndex.polygonOutside(polygon))) return null;
  const polygons = boundaries.flatMap((boundary) => sourcePolygons.flatMap((polygon) => {
    const clipped = clipPolygonToPolygon({ type: "Polygon", coordinates: polygon }, boundary);
    return clipped ? clipped.type === "Polygon" ? [clipped.coordinates] : clipped.coordinates : [];
  }));
  if (polygons.length === 0) return null;
  return polygons.length === 1 ? { type: "Polygon", coordinates: polygons[0] } : { type: "MultiPolygon", coordinates: polygons };
}
function localize(geometry: NormalizedGeometry): Record<string, unknown> {
  const mapPoint = (point: Coordinate): Coordinate => wgs84ToRender(point);
  if (geometry.type === "Point") return { type: "Point", coordinates: mapPoint(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(mapPoint) };
  if (geometry.type === "MultiLineString") return { type: "MultiLineString", coordinates: geometry.coordinates.map((line) => line.map(mapPoint)) };
  if (geometry.type === "Polygon") return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(mapPoint)) };
  return { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(mapPoint))) };
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function numeric(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}
