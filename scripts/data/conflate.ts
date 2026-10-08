import type { BusinessFeature, MapFeature, PoiFeature } from "../../src/lib/data/schema";
import { foldSearchText } from "../../src/lib/data/categories";

/** Match radius between an OSM place and a SIRENE establishment. */
export const CONFLATION_RADIUS_METRES = 150;
/** The same exact name may sit further apart: SIRENE geocodes the postal entrance, OSM maps the building or campus. */
export const CONFLATION_EXACT_RADIUS_METRES = 300;
export const CONFLATION_MIN_SIMILARITY = 0.8;

const GENERIC_TOKENS = new Set(["sarl", "sas", "sasu", "eurl", "sa", "sci", "snc", "et", "de", "du", "des", "la", "le", "les", "l", "d", "a", "au", "aux", "en"]);

function nameTokens(name: string | undefined): string[] {
  if (name === undefined) return [];
  return foldSearchText(name).split(" ").filter((token) => token.length > 0 && !GENERIC_TOKENS.has(token));
}

/**
 * Containment similarity of two shop names: the share of the shorter name's
 * words found in the longer one. "E.Leclerc" against "Leclerc Auch" is 1,
 * "Pharmacie du Centre" against "Pharmacie Occitane" is 0.5.
 */
export function nameSimilarity(first: string | undefined, second: string | undefined): number {
  const a = nameTokens(first);
  const b = nameTokens(second);
  if (a.length === 0 || b.length === 0) return 0;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const pool = new Set(longer);
  let shared = 0;
  for (const token of shorter) if (pool.has(token)) shared += 1;
  return shared / shorter.length;
}

function position(feature: MapFeature): [number, number] | null {
  return feature.x !== undefined && feature.z !== undefined ? [feature.x, feature.z] : null;
}

/**
 * Merge every SIRENE establishment with the OSM place that describes the same
 * shop: same name within CONFLATION_RADIUS_METRES. The OSM object is the one
 * people mapped on the building, so its position, hours, phone and website win;
 * SIRENE contributes the legal identity. Unmatched features pass through.
 */
export function conflateBusinesses(osmPois: readonly PoiFeature[], businesses: readonly BusinessFeature[]): { pois: PoiFeature[]; businesses: BusinessFeature[]; merged: number } {
  const cell = CONFLATION_RADIUS_METRES;
  const grid = new Map<string, number[]>();
  osmPois.forEach((poi, index) => {
    const at = position(poi);
    if (at === null || poi.name === undefined) return;
    const key = `${Math.floor(at[0] / cell)}:${Math.floor(at[1] / cell)}`;
    const bucket = grid.get(key);
    if (bucket === undefined) grid.set(key, [index]);
    else bucket.push(index);
  });
  const consumed = new Set<number>();
  let merged = 0;
  const out: BusinessFeature[] = [];
  for (const business of businesses) {
    const at = position(business);
    if (at === null) {
      out.push(business);
      continue;
    }
    const column = Math.floor(at[0] / cell);
    const row = Math.floor(at[1] / cell);
    let best = -1;
    let bestScore = 0;
    let bestDistance = Infinity;
    const reach = Math.ceil(CONFLATION_EXACT_RADIUS_METRES / cell);
    for (let dz = -reach; dz <= reach; dz += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        for (const index of grid.get(`${column + dx}:${row + dz}`) ?? []) {
          if (consumed.has(index)) continue;
          const poi = osmPois[index]!;
          const other = position(poi)!;
          const distance = Math.hypot(other[0] - at[0], other[1] - at[1]);
          if (distance > CONFLATION_EXACT_RADIUS_METRES) continue;
          const score = Math.max(nameSimilarity(poi.name, business.businessName), nameSimilarity(poi.name, business.brand));
          if (score < CONFLATION_MIN_SIMILARITY) continue;
          const exact = foldSearchText(poi.name ?? "") === foldSearchText(business.businessName);
          if (distance > (exact ? CONFLATION_EXACT_RADIUS_METRES : CONFLATION_RADIUS_METRES)) continue;
          if (score > bestScore || (score === bestScore && distance < bestDistance)) {
            best = index;
            bestScore = score;
            bestDistance = distance;
          }
        }
      }
    }
    if (best < 0) {
      out.push(business);
      continue;
    }
    consumed.add(best);
    merged += 1;
    const poi = osmPois[best]!;
    /* OSM places a mapped POI on its building; SIRENE only knows the postal address. A POI drawn as
       a building outline is reduced to a point on its anchor so geometry and anchor agree. */
    const lon = poi.lon ?? business.lon;
    const lat = poi.lat ?? business.lat;
    const x = poi.x ?? business.x;
    const z = poi.z ?? business.z;
    const geometry = poi.geometry.type === "Point" ? poi.geometry : lon !== undefined && lat !== undefined ? { type: "Point" as const, coordinates: [lon, lat] as [number, number] } : business.geometry;
    const localGeometry = poi.localGeometry?.type === "Point" ? poi.localGeometry : x !== undefined && z !== undefined ? { type: "Point" as const, coordinates: [x, z] as [number, number] } : business.localGeometry;
    out.push({
      ...business,
      name: poi.name ?? business.name,
      businessName: poi.name ?? business.businessName,
      geometry,
      localGeometry,
      lon,
      lat,
      x,
      z,
      address: poi.address ?? business.address,
      website: poi.website ?? business.website,
      phone: poi.phone ?? business.phone,
      openingHours: poi.openingHours ?? business.openingHours,
      wheelchair: poi.wheelchair ?? business.wheelchair,
      operator: business.operator ?? poi.operator,
      poiType: poi.poiType,
      category: poi.category ?? business.category,
      sourceRefs: [...business.sourceRefs, ...poi.sourceRefs],
      provenance: [
        ...business.provenance,
        { featureId: business.stableId, property: "position", winner: poi.sourceRefs[0]?.source ?? "osm", contenders: ["sirene", "osm"], priority: 90, timestamp: poi.provenance[0]?.timestamp ?? business.provenance[0]?.timestamp ?? new Date(0).toISOString() },
      ],
      sourceMetadata: { ...(business.sourceMetadata ?? {}), conflatedWith: poi.stableId, osm: poi.sourceMetadata },
    });
  }
  return { pois: osmPois.filter((_, index) => !consumed.has(index)), businesses: out, merged };
}
