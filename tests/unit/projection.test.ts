import { describe, it, expect } from "vitest";
import { LocalProjection, computeCenter } from "@/lib/geo/projection";

describe("LocalProjection", () => {
  const origin: [number, number] = [0.586, 43.65]; // approximate Auch center
  const proj = new LocalProjection(origin);

  it("forward projects origin to [0, 0]", () => {
    const [x, z] = proj.forward(origin[0], origin[1]);
    expect(x).toBeCloseTo(0, 3);
    expect(z).toBeCloseTo(0, 3);
  });

  it("forward projects east coordinate positively", () => {
    const [x, _z] = proj.forward(0.596, 43.65); // east of origin
    expect(x).toBeGreaterThan(0);
  });

  it("forward projects north coordinate positively", () => {
    const [_x, z] = proj.forward(0.586, 43.66); // north of origin
    expect(z).toBeGreaterThan(0);
  });

  it("round-trips forward and reverse", () => {
    const testPoints: [number, number][] = [
      [0.5, 43.62],
      [0.6, 43.68],
      [0.55, 43.65],
      [origin[0], origin[1]],
    ];
    for (const [lng, lat] of testPoints) {
      const [x, z] = proj.forward(lng, lat);
      const [rlng, rlat] = proj.reverse(x, z);
      expect(rlng).toBeCloseTo(lng, 6);
      expect(rlat).toBeCloseTo(lat, 6);
    }
  });

  it("meters scale is reasonable (1 degree ~ 111km at equator)", () => {
    // 0.1 degree longitude at 43.65N
    const [x, _z] = proj.forward(origin[0] + 0.1, origin[1]);
    // cos(43.65°) ≈ 0.723, so 0.1° * 111319.9 * 0.723 ≈ 8048 meters
    expect(x).toBeGreaterThan(7000);
    expect(x).toBeLessThan(9000);
  });

  it("reverse projects known BAN coords for Nocibé", () => {
    // Nocibé: 0.591913, 43.648231
    const [x, z] = proj.forward(0.591913, 43.648231);
    const [lng, lat] = proj.reverse(x, z);
    expect(lng).toBeCloseTo(0.591913, 5);
    expect(lat).toBeCloseTo(43.648231, 5);
  });

  it("returns origin", () => {
    expect(proj.origin).toEqual(origin);
  });
});

describe("computeCenter", () => {
  it("computes a source boundary centroid without changing axis semantics", () => {
    const center = computeCenter({
      type: "Polygon",
      coordinates: [[
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]],
    });
    expect(center[0]).toBeCloseTo(5, 6);
    expect(center[1]).toBeCloseTo(5, 6);

    const local = new LocalProjection([0, 0]);
    expect(local.forward(0, 1)[1]).toBeGreaterThan(0);
    expect(local.forward(1, 0)[0]).toBeGreaterThan(0);
    expect(local.reverse(...local.forward(3, 4))).toEqual([
      expect.closeTo(3, 6),
      expect.closeTo(4, 6),
    ]);
  });
});