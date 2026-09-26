/**
 * @file Gers department boundary outline builder.
 *
 * The department outline is a single dataset-level artifact. It is built
 * once and mounted once, never per tile fragment: every tile carries a
 * clipped copy of the same stableId, and tessellating all of them cost
 * 146 ms per React commit and 1 038 640 duplicate vertices.
 */
import { BufferGeometry, Float32BufferAttribute, LineSegments } from 'three';
import type { BoundaryFeature, Coordinate } from '@/lib/data/schema';

type CoordPair = Coordinate;
export type BoundaryFeatureShape = Pick<BoundaryFeature, 'kind' | 'stableId' | 'geometry'>;

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
}

const BOUNDARY_Y = 0.5;

function pushRingSegments(ring: CoordPair[], positions: number[]): void {
  if (ring.length < 2) return;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    positions.push(a[0], BOUNDARY_Y, a[1], b[0], BOUNDARY_Y, b[1]);
  }
}

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

/**
 * Select the one boundary feature to mount for the whole dataset.
 *
 * Prefers the copy carrying the most vertices, which is the full
 * department outline rather than a tile clip. Ties break on the lowest
 * fragmentId so the choice is stable across React commits.
 */
export function selectDatasetBoundary(features: BoundaryFeatureShape[]): BoundaryFeatureShape | null {
  let best: BoundaryFeatureShape | null = null;
  let bestVertices = -1;
  for (const feature of features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    let vertices = 0;
    if (geometry.type === 'Polygon') {
      for (const ring of geometry.coordinates) vertices += ring.length;
    } else {
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) vertices += ring.length;
      }
    }
    if (vertices <= 1) continue;
    const incumbent = best as { stableId: string; fragmentId?: string } | null;
    if (vertices > bestVertices) {
      best = feature;
      bestVertices = vertices;
      continue;
    }
    if (vertices === bestVertices && incumbent && best) {
      const candidateId = `${feature.stableId}@${(feature as { fragmentId?: string }).fragmentId ?? ''}`;
      const currentId = `${best.stableId}@${(best as { fragmentId?: string }).fragmentId ?? ''}`;
      if (candidateId < currentId) best = feature;
    }
  }
  return best;
}

export function buildDatasetBoundary(features: BoundaryFeatureShape[]): BuildResult & { object: LineSegments | null } {
  const selected = selectDatasetBoundary(features);
  if (selected === null) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([], 3));
    return { geometry, featureCount: 0, object: null };
  }
  const result = buildBoundary([selected]);
  return { ...result, object: new LineSegments(result.geometry) };
}

export default buildBoundary;
