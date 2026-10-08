#!/usr/bin/env tsx
/**
 * Coverage benchmark of the Gers dataset against the questions people ask a
 * consumer map: every commune, a list of well-known places, roads and
 * rivers, everyday categories in every town, and the address base.
 *
 * Google Maps data is never read or copied: the entity list is only a set of
 * queries, and every answer comes from the open sources in the pipeline.
 *
 * Writes data/qa/benchmark.json and docs/coverage-benchmark.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { categoryDefinition, categoryFamily } from "../../src/lib/data/categories";
import { SearchRecordSchema, type SearchRecord } from "../../src/lib/data/schema";
import { SearchEngine } from "../../src/lib/data/searchEngine";
import { wgs84ToRender } from "../../src/lib/geo/crs";

interface Entity {
  query: string;
  expect?: string;
  category?: string;
  group: string;
  anchor?: [number, number];
}

interface EntityResult extends Entity {
  found: boolean;
  rank: number | null;
  name: string | null;
  kind: string | null;
  context: string | null;
  distanceMetres: number | null;
  positionOk: boolean | null;
}

const ROOT = path.resolve(__dirname, "../..");
const DATA = process.env.MASTER_MAPS_DATA_DIR ?? path.join(ROOT, "data");
const POSITION_TOLERANCE_METRES = 150;
const COMMUNE_TOLERANCE_METRES = 1500;
const TOWN_POPULATION = 2000;

function loadRecords(): SearchRecord[] {
  const raw = JSON.parse(readFileSync(path.join(DATA, "search", "index.json"), "utf8")) as unknown[];
  return raw.map((value) => SearchRecordSchema.parse(value));
}

function distanceToHit(anchor: [number, number], hit: { x?: number; z?: number; bbox?: [number, number, number, number] }): number | null {
  const [x, z] = wgs84ToRender(anchor);
  if (hit.bbox !== undefined && hit.bbox[2] - hit.bbox[0] > 1) {
    const dx = Math.max(0, hit.bbox[0] - x, x - hit.bbox[2]);
    const dz = Math.max(0, hit.bbox[1] - z, z - hit.bbox[3]);
    return Math.hypot(dx, dz);
  }
  if (hit.x === undefined || hit.z === undefined) return null;
  return Math.hypot(hit.x - x, hit.z - z);
}

function population(record: SearchRecord): number {
  const match = /([\d,]+) inhabitants/.exec(record.context ?? "");
  return match === null ? 0 : Number(match[1]!.replace(/,/g, ""));
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)} %`;
}

function main(): void {
  const records = loadRecords();
  const engine = new SearchEngine(records);
  const spec = JSON.parse(readFileSync(path.join(__dirname, "benchmark-entities.json"), "utf8")) as { entities: Entity[]; categories: Array<{ id: string; label: string }> };

  /* 1. Well-known places, roads and rivers. */
  const entities: EntityResult[] = spec.entities.map((entity) => {
    const hits = engine.search(entity.query, { limit: 5 });
    const pattern = entity.expect === undefined ? null : new RegExp(entity.expect, "i");
    const family = entity.category === undefined ? null : new Set(categoryFamily(entity.category));
    const index = hits.slice(0, 3).findIndex((hit) => (pattern !== null && pattern.test(hit.canonicalName)) || (family !== null && hit.category !== undefined && family.has(hit.category)));
    const hit = index >= 0 ? hits[index]! : null;
    const distance = hit !== null && entity.anchor !== undefined ? distanceToHit(entity.anchor, hit) : null;
    const tolerance = entity.group === "commune" ? COMMUNE_TOLERANCE_METRES : POSITION_TOLERANCE_METRES;
    return {
      ...entity,
      found: hit !== null,
      rank: hit === null ? null : index + 1,
      name: hit?.canonicalName ?? hits[0]?.canonicalName ?? null,
      kind: hit?.kind ?? null,
      context: hit?.context ?? null,
      distanceMetres: distance === null ? null : Math.round(distance),
      positionOk: distance === null ? null : distance <= tolerance,
    };
  });

  /* 2. Every commune answers to its own name. */
  const communes = records.filter((record) => record.kind === "place" && record.category === "commune");
  const communeMisses: string[] = [];
  for (const commune of communes) {
    const top = engine.search(commune.canonicalName, { limit: 3 });
    if (!top.some((hit) => hit.featureId === commune.featureId)) communeMisses.push(commune.canonicalName);
  }

  /* 3. Everyday categories in every town of more than 2,000 people. */
  const towns = communes.filter((commune) => population(commune) >= TOWN_POPULATION).sort((first, second) => population(second) - population(first));
  const byCommuneCategory = new Map<string, number>();
  for (const record of records) {
    if (record.commune === undefined || record.category === undefined) continue;
    const key = `${record.commune}|${record.category}`;
    byCommuneCategory.set(key, (byCommuneCategory.get(key) ?? 0) + 1);
  }
  const coverage = towns.map((town) => ({
    commune: town.canonicalName,
    population: population(town),
    counts: Object.fromEntries(spec.categories.map((category) => [category.id, categoryFamily(category.id).reduce((sum, id) => sum + (byCommuneCategory.get(`${town.canonicalName}|${id}`) ?? 0), 0)])),
  }));
  const gaps = coverage.flatMap((town) => spec.categories.filter((category) => town.counts[category.id] === 0).map((category) => `${town.commune}: ${category.label}`));

  /* 4. Address base and businesses. */
  const addressRecords = records.filter((record) => record.kind === "address").length;
  const banPath = path.join(DATA, "raw", "ban-addresses.json");
  const banTotal = existsSync(banPath) ? ((JSON.parse(readFileSync(banPath, "utf8")) as { addresses?: unknown[] }).addresses?.length ?? 0) : 0;
  const businesses = records.filter((record) => record.kind === "business");
  const categorised = businesses.filter((record) => record.category !== undefined && record.category !== "other").length;
  const kinds = Object.fromEntries([...records.reduce((map, record) => map.set(record.kind, (map.get(record.kind) ?? 0) + 1), new Map<string, number>())].sort());

  const found = entities.filter((entity) => entity.found).length;
  const positioned = entities.filter((entity) => entity.positionOk !== null);
  const report = {
    generatedAt: new Date().toISOString(),
    records: records.length,
    kinds,
    entities: { total: entities.length, found, results: entities },
    communes: { total: communes.length, findable: communes.length - communeMisses.length, misses: communeMisses },
    categories: { towns: coverage, gaps },
    addresses: { indexed: addressRecords, ban: banTotal },
    businesses: { total: businesses.length, categorised },
  };
  mkdirSync(path.join(DATA, "qa"), { recursive: true });
  writeFileSync(path.join(DATA, "qa", "benchmark.json"), `${JSON.stringify(report, null, 2)}\n`);

  const lines: string[] = [];
  lines.push("# Gers coverage benchmark", "");
  lines.push("Generated by `npm run qa:benchmark` from the built dataset. The entity list is a checklist of things people commonly look up on a consumer map; Google Maps data is never read or copied, and every answer below comes from IGN BD TOPO, BAN, INSEE SIRENE and OpenStreetMap.", "");
  lines.push("## Summary", "");
  lines.push("| Check | Result |", "| --- | --- |");
  lines.push(`| Search records | ${records.length.toLocaleString("en-GB")} (${Object.entries(kinds).map(([kind, count]) => `${kind} ${count.toLocaleString("en-GB")}`).join(", ")}) |`);
  lines.push(`| Well-known places, roads and rivers found in the top 3 | ${found} / ${entities.length} (${percent(found, entities.length)}) |`);
  lines.push(`| …placed within tolerance of an official/OSM anchor | ${positioned.filter((entity) => entity.positionOk === true).length} / ${positioned.length} |`);
  lines.push(`| Communes found by their own name (top 3) | ${communes.length - communeMisses.length} / ${communes.length} |`);
  lines.push(`| Towns of ${TOWN_POPULATION.toLocaleString("en-GB")}+ people | ${towns.length}, with ${gaps.length} empty category cells out of ${towns.length * spec.categories.length} |`);
  lines.push(`| BAN addresses searchable | ${addressRecords.toLocaleString("en-GB")} / ${banTotal.toLocaleString("en-GB")} (${percent(addressRecords, banTotal)}) |`);
  lines.push(`| Businesses (SIRENE + OSM) | ${businesses.length.toLocaleString("en-GB")}, ${percent(categorised, businesses.length)} with a consumer category |`);
  lines.push("", "## Well-known places", "");
  lines.push("| Query | Found | Rank | Result | Context | Anchor distance |", "| --- | --- | --- | --- | --- | --- |");
  for (const entity of entities) {
    lines.push(`| ${entity.query} | ${entity.found ? "yes" : "**no**"} | ${entity.rank ?? "—"} | ${entity.name ?? "—"} | ${entity.context ?? (entity.category !== undefined ? categoryDefinition(entity.category).label : "—")} | ${entity.distanceMetres === null ? "—" : `${entity.distanceMetres} m${entity.positionOk === false ? " (**off**)" : ""}`} |`);
  }
  lines.push("", `## Everyday categories in towns of ${TOWN_POPULATION.toLocaleString("en-GB")}+ people`, "");
  lines.push(`| Commune | Pop. | ${spec.categories.map((category) => category.label).join(" | ")} |`);
  lines.push(`| --- | --- | ${spec.categories.map(() => "---").join(" | ")} |`);
  for (const town of coverage) {
    lines.push(`| ${town.commune} | ${town.population.toLocaleString("en-GB")} | ${spec.categories.map((category) => (town.counts[category.id] === 0 ? "**0**" : String(town.counts[category.id]))).join(" | ")} |`);
  }
  if (communeMisses.length > 0) {
    lines.push("", "## Communes not found first by name", "", communeMisses.slice(0, 60).join(", "));
  }
  lines.push("");
  writeFileSync(path.join(ROOT, "docs", "coverage-benchmark.md"), lines.join("\n"));
  console.log(`[benchmark] entities ${found}/${entities.length}, communes ${communes.length - communeMisses.length}/${communes.length}, category gaps ${gaps.length}, addresses ${addressRecords}/${banTotal}`);
}

main();
