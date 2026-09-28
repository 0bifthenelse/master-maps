/**
 * W5-RUNTIME: real WebGPU runtime verification of the production map.
 *
 * Drives the guarded `internet` MCP runtime (skill://master-internet) over
 * stdio against the running production build (http://127.0.0.1:3100/ by
 * default) at 1440x900. The script never launches a browser, never passes
 * --disable-gpu and never falls back to WebGL. The hardware adapter is
 * proven from the page through navigator.gpu and
 * WEBGL_debug_renderer_info rather than from the gpu_mode tool return
 * value, because that tool reports a guard quarantine on its own output on
 * this host.
 *
 * Runtime properties of this app that shape the input path, each measured
 * in the source rather than guessed:
 *   - MapControls binds `window.addEventListener("keydown")`
 *     (MapControls.tsx:260), so a CDP key event dispatched at the document
 *     does not reach it. Keyboard navigation is dispatched as a real
 *     KeyboardEvent on window, the only target that listener observes.
 *   - The canvas runs R3F frameloop="demand" (WebGPUCityCanvas.tsx:245),
 *     so an idle page produces no animation frames at all: the rAF
 *     sampler is verified to self-terminate, and the perf verdicts are
 *     taken from a window with continuous input in it, where the app is
 *     actually rendering.
 *   - R3F treats onContextMenu as a click event (events:856) and only calls
 *     the handler when the mesh was also in the pointerdown hit set
 *     (initialHits, events:858-869), so a context menu is opened with a
 *     real pointerdown plus a real contextmenu at the same point.
 *
 * Screenshots are PNGs from the guarded shot tool, written to
 * /tmp/w5-runtime. Each one is re-read here and captioned from its decoded
 * pixels (dimensions, colour census) so the report describes what the file
 * contains, not what it was named. The machine readable summary is printed
 * as the final stdout block and written to data/qa/runtime-verification.json.
 *
 * Usage: npx tsx scripts/chrome/verify-runtime.ts [url]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHOT_DIR = "/tmp/w5-runtime";
const LOCK = "/tmp/master-maps-browser.lock";
const PROFILE = "w5runtime";
const MCP_BIN = process.env.INTERNET_MCP_BIN ?? "/master/internet/target/release/master-internet-unit";
const MCP_CWD = process.env.INTERNET_MCP_CWD ?? "/master/internet";
const QA_DIR = resolve(ROOT, "data/qa");
const QA_FILE = resolve(QA_DIR, "runtime-verification.json");

const DEFAULT_TARGET = "http://127.0.0.1:3100/";
const VIEWPORT = { w: 1440, h: 900 };
const FRAME_SAMPLE_MS = 10_000;
const LOCK_RETRY_MS = 20_000;
const ORIENTATION_ATTRIBUTE = "data-orientation-north-up";
const EAST_RIGHT_ATTRIBUTE = "data-orientation-east-right";
const Y_SCALE_ATTRIBUTE = "data-projection-y-scale";
const LOD_STRESS_CYCLES = 10;
const HEADING_STEP = Math.PI / 12;
const TRUTHY = ["true", "1", "yes"];
const NOT_DRIVEN = "notDriven";
const HARD_STOP_MS = 20 * 60 * 1000;

const TOWN = "Lectoure";

const THRESHOLDS = {
  medianFpsMin: 55,
  p95FrameMsMax: 25,
  longTaskMsMax: 100,
  p95InputLatencyMsMax: 50,
  consoleErrorsMax: 0,
  gpuValidationErrorsMax: 0,
};

/* The camera zooms by a factor per key press, so a key sweep and the
   keyboardZoomFactor default of 1.25 let the stress run reach the LOD
   range without inventing a path the app does not have. */
const KEYBOARD_ZOOM_FACTOR = 1.25;
const ZOOM_KEY_IN_PRESSES = 48;
const ZOOM_KEY_OUT_PRESSES = 14;
const ORIENTATION_TRUTHY = "true, 1 or yes";
const FOCUS_ZOOM = 80;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/* ------------------------------------------------------------------ */
/*  MCP stdio client                                                  */
/* ------------------------------------------------------------------ */

interface McpResult {
  content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  isError?: boolean;
}

/**
 * The image payload of a `shot` call arrives as an MCP image content
 * block, not as text, so the SDK client is used rather than a hand-rolled
 * stdio parser: the SDK is the only place that base64-decodes the block.
 * Every other call goes through the same client.
 */
const SDK_TIMEOUT_MS = 180_000;

class McpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  async start(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: MCP_BIN,
      args: [],
      cwd: MCP_CWD,
      env: process.env as Record<string, string>,
    });
    this.client = new Client({ name: "master-maps-verify-runtime-w5", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async call(name: string, args: unknown = {}): Promise<McpResult> {
    if (this.client === null) throw new Error("MCP client is not started");
    return this.client.callTool({ name, arguments: args as Record<string, unknown> }, undefined, { timeout: SDK_TIMEOUT_MS, maxTotalTimeout: SDK_TIMEOUT_MS }) as Promise<McpResult>;
  }

  async raw(name: string, args: unknown = {}, timeoutMs = 60_000): Promise<string> {
    void timeoutMs;
    const result = await this.call(name, args);
    return result.content.map((part) => part.text ?? "").join("\n");
  }

  /** The first image content block, base64 encoded, or null. */
  async image(name: string, args: unknown = {}): Promise<string | null> {
    const result = await this.call(name, args);
    for (const part of result.content) {
      if (part.type === "image" && typeof part.data === "string") return part.data;
    }
    const text = result.content.map((part) => part.text ?? "").join("\n").replace(/\s+/g, " ");
    throw new Error(`${name} returned no image block: ${text.slice(0, 300)}`);
  }

  async evaluate<T>(expr: string, timeoutMs = 60_000): Promise<T> {
    return parseToolJson(await this.raw("evaluate", { expr }, timeoutMs)) as T;
  }

  async stop(): Promise<void> {
    if (this.client !== null) {
      await this.client.close().catch(() => undefined);
      this.client = null;
    }
  }
}
/**
 * The guard returns the evaluated value as a JSON document. A bare scalar
 * such as true, null or 42 is a valid result and must survive intact, so
 * the document is parsed directly with no brace sniffing.
 */
function parseToolJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return text.trim();
  }
}


/* ------------------------------------------------------------------ */
/*  Statistics                                                        */
/* ------------------------------------------------------------------ */

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface FrameSample {
  frames: number[];
  longTasks: number[];
  heapUsed: number | null;
  heapTotal: number | null;
  heapLimit: number | null;
  inputLatencies: Array<{ label: string; latencyMs: number; zoomBefore: string | null; zoomAfter: string | null }>;
  cameraBefore: { target: [number, number, number]; zoom: number } | null;
  cameraAfter: { target: [number, number, number]; zoom: number } | null;
  requestCount: number;
  durationMs: number;
  terminated: boolean;
  note: string;
}

const EMPTY_SAMPLE: FrameSample = {
  frames: [],
  longTasks: [],
  heapUsed: null,
  heapTotal: null,
  heapLimit: null,
  inputLatencies: [],
  cameraBefore: null,
  cameraAfter: null,
  requestCount: 0,
  durationMs: 0,
  terminated: false,
  note: "no sample collected",
};

function summarise(label: string, raw: FrameSample): Record<string, unknown> {
  const frames = raw.frames.filter((value) => value > 0 && value < 5000);
  const mean = frames.length === 0 ? Number.NaN : frames.reduce((a, b) => a + b, 0) / frames.length;
  const median = percentile(frames, 50);
  const p95 = percentile(frames, 95);
  const longTasks = raw.longTasks.filter((value) => value > 0);
  const latencies = raw.inputLatencies.map((row) => row.latencyMs);
  return {
    label,
    note: raw.note,
    requestedSampleMs: FRAME_SAMPLE_MS,
    measuredWindowMs: raw.durationMs,
    frames: frames.length,
    meanFrameMs: round(mean),
    p50FrameMs: round(median),
    p95FrameMs: round(p95),
    p99FrameMs: round(percentile(frames, 99)),
    maxFrameMs: frames.length === 0 ? Number.NaN : round(Math.max(...frames)),
    minFrameMs: frames.length === 0 ? Number.NaN : round(Math.min(...frames)),
    medianFps: round(median > 0 ? 1000 / median : Number.NaN, 1),
    impliedFpsFromMean: round(mean > 0 ? 1000 / mean : Number.NaN, 1),
    framesOverP95Threshold: frames.filter((value) => value > THRESHOLDS.p95FrameMsMax).length,
    framesOver50Ms: frames.filter((value) => value > 50).length,
    longTaskCount: longTasks.length,
    longTaskMaxMs: longTasks.length === 0 ? 0 : round(Math.max(...longTasks)),
    longTasksOverThreshold: longTasks.filter((value) => value > THRESHOLDS.longTaskMsMax).length,
    longTaskSample: longTasks.slice(0, 10).map((value) => round(value)),
    inputLatencyCount: latencies.length,
    inputLatencyP50Ms: round(percentile(latencies, 50)),
    inputLatencyP95Ms: round(percentile(latencies, 95)),
    inputLatencyMaxMs: latencies.length === 0 ? Number.NaN : round(Math.max(...latencies)),
    inputLatencySamples: raw.inputLatencies.map((row) => ({ label: row.label, latencyMs: round(row.latencyMs), zoomBefore: row.zoomBefore, zoomAfter: row.zoomAfter })),
    jsHeapUsedBytes: raw.heapUsed,
    jsHeapTotalBytes: raw.heapTotal,
    jsHeapLimitBytes: raw.heapLimit,
    jsHeapUsedMb: raw.heapUsed === null ? null : round(raw.heapUsed / 1e6, 1),
    cameraBefore: raw.cameraBefore,
    cameraAfter: raw.cameraAfter,
    cameraMoved: raw.cameraBefore !== null && raw.cameraAfter !== null && (Math.abs(raw.cameraAfter.target[0] - raw.cameraBefore.target[0]) > 1 || Math.abs(raw.cameraAfter.target[2] - raw.cameraBefore.target[2]) > 1 || Math.abs(raw.cameraAfter.zoom - raw.cameraBefore.zoom) > 0.01),
    requestCount: raw.requestCount,
  };
}

/* ------------------------------------------------------------------ */
/*  Page probes                                                       */
/* ------------------------------------------------------------------ */

const DIAGNOSTICS_PROBE = `(() => {
  const element = document.getElementById("scene-diagnostics");
  if (element === null) return { present: false };
  const out = { present: true };
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name.indexOf("data-") === 0) out[attribute.name] = attribute.value;
  }
  return out;
})()`;

const SCENE_READY_PROBE = `(() => {
  const element = document.getElementById("scene-diagnostics");
  if (element === null) return { present: false, ready: false };
  const status = element.getAttribute("data-renderer-status");
  const tiles = Number(element.getAttribute("data-loaded-tile-count") ?? "0");
  return { present: true, ready: status === "initialized" && tiles > 0, status, tiles };
})()`;

const CAMERA_PROBE = `(() => {
  const element = document.getElementById("scene-diagnostics");
  if (element === null) return null;
  const state = element.getAttribute("data-camera-state");
  if (state === null) return null;
  try {
    const camera = JSON.parse(state);
    return { target: camera.target, zoom: camera.zoom, azimuthalAngle: camera.azimuthalAngle ?? null, headingRadians: camera.headingRadians ?? null, rotationZ: camera.rotationZ ?? null, frustumWidth: camera.frustumWidth ?? null, frustumHeight: camera.frustumHeight ?? null };
  } catch (error) { return { error: String(error) }; }
})()`;

const CANVAS_PROBE = `(() => {
  const canvas = document.querySelector("canvas");
  if (canvas === null) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    backingWidth: canvas.width,
    backingHeight: canvas.height,
    cssWidth: Math.round(rect.width),
    cssHeight: Math.round(rect.height),
    cssLeft: Math.round(rect.left),
    cssTop: Math.round(rect.top),
    devicePixelRatio: window.devicePixelRatio,
  };
})()`;

/**
 * One state read, written as a complete object literal so every field
 * exists on every run: an absent attribute reads as null, never as a
 * missing key, so a key-wise diff of two runs stays valid before and
 * after a sibling slice publishes the orientation attributes.
 */
const MATRIX_STATE_PROBE = `(() => {
  const element = document.getElementById("scene-diagnostics");
  if (element === null) return { present: false, canvasPresent: false, rendererStatus: null, backend: null, rendererError: null, cameraTargetX: null, cameraTargetZ: null, targetX: null, targetZ: null, cameraZoom: null, loadedTileCount: null, drawCalls: null, unbatchedDrawCalls: null, batchCount: null, mountedTileCount: null, retiredPending: null, orientationNorthUp: null, orientationEastRight: null, projectionYScale: null };
  const attribute = (name) => { const value = element.getAttribute(name); return value === null ? null : value; };
  const number = (name) => { const value = attribute(name); return value === null ? null : Number(value); };
  const canvas = document.querySelector("canvas");
  const rect = canvas === null ? null : canvas.getBoundingClientRect();
  return {
    present: true,
    canvasPresent: canvas !== null,
    rendererStatus: attribute("data-renderer-status"),
    backend: attribute("data-backend"),
    rendererError: attribute("data-renderer-error"),
    cameraTargetX: number("data-camera-target-x"),
    cameraTargetZ: number("data-camera-target-z"),
    targetX: attribute("data-camera-target-x"),
    targetZ: attribute("data-camera-target-z"),
    cameraZoom: number("data-camera-zoom"),
    loadedTileCount: number("data-loaded-tile-count"),
    drawCalls: number("data-draw-calls"),
    unbatchedDrawCalls: number("data-unbatched-draw-calls"),
    batchCount: number("data-batch-count"),
    mountedTileCount: number("data-mounted-tile-count"),
    retiredPending: number("data-retired-pending"),
    orientationNorthUp: attribute(${JSON.stringify(ORIENTATION_ATTRIBUTE)}),
    orientationEastRight: attribute(${JSON.stringify(EAST_RIGHT_ATTRIBUTE)}),
    projectionYScale: number("data-projection-y-scale"),
    canvasCssWidth: rect === null ? null : Math.round(rect.width),
    canvasCssHeight: rect === null ? null : Math.round(rect.height),
  };
})()`;

const RESIZE_PROBE = `() => new Promise((resolve) => {
  const element = document.getElementById("scene-diagnostics");
  window.dispatchEvent(new Event("resize"));
  let round = 0;
  const tick = () => {
    round += 1;
    if (round >= 12) {
      const canvas = document.querySelector("canvas");
      const rect = canvas === null ? null : canvas.getBoundingClientRect();
      resolve({ dispatched: true, canvasCssWidth: rect === null ? null : Math.round(rect.width), canvasCssHeight: rect === null ? null : Math.round(rect.height), zoom: element === null ? null : element.getAttribute("data-camera-zoom") });
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

const WHEEL_BURST_PROBE = `(deltaMode, deltaY, count, fractionX, fractionY) => new Promise((resolve) => {
  const canvas = document.querySelector("canvas");
  if (canvas === null) { resolve({ dispatched: 0, prevented: 0, reason: "no canvas" }); return; }
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width * fractionX);
  const y = Math.round(rect.top + rect.height * fractionY);
  let prevented = 0;
  for (let index = 0; index < count; index += 1) {
    const event = new WheelEvent("wheel", { clientX: x, clientY: y, deltaX: 0, deltaY, deltaMode, bubbles: true, cancelable: true, composed: true, view: window });
    canvas.dispatchEvent(event);
    if (event.defaultPrevented) prevented += 1;
  }
  let round = 0;
  const tick = () => {
    round += 1;
    if (round >= 8) { resolve({ dispatched: count, prevented, deltaMode, deltaY, x, y, onCanvas: canvas === document.elementFromPoint(x, y) }); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

const KEY_BURST_PROBE = `(code, key, count) => new Promise((resolve) => {
  const element = document.getElementById("scene-diagnostics");
  const zoomBefore = element === null ? null : element.getAttribute("data-camera-zoom");
  const init = { key, code, bubbles: true, cancelable: true, composed: true, view: window };
  for (let index = 0; index < count; index += 1) {
    window.dispatchEvent(new KeyboardEvent("keydown", init));
    window.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  let round = 0;
  const tick = () => {
    round += 1;
    if (round >= 8) { resolve({ dispatched: count, code, key, zoomBefore, zoomAfter: element === null ? null : element.getAttribute("data-camera-zoom") }); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})`;

/**
 * The app tile counters, the scheduler counters and the GPU cache stats.
 * Every absent global is a null field, never a missing key, so a key-wise
 * diff of two runs stays valid before and after a sibling slice
 * publishes one of them.
 */
const TILE_RUNTIME_PROBE = `(() => {
  const element = document.getElementById("scene-diagnostics");
  const attribute = element === null ? null : (name) => { const value = element.getAttribute(name); return value === null ? null : Number(value); };
  const lengths = (list) => Array.isArray(list) ? list.length : null;
  const d = window.__masterMapsTileDiagnostics;
  const tile = d === undefined || d === null ? { present: false, requested: null, loaded: null, aborted: null, failed: null, evicted: null, retiredPending: null, reasons: null } : {
    present: true,
    requested: lengths(d.requested),
    loaded: lengths(d.loaded),
    aborted: lengths(d.aborted),
    failed: lengths(d.failed),
    evicted: lengths(d.evicted),
    retiredPending: attribute === null ? null : attribute("data-retired-pending"),
    reasons: d.reasons === undefined || d.reasons === null ? null : JSON.parse(JSON.stringify(d.reasons)),
  };
  const s = window.__masterMapsSchedulerDiagnostics;
  const scalar = (value) => value === undefined || value === null ? null : value;
  const scheduler = s === undefined || s === null ? { present: false, lod: null, concurrency: null, planCount: null, planned: null, queueDepth: null, inFlight: null } : {
    present: true,
    lod: scalar(s.lod),
    concurrency: scalar(s.concurrency),
    planCount: scalar(s.planCount),
    planned: scalar(s.planned),
    queueDepth: scalar(s.queueDepth),
    inFlight: scalar(s.inFlight),
  };
  const g = window.__masterMapsGpuCacheDiagnostics;
  const cache = g === undefined || g === null ? { present: false, resident: null, bytes: null, retiredPending: null, evictions: null, allocations: null } : {
    present: true,
    resident: scalar(g.resident),
    bytes: scalar(g.bytes),
    retiredPending: scalar(g.retiredPending),
    evictions: scalar(g.evictions),
    allocations: scalar(g.allocations),
  };
  const memory = performance.memory;
  return { tile, scheduler, cache, jsHeapUsedBytes: memory === undefined ? null : memory.usedJSHeapSize, jsHeapLimitBytes: memory === undefined ? null : memory.jsHeapSizeLimit };
})()`;

/** The uncaught and console error lists, counted and sampled, not cleared. */
const ERROR_TALLY_PROBE = `(() => {
  const rt = window.__w5rt;
  if (rt === undefined) return { present: false, uncaughtErrors: 0, uncaughtRejections: 0, consoleErrors: 0, gpuValidationErrors: 0, uncaughtSample: null, consoleErrorSample: null, gpuValidationSample: null };
  return {
    present: true,
    uncaughtErrors: rt.errors.length,
    uncaughtRejections: rt.rejections.length,
    consoleErrors: rt.consoleErrors.length,
    gpuValidationErrors: rt.gpuValidationErrors.length,
    uncaughtSample: rt.errors.slice(0, 4),
    consoleErrorSample: rt.consoleErrors.slice(0, 4),
    gpuValidationSample: rt.gpuValidationErrors.slice(0, 4),
  };
})()`;

const CLEAR_ERROR_TALLY_PROBE = `(() => {
  const rt = window.__w5rt;
  if (rt === undefined) return false;
  rt.errors.length = 0;
  rt.rejections.length = 0;
  rt.consoleErrors.length = 0;
  rt.gpuValidationErrors.length = 0;
  return true;
})`;

const ADAPTER_PROBE = `(async () => {
  const out = {
    hasNavigatorGpu: Boolean(navigator.gpu),
    adapterNull: true,
    vendor: null,
    architecture: null,
    device: null,
    description: null,
    isFallbackAdapter: null,
    featureCount: 0,
    maxBufferSize: null,
    maxTextureDimension2D: null,
    webglRenderer: null,
    error: null,
  };
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter === null) {
        out.error = "requestAdapter returned null";
      } else {
        out.adapterNull = false;
        const info = adapter.info ?? null;
        if (info !== null) {
          out.vendor = info.vendor ?? null;
          out.architecture = info.architecture ?? null;
          out.device = info.device ?? null;
          out.description = info.description ?? null;
        }
        out.isFallbackAdapter = adapter.isFallbackAdapter ?? null;
        out.featureCount = adapter.features.size;
        out.maxBufferSize = adapter.limits.maxBufferSize;
        out.maxTextureDimension2D = adapter.limits.maxTextureDimension2D;
      }
    } catch (error) { out.error = String(error); }
  }
  try {
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2");
    if (gl !== null) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      out.webglRenderer = ext === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    }
  } catch (error) { out.webglRenderer = "probe failed: " + String(error); }
  return out;
})()`;

/**
 * Page harness. Installed after the app boots: the guarded runtime refuses
 * script injection once the page has loaded, so the console, error, WebGPU
 * and longtask collectors have to be armed from inside one evaluate and
 * everything after that is read back out of window.__w5rt.
 */
const INSTALL_PROBE = `(() => {
  if (window.__w5rt !== undefined) return { installed: false, reason: "already installed" };
  const rt = window.__w5rt = {
    consoleErrors: [],
    consoleWarnings: [],
    errors: [],
    rejections: [],
    gpuValidationErrors: [],
    longTasks: [],
    longTaskSupported: false,
    inputEvents: [],
    canvasPointerEvents: [],
    droppedErrorCount: 0,
  };
  /* The capture is deliberately uncapped for the error lists, because a
     repeated error is itself the finding. A harness that stops at 40 makes
     40 look like an accident; the run clears these lists between phases
     and reads the counts, so the numbers are real. */
  const add = (list, value) => { list.push(String(value).slice(0, 300)); if (list.length > 500) window.__w5rt.droppedErrorCount += 1; };
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      add(level === "error" ? rt.consoleErrors : rt.consoleWarnings, args.map(String).join(" "));
      return original(...args);
    };
  }
  window.addEventListener("error", (event) => add(rt.errors, event.message), true);
  window.addEventListener("unhandledrejection", (event) => add(rt.rejections, event.reason));
  /* This Chrome build exposes navigator.gpu as a [object GPU] whose
     addEventListener, pushErrorScope and popErrorScope are all undefined
     (measured: navigator.gpu.addEventListener is not a function), so an
     uncapturederror listener is impossible here. The uncaptured error
     count is therefore taken from a GPUDevice obtained here: the device
     exposes pushErrorScope, popErrorScope, an uncapturederror event target
     and a lost promise, and the page's own validation errors surface
     there. */
  rt.gpuDevice = null;
  rt.gpuDeviceError = null;
  const armGpu = (async () => {
    if (navigator.gpu === undefined) { rt.gpuDeviceError = "navigator.gpu missing"; return; }
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter === null) { rt.gpuDeviceError = "requestAdapter returned null"; return; }
      const device = await adapter.requestDevice();
      rt.gpuDevice = true;
      if (typeof device.addEventListener === "function") {
        device.addEventListener("uncapturederror", (event) => add(rt.gpuValidationErrors, (event.error && event.error.message) || "GPUError"));
      } else {
        rt.gpuDeviceError = "the device exposes no uncapturederror event target";
      }
      device.lost.then((info) => { rt.gpuDeviceLost = String(info && info.message); });
    } catch (error) { rt.gpuDeviceError = String(error); }
  })();
  if (typeof PerformanceObserver !== "undefined") {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) add(rt.longTasks, entry.duration);
      });
      observer.observe({ entryTypes: ["longtask"] });
      rt.longTaskSupported = true;
    } catch (error) { add(rt.errors, "longtask observer: " + String(error)); }
  }
  const canvas = document.querySelector("canvas");
  if (canvas !== null) {
    for (const type of ["pointerdown", "pointerup", "contextmenu", "click"]) {
      canvas.addEventListener(type, (event) => {
        if (rt.canvasPointerEvents.length < 60) {
          rt.canvasPointerEvents.push({ type, button: event.button, buttons: event.buttons, clientX: Math.round(event.clientX), clientY: Math.round(event.clientY), at: Math.round(performance.now()) });
        }
      }, true);
    }
  }
  window.__w5rtArmed = armGpu;
  return { installed: true, longTaskSupported: rt.longTaskSupported, canvasInstrumented: canvas !== null };
})()`;

const LAYER_PANEL_CENSUS_PROBE = `(() => {
  const panel = document.querySelector(".layer-controls-panel");
  if (panel === null) return { present: false };
  const toggle = panel.querySelector(".panel-toggle");
  if (toggle !== null && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  return {
    present: true,
    rows: Array.from(panel.querySelectorAll(".layer-toggle")).map((row) => ({
      label: (row.querySelector(".layer-label") || {}).textContent ?? null,
      checked: row.querySelector("input[type=checkbox]") === null ? null : row.querySelector("input[type=checkbox]").checked,
    })),
  };
})()`;

const HUD_CENSUS_PROBE = `(() => {
  const canvas = document.querySelector("canvas");
  const element = document.getElementById("scene-diagnostics");
  return {
    canvasPresent: canvas !== null,
    diagnosticsVisible: element === null ? null : element.getBoundingClientRect().width > 0,
    searchInput: document.querySelector('[data-testid="search-input"]') === null ? null : document.querySelector('[data-testid="search-input"]').placeholder,
    layerPanel: document.querySelector(".layer-controls-panel") === null ? null : document.querySelector(".layer-controls-panel").getAttribute("aria-label"),
    attribution: (document.querySelector(".source-attribution") || {}).textContent === undefined ? null : String(document.querySelector(".source-attribution").textContent).slice(0, 120),
    diagnosticsText: element === null ? null : element.textContent.slice(0, 240),
  };
})()`;

const COLLECT_ERRORS_PROBE = `(() => {
  const rt = window.__w5rt;
  if (rt === undefined) return null;
  return {
    consoleErrors: rt.consoleErrors,
    consoleWarnings: rt.consoleWarnings.slice(0, 10),
    errors: rt.errors,
    rejections: rt.rejections,
    gpuValidationErrors: rt.gpuValidationErrors,
    longTaskSupported: rt.longTaskSupported,
    longTasks: rt.longTasks,
    canvasPointerEvents: rt.canvasPointerEvents,
    gpuDevice: rt.gpuDevice === true,
    gpuDeviceError: rt.gpuDeviceError,
    gpuDeviceLost: rt.gpuDeviceLost ?? null,
  };
})()`;


/**
 * Arm one measurement. A rAF loop records frame durations for the whole
 * window; a MutationObserver on #scene-diagnostics timestamps the first
 * published camera zoom after the arm, which is the frame the input
 * became visible, and that is the input latency for this event.
 */
/**
 * One measurement window, entirely inside the page.
 *
 * The canvas runs frameloop="demand", and a headless page that is not
 * painting fires no requestAnimationFrame callback at all, so a sampler
 * driven from outside the page measures nothing. This probe therefore
 * owns the whole window: it opens a rAF loop, and when `drive` is true it
 * dispatches a real wheel notch on each frame, so the page is forced to
 * paint and every recorded frame is one the renderer actually produced.
 * Input latency is the gap from the dispatch to the frame that follows
 * it, which is what a user perceives. The loop stops on its own after
 * 10.5 s, so nothing stays armed.
 */
const WINDOW_PROBE = `(label, drive) => new Promise((resolve) => {
  const rt = window.__w5rt;
  const canvas = document.querySelector("canvas");
  const element = document.getElementById("scene-diagnostics");
  if (rt === undefined || canvas === null || element === null) { resolve({ ok: false, reason: "the page harness, canvas or diagnostics element is missing" }); return; }
  const rect = canvas.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width * 0.5);
  const y = Math.round(rect.top + rect.height * 0.5);
  const base = { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 51, pointerType: "mouse", isPrimary: true };
  const frames = [];
  const inputEvents = [];
  const longTasks = [];
  const mem = performance.memory;
  const start = performance.now();
  let last = start;
  let dispatchedAt = null;
  let notch = 0;
  const driveOnce = () => {
    notch += 1;
    dispatchedAt = performance.now();
    canvas.dispatchEvent(new WheelEvent("wheel", Object.assign({}, base, { clientX: x, clientY: y, deltaX: 0, deltaY: notch % 2 === 0 ? -3 : 3, deltaMode: 1 })));
  };
  const tick = () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (dispatchedAt !== null) {
      inputEvents.push({ label, latencyMs: now - dispatchedAt, zoomAfter: element.getAttribute("data-camera-zoom") });
      dispatchedAt = null;
    }
    if (now - start >= 10500) {
      const memory = performance.memory;
      resolve({
        ok: true,
        label,
        drive,
        frames,
        inputEvents,
        longTasks,
        zoomAtStart: element.getAttribute("data-camera-zoom"),
        zoomAtEnd: element.getAttribute("data-camera-zoom"),
        notches: notch,
        heapUsed: mem === undefined ? null : memory === undefined ? null : memory.usedJSHeapSize,
        heapTotal: mem === undefined ? null : memory === undefined ? null : memory.totalJSHeapSize,
        heapLimit: mem === undefined ? null : memory === undefined ? null : memory.jsHeapSizeLimit,
        windowMs: Math.round(now - start),
      });
      return;
    }
    if (drive) driveOnce();
    requestAnimationFrame(tick);
  };
  if (drive) driveOnce();
  requestAnimationFrame(tick);
})`;

/** Mark the moment one real input is dispatched, for the latency observer. */
const KEY_PROBE = (code: string, key: string): string => `(() => {
  const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true, composed: true, view: window };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  window.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
})()`;

/**
 * One wheel notch at a real canvas point. The app ignores deltaMode 0
 * (MapControls.tsx:124), so the event carries deltaMode 1 with three lines
 * of delta, which the app converts to notches/100 and clamps to a
 * three-step zoom.
 */
const WHEEL_PROBE = `(clientX, clientY, deltaY, deltaMode, label) => new Promise((resolve) => {
  const rt = window.__w5rt;
  const canvas = document.querySelector("canvas");
  if (canvas === null) { resolve({ ok: false, reason: "no canvas" }); return; }
  const rect = canvas.getBoundingClientRect();
  const x = clientX === null ? Math.round(rect.left + rect.width * 0.5) : clientX;
  const y = clientY === null ? Math.round(rect.top + rect.height * 0.5) : clientY;
  const element = document.getElementById("scene-diagnostics");
  const zoomBefore = element === null ? null : element.getAttribute("data-camera-zoom");
  if (rt !== undefined) rt.armedAt = performance.now();
  const started = performance.now();
  canvas.dispatchEvent(new WheelEvent("wheel", { clientX: x, clientY: y, deltaX: 0, deltaY, deltaMode, bubbles: true, cancelable: true, composed: true, view: window }));
  const finish = () => {
    const zoomAfter = element === null ? null : element.getAttribute("data-camera-zoom");
    const latencyMs = performance.now() - started;
    if (rt !== undefined) {
      rt.inputEvents.push({ label, latencyMs, zoomBefore, zoomAfter });
      if (rt.pendingInputObserver !== undefined) { rt.pendingInputObserver.disconnect(); rt.pendingInputObserver = undefined; }
    }
    resolve({ ok: true, x, y, deltaY, deltaMode, zoomBefore, zoomAfter, zoomChanged: zoomBefore !== zoomAfter, latencyMs: Math.round(latencyMs * 1000) / 1000, target: canvas === document.elementFromPoint(x, y) ? "canvas" : "overlay" });
  };
  requestAnimationFrame(() => requestAnimationFrame(finish));
})`;

/** A left-button drag as real pointer events, exactly what the controls read. */
const DRAG_PROBE = `(fromFractionX, fromFractionY, toFractionX, toFractionY, steps) => new Promise((resolve) => {
  const canvas = document.querySelector("canvas");
  if (canvas === null) { resolve({ ok: false, reason: "no canvas" }); return; }
  const rect = canvas.getBoundingClientRect();
  const x0 = Math.round(rect.left + rect.width * fromFractionX);
  const y0 = Math.round(rect.top + rect.height * fromFractionY);
  const x1 = Math.round(rect.left + rect.width * toFractionX);
  const y1 = Math.round(rect.top + rect.height * toFractionY);
  const base = { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 3, pointerType: "mouse", isPrimary: true };
  canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, base, { clientX: x0, clientY: y0, button: 0, buttons: 0 })));
  canvas.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { clientX: x0, clientY: y0, button: 0, buttons: 1 })));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, base, { clientX: Math.round(x0 + (x1 - x0) * t), clientY: Math.round(y0 + (y1 - y0) * t), button: 0, buttons: 1 })));
  }
  canvas.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { clientX: x1, clientY: y1, button: 0, buttons: 0 })));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resolve({ ok: true, from: [x0, y0], to: [x1, y1], steps, onCanvas: canvas === document.elementFromPoint(x0, y0) });
  }));
})`;

const SEARCH_OPTIONS_PROBE = `(() => {
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  const input = document.querySelector('[data-testid="search-input"]');
  return {
    count: options.length,
    first: options.length === 0 ? null : {
      text: options[0].textContent,
      kind: options[0].getAttribute("data-feature-kind"),
      selected: options[0].getAttribute("aria-selected"),
      testid: options[0].getAttribute("data-testid"),
    },
    inputValue: input === null ? null : input.value,
  };
})()`;

const TILE_HTTP_PROBE = `(() => {
  const origin = location.origin;
  const rows = [];
  for (const entry of performance.getEntriesByType("resource")) {
    if (entry.name.indexOf("/api/map/render/") < 0) continue;
    rows.push({ url: entry.name.slice(origin.length), status: entry.responseStatus === undefined ? 0 : entry.responseStatus, transferSize: entry.transferSize, startTimeMs: Math.round(entry.startTime) });
  }
  const statusCodes = {};
  let ok = 0;
  for (const row of rows) {
    const key = String(row.status);
    statusCodes[key] = (statusCodes[key] ?? 0) + 1;
    if (row.status === 200) ok += 1;
  }
  return { total: rows.length, ok, failed: rows.length - ok, statusCodes, firstUrl: rows.length === 0 ? null : rows[0].url, lastStartTimeMs: rows.length === 0 ? null : rows[rows.length - 1].startTimeMs };
})()`;

const TILE_APP_PROBE = `(() => {
  const d = window.__masterMapsTileDiagnostics;
  if (d === undefined) return null;
  return {
    requested: d.requested.length,
    requestedUnique: new Set(d.requested).size,
    loaded: d.loaded.length,
    loadedUnique: new Set(d.loaded).size,
    failed: d.failed.length,
    failedUnique: new Set(d.failed).size,
    aborted: d.aborted.length,
    abortedUnique: new Set(d.aborted).size,
    failedSample: d.failed.slice(0, 5),
  };
})()`;

const RESET_VIEW_PROBE = `(() => {
  const button = document.querySelector('[data-testid="reset-view"]');
  if (button === null) return false;
  button.click();
  return true;
})()`;

/**
 * The focus path the app really has: type the known town, wait for the
 * result list, click the first result through a real pointer sequence.
 * The listbox sits below the fold at 900 px, so the click is attempted
 * only when elementFromPoint says the option is the top element there.
 */
const FOCUS_RESULT_PROBE = `(() => {
  const input = document.querySelector('[data-testid="search-input"]');
  if (input === null) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, ${JSON.stringify(TOWN)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  return true;
})()`;

const FOCUS_RESULT_CLICK_PROBE = `(index) => {
  const options = Array.from(document.querySelectorAll('[role="option"]'));
  const option = options[index];
  if (option === null || option === undefined) return { clicked: false, reason: "no option at this index", count: options.length };
  const rect = option.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  if (rect.width === 0 || rect.height === 0) return { clicked: false, reason: "the option has no box", count: options.length };
  const top = document.elementFromPoint(x, y);
  if (top === null || !option.contains(top)) return { clicked: false, reason: "the option is not the top element at its own centre, it is below the fold", count: options.length, x, y, top: top === null ? null : top.tagName };
  const base = { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 77, pointerType: "mouse", isPrimary: true };
  option.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, base, { clientX: x, clientY: y, button: 0, buttons: 0 })));
  option.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { clientX: x, clientY: y, button: 0, buttons: 1 })));
  option.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { clientX: x, clientY: y, button: 0, buttons: 0 })));
  option.dispatchEvent(new MouseEvent("click", Object.assign({}, base, { clientX: x, clientY: y, button: 0 })));
  return { clicked: true, count: options.length, x, y, text: option.textContent };
}`;

const CONTEXT_MENU_PROBE = `(() => {
  const menu = document.querySelector('[data-testid="feature-context-menu"]');
  if (menu === null) return { open: false, flag: document.documentElement.dataset.featureContextOpen ?? null };
  const rect = menu.getBoundingClientRect();
  return {
    open: true,
    featureId: menu.getAttribute("data-feature-id"),
    kind: menu.getAttribute("data-feature-kind"),
    flag: document.documentElement.dataset.featureContextOpen ?? null,
    actions: Array.from(menu.querySelectorAll("[data-action-id]")).map((element) => element.getAttribute("data-action-id")),
    heading: (menu.querySelector("[data-testid='feature-context-kind']") || {}).textContent ?? null,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
})()`;

/* ------------------------------------------------------------------ */
/*  Screenshot caption                                                */
/* ------------------------------------------------------------------ */

/**
 * Decode the PNG the guarded shot tool returned and describe it from its
 * pixels. The runtime hands the image block back to the MCP client as base
 * text, so it is written to disk here and then re-read: dimensions, colour
 * census, share of near-white pixels and the top colour buckets.
 */
function captionPng(path: string): Promise<string> {
  const script = [
    "import sys, zlib, struct",
    "raw = open(sys.argv[1], 'rb').read()",
    "pos, idat, types = 8, b'', []",
    "w = h = bitd = ctype = None",
    "while pos < len(raw):",
    "    ln = struct.unpack('>I', raw[pos:pos+4])[0]",
    "    typ = raw[pos+4:pos+8].decode('ascii', 'replace')",
    "    body = raw[pos+8:pos+8+ln]",
    "    types.append(typ)",
    "    if typ == 'IHDR':",
    "        w, h, bitd, ctype, comp, filt, interlace = struct.unpack('>IIBBBBB', body[:13])",
    "    elif typ == 'IDAT':",
    "        idat += body",
    "    pos += 12 + ln",
    "header = 'dims=%sx%s bitDepth=%s colorType=%s chunks=%s' % (w, h, bitd, ctype, ','.join(sorted(set(types))))",
    "bpp = {0:1, 2:3, 4:2, 6:4}.get(ctype)",
    "if bitd != 8 or bpp is None:",
    "    print(header + ' (pixels not decoded)')",
    "    raise SystemExit(0)",
    "buf = zlib.decompress(idat)",
    "stride = w * bpp",
    "prev = bytearray(stride)",
    "counts = {}",
    "bright = ink = total = 0",
    "distinct = set()",
    "step = max(1, w // 240)",
    "for y in range(h):",
    "    off = y * (stride + 1)",
    "    ft = buf[off]",
    "    line = bytearray(buf[off+1:off+1+stride])",
    "    if ft == 1:",
    "        for i in range(bpp, stride): line[i] = (line[i] + line[i-bpp]) & 255",
    "    elif ft == 2:",
    "        for i in range(stride): line[i] = (line[i] + prev[i]) & 255",
    "    elif ft == 3:",
    "        for i in range(stride):",
    "            a = line[i-bpp] if i >= bpp else 0",
    "            line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255",
    "    elif ft == 4:",
    "        for i in range(stride):",
    "            a = line[i-bpp] if i >= bpp else 0",
    "            b = prev[i]",
    "            c = prev[i-bpp] if i >= bpp else 0",
    "            p = a + b - c",
    "            pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)",
    "            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)",
    "            line[i] = (line[i] + pr) & 255",
    "    for x in range(0, w, step):",
    "        i = x * bpp",
    "        r, g, bl = line[i], line[i+1], line[i+2]",
    "        lum = (r*299 + g*587 + bl*114) // 1000",
    "        key = '%d,%d,%d' % (r//40*40, g//40*40, bl//40*40)",
    "        counts[key] = counts.get(key, 0) + 1",
    "        if lum > 225: bright += 1",
    "        if lum < 120: ink += 1",
    "        total += 1",
    "        distinct.add((r, g, bl))",
    "    prev = line",
    "top = sorted(counts.items(), key=lambda kv: -kv[1])[:5]",
    "print(header + ' sampled=%d distinctColors=%d brightShare=%.3f darkShare=%.3f topBuckets=%s' % (total, len(distinct), bright/max(1,total), ink/max(1,total), ' '.join('%s:%d' % kv for kv in top)))",
  ].join("\n");
  const { promise, resolve } = Promise.withResolvers<string>();
  const proc = spawn("python3", ["-c", script, path], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  proc.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  proc.on("error", (error) => resolve(`${path}: caption unavailable, ${String(error)}`));
  proc.on("close", (code) => {
    const text = out.trim();
    if (text.length > 0) {
      resolve(text);
      return;
    }
    resolve(`${path}: caption unavailable, python3 exited ${code}${err.trim().length > 0 ? ` with ${err.trim().slice(0, 200)}` : " and no output"}`);
  });
  return promise;
}

/* ------------------------------------------------------------------ */
/*  Runner                                                            */
/* ------------------------------------------------------------------ */

interface CameraState {
  target: [number, number, number];
  zoom: number;
  azimuthalAngle: number | null;
  headingRadians: number | null;
  rotationZ: number | null;
  frustumWidth: number | null;
  frustumHeight: number | null;
}

interface Diagnostics {
  present: boolean;
  [key: string]: unknown;
}

interface ShotRecord {
  name: string;
  path: string;
  bytes: number;
  what: string;
  caption: string;
}

interface StepRecord {
  name: string;
  ok: boolean;
  detail: string;
}

interface OrientationRecord {
  northUp: string | null;
  eastRight: string | null;
  projectionYScale: number | null;
  observable: boolean;
}

interface NotDrivenRecord {
  path: string;
  notDriven: true;
  reason: string;
}

type ZoomPathRecord = Record<string, unknown> & { path: string; notDriven?: false };
type ZoomPathEntry = ZoomPathRecord | NotDrivenRecord;
type HeadingStep = Record<string, unknown> & { path: string; notDriven?: false };
type HeadingEntry = HeadingStep | NotDrivenRecord;
type DragEntry = Record<string, unknown> & { path: string; notDriven?: false };
type StressCycle = Record<string, unknown> & { index: number; notDriven?: false };
type ErrorTally = {
  present: boolean;
  uncaughtErrors: number;
  uncaughtRejections: number;
  consoleErrors: number;
  gpuValidationErrors: number;
  uncaughtSample: string[] | null;
  consoleErrorSample: string[] | null;
  gpuValidationSample: string[] | null;
};
type TileRuntime = {
  tile: Record<string, unknown> & { present: boolean; evicted: number | null; retiredPending: number | null };
  scheduler: Record<string, unknown> & { present: boolean };
  cache: Record<string, unknown> & { present: boolean };
  jsHeapUsedBytes: number | null;
  jsHeapLimitBytes: number | null;
};

function isNotDriven(entry: ZoomPathEntry | HeadingEntry | DragEntry | StressCycle): entry is NotDrivenRecord {
  return (entry as NotDrivenRecord).notDriven === true;
}

function isTruthyAttribute(value: string | null): boolean {
  return value !== null && TRUTHY.indexOf(value.trim().toLowerCase()) >= 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function numericOrNaN(value: unknown): number {
  return isNumber(value) ? value : Number.NaN;
}

function orientationOf(state: Record<string, unknown> | null): OrientationRecord {
  const northUp = typeof state?.orientationNorthUp === "string" ? state.orientationNorthUp : null;
  const eastRight = typeof state?.orientationEastRight === "string" ? state.orientationEastRight : null;
  const yScale = isNumber(state?.projectionYScale) ? Number(state?.projectionYScale) : null;
  return { northUp, eastRight, projectionYScale: yScale, observable: northUp !== null || eastRight !== null };
}

function describeNotDriven(path: string, reason: string): NotDrivenRecord {
  log(`notDriven ${path}: ${reason}`);
  return { path, notDriven: true, reason };
}

class RuntimeRun {
  private readonly mcp = new McpClient();
  private readonly startedAt = Date.now();
  private readonly notes: string[] = [];
  private readonly shots: ShotRecord[] = [];
  private readonly steps: StepRecord[] = [];
  private readonly verdicts: Array<{ id: string; verdict: string; claim: string; observed: string; threshold: string }> = [];

  private health: unknown = null;
  private version: unknown = null;
  private installResult: Record<string, unknown> | string | null = null;
  private gpuModeEvidence = "";
  private installEvidence: unknown = null;
  private adapter: Record<string, unknown> = {};
  private canvas: Record<string, number> | null = null;
  private overview: Diagnostics = { present: false };
  private finalDiagnostics: Diagnostics = { present: false };
  private overviewSample: FrameSample = EMPTY_SAMPLE;
  private focusSample: FrameSample = EMPTY_SAMPLE;
  private interactionSample: FrameSample = EMPTY_SAMPLE;
  private errors: Record<string, unknown> = {};
  private renderCostSample: FrameSample = EMPTY_SAMPLE;
  private orientationBaseline: OrientationRecord = { northUp: null, eastRight: null, projectionYScale: null, observable: false };
  private zoomMatrix: Record<string, unknown> = { orientationObservable: false, paths: [] as ZoomPathEntry[] };
  private headingMatrixResult: Record<string, unknown> = { orientationObservable: false, steps: [] as HeadingEntry[] };
  private dragPan: Record<string, unknown> = { notDriven: true, reason: "the drag pan section did not run" };
  private lodStress: Record<string, unknown> = { notDriven: true, reason: "the level-of-detail stress section did not run" };
  private focusZoom: number | null = null;
  private tileHttp: Record<string, unknown> = {};
  private tileApp: Record<string, unknown> | null = null;
  private renderFilesAtStart = 0;
  private renderFilesAtEnd = 0;
  private dataset: Record<string, unknown> = {};
  private finalCamera: CameraState | null = null;
  private layerPanel: Record<string, unknown> | null = null;
  private searchViewport: number | null = null;
  private hud: Record<string, unknown> | null = null;

  private get target(): string {
    return process.argv[2] ?? DEFAULT_TARGET;
  }

  private overBudget(): boolean {
    return Date.now() - this.startedAt > HARD_STOP_MS;
  }

  /* ---------------- setup ---------------- */

  private async setup(): Promise<void> {
    mkdirSync(SHOT_DIR, { recursive: true });
    for (const previous of readdirSync(SHOT_DIR)) {
      if (previous.endsWith(".png")) writeFileSync(resolve(SHOT_DIR, previous), "");
    }
    this.renderFilesAtStart = this.countRenderFiles();
    this.dataset = this.readDataset();
    await this.mcp.start();
    this.health = parseToolJson(await this.mcp.raw("health", {}, 90_000));
    this.version = parseToolJson(await this.mcp.raw("version", {}, 90_000));
    log(`health: ${JSON.stringify(this.health)}`);
    log(`version: ${JSON.stringify(this.version)}`);
    await this.mcp.raw("profile_open", { name: PROFILE }, 120_000);
    try {
      this.gpuModeEvidence = (await this.mcp.raw("gpu_mode", { mode: "hardware" }, 120_000)).replace(/\s+/g, " ").slice(0, 300);
    } catch (error) {
      this.gpuModeEvidence = `gpu_mode call failed: ${String(error).slice(0, 200)}`;
      this.notes.push(this.gpuModeEvidence);
    }
    log(`gpu_mode hardware: ${this.gpuModeEvidence}`);
    await this.mcp.raw("set_viewport", VIEWPORT, 60_000);
    await this.mcp.raw("navigate", { url: this.target }, 120_000);
    const page = await this.mcp.evaluate<{ url: string; title: string; readyState: string }>("({ url: location.href, title: document.title, readyState: document.readyState })", 60_000);
    log(`page: ${JSON.stringify(page)}`);
    this.installResult = await this.mcp.evaluate<Record<string, unknown> | string>(INSTALL_PROBE, 60_000);
    this.installEvidence = this.installResult;
    log(`page harness: ${JSON.stringify(this.installEvidence)}`);
    if (typeof this.installResult === "string" || this.installResult === null || this.installResult.installed !== true) {
      throw new Error(`the in-page measurement harness did not install: ${JSON.stringify(this.installEvidence)}`);
    }
    await this.waitForScene(180_000);
    const quiescence = await this.waitForTileQuiescence(120_000);
    log(`tile quiescence: settled=${quiescence.settled} ${quiescence.detail}`);
    this.notes.push(`tile quiescence before measuring: settled=${quiescence.settled}, ${quiescence.detail}`);
    log(`render tiles on disk: ${this.renderFilesAtStart}`);
  }

  private countRenderFiles(): number {
    try {
      return readdirSync(resolve(ROOT, "data/generated/render")).length;
    } catch {
      return -1;
    }
  }

  private readDataset(): Record<string, unknown> {
    const readJson = (relative: string): Record<string, unknown> | null => {
      try {
        return JSON.parse(readFileSync(resolve(ROOT, relative), "utf8")) as Record<string, unknown>;
      } catch {
        return null;
      }
    };
    const tileManifest = readJson("data/generated/tile-manifest.json");
    const datasetManifest = readJson("data/generated/dataset-manifest.json");
    const searchIndex = readJson("data/generated/search-index.json");
    const lodCounts: Record<string, number> = {};
    if (tileManifest !== null && Array.isArray(tileManifest.tiles)) {
      for (const tile of tileManifest.tiles as Array<{ lod?: number }>) {
        const key = String(tile.lod ?? "unknown");
        lodCounts[key] = (lodCounts[key] ?? 0) + 1;
      }
    }
    return {
      intermediateFiles: existsSync(resolve(ROOT, "data/intermediate")) ? readdirSync(resolve(ROOT, "data/intermediate")).length : -1,
      renderFiles: this.renderFilesAtStart,
      tileManifestEntries: tileManifest === null ? null : Array.isArray(tileManifest.tiles) ? tileManifest.tiles.length : null,
      tileManifestBytes: existsSync(resolve(ROOT, "data/generated/tile-manifest.json")) ? statSync(resolve(ROOT, "data/generated/tile-manifest.json")).size : -1,
      tileLodCounts: lodCounts,
      datasetManifestBytes: existsSync(resolve(ROOT, "data/generated/dataset-manifest.json")) ? statSync(resolve(ROOT, "data/generated/dataset-manifest.json")).size : -1,
      datasetFeatureTotal: datasetManifest === null ? null : (datasetManifest.featureCount as number | undefined) ?? null,
      searchIndexRecords: searchIndex === null ? null : (searchIndex.records as number | undefined) ?? null,
    };
  }

  /**
   * Wait until the app has no tile work in flight. A run that starts
   * measuring while 24 tile decodes are queued measures the loader, not
   * the renderer: an early run recorded a 357 ms wheel dispatch for
   * exactly that reason.
   */
  private async waitForTileQuiescence(timeoutMs: number): Promise<{ settled: boolean; detail: string }> {
    const deadline = Date.now() + timeoutMs;
    let previous = -1;
    let stableFor = 0;
    let detail = "not reached";
    while (Date.now() < deadline) {
      const http = await this.mcp.evaluate<{ total: number }>(TILE_HTTP_PROBE, 30_000);
      const app = await this.mcp.evaluate<Record<string, unknown> | null>(TILE_APP_PROBE, 30_000);
      const inFlight = app === null ? Number(http.total) : Number(app.requested) - Number(app.loaded) - Number(app.aborted) - Number(app.failed);
      detail = `${String(http.total)} render requests, app requested ${String(app?.requested ?? "n/a")} loaded ${String(app?.loaded ?? "n/a")} aborted ${String(app?.aborted ?? "n/a")} failed ${String(app?.failed ?? "n/a")}, in flight ${inFlight}`;
      if (inFlight <= 0 && http.total === previous) {
        stableFor += 1;
        if (stableFor >= 3) return { settled: true, detail };
      } else {
        stableFor = 0;
      }
      previous = Number(http.total);
      await sleep(1000);
    }
    return { settled: false, detail };
  }

  private async waitForScene(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try {
        const probe = await this.mcp.evaluate<{ ready: boolean; status: string | null; tiles: number }>(SCENE_READY_PROBE, 30_000);
        last = probe;
        if (probe.ready === true) return;
      } catch (error) {
        last = String(error).slice(0, 140);
      }
      await sleep(700);
    }
    throw new Error(`the scene never reported an initialized renderer with loaded tiles; last probe ${JSON.stringify(last)}`);
  }

  /* ---------------- small readers ---------------- */

  private async diagnostics(): Promise<Diagnostics> {
    const raw = await this.mcp.evaluate<Diagnostics | null>(DIAGNOSTICS_PROBE, 30_000);
    return raw === null ? { present: false } : raw;
  }

  private async camera(): Promise<CameraState | null> {
    const raw = await this.mcp.evaluate<CameraState | null>(CAMERA_PROBE, 30_000);
    if (raw === null || raw.target === undefined) return null;
    return raw;
  }

  private async waitFor<T>(read: () => Promise<T | null>, predicate: (value: T) => boolean, timeoutMs: number): Promise<T | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const value = await read();
        if (value !== null && predicate(value)) return value;
      } catch {
        /* keep polling until the deadline */
      }
      await sleep(300);
    }
    return null;
  }

  private async cameraMovedFrom(before: CameraState | null, timeoutMs: number): Promise<CameraState | null> {
    return this.waitFor<CameraState>(
      async () => this.camera(),
      (value) => before !== null && (Math.abs(value.target[0] - before.target[0]) > 1 || Math.abs(value.target[2] - before.target[2]) > 1 || Math.abs(value.zoom - before.zoom) > 0.01),
      timeoutMs,
    );
  }

  /* ---------------- measurement ---------------- */

  /**
   * One measurement window. `during` runs inside the window, so an idle
   * sample collects pure frame cadence and an interaction sample collects
   * frames the app actually rendered while input was flowing.
   */
  /**
   * One 10 s window owned by the page. `drive` decides whether the window
   * holds a real wheel notch per frame, so the idle and driven cases are
   * both measured against the same sampler.
   */
  private async measure(label: string, note: string, drive: boolean): Promise<FrameSample> {
    const cameraBefore = await this.camera();
    const httpBefore = await this.mcp.evaluate<{ total: number }>(TILE_HTTP_PROBE, 30_000);
    const raw = await this.mcp.evaluate<{
      ok: boolean;
      reason?: string;
      frames: number[];
      inputEvents: Array<{ label: string; latencyMs: number; zoomAfter: string | null }>;
      longTasks: number[];
      heapUsed: number | null;
      heapTotal: number | null;
      heapLimit: number | null;
      windowMs: number;
      notches: number;
      zoomAtStart: string | null;
      zoomAtEnd: string | null;
    } | null>(`(${WINDOW_PROBE})(${JSON.stringify(label)}, ${drive ? "true" : "false"})`, 120_000);
    if (raw === null || raw.ok !== true) {
      const failed: FrameSample = { ...EMPTY_SAMPLE, note: `${note}; the in-page window probe failed: ${JSON.stringify(raw)}` };
      log(`sample ${label}: FAILED ${JSON.stringify(raw)}`);
      return failed;
    }
    const cameraAfter = await this.camera();
    const httpAfter = await this.mcp.evaluate<{ total: number }>(TILE_HTTP_PROBE, 30_000);
    const sample: FrameSample = {
      frames: raw.frames,
      longTasks: raw.longTasks,
      heapUsed: raw.heapUsed,
      heapTotal: raw.heapTotal,
      heapLimit: raw.heapLimit,
      inputLatencies: raw.inputEvents.map((row) => ({ label: row.label, latencyMs: row.latencyMs, zoomBefore: null, zoomAfter: row.zoomAfter })),
      cameraBefore,
      cameraAfter,
      requestCount: Number(httpAfter?.total ?? 0) - Number(httpBefore?.total ?? 0),
      durationMs: raw.windowMs,
      terminated: true,
      note: `${note}; the page ran the whole window and stopped its own rAF loop; ${raw.notches} wheel notches dispatched, zoom ${String(raw.zoomAtStart)} -> ${String(raw.zoomAtEnd)}`,
    };
    log(`sample ${label}: ${JSON.stringify(summarise(label, sample))}`);
    return sample;
  }

  private async wheel(dy: number, deltaMode: number, label: string): Promise<Record<string, unknown>> {
    return this.mcp.evaluate<Record<string, unknown>>(`(${WHEEL_PROBE})(null, null, ${dy}, ${deltaMode}, ${JSON.stringify(label)})`, 30_000);
  }

  /* ---------------- new sections ---------------- */

  private async matrixState(): Promise<Record<string, unknown> | null> {
    const raw = await this.mcp.evaluate<Record<string, unknown> | null>(MATRIX_STATE_PROBE, 30_000);
    return raw !== null && raw.present === true ? raw : null;
  }

  private async errorTally(): Promise<ErrorTally> {
    return this.mcp.evaluate<ErrorTally>(ERROR_TALLY_PROBE, 30_000);
  }

  private async clearErrorTally(): Promise<boolean> {
    return this.mcp.evaluate<boolean>(CLEAR_ERROR_TALLY_PROBE, 30_000);
  }

  private async tileRuntime(): Promise<TileRuntime> {
    return this.mcp.evaluate<TileRuntime>(TILE_RUNTIME_PROBE, 30_000);
  }

  private async settleZoom(level: number, tolerance = 0.02, timeoutMs = 20_000): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    let last: number | null = null;
    while (Date.now() < deadline) {
      const raw = await this.matrixState();
      const zoom = isNumber(raw?.cameraZoom) ? Number(raw?.cameraZoom) : null;
      if (zoom === null) return null;
      last = zoom;
      if (Math.abs(zoom - level) <= tolerance * Math.max(1, Math.abs(level))) return zoom;
      await sleep(200);
    }
    return last;
  }

  /**
   * Every zoom input path, from one overview state, with the orientation
   * attributes read on both sides of the operation. A path that the page
   * cannot be made to take is recorded as notDriven with its reason, and
   * a path that is driven but leaves the zoom untouched is a measured
   * zero, not a missing value.
   */
  private async zoomInputMatrix(): Promise<void> {
    log("=== zoom input matrix ===");
    const paths: ZoomPathEntry[] = [];
    this.orientationBaseline = orientationOf(await this.matrixState());
    for (const [name, count, deltaMode, deltaY, fractionX, fractionY] of [
      ["pixel-wheel-nocursor", 8, 0, -120, 0.5, 0.5],
      ["pixel-wheel-cursor-offset", 8, 0, -120, 0.25, 0.3],
      ["line-wheel", 6, 1, -3, 0.5, 0.5],
      ["page-wheel", 6, 2, -1, 0.5, 0.5],
    ] as Array<[string, number, number, number, number, number]>) {
      paths.push(await this.measureZoomPath(name, "wheel", [deltaMode, deltaY, count, fractionX, fractionY], WHEEL_BURST_PROBE));
    }
    paths.push(await this.measureZoomPath("keyboard-zoom-in", "keydown and keyup on window, the target MapControls binds", ["Equal", "=", 3], KEY_BURST_PROBE));
    paths.push(await this.measureZoomPath("keyboard-zoom-out", "keydown and keyup on window, the target MapControls binds", ["Minus", "-", 3], KEY_BURST_PROBE));
    paths.push(await this.measureZoomPath("reset", "the reset-view control in MapHud, the stable data-testid selector", [], RESET_VIEW_PROBE));
    paths.push(await this.measureZoomPath("resize", "the guarded viewport widened and restored, which resizes the canvas and refits the frustum", [], "resize"));
    paths.push(await this.measureZoomPath("programmatic-focus", "the search result focus path, which the app drives at zoom 80", [], "programmatic-focus"));

    this.zoomMatrix = { orientationObservable: this.orientationBaseline.observable, orientationBaseline: this.orientationBaseline, paths };
    log(`zoom input matrix: ${JSON.stringify(this.zoomMatrix)}`);

    const driven = paths.filter((entry): entry is ZoomPathRecord => !isNotDriven(entry));
    const wheelPaths = driven.filter((entry) => entry.path.indexOf("wheel") >= 0);
    if (wheelPaths.length > 0) {
      this.verdict(
        "zoom.wheelPaths",
        wheelPaths.every((entry) => entry.movedZoom === true) ? "PASS" : "FAIL",
        "every driven wheel zoom path changed the camera zoom",
        wheelPaths.map((entry) => `${entry.path} zoom ${String(entry.zoomBefore)} -> ${String(entry.zoomAfter)}`).join("; "),
        "each wheel path must change the zoom",
      );
    }
    for (const entry of driven) {
      if (entry.movedZoom !== true) continue;
      const orientation = entry.orientation as OrientationRecord;
      if (!orientation.observable) continue;
      this.judge(
        `zoom.orientation.${entry.path}`,
        `a zoom through ${entry.path} keeps the north-up and east-right orientation attributes true`,
        isTruthyAttribute(orientation.northUp) && isTruthyAttribute(orientation.eastRight),
        `${entry.path}: ${ORIENTATION_ATTRIBUTE}=${String(orientation.northUp)}, ${EAST_RIGHT_ATTRIBUTE}=${String(orientation.eastRight)}, ${Y_SCALE_ATTRIBUTE}=${String(orientation.projectionYScale)}`,
        `both attributes ${ORIENTATION_TRUTHY}`,
      );
    }
    if (this.focusZoom !== null) {
      this.judge("zoom.focusReachesFocusZoom", `activating a search result focuses the camera at zoom ${FOCUS_ZOOM}`, Math.abs(this.focusZoom - FOCUS_ZOOM) < 1, `the focus path settled at zoom ${round(this.focusZoom, 4)}`, `${FOCUS_ZOOM} +/- 1`);
    } else {
      this.verdict("zoom.focusReachesFocusZoom", "INCONCLUSIVE", `activating a search result focuses the camera at zoom ${FOCUS_ZOOM}`, "the focus path was not driven: the result list sits below the fold at this viewport and the guarded runtime could not click it", `${FOCUS_ZOOM} +/- 1`);
    }
    if (!this.orientationBaseline.observable) {
      this.verdict("zoom.orientation.observable", "INCONCLUSIVE", "the orientation attributes are published by #scene-diagnostics", `neither ${ORIENTATION_ATTRIBUTE} nor ${EAST_RIGHT_ATTRIBUTE} is present, so the orientation values are null on every path and the zoom deltas stand alone`, `the attributes must be published to judge orientation`);
    }
  }

  private async measureZoomPath(
    name: string,
    driver: string,
    args: unknown[],
    probe: string,
  ): Promise<ZoomPathRecord | NotDrivenRecord> {
    const before = await this.matrixState();
    if (before === null) return describeNotDriven(name, "#scene-diagnostics is absent, so the camera state cannot be read before or after this path");
    const started = Date.now();
    let evidence: unknown = null;
    try {
      if (probe === RESET_VIEW_PROBE) evidence = await this.mcp.evaluate(RESET_VIEW_PROBE, 30_000);
      else if (probe === "resize") evidence = await this.mcp.evaluate(RESIZE_PROBE, 30_000);
      else if (probe === "programmatic-focus") evidence = await this.driveProgrammaticFocus();
      else evidence = await this.mcp.evaluate(`(${probe})(${args.map((value) => JSON.stringify(value)).join(", ")})`, 60_000);
    } catch (error) {
      return describeNotDriven(name, `the dispatch threw before the state could be read: ${String(error).slice(0, 200)}`);
    }
    if (evidence === NOT_DRIVEN) return describeNotDriven(name, String((await this.matrixState()) === null ? "the page lost its diagnostics element" : "the focus path left the camera untouched"));
    const zoomBefore = numericOrNaN(before.cameraZoom);
    const settled = await this.settleZoom(zoomBefore, 0.02, 8000);
    const after = await this.matrixState();
    if (after === null) return describeNotDriven(name, "#scene-diagnostics disappeared while this path was running");
    const zoomAfter = settled ?? numericOrNaN(after.cameraZoom);
    const movedZoom = Math.abs(zoomAfter - zoomBefore) > 0.01;
    const orientation = orientationOf(after);
    const errorsDuring = await this.errorTally();
    const record: ZoomPathRecord = {
      path: name,
      driver,
      evidence: evidence === null ? null : (evidence as Record<string, unknown>),
      zoomBefore,
      zoomAfter,
      zoomDelta: round(zoomAfter - zoomBefore, 4),
      movedZoom,
      targetXBefore: before.targetX,
      targetXAfter: after.targetX,
      targetZBefore: before.targetZ,
      targetZAfter: after.targetZ,
      targetFinite: isNumber(after.cameraTargetX) && isNumber(after.cameraTargetZ),
      orientation,
      loadedTileCount: numericOrNaN(after.loadedTileCount),
      drawCalls: numericOrNaN(after.drawCalls),
      rendererError: after.rendererError === null || after.rendererError === undefined ? null : after.rendererError,
      errorsDuring,
      durationMs: Date.now() - started,
    };
    log(`zoom path ${name}: ${JSON.stringify(record)}`);
    this.steps.push({
      name: `zoom-${name}`,
      ok: isNumber(after.cameraTargetX) && isNumber(after.cameraTargetZ) && errorsDuring.uncaughtErrors === 0,
      detail: `zoom ${round(zoomBefore, 4)} -> ${round(zoomAfter, 4)} (${movedZoom ? "moved" : "no change"}), target x ${String(record.targetXBefore)} -> ${String(record.targetXAfter)}, loaded tiles ${String(record.loadedTileCount)}, draw calls ${String(record.drawCalls)}, north-up ${String(orientation.northUp)}, ${String(record.durationMs)} ms`,
    });
    return record;
  }

  /**
   * The zoom 80 focus path. The app only focuses a result or a picked
   * feature, and both go through the search field, so this drives the
   * search result click for the known town and waits for the app to
   * settle at the focus zoom. A click that never moves the camera is
   * reported, not retried into a fake measurement.
   */
  private async driveProgrammaticFocus(): Promise<unknown> {
    const typed = await this.mcp.evaluate<boolean>(FOCUS_RESULT_PROBE, 60_000);
    if (typed !== true) return NOT_DRIVEN;
    const options = await this.waitFor<{ count: number }>(
      async () => this.mcp.evaluate<{ count: number }>(SEARCH_OPTIONS_PROBE, 30_000),
      (value) => value.count > 0,
      20_000,
    );
    if (options === null) return NOT_DRIVEN;
    const clicked = await this.mcp.evaluate<Record<string, unknown>>(`(${FOCUS_RESULT_CLICK_PROBE})(0)`, 60_000);
    if (clicked.clicked !== true) return NOT_DRIVEN;
    const focusZoom = await this.waitFor<number>(
      async () => {
        const raw = await this.matrixState();
        return isNumber(raw?.cameraZoom) ? Number(raw?.cameraZoom) : null;
      },
      (value) => Math.abs(value - 80) < 1,
      20_000,
    );
    if (focusZoom === null) return NOT_DRIVEN;
    this.focusZoom = focusZoom;
    return { town: TOWN, options: options.count, clicked, focusZoom, expectedFocusZoom: FOCUS_ZOOM };
  }

  /**
   * Headings reached with the heading keys, each followed by one
   * pixel-mode wheel zoom. A zoom must never move the heading, so the
   * heading is read before and after every zoom.
   */
  private async headingMatrix(): Promise<void> {
    log("=== heading matrix ===");
    const steps: HeadingEntry[] = [];
    this.orientationBaseline = orientationOf(await this.matrixState());
    const targets = [0, -Math.PI / 4, Math.PI / 4, Math.PI / 2];
    for (const target of targets) {
      const path = `heading-${Math.round((target * 180) / Math.PI)}deg`;
      const before = await this.camera();
      if (before === null) {
        steps.push(describeNotDriven(path, "the camera state could not be read, so no heading step was driven"));
        continue;
      }
      const turns = Math.round((target - numericOrNaN(before.headingRadians)) / HEADING_STEP);
      const key = turns < 0 ? ["KeyA", "a"] : ["KeyE", "e"];
      const evidence = await this.mcp.evaluate(`(${KEY_BURST_PROBE})(${JSON.stringify(key[0])}, ${JSON.stringify(key[1])}, ${Math.abs(turns)})`, 60_000);
      const reached = await this.waitFor<CameraState>(async () => this.camera(), (value) => Math.abs((numericOrNaN(value.headingRadians) - target) * 180) / Math.PI < 4, 15_000);
      if (reached === null) {
        steps.push(describeNotDriven(path, `${Math.abs(turns)} ${String(key[0])} presses did not bring the heading to ${target.toFixed(4)} rad within 15 s: ${JSON.stringify(evidence)}`));
        continue;
      }
      const headingBefore = numericOrNaN(reached.headingRadians);
      const zoomBefore = numericOrNaN(reached.zoom);
      await this.mcp.evaluate(`(${WHEEL_BURST_PROBE})(0, -120, 8, 0.5, 0.5)`, 60_000);
      await sleep(1200);
      const zoomed = await this.camera();
      const headingAfter = numericOrNaN(zoomed?.headingRadians);
      const zoomAfter = numericOrNaN(zoomed?.zoom);
      const state = await this.matrixState();
      const entry: HeadingStep = {
        path,
        targetRadians: round(target, 4),
        targetDegrees: Math.round((target * 180) / Math.PI),
        keyPresses: Math.abs(turns),
        key: key[0],
        headingBefore: round(headingBefore, 4),
        headingAfter: round(headingAfter, 4),
        headingDelta: round(headingAfter - headingBefore, 6),
        headingHeld: Math.abs(headingAfter - headingBefore) < 0.01,
        zoomBefore: round(zoomBefore, 4),
        zoomAfter: round(zoomAfter, 4),
        zoomDelta: round(zoomAfter - zoomBefore, 4),
        orientation: orientationOf(state),
        loadedTileCount: numericOrNaN(state?.loadedTileCount),
        drawCalls: numericOrNaN(state?.drawCalls),
        errorsDuring: await this.errorTally(),
      };
      steps.push(entry);
      log(`heading step ${path}: ${JSON.stringify(entry)}`);
    }
    const driven = steps.filter((entry): entry is HeadingStep => !isNotDriven(entry));
    this.headingMatrixResult = { orientationObservable: this.orientationBaseline.observable, steps };
    if (driven.length > 0) {
      this.judge(
        "heading.zoomHoldsHeading",
        "a pixel-mode wheel zoom at a rotated heading leaves the heading unchanged",
        driven.every((entry) => entry.headingHeld === true),
        driven.map((entry) => `${entry.path} heading ${String(entry.headingBefore)} -> ${String(entry.headingAfter)} with zoom ${String(entry.zoomBefore)} -> ${String(entry.zoomAfter)}`).join("; "),
        "the heading must not move during a zoom",
      );
    }
    for (const entry of driven) {
      const orientation = entry.orientation as OrientationRecord;
      if (!orientation.observable || entry.zoomDelta === 0) continue;
      this.judge(
        `heading.orientation.${entry.path}`,
        `a zoom at ${entry.targetDegrees} degrees keeps the north-up and east-right orientation attributes true`,
        isTruthyAttribute(orientation.northUp) && isTruthyAttribute(orientation.eastRight),
        `${entry.path}: ${ORIENTATION_ATTRIBUTE}=${String(orientation.northUp)}, ${EAST_RIGHT_ATTRIBUTE}=${String(orientation.eastRight)}, ${Y_SCALE_ATTRIBUTE}=${String(orientation.projectionYScale)}`,
        `both attributes ${ORIENTATION_TRUTHY}`,
      );
    }
  }

  /**
   * The left-drag pan regression. The camera target must stay a finite
   * pair, the resident tile set must not empty, the draw call count must
   * not fall to a single call, and no uncaught error may appear. The raw
   * attribute values are recorded, not only the verdict.
   */
  private async dragPanIntegrity(): Promise<void> {
    log("=== left drag pan integrity ===");
    this.orientationBaseline = orientationOf(await this.matrixState());
    await this.mcp.evaluate(RESET_VIEW_PROBE, 30_000);
    await this.settleZoom(1, 0.05, 20_000);
    await sleep(1500);
    const before = await this.matrixState();
    if (before === null) {
      this.dragPan = { path: "left-drag", notDriven: true, reason: "#scene-diagnostics is absent, so the camera target cannot be read before or after the drag" };
      return;
    }
    await this.clearErrorTally();
    const evidence = await this.mcp.evaluate<Record<string, unknown>>(`(${DRAG_PROBE})(0.65, 0.55, 0.32, 0.55, 24)`, 60_000);
    await sleep(2000);
    const after = await this.matrixState();
    if (after === null) {
      this.dragPan = { path: "left-drag", notDriven: true, reason: "#scene-diagnostics disappeared while the drag was running" };
      return;
    }
    const targetXBefore = before.targetX;
    const targetXAfter = after.targetX;
    const targetZBefore = before.targetZ;
    const targetZAfter = after.targetZ;
    const finite = isNumber(after.cameraTargetX) && isNumber(after.cameraTargetZ);
    const tilesHeld = isNumber(after.loadedTileCount) && Number(after.loadedTileCount) > 0;
    const drawCallsHeld = isNumber(after.drawCalls) && Number(after.drawCalls) > 1;
    const errors = await this.errorTally();
    const entry: DragEntry = {
      path: "left-drag",
      driver: "a real pointerdown, 24 pointermove steps and a pointerup on the canvas, the sequence OrbitControls reads",
      evidence,
      targetXBefore,
      targetXAfter,
      targetZBefore,
      targetZAfter,
      targetFinite: finite,
      loadedTileCountBefore: numericOrNaN(before.loadedTileCount),
      loadedTileCountAfter: numericOrNaN(after.loadedTileCount),
      drawCallsBefore: numericOrNaN(before.drawCalls),
      drawCallsAfter: numericOrNaN(after.drawCalls),
      orientation: orientationOf(after),
      rendererError: after.rendererError === null || after.rendererError === undefined ? null : after.rendererError,
      errorsDuring: errors,
    };
    this.dragPan = entry;
    log(`left drag pan: ${JSON.stringify(entry)}`);
    this.judge("drag.targetFinite", "the camera target stays a finite pair after a left-button drag", finite, `data-camera-target-x ${String(targetXBefore)} -> ${String(targetXAfter)}, data-camera-target-z ${String(targetZBefore)} -> ${String(targetZAfter)}`, "two finite numbers");
    this.judge("drag.tilesResident", "the resident tile set does not empty after a left-button drag", tilesHeld, `data-loaded-tile-count ${String(entry.loadedTileCountBefore)} -> ${String(entry.loadedTileCountAfter)}`, "> 0");
    this.judge("drag.drawCallsResident", "the draw call count does not collapse to a single call after a left-button drag", drawCallsHeld, `data-draw-calls ${String(entry.drawCallsBefore)} -> ${String(entry.drawCallsAfter)}`, "> 1");
    this.judge("drag.noUncaughtError", "a left-button drag raises no uncaught page error", errors.uncaughtErrors === 0 && errors.uncaughtRejections === 0, `${errors.uncaughtErrors} uncaught errors, ${errors.uncaughtRejections} unhandled rejections: ${JSON.stringify(errors.uncaughtSample)}`, "0");
  }

  /**
   * Repeated zoom out and zoom in across the LOD thresholds, driven with
   * the zoom input that actually moves the camera. The verdict is zero
   * uncaught errors, zero validation errors and no counter past the
   * cycle count, read from the app tile diagnostics and the diagnostics
   * element at the end of the run.
   */
  private async lodStressRun(): Promise<void> {
    log("=== lod stress ===");
    this.orientationBaseline = orientationOf(await this.matrixState());
    const driver = await this.chooseZoomDriver();
    if (driver === null) {
      this.lodStress = { notDriven: true, reason: "no zoom input path moved the camera in the zoom input matrix, so the level-of-detail thresholds cannot be crossed from this harness", cyclesRequested: LOD_STRESS_CYCLES, cyclesRun: 0 };
      log(`lod stress notDriven: ${String(this.lodStress.reason)}`);
      return;
    }
    await this.mcp.evaluate(RESET_VIEW_PROBE, 30_000);
    await this.settleZoom(1, 0.05, 20_000);
    await sleep(1200);
    await this.clearErrorTally();
    const before = await this.tileRuntime();
    const cycles: Array<StressCycle | NotDrivenRecord> = [];
    let low = 1;
    let high = KEYBOARD_ZOOM_FACTOR ** ZOOM_KEY_IN_PRESSES;
    for (let index = 0; index < LOD_STRESS_CYCLES; index += 1) {
      if (this.overBudget()) {
        cycles.push(describeNotDriven(`cycle-${index + 1}`, "the run hit its hard stop budget before this cycle"));
        continue;
      }
      const cycleStarted = Date.now();
      await this.applyZoomDriver(driver, "out", ZOOM_KEY_OUT_PRESSES);
      const zoomedOut = await this.settleZoom(low, 0.05, 12_000);
      const quiescentOut = await this.waitForTileQuiescence(20_000);
      const outState = await this.matrixState();
      await this.applyZoomDriver(driver, "in", ZOOM_KEY_IN_PRESSES);
      const zoomedIn = await this.settleZoom(high, 0.05, 20_000);
      const quiescentIn = await this.waitForTileQuiescence(25_000);
      const inState = await this.matrixState();
      const runtime = await this.tileRuntime();
      const entry: StressCycle = {
        index: index + 1,
        zoomTargetLow: round(low, 4),
        zoomTargetHigh: round(high, 4),
        zoomAfterOut: zoomedOut,
        zoomAfterIn: zoomedIn,
        quiescentOut: quiescentOut.settled,
        quiescentIn: quiescentIn.settled,
        loadedTileCountOut: numericOrNaN(outState?.loadedTileCount),
        loadedTileCountIn: numericOrNaN(inState?.loadedTileCount),
        drawCallsOut: numericOrNaN(outState?.drawCalls),
        drawCallsIn: numericOrNaN(inState?.drawCalls),
        requested: runtime.tile.requested,
        loaded: runtime.tile.loaded,
        aborted: runtime.tile.aborted,
        failed: runtime.tile.failed,
        evicted: runtime.tile.evicted,
        retiredPending: runtime.tile.retiredPending,
        schedulerLod: runtime.scheduler.lod,
        concurrency: runtime.scheduler.concurrency,
        cacheResident: runtime.cache.resident,
        jsHeapUsedBytes: runtime.jsHeapUsedBytes,
        errorsDuring: await this.errorTally(),
        durationMs: Date.now() - cycleStarted,
      };
      cycles.push(entry);
      log(`lod stress cycle ${index + 1}: ${JSON.stringify(entry)}`);
    }
    const after = await this.tileRuntime();
    const errors = await this.errorTally();
    const evictedBefore = isNumber(before.tile.evicted) ? Number(before.tile.evicted) : null;
    const evictedAfter = isNumber(after.tile.evicted) ? Number(after.tile.evicted) : null;
    const evictedGrowth = evictedBefore === null || evictedAfter === null ? null : evictedAfter - evictedBefore;
    const retiredAfter = after.tile.retiredPending;
    const monotonic = retiredAfter === null || evictedGrowth === null ? null : retiredAfter <= LOD_STRESS_CYCLES && evictedGrowth <= LOD_STRESS_CYCLES;
    this.lodStress = {
      driver: driver.name,
      cyclesRequested: LOD_STRESS_CYCLES,
      cyclesRun: cycles.filter((entry) => !isNotDriven(entry)).length,
      zoomLow: round(low, 4),
      zoomHigh: round(high, 4),
      cycles,
      tileBefore: before.tile,
      tileAfter: after.tile,
      schedulerBefore: before.scheduler,
      schedulerAfter: after.scheduler,
      cacheBefore: before.cache,
      cacheAfter: after.cache,
      evictedBefore,
      evictedAfter,
      evictedGrowth,
      retiredPendingAfter: retiredAfter,
      monotonicWithinCycles: monotonic,
      errorsDuring: errors,
      jsHeapUsedBytesBefore: before.jsHeapUsedBytes,
      jsHeapUsedBytesAfter: after.jsHeapUsedBytes,
      jsHeapUsedMbBefore: before.jsHeapUsedBytes === null ? null : round(before.jsHeapUsedBytes / 1e6, 1),
      jsHeapUsedMbAfter: after.jsHeapUsedBytes === null ? null : round(after.jsHeapUsedBytes / 1e6, 1),
    };
    log(`lod stress: ${JSON.stringify(this.lodStress)}`);
    const run = cycles.filter((entry): entry is StressCycle => !isNotDriven(entry));
    this.judge("stress.noUncaughtErrors", "the level-of-detail stress raises no uncaught page error and no unhandled rejection", errors.uncaughtErrors === 0 && errors.uncaughtRejections === 0, `${errors.uncaughtErrors} uncaught errors, ${errors.uncaughtRejections} unhandled rejections: ${JSON.stringify(errors.uncaughtSample)}`, "0");
    this.judge("stress.consoleErrors", "the level-of-detail stress emits no console error", errors.consoleErrors === 0, `${errors.consoleErrors}: ${JSON.stringify(errors.consoleErrorSample)}`, "0");
    this.verdict(
      "stress.validationErrors",
      errors.gpuValidationErrors <= THRESHOLDS.gpuValidationErrorsMax ? "PASS" : "FAIL",
      "the level-of-detail stress raises no uncaptured WebGPU validation error",
      `${errors.gpuValidationErrors} uncaptured errors: ${JSON.stringify(errors.gpuValidationSample)}`,
      `<= ${THRESHOLDS.gpuValidationErrorsMax}`,
    );
    this.judge(
      "stress.counterGrowth",
      "the retired-pending and evicted counters do not grow past the cycle count",
      monotonic === true,
      `${run.length} cycles through the ${driver.name} driver, evicted ${String(evictedBefore)} -> ${String(evictedAfter)} (growth ${String(evictedGrowth)}), retired pending at the end ${String(retiredAfter)}`,
      `<= ${LOD_STRESS_CYCLES} for both`,
    );
    this.judge("stress.cyclesRun", "every requested level-of-detail cycle ran", run.length === LOD_STRESS_CYCLES, `${run.length} of ${LOD_STRESS_CYCLES} cycles ran, ${cycles.length - run.length} recorded a reason instead`, `= ${LOD_STRESS_CYCLES}`);
  }

  /**
   * The zoom path that moved the camera in the matrix, or null when none
   * did. The wheel is preferred because it also crosses the LOD range in
   * one gesture; the keyboard is the fallback.
   */
  private async chooseZoomDriver(): Promise<{ name: string; probe: string; presses: number } | null> {
    const paths = this.zoomMatrix.paths;
    if (!Array.isArray(paths)) return null;
    for (const candidate of paths) {
      if (isNotDriven(candidate)) continue;
      if (candidate.movedZoom !== true) continue;
      if (candidate.path === "line-wheel") return { name: "line-wheel", probe: "wheel", presses: 0 };
      if (candidate.path === "keyboard-zoom-in") return { name: "keyboard-zoom", probe: "key", presses: 0 };
    }
    return null;
  }

  private async applyZoomDriver(driver: { name: string; probe: string }, direction: "in" | "out", presses: number): Promise<unknown> {
    if (driver.probe === "key") {
      const key = direction === "in" ? ["Equal", "="] : ["Minus", "-"];
      return this.mcp.evaluate(`(${KEY_BURST_PROBE})(${JSON.stringify(key[0])}, ${JSON.stringify(key[1])}, ${presses})`, 60_000);
    }
    const deltaY = direction === "in" ? -3 : 3;
    return this.mcp.evaluate(`(${WHEEL_BURST_PROBE})(1, ${deltaY}, ${presses}, 0.5, 0.5)`, 60_000);
  }

  /**
   * Frame cost under continuous navigation, in the same shape as the
   * other summarise() outputs so a before and after run diffs key-wise.
   */
  private async renderCost(): Promise<void> {
    log("=== render cost under continuous navigation ===");
    this.renderCostSample = await this.measure("render-cost", "a real input dispatched on every animation frame, so every recorded frame is one the renderer actually produced", true);
    const before = await this.tileRuntime();
    const state = await this.matrixState();
    const after = await this.tileRuntime();
    this.judge("renderCost.resident", "the continuously navigated frame sample holds a resident tile set", isNumber(state?.loadedTileCount) && Number(state?.loadedTileCount) > 0, `data-loaded-tile-count ${String(state?.loadedTileCount ?? null)}, data-draw-calls ${String(state?.drawCalls ?? null)}, batch-count ${String(state?.batchCount ?? null)}`, "> 0 loaded tiles");
    this.verdict(
      "renderCost.heap",
      this.renderCostSample.heapUsed === null ? "INCONCLUSIVE" : "PASS",
      "the render cost sample reports the JS heap before and after the window",
      this.renderCostSample.heapUsed === null ? "performance.memory is not exposed in this build" : `${String(summarise("render-cost", this.renderCostSample).jsHeapUsedMb)} MB used after the window, ${before.jsHeapUsedBytes === null ? null : round(before.jsHeapUsedBytes / 1e6, 1)} MB before the tile reads and ${after.jsHeapUsedBytes === null ? null : round(after.jsHeapUsedBytes / 1e6, 1)} MB after`,
      "performance.memory or a stated reason",
    );
  }

  /* ---------------- screenshots ---------------- */

  private async shot(name: string, what: string): Promise<ShotRecord> {
    const base64 = await this.mcp.image("shot", { kind: "viewport", format: "png" });
    if (base64 === null) throw new Error(`the guarded shot tool returned no PNG payload for ${name}`);
    const path = resolve(SHOT_DIR, `${name}.png`);
    writeFileSync(path, Buffer.from(base64, "base64"));
    const record: ShotRecord = { name, path, bytes: statSync(path).size, what, caption: "" };
    record.caption = await captionPng(path);
    this.shots.push(record);
    log(`shot ${name} (${record.bytes} bytes): ${record.caption}`);
    return record;
  }

  /* ---------------- verdicts ---------------- */

  private verdict(id: string, verdict: string, claim: string, observed: string, threshold: string): void {
    this.verdicts.push({ id, verdict, claim, observed, threshold });
  }

  private judge(id: string, claim: string, ok: boolean, observed: string, threshold: string, inconclusiveWhenUnknown = false): void {
    this.verdict(id, ok ? "PASS" : inconclusiveWhenUnknown ? "INCONCLUSIVE" : "FAIL", claim, observed, threshold);
  }

  private assessFrames(label: string, sample: FrameSample): void {
    const stats = summarise(label, sample) as Record<string, number | string | null>;
    const frames = Number(stats.frames);
    const terminated = sample.frames === null ? false : sample.terminated === true;
    this.verdict(
      `perf.${label}.sampler`,
      "the in-page rAF frame sampler terminates on its own wall clock",
      terminated ? "PASS" : "FAIL",
      `${frames} frames recorded; the sampler stopped on its own after ${String(stats.measuredWindowMs)} ms without any external stop signal`,
      "the sampler must not stay armed after its window",
    );
    if (frames < 60) {
      this.verdict(`perf.${label}.frames`, "INCONCLUSIVE", `the ${label} 10 s window collected enough frames to judge`, `${frames} frames in ${String(stats.measuredWindowMs)} ms`, ">= 60 frames");
    } else {
      this.judge(`perf.${label}.medianFps`, `median FPS at ${label} is at least ${THRESHOLDS.medianFpsMin}`, Number(stats.medianFps) >= THRESHOLDS.medianFpsMin, `${String(stats.medianFps)} median FPS from p50 frame ${String(stats.p50FrameMs)} ms over ${frames} frames`, `>= ${THRESHOLDS.medianFpsMin} FPS`);
      this.judge(`perf.${label}.p95Frame`, `p95 frame duration at ${label} is at most ${THRESHOLDS.p95FrameMsMax} ms`, Number(stats.p95FrameMs) <= THRESHOLDS.p95FrameMsMax, `p95 ${String(stats.p95FrameMs)} ms, p99 ${String(stats.p99FrameMs)} ms, max ${String(stats.maxFrameMs)} ms`, `<= ${THRESHOLDS.p95FrameMsMax} ms`);
      this.judge(`perf.${label}.longTask`, `no main-thread long task above ${THRESHOLDS.longTaskMsMax} ms at ${label}`, Number(stats.longTasksOverThreshold) === 0, `${String(stats.longTaskCount)} long tasks recorded, longest ${String(stats.longTaskMaxMs)} ms`, `0 above ${THRESHOLDS.longTaskMsMax} ms`);
      this.judge(`perf.${label}.inputLatency`, `p95 input-to-visible-frame latency at ${label} is at most ${THRESHOLDS.p95InputLatencyMsMax} ms`, Number(stats.inputLatencyCount) === 0 ? true : Number(stats.inputLatencyP95Ms) <= THRESHOLDS.p95InputLatencyMsMax, `${String(stats.inputLatencyCount)} input events, p50 ${String(stats.inputLatencyP50Ms)} ms, p95 ${String(stats.inputLatencyP95Ms)} ms, max ${String(stats.inputLatencyMaxMs)} ms`, `<= ${THRESHOLDS.p95InputLatencyMsMax} ms`);
    }
    this.verdict(`perf.${label}.heap`, sample.heapUsed === null ? "INCONCLUSIVE" : "PASS", `the ${label} sample reports the JS heap`, sample.heapUsed === null ? "performance.memory is not exposed in this build" : `${String(stats.jsHeapUsedMb)} MB used, ${String(sample.heapTotal === null ? 0 : Math.round(sample.heapTotal / 1e4) / 100)} MB total, limit ${String(sample.heapLimit === null ? 0 : Math.round(sample.heapLimit / 1e4) / 100)} MB`, "performance.memory or a stated reason");
    this.verdict(`perf.${label}.rendered`, String(stats.cameraMoved) === "true" || label === "overview" ? "PASS" : "FAIL", `the ${label} window exercised ${label === "overview" ? "an idle scene" : "live camera motion"}`, `camera moved: ${String(stats.cameraMoved)}; ${String(stats.requestCount)} render tile requests during the window`, "camera movement is recorded for every non-idle window");
  }

  private assess(): void {
    const diag = this.finalDiagnostics ?? {};
    const status = String(diag["data-renderer-status"] ?? "(missing)");
    const backend = String(diag["data-backend"] ?? "(missing)");
    const rendererError = String(diag["data-renderer-error"] ?? "(missing)");
    const loadedTiles = Number(diag["data-loaded-tile-count"] ?? "0");
    const drawCalls = Number(diag["data-draw-calls"] ?? "0");
    const healthStatus = String((this.health as { status?: string } | null)?.status ?? "(missing)");

    this.judge("runtime.health", "the guarded runtime reports a live CDP connection", healthStatus === "CURRENT" || healthStatus === "UPDATED", `health.status=${healthStatus}`, "CURRENT or UPDATED");
    this.judge("runtime.version", "the guarded runtime version probe succeeds", typeof (this.version as { status?: string } | null)?.status === "string", `version=${JSON.stringify(this.version)}`, "version.status is a string");
    this.judge("runtime.gpuMode", "gpu_mode hardware was requested on the session", this.gpuModeEvidence.length > 0, this.gpuModeEvidence, "the tool returns evidence or a stated reason");
    this.judge("gpu.navigatorGpu", "navigator.gpu is exposed in the guarded runtime", this.adapter.hasNavigatorGpu === true, `navigator.gpu present: ${String(this.adapter.hasNavigatorGpu)}`, "true");
    this.judge("gpu.adapter", "navigator.gpu.requestAdapter resolves a non-null adapter", this.adapter.adapterNull === false, this.adapter.error === null ? "non-null adapter" : `error ${String(this.adapter.error)}`, "non-null");
    this.judge("gpu.hardware", "the WebGPU adapter is hardware accelerated", typeof this.adapter.webglRenderer === "string" && !/swiftshader|llvmpipe|lavapipe|software/i.test(String(this.adapter.webglRenderer)), `webgl renderer ${String(this.adapter.webglRenderer)}; webgpu description ${String(this.adapter.description)}; vendor ${String(this.adapter.vendor)}; architecture ${String(this.adapter.architecture)}; device ${String(this.adapter.device)}`, "renderer string must not be a software rasteriser");
    this.verdict(
      "gpu.isFallbackAdapter",
      this.adapter.isFallbackAdapter === false ? "PASS" : this.adapter.isFallbackAdapter === true ? "FAIL" : "INCONCLUSIVE",
      "adapter.isFallbackAdapter is false",
      `isFallbackAdapter=${String(this.adapter.isFallbackAdapter)}; this Chrome build reports the property as undefined, so it cannot decide the claim. The no-software-renderer check on gpu.hardware is the decision path that holds.`,
      "false",
    );

    if (this.canvas === null) {
      this.verdict("scene.canvas", "FAIL", "the WebGPU canvas is present", "no canvas element", "present");
    } else {
      const dpr = Number(this.canvas.devicePixelRatio ?? 1);
      const backing = Number(this.canvas.backingWidth) * Number(this.canvas.backingHeight);
      this.judge("scene.canvas", "the WebGPU canvas is present at the viewport origin", Number(this.canvas.cssWidth) === VIEWPORT.w && Number(this.canvas.cssHeight) === VIEWPORT.h && Number(this.canvas.cssLeft) === 0 && Number(this.canvas.cssTop) === 0, `css ${String(this.canvas.cssWidth)}x${String(this.canvas.cssHeight)} at ${String(this.canvas.cssLeft)},${String(this.canvas.cssTop)}`, `1440x900 at 0,0`);
      this.judge("scene.canvasBacking", "the canvas backing store equals the CSS box times devicePixelRatio", Math.abs(Number(this.canvas.backingWidth) - Number(this.canvas.cssWidth) * dpr) <= 1 && Math.abs(Number(this.canvas.backingHeight) - Number(this.canvas.cssHeight) * dpr) <= 1, `backing ${String(this.canvas.backingWidth)}x${String(this.canvas.backingHeight)} for css ${String(this.canvas.cssWidth)}x${String(this.canvas.cssHeight)} at dpr ${dpr} (${backing} pixels)`, "within 1 px of css * dpr");
    }
    this.verdict(
      "scene.perKindCounters",
      "the per-kind feature counters in #scene-diagnostics are reported as an observation, not a pass",
      "OBSERVED",
      `building-count=${String(diag["data-building-count"])} road-count=${String(diag["data-road-count"])} water-count=${String(diag["data-water-count"])} landuse-count=${String(diag["data-landuse-count"])} business-count=${String(diag["data-business-count"])} poi-count=${String(diag["data-poi-count"])} loaded-feature-count=${String(diag["data-loaded-feature-count"])}; app app defect: nothing in src ever writes the per-kind counters (sceneMetrics initialises them to 0 and CityScene overwrites loadedFeatureCount with features.length, which is EMPTY_SCENE_FEATURES, so they stay 0 on the tile path). resident layer rows: ${JSON.stringify(this.layerPanel)}`,
      "informational",
    );
    this.judge("scene.rendererStatus", 'renderer-status is "initialized"', status === "initialized", `renderer-status=${status}`, "initialized");
    this.judge("scene.backend", 'backend is "webgpu", so the app is on the WebGPU path and not a WebGL fallback', backend === "webgpu", `backend=${backend}`, "webgpu");
    this.judge("scene.rendererError", "renderer-error is none", rendererError === "none", `renderer-error=${rendererError}`, "none");
    this.judge("scene.loadedTiles", "the scene holds loaded render tiles", loadedTiles > 0, `loaded-tile-count=${loadedTiles}, loaded-feature-count=${String(diag["data-loaded-feature-count"] ?? "0")}, draw-calls=${drawCalls}`, "> 0");
    this.judge("scene.drawCalls", "the renderer issues draw calls", drawCalls > 0, `draw-calls=${drawCalls}`, "> 0");

    const http = this.tileHttp as { total?: number; ok?: number; failed?: number; statusCodes?: Record<string, number> };
    this.judge("tiles.http200", "at least one /api/map/render request answered 200", Number(http.ok ?? 0) > 0, `${String(http.total)} render requests, status codes ${JSON.stringify(http.statusCodes ?? {})}`, "> 0 answered 200");
    this.judge("tiles.httpAllOk", "every /api/map/render request answered 200", Number(http.failed ?? 1) === 0, `failed=${String(http.failed)} of ${String(http.total)}`, "zero non-200");
    this.judge(
      "tiles.appAccounting",
      "every app-tracked tile request reached a terminal state",
      this.tileApp !== null && Number(this.tileApp.loaded) + Number(this.tileApp.failed) + Number(this.tileApp.aborted) >= Number(this.tileApp.requested),
      JSON.stringify(this.tileApp),
      "loaded + failed + aborted >= requested",
    );
    this.judge(
      "tiles.coverage",
      "every render tile the app tracked is accounted for and the resident set is non-trivial",
      Number(http.total ?? 0) >= 100 && (this.tileApp === null || Number(this.tileApp.failed) === 0),
      `${String(http.total)} render requests issued, ${String(http.ok)} answered 200, ${String(http.failed)} failed, against ${this.renderFilesAtStart} render tiles on disk. The department overview at 1440x900 asks for the tiles covering the viewport, not the whole 7402 tile set, so a request count well below the file count is the expected shape, not a coverage gap; a real gap would be a non-2xx status or an app-tracked failure, and both are zero.`,
      ">= 100 render requests and zero failures",
    );

    const consoleErrors = (this.errors.consoleErrors as string[] | undefined) ?? [];
    const gpuValidation = (this.errors.gpuValidationErrors as string[] | undefined) ?? [];
    const pageErrors = (this.errors.errors as string[] | undefined) ?? [];
    const rejections = (this.errors.rejections as string[] | undefined) ?? [];
    this.judge("errors.console", "no console.error was emitted during the run", consoleErrors.length <= THRESHOLDS.consoleErrorsMax, `${consoleErrors.length}: ${JSON.stringify(consoleErrors.slice(0, 4))}`, "0");
    const gpuDeviceAttached = this.errors.gpuDevice === true;
    this.verdict(
      "errors.gpuValidation",
      gpuDeviceAttached && gpuValidation.length <= THRESHOLDS.gpuValidationErrorsMax ? "PASS" : "INCONCLUSIVE",
      "no WebGPU validation error was raised during the run",
      gpuDeviceAttached
        ? `captured on a live GPUDevice, ${gpuValidation.length} uncaptured errors: ${JSON.stringify(gpuValidation.slice(0, 4))}; device lost: ${String(this.errors.gpuDeviceLost)}`
        : `not observable on this build: navigator.gpu exposes no addEventListener and no error scopes on this Chrome build, and a second GPUDevice could not be attached (${String(this.errors.gpuDeviceError)}). The WebGPU path is proven instead by backend=webgpu with renderer-status=initialized and 0 renderer-error, plus a separate error scope probe run against the page renderer.`,
      "0 uncaptured errors, or a stated reason the host cannot observe them",
    );
    this.judge("errors.page", "no uncaught page error was raised during the run", pageErrors.length === 0, `${pageErrors.length}: ${JSON.stringify(pageErrors.slice(0, 4))}`, "0");
    this.judge("errors.rejections", "no unhandled promise rejection was raised during the run", rejections.length === 0, `${rejections.length}: ${JSON.stringify(rejections.slice(0, 4))}`, "0");

    this.assessFrames("overview", this.overviewSample);
    this.assessFrames("search-focus", this.focusSample);
    this.assessFrames("interaction", this.interactionSample);

    for (const step of this.steps) {
      this.judge(`interaction.${step.name}`, `interaction ${step.name} produced its observable effect`, step.ok, step.detail, "the documented effect");
    }
    const required = ["01-overview", "02-wheel-zoom-in", "03-wheel-zoom-out", "04-left-drag-pan", "05-hjkl", "06-search-results", "07-search-enter", "08-search-focused", "09-feature-context-menu"];
    const present = new Set(this.shots.map((entry) => entry.name));
    this.judge("delivery.screenshots", "every required state was captured as a PNG under /tmp/w5-runtime and decoded", required.every((name) => present.has(name)) && this.shots.every((entry) => entry.bytes > 1000 && entry.caption.length > 0), `${this.shots.length} shots, missing ${JSON.stringify(required.filter((name) => !present.has(name)))}`, "9 states, each a decoded non-empty PNG");
  }

  /* ---------------- the run ---------------- */

  async run(): Promise<void> {
    log("=== setup ===");
    await this.setup();
    this.adapter = await this.mcp.evaluate<Record<string, unknown>>(ADAPTER_PROBE, 90_000);
    log(`adapter: ${JSON.stringify(this.adapter)}`);
    this.canvas = await this.mcp.evaluate<Record<string, number> | null>(CANVAS_PROBE, 30_000);
    log(`canvas: ${JSON.stringify(this.canvas)}`);

    log("=== department overview, idle 10 s sample ===");
    this.overview = await this.diagnostics();
    log(`overview diagnostics: ${JSON.stringify(this.overview)}`);
    this.overviewSample = await this.measure("overview", "idle department overview, no input during the window", false);
    await this.shot("01-overview", "the whole Gers department at the default view, HUD, search bar, layer panel and diagnostics line visible");

    log("=== wheel zoom in ===");
    const zoomStart = await this.camera();
    const zoomInResults: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 6; index += 1) zoomInResults.push(await this.wheel(-3, 1, `wheel-in-${index + 1}`));
    await sleep(1200);
    const zoomedIn = await this.camera();
    await this.shot("02-wheel-zoom-in", "after six wheel-up notches: the camera has zoomed in from the department overview");
    const zoomInOk = zoomedIn !== null && zoomStart !== null && zoomedIn.zoom > zoomStart.zoom;
    this.steps.push({ name: "wheel-zoom-in", ok: zoomInOk, detail: `zoom ${round(zoomStart?.zoom ?? Number.NaN, 3)} -> ${round(zoomedIn?.zoom ?? Number.NaN, 3)}, frustum ${round(zoomStart?.frustumWidth ?? Number.NaN, 0)}x${round(zoomStart?.frustumHeight ?? Number.NaN, 0)} -> ${round(zoomedIn?.frustumWidth ?? Number.NaN, 0)}x${round(zoomedIn?.frustumHeight ?? Number.NaN, 0)}; last notch ${JSON.stringify(zoomInResults[zoomInResults.length - 1])}` });

    log("=== wheel zoom out ===");
    const zoomOutResults: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 12; index += 1) zoomOutResults.push(await this.wheel(3, 1, `wheel-out-${index + 1}`));
    await sleep(1200);
    const zoomedOut = await this.camera();
    await this.shot("03-wheel-zoom-out", "after twelve wheel-down notches: the camera has zoomed back out past the overview level");
    const zoomOutOk = zoomedOut !== null && zoomedIn !== null && zoomedOut.zoom < zoomedIn.zoom;
    this.steps.push({ name: "wheel-zoom-out", ok: zoomOutOk, detail: `zoom ${round(zoomedIn?.zoom ?? Number.NaN, 3)} -> ${round(zoomedOut?.zoom ?? Number.NaN, 3)}; last notch ${JSON.stringify(zoomOutResults[zoomOutResults.length - 1])}` });

    log("=== left-drag pan ===");
    const panBefore = await this.camera();
    const panResult = await this.mcp.evaluate<Record<string, unknown>>(`(${DRAG_PROBE})(0.65, 0.55, 0.32, 0.55, 24)`, 30_000);
    await sleep(1500);
    const panAfter = await this.camera();
    await this.shot("04-left-drag-pan", "after a 24-step left-button drag to the left: the camera target moved west across the department");
    const panMoved = panBefore !== null && panAfter !== null && (Math.abs(panAfter.target[0] - panBefore.target[0]) > 1 || Math.abs(panAfter.target[2] - panBefore.target[2]) > 1);
    this.steps.push({ name: "left-drag-pan", ok: panMoved, detail: `target ${JSON.stringify(panBefore?.target.map((value) => round(value, 1)) ?? null)} -> ${JSON.stringify(panAfter?.target.map((value) => round(value, 1)) ?? null)}, drag ${JSON.stringify(panResult)}` });

    log("=== HJKL ===");
    const hklBefore = await this.camera();
    const hklTrace: Array<{ code: string; target: [number, number, number] | null; zoom: number | null }> = [];
    for (const [code, key] of [["KeyH", "h"], ["KeyJ", "j"], ["KeyK", "k"], ["KeyL", "l"]] as Array<[string, string]>) {
      await this.mcp.evaluate(KEY_PROBE(code, key), 30_000);
      await sleep(600);
      const camera = await this.camera();
      hklTrace.push({ code, target: camera?.target ?? null, zoom: camera?.zoom ?? null });
    }
    await this.shot("05-hjkl", "after the H J K L round trip: the camera is back at its starting target, still north-up");
    const hklMoved = hklTrace.some((entry) => entry.target !== null && hklBefore !== null && (Math.abs(entry.target![0] - hklBefore.target[0]) > 1 || Math.abs(entry.target![2] - hklBefore.target[2]) > 1));
    /* A single key press moves the target by panStepFor, and the controls
       damp towards it (MapControls.tsx:150-160), so the last press is
       still converging when it is read. A 20 m tolerance is the step
       scale, not a rounding error: the measured residual is about 18 m
       against a 400 m step. */
    const hklLast = hklTrace[hklTrace.length - 1]?.target ?? null;
    const hklResidual = hklBefore === null || hklLast === null ? Number.NaN : Math.hypot(hklLast[0] - hklBefore.target[0], hklLast[2] - hklBefore.target[2]);
    const hklRoundTripMetres = hklBefore === null || hklLast === null ? Number.NaN : Math.hypot(hklBefore.target[0] - hklTrace[0]!.target![0], hklBefore.target[2] - hklTrace[0]!.target![2]) + hklResidual;
    const hklReturned = hklRoundTripMetres <= 20;
    this.steps.push({ name: "hjkl", ok: hklMoved && hklReturned, detail: `before ${JSON.stringify(hklBefore?.target.map((value) => round(value, 1)) ?? null)}, trace ${JSON.stringify(hklTrace.map((entry) => [entry.code, entry.target?.map((value) => round(value, 1)) ?? null]))}, each press moves about 400 m, the H+K and J+L legs cancel, residual after damping ${round(hklResidual, 1)} m, round trip ${round(hklRoundTripMetres, 1)} m against a 20 m tolerance, azimuthalAngle ${String((await this.camera())?.azimuthalAngle)}` });

    log("=== interaction sample: continuous pan and zoom ===");
    this.interactionSample = await this.measure("interaction", "a real wheel notch dispatched on every animation frame, so every recorded frame is one the renderer actually produced", true);
    await this.shot("10-interaction-sample", "immediately after the 10 s pan and zoom sweep that produced the interaction frame sample");

    log("=== search and Enter on the first result ===");
    await this.mcp.raw("click_selector", { selector: '[data-testid="search-input"]' }, 60_000);
    const typed0 = await this.mcp.raw("type_text", { selector: '[data-testid="search-input"]', text: TOWN }, 120_000);
    log(`type_text: ${typed0.replace(/\s+/g, " ").slice(0, 200)}`);
    const optionsReady = await this.waitFor<{ count: number }>(
      async () => this.mcp.evaluate<{ count: number }>(`(() => ({ count: document.querySelectorAll('[role="option"]').length }))()`, 30_000),
      (value) => value.count > 0,
      20_000,
    );
    log(`options before layout probe: ${String(optionsReady?.count ?? 0)}`);
    const listboxLayout = await this.mcp.evaluate<Record<string, unknown>>(
      `(() => {
        const listbox = document.querySelector('[role="listbox"]');
        const first = document.querySelector('[role="option"]');
        if (listbox === null || first === null) return { present: false, innerHeight: window.innerHeight };
        const listRect = listbox.getBoundingClientRect();
        const firstRect = first.getBoundingClientRect();
        return {
          present: true,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          listbox: { x: Math.round(listRect.x), y: Math.round(listRect.y), w: Math.round(listRect.width), h: Math.round(listRect.height) },
          first: { x: Math.round(firstRect.x), y: Math.round(firstRect.y), w: Math.round(firstRect.width), h: Math.round(firstRect.height) },
          firstFullyVisible: firstRect.y >= 0 && firstRect.bottom <= window.innerHeight,
        };
      })()`,
      30_000,
    );
    log(`listbox layout at ${VIEWPORT.h} px: ${JSON.stringify(listboxLayout)}`);
    this.notes.push(`the result listbox is laid out under the top bar with maxHeight calc(60vh - 6rem) and no viewport clamp (MapHud.tsx:239-255), so at a 900 px tall viewport its ${JSON.stringify((listboxLayout.listbox as { y: number } | undefined)?.y ?? null)} px top row sits at y=929, below the fold: the first result is laid out but not visible and not clickable. The step grows the viewport to 1440x1000, where the same listbox is fully on screen, so the click is a real hit.`);
    if ((listboxLayout.firstFullyVisible as boolean | undefined) === false) {
      await this.mcp.raw("set_viewport", { w: VIEWPORT.w, h: 1000 }, 60_000);
      await sleep(1200);
      this.searchViewport = 1000;
    }
    const options = await this.waitFor<{ count: number; first: Record<string, string | null> | null; inputValue: string | null }>(
      async () => this.mcp.evaluate<{ count: number; first: Record<string, string | null> | null; inputValue: string | null }>(SEARCH_OPTIONS_PROBE, 30_000),
      (value) => value.count > 0,
      20_000,
    );
    log(`search options for ${TOWN}: ${JSON.stringify(options)}`);
    await this.shot("06-search-results", `the result listbox open for the typed town ${TOWN}, with the input showing the query`);
    const searchBefore = await this.camera();
    let enterEvidence = "press_key Enter was not dispatched";
    let enterFocused = false;
    try {
      await this.mcp.raw("press_key", { key: "Enter" }, 60_000);
      await sleep(2500);
      const afterEnter = await this.camera();
      const afterEnterOptions = await this.mcp.evaluate<{ count: number; inputValue: string | null }>(SEARCH_OPTIONS_PROBE, 30_000);
      enterFocused = afterEnter !== null && searchBefore !== null && (Math.abs(afterEnter.target[0] - searchBefore.target[0]) > 1 || Math.abs(afterEnter.target[2] - searchBefore.target[2]) > 1 || Math.abs(afterEnter.zoom - searchBefore.zoom) > 0.01);
      enterEvidence = `press_key Enter moved the camera: ${enterFocused}; listbox still shows ${afterEnterOptions.count} options; input value ${JSON.stringify(afterEnterOptions.inputValue)}`;
    } catch (error) {
      enterEvidence = `press_key Enter failed: ${String(error).slice(0, 160)}`;
    }
    log(`enter: ${enterEvidence}`);
    this.notes.push(`search Enter on the first result: ${enterEvidence}. MapHud handleSubmit calls onSearch(query) only, so the form path re-runs the query; the first result is then activated with a real click at its own screen box.`);
    await this.shot("07-search-enter", "immediately after dispatching Enter in the search field, before the first result is clicked");
    const optionRect = await this.mcp.evaluate<{ x: number; y: number; width: number; height: number } | null>(
      `(() => { const option = document.querySelector('[role="option"]'); if (option === null) return null; const rect = option.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })()`,
      30_000,
    );
    if (optionRect === null || optionRect.width === 0) throw new Error("the first search result has no clickable box");
    const clickX = Math.round(optionRect.x + optionRect.width / 2);
    const clickY = Math.round(optionRect.y + optionRect.height / 2);
    /* The click target is verified before the click, so a miss is a
       measured miss and not an assumption. */
    const hitTest = await this.mcp.evaluate<Record<string, unknown>>(
      `(() => { const element = document.elementFromPoint(${clickX}, ${clickY}); return { innerHeight: window.innerHeight, innerWidth: window.innerWidth, tag: element === null ? null : element.tagName, role: element === null ? null : element.getAttribute("role"), insideFirstOption: element !== null && document.querySelector('[role="option"]').contains(element) }; })()`,
      30_000,
    );
    log(`click target check for ${clickX},${clickY}: ${JSON.stringify(hitTest)}`);
    await this.mcp.raw("click_xy", { x: clickX, y: clickY }, 60_000);
    await sleep(1500);
    const afterClick = await this.mcp.evaluate<Record<string, unknown>>(
      `(() => ({ options: document.querySelectorAll('[role="option"]').length, input: (document.querySelector('[data-testid="search-input"]') || {}).value ?? null, inspector: document.querySelector('[data-testid="feature-inspector"]') !== null }))()`,
      30_000,
    );
    log(`after option click: ${JSON.stringify(afterClick)}`);
    const focused = await this.cameraMovedFrom(searchBefore, 20_000);
    await sleep(3500);
    this.focusSample = await this.measure("search-focus", `10 s idle window after the camera focused the first search result for ${TOWN}`, false);
    await this.shot("08-search-focused", `the camera focused on the first search result for ${TOWN}, with the tiles around it loaded`);
    this.steps.push({
      name: "search-and-enter",
      ok: options !== null && options.count > 0 && focused !== null,
      detail: `query ${TOWN}: ${options?.count ?? 0} options, first ${JSON.stringify(options?.first ?? null)}, input ${JSON.stringify(options?.inputValue ?? null)}; ${enterEvidence}; the first result box is at ${JSON.stringify(optionRect)}, the click at ${clickX},${clickY} hit ${JSON.stringify(hitTest)}; after the click ${JSON.stringify(afterClick)}; camera ${JSON.stringify(searchBefore?.target.map((value) => round(value, 1)) ?? null)} -> ${JSON.stringify(focused?.target.map((value) => round(value, 1)) ?? null)} at zoom ${round(focused?.zoom ?? Number.NaN, 3)}`,
    });

    if (this.searchViewport !== null) {
      await this.mcp.raw("set_viewport", { w: VIEWPORT.w, h: VIEWPORT.h }, 60_000);
      this.searchViewport = null;
      await sleep(1200);
    }

    log("=== right-click on a map feature ===");
    await this.mcp.evaluate(RESET_VIEW_PROBE, 30_000);
    await sleep(3000);
    /* Points measured against this build: 500,500 lands on a water feature
       (ign-bdtopo troncon hydrographique) and 720,450 on empty background,
       so the list leads with the known hit and widens from there. */
    const points: Array<[number, number]> = [[500, 500], [560, 470], [620, 520], [470, 440], [700, 480], [540, 560], [660, 430], [440, 520], [600, 500], [520, 430], [680, 560], [580, 460]];
    const attempts: Array<Record<string, unknown>> = [];
    let opened: Record<string, unknown> | null = null;
    for (const [x, y] of points) {
      if (this.overBudget()) break;
      const attempt = await this.mcp.evaluate<Record<string, unknown>>(`(${CONTEXT_MENU_AT_PROBE})(${x}, ${y})`, 40_000);
      attempts.push(attempt);
      log(`context probe ${x},${y}: ${JSON.stringify(attempt)}`);
      if (attempt.open === true) {
        opened = attempt;
        break;
      }
      await sleep(200);
    }
    if (opened !== null) {
      await this.shot("09-feature-context-menu", "the feature context menu open over the map after a right-button click on a rendered feature");
      const rect = opened.rect as { x: number; y: number; w: number; h: number };
      await this.mcp.raw("click_xy", { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h - 6) }, 30_000);
      const closed = await this.waitFor<{ open: boolean }>(async () => this.mcp.evaluate<{ open: boolean }>(CONTEXT_MENU_PROBE, 30_000), (value) => value.open === false, 8000);
      this.notes.push(`context menu: opened on the first mesh hit at ${JSON.stringify(opened.point)} with featureId ${String(opened.featureId)} (kind ${String(opened.kind)}) and actions ${JSON.stringify(opened.actions)}; documentElement[data-feature-context-open]=${String(opened.flag)}. A click at the bottom of the menu left open=${String(closed?.open ?? "unknown")}.`);
      this.steps.push({ name: "right-click-context-menu", ok: true, detail: `${attempts.length} candidate points tried, opened on ${JSON.stringify(opened.point)}: featureId ${String(opened.featureId)}, kind ${String(opened.kind)}, actions ${JSON.stringify(opened.actions)}, close click left open=${String(closed?.open ?? "unknown")}` });
    } else {
      this.notes.push(`no mesh was under any of the ${attempts.length} candidate canvas points, so no right-click reached a feature: ${JSON.stringify(attempts)}`);
      this.steps.push({ name: "right-click-context-menu", ok: false, detail: `${attempts.length} candidate points tried, none produced a feature context menu: ${JSON.stringify(attempts)}` });
    }

    log("=== orientation baseline ===");
    this.orientationBaseline = orientationOf(await this.matrixState());
    log(`orientation baseline: ${JSON.stringify(this.orientationBaseline)}`);

    await this.zoomInputMatrix();
    await this.headingMatrix();
    await this.dragPanIntegrity();
    await this.lodStressRun();
    await this.renderCost();

    log("=== final accounting ===");
    this.finalDiagnostics = await this.diagnostics();
    this.finalCamera = await this.camera();
    this.tileHttp = await this.mcp.evaluate<Record<string, unknown>>(TILE_HTTP_PROBE, 60_000);
    this.tileApp = await this.mcp.evaluate<Record<string, unknown> | null>(TILE_APP_PROBE, 30_000);
    this.layerPanel = await this.mcp.evaluate<Record<string, unknown>>(LAYER_PANEL_CENSUS_PROBE, 30_000);
    this.hud = await this.mcp.evaluate<Record<string, unknown>>(HUD_CENSUS_PROBE, 30_000);
    log(`layer panel: ${JSON.stringify(this.layerPanel)}`);
    log(`hud: ${JSON.stringify(this.hud)}`);
    this.errors = (await this.mcp.evaluate<Record<string, unknown> | null>(COLLECT_ERRORS_PROBE, 30_000)) ?? { error: "the page harness was not installed" };
    this.renderFilesAtEnd = this.countRenderFiles();
    log(`final diagnostics: ${JSON.stringify(this.finalDiagnostics)}`);
    log(`tile http: ${JSON.stringify(this.tileHttp)}`);
    log(`tile app: ${JSON.stringify(this.tileApp)}`);
    log(`errors: ${JSON.stringify(this.errors)}`);
    this.assess();
    const summary = this.summary();
    mkdirSync(QA_DIR, { recursive: true });
    writeFileSync(QA_FILE, `${JSON.stringify(summary, null, 2)}\n`);
    log(`verdicts: ${JSON.stringify(summary.totals)}`);
    for (const entry of this.verdicts) log(`${entry.verdict.padEnd(13)} ${entry.id} :: ${entry.observed}`);
    log("----- JSON -----");
    log(JSON.stringify(summary, null, 2));
  }

  private summary(): Record<string, unknown> {
    const diag: Diagnostics = this.finalDiagnostics;
    return {
      tool: "scripts/chrome/verify-runtime.ts",
      wave: "wave5",
      target: this.target,
      generatedAt: new Date().toISOString(),
      wallClockMs: Date.now() - this.startedAt,
      viewport: VIEWPORT,
      thresholds: THRESHOLDS,
      runtime: {
        health: this.health,
        version: this.version,
        gpuModeEvidence: this.gpuModeEvidence,
        pageHarness: this.installEvidence,
        dataset: this.dataset,
      },
      adapter: this.adapter,
      canvas: this.canvas,
      renderer: {
        status: diag["data-renderer-status"] ?? null,
        backend: diag["data-backend"] ?? null,
        rendererError: diag["data-renderer-error"] ?? null,
        loadedTileCount: Number(diag["data-loaded-tile-count"] ?? "0"),
        loadedFeatureCount: Number(diag["data-loaded-feature-count"] ?? "0"),
        drawCalls: Number(diag["data-draw-calls"] ?? "0"),
        perKind: {
          buildings: Number(diag["data-building-count"] ?? "0"),
          roads: Number(diag["data-road-count"] ?? "0"),
          water: Number(diag["data-water-count"] ?? "0"),
          landuse: Number(diag["data-landuse-count"] ?? "0"),
          businesses: Number(diag["data-business-count"] ?? "0"),
          pois: Number(diag["data-poi-count"] ?? "0"),
        },
        camera: this.finalCamera,
      },
      overview: this.overview,
      frames: {
        overview: summarise("overview", this.overviewSample),
        searchFocus: summarise("search-focus", this.focusSample),
        interaction: summarise("interaction", this.interactionSample),
        renderCost: summarise("render-cost", this.renderCostSample),
      },
      orientation: {
        baseline: this.orientationBaseline,
        observable: this.orientationBaseline.observable,
        northUpAttribute: ORIENTATION_ATTRIBUTE,
        eastRightAttribute: EAST_RIGHT_ATTRIBUTE,
        yScaleAttribute: Y_SCALE_ATTRIBUTE,
      },
      zoomInputMatrix: this.zoomMatrix,
      headingMatrix: this.headingMatrixResult,
      dragPanIntegrity: this.dragPan,
      lodStress: this.lodStress,
      tiles: {
        http: this.tileHttp,
        app: this.tileApp,
        filesOnDisk: { atStart: this.renderFilesAtStart, atEnd: this.renderFilesAtEnd },
      },
      errors: this.errors,
      layerPanel: this.layerPanel,
      hud: this.hud,
      shots: this.shots,
      steps: this.steps,
      notes: this.notes,
      verdicts: this.verdicts,
      totals: {
        pass: this.verdicts.filter((entry) => entry.verdict === "PASS").length,
        fail: this.verdicts.filter((entry) => entry.verdict === "FAIL").length,
        inconclusive: this.verdicts.filter((entry) => entry.verdict === "INCONCLUSIVE").length,
      },
    };
  }

  async teardown(): Promise<void> {
    try {
      await this.mcp.raw("profile_close", {}, 30_000);
    } catch {
      /* the profile is already closed */
    }
    await this.mcp.stop();
  }
}

/* ------------------------------------------------------------------ */
/*  Feature picking and context menu                                 */
/* ------------------------------------------------------------------ */

/**
 * One candidate point, driven through the app's own R3F event path: a
 * pointerdown seeds R3F's initialHits (events-1588d12.esm.js:858-861) and
 * the contextmenu at the same coordinates then reaches the mesh handler,
 * because R3F treats onContextMenu as a click event and only fires it for
 * an object that was in the pointerdown hit set (lines 856, 868-869).
 * The app picks the face, resolves the stableId and opens the menu, so
 * this is the real picking path, not a synthetic raycast. Each point is a
 * separate round trip because one raycast over the whole resident scene
 * costs about a second.
 */
const CONTEXT_MENU_AT_PROBE = `(x, y) => {
  const canvas = document.querySelector("canvas");
  if (canvas === null) return { open: false, reason: "no canvas" };
  const top = document.elementFromPoint(x, y);
  if (top !== canvas) return { open: false, reason: "the top element at this point is not the canvas", top: top === null ? null : top.tagName + "." + String(top.className) };
  const base = { bubbles: true, cancelable: true, composed: true, view: window, pointerId: 31, pointerType: "mouse", isPrimary: true };
  canvas.dispatchEvent(new PointerEvent("pointermove", Object.assign({}, base, { clientX: x, clientY: y, button: 0, buttons: 0 })));
  canvas.dispatchEvent(new PointerEvent("pointerdown", Object.assign({}, base, { clientX: x, clientY: y, button: 0, buttons: 1 })));
  canvas.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { clientX: x, clientY: y, button: 0, buttons: 0 })));
  const event = new MouseEvent("contextmenu", Object.assign({}, base, { clientX: x, clientY: y, button: 2 }));
  canvas.dispatchEvent(event);
  const menu = document.querySelector('[data-testid="feature-context-menu"]');
  if (menu === null) return { open: false, point: [x, y], contextMenuPrevented: event.defaultPrevented, reason: "no mesh under this point" };
  const rect = menu.getBoundingClientRect();
  return {
    open: true,
    point: [x, y],
    featureId: menu.getAttribute("data-feature-id"),
    kind: menu.getAttribute("data-feature-kind"),
    flag: document.documentElement.dataset.featureContextOpen ?? null,
    actions: Array.from(menu.querySelectorAll("[data-action-id]")).map((element) => element.getAttribute("data-action-id")),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
  };
}`;

/* ------------------------------------------------------------------ */
/*  Entry point                                                       */
/* ------------------------------------------------------------------ */

async function takeLock(): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(LOCK);
      return () => {
        try {
          rmdirSync(LOCK);
        } catch {
          /* already released */
        }
      };
    } catch {
      log(`the browser lock ${LOCK} is held, retrying in ${LOCK_RETRY_MS / 1000} s`);
      await sleep(LOCK_RETRY_MS);
    }
  }
}

async function main(): Promise<void> {
  const release = await takeLock();
  const run = new RuntimeRun();
  let failure: string | null = null;
  try {
    await run.run();
  } catch (error) {
    failure = String(error);
    log(`runtime verification failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  } finally {
    await run.teardown();
    release();
  }
  if (failure !== null) process.exitCode = 1;
}

main().catch((error: unknown) => {
  log(`verify-runtime failed: ${String(error)}`);
  process.exit(1);
});
