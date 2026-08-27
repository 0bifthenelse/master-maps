// @ts-nocheck
/**
 * @file POI marker geometry builder.
 *
 * Converts PoiFeature records into batched Three.js geometry for
 * the flat map.  Two strategies are exported:
 *
 *   1. `buildPoiInstances()` – InstancedMesh with CircleGeometry base,
 *      per-instance colour and transformation.  Supports raycast picking
 *      via `instanceId`.
 *
 *   2. `buildPoiPoints()`  – Lightweight Points geometry using poiMat
 *      (accent #ff7d27).  No per-instance interaction, minimal GPU cost.
 *
 * @see THEME: poiMat (PointsMaterial, accent colour)
 * @see PLAN §6: "Use batched marker geometry or InstancedMesh for POIs"
 */

import {
  BufferGeometry,
  CircleGeometry,
  Color,
  Float32BufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Points,
  Quaternion,
  Vector3,
} from 'three';

// ─── Local types ────────────────────────────────────────────────────────────

type CoordPair = [number, number]; // [x, z]

interface PointRep {
  type: 'Point';
  coordinates: CoordPair;
}

export interface PoiFeatureShape {
  kind: 'poi';
  stableId: string;
  geometry: PointRep;
  name?: string;
  category?: string;
  /** Optional icon key (future use). */
  icon?: string;
  /** Optional override colour (CSS hex, e.g. "#e74c3c"). */
  color?: string;
  /** Marker size in metres (default 4). */
  size?: number;
}
export interface BusinessFeatureShape {
  kind: 'business';
  stableId: string;
  geometry: PointRep;
  name?: string;
  businessName?: string;
  legalName?: string;
  brand?: string;
  category?: string;
  nafLabel?: string;
  nafCode?: string;
  address?: string;
  siret?: string;
  phone?: string;
  website?: string;
  size?: number;
  openingHours?: string;
  operator?: string;
  wheelchair?: string;
}

// ─── Builder result types ───────────────────────────────────────────────────

export interface InstancedResult {
  kind: 'instanced';
  mesh: InstancedMesh;
  featureCount: number;
  /** Maps instanceId → feature array index. */
  featureIdByInstance: number[];
}
export interface BusinessInstancedResult {
  kind: 'business-instanced';
  mesh: InstancedMesh;
  featureCount: number;
  /** Maps instanceId → business feature array index. */
  featureIdByInstance: number[];
  /** Updates one instance colour without changing React state. */
  setHighlight: (instanceId: number | null) => void;
}

export interface PointsResult {
  kind: 'points';
  points: Points;
  featureCount: number;
}

export type PoiBuildResult = InstancedResult | PointsResult;

// ─── Constants & shared state ───────────────────────────────────────────────

const DEFAULT_BUSINESS_SIZE = 6;
const BUSINESS_COLOR = '#d34f2f';
const BUSINESS_HOVER_COLOR = '#ffb000';
const DEFAULT_POI_SIZE = 4; // metres diameter

const _matrix = new Matrix4();
const _position = new Vector3();
const _scale = new Vector3();
const _quat = new Quaternion();
const _color = new Color();

/** Shared CircleGeometry rotated to lie flat on the XZ plane at y=0. */
let _sharedCircleGeom: CircleGeometry | null = null;

function getCircleGeometry(): CircleGeometry {
  if (!_sharedCircleGeom) {
    const g = new CircleGeometry(1, 16); // radius 1, 16 segments
    g.rotateX(-Math.PI / 2);             // lay flat onto XZ plane
    _sharedCircleGeom = g;
  }
  return _sharedCircleGeom;
}

// ─── InstancedMesh builder ──────────────────────────────────────────────────

/**
 * Build an InstancedMesh of circular POI markers.
 *
 * Each POI is a flat circle at y=0 drawn with a MeshBasicMaterial.
 * Instance colour defaults to accent (#ff7d27) unless `color` is specified.
 *
 * @param features - POI features with Point geometry (local coordinates).
 * @returns InstancedMesh ready to add to the scene, plus instance→feature mapping.
 */
export function buildPoiInstances(features: PoiFeatureShape[]): InstancedResult {
  const count = features.length;
  if (count === 0) {
    const mesh = new InstancedMesh(getCircleGeometry(), new MeshBasicMaterial(), 0);
    return { kind: 'instanced', mesh, featureCount: 0, featureIdByInstance: [] };
  }

  const material = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  });
  const mesh = new InstancedMesh(getCircleGeometry(), material, count);
  mesh.count = count;

  const featureIdByInstance: number[] = [];

  for (let i = 0; i < count; i++) {
    const feat = features[i];
    const size = feat.size ?? DEFAULT_POI_SIZE;
    const [x, z] = feat.geometry.coordinates;

    // Full transform: translate to (x, 0, z), identity rotation, uniform scale.
    // CircleGeometry radius = 1, so scale = size/2 yields diameter = `size`.
    _position.set(x, 0, z);
    _scale.set(size / 2, size / 2, 1);
    _quat.identity();
    _matrix.compose(_position, _quat, _scale);
    mesh.setMatrixAt(i, _matrix);

    // Per-instance colour (defaults to accent).
    _color.set(feat.color ?? '#ff7d27');
    mesh.setColorAt(i, _color);

    featureIdByInstance.push(i);
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  // Tag for raycast picking and metadata lookup.
  mesh.userData.poiFeatureIds = featureIdByInstance;
  mesh.userData.poiFeatures = features;

  return {
    kind: 'instanced',
    mesh,
    featureCount: count,
    featureIdByInstance,
  };
}
export function buildBusinessInstances(
  features: BusinessFeatureShape[],
): BusinessInstancedResult {
  const count = features.length;
  const material = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  });
  const mesh = new InstancedMesh(getCircleGeometry(), material, count);
  mesh.count = count;
  mesh.frustumCulled = false;
  const featureIdByInstance: number[] = [];
  const baseColors = features.map(() => BUSINESS_COLOR);

  for (let i = 0; i < count; i += 1) {
    const feature = features[i];
    const [x, z] = feature.geometry.coordinates;
    _position.set(x, 0, z);
    _scale.set((feature.size ?? DEFAULT_BUSINESS_SIZE) / 2, (feature.size ?? DEFAULT_BUSINESS_SIZE) / 2, 1);
    _quat.identity();
    _matrix.compose(_position, _quat, _scale);
    mesh.setMatrixAt(i, _matrix);
    _color.set(baseColors[i]);
    mesh.setColorAt(i, _color);
    featureIdByInstance.push(i);
  }

  let highlightedInstance = -1;
  const setHighlight = (instanceId: number | null): void => {
    if (!mesh.instanceColor) return;
    if (highlightedInstance >= 0 && highlightedInstance < count) {
      _color.set(baseColors[highlightedInstance]);
      mesh.setColorAt(highlightedInstance, _color);
    }
    if (instanceId !== null && instanceId >= 0 && instanceId < count) {
      _color.set(BUSINESS_HOVER_COLOR);
      mesh.setColorAt(instanceId, _color);
      highlightedInstance = instanceId;
    } else {
      highlightedInstance = -1;
    }
    mesh.instanceColor.needsUpdate = true;
  };

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.userData.businessFeatureIds = featureIdByInstance;
  mesh.userData.businessFeatures = features;

  return {
    kind: 'business-instanced',
    mesh,
    featureCount: count,
    featureIdByInstance,
    setHighlight,
  };
}

// ─── Points builder ─────────────────────────────────────────────────────────

/**
 * Build a lightweight Points geometry from POI features.
 *
 * Simpler and lower GPU cost than InstancedMesh, but does not support
 * per-instance picking or individual colours in the basic PointsMaterial.
 * Use when per-POI interaction is not required.
 *
 * @param features - POI features.
 * @returns Points object using poiMat (imported from materials.ts by the scene).
 */
export function buildPoiPoints(features: PoiFeatureShape[]): PointsResult {
  const count = features.length;
  if (count === 0) {
    return { kind: 'points', points: new Points(new BufferGeometry()), featureCount: 0 };
  }

  const positions: number[] = [];

  for (let i = 0; i < count; i++) {
    const feat = features[i];
    const [x, z] = feat.geometry.coordinates;
    positions.push(x, 0, z);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));

  // Feature index per vertex for diagnostics lookup.
  const indices = new Float32BufferAttribute(
    Float32Array.from(features.map((_, i) => i)),
    1,
  );
  indices.name = 'featureIndex';
  geometry.setAttribute('featureIndex', indices);

  geometry.computeVertexNormals();

  const points = new Points(geometry);
  points.userData.poiFeatures = features;

  return { kind: 'points', points, featureCount: count };
}

// ─── Default export (prefer InstancedMesh) ──────────────────────────────────

/**
 * Default POI builder – uses InstancedMesh for clickable markers.
 *
 * @see buildPoiInstances
 */
export default function buildPois(features: PoiFeatureShape[]): InstancedResult {
  return buildPoiInstances(features);
}

export { buildPois };