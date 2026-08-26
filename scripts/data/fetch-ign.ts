/**
 * scripts/data/fetch-ign.ts
 *
 * Discover IGN Géoplateforme WFS elevation layers for Auch (32013).
 * Acquires contour lines (ELEVATION.CONTOUR.LINE) as vector terrain data
 * and records available LiDAR HD tile indices.
 *
 * If contour lines or any practical elevation grid is unavailable,
 * writes an explicit unavailable record to data/intermediate/ign-unavailable.json.
 *
 * Environment: MASTER_MAPS_DATA_DIR (default "data")
 * Runtime: tsx
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Local type definitions (duplicated from src/lib/data/schema.ts until it
// exists — compatible with the expected shared contract)
// ---------------------------------------------------------------------------

interface IgnSourceRecord {
  readonly id: string;
  readonly layerName: string;
  readonly layerTitle: string;
  readonly wfsEndpoint: string;
  readonly parameters: Record<string, string>;
  readonly acquiredAt: string;
  readonly sourceFamily: "ign-geoplateforme";
  readonly license: string;
  readonly responseHash: string;
  readonly featureCount: number;
  readonly crs: string;
  readonly defaultCrs: string;
  readonly status: "success" | "unavailable" | "error";
  readonly error?: string;
}

interface IgnCapabilityRecord {
  readonly wfsEndpoint: string;
  readonly acquiredAt: string;
  readonly version: string;
  readonly layers: Array<{
    readonly name: string;
    readonly title: string;
    readonly abstract: string;
    readonly defaultCrs: string;
    readonly crsOptions: string[];
    readonly wgs84Bbox: [number, number, number, number] | null;
    readonly keywords: string[];
  }>;
  readonly responseHash: string;
}

interface IgnUnavailableRecord {
  readonly reason: string;
  readonly checkedAt: string;
  readonly sourceFamily: "ign-geoplateforme";
  readonly endpoint: string;
  readonly attempts: number;
  readonly errors: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const INTERMEDIATE_DIR = path.join(DATA_DIR, "intermediate");

/** IGN Géoplateforme WFS base endpoint */
const WFS_BASE = "https://data.geopf.fr/wfs/ows";

/** Auch bounding box (WGS84) — west, south, east, north */
const AUCH_BBOX: [number, number, number, number] = [
  0.486087,
  43.617419,
  0.647019,
  43.707701,
];

/** WFS count limit — the server caps at 5000 */
const WFS_COUNT = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchText(url: string, accept: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {Accept: accept},
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
  return resp.text();
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

function utcTimestamp(): string {
  return new Date().toISOString();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, {recursive: true});
}

/** Extract first tag content */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

/** Extract all text of a child tag within each parent block */
function extractAll(xml: string, parent: string, child: string): string[][] {
  const results: string[][] = [];
  const parentRe = new RegExp(`<${parent}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${parent}>`, "g");
  let pm: RegExpExecArray | null;
  while ((pm = parentRe.exec(xml)) !== null) {
    const inner = pm[1];
    const children: string[] = [];
    const childRe = new RegExp(`<${child}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${child}>`, "g");
    let cm: RegExpExecArray | null;
    while ((cm = childRe.exec(inner)) !== null) {
      children.push(cm[1].trim());
    }
    results.push(children);
  }
  return results;
}

/** Parse WGS84BoundingBox into [west,south,east,north] */
function parseBbox(xml: string): [number, number, number, number] | null {
  const m = /<ows:LowerCorner>([\d.\-]+)\s+([\d.\-]+)<\/ows:LowerCorner>\s*<ows:UpperCorner>([\d.\-]+)\s+([\d.\-]+)<\/ows:UpperCorner>/.exec(xml);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
}

// ---------------------------------------------------------------------------
// Phase 1: Discover capabilities
// ---------------------------------------------------------------------------

async function discoverCapabilities(
  endpoint: string,
): Promise<{xml: string; version: string; layers: Array<ReturnType<typeof parseFeatureType>>}> {
  const url = `${endpoint}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetCapabilities`;
  const xml = await fetchText(url, "application/xml, text/xml, text/plain");

  const version = extractTag(xml, "ows:ServiceTypeVersion") ?? "2.0.0";

  function parseFeatureType(block: string) {
    return {
      name: extractTag(block, "Name") ?? "",
      title: extractTag(block, "Title") ?? "",
      abstract: extractTag(block, "Abstract") ?? "",
      defaultCrs: extractTag(block, "DefaultCRS") ?? "",
      crsOptions: extractAll(block, "OtherCRS", "OtherCRS").flat(),
      wgs84Bbox: parseBbox(block),
      keywords: extractAll(block, "ows:Keyword", "ows:Keyword").flat(),
    };
  }

  const blocks: string[] = [];
  const ftRe = /<FeatureType>([\s\S]*?)<\/FeatureType>/g;
  let m: RegExpExecArray | null;
  while ((m = ftRe.exec(xml)) !== null) blocks.push(m[1]);

  const layers = blocks.map(parseFeatureType);

  return {xml, version, layers};
}

// ---------------------------------------------------------------------------
// Phase 2: WFS GetFeature queries
// ---------------------------------------------------------------------------

async function fetchWfsFeatures(
  endpoint: string,
  layerName: string,
  bbox: [number, number, number, number],
): Promise<{raw: string; featureCount: number}> {
  const [w, s, e, n] = bbox;
  const url =
    `${endpoint}` +
    `?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=${encodeURIComponent(layerName)}` +
    `&SRSNAME=urn:ogc:def:crs:EPSG::4326` +
    `&BBOX=${w},${s},${e},${n},urn:ogc:def:crs:EPSG::4326` +
    `&COUNT=${WFS_COUNT}` +
    `&OUTPUTFORMAT=application/json`;

  const raw = await fetchText(url, "application/json, application/geo+json, text/plain");

  let featureCount = 0;
  try {
    const parsed = JSON.parse(raw);
    featureCount = Array.isArray(parsed.features) ? parsed.features.length : 0;
  } catch {
    featureCount = (raw.match(/"type"\s*:\s*"Feature"/g) ?? []).length;
  }

  return {raw, featureCount};
}

// ---------------------------------------------------------------------------
// Phase 3: Store results
// ---------------------------------------------------------------------------

async function storeRaw(
  subdir: string,
  filename: string,
  content: string,
): Promise<string> {
  await ensureDir(subdir);
  const fp = path.join(subdir, filename);
  await fs.writeFile(fp, content, "utf-8");
  return fp;
}

async function storeJson(
  subdir: string,
  filename: string,
  data: unknown,
): Promise<string> {
  await ensureDir(subdir);
  const fp = path.join(subdir, filename);
  await fs.writeFile(fp, JSON.stringify(data, null, 2), "utf-8");
  return fp;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main() {
  // ---- Phase 1: Capabilities -------------------------------------------
  console.error("[fetch-ign] Discovering capabilities…");
  let cap: {xml: string; version: string; layers: ReturnType<typeof parseFeatureType>[]};
  try {
    cap = await discoverCapabilities(WFS_BASE);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[fetch-ign] Capabilities fetch failed: ${msg}`);
    await storeJson(INTERMEDIATE_DIR, "ign-unavailable.json", {
      reason: `Cannot reach IGN Géoplateforme WFS: ${msg}`,
      checkedAt: utcTimestamp(),
      sourceFamily: "ign-geoplateforme",
      endpoint: WFS_BASE,
      attempts: 1,
      errors: [msg],
    } satisfies IgnUnavailableRecord);
    console.log(JSON.stringify({status: "error", fatalError: msg}));
    process.exitCode = 1;
    return;
  }

  const capHash = sha256(cap.xml);
  const capRecord: IgnCapabilityRecord = {
    wfsEndpoint: WFS_BASE,
    acquiredAt: utcTimestamp(),
    version: cap.version,
    layers: cap.layers.map((l) => ({
      name: l.name,
      title: l.title,
      abstract: l.abstract.slice(0, 200),
      defaultCrs: l.defaultCrs,
      crsOptions: l.crsOptions,
      wgs84Bbox: l.wgs84Bbox,
      keywords: l.keywords,
    })),
    responseHash: capHash,
  };
  const capFile = await storeJson(RAW_DIR, "ign-capabilities.json", capRecord);
  console.error(`[fetch-ign] Capabilities (${cap.layers.length} types) → ${capFile}`);

  // ---- Phase 2: Select elevation layers covering Auch -------------------
  const [bw, bs, be, bn] = AUCH_BBOX;

  const applicable = cap.layers.filter((l) => {
    const isElevation =
      l.name.startsWith("ELEVATION.") ||
      l.name.includes("LIDAR-HD") ||
      l.name.includes("RGEALTI") ||
      l.keywords.some((kw) => kw.toLowerCase().includes("altitude"));

    if (!isElevation) return false;

    if (l.wgs84Bbox) {
      const [lw, ls, le, ln] = l.wgs84Bbox;
      if (bw >= le || be <= lw || bs >= ln || bn <= ls) return false;
    }
    return true;
  });

  console.error(
    `[fetch-ign] ${applicable.length} elevation layer(s) cover Auch:`,
    applicable.map((l) => l.name).join(", "),
  );

  if (applicable.length === 0) {
    await storeJson(INTERMEDIATE_DIR, "ign-unavailable.json", {
      reason: "No IGN Géoplateforme elevation layer covers the Auch bounding box",
      checkedAt: utcTimestamp(),
      sourceFamily: "ign-geoplateforme",
      endpoint: WFS_BASE,
      attempts: 0,
      errors: [],
    } satisfies IgnUnavailableRecord);
    console.error("[fetch-ign] No applicable layers — unavailable written");
    console.log(JSON.stringify({status: "unavailable", reason: "no-elevation-layers-cover-auch"}));
    return;
  }

  // ---- Phase 3: Acquire each applicable layer --------------------------
  const acquisitions: Array<{
    sourceRecord: IgnSourceRecord;
    rawFile: string;
    layerName: string;
  }> = [];
  const errors: Array<{layer: string; error: string}> = [];
  const unavailable: string[] = [];

  for (const layer of applicable) {
    console.error(`[fetch-ign] Acquiring ${layer.name}…`);
    try {
      const {raw: rawJson, featureCount} = await fetchWfsFeatures(
        WFS_BASE,
        layer.name,
        AUCH_BBOX,
      );

      const hash = sha256(rawJson);

      // Determine CRS from payload if available
      let crs = layer.defaultCrs;
      try {
        const parsed = JSON.parse(rawJson);
        if (parsed.crs?.properties?.name) crs = parsed.crs.properties.name;
      } catch { /* use default */ }

      const safeName = layer.name.replace(/[.:]/g, "-").toLowerCase();
      const rawFile = await storeRaw(RAW_DIR, `ign-${safeName}.json`, rawJson);

      const sourceRecord: IgnSourceRecord = {
        id: `ign:${layer.name}:${hash.slice(0, 12)}`,
        layerName: layer.name,
        layerTitle: layer.title,
        wfsEndpoint: WFS_BASE,
        parameters: {
          service: "WFS",
          version: "2.0.0",
          request: "GetFeature",
          typenames: layer.name,
          srsname: "urn:ogc:def:crs:EPSG::4326",
          bbox: `${bw},${bs},${be},${bn}`,
          count: String(WFS_COUNT),
          outputformat: "application/json",
        },
        acquiredAt: utcTimestamp(),
        sourceFamily: "ign-geoplateforme",
        license: "https://cartes.gouv.fr/cgu",
        responseHash: hash,
        featureCount,
        crs,
        defaultCrs: layer.defaultCrs,
        status: featureCount > 0 ? "success" : "unavailable",
      };

      acquisitions.push({sourceRecord, rawFile, layerName: layer.name});

      if (featureCount === 0) {
        unavailable.push(`${layer.name}: empty (0 features in bbox)`);
        console.error(`[fetch-ign] ${layer.name}: 0 features`);
      } else {
        console.error(`[fetch-ign] ${layer.name}: ${featureCount} features → ${rawFile}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fetch-ign] FAIL ${layer.name}: ${msg}`);
      errors.push({layer: layer.name, error: msg});
    }
  }

  // ---- Phase 4: Write unavailable marker if contour lines missing -------
  const contourAcq = acquisitions.find(
    (a) => a.layerName === "ELEVATION.CONTOUR.LINE:courbe",
  );
  const hasContour =
    contourAcq && contourAcq.sourceRecord.status === "success" && contourAcq.sourceRecord.featureCount > 0;

  if (!hasContour) {
    const contourErrors = errors
      .filter((e) => e.layer === "ELEVATION.CONTOUR.LINE:courbe")
      .map((e) => e.error);
    await storeJson(INTERMEDIATE_DIR, "ign-unavailable.json", {
      reason: "No practical elevation grid available for Auch from IGN Géoplateforme: contour lines not acquired",
      checkedAt: utcTimestamp(),
      sourceFamily: "ign-geoplateforme",
      endpoint: WFS_BASE,
      attempts: contourAcq ? 1 : 0,
      errors: contourErrors.length > 0 ? contourErrors : ["contour-line-query-returned-zero-or-no-features"],
    } satisfies IgnUnavailableRecord);
    console.error("[fetch-ign] Unavailable record written (no contour data)");
  }

  // ---- Phase 5: Report --------------------------------------------------
  const successCount = acquisitions.filter((a) => a.sourceRecord.status === "success").length;
  const failCount = acquisitions.filter((a) => a.sourceRecord.status !== "success").length;

  const report = {
    status: errors.length > 0 && successCount === 0 ? "error" : "success",
    capabilitiesAcquired: cap.layers.length > 0,
    totalElevationLayersQueried: acquisitions.length,
    successfulAcquisitions: successCount,
    failedAcquisitions: failCount,
    unavailable,
    errors,
    hasPracticalTerrain: hasContour,
    acquisitionFiles: acquisitions.map((a) => ({
      layerName: a.layerName,
      file: a.rawFile.replace(/^data\//, "data/"),
      features: a.sourceRecord.featureCount,
      status: a.sourceRecord.status,
    })),
  };

  console.log(JSON.stringify(report, null, 2));
}

// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[fetch-ign] FATAL: ${msg}`);
  process.exitCode = 1;
  console.log(JSON.stringify({status: "error", fatalError: msg}));
});