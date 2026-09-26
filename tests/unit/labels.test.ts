import { describe, expect, it } from "vitest";
import { MapFeatureSchema, type MapFeature } from "@/lib/data/schema";
import { buildRenderTile } from "@/lib/render/buildRenderTile";
import { decodeRenderTile, encodeRenderTile, type DecodedRenderTile } from "@/lib/render/codec";
import {
  LABEL_ZOOM_MIN,
  MAX_ADDRESS_LABELS_PER_MEGAPIXEL,
  MAX_VISIBLE_LABELS,
  buildLabelCandidates,
  countByKind,
  findOverlaps,
  layoutLabels,
  zoomBand,
  type LabelProjection,
} from "@/lib/scene/labels";

const BOUNDS: [number, number, number, number] = [0, 0, 4096, 4096];

let featureCounter = 0;

function feature(value: Record<string, unknown>): MapFeature {
  featureCounter += 1;
  return MapFeatureSchema.parse({ stableId: `test:${featureCounter}`, geometry: { type: "Point", coordinates: [0, 0] }, ...value } as Record<string, unknown>);
}

function road(value: Record<string, unknown>): MapFeature {
  featureCounter += 1;
  return MapFeatureSchema.parse({
    stableId: `test-road:${featureCounter}`,
    geometry: { type: "LineString", coordinates: [[0, 0], [400, 400]] },
    ...value,
  } as Record<string, unknown>);
}

function build(features: MapFeature[], bounds: [number, number, number, number] = BOUNDS): DecodedRenderTile {
  const input = buildRenderTile(features, { tileId: "l0_0_0", lod: 0, bounds, datasetVersion: "0.1.0" });
  return decodeRenderTile(encodeRenderTile(input));
}

/** Identity projection over a 1440x900 viewport mapping the bounds 1:1. */
function projection(bounds: [number, number, number, number] = BOUNDS, width = 1440, height = 900): LabelProjection {
  const [minX, minZ, maxX, maxZ] = bounds;
  return {
    width,
    height,
    metresPerPixel: (maxX - minX) / width,
    project: (x, z) => [
      ((x - minX) / (maxX - minX)) * width,
      height - ((z - minZ) / (maxZ - minZ)) * height,
    ],
  };
}

describe("buildLabelCandidates zoom gating", () => {
  it("reads the place name and importance out of the render tile meta", () => {
    const tile = build([
      feature({ kind: "place", placeType: "commune", importance: 2, name: "Auch", localGeometry: { type: "Point", coordinates: [1000, 2000] } }),
    ]);
    const candidates = buildLabelCandidates([tile], 1, {});
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe("Auch");
    expect(candidates[0]?.kind).toBe("place");
    expect(candidates[0]?.x).toBe(1000);
    expect(candidates[0]?.z).toBe(2000);
  });

  it("hides a low-importance place at the department overview and shows it when zoomed in", () => {
    const tile = build([
      feature({ kind: "place", placeType: "lieu_dit_non_habite", importance: 6, name: "Llop", localGeometry: { type: "Point", coordinates: [500, 500] } }),
    ]);
    expect(buildLabelCandidates([tile], 1, {})).toHaveLength(0);
    expect(buildLabelCandidates([tile], 24, {})).toHaveLength(1);
  });

  it("keeps every address hidden below the documented address threshold", () => {
    const tile = build([
      feature({ kind: "address", street: "Route de Lannux", housenumber: "114", name: "114 Route de Lannux", localGeometry: { type: "Point", coordinates: [800, 800] } }),
    ]);
    expect(buildLabelCandidates([tile], LABEL_ZOOM_MIN.address - 1, {})).toHaveLength(0);
    const atThreshold = buildLabelCandidates([tile], LABEL_ZOOM_MIN.address, {});
    expect(atThreshold).toHaveLength(1);
    expect(atThreshold[0]?.kind).toBe("address");
    expect(atThreshold[0]?.text).toBe("114 Route de Lannux");
  });

  it("gates streets behind their own threshold and never labels water or buildings", () => {
    const tile = build([
      road({ kind: "road", roadClass: "residential", name: "Rue de la Paix", localGeometry: { type: "LineString", coordinates: [[0, 0], [900, 900]] } }),
      feature({ kind: "building", name: "Mairie", localGeometry: { type: "Point", coordinates: [200, 200] } }),
    ]);
    expect(buildLabelCandidates([tile], LABEL_ZOOM_MIN.street - 1, {})).toHaveLength(0);
    const streets = buildLabelCandidates([tile], LABEL_ZOOM_MIN.street, {});
    expect(streets.map((label) => label.text)).toEqual(["Rue de la Paix"]);
  });

  it("honours the per-family layer switches", () => {
    const tile = build([
      feature({ kind: "place", placeType: "commune", importance: 1, name: "Auch", localGeometry: { type: "Point", coordinates: [100, 100] } }),
      feature({ kind: "poi", poiType: "restaurant", name: "Chez Paul", localGeometry: { type: "Point", coordinates: [300, 300] } }),
    ]);
    expect(buildLabelCandidates([tile], 14, { places: false })).toHaveLength(1);
    expect(buildLabelCandidates([tile], 14, { pois: false })).toHaveLength(1);
    expect(buildLabelCandidates([tile], 14, { places: false, pois: false })).toHaveLength(0);
  });

  it("classifies a settlement poi as a place, not a point of interest", () => {
    const tile = build([
      feature({ kind: "poi", poiType: "townhall", name: "Auch", localGeometry: { type: "Point", coordinates: [100, 100] } }),
      feature({ kind: "poi", poiType: "restaurant", name: "Chez Paul", localGeometry: { type: "Point", coordinates: [300, 300] } }),
    ]);
    const candidates = buildLabelCandidates([tile], 24, {});
    expect(candidates.map((label) => [label.text, label.kind])).toEqual([["Auch", "place"], ["Chez Paul", "poi"]]);
  });

  it("gates a settlement by its category importance at the department overview", () => {
    const tile = build([
      feature({ kind: "poi", poiType: "townhall", name: "Auch", localGeometry: { type: "Point", coordinates: [100, 100] } }),
      feature({ kind: "poi", poiType: "isolated_dwelling", name: "La Baraque", localGeometry: { type: "Point", coordinates: [300, 300] } }),
    ]);
    expect(buildLabelCandidates([tile], 1, {}).map((label) => label.text)).toEqual(["Auch"]);
    expect(buildLabelCandidates([tile], 24, {}).map((label) => label.text)).toEqual(["Auch", "La Baraque"]);
  });
});

describe("buildLabelCandidates priority order", () => {
  it("sorts by descending priority with a total tie-break so the output is deterministic", () => {
    const tile = build([
      feature({ kind: "place", placeType: "commune", importance: 5, name: "Petit", localGeometry: { type: "Point", coordinates: [100, 100] } }),
      feature({ kind: "place", placeType: "commune", importance: 1, name: "Grand", localGeometry: { type: "Point", coordinates: [200, 200] } }),
      feature({ kind: "place", placeType: "commune", importance: 5, name: "Autre", localGeometry: { type: "Point", coordinates: [300, 300] } }),
    ]);
    const first = buildLabelCandidates([tile], 6, {});
    const second = buildLabelCandidates([tile], 6, {});
    expect(first[0]?.text).toBe("Grand");
    expect(first[1]?.priority).toBe(first[2]?.priority);
    expect(new Set(first.map((label) => label.id)).size).toBe(3);
    expect(second.map((label) => label.id)).toEqual(first.map((label) => label.id));
  });

  it("truncates the pool to the requested size keeping the highest priorities", () => {
    const features: MapFeature[] = [];
    for (let index = 0; index < 40; index += 1) {
      features.push(feature({
        kind: "place",
        placeType: "commune",
        importance: 6 - (index % 5),
        name: `Lieu ${index}`,
        localGeometry: { type: "Point", coordinates: [index * 40, index * 40] },
      }));
    }
    const tile = build(features);
    const capped = buildLabelCandidates([tile], 6, {}, 10);
    expect(capped).toHaveLength(10);
    for (let index = 1; index < capped.length; index += 1) {
      expect(capped[index - 1]!.priority).toBeGreaterThanOrEqual(capped[index]!.priority);
    }
  });
});

describe("layoutLabels collision and caps", () => {
  it("never lets two placed labels overlap, whatever the input density", () => {
    const features: MapFeature[] = [];
    for (let index = 0; index < 400; index += 1) {
      features.push(feature({
        kind: "place",
        placeType: "commune",
        importance: 4,
        name: `Village ${index}`,
        localGeometry: { type: "Point", coordinates: [(index % 20) * 200, Math.floor(index / 20) * 200] },
      }));
    }
    const tile = build(features);
    const candidates = buildLabelCandidates([tile], 6, {});
    const placed = layoutLabels(candidates, projection(), { fontSize: 13 });
    expect(placed.length).toBeGreaterThan(0);
    expect(findOverlaps(placed)).toEqual([]);
  });

  it("drops the lower-priority label when two candidates fight for the same cell", () => {
    const tile = build([
      feature({ kind: "place", placeType: "commune", importance: 6, name: "Petit", localGeometry: { type: "Point", coordinates: [1000, 2000] } }),
      feature({ kind: "place", placeType: "commune", importance: 1, name: "Grand", localGeometry: { type: "Point", coordinates: [1005, 2005] } }),
    ]);
    const placed = layoutLabels(buildLabelCandidates([tile], 6, {}), projection(), { fontSize: 13 });
    expect(placed.map((label) => label.text)).toEqual(["Grand"]);
  });

  it("honours the hard cap on visible labels", () => {
    const features: MapFeature[] = [];
    for (let index = 0; index < 600; index += 1) {
      features.push(feature({
        kind: "place",
        placeType: "commune",
        importance: 3,
        name: `Nom ${index}`,
        localGeometry: { type: "Point", coordinates: [(index % 30) * 130, Math.floor(index / 30) * 130] },
      }));
    }
    const tile = build(features);
    const placed = layoutLabels(buildLabelCandidates([tile], 6, {}), projection(), { fontSize: 13 });
    expect(placed.length).toBeLessThanOrEqual(MAX_VISIBLE_LABELS);
  });

  it("caps addresses per megapixel of viewport, below the global cap", () => {
    const features: MapFeature[] = [];
    for (let index = 0; index < 300; index += 1) {
      features.push(feature({
        kind: "address",
        street: "Route de Lannux",
        housenumber: `${index}`,
        name: `${index} Route de Lannux`,
        localGeometry: { type: "Point", coordinates: [(index % 30) * 130, Math.floor(index / 30) * 130] },
      }));
    }
    const tile = build(features);
    const placed = layoutLabels(buildLabelCandidates([tile], 80, {}), projection(), { fontSize: 13 });
    const addresses = placed.filter((label) => label.kind === "address");
    const cap = Math.max(4, Math.floor(MAX_ADDRESS_LABELS_PER_MEGAPIXEL * (1440 * 900) / 1_000_000));
    expect(addresses.length).toBeLessThanOrEqual(cap);
    expect(addresses.length).toBeGreaterThan(0);
  });

  it("reports the per-family census of what it placed", () => {
    const tile = build([
      feature({ kind: "place", placeType: "commune", importance: 1, name: "Auch", localGeometry: { type: "Point", coordinates: [500, 3500] } }),
    ]);
    const counts = countByKind(layoutLabels(buildLabelCandidates([tile], 1, {}), projection(), { fontSize: 13 }));
    expect(counts.place).toBe(1);
    expect(counts.street).toBe(0);
  });

  it("lays out nothing for a degenerate viewport", () => {
    const tile = build([
      feature({ kind: "place", placeType: "commune", importance: 1, name: "Auch", localGeometry: { type: "Point", coordinates: [100, 100] } }),
    ]);
    expect(layoutLabels(buildLabelCandidates([tile], 1, {}), { width: 0, height: 0, project: () => [0, 0], metresPerPixel: 1 }, { fontSize: 13 })).toEqual([]);
  });
});

describe("zoomBand", () => {
  it("quantises a live zoom onto the band the candidate pool is built for", () => {
    expect(zoomBand(0.4)).toBe(0);
    expect(zoomBand(1)).toBe(1);
    expect(zoomBand(1.9)).toBe(1);
    expect(zoomBand(2.6)).toBe(2.5);
    expect(zoomBand(29)).toBe(24);
    expect(zoomBand(500)).toBe(120);
  });
});
