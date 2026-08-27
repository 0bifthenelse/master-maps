import type { LocalProjection } from "@/lib/geo/projection";
import {
  clipLineStringToPolygon,
  clipPolygonToPolygon,
  pointInGeometry,
} from "@/lib/geo/polygon";
import {
  GeometrySchema,
  MapFeatureSchema,
  SourceReferenceSchema,
  type Geometry,
  type MapFeature,
  type SourceReference,
} from "./schema";

export type { Geometry, SourceReference } from "./schema";

export function clipToBoundary(geometry: Geometry, boundary: Geometry): Geometry | null {
  const boundaries = boundary.type === "Polygon"
    ? [boundary]
    : boundary.type === "MultiPolygon"
      ? boundary.coordinates.map((coordinates) => ({ type: "Polygon" as const, coordinates }))
      : [];
  if (boundaries.length === 0) throw new Error("Boundary must be a Polygon or MultiPolygon");

  if (geometry.type === "Point") {
    return boundaries.some((polygon) => pointInGeometry(geometry.coordinates, polygon)) ? geometry : null;
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const lines = (geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates)
      .flatMap((line) => boundaries.flatMap((polygon) => clipLineStringToPolygon(line, polygon)));
    if (lines.length === 0) return null;
    return GeometrySchema.parse(lines.length === 1 ? { type: "LineString", coordinates: lines[0] } : { type: "MultiLineString", coordinates: lines });
  }

  const subjects = geometry.type === "Polygon"
    ? [geometry.coordinates]
    : geometry.coordinates;
  const clippedPolygons = subjects.flatMap((coordinates) => boundaries.flatMap((polygon) => {
    const clipped = clipPolygonToPolygon({ type: "Polygon", coordinates }, polygon);
    if (!clipped) return [];
    return clipped.type === "Polygon" ? [clipped.coordinates] : clipped.coordinates;
  }));
  if (clippedPolygons.length === 0) return null;
  return GeometrySchema.parse(clippedPolygons.length === 1
    ? { type: "Polygon", coordinates: clippedPolygons[0] }
    : { type: "MultiPolygon", coordinates: clippedPolygons });
}

export function deriveLocalCoords(geometry: Geometry, projection: LocalProjection): Geometry {
  const mapPoint = ([longitude, latitude]: [number, number]): [number, number] => projection.forward(longitude, latitude);
  if (geometry.type === "Point") return { type: "Point", coordinates: mapPoint(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(mapPoint) };
  if (geometry.type === "MultiLineString") return { type: "MultiLineString", coordinates: geometry.coordinates.map((line) => line.map(mapPoint)) };
  if (geometry.type === "Polygon") return { type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(mapPoint)) };
  return { type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(mapPoint))) };
}

function recordText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function recordTags(record: Record<string, unknown>): Record<string, unknown> {
  return typeof record.tags === "object" && record.tags !== null ? record.tags as Record<string, unknown> : {};
}

function geometryFromRecord(record: Record<string, unknown>): Geometry | null {
  const geometry = record.geometry;
  if (typeof geometry !== "object" || geometry === null) return null;
  const parsed = GeometrySchema.safeParse(geometry);
  return parsed.success ? parsed.data : null;
}

function sourceReference(source: SourceReference): SourceReference {
  return SourceReferenceSchema.parse(source);
}

function sourceId(record: Record<string, unknown>, fallback: string): string {
  return recordText(record, "id") ?? recordText(record, "siret") ?? fallback;
}

export function normalizeWater(
  raw: Record<string, unknown>,
  source: SourceReference,
  boundary?: Geometry,
  projection?: LocalProjection,
): MapFeature | null {
  const sourceGeometry = geometryFromRecord(raw);
  if (!sourceGeometry) return null;
  const geometry = boundary ? clipToBoundary(sourceGeometry, boundary) : sourceGeometry;
  if (!geometry) return null;
  const tags = recordTags(raw);
  const rawType = recordText(tags, "waterway") ?? recordText(tags, "natural") ?? "water";
  const isSurface = geometry.type === "Polygon" || geometry.type === "MultiPolygon";
  const stableId = `${source.source}:${sourceId(raw, rawType)}`;
  return MapFeatureSchema.parse({
    kind: "water",
    stableId,
    sourceId: sourceId(raw, stableId),
    geometry,
    localGeometry: projection ? deriveLocalCoords(geometry, projection) : undefined,
    name: recordText(tags, "name"),
    waterType: rawType,
    width: isSurface ? undefined : rawType === "river" ? 10 : rawType === "stream" ? 3 : 2,
    widthInferred: !isSurface,
    isSurface,
    confidence: "medium",
    sourceRefs: [sourceReference(source)],
  });
}

export function normalizeBusiness(
  record: Record<string, unknown>,
  source: SourceReference,
  boundary?: Geometry,
): MapFeature | null {
  const longitude = Number(record.longitude);
  const latitude = Number(record.latitude);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const geometry: Geometry = { type: "Point", coordinates: [longitude, latitude] };
  if (boundary && !clipToBoundary(geometry, boundary)) return null;
  const businessName = recordText(record, "enseigne1")
    ?? recordText(record, "denominationUniteLegale")
    ?? recordText(record, "denomination")
    ?? recordText(record, "siret")
    ?? "Unnamed business";
  const street = [recordText(record, "numeroVoie"), recordText(record, "typeVoie"), recordText(record, "libelleVoie")].filter(Boolean).join(" ");
  const postcode = recordText(record, "codePostal");
  const city = recordText(record, "libelleCommune");
  const address = [street, [postcode, city].filter(Boolean).join(", ")].filter(Boolean).join(", ");
  const siret = recordText(record, "siret");
  const stableId = `${source.source}:${sourceId(record, siret ?? businessName)}`;
  return MapFeatureSchema.parse({
    kind: "business",
    stableId,
    sourceId: sourceId(record, stableId),
    geometry,
    lon: longitude,
    lat: latitude,
    businessName,
    legalName: recordText(record, "denominationUniteLegale") ?? recordText(record, "denomination"),
    siret,
    siren: recordText(record, "siren"),
    category: recordText(record, "libelleActivitePrincipale"),
    address: address || undefined,
    sourceRefs: [sourceReference(source)],
    confidence: "medium",
  });
}

