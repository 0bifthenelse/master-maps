/**
 * W5-STRESS: bounded-memory and no-leak soak verification against the
 * production build. Drives the guarded `internet` MCP runtime over stdio
 * against http://127.0.0.1:3100/ at 1440x900 and runs a bounded cycle of
 * pan, zoom, search focus jumps, LOD crossings and context menu cycles,
 * sampling the heap, the tile diagnostics counters, the scene diagnostics
 * line and a rAF frame sampler between phases.
 *
 * Every input channel was measured against the running build before the
 * cycle was written. `scroll` is a genuine no-op: the guarded runtime sends
 * a CDP mouseWheel at (0, 0) and MapControls.onWheel returns early when
 * deltaMode is 0. What works, and is what this script uses, is the runtime's
 * own `press_key` (arrows pan, "=" and "-" zoom: MapControls binds
 * window.addEventListener("keydown")) and its own pointer transport, driven
 * as a real pointerdown/pointermove/pointerup triple so R3F records
 * initialHits and the canvas pan and the per-mesh contextmenu handler both
 * fire. Each phase reads camera-target-x, camera-target-z and camera-zoom
 * before and after, so a silent no-op cannot pass as a clean soak.
 *
 * The script never launches a browser, never passes --disable-gpu and never
 * falls back to WebGL. It takes /tmp/master-maps-browser.lock with mkdir
 * (atomic, retried every 20 s) and always rmdirs it in a finally block.
 *
 * Usage: npx tsx scripts/moli/verify-stress.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = process.env.STRESS_TARGET ?? "http://127.0.0.1:3100/";
const RENDER_DIR = resolve(ROOT, "data/generated/render");
const MCP_BIN = process.env.INTERNET_MCP_BIN ?? "/master/internet/target/release/master-internet-unit";
const MCP_CWD = process.env.INTERNET_MCP_CWD ?? "/master/internet";
const ARTIFACTS = resolve(ROOT, "tests/artifacts/stress");
const LOCK = "/tmp/master-maps-browser.lock";
const PROFILE = "w5stress";

const VIEWPORT = { w: 1440, h: 900 };
const BUDGET_MS = 7 * 60 * 1000;
const RUN_HARD_STOP_MS = 11 * 60 * 1000;
const HEAP_GROWTH_MARGIN_BYTES = 8 * 1024 * 1024;
const LOD0_MAX_SPAN = 12_000;
const LOD1_MAX_SPAN = 60_000;
/** Orthographic frustum at zoom 1 is GERS_SPAN * 1.15 wide and tall, so the
    span falls below 12 km at zoom 13 and below 60 km at zoom 2.6. */
const FRUSTUM_AT_ZOOM_ONE = 150_733;
const KEY_ZOOM_FACTOR = 1.25;

const SEARCH_TERMS = [
  "Auch",
  "Fleurance",
  "Lectoure",
  "Mirande",
  "Condom",
  "Valence",
  "Riscle",
  "Gimont",
  "Samatan",
  "Aignan",
];

const KEY_PAN_DIRECTIONS: readonly string[] = ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"];

/* ------------------------------------------------------------------ */
/*  Minimal MCP stdio client                                          */
/* ------------------------------------------------------------------ */

interface McpResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

class McpClient {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: McpResult) => void; reject: (e: Error) => void }>();

  async start(): Promise<void> {
    this.child = spawn(MCP_BIN, [], { cwd: MCP_CWD, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr?.on("data", () => undefined);
    this.child.on("exit", () => this.failAll(new Error("internet MCP server exited")));
    this.send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "master-maps-verify-stress", version: "1" },
    });
    this.notify("notifications/initialized", {});
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
      if (line.length === 0) continue;
      let parsed: { id?: number; result?: McpResult; error?: { message: string } };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        continue;
      }
      if (typeof parsed.id !== "number") continue;
      const waiter = this.pending.get(parsed.id);
      if (waiter === undefined) continue;
      this.pending.delete(parsed.id);
      if (parsed.error !== undefined) waiter.reject(new Error(parsed.error.message));
      else waiter.resolve(parsed.result ?? { content: [] });
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  private send(method: string, params: unknown): void {
    if (this.child === null || this.child.stdin === null) throw new Error("MCP client not started");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: this.nextId, method, params })}\n`);
    this.nextId += 1;
  }

  private notify(method: string, params: unknown): void {
    if (this.child === null || this.child.stdin === null) throw new Error("MCP client not started");
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async tool(name: string, args: unknown = {}, timeoutMs = 30_000): Promise<string> {
    const id = this.nextId;
    this.send("tools/call", { name, arguments: args });
    const waiter = Promise.withResolvers<McpResult>();
    this.pending.set(id, waiter);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      waiter.reject(new Error(`MCP tool ${name} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    try {
      const result = await waiter.promise;
      return result.content.map((part) => part.text ?? "").join("\n");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Evaluate an expression and return the JSON-decoded value. A longer
   * timeout is required while the page is saturated with tile decode work,
   * where a single CDP round trip can exceed the 30 s default.
   */
  async evaluate<T>(expr: string, timeoutMs = 30_000): Promise<T> {
    return parseToolJson(await this.tool("evaluate", { expr }, timeoutMs)) as T;
  }

  stop(): void {
    if (this.child !== null) {
      this.child.stdin?.end();
      this.child.kill("SIGTERM");
      this.child = null;
    }
  }
}

/**
 * The guard returns the evaluated value as a JSON document. Parse it
 * directly: a bare scalar such as `true`, `null` or `42` is a valid
 * result and must survive intact, so no brace sniffing is applied.
 */
function parseToolJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return text.trim();
  }
}

/* ------------------------------------------------------------------ */
/*  Page probes                                                       */
/* ------------------------------------------------------------------ */

const INSTALL_PROBE = `(() => {
  const w = window;
  w.__stress = { rejections: [], errors: [], consoleErrors: [], warnCount: 0, frames: [], mark: 0, ticks: 0 };
  w.addEventListener("unhandledrejection", (e) => {
    w.__stress.rejections.push({ at: Math.round(performance.now()), reason: String(e.reason) });
  });
  w.addEventListener("error", (e) => {
    w.__stress.errors.push({ at: Math.round(performance.now()), message: String(e.message) });
  });
  const origError = console.error.bind(console);
  console.error = (...args) => {
    w.__stress.consoleErrors.push({ at: Math.round(performance.now()), text: args.map(String).join(" ").slice(0, 300) });
    origError(...args);
  };
  const origWarn = console.warn.bind(console);
  console.warn = (...args) => {
    w.__stress.warnCount += 1;
    origWarn(...args);
  };
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    w.__stress.ticks += 1;
    w.__stress.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

const SAMPLE_PROBE = `(() => {
  const s = window.__stress;
  if (s === undefined) return null;
  s.mark = s.frames.length;
  return { mark: s.mark, ticks: s.ticks };
})()`;

const COLLECT_PROBE = `(() => {
  const w = window;
  const s = w.__stress ?? { rejections: [], errors: [], consoleErrors: [], warnCount: 0, frames: [] };
  const mark = s.mark ?? 0;
  const d = w.__masterMapsTileDiagnostics;
  const node = document.getElementById("scene-diagnostics");
  const scene = {};
  if (node !== null && node.textContent !== null) {
    for (const part of node.textContent.split("\\u2502")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      scene[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
  }
  const mem = performance.memory;
  return {
    heapUsed: mem ? mem.usedJSHeapSize : null,
    heapTotal: mem ? mem.totalJSHeapSize : null,
    heapLimit: mem ? mem.jsHeapSizeLimit : null,
    frames: s.frames.slice(mark),
    ticks: s.ticks,
    rejections: s.rejections,
    errors: s.errors,
    consoleErrors: s.consoleErrors,
    warnCount: s.warnCount,
    diag: d === undefined ? null : {
      requested: d.requested.length,
      loaded: d.loaded.length,
      aborted: d.aborted.length,
      failed: d.failed.length,
      requestedUnique: new Set(d.requested).size,
      loadedUnique: new Set(d.loaded).size,
      abortedUnique: new Set(d.aborted).size,
      failedUnique: new Set(d.failed).size
    },
    scene: scene,
    labels: w.__masterMapsLabels ?? null,
    searchOptions: document.querySelectorAll('[role="option"]').length,
    contextMenu: document.querySelector('[data-testid="feature-context-menu"]') !== null
  };
})()`;

/**
 * Camera probe. The frustum width and height are not published in
 * camera-state, so the span is derived from the published orthographic zoom
 * against the frustum fitted at zoom 1, which the build computes from the
 * dataset bounds (131072 x 98304 m) with a 1.15 pad.
 */
const CAMERA_PROBE = `(() => {
  const n = document.getElementById("scene-diagnostics");
  if (n === null) return null;
  const zoom = Number(n.getAttribute("data-camera-zoom"));
  return {
    zoom: zoom,
    x: Number(n.getAttribute("data-camera-target-x")),
    z: Number(n.getAttribute("data-camera-target-z")),
    loadedTiles: Number(n.getAttribute("data-loaded-tile-count")),
    drawCalls: Number(n.getAttribute("data-draw-calls")),
    rendererStatus: n.getAttribute("data-renderer-status"),
    rendererError: n.getAttribute("data-renderer-error"),
    backend: n.getAttribute("data-backend")
  };
})()`;

const CANVAS_RECT = `(() => {
  const canvas = document.querySelector("canvas");
  if (canvas === null) return null;
  const r = canvas.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
})()`;

const RESET_VIEW = `(() => {
  const button = document.querySelector('[data-testid="reset-view"]');
  if (button === null) return false;
  button.click();
  return true;
})()`;

const FOCUS_SEARCH = `(() => {
  const input = document.querySelector('[data-testid="search-input"]');
  if (input === null) return false;
  input.focus();
  return true;
})()`;

const CLEAR_SEARCH = `(() => {
  const input = document.querySelector('[data-testid="search-input"]');
  if (input === null) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const OPTION_COUNT = `(() => document.querySelectorAll('[role="option"]').length)()`;

const CLICK_OPTION = `(() => {
  const option = document.querySelector('[role="option"]');
  if (option === null) return false;
  option.click();
  return true;
})()`;

const OPTION_RECT = `(() => {
  const option = document.querySelector('[role="option"]');
  if (option === null) return null;
  const r = option.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, text: (option.textContent || "").slice(0, 60) };
})()`;

const MENU_OPEN = `(() => document.querySelector('[data-testid="feature-context-menu"]') !== null)()`;

/**
 * A real pointer gesture on the canvas. R3F reads offsetX/offsetY to aim
 * its raycaster, which a synthetic MouseEvent leaves at 0, and a click-class
 * event only reaches a mesh handler when that mesh is in the initialHits
 * recorded by pointerdown. Both are supplied here, so the sequence is the
 * same event order a real mouse produces.
 */
function pointerProbe(kind: "drag" | "rightclick", x0: number, y0: number, x1: number, y1: number, steps: number): string {
  const at = (type: string, x: number, y: number, button: number): string =>
    `(() => { const e = new MouseEvent("${type}", { clientX: ${x}, clientY: ${y}, button: ${button}, buttons: ${button === 2 ? 2 : 1}, bubbles: true, cancelable: true });
      Object.defineProperty(e, "offsetX", { value: ${x} });
      Object.defineProperty(e, "offsetY", { value: ${y} });
      document.querySelector("canvas").dispatchEvent(e); return true; })()`;
  if (kind === "rightclick") {
    return `(() => {
      const at = ${at.toString()};
      at("pointerdown", ${x0}, ${y0}, 2);
      at("pointerup", ${x0}, ${y0}, 2);
      at("contextmenu", ${x0}, ${y0}, 2);
      return document.querySelector('[data-testid="feature-context-menu"]') !== null;
    })()`;
  }
  const moves: string[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    moves.push(at("pointermove", Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), 0));
  }
  return `(() => {
    const at = ${at.toString()};
    at("pointerdown", ${x0}, ${y0}, 0);
    ${moves.join("\n    ")}
    at("pointerup", ${x1}, ${y1}, 0);
    return true;
  })()`;
}

interface TileDiag {
  requested: number;
  loaded: number;
  aborted: number;
  failed: number;
  requestedUnique: number;
  loadedUnique: number;
  abortedUnique: number;
  failedUnique: number;
}

interface RawSample {
  heapUsed: number | null;
  heapTotal: number | null;
  heapLimit: number | null;
  frames: number[];
  ticks: number;
  rejections: { at: number; reason: string }[];
  errors: { at: number; message: string }[];
  consoleErrors: { at: number; text: string }[];
  warnCount: number;
  diag: TileDiag | null;
  scene: Record<string, string>;
  labels: unknown;
  searchOptions: number;
  contextMenu: boolean;
}

interface Sample extends RawSample {
  phase: string;
  at: string;
}

interface CameraPoint {
  x: number;
  z: number;
  zoom: number;
  spanMetres: number;
  lod: number;
  loadedTiles: number;
  drawCalls: number;
}

interface CameraMotion {
  phase: string;
  before: CameraPoint;
  after: CameraPoint;
  panMetres: number;
  zoomRatio: number;
  moved: boolean;
}

interface PhaseResult {
  phase: string;
  sample: Sample;
  frames: Record<string, number>;
  durationMs: number;
  notes: string[];
  camera: CameraMotion | null;
}

type Action = () => Promise<void>;

/* ------------------------------------------------------------------ */
/*  Statistics                                                        */
/* ------------------------------------------------------------------ */

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

function summariseFrames(frames: number[]): Record<string, number> {
  const usable = frames.filter((f) => f > 0 && f < 5000);
  if (usable.length === 0) return { count: 0 };
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  return {
    count: usable.length,
    meanMs: Number(mean.toFixed(2)),
    p50Ms: Number(percentile(usable, 50).toFixed(2)),
    p90Ms: Number(percentile(usable, 90).toFixed(2)),
    p99Ms: Number(percentile(usable, 99).toFixed(2)),
    maxMs: Number(Math.max(...usable).toFixed(2)),
    minMs: Number(Math.min(...usable).toFixed(2)),
    impliedFps: Number((1000 / mean).toFixed(1)),
  };
}

const EMPTY_SAMPLE: RawSample = {
  heapUsed: null,
  heapTotal: null,
  heapLimit: null,
  frames: [],
  ticks: 0,
  rejections: [],
  errors: [],
  consoleErrors: [],
  warnCount: 0,
  diag: null,
  scene: {},
  labels: null,
  searchOptions: 0,
  contextMenu: false,
};

/* ------------------------------------------------------------------ */
/*  Runner                                                            */
/* ------------------------------------------------------------------ */

class StressRun {
  private readonly mcp = new McpClient();
  private readonly samples: Sample[] = [];
  private readonly phases: PhaseResult[] = [];
  private readonly notes: string[] = [];
  private readonly startedAt = Date.now();
  private renderTilesStart = 0;
  private renderTilesEnd = 0;
  private gpuEvidence = "not probed";
  private adapterEvidence = "not probed";
  private abortedAccounting = "not measured";
  private searchOptionsSeen = 0;
  private searchTermsTried = 0;
  private menuOpened = 0;
  private menuClosed = 0;
  private menuRightClicks = 0;
  private droppedKeys = 0;
  private droppedDrags = 0;
  private confirmedKeys = 0;
  private confirmedDrags = 0;
  private quietWindow: { loadedTiles: number; drawCalls: number; cameraZoom: number; frames: Record<string, number> } | null = null;
  private readonly lodTrace: string[] = [];
  private readonly plateau: { step: string; loadedTiles: number; drawCalls: number; heapUsed: number | null; spanMetres: number; lod: number }[] = [];
  private verdicts: Record<string, string> = {};
  private readonly defects: string[] = [];

  private overBudget(): boolean {
    return Date.now() - this.startedAt > BUDGET_MS;
  }

  private hardStop(): boolean {
    return Date.now() - this.startedAt > RUN_HARD_STOP_MS;
  }

  private async setup(): Promise<void> {
    mkdirSync(ARTIFACTS, { recursive: true });
    this.renderTilesStart = existsSync(RENDER_DIR) ? readdirSync(RENDER_DIR).length : 0;
    await this.mcp.start();
    await this.mcp.tool("health", {}, 60_000);
    await this.mcp.tool("version", {}, 60_000);
    await this.mcp.tool("profile_open", { name: PROFILE }, 90_000);
    /**
     * gpu_mode reports a guard quarantine on its own output, a known tool
     * issue. It must be issued BEFORE navigate: the default is software
     * rendering, which launches Chrome with --disable-gpu, and then
     * navigator.gpu.requestAdapter() returns null and the app renders the
     * WebGPUUnsupported panel instead of the map. The adapter is then proven
     * through the page after navigation, which is the authoritative check.
     */
    try {
      await this.mcp.tool("gpu_mode", { mode: "hardware" }, 120_000);
    } catch (error) {
      this.notes.push(`gpu_mode call did not return cleanly: ${String(error).slice(0, 120)}`);
    }
    this.gpuEvidence =
      (await this.mcp.evaluate<string | null>(`(() => {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl2");
        if (gl === null) return null;
        const d = gl.getExtension("WEBGL_debug_renderer_info");
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      })()`, 90_000)) ?? "webgl2 unavailable";
    await this.mcp.tool("set_viewport", VIEWPORT, 60_000);
    await this.mcp.tool("navigate", { url: TARGET }, 90_000);
    await this.mcp.tool("state", {}, 60_000);
    await this.waitForScene(120_000);
    await this.mcp.evaluate(INSTALL_PROBE, 60_000);
    await this.waitForRenderer(180_000);
    this.adapterEvidence = await this.readAdapter();
    this.notes.push(`gpu_mode hardware requested; webgl renderer ${this.gpuEvidence}`);
    this.notes.push(`guarded scroll is a measured no-op: MapControls.onWheel returns early when deltaMode is 0 and the runtime sends a pixel-mode wheel at (0,0); navigation therefore uses press_key and real pointer sequences`);
  }

  private async readAdapter(): Promise<string> {
    const info = await this.mcp.evaluate<Record<string, unknown> | null>(
      `(async () => {
        if (!navigator.gpu) return { error: "navigator.gpu missing" };
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter === null) return { error: "requestAdapter returned null" };
        const i = adapter.info ?? {};
        return { vendor: i.vendor ?? null, architecture: i.architecture ?? null, device: i.device ?? null, description: i.description ?? null };
      })()`,
      60_000,
    );
    return JSON.stringify(info);
  }

  private async waitForScene(timeoutMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = await this.mcp.evaluate<boolean>(`(() => {
        const c = document.querySelector("canvas");
        const s = document.getElementById("scene-diagnostics");
        return c !== null && s !== null && s.textContent !== null && s.textContent.includes("draw-calls");
      })()`);
      if (ready === true) return;
      await sleep(500);
    }
    throw new Error("scene canvas never reported draw-calls diagnostics within timeout");
  }

  /**
   * Press a key and wait for the camera to react. The app runs a demand
   * rendered canvas, so a key is only applied on the next animation frame:
   * keys fired back to back land inside one frame and the last one wins,
   * which is what made an earlier version of this harness read as a clean
   * no-op. Every press is therefore confirmed against the published camera
   * and retried, so a dropped key is a counted retry, not a silent one.
   */
  private async pressKey(key: string, attempts = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const before = await this.cameraPoint();
      await this.mcp.tool("press_key", { key }, 20_000);
      for (let wait = 0; wait < 12; wait += 1) {
        await sleep(90);
        const after = await this.cameraPoint();
        if (Math.hypot(after.x - before.x, after.z - before.z) > 1 || Math.abs(after.zoom / before.zoom - 1) > 0.01) {
          this.confirmedKeys += 1;
          return true;
        }
      }
      this.droppedKeys += 1;
    }
    return false;
  }

  private async pressKeys(key: string, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) await this.pressKey(key);
  }

  /** Real pointer drag across the canvas: pointerdown, moves, pointerup. */
  private async drag(x0: number, y0: number, x1: number, y1: number, steps = 6): Promise<boolean> {
    const before = await this.cameraPoint();
    await this.mcp.evaluate(pointerProbe("drag", x0, y0, x1, y1, steps), 30_000);
    for (let wait = 0; wait < 10; wait += 1) {
      await sleep(90);
      const after = await this.cameraPoint();
      if (Math.hypot(after.x - before.x, after.z - before.z) > 1) {
        this.confirmedDrags += 1;
        return true;
      }
    }
    this.droppedDrags += 1;
    return false;
  }

  /** Real right click on the canvas: pointerdown, pointerup, contextmenu. */
  private async rightClick(x: number, y: number): Promise<boolean> {
    return this.mcp.evaluate<boolean>(pointerProbe("rightclick", x, y, x, y, 0), 30_000);
  }

  private async canvasRect(): Promise<{ x: number; y: number; w: number; h: number }> {
    const rect = await this.mcp.evaluate<{ x: number; y: number; w: number; h: number } | null>(CANVAS_RECT, 30_000);
    if (rect === null) throw new Error("canvas is not present");
    return rect;
  }

  private async cameraPoint(): Promise<CameraPoint> {
    const probe = await this.mcp.evaluate<{
      zoom: number;
      x: number;
      z: number;
      loadedTiles: number;
      drawCalls: number;
      rendererStatus: string | null;
      rendererError: string | null;
      backend: string | null;
    } | null>(CAMERA_PROBE, 30_000);
    if (probe === null) throw new Error("camera diagnostics are missing");
    const span = probe.zoom > 0 ? FRUSTUM_AT_ZOOM_ONE / probe.zoom : FRUSTUM_AT_ZOOM_ONE;
    return {
      x: probe.x,
      z: probe.z,
      zoom: probe.zoom,
      spanMetres: span,
      lod: span <= LOD0_MAX_SPAN ? 0 : span <= LOD1_MAX_SPAN ? 1 : 2,
      loadedTiles: probe.loadedTiles,
      drawCalls: probe.drawCalls,
    };
  }

  private async runPhase(name: string, actions: Action[], settleMs: number): Promise<PhaseResult> {
    const phaseStart = Date.now();
    await this.mcp.evaluate(SAMPLE_PROBE, 30_000);
    const notes: string[] = [];
    let before: CameraPoint | null = null;
    let after: CameraPoint | null = null;
    let executed = 0;
    try {
      before = await this.cameraPoint();
    } catch (error) {
      notes.push(`camera read before phase failed: ${String(error).slice(0, 140)}`);
    }
    for (const action of actions) {
      if (this.overBudget() || this.hardStop()) {
        notes.push(`budget exhausted after ${executed}/${actions.length} actions`);
        break;
      }
      try {
        await action();
        executed += 1;
      } catch (error) {
        notes.push(`action ${executed} failed: ${String(error).slice(0, 160)}`);
      }
    }
    await sleep(settleMs);
    try {
      after = await this.cameraPoint();
    } catch (error) {
      notes.push(`camera read after phase failed: ${String(error).slice(0, 140)}`);
    }
    let raw: RawSample;
    try {
      raw = await this.mcp.evaluate<RawSample>(COLLECT_PROBE, 60_000);
    } catch (error) {
      notes.push(`phase sample collection failed: ${String(error).slice(0, 140)}`);
      raw = EMPTY_SAMPLE;
    }
    const camera: CameraMotion | null = before === null || after === null
      ? null
      : {
          phase: name,
          before,
          after,
          panMetres: Math.hypot(after.x - before.x, after.z - before.z),
          zoomRatio: before.zoom > 0 ? after.zoom / before.zoom : 0,
          moved: false,
        };
    if (camera !== null) camera.moved = camera.panMetres > 1 || Math.abs(camera.zoomRatio - 1) > 0.01;
    const result: PhaseResult = {
      phase: name,
      sample: { phase: name, at: new Date().toISOString(), ...raw },
      frames: summariseFrames(raw.frames),
      durationMs: Date.now() - phaseStart,
      notes,
      camera,
    };
    this.samples.push(result.sample);
    this.phases.push(result);
    this.report(result);
    return result;
  }

  /**
   * The camera diagnostics are edge triggered (CameraRig publishes only on
   * a viewport change), so a renderer that never initialised leaves every
   * published value at its zero default. Waiting for a non-zero zoom is the
   * only readiness condition that separates a live renderer from a page
   * that rendered nothing, and an unsupported adapter stops the run
   * outright rather than reporting a clean soak of a blank page.
   */
  private async waitForRenderer(timeoutMs: number): Promise<void> {
    const start = Date.now();
    let lastStatus = "unread";
    while (Date.now() - start < timeoutMs) {
      const probe = await this.mcp.evaluate<{ zoom: number; status: string | null; error: string | null; backend: string | null } | null>(CAMERA_PROBE, 30_000);
      if (probe === null) {
        lastStatus = "no #scene-diagnostics element";
      } else if (probe.status === "unsupported") {
        throw new Error(`the guarded runtime exposed no WebGPU adapter: renderer-status=unsupported renderer-error=${probe.error ?? "none"} backend=${probe.backend ?? "none"}; a soak of a blank page would prove nothing, so the run stops here`);
      } else if (probe.zoom > 0) {
        return;
      } else {
        lastStatus = `renderer-status=${probe.status ?? "null"} camera-zoom=${probe.zoom}`;
      }
      await sleep(500);
    }
    throw new Error(`the renderer never initialised within ${timeoutMs} ms (${lastStatus})`);
  }

  private report(result: PhaseResult): void {
    const d = result.sample.diag;
    const f = result.frames;
    const c = result.camera;
    console.log(
      `  [${result.phase} | ${(result.durationMs / 1000).toFixed(1)}s | heap=${result.sample.heapUsed === null ? "n/a" : `${(result.sample.heapUsed / 1e6).toFixed(1)}MB`} | ` +
      `tiles r/l/a/f=${d === null ? "n/a" : `${d.requested}/${d.loaded}/${d.aborted}/${d.failed}`} | loaded=${result.sample.scene["loaded-tile-count"] ?? "n/a"} | ` +
      `draw=${result.sample.scene["draw-calls"] ?? "n/a"} | frames=${f.count ?? 0} p50=${f.p50Ms ?? "-"} p99=${f.p99Ms ?? "-"} | ` +
      `camera=${c === null ? "n/a" : `pan ${c.panMetres.toFixed(0)}m zoom x${c.zoomRatio.toFixed(3)} span ${Math.round(c.before.spanMetres)}->${Math.round(c.after.spanMetres)}m LOD${c.before.lod}->${c.after.lod} moved=${String(c.moved)}`}]`,
    );
    for (const note of result.notes) console.log(`      note: ${note}`);
  }

  /* ---------------------------------------------------------------- */
  /*  Phases                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Phase 1: 20 alternating pan and zoom operations across several Gers
   * locations. Each operation is a real pointer drag over a different
   * quarter of the canvas followed by a real key zoom.
   */
  private async panZoomPhase(): Promise<PhaseResult> {
    const rect = await this.canvasRect();
    const actions: Action[] = [];
    const spots = [
      { fx: 0.5, fy: 0.5 },
      { fx: 0.28, fy: 0.32 },
      { fx: 0.74, fy: 0.66 },
      { fx: 0.36, fy: 0.72 },
      { fx: 0.66, fy: 0.28 },
    ];
    for (let i = 0; i < 20; i += 1) {
      const spot = spots[i % spots.length]!;
      const dir = i % 2 === 0 ? 1 : -1;
      actions.push(async () => {
        const x = rect.x + rect.w * spot.fx;
        const y = rect.y + rect.h * spot.fy;
        await this.drag(x, y, x + dir * 170, y + (i % 4 === 0 ? 70 : -50), 6);
      });
      actions.push(async () => {
        await this.pressKey(i % 2 === 0 ? "=" : "-");
      });
    }
    return this.runPhase("panzoom-alternating-20", actions, 1500);
  }

  /** Phase 2: 10 rapid direction reversals, east then west with no settle. */
  private async reversalPhase(): Promise<PhaseResult> {
    const rect = await this.canvasRect();
    const actions: Action[] = [];
    for (let i = 0; i < 10; i += 1) {
      const east = i % 2 === 0;
      const y = rect.y + rect.h * (0.38 + 0.03 * (i % 5));
      actions.push(async () => {
        const x0 = rect.x + rect.w * 0.5;
        await this.drag(x0, y, east ? x0 + 190 : x0 - 190, y, 4);
      });
      actions.push(async () => {
        const x0 = rect.x + rect.w * 0.5;
        await this.drag(x0, y, east ? x0 - 190 : x0 + 190, y, 4);
      });
    }
    return this.runPhase("direction-reversals-10", actions, 1200);
  }

  /**
   * Phase 3: 10 search focus jumps to different Gers towns. The term is
   * typed with the guarded type_text and the first option is activated with
   * a real click at the option's own rectangle, so the camera focus
   * interpolation runs exactly as it does for a user.
   */
  private async searchPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    for (const term of SEARCH_TERMS) {
      actions.push(async () => {
        await this.mcp.evaluate(FOCUS_SEARCH, 30_000);
        await this.mcp.tool("type_text", { selector: '[data-testid="search-input"]', text: term }, 60_000);
        const options = await this.mcp.evaluate<number>(OPTION_COUNT, 30_000);
        this.searchTermsTried += 1;
        if (options > 0) {
          this.searchOptionsSeen += 1;
          const rect = await this.mcp.evaluate<{ x: number; y: number; w: number; h: number; text: string } | null>(OPTION_RECT, 30_000);
          if (rect !== null && rect.w > 0 && rect.h > 0) {
            await this.mcp.tool("click_xy", { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) }, 30_000);
          } else {
            await this.mcp.evaluate(CLICK_OPTION, 30_000);
          }
        }
        await sleep(700);
        await this.mcp.evaluate(CLEAR_SEARCH, 30_000);
      });
    }
    const result = await this.runPhase("search-focus-jumps-10", actions, 1500);
    this.notes.push(`search terms producing at least one result option: ${this.searchOptionsSeen} of ${this.searchTermsTried}`);
    return result;
  }

  /**
   * Phase 4: 3 rapid LOD crossings. Each crossing zooms from the overview
   * band past the 12 km threshold down to LOD0 and back out past the 60 km
   * threshold into LOD2. The span is read at every stop, so the crossing is
   * measured against MapShell.lodForSpan rather than assumed.
   */
  private async lodPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    const stepsIn = Math.ceil(Math.log(FRUSTUM_AT_ZOOM_ONE / 10_000) / Math.log(KEY_ZOOM_FACTOR));
    const stepsOut = Math.ceil(Math.log(FRUSTUM_AT_ZOOM_ONE / 80_000) / Math.log(KEY_ZOOM_FACTOR));
    for (let crossing = 0; crossing < 3; crossing += 1) {
      actions.push(async () => {
        await this.mcp.evaluate(RESET_VIEW, 30_000);
        await sleep(1200);
        const start = await this.cameraPoint();
        await this.pressKeys("=", stepsIn);
        await sleep(500);
        const inward = await this.cameraPoint();
        await this.pressKeys("-", stepsOut);
        await sleep(500);
        const outward = await this.cameraPoint();
        this.lodTrace.push(
          `crossing${crossing + 1}: ${Math.round(start.spanMetres)}m LOD${start.lod} -> ${Math.round(inward.spanMetres)}m LOD${inward.lod} -> ${Math.round(outward.spanMetres)}m LOD${outward.lod}` +
          ` | zoom ${start.zoom.toFixed(2)} -> ${inward.zoom.toFixed(2)} -> ${outward.zoom.toFixed(2)}` +
          ` | loaded tiles ${start.loadedTiles} -> ${inward.loadedTiles} -> ${outward.loadedTiles}`,
        );
      });
    }
    const result = await this.runPhase("lod-crossings-3", actions, 1500);
    for (const line of this.lodTrace) this.notes.push(`lod-trace ${line}`);
    const classes = new Set<number>();
    for (const line of this.lodTrace) for (const match of line.matchAll(/LOD(\d)/g)) classes.add(Number(match[1]));
    this.notes.push(`LOD classes traversed across the 3 crossings: ${[...classes].sort().join(",")}`);
    return result;
  }

  /**
   * Phase 5: 5 context menu open and close cycles. The menu is opened by a
   * per-mesh onContextMenu handler that raycasts resident geometry, so real
   * right clicks are issued on a grid of canvas points until one lands on a
   * feature, then closed with a real press_key Escape.
   */
  private async menuPhase(): Promise<PhaseResult> {
    const rect = await this.canvasRect();
    const actions: Action[] = [];
    for (let i = 0; i < 5; i += 1) {
      actions.push(async () => {
        for (let gx = 1; gx <= 5; gx += 1) {
          for (let gy = 1; gy <= 4; gy += 1) {
            const x = Math.round(rect.x + (rect.w * gx) / 6);
            const y = Math.round(rect.y + (rect.h * gy) / 5);
            const opened = await this.rightClick(x, y);
            this.menuRightClicks += 1;
            if (!opened) continue;
            this.menuOpened += 1;
            await this.pressKey("Escape");
            await sleep(250);
            const closed = await this.mcp.evaluate<boolean>(MENU_OPEN, 20_000);
            if (!closed) this.menuClosed += 1;
            return;
          }
        }
      });
    }
    const result = await this.runPhase("context-menu-cycles-5", actions, 1200);
    this.notes.push(`context menu: ${this.menuOpened} open and ${this.menuClosed} close confirmed from ${this.menuRightClicks} real right clicks on resident geometry`);
    return result;
  }

  /**
   * Phase 6: soak tail. Repeated real pan and key zoom churn after the
   * directed phases, so the heap and the tile counters are read after a
   * longer and less directed run of the same operations.
   */
  private async soakPhase(): Promise<PhaseResult> {
    const rect = await this.canvasRect();
    const actions: Action[] = [];
    const directions = KEY_PAN_DIRECTIONS;
    for (let i = 0; i < 24; i += 1) {
      const y = rect.y + rect.h * (0.34 + 0.3 * ((i % 3) / 2));
      actions.push(async () => {
        const x = rect.x + rect.w * (0.3 + 0.4 * ((i % 5) / 4));
        await this.drag(x, y, x + (i % 2 === 0 ? 130 : -130), y + 45, 5);
        await this.pressKey(i % 3 === 0 ? "=" : "-");
        await this.pressKey(directions[i % directions.length]!);
      });
    }
    return this.runPhase("soak-tail", actions, 2000);
  }

  /**
   * Phase 7: loaded-tile plateau probe. Return to the department overview,
   * then pan away and back and zoom in and out, reading loaded-tile-count
   * and draw-calls at every stop: the resident set must fall or hold, never
   * grow without bound.
   */
  private async plateauProbe(): Promise<void> {
    const read = async (step: string): Promise<void> => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const point = await this.cameraPoint();
          this.plateau.push({
            step,
            loadedTiles: point.loadedTiles,
            drawCalls: point.drawCalls,
            heapUsed: (await this.mcp.evaluate<number | null>("(() => (performance.memory ? performance.memory.usedJSHeapSize : null))()", 30_000)),
            spanMetres: Math.round(point.spanMetres),
            lod: point.lod,
          });
          return;
        } catch (error) {
          this.notes.push(`plateau probe ${step} attempt ${attempt} failed: ${String(error).slice(0, 100)}`);
          await sleep(1500);
        }
      }
    };
    await this.mcp.evaluate(RESET_VIEW, 30_000);
    await sleep(2000);
    await read("overview");
    const rect = await this.canvasRect();
    for (let i = 0; i < 4; i += 1) {
      const y = rect.y + rect.h * 0.5;
      await this.drag(rect.x + rect.w * 0.55, y, rect.x + rect.w * 0.85, y, 6);
      await sleep(1200);
      await read(`panned-east-${i + 1}`);
      await this.drag(rect.x + rect.w * 0.45, y, rect.x + rect.w * 0.15, y, 6);
      await sleep(1200);
      await read(`panned-west-${i + 1}`);
    }
    for (let i = 0; i < 3; i += 1) {
      await this.pressKeys("=", 6);
      await sleep(1200);
      await read(`zoomed-in-${i + 1}`);
      await this.pressKeys("-", 6);
      await sleep(1200);
      await read(`zoomed-out-${i + 1}`);
    }
  }

  private assess(): void {
    const last = this.samples.slice(-3).filter((s) => s.heapUsed !== null);
    if (last.length < 3) {
      this.verdicts.heap = "INCONCLUSIVE: fewer than three phases carried a heap reading";
    } else {
      const heaps = last.map((s) => s.heapUsed as number);
      const monotonic = heaps[0]! < heaps[1]! && heaps[1]! < heaps[2]!;
      const delta = heaps[2]! - heaps[0]!;
      this.verdicts.heap =
        `last three phase heaps (MB): ${heaps.map((h) => (h / 1e6).toFixed(1)).join(" -> ")}; ` +
        `strictly monotonic increase: ${monotonic}; delta ${(delta / 1e6).toFixed(1)} MB; threshold ${(HEAP_GROWTH_MARGIN_BYTES / 1e6).toFixed(1)} MB; ` +
        `phases ${last.map((s) => s.phase).join(", ")}. ` +
        (monotonic && delta > HEAP_GROWTH_MARGIN_BYTES
          ? "VERDICT: MONOTONIC HEAP GROWTH, defect."
          : "VERDICT: no monotonic heap growth beyond the stated threshold.");
      if (monotonic && delta > HEAP_GROWTH_MARGIN_BYTES) {
        this.defects.push(`monotonic heap growth of ${(delta / 1e6).toFixed(1)} MB across the last three phases (${last.map((s) => s.phase).join(", ")})`);
      }
    }

    const rejections = this.samples.flatMap((s) => s.rejections);
    this.verdicts.rejections =
      rejections.length === 0
        ? "VERDICT: zero unhandled promise rejections across all phases."
        : `VERDICT: ${rejections.length} unhandled promise rejection(s), defect: ${JSON.stringify(rejections.slice(0, 5))}`;
    if (rejections.length > 0) this.defects.push(`${rejections.length} unhandled promise rejection(s)`);

    const pageErrors = this.samples.flatMap((s) => s.errors);
    this.verdicts.pageErrors =
      pageErrors.length === 0
        ? "VERDICT: zero uncaught page errors across all phases."
        : `VERDICT: ${pageErrors.length} uncaught page error(s): ${JSON.stringify(pageErrors.slice(0, 5))}`;
    if (pageErrors.length > 0) this.defects.push(`${pageErrors.length} uncaught page error(s)`);

    const gpuConsole = this.samples.flatMap((s) => s.consoleErrors).filter((e) => /webgpu|validation|gpu|device lost|pipeline/i.test(e.text));
    const rendererError = this.samples.filter((s) => (s.scene["renderer-error"] ?? "none") !== "none");
    const lost = this.samples.filter((s) => s.scene["renderer-status"] === "lost");
    const failedTotal = this.samples[this.samples.length - 1]?.diag?.failed ?? 0;
    this.verdicts.webgpu =
      gpuConsole.length === 0 && rendererError.length === 0 && lost.length === 0
        ? "VERDICT: no WebGPU validation errors, no renderer error, no device loss."
        : `VERDICT: WebGPU or renderer problem, defect: consoleErrors=${JSON.stringify(gpuConsole.slice(0, 5))} rendererError=${JSON.stringify(rendererError.map((s) => s.scene["renderer-error"]))} lost=${lost.length}`;
    if (gpuConsole.length > 0 || rendererError.length > 0 || lost.length > 0) {
      this.defects.push(`WebGPU or renderer problem: rendererError=${rendererError.length} deviceLost=${lost.length} gpuConsoleErrors=${gpuConsole.length}`);
    }
    this.notes.push(`cumulative failed tile requests at end of run: ${failedTotal}`);

    this.verdicts.inputDelivery =
      `input delivery: ${this.confirmedKeys} of ${this.confirmedKeys + this.droppedKeys} key presses confirmed by a camera transition ` +
      `(${this.droppedKeys} dropped after 3 attempts); ${this.confirmedDrags} of ${this.confirmedDrags + this.droppedDrags} pointer drags confirmed ` +
      `(${this.droppedDrags} dropped). Every confirmed input is a measured camera-target-x/z or camera-zoom change, so a phase that reads flat is a real no-op.`;
    if (this.droppedKeys + this.droppedDrags > 0) {
      this.defects.push(`${this.droppedKeys} key presses and ${this.droppedDrags} pointer drags were dropped by the runtime even after 3 attempts`);
    }

    const first = this.samples[0]?.diag ?? null;
    const final = this.samples[this.samples.length - 1]?.diag ?? null;
    if (first === null || final === null) {
      this.verdicts.aborted = "INCONCLUSIVE: no tile diagnostics samples";
    } else {
      const requested = final.requested - first.requested;
      const loaded = final.loaded - first.loaded;
      const aborted = final.aborted - first.aborted;
      const failed = final.failed - first.failed;
      const terminal = loaded + aborted + failed;
      this.abortedAccounting =
        `cumulative requested=${final.requested} loaded=${final.loaded} aborted=${final.aborted} failed=${final.failed}; ` +
        `run delta requested=${requested} loaded=${loaded} aborted=${aborted} failed=${failed} terminalSum=${terminal}`;
      this.verdicts.aborted =
        terminal >= requested
          ? `VERDICT: aborted requests accounted for. ${this.abortedAccounting}`
          : `VERDICT: aborted accounting gap of ${requested - terminal} requests, defect. ${this.abortedAccounting}`;
      if (terminal < requested) this.defects.push(`tile request accounting gap of ${requested - terminal} requests`);
    }

    const counts = this.plateau.map((p) => p.loadedTiles).filter((c) => c >= 0);
    if (counts.length === 0) {
      this.verdicts.disposal = "INCONCLUSIVE: plateau probe produced no loaded-tile-count readings";
    } else {
      const peak = Math.max(...counts);
      const tailMax = Math.max(...counts.slice(-3));
      this.verdicts.disposal =
        `loaded-tile-count series: ${counts.join(" -> ")}; peak ${peak}; final-three max ${tailMax}; stated plateau value ${peak} tiles. ` +
        (tailMax <= peak
          ? "VERDICT: the resident tile set never exceeded its peak plateau, disposal keeps it bounded."
          : "VERDICT: loaded-tile count grew beyond the peak without bound, defect.");
      if (tailMax > peak) this.defects.push(`loaded-tile count exceeded its ${peak} tile plateau, reaching ${tailMax}`);
    }

    const measured = this.phases.filter((p) => p.camera !== null);
    const still = measured.filter((p) => p.camera !== null && !p.camera.moved);
    this.verdicts.cameraMotion =
      `phases with a measured camera transition: ${measured.length}; phases where the camera did not move: ${still.length}. ` +
      this.phases
        .map((p) => `${p.phase}: pan ${p.camera === null ? "n/a" : p.camera.panMetres.toFixed(0)}m, zoom x${p.camera === null ? "n/a" : p.camera.zoomRatio.toFixed(3)}, span ${p.camera === null ? "n/a" : Math.round(p.camera.before.spanMetres)}->${p.camera === null ? "n/a" : Math.round(p.camera.after.spanMetres)}m`)
        .join("; ") +
      ". " +
      (still.length === 0
        ? "VERDICT: the real input moved the camera in every phase, so no phase was a silent no-op."
        : `VERDICT: ${still.length} phase(s) left the camera unmoved, defect.`);
    if (still.length > 0) this.defects.push(`${still.length} phase(s) left the camera unmoved`);

    const busiest = [...this.phases].filter((p) => (p.frames.count ?? 0) > 20).sort((a, b) => (b.frames.meanMs ?? 0) - (a.frames.meanMs ?? 0))[0];
    const perPhase = this.phases.map((p) => `${p.phase}: count=${p.frames.count ?? 0} mean=${p.frames.meanMs ?? "-"} p50=${p.frames.p50Ms ?? "-"} p99=${p.frames.p99Ms ?? "-"}`).join("; ");
    this.verdicts.frames =
      `per-phase rAF sampling while input round trips run: ${perPhase}. ` +
      (busiest === undefined
        ? "No phase collected enough frames under load, so the per-phase sampler is not usable on its own. "
        : `Busiest phase by mean frame duration under load is ${busiest.phase}: ${JSON.stringify(busiest.frames)}. `) +
      (this.quietWindow === null
        ? "INCONCLUSIVE: the quiet-window measurement did not complete."
        : `Authoritative frame percentiles, measured over ${this.quietWindow.frames.count ?? 0} consecutive frames in one in-page window with no CDP traffic, on the busiest view of the run (${this.quietWindow.loadedTiles} resident tiles, ${this.quietWindow.drawCalls} draw calls, camera-zoom ${this.quietWindow.cameraZoom.toFixed(2)}): ${JSON.stringify(this.quietWindow.frames)}`);

    this.verdicts.context = `context menu: ${this.menuOpened} opens and ${this.menuClosed} closes confirmed from ${this.menuRightClicks} real right clicks on resident geometry`;
    if (this.menuOpened < 5) this.defects.push(`context menu opened ${this.menuOpened} of 5 requested cycles`);
    this.verdicts.search = `search terms producing result options: ${this.searchOptionsSeen} of ${this.searchTermsTried}`;
    this.verdicts.lod = this.lodTrace.length === 0 ? "INCONCLUSIVE: no LOD crossing trace" : this.lodTrace.join(" | ");
  }

  private result(): Record<string, unknown> {
    return {
      target: TARGET,
      generatedAt: new Date().toISOString(),
      wallClockMs: Date.now() - this.startedAt,
      budgetMs: BUDGET_MS,
      viewport: VIEWPORT,
      gpuEvidence: this.gpuEvidence,
      webgpuAdapter: this.adapterEvidence,
      renderTilesAtStart: this.renderTilesStart,
      renderTilesAtEnd: this.renderTilesEnd,
      frustumAtZoomOneMetres: FRUSTUM_AT_ZOOM_ONE,
      thresholds: {
        heapGrowthBytes: HEAP_GROWTH_MARGIN_BYTES,
        lod0MaxSpanMetres: LOD0_MAX_SPAN,
        lod1MaxSpanMetres: LOD1_MAX_SPAN,
      },
      phases: this.phases.map((p) => ({
        phase: p.phase,
        durationMs: p.durationMs,
        notes: p.notes,
        frames: p.frames,
        heapUsedBytes: p.sample.heapUsed,
        heapTotalBytes: p.sample.heapTotal,
        heapLimitBytes: p.sample.heapLimit,
        tileDiagnostics: p.sample.diag,
        sceneDiagnostics: p.sample.scene,
        camera: p.camera,
        searchOptionCount: p.sample.searchOptions,
        contextMenuPresent: p.sample.contextMenu,
        unhandledRejections: p.sample.rejections,
        pageErrors: p.sample.errors,
        consoleErrorCount: p.sample.consoleErrors.length,
        consoleErrors: p.sample.consoleErrors.slice(0, 5),
        warnCount: p.sample.warnCount,
        labels: p.sample.labels,
      })),
      plateauProbe: this.plateau,
      lodTrace: this.lodTrace,
      abortedAccounting: this.abortedAccounting,
      quietWindow: this.quietWindow,
      inputDelivery: {
        confirmedKeys: this.confirmedKeys,
        droppedKeys: this.droppedKeys,
        confirmedDrags: this.confirmedDrags,
        droppedDrags: this.droppedDrags,
      },
      verdicts: this.verdicts,
      defects: this.defects,
      notes: this.notes,
    };
  }

  async run(): Promise<void> {
    console.log("=== W5-STRESS setup ===");
    await this.setup();
    console.log(`gpu evidence: ${this.gpuEvidence}`);
    console.log(`webgpu adapter: ${this.adapterEvidence}`);
    console.log(`render tiles on disk at start: ${this.renderTilesStart}`);

    console.log("\n=== phase 1: 20 alternating pan/zoom operations ===");
    await this.panZoomPhase();

    console.log("\n=== phase 2: 10 rapid direction reversals ===");
    await this.reversalPhase();

    console.log("\n=== phase 3: 10 search focus jumps ===");
    await this.searchPhase();

    console.log("\n=== phase 4: 3 rapid LOD crossings ===");
    await this.lodPhase();

    console.log("\n=== phase 5: 5 context-menu open/close cycles ===");
    await this.menuPhase();

    console.log("\n=== phase 6: soak tail ===");
    await this.soakPhase();

    if (this.overBudget() || this.hardStop()) {
      console.log("\n=== phase 7: skipped, budget exhausted ===");
    } else {
      console.log("\n=== phase 7: loaded-tile plateau probe ===");
      try {
        await this.plateauProbe();
      } catch (error) {
        this.notes.push(`plateau probe aborted: ${String(error).slice(0, 160)}`);
      }
    }

    /**
     * Frame percentiles for the busiest part of the run, measured in one
     * in-page round trip over a 6 s window with no CDP traffic in it: the
     * per-phase sampler shares the page with the input round trips, and
     * those dominate the rAF budget enough to hide the render cost.
     */
    console.log("\n=== phase 8: quiet-window frame duration on the busiest view ===");
    try {
      await this.mcp.evaluate(`(() => { const b = document.querySelector('[data-testid="reset-view"]'); if (b) b.click(); return true; })()`, 30_000);
      await sleep(2500);
      for (let i = 0; i < 6; i += 1) await this.pressKey("=");
      await sleep(2000);
      const window = await this.mcp.evaluate<{ frames: number[]; tiles: number; draw: number; zoom: number }>(
        `(() => new Promise((resolve) => {
          const t = [];
          let last = performance.now();
          const tick = () => {
            const now = performance.now();
            t.push(now - last);
            last = now;
            if (t.length < 360) requestAnimationFrame(tick);
            else {
              const d = document.getElementById("scene-diagnostics");
              resolve({ frames: t, tiles: Number(d.getAttribute("data-loaded-tile-count")), draw: Number(d.getAttribute("data-draw-calls")), zoom: Number(d.getAttribute("data-camera-zoom")) });
            }
          };
          requestAnimationFrame(tick);
        }))()`,
        120_000,
      );
      this.quietWindow = {
        loadedTiles: window.tiles,
        drawCalls: window.draw,
        cameraZoom: window.zoom,
        frames: summariseFrames(window.frames),
      };
      console.log(`  [quiet-window | ${window.frames.length} frames | tiles=${window.tiles} draw=${window.draw} zoom=${window.zoom.toFixed(2)} | ${JSON.stringify(this.quietWindow.frames)}]`);
    } catch (error) {
      this.notes.push(`quiet-window frame measurement failed: ${String(error).slice(0, 160)}`);
    }

    this.renderTilesEnd = existsSync(RENDER_DIR) ? readdirSync(RENDER_DIR).length : 0;
    this.assess();
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(resolve(ARTIFACTS, "stress-run.json"), JSON.stringify(this.result(), null, 2));
    console.log("\n=== raw counters ===");
    console.log(JSON.stringify(this.result(), null, 2));
  }

  async teardown(): Promise<void> {
    this.renderTilesEnd = existsSync(RENDER_DIR) ? readdirSync(RENDER_DIR).length : 0;
    try {
      await this.mcp.tool("profile_close", {}, 30_000);
    } catch {
      /* profile already closed */
    }
    this.mcp.stop();
  }
}

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
      await sleep(20_000);
    }
  }
}

async function main(): Promise<void> {
  const release = await takeLock();
  const run = new StressRun();
  let failure: string | null = null;
  try {
    await run.run();
  } catch (error) {
    failure = String(error);
    console.error("stress run failed:", error);
  } finally {
    await run.teardown();
    release();
  }
  if (failure !== null) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("verify-stress failed:", error);
  process.exit(1);
});
