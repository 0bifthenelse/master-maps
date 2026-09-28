import { describe, it, expect } from "vitest";
import {
  PAN_KEY_FRACTION,
  PAN_MAX_STEP,
  PAN_MIN_STEP,
  ZOOM_KEY_FACTOR,
  WHEEL_ZOOM_SPEED,
  HEADING_EPSILON,
  acceptsMapKey,
  clampZoom,
  headingForKey,
  normalizeHeading,
  headingsMatch,
  TOUCH_PINCH_TOLERANCE,
  TOUCH_TWIST_THRESHOLD,
  touchHeadingForGesture,
  panStepFor,
  worldPanFor,
  zoomDirectionFor,
  WHEEL_LINE_HEIGHT,
  WHEEL_NOTCH_PIXELS,
  WHEEL_ZOOM_BASE,
  wheelScaleFor,
  writeCursorMapPoint,
  KEY_PANS,
} from "@/components/map/mapNavigation";
import type { KeyPan } from "@/components/map/mapNavigation";

const WEST: KeyPan = { screenX: -1, screenY: 0 };
const EAST: KeyPan = { screenX: 1, screenY: 0 };
const NORTH: KeyPan = { screenX: 0, screenY: 1 };
const SOUTH: KeyPan = { screenX: 0, screenY: -1 };

interface KeyInit {
  code: string;
  key?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  target?: unknown;
}

function keyEvent(init: KeyInit): KeyboardEvent {
  return {
    code: init.code,
    key: init.key ?? "",
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    target: init.target ?? null,
  } as unknown as KeyboardEvent;
}

describe("panStepFor", () => {
  it("moves a fraction of the shorter visible axis", () => {
    expect(panStepFor(1000, 2000)).toBeCloseTo(1000 * PAN_KEY_FRACTION, 9);
  });

  it("clamps a department scale step to a few hundred metres", () => {
    expect(panStepFor(141000, 88000)).toBe(PAN_MAX_STEP);
  });

  it("clamps a building scale step to a few tens of metres", () => {
    expect(panStepFor(40, 90)).toBe(PAN_MIN_STEP);
  });

  it("falls back to the minimum for a degenerate frustum", () => {
    expect(panStepFor(0, Number.NaN)).toBe(PAN_MIN_STEP);
  });
});

describe("worldPanFor", () => {
  it("pans east and north at zero heading", () => {
    const east = worldPanFor(1000, 1000, 0, EAST);
    expect(east.dx).toBeCloseTo(120, 9);
    expect(east.dz).toBeCloseTo(0, 9);
    const north = worldPanFor(1000, 1000, 0, NORTH);
    expect(north.dx).toBeCloseTo(0, 9);
    expect(north.dz).toBeCloseTo(120, 9);
  });

  it("moves H west and never east", () => {
    const west = worldPanFor(1000, 1000, 0, WEST);
    expect(west.dx).toBeCloseTo(-120, 9);
    expect(west.dz).toBeCloseTo(0, 9);
  });

  it("follows the heading so the key always moves the map on screen", () => {
    const eastOnScreen = worldPanFor(1000, 1000, Math.PI / 2, EAST);
    expect(eastOnScreen.dz).toBeCloseTo(-120, 9);
    expect(Math.abs(eastOnScreen.dx)).toBeLessThan(1e-9);
    const northOnScreen = worldPanFor(1000, 1000, Math.PI / 2, NORTH);
    expect(northOnScreen.dx).toBeCloseTo(120, 9);
    expect(Math.abs(northOnScreen.dz)).toBeLessThan(1e-9);
  });

  it("keeps a 45 degree heading on both world axes", () => {
    const diagonal = worldPanFor(1000, 1000, Math.PI / 4, EAST);
    expect(diagonal.dx).toBeCloseTo(120 * Math.SQRT1_2, 9);
    expect(diagonal.dz).toBeCloseTo(-120 * Math.SQRT1_2, 9);
  });
});

describe("key bindings", () => {
  it("binds HJKL and the four arrows to the same screen directions", () => {
    expect(KEY_PANS.KeyH).toEqual(WEST);
    expect(KEY_PANS.KeyL).toEqual(EAST);
    expect(KEY_PANS.KeyJ).toEqual(SOUTH);
    expect(KEY_PANS.KeyK).toEqual(NORTH);
    expect(KEY_PANS.ArrowLeft).toEqual(WEST);
    expect(KEY_PANS.ArrowRight).toEqual(EAST);
    expect(KEY_PANS.ArrowDown).toEqual(SOUTH);
    expect(KEY_PANS.ArrowUp).toEqual(NORTH);
  });

  it("maps plus and minus keys to a zoom direction", () => {
    expect(zoomDirectionFor(keyEvent({ code: "Equal", key: "+" }))).toBe(1);
    expect(zoomDirectionFor(keyEvent({ code: "NumpadAdd" }))).toBe(1);
    expect(zoomDirectionFor(keyEvent({ code: "Minus", key: "-" }))).toBe(-1);
    expect(zoomDirectionFor(keyEvent({ code: "NumpadSubtract" }))).toBe(-1);
  });

  it("ignores zoom keys carrying a browser modifier", () => {
    expect(zoomDirectionFor(keyEvent({ code: "Equal", ctrlKey: true }))).toBe(0);
    expect(zoomDirectionFor(keyEvent({ code: "Minus", metaKey: true }))).toBe(0);
    expect(zoomDirectionFor(keyEvent({ code: "Equal", altKey: true }))).toBe(0);
  });

  it("leaves unrelated keys alone", () => {
    expect(zoomDirectionFor(keyEvent({ code: "KeyQ" }))).toBe(0);
    expect(headingForKey(keyEvent({ code: "KeyQ" }))).toBeNull();
    expect(KEY_PANS.KeyQ).toBeUndefined();
  });

  it("maps the heading keys to a fixed 15 degree step", () => {
    expect(headingForKey(keyEvent({ code: "KeyA" }))).toBeCloseTo(-Math.PI / 12, 9);
    expect(headingForKey(keyEvent({ code: "BracketLeft" }))).toBeCloseTo(-Math.PI / 12, 9);
    expect(headingForKey(keyEvent({ code: "KeyE" }))).toBeCloseTo(Math.PI / 12, 9);
    expect(headingForKey(keyEvent({ code: "BracketRight" }))).toBeCloseTo(Math.PI / 12, 9);
    expect(headingForKey(keyEvent({ code: "KeyE", ctrlKey: true }))).toBeNull();
  });
});

describe("zoom range", () => {
  it("clamps wheel and pinch zoom to the configured range", () => {
    expect(clampZoom(0.01, 1, 4000)).toBe(1);
    expect(clampZoom(999999, 1, 4000)).toBe(4000);
    expect(clampZoom(37.5, 1, 4000)).toBe(37.5);
    expect(clampZoom(Number.NaN, 1, 4000)).toBe(1);
  });

  it("keeps one zoom key press inside the default range", () => {
    expect(clampZoom(1 * ZOOM_KEY_FACTOR, 1, 4000)).toBeCloseTo(1.25, 9);
  });
});
describe("wheel scale", () => {
  it("turns one line or page notch into one wheel ratio", () => {
    const scale = Math.pow(WHEEL_ZOOM_BASE, WHEEL_ZOOM_SPEED);
    expect(wheelScaleFor(-3, 1, WHEEL_ZOOM_SPEED)).toBeCloseTo(scale, 12);
    expect(wheelScaleFor(-1, 2, WHEEL_ZOOM_SPEED)).toBeCloseTo(scale, 12);
    expect(wheelScaleFor(3, 1, WHEEL_ZOOM_SPEED)).toBeCloseTo(1 / scale, 12);
    expect(wheelScaleFor(1, 2, WHEEL_ZOOM_SPEED)).toBeCloseTo(1 / scale, 12);
  });

  it("zooms pixel mode too, so no delta mode is left to a second owner", () => {
    expect(wheelScaleFor(-WHEEL_NOTCH_PIXELS, 0, WHEEL_ZOOM_SPEED)).toBeCloseTo(
      Math.pow(WHEEL_ZOOM_BASE, WHEEL_ZOOM_SPEED),
      12,
    );
    expect(wheelScaleFor(WHEEL_NOTCH_PIXELS, 0, WHEEL_ZOOM_SPEED)).toBeCloseTo(
      1 / Math.pow(WHEEL_ZOOM_BASE, WHEEL_ZOOM_SPEED),
      12,
    );
  });

  it("bounds large wheel deltas to three notches", () => {
    expect(wheelScaleFor(-100, 2, WHEEL_ZOOM_SPEED)).toBeCloseTo(
      Math.pow(WHEEL_ZOOM_BASE, 3 * WHEEL_ZOOM_SPEED),
      12,
    );
    expect(wheelScaleFor(Number.NaN, 1, WHEEL_ZOOM_SPEED)).toBe(1);
  });

  it("leaves the zoom alone for a zero or unusable delta", () => {
    expect(wheelScaleFor(0, 0, WHEEL_ZOOM_SPEED)).toBe(1);
    expect(wheelScaleFor(120, 0, Number.NaN)).toBe(1);
    expect(wheelScaleFor(120, 0, -1)).toBe(1);
  });
});

describe("cursor world anchor", () => {
  it("keeps the projected map point fixed when the target offsets for zoom", () => {
    const before = { x: 0, z: 0 };
    const after = { x: 0, z: 0 };
    const ndcX = -0.6;
    const ndcY = 0.4;
    const targetX = -100;
    const targetZ = 80;
    const halfWidth = 900;
    const halfHeight = 500;
    const heading = Math.PI / 5;
    const scale = wheelScaleFor(-WHEEL_LINE_HEIGHT, 1, WHEEL_ZOOM_SPEED);
    writeCursorMapPoint(before, ndcX, ndcY, targetX, targetZ, halfWidth, halfHeight, heading);
    writeCursorMapPoint(after, ndcX, ndcY, targetX, targetZ, halfWidth * scale, halfHeight * scale, heading);
    const nextTargetX = targetX + before.x - after.x;
    const nextTargetZ = targetZ + before.z - after.z;
    writeCursorMapPoint(
      after,
      ndcX,
      ndcY,
      nextTargetX,
      nextTargetZ,
      halfWidth * scale,
      halfHeight * scale,
      heading,
    );
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.z).toBeCloseTo(before.z, 10);
  });
});


describe("heading normalisation", () => {
  it("keeps a right drag inside plus or minus half a turn", () => {
    expect(normalizeHeading(0)).toBe(0);
    expect(normalizeHeading(Math.PI / 4)).toBeCloseTo(Math.PI / 4, 9);
    expect(normalizeHeading(2 * Math.PI)).toBeCloseTo(0, 9);
    expect(normalizeHeading(3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
    expect(normalizeHeading(-3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
  });
});

describe("heading alignment", () => {
  it("compares headings across the wrap boundary within tolerance", () => {
    expect(headingsMatch(Math.PI - 1e-5, -Math.PI + 1e-5)).toBe(true);
    expect(headingsMatch(0, HEADING_EPSILON * 2)).toBe(false);
  });
});
describe("two-touch heading gesture", () => {
  it("uses a twist only when the pinch scale stays within tolerance", () => {
    expect(touchHeadingForGesture(0.3, 100, 102, 0, 0.2)).toBeCloseTo(0.5, 9);
    expect(touchHeadingForGesture(0.3, 100, 105, 0, 0.2)).toBeNull();
    expect(touchHeadingForGesture(0.3, 100, 100, 0, TOUCH_TWIST_THRESHOLD / 2)).toBeNull();
  });
});

describe("acceptsMapKey", () => {
  it("absorbs map keys when focus is not on a text field", () => {
    expect(acceptsMapKey(keyEvent({ code: "KeyL" }))).toBe(true);
    expect(acceptsMapKey(keyEvent({ code: "KeyL", target: { tagName: "BUTTON", isContentEditable: false } }))).toBe(true);
  });

  it("leaves text entry alone", () => {
    expect(acceptsMapKey(keyEvent({ code: "KeyL", target: { tagName: "INPUT", isContentEditable: false } }))).toBe(false);
    expect(acceptsMapKey(keyEvent({ code: "KeyL", target: { tagName: "TEXTAREA", isContentEditable: false } }))).toBe(false);
    expect(acceptsMapKey(keyEvent({ code: "KeyL", target: { tagName: "DIV", isContentEditable: true } }))).toBe(false);
  });
});
