'use client';

export const PAN_KEY_FRACTION = 0.12;
export const PAN_MIN_STEP = 25;
export const PAN_MAX_STEP = 400;
export const ZOOM_KEY_FACTOR = 1.25;
export const MIN_HEADING = -Math.PI;
export const MAX_HEADING = Math.PI;

export interface KeyPan {
  /** Screen-space pan direction, +x right and +y up in NDC. */
  screenX: number;
  screenY: number;
}

export const KEY_PANS: Readonly<Record<string, KeyPan>> = {
  KeyH: { screenX: -1, screenY: 0 },
  KeyL: { screenX: 1, screenY: 0 },
  KeyJ: { screenX: 0, screenY: -1 },
  KeyK: { screenX: 0, screenY: 1 },
  ArrowLeft: { screenX: -1, screenY: 0 },
  ArrowRight: { screenX: 1, screenY: 0 },
  ArrowDown: { screenX: 0, screenY: -1 },
  ArrowUp: { screenX: 0, screenY: 1 },
};

const KEY_ZOOMS: Readonly<Record<string, number>> = {
  Equal: 1,
  NumpadAdd: 1,
  Minus: -1,
  NumpadSubtract: -1,
};

const KEY_TAGS: Readonly<Record<string, true>> = { INPUT: true, TEXTAREA: true, SELECT: true };

export function panStepFor(visibleWidth: number, visibleHeight: number): number {
  const shortest = Math.min(Math.abs(visibleWidth), Math.abs(visibleHeight));
  if (!Number.isFinite(shortest) || shortest <= 0) return PAN_MIN_STEP;
  return Math.min(PAN_MAX_STEP, Math.max(PAN_MIN_STEP, shortest * PAN_KEY_FRACTION));
}

export function worldPanFor(
  visibleWidth: number,
  visibleHeight: number,
  heading: number,
  pan: KeyPan,
): { dx: number; dz: number } {
  const step = panStepFor(visibleWidth, visibleHeight);
  const screenRight = { x: Math.cos(heading), z: -Math.sin(heading) };
  const screenUp = { x: Math.sin(heading), z: Math.cos(heading) };
  return {
    dx: step * (pan.screenX * screenRight.x + pan.screenY * screenUp.x),
    dz: step * (pan.screenX * screenRight.z + pan.screenY * screenUp.z),
  };
}

export function zoomDirectionFor(event: KeyboardEvent): number {
  if (event.altKey || event.ctrlKey || event.metaKey) return 0;
  if (event.code in KEY_ZOOMS) return KEY_ZOOMS[event.code] ?? 0;
  if (event.key === '+' || event.key === '=' || event.key === '~') return 1;
  if (event.key === '-' || event.key === '_') return -1;
  return 0;
}

export function headingForKey(event: KeyboardEvent): number | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  switch (event.code) {
    case 'KeyA':
    case 'BracketLeft':
      return -Math.PI / 12;
    case 'KeyE':
    case 'BracketRight':
      return Math.PI / 12;
    default:
      return null;
  }
}

export function clampZoom(zoom: number, minZoom: number, maxZoom: number): number {
  if (!Number.isFinite(zoom)) return minZoom;
  return Math.max(minZoom, Math.min(maxZoom, zoom));
}

export function normalizeHeading(heading: number): number {
  const wrapped = ((heading + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return Math.min(MAX_HEADING, Math.max(MIN_HEADING, wrapped));
}

export function acceptsMapKey(event: KeyboardEvent): boolean {
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (target === null || typeof target.tagName !== "string") return true;
  if (KEY_TAGS[target.tagName] === true) return false;
  return target.isContentEditable !== true;
}
