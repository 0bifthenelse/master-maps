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
import { mapShapeGeometryToWorld } from "./geometryCoordinates";

// ─── Local types ────────────────────────────────────────────────────────────

type CoordPair = [number, number]; // [x, z] projected metres
interface LineStringRep {
  type: 'LineString';
  coordinates: CoordPair[];
}

interface MultiLineStringRep {
  type: 'MultiLineString';
  coordinates: CoordPair[][];
}

interface PolygonRep {
  type: 'Polygon';
  coordinates: CoordPair[][]; // [outer, ...holes]
}

interface MultiPolygonRep {
  type: 'MultiPolygon';
  coordinates: CoordPair[][][];
}

type WaterGeometry = LineStringRep | MultiLineStringRep | PolygonRep | MultiPolygonRep;

export interface WaterFeatureShape {
  kind: 'water';
  stableId: string;
  geometry: WaterGeometry;
  name?: string;
  /** OSM waterway or natural tag. */
  waterType?: 'river' | 'lake' | 'reservoir' | 'pond' | 'stream' | 'ditch' | 'canal' | 'basin' | string;
  /** Explicit OSM width in metres. */
  width?: number;
  /** True when width uses a documented waterway-class default. */
  widthInferred?: boolean;
}

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
  /** Total water surface area in square metres (sum of all polygons). */
  areaMetres: number;
  /** Total length of linear waterways in metres. */
  lineLengthMetres: number;
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
  const geom = mapShapeGeometryToWorld(new ShapeGeometry(shape));

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
  if (rings.length === 0 || rings[0].length < 3) return 0;
  let outerArea = 0;
  for (let i = 0; i < rings[0].length; i += 1) {
    const j = (i + 1) % rings[0].length;
    outerArea += rings[0][i][0] * rings[0][j][1];
    outerArea -= rings[0][j][0] * rings[0][i][1];
  }
  let holeArea = 0;
  for (const ring of rings.slice(1)) {
    if (ring.length < 3) continue;
    let ringArea = 0;
    for (let i = 0; i < ring.length; i += 1) {
      const j = (i + 1) % ring.length;
      ringArea += ring[i][0] * ring[j][1];
      ringArea -= ring[j][0] * ring[i][1];
    }
    holeArea += Math.abs(ringArea) / 2;
  }
  return Math.max(0, Math.abs(outerArea) / 2 - holeArea);
}
const WATERWAY_WIDTH_DEFAULTS: Record<string, number> = {
  river: 10,
  stream: 2,
  brook: 2,
  canal: 6,
  ditch: 1.5,
  drain: 1.5,
  tidal_channel: 6,
  default: 3,
};

function waterwayWidth(feature: WaterFeatureShape): number {
  if (feature.width !== undefined && feature.width > 0) return feature.width;
  return WATERWAY_WIDTH_DEFAULTS[feature.waterType ?? "default"]
    ?? WATERWAY_WIDTH_DEFAULTS.default;
}

function lineLength(coordinates: CoordPair[]): number {
  let length = 0;
  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const dx = coordinates[i + 1][0] - coordinates[i][0];
    const dz = coordinates[i + 1][1] - coordinates[i][1];
    length += Math.sqrt(dx * dx + dz * dz);
  }
  return length;
}

function waterRibbon(
  coordinates: CoordPair[],
  halfWidth: number,
  featureIndex: number,
): BufferGeometry {
  if (coordinates.length < 2) return new BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const featureIndices: number[] = [];

  for (let i = 0; i < coordinates.length - 1; i += 1) {
    const [x0, z0] = coordinates[i];
    const [x1, z1] = coordinates[i + 1];
    const dx = x1 - x0;
    const dz = z1 - z0;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length < 1e-8) continue;

    const normalX = -dz / length * halfWidth;
    const normalZ = dx / length * halfWidth;
    const vertices: CoordPair[] = [
      [x0 - normalX, z0 - normalZ],
      [x0 + normalX, z0 + normalZ],
      [x1 - normalX, z1 - normalZ],
      [x1 + normalX, z1 + normalZ],
    ];
    const base = featureIndices.length;
    for (const [x, z] of vertices) {
      positions.push(x, 0, z);
      featureIndices.push(featureIndex);
    }
    indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  if (positions.length === 0) return new BufferGeometry();
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.setAttribute('featureIndex', new Float32BufferAttribute(featureIndices, 1));
  return geometry;
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
 * Build flat water geometry from polygonal bodies and linear waterways.
 * Linear waterways use explicit source width or a documented class default.
 */
export function buildWater(features: WaterFeatureShape[]): BuildResult {
  if (features.length === 0) {
    return {
      geometry: new BufferGeometry(),
      featureCount: 0,
      areaMetres: 0,
      lineLengthMetres: 0,
    };
  }

  const geoms: BufferGeometry[] = [];
  let totalArea = 0;
  let lineLengthMetres = 0;

  const appendLine = (
    coordinates: CoordPair[],
    width: number,
    featureIndex: number,
  ): void => {
    lineLengthMetres += lineLength(coordinates);
    const ribbon = waterRibbon(coordinates, width / 2, featureIndex);
    if ((ribbon.getAttribute('position')?.count ?? 0) > 0) geoms.push(ribbon);
  };

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi];
    const geo = feat.geometry;

    if (geo.type === 'Polygon') {
      totalArea += polygonArea(geo.coordinates);
      const [outer, ...holes] = geo.coordinates;
      if (outer.length < 3) continue;
      const shape = ringToShape(outer);
      addHoles(shape, holes);
      geoms.push(buildGeometryForShape(shape, fi));
    } else if (geo.type === 'MultiPolygon') {
      for (const polygon of geo.coordinates) {
        totalArea += polygonArea(polygon);
        const [outer, ...holes] = polygon;
        if (outer.length < 3) continue;
        const shape = ringToShape(outer);
        addHoles(shape, holes);
        geoms.push(buildGeometryForShape(shape, fi));
      }
    } else if (geo.type === 'LineString') {
      appendLine(geo.coordinates, waterwayWidth(feat), fi);
    } else {
      for (const coordinates of geo.coordinates) {
        appendLine(coordinates, waterwayWidth(feat), fi);
      }
    }
  }

  const geometry = mergeGeometries(geoms);
  if (geoms.length > 1) {
    for (const intermediate of geoms) intermediate.dispose();
  }

  return {
    geometry,
    featureCount: features.length,
    areaMetres: totalArea,
    lineLengthMetres,
  };
}

export default buildWater;