import { describe, expect, it } from "vitest";
import { MapTransform, MAX_PITCH, metresPerPixelAt, wrapAngle } from "@/lib/map/transform";

const W = 1200;
const H = 800;

function transform(state: Partial<{ center: [number, number]; zoom: number; bearing: number; pitch: number }> = {}): MapTransform {
  return new MapTransform({ center: [1000, 2000], zoom: 15, bearing: 0, pitch: 0, width: W, height: H, ...state });
}

const deg = (value: number): number => (value * Math.PI) / 180;

describe("MapTransform orientation", () => {
  it("puts the centre at the middle of the screen", () => {
    for (const bearing of [0, deg(37), deg(-120)]) {
      for (const pitch of [0, deg(30), deg(55)]) {
        const t = transform({ bearing, pitch });
        const [x, y] = t.mapToScreen(1000, 2000);
        expect(x).toBeCloseTo(W / 2, 3);
        expect(y).toBeCloseTo(H / 2, 3);
      }
    }
  });

  it("is north-up and east-right at bearing 0", () => {
    const t = transform();
    const [cx, cy] = t.mapToScreen(1000, 2000);
    const [nx, ny] = t.mapToScreen(1000, 2100);
    const [ex, ey] = t.mapToScreen(1100, 2000);
    expect(ny).toBeLessThan(cy);
    expect(nx).toBeCloseTo(cx, 3);
    expect(ex).toBeGreaterThan(cx);
    expect(ey).toBeCloseTo(cy, 3);
  });

  it("matches the zoom scale at pitch 0", () => {
    const t = transform({ zoom: 16 });
    const [x0] = t.mapToScreen(1000, 2000);
    const [x1] = t.mapToScreen(1000 + metresPerPixelAt(16) * 100, 2000);
    expect(x1 - x0).toBeCloseTo(100, 2);
  });

  it("faces the bearing: at 90° east is up and north points left", () => {
    const t = transform({ bearing: deg(90) });
    const [cx, cy] = t.mapToScreen(1000, 2000);
    const [ex, ey] = t.mapToScreen(1100, 2000);
    const [nx, ny] = t.mapToScreen(1000, 2100);
    expect(ey).toBeLessThan(cy);
    expect(ex).toBeCloseTo(cx, 3);
    expect(nx).toBeLessThan(cx);
    expect(ny).toBeCloseTo(cy, 3);
  });

  it("never mirrors: east stays clockwise of north on screen at any bearing and pitch", () => {
    for (let b = -180; b < 180; b += 30) {
      for (const pitch of [0, deg(45)]) {
        const t = transform({ bearing: deg(b), pitch });
        const [cx, cy] = t.mapToScreen(1000, 2000);
        const [nx, ny] = t.mapToScreen(1000, 2010);
        const [ex, ey] = t.mapToScreen(1010, 2000);
        /* Screen y points down, so a clockwise turn from north to east has a positive cross product. */
        const cross = (nx - cx) * (ey - cy) - (ny - cy) * (ex - cx);
        expect(cross).toBeGreaterThan(0);
      }
    }
  });

  it("tilting shows more ground above the centre than below", () => {
    const t = transform({ pitch: deg(50) });
    const top = t.screenToMap(W / 2, 0);
    const bottom = t.screenToMap(W / 2, H);
    expect(top[1] - 2000).toBeGreaterThan(2000 - bottom[1]);
  });
});

describe("MapTransform screen/map round trip", () => {
  it("screenToMap inverts mapToScreen on the ground", () => {
    for (const bearing of [0, deg(15), deg(-170)]) {
      for (const pitch of [0, deg(20), deg(58)]) {
        const t = transform({ bearing, pitch });
        for (const [x, y] of [[100, 120], [600, 400], [1100, 700], [10, 790]] as const) {
          const [e, n] = t.screenToMap(x, y);
          const [sx, sy] = t.mapToScreen(e, n);
          expect(sx).toBeCloseTo(x, 2);
          expect(sy).toBeCloseTo(y, 2);
        }
      }
    }
  });
});

describe("MapTransform anchored edits", () => {
  it("keeps the point under the cursor fixed while zooming", () => {
    for (const bearing of [0, deg(45)]) {
      for (const pitch of [0, deg(45)]) {
        const t = transform({ bearing, pitch });
        const cursor: [number, number] = [900, 250];
        const before = t.screenToMap(...cursor);
        t.zoomAround(17.3, ...cursor);
        const after = t.screenToMap(...cursor);
        expect(after[0]).toBeCloseTo(before[0], 3);
        expect(after[1]).toBeCloseTo(before[1], 3);
        expect(t.zoom).toBeCloseTo(17.3, 6);
      }
    }
  });

  it("keeps the point under the cursor fixed while rotating", () => {
    const t = transform({ pitch: deg(30) });
    const cursor: [number, number] = [300, 600];
    const before = t.screenToMap(...cursor);
    t.rotateAround(deg(70), ...cursor);
    const after = t.screenToMap(...cursor);
    expect(after[0]).toBeCloseTo(before[0], 3);
    expect(after[1]).toBeCloseTo(before[1], 3);
  });

  it("moves content with the pointer when panning", () => {
    for (const bearing of [0, deg(120)]) {
      const t = transform({ bearing, pitch: deg(25) });
      const grabbed = t.screenToMap(400, 300);
      t.setLocationAtPoint(grabbed, 520, 380);
      const [x, y] = t.mapToScreen(...grabbed);
      expect(x).toBeCloseTo(520, 2);
      expect(y).toBeCloseTo(380, 2);
    }
  });
});

describe("MapTransform constraints", () => {
  it("clamps zoom, pitch and centre", () => {
    const t = transform();
    t.setConstraints({ minZoom: 8, maxZoom: 20, bounds: [0, 0, 5000, 5000] });
    t.set({ zoom: 30, pitch: 2, center: [-100, 9000] });
    expect(t.zoom).toBe(20);
    expect(t.pitch).toBe(MAX_PITCH);
    expect(t.center).toEqual([0, 5000]);
    t.set({ zoom: 1 });
    expect(t.zoom).toBe(8);
  });

  it("wraps bearings into (-π, π]", () => {
    expect(wrapAngle(deg(190))).toBeCloseTo(deg(-170), 9);
    expect(wrapAngle(deg(-190))).toBeCloseTo(deg(170), 9);
    expect(wrapAngle(0)).toBe(0);
  });

  it("fits bounds", () => {
    const t = transform();
    const zoom = t.zoomToFit([0, 0, 12000, 8000], { top: 0, right: 0, bottom: 0, left: 0 });
    expect(metresPerPixelAt(zoom)).toBeCloseTo(10, 6);
  });
});
