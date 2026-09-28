'use client';

export const PAN_KEY_FRACTION = 0.12;
export const PAN_MIN_STEP = 25;
export const PAN_MAX_STEP = 400;
export const ZOOM_KEY_FACTOR = 1.25;
export const WHEEL_ZOOM_SPEED = 0.5;
export const WHEEL_ZOOM_BASE = 0.95;
export const WHEEL_NOTCH_PIXELS = 100;
export const WHEEL_LINE_HEIGHT = 3;
export const WHEEL_MAX_NOTCHES = 3;
export const MIN_HEADING = -Math.PI;
export const MAX_HEADING = Math.PI;
export const HEADING_EPSILON = 1e-4;

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
  const direction = screenDirectionFor(heading, pan.screenX, pan.screenY);
  return { dx: step * direction.x, dz: step * direction.z };
}

export interface CursorMapPoint {
  x: number;
  z: number;
}

export interface Orientation {
  northScreenUp: boolean;
  eastScreenRight: boolean;
  projectionYScale: number;
}

/* Top-down right-handed basis: the camera is pitched -PI/2 about X, so its local
   +Y (screen up) points at world -Z (south). North is screen up only when the
   projection Y scale is negative, which the mirrored frustum encodes. */
export const NORTH_SCREEN_UP_Y_SCALE = -1;

export function wheelScaleFor(deltaY: number, deltaMode: number, zoomSpeed: number): number {
  const notches = deltaMode === 0
    ? deltaY / WHEEL_NOTCH_PIXELS
    : deltaMode === 1
      ? deltaY / WHEEL_LINE_HEIGHT
      : deltaY;
  if (!Number.isFinite(notches) || notches === 0) return 1;
  if (!Number.isFinite(zoomSpeed) || zoomSpeed < 0) return 1;
  const clamped = Math.max(-WHEEL_MAX_NOTCHES, Math.min(WHEEL_MAX_NOTCHES, notches));
  return Math.pow(WHEEL_ZOOM_BASE, -clamped * zoomSpeed);
}

export function screenDirectionFor(
  heading: number,
  screenX: number,
  screenY: number,
): { x: number; z: number } {
  const cosine = Math.cos(heading);
  const sine = Math.sin(heading);
  return {
    x: cosine * screenX + sine * screenY,
    z: -sine * screenX + cosine * screenY,
  };
}

export function writeCursorMapPoint(
  point: CursorMapPoint,
  ndcX: number,
  ndcY: number,
  targetX: number,
  targetZ: number,
  halfWidth: number,
  halfHeight: number,
  heading: number,
): void {
  const direction = screenDirectionFor(heading, ndcX * halfWidth, ndcY * halfHeight);
  point.x = targetX + direction.x;
  point.z = targetZ + direction.z;
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

export function headingsMatch(current: number, desired: number): boolean {
  return Math.abs(normalizeHeading(current - desired)) <= HEADING_EPSILON;
}
export const TOUCH_PINCH_TOLERANCE = 0.03;
export const TOUCH_TWIST_THRESHOLD = Math.PI / 36;

export function touchHeadingForGesture(
  startHeading: number,
  startDistance: number,
  currentDistance: number,
  startAngle: number,
  currentAngle: number,
): number | null {
  if (
    !Number.isFinite(startHeading)
    || !Number.isFinite(startDistance)
    || !Number.isFinite(currentDistance)
    || !Number.isFinite(startAngle)
    || !Number.isFinite(currentAngle)
    || startDistance <= 0
  ) return null;
  if (Math.abs(currentDistance / startDistance - 1) > TOUCH_PINCH_TOLERANCE) return null;
  const twist = normalizeHeading(currentAngle - startAngle);
  if (Math.abs(twist) < TOUCH_TWIST_THRESHOLD) return null;
  return normalizeHeading(startHeading + twist);
}

export function acceptsMapKey(event: KeyboardEvent): boolean {
  const target = event.target as { tagName?: string; isContentEditable?: boolean } | null;
  if (target === null || typeof target.tagName !== "string") return true;
  if (KEY_TAGS[target.tagName] === true) return false;
  return target.isContentEditable !== true;
}
