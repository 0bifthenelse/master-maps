import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deduplicateStreaming, deduplicateFeatures, DEDUP_TEMP_ROOT } from "./deduplicate";
import { MapFeatureSchema, type Geometry, type MapFeature } from "../../src/lib/data/schema";

const T = "2026-01-01T00:00:00Z";

function f(id: string, x: number, z: number): MapFeature {
  const geometry: Geometry = { type: "Point", coordinates: [x, z] };
  return MapFeatureSchema.parse({
    kind: "poi",
    stableId: id,
    geometry,
    localGeometry: geometry,
    x,
    z,
    confidence: "high",
    status: "active",
    provenance: [{ featureId: id, property: "geometry", winner: "osm", contenders: ["osm"], priority: 1, timestamp: T }],
    sourceRefs: [{ source: "osm", timestamp: T }],
    poiType: "amenity",
  });
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(DEDUP_TEMP_ROOT, "w3b-spool-probe-"));
  const input = path.join(root, "in");
  const output = path.join(root, "out");
  await fs.mkdir(input);
  await fs.mkdir(output);
  const features: MapFeature[] = [];
  const bands = 70;
  const perBand = 4000;
  for (let band = 0; band < bands; band += 1) {
    for (let index = 0; index < perBand; index += 1) {
      const cellZ = band * 4 + (index % 4);
      features.push(f(`poi:${band}:${index}`, (index % 900) * 100 + 10, cellZ * 100 + 10));
    }
  }
  await fs.writeFile(path.join(input, "poi.json"), JSON.stringify(features), "utf8");
  console.log("input", features.length, "distinct ids", new Set(features.map((item) => item.stableId)).size);
  console.log("reference emitted", deduplicateFeatures(features).length);
  const stats = await deduplicateStreaming(input, output);
  console.log("bounded emitted", stats.emitted, "groups", stats.groups, "peakBands", stats.peakBands);
  await fs.rm(root, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
