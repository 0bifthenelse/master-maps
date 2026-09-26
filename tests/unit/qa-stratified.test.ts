import { describe, it, expect } from 'vitest';
import {
  GERS_DEPARTMENT_CODE,
  MAX_TILE_BYTES,
  MINOR_ROAD_CLASSES,
  SAMPLE_TARGET_COMMUNES,
  SAMPLE_TARGET_TILES,
  STRATIFIED_SEED,
  buildStrata,
  classifyNetwork,
  classifyRiver,
  densityBin,
  densityEdges,
  expectedKindsFor,
  mulberry32,
  observeFeatures,
  polygonCentroid,
  ringDistanceFunction,
  quadrantOf,
  quantile,
  settlementClass,
  spreadObservationTargets,
  stratifiedSample,
  tileIntersectsBounds,
  verifyStratum,
  type Bbox,
  type CommuneRecord,
  type TileObservation,
  type TileRecord,
} from '../../scripts/data/qa-stratified';

function tile(tileId: string, bounds: Bbox, featureCount: number, byteSize = 1000): TileRecord {
  return { tileId, lod: 0, bounds, featureCount, byteSize };
}

function commune(codeInsee: string, x: number, z: number, population: number): CommuneRecord {
  return { codeInsee, name: codeInsee, population, x, z };
}

function observation(tileId: string, overrides: Partial<TileObservation> = {}): TileObservation {
  return {
    tileId,
    kinds: { road: 10, building: 10, address: 5, water: 4 },
    anchorCount: 10,
    anchorsOutside: 0,
    onEdgeAnchors: 0,
    minorRoadShare: 0.2,
    roadCount: 10,
    maxAnchorDistanceMetres: 0,
    ...overrides,
  };
}

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const first = mulberry32(STRATIFIED_SEED);
    const second = mulberry32(STRATIFIED_SEED);
    const a = [first(), first(), first()];
    const b = [second(), second(), second()];
    expect(a).toEqual(b);
  });

  it('produces different streams for different seeds', () => {
    const first = mulberry32(1);
    const second = mulberry32(2);
    expect(first()).not.toBe(second());
  });

  it('stays within the unit interval', () => {
    const random = mulberry32(STRATIFIED_SEED);
    for (let index = 0; index < 5000; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('quantile', () => {
  it('interpolates linearly and clamps out-of-range fractions', () => {
    const values = [0, 10, 20, 30, 40];
    expect(quantile(values, 0)).toBe(0);
    expect(quantile(values, 1)).toBe(40);
    expect(quantile(values, 0.5)).toBe(20);
    expect(quantile(values, -1)).toBe(0);
    expect(quantile(values, 5)).toBe(40);
  });

  it('returns zero for an empty population', () => {
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('densityEdges and densityBin', () => {
  const counts = Array.from({ length: 100 }, (_, index) => index + 1);
  const edges = densityEdges(counts);

  it('splits a population into five bins with monotonic edges', () => {
    expect(edges.sparseMax).toBeLessThanOrEqual(edges.lowMax);
    expect(edges.lowMax).toBeLessThanOrEqual(edges.midMax);
    expect(edges.midMax).toBeLessThanOrEqual(edges.highMax);
  });

  it('assigns every value in the population to a bin', () => {
    const assigned = new Set(counts.map((count) => densityBin(count, edges)));
    expect(assigned.size).toBe(5);
  });

  it('places the extremes at the ends', () => {
    expect(densityBin(counts[0]!, edges)).toBe('sparse');
    expect(densityBin(counts[counts.length - 1]!, edges)).toBe('dense');
  });

  it('is insensitive to input order', () => {
    const shuffled = [...counts].reverse();
    expect(densityEdges(shuffled)).toEqual(edges);
  });
});

describe('settlementClass', () => {
  it('maps population to the four canonical classes at their boundaries', () => {
    expect(settlementClass(0)).toBe('rural');
    expect(settlementClass(499)).toBe('rural');
    expect(settlementClass(500)).toBe('village');
    expect(settlementClass(1999)).toBe('village');
    expect(settlementClass(2000)).toBe('town');
    expect(settlementClass(9999)).toBe('town');
    expect(settlementClass(10000)).toBe('city');
    expect(settlementClass(22428)).toBe('city');
  });

  it('is monotonic in population', () => {
    const order = { rural: 0, village: 1, town: 2, city: 3 } as const;
    for (let population = 0; population < 30000; population += 137) {
      const current = order[settlementClass(population)];
      if (population > 0) expect(current).toBeGreaterThanOrEqual(order[settlementClass(population - 137)]);
    }
  });
});

describe('quadrantOf', () => {
  it('splits the department bbox into four quadrants', () => {
    expect(quadrantOf([-2048, -2048, 0, 0])).toBe('nw');
    expect(quadrantOf([0, -2048, 2048, 0])).toBe('ne');
    expect(quadrantOf([-2048, 0, 0, 2048])).toBe('sw');
    expect(quadrantOf([0, 0, 2048, 2048])).toBe('se');
  });

  it('treats the centre lines as belonging to the positive side', () => {
    expect(quadrantOf([0, 0, 10, 10])).toBe('se');
    expect(quadrantOf([-10, 0, 0, 10])).toBe('sw');
  });

  it('classifies a tile by its centre, not its corner', () => {
    expect(quadrantOf([-4000, 10, 0, 20])).toBe('sw');
  });
});

describe('tileIntersectsBounds', () => {
  const subject = tile('t', [0, 0, 100, 100], 5);

  it('accepts interior points and the closed border', () => {
    expect(tileIntersectsBounds(subject, [50, 50])).toBe(true);
    expect(tileIntersectsBounds(subject, [0, 0])).toBe(true);
    expect(tileIntersectsBounds(subject, [100, 100])).toBe(true);
  });

  it('rejects points outside', () => {
    expect(tileIntersectsBounds(subject, [-1, 50])).toBe(false);
    expect(tileIntersectsBounds(subject, [50, 101])).toBe(false);
  });
});

describe('classifyRiver', () => {
  it('reports no water for a dry tile', () => {
    expect(classifyRiver({ kinds: { road: 5 } })).toBe('none');
    expect(classifyRiver({ kinds: { water: 0 } })).toBe('none');
  });

  it('separates a watercourse from a water body by feature count', () => {
    expect(classifyRiver({ kinds: { water: 1 } })).toBe('watercourse');
    expect(classifyRiver({ kinds: { water: 11 } })).toBe('watercourse');
    expect(classifyRiver({ kinds: { water: 12 } })).toBe('surface');
    expect(classifyRiver({ kinds: { water: 90 } })).toBe('surface');
  });
});

describe('classifyNetwork', () => {
  it('uses the documented minor-road share threshold', () => {
    expect(classifyNetwork(0)).toBe('plain');
    expect(classifyNetwork(0.49)).toBe('plain');
    expect(classifyNetwork(0.5)).toBe('minorRoad');
    expect(classifyNetwork(1)).toBe('minorRoad');
  });
});

describe('polygonCentroid', () => {
  it('centres a Polygon ring', () => {
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(polygonCentroid([ring])).toEqual([5, 5]);
  });

  it('centres a MultiPolygon by descending to the first ring', () => {
    const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(polygonCentroid([[ring]])).toEqual([5, 5]);
  });

  it('returns null for degenerate and malformed input instead of NaN', () => {
    expect(polygonCentroid([])).toBeNull();
    expect(polygonCentroid(null)).toBeNull();
    expect(polygonCentroid([[[]]])).toBeNull();
    expect(polygonCentroid([[[[0, 0], [1, 1]]]])).toBeNull();
  });

  it('never yields a non-finite centroid for real commune input', () => {
    const ring = [[440853.6, 6278348.8], [441000, 6278348.8], [441000, 6279000], [440853.6, 6278348.8]];
    const centroid = polygonCentroid([[ring]]);
    expect(centroid).not.toBeNull();
    expect(Number.isFinite(centroid![0])).toBe(true);
    expect(Number.isFinite(centroid![1])).toBe(true);
  });
});

describe('ringDistanceFunction', () => {
  const square: number[][][][] = [[[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]]]];

  it('returns zero for a point on the ring', () => {
    expect(ringDistanceFunction(square)([50, 0])).toBeCloseTo(0);
    expect(ringDistanceFunction(square)([0, 50])).toBeCloseTo(0);
  });

  it('measures the perpendicular distance from an edge', () => {
    expect(ringDistanceFunction(square)([50, 10])).toBeCloseTo(10);
    expect(ringDistanceFunction(square)([-30, 50])).toBeCloseTo(30);
  });

  it('clamps beyond a corner to the nearest endpoint', () => {
    expect(ringDistanceFunction(square)([-10, -10])).toBeCloseTo(Math.hypot(10, 10));
  });

  it('returns Infinity when there is no ring to measure against', () => {
    expect(ringDistanceFunction([])([1, 1])).toBe(Infinity);
  });
});

describe('observeFeatures', () => {
  const boundary = {
    contains: (point: [number, number]) => point[0] >= 0 && point[1] >= 0,
    lineInside: () => true,
    lineOutside: () => false,
    polygonInside: () => true,
    polygonOutside: () => false,
    touches: () => true,
  };

  it('counts kinds, road classes and boundary containment', () => {
    const result = observeFeatures(
      [
        { kind: 'road', x: 10, z: 10, roadClass: 'track' },
        { kind: 'road', x: 10, z: 10, roadClass: 'track' },
        { kind: 'road', x: 10, z: 10, roadClass: 'primary' },
        { kind: 'building', x: -5, z: 10 },
        { kind: 'building' },
      ],
      boundary,
      't1',
    );
    expect(result.kinds).toEqual({ road: 3, building: 2 });
    expect(result.roadCount).toBe(3);
    expect(result.minorRoadShare).toBeCloseTo(2 / 3);
    expect(result.anchorCount).toBe(4);
    expect(result.anchorsOutside).toBe(1);
  });

  it('separates an anchor lying on the boundary ring from a real escape', () => {
    const features = [{ kind: 'road', x: 1, z: 5 }, { kind: 'road', x: -1, z: 5 }, { kind: 'road', x: -40, z: 5 }];
    const result = observeFeatures(features, boundary, 't', (point) => Math.abs(point[0]));
    expect(result.anchorsOutside).toBe(2);
    expect(result.onEdgeAnchors).toBe(1);
    expect(result.maxAnchorDistanceMetres).toBe(40);
  });

  it('reports no on-edge anchors when no ring distance function is supplied', () => {
    const result = observeFeatures([{ kind: 'road', x: -1, z: 5 }], boundary, 't');
    expect(result.anchorsOutside).toBe(1);
    expect(result.onEdgeAnchors).toBe(0);
  });

  it('never counts an anchor that is inside the boundary as outside', () => {
    const result = observeFeatures([{ kind: 'road', x: 10, z: 10 }], boundary, 't', () => 0);
    expect(result.anchorsOutside).toBe(0);
    expect(result.onEdgeAnchors).toBe(0);
  });

  it('falls back to the highway field for road class', () => {
    const result = observeFeatures([{ kind: 'road', highway: 'path' }, { kind: 'road', highway: 'motorway' }], boundary, 't');
    expect(result.minorRoadShare).toBe(0.5);
  });

  it('treats a tile with no roads as no minor-road share rather than dividing by zero', () => {
    const result = observeFeatures([{ kind: 'building' }], boundary, 't');
    expect(result.roadCount).toBe(0);
    expect(result.minorRoadShare).toBe(0);
  });

  it('treats a missing kind as unknown rather than dropping the feature', () => {
    const result = observeFeatures([{}], boundary, 't');
    expect(result.kinds['unknown']).toBe(1);
  });

  it('recognises every documented minor-road class', () => {
    const features = MINOR_ROAD_CLASSES.map((roadClass) => ({ kind: 'road', roadClass }));
    expect(observeFeatures(features, boundary, 't').minorRoadShare).toBe(1);
  });
});

describe('buildStrata', () => {
  const tiles = [
    tile('a', [-2048, -2048, 0, 0], 10),
    tile('b', [0, 0, 2048, 2048], 400),
  ];
  const observations = new Map([
    ['a', observation('a', { kinds: { road: 5 }, minorRoadShare: 0.9 })],
    ['b', observation('b', { kinds: { road: 5, building: 5, water: 50 }, minorRoadShare: 0.1 })],
  ]);

  it('places a tile in the quadrant of its own bounds', () => {
    const { strata } = buildStrata({ tiles, communes: [], edges: densityEdges([10, 400]), observations });
    const keys = [...strata.keys()];
    expect(keys.some((key) => key.startsWith('nw'))).toBe(true);
    expect(keys.some((key) => key.startsWith('se'))).toBe(true);
  });

  it('reports tiles that were never observed as unknown', () => {
    const { unknown } = buildStrata({
      tiles: [...tiles, tile('c', [0, 0, 1, 1], 5)],
      communes: [],
      edges: densityEdges([10, 400]),
      observations,
    });
    expect(unknown).toEqual(['c']);
  });

  it('keeps every observed tile in exactly one stratum', () => {
    const { strata } = buildStrata({ tiles, communes: [], edges: densityEdges([10, 400]), observations });
    const total = [...strata.values()].reduce((sum, stratum) => sum + stratum.tileIds.length, 0);
    expect(total).toBe(tiles.length);
  });

  it('assigns settlement class from the commune hosted by the tile', () => {
    const withCity = [tile('a', [-2048, -2048, 0, 0], 10)];
    const { strata } = buildStrata({
      tiles: withCity,
      communes: [commune('32001', -1000, -1000, 15000)],
      edges: densityEdges([10]),
      observations: new Map([['a', observation('a')]]),
    });
    expect([...strata.keys()][0]).toContain('city');
  });

  it('keeps the highest settlement severity when several communes share a tile', () => {
    const { strata } = buildStrata({
      tiles: [tile('a', [0, 0, 2048, 2048], 10)],
      communes: [commune('32001', 10, 10, 50), commune('32002', 20, 20, 20000)],
      edges: densityEdges([10]),
      observations: new Map([['a', observation('a')]]),
    });
    expect([...strata.keys()][0]).toContain('city');
  });

  it('defaults a tile with no commune to rural', () => {
    const { strata } = buildStrata({
      tiles: [tile('a', [0, 0, 2048, 2048], 10)],
      communes: [commune('32001', 999999, 999999, 20000)],
      edges: densityEdges([10]),
      observations: new Map([['a', observation('a')]]),
    });
    expect([...strata.keys()][0]).toContain('rural');
  });
});

describe('expectedKindsFor', () => {
  const kinds = { address: 1, building: 1, road: 1, water: 1, business: 1, poi: 1, boundary: 1 };

  it('does not demand buildings in a sparse rural tile', () => {
    const expected = expectedKindsFor(
      { quadrant: 'nw', density: 'sparse', settlement: 'rural', river: 'none', network: 'plain' },
      kinds,
    );
    expect(expected).not.toContain('building');
    expect(expected).toContain('road');
  });

  it('demands buildings once density rises', () => {
    const expected = expectedKindsFor(
      { quadrant: 'nw', density: 'dense', settlement: 'rural', river: 'none', network: 'plain' },
      kinds,
    );
    expect(expected).toContain('building');
  });

  it('demands water only where the stratum has water', () => {
    const dry = expectedKindsFor(
      { quadrant: 'nw', density: 'mid', settlement: 'rural', river: 'none', network: 'plain' },
      kinds,
    );
    const wet = expectedKindsFor(
      { quadrant: 'nw', density: 'mid', settlement: 'rural', river: 'surface', network: 'plain' },
      kinds,
    );
    expect(dry).not.toContain('water');
    expect(wet).toContain('water');
  });

  it('only demands rare kinds in town or city strata', () => {
    const rural = expectedKindsFor(
      { quadrant: 'nw', density: 'mid', settlement: 'rural', river: 'none', network: 'plain' },
      kinds,
    );
    const city = expectedKindsFor(
      { quadrant: 'nw', density: 'mid', settlement: 'city', river: 'none', network: 'plain' },
      kinds,
    );
    expect(rural).not.toContain('business');
    expect(city).toContain('business');
    expect(city).toContain('poi');
  });

  it('never expects a kind the dataset does not contain at all', () => {
    const expected = expectedKindsFor(
      { quadrant: 'nw', density: 'dense', settlement: 'city', river: 'surface', network: 'plain' },
      { road: 5, business: 0, poi: 0 },
    );
    expect(expected).not.toContain('business');
    expect(expected).not.toContain('poi');
  });

  it('never expects the kinds the whole Wave 2 is meant to add', () => {
    const expected = expectedKindsFor(
      { quadrant: 'se', density: 'dense', settlement: 'city', river: 'surface', network: 'minorRoad' },
      { road: 1, building: 1, address: 1, water: 1 },
    );
    expect(expected).not.toContain('landuse');
    expect(expected).not.toContain('transport');
    expect(expected).not.toContain('place');
  });
});

describe('stratifiedSample', () => {
  function population(size: number): {
    tiles: TileRecord[];
    communes: CommuneRecord[];
    observations: Map<string, TileObservation>;
    edges: ReturnType<typeof densityEdges>;
  } {
    const tiles: TileRecord[] = [];
    const observations = new Map<string, TileObservation>();
    const side = Math.ceil(Math.sqrt(size));
    for (let index = 0; index < size; index += 1) {
      const col = index % side;
      const row = Math.floor(index / side);
      const bounds: Bbox = [(col - side / 2) * 2048, (row - side / 2) * 2048, (col + 1 - side / 2) * 2048, (row + 1 - side / 2) * 2048];
      const id = `t${index}`;
      tiles.push(tile(id, bounds, 10 + index));
      observations.set(id, observation(id));
    }
    const communes: CommuneRecord[] = [];
    for (let index = 0; index < 100; index += 1) communes.push(commune(`32${String(index).padStart(3, '0')}`, (index % 10) * 2048 - 10000, Math.floor(index / 10) * 2048 - 10000, index * 100));
    return { tiles, communes, observations, edges: densityEdges(tiles.map((entry) => entry.featureCount)) };
  }

  it('is deterministic for the documented seed', () => {
    const first = population(300);
    const second = population(300);
    const a = stratifiedSample({
      ...first,
      targetTiles: SAMPLE_TARGET_TILES,
      targetCommunes: SAMPLE_TARGET_COMMUNES,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    const b = stratifiedSample({
      ...second,
      targetTiles: SAMPLE_TARGET_TILES,
      targetCommunes: SAMPLE_TARGET_COMMUNES,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    expect(a.sampledTiles).toEqual(b.sampledTiles);
    expect(a.sampledCommunes).toEqual(b.sampledCommunes);
  });

  it('reaches the target tile count when enough strata exist', () => {
    const sample = stratifiedSample({
      ...population(300),
      targetTiles: SAMPLE_TARGET_TILES,
      targetCommunes: SAMPLE_TARGET_COMMUNES,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    expect(sample.sampledTiles).toHaveLength(SAMPLE_TARGET_TILES);
    expect(new Set(sample.sampledTiles).size).toBe(SAMPLE_TARGET_TILES);
  });

  it('never samples the same tile twice', () => {
    const sample = stratifiedSample({
      ...population(300),
      targetTiles: SAMPLE_TARGET_TILES,
      targetCommunes: SAMPLE_TARGET_COMMUNES,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    expect(new Set(sample.sampledTiles).size).toBe(sample.sampledTiles.length);
  });

  it('samples at least the required number of communes', () => {
    const sample = stratifiedSample({
      ...population(300),
      targetTiles: SAMPLE_TARGET_TILES,
      targetCommunes: SAMPLE_TARGET_COMMUNES,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    expect(sample.sampledCommunes.length).toBe(SAMPLE_TARGET_COMMUNES);
    expect(new Set(sample.sampledCommunes).size).toBe(SAMPLE_TARGET_COMMUNES);
  });

  it('returns only tiles that were actually observed', () => {
    const source = population(60);
    const partial = new Map([...source.observations].slice(0, 20));
    const sample = stratifiedSample({
      ...source,
      observations: partial,
      targetTiles: 50,
      targetCommunes: 20,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    for (const tileId of sample.sampledTiles) expect(partial.has(tileId)).toBe(true);
  });

  it('takes one tile from every stratum before taking a second from any', () => {
    const source = population(300);
    const sample = stratifiedSample({
      ...source,
      targetTiles: 20,
      targetCommunes: 20,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    const stratumCount = buildStrata(source).strata.size;
    expect(sample.strata).toHaveLength(Math.min(stratumCount, 20));
  });

  it('widens quadrant coverage as the target grows', () => {
    const source = population(300);
    const small = stratifiedSample({ ...source, targetTiles: 20, targetCommunes: 20, seed: STRATIFIED_SEED, manifestKinds: { road: 1 } });
    const large = stratifiedSample({ ...source, targetTiles: 200, targetCommunes: 20, seed: STRATIFIED_SEED, manifestKinds: { road: 1 } });
    const quadrants = (sample: { strata: { quadrant: string }[] }): number => new Set(sample.strata.map((s) => s.quadrant)).size;
    expect(quadrants(large)).toBeGreaterThanOrEqual(quadrants(small));
    expect(quadrants(small)).toBeGreaterThan(0);
  });

  it('spreads the sample across distinct strata', () => {
    const sample = stratifiedSample({
      ...population(300),
      targetTiles: SAMPLE_TARGET_TILES,
      targetCommunes: SAMPLE_TARGET_COMMUNES,
      seed: STRATIFIED_SEED,
      manifestKinds: { road: 1 },
    });
    expect(sample.strata.length).toBeGreaterThan(1);
    const total = sample.strata.reduce((sum, stratum) => sum + stratum.tileIds.length, 0);
    expect(total).toBe(sample.sampledTiles.length);
  });
});

describe('verifyStratum', () => {
  const tiles = new Map([['a', tile('a', [0, 0, 100, 100], 100)]]);
  const kinds = { road: 1, building: 1, address: 1, water: 1 };
  const stratum = {
    key: 'ne/dense/town/surface/plain' as const,
    quadrant: 'ne' as const,
    density: 'dense' as const,
    settlement: 'town' as const,
    river: 'surface' as const,
    network: 'plain' as const,
    tileIds: ['a'],
  };

  it('passes a stratum whose expectations are met', () => {
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a')]]),
      tiles,
      communeChecks: [{ codeInsee: '32001', inside: true }],
      onEdgeAnchors: 0,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.failures).toEqual([]);
    expect(verdict.missingKinds).toEqual([]);
  });

  it('fails and names the missing kinds', () => {
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a', { kinds: { road: 1 } })]]),
      tiles,
      communeChecks: [],
      onEdgeAnchors: 0,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.missingKinds).toContain('building');
    expect(verdict.missingKinds).toContain('water');
    expect(verdict.failures.join(' ')).toContain('missing kinds');
  });

  it('fails a tile above the 2 MiB ceiling', () => {
    const oversized = new Map([['a', tile('a', [0, 0, 100, 100], 100, MAX_TILE_BYTES + 1)]]);
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a')]]),
      tiles: oversized,
      communeChecks: [],
      onEdgeAnchors: 0,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.oversizedTiles).toEqual(['a']);
  });

  it('accepts a tile exactly at the ceiling', () => {
    const atLimit = new Map([['a', tile('a', [0, 0, 100, 100], 100, MAX_TILE_BYTES)]]);
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a')]]),
      tiles: atLimit,
      communeChecks: [],
      onEdgeAnchors: 0,
    });
    expect(verdict.oversizedTiles).toEqual([]);
    expect(verdict.maxTileBytes).toBe(MAX_TILE_BYTES);
  });

  it('passes when every outside anchor lies on the boundary ring', () => {
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a', { anchorsOutside: 2, onEdgeAnchors: 2 })]]),
      tiles,
      communeChecks: [],
      onEdgeAnchors: 2,
    });
    expect(verdict.passed).toBe(true);
    expect(verdict.onEdgeAnchors).toBe(2);
  });

  it('fails when an anchor escapes well beyond the boundary ring', () => {
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a', { anchorsOutside: 4, onEdgeAnchors: 2 })]]),
      tiles,
      communeChecks: [],
      onEdgeAnchors: 2,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('more than');
  });

  it('fails when a feature anchor lies outside the boundary', () => {
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a', { anchorsOutside: 3 })]]),
      tiles,
      communeChecks: [],
      onEdgeAnchors: 0,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.anchorsOutside).toBe(3);
    expect(verdict.anchorsChecked).toBe(10);
  });

  it('fails when a sampled commune centroid lies outside the boundary', () => {
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map([['a', observation('a')]]),
      tiles,
      communeChecks: [
        { codeInsee: '32001', inside: true },
        { codeInsee: '32002', inside: false },
      ],
      onEdgeAnchors: 0,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.communeAnchorsChecked).toBe(2);
    expect(verdict.communeAnchorsOutside).toBe(1);
    expect(verdict.failures.join(' ')).toContain('32002');
  });

  it('fails a sampled tile that has no observation', () => {
    const verdict = verifyStratum({
      stratum,
      manifestKinds: kinds,
      observations: new Map(),
      tiles,
      communeChecks: [],
      onEdgeAnchors: 0,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.join(' ')).toContain('no observation');
  });
});

describe('spreadObservationTargets', () => {
  it('spreads across the department rather than filling one corner', () => {
    const tiles: TileRecord[] = [];
    for (let col = 0; col < 20; col += 1) {
      for (let row = 0; row < 20; row += 1) {
        tiles.push(tile(`t${col}_${row}`, [col * 2048, row * 2048, (col + 1) * 2048, (row + 1) * 2048], 10));
      }
    }
    const selected = spreadObservationTargets(tiles, 40);
    expect(selected).toHaveLength(40);
    const columns = new Set(selected.map((entry) => Math.floor(entry.bounds[0] / 2048)));
    expect(columns.size).toBeGreaterThan(1);
  });

  it('never returns more tiles than the population holds', () => {
    const tiles = [tile('a', [0, 0, 1, 1], 1), tile('b', [0, 0, 1, 1], 1)];
    expect(spreadObservationTargets(tiles, 100)).toHaveLength(2);
  });

  it('returns nothing for an empty population', () => {
    expect(spreadObservationTargets([], 10)).toEqual([]);
  });
});

describe('constants', () => {
  it('pins the documented sample sizes and seed', () => {
    expect(SAMPLE_TARGET_TILES).toBeGreaterThanOrEqual(50);
    expect(SAMPLE_TARGET_COMMUNES).toBeGreaterThanOrEqual(20);
    expect(STRATIFIED_SEED).toBe(20260926);
    expect(MAX_TILE_BYTES).toBe(2 * 1024 * 1024);
    expect(GERS_DEPARTMENT_CODE).toBe('32');
  });
});
