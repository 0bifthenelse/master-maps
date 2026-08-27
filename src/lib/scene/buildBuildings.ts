// @ts-nocheck
/**
 * @file Flat building footprint geometry builder.
 *
 * Converts BuildingFeature records (Polygon / MultiPolygon at y=0) into a
 * single merged BufferGeometry with per-vertex feature-picking indices.
 *
 * No extrusion – height / level data stays on feature records for the
 * inspector and coverage report only.
 *
 * @see PLAN §6: "Buildings render as flat source-backed footprints at y=0"
 * @see THEME: buildingMat (warm gray semi-transparent fill)
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Shape,
  ShapeGeometry,
  Path,
  type Vector2,
} from 'three';
import { mapShapeGeometryToWorld } from "./geometryCoordinates";

// ─── Local type guards (matches expected schema.ts shape) ──────────────────

/**
 * A 2D coordinate array used by Polygon / MultiPolygon rings.
 * All values are in local projected metres.
 */
type CoordPair = [number, number]; // [x, z]  (east, north)

interface PolygonRep {
  type: 'Polygon';
  coordinates: CoordPair[][]; // first = outer, rest = holes
}

interface MultiPolygonRep {
  type: 'MultiPolygon';
  coordinates: CoordPair[][][]; // each entry is a Polygon rep
}

export interface BuildingFeatureShape {
  kind: 'building';
  stableId: string;
  geometry: PolygonRep | MultiPolygonRep;
  height?: number;
  levels?: number;
  heightSource?: 'explicit' | 'inferred_from_levels' | 'inferred_default';
  name?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Build a Three.js Shape from an outer ring of CoordPairs.
 * The ring is treated as (x, y) in Shape space; the resulting geometry
 * is rotated into the xz-plane at y=0 after creation.
 */
function ringToShape(outerRing: CoordPair[]): Shape {
  const shape = new Shape();
  if (outerRing.length < 3) return shape; // degenerate

  shape.moveTo(outerRing[0][0], outerRing[0][1]);
  for (let i = 1; i < outerRing.length; i++) {
    shape.lineTo(outerRing[i][0], outerRing[i][1]);
  }
  shape.closePath();
  return shape;
}

/**
 * Add holes (inner rings) to a Shape.
 */
function addHolesToShape(shape: Shape, holes: CoordPair[][]): void {
  for (const holeRing of holes) {
    if (holeRing.length < 3) continue;
    const path = new Path();
    path.moveTo(holeRing[0][0], holeRing[0][1]);
    for (let i = 1; i < holeRing.length; i++) {
      path.lineTo(holeRing[i][0], holeRing[i][1]);
    }
    path.closePath();
    shape.holes.push(path);
  }
}
/**
 * Create a ShapeGeometry from a Shape in the shared x=east, z=north
 * coordinate contract and append a feature index attribute.
 */
function shapeGeometryForFeature(
  shape: Shape,
  featureIndex: number,
): BufferGeometry {
  const geom = mapShapeGeometryToWorld(new ShapeGeometry(shape));

  // Tag every vertex with the feature index for picking.
  const vertexCount = geom.getAttribute('position')?.count ?? 0;
  const indices = new Float32BufferAttribute(
    new Float32Array(vertexCount).fill(featureIndex),
    1,
  );
  indices.name = 'featureIndex';
  geom.setAttribute('featureIndex', indices);

  return geom;
}

// ─── Merge utility ───────────────────────────────────────────────────────────

/**
 * Concatenate multiple BufferGeometry objects into one.
 * Copied inline to avoid an external addon dependency.
 */
function mergeGeometries(geometries: BufferGeometry[]): BufferGeometry {
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

    // Copy positions
    for (let i = 0; i < posArr.length; i++) {
      positions.push(posArr[i]);
    }

    // Copy feature index (one per vertex)
    if (fi) {
      const fiArr = fi.array as Float32Array;
      for (let i = 0; i < fiArr.length; i++) {
        featureIndices.push(fiArr[i]);
      }
    } else {
      for (let i = 0; i < count; i++) {
        featureIndices.push(0);
      }
    }

    // Copy & offset indices
    if (idx) {
      const idxArr = idx.array as Uint16Array | Uint32Array;
      for (let i = 0; i < idxArr.length; i++) {
        indices.push(idxArr[i] + vertexOffset);
      }
    } else {
      // Non-indexed geometry: add sequential indices
      for (let i = 0; i < count; i++) {
        indices.push(i + vertexOffset);
      }
    }

    vertexOffset += count;
  }

  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.setAttribute('featureIndex', new Float32BufferAttribute(featureIndices, 1));
  merged.computeVertexNormals();

  return merged;
}

// ─── Main builder ───────────────────────────────────────────────────────────

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
}

/**
 * Build flat building footprints from normalized BuildingFeature records.
 *
 * @param features - Array of building features (may be empty).
 * @returns       - Merged BufferGeometry + count of features processed.
 *
 * Performance note: for large datasets (>500 buildings) consider grouping
 * by material or using mergeGeometries from BufferGeometryUtils.
 */
export function buildBuildings(features: BuildingFeatureShape[]): BuildResult {
  if (features.length === 0) {
    return { geometry: new BufferGeometry(), featureCount: 0 };
  }

  const geoms: BufferGeometry[] = [];

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi];
    const geo = feat.geometry;

    if (geo.type === 'Polygon') {
      const [outer, ...holes] = geo.coordinates;
      if (outer.length < 3) continue;

      const shape = ringToShape(outer);
      addHolesToShape(shape, holes);
      geoms.push(shapeGeometryForFeature(shape, fi));
    } else if (geo.type === 'MultiPolygon') {
      for (const polyCoords of geo.coordinates) {
        const [outer, ...holes] = polyCoords;
        if (outer.length < 3) continue;

        const shape = ringToShape(outer);
        addHolesToShape(shape, holes);
        geoms.push(shapeGeometryForFeature(shape, fi));
      }
    }
  }

  const merged = geoms.length > 1
    ? mergeGeometries(geoms)
    : geoms.length === 1
      ? geoms[0]
      : new BufferGeometry();

  if (geoms.length > 1) {
    for (const geometry of geoms) geometry.dispose();
  }

  return { geometry: merged, featureCount: features.length };
}

/**
 * Convenience alias – matches naming convention of sibling builders.
 */
export { buildBuildings as default };