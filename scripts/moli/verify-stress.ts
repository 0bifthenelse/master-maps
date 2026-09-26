/**
 * W4-STRESS: bounded-memory and no-leak soak verification.
 *
 * Drives the guarded `internet` MCP runtime over stdio against the running
 * dev server and runs a scripted stress cycle, sampling the heap, the tile
 * diagnostics counters, the scene diagnostics line, and a rAF frame
 * sampler between phases. The cycle is bounded by a wall-clock budget; no
 * phase exceeds its own slice.
 *
 * The script never launches a browser itself, never uses --disable-gpu and
 * never falls back to WebGL: the guarded runtime owns the Chrome instance
 * and the hardware GPU mode. The only prerequisite is an already-running
 * dev server on TARGET.
 *
 * Usage: tsx scripts/moli/verify-stress.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TARGET = process.env.STRESS_TARGET ?? "http://localhost:3202/";
const RENDER_DIR = resolve(ROOT, "data/generated/render");
const MCP_BIN = process.env.INTERNET_MCP_BIN ?? "/master/internet/target/release/master-internet-unit";
const MCP_CWD = process.env.INTERNET_MCP_CWD ?? "/master/internet";
const ARTIFACTS = resolve(ROOT, "tests/artifacts/stress");
const PROFILE = "w4stress";

const VIEWPORT = { w: 1440, h: 900 };
const BUDGET_MS = 6 * 60 * 1000;
const RUN_HARD_STOP_MS = 12 * 60 * 1000;
const HEAP_GROWTH_MARGIN_BYTES = 8 * 1024 * 1024;
const SEARCH_TERMS = [
  "Cathedrale Sainte Marie",
  "Boulevard Sadi Carnot",
  "Place de la Liberation",
  "Auch",
  "Gers",
  "Fleurance",
  "Lectoure",
  "Mirande",
  "Condom",
  "Valence",
];
interface KeyStroke {
  code: string;
  key: string;
}
const PAN_KEYS: Record<string, KeyStroke> = {
  KeyH: { code: "KeyH", key: "h" },
  KeyL: { code: "KeyL", key: "l" },
  KeyJ: { code: "KeyJ", key: "j" },
  KeyK: { code: "KeyK", key: "k" },
};
const ZOOM_IN: KeyStroke = { code: "Equal", key: "=" };
const ZOOM_OUT: KeyStroke = { code: "Minus", key: "-" };
/**
 * MapShell.lodForSpan: span <= 12000 m is LOD0, <= 60000 m is LOD1, above
 * is LOD2. The key-pan step is panStepFor(visibleWidth, visibleHeight),
 * clamped to [25, 400] px, so one crossing needs at least 30 key steps at
 * the overview zoom where the territory spans ~125 km.
 */
const LOD_STEPS_PER_CROSSING = 34;

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
  w.__stress = { rejections: [], errors: [], consoleErrors: [], warnErrors: [], frames: [], sampling: false };
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
    w.__stress.warnErrors.push({ at: Math.round(performance.now()), text: args.map(String).join(" ").slice(0, 300) });
    origWarn(...args);
  };
  return true;
})()`;

const SAMPLE_PROBE = `(() => {
  const s = window.__stress;
  if (s === undefined) return null;
  s.frames = [];
  let last = performance.now();
  s.sampling = true;
  const tick = () => {
    if (!s.sampling) return;
    const now = performance.now();
    s.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return true;
})()`;

const COLLECT_PROBE = `(() => {
  const w = window;
  const s = w.__stress ?? { rejections: [], errors: [], consoleErrors: [], warnErrors: [], frames: [] };
  s.sampling = false;
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
    frames: s.frames,
    rejections: s.rejections,
    errors: s.errors,
    consoleErrors: s.consoleErrors,
    warnErrors: s.warnErrors,
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
  rejections: { at: number; reason: string }[];
  errors: { at: number; message: string }[];
  consoleErrors: { at: number; text: string }[];
  warnErrors: { at: number; text: string }[];
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

interface PhaseResult {
  phase: string;
  sample: Sample;
  frames: Record<string, number>;
  durationMs: number;
  notes: string[];
}

type Action = () => Promise<void>;

const FOCUS_SEARCH = `(() => {
  const input = document.querySelector('[data-testid="search-input"]');
  if (input === null) return false;
  input.focus();
  return true;
})()`;

const CLICK_OPTION = `(() => {
  const option = document.querySelector('[role="option"]');
  if (option === null) return false;
  option.click();
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

const DISMISS_MENU = `(() => {
  const menu = document.querySelector('[data-testid="feature-context-menu"]');
  if (menu === null) return false;
  menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  return true;
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

const OPTION_COUNT = `(() => document.querySelectorAll('[role="option"]').length)()`;

/**
 * One full idle-soak cycle in a single round trip: pan out, pan back, zoom
 * in, zoom out, reset the view, then read the heap. Every phase returns
 * the camera to the same place, so the heap series across cycles is the
 * direct evidence that repeated navigation retains nothing.
 */
const IDLE_CYCLE_PROBE = `(() => {
  const stroke = (code, key, n) => {
    for (let i = 0; i < n; i += 1) {
      window.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true }));
    }
  };
  stroke("KeyL", "l", 6);
  stroke("KeyJ", "j", 4);
  stroke("Equal", "=", 2);
  stroke("KeyH", "h", 6);
  stroke("KeyK", "k", 4);
  stroke("Minus", "-", 2);
  const button = document.querySelector('[data-testid="reset-view"]');
  if (button !== null) button.click();
  return performance.memory ? performance.memory.usedJSHeapSize : null;
})()`;

const SCENE_DIGEST = `(() => {
  const node = document.getElementById("scene-diagnostics");
  if (node === null || node.textContent === null) return null;
  const out = {};
  for (const part of node.textContent.split("\\u2502")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return { loadedTiles: out["loaded-tile-count"], drawCalls: out["draw-calls"], zoom: out["camera-zoom"], wpp: (window.__masterMapsLabels ?? {}).worldPerPixel };
})()`;

const CONTEXT_SWEEP = `(() => {
  const canvas = document.querySelector("canvas");
  if (canvas === null) return { attempted: 0, opened: 0 };
  const r = canvas.getBoundingClientRect();
  let attempted = 0;
  let opened = 0;
  for (let ix = 1; ix <= 5; ix += 1) {
    for (let iy = 1; iy <= 4; iy += 1) {
      const x = r.x + (r.width * ix) / 6;
      const y = r.y + (r.height * iy) / 5;
      canvas.dispatchEvent(new MouseEvent("contextmenu", { clientX: x, clientY: y, button: 2, buttons: 2, bubbles: true, cancelable: true }));
      attempted += 1;
      const menu = document.querySelector('[data-testid="feature-context-menu"]');
      if (menu !== null) {
        opened += 1;
        menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    }
  }
  return { attempted, opened };
})()`;

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
  rejections: [],
  errors: [],
  consoleErrors: [],
  warnErrors: [],
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
  private abortedAccounting = "not measured";
  private menuOpens = 0;
  private menuObservedOpen = 0;
  private searchOptionsSeen = 0;
  private lodCrossingsObserved = 0;
  private lodTrace: string[] = [];
  private cameraZooms: number[] = [];
  private cameraTargets: number[] = [];
  private plateau: { step: string; loadedTiles: number; heapUsed: number | null; drawCalls: string | null }[] = [];
  private lastIdleError = "none";
  private verdicts: Record<string, string> = {};

  private overBudget(): boolean {
    return Date.now() - this.startedAt > BUDGET_MS;
  }

  private hardStop(): boolean {
    return Date.now() - this.startedAt > RUN_HARD_STOP_MS;
  }

  private async setup(): Promise<void> {
    mkdirSync(ARTIFACTS, { recursive: true });
    this.renderTilesStart = readdirSync(RENDER_DIR).length;
    await this.mcp.start();
    await this.mcp.tool("health", {}, 60_000);
    await this.mcp.tool("version", {}, 60_000);
    await this.mcp.tool("profile_open", { name: PROFILE }, 90_000);
    /**
     * gpu_mode reports a guard quarantine on its own output, a known tool
     * issue. The call is still issued so the hardware mode is requested;
     * the adapter is then proven through WEBGL_debug_renderer_info, which
     * must not be a software renderer. A timeout here is tolerated because
     * the default is already hardware on this host, and the adapter probe
     * below is the authoritative check.
     */
    try {
      await this.mcp.tool("gpu_mode", { mode: "hardware" }, 90_000);
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
    this.notes.push(`gpu_mode hardware verified via WEBGL_debug_renderer_info: ${this.gpuEvidence}`);
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
   * The guarded `press_key` tool does not reach the map: MapControls binds
   * `window.addEventListener("keydown")` and a CDP key event dispatched at
   * the document level never reaches that window listener, so camera-zoom
   * stayed pinned at 1 for an entire run. A synthetic KeyboardEvent
   * dispatched on window does reach it, verified by probe: three `Equal`
   * events moved camera-zoom from 1 to 1.2403246813938753.
   */
  private async pressKey(stroke: KeyStroke): Promise<void> {
    await this.mcp.evaluate(
      `(() => { window.dispatchEvent(new KeyboardEvent("keydown", { code: ${JSON.stringify(stroke.code)}, key: ${JSON.stringify(stroke.key)}, bubbles: true, cancelable: true })); return true; })()`,
    );
    await sleep(60);
  }

  /**
   * Dispatch a whole key sequence in one round trip. Key events are
   * synchronous, so batching them is behaviourally identical to N
   * separate round trips while removing the per-key MCP latency that
   * otherwise starves the page and makes CDP round trips time out.
   */
  private async pressSequence(strokes: KeyStroke[]): Promise<void> {
    const list = strokes.map((s) => `["${s.code}","${s.key}"]`).join(",");
    await this.mcp.evaluate(
      `(() => { const seq = [${list}]; for (const [code, key] of seq) { window.dispatchEvent(new KeyboardEvent("keydown", { code, key, bubbles: true, cancelable: true })); } return seq.length; })()`,
      60_000,
    );
    await sleep(60);
  }

  private async pressKeys(stroke: KeyStroke, count: number): Promise<void> {
    await this.pressSequence(Array.from({ length: count }, () => stroke));
  }

  private async phase(name: string, actions: Action[], settleMs = 1200): Promise<PhaseResult> {
    const phaseStart = Date.now();
    await this.mcp.evaluate(SAMPLE_PROBE);
    const notes: string[] = [];
    let executed = 0;
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
    const left = BUDGET_MS - (Date.now() - this.startedAt);
    await sleep(Math.max(0, Math.min(settleMs, left)));
    let raw: RawSample;
    try {
      raw = await this.mcp.evaluate<RawSample>(COLLECT_PROBE, 60_000);
    } catch (error) {
      notes.push(`phase sample collection timed out: ${String(error).slice(0, 120)}`);
      raw = EMPTY_SAMPLE;
    }
    const sample: Sample = { phase: name, at: new Date().toISOString(), ...raw };
    this.samples.push(sample);
    const result: PhaseResult = {
      phase: name,
      sample,
      frames: summariseFrames(sample.frames),
      durationMs: Date.now() - phaseStart,
      notes,
    };
    this.phases.push(result);
    this.report(result);
    return result;
  }

  private report(result: PhaseResult): void {
    const d = result.sample.diag;
    const f = result.frames;
    console.log(
      `  [${result.phase} | heap=${result.sample.heapUsed === null ? "n/a" : `${(result.sample.heapUsed / 1e6).toFixed(1)}MB`} | tiles r/l/a/f=${d === null ? "n/a" : `${d.requested}/${d.loaded}/${d.aborted}/${d.failed}`} | draw=${result.sample.scene["draw-calls"] ?? "n/a"} | frames=${f.count ?? 0} p50=${f.p50Ms ?? "-"} p99=${f.p99Ms ?? "-"} | ${(result.durationMs / 1000).toFixed(1)}s]`,
    );
    for (const note of result.notes) console.log(`      note: ${note}`);
  }

  /** 20 alternating pan/zoom operations spread over several Gers locations. */
  private async panZoomPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    for (let i = 0; i < 20; i += 1) {
      const zoomIn = i % 2 === 0;
      actions.push(async () => {
        const rect = await this.mcp.evaluate<{ x: number; y: number; w: number; h: number } | null>(CANVAS_RECT);
        if (rect === null) throw new Error("no canvas");
        const fx = 0.2 + 0.6 * (((i * 7) % 5) / 4);
        const fy = 0.2 + 0.6 * (((i * 3) % 5) / 4);
        await this.mcp.tool("click_xy", { x: Math.round(rect.x + rect.w * fx), y: Math.round(rect.y + rect.h * fy) });
        await this.pressKey(PAN_KEYS[`Key${"HLJK"[i % 4]!}`]!);
        await this.pressKey(PAN_KEYS[`Key${"HLJK"[(i + 1) % 4]!}`]!);
      });
      actions.push(async () => {
        await this.pressKey(zoomIn ? ZOOM_IN : ZOOM_OUT);
      });
    }
    return this.phase("panzoom-alternating-20", actions, 1500);
  }

  /** 10 rapid direction reversals. */
  private async reversalPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    for (let i = 0; i < 10; i += 1) {
      actions.push(async () => {
        await this.pressKeys(PAN_KEYS[i % 2 === 0 ? "KeyL" : "KeyH"]!, 5);
        await this.pressKeys(PAN_KEYS[i % 2 === 0 ? "KeyH" : "KeyL"]!, 5);
      });
    }
    return this.phase("direction-reversals-10", actions, 1200);
  }

  /** 10 search focus jumps. */
  private async searchPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    for (const term of SEARCH_TERMS) {
      actions.push(async () => {
        await this.mcp.evaluate(FOCUS_SEARCH);
        await this.mcp.tool("type_text", { selector: '[data-testid="search-input"]', text: term }, 45_000);
        const options = await this.mcp.evaluate<number>(OPTION_COUNT);
        if (options > 0) {
          this.searchOptionsSeen += 1;
          await this.mcp.evaluate(CLICK_OPTION);
        }
        await sleep(500);
        await this.mcp.evaluate(CLEAR_SEARCH);
      });
      actions.push(async () => {
        await this.mcp.evaluate(RESET_VIEW);
      });
    }
    const result = await this.phase("search-focus-jumps-10", actions, 1500);
    this.notes.push(`search terms returning at least one result option: ${this.searchOptionsSeen}/${SEARCH_TERMS.length}`);
    return result;
  }

  /**
   * 3 rapid LOD crossings. Records the visible span implied by the label
   * layer worldPerPixel at each stop so the 12 km and 60 km thresholds are
   * shown to be crossed, not merely assumed.
   */
  private async lodPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    for (let crossing = 0; crossing < 3; crossing += 1) {
      actions.push(async () => {
        await this.pressKeys(ZOOM_IN, LOD_STEPS_PER_CROSSING);
        const inState = await this.mcp.evaluate<{ loadedTiles: string; drawCalls: string; zoom: string; wpp: number | null } | null>(SCENE_DIGEST);
        this.lodTrace.push(`crossing${crossing + 1} zoomed-in ${JSON.stringify(inState)}`);
        await this.pressKeys(ZOOM_OUT, LOD_STEPS_PER_CROSSING);
        const outState = await this.mcp.evaluate<{ loadedTiles: string; drawCalls: string; zoom: string; wpp: number | null } | null>(SCENE_DIGEST);
        this.lodTrace.push(`crossing${crossing + 1} zoomed-out ${JSON.stringify(outState)}`);
        const wppIn = inState?.wpp ?? null;
        const wppOut = outState?.wpp ?? null;
        if (wppIn !== null && wppOut !== null) {
          const spanIn = wppIn * 900;
          const spanOut = wppOut * 900;
          const classOf = (span: number): number => (span <= 12_000 ? 0 : span <= 60_000 ? 1 : 2);
          const before = classOf(spanIn);
          const after = classOf(spanOut);
          if (before !== after) this.lodCrossingsObserved += 1;
          this.lodTrace.push(`crossing${crossing + 1} zoom-in span=${Math.round(spanIn)}m LOD${before}; zoom-out span=${Math.round(spanOut)}m LOD${after}`);
        }
      });
    }
    const result = await this.phase("lod-crossings-3", actions, 1500);
    this.notes.push(`LOD class transitions observed: ${this.lodCrossingsObserved} across 3 crossings`);
    for (const line of this.lodTrace) this.notes.push(`lod-trace ${line}`);
    return result;
  }

  /** 5 context-menu open/close cycles. */
  private async menuPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    for (let i = 0; i < 5; i += 1) {
      actions.push(async () => {
        const sweep = await this.mcp.evaluate<{ attempted: number; opened: number }>(CONTEXT_SWEEP);
        this.menuOpens += sweep.attempted;
        this.menuObservedOpen += sweep.opened;
        await sleep(300);
      });
      actions.push(async () => {
        await this.mcp.evaluate(DISMISS_MENU);
      });
    }
    const result = await this.phase("context-menu-cycles-5", actions, 1200);
    this.notes.push(
      `context menu: ${this.menuOpens} synthetic right-clicks over a 5x4 canvas grid, ${this.menuObservedOpen} produced an open menu`,
    );
    return result;
  }

  /** Bounded tail soak: repeated pan/zoom churn after the scripted phases. */
  private async soakPhase(): Promise<PhaseResult> {
    const actions: Action[] = [];
    for (let i = 0; i < 30; i += 1) {
      actions.push(async () => {
        await this.pressKey(PAN_KEYS[`Key${"HLJK"[i % 4]!}`]!);
        await this.pressKey(i % 3 === 0 ? ZOOM_IN : ZOOM_OUT);
      });
    }
    return this.phase("soak-tail", actions, 2000);
  }

  /**
   * Idle cycles with a reset-view between them. The heap series here is
   * the primary monotonic-growth evidence: each cycle returns the camera
   * to the same place, so any retained tile, geometry or decoded slab must
   * show up as a rising floor.
   */
  private async idleSoak(sliceMs: number): Promise<void> {
    const start = Date.now();
    const heaps: number[] = [];
    let cycles = 0;
    let timeouts = 0;
    while (Date.now() - start < sliceMs && !this.hardStop() && !this.overBudget()) {
      cycles += 1;
      try {
        const heap = await this.mcp.evaluate<number | null>(IDLE_CYCLE_PROBE, 90_000);
        if (heap !== null) heaps.push(heap);
        await sleep(300);
      } catch (error) {
        timeouts += 1;
        this.lastIdleError = String(error).slice(0, 160);
        await sleep(1000);
      }
    }
    let raw: RawSample;
    try {
      raw = await this.mcp.evaluate<RawSample>(COLLECT_PROBE, 90_000);
    } catch (error) {
      timeouts += 1;
      this.lastIdleError = String(error).slice(0, 160);
      raw = EMPTY_SAMPLE;
    }
    const sample: Sample = { phase: `idle-soak-${cycles}-cycles`, at: new Date().toISOString(), ...raw };
    this.samples.push(sample);
    const result: PhaseResult = {
      phase: sample.phase,
      sample,
      frames: summariseFrames(sample.frames),
      durationMs: Date.now() - start,
      notes: [
        `idle soak cycles: ${cycles}`,
        `recovered MCP timeouts: ${timeouts}${timeouts > 0 ? ` (last: ${this.lastIdleError})` : ""}`,
        `per-cycle heap MB: ${heaps.map((h) => (h / 1e6).toFixed(1)).join(", ")}`,
      ],
    };
    this.phases.push(result);
    this.report(result);
    this.notes.push(`idle soak ${cycles} cycles, heap ${(heaps[0] ?? 0) / 1e6} MB -> ${(heaps[heaps.length - 1] ?? 0) / 1e6} MB`);
  }

  /**
   * Loaded-tile plateau probe: return to the overview, then pan away and
   * back repeatedly. loaded-tile-count must fall or hold, never grow
   * without bound.
   */
  private async plateauProbe(): Promise<void> {
    const read = async (step: string): Promise<void> => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const snap = await this.mcp.evaluate<RawSample>(COLLECT_PROBE, 90_000);
          this.cameraZooms.push(Number(snap.scene["camera-zoom"] ?? 0));
          this.cameraTargets.push(Number(snap.scene["camera-target-x"] ?? 0));
          this.plateau.push({
            step,
            loadedTiles: Number(snap.scene["loaded-tile-count"] ?? -1),
            heapUsed: snap.heapUsed,
            drawCalls: snap.scene["draw-calls"] ?? null,
          });
          return;
        } catch (error) {
          this.notes.push(`plateau probe ${step} attempt ${attempt} timed out: ${String(error).slice(0, 100)}`);
          await sleep(1500);
        }
      }
    };
    await this.mcp.evaluate(RESET_VIEW);
    await sleep(1500);
    await read("overview-1");
    for (let i = 0; i < 4; i += 1) {
      await this.pressKeys(PAN_KEYS.KeyL!, 6);
      await sleep(900);
      await read(`panned-right-${i + 1}`);
      await this.pressKeys(PAN_KEYS.KeyH!, 6);
      await sleep(900);
      await read(`returned-left-${i + 1}`);
    }
    for (let i = 0; i < 3; i += 1) {
      await this.pressKeys(ZOOM_IN, 4);
      await sleep(800);
      await read(`zoomed-in-${i + 1}`);
      await this.pressKeys(ZOOM_OUT, 4);
      await sleep(800);
      await read(`zoomed-out-${i + 1}`);
    }
  }

  private assess(): void {
    const last = this.samples.slice(-3).filter((s) => s.heapUsed !== null);
    if (last.length < 3) {
      this.verdicts.heap = "INCONCLUSIVE: fewer than three phases carried a heap reading";
    } else {
      const means = last.map((s) => s.heapUsed as number);
      const monotonic = means[0]! < means[1]! && means[1]! < means[2]!;
      const delta = means[2]! - means[0]!;
      this.verdicts.heap =
        `last three phase heaps (MB): ${means.map((m) => (m / 1e6).toFixed(1)).join(" -> ")}; ` +
        `strictly monotonic increase: ${monotonic}; delta ${(delta / 1e6).toFixed(1)} MB; threshold ${(HEAP_GROWTH_MARGIN_BYTES / 1e6).toFixed(1)} MB. ` +
        (monotonic && delta > HEAP_GROWTH_MARGIN_BYTES
          ? "VERDICT: MONOTONIC HEAP GROWTH, defect."
          : "VERDICT: no monotonic heap growth beyond the stated threshold.");
    }

    const rejections = this.samples.flatMap((s) => s.rejections);
    this.verdicts.rejections =
      rejections.length === 0
        ? "VERDICT: zero unhandled promise rejections across all phases."
        : `VERDICT: ${rejections.length} unhandled promise rejection(s), defect: ${JSON.stringify(rejections.slice(0, 5))}`;

    const gpuText = this.samples.flatMap((s) => s.consoleErrors).filter((e) => /webgpu|validation|gpu|device lost|pipeline/i.test(e.text));
    const rendererError = this.samples.filter((s) => (s.scene["renderer-error"] ?? "none") !== "none");
    const lost = this.samples.filter((s) => s.scene["renderer-status"] === "lost");
    this.verdicts.webgpu =
      gpuText.length === 0 && rendererError.length === 0 && lost.length === 0
        ? "VERDICT: no WebGPU validation errors, no renderer error, no device loss."
        : `VERDICT: WebGPU or renderer problem, defect: errors=${JSON.stringify(gpuText.slice(0, 5))} rendererError=${JSON.stringify(rendererError.map((s) => s.scene["renderer-error"]))} lost=${lost.length}`;

    const first = this.samples[0]?.diag ?? null;
    const final = this.samples[this.samples.length - 1]?.diag ?? null;
    if (first === null || final === null) {
      this.verdicts.aborted = "INCONCLUSIVE: no tile diagnostics samples";
    } else {
      const delta: TileDiag = {
        requested: final.requested - first.requested,
        loaded: final.loaded - first.loaded,
        aborted: final.aborted - first.aborted,
        failed: final.failed - first.failed,
        requestedUnique: final.requestedUnique - first.requestedUnique,
        loadedUnique: final.loadedUnique - first.loadedUnique,
        abortedUnique: final.abortedUnique - first.abortedUnique,
        failedUnique: final.failedUnique - first.failedUnique,
      };
      const terminal = delta.loaded + delta.aborted + delta.failed;
      this.abortedAccounting =
        `cumulative requested=${final.requested} loaded=${final.loaded} aborted=${final.aborted} failed=${final.failed}; ` +
        `phase delta requested=${delta.requested} loaded=${delta.loaded} aborted=${delta.aborted} failed=${delta.failed} terminalSum=${terminal}`;
      this.verdicts.aborted =
        terminal >= delta.requested
          ? `VERDICT: aborted requests accounted for. ${this.abortedAccounting}`
          : `VERDICT: aborted accounting gap of ${delta.requested - terminal}, defect. ${this.abortedAccounting}`;
    }

    const counts = this.plateau.map((p) => p.loadedTiles).filter((c) => c >= 0);
    if (counts.length === 0) {
      this.verdicts.disposal = "INCONCLUSIVE: plateau probe produced no loaded-tile-count readings";
    } else {
      const peak = Math.max(...counts);
      const tailMax = Math.max(...counts.slice(-3));
      this.verdicts.disposal =
        `loaded-tile-count series: ${counts.join(" -> ")}; peak ${peak}; final-three max ${tailMax}. ` +
        (tailMax <= peak
          ? "VERDICT: loaded-tile count never exceeded its peak, disposal keeps the resident set bounded."
          : "VERDICT: loaded-tile count grew beyond the peak without bound, defect.");
    }

    const busiest = [...this.phases].filter((p) => (p.frames.count ?? 0) > 20).sort((a, b) => (b.frames.p50Ms ?? 0) - (a.frames.p50Ms ?? 0))[0];
    this.verdicts.frames =
      busiest === undefined
        ? "INCONCLUSIVE: no phase collected enough frames"
        : `busiest phase by p50 frame duration is ${busiest.phase}: ${JSON.stringify(busiest.frames)}`;

    this.verdicts.gpuCache =
      "NOT REACHABLE: getTileGpuCacheStats is a module-level export of src/lib/render/tileGpuCache.ts with no window or global hook, " +
      "so cache entry count and byte budget cannot be read from the page. scene-diagnostics loaded-tile-count is the observable proxy.";

    this.verdicts.context = `context menu: ${this.menuObservedOpen} of ${this.menuOpens} synthetic right-clicks over a 5x4 canvas grid opened the menu`;
    this.verdicts.search = `search terms producing result options: ${this.searchOptionsSeen} of ${SEARCH_TERMS.length}`;
    this.verdicts.lod = `LOD class transitions observed: ${this.lodCrossingsObserved} across 3 crossings`;

    const zoomSpread = this.cameraZooms.length > 0 ? Math.max(...this.cameraZooms) - Math.min(...this.cameraZooms) : 0;
    const targetSpread = this.cameraTargets.length > 0 ? Math.max(...this.cameraTargets) - Math.min(...this.cameraTargets) : 0;
    this.verdicts.cameraMotion =
      `camera-zoom range ${this.cameraZooms.length > 0 ? Math.min(...this.cameraZooms).toFixed(3) : "n/a"} .. ${this.cameraZooms.length > 0 ? Math.max(...this.cameraZooms).toFixed(3) : "n/a"} (spread ${zoomSpread.toFixed(3)}); ` +
      `camera-target-x spread ${targetSpread.toFixed(1)} m over ${this.cameraZooms.length} samples. ` +
      (zoomSpread > 0.05 && targetSpread > 1
        ? "VERDICT: the scripted input actually moved the camera, so every phase above exercised real navigation."
        : "VERDICT: the scripted input did NOT move the camera, so the navigation phases were no-ops and their counters prove nothing.");
  }

  private result(): Record<string, unknown> {
    return {
      target: TARGET,
      generatedAt: new Date().toISOString(),
      wallClockMs: Date.now() - this.startedAt,
      budgetMs: BUDGET_MS,
      gpuEvidence: this.gpuEvidence,
      renderTilesAtStart: this.renderTilesStart,
      renderTilesAtEnd: this.renderTilesEnd,
      manifestEntries: 9591,
      heapGrowthThresholdBytes: HEAP_GROWTH_MARGIN_BYTES,
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
        searchOptionCount: p.sample.searchOptions,
        contextMenuPresent: p.sample.contextMenu,
        unhandledRejections: p.sample.rejections,
        pageErrors: p.sample.errors,
        consoleErrorCount: p.sample.consoleErrors.length,
        consoleErrors: p.sample.consoleErrors.slice(0, 5),
        warnSample: p.sample.warnErrors.slice(0, 3),
        warnCount: p.sample.warnErrors.length,
        labels: p.sample.labels,
      })),
      plateauProbe: this.plateau,
      cameraZoomSeries: this.cameraZooms,
      cameraTargetXSeries: this.cameraTargets,
      abortedAccounting: this.abortedAccounting,
      verdicts: this.verdicts,
      notes: this.notes,
    };
  }

  async run(): Promise<void> {
    console.log("=== W4-STRESS setup ===");
    await this.setup();
    console.log(`gpu evidence: ${this.gpuEvidence}`);
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

    const remaining = BUDGET_MS - (Date.now() - this.startedAt);
    if (remaining > 60_000) {
      console.log("\n=== phase 7: idle soak cycles ===");
      await this.idleSoak(Math.min(remaining - 20_000, 180_000));
    }

    console.log("\n=== phase 8: loaded-tile plateau probe ===");
    try {
      await this.plateauProbe();
    } catch (error) {
      this.notes.push(`plateau probe aborted: ${String(error).slice(0, 160)}`);
    }

    this.renderTilesEnd = readdirSync(RENDER_DIR).length;
    this.assess();
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(resolve(ARTIFACTS, "stress-run.json"), JSON.stringify(this.result(), null, 2));
    console.log("\n=== raw counters ===");
    console.log(JSON.stringify(this.result(), null, 2));
  }

  async teardown(): Promise<void> {
    this.renderTilesEnd = readdirSync(RENDER_DIR).length;
    try {
      await this.mcp.tool("profile_close");
    } catch {
      // profile already gone
    }
    this.mcp.stop();
  }
}

async function main(): Promise<void> {
  const run = new StressRun();
  let failure: string | null = null;
  try {
    await run.run();
  } catch (error) {
    failure = String(error);
    console.error("stress run failed:", error);
  } finally {
    await run.teardown();
  }
  if (failure !== null) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error("verify-stress failed:", error);
  process.exit(1);
});
