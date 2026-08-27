/**
 * @file Shared Three.js materials for the flat Gers map scene.
 *
 * All materials are exported as mutable singletons so theme switches
 * can update color, opacity, and tone-mapped values in one pass.
 *
 * @see THEME_TOKENS: --color-accent: #ff7d27, --color-ink, --color-paper
 */

import {
  MeshBasicMaterial,
  LineBasicMaterial,
  PointsMaterial,
  type Color,
  type Material,
} from 'three';

// ─── Theme token state ──────────────────────────────────────────────────────
// Read from CSS custom properties or injected programmatically.
// Default = light theme.
let _accent: string = '#ff7d27';
let _ink: string = '#000000';
let _paper: string = '#f7f4ed';

/** Current paper (scene background) colour token. */
export function getPaperColor(): string {
  return _paper;
}

/** Update the global colour palette used by all exported materials. */
export function setThemeTokens(accent: string, ink: string, paper: string): void {
  _accent = accent;
  _ink = ink;
  _paper = paper;

  // Push colours into every registered material.
  for (const m of _themeAware) {
    applyTokens(m);
  }
}

function applyTokens(m: ThemeAwareMaterial): void {
  if (m.userData.tokenRole === 'road') {
    m.color.set(_ink);
    m.opacity = 0.88;
  } else if (m.userData.tokenRole === 'water') {
    m.color.set('#6da8dc');
    m.opacity = 0.82;
  } else if (m.userData.tokenRole === 'building') {
    m.color.set(_ink);
    m.opacity = 0.18;
  } else if (m.userData.tokenRole === 'landuse') {
    m.color.set('#c8dcc0');
    m.opacity = 0.24;
  } else if (m.userData.tokenRole === 'poi') {
    m.color.set(_accent);
  } else if (m.userData.tokenRole === 'accent') {
    m.color.set(_accent);
  } else if (m.userData.tokenRole === 'boundary') {
    m.color.set(_accent);
    m.opacity = 0.6;
  }
  m.needsUpdate = true;
}

// ─── Theme-aware material tracking ──────────────────────────────────────────

interface ThemeAwareMaterial extends Material {
  color: Color;
  userData: { tokenRole?: string; fallbackColor?: string };
}
const _themeAware: ThemeAwareMaterial[] = [];

function register(m: ThemeAwareMaterial, role: string, fallback?: string): void {
  m.userData.tokenRole = role;
  if (fallback !== undefined) m.userData.fallbackColor = fallback;
  applyTokens(m);
  _themeAware.push(m);
}

// ─── Factories ──────────────────────────────────────────────────────────────

function roadMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  register(m, 'road');
  return m;
}

function waterMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    side: 2, // DoubleSide
  });
  register(m, 'water');
  return m;
}

function buildingMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  register(m, 'building');
  return m;
}

function landuseMaterial(): MeshBasicMaterial {
  const m = new MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    side: 2,
  });
  register(m, 'landuse');
  return m;
}

function poiMarkerMaterial(): PointsMaterial {
  const m = new PointsMaterial({
    size: 6,
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
  });
  register(m, 'poi');
  return m;
}

function accentLineMaterial(): LineBasicMaterial {
  const m = new LineBasicMaterial({
    transparent: true,
    depthWrite: false,
    linewidth: 1, // WebGL limitation; linewidth > 1 only supported on some systems
  });
  register(m, 'accent');
  return m;
}

function boundaryLineMaterial(): LineBasicMaterial {
  const m = new LineBasicMaterial({
    transparent: true,
    depthWrite: false,
  });
  register(m, 'boundary');
  return m;
}

// ─── Exported singleton instances ───────────────────────────────────────────

/** Roads and paved surfaces, semi-transparent ink. */
export const roadMat = roadMaterial();
/** Water bodies, muted blue. */
export const waterMat = waterMaterial();
/** Building footprints, slight ink fill. */
export const buildingMat = buildingMaterial();
/** Parks, forests, farmland, and other land-use colours. */
export const landuseMat = landuseMaterial();
/** POI dot markers, accent (#ff7d27). */
export const poiMat = poiMarkerMaterial();
/** Accent lines for boundary highlights and corridors, accent. */
export const accentLineMat = accentLineMaterial();
/** Department boundary outline, accent at reduced opacity. */
export const boundaryLineMat = boundaryLineMaterial();

// ─── Convenience: update all materials from CSS custom properties ───────────

/**
 * Read theme tokens from the document and apply them to all scene materials.
 * Safe to call even when `document` is unavailable (SSR / prerender).
 */
export function syncThemeFromCss(): void {
  if (typeof document === 'undefined') return;
  const style = getComputedStyle(document.documentElement);
  const a = style.getPropertyValue('--color-accent').trim() || '#ff7d27';
  const i = style.getPropertyValue('--color-ink').trim() || '#000000';
  const p = style.getPropertyValue('--color-paper').trim() || '#ffffff';
  setThemeTokens(a, i, p);
}

// ─── Exported set of all materials (for disposal) ───────────────────────────

export const allSceneMaterials: Material[] = [
  roadMat,
  waterMat,
  buildingMat,
  landuseMat,
  poiMat,
  accentLineMat,
  boundaryLineMat,
];