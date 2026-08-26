// @ts-nocheck
/**
 * @file Landuse-area geometry builder.
 *
 * Converts LanduseFeature records (Polygon / MultiPolygon) into a single
 * merged BufferGeometry at y=0.  Each area type carries a `landuseType`
 * metadata attribute so the scene can apply per-type colours (park green,
 * farmland ochre, forest dark green, etc.) via the landuseMat material's
 * userData or a custom shader.
 *
 * @see THEME: landuseMat – per-type colour stored as userData.fallbackColor
 */

import {
  BufferGeometry,
  Float32BufferAttribute,
  Shape,
  ShapeGeometry,
  Path,
} from 'three';

// ─── Local types ────────────────────────────────────────────────────────────

type CoordPair = [number, number];

interface PolygonRep {
  type: 'Polygon';
  coordinates: CoordPair[][];
}

interface MultiPolygonRep {
  type: 'MultiPolygon';
  coordinates: CoordPair[][][];
}

export interface LanduseFeatureShape {
  kind: 'landuse';
  stableId: string;
  geometry: PolygonRep | MultiPolygonRep;
  name?: string;
  /** OSM landuse or leisure tag (forest, park, farm, residential, etc.). */
  landuseType?:
    | 'forest' | 'park' | 'grass' | 'farmland'
    | 'residential' | 'commercial' | 'industrial'
    | 'cemetery' | 'meadow' | 'orchard'
    | 'vineyard' | 'quarry' | 'landfill'
    | 'construction' | 'brownfield' | 'greenfield'
    | 'farmyard' | 'allotments' | 'plant_nursery'
    | 'recreation_ground' | 'village_green' | 'golf_course'
    | 'military' | 'retail' | 'religious'
    | string;
}

export interface BuildResult {
  geometry: BufferGeometry;
  featureCount: number;
  /** Total landuse area in square metres. */
  areaMetres: number;
  /** Landuse types present in this batch (for colour mapping). */
  typesPresent: Set<string>;
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

function buildGeometryForShape(
  shape: Shape,
  featureIndex: number,
  landuseType: string,
): BufferGeometry {
  const geom = new ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);

  const count = geom.getAttribute('position')?.count ?? 0;
  const indices = new Float32BufferAttribute(
    new Float32Array(count).fill(featureIndex), 1,
  );
  indices.name = 'featureIndex';
  geom.setAttribute('featureIndex', indices);

  // Store landuse type per-vertex for custom shader / colour mapping.
  const typeId = landuseTypeHash(landuseType);
  const typeAttr = new Float32BufferAttribute(
    new Float32Array(count).fill(typeId), 1,
  );
  typeAttr.name = 'landuseType';
  geom.setAttribute('landuseType', typeAttr);

  return geom;
}

/** Stable numeric hash for a landuse type string (used for per-vertex colour mapping). */
function landuseTypeHash(type: string): number {
  // Simple hash: sum of char codes modulo 100 (more than enough for ~30 types).
  let hash = 0;
  for (let i = 0; i < type.length; i++) {
    hash = (hash * 31 + type.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 100;
}

// ─── Area ───────────────────────────────────────────────────────────────────

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

// ─── Merge ─────────────────────────────────────────────────────────────────

function mergeGeometries(geometries: BufferGeometry[]): BufferGeometry {
  if (geometries.length === 0) return new BufferGeometry();
  if (geometries.length === 1) return geometries[0];

  const merged = new BufferGeometry();
  const positions: number[] = [];
  const indices: number[] = [];
  const featureIndices: number[] = [];
  const landuseTypes: number[] = [];
  let vertexOffset = 0;

  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const fi = g.getAttribute('featureIndex');
    const lt = g.getAttribute('landuseType');
    if (!pos) continue;

    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i++) positions.push(arr[i]);

    if (fi) {
      const f = fi.array as Float32Array;
      for (let i = 0; i < f.length; i++) featureIndices.push(f[i]);
    } else {
      for (let i = 0; i < pos.count; i++) featureIndices.push(0);
    }

    if (lt) {
      const l = lt.array as Float32Array;
      for (let i = 0; i < l.length; i++) landuseTypes.push(l[i]);
    } else {
      for (let i = 0; i < pos.count; i++) landuseTypes.push(0);
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
  merged.setAttribute('landuseType', new Float32BufferAttribute(landuseTypes, 1));

  return merged;
}

// ─── Main builder ──────────────────────────────────────────────────────────

/**
 * Build flat landuse geometry from LanduseFeature records.
 *
 * @param features - Array of landuse features (parks, forests, farmland, etc.).
 * @returns Merged polygon geometry, processed count, area, and type set.
 */
export function buildLanduse(features: LanduseFeatureShape[]): BuildResult {
  if (features.length === 0) {
    return {
      geometry: new BufferGeometry(),
      featureCount: 0,
      areaMetres: 0,
      typesPresent: new Set(),
    };
  }

  const geoms: BufferGeometry[] = [];
  let totalArea = 0;
  const typesPresent = new Set<string>();

  for (let fi = 0; fi < features.length; fi++) {
    const feat = features[fi];
    const geo = feat.geometry;
    const luType = feat.landuseType ?? 'unknown';

    typesPresent.add(luType);

    if (geo.type === 'Polygon') {
      totalArea += polygonArea([geo.coordinates[0]]);
      const [outer, ...holes] = geo.coordinates;
      if (outer.length < 3) continue;
      const shape = ringToShape(outer);
      addHoles(shape, holes);
      geoms.push(buildGeometryForShape(shape, fi, luType));
    } else if (geo.type === 'MultiPolygon') {
      for (const polyCoords of geo.coordinates) {
        totalArea += polygonArea([polyCoords[0]]);
        const [outer, ...holes] = polyCoords;
        if (outer.length < 3) continue;
        const shape = ringToShape(outer);
        addHoles(shape, holes);
        geoms.push(buildGeometryForShape(shape, fi, luType));
      }
    }
  }

  return {
    geometry: mergeGeometries(geoms),
    featureCount: features.length,
    areaMetres: totalArea,
    typesPresent,
  };
}

export default buildLanduse;