import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireJson, createRateLimiter } from "./http-cache";
import { AUCH_DETAIL_SCOPE, GERS_TERRITORY } from "../../src/lib/data/territory";

interface ExtractedBusinessRecord {
  sourceId: string;
  siret: string;
  siren?: string;
  legalName?: string;
  tradingName?: string;
  nafCode?: string;
  nafLabel?: string;
  address?: string;
  coordinate?: { lon: number; lat: number } | null;
  administrativeStatus?: string;
  creationDate?: string;
  confidence: "high" | "medium" | "low";
  nominatedRecord: boolean;
  acquiredFromQuery: { q: string; page: number };
}

interface SireneQueryEntry {
  query: Record<string, unknown>;
  url: string;
  status: "ok" | "error" | "partial";
  httpStatus?: number;
  sha256: string;
  recordCount: number;
  fromCache?: boolean;
  bytesDownloaded?: number;
  requestCount?: number;
  retryCount?: number;
  rateLimitCount?: number;
  error?: string;

}
interface SireneRawFile {
  dataset: "businesses-sirene";
  sourceName: string;
  sourceUrl: string;
  version: string;
  license: string;
  department: { code: string; name: string };
  commune?: string;
  acquiredAt: string;
  totalQueries: number;
  totalUniqueRecords: number;
  truncated: boolean;
  bytesDownloaded: number;
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
  sha256: string;
  fromCache: boolean;
  queries: SireneQueryEntry[];
  records: ExtractedBusinessRecord[];
}
interface OsmRawFile {
  dataset: "businesses-osm";
  sourceName: string;
  sourceUrls: string[];
  license: string;
  department: { code: string; name: string };
  bbox: { west: number; east: number; south: number; north: number };
  queryText: string;
  acquiredAt: string;
  elementCount: number;
  status: "ok" | "error" | "missing";
  error?: string;
  sha256: string;
  body: unknown;
}

interface WebPageResult {
  sourceId: string;
  url: string;
  fetchedVia: "http" | "moli" | "none";
  status: "ok" | "blocked" | "error" | "crashed" | "not-found";
  httpStatus?: number;
  acquiredAt: string;
  title?: string;
  name?: string;
  address?: string;
  phone?: string;
  website?: string;
  coordinate?: { lon: number; lat: number } | null;
  confidence: "high" | "medium" | "low";
  moliError?: string;
  textTruncated?: string;
  note?: string;
}

interface WebRawFile {
  dataset: "businesses-web";
  sourceName: string;
  acquiredAt: string;
  results: WebPageResult[];
}

interface SourceManifestEntry {
  source: string;
  url?: string;
  query?: string;
  acquiredAt: string;
  license?: string;
  recordCount: number;
  status: "ok" | "partial" | "failed";
  sha256?: string;
  fromCache?: boolean;
  bytesDownloaded?: number;
  requestCount?: number;
  retryCount?: number;
  rateLimitCount?: number;
  error?: string;
}
interface FailureEntry {
  step: string;
  source: string;
  url?: string;
  error: string;
  severity: "error" | "warning";
}

export interface FetchBusinessesOptions {
  dataDir?: string;
  offline?: boolean;
  maxSirenePages?: number;
  signal?: AbortSignal;
  communeCode?: string;
  departement?: boolean;
  forceRefresh?: boolean;
}

export interface FetchBusinessesResult {
  status: "ok" | "partial" | "failed";
  sources: SourceManifestEntry[];
  failures: FailureEntry[];
  counts: Record<string, number>;
  rawFiles: string[];
}

interface AcquireSireneOptions {
  maxSirenePages: number;
  signal?: AbortSignal;
  communeCode: string;
  departement: boolean;
  forceRefresh?: boolean;
}

interface OsmBusinessElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags: Record<string, string>;
}

const DEPARTMENT_CODE = GERS_TERRITORY.code;
const TERRITORY_NAME = GERS_TERRITORY.name;
const BBOX = {
  west: GERS_TERRITORY.bootstrapBbox[0],
  east: GERS_TERRITORY.bootstrapBbox[2],
  south: GERS_TERRITORY.bootstrapBbox[1],
  north: GERS_TERRITORY.bootstrapBbox[3],
} as const;

const USER_AGENT =
  "master-maps-data-script/0.1 (+https://github.com/0bifthenelse/master-maps)";

const ANNIAURE_BASE = "https://recherche-entreprises.api.gouv.fr";
const ANNUAIRE_REQUESTS_PER_SECOND = 3;
const annuaireRateLimiter = createRateLimiter(ANNUAIRE_REQUESTS_PER_SECOND);

const MAX_RESPONSE_BYTES = 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 30_000;
const HTTP_ATTEMPTS = 4;

const SIRENE_LICENSE = "Licence Ouverte / Open Licence 2.0 (ETALAB)";
const OSM_LICENSE = "Open Database License (ODbL) v1.0";

const DEFAULT_COMMUNE_CODE = AUCH_DETAIL_SCOPE.code;
const OSM_EXTRACT_SOURCE_NAME = "osm-auch-extract";
const OSM_EXTRACT_DERIVATION =
  "named features with shop, office, craft, or commercial amenity tags derived from the local auch-osm.geojson extract";

const COMMERCIAL_AMENITIES: ReadonlySet<string> = new Set([
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
  "pharmacy",
  "bank",
  "cinema",
  "fuel",
  "hotel",
  "hostel",
  "pub",
  "biergarten",
  "ice_cream",
  "car_rental",
  "car_wash",
  "charging_station",
  "atm",
  "library",
  "theatre",
  "nightclub",
  "casino",
  "clinic",
  "dentist",
  "doctors",
  "veterinary",
  "post_office",
  "marketplace",
  "shopping_centre",
]);

const KNOWN_BUSINESS_TARGETS = [
  {
    id: "nocibe-pagesjaunes",
    url: "https://www.pagesjaunes.fr/pros/08905195",
    expectedName: "Nocibé",
    kind: "directory",
    priority: "high",
  },
  {
    id: "nocibe-official-main",
    url: "https://www.nocibe.fr/",
    expectedName: "Nocibé",
    kind: "official",
    note: "Previously crashed in Moli (bad_optional_access, exit 134), recorded limitation; used for BAN, Annuaire, and site corroboration",
  },
  {
    id: "crue-auch",
    url: "https://cru-auch.fr/",
    expectedName: "CRU",
    kind: "official",
    priority: "high",
  },
] as const;

function errMsg(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function resolveDataDir(overrides?: Pick<FetchBusinessesOptions, "dataDir">): string {
  const dir =
    overrides?.dataDir ??
    process.env["MASTER_MAPS_DATA_DIR"] ??
    "data";
  return path.resolve(process.cwd(), dir);
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

interface CachedFetchResult {
  status: number;
  contentType: string | null;
  body: string;
  sha256: string;
  fromCache: boolean;
  bytesDownloaded: number;
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
}

interface FetchOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}

async function cachedFetch(
  url: string,
  opts: FetchOptions = {},
): Promise<CachedFetchResult> {
  const method = opts.method === "POST" ? "POST" : "GET";
  const timeoutSignal = AbortSignal.timeout(
    (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) * HTTP_ATTEMPTS,
  );
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  const outcome = await acquireJson({
    url,
    method,
    body: opts.body,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/html, text/plain, */*",
      ...opts.headers,
    },
    maxBytes: opts.maxBytes ?? MAX_RESPONSE_BYTES,
    forceRefresh: opts.forceRefresh,
    signal,
  });
  return {
    status: outcome.httpStatus,
    contentType: null,
    body: outcome.body,
    sha256: outcome.sha256,
    fromCache: outcome.fromCache,
    bytesDownloaded: outcome.bytesDownloaded,
    requestCount: outcome.requestCount,
    retryCount: outcome.retryCount,
    rateLimitCount: outcome.rateLimitCount,
  };
}

interface MoliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

async function runMoliFetch(
	url: string,
	timeoutMs: number = 30_000,
): Promise<MoliResult> {
	const { promise, resolve } = Promise.withResolvers<MoliResult>();
	const start = Date.now();
	const proc = spawn(
		"moli",
		["fetch", "--dump", "markdown", url],
		{
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
			env: { ...process.env },
		},
	);

	const chunks: Buffer[] = [];
	const errChunks: Buffer[] = [];

	proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
	proc.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));

	const killTimer = setTimeout(() => {
		proc.kill("SIGTERM");
		resolve({
			success: false,
			stdout: Buffer.concat(chunks).toString("utf-8"),
			stderr: Buffer.concat(errChunks).toString("utf-8"),
			exitCode: null,
			error: `Moli timed out after ${timeoutMs}ms`,
		});
	}, timeoutMs);

	proc.on("close", (code) => {
		clearTimeout(killTimer);
		const elapsed = Date.now() - start;
		const stdout = Buffer.concat(chunks).toString("utf-8");
		const stderr = Buffer.concat(errChunks).toString("utf-8");

		if (code === 0) {
			resolve({ success: true, stdout, stderr, exitCode: code });
		} else {
			resolve({
				success: false,
				stdout,
				stderr,
				exitCode: code,
				error: `Moli exit code ${code} after ${elapsed}ms; stderr: ${stderr.slice(0, 400)}`,
			});
		}
	});

	proc.on("error", (err: NodeJS.ErrnoException) => {
		clearTimeout(killTimer);
		resolve({
			success: false,
			stdout: Buffer.concat(chunks).toString("utf-8"),
			stderr: Buffer.concat(errChunks).toString("utf-8"),
			exitCode: null,
			error: `Moli spawn error: ${err.code ?? err.message}`,
		});
	});

	return promise;
}

async function moliAvailable(): Promise<boolean> {
  try {
    const r = await runMoliFetch("https://example.com/", 5_000);
    return r.exitCode !== null;
  } catch {
    return false;
  }
}

function extractSireneRecord(
  apiResult: Record<string, unknown>,
  nominatedRecord: boolean,
  query: { q: string; page: number },
): ExtractedBusinessRecord | null {
  const siege = apiResult["siege"] as Record<string, unknown> | undefined;
  const matching = (apiResult["matching_etablissements"] as Array<Record<string, unknown>>) ?? [];
  const local = matching[0] as Record<string, unknown> | undefined ?? siege;
  if (!local) return null;

  const siret = (local["siret"] ?? apiResult["siret"]) as string | undefined;
  if (!siret) return null;

  const coordLon = local["longitude"] as string | number | undefined;
  const coordLat = local["latitude"] as string | number | undefined;

  const nafCode = (local["activite_principale"] ?? siege?.["activite_principale"]) as string | undefined;
  const nafLabel = (local["activite_principale_libelle"] ?? siege?.["libelle_activite_principale"]) as string | undefined;

  return {
    sourceId: `sirene:${siret}`,
    siret,
    siren: apiResult["siren"] as string | undefined,
    legalName: apiResult["nom_complet"] as string | undefined,
    tradingName: (local["nom_commercial"] ??
      local["enseigne_nom_commercial"] ??
      apiResult["nom_complet"]) as string | undefined,
    nafCode,
    nafLabel,
    address: local["adresse"] as string | undefined,
    coordinate:
      coordLon != null && coordLat != null
        ? {
            lon: Number(coordLon),
            lat: Number(coordLat),
          }
        : null,
    administrativeStatus: local["etat_administratif"] as string | undefined,
    creationDate: local["date_creation"] as string | undefined,
    confidence: "high",
    nominatedRecord,
    acquiredFromQuery: { q: query.q, page: query.page },
  };
}

function annuaireQueryString(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

function annuaireSearchUrl(params: Record<string, string | number>): string {
  return `${ANNIAURE_BASE}/search?${annuaireQueryString(params)}`;
}

async function querySirene(
  params: Record<string, string | number>,
  forceRefresh = false,
): Promise<{
  body: Record<string, unknown>;
  sha256: string;
  status: number;
  fromCache: boolean;
  bytesDownloaded: number;
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
}> {
  await annuaireRateLimiter.acquire();
  const result = await cachedFetch(annuaireSearchUrl(params), { timeoutMs: 20_000, forceRefresh });
  const body: unknown = JSON.parse(result.body);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Annuaire des Entreprises returned a non-object JSON response");
  return { body: body as Record<string, unknown>, sha256: result.sha256, status: result.status, fromCache: result.fromCache, bytesDownloaded: result.bytesDownloaded, requestCount: result.requestCount, retryCount: result.retryCount, rateLimitCount: result.rateLimitCount };
}

async function acquireSirene(
  rawDir: string,
  opts: AcquireSireneOptions,
): Promise<{
  rawFile: SireneRawFile;
  sources: SourceManifestEntry[];
  failures: FailureEntry[];
  counts: Record<string, number>;
}> {
  const failures: FailureEntry[] = [];
  const queries: SireneQueryEntry[] = [];
  const allRecords: ExtractedBusinessRecord[] = [];
  let totalResults = 0;
  let truncated = false;

  const scopeParams: Record<string, string | number> = opts.departement
    ? { departement: DEPARTMENT_CODE }
    : { code_commune: opts.communeCode };
  const perPage = 25;
  const maxPages = Math.min(opts.maxSirenePages, 400);

  try {
    const firstParams: Record<string, string | number> = { q: "", ...scopeParams, per_page: perPage, page: 1 };
    const first = await querySirene(firstParams, opts.forceRefresh);

    totalResults = (first.body["total_results"] as number) ?? 0;
    const totalPages = Math.min(
      (first.body["total_pages"] as number) ?? Math.ceil(totalResults / perPage),
      400,
    );

    const results = (first.body["results"] as Array<Record<string, unknown>>) ?? [];
    for (const r of results) {
      const rec = extractSireneRecord(r, false, { q: "", page: 1 });
      if (rec) allRecords.push(rec);
    }

    queries.push({
      query: firstParams,
      url: annuaireSearchUrl(firstParams),
      status: "ok",
      httpStatus: first.status,
      sha256: first.sha256,
      recordCount: results.length,
      fromCache: first.fromCache,
      bytesDownloaded: first.bytesDownloaded,
      requestCount: first.requestCount,
      retryCount: first.retryCount,
      rateLimitCount: first.rateLimitCount,
    });

    const pagesToFetch = Math.min(maxPages, totalPages);
    if (totalResults > pagesToFetch * perPage) {
      truncated = true;
    }

    for (let page = 2; page <= pagesToFetch; page++) {
      if (opts.signal?.aborted) break;

      try {
        const pageParams: Record<string, string | number> = { q: "", ...scopeParams, per_page: perPage, page };
        const pageResult = await querySirene(pageParams, opts.forceRefresh);

        const pageResults = (pageResult.body["results"] as Array<Record<string, unknown>>) ?? [];
        for (const r of pageResults) {
          const rec = extractSireneRecord(r, false, { q: "", page });
          if (rec) allRecords.push(rec);
        }

        queries.push({
          query: pageParams,
          url: annuaireSearchUrl(pageParams),
          status: "ok",
          httpStatus: pageResult.status,
          sha256: pageResult.sha256,
          recordCount: pageResults.length,
          fromCache: pageResult.fromCache,
          bytesDownloaded: pageResult.bytesDownloaded,
          requestCount: pageResult.requestCount,
          retryCount: pageResult.retryCount,
          rateLimitCount: pageResult.rateLimitCount,
        });
      } catch (err: unknown) {
        failures.push({
          step: "sirene-scan-pagination",
          source: "recherche-entreprises.api.gouv.fr",
          url: annuaireSearchUrl({ q: "", ...scopeParams, per_page: perPage, page }),
          error: errMsg(err),
          severity: "warning",
        });
        queries.push({
          query: { q: "", ...scopeParams, per_page: perPage, page },
          url: annuaireSearchUrl({ q: "", ...scopeParams, per_page: perPage, page }),
          status: "error",
          error: errMsg(err),
          recordCount: 0,
          sha256: "",
        });
      }
    }
  } catch (err: unknown) {
    const msg = errMsg(err);
    failures.push({
      step: "sirene-scan-initial",
      source: "recherche-entreprises.api.gouv.fr",
      url: annuaireSearchUrl({ q: "", ...scopeParams, per_page: perPage, page: 1 }),
      error: msg,
      severity: "error",
    });
    throw new Error(`SIRENE scan query failed: ${msg}`);
  }

  const nameQueries = [
    { q: "NOCIBE", label: "nocibe" },
    { q: "FANTOCHE", label: "fantoche" },
    { q: "CRU", label: "cru" },
  ];

  for (const nq of nameQueries) {
    if (opts.signal?.aborted) break;

    try {
      const targetedParams: Record<string, string | number> = { q: nq.q, ...scopeParams, per_page: 25, page: 1 };
      const result = await querySirene(targetedParams, opts.forceRefresh);

      const results = (result.body["results"] as Array<Record<string, unknown>>) ?? [];

      for (const r of results) {
        const matching = (r["matching_etablissements"] as Array<Record<string, unknown>>) ?? [];
        for (let i = 0; i < matching.length; i++) {
          const m = matching[i] as Record<string, unknown>;
          const siret = m["siret"] as string | undefined;
          if (!siret) continue;

          const coordLon = m["longitude"] as string | number | undefined;
          const coordLat = m["latitude"] as string | number | undefined;

          allRecords.push({
            sourceId: `sirene:${siret}`,
            siret,
            siren: r["siren"] as string | undefined,
            legalName: r["nom_complet"] as string | undefined,
            tradingName: (m["nom_commercial"] ??
              m["enseigne_nom_commercial"] ??
              r["nom_complet"]) as string | undefined,
            nafCode: m["activite_principale"] as string | undefined,
            address: m["adresse"] as string | undefined,
            coordinate:
              coordLon != null && coordLat != null
                ? { lon: Number(coordLon), lat: Number(coordLat) }
                : null,
            administrativeStatus: m["etat_administratif"] as string | undefined,
            confidence: "high",
            nominatedRecord: true,
            acquiredFromQuery: { q: nq.q, page: 1 },
          });
        }
      }

      queries.push({
        query: targetedParams,
        url: annuaireSearchUrl(targetedParams),
        status: "ok",
        httpStatus: result.status,
        sha256: result.sha256,
        recordCount: results.length,
        fromCache: result.fromCache,
        bytesDownloaded: result.bytesDownloaded,
        requestCount: result.requestCount,
        retryCount: result.retryCount,
        rateLimitCount: result.rateLimitCount,
      });
    } catch (err: unknown) {
      failures.push({
        step: `sirene-targeted-query-${nq.label}`,
        source: "recherche-entreprises.api.gouv.fr",
        url: annuaireSearchUrl({ q: nq.q, ...scopeParams, per_page: 25, page: 1 }),
        error: errMsg(err),
        severity: "warning",
      });
      queries.push({
        query: { q: nq.q, ...scopeParams, per_page: 25, page: 1 },
        url: annuaireSearchUrl({ q: nq.q, ...scopeParams, per_page: 25, page: 1 }),
        status: "error",
        error: errMsg(err),
        recordCount: 0,
        sha256: "",
      });
    }
  }

  const seen = new Set<string>();
  const uniqueRecords: ExtractedBusinessRecord[] = [];
  for (const rec of allRecords) {
    if (!seen.has(rec.sourceId)) {
      seen.add(rec.sourceId);
      uniqueRecords.push(rec);
    }
  }

  const bytesDownloaded = queries.reduce((sum, query) => sum + (query.bytesDownloaded ?? 0), 0);
  const requestCount = queries.reduce((sum, query) => sum + (query.requestCount ?? 0), 0);
  const retryCount = queries.reduce((sum, query) => sum + (query.retryCount ?? 0), 0);
  const rateLimitCount = queries.reduce((sum, query) => sum + (query.rateLimitCount ?? 0), 0);
  const fromCache = queries.length > 0 && queries.every((query) => query.fromCache === true);
  const rawFile: SireneRawFile = {
    dataset: "businesses-sirene",
    sourceName: "Annuaire des Entreprises / SIRENE (recherche-entreprises.api.gouv.fr)",
    sourceUrl: ANNIAURE_BASE,
    version: "2.6",
    license: SIRENE_LICENSE,
    department: { code: DEPARTMENT_CODE, name: TERRITORY_NAME },
    ...(opts.departement ? {} : { commune: opts.communeCode }),
    acquiredAt: new Date().toISOString(),
    totalQueries: queries.length,
    totalUniqueRecords: uniqueRecords.length,
    truncated,
    bytesDownloaded,
    requestCount,
    retryCount,
    rateLimitCount,
    fromCache,
    queries,
    records: uniqueRecords,
  };
  rawFile.sha256 = sha256(JSON.stringify(rawFile));

  const sourceEntry: SourceManifestEntry = {
    source: `recherche-entreprises.api.gouv.fr (${SIRENE_LICENSE})`,
    url: `${ANNIAURE_BASE}/search`,
    sha256: sha256(JSON.stringify(rawFile)),
    fromCache,
    bytesDownloaded,
    requestCount,
    retryCount,
    rateLimitCount,
    query: annuaireQueryString({ q: "", ...scopeParams, per_page: perPage }),
    acquiredAt: rawFile.acquiredAt,
    license: SIRENE_LICENSE,
    recordCount: uniqueRecords.length,
    status: failures.some((f) => f.severity === "error") ? "partial" : "ok",
  };

  return {
    rawFile,
    sources: [sourceEntry],
    failures,
    counts: { sireneRecords: uniqueRecords.length, sireneQueries: queries.length },
  };
}

function isCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number";
}

function isCoordinateRing(value: unknown): value is number[][] {
  return Array.isArray(value) && value.every(isCoordinate);
}

function isCoordinateRingCollection(value: unknown): value is number[][][] {
  return Array.isArray(value) && value.every(isCoordinateRing);
}

function isCoordinateRingNest(value: unknown): value is number[][][][] {
  return Array.isArray(value) && value.every(isCoordinateRingCollection);
}

function firstRing(geometry: unknown): number[][] | null {
  if (typeof geometry !== "object" || geometry === null) return null;
  const record = geometry as Record<string, unknown>;
  const coordinates = record["coordinates"];
  if (record["type"] === "Point" && isCoordinate(coordinates)) return [coordinates];
  if (record["type"] === "LineString" && isCoordinateRing(coordinates)) return coordinates;
  if (record["type"] === "MultiLineString" && isCoordinateRingCollection(coordinates) && coordinates[0]) return coordinates[0];
  if (record["type"] === "Polygon" && isCoordinateRingCollection(coordinates) && coordinates[0]) return coordinates[0];
  if (record["type"] === "MultiPolygon" && isCoordinateRingNest(coordinates) && coordinates[0] && coordinates[0][0]) return coordinates[0][0];
  return null;
}

function ringAnchor(ring: number[][]): { lat: number; lon: number } | null {
  if (ring.length === 0) return null;
  let lonSum = 0;
  let latSum = 0;
  for (const coordinate of ring) {
    lonSum += coordinate[0]!;
    latSum += coordinate[1]!;
  }
  return { lat: latSum / ring.length, lon: lonSum / ring.length };
}

function osmElementType(
  feature: Record<string, unknown>,
  properties: Record<string, unknown>,
): "node" | "way" | "relation" | null {
  const declared = properties["@type"] ?? properties["type"];
  if (declared === "node" || declared === "way" || declared === "relation") return declared;
  const uniqueId = feature["id"];
  if (typeof uniqueId !== "string") return null;
  const prefix = uniqueId.split("/")[0];
  if (prefix === "node" || prefix === "way" || prefix === "relation") return prefix;
  if (prefix === "n") return "node";
  if (prefix === "w") return "way";
  if (prefix === "r") return "relation";
  return null;
}

function osmElementId(
  feature: Record<string, unknown>,
  properties: Record<string, unknown>,
): number | null {
  const declared = properties["@id"] ?? properties["id"];
  if (typeof declared === "number" && Number.isInteger(declared)) return declared;
  if (typeof declared === "string") {
    const value = Number.parseInt(declared, 10);
    if (Number.isInteger(value)) return value;
  }
  const uniqueId = feature["id"];
  if (typeof uniqueId !== "string") return null;
  const suffix = uniqueId.includes("/") ? uniqueId.split("/")[1] : uniqueId.slice(1);
  const value = Number.parseInt(suffix ?? "", 10);
  return Number.isInteger(value) ? value : null;
}

function toOsmBusinessElement(feature: unknown): OsmBusinessElement | null {
  if (typeof feature !== "object" || feature === null) return null;
  const record = feature as Record<string, unknown>;
  const properties = record["properties"];
  if (typeof properties !== "object" || properties === null) return null;

  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === "type" || key === "id") continue;
    if (typeof value === "string") tags[key] = value;
  }

  const name = tags["name"];
  if (name === undefined || name === "") return null;
  const shop = tags["shop"];
  const office = tags["office"];
  const craft = tags["craft"];
  const amenity = tags["amenity"];
  const commercial =
    (shop !== undefined && shop !== "") ||
    (office !== undefined && office !== "") ||
    (craft !== undefined && craft !== "") ||
    (amenity !== undefined && COMMERCIAL_AMENITIES.has(amenity));
  if (!commercial) return null;

  const osmType = osmElementType(record, properties);
  if (osmType === null) return null;
  const osmId = osmElementId(record, properties);
  if (osmId === null) return null;
  const anchor = ringAnchor(firstRing(record["geometry"]) ?? []);
  if (anchor === null) return null;

  const element: OsmBusinessElement = { type: osmType, id: osmId, tags };
  if (osmType === "node") {
    element.lat = anchor.lat;
    element.lon = anchor.lon;
  } else {
    element.center = { lat: anchor.lat, lon: anchor.lon };
  }
  return element;
}

function elementAnchor(element: OsmBusinessElement): { lat: number; lon: number } | null {
  if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.center) return element.center;
  return null;
}

function elementsBbox(elements: OsmBusinessElement[]): { west: number; east: number; south: number; north: number } | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const element of elements) {
    const anchor = elementAnchor(element);
    if (!anchor) continue;
    west = Math.min(west, anchor.lon);
    east = Math.max(east, anchor.lon);
    south = Math.min(south, anchor.lat);
    north = Math.max(north, anchor.lat);
  }
  if (!Number.isFinite(west)) return null;
  return { west, east, south, north };
}

async function deriveOsmBusinessesFromExtract(
  rawDir: string,
): Promise<{
  rawFile: OsmRawFile;
  sources: SourceManifestEntry[];
  failures: FailureEntry[];
  counts: Record<string, number>;
}> {
  const extractPath = path.join(rawDir, AUCH_DETAIL_SCOPE.osmGeojsonFile);
  const failures: FailureEntry[] = [];
  const acquiredAt = new Date().toISOString();

  const unavailable = (status: "missing" | "error", reason: string): {
    rawFile: OsmRawFile;
    sources: SourceManifestEntry[];
    failures: FailureEntry[];
    counts: Record<string, number>;
  } => {
    failures.push({
      step: "osm-business-extract",
      source: OSM_EXTRACT_SOURCE_NAME,
      error: reason,
      severity: "warning",
    });
    const rawFile: OsmRawFile = {
      dataset: "businesses-osm",
      sourceName: OSM_EXTRACT_SOURCE_NAME,
      sourceUrls: [extractPath],
      license: OSM_LICENSE,
      department: { code: DEPARTMENT_CODE, name: TERRITORY_NAME },
      bbox: { ...BBOX },
      queryText: OSM_EXTRACT_DERIVATION,
      acquiredAt,
      elementCount: 0,
      status,
      error: reason,
      sha256: "",
      body: null,
    };
    const source: SourceManifestEntry = {
      source: "OpenStreetMap (osm-auch-extract), businesses",
      url: extractPath,
      query: OSM_EXTRACT_DERIVATION,
      acquiredAt,
      license: OSM_LICENSE,
      recordCount: 0,
      status: "failed",
      error: reason,
    };
    return { rawFile, sources: [source], failures, counts: { osmBusinessElements: 0 } };
  };

  let content: string;
  try {
    content = await readFile(extractPath, "utf-8");
  } catch {
    return unavailable(
      "missing",
      `Auch OSM extract ${extractPath} not found; run fetch-osm.ts --auch before deriving OSM businesses`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err: unknown) {
    return unavailable("error", `Auch OSM extract ${extractPath} is not valid JSON: ${errMsg(err)}`);
  }

  const features = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["features"])
    ? (parsed as { features: unknown[] })["features"]
    : null;
  if (features === null) {
    return unavailable("error", `Auch OSM extract ${extractPath} does not contain a GeoJSON features array`);
  }

  const elements: OsmBusinessElement[] = [];
  for (const feature of features) {
    const element = toOsmBusinessElement(feature);
    if (element) elements.push(element);
  }

  const digest = sha256(content);
  const rawFile: OsmRawFile = {
    dataset: "businesses-osm",
    sourceName: OSM_EXTRACT_SOURCE_NAME,
    sourceUrls: [extractPath],
    license: OSM_LICENSE,
    department: { code: DEPARTMENT_CODE, name: TERRITORY_NAME },
    bbox: elementsBbox(elements) ?? { ...BBOX },
    queryText: OSM_EXTRACT_DERIVATION,
    acquiredAt,
    elementCount: elements.length,
    status: "ok",
    sha256: digest,
    body: { elements },
  };

  const source: SourceManifestEntry = {
    source: "OpenStreetMap (osm-auch-extract), businesses",
    url: extractPath,
    query: OSM_EXTRACT_DERIVATION,
    acquiredAt,
    license: OSM_LICENSE,
    recordCount: elements.length,
    status: "ok",
    sha256: digest,
  };

  return {
    rawFile,
    sources: [source],
    failures,
    counts: { osmBusinessElements: elements.length },
  };
}

async function acquireWebBusinessPages(
  rawDir: string,
  opts: Pick<FetchBusinessesOptions, "offline" | "signal" | "forceRefresh">,
): Promise<{
  rawFile: WebRawFile;
  sources: SourceManifestEntry[];
  failures: FailureEntry[];
  counts: Record<string, number>;
}> {
  const failures: FailureEntry[] = [];
  const results: WebPageResult[] = [];
  const hasMoli = process.env.MASTER_MAPS_BUSINESS_MOLI === "1" && await moliAvailable();

  for (const target of KNOWN_BUSINESS_TARGETS) {
    if (opts.signal?.aborted) break;

    let pageResult: WebPageResult = {
      sourceId: `web:${target.id}`,
      url: target.url,
      fetchedVia: "none",
      status: "ok",
      acquiredAt: new Date().toISOString(),
      confidence: "medium",
      note: target.note,
    };

    try {
      const httpResult = await cachedFetch(target.url, {
        timeoutMs: 20_000,
        maxBytes: 512_000,
        forceRefresh: opts.forceRefresh,
        headers: { Accept: "text/html,text/plain,*/*" },
      });

      pageResult.httpStatus = httpResult.status;
      pageResult.acquiredAt = new Date().toISOString();

      if (httpResult.status >= 200 && httpResult.status < 300) {
        pageResult.fetchedVia = "http";
        pageResult.status = "ok";

        const body = httpResult.body;
        const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
        pageResult.title = titleMatch?.[1]?.trim() ?? "";

        const nameMatch = body.match(
          /(?:business-name|company-name|h1|org|brand)[^>]*>([^<]{2,80})</i,
        );
        if (nameMatch && !pageResult.name) {
          pageResult.name = nameMatch[1]!.trim();
        }

        const textBody = body
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        pageResult.textTruncated = textBody.slice(0, 8_000);

        pageResult.note =
          target.note ?? `HTTP ${httpResult.status}, ${httpResult.body.length} bytes`;
        pageResult.confidence = target.priority === "high" ? "high" : "medium";

        if (target.id.startsWith("nocibe") && /Nocib[éèe]/i.test(body)) {
          pageResult.name = "Nocibé";
        }
      } else if (httpResult.status === 404) {
        pageResult.status = "not-found";
        pageResult.note = `HTTP 404`;
      } else {
        pageResult.status = "blocked";
        pageResult.note = `HTTP ${httpResult.status}`;
      }
    } catch (err: unknown) {
      pageResult.fetchedVia = "none";
      pageResult.status = "error";
      pageResult.note = `HTTP fetch error: ${errMsg(err)}`;
    }

    if (
      pageResult.status !== "ok" &&
      pageResult.status !== "not-found" &&
      hasMoli
    ) {
      try {
        const moliResult = await runMoliFetch(target.url, 45_000);

        if (moliResult.success) {
          pageResult.fetchedVia = "moli";
          pageResult.status = "ok";

          const lines = moliResult.stdout.split("\n").filter((l) => l.trim());
          pageResult.textTruncated = moliResult.stdout.slice(0, 8_000);
          if (lines.length > 0) {
            pageResult.title =
              lines.find((l) => /^#/.test(l))?.replace(/^#+\s*/, "") ?? lines[0]!.slice(0, 120);
          }

          pageResult.note = `Moli fetch OK (${moliResult.stdout.length}B)`;
          pageResult.confidence = target.priority === "high" ? "high" : "medium";
        } else {
          pageResult.fetchedVia = "moli";
          pageResult.status = "crashed";
          pageResult.moliError = moliResult.error ?? `exit ${moliResult.exitCode}`;
          pageResult.note = `Moli failure: ${moliResult.error ?? "unknown"}`;
          if (moliResult.stderr) pageResult.note += `; stderr: ${moliResult.stderr.slice(0, 300)}`;

          failures.push({
            step: `web-moli-${target.id}`,
            source: "moli",
            url: target.url,
            error: pageResult.moliError,
            severity: "warning",
          });
        }
      } catch (err: unknown) {
        pageResult.fetchedVia = "moli";
        pageResult.status = "crashed";
        pageResult.moliError = errMsg(err);
        pageResult.note = `Moli invocation error: ${errMsg(err)}`;
        failures.push({
          step: `web-moli-crash-${target.id}`,
          source: "moli",
          url: target.url,
          error: errMsg(err),
          severity: "warning",
        });
      }
    }

    results.push(pageResult);
  }

  const acquiredAt = new Date().toISOString();
  const rawFile: WebRawFile = {
    dataset: "businesses-web",
    sourceName: "Individually verified business public pages",
    acquiredAt,
    results,
  };

  const source: SourceManifestEntry = {
    source: "Web business pages (direct HTTP + Moli)",
    url: KNOWN_BUSINESS_TARGETS.map((t) => t.url).join("; "),
    acquiredAt,
    recordCount: results.length,
    status: failures.length > results.length ? "partial" : "ok",
  };

  const counts: Record<string, number> = {
    webPagesFetched: results.length,
    webPagesOk: results.filter((r) => r.status === "ok").length,
    webPagesBlocked: results.filter((r) => r.status === "blocked").length,
    webPagesCrashed: results.filter((r) => r.status === "crashed").length,
    webPagesMoliUsed: results.filter((r) => r.fetchedVia === "moli").length,
  };

  return { rawFile, sources: [source], failures, counts };
}

export async function fetchBusinesses(
  options: FetchBusinessesOptions = {},
): Promise<FetchBusinessesResult> {
  const dataRoot = resolveDataDir(options);
  const rawDir = path.join(dataRoot, "raw");
  const mode: "online" | "offline" = options.offline ? "offline" : "online";

  await ensureDir(rawDir);

	const allSources: SourceManifestEntry[] = [];
	const allFailures: FailureEntry[] = [];
	const allCounts: Record<string, number> = {};
	const rawFiles: string[] = [];

	if (mode === "offline") {
		const requiredFiles = [
			"businesses-sirene.json",
		];
		const optionalFiles = [
			"businesses-osm.json",
			"businesses-web.json",
		];

		for (const name of [...requiredFiles, ...optionalFiles]) {
			const p = path.join(rawDir, name);
			try {
				await access(p);
				rawFiles.push(p);
				const content = await readFile(p, "utf-8");
				const parsed = JSON.parse(content) as Record<string, unknown>;
				const rc = (parsed["totalUniqueRecords"] ??
					(parsed as Record<string, unknown>)["records"]?.["length"] ??
					(parsed as Record<string, unknown>)["elementCount"] ??
					(parsed as Record<string, unknown>)["results"]?.["length"] ??
					0) as number;
				allCounts[`${name.replace(/\.json$/, "")}`] = rc;
				allSources.push({
					source: `cached:${name}`,
					acquiredAt: parsed["acquiredAt"] as string ?? new Date().toISOString(),
					recordCount: rc,
					status: "ok",
				});
			} catch {
				if (requiredFiles.includes(name)) {
					throw new Error(
						`Offline mode: required raw file ${p} is missing. Run data:refresh without --offline first.`,
					);
				}
				allFailures.push({
					step: `offline-missing-${name}`,
					source: `raw:${name}`,
					error: `Optional raw file ${p} not found; skipping`,
					severity: "warning",
				});
			}
		}

		return {
			status: "ok",
			sources: allSources,
			failures: allFailures,
			counts: allCounts,
			rawFiles,
		};
	}

	const departementScan = options.departement === true;
	const communeCode = options.communeCode ?? DEFAULT_COMMUNE_CODE;
  {
    const result = await acquireSirene(rawDir, {
      maxSirenePages: options.maxSirenePages ?? 30,
      signal: options.signal ?? undefined,
      communeCode,
      departement: departementScan,
      forceRefresh: options.forceRefresh,
    });

    const outPath = path.join(rawDir, "businesses-sirene.json");
    await writeFile(outPath, JSON.stringify(result.rawFile, null, 2), "utf-8");
    rawFiles.push(outPath);

    allSources.push(...result.sources);
    allFailures.push(...result.failures);
    Object.assign(allCounts, result.counts);
  }

	{
		const result = await deriveOsmBusinessesFromExtract(rawDir);

		const outPath = path.join(rawDir, "businesses-osm.json");
		await writeFile(outPath, JSON.stringify(result.rawFile, null, 2), "utf-8");
		rawFiles.push(outPath);

		allSources.push(...result.sources);
		allFailures.push(...result.failures);
		Object.assign(allCounts, result.counts);
	}

	{
		const result = await acquireWebBusinessPages(rawDir, { signal: options.signal, forceRefresh: options.forceRefresh });

		const outPath = path.join(rawDir, "businesses-web.json");
		await writeFile(outPath, JSON.stringify(result.rawFile, null, 2), "utf-8");
		rawFiles.push(outPath);

		allSources.push(...result.sources);
		allFailures.push(...result.failures);
		Object.assign(allCounts, result.counts);
	}

  const totalErrors = allFailures.filter((f) => f.severity === "error").length;
  const status: "ok" | "partial" | "failed" =
    totalErrors > 0 ? "failed" : allFailures.length > 0 ? "partial" : "ok";

  if (!allCounts["sireneRecords"]) {
    allFailures.push({
      step: "final",
      source: "sirene",
      error: "No SIRENE records were acquired; required data missing",
      severity: "error",
    });
    return {
      status: "failed",
      sources: allSources,
      failures: allFailures,
      counts: allCounts,
      rawFiles,
    };
  }

  return {
    status,
    sources: allSources,
    failures: allFailures,
    counts: allCounts,
    rawFiles,
  };
}

function isDirectRun(): boolean {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const arg = process.argv[1];
    return !!arg && path.resolve(arg) === selfPath;
  } catch {
    const arg = process.argv[1];
    return !!arg && (arg.endsWith("/fetch-businesses.ts") || arg.endsWith("\\fetch-businesses.ts") || arg.endsWith("fetch-businesses.js"));
  }
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  const flags = {
    offline: argv.includes("--offline"),
    departement: argv.includes("--departement"),
    forceRefresh: argv.includes("--force"),
    dataDir: undefined as string | undefined,
    communeCode: undefined as string | undefined,
  };
  const dataIdx = argv.indexOf("--data-dir");
  if (dataIdx !== -1 && dataIdx + 1 < argv.length) flags.dataDir = argv[dataIdx + 1]!;
  const communeIdx = argv.indexOf("--commune");
  if (communeIdx !== -1 && communeIdx + 1 < argv.length) flags.communeCode = argv[communeIdx + 1]!;
  const maxPagesIdx = argv.indexOf("--max-pages");
  const maxPagesValue = maxPagesIdx !== -1 && maxPagesIdx + 1 < argv.length ? Number.parseInt(argv[maxPagesIdx + 1]!, 10) : 30;
  fetchBusinesses({
    dataDir: flags.dataDir,
    offline: flags.offline,
    maxSirenePages: Number.isFinite(maxPagesValue) ? maxPagesValue : 30,
    departement: flags.departement,
    communeCode: flags.communeCode,
    forceRefresh: flags.forceRefresh,
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      const errorCount = result.failures.filter((failure) => failure.severity === "error").length;
      if (errorCount > 0) process.exit(1);
      if (result.failures.length > 0) console.error(`Completed with ${result.failures.length} warning(s):`, result.failures.map((failure) => `  ${failure.step}: ${failure.error}`).join("\n"));
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("Fatal error:", errMsg(error));
      process.exit(1);
    });
}
