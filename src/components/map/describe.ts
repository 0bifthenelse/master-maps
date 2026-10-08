import type { ReactNode } from "react";
import { categoryDefinition } from "@/lib/data/categories";
import { DAYS, DAY_LABELS, formatDay, openState, parseOpeningHours } from "@/lib/data/openingHours";
import type { FeatureMeta } from "@/lib/render/codec";
import { renderToLambert, renderToWgs84 } from "@/lib/geo/crs";
import type { DossierData, DossierSection } from "./hud/Dossier";

/** Machine classification codes shown on result rows and the dossier. */
export function classify(kind: string, category: string | undefined): { code: string; tone: DossierData["tone"] } {
  const definition = categoryDefinition(category);
  switch (kind) {
    case "place":
      return category === "commune" ? { code: "COMMUNE", tone: "white" } : { code: "LOCALITY", tone: "ghost" };
    case "road":
      return { code: "STREET", tone: "ghost" };
    case "address":
      return { code: "ADDRESS", tone: "ghost" };
    case "building":
      return { code: "STRUCTURE", tone: "ghost" };
    case "water":
      return { code: "WATER", tone: "ghost" };
    case "transport":
      return { code: "TRANSIT", tone: "ghost" };
    case "boundary":
      return { code: "TERRITORY", tone: "yellow" };
    case "business":
      return definition.group === "emergency" ? { code: "EMERGENCY", tone: "red" } : { code: "ASSET", tone: "white" };
    case "poi":
    case "landuse":
      if (definition.group === "emergency") return { code: "EMERGENCY", tone: "red" };
      if (definition.group === "landmark" || definition.group === "culture" || definition.group === "religion") return { code: "LANDMARK", tone: "yellow" };
      if (definition.id === "other") return { code: kind === "landuse" ? "ZONE" : "POINT", tone: "ghost" };
      return { code: "PLACE", tone: "white" };
    default:
      return { code: kind.toUpperCase().slice(0, 9), tone: "ghost" };
  }
}

const ROAD_CLASS_LABEL: Readonly<Record<string, string>> = {
  motorway: "Motorway",
  trunk: "National road",
  primary: "Major departmental road",
  secondary: "Departmental road",
  tertiary: "Local connector road",
  residential: "Residential street",
  unclassified: "Local road",
  service: "Service road",
  track: "Track",
  path: "Footpath",
  cycleway: "Cycleway",
  steps: "Steps",
  pedestrian: "Pedestrian street",
  ferry: "Ferry",
};

export function categoryLabel(meta: Pick<FeatureMeta, "k" | "c">): string {
  switch (meta.k) {
    case "road":
      return ROAD_CLASS_LABEL[meta.c] ?? "Road";
    case "place":
      return meta.c === "commune" ? "Commune" : meta.c === "hamlet" ? "Hamlet" : meta.c === "locality" ? "Locality" : meta.c.replace(/_/g, " ");
    case "address":
      return "Address";
    case "building":
      return meta.c === "building" ? "Building" : `Building · ${meta.c}`;
    case "water":
      return meta.c === "river" ? "River" : meta.c === "stream" ? "Stream" : meta.c === "canal" ? "Canal" : "Water";
    case "transport":
      return meta.c.replace(/_/g, " ");
    case "boundary":
      return "Department of the Gers";
    default: {
      const definition = categoryDefinition(meta.c);
      if (definition.id !== "other") return definition.label;
      if (meta.c === "other" || meta.c === meta.k) return meta.k === "business" ? "Business" : "Place";
      return meta.c.replace(/_/g, " ");
    }
  }
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function formatPhone(value: string): string {
  const digits = value.replace(/[^\d+]/g, "");
  if (/^\+33\d{9}$/.test(digits)) return `+33 ${digits.slice(3, 4)} ${digits.slice(4).replace(/(\d{2})(?=\d)/g, "$1 ")}`;
  if (/^0\d{9}$/.test(digits)) return digits.replace(/(\d{2})(?=\d)/g, "$1 ");
  return value;
}

function website(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}/i.test(value)) return `https://${value}`;
  return undefined;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  "ign-bdtopo": "IGN BD TOPO",
  ban: "Base Adresse Nationale",
  sirene: "INSEE SIRENE",
  osm: "OpenStreetMap",
  "osm-bulk": "OpenStreetMap",
  "admin-express": "IGN Admin Express",
};

/**
 * Turn a feature (render meta plus, when loaded, its full canonical record)
 * into the dossier sheet. Every field shown comes from a source record.
 */
export function buildDossier(meta: FeatureMeta, record: Record<string, unknown> | null, now: Date): DossierData {
  const kind = meta.k;
  const { code, tone } = classify(kind, meta.c);
  const get = (key: string): unknown => record?.[key];
  const sourceMetadata = (record?.sourceMetadata ?? {}) as Record<string, unknown>;
  const name = text(get("businessName")) ?? text(get("name")) ?? meta.n;
  const address = text(get("address"));
  const label = categoryLabel(meta);
  const title = kind === "address" ? (meta.n ?? address ?? "Address") : name ?? (meta.r !== undefined ? meta.r : label);
  const city = text(get("city")) ?? text((meta.p ?? {}).city);
  const subtitleParts = [kind === "address" ? undefined : label, kind === "road" && meta.r !== undefined && name !== undefined ? meta.r : undefined, city].filter((part): part is string => part !== undefined);
  const [lon, lat] = renderToWgs84(meta.a);
  const [lx, ly] = renderToLambert(meta.a);
  const sections: DossierSection[] = [];

  const identity: DossierSection = { title: "Identity", fields: [] };
  const push = (section: DossierSection, label: string, value: ReactNode | undefined): void => {
    if (value === undefined || value === null || value === "") return;
    section.fields.push({ label, value });
  };
  push(identity, "Type", label);
  push(identity, "Brand", text(get("brand")));
  push(identity, "Legal name", text(get("legalName")) !== name ? text(get("legalName")) : undefined);
  push(identity, "SIRET", text(get("siret")));
  push(identity, "Activity", text(get("nafCode")) === undefined ? undefined : `${text(get("nafCode"))}${text(get("nafLabel")) !== undefined ? ` · ${text(get("nafLabel"))}` : ""}`);
  push(identity, "Since", text(get("creationDate")));
  push(identity, "Operator", text(get("operator")));
  push(identity, "Cuisine", text(sourceMetadata.cuisine)?.replace(/_/g, " ").replace(/;/g, ", "));
  push(identity, "Population", kind === "place" && typeof meta.p?.pop === "number" ? (meta.p.pop as number).toLocaleString("en-GB") : undefined);
  push(identity, "INSEE code", text(sourceMetadata.communeCode));
  if (identity.fields.length > 0) sections.push(identity);

  const location: DossierSection = { title: "Location", fields: [] };
  if (kind === "address") {
    push(location, "Number", text(get("housenumber")) ?? text(meta.p?.hn));
    push(location, "Street", text(get("street")) ?? text(meta.p?.st));
    push(location, "Postcode", text(get("postcode")) ?? text(meta.p?.pc));
    push(location, "Commune", city);
  } else {
    push(location, "Address", address);
    push(location, "Postcode", text(sourceMetadata.postcode));
  }
  push(location, "WGS84", `${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  push(location, "Lambert-93", `${Math.round(lx)} E · ${Math.round(ly)} N`);
  sections.push(location);

  const contact: DossierSection = { title: "Contact", fields: [] };
  const phone = text(get("phone"));
  const site = website(text(get("website")));
  push(contact, "Phone", phone === undefined ? undefined : formatPhone(phone));
  push(contact, "Website", site === undefined ? undefined : site.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""));
  push(contact, "Email", text(sourceMetadata.email));
  push(contact, "Wheelchair", text(get("wheelchair")));
  if (contact.fields.length > 0) sections.push(contact);

  const attributes: DossierSection = { title: "Attributes", fields: [] };
  if (kind === "building") {
    push(attributes, "Height", meta.h === undefined ? undefined : `${meta.h.toFixed(1)} m`);
    push(attributes, "Floors", text(get("levels")));
    push(attributes, "Use", text(sourceMetadata.usage1));
    push(attributes, "Nature", text(sourceMetadata.nature));
  }
  if (kind === "road") {
    push(attributes, "Road number", meta.r);
    push(attributes, "Class", label);
    push(attributes, "Width", meta.w === undefined ? undefined : `${meta.w.toFixed(1)} m`);
    push(attributes, "Lanes", text(get("lanes")));
    push(attributes, "One way", get("oneway") === true ? "Yes" : get("oneway") === false ? "No" : undefined);
    push(attributes, "Surface", text(get("surface")));
    push(attributes, "Speed limit", text(get("maxSpeed")) === undefined ? undefined : `${text(get("maxSpeed"))} km/h`);
    push(attributes, "Bridge", get("bridge") === true ? "Yes" : undefined);
    push(attributes, "Tunnel", get("tunnel") === true ? "Yes" : undefined);
    push(attributes, "Managed by", text(sourceMetadata.manager));
  }
  if (kind === "water") {
    push(attributes, "Width", meta.w === undefined ? undefined : `${meta.w.toFixed(1)} m`);
    push(attributes, "Type", text(get("waterType")));
    push(attributes, "Intermittent", get("intermittent") === true ? "Yes" : undefined);
  }
  if (kind === "landuse") {
    push(attributes, "Land use", text(get("landuseType"))?.replace(/_/g, " "));
    push(attributes, "Area", typeof get("area") === "number" ? `${Math.round(get("area") as number).toLocaleString("en-GB")} m²` : undefined);
  }
  if (attributes.fields.length > 0) sections.push(attributes);

  const refs = Array.isArray(get("sourceRefs")) ? (get("sourceRefs") as Array<{ source?: string; license?: string }>) : [];
  const sources = [...new Set(refs.map((reference) => SOURCE_LABELS[reference.source ?? ""] ?? reference.source ?? "").filter((value) => value !== ""))];

  const hoursRaw = text(get("openingHours"));
  const week = parseOpeningHours(hoursRaw);
  let hours: DossierData["hours"] = null;
  let open: DossierData["open"] = null;
  if (week !== null) {
    const today = (now.getDay() + 6) % 7;
    hours = DAYS.map((day, index) => ({ day: DAY_LABELS[day], text: formatDay(week[index]!), today: index === today }));
    open = openState(week, now);
  } else if (hoursRaw !== undefined) {
    const contactSection = sections.find((section) => section.title === "Contact");
    if (contactSection !== undefined) contactSection.fields.push({ label: "Hours", value: hoursRaw });
    else sections.push({ title: "Contact", fields: [{ label: "Hours", value: hoursRaw }] });
  }

  const osmId = text(sourceMetadata.sourceObjectUrl) ?? (typeof sourceMetadata.osm === "object" && sourceMetadata.osm !== null ? text((sourceMetadata.osm as Record<string, unknown>).sourceObjectUrl) : undefined);
  return {
    key: meta.s,
    code,
    tone,
    title,
    subtitle: subtitleParts.join(" · "),
    open,
    sections,
    hours,
    phone: phone === undefined ? undefined : formatPhone(phone),
    website: site,
    osmUrl: osmId ?? `https://www.openstreetmap.org/#map=18/${lat.toFixed(5)}/${lon.toFixed(5)}`,
    sources,
  };
}
