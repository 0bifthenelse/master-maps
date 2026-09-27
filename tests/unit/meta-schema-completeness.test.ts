import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MapFeatureSchema, TileMetaFeatureSchema } from "../../src/lib/data/schema";

const SCHEMA_PATH = path.join(process.cwd(), "src", "lib", "data", "schema.ts");

const POINT_GEOMETRY = { type: "Point", coordinates: [0.5, 43.5] } as const;
const AREA_GEOMETRY = {
  type: "Polygon",
  coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]],
} as const;
const LINE_GEOMETRY = { type: "LineString", coordinates: [[0, 0], [0.01, 0.01]] } as const;

const GEOMETRY_BY_KIND: Record<string, unknown> = {
  boundary: AREA_GEOMETRY,
  building: AREA_GEOMETRY,
  road: LINE_GEOMETRY,
  water: LINE_GEOMETRY,
  landuse: AREA_GEOMETRY,
  poi: POINT_GEOMETRY,
  business: POINT_GEOMETRY,
  address: POINT_GEOMETRY,
  transport: LINE_GEOMETRY,
  structure: LINE_GEOMETRY,
  place: POINT_GEOMETRY,
};

function canonicalFeature(kind: string): Record<string, unknown> {
  const geometry = GEOMETRY_BY_KIND[kind] ?? POINT_GEOMETRY;
  const required: Record<string, Record<string, unknown>> = {
    boundary: { territoryCode: "32" },
    landuse: { landuseType: "forest" },
    poi: { poiType: "bench" },
    business: { businessName: "Test" },
    address: { street: "Rue Test" },
    transport: { transportType: "rail" },
    structure: { structureType: "bridge" },
    place: { placeType: "town" },
  };
  return {
    stableId: `meta-completeness:${kind}`,
    kind,
    ...(required[kind] ?? {}),
    geometry,
    localGeometry: geometry,
    names: [],
    confidence: "medium",
    status: "active",
    provenance: [],
    sourceRefs: [],
  };
}

describe("tile meta schema completeness", () => {
  it("strips geometry from every canonical kind and still parses as a meta feature", () => {
    const kinds = MapFeatureSchema.options.map((option) => option.shape.kind.value as string);
    expect(kinds.length).toBeGreaterThanOrEqual(11);
    for (const kind of kinds) {
      const feature = MapFeatureSchema.parse(canonicalFeature(kind));
      const { geometry, localGeometry, sourceGeometry, ...meta } = feature as Record<string, unknown>;
      expect(geometry, kind).toBeDefined();
      expect(localGeometry, kind).toBeDefined();
      expect(sourceGeometry, kind).toBeUndefined();
      const parsed = TileMetaFeatureSchema.safeParse(meta);
      expect(parsed.success, `${kind}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`).toBe(true);
    }
  });

  it("declares every canonical optional field on the matching meta schema", () => {
    const source = readFileSync(SCHEMA_PATH, "utf8");
    const fieldNames = (block: string): Set<string> => new Set([...block.matchAll(/^\s{2}([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm)].map((match) => match[1]!));
    const blockFor = (declaration: string): string => {
      const start = source.indexOf(declaration);
      expect(start, declaration).toBeGreaterThan(-1);
      const end = source.indexOf("}).strict();", start);
      return source.slice(start, end);
    };
    const baseFields = fieldNames(blockFor("export const FeatureBaseSchema = z.object({"));
    const pairs: Array<[string, string]> = [
      ["BoundaryFeatureSchema", "BoundaryFeatureMetaSchema"],
      ["BuildingFeatureSchema", "BuildingFeatureMetaSchema"],
      ["RoadFeatureSchema", "RoadFeatureMetaSchema"],
      ["WaterFeatureSchema", "WaterFeatureMetaSchema"],
      ["LanduseFeatureSchema", "LanduseFeatureMetaSchema"],
      ["PoiFeatureSchema", "PoiFeatureMetaSchema"],
      ["BusinessFeatureSchema", "BusinessFeatureMetaSchema"],
      ["AddressFeatureSchema", "AddressFeatureMetaSchema"],
      ["TransportFeatureSchema", "TransportFeatureMetaSchema"],
      ["StructureFeatureSchema", "StructureFeatureMetaSchema"],
      ["PlaceFeatureSchema", "PlaceFeatureMetaSchema"],
    ];
    for (const [canonical, meta] of pairs) {
      const canonicalFields = fieldNames(blockFor(`export const ${canonical} = FeatureBaseSchema.extend({`));
      const metaFields = fieldNames(blockFor(`const ${meta} = FeatureMetaBaseSchema.extend({`));
      const geometryFields = new Set(["geometry", "localGeometry", "sourceGeometry"]);
      const missing = [...canonicalFields].filter((field) => !baseFields.has(field) && !geometryFields.has(field) && !metaFields.has(field));
      expect(missing, `${canonical} fields absent from ${meta}`).toEqual([]);
    }
  });
});
