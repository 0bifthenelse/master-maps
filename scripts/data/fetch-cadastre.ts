#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { acquireFile, type AcquisitionOutcome } from "./http-cache";
import { GERS_TERRITORY } from "../../src/lib/data/territory";

const DATA_DIR = process.env.MASTER_MAPS_DATA_DIR ?? "data";
const RAW_DIR = path.join(DATA_DIR, "raw");
const MANIFESTS_DIR = path.join(DATA_DIR, "manifests");
const QA_DIR = path.join(DATA_DIR, "qa");
const SOURCES_MANIFEST_PATH = path.join(MANIFESTS_DIR, "sources.json");
const CADASTRE_INVENTORY_PATH = path.join(QA_DIR, "cadastre-parity.json");

const CADASTRE_BASE_URL =
  "https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements";
const CADASTRE_LICENSE = "Licence Ouverte / Open Licence 2.0 (ETALAB)";
const CADASTRE_CRS = "WGS84 (EPSG:4326)";
const CADASTRE_TRANSFORMATION = "none (native WGS84 lon/lat)";
const CADASTRE_PRODUCER = "DGFiP / Etalab, etalab-cadastre";

export const CADASTRE_LAYERS = ["batiments", "lieux_dits"] as const;
export type CadastreLayer = (typeof CADASTRE_LAYERS)[number];

export interface CadastreLayerSpec {
  layer: CadastreLayer;
  url: string;
  destination: string;
}

export interface CadastreAcquisition {
  layer: CadastreLayer;
  url: string;
  path: string;
  bytes: number;
  sha256: string;
  fromCache: boolean;
  httpStatus: number;
  etag?: string;
  acquiredAt: string;
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
}

export interface SourceManifestEntry {
  source: string;
  url: string;
  parameters: Record<string, unknown>;
  timestamp: string;
  license: string;
  etag?: string;
  sha256: string;
  recordCount: number;
  crs: string;
  transformation: string;
  fromCache?: boolean;
  httpStatus?: number;
  bytesDownloaded?: number;
  requestCount?: number;
  retryCount?: number;
  rateLimitCount?: number;
}

interface SourcesManifestFile {
  sources: SourceManifestEntry[];
  [key: string]: unknown;
}

function isSourcesManifestFile(value: unknown): value is SourcesManifestFile {
  if (typeof value !== "object" || value === null) return false;
  return Array.isArray((value as { sources?: unknown }).sources);
}

export function cadastreLayerSpecs(departmentCode: string = GERS_TERRITORY.code): CadastreLayerSpec[] {
  return CADASTRE_LAYERS.map((layer) => ({
    layer,
    url: `${CADASTRE_BASE_URL}/${departmentCode}/cadastre-${departmentCode}-${layer}.json.gz`,
    destination: path.join(RAW_DIR, `cadastre-${departmentCode}-${layer}.json.gz`),
  }));
}

async function writeSourceManifest(entry: SourceManifestEntry): Promise<void> {
  let manifest: SourcesManifestFile = { sources: [] };
  try {
    const parsed: unknown = JSON.parse(await readFile(SOURCES_MANIFEST_PATH, "utf8"));
    if (isSourcesManifestFile(parsed)) {
      parsed.sources = parsed.sources.filter((candidate) => candidate.source !== entry.source);
      manifest = parsed;
    }
  } catch {
    manifest = { sources: [] };
  }
  manifest.sources.push(entry);
  await mkdir(path.dirname(SOURCES_MANIFEST_PATH), { recursive: true });
  await writeFile(SOURCES_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function publishCadastreInventory(acquisitions: CadastreAcquisition[]): Promise<void> {
  const layers: Record<string, unknown> = {};
  for (const acquisition of acquisitions) {
    const { layer, ...summary } = acquisition;
    layers[layer] = summary;
  }
  const payload = {
    dataset: "cadastre-inventory",
    department: GERS_TERRITORY.code,
    generatedAt: new Date().toISOString(),
    license: CADASTRE_LICENSE,
    producer: CADASTRE_PRODUCER,
    sourceUrl: CADASTRE_BASE_URL,
    mergedIntoCanonicalData: false,
    usage: "parity reconciliation only; canonical data is never merged from cadastre",
    layers,
  };
  await mkdir(QA_DIR, { recursive: true });
  await writeFile(CADASTRE_INVENTORY_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function parseLayerArg(argv: string[]): CadastreLayer[] {
  const index = argv.indexOf("--layers");
  if (index === -1) return [...CADASTRE_LAYERS];
  const value = argv[index + 1];
  if (value === undefined) throw new Error("--layers requires a comma separated list");
  const requested = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  for (const layer of requested) {
    if (!CADASTRE_LAYERS.includes(layer as CadastreLayer)) {
      throw new Error(`Unsupported cadastre layer ${layer}; expected one of ${CADASTRE_LAYERS.join(", ")}`);
    }
  }
  return requested as CadastreLayer[];
}

function hasForceArg(argv: string[]): boolean {
  return argv.includes("--force");
}

export async function fetchCadastre(options: { layers?: CadastreLayer[]; forceRefresh?: boolean } = {}): Promise<CadastreAcquisition[]> {
  const specs = cadastreLayerSpecs().filter((spec) => options.layers === undefined || options.layers.includes(spec.layer));
  const acquisitions: CadastreAcquisition[] = [];
  for (const spec of specs) {
    const outcome: AcquisitionOutcome = await acquireFile({
      url: spec.url,
      destination: spec.destination,
      forceRefresh: options.forceRefresh === true,
    });
    const acquisition: CadastreAcquisition = {
      layer: spec.layer,
      url: spec.url,
      path: spec.destination,
      bytes: outcome.contentLength,
      sha256: outcome.sha256,
      fromCache: outcome.fromCache,
      httpStatus: outcome.httpStatus,
      acquiredAt: outcome.acquiredAt,
      requestCount: outcome.requestCount,
      retryCount: outcome.retryCount,
      rateLimitCount: outcome.rateLimitCount,
    };
    if (outcome.etag !== undefined) acquisition.etag = outcome.etag;
    acquisitions.push(acquisition);
    await writeSourceManifest({
      source: `cadastre-${spec.layer}`,
      url: spec.url,
      parameters: {
        department: GERS_TERRITORY.code,
        layer: spec.layer,
        format: "geojson-gzip",
        vintage: "latest",
        mergedIntoCanonicalData: false,
      },
      timestamp: outcome.acquiredAt,
      license: CADASTRE_LICENSE,
      etag: outcome.etag,
      sha256: outcome.sha256,
      recordCount: 0,
      crs: CADASTRE_CRS,
      transformation: CADASTRE_TRANSFORMATION,
      fromCache: outcome.fromCache,
      httpStatus: outcome.httpStatus,
      bytesDownloaded: outcome.bytesDownloaded,
      requestCount: outcome.requestCount,
      retryCount: outcome.retryCount,
      rateLimitCount: outcome.rateLimitCount,
    });
  }
  await publishCadastreInventory(acquisitions);
  return acquisitions;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const layers = parseLayerArg(argv);
  console.log(`=== Cadastre acquisition: layers ${layers.join(", ")} (Licence Ouverte 2.0, not merged) ===`);
  await mkdir(RAW_DIR, { recursive: true });
  const acquisitions = await fetchCadastre({ layers, forceRefresh: hasForceArg(argv) });
  for (const acquisition of acquisitions) {
    console.log(
      `${acquisition.layer}: ${acquisition.bytes} bytes sha256=${acquisition.sha256.slice(0, 16)} fromCache=${acquisition.fromCache} http=${acquisition.httpStatus} -> ${acquisition.path}`,
    );
  }
  console.log(`Cadastre inventory written to ${CADASTRE_INVENTORY_PATH}`);
  console.log("=== Acquisition complete ===");
}

if (process.argv[1]?.endsWith("fetch-cadastre.ts")) {
  main().catch((error: unknown) => {
    console.error("Fatal error during cadastre acquisition:", error);
    process.exit(1);
  });
}
