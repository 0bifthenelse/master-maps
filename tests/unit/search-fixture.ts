import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRecord } from "@/lib/data/schema";

const FIXTURE_RECORDS: SearchRecord[] = [
  {
    featureId: "cathedrale-sainte-marie",
    canonicalName: "Cathédrale Sainte-Marie",
    normalizedName: "cathedrale sainte-marie",
    aliases: ["Sainte-Marie"],
    kind: "building",
    category: "monument",
    tileId: "2048-3168-2208",
    focusLon: 0.5905,
    focusLat: 43.6475,
    boost: 5,
  },
  {
    featureId: "boulevard-sadi-carnot",
    canonicalName: "Boulevard Sadi Carnot",
    normalizedName: "boulevard sadi carnot",
    aliases: ["Sadi Carnot"],
    kind: "road",
    tileId: "2048-3160-2210",
    focusLon: 0.5872,
    focusLat: 43.6456,
    boost: 0,
  },
  {
    featureId: "rue-pasteur",
    canonicalName: "Rue Pasteur",
    normalizedName: "rue pasteur",
    aliases: [],
    kind: "road",
    tileId: "2048-3164-2212",
    focusLon: 0.5894,
    focusLat: 43.6461,
    boost: 0,
  },
  {
    featureId: "nocibe-32013",
    canonicalName: "NOCIBE",
    normalizedName: "nocibe",
    aliases: [],
    kind: "business",
    category: "beauty",
    tileId: "2048-3164-2210",
    focusLon: 0.5881,
    focusLat: 43.6459,
    boost: 10,
  },
  {
    featureId: "rue-nationale",
    canonicalName: "Rue Nationale",
    normalizedName: "rue nationale",
    aliases: [],
    kind: "road",
    tileId: "2048-3164-2209",
    focusLon: 0.5902,
    focusLat: 43.6466,
    boost: 0,
  },
  {
    featureId: "rue-d-alsace",
    canonicalName: "Rue d'Alsace",
    normalizedName: "rue d'alsace",
    aliases: ["Alsace"],
    kind: "road",
    tileId: "2048-3162-2211",
    focusLon: 0.5911,
    focusLat: 43.6470,
    boost: 0,
  },
  {
    featureId: "avenue-de-l-yser",
    canonicalName: "Avenue de l'Yser",
    normalizedName: "avenue de l'yser",
    aliases: [],
    kind: "road",
    tileId: "2048-3166-2207",
    focusLon: 0.5869,
    focusLat: 43.6487,
    boost: 0,
  },
  {
    featureId: "place-de-la-liberation",
    canonicalName: "Place de la Libération",
    normalizedName: "place de la liberation",
    aliases: [],
    kind: "road",
    tileId: "2048-3165-2209",
    focusLon: 0.5908,
    focusLat: 43.6469,
    boost: 0,
  },
  {
    featureId: "le-gers",
    canonicalName: "Le Gers",
    normalizedName: "le gers",
    aliases: [],
    kind: "water",
    tileId: "2048-3163-2213",
    focusLon: 0.5898,
    focusLat: 43.6441,
    boost: 0,
  },
  {
    featureId: "mairie-auch",
    canonicalName: "Mairie d'Auch",
    normalizedName: "mairie d'auch",
    aliases: ["Hôtel de ville"],
    kind: "address",
    tileId: "2048-3165-2210",
    focusLon: 0.5900,
    focusLat: 43.6471,
    boost: 0,
  },
  {
    featureId: "cinema-le-refectoire",
    canonicalName: "Cinéma Le Réfectoire",
    normalizedName: "cinema le refectoire",
    aliases: [],
    kind: "poi",
    tileId: "2048-3166-2211",
    focusLon: 0.5877,
    focusLat: 43.6452,
    boost: 0,
  },
  {
    featureId: "tour-armagnac",
    canonicalName: "Tour d'Armagnac",
    normalizedName: "tour d'armagnac",
    aliases: ["Prison de l'Évêché"],
    kind: "building",
    tileId: "2048-3167-2209",
    focusLon: 0.5916,
    focusLat: 43.6478,
    boost: 0,
  },
];

export async function writeSearchFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "master-maps-search-"));
  await mkdir(join(root, "search"), { recursive: true });
  await writeFile(join(root, "search", "index.json"), JSON.stringify(FIXTURE_RECORDS), "utf8");
  return root;
}

export async function removeSearchFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
