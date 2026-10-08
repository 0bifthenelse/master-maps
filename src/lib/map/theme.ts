/**
 * "The Machine" palette. Colours are sRGB hex and are written to the screen
 * unchanged (the custom shaders skip colour-space conversion), so what is
 * written here is exactly what is seen.
 */
import {
  BOUNDARY_STYLES,
  BUILDING_STYLES,
  LANDCOVER_STYLES,
  RAIL_STYLES,
  ROAD_STYLES,
  STRUCTURE_STYLES,
  TRANSPORT_AREA_STYLES,
  WATER_AREA_STYLES,
  WATER_LINE_STYLES,
  type LandcoverStyle,
  type RoadStyle,
} from "@/lib/render/styles";

export type BaseMap = "machine" | "satellite";

export const MACHINE = {
  void: "#04060a",
  territory: "#0a0e13",
  grid: "#6d8aa6",
  ink: "#e8eef4",
  inkSoft: "#aab6c2",
  inkDim: "#6e7c8a",
  halo: "#04060a",
  yellow: "#f5c400",
  yellowSoft: "#ffe27a",
  red: "#ff3b3b",
  cyan: "#38d4ff",
  white: "#f3f6f9",
  water: "#0a2133",
  waterLine: "#1d6a93",
  shore: "#2b8fc2",
  roofs: "#1b222b",
  walls: "#0e1319",
  edges: "#5fa3cf",
} as const;

export const LANDCOVER_COLORS: Readonly<Record<LandcoverStyle, string>> = {
  territory: MACHINE.territory,
  forest: "#0d1a14",
  scrub: "#101913",
  grass: "#0f1714",
  farmland: "#0b1015",
  vineyard: "#170f1d",
  orchard: "#111a12",
  residential: "#121820",
  industrial: "#15161c",
  commercial: "#18151d",
  cemetery: "#101814",
  sports: "#0c1918",
  park: "#0e1c16",
  quarry: "#18160f",
  wetland: "#0b1a1e",
  school: "#16151d",
  health: "#1b1218",
  public: "#131925",
  religious: "#17131c",
  reserve: "#0d1a12",
  other: "#0f1318",
};

export interface RoadLook {
  fill: string;
  casing: string;
  /** Minimum half width of the fill, in CSS pixels. */
  minHalfPx: number;
  /** Zoom at which the class fades in. */
  fromZoom: number;
  /** Dash and gap in pixels, 0 for a solid line. */
  dash: [number, number];
}

export const ROAD_LOOK: Readonly<Record<RoadStyle, RoadLook>> = {
  motorway: { fill: "#ffd23f", casing: "#3d2f00", minHalfPx: 2.1, fromZoom: 5, dash: [0, 0] },
  trunk: { fill: "#f5c400", casing: "#3a2e00", minHalfPx: 1.9, fromZoom: 5, dash: [0, 0] },
  primary: { fill: "#f1f4f8", casing: "#06080c", minHalfPx: 1.6, fromZoom: 7.5, dash: [0, 0] },
  secondary: { fill: "#d2dbe5", casing: "#06080c", minHalfPx: 1.35, fromZoom: 9, dash: [0, 0] },
  tertiary: { fill: "#aab7c5", casing: "#06080c", minHalfPx: 1.1, fromZoom: 10.5, dash: [0, 0] },
  residential: { fill: "#7f8d9c", casing: "#05070a", minHalfPx: 0.9, fromZoom: 12.5, dash: [0, 0] },
  unclassified: { fill: "#6f7d8c", casing: "#05070a", minHalfPx: 0.85, fromZoom: 12, dash: [0, 0] },
  service: { fill: "#566270", casing: "#05070a", minHalfPx: 0.7, fromZoom: 14, dash: [0, 0] },
  track: { fill: "#6b6350", casing: "#05070a", minHalfPx: 0.65, fromZoom: 13, dash: [5, 3] },
  path: { fill: "#7b8794", casing: "#05070a", minHalfPx: 0.55, fromZoom: 14.5, dash: [3, 3] },
  cycleway: { fill: "#36c2a6", casing: "#05070a", minHalfPx: 0.6, fromZoom: 14, dash: [4, 3] },
  steps: { fill: "#7b8794", casing: "#05070a", minHalfPx: 0.6, fromZoom: 16, dash: [1.5, 1.5] },
  pedestrian: { fill: "#8a96a4", casing: "#05070a", minHalfPx: 0.8, fromZoom: 14.5, dash: [0, 0] },
  ferry: { fill: "#3d86b0", casing: "#04060a", minHalfPx: 0.6, fromZoom: 11, dash: [6, 4] },
};

export interface LineLook {
  color: string;
  minHalfPx: number;
  fromZoom: number;
  dash: [number, number];
  opacity: number;
}

export const WATER_LINE_LOOK: Readonly<Record<(typeof WATER_LINE_STYLES)[number], LineLook>> = {
  river: { color: "#2d93c7", minHalfPx: 1.2, fromZoom: 7, dash: [0, 0], opacity: 1 },
  stream: { color: "#1f6f99", minHalfPx: 0.6, fromZoom: 11.5, dash: [0, 0], opacity: 0.95 },
  canal: { color: "#2b86b8", minHalfPx: 0.9, fromZoom: 10, dash: [0, 0], opacity: 1 },
  ditch: { color: "#1a5b7e", minHalfPx: 0.45, fromZoom: 14, dash: [0, 0], opacity: 0.85 },
  intermittent: { color: "#1a5b7e", minHalfPx: 0.45, fromZoom: 13, dash: [4, 3], opacity: 0.8 },
};

export const RAIL_LOOK: Readonly<Record<(typeof RAIL_STYLES)[number], LineLook>> = {
  rail: { color: "#a7b1bc", minHalfPx: 0.9, fromZoom: 8, dash: [7, 4], opacity: 1 },
  disused: { color: "#59636e", minHalfPx: 0.7, fromZoom: 12, dash: [3, 4], opacity: 0.8 },
  runway: { color: "#283039", minHalfPx: 1.5, fromZoom: 10, dash: [0, 0], opacity: 1 },
};

export const BOUNDARY_LOOK: Readonly<Record<(typeof BOUNDARY_STYLES)[number], LineLook>> = {
  /* The detailed border takes over from the generalised one around z11.5 (a negative fromZoom means "until"). */
  department: { color: MACHINE.yellow, minHalfPx: 1.1, fromZoom: 11.5, dash: [10, 6], opacity: 0.95 },
  commune: { color: "#4a5b6e", minHalfPx: 0.5, fromZoom: 9.6, dash: [5, 4], opacity: 0.6 },
  department_overview: { color: MACHINE.yellow, minHalfPx: 1.1, fromZoom: -11.5, dash: [10, 6], opacity: 0.95 },
};

export const STRUCTURE_LINE_LOOK: Readonly<Record<(typeof STRUCTURE_STYLES)[number], LineLook>> = {
  bridge: { color: "#4e5a67", minHalfPx: 0.6, fromZoom: 15, dash: [0, 0], opacity: 0.9 },
  dam: { color: "#647283", minHalfPx: 0.8, fromZoom: 13, dash: [0, 0], opacity: 1 },
  wall: { color: "#3c4652", minHalfPx: 0.4, fromZoom: 16.5, dash: [0, 0], opacity: 0.8 },
  other: { color: "#3c4652", minHalfPx: 0.4, fromZoom: 16, dash: [0, 0], opacity: 0.7 },
};

export const WATER_AREA_COLORS: Readonly<Record<(typeof WATER_AREA_STYLES)[number], string>> = {
  water: MACHINE.water,
  reservoir: "#0b2438",
  pool: "#0f3346",
  wetland: "#0b1d24",
};

export const TRANSPORT_AREA_COLORS: Readonly<Record<(typeof TRANSPORT_AREA_STYLES)[number], string>> = {
  parking: "#141a21",
  aerodrome: "#111820",
  runway: "#262e37",
  rail: "#13171d",
  other: "#121821",
};

export const STRUCTURE_AREA_COLORS: Readonly<Record<(typeof STRUCTURE_STYLES)[number], string>> = {
  bridge: "#2b333d",
  dam: "#2f3843",
  wall: "#222a33",
  other: "#1d242c",
};

export const BUILDING_ROOF_COLORS: Readonly<Record<(typeof BUILDING_STYLES)[number], string>> = {
  generic: "#1b222b",
  residential: "#1c232c",
  religious: "#2a2433",
  industrial: "#1d2127",
  agricultural: "#1f2121",
  commercial: "#25212e",
  public: "#1c2534",
  sports: "#182628",
  light: "#161b21",
  castle: "#2c2a22",
  tower: "#262b33",
};

export function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/* Re-export the style lists so material code reads one module. */
export { LANDCOVER_STYLES, ROAD_STYLES, WATER_LINE_STYLES, RAIL_STYLES, BOUNDARY_STYLES, STRUCTURE_STYLES, WATER_AREA_STYLES, TRANSPORT_AREA_STYLES, BUILDING_STYLES };
