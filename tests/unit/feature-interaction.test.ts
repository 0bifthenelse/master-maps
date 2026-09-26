import { describe, expect, it } from "vitest";
import { BufferAttribute, Group, type BufferGeometry } from "three";
import {
  buildFeatureHighlight,
  clearFeatureHighlight,
  createHighlightGroup,
  resolvePickedFeature,
  resolvePickedFeatureByStableId,
  setFeatureHighlight,
  HIGHLIGHT_LIFT_METRES,
  type FeatureHighlightTarget,
} from "@/lib/scene/highlight";
import { encodeRenderTile, type FeatureMeta, type RenderTileInput } from "@/lib/render/codec";
import { decodeRenderTile } from "@/lib/render/codec";

const BOUNDS: [number, number, number, number] = [-512, -512, 512, 512];

interface Fixture {
  target: (index: number) => FeatureHighlightTarget;
  meta: FeatureMeta[];
}

function tileInput(): RenderTileInput {
  const meta: FeatureMeta[] = [
    { s: "road/1@x", k: "road", c: "residential", a: [0, 0], w: 5 },
    { s: "building/1@y", k: "building", c: "yes", n: "Mairie", a: [10, 10], h: 9 },
    { s: "poi/1@z", k: "poi", c: "restaurant", n: "Table", a: [40, 40], p: { phone: "05 00 00 00 00" } },
  ];
  return {
    tileId: "l0_0_0",
    lod: 0,
    bounds: BOUNDS,
    datasetVersion: "v1",
    layers: [
      {
        id: "road_normal",
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        ranges: new Uint32Array([0, 6, 0]),
      },
      {
        id: "buildings",
        positions: new Float32Array([10, 0, 10, 12, 0, 10, 12, 0, 12, 10, 0, 12, 10, 0, 10, 10, 9, 10]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 0, 4, 5, 0, 4, 1, 5]),
        ranges: new Uint32Array([0, 15, 1]),
      },
      {
        id: "poi",
        positions: new Float32Array([40, 2, 40]),
        indices: new Uint32Array([]),
        ranges: new Uint32Array([0, 0, 2]),
      },
    ],
    meta,
  };
}

function fixture(): Fixture {
  const decoded = decodeRenderTile(encodeRenderTile(tileInput()));
  return {
    target: (index: number): FeatureHighlightTarget => ({ tile: decoded, layer: "buildings", index }),
    meta: decoded.meta,
  };
}

function positionsOf(object: { geometry: BufferGeometry }): Float32Array {
  return object.geometry.getAttribute("position").array as Float32Array;
}

describe("picked feature resolution", () => {
  it("maps a face index to the meta entry of the covering range", () => {
    const { target } = fixture();
    const pick = resolvePickedFeature(target(4));
    expect(pick).not.toBeNull();
    expect(pick?.stableId).toBe("building/1@y");
    expect(pick?.kind).toBe("building");
    expect(pick?.name).toBe("Mairie");
    expect(pick?.height).toBe(9);
    expect(pick?.tileId).toBe("l0_0_0");
    expect(pick?.layer).toBe("buildings");
  });

  it("returns null for a face index outside every range", () => {
    const { target } = fixture();
    expect(resolvePickedFeature(target(999))).toBeNull();
  });

  it("returns the road width and the poi props from meta", () => {
    const decoded = decodeRenderTile(encodeRenderTile(tileInput()));
    const road = resolvePickedFeature({ tile: decoded, layer: "road_normal", index: 1 });
    expect(road?.width).toBe(5);
    expect(road?.category).toBe("residential");
    const poi = resolvePickedFeature({ tile: decoded, layer: "poi", index: 0 });
    expect(poi?.props).toEqual({ phone: "05 00 00 00 00" });
  });

  it("carries the range index so a point feature stays addressable", () => {
    const decoded = decodeRenderTile(encodeRenderTile(tileInput()));
    const poi = resolvePickedFeature({ tile: decoded, layer: "poi", index: 0 });
    expect(poi?.rangeIndex).toBe(0);
    expect(poi?.stableId).toBe("poi/1@z");
    const building = resolvePickedFeature({ tile: decoded, layer: "buildings", index: 4 });
    expect(building?.rangeIndex).toBe(0);
  });

  it("resolves a stableId to the right point in a multi-point layer", () => {
    const many = tileInput();
    many.layers[2] = {
      id: "poi",
      positions: new Float32Array([0, 2, 0, 10, 2, 10, 20, 2, 20]),
      indices: new Uint32Array([]),
      ranges: new Uint32Array([0, 0, 2, 0, 0, 3, 0, 0, 4]),
    };
    many.meta = [
      ...many.meta,
      { s: "poi/2@a", k: "poi", c: "bar", a: [0, 0] },
      { s: "poi/2@b", k: "poi", c: "cafe", a: [10, 10] },
    ];
    const decoded = decodeRenderTile(encodeRenderTile(many));
    const second = resolvePickedFeatureByStableId(decoded, "poi/2@b");
    expect(second?.stableId).toBe("poi/2@b");
    expect(second?.category).toBe("cafe");
    expect(second?.rangeIndex).toBe(2);
    expect(second?.anchor).toEqual([10, 10]);
  });
});

describe("feature highlight geometry", () => {
  it("duplicates only the picked range, lifted above the feature", () => {
    const { target } = fixture();
    const highlight = buildFeatureHighlight(target(4));
    expect(highlight).not.toBeNull();
    const [fill, outline] = highlight!.objects;
    const fillPositions = positionsOf(fill as { geometry: BufferGeometry });
    expect(fillPositions).toHaveLength(6 * 3);
    const sourceHeights = [0, 9];
    for (let cursor = 1; cursor < fillPositions.length; cursor += 3) {
      const lifted = sourceHeights.some((height) => Math.abs(fillPositions[cursor]! - (height + HIGHLIGHT_LIFT_METRES)) < 1e-5);
      expect(lifted).toBe(true);
    }
    highlight!.dispose();
  });

  it("traces a silhouette with the shared interior edges cancelled", () => {
    const { target } = fixture();
    const highlight = buildFeatureHighlight(target(4));
    const outline = highlight!.objects[1] as unknown as { geometry: BufferGeometry };
    const positions = positionsOf(outline);
    const edges = positions.length / 6;
    expect(edges).toBeGreaterThan(0);
    const keys = new Set<string>();
    for (let cursor = 0; cursor < positions.length; cursor += 6) {
      keys.add(
        [positions[cursor]!, positions[cursor + 1]!, positions[cursor + 2]!,
          positions[cursor + 3]!, positions[cursor + 4]!, positions[cursor + 5]!].join(","),
      );
    }
    expect(keys.size).toBe(edges);
    highlight!.dispose();
  });

  it("draws a reticle for a point feature that owns no triangles", () => {
    const decoded = decodeRenderTile(encodeRenderTile(tileInput()));
    const highlight = buildFeatureHighlight({ tile: decoded, layer: "poi", index: 0 });
    expect(highlight).not.toBeNull();
    const outline = highlight!.objects[1] as unknown as { geometry: BufferGeometry };
    const positions = positionsOf(outline);
    expect(positions.length / 3).toBe(5);
    expect(positions[0]).toBeCloseTo(40 - 9, 5);
    expect(positions[14]).toBeCloseTo(40 - 9, 5);
    highlight!.dispose();
  });

  it("never writes into the tile payload", () => {
    const decoded = decodeRenderTile(encodeRenderTile(tileInput()));
    const before = new Uint8Array(decoded.payload.slice(0));
    const highlight = buildFeatureHighlight({ tile: decoded, layer: "buildings", index: 4 });
    const after = new Uint8Array(decoded.payload.slice(0));
    expect(Array.from(after)).toEqual(Array.from(before));
    highlight!.dispose();
  });
});

describe("highlight group ownership", () => {
  it("replaces and disposes the previous highlight", () => {
    const { target } = fixture();
    const group = createHighlightGroup();
    expect(group.userData.highlight).toBeNull();
    const first = buildFeatureHighlight(target(0));
    setFeatureHighlight(group, first);
    expect(group.children).toHaveLength(2);
    const firstFill = group.children[0]!;
    setFeatureHighlight(group, buildFeatureHighlight(target(4)));
    expect(group.children).toHaveLength(2);
    expect(group.children).not.toContain(firstFill);
    expect(firstFill.parent).toBeNull();
    clearFeatureHighlight(group);
    expect(group.children).toHaveLength(0);
    expect(group.userData.highlight).toBeNull();
  });

  it("stays empty when a pick no longer resolves", () => {
    const { target } = fixture();
    const group = createHighlightGroup();
    setFeatureHighlight(group, buildFeatureHighlight(target(4)));
    setFeatureHighlight(group, buildFeatureHighlight(target(999)));
    expect(group.children).toHaveLength(0);
  });

  it("adds and removes the group without touching a scene parent", () => {
    const group = createHighlightGroup();
    const scene = new Group();
    scene.add(group);
    expect(scene.children).toHaveLength(1);
    clearFeatureHighlight(group);
    expect(scene.children).toHaveLength(1);
    expect(group).toBeInstanceOf(Group);
    expect(group.getAttribute?.("nope")).toBeUndefined();
    void BufferAttribute;
  });
});
