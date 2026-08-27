// @ts-nocheck
/**
 * @file Commune boundary outline builder.
 *
 * Converts the boundary feature's Polygon / MultiPolygon rings into a single
 * LINES BufferGeometry (pairs of endpoints per edge) at a small y-offset
 * above the ground plane, rendered with boundaryLineMat to trace the Auch
 * commune outline.
 */

import { BufferGeometry, Float32BufferAttribute } from 'three';

// ─── Local types ────────────────────────────────────────────────────────────

type CoordPair = [number, number]; // [x, z] projected metres

interface PolygonRep {
  type: 'Polygon';
  coordinates: CoordPair[][]; // [outer, ...holes]
}

interface MultiPolygonRep {
  type: 'MultiPolygon';
  coordinates: CoordPair[][][];
}

export interface BoundaryFeatureShape {
  kind: 'boundary';
  stableId: string;
  geometry: PolygonRep | MultiPolygonRep;
}

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Y-offset above the ground plane to avoid z-fighting with fills. */
const BOUNDARY_Y = 0.5;

function pushRingSegments(ring: CoordPair[], positions: number[]): void {
  if (ring.length < 2) return;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    positions.push(a[0], BOUNDARY_Y, a[1], b[0], BOUNDARY_Y, b[1]);
  }
}

// ─── Main builder ───────────────────────────────────────────────────────────

/**
 * Build the commune boundary outline as a LINES BufferGeometry from
 * BoundaryFeature records. Every ring (outer + holes) of every polygon is
 * traced as a closed loop of segments.
 */
export function buildBoundary(features: BoundaryFeatureShape[]): BuildResult {
  const positions: number[] = [];
  let featureCount = 0;

  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === 'Polygon') {
      for (const ring of geometry.coordinates) pushRingSegments(ring, positions);
      featureCount += 1;
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) pushRingSegments(ring, positions);
      }
      featureCount += 1;
    }
  }

  const bufferGeometry = new BufferGeometry();
  bufferGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return { geometry: bufferGeometry, featureCount };
}

export default buildBoundary;
