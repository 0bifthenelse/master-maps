import { describe, expect, it } from "vitest";
import { fromLambert93, renderToWgs84, toLambert93, wgs84ToRender } from "@/lib/geo/crs";

const samples: [number, number][] = [
  [0.586, 43.695],
  [-0.282, 43.311],
  [1.203, 44.08],
  [0.58, 43.65],
];

describe("EPSG:2154 conversion", () => {
  it("round-trips Gers WGS84 coordinates below five centimetres", () => {
    let worstMetres = 0;
    for (const point of samples) {
      const roundTrip = fromLambert93(toLambert93(point));
      const dx = (roundTrip[0] - point[0]) * 80_000;
      const dz = (roundTrip[1] - point[1]) * 111_000;
      worstMetres = Math.max(worstMetres, Math.hypot(dx, dz));
    }
    expect(worstMetres).toBeLessThan(0.05);
  });

  it("keeps east as x and north as z in render coordinates", () => {
    const origin = wgs84ToRender([0.586, 43.695]);
    const east = wgs84ToRender([0.587, 43.695]);
    const north = wgs84ToRender([0.586, 43.696]);
    expect(east[0]).toBeGreaterThan(origin[0]);
    expect(north[1]).toBeGreaterThan(origin[1]);
    expect(renderToWgs84(origin)[0]).toBeCloseTo(0.586, 10);
  });
});
