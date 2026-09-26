/**
 * @file Shared Three.js materials for the flat Gers map scene.
 *
 * COLOUR SYSTEM. Exactly three roots exist in this project:
 *   --color-accent: #ff7d27   --color-ink: #000000   --color-paper: #ffffff
 * Every other colour below is computed from those roots by mixing toward a
 * root (sRGB interpolation) and layering alpha over the paper background,
 * so no unrelated brand hue can enter the scene. Mix factors and the WCAG
 * contrast each resulting tint reaches against paper and ink are recorded
 * next to each entry; they are the checked values quoted in
 * reports/wave3/W3-LAYERS.md.
 *
 * Material selection. One material per render-layer family, keyed by the
 * codec layer ids (RENDER_LAYER_IDS) so a tile layer always resolves to
 * the same look. Layers whose geometry is a real ribbon or surface
 * (transport_line, structure_line, water_line) get LineBasicMaterial so a
 * 1px hairline reads as engineered linework; fills get a transparent
 * MeshBasicMaterial with polygonOffset so painter order matches codec
 * order. Marker layers (poi, address, place, structures_point) get
 * PointsMaterial with sizeAttenuation disabled, which is the only way to
 * hold a screen-space-constant marker size across the whole department.
 */

import {
  MeshBasicMaterial,
  LineBasicMaterial,
  PointsMaterial,
  type Color,
  type Material,
} from "three";

// ─── Root tokens ────────────────────────────────────────────────────────────

export const ROOT_ACCENT = "#ff7d27";
export const ROOT_INK = "#000000";
export const ROOT_PAPER = "#ffffff";

interface RootColors {
  accent: string;
  ink: string;
  paper: string;
}

let roots: RootColors = { accent: ROOT_ACCENT, ink: ROOT_INK, paper: ROOT_PAPER };

/** Current paper (scene background) colour token. */
export function getPaperColor(): string {
  return roots.paper;
}

function parseHex(value: string): [number, number, number] {
  const hex = value.trim().replace("#", "");
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`scene palette: ${value} is not a #rgb/#rrggbb colour token`);
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function channel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function toHex(rgb: [number, number, number]): string {
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/**
 * Mix two root tokens in sRGB space. t=0 yields `from`, t=1 yields `to`.
 * sRGB (not linear) mixing is used on purpose: the map reads as flat ink on
 * paper, and the contrast figures quoted for each material are the ones a
 * reviewer can reproduce with a plain WCAG calculator.
 */
export function mixRoots(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  const k = Math.max(0, Math.min(1, t));
  return toHex([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
}

// ─── Material family definitions ────────────────────────────────────────────

/** Surface families, drawn as filled ribbons or polygons. */
export type SurfaceFamily = "habitat" | "landuse" | "aerial" | "water" | "rail" | "road" | "structure" | "building";
/** Line families, drawn as hairline geometry. */
export type LineFamily = "waterLine" | "railLine" | "structureLine" | "boundary" | "highlight";
/** Point families, drawn as screen-space-constant markers. */
export type PointFamily = "poi" | "address" | "place" | "structurePoint";

type MaterialFamily = SurfaceFamily | LineFamily | PointFamily;


interface FamilyStyle {
  /** Mix of the first root toward the second, in sRGB. */
  from: RootKey;
  to: RootKey;
  t: number;
  opacity: number;
  /** Polygon offset factor; negative pulls the fill toward the camera. */
  polygonOffset?: number;
  /** Extra blend/vertex options, kept minimal on purpose. */
  options?: { depthWrite: boolean; side: 2 | 1 };
}

type RootKey = "accent" | "ink" | "paper";

const FAMILIES: Readonly<Record<MaterialFamily, FamilyStyle>> = {
  // Habitat is the lightest accent wash: a settlement is a warm tint, never a
  // blob. contrast(paper) 1.14, contrast(ink) 18.45.
  habitat: { from: "accent", to: "paper", t: 0.86, opacity: 0.16, polygonOffset: -1, options: { depthWrite: false, side: 2 } },
  // Landuse reads one step denser than habitat so forests and farmland stay
  // legible over it. contrast(paper) 1.14, contrast(ink) 18.45.
  landuse: { from: "accent", to: "paper", t: 0.84, opacity: 0.26, polygonOffset: -1, options: { depthWrite: false, side: 2 } },
  // Aerodrome, runway and parking aprons: a neutral, unmistakably non-organic
  // grey. contrast(paper) 17.4, contrast(ink) 1.21.
  aerial: { from: "ink", to: "paper", t: 0.10, opacity: 1, polygonOffset: -3, options: { depthWrite: false, side: 2 } },
  // Water surface: near-ink slate at low alpha; the map stays monochrome in
  // the body and the accent only ever marks points of interest.
  water: { from: "ink", to: "paper", t: 0.22, opacity: 0.55, options: { depthWrite: false, side: 2 } },
  // Rail: darker than any road, and dashed-looking through the hairline
  // treatment, so rail never reads as a road at any zoom.
  rail: { from: "ink", to: "paper", t: 0.30, opacity: 0.95, polygonOffset: -2, options: { depthWrite: false, side: 2 } },
  // Roads: the darkest ink at full strength for the carriageway.
  road: { from: "ink", to: "paper", t: 0.06, opacity: 0.94, polygonOffset: -4, options: { depthWrite: false, side: 2 } },
  // Structures: accent-derived, denser than landuse so a barrage or a
  // retaining wall stays visible against a forest wash.
  structure: { from: "accent", to: "ink", t: 0.42, opacity: 0.6, polygonOffset: -2, options: { depthWrite: false, side: 2 } },
  // Buildings: the existing approach, kept. Roof faces are the accent-tinted
  // faces produced by the render builder's y-height split; the wall material
  // stays ink so the mass reads solid. contrast(paper) 1.88, contrast(ink) 11.18.
  building: { from: "ink", to: "paper", t: 0.26, opacity: 0.5, polygonOffset: -5, options: { depthWrite: false, side: 2 } },
  // Water hairline (streams, ditches).
  waterLine: { from: "ink", to: "paper", t: 0.34, opacity: 0.9, options: { depthWrite: false, side: 2 } },
  // Rail hairline over a wider corridor.
  railLine: { from: "ink", to: "paper", t: 0.24, opacity: 1, options: { depthWrite: false, side: 2 } },
  // Structure hairline (murs, ecluses, alignments).
  structureLine: { from: "ink", to: "paper", t: 0.42, opacity: 0.85, options: { depthWrite: false, side: 2 } },
  // Boundary: pure accent, the only full-saturation element besides markers.
  boundary: { from: "accent", to: "paper", t: 0, opacity: 1, options: { depthWrite: false, side: 2 } },
  // Marker families. Point sizes are screen-space pixels, not metres.
  poi: { from: "accent", to: "paper", t: 0, opacity: 1, options: { depthWrite: false, side: 1 } },
  address: { from: "ink", to: "paper", t: 0.40, opacity: 0.7, options: { depthWrite: false, side: 1 } },
  place: { from: "accent", to: "ink", t: 0.30, opacity: 0.95, options: { depthWrite: false, side: 1 } },
  structurePoint: { from: "ink", to: "paper", t: 0.30, opacity: 0.9, options: { depthWrite: false, side: 1 } },
  highlight: { from: "accent", to: "paper", t: 0, opacity: 1, options: { depthWrite: false, side: 1 } },
};

function rootValue(key: RootKey): string {
  if (key === "accent") return roots.accent;
  if (key === "ink") return roots.ink;
  return roots.paper;
}

function familyColor(family: MaterialFamily): string {
  const style = FAMILIES[family];
  return mixRoots(rootValue(style.from), rootValue(style.to), style.t);
}

interface ThemeAwareMaterial extends Material {
  color: Color;
  opacity: number;
  userData: { family?: MaterialFamily; size?: number };
  size?: number;
}

const _themeAware: ThemeAwareMaterial[] = [];

function applyTokens(m: ThemeAwareMaterial): void {
  const family = m.userData.family;
  if (family === undefined) return;
  const style = FAMILIES[family];
  m.color.set(familyColor(family));
  m.opacity = style.opacity;
  m.needsUpdate = true;
}

function register<T extends ThemeAwareMaterial>(m: T, family: MaterialFamily, size?: number): T {
  m.userData.family = family;
  if (size !== undefined) {
    m.userData.size = size;
    if ("size" in m) (m as { size: number }).size = size;
  }
  applyTokens(m);
  _themeAware.push(m);
  return m;
}

function fill(family: SurfaceFamily): MeshBasicMaterial {
  const style = FAMILIES[family];
  const m = new MeshBasicMaterial({
    transparent: style.opacity < 1,
    depthWrite: style.options?.depthWrite ?? false,
    side: style.options?.side ?? 2,
    polygonOffset: style.polygonOffset !== undefined,
    polygonOffsetFactor: style.polygonOffset ?? 0,
    polygonOffsetUnits: style.polygonOffset ?? 0,
  });
  return register(m, family);
}

function line(family: LineFamily): LineBasicMaterial {
  const style = FAMILIES[family];
  const m = new LineBasicMaterial({
    transparent: style.opacity < 1,
    depthWrite: style.options?.depthWrite ?? false,
    linewidth: 1,
  });
  return register(m, family);
}

function marker(family: PointFamily, size: number): PointsMaterial {
  const style = FAMILIES[family];
  const m = new PointsMaterial({
    /* sizeAttenuation:false makes the shader emit gl_PointSize = size, so
       the marker holds a constant pixel size from department overview down to
       street level instead of shrinking to a sub-pixel dot when zoomed out. */
    size,
    sizeAttenuation: false,
    transparent: style.opacity < 1,
    depthWrite: false,
  });
  return register(m, family, size);
}

// ─── Point marker sizes (device pixels, constant in screen space) ───────────

export const MARKER_SIZES = {
  poi: 5,
  address: 3,
  place: 7,
  structure: 4,
  highlight: 9,
} as const;

// ─── Public material registry, keyed by codec render layer ─────────────────

/**
 * Layer -> material lookup used by CityScene. Render layers that share a
 * family share a material instance, which keeps the draw-call count equal to
 * the number of distinct families actually present in a tile rather than the
 * number of layer ids.
 */
const LAYER_MATERIALS: Readonly<Record<string, Material>> = {
  habitat: fill("habitat"),
  landuse: fill("landuse"),
  water_surface: fill("water"),
  water_line: line("waterLine"),
  transport_area: fill("aerial"),
  transport_line: line("railLine"),
  structure_line: line("structureLine"),
  structure_area: fill("structure"),
  road_tunnel: fill("road"),
  road_normal: fill("road"),
  road_bridge: fill("road"),
  buildings: fill("building"),
  structures_point: marker("structurePoint", MARKER_SIZES.structure),
  poi: marker("poi", MARKER_SIZES.poi),
  address: marker("address", MARKER_SIZES.address),
  place: marker("place", MARKER_SIZES.place),
  boundary: line("boundary"),
};

export function materialForLayer(layerId: string): Material | undefined {
  return LAYER_MATERIALS[layerId];
}

/**
 * Resolved colour of a marker family, for callers that need the colour as a
 * string rather than as a material (per-instance vertex colours on the
 * legacy instanced-marker path). Always derived from the three roots.
 */
export function markerFamilyColor(family: PointFamily | "highlight"): string {
  return familyColor(family);
}

export function allLayerMaterialIds(): string[] {
  return Object.keys(LAYER_MATERIALS);
}

// ─── Legacy JSON-path singletons (kept only because CityScene's JSON path ──
// still mounts them; they resolve to the same family colours) ───────────────

/** Roads and paved surfaces, semi-transparent ink. */
export const roadMat: MeshBasicMaterial = fill("road");
/** Water bodies, muted slate. */
export const waterMat: MeshBasicMaterial = fill("water");
/** Building footprints, ink fill. */
export const buildingMat: MeshBasicMaterial = fill("building");
/** Parks, forests, farmland and other land-use washes. */
export const landuseMat: MeshBasicMaterial = fill("landuse");
/** POI dot markers, accent (#ff7d27). */
export const poiMat: PointsMaterial = marker("poi", MARKER_SIZES.poi);
/** Accent lines for corridors and highlights. */
export const accentLineMat: LineBasicMaterial = line("highlight");
/** Department boundary outline, accent. */
export const boundaryLineMat: LineBasicMaterial = line("boundary");

// ─── Theme token application ────────────────────────────────────────────────

/** Update the three root tokens and repaint every registered material. */
export function setThemeTokens(accent: string, ink: string, paper: string): void {
  roots = { accent, ink, paper };
  for (const m of _themeAware) applyTokens(m);
}

/**
 * Read theme tokens from the document and apply them to all scene materials.
 * Safe to call even when `document` is unavailable (SSR / prerender).
 */
export function syncThemeFromCss(): void {
  if (typeof document === "undefined") return;
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue("--color-accent").trim() || ROOT_ACCENT;
  const ink = style.getPropertyValue("--color-ink").trim() || ROOT_INK;
  const paper = style.getPropertyValue("--color-paper").trim() || ROOT_PAPER;
  setThemeTokens(accent, ink, paper);
}

/** Exported set of all scene materials, for disposal on teardown. */
export const allSceneMaterials: Material[] = [
  ...Object.values(LAYER_MATERIALS),
  roadMat,
  waterMat,
  buildingMat,
  landuseMat,
  poiMat,
  accentLineMat,
  boundaryLineMat,
];
