/**
 * Style ids stored per vertex in render tiles. The tile builder writes the
 * index, the shaders read colours, widths and zoom ranges for that index.
 * Order is the wire format: append, never reorder.
 */

export const ROAD_STYLES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "service",
  "track",
  "path",
  "cycleway",
  "steps",
  "pedestrian",
  "ferry",
] as const;
export type RoadStyle = (typeof ROAD_STYLES)[number];

export const LANDCOVER_STYLES = [
  "territory",
  "forest",
  "scrub",
  "grass",
  "farmland",
  "vineyard",
  "orchard",
  "residential",
  "industrial",
  "commercial",
  "cemetery",
  "sports",
  "park",
  "quarry",
  "wetland",
  "school",
  "health",
  "public",
  "religious",
  "reserve",
  "other",
] as const;
export type LandcoverStyle = (typeof LANDCOVER_STYLES)[number];

export const WATER_AREA_STYLES = ["water", "reservoir", "pool", "wetland"] as const;
export const WATER_LINE_STYLES = ["river", "stream", "canal", "ditch", "intermittent"] as const;
export const RAIL_STYLES = ["rail", "disused", "runway"] as const;
export const BOUNDARY_STYLES = ["department", "commune"] as const;
export const TRANSPORT_AREA_STYLES = ["parking", "aerodrome", "runway", "rail", "other"] as const;
export const STRUCTURE_STYLES = ["bridge", "dam", "wall", "other"] as const;
export const BUILDING_STYLES = [
  "generic",
  "residential",
  "religious",
  "industrial",
  "agricultural",
  "commercial",
  "public",
  "sports",
  "light",
  "castle",
  "tower",
] as const;

export function styleIndex<T extends readonly string[]>(styles: T, value: string | undefined, fallback: T[number]): number {
  const index = value === undefined ? -1 : styles.indexOf(value);
  return index >= 0 ? index : styles.indexOf(fallback);
}

/** Importance order for drawing: minor roads first so major ones sit on top. */
export const ROAD_DRAW_RANK: Readonly<Record<RoadStyle, number>> = {
  ferry: 0,
  steps: 1,
  path: 2,
  cycleway: 3,
  pedestrian: 4,
  track: 5,
  service: 6,
  unclassified: 7,
  residential: 8,
  tertiary: 9,
  secondary: 10,
  primary: 11,
  trunk: 12,
  motorway: 13,
};

const ROAD_ALIASES: Readonly<Record<string, RoadStyle>> = {
  motorway_link: "motorway",
  trunk_link: "trunk",
  primary_link: "primary",
  secondary_link: "secondary",
  tertiary_link: "tertiary",
  living_street: "residential",
  road: "unclassified",
  footway: "path",
  bridleway: "path",
  corridor: "path",
  roundabout: "tertiary",
  busway: "service",
  ford: "track",
};

export function roadStyle(roadClass: string | undefined): RoadStyle {
  if (roadClass === undefined) return "unclassified";
  if ((ROAD_STYLES as readonly string[]).includes(roadClass)) return roadClass as RoadStyle;
  return ROAD_ALIASES[roadClass] ?? "unclassified";
}

const LANDCOVER_ALIASES: Readonly<Record<string, LandcoverStyle>> = {
  wood: "forest",
  forest: "forest",
  poplar: "forest",
  heath: "scrub",
  scrub: "scrub",
  grassland: "grass",
  meadow: "grass",
  grass: "grass",
  village_green: "grass",
  recreation_ground: "park",
  allotments: "farmland",
  farmland: "farmland",
  farmyard: "farmland",
  greenhouse_horticulture: "farmland",
  plant_nursery: "orchard",
  vineyard: "vineyard",
  orchard: "orchard",
  residential: "residential",
  habitat: "residential",
  zone_d_habitation: "residential",
  garages: "residential",
  industrial: "industrial",
  railway: "industrial",
  construction: "industrial",
  brownfield: "industrial",
  landfill: "quarry",
  quarry: "quarry",
  commercial: "commercial",
  retail: "commercial",
  cemetery: "cemetery",
  grave_yard: "cemetery",
  sports: "sports",
  pitch: "sports",
  park: "park",
  garden: "park",
  playground: "park",
  wetland: "wetland",
  reserve: "reserve",
  nature_reserve: "reserve",
  military: "public",
  religious: "religious",
  education: "school",
};

/** Category ids (see data/categories.ts) whose grounds get a tint. */
const CATEGORY_LANDCOVER: Readonly<Record<string, LandcoverStyle>> = {
  school: "school",
  university: "school",
  kindergarten: "school",
  hospital: "health",
  nursing_home: "health",
  doctor: "health",
  town_hall: "public",
  public_service: "public",
  police: "public",
  fire_station: "public",
  post_office: "public",
  place_of_worship: "religious",
  cemetery: "cemetery",
  sports: "sports",
  swimming_pool: "sports",
  campsite: "park",
  park: "park",
  attraction: "park",
  industry: "industrial",
  utility: "industrial",
  shop: "commercial",
  market: "commercial",
  farm: "farmland",
};

export function landcoverStyle(landuseType: string | undefined, category?: string): LandcoverStyle {
  if (category !== undefined) {
    const fromCategory = CATEGORY_LANDCOVER[category];
    if (fromCategory !== undefined) return fromCategory;
  }
  if (landuseType === undefined) return "other";
  if ((LANDCOVER_STYLES as readonly string[]).includes(landuseType)) return landuseType as LandcoverStyle;
  return LANDCOVER_ALIASES[landuseType] ?? "other";
}

export function buildingStyle(buildingType: string | undefined, usage?: string): (typeof BUILDING_STYLES)[number] {
  const value = `${buildingType ?? ""} ${usage ?? ""}`.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (/relig|eglise|chapelle|church|cathedral|chapel/.test(value)) return "religious";
  if (/chateau|castle|fort/.test(value)) return "castle";
  if (/tour|donjon|tower|clocher/.test(value)) return "tower";
  if (/industri|usine|entrepot|warehouse|factory/.test(value)) return "industrial";
  if (/agric|grange|barn|farm|serre|hangar|silo/.test(value)) return "agricultural";
  if (/commerc|retail|shop|supermarket/.test(value)) return "commercial";
  if (/sport|gymnase|stade/.test(value)) return "sports";
  if (/annexe|legere|light|abri|shed|garage|carport/.test(value)) return "light";
  if (/public|mairie|school|ecole|hopital|hospital|civic|government|administrat/.test(value)) return "public";
  if (/resid|house|apartment|maison|logement|indifferenci/.test(value)) return "residential";
  return "generic";
}
