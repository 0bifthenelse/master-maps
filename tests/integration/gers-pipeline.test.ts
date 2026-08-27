import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBoundaryIndex, type BoundaryIndex } from "../../scripts/data/boundaryIndex";
import { wgs84ToRender } from "@/lib/geo/crs";
import { GERS_TERRITORY } from "@/lib/data/territory";
import { MapFeatureSchema, SearchRecordSchema, type Geometry, type MapFeature, type SearchRecord } from "@/lib/data/schema";
import anchors from "../fixtures/gers-landmark-anchors.json";

const ROOT = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const DATA_AVAILABLE = existsSync(join(ROOT, "raw", GERS_TERRITORY.boundaryRawFile))
  && existsSync(join(ROOT, "search", "index.json"))
  && existsSync(join(ROOT, "intermediate"));

type Anchor = { coordinate: [number, number]; sourceUrl: string };
const anchorRecords = anchors.anchors as Record<string, Anchor>;

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function geometryPoints(geometry: Geometry): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      points.push([value[0], value[1]]);
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return points;
}

function metricDistance(first: [number, number], second: [number, number]): number {
  const a = wgs84ToRender(first);
  const b = wgs84ToRender(second);
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}
function nearestGeometryPoint(geometry: Geometry, target: [number, number]): [number, number] | undefined {
  return geometryPoints(geometry).sort((first, second) => metricDistance(first, target) - metricDistance(second, target))[0];
}


function loadFeatures(): MapFeature[] {
  const directory = join(ROOT, "intermediate");
  const ignored = new Set(["provenance.json", "boundary-source.json", "bdtopo-manifest.json", "ign-unavailable.json", "osm-manifest.json", "osm-bulk-manifest.json", "relation-issues.json", "normalization-issues.json"]);
  const features: MapFeature[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || ignored.has(entry.name)) continue;
    const parsed = JSON.parse(readFileSync(join(directory, entry.name), "utf8")) as unknown;
    if (Array.isArray(parsed)) for (const value of parsed) features.push(MapFeatureSchema.parse(value));
  }
  return [...new Map(features.map((feature) => [feature.stableId, feature])).values()];
}

function loadSearch(): SearchRecord[] {
  const parsed = JSON.parse(readFileSync(join(ROOT, "search", "index.json"), "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("search index is not an array");
  return parsed.map((value) => SearchRecordSchema.parse(value));
}

function loadBoundaryIndex(): BoundaryIndex {
  const parsed = JSON.parse(readFileSync(join(ROOT, "raw", GERS_TERRITORY.boundaryRawFile), "utf8")) as { features?: Array<{ geometry?: { type?: string; coordinates?: unknown } }> };
  const geometry = parsed.features?.[0]?.geometry;
  if (!geometry || !Array.isArray(geometry.coordinates)) throw new Error("missing Gers boundary");
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  return createBoundaryIndex(polygons as number[][][][]);
}

describe("Gers production territory", () => {
  it("uses department 32 and the complete configured extent", () => {
    expect(GERS_TERRITORY.code).toBe("32");
    expect(GERS_TERRITORY.name).toBe("Gers");
    expect(GERS_TERRITORY.interchangeCrs).toBe("EPSG:4326");
    expect(GERS_TERRITORY.processingCrs).toBe("EPSG:2154");
    expect(Object.keys(anchorRecords)).toHaveLength(15);
  });

  it("resolves the five Auch source anchors in generated data", () => {
    if (!DATA_AVAILABLE) return;
    const features = loadFeatures();
    for (const key of ["gareAuch", "cathedralSainteMarie", "prefectureGers", "boulevardSadiCarnot", "avenueDAlsace"]) {
      const anchor = anchorRecords[key]!;
      const feature = features
        .filter((candidate) => candidate.sourceRefs.some((reference) => reference.url === anchor.sourceUrl))
        .sort((first, second) => metricDistance([first.lon ?? 0, first.lat ?? 0], anchor.coordinate) - metricDistance([second.lon ?? 0, second.lat ?? 0], anchor.coordinate))[0];
      expect(feature, `${key} source anchor`).toBeDefined();
      if (feature) {
        const point = nearestGeometryPoint(feature.geometry, anchor.coordinate);
        expect(point, `${key} geometry`).toBeDefined();
        if (point) expect(metricDistance(point, anchor.coordinate), key).toBeLessThan(150);
      }
    }
  });

  it("locates every distributed town inside the Gers boundary", () => {
    if (!DATA_AVAILABLE) return;
    const search = loadSearch();
    const boundary = loadBoundaryIndex();
    for (const key of ["condom", "lectoure", "fleurance", "eauze", "vicFezensac", "mirande", "marciac", "nogaro", "samatan", "lisleJourdain"]) {
      const anchor = anchorRecords[key]!;
      const target = normalized(key === "vicFezensac" ? "Vic-Fezensac" : key === "lisleJourdain" ? "L'Isle-Jourdain" : key[0]!.toUpperCase() + key.slice(1));
      const candidates = search.filter((entry) => normalized(entry.canonicalName) === target);
      const record = candidates.sort((first, second) => metricDistance([first.focusLon, first.focusLat], anchor.coordinate) - metricDistance([second.focusLon, second.focusLat], anchor.coordinate))[0];
      if (!record) continue;
      expect(boundary.contains([record.focusLon, record.focusLat]), `${key} boundary`).toBe(true);
      expect(metricDistance([record.focusLon, record.focusLat], anchor.coordinate), `${key} coordinate`).toBeLessThan(10_000);
      expect(record.tileId.startsWith("l0_")).toBe(true);
    }
  });

  it("keeps central Auch topology on the expected sides of the Gers", () => {
    if (!DATA_AVAILABLE) return;
    const features = loadFeatures();
    const centre = anchorRecords.cathedralSainteMarie.coordinate;
    const rivers = features.filter((feature) => feature.kind === "water" && normalized(feature.name ?? "").includes("gers"));
    const river = rivers.sort((first, second) => {
      const firstPoint = nearestGeometryPoint(first.geometry, centre);
      const secondPoint = nearestGeometryPoint(second.geometry, centre);
      return metricDistance(firstPoint ?? [0, 0], centre) - metricDistance(secondPoint ?? [0, 0], centre);
    })[0];
    expect(river, "named Gers water feature").toBeDefined();
    if (!river) return;
    const lonToleranceDegrees = (metres: number): number => metres / (111_320 * Math.cos(43.65 * Math.PI / 180));
    const localRiverLongitude = (anchor: [number, number]): number => nearestGeometryPoint(river.geometry, anchor)![0];
    expect(anchorRecords.cathedralSainteMarie.coordinate[0]).toBeLessThan(localRiverLongitude(anchorRecords.cathedralSainteMarie.coordinate) + lonToleranceDegrees(10));
    expect(anchorRecords.prefectureGers.coordinate[0]).toBeLessThan(localRiverLongitude(anchorRecords.prefectureGers.coordinate) + lonToleranceDegrees(10));
    expect(anchorRecords.boulevardSadiCarnot.coordinate[0]).toBeLessThan(localRiverLongitude(anchorRecords.boulevardSadiCarnot.coordinate) + lonToleranceDegrees(10));
    expect(anchorRecords.avenueDAlsace.coordinate[0]).toBeGreaterThan(localRiverLongitude(anchorRecords.avenueDAlsace.coordinate) - lonToleranceDegrees(10));
    const pasteur = features
      .filter((feature) => feature.kind === "road" && normalized(feature.name ?? "").includes("rue pasteur"))
      .sort((first, second) => metricDistance([first.lon ?? 0, first.lat ?? 0], centre) - metricDistance([second.lon ?? 0, second.lat ?? 0], centre))[0];
    expect(pasteur, "Rue Pasteur road").toBeDefined();
    if (pasteur) {
      const pasteurPoint = nearestGeometryPoint(pasteur.geometry, centre);
      expect(pasteurPoint).toBeDefined();
      const riverNearPasteur = pasteurPoint ? nearestGeometryPoint(river.geometry, pasteurPoint) : undefined;
      if (pasteurPoint && riverNearPasteur) expect(metricDistance(pasteurPoint, riverNearPasteur)).toBeLessThan(150);
    }
  });
});
