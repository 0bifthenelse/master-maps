// @ts-nocheck
/**
 * @file Water-body geometry builder.
 *
 * Converts WaterFeature records (Polygon / MultiPolygon) into a single
 * merged BufferGeometry at y=0 with a flat fill.  Used with waterMat
 * (muted blue) in the flat map.
 *
 * @see PLAN §6: "Render water surfaces as flat filled polygons"
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Shape,
  ShapeGeometry,
  Path,
} from 'three';

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

export interface WaterFeatureShape {
  kind: 'water';
  stableId: string;
  geometry: PolygonRep | MultiPolygonRep;
  name?: string;
  /** OSM waterway or natural tag. */
  waterType?: 'river' | 'lake' | 'reservoir' | 'pond' | 'ditch' | 'canal' | 'basin' | string;
}

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
  /** Total water surface area in square metres (sum of all polygons). */
  areaMetres: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ringToShape(outerRing: CoordPair[]): Shape {
  const shape = new Shape();
  if (outerRing.length < 3) return shape;
  shape.moveTo(outerRing[0][0], outerRing[0][1]);
  for (let i = 1; i < outerRing.length; i++) {
    shape.lineTo(outerRing[i][0], outerRing[i][1]);
  }
  shape.closePath();
  return shape;
}

function addHoles(shape: Shape, holes: CoordPair[][]): void {
  for (const ring of holes) {
    if (ring.length < 3) continue;
    const path = new Path();
    path.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) {
      path.lineTo(ring[i][0], ring[i][1]);
    }
    path.closePath();
    shape.holes.push(path);
  }
}

function buildGeometryForShape(shape: Shape, featureIndex: number): BufferGeometry {
  const geom = new ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);

  const count = geom.getAttribute('position')?.count ?? 0;
  const indices = new Float32BufferAttribute(
    new Float32Array(count).fill(featureIndex), 1,
  );
  indices.name = 'featureIndex';
  geom.setAttribute('featureIndex', indices);

  return geom;
}

// ─── Area calculation (shoelace) ───────────────────────────────────────────

function polygonArea(rings: CoordPair[][]): number {
  let total = 0;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      area += ring[i][0] * ring[j][1];
      area -= ring[j][0] * ring[i][1];
    }
    total += Math.abs(area) / 2;
  }
  return total;
}

// ─── Merge (inline, avoids BufferGeometryUtils dependency) ─────────────────

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

    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i++) positions.push(arr[i]);

    if (fi) {
      const f = fi.array as Float32Array;
      for (let i = 0; i < f.length; i++) featureIndices.push(f[i]);
    } else {
      for (let i = 0; i < pos.count; i++) featureIndices.push(0);
    }

    if (idx) {
      const iarr = idx.array as Uint16Array | Uint32Array;
      for (let i = 0; i < iarr.length; i++) indices.push(iarr[i] + vertexOffset);
    } else {
      for (let i = 0; i < pos.count; i++) indices.push(i + vertexOffset);
    }
    vertexOffset += pos.count;
  }

  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.setAttribute('featureIndex', new Float32BufferAttribute(featureIndices, 1));

  return merged;
}

// ─── Main builder ───────────────────────────────────────────────────────────

/**
 * Build flat water-body geometry from WaterFeature records.
 *
 * @param features - Array of water features (rivers, lakes, ponds, etc.).
 * @returns Merged polygon geometry, water-body count, and total area in m².
 */
export function buildWater(features: WaterFeatureShape[]): BuildResult {
  if (features.length === 0) {
    return { geometry: new BufferGeometry(), featureCount: 0, areaMetres: 0 };
  }

  const geoms: BufferGeometry[] = [];
  let totalArea = 0;

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi];
    const geo = feat.geometry;

    if (geo.type === 'Polygon') {
      totalArea += polygonArea([geo.coordinates[0]]);
      const [outer, ...holes] = geo.coordinates;
      if (outer.length < 3) continue;
      const shape = ringToShape(outer);
      addHoles(shape, holes);
      geoms.push(buildGeometryForShape(shape, fi));
    } else if (geo.type === 'MultiPolygon') {
      for (const polyCoords of geo.coordinates) {
        totalArea += polygonArea([polyCoords[0]]);
        const [outer, ...holes] = polyCoords;
        if (outer.length < 3) continue;
        const shape = ringToShape(outer);
        addHoles(shape, holes);
        geoms.push(buildGeometryForShape(shape, fi));
      }
    }
  }

  return {
    geometry: mergeGeometries(geoms),
    featureCount: features.length,
    areaMetres: totalArea,
  };
}

export default buildWater;