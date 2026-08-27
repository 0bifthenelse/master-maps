import { describe, expect, it } from "vitest";
import { Color, Matrix4, Vector3 } from "three";
import { buildBusinessInstances } from "@/lib/scene/buildPois";

describe("batched business marker picking", () => {
  it("keeps stable feature mapping and updates highlight colours by instance", () => {
    const result = buildBusinessInstances([
      {
        kind: "business",
        stableId: "business:one",
        businessName: "One",
        geometry: { type: "Point", coordinates: [10, 20] },
      },
      {
        kind: "business",
        stableId: "business:two",
        businessName: "Two",
        geometry: { type: "Point", coordinates: [30, 40] },
      },
    ]);

    expect(result.featureIdByInstance).toEqual([0, 1]);
    expect(result.mesh.userData.businessFeatures).toHaveLength(2);

    const matrix = new Matrix4();
    const position = new Vector3();
    result.mesh.getMatrixAt(1, matrix);
    position.setFromMatrixPosition(matrix);
    expect(position.toArray()).toEqual([30, 0, 40]);

    const color = new Color();
    result.mesh.getColorAt(1, color);
    const original = color.getHexString();
    result.setHighlight(1);
    result.mesh.getColorAt(1, color);
    expect(color.getHexString()).toBe("ffb000");
    result.setHighlight(null);
    result.mesh.getColorAt(1, color);
    expect(color.getHexString()).toBe(original);

    result.mesh.material.dispose();
  });
});
