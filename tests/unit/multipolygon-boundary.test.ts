import { describe, expect, it } from "vitest";
import { transformGeometryToRender } from "@/lib/geo/crs";

describe("boundary geometry preservation", () => {
  it("preserves every polygon and hole in a MultiPolygon", () => {
    const geometry = {
      type: "MultiPolygon" as const,
      coordinates: [
        [[[0.58, 43.65], [0.59, 43.65], [0.59, 43.66], [0.58, 43.65]]],
        [[[0.60, 43.67], [0.61, 43.67], [0.61, 43.68], [0.60, 43.67]], [[0.605, 43.672], [0.606, 43.672], [0.606, 43.673], [0.605, 43.672]]],
      ],
    };
    const transformed = transformGeometryToRender(geometry);
    expect(transformed.type).toBe("MultiPolygon");
    if (transformed.type !== "MultiPolygon") throw new Error("unexpected geometry type");
    expect(transformed.coordinates).toHaveLength(2);
    expect(transformed.coordinates[1]).toHaveLength(2);
  });
});
