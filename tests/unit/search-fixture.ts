import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchRecord } from "@/lib/data/schema";
import { normalizeSearchText } from "@/lib/data/search";

/** Local metres; Auch sits near the render origin, Condom ~40 km north-west. */
export const AUCH: [number, number] = [0, -5000];
export const CONDOM: [number, number] = [-30000, 30000];

type Draft = Omit<SearchRecord, "normalizedName" | "aliases" | "focusLon" | "focusLat" | "tileId" | "boost"> & Partial<Pick<SearchRecord, "aliases" | "tileId" | "boost">>;

function record(draft: Draft): SearchRecord {
  return {
    aliases: [],
    tileId: "l0_0_0",
    boost: 0,
    ...draft,
    normalizedName: normalizeSearchText(draft.canonicalName),
    focusLon: 0.586 + (draft.x ?? 0) / 80_000,
    focusLat: 43.695 + (draft.z ?? 0) / 111_000,
  };
}

const at = (base: [number, number], dx: number, dz: number): { x: number; z: number } => ({ x: base[0] + dx, z: base[1] + dz });

export const FIXTURE_RECORDS: SearchRecord[] = [
  record({ featureId: "commune-auch", canonicalName: "Auch", kind: "place", category: "commune", boost: 302, context: "Commune · 32000 · 21,935 inhabitants", commune: "Auch", postcode: "32000", ...at(AUCH, 0, 0), bbox: [-6000, -11000, 6000, 1000] }),
  record({ featureId: "commune-condom", canonicalName: "Condom", kind: "place", category: "commune", boost: 287, context: "Commune · 32100 · 6,698 inhabitants", commune: "Condom", postcode: "32100", ...at(CONDOM, 0, 0) }),
  record({ featureId: "commune-bars", canonicalName: "Bars", kind: "place", category: "commune", boost: 230, context: "Commune · 32300", commune: "Bars", ...at(AUCH, 15000, -20000) }),
  record({ featureId: "commune-saint-clar", canonicalName: "Saint-Clar", kind: "place", category: "commune", boost: 260, context: "Commune · 32380", commune: "Saint-Clar", ...at(AUCH, 20000, 30000) }),
  record({ featureId: "hamlet-lasserre", canonicalName: "Lasserre", kind: "place", category: "hamlet", boost: 66, context: "Hamlet · Auch", commune: "Auch", ...at(AUCH, -3000, 2000) }),
  record({ featureId: "street-gambetta-auch", canonicalName: "Rue Gambetta", kind: "road", category: "residential", boost: 51, context: "Auch", commune: "Auch", postcode: "32000", ...at(AUCH, 100, 50), bbox: [0, -5000, 250, -4900] }),
  record({ featureId: "street-gambetta-condom", canonicalName: "Rue Gambetta", kind: "road", category: "residential", boost: 51, context: "Condom", commune: "Condom", postcode: "32100", ...at(CONDOM, 10, 20) }),
  record({ featureId: "street-marne", canonicalName: "Avenue de la Marne", kind: "road", category: "trunk", boost: 95, context: "Auch", commune: "Auch", ref: "N124", ...at(AUCH, 900, 100) }),
  record({ featureId: "route-n124", canonicalName: "N124", kind: "road", category: "trunk", boost: 255, context: "84 km · 22 communes", ref: "N124", aliases: ["Avenue de la Marne"], ...at(AUCH, 1000, 200), bbox: [-40000, -20000, 40000, 10000] }),
  record({ featureId: "address-12", canonicalName: "12 Rue Gambetta", kind: "address", boost: 20, context: "32000 Auch", commune: "Auch", postcode: "32000", street: "Rue Gambetta", housenumber: "12", ...at(AUCH, 110, 55) }),
  record({ featureId: "address-12-bis", canonicalName: "12 bis Rue Gambetta", kind: "address", boost: 20, context: "32000 Auch", commune: "Auch", postcode: "32000", street: "Rue Gambetta", housenumber: "12 bis", ...at(AUCH, 112, 56) }),
  record({ featureId: "address-14", canonicalName: "14 Rue Gambetta", kind: "address", boost: 20, context: "32000 Auch", commune: "Auch", postcode: "32000", street: "Rue Gambetta", housenumber: "14", ...at(AUCH, 118, 58) }),
  record({ featureId: "pharmacie-centre", canonicalName: "Pharmacie du Centre", kind: "business", category: "pharmacy", boost: 80, context: "5 Rue Gambetta, Auch", commune: "Auch", street: "Rue Gambetta", ...at(AUCH, 200, 30) }),
  record({ featureId: "pharmacie-gare-condom", canonicalName: "Pharmacie de la Gare", kind: "business", category: "pharmacy", boost: 74, context: "Condom", commune: "Condom", ...at(CONDOM, 100, -50) }),
  record({ featureId: "leclerc-auch", canonicalName: "E.Leclerc", kind: "business", category: "supermarket", brand: "E.Leclerc", boost: 90, context: "Route de Toulouse, Auch", commune: "Auch", ...at(AUCH, 3000, -1500) }),
  record({ featureId: "carrefour-condom", canonicalName: "Carrefour Market", kind: "business", category: "supermarket", brand: "Carrefour Market", boost: 90, context: "Condom", commune: "Condom", ...at(CONDOM, -500, 500) }),
  record({ featureId: "intermarche-auch", canonicalName: "Intermarché", kind: "business", category: "supermarket", boost: 90, context: "Auch", commune: "Auch", ...at(AUCH, -2000, 1000) }),
  record({ featureId: "lidl-auch", canonicalName: "Lidl", kind: "business", category: "supermarket", boost: 90, context: "Auch", commune: "Auch", ...at(AUCH, 2500, -2500) }),
  record({ featureId: "super-u-condom", canonicalName: "Super U", kind: "business", category: "supermarket", boost: 90, context: "Condom", commune: "Condom", ...at(CONDOM, 800, -300) }),
  record({ featureId: "boulangerie-dupont", canonicalName: "Boulangerie Dupont", kind: "business", category: "bakery", boost: 66, context: "Rue Dessoles, Auch", commune: "Auch", street: "Rue Dessoles", ...at(AUCH, 150, 150) }),
  record({ featureId: "nocibe-auch", canonicalName: "Nocibé", kind: "business", category: "beauty", boost: 70, context: "Auch", commune: "Auch", ...at(AUCH, 160, 40) }),
  record({ featureId: "cathedrale-sainte-marie", canonicalName: "Cathédrale Sainte-Marie", kind: "poi", category: "place_of_worship", boost: 100, context: "Auch", commune: "Auch", ...at(AUCH, 50, 120) }),
  record({ featureId: "tour-armagnac", canonicalName: "Tour d'Armagnac", kind: "poi", category: "attraction", boost: 100, aliases: ["Prison de l'Évêché"], context: "Auch", commune: "Auch", ...at(AUCH, 60, 140) }),
  record({ featureId: "gare-auch", canonicalName: "Gare d'Auch", kind: "transport", category: "train_station", boost: 110, context: "Auch", commune: "Auch", ...at(AUCH, 1300, 400) }),
  record({ featureId: "hamlet-la-gare", canonicalName: "La Gare", kind: "place", category: "hamlet", boost: 66, context: "Hamlet · Condom", commune: "Condom", ...at(CONDOM, 2000, 1000) }),
  record({ featureId: "bus-hopital", canonicalName: "Hôpital", kind: "transport", category: "bus_stop", boost: 25, context: "Auch", commune: "Auch", ...at(AUCH, 600, -800) }),
  record({ featureId: "ch-auch", canonicalName: "Centre Hospitalier d'Auch", kind: "poi", category: "hospital", boost: 115, context: "Auch", commune: "Auch", ...at(AUCH, 650, -820) }),
  record({ featureId: "chateau-lavardens", canonicalName: "Château de Lavardens", kind: "poi", category: "castle", boost: 100, context: "Lavardens", commune: "Lavardens", ...at(AUCH, -9000, 12000) }),
  record({ featureId: "domaine-armagnac", canonicalName: "Domaine d'Armagnac", kind: "business", category: "winery", boost: 80, context: "Eauze", commune: "Eauze", ...at(CONDOM, -20000, -10000) }),
  record({ featureId: "bar-n124", canonicalName: "N 124", kind: "business", category: "restaurant", boost: 160, context: "Village, Bascous", commune: "Bascous", ...at(CONDOM, -15000, -15000) }),
  record({ featureId: "route-d1021", canonicalName: "D1021", kind: "road", category: "primary", boost: 200, context: "Former N21 · 60 km · 12 communes", ref: "D1021;N21", aliases: ["N21"], ...at(AUCH, 0, 9000), bbox: [-10000, -40000, 10000, 40000] }),
  record({ featureId: "bus-cinema", canonicalName: "Cinéma", kind: "transport", category: "bus_stop", boost: 25, context: "Auch", commune: "Auch", ...at(AUCH, 400, 300) }),
  record({ featureId: "cine-32", canonicalName: "Ciné 32", kind: "poi", category: "cinema", boost: 90, context: "Auch", commune: "Auch", ...at(AUCH, 420, 330) }),
  record({ featureId: "street-n21-lectoure", canonicalName: "N 21 Lectoure", kind: "road", category: "primary", boost: 95, context: "Sainte-Mère", commune: "Sainte-Mère", ref: "D1021;N21", ...at(AUCH, 0, 30000) }),
  record({ featureId: "river-baise", canonicalName: "La Baïse", kind: "water", category: "river", boost: 90, context: "88 km · 30 communes", ...at(CONDOM, 500, 0), bbox: [-35000, -40000, -20000, 40000] }),
];

export async function writeSearchFixture(records: readonly SearchRecord[] = FIXTURE_RECORDS): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "master-maps-search-"));
  await mkdir(join(root, "search"), { recursive: true });
  await writeFile(join(root, "search", "index.json"), JSON.stringify(records), "utf8");
  return root;
}

export async function removeSearchFixture(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
