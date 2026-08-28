import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface AcquisitionOutcome {
  url: string;
  path: string;
  fromCache: boolean;
  httpStatus: number;
  bytesDownloaded: number;
  contentLength: number;
  sha256: string;
  etag?: string;
  lastModified?: string;
  acquiredAt: string;
  checkedAt: string;
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
}

const MAX_ATTEMPTS = 4;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_JSON_MAX_BYTES = 1_024 * 1_024;
const RETRYABLE_STATUS: Record<number, boolean> = { 408: true, 425: true, 429: true, 500: true, 502: true, 503: true, 504: true };

interface RequestStats {
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
}

interface FileCacheMetadata {
  url: string;
  etag?: string;
  lastModified?: string;
  sha256: string;
  contentLength: number;
  acquiredAt: string;
  checkedAt: string;
}

interface JsonCacheRecord {
  url: string;
  method: "GET" | "POST";
  requestedAt: string;
  httpStatus: number;
  sha256: string;
  body: string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("The acquisition request was aborted");
  error.name = "AbortError";
  return error;
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, seconds * 1_000);
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - Date.now()));
}

function backoffMilliseconds(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (attempt - 1));
  return base * (0.8 + Math.random() * 0.4);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

async function requestWithRetry(
  url: string,
  init: RequestInit,
  stats: RequestStats,
): Promise<Response> {
  const signal = init.signal ?? undefined;
  let lastError: unknown = undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw abortError();
    stats.requestCount += 1;
    try {
      const response = await fetch(url, init);
      const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"));
      const retryable = RETRYABLE_STATUS[response.status] === true;
      if (retryable && response.status === 429) stats.rateLimitCount += 1;
      if (retryable && attempt < MAX_ATTEMPTS) {
        await cancelBody(response);
        stats.retryCount += 1;
        await delay(retryAfter ?? backoffMilliseconds(attempt), signal);
        continue;
      }
      return response;
    } catch (error: unknown) {
      lastError = error;
      if (isAbortError(error) || signal?.aborted) throw error;
      if (attempt >= MAX_ATTEMPTS) throw error;
      stats.retryCount += 1;
      await delay(backoffMilliseconds(attempt), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Request failed for ${url}`);
}

function isFileCacheMetadata(value: unknown): value is FileCacheMetadata {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.url === "string"
    && typeof record.sha256 === "string"
    && typeof record.contentLength === "number"
    && Number.isFinite(record.contentLength)
    && typeof record.acquiredAt === "string"
    && typeof record.checkedAt === "string"
    && (record.etag === undefined || typeof record.etag === "string")
    && (record.lastModified === undefined || typeof record.lastModified === "string");
}

function isJsonCacheRecord(value: unknown): value is JsonCacheRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.url === "string"
    && (record.method === "GET" || record.method === "POST")
    && typeof record.requestedAt === "string"
    && typeof record.httpStatus === "number"
    && Number.isInteger(record.httpStatus)
    && typeof record.sha256 === "string"
    && typeof record.body === "string";
}

function hashString(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const partialPath = `${filePath}.part`;
  try {
    await writeFile(partialPath, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(partialPath, filePath);
  } catch (error: unknown) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
}

async function readFileCacheMetadata(metadataPath: string): Promise<FileCacheMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
    return isFileCacheMetadata(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function acquireFile(options: {
  url: string;
  destination: string;
  forceRefresh?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<AcquisitionOutcome> {
  const metadataPath = `${options.destination}.cache.json`;
  const metadata = options.forceRefresh === true ? null : await readFileCacheMetadata(metadataPath);
  let destinationExists = false;
  if (metadata !== null && metadata.url === options.url) {
    try {
      destinationExists = (await stat(options.destination)).isFile();
    } catch {
      destinationExists = false;
    }
  }
  const cacheReady = metadata !== null && metadata.url === options.url && destinationExists;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (cacheReady && metadata !== null) {
    if (metadata.etag !== undefined && metadata.etag !== "") headers["If-None-Match"] = metadata.etag;
    if (metadata.lastModified !== undefined && metadata.lastModified !== "") headers["If-Modified-Since"] = metadata.lastModified;
  }
  const stats: RequestStats = { requestCount: 0, retryCount: 0, rateLimitCount: 0 };
  const response = await requestWithRetry(options.url, { method: "GET", headers, signal: options.signal }, stats);
  const checkedAt = new Date().toISOString();

  if (response.status === 304) {
    await cancelBody(response);
    if (!cacheReady || metadata === null) throw new Error(`HTTP 304 for ${options.url} without a valid cached file`);
    await writeJsonAtomically(metadataPath, { ...metadata, checkedAt });
    const outcome: AcquisitionOutcome = {
      url: options.url,
      path: options.destination,
      fromCache: true,
      httpStatus: 304,
      bytesDownloaded: 0,
      contentLength: metadata.contentLength,
      sha256: metadata.sha256,
      acquiredAt: metadata.acquiredAt,
      checkedAt,
      requestCount: stats.requestCount,
      retryCount: stats.retryCount,
      rateLimitCount: stats.rateLimitCount,
    };
    if (metadata.etag !== undefined) outcome.etag = metadata.etag;
    if (metadata.lastModified !== undefined) outcome.lastModified = metadata.lastModified;
    return outcome;
  }

  if (response.status !== 200 || response.body === null) {
    await cancelBody(response);
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${options.url}`);
  }

  await mkdir(path.dirname(options.destination), { recursive: true });
  const partialPath = `${options.destination}.part`;
  const digest = createHash("sha256");
  let bytesDownloaded = 0;
  const hashing = new Transform({
    transform(chunk: Buffer | string, _encoding, callback): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      digest.update(buffer);
      bytesDownloaded += buffer.length;
      callback(null, buffer);
    },
  });

  try {
    await unlink(partialPath).catch(() => undefined);
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), hashing, createWriteStream(partialPath));
    const sha256 = digest.digest("hex");
    await rename(partialPath, options.destination);
    const contentLengthHeader = Number(response.headers.get("content-length"));
    const contentLength = Number.isFinite(contentLengthHeader) && contentLengthHeader >= 0 ? contentLengthHeader : bytesDownloaded;
    const etag = response.headers.get("etag") ?? undefined;
    const lastModified = response.headers.get("last-modified") ?? undefined;
    const fileMetadata: FileCacheMetadata = { url: options.url, sha256, contentLength, acquiredAt: checkedAt, checkedAt };
    if (etag !== undefined) fileMetadata.etag = etag;
    if (lastModified !== undefined) fileMetadata.lastModified = lastModified;
    await writeJsonAtomically(metadataPath, fileMetadata);
    return {
      url: options.url,
      path: options.destination,
      fromCache: false,
      httpStatus: response.status,
      bytesDownloaded,
      contentLength,
      sha256,
      etag,
      lastModified,
      acquiredAt: checkedAt,
      checkedAt,
      requestCount: stats.requestCount,
      retryCount: stats.retryCount,
      rateLimitCount: stats.rateLimitCount,
    };
  } catch (error: unknown) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
}

export async function acquireJson(options: {
  url: string;
  cacheKey?: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  maxBytes?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
}): Promise<{
  body: string;
  sha256: string;
  httpStatus: number;
  fromCache: boolean;
  bytesDownloaded: number;
  requestCount: number;
  retryCount: number;
  rateLimitCount: number;
}> {
  const method = options.method ?? "GET";
  const requestBody = options.body ?? "";
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_MAX_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes < 0) throw new Error(`Invalid maxBytes ${maxBytes} for ${options.url}`);
  const cacheDirectory = path.join(process.env.MASTER_MAPS_DATA_DIR ?? "data", "raw", ".http-cache");
  const cacheIdentity = options.cacheKey ?? `${method}${options.url}${requestBody}`;
  const cachePath = path.join(cacheDirectory, `${hashString(cacheIdentity)}.json`);
  let cached: JsonCacheRecord | null = null;
  if (options.forceRefresh !== true) {
    try {
      const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
      if (isJsonCacheRecord(parsed) && parsed.url === options.url && parsed.method === method && parsed.sha256 === hashString(parsed.body) && Buffer.byteLength(parsed.body, "utf8") <= maxBytes) cached = parsed;
    } catch {
      cached = null;
    }
  }
  if (cached !== null) {
    return {
      body: cached.body,
      sha256: cached.sha256,
      httpStatus: cached.httpStatus,
      fromCache: true,
      bytesDownloaded: 0,
      requestCount: 0,
      retryCount: 0,
      rateLimitCount: 0,
    };
  }
  const stats: RequestStats = { requestCount: 0, retryCount: 0, rateLimitCount: 0 };
  const init: RequestInit = { method, headers: options.headers, signal: options.signal };
  if (method === "POST") init.body = requestBody;
  const response = await requestWithRetry(options.url, init, stats);
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${options.url}`);
  }
  const contentLengthHeader = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLengthHeader) && contentLengthHeader > maxBytes) {
    await cancelBody(response);
    throw new Error(`Response content-length ${contentLengthHeader} exceeds max ${maxBytes} for ${options.url}`);
  }
  const responseBody = await response.text();
  const bytesDownloaded = Buffer.byteLength(responseBody, "utf8");
  if (bytesDownloaded > maxBytes) throw new Error(`Response body exceeds max ${maxBytes} for ${options.url}`);
  const digest = hashString(responseBody);
  const record: JsonCacheRecord = {
    url: options.url,
    method,
    requestedAt: new Date().toISOString(),
    httpStatus: response.status,
    sha256: digest,
    body: responseBody,
  };
  await mkdir(cacheDirectory, { recursive: true });
  await writeJsonAtomically(cachePath, record);
  return {
    body: responseBody,
    sha256: digest,
    httpStatus: response.status,
    fromCache: false,
    bytesDownloaded,
    requestCount: stats.requestCount,
    retryCount: stats.retryCount,
    rateLimitCount: stats.rateLimitCount,
  };
}

export function createRateLimiter(requestsPerSecond: number): { acquire(): Promise<void> } {
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond <= 0) throw new Error("requestsPerSecond must be greater than zero");
  const capacity = requestsPerSecond;
  let tokens = capacity;
  let lastRefill = Date.now();
  let queue: Promise<void> = Promise.resolve();

  const waitForToken = async (): Promise<void> => {
    for (;;) {
      const now = Date.now();
      tokens = Math.min(capacity, tokens + ((now - lastRefill) * requestsPerSecond) / 1_000);
      lastRefill = now;
      if (tokens >= 1) {
        tokens -= 1;
        return;
      }
      await delay(((1 - tokens) * 1_000) / requestsPerSecond);
    }
  };

  return {
    acquire(): Promise<void> {
      const next = queue.then(waitForToken);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
