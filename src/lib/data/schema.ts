// ---------------------------------------------------------------------------
// Master Maps canonical schemas for the Gers department dataset.
//
// All normalized features, manifest entries, coverage reports, and focus
// records are validated through these schemas before storage.
//
// Zod 4.4.3 — self‑contained; does NOT import src/types/map.ts.
// Inferred TypeScript types are exported alongside each schema.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ===========================================================================
// Coordinate & Geometry (WGS84 / local projected)
// ===========================================================================

/** [longitude, latitude] or local [x, z]. y=0 always for visible geometry. */
export const CoordinateSchema = z.tuple([z.number(), z.number()]);
export type Coordinate = z.infer<typeof CoordinateSchema>;

/** Closed exterior ring or hole ring: [[lng,lat], …] (minimum 4 for valid ring) */
export const RingSchema = z.array(CoordinateSchema).min(1);
export type Ring = z.infer<typeof RingSchema>;

// ---- GeoJSON geometry types (discriminated union) ----

export const PointSchema = z
  .object({
    type: z.literal("Point"),
    coordinates: CoordinateSchema,
  })
  .strict();
export type PointGeometry = z.infer<typeof PointSchema>;

export const LineStringSchema = z
  .object({
    type: z.literal("LineString"),
    coordinates: z.array(CoordinateSchema).min(2),
  })
  .strict();
export type LineStringGeometry = z.infer<typeof LineStringSchema>;
export const MultiLineStringSchema = z
  .object({
    type: z.literal("MultiLineString"),
    coordinates: z.array(z.array(CoordinateSchema).min(2)).min(1),
  })
  .strict();
export type MultiLineStringGeometry = z.infer<typeof MultiLineStringSchema>;

export const PolygonSchema = z
  .object({
    type: z.literal("Polygon"),
    coordinates: z.array(RingSchema),
  })
  .strict();
export type PolygonGeometry = z.infer<typeof PolygonSchema>;

export const MultiPolygonSchema = z
  .object({
    type: z.literal("MultiPolygon"),
    coordinates: z.array(z.array(RingSchema)),
  })
  .strict();
export type MultiPolygonGeometry = z.infer<typeof MultiPolygonSchema>;

export const GeometrySchema = z.discriminatedUnion("type", [
  PointSchema,
  LineStringSchema,
  MultiLineStringSchema,
  PolygonSchema,
  MultiPolygonSchema,
]);
export type Geometry = z.infer<typeof GeometrySchema>;

// WGS84 bounding box [west, south, east, north]
export const BboxSchema = z.tuple([
  z.number(), // west
  z.number(), // south
  z.number(), // east
  z.number(), // north
]);
export type Bbox = z.infer<typeof BboxSchema>;

// ===========================================================================
// Enums
// ===========================================================================

export const FeatureStatusEnum = z.enum([
  "active",
  "uncertain",
  "inferred",
  "unresolved",
]);
export type FeatureStatus = z.infer<typeof FeatureStatusEnum>;

export const FeatureConfidenceEnum = z.enum(["high", "medium", "low"]);
export type FeatureConfidence = z.infer<typeof FeatureConfidenceEnum>;

export const HeightSourceEnum = z.enum([
  "explicit",
  "inferred_from_levels",
  "inferred_default",
]);
export type HeightSource = z.infer<typeof HeightSourceEnum>;

export const RoadSurfaceEnum = z.enum([
  "paved",
  "unpaved",
  "asphalt",
  "concrete",
  "cobblestone",
  "gravel",
  "dirt",
  "grass",
  "ground",
]);

// ===========================================================================
// Source & Provenance
// ===========================================================================

export const SourceReferenceSchema = z
  .object({
    source: z.string().min(1),
    url: z.string().optional(),
    timestamp: z.string(), // ISO 8601 UTC
    license: z.string().optional(),
    sha256: z.string().optional(),
    recordCount: z.number().int().nonnegative().optional(),
  })
  .strict();
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const ProvenanceRecordSchema = z
  .object({
    featureId: z.string().min(1),
    property: z.string().min(1),
    winner: z.string().min(1),
    contenders: z.array(z.string().min(1)).min(1),
    priority: z.number().int().positive(),
    timestamp: z.string(), // ISO 8601 UTC
  })
  .strict();
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

// ===========================================================================
// Common feature fields
// ===========================================================================

export const FeatureBaseSchema = z.object({
  stableId: z.string().min(1),
  geometry: GeometrySchema,
  sourceId: z.string().optional(),
  name: z.string().optional(),
  lon: z.number().optional(),
  lat: z.number().optional(),
  x: z.number().optional(),
  z: z.number().optional(),
  localGeometry: GeometrySchema.optional(),
  sourceGeometry: GeometrySchema.optional(),
  names: z.array(z.string()).default([]),
  displayName: z.string().optional(),
  address: z.string().optional(),
  confidence: FeatureConfidenceEnum.default("medium"),
  status: FeatureStatusEnum.default("active"),
  provenance: z.array(ProvenanceRecordSchema).default([]),
  sourceRefs: z.array(SourceReferenceSchema).default([]),
});
export const BoundaryFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("boundary"),
  territoryCode: z.string().min(1),
  geometry: z.union([PolygonSchema, MultiPolygonSchema]),
}).strict();
export type BoundaryFeature = z.infer<typeof BoundaryFeatureSchema>;


// ===========================================================================
// Per‑feature kind schemas
// ===========================================================================

export const BuildingFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("building"),
  height: z.number().nonnegative().optional(),
  heightInferred: z.boolean().optional(),
  levels: z.number().int().nonnegative().optional(),
  heightSource: HeightSourceEnum.optional(),
  buildingType: z.string().optional(),
  roofType: z.string().optional(),
  wallType: z.string().optional(),
  buildingLevels: z.number().int().nonnegative().optional(),
  buildingColour: z.string().optional(),
  roofColour: z.string().optional(),
  startDate: z.string().optional(),
  yearConstructed: z.number().int().optional(),
}).strict();
export type BuildingFeature = z.infer<typeof BuildingFeatureSchema>;

export const RoadFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("road"),
  highway: z.string().optional(),
  roadClass: z.string().optional(),
  width: z.number().nonnegative().optional(),
  widthInferred: z.boolean().optional(),
  widthSource: HeightSourceEnum.optional(),
  surface: RoadSurfaceEnum.or(z.string()).optional(),
  bridge: z.boolean().optional(),
  tunnel: z.boolean().optional(),
  maxSpeed: z.number().int().nonnegative().optional(),
  layer: z.string().optional(),
  oneway: z.boolean().optional(),
  lit: z.boolean().optional(),
  sidewalk: z.string().optional(),
}).strict();
export type RoadFeature = z.infer<typeof RoadFeatureSchema>;

export const WaterFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("water"),
  waterType: z.string().optional(),
  intermittent: z.boolean().optional(),
  width: z.number().nonnegative().optional(),
  widthInferred: z.boolean().optional(),
  tidal: z.boolean().optional(),
  salt: z.enum(["yes", "no"]).optional(),
}).strict();
export type WaterFeature = z.infer<typeof WaterFeatureSchema>;

export const LanduseFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("landuse"),
  landuseType: z.string().min(1),
  area: z.number().nonnegative().optional(),
}).strict();
export type LanduseFeature = z.infer<typeof LanduseFeatureSchema>;

export const PoiFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("poi"),
  poiType: z.string().min(1),
  category: z.string().optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  openingHours: z.string().optional(),
  wheelchair: z.string().optional(),
  operator: z.string().optional(),
}).strict();
export type PoiFeature = z.infer<typeof PoiFeatureSchema>;

export const BusinessFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("business"),
  businessName: z.string().min(1),
  poiType: z.string().optional(),
  category: z.string().optional(),
  siret: z.string().optional(),
  siren: z.string().optional(),
  businessId: z.string().optional(),
  brand: z.string().optional(),
  legalName: z.string().optional(),
  website: z.string().optional(),
  phone: z.string().optional(),
  openingHours: z.string().optional(),
  operator: z.string().optional(),
  wheelchair: z.string().optional(),
  nafCode: z.string().optional(),
  nafLabel: z.string().optional(),
  administrativeStatus: z.string().optional(),
  creationDate: z.string().optional(),
}).strict();
export type BusinessFeature = z.infer<typeof BusinessFeatureSchema>;

export const AddressFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("address"),
  street: z.string().min(1),
  housenumber: z.string().optional(),
  postcode: z.string().optional(),
  city: z.string().optional(),
  source: z.string().optional(),
  banId: z.string().optional(),
}).strict();
export type AddressFeature = z.infer<typeof AddressFeatureSchema>;

export const TransportFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("transport"),
  transportType: z.string().min(1),
  line: z.string().optional(),
  network: z.string().optional(),
  operator: z.string().optional(),
  ref: z.string().optional(),
  publicTransport: z.string().optional(),
  wheelchair: z.string().optional(),
}).strict();
export type TransportFeature = z.infer<typeof TransportFeatureSchema>;

// ===========================================================================
// MapFeature — discriminated union over 'kind'
// ===========================================================================

export const MapFeatureSchema = z.discriminatedUnion("kind", [
  BoundaryFeatureSchema,
  BuildingFeatureSchema,
  RoadFeatureSchema,
  WaterFeatureSchema,
  LanduseFeatureSchema,
  PoiFeatureSchema,
  BusinessFeatureSchema,
  AddressFeatureSchema,
  TransportFeatureSchema,
]);
export type MapFeature = z.infer<typeof MapFeatureSchema>;

// ===========================================================================
// Tile manifest
// ===========================================================================

export const TileManifestSchema = z
  .object({
    tileId: z.string().min(1),
    lod: z.number().int().nonnegative().default(0),
    bounds: z.tuple([
      z.number(), // minX
      z.number(), // minY
      z.number(), // maxX
      z.number(), // maxY
    ]),
    featureCount: z.number().int().nonnegative(),
    byteSize: z.number().int().nonnegative(),
    features: z.array(z.string().min(1)),
    fragmentOf: z.string().optional(),
    geometryBounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })
  .strict();
export type TileManifest = z.infer<typeof TileManifestSchema>;

export const TileDataSchema = z
  .object({
    manifest: TileManifestSchema,
    features: z.array(MapFeatureSchema),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type TileData = z.infer<typeof TileDataSchema>;

// ===========================================================================
// Coverage report
// ===========================================================================

export const CoverageReportSchema = z
  .object({
    datasetVersion: z.string().min(1),
    acquisitionTime: z.string(), // ISO 8601 UTC
    boundary: BboxSchema,
    projectionOrigin: CoordinateSchema,
    tileSize: z.number().positive(),
    tileCount: z.number().int().nonnegative(),
    featureCounts: z.record(z.string(), z.number().int().nonnegative()),
    sourceCounts: z.record(z.string(), z.number().int().nonnegative()),
    unresolved: z
      .array(
        z.object({
          category: z.string(),
          description: z.string(),
        })
      )
      .default([]),
    failedSources: z
      .array(
        z.object({
          name: z.string(),
          url: z.string().optional(),
          error: z.string().optional(),
        })
      )
      .default([]),
    budgets: z
      .object({
        tileBudgetBytes: z.number().int().nonnegative(),
        maxTileBytes: z.number().int().nonnegative(),
        totalTileCount: z.number().int().nonnegative(),
        passes: z.boolean(),
        largestTileBytes: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .strict();
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

// ===========================================================================
// Generated dataset manifest (top-level)
// ===========================================================================

export const DatasetManifestSchema = z
  .object({
    datasetVersion: z.string().min(1),
    acquisitionTime: z.string(),
    territoryCode: z.string().default("32"),
    territoryName: z.string().default("Gers"),
    interchangeCrs: z.string().default("EPSG:4326"),
    processingCrs: z.string().default("EPSG:2154"),
    renderOrigin: CoordinateSchema.optional(),
    boundary: BboxSchema,
    projectionOrigin: CoordinateSchema,
    tileSize: z.number().positive(),
    tileBounds: z.array(BboxSchema).optional(),
    lods: z.array(
      z.object({
        level: z.number().int().nonnegative(),
        tileSize: z.number().positive(),
        tileCount: z.number().int().nonnegative(),
      }).strict(),
    ).optional(),
    featureCounts: z.record(z.string(), z.number().int().nonnegative()),
    byteSizes: z.record(z.string(), z.number().int().nonnegative()).optional(),
    layerAvailability: z.record(z.string(), z.boolean()).optional(),
    nocibeFocus: z
      .object({
        name: z.string(),
        searchKey: z.string(),
        banId: z.string().optional(),
        address: z.string(),
        coord: CoordinateSchema,
        sourceRefs: z.array(SourceReferenceSchema),
        confidence: FeatureConfidenceEnum,
        status: FeatureStatusEnum,
        anchors: z.array(
          z.object({
            name: z.string(),
            coord: CoordinateSchema,
          })
        ),
      })
      .optional(),
  })
  .strict();
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;

// ===========================================================================
// Nocibé focus object (standalone schema for search / overlay)
// ===========================================================================

export const NocibeFocusSchema = z
  .object({
    name: z.string().min(1),
    searchKey: z.string().min(1),
    banId: z.string().optional(),
    address: z.string().min(1),
    coord: CoordinateSchema,
    sourceRefs: z.array(SourceReferenceSchema),
    confidence: FeatureConfidenceEnum,
    status: FeatureStatusEnum,
    anchors: z.array(
      z
        .object({
          name: z.string().min(1),
          coord: CoordinateSchema,
        })
        .strict()
    ),
  })
  .strict();
export type NocibeFocus = z.infer<typeof NocibeFocusSchema>;

// ===========================================================================
// Validation helpers
// ===========================================================================

/**
 * Check that a coordinate pair is finite and within plausible WGS84 bounds.
 * Returns validated Coordinate or throws a descriptive Zod-like error object.
 */
export function validateCoordinate(
  coord: unknown,
  label: string = "coordinate"
): Coordinate {
  const result = CoordinateSchema.safeParse(coord);
  if (!result.success) {
    throw new Error(
      `${label}: invalid coordinate — ${result.error.message}`
    );
  }
  return result.data;
}

/**
 * Check that all coordinates in a geometry are finite.
 */
export function validateGeometry(geom: unknown, label: string = "geometry"): Geometry {
  const result = GeometrySchema.safeParse(geom);
  if (!result.success) {
    throw new Error(
      `${label}: invalid geometry — ${result.error.message}`
    );
  }
  return result.data;
}

// ===========================================================================
// MapFeature helpers
// ===========================================================================

/** Discriminant keys for per‑kind feature access. */
export const FEATURE_KINDS = [
  "boundary",
  "building",
  "road",
  "water",
  "landuse",
  "poi",
  "business",
  "address",
  "transport",
] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

/**
 * Narrow a MapFeature to its specific kind.
 * Returns undefined when the feature does not match the requested kind.
 */
export function isBuildingFeature(
  feature: MapFeature
): feature is BuildingFeature {
  return feature.kind === "building";
}

export function isRoadFeature(feature: MapFeature): feature is RoadFeature {
  return feature.kind === "road";
}

export function isWaterFeature(feature: MapFeature): feature is WaterFeature {
  return feature.kind === "water";
}

export function isLanduseFeature(feature: MapFeature): feature is LanduseFeature {
  return feature.kind === "landuse";
}

export function isPoiFeature(feature: MapFeature): feature is PoiFeature {
  return feature.kind === "poi";
}

export function isBusinessFeature(feature: MapFeature): feature is BusinessFeature {
  return feature.kind === "business";
}

export function isAddressFeature(feature: MapFeature): feature is AddressFeature {
  return feature.kind === "address";
}

export function isTransportFeature(
  feature: MapFeature
): feature is TransportFeature {
  return feature.kind === "transport";
}
