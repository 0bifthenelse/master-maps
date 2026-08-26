/**
 * @file Core geographic, feature, manifest, and provenance type definitions
 * for the Auch 2D WebGPU map. Pure TypeScript types (no runtime schemas).
 * All geometry uses WGS84 source coordinates and local projected coordinates
 * in metres (x = east, z = north, y = 0 for visible map geometry).
 *
 * These types are the contract between the data pipeline (scripts/data/),
 * the API routes (app/api/map/), the scene builders (src/lib/scene/),
 * and the React map shell (src/components/map/).
 *
 * Runtime validation is delegated to Zod schemas in src/lib/data/schema.ts.
 *
 * @module map
 */

// ──────────────────────────────────────────────────────────────────────────────
//  Coordinate & Geometry Primitives
// ──────────────────────────────────────────────────────────────────────────────

/**
 * WGS84 longitude/latitude pair expressed as [longitude, latitude] in decimal
 * degrees. The first element is longitude (x, east—west), the second is
 * latitude (y, north—south).
 */
export type Wgs84Coordinate = [longitude: number, latitude: number];

/**
 * Local projected point in metres.
 *
 * Axis contract:
 * - `x` = easting (metres from projection origin)
 * - `z` = northing (metres from projection origin, north-positive)
 * - `y` is always 0 for visible map geometry
 *
 * Coordinates are derived from an equirectangular spherical projection centred
 * on the commune centre or the bounding-box midpoint when the centre is
 * infinite.
 */
export interface LocalPoint {
  /** Easting from the projection origin in metres. */
  readonly x: number;
  /** Northing from the projection origin in metres (north-positive). */
  readonly z: number;
}

// ── GeoJSON geometry types ────────────────────────────────────────────────────

/** A single position: [longitude, latitude, elevation?]. */
export type GeoJsonPosition = [number, number, ...number[]];

/** GeoJSON Point. */
export interface GeoJsonPoint {
  readonly type: 'Point';
  readonly coordinates: GeoJsonPosition;
}

/** GeoJSON MultiPoint. */
export interface GeoJsonMultiPoint {
  readonly type: 'MultiPoint';
  readonly coordinates: GeoJsonPosition[];
}

/** GeoJSON LineString. */
export interface GeoJsonLineString {
  readonly type: 'LineString';
  readonly coordinates: GeoJsonPosition[];
}

/** GeoJSON MultiLineString. */
export interface GeoJsonMultiLineString {
  readonly type: 'MultiLineString';
  readonly coordinates: GeoJsonPosition[][];
}

/** GeoJSON Polygon (exterior ring first, optional interior hole rings). */
export interface GeoJsonPolygon {
  readonly type: 'Polygon';
  readonly coordinates: GeoJsonPosition[][];
}

/** GeoJSON MultiPolygon. */
export interface GeoJsonMultiPolygon {
  readonly type: 'MultiPolygon';
  readonly coordinates: GeoJsonPosition[][][];
}

/**
 * Discriminated union of all GeoJSON geometry types used by map features.
 * GeometryCollection is omitted; each feature carries a single geometry type.
 */
export type GeoJsonGeometry =
  | GeoJsonPoint
  | GeoJsonMultiPoint
  | GeoJsonLineString
  | GeoJsonMultiLineString
  | GeoJsonPolygon
  | GeoJsonMultiPolygon;

// ──────────────────────────────────────────────────────────────────────────────
//  Enumerations (string-union types)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Data confidence level for a feature or a specific field value.
 *
 * - `verified`  – Confirmed by an authoritative source (IGN, BAN, SIRENE,
 *                  official business website).
 * - `high`      – Strong corroboration from multiple independent sources.
 * - `medium`    – Single reliable source with consistent metadata.
 * - `low`       – Indirect or unverifiable source (directory listing, snippet).
 * - `uncertain` – No reliable source; best-effort estimate or placeholder.
 */
export type Confidence = 'verified' | 'high' | 'medium' | 'low' | 'uncertain';

/**
 * Lifecycle status of a feature or a specific field value.
 *
 * - `active`     – Currently valid and confirmed present on the ground.
 * - `uncertain`  – Existence or value is not fully confirmed.
 * - `inferred`   – Derived from other data (e.g. height from `building:levels`
 *                  or width from highway class).
 * - `unresolved` – Conflicting source data that could not be reconciled.
 */
export type Status = 'active' | 'uncertain' | 'inferred' | 'unresolved';

// ──────────────────────────────────────────────────────────────────────────────
//  Source & Provenance
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Immutable reference to a data source used during acquisition. Every raw
 * response is recorded with its timestamp, licence, and content hash so the
 * data lineage remains auditable.
 *
 * Source families include:
 * OpenStreetMap / Overpass API, geo.api.gouv.fr, Base Adresse Nationale (BAN),
 * IGN Géoplateforme, INSEE SIRENE, Annuaire des Entreprises, official business
 * websites, and corroborative public directories.
 */
export interface SourceReference {
  /** Source name or identifier (e.g. `'osm'`, `'ban'`, `'ign'`, `'sirene'`). */
  readonly source: string;
  /** URL or API endpoint from which the data was acquired. */
  readonly url?: string;
  /** ISO 8601 UTC timestamp when the data was acquired (e.g. `'2026-08-26T12:00:00Z'`). */
  readonly timestamp: string;
  /** SPDX licence identifier or legal restriction governing reuse (e.g. `'ODbL-1.0'`). */
  readonly license?: string;
  /** SHA-256 hex digest of the raw response body, when available. */
  readonly sha256?: string;
  /** Number of records or features obtained from this source in the request. */
  readonly recordCount?: number;
}

/**
 * Record of a resolved property conflict between multiple sources. Every
 * disagreement produces one ProvenanceRecord that remains visible in the
 * feature inspector so no resolution is hidden from audit.
 */
export interface ProvenanceRecord {
  /** Stable feature ID this provenance record belongs to. */
  readonly featureId: string;
  /** Property or field name that had conflicting values. */
  readonly property: string;
  /** The winning value after applying the source-priority policy. */
  readonly winner: string | number | boolean | null;
  /** Ordered list of source identifiers that contributed values (first = highest priority). */
  readonly contenders: readonly string[];
  /** Numeric priority level that selected the winner (higher = stronger source). */
  readonly priority: number;
  /** ISO 8601 UTC timestamp when the conflict was resolved. */
  readonly timestamp: string;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Feature Base
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Fields common to every strongly-typed map feature that carries source
 * references and provenance tracking. AddressFeature and TransportFeature
 * are intentionally narrower and do not extend this interface.
 */
interface FeatureBase {
  /**
   * Stable internal identifier.
   *
   * Format: `sourceType:sourceId` when the source provides a durable ID
   * (e.g. `ban:32013_0050_00028`, `osm:way/123456789`).
   *
   * Otherwise a deterministic hash of the feature kind, normalised name,
   * normalised address, rounded WGS84 coordinate, and normalised geometry
   * hash. No array position, acquisition order, or random ID is used.
   */
  readonly id: string;

  /** Optional human-readable name (not guaranteed unique). */
  readonly name?: string;

  /** WGS84 GeoJSON geometry in decimal degrees. */
  readonly geometry: GeoJsonGeometry;

  /** Ordered source references that contributed to this feature. */
  readonly sourceRefs: readonly SourceReference[];

  /** Provenance records for every property that had a source conflict. */
  readonly provenance: readonly ProvenanceRecord[];

  /** Overall data confidence level for this feature. */
  readonly confidence: Confidence;

  /** Feature lifecycle status. */
  readonly status: Status;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Feature Discriminants
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A building footprint or structure within the commune boundary.
 *
 * Height and level metadata are retained for the inspector and coverage report
 * only; the flat map renders footprints at `y = 0` without extrusion.
 *
 * **Height derivation order:**
 * 1. Source-backed explicit `height` tag (used as-is).
 * 2. Derived from `building:levels * 3.0` when levels are finite and positive.
 * 3. Restrained category default:
 *    - House: 3.5 m
 *    - Apartment block: 6.0 m
 *    - Garage / shed: 2.7 m
 *    - Retail: 5.0 m
 *    - Industrial / warehouse: 6.0 m
 *    - Church: 12.0 m
 *    - Generic building: 3.5 m
 *
 * Inferred heights are marked `status: 'inferred'`. Heights exceeding 18.0 m
 * without an explicit source value are rejected.
 */
export interface BuildingFeature extends FeatureBase {
  readonly kind: 'building';

  /** Building height in metres (source-backed, derived, or category default). */
  readonly height: number;

  /** Number of floors above ground, when source-backed or derived. */
  readonly levels?: number;

  /**
   * Local projected polygon rings.
   *
   * The first sub-array is the exterior ring; subsequent sub-arrays are
   * interior holes. Coordinates are in metres from the projection origin
   * (x = east, z = north).
   */
  readonly localCoords: readonly (readonly LocalPoint[])[];
}

/**
 * A road, street, highway, path, cycleway, or pedestrian way.
 *
 * **Width derivation order:**
 * 1. Explicit source-backed `width` tag.
 * 2. Class default:
 *    - Motorway: 12.0 m
 *    - Trunk / primary: 9.0 m
 *    - Secondary: 7.0 m
 *    - Tertiary: 6.0 m
 *    - Residential: 5.0 m
 *    - Service: 3.5 m
 *    - Pedestrian / footway: 2.0 m
 *    - Cycleway: 2.0 m
 *    - Path: 1.5 m
 *    - Track: 2.5 m
 *
 * Default widths are marked `status: 'inferred'`.
 */
export interface RoadFeature extends FeatureBase {
  readonly kind: 'road';

  /** OSM `highway` tag value (e.g. `'residential'`, `'secondary'`, `'service'`). */
  readonly highway: string;

  /** Road or path width in metres (source-backed or inferred class default). */
  readonly width: number;

  /** Surface material (`'paved'`, `'unpaved'`, `'asphalt'`, `'concrete'`, `'gravel'`, etc.). */
  readonly surface?: string;

  /** `true` when the road is carried by a bridge structure. */
  readonly bridge?: boolean;

  /** `true` when the road passes through a tunnel. */
  readonly tunnel?: boolean;

  /**
   * Local projected line-string coordinates in metres
   * (x = east, z = north).
   */
  readonly localCoords: readonly LocalPoint[];
}

/**
 * A water body: river, stream, canal, lake, pond, reservoir, etc.
 */
export interface WaterFeature extends FeatureBase {
  readonly kind: 'water';

  /** OSM `waterway`, `natural`, or `landuse` tag value (e.g. `'river'`, `'lake'`, `'pond'`). */
  readonly waterType: string;

  /**
   * Local projected polygon rings in metres (x = east, z = north).
   * First ring is exterior; subsequent rings are interior holes.
   */
  readonly localCoords: readonly (readonly LocalPoint[])[];
}

/**
 * A land-use or land-cover area: residential, commercial, industrial,
 * agricultural, forest, park, cemetery, allotment, etc.
 */
export interface LanduseFeature extends FeatureBase {
  readonly kind: 'landuse';

  /** OSM `landuse`, `natural`, or `leisure` tag value (e.g. `'residential'`, `'forest'`, `'park'`). */
  readonly landuseType: string;

  /**
   * Local projected polygon rings in metres (x = east, z = north).
   * First ring is exterior; subsequent rings are interior holes.
   */
  readonly localCoords: readonly (readonly LocalPoint[])[];
}

/**
 * A point of interest: amenity, tourism attraction, leisure facility,
 * or named shop.
 *
 * The `name` field is required for POIs because the feature is primarily
 * defined by its public-facing identity rather than its geometry.
 */
export interface PoiFeature extends FeatureBase {
  readonly kind: 'poi';

  /** Canonical POI name (required for search and display). */
  readonly name: string;

  /**
   * OSM `amenity`, `shop`, `tourism`, or `leisure` category value
   * (e.g. `'restaurant'`, `'pharmacy'`, `'supermarket'`, `'viewpoint'`).
   */
  readonly category: string;

  /** Local projected point in metres (x = east, z = north). */
  readonly localCoords: LocalPoint;
}

/**
 * A commercial business or establishment.
 *
 * Sourced from SIRENE, Annuaire des Entreprises, OSM, official business
 * websites, or corroborated directory listings (PagesJaunes). Business
 * features carry structured address data and optional SIRET identifiers.
 */
export interface BusinessFeature extends FeatureBase {
  readonly kind: 'business';

  /** Legal or operating name (required for search and display). */
  readonly name: string;

  /** Commercial trade name when it differs from the legal name. */
  readonly tradeName?: string;

  /** Full street address string (e.g. `'28 avenue d\'Alsace, 32000 Auch'`). */
  readonly address: string;

  /** Contact telephone number, when publicly listed. */
  readonly phone?: string;

  /** Official website URL, when publicly listed. */
  readonly website?: string;

  /**
   * SIRET identifier (14-digit French establishment identifier).
   * Present only when acquired from SIRENE or Annuaire des Entreprises.
   */
  readonly siret?: string;

  /** Local projected point in metres (x = east, z = north). */
  readonly localCoords: LocalPoint;
}

/**
 * A postal address from the Base Adresse Nationale (BAN) or OSM.
 *
 * This is intentionally **narrower** than FeatureBase: addresses carry no
 * provenance tracking and are treated as lightweight locator records rather
 * than fully-audited map features. They are included in the data pipeline
 * for geocoding and search but are not rendered as visible map geometry.
 */
export interface AddressFeature {
  readonly id: string;
  readonly kind: 'address';

  /** Street number or designation (e.g. `'28'`, `'2bis'`, `'s/n'`). */
  readonly number: string;

  /** Street name (e.g. `'Avenue d\'Alsace'`). */
  readonly street: string;

  /** City or commune name (e.g. `'Auch'`). */
  readonly city: string;

  /** French postal code (e.g. `'32000'`). */
  readonly postcode: string;

  /** Source of the address (`'ban'`, `'osm'`, etc.). */
  readonly source: string;

  /** Base Adresse Nationale record identifier, when the source is BAN. */
  readonly banId?: string;

  /** WGS84 GeoJSON Point geometry in decimal degrees. */
  readonly geometry: GeoJsonPoint;

  /** Local projected point in metres (x = east, z = north). */
  readonly localCoords: LocalPoint;

  /** Data confidence level (optional; defaults to `'verified'` for BAN-sourced addresses). */
  readonly confidence?: Confidence;

  /** Feature lifecycle status (optional; defaults to `'active'`). */
  readonly status?: Status;
}

/**
 * A transport infrastructure point: bus stop, train station, or parking area.
 *
 * Like AddressFeature, this is intentionally narrower than FeatureBase.
 * Transport features may lack full provenance tracking; they are included
 * for layer toggles and search but are not audited at the property-conflict
 * level.
 */
export interface TransportFeature {
  readonly id: string;
  readonly kind: 'transport';

  /** Transport sub-type discriminator. */
  readonly type: 'bus_stop' | 'train_station' | 'parking';

  /** Optional name (route name, station name, car-park identifier). */
  readonly name?: string;

  /** WGS84 GeoJSON Point geometry in decimal degrees. */
  readonly geometry: GeoJsonPoint;

  /** Local projected point in metres (x = east, z = north). */
  readonly localCoords: LocalPoint;

  /** Source references for this feature, when available. */
  readonly sourceRefs?: readonly SourceReference[];

  /** Data confidence level, when available. */
  readonly confidence?: Confidence;

  /** Feature lifecycle status, when available. */
  readonly status?: Status;
}

/**
 * Discriminated union of every map feature kind.
 *
 * The `kind` field acts as the discriminant for type narrowing:
 *
 * ```ts
 * function handleFeature(f: MapFeature): void {
 *   switch (f.kind) {
 *     case 'building':  f.height;    // narrows to BuildingFeature
 *     case 'road':      f.highway;   // narrows to RoadFeature
 *     case 'water':     f.waterType; // narrows to WaterFeature
 *     // ...
 *   }
 * }
 * ```
 */
export type MapFeature =
  | BuildingFeature
  | RoadFeature
  | WaterFeature
  | LanduseFeature
  | PoiFeature
  | BusinessFeature
  | AddressFeature
  | TransportFeature;

// ──────────────────────────────────────────────────────────────────────────────
//  Tile & Manifest Types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Manifest for a single spatial tile.
 *
 * Tiles are assigned using a deterministic half-open grid over the commune
 * bounding box. The maximum east and north edges are inclusive so that
 * features exactly on the boundary are assigned to one tile.
 */
export interface TileManifest {
  /** Tile identifier (row–column index or spatial hash). */
  readonly tileId: string;

  /**
   * Tile bounding box in local projected metres:
   * `[minX, minY, maxX, maxY]`.
   *
   * Guarantee: `minX <= maxX` and `minY <= maxY`.
   */
  readonly bounds: [minX: number, minY: number, maxX: number, maxY: number];

  /** Number of features packed into this tile. */
  readonly featureCount: number;

  /** Serialised tile data (`tiles/<tileId>.json`) size in bytes. */
  readonly byteSize: number;

  /** Stable feature IDs of every feature contained in this tile. */
  readonly features: readonly string[];
}

/**
 * Full coverage report for a single data-acquisition and generation run.
 *
 * All numeric counts in documentation **must** be copied from this generated
 * report, never estimated from a rectangular bounding-box query. This ensures
 * that the reported numbers correspond to the actual clipped, deduplicated,
 * and validated feature set.
 */
export interface CoverageReport {
  /** Dataset version string (e.g. `'1.0.0'`). */
  readonly datasetVersion: string;

  /** ISO 8601 UTC timestamp of acquisition completion. */
  readonly acquisitionTime: string;

  /** WGS84 GeoJSON Polygon of the commune boundary. */
  readonly boundary: GeoJsonPolygon;

  /** Projection origin as a WGS84 coordinate [longitude, latitude]. */
  readonly projectionOrigin: Wgs84Coordinate;

  /** Tile edge length in metres. */
  readonly tileSize: number;

  /** Total number of tiles generated. */
  readonly tileCount: number;

  /** Feature counts keyed by feature kind (e.g. `building: 420`, `road: 830`). */
  readonly featureCounts: Readonly<Record<string, number>>;

  /** Record counts keyed by source name (e.g. `osm: 1250`, `ban: 980`). */
  readonly sourceCounts: Readonly<Record<string, number>>;

  /** Human-readable descriptions of unresolved categories or gaps. */
  readonly unresolved: readonly string[];

  /** Source identifiers that failed during acquisition. */
  readonly failedSources: readonly string[];

  /**
   * Measured budget metrics.
   *
   * Includes tile byte-size bounds, query timing, and feature counts per
   * category. Values are numeric measurements or short descriptive strings.
   */
  readonly budgets: Readonly<Record<string, number | string>>;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Nocibé Commercial-Audit Focus
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A named anchor point within the Nocibé commercial audit zone.
 *
 * The three verified anchors are:
 * 1. **Avenue d'Alsace** – Nocibé store location (28 avenue d'Alsace)
 * 2. **Place de Verdun** – Near the store entrance / square
 * 3. **Place Villaret Joyeuse** – Commercial corridor anchor
 */
export interface NocibeAnchor {
  /** Human-readable anchor label (e.g. `'Avenue d\'Alsace'`). */
  readonly name: string;
  /** WGS84 coordinate [longitude, latitude] of the anchor. */
  readonly coord: Wgs84Coordinate;
}

/**
 * Commercial focus object for the Nocibé audited perimeter (zone de
 * chalandise). Constructed from BAN, PagesJaunes, SIRENE / Annuaire des
 * Entreprises, and any accessible official Nocibé page.
 *
 * The focus drives:
 * - Search relevance for `Nocibé` / `Nocibe` / `nocib`
 * - The orange audited-perimeter overlay (750 m radius + 80 m corridor)
 * - Camera focus when selected
 * - Nearby business listing filtering
 */
export interface NocibeFocus {
  /** Canonical display name (`'Nocibé'`). */
  readonly name: string;

  /** Accent-insensitive search key (`'nocibe'`). */
  readonly searchKey: string;

  /** BAN record identifier (e.g. `'32013_0050_00028'`). */
  readonly banId: string;

  /** Verified street address (`'28 avenue d\'Alsace, 32000 Auch'`). */
  readonly address: string;

  /** WGS84 coordinates [longitude, latitude] of the Nocibé location. */
  readonly coord: Wgs84Coordinate;

  /** Ordered source references that contributed to this focus record. */
  readonly sourceRefs: readonly SourceReference[];

  /** Data confidence level for the Nocibé presence and address. */
  readonly confidence: Confidence;

  /** Feature lifecycle status. */
  readonly status: Status;

  /** Verified commercial-audit anchor points (minimum 3). */
  readonly anchors: readonly NocibeAnchor[];
}