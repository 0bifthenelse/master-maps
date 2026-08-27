import { describe, expect, it } from "vitest";
import { fromLambert93, toLambert93, wgs84ToRender } from "@/lib/geo/crs";

describe("source-to-render geometry parity", () => {
  it("keeps known consecutive source vertices on the transformed line", () => {
    const source: [number, number][] = [[0.58, 43.64], [0.581, 43.641], [0.582, 43.642]];
    const render = source.map(wgs84ToRender);
    for (let index = 0; index < source.length; index += 1) {
      const roundTrip = fromLambert93(toLambert93(source[index]));
      expect(Math.hypot((roundTrip[0] - source[index][0]) * 80_000, (roundTrip[1] - source[index][1]) * 111_000)).toBeLessThan(0.05);
      expect(render[index]).toHaveLength(2);
    }
  });
});
