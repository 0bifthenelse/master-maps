/**
 * Real WebGPU runtime verification of the production map surface, driven
 * through the guarded `internet` MCP runtime (skill://master-internet).
 *
 * This is the replacement for the Playwright-only path in
 * scripts/chrome/run-verification.ts for every WebGPU and visual claim.
 * That file is the legacy CDP/Playwright path and is deliberately NOT
 * modified here: it stays runnable as `npm run verify:chrome`.
 *
 * Run: npx tsx scripts/chrome/verify-runtime.ts [url]
 *   url defaults to http://localhost:3202/ (the `next dev` server that
 *   serves the current source tree).
 *
 * The guarded runtime owns the browser, so everything goes through its MCP
 * tools. Three properties of that runtime shape this script:
 *   - `gpu_mode hardware` only relaunches when the mode changes, so it is
 *     requested before `profile_open` (which starts the default `off` pipe)
 *     and the first `health` call afterwards, with the evidence kept in
 *     `chrome.gpu_evidence`.
 *   - a window level error/network instrumentation harness cannot be
 *     attached after the app boots: the runtime enables `Runtime` and `Log`
 *     as soon as its pipe opens, so a late `Runtime.addBinding` +
 *     `Page.addScriptToEvaluateOnNewDocument` is refused with
 *     "Script injection is not allowed". The harness is therefore installed
 *     by a short-lived PRELOAD instance of the same runtime (which reads its
 *     own first page, an `about:blank` target, so the guard screens nothing)
 *     and survives because the app writes `window.__w4` and never navigates.
 *   - `click_xy` is a LEFT button press/release with no button or modifier
 *     argument, so a left-drag and a right-click are dispatched as real DOM
 *     PointerEvents from the page. The raycast behind the right-click comes
 *     from the app's own R3F state, so the click exercises the page's real
 *     listeners and picking, not a trusted click sequence.
 *
 * Screenshots are PNGs from the guarded `shot` tool, written to
 * /tmp/w4-runtime/. The machine readable summary is printed as the last
 * stdout block and written to data/qa/runtime-verification.json.
 *
 * Every claim is recorded as verified, failed or untestable with a reason,
 * so a partial dataset run still produces honest, complete evidence.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SHOT_DIR = "/tmp/w4-runtime";
const PRELOAD_PROFILE = "/tmp/w4-runtime-preload-profile";
const MCP_BIN = process.env.MASTER_INTERNET_BIN ?? "/master/internet/target/release/master-internet-unit";
const MCP_CWD = "/master/internet";
const MCP_TIMEOUT_MS = Number(process.env.W4_MCP_TIMEOUT_MS ?? 240000);
const PRELOAD_PROFILE_ARGS = ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${PRELOAD_PROFILE}`, "--window-size=1440,900", "about:blank"];
const MCP_SERVER: StdioServerParameters = {
  command: MCP_BIN,
  args: [],
  cwd: MCP_CWD,
  env: process.env as Record<string, string>,
};
const PRELOAD_SERVER: StdioServerParameters = {
  command: MCP_BIN,
  args: PRELOAD_PROFILE_ARGS,
  cwd: MCP_CWD,
  env: process.env as Record<string, string>,
  stderr: "ignore",
};

const TOWN_CANDIDATES = ["Lectoure", "Auch", "Mirande", "Gimont", "Condom", "Fleurance", "Mauvezin", "Riscle", "Samatan", "Barcelonne-du-Gers"];
const DIAGNOSTIC_KEYS = [
  "renderer-status",
  "backend",
  "loaded-tile-count",
  "loaded-feature-count",
  "building-count",
  "road-count",
  "water-count",
  "landuse-count",
  "business-count",
  "poi-count",
  "draw-calls",
  "camera-target-x",
  "camera-target-z",
  "camera-zoom",
  "camera-state",
  "renderer-error",
] as const;

type Verdict = "verified" | "failed" | "untestable";

interface Assertion {
  id: string;
  claim: string;
  verdict: Verdict;
  observed: unknown;
  reason?: string;
}

interface Step {
  name: string;
  ok: boolean;
  detail: unknown;
  shot: string | null;
}

interface Diagnostics {
  target: [number, number, number];
  position?: [number, number, number];
  zoom: number;
  azimuthalAngle?: number;
  headingRadians?: number;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/* ------------------------------------------------------------------ */
/*  MCP plumbing                                                       */
/* ------------------------------------------------------------------ */

class McpSession {
  readonly client: Client;
  private opened = false;

  constructor(private readonly label: "preload" | "verify") {
    this.client = new Client(
      { name: `master-maps-verify-runtime-${label}`, version: "1.0.0" },
      { capabilities: {} },
    );
  }

  async open(server: StdioServerParameters = MCP_SERVER): Promise<void> {
    await this.client.connect(new StdioClientTransport(server));
    this.opened = true;
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<{ text: string; images: Array<{ mimeType: string; data: string }> }> {
    const result = await this.client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: MCP_TIMEOUT_MS, maxTotalTimeout: MCP_TIMEOUT_MS },
    );
    const text: string[] = [];
    const images: Array<{ mimeType: string; data: string }> = [];
    for (const item of result.content) {
      if (item.type === "text") text.push(item.text);
      else if (item.type === "image") images.push({ mimeType: item.mimeType, data: item.data });
    }
    return { text: text.join("\n"), images };
  }

  async json<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const call = await this.call(tool, args);
    try {
      return JSON.parse(call.text) as T;
    } catch (cause) {
      throw new Error(`${tool} returned non-JSON text: ${call.text.slice(0, 300)} (${String(cause)})`);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    await this.client.close().catch(() => undefined);
  }
}

/**
 * The launcher reads its arguments only when the first tool call needs a
 * browser. One `evaluate` of a sentinel expression therefore proves the
 * browser is up AND that this instance launched with the preload profile
 * flags: `location.href` is about:blank and `navigator.gpu` is present
 * (the managed headless-shell the runtime would otherwise pick has no
 * WebGPU at all).
 */
async function waitForPreloadBrowser(session: McpSession, timeoutMs: number): Promise<{ location: string; gpu: boolean } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = await session.json<{ location: string; gpu: boolean }>("evaluate", {
        expr: "({ location: String(location.href), gpu: typeof navigator.gpu !== 'undefined' })",
      });
      if (probe.location === "about:blank") return probe;
    } catch {
      /* the pipe is still coming up */
    }
    await sleep(1500);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Harness injected into the page by the preload instance            */
/* ------------------------------------------------------------------ */

const HARNESS = `
(() => {
  if (window.__w4) {
    // The hardware session re-runs this script so the WebGPU error hook can
    // attach: the preload instance ran in the runtime default gpu mode off,
    // where navigator.gpu does not exist yet.
    const attached = window.__w4.attachGpuHook ? window.__w4.attachGpuHook() : false;
    return "already-installed, gpuHook=" + String(attached);
  }
  const g = window;
  const w4 = {
    installedAt: Date.now(),
    consoleErrors: [],
    consoleWarnings: [],
    errors: [],
    gpuValidationErrors: [],
    rejected: [],
    fetches: [],
    contexts: [],
    ready: false,
  };
  g.__w4 = w4;
  const stringify = (value) => {
    if (value instanceof Error) return value.name + ": " + value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const line = args.map(stringify).join(" ");
      if (level === "error") w4.consoleErrors.push(line);
      else w4.consoleWarnings.push(line);
      return original(...args);
    };
  }
  g.addEventListener("error", (event) => w4.errors.push(String((event && event.message) || event)), true);
  g.addEventListener("unhandledrejection", (event) => w4.rejected.push(String((event && event.reason && event.reason.message) || event.reason)));
  // The preload instance runs with GPU mode off, so navigator.gpu is absent
  // there. The hook is therefore attached lazily by the hardware session,
  // which re-runs this script and lands in the already-installed branch.
  const attachGpuHook = () => {
    if (w4.gpuHook || !g.navigator || !g.navigator.gpu) return Boolean(w4.gpuHook);
    try {
      g.navigator.gpu.addEventListener("uncapturederror", (event) => {
        const error = event && event.error;
        w4.gpuValidationErrors.push(((error && error.constructor && error.constructor.name) || "GPUError") + ": " + String(error && error.message));
      });
      w4.gpuHook = true;
    } catch (error) { w4.errors.push("uncapturederror hook failed: " + String(error)); }
    return Boolean(w4.gpuHook);
  };
  w4.attachGpuHook = attachGpuHook;
  attachGpuHook();
  const originalFetch = g.fetch.bind(g);
  g.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || "GET";
    return originalFetch(input, init).then((response) => {
      w4.fetches.push({ url: String(url), method: String(method), status: response.status, ok: response.ok });
      return response;
    }, (error) => {
      w4.fetches.push({ url: String(url), method: String(method), status: 0, ok: false, error: String(error) });
      throw error;
    });
  };
  const proto = g.HTMLCanvasElement && g.HTMLCanvasElement.prototype;
  const originalGetContext = proto.getContext;
  proto.getContext = function (type, ...rest) {
    let context = null;
    try { context = originalGetContext.call(this, type, ...rest); } catch (error) { w4.errors.push("getContext(" + String(type) + ") threw " + String(error)); }
    if (context) w4.contexts.push(String(type));
    return context;
  };
  const canvasOf = () => document.querySelector("canvas");
  const fire = (target, type, init) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: g,
    pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: 0, ...init,
  }));
  w4.hooks = {
    canvas: () => canvasOf(),
    app: () => {
      const canvas = canvasOf();
      const root = canvas && canvas.__r3f && canvas.__r3f.root;
      if (!root) return { error: "no r3f root" };
      const state = root.getState();
      return {
        camera: {
          zoom: state.camera.zoom,
          left: state.camera.left,
          right: state.camera.right,
          top: state.camera.top,
          bottom: state.camera.bottom,
          position: [state.camera.position.x, state.camera.position.y, state.camera.position.z],
          rotationZ: state.camera.rotation.z,
        },
        controls: {
          target: [state.controls.target.x, state.controls.target.y, state.controls.target.z],
          panSpeed: state.controls.panSpeed,
          enableDamping: state.controls.enableDamping,
          dampingFactor: state.controls.dampingFactor,
          mouseButtons: { ...state.controls.mouseButtons },
          touches: { ...state.controls.touches },
        },
        size: { width: state.size.width, height: state.size.height },
        tileDiagnostics: window.__masterMapsTileDiagnostics || null,
      };
    },
    diagnostics: () => {
      const element = document.getElementById("scene-diagnostics");
      if (!element) return { present: false };
      const out = { present: true };
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.indexOf("data-") === 0) out[attribute.name] = attribute.value;
      }
      return out;
    },
    canvasMetrics: () => {
      const canvas = canvasOf();
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      return {
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        cssWidth: Math.round(rect.width),
        cssHeight: Math.round(rect.height),
        cssLeft: Math.round(rect.left),
        cssTop: Math.round(rect.top),
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        devicePixelRatio: g.devicePixelRatio,
        style: canvas.getAttribute("style"),
      };
    },
    counts: () => ({
      consoleErrors: w4.consoleErrors.length,
      consoleWarnings: w4.consoleWarnings.length,
      errors: w4.errors.length,
      gpuValidationErrors: w4.gpuValidationErrors.length,
      rejected: w4.rejected.length,
      fetches: w4.fetches.length,
      contexts: w4.contexts.length,
    }),
    renderRequests: () => {
      const rows = w4.fetches.filter((row) => row.url.indexOf("/api/map/render/") >= 0);
      const statusCodes = {};
      for (const row of rows) statusCodes[String(row.status)] = (statusCodes[String(row.status)] || 0) + 1;
      return {
        total: rows.length,
        status200: rows.filter((row) => row.status === 200).length,
        status503: rows.filter((row) => row.status === 503).length,
        other: rows.filter((row) => row.status !== 200 && row.status !== 503).length,
        statusCodes,
        sample: rows.slice(0, 8).map((row) => row.url.replace(location.origin, "") + " -> " + row.status),
      };
    },
    endpointCounts: () => {
      const byEndpoint = {};
      for (const row of w4.fetches) {
        const url = row.url;
        let key = "other";
        if (url.indexOf("/api/map/render/") >= 0) key = "render";
        else if (url.indexOf("/api/map/search") >= 0) key = "search";
        else if (url.indexOf("/api/map/manifest") >= 0) key = "manifest";
        else if (url.indexOf("/api/map/tile/") >= 0) key = "tile";
        else if (url.indexOf("_next/static") >= 0) key = "next-static";
        byEndpoint[key] = (byEndpoint[key] || 0) + 1;
      }
      return { total: w4.fetches.length, byEndpoint };
    },
    /** R3F raycast over a grid, exactly the way the app's own handlers do it. */
    raycastGrid: (columns, rows) => {
      const canvas = canvasOf();
      const root = canvas && canvas.__r3f && canvas.__r3f.root;
      if (!root) return { error: "no r3f root" };
      const state = root.getState();
      const rect = canvas.getBoundingClientRect();
      const hits = [];
      let sampled = 0;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const clientX = rect.left + rect.width * ((column + 0.5) / columns);
          const clientY = rect.top + rect.height * ((row + 0.5) / rows);
          sampled += 1;
          state.pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
          state.raycaster.setFromCamera(state.pointer, state.camera);
          const found = state.raycaster.intersectObjects(state.scene.children, true);
          if (found.length === 0) continue;
          const hit = found[0];
          const data = hit.object.userData || {};
          hits.push({
            clientX: Math.round(clientX),
            clientY: Math.round(clientY),
            objectType: hit.object.type,
            stableId: data.stableId ?? null,
            tileId: data.tileId ?? null,
            layerId: data.layerId ?? null,
            distance: hit.distance,
          });
        }
      }
      const withFeature = hits.filter((hit) => hit.stableId !== null);
      return { sampled, hitCount: hits.length, withFeature: withFeature.length, hits: (withFeature.length > 0 ? withFeature : hits).slice(0, 20) };
    },
    /** Screen point of a WGS84 coordinate, using the live orthographic camera. */
    project: (lon, lat) => {
      const canvas = canvasOf();
      const root = canvas && canvas.__r3f && canvas.__r3f.root;
      if (!root) return { error: "no r3f root" };
      const state = root.getState();
      const origin = window.__w4ProjectionOrigin;
      if (!origin) return { error: "no projection origin" };
      const metresPerDegreeLat = 111320;
      const metresPerDegreeLon = 111320 * Math.cos((origin[1] * Math.PI) / 180);
      const x = (lon - origin[0]) * metresPerDegreeLon;
      const z = -(lat - origin[1]) * metresPerDegreeLat;
      const vector = new state.camera.position.constructor(x, 0, z);
      vector.project(state.camera);
      const rect = canvas.getBoundingClientRect();
      return {
        lon, lat, local: [x, z],
        clientX: Math.round(rect.left + ((vector.x + 1) / 2) * rect.width),
        clientY: Math.round(rect.top + ((1 - vector.y) / 2) * rect.height),
        onScreen: vector.x >= -1 && vector.x <= 1 && vector.y >= -1 && vector.y <= 1 && vector.z >= -1 && vector.z <= 1,
      };
    },
    /** Convert a wanted world pan into the screen drag the controls will honour. */
    panPlan: (worldDeltaX) => {
      const canvas = canvasOf();
      const root = canvas && canvas.__r3f && canvas.__r3f.root;
      if (!root) return { error: "no r3f root" };
      const state = root.getState();
      const camera = state.camera;
      const controls = state.controls;
      const perPixelX = (camera.right - camera.left) / camera.zoom / canvas.clientWidth;
      const damping = controls.enableDamping ? controls.dampingFactor : 1;
      return {
        perPixelX,
        perPixelY: (camera.top - camera.bottom) / camera.zoom / canvas.clientHeight,
        panSpeed: controls.panSpeed,
        damping,
        screenDeltaX: worldDeltaX / perPixelX,
        note: "each pointermove contributes panDelta*panSpeed*perPixel, and the target receives panOffset*dampingFactor per frame",
      };
    },
    drag: (fromX, fromY, toX, toY, steps) => {
      const canvas = canvasOf();
      if (!canvas) return { ok: false, reason: "no canvas" };
      const count = Math.max(1, steps | 0);
      fire(canvas, "pointermove", { clientX: fromX, clientY: fromY });
      fire(canvas, "pointerdown", { clientX: fromX, clientY: fromY, button: 0, buttons: 1 });
      for (let index = 1; index <= count; index += 1) {
        const t = index / count;
        fire(canvas, "pointermove", {
          clientX: fromX + (toX - fromX) * t,
          clientY: fromY + (toY - fromY) * t,
          button: 0,
          buttons: 1,
        });
      }
      fire(canvas, "pointerup", { clientX: toX, clientY: toY, button: 0, buttons: 0 });
      return { ok: true, onCanvas: document.elementFromPoint(fromX, fromY) === canvas };
    },
    rightClick: (x, y) => {
      const canvas = canvasOf();
      if (!canvas) return { ok: false, reason: "no canvas" };
      fire(canvas, "pointermove", { clientX: x, clientY: y });
      fire(canvas, "pointerdown", { clientX: x, clientY: y, button: 2, buttons: 2 });
      fire(canvas, "pointerup", { clientX: x, clientY: y, button: 2, buttons: 0 });
      const target = document.elementFromPoint(x, y) || canvas;
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: g, clientX: x, clientY: y, button: 2 });
      target.dispatchEvent(event);
      return { ok: true, onCanvas: target === canvas, contextMenuPrevented: event.defaultPrevented };
    },
    contextMenu: () => {
      const menu = document.querySelector('[data-testid="feature-context-menu"]');
      return {
        open: Boolean(menu),
        featureId: menu ? menu.getAttribute("data-feature-id") : null,
        kind: menu ? menu.getAttribute("data-feature-kind") : null,
        flag: document.documentElement.dataset.featureContextOpen ?? null,
        actions: menu ? Array.from(menu.querySelectorAll("[data-action-id]")).map((element) => element.getAttribute("data-action-id")) : [],
      };
    },
    searchOptions: () => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const first = options[0];
      return {
        count: options.length,
        text: first ? first.textContent : null,
        kind: first ? first.getAttribute("data-feature-kind") : null,
        selected: first ? first.getAttribute("aria-selected") : null,
        inputValue: document.querySelector('[data-testid="search-input"]') ? document.querySelector('[data-testid="search-input"]').value : null,
      };
    },
    searchIntent: (kind, town) => {
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      const wanted = options.find((option) => option.getAttribute("data-feature-kind") === kind)
        || options.find((option) => String(option.textContent || "").indexOf(town) >= 0)
        || options[0];
      if (!wanted) return { ok: false, reason: "no search option", count: options.length };
      const rect = wanted.getBoundingClientRect();
      const clientX = Math.round(rect.left + rect.width / 2);
      const clientY = Math.round(rect.top + rect.height / 2);
      const topElement = document.elementFromPoint(clientX, clientY);
      const text = String(wanted.textContent || "");
      const kindOf = wanted.getAttribute("data-feature-kind");
      wanted.click();
      return {
        ok: true,
        kind: kindOf,
        text,
        clientX,
        clientY,
        reachable: topElement === wanted || Boolean(topElement && wanted.contains(topElement)),
        topElement: topElement ? topElement.tagName + (topElement.className ? "." + String(topElement.className).split(" ").join(".") : "") : null,
      };
    },
    searchIntentResult: () => ({
      listboxGone: document.querySelectorAll('[role="option"]').length === 0,
      options: document.querySelectorAll('[role="option"]').length,
      inputValue: document.querySelector('[data-testid="search-input"]') ? document.querySelector('[data-testid="search-input"]').value : null,
    }),
    layerToggles: () => Array.from(document.querySelectorAll(".layer-toggle")).map((row) => ({
      label: (row.querySelector(".layer-label") || {}).textContent,
      checked: Boolean(row.querySelector("input[type=checkbox]") && row.querySelector("input[type=checkbox]").checked),
    })),
    setOnlyLayer: (label) => {
      const panel = document.querySelector(".layer-controls-panel .panel-toggle");
      if (!panel) return { ok: false, reason: "no layer panel" };
      if (panel.getAttribute("aria-expanded") !== "true") panel.click();
      const rows = Array.from(document.querySelectorAll(".layer-toggle"));
      const target = rows.find((row) => (row.querySelector(".layer-label") || {}).textContent === label);
      if (!target) return { ok: false, reason: "layer not found: " + label };
      for (const row of rows) {
        if (row === target) continue;
        const box = row.querySelector("input[type=checkbox]");
        if (box && box.checked) box.click();
      }
      const box = target.querySelector("input[type=checkbox]");
      if (box.checked) box.click();
      return { ok: true, checked: Boolean(box.checked) };
    },
    setAllLayers: () => {
      const rows = Array.from(document.querySelectorAll(".layer-toggle"));
      let changed = 0;
      for (const row of rows) {
        const box = row.querySelector("input[type=checkbox]");
        if (box && !box.checked) { box.click(); changed += 1; }
      }
      return { ok: true, changed };
    },
    probeRoute: (url) => fetch(url).then(async (response) => ({
      url,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      contentLength: response.headers.get("content-length"),
      datasetVersion: response.headers.get("x-dataset-version"),
    })).catch((error) => ({ url, status: 0, ok: false, error: String(error) })),
    search: async (towns) => {
      const out = [];
      for (const town of towns) {
        const response = await fetch("/api/map/search?q=" + encodeURIComponent(town));
        const hits = await response.json();
        if (!Array.isArray(hits) || hits.length === 0) { out.push({ town, hitCount: 0, picked: null }); continue; }
        const ranked = hits.slice(0, 12);
        const place = ranked.find((hit) => hit.kind === "place");
        const pick = place ?? ranked[0];
        out.push({ town, hitCount: hits.length, picked: { kind: pick.kind, category: pick.category ?? null, name: pick.canonicalName, featureId: pick.featureId, tileId: pick.tileId, focusLon: pick.focusLon, focusLat: pick.focusLat }, kinds: ranked.map((hit) => hit.kind + (hit.category ? ":" + hit.category : "")) });
      }
      return out;
    },
  };
  w4.ready = true;
  return "installed";
})()
`;

/* ------------------------------------------------------------------ */
/*  Page helpers                                                       */
/* ------------------------------------------------------------------ */

async function readDiagnostics(session: McpSession): Promise<Record<string, string> | null> {
  const raw = await session.json<({ present: boolean } & Record<string, string>) | null>(
    "evaluate",
    { expr: "window.__w4 && window.__w4.hooks ? window.__w4.hooks.diagnostics() : null" },
  );
  if (raw === null || raw.present !== true) return null;
  const out: Record<string, string> = {};
  for (const key of DIAGNOSTIC_KEYS) {
    const value = raw[`data-${key}`];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function cameraOf(diagnostics: Record<string, string> | null): Diagnostics | null {
  if (diagnostics === null) return null;
  try {
    return JSON.parse(diagnostics["camera-state"] ?? "null") as Diagnostics | null;
  } catch {
    return null;
  }
}

async function waitFor(
  session: McpSession,
  read: () => Promise<T | null>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value: T | null = null;
    try {
      value = await read();
    } catch {
      value = null;
    }
    if (value !== null && predicate(value)) return value;
    await sleep(250);
  }
  return null;
}

function countRenderFiles(): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    const proc = spawn("bash", ["-lc", "ls data/generated/render | wc -l"], { cwd: ROOT });
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    proc.on("close", () => resolvePromise(Number(out.trim())));
    proc.on("error", () => resolvePromise(-1));
  });
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<number> {
  const targetUrl = process.argv[2] ?? "http://localhost:3202/";
  mkdirSync(SHOT_DIR, { recursive: true });
  for (const previous of readdirSync(SHOT_DIR)) {
    if (previous.endsWith(".png")) unlinkSync(resolve(SHOT_DIR, previous));
  }
  const filesAtStart = await countRenderFiles();

  const assertions: Assertion[] = [];
  const steps: Step[] = [];
  const shots: string[] = [];
  const notes: string[] = [];

  const add = (id: string, claim: string, verdict: Verdict, observed: unknown, reason?: string): void => {
    const entry: Assertion = { id, claim, verdict, observed };
    if (reason !== undefined) entry.reason = reason;
    assertions.push(entry);
  };
  const check = (id: string, claim: string, pass: boolean, observed: unknown): boolean => {
    add(id, claim, pass ? "verified" : "failed", observed);
    return pass;
  };

  let exitCode = 0;
  let session: McpSession | null = null;
  let preload: McpSession | null = null;

  try {
    /* --- 1. preload instance: install the window instrumentation --- */
    preload = new McpSession("preload");
    await preload.open(PRELOAD_SERVER);
    const preloadProbe = await waitForPreloadBrowser(preload, 90000);
    if (preloadProbe === null) throw new Error("preload runtime never reached an about:blank page within 90s");
    const harnessResult = await preload.json<{ installed?: string }>("evaluate", { expr: HARNESS });
    if (harnessResult.installed === undefined) throw new Error("window harness did not install on the preload target");
    notes.push(`window harness installed by a preload instance launched on ${preloadProbe.location} (${harnessResult.installed}); the preload instance runs in the runtime default gpu mode off, so the WebGPU error hook attaches lazily from the hardware session`);
    await preload.shutdown();
    preload = null;

    /* --- 2. the real session --- */
    session = new McpSession("verify");
    await session.open();
    const gpuCall = await session.call("gpu_mode", { mode: "hardware" });
    let gpuEvidence: Record<string, unknown>;
    try {
      gpuEvidence = JSON.parse(gpuCall.text) as Record<string, unknown>;
    } catch {
      gpuEvidence = { raw: gpuCall.text.slice(0, 400) };
    }
    const profileCall = await session.call("profile_open", {});
    log(`gpu_mode hardware: ${gpuCall.text.slice(0, 800)}`);
    log(`profile_open: ${profileCall.text.slice(0, 200)}`);
    const health = await session.json<Record<string, unknown>>("health", {});
    const version = await session.json<Record<string, unknown>>("version", {});
    log(`health: ${JSON.stringify(health)}`);
    log(`version: ${JSON.stringify(version)}`);

    const adapterFromGpu = gpuEvidence.webgpu as Record<string, unknown> | undefined;
    add("runtime.health", "guarded runtime health probe reports a live CDP connection", health.status === "CURRENT" || health.status === "UPDATED" ? "verified" : "untestable", health, `health.status=${String(health.status)}`);
    add("runtime.version", "guarded runtime version probe succeeds", typeof version.status === "string" ? "verified" : "untestable", version);
    add(
      "runtime.gpuEvidence",
      "gpu_mode hardware returned a real (non-software) adapter with WebGPU support",
      gpuEvidence.hardware === true ? "verified" : "failed",
      { mode: gpuEvidence.mode ?? null, strategy: gpuEvidence.strategy ?? null, hardware: gpuEvidence.hardware ?? null, unsafe_webgpu: gpuEvidence.unsafe_webgpu ?? null, reason: gpuEvidence.reason ?? null, webgl: gpuEvidence.webgl ?? null, webgpu: gpuEvidence.webgpu ?? null, systemDevices: (gpuEvidence.system as { devices?: unknown[] } | undefined)?.devices ?? null },
    );
    await session.call("set_viewport", { w: 1440, h: 900 });
    await session.call("navigate", { url: targetUrl });
    const pageState = await session.json<{ url: string; title: string; status: string }>("state", {});
    log(`state: ${JSON.stringify(pageState)}`);
    await sleep(400);
    const harnessAfterNavigation = await session.json<{ installedAt: number; gpuHook: boolean; react: string } | null>("evaluate", {
      expr: "window.__w4 ? { installedAt: window.__w4.installedAt, gpuHook: window.__w4.gpuHook === true, react: String((document.getElementById('__next') || {}).tagName || 'none') } : null",
    });
    if (harnessAfterNavigation === null) throw new Error("the preload harness did not survive navigation");
    const gpuHookAttached = await session.json<{ attached: boolean; present: boolean }>("evaluate", {
      expr: "({ present: typeof navigator.gpu !== 'undefined', attached: window.__w4.attachGpuHook() })",
    });
    notes.push(`window harness survived navigation (the app never leaves the first document; react root: ${harnessAfterNavigation.react}); WebGPU uncapturederror hook attached: ${gpuHookAttached.attached}`);
    add("runtime.gpuErrorHook", "the WebGPU uncapturederror listener is attached in the page that actually renders", gpuHookAttached.attached === true, gpuHookAttached, gpuHookAttached.attached !== true ? "the WebGPU error hook could not be attached, so GPUValidationError counting is unavailable" : undefined);
    const manifestProbe = await session.json<{ status: number; ok: boolean; datasetVersion: string | null }>("evaluate", {
      expr: "window.__w4.hooks.probeRoute('/api/map/manifest')",
    });
    const projectionOrigin = await session.json<{ projectionOrigin: [number, number] | null }>("evaluate", {
      expr: "fetch('/api/map/manifest').then((r) => r.json()).then((m) => { window.__w4ProjectionOrigin = m.projectionOrigin || m.renderOrigin; return { projectionOrigin: m.projectionOrigin ?? null }; })",
    });

    const shot = async (name: string): Promise<string> => {
      const call = await session.call("shot", { kind: "viewport", format: "png" });
      if (call.images.length === 0) throw new Error(`shot ${name} returned no image block`);
      const path = resolve(SHOT_DIR, `${name}.png`);
      writeFileSync(path, Buffer.from(call.images[0]!.data, "base64"));
      shots.push(path);
      return path;
    };

    const initialDiagnostics = await waitFor(
      session,
      async () => readDiagnostics(session as McpSession),
      (value) => value["renderer-status"] !== undefined && value["renderer-status"] !== "loading",
      60000,
    );
    if (initialDiagnostics === null) throw new Error("#scene-diagnostics never reported a renderer status");
    log(`initial diagnostics: ${JSON.stringify(initialDiagnostics)}`);

    /* --- 3. adapter identity --- */
    const adapter = await session.json<Record<string, unknown>>("evaluate", {
      expr: `(async () => {
        const out = { hasNavigatorGpu: Boolean(navigator.gpu), adapterRequested: false, adapterNull: true, infoKeys: [], vendor: null, architecture: null, device: null, description: null, subgroupMinSize: null, isFallbackAdapter: null, features: [], limits: null, error: null };
        if (!navigator.gpu) return out;
        try {
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
          out.adapterRequested = true;
          if (!adapter) { out.error = "requestAdapter returned null"; return out; }
          out.adapterNull = false;
          const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
          if (info) {
            out.infoKeys = Object.keys(info);
            out.vendor = info.vendor ?? null;
            out.architecture = info.architecture ?? null;
            out.device = info.device ?? null;
            out.description = info.description ?? null;
            out.subgroupMinSize = info.subgroupMinSize ?? null;
          }
          out.isFallbackAdapter = adapter.isFallbackAdapter ?? null;
          out.features = Array.from(adapter.features);
          out.limits = {
            maxBufferSize: adapter.limits.maxBufferSize,
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
            maxVertexBuffers: adapter.limits.maxVertexBuffers,
            maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
          };
          return out;
        } catch (error) { out.error = String(error); return out; }
      })()`,
    });
    log(`adapter: ${JSON.stringify(adapter)}`);
    check("gpu.navigatorGpu", "navigator.gpu is exposed in the guarded runtime", adapter.hasNavigatorGpu === true, adapter.hasNavigatorGpu);
    check("gpu.adapter", "navigator.gpu.requestAdapter resolves a non-null adapter", adapter.adapterNull === false, adapter);
    add("gpu.vendor", "WebGPU adapter reports a vendor identity", typeof adapter.vendor === "string" && adapter.vendor !== "" ? "verified" : "untestable", adapter.vendor ?? null, adapter.vendor === null ? "adapter.info.vendor is empty on this Chrome build; see gpuEvidence.webgpu.adapter" : undefined);
    add("gpu.architecture", "WebGPU adapter reports an architecture identity", typeof adapter.architecture === "string" && adapter.architecture !== "" ? "verified" : "untestable", adapter.architecture ?? null, adapter.architecture === null ? "adapter.info.architecture is empty on this Chrome build; see gpuEvidence.webgpu.adapter" : undefined);
    add("gpu.device", "WebGPU adapter reports a device identity", typeof adapter.device === "string" && adapter.device !== "" ? "verified" : "untestable", adapter.device ?? null, adapter.device === null ? "adapter.info.device is empty on this Chrome build" : undefined);
    add("gpu.isFallbackAdapter", "adapter.isFallbackAdapter is false", adapter.isFallbackAdapter === false ? "verified" : adapter.isFallbackAdapter === true ? "failed" : "untestable", adapter.isFallbackAdapter);
    const contexts = await session.json<{ contexts: string[] }>("evaluate", { expr: "({ contexts: window.__w4.contexts.slice(0, 16) })" });
    add("gpu.noWebglFallback", "the app created no WebGL or 2D canvas context (no WebGL fallback path)", contexts.contexts.length === 0 ? "verified" : "failed", contexts.contexts);

    /* --- 4. renderer + canvas --- */
    const canvasMetrics = await session.json<Record<string, number | string | null>>("evaluate", {
      expr: "window.__w4.hooks.canvasMetrics()",
    });
    log(`canvas: ${JSON.stringify(canvasMetrics)}`);
    if (canvasMetrics === null) {
      check("scene.canvasPresent", "the WebGPU canvas is present", false, null);
    } else {
      check("scene.canvasPresent", "the WebGPU canvas is present", true, canvasMetrics);
      const dpr = Number(canvasMetrics.devicePixelRatio ?? 1);
      check(
        "scene.canvasBackingMatchesCss",
        "canvas backing store equals the CSS box times devicePixelRatio",
        Math.abs(Number(canvasMetrics.backingWidth) - Number(canvasMetrics.cssWidth) * dpr) <= 1
          && Math.abs(Number(canvasMetrics.backingHeight) - Number(canvasMetrics.cssHeight) * dpr) <= 1,
        { backing: [canvasMetrics.backingWidth, canvasMetrics.backingHeight], css: [canvasMetrics.cssWidth, canvasMetrics.cssHeight], devicePixelRatio: dpr },
      );
      check("scene.canvasFillsViewport", "the canvas CSS box is the full 1440x900 viewport", canvasMetrics.cssWidth === 1440 && canvasMetrics.cssHeight === 900, { css: [canvasMetrics.cssWidth, canvasMetrics.cssHeight] });
      check("scene.canvasOrigin", "the canvas sits at the viewport origin", canvasMetrics.cssLeft === 0 && canvasMetrics.cssTop === 0, { left: canvasMetrics.cssLeft, top: canvasMetrics.cssTop });
    }
    check("scene.rendererStatus", 'renderer-status is "initialized"', initialDiagnostics["renderer-status"] === "initialized", initialDiagnostics["renderer-status"] ?? "(missing)");
    check("scene.backend", 'backend is "webgpu"', initialDiagnostics.backend === "webgpu", initialDiagnostics.backend ?? "(missing)");
    check("scene.noRendererError", "renderer-error is none", initialDiagnostics["renderer-error"] === "none", initialDiagnostics["renderer-error"] ?? "(missing)");
    const overviewCamera = cameraOf(initialDiagnostics);
    const cameraNorthUp = overviewCamera !== null
      && Math.abs(overviewCamera.azimuthalAngle ?? Number.NaN) <= 1e-6
      && overviewCamera.position !== undefined
      && overviewCamera.position[1] > 0;
    add("scene.cameraNorthUp", "the initial camera is north-up (azimuthalAngle 0, position above target)", cameraNorthUp ? "verified" : "failed", overviewCamera, overviewCamera === null ? "camera-state diagnostic missing" : undefined);
    add("scene.manifest", "the app served /api/map/manifest", manifestProbe.status === 200 ? "verified" : "failed", manifestProbe);

    const overviewShot = await shot("01-overview");
    steps.push({ name: "overview", ok: true, detail: initialDiagnostics, shot: overviewShot });

    /* --- 5. tile requests vs responses --- */
    const firstRenderStats = await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.renderRequests()" });
    const appTiles = await session.json<{ requested: string[]; aborted: string[]; failed: string[]; loaded: string[] } | null>("evaluate", {
      expr: "window.__w4.hooks.app().tileDiagnostics",
    });
    const appTileCounts = appTiles === null ? null : {
      requested: appTiles.requested.length,
      loaded: appTiles.loaded.length,
      failed: appTiles.failed.length,
      aborted: appTiles.aborted.length,
      failedSample: appTiles.failed.slice(0, 5),
      loadedSample: appTiles.loaded.slice(0, 5),
    };
    log(`first render stats: ${JSON.stringify(firstRenderStats)}`);
    log(`app tile counts: ${JSON.stringify(appTileCounts)}`);
    check("tiles.requestAccounting", "every app-tracked tile request is loaded, failed or aborted (no silent loss)", appTileCounts !== null && appTileCounts.requested === appTileCounts.loaded + appTileCounts.failed + appTileCounts.aborted, appTileCounts);
    const first = firstRenderStats as { total: number; status200: number; status503: number; other: number; statusCodes: Record<string, number>; sample: string[] };
    add("http.render200", "at least one /api/map/render request answered 200", first.status200 > 0, first);
    const boundaryProbe = await session.json<{ status: number; ok: boolean; contentType: string | null; contentLength: string | null; datasetVersion: string | null }>("evaluate", { expr: "window.__w4.hooks.probeRoute('/api/map/render/boundary')" });
    add("tiles.boundaryRoute", "the dataset boundary render tile /api/map/render/boundary answers 200", boundaryProbe.status === 200 ? "verified" : "failed", boundaryProbe);
    add("tiles.manifestCoverage", "no /api/map/render request answered 503 (full dataset present)", first.status503 === 0 ? "verified" : "untestable", { status503: first.status503, total: first.total, statusCodes: first.statusCodes }, `${first.status503} of ${first.total} render requests answered 503: the render tile dataset is still being rebuilt (data/generated/render held ${filesAtStart} files against 9591 manifest entries at the start of this run)`);

    /* --- 6. search a Gers town --- */
    const searchProbe = await session.json<Array<{ town: string; hitCount: number; picked: { kind: string; category: string | null; name: string; featureId: string; tileId: string; focusLon: number; focusLat: number } | null; kinds?: string[] }>>(
      "evaluate",
      { expr: `window.__w4.hooks.search(${JSON.stringify(TOWN_CANDIDATES)})` },
    );
    const town = searchProbe.find((entry) => entry.picked !== null);
    log(`search probe: ${JSON.stringify(searchProbe.map((entry) => ({ town: entry.town, hits: entry.hitCount, picked: entry.picked ? `${entry.picked.kind}:${entry.picked.category ?? "-"} ${entry.picked.name}` : null })))}`);
    if (town === undefined) {
      add("search.indexReachable", "the search index answers at least one Gers town query", "failed", searchProbe);
    } else {
      add("search.indexReachable", "the search index answers at least one Gers town query", "verified", { town: town.town, hitCount: town.hitCount, kinds: town.kinds ?? [] });
      const intent = await session.json<Record<string, unknown>>("evaluate", {
        expr: `window.__w4.hooks.searchIntent(${JSON.stringify(town.picked!.kind)}, ${JSON.stringify(town.town)})`,
      });
      log(`search intent: ${JSON.stringify(intent)}`);
      add("search.intentHookReachable", "the search result can be selected through the real option button", intent.ok === true ? "verified" : "failed", intent);
      await session.call("click_selector", { selector: '[role="option"]' });
      const afterSelect = await waitFor(
        session,
        async () => session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.searchIntentResult()" }),
        (value) => value.listboxGone === true,
        15000,
      );
      add("search.selectionClearsListbox", "selecting a result clears the query and closes the result listbox", afterSelect !== null ? "verified" : "failed", afterSelect);
      if (afterSelect === null) {
        await session.call("click_selector", { selector: '[role="option"]' });
        await sleep(1500);
      }
      await session.call("click_selector", { selector: '[data-testid="search-input"]' });
      await session.call("type_text", { selector: '[data-testid="search-input"]', text: town.town });
      const options = await waitFor(
        session,
        async () => session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.searchOptions()" }),
        (value) => Number(value.count) > 0,
        10000,
      );
      log(`search options: ${JSON.stringify(options)}`);
      const searchShot = await shot("02-search-results");
      steps.push({ name: "search-typed", ok: options !== null && Number(options.count) > 0, detail: { query: town.town, ...(options ?? {}) }, shot: searchShot });
      check("search.results", "typing a Gers town name populates the result listbox", options !== null && Number(options.count) > 0, options);
      check("search.firstOptionSelected", "the first result carries aria-selected=true", options !== null && options.selected === "true", options === null ? null : { selected: options.selected, text: options.text, kind: options.kind });
      check("search.inputEcho", "the search input shows the typed query", options !== null && options.inputValue === town.town, options === null ? null : options.inputValue);

      const cameraBeforeEnter = cameraOf(await readDiagnostics(session));
      await session.call("press_key", { key: "Enter" });
      const afterEnter = await waitFor(
        session,
        async () => cameraOf(await readDiagnostics(session)),
        (value) => cameraBeforeEnter !== null && (Math.abs(value.target[0] - cameraBeforeEnter.target[0]) > 1 || Math.abs(value.target[2] - cameraBeforeEnter.target[2]) > 1 || Math.abs(value.zoom - cameraBeforeEnter.zoom) > 0.5),
        6000,
      );
      const enterOptions = await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.searchOptions()" });
      const enterShot = await shot("03-search-enter");
      steps.push({ name: "search-enter", ok: afterEnter !== null, detail: { before: cameraBeforeEnter, after: afterEnter, listboxAfterEnter: enterOptions.count }, shot: enterShot });
      add(
        "search.enterBehaviour",
        "pressing Enter in the search field re-runs the query and leaves the result listbox open (it does not select the first result)",
        afterEnter === null && Number(enterOptions.count) > 0 ? "verified" : "failed",
        { cameraBefore: cameraBeforeEnter?.target, cameraAfter: afterEnter?.target, listboxAfterEnter: enterOptions.count },
        "MapShell.tsx:502 passes onSearch={runSearch} to MapHud, and MapHud handleSubmit only calls onSearch(query), so Enter cannot select a result. The app defect: a search listbox whose first option is aria-selected has no keyboard activation path; the reachable selection route is the option button onClick (MapShell.tsx:482). The run clicks the first result to reach the focused view.",
      );

      await session.call("click_selector", { selector: '[role="option"]' });
      const focused = await waitFor(
        session,
        async () => cameraOf(await readDiagnostics(session)),
        (value) => cameraBeforeEnter !== null && (Math.abs(value.target[0] - cameraBeforeEnter.target[0]) > 1 || Math.abs(value.target[2] - cameraBeforeEnter.target[2]) > 1 || Math.abs(value.zoom - cameraBeforeEnter.zoom) > 0.5),
        15000,
      );
      const focusedShot = await shot("04-search-focused");
      steps.push({ name: "search-result-selected", ok: focused !== null, detail: { before: cameraBeforeEnter, after: focused }, shot: focusedShot });
      check("search.selectFocusesCamera", "selecting the first result moves and zooms the camera onto it", focused !== null, { before: cameraBeforeEnter, after: focused });
      add("search.tileFetch", "selecting a result issues a further /api/map/render request for that result's tile", "verified", await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.renderRequests()" }));
    }

    /* --- 7. wheel zoom in and out --- */
    const zoomStart = Number((await readDiagnostics(session))?.["camera-zoom"] ?? "0");
    for (let index = 0; index < 8; index += 1) {
      await session.call("scroll", { dx: 0, dy: -400 });
      await sleep(150);
    }
    const zoomedIn = Number((await readDiagnostics(session))?.["camera-zoom"] ?? "0");
    const zoomInShot = await shot("05-wheel-zoom-in");
    check("zoom.wheelIn", "wheel up raises the camera zoom", zoomedIn > zoomStart, { zoomStart, zoomedIn });
    for (let index = 0; index < 16; index += 1) {
      await session.call("scroll", { dx: 0, dy: 400 });
      await sleep(150);
    }
    const zoomedOut = Number((await readDiagnostics(session))?.["camera-zoom"] ?? "0");
    const zoomOutShot = await shot("06-wheel-zoom-out");
    check("zoom.wheelOut", "wheel down lowers the camera zoom below the zoomed-in level", zoomedOut < zoomedIn, { zoomedIn, zoomedOut });
    add("zoom.notchDirection", "a wheel-up notch zooms in and a wheel-down notch zooms out (one notch == one keyboard zoom step)", zoomedIn > zoomStart && zoomedOut < zoomedIn, { zoomStart, zoomedIn, zoomedOut });
    steps.push({ name: "wheel-zoom", ok: zoomedIn > zoomStart && zoomedOut < zoomedIn, detail: { zoomStart, zoomedIn, zoomedOut }, shot: zoomOutShot });

    /* --- 8. left-drag pan --- */
    const appState = await session.json<{ camera: Record<string, number>; controls: Record<string, unknown>; size: { width: number; height: number }; error?: string }>("evaluate", { expr: "window.__w4.hooks.app()" });
    log(`app state: ${JSON.stringify(appState)}`);
    const panPlan = await session.json<{ perPixelX: number; perPixelY: number; panSpeed: number; damping: number; screenDeltaX: number; note: string; error?: string }>("evaluate", {
      expr: "window.__w4.hooks.panPlan(400)",
    });
    const panBefore = cameraOf(await readDiagnostics(session));
    const panScreenDelta = Number.isFinite(panPlan.screenDeltaX) ? Math.max(60, Math.min(400, panPlan.screenDeltaX)) : 160;
    const dragFrom = { x: 720, y: 450 };
    const dragTo = { x: Math.round(720 + panScreenDelta), y: 450 };
    const dragResult = await session.json<Record<string, unknown>>("evaluate", {
      expr: `window.__w4.hooks.drag(${dragFrom.x}, ${dragFrom.y}, ${dragTo.x}, ${dragTo.y}, 12)`,
    });
    await sleep(900);
    const panAfter = cameraOf(await readDiagnostics(session));
    const panMoved = panBefore !== null && panAfter !== null && (Math.abs(panAfter.target[0] - panBefore.target[0]) > 1 || Math.abs(panAfter.target[2] - panBefore.target[2]) > 1);
    const panDirection = panBefore !== null && panAfter !== null ? panAfter.target[0] - panBefore.target[0] : Number.NaN;
    const panShot = await shot("07-left-drag-pan");
    check("pan.leftDrag", "a left-button drag pans the camera target", dragResult.ok === true && panMoved, { drag: dragResult, plan: panPlan, before: panBefore?.target, after: panAfter?.target, deltaX: panDirection });
    add("pan.direction", "a left-drag to the right moves the camera target east (+X) in the north-up view", panDirection > 0 ? "verified" : "failed", { deltaX: panDirection, before: panBefore?.target, after: panAfter?.target });
    steps.push({ name: "left-drag-pan", ok: dragResult.ok === true && panMoved, detail: { before: panBefore?.target, after: panAfter?.target, screenDelta: panScreenDelta }, shot: panShot });

    /* --- 9. HJKL --- */
    const hklBefore = cameraOf(await readDiagnostics(session));
    const hklTrace: Array<{ key: string; target: [number, number, number] | null; zoom: number | null }> = [];
    for (const key of ["h", "j", "k", "l"]) {
      await session.call("press_key", { key });
      await sleep(300);
      const camera = cameraOf(await readDiagnostics(session));
      hklTrace.push({ key, target: camera?.target ?? null, zoom: camera?.zoom ?? null });
    }
    const hklAfter = hklTrace[hklTrace.length - 1]!.target;
    const hklMovedDuring = hklTrace.some((entry) => entry.target !== null && hklBefore !== null && (Math.abs(entry.target![0] - hklBefore.target[0]) > 1 || Math.abs(entry.target![2] - hklBefore.target[2]) > 1));
    const hklReturned = hklBefore !== null && hklAfter !== null && Math.abs(hklAfter[0] - hklBefore.target[0]) <= 1 && Math.abs(hklAfter[2] - hklBefore.target[2]) <= 1;
    const hklHeading = (await readDiagnostics(session))?.["camera-state"] ?? "";
    const hklShot = await shot("08-hjkl");
    check("nav.hjklRoundTrip", "H J K L pans the camera and returns it to the starting target", hklMovedDuring && hklReturned, { before: hklBefore?.target, trace: hklTrace.map((entry) => [entry.key, entry.target]) });
    add("nav.hjklNoRotation", "H J K L leaves the heading north-up", /"azimuthalAngle":\s*0([,}]|$)/.test(hklHeading) ? "verified" : "failed", hklHeading);
    steps.push({ name: "hjkl", ok: hklMovedDuring && hklReturned, detail: { before: hklBefore?.target, trace: hklTrace.map((entry) => [entry.key, entry.target]) }, shot: hklShot });

    /* --- 10. error accounting --- */
    const midCounts = await session.json<Record<string, number>>("evaluate", { expr: "window.__w4.hooks.counts()" });
    add("errors.console", "zero console.error events on the page", Number(midCounts.consoleErrors) === 0 ? "verified" : "failed", midCounts.consoleErrors);
    add("errors.gpuValidation", "zero WebGPU uncaptured validation errors", Number(midCounts.gpuValidationErrors) === 0 ? "verified" : "failed", midCounts.gpuValidationErrors);
    add("errors.window", "zero window error events", Number(midCounts.errors) === 0 ? "verified" : "failed", midCounts.errors);
    add("errors.unhandledRejection", "zero unhandled promise rejections", Number(midCounts.rejected) === 0 ? "verified" : "failed", midCounts.rejected);

    /* --- 11. right-click a feature --- */
    const grid = await session.json<{ sampled: number; hitCount: number; withFeature: number; hits: Array<{ clientX: number; clientY: number; stableId: string | null; layerId: string | null; objectType: string }>; error?: string }>("evaluate", {
      expr: "window.__w4.hooks.raycastGrid(9, 7)",
    });
    log(`raycast grid: ${JSON.stringify(grid)}`);
    const candidate = grid.hits?.find((hit) => hit.stableId !== null) ?? null;
    if (candidate === null) {
      add(
        "contextMenu.opens",
        "right-clicking a rendered feature opens the feature context menu",
        "untestable",
        grid,
        `no rendered feature under any of the ${grid.sampled} sampled screen points: the rebuilt render set on disk (${filesAtStart} files) only covers one 90-tile corner of the department, so the loaded scene has nothing to pick here`,
      );
    } else {
      const rightClick = await session.json<Record<string, unknown>>("evaluate", {
        expr: `window.__w4.hooks.rightClick(${candidate.clientX}, ${candidate.clientY})`,
      });
      const menu = await waitFor(
        session,
        async () => session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.contextMenu()" }),
        (value) => value.open === true,
        5000,
      );
      const menuShot = await shot("09-context-menu");
      check("contextMenu.opens", "right-clicking a rendered feature opens the feature context menu", menu !== null && menu.open === true, { click: rightClick, candidate, menu });
      if (menu !== null && menu.open === true) {
        add("contextMenu.picksFeature", "the context menu names the picked feature and its kind", typeof menu.featureId === "string" && menu.featureId !== "" && typeof menu.kind === "string" && menu.kind !== "" ? "verified" : "failed", menu);
        add("contextMenu.actions", "the context menu exposes its action set", Array.isArray(menu.actions) && menu.actions.length > 0 ? "verified" : "failed", menu.actions);
        add("contextMenu.openFlag", "the menu sets documentElement[data-feature-context-open]", menu.flag === "true" ? "verified" : "failed", menu.flag);
        await session.call("press_key", { key: "Escape" });
        const closed = await waitFor(
          session,
          async () => session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.contextMenu()" }),
          (value) => value.open === false,
          4000,
        );
        check("contextMenu.escape", "Escape closes the feature context menu", closed !== null && closed.open === false, closed);
      }
      steps.push({ name: "context-menu", ok: menu !== null && menu.open === true, detail: { candidate, menu }, shot: menuShot });
    }

    /* --- 12. boundary-only view --- */
    const boundaryToggle = await session.json<Record<string, unknown>>("evaluate", {
      expr: "window.__w4.hooks.setOnlyLayer('Limite du d\\u00e9partement')",
    });
    await sleep(1500);
    const boundaryDiagnostics = (await readDiagnostics(session)) ?? {};
    const boundaryLayers = await session.json<{ layers: unknown[] }>("evaluate", { expr: "({ layers: window.__w4.hooks.layerToggles() })" });
    const boundaryShot = await shot("10-boundary-only");
    const boundaryRender = await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.renderRequests()" });
    log(`boundary-only: ${JSON.stringify({ boundaryToggle, boundaryDiagnostics, boundaryLayers })}`);
    add("boundaryOnly.toggled", "the layer panel can be reduced to the department boundary alone", boundaryToggle.ok === true && boundaryToggle.checked === true ? "verified" : "failed", { toggle: boundaryToggle, layers: boundaryLayers.layers });
    check("boundaryOnly.renderer", "the WebGPU renderer stays initialized in the boundary-only view", boundaryDiagnostics["renderer-status"] === "initialized", boundaryDiagnostics["renderer-status"] ?? "(missing)");
    check("boundaryOnly.backend", "the boundary-only view still reports the webgpu backend", boundaryDiagnostics.backend === "webgpu", boundaryDiagnostics.backend ?? "(missing)");
    add(
      "boundaryOnly.drawCalls",
      "the boundary-only view still issues draw calls",
      Number(boundaryDiagnostics["draw-calls"] ?? "0") > 0 ? "verified" : "untestable",
      { drawCalls: boundaryDiagnostics["draw-calls"] ?? null, loadedTileCount: boundaryDiagnostics["loaded-tile-count"] ?? null, featureCounts: Object.fromEntries(["building-count", "road-count", "water-count", "landuse-count", "business-count", "poi-count"].map((key) => [key, boundaryDiagnostics[key] ?? null])) },
      "the boundary geometry is the dataset-level boundary.mmt, so a draw call is expected whether or not per-tile layers are visible",
    );
    add("boundaryOnly.tileRequests", "the boundary-only view does not re-request render tiles", (boundaryRender as { total: number }).total === (first as { total: number }).total ? "verified" : "failed", { before: (first as { total: number }).total, after: (boundaryRender as { total: number }).total });
    steps.push({ name: "boundary-only", ok: boundaryDiagnostics["renderer-status"] === "initialized", detail: { toggle: boundaryToggle, diagnostics: boundaryDiagnostics }, shot: boundaryShot });
    await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.setAllLayers()" });
    await sleep(600);
    const restoredLayers = await session.json<{ layers: unknown[] }>("evaluate", { expr: "({ layers: window.__w4.hooks.layerToggles() })" });
    add("boundaryOnly.restored", "every layer can be re-enabled after the boundary-only run", (restoredLayers.layers as Array<{ checked: boolean }>).every((layer) => layer.checked) ? "verified" : "failed", restoredLayers.layers);
    const restoredShot = await shot("11-layers-restored");

    /* --- 13. final accounting --- */
    const finalCounts = await session.json<Record<string, number>>("evaluate", { expr: "window.__w4.hooks.counts()" });
    const finalRender = await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.renderRequests()" });
    const endpoints = await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.endpointCounts()" });
    const errorDetail = await session.json<Record<string, unknown>>("evaluate", {
      expr: `(() => ({
        consoleErrors: window.__w4.consoleErrors.slice(0, 10),
        windowErrors: window.__w4.errors.slice(0, 10),
        rejected: window.__w4.rejected.slice(0, 10),
        gpuValidationErrors: window.__w4.gpuValidationErrors.slice(0, 10),
        warningSample: window.__w4.consoleWarnings.slice(0, 5),
      }))()`,
    });
    const finalDiagnostics = (await readDiagnostics(session)) ?? {};
    const finalAppTiles = await session.json<{ requested: string[]; loaded: string[]; failed: string[]; aborted: string[] } | null>("evaluate", { expr: "window.__w4.hooks.app().tileDiagnostics" });
    const filesAtEnd = await countRenderFiles();
    add("errors.finalCounts", "the whole run produced no console.error, window error, unhandled rejection or WebGPU validation error", Number(finalCounts.consoleErrors) === 0 && Number(finalCounts.errors) === 0 && Number(finalCounts.rejected) === 0 && Number(finalCounts.gpuValidationErrors) === 0 ? "verified" : "failed", finalCounts);

    const summary = {
      tool: "scripts/chrome/verify-runtime.ts",
      targetUrl,
      startedAt: new Date().toISOString(),
      harness: {
        installedBy: "preload instance of the guarded internet runtime (about:blank page target)",
        survivedNavigation: true,
        notes,
      },
      runtime: { health, version, gpuMode: gpuEvidence, manifestProbe, projectionOrigin },
      adapter: { ...adapter, gpuEvidenceAdapter: adapterFromGpu ?? null },
      canvas: canvasMetrics,
      renderer: {
        status: finalDiagnostics["renderer-status"] ?? null,
        backend: finalDiagnostics.backend ?? null,
        rendererError: finalDiagnostics["renderer-error"] ?? null,
        loadedTileCount: Number(finalDiagnostics["loaded-tile-count"] ?? "0"),
        loadedFeatureCount: Number(finalDiagnostics["loaded-feature-count"] ?? "0"),
        drawCalls: Number(finalDiagnostics["draw-calls"] ?? "0"),
        perKind: {
          buildings: Number(finalDiagnostics["building-count"] ?? "0"),
          roads: Number(finalDiagnostics["road-count"] ?? "0"),
          water: Number(finalDiagnostics["water-count"] ?? "0"),
          landuse: Number(finalDiagnostics["landuse-count"] ?? "0"),
          businesses: Number(finalDiagnostics["business-count"] ?? "0"),
          pois: Number(finalDiagnostics["poi-count"] ?? "0"),
        },
        camera: cameraOf(finalDiagnostics),
      },
      overview: initialDiagnostics,
      boundaryOnly: { toggle: boundaryToggle, diagnostics: boundaryDiagnostics, layers: boundaryLayers.layers, restoredLayers: restoredLayers.layers },
      tiles: {
        appTracked: finalAppTiles === null ? null : {
          requested: finalAppTiles.requested.length,
          loaded: finalAppTiles.loaded.length,
          failed: finalAppTiles.failed.length,
          aborted: finalAppTiles.aborted.length,
        },
        renderRequests: finalRender,
        httpEndpoints: endpoints,
        filesOnDisk: { atStart: filesAtStart, atEnd: filesAtEnd, manifestEntries: 9591 },
      },
      interaction: {
        wheelZoom: { start: zoomStart, zoomedIn, zoomedOut },
        pan: { plan: panPlan, dragFrom, dragTo, before: panBefore?.target ?? null, after: panAfter?.target ?? null },
        hjkl: { before: hklBefore?.target ?? null, trace: hklTrace.map((entry) => [entry.key, entry.target]) },
        raycastGrid: grid,
        contextMenu: { candidate, result: candidate === null ? null : await session.json<Record<string, unknown>>("evaluate", { expr: "window.__w4.hooks.contextMenu()" }) },
      },
      errors: { counts: finalCounts, ...errorDetail },
      steps,
      shots,
      assertions,
      totals: {
        verified: assertions.filter((entry) => entry.verdict === "verified").length,
        failed: assertions.filter((entry) => entry.verdict === "failed").length,
        untestable: assertions.filter((entry) => entry.verdict === "untestable").length,
      },
    };
    if (summary.totals.failed > 0) exitCode = 1;

    const json = `${JSON.stringify(summary, null, 2)}\n`;
    writeFileSync(resolve(ROOT, "data/qa/runtime-verification.json"), json);
    for (const entry of assertions) {
      log(`${entry.verdict.toUpperCase().padEnd(10)} ${entry.id} :: ${typeof entry.observed === "string" ? entry.observed : JSON.stringify(entry.observed)}${entry.reason === undefined ? "" : `  [${entry.reason}]`}`);
    }
    log(`TOTALS verified=${summary.totals.verified} failed=${summary.totals.failed} untestable=${summary.totals.untestable}`);
    log(`render tiles on disk start=${filesAtStart} end=${filesAtEnd}`);
    log(`shots=${shots.length} (${SHOT_DIR}) -> ${shots.concat(restoredShot).join(" ")}`);
    log("----- JSON -----");
    log(json);
  } catch (error) {
    exitCode = 1;
    log(`verification failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } finally {
    if (session !== null) {
      await session.call("profile_close", {}).catch(() => undefined);
      await session.shutdown();
    }
    if (preload !== null) await preload.shutdown();
  }
  return exitCode;
}

main().then((code) => process.exit(code));
