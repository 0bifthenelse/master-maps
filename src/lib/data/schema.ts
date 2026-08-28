import { z } from "zod";

const FINITE_NUMBER = z.number().finite();
const RING_EPSILON = 1e-9;
const AREA_EPSILON = 1e-16;

export const CoordinateSchema = z.tuple([FINITE_NUMBER, FINITE_NUMBER]);
export type Coordinate = z.infer<typeof CoordinateSchema>;

function signedRingArea(ring: readonly Coordinate[]): number {
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x0, y0] = ring[index]!;
    const [x1, y1] = ring[index + 1]!;
    twiceArea += x0 * y1 - x1 * y0;
  }
  return twiceArea / 2;
}

function pointInRing(point: Coordinate, ring: readonly Coordinate[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index]!;
    const prior = ring[previous]!;
    const cross = (point[1] - prior[1]) * (current[0] - prior[0]) - (point[0] - prior[0]) * (current[1] - prior[1]);
    if (Math.abs(cross) <= RING_EPSILON
      && point[0] >= Math.min(prior[0], current[0]) - RING_EPSILON
      && point[0] <= Math.max(prior[0], current[0]) + RING_EPSILON
      && point[1] >= Math.min(prior[1], current[1]) - RING_EPSILON
      && point[1] <= Math.max(prior[1], current[1]) + RING_EPSILON) return true;
    if ((current[1] > point[1]) !== (prior[1] > point[1])) {
      const x = prior[0] + ((point[1] - prior[1]) * (current[0] - prior[0])) / (current[1] - prior[1]);
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}

export const RingSchema = z.array(CoordinateSchema).min(4).superRefine((ring, ctx) => {
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) > RING_EPSILON) {
    ctx.addIssue({ code: "custom", message: "ring must be closed" });
  }
  if (Math.abs(signedRingArea(ring)) <= AREA_EPSILON) {
    ctx.addIssue({ code: "custom", message: "ring must have non-zero area" });
  }
  for (let index = 1; index < ring.length; index += 1) {
    if (ring[index]![0] === ring[index - 1]![0] && ring[index]![1] === ring[index - 1]![1]) {
      ctx.addIssue({ code: "custom", message: `ring has consecutive duplicate at ${index}` });
      break;
    }
  }
});
export type Ring = z.infer<typeof RingSchema>;

const PolygonCoordinatesSchema = z.array(RingSchema).min(1).superRefine((rings, ctx) => {
  const exterior = rings[0]!;
  const exteriorArea = Math.abs(signedRingArea(exterior));
  for (let index = 1; index < rings.length; index += 1) {
    const hole = rings[index]!;
    if (Math.abs(signedRingArea(hole)) >= exteriorArea) {
      ctx.addIssue({ code: "custom", path: [index], message: "hole area must be smaller than exterior area" });
    }
    if (!pointInRing(hole[0]!, exterior)) {
      ctx.addIssue({ code: "custom", path: [index], message: "hole must lie inside exterior ring" });
    }
  }
});

export const PointSchema = z.object({
  type: z.literal("Point"),
  coordinates: CoordinateSchema,
}).strict();
export type PointGeometry = z.infer<typeof PointSchema>;

export const LineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(CoordinateSchema).min(2),
}).strict();
export type LineStringGeometry = z.infer<typeof LineStringSchema>;

export const MultiLineStringSchema = z.object({
  type: z.literal("MultiLineString"),
  coordinates: z.array(z.array(CoordinateSchema).min(2)).min(1),
}).strict();
export type MultiLineStringGeometry = z.infer<typeof MultiLineStringSchema>;

export const PolygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: PolygonCoordinatesSchema,
}).strict();
export type PolygonGeometry = z.infer<typeof PolygonSchema>;

export const MultiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(PolygonCoordinatesSchema).min(1),
}).strict();
export type MultiPolygonGeometry = z.infer<typeof MultiPolygonSchema>;

export const GeometrySchema = z.discriminatedUnion("type", [
  PointSchema,
  LineStringSchema,
  MultiLineStringSchema,
  PolygonSchema,
  MultiPolygonSchema,
]);
export type Geometry = z.infer<typeof GeometrySchema>;

export const BboxSchema = z.tuple([
  FINITE_NUMBER,
  FINITE_NUMBER,
  FINITE_NUMBER,
  FINITE_NUMBER,
]).superRefine((bbox, ctx) => {
  if (bbox[0] > bbox[2] || bbox[1] > bbox[3]) {
    ctx.addIssue({ code: "custom", message: "bbox minimum must not exceed maximum" });
  }
});
export type Bbox = z.infer<typeof BboxSchema>;
export const LocalBoundsSchema = BboxSchema;
export type LocalBounds = Bbox;

export const FeatureStatusEnum = z.enum(["active", "uncertain", "inferred", "unresolved"]);
export type FeatureStatus = z.infer<typeof FeatureStatusEnum>;
export const FeatureConfidenceEnum = z.enum(["high", "medium", "low"]);
export type FeatureConfidence = z.infer<typeof FeatureConfidenceEnum>;
export const HeightSourceEnum = z.enum(["explicit", "inferred_from_levels", "inferred_default"]);
export type HeightSource = z.infer<typeof HeightSourceEnum>;
export const WidthSourceEnum = z.enum(["explicit", "inferred_default"]);
export type WidthSource = z.infer<typeof WidthSourceEnum>;
export const RoadSurfaceEnum = z.enum([
  "paved", "unpaved", "asphalt", "concrete", "cobblestone", "gravel", "dirt", "grass", "ground",
]);

export const SourceReferenceSchema = z.object({
  source: z.string().min(1),
  url: z.string().optional(),
  timestamp: z.string().min(1),
  license: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  recordCount: z.number().int().nonnegative().optional(),
}).strict();
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const ProvenanceRecordSchema = z.object({
  featureId: z.string().min(1),
  property: z.string().min(1),
  winner: z.string().min(1),
  contenders: z.array(z.string().min(1)).min(1),
  priority: z.number().int().positive(),
  timestamp: z.string().min(1),
}).strict();
export type ProvenanceRecord = z.infer<typeof ProvenanceRecordSchema>;

export const FeatureBaseSchema = z.object({
  stableId: z.string().min(1),
  geometry: GeometrySchema,
  sourceId: z.string().optional(),
  name: z.string().optional(),
  lon: FINITE_NUMBER.optional(),
  lat: FINITE_NUMBER.optional(),
  x: FINITE_NUMBER.optional(),
  z: FINITE_NUMBER.optional(),
  localGeometry: GeometrySchema.optional(),
  sourceGeometry: GeometrySchema.optional(),
  names: z.array(z.string()).default([]),
  displayName: z.string().optional(),
  address: z.string().optional(),
  confidence: FeatureConfidenceEnum.default("medium"),
  status: FeatureStatusEnum.default("active"),
  provenance: z.array(ProvenanceRecordSchema).default([]),
  sourceRefs: z.array(SourceReferenceSchema).default([]),
  fragmentId: z.string().min(1).optional(),
  parentStableId: z.string().min(1).optional(),
  fragmentOf: z.string().min(1).optional(),
  sourceMetadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const BoundaryFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("boundary"),
  territoryCode: z.string().min(1),
  geometry: z.union([PolygonSchema, MultiPolygonSchema]),
}).strict();
export type BoundaryFeature = z.infer<typeof BoundaryFeatureSchema>;

export const BuildingFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("building"),
  height: FINITE_NUMBER.nonnegative().optional(),
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
  width: FINITE_NUMBER.nonnegative().optional(),
  widthInferred: z.boolean().optional(),
  widthSource: WidthSourceEnum.optional(),
  surface: RoadSurfaceEnum.or(z.string()).optional(),
  bridge: z.boolean().optional(),
  tunnel: z.boolean().optional(),
  maxSpeed: z.number().int().nonnegative().optional(),
  layer: z.string().optional(),
  stratum: z.enum(["tunnel", "normal", "bridge"]).optional(),
  oneway: z.boolean().optional(),
  lanes: z.number().int().positive().optional(),
  lit: z.boolean().optional(),
  sidewalk: z.string().optional(),
}).strict();
export type RoadFeature = z.infer<typeof RoadFeatureSchema>;

export const WaterFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("water"),
  waterType: z.string().optional(),
  intermittent: z.boolean().optional(),
  width: FINITE_NUMBER.nonnegative().optional(),
  widthInferred: z.boolean().optional(),
  tidal: z.boolean().optional(),
  salt: z.enum(["yes", "no"]).optional(),
  fictiveAxis: z.boolean().optional(),
  isSurface: z.boolean().optional(),
}).strict();
export type WaterFeature = z.infer<typeof WaterFeatureSchema>;

export const LanduseFeatureSchema = FeatureBaseSchema.extend({
  kind: z.literal("landuse"),
  landuseType: z.string().min(1),
  area: FINITE_NUMBER.nonnegative().optional(),
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
  route: z.string().optional(),
  network: z.string().optional(),
  operator: z.string().optional(),
  ref: z.string().optional(),
  publicTransport: z.string().optional(),
  wheelchair: z.string().optional(),
}).strict();
export type TransportFeature = z.infer<typeof TransportFeatureSchema>;

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
export const FEATURE_KINDS = ["boundary", "building", "road", "water", "landuse", "poi", "business", "address", "transport"] as const;
export type FeatureKind = (typeof FEATURE_KINDS)[number];

export const TileManifestSchema = z.object({
  tileId: z.string().min(1),
  lod: z.number().int().min(0).max(2),
  bounds: LocalBoundsSchema,
  featureCount: z.number().int().nonnegative(),
  byteSize: z.number().int().nonnegative(),
  features: z.array(z.string().min(1)),
  fragmentIds: z.array(z.string().min(1)).optional(),
  fragmentOf: z.string().min(1).optional(),
  geometryBounds: LocalBoundsSchema.optional(),
}).strict();
export type TileManifest = z.infer<typeof TileManifestSchema>;

export const TileDataSchema = z.object({
  manifest: TileManifestSchema,
  features: z.array(MapFeatureSchema),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type TileData = z.infer<typeof TileDataSchema>;

export const SearchRecordSchema = z.object({
  featureId: z.string().min(1),
  canonicalName: z.string().min(1),
  normalizedName: z.string().min(1),
  aliases: z.array(z.string()),
  kind: z.enum(FEATURE_KINDS),
  category: z.string().optional(),
  tileId: z.string().min(1),
  focusLon: FINITE_NUMBER,
  focusLat: FINITE_NUMBER,
  boost: z.number().int().nonnegative(),
}).strict();
export type SearchRecord = z.infer<typeof SearchRecordSchema>;

const SourceManifestSchema = z.record(z.string(), z.unknown());
const FailedSourceSchema = z.object({ name: z.string().min(1), url: z.string().optional(), error: z.string().optional() }).strict();

export const DatasetManifestSchema = z.object({
  version: z.string().min(1).optional(),
  datasetVersion: z.string().min(1),
  acquisitionTime: z.string().min(1),
  territoryCode: z.string().min(1),
  territoryName: z.string().min(1),
  interchangeCrs: z.string().min(1),
  processingCrs: z.string().min(1),
  renderOrigin: CoordinateSchema,
  boundary: BboxSchema,
  projectionOrigin: CoordinateSchema,
  bounds: LocalBoundsSchema.optional(),
  tileSize: FINITE_NUMBER.positive(),
  tileCount: z.number().int().nonnegative().optional(),
  tileIds: z.array(z.string().min(1)).optional(),
  tiles: z.array(TileManifestSchema).optional(),
  tileBounds: z.array(LocalBoundsSchema).optional(),
  lods: z.array(z.object({ level: z.number().int().min(0).max(2), tileSize: FINITE_NUMBER.positive(), tileCount: z.number().int().nonnegative() }).strict()).optional(),
  featureCounts: z.record(z.string(), z.number().int().nonnegative()),
  byteSizes: z.record(z.string(), z.number().int().nonnegative()).optional(),
  layerAvailability: z.record(z.string(), z.boolean()).optional(),
  tileFeatureCounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
  pipeline: z.array(z.string()).default([]),
  sources: z.array(SourceManifestSchema).optional(),
  failedSources: z.array(FailedSourceSchema).optional(),
  transformation: z.record(z.string(), z.unknown()).optional(),
  nocibeFocus: z.object({
    name: z.string(),
    searchKey: z.string(),
    banId: z.string().optional(),
    address: z.string(),
    coord: CoordinateSchema,
    sourceRefs: z.array(SourceReferenceSchema),
    confidence: FeatureConfidenceEnum,
    status: FeatureStatusEnum,
    anchors: z.array(z.object({ name: z.string(), coord: CoordinateSchema }).strict()),
  }).strict().optional(),
}).strict();
export type DatasetManifest = z.infer<typeof DatasetManifestSchema>;

export const CoverageReportSchema = z.object({
  datasetVersion: z.string().min(1),
  acquisitionTime: z.string().min(1),
  boundary: BboxSchema,
  projectionOrigin: CoordinateSchema,
  tileSize: FINITE_NUMBER.positive(),
  tileCount: z.number().int().nonnegative(),
  featureCounts: z.record(z.string(), z.number().int().nonnegative()),
  sourceCounts: z.record(z.string(), z.number().int().nonnegative()),
  totalFeatures: z.number().int().nonnegative().optional(),
  categories: z.record(z.string(), z.number().int().nonnegative()).optional(),
  sources: z.record(z.string(), z.number().int().nonnegative()).optional(),
  unresolved: z.array(z.object({ category: z.string(), description: z.string() }).strict()).default([]),
  failedSources: z.array(FailedSourceSchema).default([]),
  budgets: z.object({
    tileBudgetBytes: z.number().int().nonnegative().optional(),
    maxTileBytes: z.number().int().nonnegative().optional(),
    totalTileCount: z.number().int().nonnegative().optional(),
    passes: z.boolean().optional(),
    largestTileBytes: z.number().int().nonnegative().optional(),
    policy: z.string().optional(),
    maxTileBytesLimit: z.number().int().nonnegative().optional(),
    actualTileCount: z.number().int().nonnegative().optional(),
    actualMaxTileBytes: z.number().int().nonnegative().optional(),
    withinBudget: z.boolean().optional(),
  }).strict().optional(),
}).strict();
export type CoverageReport = z.infer<typeof CoverageReportSchema>;

export const NocibeFocusSchema = z.object({
  name: z.string().min(1),
  searchKey: z.string().min(1),
  banId: z.string().optional(),
  address: z.string().min(1),
  coord: CoordinateSchema,
  sourceRefs: z.array(SourceReferenceSchema),
  confidence: FeatureConfidenceEnum,
  status: FeatureStatusEnum,
  anchors: z.array(z.object({ name: z.string().min(1), coord: CoordinateSchema }).strict()),
}).strict();
export type NocibeFocus = z.infer<typeof NocibeFocusSchema>;

export function validateCoordinate(coord: unknown, label = "coordinate"): Coordinate {
  const result = CoordinateSchema.safeParse(coord);
  if (!result.success) throw new Error(`${label}: invalid coordinate - ${result.error.message}`);
  return result.data;
}

export function validateGeometry(geom: unknown, label = "geometry"): Geometry {
  const result = GeometrySchema.safeParse(geom);
  if (!result.success) throw new Error(`${label}: invalid geometry - ${result.error.message}`);
  return result.data;
}

export function isBuildingFeature(feature: MapFeature): feature is BuildingFeature { return feature.kind === "building"; }
export function isRoadFeature(feature: MapFeature): feature is RoadFeature { return feature.kind === "road"; }
export function isWaterFeature(feature: MapFeature): feature is WaterFeature { return feature.kind === "water"; }
export function isLanduseFeature(feature: MapFeature): feature is LanduseFeature { return feature.kind === "landuse"; }
export function isPoiFeature(feature: MapFeature): feature is PoiFeature { return feature.kind === "poi"; }
export function isBusinessFeature(feature: MapFeature): feature is BusinessFeature { return feature.kind === "business"; }
export function isAddressFeature(feature: MapFeature): feature is AddressFeature { return feature.kind === "address"; }
export function isTransportFeature(feature: MapFeature): feature is TransportFeature { return feature.kind === "transport"; }
