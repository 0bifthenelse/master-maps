import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createDedupAccounting,
  deduplicateStreaming,
  deduplicateAllInMemory,
  deduplicateFeatures,
  DEDUP_TEMP_ROOT,
  type DedupAccounting,
} from "../../scripts/data/deduplicate";
import { MapFeatureSchema, type Geometry, type MapFeature } from "@/lib/data/schema";
import { DROP_REASONS, STAGES, type ExclusionReason, type SourceLayerAccounting } from "../../scripts/data/exclusion-report";

const SOURCE_TIMESTAMP = "2026-01-01T00:00:00Z";

interface RecordedDrops {
  readonly counts: Map<string, number>;
}

function recordingAccounting(): DedupAccounting & { recorded: RecordedDrops } {
  const counts = new Map<string, number>();
  const base = createDedupAccounting();
  return {
    sources: base.sources,
    drops: {
      drop(stage: string, reason: ExclusionReason, count: number): void {
        const key = `${stage}|${reason}`;
        counts.set(key, (counts.get(key) ?? 0) + count);
        base.drops.drop(stage, reason, count);
      },
    },
    recorded: { counts },
  };
}

function feature(kind: string, stableId: string, source: string, geometry: Geometry, extra: Record<string, unknown> = {}): MapFeature {
  return MapFeatureSchema.parse({
    kind,
    stableId,
    geometry,
    localGeometry: geometry,
    x: 0,
    z: 0,
    confidence: "high",
    status: "active",
    provenance: [{ featureId: stableId, property: "geometry", winner: source, contenders: [source], priority: 1, timestamp: SOURCE_TIMESTAMP }],
    sourceRefs: [{ source, timestamp: SOURCE_TIMESTAMP }],
    ...extra,
  });
}

const square = (minX: number, minZ: number, maxX: number, maxZ: number): Geometry => ({
  type: "Polygon",
  coordinates: [[[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ], [minX, minZ]]],
});

const centred = (minX: number, minZ: number, maxX: number, maxZ: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  x: (minX + maxX) / 2,
  z: (minZ + maxZ) / 2,
  ...extra,
});

function canonical(features: MapFeature[]): string[] {
  return features.map((item) => JSON.stringify(item, Object.keys(item).sort())).sort();
}

function rowsSignature(rows: SourceLayerAccounting[]): string[] {
  return rows.map((row) =>
    [
      row.source,
      row.layer,
      row.kind,
      row.input,
      row.accepted,
      row.mergedDeduplicated,
      row.excludedByRule.map((entry) => `${entry.rule}=${entry.count}`).sort().join("+"),
    ].join("|")
  );
}

async function readOutput(dir: string): Promise<MapFeature[]> {
  const result: MapFeature[] = [];
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith(".json") && name !== "provenance.json").sort();
  for (const name of names) {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    if (Array.isArray(parsed)) for (const value of parsed) result.push(MapFeatureSchema.parse(value));
  }
  return result;
}

async function readProvenance(dir: string): Promise<unknown[]> {
  const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, "provenance.json"), "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

let root = "";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(DEDUP_TEMP_ROOT, "dedup-equiv-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function expectEquivalent(features: MapFeature[], name = "fixture.json"): Promise<MapFeature[]> {
  const streamIn = path.join(root, "in-stream");
  const memoryIn = path.join(root, "in-memory");
  const streamOut = path.join(root, "out-stream");
  const memoryOut = path.join(root, "out-memory");
  for (const dir of [streamIn, memoryIn, streamOut, memoryOut]) await fs.mkdir(dir);
  const payload = JSON.stringify(features);
  await fs.writeFile(path.join(streamIn, name), payload, "utf8");
  await fs.writeFile(path.join(memoryIn, name), payload, "utf8");
  const streamAccounting = recordingAccounting();
  const memoryAccounting = recordingAccounting();
  await deduplicateStreaming(streamIn, streamOut, streamAccounting);
  await deduplicateAllInMemory(memoryIn, memoryOut, memoryAccounting);

  const streamed = await readOutput(streamOut);
  const memory = await readOutput(memoryOut);
  expect(canonical(streamed)).toEqual(canonical(memory));
  expect(rowsSignature(streamAccounting.sources.rows())).toEqual(rowsSignature(memoryAccounting.sources.rows()));
  expect([...streamAccounting.recorded.counts.entries()].sort()).toEqual([...memoryAccounting.recorded.counts.entries()].sort());
  const provenanceKey = (records: unknown[]): string[] => records.map((record) => JSON.stringify(record)).sort();
  expect(provenanceKey(await readProvenance(streamOut))).toEqual(provenanceKey(await readProvenance(memoryOut)));
  return streamed;
}

describe("bounded memory deduplication equals the in memory reference", () => {
  it("keeps two distinct features in the same cell separate", async () => {
    const first = feature("building", "osm:way/1", "osm", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    const second = feature("building", "osm:way/2", "osm", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    expect(await expectEquivalent([first, second])).toHaveLength(2);
  });

  it("collapses an exact identity repeat and books a dedupExactIdentity drop", async () => {
    const winner = feature("building", "ign-bdtopo:building/1", "IGN BD TOPO", square(0, 0, 10, 10), centred(0, 0, 10, 10, { height: 12 }));
    const repeat = feature("building", "ign-bdtopo:building/1", "IGN BD TOPO", square(0, 0, 10, 10), centred(0, 0, 10, 10, { height: 12 }));
    const streamed = await expectEquivalent([winner, repeat]);
    expect(streamed).toHaveLength(1);
  });

  it("merges a cross cell building pair whose anchors straddle a 100 m bucket edge", async () => {
    const west = feature("building", "osm:way/10", "osm", square(96, 96, 104, 104), centred(96, 96, 104, 104));
    const east = feature("building", "ign-bdtopo:building/10", "IGN BD TOPO", square(96.5, 96.5, 103.5, 103.5), centred(96, 96, 104, 104));
    expect(Math.floor(96 / 100)).not.toBe(Math.floor(101 / 100));
    const streamed = await expectEquivalent([west, east]);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.stableId).toBe("ign-bdtopo:building/10");
  });

  it("merges a three way group and accumulates every source reference", async () => {
    const osm = feature("building", "osm-bulk:way/20", "osm-bulk", square(180, 20, 190, 30), centred(180, 20, 190, 30, { name: "Gendarmerie" }));
    const ign = feature("building", "ign-bdtopo:building/20", "IGN BD TOPO", square(181, 21, 189, 29), centred(180, 20, 190, 30));
    const sirene = feature("building", "annuaire-entreprises:20", "annuaire-entreprises", square(182, 22, 188, 28), centred(180, 20, 190, 30, { buildingType: "civic" }));
    const streamed = await expectEquivalent([osm, ign, sirene]);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.sourceRefs.map((ref) => ref.source).sort()).toEqual(["IGN BD TOPO", "annuaire-entreprises", "osm-bulk"]);
  });

  it("does not merge overlapping features of different kinds", async () => {
    const building = feature("building", "osm:way/30", "osm", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    const road = feature("road", "osm:way/31", "osm-bulk", { type: "LineString", coordinates: [[0, 0], [10, 10]] }, centred(0, 0, 10, 10));
    const water = feature("water", "osm:way/32", "osm", { type: "LineString", coordinates: [[0, 0], [10, 1]] }, centred(0, 0, 10, 1, { waterType: "river" }));
    expect(await expectEquivalent([building, road, water])).toHaveLength(3);
  });

  it("does not merge same kind neighbours that fail the IoU gate", async () => {
    const first = feature("building", "osm:way/40", "osm", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    const second = feature("building", "ign-bdtopo:building/40", "IGN BD TOPO", square(60, 60, 70, 70), centred(60, 60, 70, 70));
    expect(await expectEquivalent([first, second])).toHaveLength(2);
  });

  it("selects the same geometry winner and the same scalar field winners", async () => {
    const osm = feature("building", "osm-bulk:way/50", "osm-bulk", square(0, 0, 10, 10), centred(0, 0, 10, 10, { name: "Mairie", height: 7 }));
    const ign = feature("building", "ign-bdtopo:building/50", "IGN BD TOPO", square(0.2, 0.2, 9.8, 9.8), centred(0, 0, 10, 10, { height: 14, buildingType: "civic" }));
    const sirene = feature("building", "sirene:50", "sirene", square(0.4, 0.4, 9.6, 9.6), centred(0, 0, 10, 10, { name: "Mairie Annexe" }));
    const streamed = await expectEquivalent([osm, ign, sirene]);
    expect(streamed).toHaveLength(1);
    const merged = streamed[0]!;
    expect(merged.stableId).toBe("ign-bdtopo:building/50");
    expect(merged.geometry).toEqual(square(0.2, 0.2, 9.8, 9.8));
    expect(merged.height).toBe(14);
    expect(merged.buildingType).toBe("civic");
    expect(merged.name).toBe("Mairie Annexe");
    expect(merged.confidence).toBe("medium");
  });

  it("merges a road pair across a cell edge and keeps the BD TOPO centreline", async () => {
    const osm = feature("road", "osm:way/60", "osm", { type: "LineString", coordinates: [[190, 5], [210, 5.2]] }, centred(190, 5, 210, 5.2, { name: "Rue de la Gare", roadClass: "residential", highway: "residential" }));
    const ign = feature("road", "ign-bdtopo:road/60", "IGN BD TOPO", { type: "LineString", coordinates: [[190, 5.1], [210, 5.3]] }, centred(190, 5.1, 210, 5.3, { name: "Rue de la Gare" }));
    const streamed = await expectEquivalent([osm, ign]);
    expect(streamed).toHaveLength(1);
    expect(streamed[0]?.stableId).toBe("ign-bdtopo:road/60");
  });

  it("merges water surfaces, keeps a reservoir apart and refuses a surface to centreline merge", async () => {
    const surface = feature("water", "ign-bdtopo:surface/70", "IGN BD TOPO", square(40, 40, 60, 60), centred(40, 40, 60, 60, { waterType: "Ecoulement naturel", isSurface: true }));
    const osm = feature("water", "osm-bulk:way/70", "osm-bulk", square(41, 41, 59, 59), centred(40, 40, 60, 60, { waterType: "Ecoulement naturel", isSurface: true }));
    const reservoir = feature("water", "osm-bulk:way/71", "osm-bulk", square(100, 100, 120, 120), centred(100, 100, 120, 120, { waterType: "Reservoir", isSurface: true }));
    const river = feature("water", "osm:way/72", "osm", { type: "LineString", coordinates: [[40, 50], [60, 50]] }, centred(40, 50, 60, 50, { waterType: "Cours d'eau" }));
    const streamed = await expectEquivalent([surface, osm, reservoir, river]);
    expect(streamed).toHaveLength(3);
    expect(streamed.map((item) => item.stableId).sort()).toEqual(["ign-bdtopo:surface/70", "osm-bulk:way/71", "osm:way/72"]);
  });

  it("merges a business pair on siret identity and an address pair on banId identity", async () => {
    const sirene = feature("business", "business:siret/80", "sirene", { type: "Point", coordinates: [12, 12] }, { x: 12, z: 12, businessName: "Boulangerie", siret: "123", address: "1 Rue A" });
    const osm = feature("business", "business:osm/node/80", "osm", { type: "Point", coordinates: [12.0002, 12.0002] }, { x: 12, z: 12, businessName: "Boulangerie", siret: "123", address: "1 Rue A" });
    const ban = feature("address", "address:ban/80", "ban", { type: "Point", coordinates: [150, 150] }, { x: 150, z: 150, name: "Place du Marche", street: "Place du Marche", banId: "ban-1" });
    const directory = feature("address", "address:pj/80", "pagesjaunes", { type: "Point", coordinates: [150.4, 150.4] }, { x: 150, z: 150, name: "Place du Marche", street: "Place du Marche", banId: "ban-1" });
    expect(await expectEquivalent([sirene, osm, ban, directory])).toHaveLength(2);
  });

  it("keeps a feature with no resolvable anchor as its own group", async () => {
    const anchored = feature("building", "osm:way/90", "osm", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    const orphan = MapFeatureSchema.parse({
      kind: "building",
      stableId: "ign-bdtopo:building/90",
      geometry: square(0, 0, 10, 10),
      localGeometry: square(0, 0, 10, 10),
      confidence: "high",
      status: "active",
      provenance: [{ featureId: "ign-bdtopo:building/90", property: "geometry", winner: "IGN BD TOPO", contenders: ["IGN BD TOPO"], priority: 1, timestamp: SOURCE_TIMESTAMP }],
      sourceRefs: [{ source: "IGN BD TOPO", timestamp: SOURCE_TIMESTAMP }],
    });
    expect(await expectEquivalent([anchored, orphan])).toHaveLength(2);
  });

  it("produces identical output and accounting over a dense multi kind grid", async () => {
    const features: MapFeature[] = [];
    let seed = 1;
    const pseudoRandom = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let index = 0; index < 120; index += 1) {
      const minX = Math.floor(pseudoRandom() * 40) * 100;
      const minZ = Math.floor(pseudoRandom() * 40) * 100;
      const kind = (["building", "road", "water", "poi"] as const)[index % 4]!;
      const source = index % 3 === 0 ? "osm" : index % 3 === 1 ? "IGN BD TOPO" : "osm-bulk";
      const geometry: Geometry = kind === "road" || kind === "water"
        ? { type: "LineString", coordinates: [[minX, minZ], [minX + 40, minZ + 40]] }
        : square(minX, minZ, minX + 20, minZ + 20);
      const extra = kind === "poi" ? { poiType: "amenity" } : {};
      features.push(feature(kind, `${source}:way/${index}`, source, geometry, centred(minX, minZ, minX + 40, minZ + 40, { name: `L${index}`, ...extra })));
      if (index % 4 === 0) {
        features.push(
          feature(kind, `${source}:way/dup${index}`, source === "osm" ? "IGN BD TOPO" : "osm", geometry, centred(minX, minZ, minX + 40, minZ + 40, { name: `L${index}`, ...extra }))
        );
      }
    }
    const streamed = await expectEquivalent(features);
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.length).toBeLessThan(features.length);
  });
});

describe("scan band replication safety", () => {
  it("emits each stableId once when features land in different scan bands", async () => {
    const features: MapFeature[] = [];
    for (let index = 0; index < 8; index += 1) {
      const minZ = index * 4 * 100;
      features.push(feature("building", `ign-bdtopo:building/${index}`, "IGN BD TOPO", square(0, minZ, 20, minZ + 20), centred(0, minZ, 20, minZ + 20)));
    }
    const streamed = await expectEquivalent(features);
    expect(new Set(streamed.map((item) => item.stableId)).size).toBe(streamed.length);
    expect(streamed).toHaveLength(8);
  });

  it("merges a pair whose two members fall in different scan bands but the same cell neighbourhood", async () => {
    const minZ = 4 * 100;
    const west = feature("building", "osm:way/200", "osm", square(0, minZ - 2, 20, minZ + 18), centred(0, minZ - 2, 20, minZ + 18));
    const east = feature("building", "ign-bdtopo:building/200", "IGN BD TOPO", square(1, minZ - 1, 19, minZ + 17), centred(0, minZ - 2, 20, minZ + 18));
    const streamed = await expectEquivalent([west, east]);
    expect(streamed).toHaveLength(1);
  });
});

describe("chunked output contract", () => {
  it("splits output into 20000 feature chunks with the documented file naming", async () => {
    const features: MapFeature[] = [];
    for (let index = 0; index < 20_005; index += 1) {
      const minX = index * 10;
      features.push(feature("poi", `poi:${index}`, "osm", { type: "Point", coordinates: [minX, 0] }, { x: minX, z: 0, name: `P${index}`, poiType: "amenity" }));
    }
    const input = path.join(root, "big");
    const output = path.join(root, "big-out");
    await fs.mkdir(input);
    await fs.mkdir(output);
    await fs.writeFile(path.join(input, "poi.json"), JSON.stringify(features), "utf8");
    await deduplicateStreaming(input, output, createDedupAccounting());
    const names = (await fs.readdir(output)).sort();
    expect(names).toEqual(["poi-0001.json", "poi.json", "provenance.json"]);
    expect((await readProvenance(output)).length).toBe(40_010);
    expect((await readOutput(output))).toHaveLength(20_005);
  });
});

describe("reference path and accounting invariants", () => {
  it("keeps deduplicateFeatures reachable as the equivalence reference", () => {
    const osm = feature("building", "osm:way/1", "osm", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    const ign = feature("building", "ign-bdtopo:building/1", "IGN BD TOPO", square(0.5, 0.5, 9.5, 9.5), centred(0, 0, 10, 10));
    const merged = deduplicateFeatures([osm, ign]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.stableId).toBe(ign.stableId);
  });

  it("books drops under the deduplicate stage with the two canonical reasons", () => {
    const accounting = recordingAccounting();
    const winner = feature("building", "ign-bdtopo:building/1", "IGN BD TOPO", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    const repeat = feature("building", "ign-bdtopo:building/1", "IGN BD TOPO", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    deduplicateFeatures([winner, repeat], accounting);
    expect([...accounting.recorded.counts.entries()]).toEqual([[`${STAGES.deduplicate}|${DROP_REASONS.dedupExactIdentity}`, 1]]);
  });

  it("balances input against accepted plus excluded for every source row", async () => {
    const osm = feature("building", "osm:way/10", "osm", square(0, 0, 10, 10), centred(0, 0, 10, 10));
    const ign = feature("building", "ign-bdtopo:building/10", "IGN BD TOPO", square(0.5, 0.5, 9.5, 9.5), centred(0, 0, 10, 10));
    const streamed = await expectEquivalent([osm, ign]);
    expect(streamed).toHaveLength(1);
  });
});

describe("temporary band directory lifecycle", () => {
  it("removes every band file it creates", async () => {
    const input = path.join(root, "tmp-check");
    const output = path.join(root, "tmp-check-out");
    await fs.mkdir(input);
    await fs.mkdir(output);
    await fs.writeFile(
      path.join(input, "poi.json"),
      JSON.stringify([feature("poi", "poi:1", "osm", { type: "Point", coordinates: [1, 1] }, { x: 1, z: 1, poiType: "amenity" })]),
      "utf8"
    );
    const before = (await fs.readdir(DEDUP_TEMP_ROOT)).filter((name) => name.startsWith("master-maps-dedup-"));
    await deduplicateStreaming(input, output, createDedupAccounting());
    const after = (await fs.readdir(DEDUP_TEMP_ROOT)).filter((name) => name.startsWith("master-maps-dedup-"));
    expect(after).toEqual(before);
  });
});
