import { renderToWgs84, wgs84ToRender } from "../../src/lib/geo/crs";
import type {
  BuildingFeature,
  LanduseFeature,
  MapFeature,
  PlaceFeature,
  PoiFeature,
  RoadFeature,
  SourceReference,
  StructureFeature,
  TransportFeature,
  WaterFeature,
} from "../../src/lib/data/schema";
import { clipLineStringToPolygon, clipPolygonToPolygon, normalizePolygonGeometry, type PolygonGeometry } from "../../src/lib/geo/polygon";
import { createBoundaryIndex, type BoundaryIndex } from "./boundaryIndex";
import { ADOPTED_LAYERS, BD_TOPO_LAYERS, type BdtopoLayerName } from "./bdtopoLayers";
import { categoryForBdtopoNature } from "../../src/lib/data/categories";

type Coordinate = [number, number];
type NormalizedGeometry =
  | { type: "Point"; coordinates: Coordinate }
  | { type: "LineString"; coordinates: Coordinate[] }
  | { type: "MultiLineString"; coordinates: Coordinate[][] }
  | { type: "Polygon"; coordinates: Coordinate[][] }
  | { type: "MultiPolygon"; coordinates: Coordinate[][][] };

interface SourceFeature {
  type?: unknown;
  geometry?: { type?: unknown; coordinates?: unknown } | null;
  properties?: Record<string, unknown>;
  sourceLayer?: unknown;
}

const SOURCE_URL = "https://geoservices.ign.fr/bdtopo";
const SOURCE_NAME = "IGN BD TOPO";
const SOURCE_TIMESTAMP = new Date().toISOString();
const SOURCE_LICENSE = "Licence Ouverte / Open Licence 2.0";

export function parseBdBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "oui", "vrai"].includes(normalized)) return true;
  if (["0", "false", "no", "non", "faux"].includes(normalized)) return false;
  return undefined;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function coordinate(value: unknown): Coordinate | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = value[0];
  const latitude = value[1];
  if (typeof longitude !== "number" || typeof latitude !== "number") return null;
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  return [longitude, latitude];
}

function closeRing(value: unknown): Coordinate[] | null {
  if (!Array.isArray(value)) return null;
  const points: Coordinate[] = [];
  for (const item of value) {
    const point = coordinate(item);
    if (!point) return null;
    points.push(point);
  }
  if (points.length < 3) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) points.push([first[0], first[1]]);
  return points.length >= 4 ? points : null;
}

function line(value: unknown): Coordinate[] | null {
  if (!Array.isArray(value)) return null;
  const points: Coordinate[] = [];
  for (const item of value) {
    const point = coordinate(item);
    if (!point) return null;
    points.push(point);
  }
  return points.length >= 2 ? points : null;
}

function polygon(value: unknown): Coordinate[][] | null {
  if (!Array.isArray(value)) return null;
  const rings: Coordinate[][] = [];
  for (const item of value) {
    const ring = closeRing(item);
    if (!ring) return null;
    rings.push(ring);
  }
  return rings.length > 0 ? rings : null;
}

function asGeometry(value: SourceFeature["geometry"]): NormalizedGeometry | null {
  if (!value || typeof value.type !== "string") return null;
  switch (value.type) {
    case "Point": {
      const point = coordinate(value.coordinates);
      return point ? { type: "Point", coordinates: point } : null;
    }
    case "LineString": {
      const points = line(value.coordinates);
      return points ? { type: "LineString", coordinates: points } : null;
    }
    case "MultiLineString": {
      if (!Array.isArray(value.coordinates)) return null;
      const lines = value.coordinates.map(line);
      return lines.every((candidate): candidate is Coordinate[] => candidate !== null)
        ? { type: "MultiLineString", coordinates: lines }
        : null;
    }
    case "Polygon": {
      const rings = polygon(value.coordinates);
      return rings ? { type: "Polygon", coordinates: rings } : null;
    }
    case "MultiPolygon": {
      if (!Array.isArray(value.coordinates)) return null;
      const polygons = value.coordinates.map(polygon);
      return polygons.every((candidate): candidate is Coordinate[][] => candidate !== null)
        ? { type: "MultiPolygon", coordinates: polygons }
        : null;
    }
    default:
      return null;
  }
}

function lineLength(points: Coordinate[]): number {
  let total = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    total += Math.hypot(points[index + 1]![0] - points[index]![0], points[index + 1]![1] - points[index]![1]);
  }
  return total;
}

function linePointAt(points: Coordinate[], distance: number): Coordinate {
  let remaining = distance;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (remaining <= length) {
      const ratio = length === 0 ? 0 : remaining / length;
      return [start[0] + (end[0] - start[0]) * ratio, start[1] + (end[1] - start[1]) * ratio];
    }
    remaining -= length;
  }
  return points[points.length - 1]!;
}

function ringContribution(ring: Coordinate[]): { area: number; centroid: Coordinate } {
  if (ring.length < 3) return { area: 0, centroid: [0, 0] };
  let signedArea = 0;
  let x = 0;
  let y = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const first = ring[index]!;
    const second = ring[(index + 1) % ring.length]!;
    const cross = first[0] * second[1] - second[0] * first[1];
    signedArea += cross;
    x += (first[0] + second[0]) * cross;
    y += (first[1] + second[1]) * cross;
  }
  signedArea /= 2;
  const area = Math.abs(signedArea);
  if (area <= 1e-9) {
    const sum = ring.reduce<Coordinate>((total, point) => [total[0] + point[0], total[1] + point[1]], [0, 0]);
    return { area: 0, centroid: [sum[0] / ring.length, sum[1] / ring.length] };
  }
  return { area, centroid: [x / (6 * signedArea), y / (6 * signedArea)] };
}

function areaAnchor(rings: Coordinate[][]): Coordinate {
  const outer = rings[0];
  if (!outer) throw new Error("BD TOPO polygon has no exterior ring");
  const outerContribution = ringContribution(outer);
  let weight = outerContribution.area;
  let x = outerContribution.centroid[0] * weight;
  let y = outerContribution.centroid[1] * weight;
  for (const hole of rings.slice(1)) {
    const contribution = ringContribution(hole);
    weight -= contribution.area;
    x -= contribution.centroid[0] * contribution.area;
    y -= contribution.centroid[1] * contribution.area;
  }
  return weight > 1e-9 ? [x / weight, y / weight] : outerContribution.centroid;
}

export function geometryAnchor(geometry: NormalizedGeometry): Coordinate {
  if (geometry.type === "Point") return geometry.coordinates;
  if (geometry.type === "LineString") return linePointAt(geometry.coordinates, lineLength(geometry.coordinates) / 2);
  if (geometry.type === "MultiLineString") {
    const total = geometry.coordinates.reduce((sum, points) => sum + lineLength(points), 0);
    if (total <= 1e-9) return geometry.coordinates[0]?.[0] ?? [0, 0];
    let passed = 0;
    for (const points of geometry.coordinates) {
      const length = lineLength(points);
      if (passed + length >= total / 2) return linePointAt(points, total / 2 - passed);
      passed += length;
    }
    const last = geometry.coordinates[geometry.coordinates.length - 1];
    return last?.[last.length - 1] ?? [0, 0];
  }
  if (geometry.type === "Polygon") return areaAnchor(geometry.coordinates);
  let totalArea = 0;
  let x = 0;
  let y = 0;
  for (const polygon of geometry.coordinates) {
    const anchor = areaAnchor(polygon);
    const outer = polygon[0];
    if (!outer) continue;
    const outerArea = ringContribution(outer).area;
    const holeArea = polygon.slice(1).reduce((sum, hole) => sum + ringContribution(hole).area, 0);
    const area = Math.max(0, outerArea - holeArea);
    totalArea += area;
    x += anchor[0] * area;
    y += anchor[1] * area;
  }
  if (totalArea <= 1e-9) return geometry.coordinates[0]?.[0]?.[0] ?? [0, 0];
  return [x / totalArea, y / totalArea];
}

function localize(geometry: NormalizedGeometry): NormalizedGeometry | null {
  const mapPoint = (point: Coordinate): Coordinate => wgs84ToRender(point);
  if (geometry.type === "Point") return { type: "Point", coordinates: mapPoint(geometry.coordinates) };
  if (geometry.type === "LineString") return { type: "LineString", coordinates: geometry.coordinates.map(mapPoint) };
  if (geometry.type === "MultiLineString") return { type: "MultiLineString", coordinates: geometry.coordinates.map((points) => points.map(mapPoint)) };
  if (geometry.type === "Polygon") return normalizePolygonGeometry({ type: "Polygon", coordinates: geometry.coordinates.map((ring) => ring.map(mapPoint)) }) as NormalizedGeometry | null;
  return normalizePolygonGeometry({ type: "MultiPolygon", coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map(mapPoint))) }) as NormalizedGeometry | null;
}

function clipToBoundary(geometry: NormalizedGeometry, boundaries: PolygonGeometry[], boundaryIndex: BoundaryIndex): NormalizedGeometry | null {
  if (geometry.type === "Point") return boundaryIndex.contains(geometry.coordinates) ? geometry : null;
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const sourceLines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
    if (sourceLines.every((points) => boundaryIndex.lineInside(points))) return geometry;
    if (sourceLines.every((points) => boundaryIndex.lineOutside(points))) return null;
    const clipped = sourceLines.flatMap((points) => boundaries.flatMap((boundary) => clipLineStringToPolygon(points, boundary)));
    if (clipped.length === 0) return null;
    return clipped.length === 1 ? { type: "LineString", coordinates: clipped[0]! } : { type: "MultiLineString", coordinates: clipped };
  }
  const sourcePolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (sourcePolygons.every((rings) => boundaryIndex.polygonInside(rings))) return geometry;
  if (sourcePolygons.every((rings) => boundaryIndex.polygonOutside(rings))) return null;
  const clipped: Coordinate[][][] = [];
  for (const rings of sourcePolygons) {
    for (const boundary of boundaries) {
      const intersection = clipPolygonToPolygon({ type: "Polygon", coordinates: rings }, boundary);
      if (!intersection) continue;
      if (intersection.type === "Polygon") clipped.push(intersection.coordinates);
      else clipped.push(...intersection.coordinates);
    }
  }
  if (clipped.length === 0) return null;
  return clipped.length === 1 ? { type: "Polygon", coordinates: clipped[0]! } : { type: "MultiPolygon", coordinates: clipped };
}

function metadata(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== ""));
}

/* BD TOPO grades every road segment by `importance` (1 = national backbone
   down to 6 = footpath) and records its administrative class separately. The
   nature alone only says how many carriageways a road has, so a departmental
   road and a farm lane both used to come out as "secondary". The class used by
   the renderer and search is the hierarchy a map reader expects. */
export function roadClass(
  nature: string | undefined,
  importance?: string,
  classement?: string,
  urbain?: boolean,
): string {
  const normalized = folded(nature);
  const rank = importance === undefined ? Number.NaN : Number.parseInt(importance, 10);
  const admin = folded(classement);
  if (normalized === "sentier") return "path";
  if (normalized === "escalier") return "steps";
  if (normalized === "piste cyclable") return "cycleway";
  if (normalized === "bac ou liaison maritime") return "ferry";
  if (normalized === "type autoroutier" && (rank === 1 || admin.includes("autoroute"))) return "motorway";
  if (normalized === "chemin" || normalized === "route empierree") return rank <= 4 ? "tertiary" : "track";
  if (admin.includes("nationale") || rank === 1) return "trunk";
  if (rank === 2) return "primary";
  if (rank === 3) return "secondary";
  if (rank === 4) return "tertiary";
  if (rank === 5) return urbain === true ? "residential" : "unclassified";
  if (rank === 6) return "service";
  if (normalized === "type autoroutier") return "motorway";
  if (normalized === "route a 2 chaussees") return "primary";
  return "unclassified";
}

/** The street name BAN and the collaborative base agree on, left side first. */
export function roadName(properties: Record<string, unknown>): string | undefined {
  return text(properties.nom_voie_ban_gauche)
    ?? text(properties.nom_voie_ban_droite)
    ?? text(properties.nom_collaboratif_gauche)
    ?? text(properties.nom_collaboratif_droite)
    ?? text(properties.cpx_toponyme_route_nommee);
}

/** Road number such as D930 or N124; several numbers are separated by "/". */
export function roadRef(properties: Record<string, unknown>): string | undefined {
  const value = text(properties.cpx_numero);
  if (value === undefined) return undefined;
  return value.split("/").map((part) => part.trim()).filter((part) => part.length > 0 && part.toUpperCase() !== "NC").join(" / ") || undefined;
}

function roadOneway(direction: string | undefined): boolean | undefined {
  const value = folded(direction);
  if (value === "sens direct" || value === "sens inverse") return true;
  if (value === "double sens") return false;
  return undefined;
}

function folded(value: string | undefined): string {
  return value?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim() ?? "";
}

function mappedValue(foldedValue: string, table: Record<string, string>): string {
  return table[foldedValue] ?? "other";
}

const STRUCTURE_TYPE_BY_NATURE: Record<string, string> = {
  pont: "bridge",
  tunnel: "tunnel",
  barrage: "dam",
  ecluse: "lock",
  quai: "quay",
  mur: "wall",
  "mur de soutenement": "retaining_wall",
  "mur anti-bruit": "noise_wall",
  cloture: "fence",
  ruines: "ruins",
  "fronton de pelote basque": "sports_wall",
  "autre ligne descriptive": "other",
};

const LANDUSE_TYPE_BY_NATURE: Record<string, string> = {
  bois: "wood",
  "foret fermee de feuillus": "forest",
  "foret fermee mixte": "forest",
  "foret fermee de coniferes": "forest",
  "foret ouverte": "forest",
  "lande ligneuse": "heath",
  peupleraie: "poplar",
  vigne: "vineyard",
  verger: "orchard",
  "reservoir d'eau ou chateau d'eau au sol": "reservoir",
  "chateau d'eau": "water_tower",
  "reservoir industriel": "industrial_reservoir",
  civil: "cemetery",
  militaire: "cemetery",
  "militaire etranger": "cemetery",
  "terrain de tennis": "sports",
  "grand terrain de sport": "sports",
  "petit terrain multi-sports": "sports",
  "carriere equestre": "sports",
  "bassin de natation": "sports",
  "piste de sport": "sports",
  "site natura 2000": "reserve",
  "site acquis ou assimile des conservatoires d'especes naturels": "reserve",
  "arrete de protection": "reserve",
};

const POI_TYPE_BY_NATURE: Record<string, string> = {
  source: "spring",
  "source captee": "spring",
  "point d'eau": "water_point",
  citerne: "cistern",
  fontaine: "fountain",
  lavoir: "washhouse",
  perte: "sink",
  resurgence: "resurgence",
  marais: "marsh",
  croix: "cross",
  clocher: "bell_tower",
  transformateur: "transformer",
  antenne: "antenna",
  "autre construction elevee": "elevated_structure",
  cheminee: "chimney",
  calvaire: "calvary",
  "puits d'hydrocarbures": "well",
  torchere: "torchere",
};

const TRANSPORT_TYPE_BY_NATURE: Record<string, string> = {
  parking: "parking",
  carrefour: "roundabout",
  "rond-point": "roundabout",
  peage: "toll",
  port: "port",
  "arret voyageurs": "bus_stop",
  "gare routiere": "bus_stop",
  "gare voyageurs": "station",
  "gare voyageurs uniquement": "station",
  "gare voyageurs et fret": "station",
  "areogare": "station",
  "aire de repos ou de service": "parking",
  "aire de triage": "parking",
  "service dedie aux vehicules": "parking",
  "tour de controle aerien": "tower",
  "piste en herbe": "runway",
  "piste en dur": "runway",
};

const PLACE_TYPE_BY_NATURE: Record<string, string> = {
  "lieu-dit habite": "hamlet",
  "lieu-dit non habite": "locality",
  bois: "wood",
  arbre: "tree",
  sommet: "peak",
  versant: "slope",
  vallee: "valley",
  plaine: "plain",
  crete: "ridge",
  gouffre: "sinkhole",
  grotte: "cave",
  ile: "island",
  depression: "depression",
  col: "col",
  "autre foret publique": "forest",
  "foret domaniale": "forest",
};

const PLACE_TYPE_BY_OBJECT_CLASS: Record<string, string> = {
  "zone d'habitation": "settlement",
  "lieu-dit non habite": "locality",
  "zone d'activite ou d'interet": "named_area",
  "cours d'eau": "watercourse",
  "itineraire autre": "itinerary",
  "detail orographique": "terrain_feature",
  "detail hydrographique": "water_feature",
  "point du reseau": "network_point",
  "equipement de transport": "transport_facility",
  "plan d'eau": "water_body",
  "foret publique": "forest",
  "construction lineaire": "linear_structure",
  route: "road",
  "construction ponctuelle": "point_structure",
  "parc ou reserve": "protected_area",
  "construction surfacique": "area_structure",
  aerodrome: "airport",
  cimetiere: "cemetery",
  "voie ferree": "railway",
  "poste de transformation": "substation",
};

const WATER_WIDTH_M_BY_CLASS: Record<string, number> = {
  "entre 0 et 5 m": 2.5,
  "entre 5 et 15 m": 10,
  "entre 15 et 50 m": 32.5,
  "plus de 50 m": 60,
};

function importanceValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 6 ? parsed : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roadWidthMetres(properties: Record<string, unknown>): number | undefined {
  return numeric(properties.largeur_de_chaussee);
}

function railLineName(properties: Record<string, unknown>): string | undefined {
  return text(properties.cpx_toponyme) ?? text(properties.liens_vers_voie_ferree_nommee);
}

function hydroWidth(properties: Record<string, unknown>): number | undefined {
  return WATER_WIDTH_M_BY_CLASS[folded(text(properties.classe_de_largeur))];
}

function waterIntermittent(properties: Record<string, unknown>): boolean | undefined {
  const persistence = text(properties.persistance);
  if (persistence === undefined) return undefined;
  return persistence === "Intermittent" || persistence === "Sec";
}

function toponymyIdentity(properties: Record<string, unknown>): string | undefined {
  const objectClass = text(properties.classe_de_l_objet);
  const objectId = text(properties.cleabs_de_l_objet);
  if (!objectClass || !objectId) return undefined;
  return `${objectClass}/${objectId}`;
}

interface FeatureContext {
  properties: Record<string, unknown>;
  sourceId: string;
  common: Omit<MapFeature, "kind">;
}

function layerSourceLayer(value: unknown): { name: BdtopoLayerName; layer: string } | null {
  const output = text(value)?.toLowerCase();
  if (!output) return null;
  const spec = ADOPTED_LAYERS.get(output);
  return spec ? { name: spec.name, layer: spec.layer } : null;
}

function buildingFeature(context: FeatureContext): BuildingFeature {
  const { properties, common, sourceId } = context;
  const height = nonnegative(properties.hauteur);
  return {
    ...common,
    kind: "building",
    height,
    heightSource: height === undefined ? undefined : "explicit",
    levels: integerValue(properties.nombre_d_etages),
    buildingType: text(properties.nature),
    sourceMetadata: metadata({
      layer: "batiment",
      officialId: sourceId,
      nature: properties.nature,
      usage1: properties.usage_1,
      usage2: properties.usage_2,
      height: properties.hauteur,
      floors: properties.nombre_d_etages,
    }),
  };
}

function roadFeature(context: FeatureContext): RoadFeature {
  const { properties, common, sourceId } = context;
  const position = text(properties.position_par_rapport_au_sol);
  const bridge = position === "1";
  const tunnel = position === "-1";
  const width = roadWidthMetres(properties);
  const className = roadClass(
    text(properties.nature),
    text(properties.importance),
    text(properties.cpx_classement_administratif),
    parseBdBoolean(properties.urbain),
  );
  const ref = roadRef(properties);
  const oneway = roadOneway(text(properties.sens_de_circulation));
  const lanes = integerValue(properties.nombre_de_voies);
  return {
    ...common,
    kind: "road",
    highway: className,
    roadClass: className,
    ...(ref === undefined ? {} : { ref }),
    ...(oneway === undefined ? {} : { oneway }),
    ...(lanes === undefined || lanes <= 0 ? {} : { lanes }),
    width,
    widthInferred: width === undefined,
    widthSource: width === undefined ? "inferred_default" : "explicit",
    bridge,
    tunnel,
    stratum: tunnel ? "tunnel" : bridge ? "bridge" : "normal",
    layer: position,
    sourceMetadata: metadata({
      layer: "troncon_de_route",
      officialId: sourceId,
      nature: properties.nature,
      importance: properties.importance,
      positionParRapportAuSol: position,
      fictif: parseBdBoolean(properties.fictif),
      width: properties.largeur_de_chaussee,
      namesLeft: properties.nom_voie_ban_gauche,
      namesRight: properties.nom_voie_ban_droite,
      administrativeClass: properties.cpx_classement_administratif,
      manager: properties.cpx_gestionnaire,
      communeLeft: properties.insee_commune_gauche,
      communeRight: properties.insee_commune_droite,
      direction: properties.sens_de_circulation,
    }),
  };
}

function waterFeature(context: FeatureContext, layer: string, isSurface: boolean): WaterFeature {
  const { properties, common, sourceId } = context;
  const fictif = parseBdBoolean(properties.fictif);
  const width = hydroWidth(properties) ?? numeric(properties.largeur);
  const feature: WaterFeature = {
    ...common,
    kind: "water",
    waterType: text(properties.nature),
    width,
    widthInferred: width === undefined,
    fictiveAxis: !isSurface && fictif === true,
    isSurface,
    sourceMetadata: metadata({
      layer,
      officialId: sourceId,
      nature: properties.nature,
      fictif,
      widthClass: properties.classe_de_largeur,
      positionParRapportAuSol: properties.position_par_rapport_au_sol,
      persistence: properties.persistance,
      permanence: properties.caractere_permanent,
    }),
  };
  const intermittent = waterIntermittent(properties);
  return intermittent === undefined ? feature : { ...feature, intermittent };
}

function railFeature(context: FeatureContext): TransportFeature {
  const { properties, common, sourceId } = context;
  const nature = text(properties.nature);
  return {
    ...common,
    kind: "transport",
    transportType: "rail",
    line: railLineName(properties),
    network: text(properties.liens_vers_voie_ferree_nommee),
    sourceMetadata: metadata({
      layer: "troncon_de_voie_ferree",
      officialId: sourceId,
      nature,
      usage: properties.usage,
      electrified: parseBdBoolean(properties.electrifie),
      lanes: properties.nombre_de_voies,
      maxSpeed: properties.vitesse_maximale,
      gauge: properties.largeur,
      positionParRapportAuSol: properties.position_par_rapport_au_sol,
      state: properties.etat_de_l_objet,
    }),
  };
}

function transportAreaFeature(context: FeatureContext): TransportFeature {
  const { properties, common, sourceId } = context;
  return {
    ...common,
    kind: "transport",
    transportType: mappedValue(folded(text(properties.nature)), TRANSPORT_TYPE_BY_NATURE),
    sourceMetadata: metadata({
      layer: "equipement_de_transport",
      officialId: sourceId,
      nature: properties.nature,
      detailedNature: properties.nature_detaillee,
      importance: properties.importance,
      fictif: parseBdBoolean(properties.fictif),
      state: properties.etat_de_l_objet,
    }),
  };
}

function runwayFeature(context: FeatureContext): TransportFeature {
  const { properties, common, sourceId } = context;
  return {
    ...common,
    kind: "transport",
    transportType: "runway",
    sourceMetadata: metadata({
      layer: "piste_d_aerodrome",
      officialId: sourceId,
      nature: properties.nature,
      function: properties.fonction,
      state: properties.etat_de_l_objet,
    }),
  };
}

function airportFeature(context: FeatureContext): TransportFeature {
  const { properties, common, sourceId } = context;
  return {
    ...common,
    kind: "transport",
    transportType: "aerodrome",
    ref: text(properties.code_icao) ?? text(properties.code_iata),
    sourceMetadata: metadata({
      layer: "aerodrome",
      officialId: sourceId,
      category: properties.categorie,
      usage: properties.usage,
      altitude: properties.altitude,
      icao: properties.code_icao,
      iata: properties.code_iata,
      fictif: parseBdBoolean(properties.fictif),
      state: properties.etat_de_l_objet,
    }),
  };
}

function structureFeature(context: FeatureContext, sourceLayer: string): StructureFeature {
  const { properties, common, sourceId } = context;
  const height = nonnegative(properties.hauteur);
  return {
    ...common,
    kind: "structure",
    structureType: mappedValue(folded(text(properties.nature)), STRUCTURE_TYPE_BY_NATURE),
    height,
    heightSource: height === undefined ? undefined : "explicit",
    sourceMetadata: metadata({
      layer: sourceLayer,
      officialId: sourceId,
      nature: properties.nature,
      detailedNature: properties.nature_detaillee,
      importance: properties.importance,
      positionParRapportAuSol: properties.position_par_rapport_au_sol,
      state: properties.etat_de_l_objet,
    }),
  };
}

function landuseFeature(context: FeatureContext, sourceLayer: string): LanduseFeature {
  const { properties, common, sourceId } = context;
  return {
    ...common,
    kind: "landuse",
    landuseType: mappedValue(folded(text(properties.nature)), LANDUSE_TYPE_BY_NATURE),
    ...(sourceLayer === "zone_d_activite_ou_d_interet" ? optionalCategory(categoryForBdtopoNature(text(properties.nature))) : {}),
    sourceMetadata: metadata({
      layer: sourceLayer,
      officialId: sourceId,
      nature: properties.nature,
      detailedNature: properties.nature_detaillee,
      category: properties.categorie,
      importance: properties.importance,
      fictif: parseBdBoolean(properties.fictif),
      state: properties.etat_de_l_objet,
    }),
  };
}

function optionalCategory(category: string | undefined): { category?: string } {
  return category === undefined ? {} : { category };
}

function placeFeature(context: FeatureContext, sourceLayer: string, placeType: string): PlaceFeature {
  const { properties, common, sourceId } = context;
  return {
    ...common,
    kind: "place",
    placeType,
    importance: importanceValue(properties.importance),
    population: nonnegative(properties.population),
    sourceMetadata: metadata({
      layer: sourceLayer,
      officialId: sourceId,
      communeCode: properties.code_insee,
      postcode: properties.code_postal,
      nature: properties.nature,
      detailedNature: properties.nature_detaillee,
      importance: properties.importance,
      objectClass: properties.classe_de_l_objet,
      fictif: parseBdBoolean(properties.fictif),
      state: properties.etat_de_l_objet,
    }),
  };
}

function poiFeature(context: FeatureContext, sourceLayer: string, poiType: string, extra: Record<string, unknown> = {}): PoiFeature {
  const { properties, common, sourceId } = context;
  return {
    ...common,
    kind: "poi",
    poiType,
    category: categoryForBdtopoNature(text(properties.nature) ?? text(properties.type_principal), text(properties.activite_principale) ?? text(properties.libelle))
      ?? text(properties.activite_principale) ?? text(properties.nature),
    sourceMetadata: metadata({
      layer: sourceLayer,
      officialId: sourceId,
      ...extra,
      importance: properties.importance,
      state: properties.etat_de_l_objet,
    }),
  };
}

function erpFeature(context: FeatureContext): PoiFeature {
  const { properties, common, sourceId } = context;
  const category = text(properties.categorie);
  return poiFeature(context, "erp", `erp:${category ?? "inconnu"}`, {
    erpCategory: category,
    principalType: properties.type_principal,
    secondaryTypes: properties.types_secondaires,
    mainActivity: properties.activite_principale,
    publicAccess: parseBdBoolean(properties.public),
    open: parseBdBoolean(properties.ouvert),
    capacity: properties.capacite_d_accueil_du_public,
    addressNumber: properties.adresse_numero,
    addressStreet: properties.adresse_nom_1,
    postcode: properties.code_postal,
    commune: properties.insee_commune,
    buildingLink: properties.liens_vers_batiment,
  });
}

function buildFeature(
  layer: BdtopoLayerName,
  sourceLayer: string,
  context: FeatureContext,
  nature: string | undefined,
): MapFeature {
  const { properties } = context;
  switch (layer) {
    case "buildings":
      return buildingFeature(context);
    case "roads":
      return roadFeature(context);
    case "water-surfaces":
      return waterFeature(context, sourceLayer, true);
    case "water-lines":
      return waterFeature(context, sourceLayer, false);
    case "canalisations":
      return waterFeature(context, sourceLayer, false);
    case "rail":
      return railFeature(context);
    case "transport-equipment":
      return transportAreaFeature(context);
    case "airport-runways":
      return runwayFeature(context);
    case "airports":
      return airportFeature(context);
    case "area-structures":
    case "linear-structures":
      return structureFeature(context, sourceLayer);
    case "reservoirs":
    case "cemeteries":
    case "sports-grounds":
    case "protected-areas":
    case "vegetation":
    case "activity-areas":
      return landuseFeature(context, sourceLayer);
    case "settlements":
      return placeFeature(context, sourceLayer, mappedValue(folded(nature), PLACE_TYPE_BY_NATURE));
    case "uninhabited-places":
    case "terrain-features":
    case "public-forests":
      return placeFeature(context, sourceLayer, mappedValue(folded(nature), PLACE_TYPE_BY_NATURE));
    case "communes":
      return placeFeature(context, sourceLayer, "commune");
    case "toponymy":
      return placeFeature(context, sourceLayer, mappedValue(folded(text(properties.classe_de_l_objet)), PLACE_TYPE_BY_OBJECT_CLASS));
    case "named-water-bodies":
      return placeFeature(context, sourceLayer, "water_body");
    case "named-watercourses":
      return placeFeature(context, sourceLayer, "watercourse");
    case "point-structures":
    case "hydro-details":
      return poiFeature(context, sourceLayer, mappedValue(folded(nature), POI_TYPE_BY_NATURE), {
        detailedNature: properties.nature_detaillee,
        persistence: properties.persistance,
      });
    case "pylons":
      return poiFeature(context, sourceLayer, "pylon", { height: properties.hauteur, number: properties.numero });
    case "power-lines":
      return poiFeature(context, sourceLayer, "power_line", { voltage: properties.voltage, operator: properties.gestionnaire });
    case "reference-points":
      return poiFeature(context, sourceLayer, "reference_point", {
        route: properties.route,
        number: properties.numero,
        abscissa: properties.abscisse,
        elevation: properties.cote,
        kind: properties.type_de_pr,
        manager: properties.gestionnaire,
      });
    case "public-places":
      return erpFeature(context);
  }
}

const SEARCH_ONLY_LAYERS: ReadonlySet<BdtopoLayerName> = new Set(BD_TOPO_LAYERS.filter((spec) => spec.adoption === "search").map((spec) => spec.name));

function featureName(layer: BdtopoLayerName, properties: Record<string, unknown>): string | undefined {
  switch (layer) {
    case "roads":
      return roadName(properties);
    case "water-lines":
      return text(properties.cpx_toponyme_de_cours_d_eau) ?? text(properties.cpx_toponyme_d_entite_de_transition);
    case "water-surfaces":
    case "named-water-bodies":
    case "named-watercourses":
      return text(properties.cpx_toponyme_de_plan_d_eau) ?? text(properties.cpx_toponyme_de_cours_d_eau) ?? text(properties.toponyme);
    case "toponymy":
      return text(properties.graphie_du_toponyme);
    case "public-places":
      return text(properties.libelle) ?? text(properties.activite_principale);
    case "reference-points":
      return text(properties.libelle);
    case "communes":
      return text(properties.nom_officiel);
    case "pylons":
      return text(properties.numero) === undefined ? undefined : `Pylone ${properties.numero}`;
    case "power-lines":
      return text(properties.voltage) === undefined ? undefined : `Ligne electrique ${properties.voltage}`;
    default:
      return text(properties.toponyme) ?? text(properties.cpx_toponyme);
  }
}

export interface BdtopoNormalizationOptions {
  edition?: string;
  /** Local anchor of every inhabited place, keyed by its BD TOPO cleabs, so a
      commune label sits on its chef-lieu instead of its polygon centroid. */
  chefLieuAnchors?: ReadonlyMap<string, Coordinate>;
}

/** Local anchors of the inhabited places a commune links as its chef-lieu. */
export function settlementAnchors(sourceFeatures: Iterable<Record<string, unknown>>, into: Map<string, Coordinate> = new Map()): Map<string, Coordinate> {
  for (const candidate of sourceFeatures as Iterable<SourceFeature>) {
    const id = text(candidate.properties?.cleabs);
    if (id === undefined) continue;
    const geometry = asGeometry(candidate.geometry);
    if (geometry === null) continue;
    const local = localize(geometry);
    if (local === null) continue;
    into.set(id, geometryAnchor(local));
  }
  return into;
}

export function normalizeBdtopo(sourceFeatures: Record<string, unknown>[], boundaryPolygons: number[][][][], options: BdtopoNormalizationOptions = {}): MapFeature[] {
  const sourceReference: SourceReference = {
    source: SOURCE_NAME,
    url: options.edition === undefined ? SOURCE_URL : `${SOURCE_URL} (edition ${options.edition})`,
    timestamp: SOURCE_TIMESTAMP,
    license: SOURCE_LICENSE,
  };
  const boundaries: PolygonGeometry[] = boundaryPolygons.map((coordinates) => ({ type: "Polygon", coordinates: coordinates as Coordinate[][] }));
  const boundaryIndex = createBoundaryIndex(boundaryPolygons as Coordinate[][][][]);
  const result: MapFeature[] = [];
  for (const candidate of sourceFeatures as SourceFeature[]) {
    const resolved = layerSourceLayer(candidate.sourceLayer);
    if (!resolved) continue;
    const properties = candidate.properties ?? {};
    const sourceId = text(properties.cleabs) ?? toponymyIdentity(properties);
    if (!sourceId) continue;
    const sourceGeometry = asGeometry(candidate.geometry);
    if (!sourceGeometry) continue;
    const clipped = clipToBoundary(sourceGeometry, boundaries, boundaryIndex);
    if (!clipped) continue;
    const localGeometry = localize(clipped);
    if (!localGeometry) continue;
    const chefLieu = resolved.name === "communes" ? options.chefLieuAnchors?.get(text(properties.lien_vers_chef_lieu) ?? "") : undefined;
    const localAnchor = chefLieu ?? geometryAnchor(localGeometry);
    const [lon, lat] = renderToWgs84(localAnchor);
    const stableId = `ign-bdtopo:${resolved.layer}/${sourceId}`;
    const common = {
      stableId,
      sourceId,
      name: featureName(resolved.name, properties),
      lon,
      lat,
      x: localAnchor[0],
      z: localAnchor[1],
      geometry: clipped,
      localGeometry,
      confidence: parseBdBoolean(properties.fictif) === true ? ("medium" as const) : ("high" as const),
      status: text(properties.etat_de_l_objet) === "En ruine" ? ("uncertain" as const) : ("active" as const),
      provenance: [{ featureId: stableId, property: "geometry", winner: SOURCE_NAME, contenders: [SOURCE_NAME], priority: 100, timestamp: SOURCE_TIMESTAMP }],
      sourceRefs: [sourceReference],
    };
    const feature = buildFeature(resolved.name, resolved.layer, { properties, sourceId, common }, text(properties.nature));
    if (SEARCH_ONLY_LAYERS.has(resolved.name)) {
      feature.sourceMetadata = { ...feature.sourceMetadata, adoption: "search", sourceLayer: resolved.name };
    }
    result.push(feature);
  }
  return result;
}
