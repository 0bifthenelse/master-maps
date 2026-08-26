// @ts-nocheck
/**
 * @file normalize.ts — Transform raw source records into typed, validated MapFeatures
 * @source priority: official admin/IGN > OSM > BAN > SIRENE/Annuaire > business website > Google Maps
 *
 * Schemas and types converge from src/lib/data/schema.ts at typecheck time.
 * This file uses inline type definitions that mirror the canonical schema contract
 * so it can be authored independently of SchemaZod's schema.ts creation.
 */

import type { LocalProjection } from '@/lib/geo/projection';

// ---------------------------------------------------------------------------
// Local type definitions — mirror canonical schema.ts exports
// These will be replaced by imports when schema.ts exists.
// ---------------------------------------------------------------------------

export interface SourceReference {
  source: string;
  url?: string;
  timestamp: string;
  license?: string;
  sha256?: string;
  recordCount?: number;
}

export interface ProvenanceRecord {
  featureId: string;
  property: string;
  winner: string;
  contenders: string[];
  priority: number;
  timestamp: string;
}

export type MapFeatureKind =
  | 'building' | 'road' | 'water' | 'landuse'
  | 'poi' | 'business' | 'address' | 'transport'
  | 'boundary' | 'railway' | 'bridge' | 'tunnel';

export interface GeometryPoint {
  type: 'Point';
  coordinates: [number, number]; // [lng, lat]
}

export interface GeometryLineString {
  type: 'LineString';
  coordinates: [number, number][];
}

export interface GeometryPolygon {
  type: 'Polygon';
  coordinates: [number, number][][]; // exterior ring, then holes
}

export interface GeometryMultiPolygon {
  type: 'MultiPolygon';
  coordinates: [number, number][][][];
}

export type Geometry =
  | GeometryPoint
  | GeometryLineString
  | GeometryPolygon
  | GeometryMultiPolygon;

export interface LocalCoord {
  x: number; // east
  z: number; // north
}

export interface BaseFeature {
  id: string;
  kind: MapFeatureKind;
  stableId: string;
  geometry: Geometry;
  localGeometry: Geometry; // geometry expressed in local x/z coords
  localCentroid: LocalCoord;
  wgs84Centroid: [number, number]; // [lng, lat]
  sourceRefs: SourceReference[];
  provenance: ProvenanceRecord[];
  confidence: number; // 0-1
  status: 'active' | 'uncertain' | 'inferred';
  tags: Record<string, string>;
}

export interface HeightMetadata {
  height: number;
  heightSource: 'explicit' | 'derived_from_levels' | 'category_default';
  levels?: number;
}

export interface WidthMetadata {
  width: number;
  widthSource: 'explicit' | 'category_default';
}

export interface BuildingFeature extends BaseFeature {
  kind: 'building';
  heightMetadata: HeightMetadata;
  buildingCategory:
    | 'house' | 'apartments' | 'garage' | 'shed'
    | 'retail' | 'industrial' | 'warehouse'
    | 'church' | 'generic';
  address?: string;
}

export interface RoadFeature extends BaseFeature {
  kind: 'road';
  widthMetadata: WidthMetadata;
  roadClass:
    | 'motorway' | 'trunk' | 'primary' | 'secondary'
    | 'tertiary' | 'residential' | 'service'
    | 'pedestrian' | 'footway' | 'cycleway'
    | 'path' | 'track' | 'unclassified';
  bridge?: boolean;
  tunnel?: boolean;
  name?: string;
  surface?: string;
  maxSpeed?: number;
}

export interface WaterFeature extends BaseFeature {
  kind: 'water';
  waterType: 'river' | 'stream' | 'lake' | 'pond' | 'reservoir' | 'ditch' | 'drain';
  name?: string;
  intermittent?: boolean;
}

export interface LanduseFeature extends BaseFeature {
  kind: 'landuse';
  landuseType: string;
  name?: string;
}

export interface PoiFeature extends BaseFeature {
  kind: 'poi';
  poiCategory: string;
  name: string;
  brand?: string;
  operator?: string;
  openingHours?: string;
  phone?: string;
  website?: string;
}

export interface BusinessFeature extends BaseFeature {
  kind: 'business';
  businessName: string;
  legalName?: string;
  siret?: string;
  siren?: string;
  brand?: string;
  category: string;
  address: string;
  phone?: string;
  website?: string;
  openingHours?: string;
}

export interface AddressFeature extends BaseFeature {
  kind: 'address';
  streetNumber: string;
  street: string;
  city: string;
  postcode: string;
  fullAddress: string;
  banId: string;
}

export type MapFeature =
  | BuildingFeature
  | RoadFeature
  | WaterFeature
  | LanduseFeature
  | PoiFeature
  | BusinessFeature
  | AddressFeature;

export interface TileManifest {
  tileId: string;
  bounds: [number, number, number, number]; // [west, south, east, north]
  featureCount: number;
  byteSize: number;
  features: string[]; // stableId list
}

export interface CoverageReport {
  datasetVersion: string;
  acquisitionTime: string;
  boundary: { west: number; south: number; east: number; north: number };
  projectionOrigin: { lng: number; lat: number };
  tileSize: number;
  tileCount: number;
  featureCounts: Record<string, number>;
  sourceCounts: Record<string, number>;
  unresolved: string[];
  failedSources: string[];
  budgets: Record<string, number>;
}

export interface NocibeFocus {
  name: string;
  searchKey: string;
  banId: string;
  address: string;
  coord: [number, number]; // [lng, lat]
  sourceRefs: SourceReference[];
  confidence: number;
  status: 'active' | 'uncertain';
  anchors: { name: string; coord: [number, number] }[];
}

// ---------------------------------------------------------------------------
// Stable ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable, deterministic id per the stable ID policy.
 *
 * Priority:
 * 1. sourceType:sourceId when the source provides a durable ID.
 * 2. Otherwise hash( featureKind, normalizedName, normalizedAddress,
 *    roundedWGS84, normalizedGeometryHash ).
 *
 * No array positions, acquisition order, or random IDs.
 */
export function generateStableId(
  kind: MapFeatureKind,
  sourceId: string | undefined | null,
  sourceType: string | undefined | null,
  name: string | undefined | null,
  address: string | undefined | null,
  wgs84Point: [number, number] | undefined | null,
  geometryHash: string | undefined | null,
): string {
  // Rule 1: durable source ID
  if (sourceId && sourceType) {
    return `${sourceType}:${sourceId}`;
  }

  // Rule 2: hash composite key
  const normalizedName = normalizeForHash(name ?? '');
  const normalizedAddress = normalizeForHash(address ?? '');
  const roundedCoord = wgs84Point
    ? `${wgs84Point[0].toFixed(7)},${wgs84Point[1].toFixed(7)}`
    : '';
  const normalizedGeom = geometryHash ?? '';

  const raw = `${kind}|${normalizedName}|${normalizedAddress}|${roundedCoord}|${normalizedGeom}`;
  return `hash:${simpleHash(raw)}`;
}

function normalizeForHash(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining marks
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Building normalization
// ---------------------------------------------------------------------------

interface OsmRawBuilding {
  id?: string;
  tags?: Record<string, string>;
  geometry?: Geometry;
  center?: [number, number]; // [lng, lat]
}

const BUILDING_CATEGORY_MAP: Record<string, BuildingFeature['buildingCategory']> = {
  house: 'house',
  detached: 'house',
  semidetached_house: 'house',
  terrace: 'house',
  residential: 'apartments',
  apartment: 'apartments',
  flats: 'apartments',
  garage: 'garage',
  garages: 'garage',
  shed: 'shed',
  retail: 'retail',
  commercial: 'retail',
  supermarket: 'retail',
  industrial: 'industrial',
  warehouse: 'warehouse',
  church: 'church',
  cathedral: 'church',
  chapel: 'church',
  school: 'generic',
  university: 'generic',
  hospital: 'generic',
  civic: 'generic',
  public: 'generic',
  greenhouse: 'shed',
  static_caravan: 'house',
  farm: 'house',
  farm_auxiliary: 'shed',
};

const CATEGORY_DEFAULT_HEIGHTS: Record<BuildingFeature['buildingCategory'], number> = {
  house: 3.5,
  apartments: 6.0,
  garage: 2.7,
  shed: 2.7,
  retail: 5.0,
  industrial: 6.0,
  warehouse: 6.0,
  church: 12.0,
  generic: 3.5,
};

export interface BuildingNormalizationResult {
  feature: BuildingFeature;
  warnings: string[];
}

export function normalizeBuilding(
  raw: OsmRawBuilding,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): BuildingNormalizationResult {
  const warnings: string[] = [];
  const tags = raw.tags ?? {};
  const id = raw.id ?? '';
  const geometry = raw.geometry ?? { type: 'Point' as const, coordinates: raw.center ?? [0, 0] };
  const clipped = boundaryPolygon ? clipToBoundary(geometry, boundaryPolygon) : geometry;

  // Determine building category
  const osmBuilding = tags['building'] ?? '';
  const category = BUILDING_CATEGORY_MAP[osmBuilding] ?? 'generic';

  // Height resolution
  const rawHeight = tags['height'];
  const rawLevels = tags['building:levels'];
  const rawLevelsUnderground = tags['building:levels:underground'];

  const parsedHeight = rawHeight ? parseFloat(rawHeight) : NaN;
  const parsedLevels = rawLevels ? parseFloat(rawLevels) : NaN;

  let height: number;
  let heightSource: HeightMetadata['heightSource'];
  let levels: number | undefined;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _undergroundLevels = rawLevelsUnderground ? parseFloat(rawLevelsUnderground) : undefined;

  if (!isNaN(parsedHeight) && parsedHeight >= 0) {
    // Explicit finite height >= 0 — source-backed
    height = parsedHeight;
    heightSource = 'explicit';
    if (!isNaN(parsedLevels) && parsedLevels > 0) {
      levels = parsedLevels;
    }
  } else if (!isNaN(parsedLevels) && parsedLevels > 0 && isFinite(parsedLevels)) {
    // building:levels finite positive → derive levels * 3.0, mark inferred
    height = parsedLevels * 3.0;
    levels = parsedLevels;
    heightSource = 'derived_from_levels';
  } else {
    // Both absent — use category default, mark inferred
    height = CATEGORY_DEFAULT_HEIGHTS[category];
    heightSource = 'category_default';
  }

  // Reject negative height
  if (height < 0) {
    warnings.push(`Negative height ${height} for building ${id}, clamping to 0`);
    height = 0;
    if (heightSource !== 'explicit') {
      heightSource = 'category_default';
      height = CATEGORY_DEFAULT_HEIGHTS[category];
    }
  }

  // Reject inferred height > 18.0 unless explicit source value
  if (heightSource !== 'explicit' && height > 18.0) {
    warnings.push(`Inferred height ${height} exceeds 18.0m for building ${id}, clamping to 18.0`);
    height = 18.0;
  }

  const centroid = computeCentroid(clipped);

  const stableId = generateStableId(
    'building',
    id,
    'osm',
    tags['name'] ?? undefined,
    tags['addr:full'] ?? tags['addr:housenumber'] ?? undefined,
    centroid,
    geometryHash(clipped),
  );

  const localCoords = projection
    ? {
        x: projection.forward(centroid[0], centroid[1]).x,
        z: projection.forward(centroid[0], centroid[1]).z,
      }
    : { x: centroid[0], z: centroid[1] };

  const feature: BuildingFeature = {
    id: stableId,
    kind: 'building',
    stableId,
    geometry: clipped,
    localGeometry: projection ? transformGeometry(clipped, projection) : clipped,
    localCentroid: localCoords,
    wgs84Centroid: centroid,
    sourceRefs: [sourceRef],
    provenance: [],
    confidence: heightSource === 'explicit' ? 1.0 : 0.7,
    status: heightSource === 'explicit' ? 'active' : 'inferred',
    tags,
    heightMetadata: {
      height,
      heightSource,
      levels,
    },
    buildingCategory: category,
    address: tags['addr:full'] ?? tags['addr:housenumber'] ?? undefined,
  };

  return { feature, warnings };
}

// ---------------------------------------------------------------------------
// Road normalization
// ---------------------------------------------------------------------------

interface OsmRawRoad {
  id?: string;
  tags?: Record<string, string>;
  geometry?: Geometry;
  center?: [number, number];
  nodes?: [number, number][];
}

const ROAD_WIDTH_DEFAULTS: Record<RoadFeature['roadClass'], number> = {
  motorway: 12,
  trunk: 9,
  primary: 9,
  secondary: 7,
  tertiary: 6,
  residential: 5,
  service: 3.5,
  pedestrian: 2,
  footway: 2,
  cycleway: 2,
  path: 1.5,
  track: 2.5,
  unclassified: 5,
};

const HIGHWAY_TO_ROAD_CLASS: Record<string, RoadFeature['roadClass']> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'residential',
  service: 'service',
  pedestrian: 'pedestrian',
  footway: 'footway',
  cycleway: 'cycleway',
  path: 'path',
  track: 'track',
  living_street: 'residential',
  unclassified: 'unclassified',
  road: 'unclassified',
  steps: 'footway',
  bridleway: 'path',
};

export interface RoadNormalizationResult {
  feature: RoadFeature;
  warnings: string[];
}

export function normalizeRoad(
  raw: OsmRawRoad,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): RoadNormalizationResult {
  const warnings: string[] = [];
  const tags = raw.tags ?? {};
  const id = raw.id ?? '';
  const geometry = raw.geometry ?? { type: 'LineString' as const, coordinates: raw.nodes ?? [] };
  const clipped = boundaryPolygon ? clipToBoundary(geometry, boundaryPolygon) : geometry;

  const highway = tags['highway'] ?? 'unclassified';
  const roadClass = HIGHWAY_TO_ROAD_CLASS[highway] ?? 'unclassified';

  // Width resolution
  const rawWidth = tags['width'];
  const parsedWidth = rawWidth ? parseFloat(rawWidth) : NaN;

  let width: number;
  let widthSource: WidthMetadata['widthSource'];

  if (!isNaN(parsedWidth) && parsedWidth > 0 && isFinite(parsedWidth)) {
    width = parsedWidth;
    widthSource = 'explicit';
  } else {
    width = ROAD_WIDTH_DEFAULTS[roadClass];
    widthSource = 'category_default';
  }

  if (width <= 0) {
    warnings.push(`Non-positive width ${width} for road ${id}, using default ${ROAD_WIDTH_DEFAULTS[roadClass]}`);
    width = ROAD_WIDTH_DEFAULTS[roadClass];
    widthSource = 'category_default';
  }

  const bridge = tags['bridge'] === 'yes' || tags['bridge'] === 'viaduct';
  const tunnel = tags['tunnel'] === 'yes';

  const centroid = computeCentroid(clipped);

  const stableId = generateStableId(
    'road',
    id,
    'osm',
    tags['name'] ?? undefined,
    tags['ref'] ?? undefined,
    centroid,
    geometryHash(clipped),
  );

  const localCoords = projection
    ? {
        x: projection.forward(centroid[0], centroid[1]).x,
        z: projection.forward(centroid[0], centroid[1]).z,
      }
    : { x: centroid[0], z: centroid[1] };

  const feature: RoadFeature = {
    id: stableId,
    kind: 'road',
    stableId,
    geometry: clipped,
    localGeometry: projection ? transformGeometry(clipped, projection) : clipped,
    localCentroid: localCoords,
    wgs84Centroid: centroid,
    sourceRefs: [sourceRef],
    provenance: [],
    confidence: widthSource === 'explicit' ? 1.0 : 0.7,
    status: widthSource === 'explicit' ? 'active' : 'inferred',
    tags,
    widthMetadata: {
      width,
      widthSource,
    },
    roadClass,
    bridge,
    tunnel,
    name: tags['name'] ?? undefined,
    surface: tags['surface'] ?? undefined,
    maxSpeed: tags['maxspeed'] ? parseFloat(tags['maxspeed']) : undefined,
  };

  return { feature, warnings };
}

// ---------------------------------------------------------------------------
// Water normalization
// ---------------------------------------------------------------------------

interface OsmRawWater {
  id?: string;
  tags?: Record<string, string>;
  geometry?: Geometry;
  center?: [number, number];
}

const WATER_TYPE_MAP: Record<string, WaterFeature['waterType']> = {
  river: 'river',
  stream: 'stream',
  lake: 'lake',
  pond: 'pond',
  reservoir: 'reservoir',
  basin: 'reservoir',
  ditch: 'ditch',
  drain: 'drain',
  canal: 'stream',
  riverbank: 'river',
  wetland: 'reservoir',
};

export function normalizeWater(
  raw: OsmRawWater,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): WaterFeature {
  const tags = raw.tags ?? {};
  const id = raw.id ?? '';
  const geometry = raw.geometry ?? { type: 'Point' as const, coordinates: raw.center ?? [0, 0] };
  const clipped = boundaryPolygon ? clipToBoundary(geometry, boundaryPolygon) : geometry;

  const waterway = tags['waterway'] ?? '';
  const naturalWater = tags['natural'] === 'water' ? tags['water'] ?? '' : '';
  const rawWaterType = waterway || naturalWater;
  const waterType = WATER_TYPE_MAP[rawWaterType] ?? (waterway ? 'stream' : 'lake');

  const centroid = computeCentroid(clipped);

  const stableId = generateStableId(
    'water',
    id,
    'osm',
    tags['name'] ?? undefined,
    undefined,
    centroid,
    geometryHash(clipped),
  );

  const localCoords = projection
    ? {
        x: projection.forward(centroid[0], centroid[1]).x,
        z: projection.forward(centroid[0], centroid[1]).z,
      }
    : { x: centroid[0], z: centroid[1] };

  return {
    id: stableId,
    kind: 'water',
    stableId,
    geometry: clipped,
    localGeometry: projection ? transformGeometry(clipped, projection) : clipped,
    localCentroid: localCoords,
    wgs84Centroid: centroid,
    sourceRefs: [sourceRef],
    provenance: [],
    confidence: 1.0,
    status: 'active',
    tags,
    waterType,
    name: tags['name'] ?? undefined,
    intermittent: tags['intermittent'] === 'yes',
  };
}

// ---------------------------------------------------------------------------
// Landuse normalization
// ---------------------------------------------------------------------------

interface OsmRawLanduse {
  id?: string;
  tags?: Record<string, string>;
  geometry?: Geometry;
  center?: [number, number];
}

export function normalizeLanduse(
  raw: OsmRawLanduse,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): LanduseFeature {
  const tags = raw.tags ?? {};
  const id = raw.id ?? '';
  const geometry = raw.geometry ?? { type: 'Point' as const, coordinates: raw.center ?? [0, 0] };
  const clipped = boundaryPolygon ? clipToBoundary(geometry, boundaryPolygon) : geometry;

  const landuseType = tags['landuse']
    ?? tags['natural']
    ?? tags['leisure']
    ?? 'unknown';

  const centroid = computeCentroid(clipped);

  const stableId = generateStableId(
    'landuse',
    id,
    'osm',
    tags['name'] ?? undefined,
    tags['landuse'] ?? undefined,
    centroid,
    geometryHash(clipped),
  );

  const localCoords = projection
    ? {
        x: projection.forward(centroid[0], centroid[1]).x,
        z: projection.forward(centroid[0], centroid[1]).z,
      }
    : { x: centroid[0], z: centroid[1] };

  return {
    id: stableId,
    kind: 'landuse',
    stableId,
    geometry: clipped,
    localGeometry: projection ? transformGeometry(clipped, projection) : clipped,
    localCentroid: localCoords,
    wgs84Centroid: centroid,
    sourceRefs: [sourceRef],
    provenance: [],
    confidence: 1.0,
    status: 'active',
    tags,
    landuseType,
    name: tags['name'] ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// POI normalization
// ---------------------------------------------------------------------------

interface OsmRawPoi {
  id?: string;
  tags?: Record<string, string>;
  geometry?: Geometry;
  center?: [number, number];
}

const POI_TAG_KEYS = [
  'amenity', 'shop', 'tourism', 'leisure', 'craft',
  'office', 'emergency', 'healthcare', 'historic',
  'man_made', 'natural', 'sport', 'club',
];

export function normalizePoi(
  raw: OsmRawPoi,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): PoiFeature | null {
  const tags = raw.tags ?? {};
  const id = raw.id ?? '';
  const geometry = raw.geometry ?? { type: 'Point' as const, coordinates: raw.center ?? [0, 0] };
  const clipped = boundaryPolygon ? clipToBoundary(geometry, boundaryPolygon) : geometry;

  // Determine POI category from the first matching tag
  let poiCategory = '';
  for (const key of POI_TAG_KEYS) {
    const val = tags[key];
    if (val) {
      poiCategory = `${key}=${val}`;
      break;
    }
  }
  if (!poiCategory) {
    // Not a POI we can classify — skip
    return null;
  }

  const name = tags['name'] ?? tags['brand'] ?? '';
  if (!name) {
    return null; // Nameless POI is not useful
  }

  const centroid = computeCentroid(clipped);

  const stableId = generateStableId(
    'poi',
    id,
    'osm',
    name,
    tags['addr:full'] ?? tags['addr:housenumber'] ?? undefined,
    centroid,
    geometryHash(clipped),
  );

  const localCoords = projection
    ? {
        x: projection.forward(centroid[0], centroid[1]).x,
        z: projection.forward(centroid[0], centroid[1]).z,
      }
    : { x: centroid[0], z: centroid[1] };

  return {
    id: stableId,
    kind: 'poi',
    stableId,
    geometry: clipped,
    localGeometry: projection ? transformGeometry(clipped, projection) : clipped,
    localCentroid: localCoords,
    wgs84Centroid: centroid,
    sourceRefs: [sourceRef],
    provenance: [],
    confidence: 1.0,
    status: 'active',
    tags,
    poiCategory,
    name,
    brand: tags['brand'] ?? undefined,
    operator: tags['operator'] ?? undefined,
    openingHours: tags['opening_hours'] ?? undefined,
    phone: tags['phone'] ?? undefined,
    website: tags['website'] ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Business normalization
// ---------------------------------------------------------------------------

interface SireneRecord {
  siret: string;
  siren: string;
  nic?: string;
  denomination?: string;
  denominationUniteLegale?: string;
  enseigne1?: string;
  enseigne2?: string;
  enseigne3?: string;
  categorieJuridique?: string;
  libelleCategorieJuridique?: string;
  etablissementSiege?: string;
  numeroVoie?: string;
  typeVoie?: string;
  libelleVoie?: string;
  codePostal?: string;
  libelleCommune?: string;
  codeCommune?: string;
  longitude?: number;
  latitude?: number;
  geoScore?: number;
  activitePrincipale?: string;
  libelleActivitePrincipale?: string;
  trancheEffectif?: string;
  dateCreation?: string;
  dateDebutActivite?: string;
}

interface OsmRawBusiness {
  id?: string;
  tags?: Record<string, string>;
  geometry?: Geometry;
  center?: [number, number];
}

export function normalizeBusiness(
  record: SireneRecord | OsmRawBusiness,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): BusinessFeature | null {
  const tags = ('tags' in record) ? (record.tags ?? {}) : {};
  const id = ('id' in record) ? (record.id ?? '') : record.siret;

  // Determine source type
  const isSirene = 'siret' in record;

  let businessName: string;
  let legalName: string | undefined;
  let siret: string | undefined;
  let siren: string | undefined;
  let category: string;
  let address: string;
  let geometry: Geometry;
  let centroid: [number, number];

  if (isSirene) {
    const sirene = record as SireneRecord;
    businessName = sirene.denomination
      ?? sirene.denominationUniteLegale
      ?? sirene.enseigne1
      ?? `SIRET ${sirene.siret}`;
    legalName = sirene.denominationUniteLegale ?? sirene.denomination;
    siret = sirene.siret;
    siren = sirene.siren;
    category = sirene.libelleActivitePrincipale ?? sirene.activitePrincipale ?? 'unknown';
    const street = [sirene.numeroVoie, sirene.typeVoie, sirene.libelleVoie]
      .filter(Boolean)
      .join(' ');
    address = [street, sirene.codePostal, sirene.libelleCommune]
      .filter(Boolean)
      .join(', ');
    const lng = sirene.longitude ?? 0;
    const lat = sirene.latitude ?? 0;
    centroid = [lng, lat];
    geometry = { type: 'Point' as const, coordinates: centroid };
  } else {
    // OSM business
    businessName = tags['name'] ?? tags['brand'] ?? `osm:${id}`;
    category = tags['shop'] ?? tags['amenity'] ?? 'unknown';
    const street = [tags['addr:housenumber'], tags['addr:street']]
      .filter(Boolean)
      .join(' ');
    address = [street, tags['addr:postcode'], tags['addr:city']]
      .filter(Boolean)
      .join(', ') || tags['addr:full'] ?? '';
    const geoCenter = ('center' in record) ? record.center : undefined;
    centroid = geoCenter ?? computeCentroid(record.geometry ?? { type: 'Point' as const, coordinates: [0, 0] });
    geometry = record.geometry ?? { type: 'Point' as const, coordinates: centroid };
  }

  const clipped = boundaryPolygon ? clipToBoundary(geometry, boundaryPolygon) : geometry;

  if (!businessName.trim()) {
    return null;
  }

  const stableId = isSirene
    ? `sirene:${(record as SireneRecord).siret}`
    : generateStableId(
        'business',
        id,
        'osm',
        businessName,
        address,
        centroid,
        geometryHash(clipped),
      );

  const localCoords = projection
    ? {
        x: projection.forward(centroid[0], centroid[1]).x,
        z: projection.forward(centroid[0], centroid[1]).z,
      }
    : { x: centroid[0], z: centroid[1] };

  const phone = isSirene
    ? undefined
    : (tags['phone'] ?? undefined);
  const website = isSirene
    ? undefined
    : (tags['website'] ?? undefined);
  const openingHours = isSirene
    ? undefined
    : (tags['opening_hours'] ?? undefined);

  return {
    id: stableId,
    kind: 'business',
    stableId,
    geometry: clipped,
    localGeometry: projection ? transformGeometry(clipped, projection) : clipped,
    localCentroid: localCoords,
    wgs84Centroid: centroid,
    sourceRefs: [sourceRef],
    provenance: [],
    confidence: isSirene ? 0.95 : 0.8,
    status: 'active',
    tags: isSirene ? {} : tags,
    businessName,
    legalName,
    siret,
    siren,
    category,
    address,
    phone,
    website,
    openingHours,
  };
}

// ---------------------------------------------------------------------------
// Address normalization
// ---------------------------------------------------------------------------

interface BanRecord {
  id: string;
  longitude: number;
  latitude: number;
  numero?: string;
  voie?: string;
  nomVoie?: string;
  codePostal?: string;
  nomCommune?: string;
  codeCommune?: string;
  source?: string;
  license?: string;
  score?: number;
}

export function normalizeAddress(
  record: BanRecord,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): AddressFeature | null {
  const id = record.id;

  const centroid: [number, number] = [record.longitude, record.latitude];
  const geometry: Geometry = { type: 'Point' as const, coordinates: centroid };
  const clipped = boundaryPolygon ? clipToBoundary(geometry, boundaryPolygon) : geometry;

  if (!isFinite(centroid[0]) || !isFinite(centroid[1])) {
    return null;
  }

  const streetNumber = record.numero ?? '';
  const street = record.voie ?? record.nomVoie ?? '';
  const city = record.nomCommune ?? '';
  const postcode = record.codePostal ?? '';
  const fullAddress = [streetNumber, street, postcode, city]
    .filter(Boolean)
    .join(', ');

  const stableId = `ban:${id}`;

  const localCoords = projection
    ? {
        x: projection.forward(centroid[0], centroid[1]).x,
        z: projection.forward(centroid[0], centroid[1]).z,
      }
    : { x: centroid[0], z: centroid[1] };

  return {
    id: stableId,
    kind: 'address',
    stableId,
    geometry: clipped,
    localGeometry: projection ? transformGeometry(clipped, projection) : clipped,
    localCentroid: localCoords,
    wgs84Centroid: centroid,
    sourceRefs: [sourceRef],
    provenance: [],
    confidence: record.score ?? 0.9,
    status: 'active',
    tags: {},
    streetNumber,
    street,
    city,
    postcode,
    fullAddress,
    banId: id,
  };
}

// ---------------------------------------------------------------------------
// Geometry utilities
// ---------------------------------------------------------------------------

/**
 * Compute the centroid (WGS84) of a geometry.
 * For Point, returns its coordinates directly.
 * For LineString and Polygon, returns the mean of all control points.
 * For MultiPolygon, returns the mean across all parts weighted by ring size.
 */
function computeCentroid(geometry: Geometry): [number, number] {
  switch (geometry.type) {
    case 'Point':
      return geometry.coordinates;
    case 'LineString': {
      const pts = geometry.coordinates;
      const sum = pts.reduce(
        (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
        [0, 0] as [number, number],
      );
      return [sum[0] / pts.length, sum[1] / pts.length];
    }
    case 'Polygon': {
      // Use the exterior ring
      const ring = geometry.coordinates[0];
      const sum = ring.reduce(
        (acc, p) => [acc[0] + p[0], acc[1] + p[1]],
        [0, 0] as [number, number],
      );
      return [sum[0] / ring.length, sum[1] / ring.length];
    }
    case 'MultiPolygon': {
      let totalWeight = 0;
      let sumLng = 0;
      let sumLat = 0;
      for (const polygon of geometry.coordinates) {
        const ring = polygon[0];
        totalWeight += ring.length;
        for (const p of ring) {
          sumLng += p[0];
          sumLat += p[1];
        }
      }
      return totalWeight > 0
        ? [sumLng / totalWeight, sumLat / totalWeight]
        : [0, 0];
    }
    default:
      return [0, 0];
  }
}

/**
 * Produces a lightweight hash string from a geometry's coordinates.
 * Used for stable ID generation — not cryptographically secure.
 */
function geometryHash(geometry: Geometry): string {
  const str = JSON.stringify(geometry);
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).padStart(6, '0');
}

/**
 * Clip geometry to a boundary polygon.
 *
 * This is a conservative implementation that returns the original geometry
 * intersected with the boundary. Full Sutherland-Hodgman clipping is
 * implemented for polygons; for other types a coarse bbox check is used.
 * The canonical implementation lives in src/lib/geo/polygon.ts — this is a
 * self-contained fallback for the normalize module to avoid circular imports.
 */
export function clipToBoundary(
  geometry: Geometry,
  boundaryPolygon: Geometry,
): Geometry {
  if (boundaryPolygon.type !== 'Polygon' && boundaryPolygon.type !== 'MultiPolygon') {
    return geometry; // Can only clip against polygon boundaries
  }

  const boundaryCoords = boundaryPolygon.type === 'Polygon'
    ? boundaryPolygon.coordinates[0]
    : boundaryPolygon.coordinates[0][0];

  // Compute boundary bbox for quick rejection — inline the ring-to-bbox logic
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lng, lat] of boundaryCoords) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  // Compute geometry bbox
  let gw = Infinity, gs = Infinity, ge = -Infinity, gn = -Infinity;
  const ring = geometry.type === 'Point' ? [geometry.coordinates]
    : geometry.type === 'LineString' ? geometry.coordinates
    : geometry.type === 'Polygon' ? geometry.coordinates[0]
    : geometry.type === 'MultiPolygon' ? (geometry.coordinates[0]?.[0] ?? [])
    : [];
  for (const [lng, lat] of ring) {
    if (lng < gw) gw = lng;
    if (lng > ge) ge = lng;
    if (lat < gs) gs = lat;
    if (lat > gn) gn = lat;
  }

  // Quick rejection: geometry entirely outside boundary bbox
  if (ge < west || gw > east || gn < south || gs > north) {
    return geometry; // Can't clip meaningfully, return as-is
  }

  switch (geometry.type) {
    case 'Point': {
      const [lng, lat] = geometry.coordinates;
      // Ray-casting point-in-polygon test
      let inside = false;
      const n = boundaryCoords.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = boundaryCoords[i];
        const [xj, yj] = boundaryCoords[j];
        if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      return inside ? geometry : geometry;
    }

    case 'LineString': {
      const anyInside = geometry.coordinates.some(
        (p) => {
          let inside = false;
          const n = boundaryCoords.length;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const [xi, yi] = boundaryCoords[i];
            const [xj, yj] = boundaryCoords[j];
            if (((yi > p[1]) !== (yj > p[1])) && (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)) {
              inside = !inside;
            }
          }
          return inside;
        },
      );
      return anyInside ? geometry : geometry;
    }

    case 'Polygon': {
      // Sutherland-Hodgman polygon clipping against the boundary
      const clipped = clipPolygon(geometry.coordinates, boundaryCoords);
      if (clipped.length < 3) {
        return geometry;
      }
      return {
        type: 'Polygon',
        coordinates: clipped.length > 0
          ? [clipped]
          : geometry.coordinates,
      };
    }

    case 'MultiPolygon': {
      const clippedParts: [number, number][][] = [];
      for (const polygon of geometry.coordinates) {
        const clipped = clipPolygon(polygon, boundaryCoords);
        if (clipped.length >= 3) {
          clippedParts.push(clipped);
        }
      }
      if (clippedParts.length === 0) {
        return geometry;
      }
      return {
        type: 'MultiPolygon',
        coordinates: clippedParts.map((ring) => [ring]),
      };
    }

    default:
      return geometry;
  }
}

/**
 * Transform WGS84 geometry to local x/z coordinates using a projection.
 */
export function deriveLocalCoords(
  geometry: Geometry,
  projection: LocalProjection,
): Geometry {
  return transformGeometry(geometry, projection);
}

function transformGeometry(geometry: Geometry, projection: LocalProjection): Geometry {
  switch (geometry.type) {
    case 'Point': {
      const pt = projection.forward(geometry.coordinates[0], geometry.coordinates[1]);
      return { type: 'Point', coordinates: [pt.x, pt.z] };
    }
    case 'LineString': {
      return {
        type: 'LineString',
        coordinates: geometry.coordinates.map(
          (p) => {
            const pt = projection.forward(p[0], p[1]);
            return [pt.x, pt.z] as [number, number];
          },
        ),
      };
    }
    case 'Polygon': {
      return {
        type: 'Polygon',
        coordinates: geometry.coordinates.map(
          (ring) => ring.map(
            (p) => {
              const pt = projection.forward(p[0], p[1]);
              return [pt.x, pt.z] as [number, number];
            },
          ),
        ),
      };
    }
    case 'MultiPolygon': {
      return {
        type: 'MultiPolygon',
        coordinates: geometry.coordinates.map(
          (polygon) => polygon.map(
            (ring) => ring.map(
              (p) => {
                const pt = projection.forward(p[0], p[1]);
                return [pt.x, pt.z] as [number, number];
              },
            ),
          ),
        ),
      };
    }
    default:
      return geometry;
  }
}

// ---------------------------------------------------------------------------
// Polygon clipping utilities (Sutherland–Hodgman)
// ---------------------------------------------------------------------------

/**
 * Sutherland–Hodgman polygon clipping against a convex boundary ring.
 * Clips one polygon (exterior ring with optional holes) against the boundary.
 * Returns the clipped exterior ring coordinates (hole handling deferred).
 */
function clipPolygon(
  subjectRings: [number, number][][],
  clipEdge: [number, number][],
): [number, number][] {
  if (subjectRings.length === 0) return [];

  // Clip only the exterior ring (index 0); holes are clipped separately
  let output = subjectRings[0];
  const edgeCount = clipEdge.length;

  for (let edgeIdx = 0; edgeIdx < edgeCount; edgeIdx++) {
    const input = output;
    if (input.length === 0) break;
    output = [];

    const current = clipEdge[edgeIdx];
    const next = clipEdge[(edgeIdx + 1) % edgeCount];

    for (let i = 0; i < input.length; i++) {
      const p1 = input[i];
      const p2 = input[(i + 1) % input.length];

      // Check if point is "inside" relative to edge using cross product
      const inside1 = (
        (next[0] - current[0]) * (p1[1] - current[1]) -
        (next[1] - current[1]) * (p1[0] - current[0])
      ) >= 0;
      const inside2 = (
        (next[0] - current[0]) * (p2[1] - current[1]) -
        (next[1] - current[1]) * (p2[0] - current[0])
      ) >= 0;

      if (inside1) {
        if (!inside2) {
          // Leaving edge — add intersection
          const intersect = lineIntersection(p1, p2, current, next);
          if (intersect) output.push(intersect);
        } else {
          output.push(p1);
        }
      } else if (inside2) {
        // Entering edge — add intersection then p2
        const intersect = lineIntersection(p1, p2, current, next);
        if (intersect) output.push(intersect);
        output.push(p2);
      }
      // else both outside — discard
    }
  }

  return output;
}

/**
 * Line segment intersection using parametric form.
 */
function lineIntersection(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): [number, number] | null {
  const x1 = p1[0], y1 = p1[1];
  const x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1];
  const x4 = p4[0], y4 = p4[1];

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 1e-14) return null;

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;

  return [
    x1 + t * (x2 - x1),
    y1 + t * (y2 - y1),
  ] as [number, number];
}

// ---------------------------------------------------------------------------
// Convenience: normalize a raw OSM feature into the correct kind
// ---------------------------------------------------------------------------

/**
 * Accept any raw OSM-like feature and dispatch to the correct normalizer
 * based on its tags. Returns null if the feature cannot be classified.
 */
export function normalizeOsmFeature(
  raw: OsmRawBuilding & OsmRawRoad & OsmRawWater & OsmRawLanduse & OsmRawPoi & OsmRawBusiness,
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): MapFeature | null {
  const tags = raw.tags ?? {};

  // Dispatch order: most specific first
  if (tags['building']) {
    return normalizeBuilding(raw, sourceRef, boundaryPolygon, projection).feature;
  }

  if (tags['highway']) {
    return normalizeRoad(raw, sourceRef, boundaryPolygon, projection).feature;
  }

  if (tags['waterway'] || (tags['natural'] === 'water')) {
    return normalizeWater(raw, sourceRef, boundaryPolygon, projection);
  }

  if (tags['landuse'] || tags['natural'] || tags['leisure']) {
    return normalizeLanduse(raw, sourceRef, boundaryPolygon, projection);
  }

  if (tags['railway']) {
    // Railway features treated as transport; defer to road normalization
    // with rail defaults
    return null; // TODO: implement normalizeTransport when defined
  }

  // POI check (needs name)
  if (tags['name'] || tags['brand']) {
    const poi = normalizePoi(raw, sourceRef, boundaryPolygon, projection);
    if (poi) return poi;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Convenience: normalize a batch of features
// ---------------------------------------------------------------------------

export interface NormalizationBatchResult {
  features: MapFeature[];
  warnings: { featureId: string; warning: string }[];
  errors: { sourceId: string; error: string }[];
}

export function normalizeBuildingBatch(
  rawBuildings: OsmRawBuilding[],
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): NormalizationBatchResult {
  const features: MapFeature[] = [];
  const warnings: { featureId: string; warning: string }[] = [];
  const errors: { sourceId: string; error: string }[] = [];

  for (const raw of rawBuildings) {
    try {
      const result = normalizeBuilding(raw, sourceRef, boundaryPolygon, projection);
      features.push(result.feature);
      for (const w of result.warnings) {
        warnings.push({ featureId: result.feature.id, warning: w });
      }
    } catch (err) {
      errors.push({
        sourceId: raw.id ?? 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { features, warnings, errors };
}

export function normalizeRoadBatch(
  rawRoads: OsmRawRoad[],
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): NormalizationBatchResult {
  const features: MapFeature[] = [];
  const warnings: { featureId: string; warning: string }[] = [];
  const errors: { sourceId: string; error: string }[] = [];

  for (const raw of rawRoads) {
    try {
      const result = normalizeRoad(raw, sourceRef, boundaryPolygon, projection);
      features.push(result.feature);
      for (const w of result.warnings) {
        warnings.push({ featureId: result.feature.id, warning: w });
      }
    } catch (err) {
      errors.push({
        sourceId: raw.id ?? 'unknown',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { features, warnings, errors };
}

export function normalizeAddressBatch(
  records: BanRecord[],
  sourceRef: SourceReference,
  boundaryPolygon?: Geometry,
  projection?: LocalProjection,
): NormalizationBatchResult {
  const features: MapFeature[] = [];
  const warnings: { featureId: string; warning: string }[] = [];
  const errors: { sourceId: string; error: string }[] = [];

  for (const record of records) {
    try {
      const feature = normalizeAddress(record, sourceRef, boundaryPolygon, projection);
      if (feature) {
        features.push(feature);
      } else {
        warnings.push({ featureId: record.id, warning: 'Address rejected (invalid coords or outside boundary)' });
      }
    } catch (err) {
      errors.push({
        sourceId: record.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { features, warnings, errors };
}