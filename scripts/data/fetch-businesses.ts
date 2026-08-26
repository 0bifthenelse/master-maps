/**
 * fetch-businesses.ts — acquire business records for Auch (32013).
 *
 * Sources:
 *   1. Annuaire des Entreprises / SIRENE (recherche-entreprises.api.gouv.fr)
 *      — commune-wide paginated scan + targeted name queries for known leads
 *   2. OpenStreetMap business records (Overpass)
 *      — shop=*, office=*, craft=*, and business-oriented amenity within the commune bbox
 *   3. Individually verified public business pages
 *      — direct HTTP + Moli for rendered pages (PagesJaunes Nocibé, CRU, Nocibé official)
 *
 * Raw outputs (under MASTER_MAPS_DATA_DIR/raw/):
 *   businesses-sirene.json — Annuaire API responses (verbatim bodies + extracted records)
 *   businesses-osm.json   — Overpass response (verbatim JSON + query metadata)
 *   businesses-web.json   — per-page fetched results from business URLs
 *
 * All failures are recorded, never treated as evidence of zero objects.
 * Bounded exponential retries on transient failures; Moli wrapped in try/catch.
 *
 * @module
 */

// ── Structural types matching the canonical schema contract ─────────────────
// The canonical src/lib/data/schema.ts is loaded dynamically when available;
// these local structural types are the fallback for runtime and annotation.
// They mirror the agreed contracts for SourceReference and business records.

/** A single raw business record extracted from the Annuaire API response body. */
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

/** Per-query entry in the SIRENE raw file. */
interface SireneQueryEntry {
  query: Record<string, unknown>;
  url: string;
  status: "ok" | "error" | "partial";
  httpStatus?: number;
  sha256: string;
  recordCount: number;
  error?: string;
  body: unknown; // verbatim parsed JSON response
}

/** Schema for data/raw/businesses-sirene.json */
interface SireneRawFile {
  dataset: "businesses-sirene";
  sourceName: string;
  sourceUrl: string;
  version: string;
  license: string;
  commune: { code: string; name: string };
  acquiredAt: string;
  totalQueries: number;
  totalUniqueRecords: number;
  truncated: boolean;
  queries: SireneQueryEntry[];
  records: ExtractedBusinessRecord[];
}

/** Schema for data/raw/businesses-osm.json */
interface OsmRawFile {
  dataset: "businesses-osm";
  sourceName: string;
  sourceUrls: string[];
  license: string;
  commune: { code: string; name: string };
  bbox: { west: number; east: number; south: number; north: number };
  queryText: string;
  acquiredAt: string;
  elementCount: number;
  status: "ok" | "error";
  error?: string;
  sha256: string;
  body: unknown; // verbatim Overpass response
}

/** A result from fetching one verified business URL. */
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
  textTruncated?: string; // bounded excerpt, ≤ 8_000 chars
  note?: string;
}

interface WebRawFile {
  dataset: "businesses-web";
  sourceName: string;
  acquiredAt: string;
  results: WebPageResult[];
}

/** Source metadata entry returned for manifest assembly. */
interface SourceManifestEntry {
  source: string;
  url?: string;
  query?: string;
  acquiredAt: string;
  license?: string;
  recordCount: number;
  status: "ok" | "partial" | "failed";
  sha256?: string;
  error?: string;
}

/** A recorded failure with context. */
interface FailureEntry {
  step: string;
  source: string;
  url?: string;
  error: string;
  severity: "error" | "warning";
}

export interface FetchBusinessesOptions {
  /** Root of MASTER_MAPS_DATA_DIR; default "data" */
  dataDir?: string;
  /** Skip all network; read existing raw dumps */
  offline?: boolean;
  /** Max pages for the Annuaire commune scan (25 records/page); default 30, max 400 */
  maxSirenePages?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

export interface FetchBusinessesResult {
  status: "ok" | "partial" | "failed";
  sources: SourceManifestEntry[];
  failures: FailureEntry[];
  counts: Record<string, number>;
  rawFiles: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const INSEE_CODE = "32013";
const COMMUNE_NAME = "Auch";
const BBOX = {
  west: 0.486087 as const,
  east: 0.647019 as const,
  south: 43.617419 as const,
  north: 43.707701 as const,
} as const;

const USER_AGENT =
  "master-maps-data-script/0.1 (+https://github.com/0bifthenelse/master-maps)";

/** Annuaire des Entreprises / SIRENE base URL */
const ANNIAURE_BASE = "https://recherche-entreprises.api.gouv.fr";

/** Overpass endpoints, tried in order */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
] as const;

/** Bounded max bytes for a single HTTP response body */
const MAX_RESPONSE_BYTES = 1_024 * 1_024; // 1 MiB

/** User-facing license for SIRENE data */
const SIRENE_LICENSE = "Licence Ouverte / Open Licence 2.0 (ETALAB)";
const OSM_LICENSE = "Open Database License (ODbL) v1.0";

// Known verified business leads — used for targeted queries and web page verification
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
    note: "Previously crashed in Moli (bad_optional_access, exit 134) — recorded limitation; used for BAN/Annuaire/site corroboration",
  },
  {
    id: "crue-auch",
    url: "https://cru-auch.fr/",
    expectedName: "CRU",
    kind: "official",
    priority: "high",
  },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Get a human-readable message from an unknown error. */
function errMsg(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Compute SHA-256 hex digest of a string. */
function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Resolve the data root directory from options or environment. */
function resolveDataDir(overrides?: Pick<FetchBusinessesOptions, "dataDir">): string {
  const dir =
    overrides?.dataDir ??
    process.env["MASTER_MAPS_DATA_DIR"] ??
    "data";
  return path.resolve(process.cwd(), dir);
}

/** Ensure a directory exists. */
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

// ── Cached HTTP fetch with retries ─────────────────────────────────────────

interface CachedFetchResult {
  status: number;
  contentType: string | null;
  body: string;
  sha256: string;
  fromCache: boolean;
}

/** In-memory cache — keyed by normalised URL. */
const responseCache = new Map<string, CachedFetchResult>();

interface FetchOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
}

/**
 * Bounded exponential backoff + jitter.
 * Returns delay in milliseconds.
 */
function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const delay = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitter = Math.random() * 0.3 * delay;
  return delay + jitter;
}

function isRetryable(status: number | undefined, err: unknown): boolean {
  if (err) return true; // network/timeout errors are retryable
  if (status === undefined) return true;
  if (status >= 500) return true; // server errors
  if (status === 429) return true; // rate limit
  return false;
}

/**
 * Fetch a URL with in-memory caching, size cap, content hashing,
 * and bounded exponential retries.
 * On persistent failure, the last error is thrown.
 */
async function cachedFetch(
  url: string,
  opts: FetchOptions = {},
): Promise<CachedFetchResult> {
  const maxRetries = opts.retries ?? 3;
  const baseDelayMs = 1_000;
  const maxDelayMs = 15_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const method = opts.method ?? "GET";

  // Check cache for GET requests
  const cacheKey = method === "GET" ? url : `POST:${sha256(opts.body ?? "")}:${url}`;
  const cached = responseCache.get(cacheKey);
  if (cached && method === "GET") {
    return { ...cached, fromCache: true };
  }

  let lastError: unknown;
  let lastStatus: number | undefined;

  // Ensure at least one attempt even when maxRetries is 0 (try-once mode)
  const totalAttempts = Math.max(1, maxRetries);

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json, text/html, text/plain, */*",
          ...opts.headers,
        },
        body: opts.body,
        signal: opts.signal
          ? AbortSignal.any([opts.signal, controller.signal])
          : controller.signal,
      });

      clearTimeout(timeout);

      // Check content-length cap before reading body
      const contentLen = response.headers.get("content-length");
      if (contentLen && Number(contentLen) > maxBytes) {
        throw new Error(
          `Response content-length ${contentLen} exceeds max ${maxBytes}`,
        );
      }

      const body = await response.text();

      if (body.length > maxBytes) {
        throw new Error(
          `Response body length ${body.length} exceeds max ${maxBytes}`,
        );
      }

      const digest = sha256(body);
      const contentType = response.headers.get("content-type");

      const result: CachedFetchResult = {
        status: response.status,
        contentType,
        body,
        sha256: digest,
        fromCache: false,
      };

      // Cache successful GET responses
      if (method === "GET" && response.ok) {
        responseCache.set(cacheKey, result);
      }

      	if (!response.ok && isRetryable(response.status, null) && attempt < totalAttempts) {
		lastStatus = response.status;
		lastError = new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
		const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
		await new Promise((r) => setTimeout(r, delay));
		continue;
	}

	// Non-ok responses that can't be retried (retries exhausted or non-retryable status) must throw
	if (!response.ok) {
		throw new Error(
			`HTTP ${response.status} after ${attempt} attempt(s): ${body.slice(0, 200)}`,
		);
	}

	return result;
} catch (err: unknown) {
	lastError = err;
	if (attempt < totalAttempts && isRetryable(lastStatus, err)) {
		const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
		await new Promise((r) => setTimeout(r, delay));
		continue;
	}
	// Improve error message when retries=0 — "Exhausted 0 retries" is misleading
	if (maxRetries === 0 && lastError) {
		throw new Error(`Request failed for ${url}: ${errMsg(lastError)}`);
	}
	throw lastError;
}
  }

  // Should not reach here — only reached if the loop never ran (shouldn't happen with totalAttempts >= 1)
  throw lastError ?? new Error(`Exhausted ${maxRetries} retries for ${url}`);
}

// ── Moli fetch wrapper ─────────────────────────────────────────────────────

interface MoliResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

/**
 * Run `moli fetch --dump markdown <url>` with a timeout.
 * Returns structured result. Does NOT throw — callers check `success`.
 * Moli is expected to fail for certain pages (official Nocibé crash);
 * this is by design — the script records the limitation.
 */
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

/** Check if `moli` is available on PATH. Returns false quickly. */
async function moliAvailable(): Promise<boolean> {
  try {
    const r = await runMoliFetch("https://example.com/", 5_000);
    return r.exitCode !== null; // spawned and ran, even if it failed
  } catch {
    return false;
  }
}

// ── SIRENE / Annuaire acquisition ──────────────────────────────────────────

/**
 * Parse a SIRENE "entreprises result" (from recherche-entreprises JSON) into an
 * extracted business record focusing on the local Auch establishment.
 * Uses `matching_etablissements[0]` when available for local coordinates/address.
 */
function extractSireneRecord(
  apiResult: Record<string, unknown>,
  nominatedRecord: boolean,
  query: { q: string; page: number },
): ExtractedBusinessRecord | null {
  const siege = apiResult["siege"] as Record<string, unknown> | undefined;
  const matching = (apiResult["matching_etablissements"] as Array<Record<string, unknown>>) ?? [];
  // Use the first matching establishment (local Auch) or fall back to siege
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

/**
 * Run one Annuaire API query and return the parsed result.
 * Cached via cachedFetch.
 */
async function querySirene(
  params: Record<string, string | number>,
): Promise<{
  body: Record<string, unknown>;
  sha256: string;
  status: number;
}> {
  const queryString = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${ANNIAURE_BASE}/search?${queryString}`;

  const result = await cachedFetch(url, { retries: 3, timeoutMs: 20_000 });
  const body = JSON.parse(result.body);
  return { body: body as Record<string, unknown>, sha256: result.sha256, status: result.status };
}

/**
 * Acquire all SIRENE / Annuaire records for Auch.
 *
 * Strategy:
 *   1. Paginated commune-wide scan (q='', commune=32013, per_page=25, page=1..N).
 *   2. Targeted name queries for known leads (NOCIBE, FANTOCHE, CRU).
 *
 * Returns the assembled raw file data plus metadata.
 */
async function acquireSirene(
  rawDir: string,
  opts: Required<Pick<FetchBusinessesOptions, "maxSirenePages" | "offline" | "signal">>,
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

  // ── 1. Commune-wide scan ──────────────────────────────────
  const perPage = 25;
  const maxPages = Math.min(opts.maxSirenePages, 400);

  try {
    // First page to get total_results
    const first = await querySirene({
      q: "",
      commune: INSEE_CODE,
      per_page: perPage,
      page: 1,
    });

    totalResults = (first.body["total_results"] as number) ?? 0;
    const totalPages = Math.min(
      (first.body["total_pages"] as number) ?? Math.ceil(totalResults / perPage),
      400,
    );

    // Extract records from page 1
    const results = (first.body["results"] as Array<Record<string, unknown>>) ?? [];
    for (const r of results) {
      const rec = extractSireneRecord(r, false, { q: "", page: 1 });
      if (rec) allRecords.push(rec);
    }

    queries.push({
      query: { q: "", commune: INSEE_CODE, per_page: perPage, page: 1 },
      url: `${ANNIAURE_BASE}/search?q=&commune=${INSEE_CODE}&per_page=${perPage}&page=1`,
      status: "ok",
      httpStatus: first.status,
      sha256: first.sha256,
      recordCount: results.length,
      body: first.body,
    });

    // Paginate remaining pages
    const pagesToFetch = Math.min(maxPages, totalPages);
    if (totalResults > pagesToFetch * perPage) {
      truncated = true;
    }

    for (let page = 2; page <= pagesToFetch; page++) {
      if (opts.signal?.aborted) break;

      // Small delay between pages to be gentle to the API
      await new Promise((r) => setTimeout(r, 150));

      try {
        const pageResult = await querySirene({
          q: "",
          commune: INSEE_CODE,
          per_page: perPage,
          page,
        });

        const pageResults = (pageResult.body["results"] as Array<Record<string, unknown>>) ?? [];
        for (const r of pageResults) {
          const rec = extractSireneRecord(r, false, { q: "", page });
          if (rec) allRecords.push(rec);
        }

        queries.push({
          query: { q: "", commune: INSEE_CODE, per_page: perPage, page },
          url: `${ANNIAURE_BASE}/search?q=&commune=${INSEE_CODE}&per_page=${perPage}&page=${page}`,
          status: "ok",
          httpStatus: pageResult.status,
          sha256: pageResult.sha256,
          recordCount: pageResults.length,
          body: pageResult.body,
        });
      } catch (err: unknown) {
        failures.push({
          step: "sirene-commune-pagination",
          source: "recherche-entreprises.api.gouv.fr",
          url: `${ANNIAURE_BASE}/search?q=&commune=${INSEE_CODE}&per_page=${perPage}&page=${page}`,
          error: errMsg(err),
          severity: "warning",
        });
        queries.push({
          query: { q: "", commune: INSEE_CODE, per_page: perPage, page },
          url: `${ANNIAURE_BASE}/search?q=&commune=${INSEE_CODE}&per_page=${perPage}&page=${page}`,
          status: "error",
          error: errMsg(err),
          recordCount: 0,
          body: null,
          sha256: "",
        });
      }
    }
  } catch (err: unknown) {
    const msg = errMsg(err);
    failures.push({
      step: "sirene-commune-initial",
      source: "recherche-entreprises.api.gouv.fr",
      url: `${ANNIAURE_BASE}/search?q=&commune=${INSEE_CODE}&per_page=25&page=1`,
      error: msg,
      severity: "error",
    });
    // If the first page fails completely, we cannot continue — rethrow
    throw new Error(`SIRENE commune query failed: ${msg}`);
  }

  // ── 2. Targeted name queries ──────────────────────────────
  const nameQueries = [
    { q: "NOCIBE", label: "nocibe" },
    { q: "FANTOCHE", label: "fantoche" },
    { q: "CRU", label: "cru" },
  ];

  for (const nq of nameQueries) {
    if (opts.signal?.aborted) break;

    try {
      const result = await querySirene({
        q: nq.q,
        commune: INSEE_CODE,
        per_page: 25,
        page: 1,
      });

      const results = (result.body["results"] as Array<Record<string, unknown>>) ?? [];

      // For targeted queries, iterate all matching_etablissements
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
        query: { q: nq.q, commune: INSEE_CODE, per_page: 25, page: 1 },
        url: `${ANNIAURE_BASE}/search?q=${nq.q}&commune=${INSEE_CODE}&per_page=25&page=1`,
        status: "ok",
        httpStatus: result.status,
        sha256: result.sha256,
        recordCount: results.length,
        body: result.body,
      });
    } catch (err: unknown) {
      failures.push({
        step: `sirene-targeted-query-${nq.label}`,
        source: "recherche-entreprises.api.gouv.fr",
        url: `${ANNIAURE_BASE}/search?q=${nq.q}&commune=${INSEE_CODE}&per_page=25&page=1`,
        error: errMsg(err),
        severity: "warning",
      });
      queries.push({
        query: { q: nq.q, commune: INSEE_CODE, per_page: 25, page: 1 },
        url: `${ANNIAURE_BASE}/search?q=${nq.q}&commune=${INSEE_CODE}&per_page=25&page=1`,
        status: "error",
        error: errMsg(err),
        recordCount: 0,
        body: null,
        sha256: "",
      });
    }
  }

  // Deduplicate records by sourceId (sirene:XXXX)
  const seen = new Set<string>();
  const uniqueRecords: ExtractedBusinessRecord[] = [];
  for (const rec of allRecords) {
    if (!seen.has(rec.sourceId)) {
      seen.add(rec.sourceId);
      uniqueRecords.push(rec);
    }
  }

  const rawFile: SireneRawFile = {
    dataset: "businesses-sirene",
    sourceName: "Annuaire des Entreprises / SIRENE (recherche-entreprises.api.gouv.fr)",
    sourceUrl: ANNIAURE_BASE,
    version: "2.6",
    license: SIRENE_LICENSE,
    commune: { code: INSEE_CODE, name: COMMUNE_NAME },
    acquiredAt: new Date().toISOString(),
    totalQueries: queries.length,
    totalUniqueRecords: uniqueRecords.length,
    truncated,
    queries,
    records: uniqueRecords,
  };

  const sourceEntry: SourceManifestEntry = {
    source: `recherche-entreprises.api.gouv.fr (${SIRENE_LICENSE})`,
    url: `${ANNIAURE_BASE}/search`,
    query: `q=&commune=${INSEE_CODE}&per_page=${perPage}`,
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

// ── OSM business records acquisition ────────────────────────────────────────

/** Build the Overpass QL query text for business records within the bbox. */
function buildBusinessOverpassQuery(): string {
  const { south, west, north, east } = BBOX;
  const bbox = `${south},${west},${north},${east}`;
  return [
    "[out:json][timeout:90];",
    "(",
    // Shops
    `  node["shop"]["name"](${bbox});`,
    `  way["shop"]["name"](${bbox});`,
    `  relation["shop"]["name"](${bbox});`,
    // Offices
    `  node["office"]["name"](${bbox});`,
    `  way["office"]["name"](${bbox});`,
    // Craft businesses
    `  node["craft"]["name"](${bbox});`,
    `  way["craft"]["name"](${bbox});`,
    // Commercial amenities with known business category
    `  node["amenity"]~"^(restaurant|cafe|bar|fast_food|pharmacy|bank|cinema|fuel|hotel|hostel|pub|biergarten|ice_cream|car_rental|car_wash|charging_station|atm|library|theatre|nightclub|casino|clinic|dentist|doctors|veterinary|post_office|marketplace|shopping_centre)$"["name"](${bbox});`,
    `  way["amenity"]~"^(restaurant|cafe|bar|fast_food|pharmacy|bank|cinema|fuel|hotel|hostel|pub|biergarten|ice_cream|car_rental|car_wash|charging_station|atm|library|theatre|nightclub|casino|clinic|dentist|doctors|veterinary|post_office|marketplace|shopping_centre)$"["name"](${bbox});`,
    ");",
    "out center tags;",
  ].join("\n");
}

/**
 * Acquire OSM business records via Overpass.
 * Tries endpoints in order with bounded retries.
 */
async function acquireOsmBusiness(
  rawDir: string,
  opts: Pick<FetchBusinessesOptions, "offline" | "signal">,
): Promise<{
  rawFile: OsmRawFile;
  sources: SourceManifestEntry[];
  failures: FailureEntry[];
  counts: Record<string, number>;
}> {
  const failures: FailureEntry[] = [];
  const queryText = buildBusinessOverpassQuery();
  	const maxRetries = 4; // total across endpoints
	let lastError: unknown;
	let responseBody: string | null = null;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		if (opts.signal?.aborted) break;

		// Cycle through endpoints
		const endpoint =
			OVERPASS_ENDPOINTS[(attempt - 1) % OVERPASS_ENDPOINTS.length]!;
		const url = endpoint;

		try {
			const result = await cachedFetch(url, {
				method: "POST",
				body: `data=${encodeURIComponent(queryText)}`,
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				timeoutMs: 120_000,
				retries: 0, // outer loop controls all retry attempts
			});

      if (!result.body.trim()) {
        throw new Error("Empty response body");
      }

      // Validate it's Overpass JSON: must have osm3s timestamp
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(result.body) as Record<string, unknown>;
      } catch {
        throw new Error(`Invalid JSON from Overpass: ${result.body.slice(0, 200)}`);
      }

      const osm3s = parsed["osm3s"] as Record<string, unknown> | undefined;
      if (!osm3s?.["timestamp_osm_base"]) {
        throw new Error(
          `Missing osm3s timestamp in Overpass response — likely not a valid Overpass response`,
        );
      }

      responseBody = result.body;
      break; // success
    } catch (err: unknown) {
      lastError = err;
      const msg = errMsg(err);
      failures.push({
        step: `osm-business-query-${attempt}`,
        source: endpoint,
        url,
        error: msg,
        severity: "warning",
      });

      if (attempt < maxRetries) {
        const delay = backoffDelay(attempt, 2_000, 20_000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  if (responseBody === null) {
    const msg = `All Overpass endpoints failed for business query: ${errMsg(lastError)}`;
    failures.push({
      step: "osm-business-final",
      source: "Overpass",
      error: msg,
      severity: "warning",
    });

    // Write failure record
    const rawFile: OsmRawFile = {
      dataset: "businesses-osm",
      sourceName: "OpenStreetMap (Overpass API)",
      sourceUrls: [...OVERPASS_ENDPOINTS],
      license: OSM_LICENSE,
      commune: { code: INSEE_CODE, name: COMMUNE_NAME },
      bbox: { ...BBOX },
      queryText,
      acquiredAt: new Date().toISOString(),
      elementCount: 0,
      status: "error",
      error: msg,
      sha256: "",
      body: null,
    };
    return {
      rawFile,
      sources: [
        {
          source: `Overpass API — businesses`,
          query: queryText.slice(0, 200),
          acquiredAt: rawFile.acquiredAt,
          license: OSM_LICENSE,
          recordCount: 0,
          status: "failed",
          error: msg,
        },
      ],
      failures,
      counts: { osmBusinessElements: 0 },
    };
  }

  const parsedBody = JSON.parse(responseBody) as Record<string, unknown>;
  const elements = (parsedBody["elements"] as Array<Record<string, unknown>>) ?? [];

  const rawFile: OsmRawFile = {
    dataset: "businesses-osm",
    sourceName: "OpenStreetMap (Overpass API)",
    sourceUrls: [...OVERPASS_ENDPOINTS],
    license: OSM_LICENSE,
    commune: { code: INSEE_CODE, name: COMMUNE_NAME },
    bbox: { ...BBOX },
    queryText,
    acquiredAt: new Date().toISOString(),
    elementCount: elements.length,
    status: "ok",
    sha256: sha256(responseBody),
    body: parsedBody,
  };

  // Determine which endpoint succeeded (the last attempt that didn't error)
  const source: SourceManifestEntry = {
    source: "OpenStreetMap (Overpass API) — businesses",
    url: OVERPASS_ENDPOINTS[0],
    query: queryText.slice(0, 300),
    acquiredAt: rawFile.acquiredAt,
    license: OSM_LICENSE,
    recordCount: elements.length,
    status: "ok",
    sha256: rawFile.sha256,
  };

  return {
    rawFile,
    sources: [source],
    failures,
    counts: { osmBusinessElements: elements.length },
  };
}

// ── Web page acquisition ───────────────────────────────────────────────────

/**
 * Attempt plain HTTP fetch of a business page, fall back to Moli for rendered pages.
 */
async function acquireWebBusinessPages(
  rawDir: string,
  opts: Pick<FetchBusinessesOptions, "offline" | "signal">,
): Promise<{
  rawFile: WebRawFile;
  sources: SourceManifestEntry[];
  failures: FailureEntry[];
  counts: Record<string, number>;
}> {
  const failures: FailureEntry[] = [];
  const results: WebPageResult[] = [];
  const hasMoli = await moliAvailable();

  for (const target of KNOWN_BUSINESS_TARGETS) {
    if (opts.signal?.aborted) break;

    // ── Try plain HTTP first ──────────────────────────────
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
        retries: 2,
        maxBytes: 512_000,
        headers: { Accept: "text/html,text/plain,*/*" },
      });

      pageResult.httpStatus = httpResult.status;
      pageResult.acquiredAt = new Date().toISOString();

      if (httpResult.ok) {
        pageResult.fetchedVia = "http";
        pageResult.status = "ok";

        // Extract basic metadata from HTML
        const body = httpResult.body;
        const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
        pageResult.title = titleMatch?.[1]?.trim() ?? "";

        // Look for name/address/phone patterns (simple heuristics — not exhaustive)
        const nameMatch = body.match(
          /(?:business-name|company-name|h1|org|brand)[^>]*>([^<]{2,80})</i,
        );
        if (nameMatch && !pageResult.name) {
          pageResult.name = nameMatch[1]!.trim();
        }

        // Truncated text excerpt
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

        // For PagesJaunes, check for "Nocibé" in content
        if (target.id.startsWith("nocibe") && /Nocib[éèe]/i.test(body)) {
          pageResult.name = "Nocibé";
        }
      } else if (httpResult.status === 404) {
        pageResult.status = "not-found";
        pageResult.note = `HTTP 404`;
      } else {
        // Non-ok but not 404 — may need Moli for JS-rendered page
        pageResult.status = "blocked";
        pageResult.note = `HTTP ${httpResult.status}`;
      }
    } catch (err: unknown) {
      // Plain HTTP failed — try Moli
      pageResult.fetchedVia = "none";
      pageResult.status = "error";
      pageResult.note = `HTTP fetch error: ${errMsg(err)}`;
    }

    // ── Fall back to Moli (rendered page) if http failed or blocked ────
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

          // Extract markdown title (first #-heading or first line)
          const lines = moliResult.stdout.split("\n").filter((l) => l.trim());
          pageResult.textTruncated = moliResult.stdout.slice(0, 8_000);
          if (lines.length > 0) {
            pageResult.title =
              lines.find((l) => /^#/.test(l))?.replace(/^#+\s*/, "") ?? lines[0]!.slice(0, 120);
          }

          pageResult.note = `Moli fetch OK (${moliResult.stdout.length}B)`;
          pageResult.confidence = target.priority === "high" ? "high" : "medium";
        } else {
          // Moli failed — record the limitation
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

// ── Main orchestrator ──────────────────────────────────────────────────────

/**
 * Fetch all business records for Auch and write raw files.
 *
 * @param options  Configuration overrides.
 * @returns Summary with source entries, failures, and counts.
 */
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
		// Offline mode: read existing raw files, skip all network.
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
				// Optional file missing — record but don't fail
				allFailures.push({
					step: `offline-missing-${name}`,
					source: `raw:${name}`,
					error: `Optional raw file ${p} not found — skipping`,
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

	// ── 1. SIRENE / Annuaire ─────────────────────────────────
	{
		const result = await acquireSirene(rawDir, {
			maxSirenePages: options.maxSirenePages ?? 30,
			offline: false,
			signal: options.signal ?? undefined,
		});

		const outPath = path.join(rawDir, "businesses-sirene.json");
		await writeFile(outPath, JSON.stringify(result.rawFile, null, 2), "utf-8");
		rawFiles.push(outPath);

		allSources.push(...result.sources);
		allFailures.push(...result.failures);
		Object.assign(allCounts, result.counts);
	}

	// ── 2. OSM business records ─────────────────────────────
	{
		const result = await acquireOsmBusiness(rawDir, {});

		const outPath = path.join(rawDir, "businesses-osm.json");
		await writeFile(outPath, JSON.stringify(result.rawFile, null, 2), "utf-8");
		rawFiles.push(outPath);

		allSources.push(...result.sources);
		allFailures.push(...result.failures);
		Object.assign(allCounts, result.counts);
	}

	// ── 3. Web business pages ───────────────────────────────
	{
		const result = await acquireWebBusinessPages(rawDir, {});

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

  // If SIRENE returned no records, the entire acquisition is failed
  if (!allCounts["sireneRecords"]) {
    allFailures.push({
      step: "final",
      source: "sirene",
      error: "No SIRENE records were acquired — required data missing",
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

// ── Standalone runner ───────────────────────────────────────────────────────

/**
 * Detect if this module is executed directly (vs imported).
 */
function isDirectRun(): boolean {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const arg = process.argv[1];
    return !!arg && path.resolve(arg) === selfPath;
  } catch {
    // Fallback when import.meta.url is unavailable (CommonJS via tsx)
    const arg = process.argv[1];
    return (
      !!arg &&
      (arg.endsWith("/fetch-businesses.ts") ||
        arg.endsWith("\\fetch-businesses.ts") ||
        arg.endsWith("fetch-businesses.js"))
    );
  }
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  const flags = {
    offline: argv.includes("--offline"),
    dataDir: undefined as string | undefined,
  };

  const dataIdx = argv.indexOf("--data-dir");
  if (dataIdx !== -1 && dataIdx + 1 < argv.length) {
    flags.dataDir = argv[dataIdx + 1]!;
  }

  const maxPagesIdx = argv.indexOf("--max-pages");
  if (maxPagesIdx !== -1 && maxPagesIdx + 1 < argv.length) {
    const val = parseInt(argv[maxPagesIdx + 1]!, 10);
    if (!isNaN(val)) {
      process.env["_MAX_SIRENE_PAGES"] = String(val);
    }
  }

  fetchBusinesses({
    dataDir: flags.dataDir,
    offline: flags.offline,
    maxSirenePages: parseInt(process.env["_MAX_SIRENE_PAGES"] ?? "30", 10),
  })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      const errorCount = result.failures.filter((f) => f.severity === "error").length;
      if (errorCount > 0) {
        process.exit(1);
      }
      const warningCount = result.failures.length;
      if (warningCount > 0) {
        console.error(
          `Completed with ${warningCount} warning(s):`,
          result.failures.map((f) => `  ${f.step}: ${f.error}`).join("\n"),
        );
      }
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error("Fatal error:", errMsg(err));
      process.exit(1);
    });
}