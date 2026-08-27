// @ts-nocheck
/**
 * @file Flat road ribbon builder.
 *
 * Converts RoadFeature LineStrings into merged ribbon geometry at y=0.
 * Each road segment is expanded perpendicularly by its class width to
 * produce a filled polygon strip.
 *
 * Bridge / tunnel flags are carried as metadata attributes so the scene
 * can apply z-order or styling hints without elevating geometry.
 *
 * @see PLAN §6: "Build road ribbons from actual line geometry with class widths"
 * @see WIDTH_DEFAULTS by highway classification
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
} from 'three';

// ─── Types ──────────────────────────────────────────────────────────────────

type CoordPair = [number, number]; // [x, z] projected metres

interface LineStringRep {
  type: 'LineString';
  coordinates: CoordPair[];
}

interface MultiLineStringRep {
  type: 'MultiLineString';
  coordinates: CoordPair[][];
}

export interface RoadFeatureShape {
  kind: 'road';
  stableId: string;
  /** Explicit width in metres (overrides classification default). */
  width?: number;
  /** OSM highway classification. */
  highway?:
    | 'motorway' | 'trunk' | 'primary'
    | 'secondary' | 'tertiary'
    | 'residential' | 'service'
    | 'pedestrian' | 'footway'
    | 'cycleway' | 'path' | 'track'
    | 'unclassified'
    | string;
  bridge?: boolean;
  tunnel?: boolean;
  name?: string;
  /** Source layer for z-ordering. */
  layer?: string;
  geometry: LineStringRep | MultiLineStringRep;
}

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
  /** Total road length in metres (sum of all LineString lengths). */
  totalLengthMetres: number;
}

// ─── Width defaults ─────────────────────────────────────────────────────────

const WIDTH_DEFAULTS: Record<string, number> = {
  motorway: 12.0,
  trunk: 9.0,
  primary: 9.0,
  secondary: 7.0,
  tertiary: 6.0,
  residential: 5.0,
  service: 3.5,
  pedestrian: 2.0,
  footway: 2.0,
  cycleway: 2.0,
  path: 1.5,
  track: 2.5,
  unclassified: 4.0,
};

function resolveWidth(feature: RoadFeatureShape): number {
  if (feature.width != null && feature.width > 0) return feature.width;
  const cls = feature.highway;
  if (cls && WIDTH_DEFAULTS[cls] !== undefined) return WIDTH_DEFAULTS[cls];
  return 4.0; // fallback for unknown classifications
}

// ─── Ribbon geometry helper ─────────────────────────────────────────────────

/**
 * Build a filled ribbon (triangle strip) along a polyline with the given width.
 *
 * Each segment produces two triangles (one quad). Adjacent segments share
 * vertices so there are no gaps at corners. The ribbon lies at y=0.
 */
function ribbonGeometry(
  coords: CoordPair[],
  halfWidth: number,
  featureIndex: number,
): BufferGeometry {
  if (coords.length < 2) return new BufferGeometry();

  // Per-vertex data: position (3), featureIndex (1), bridge/tunnel flags carried separately
  const positions: number[] = [];
  const indices: number[] = [];
  const featureIndices: number[] = [];

  let vertexCount = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, z0] = coords[i];
    const [x1, z1] = coords[i + 1];

    // Segment direction and perpendicular (right-hand)
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-8) continue; // skip zero-length segments

    const nx = -dz / len * halfWidth;  // perpendicular X
    const nz = dx / len * halfWidth;   // perpendicular Z

    // Four corners of the quad (left/right at start/end)
    // Left side is perpendicular direction, right side is opposite
    // Vertex layout: 0=start-left, 1=start-right, 2=end-left, 3=end-right
    const vl = [
      [x0 - nx, z0 - nz],  // start-left  (0)
      [x0 + nx, z0 + nz],  // start-right (1)
      [x1 - nx, z1 - nz],  // end-left    (2)
      [x1 + nx, z1 + nz],  // end-right   (3)
    ];

    const base = vertexCount;

    // Add vertices
    for (const [px, pz] of vl) {
      positions.push(px, 0, pz);
      featureIndices.push(featureIndex);
    }

    // Two triangles: (0,1,2) and (1,3,2)
    indices.push(
      base + 0, base + 1, base + 2,
      base + 1, base + 3, base + 2,
    );

    vertexCount += 4;
  }

  if (positions.length === 0) return new BufferGeometry();

  const geom = new BufferGeometry();
  geom.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.setAttribute('featureIndex', new Float32BufferAttribute(featureIndices, 1));
  return geom;
}

// ─── Merge helper ───────────────────────────────────────────────────────────

function mergeGeometries(geometries: BufferGeometry[]): BufferGeometry {
  if (geometries.length === 0) return new BufferGeometry();
  if (geometries.length === 1) return geometries[0];

  const merged = new BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const featureIndices: number[] = [];
  let vertexOffset = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const fi = g.getAttribute('featureIndex');
    if (!pos) continue;

    const posArr = pos.array as Float32Array;
    const count = pos.count;

    for (let i = 0; i < posArr.length; i++) positions.push(posArr[i]);

    if (fi) {
      const fiArr = fi.array as Float32Array;
      for (let i = 0; i < fiArr.length; i++) featureIndices.push(fiArr[i]);
    } else {
      for (let i = 0; i < count; i++) featureIndices.push(0);
    }

    if (idx) {
      const idxArr = idx.array as Uint16Array | Uint32Array;
      for (let i = 0; i < idxArr.length; i++) indices.push(idxArr[i] + vertexOffset);
    } else {
      for (let i = 0; i < count; i++) indices.push(i + vertexOffset);
    }

    vertexOffset += count;
  }

  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.setAttribute('featureIndex', new Float32BufferAttribute(featureIndices, 1));
  return merged;
}

// ─── Per-segment metadata for bridge / tunnel detection ─────────────────────

/**
 * Check whether any segment of the road is a bridge or tunnel.
 * (In a flat map these are z-order hints, not geometry changes.)
 */
function hasBridge(feature: RoadFeatureShape): boolean {
  return feature.bridge === true;
}

function hasTunnel(feature: RoadFeatureShape): boolean {
  return feature.tunnel === true;
}

// ─── Main builder ───────────────────────────────────────────────────────────

/**
 * Build flat road ribbon geometry from RoadFeature records.
 *
 * @param features - Array of road features.
 * @param layerFilter - Optional: only process roads with this `highway` value.
 * @returns Merged ribbon geometry, feature count, and total length.
 */
export function buildRoads(
  features: RoadFeatureShape[],
  layerFilter?: string,
): BuildResult {
  if (features.length === 0) {
    return { geometry: new BufferGeometry(), featureCount: 0, totalLengthMetres: 0 };
  }

  const geoms: BufferGeometry[] = [];
  let totalLength = 0;

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi];

    // Optional layer filter
    if (layerFilter !== undefined && feat.highway !== layerFilter) continue;

    const lineStrings = feat.geometry.type === 'LineString'
      ? [feat.geometry.coordinates]
      : feat.geometry.coordinates;
    const width = resolveWidth(feat);
    const halfWidth = width / 2;

    for (const coords of lineStrings) {
      if (coords.length < 2) continue;

      // Accumulate length for reporting.
      for (let i = 0; i < coords.length - 1; i++) {
        const dx = coords[i + 1][0] - coords[i][0];
        const dz = coords[i + 1][1] - coords[i][1];
        totalLength += Math.sqrt(dx * dx + dz * dz);
      }

      const ribbon = ribbonGeometry(coords, halfWidth, fi);
      // Tag bridge/tunnel as a draw attribute for the scene to consume.
      if (hasBridge(feat)) ribbon.userData.bridge = true;
      if (hasTunnel(feat)) ribbon.userData.tunnel = true;
      if ((ribbon.getAttribute('position')?.count ?? 0) > 0) geoms.push(ribbon);
    }

  }
  const merged = mergeGeometries(geoms);
  if (geoms.length > 1) {
    for (const intermediate of geoms) intermediate.dispose();
  }

  return {
    geometry: merged,
    featureCount: features.length,
    totalLengthMetres: totalLength,
  };
}

export default buildRoads;