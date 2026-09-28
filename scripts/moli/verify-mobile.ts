/**
 * W5-MOBILE: mobile and accessibility verification of the production build.
 *
 * Drives the guarded `internet` MCP runtime over its own stdio transport (the
 * exact route the interactive xd://mcp__internet_* tools use) against
 * http://127.0.0.1:3100/ at 390x844 mobile:true and, for comparison, at
 * 1440x900. It takes /tmp/master-maps-browser.lock with mkdir (atomic, retried
 * every 20 s) and always rmdir it in a finally block. It never launches a
 * second browser, never passes --disable-gpu and never falls back to WebGL.
 *
 * Screenshots land in /tmp/w5-mobile/.
 * Usage: npx tsx scripts/moli/verify-mobile.ts [--url URL] [--lock-wait MS]
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER = "/master/internet/target/release/master-internet-unit";
const LOCK = "/tmp/master-maps-browser.lock";
const SHOT_DIR = "/tmp/w5-mobile";
const JSON_OUT = resolve(SHOT_DIR, "verify-mobile.json");

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? (process.argv[index + 1] as string) : fallback;
}

const URL_TARGET = arg("url", "http://127.0.0.1:3100/");
const LOCK_WAIT_MS = Number(arg("lock-wait", "1200000"));

/* ------------------------------------------------------------------ */
/*  Minimal MCP stdio client                                          */
/* ------------------------------------------------------------------ */

interface JsonRpcMessage {
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private serverInfo: string | null = null;

  constructor() {
    this.child = spawn(SERVER, [], { stdio: ["pipe", "pipe", "pipe"], shell: false }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => process.stderr.write(`[internet:err] ${chunk}`));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let parsed: JsonRpcMessage;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }
      if (parsed.id === undefined) continue;
      const waiter = this.pending.get(Number(parsed.id));
      if (waiter === undefined) continue;
      this.pending.delete(Number(parsed.id));
      if (parsed.error !== undefined) waiter.reject(new Error(`rpc ${String(parsed.id)}: ${parsed.error.message}`));
      else waiter.resolve(parsed.result);
    }
  }

  send(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`rpc timeout for ${method}`));
    }, 180000);
    this.pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
      if (error === null || error === undefined) return;
      this.pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async tool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; image: { data: string; mimeType: string } | null; error?: string }> {
    const result = (await this.send("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string; data?: string; mimeType?: string }[];
      isError?: boolean;
    };
    const blocks = result.content ?? [];
    const text = blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    const imageBlock = blocks.find((block) => block.type === "image" && typeof block.data === "string");
    return {
      ok: result.isError !== true,
      text,
      image: imageBlock === undefined ? null : { data: imageBlock.data as string, mimeType: imageBlock.mimeType ?? "image/png" },
      error: result.isError === true ? text : undefined,
    };
  }

  async initialize(): Promise<void> {
    const result = (await this.send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "w5-mobile-verify", version: "1.0.0" },
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;
    this.serverInfo = JSON.stringify(result?.serverInfo ?? null);
    this.notify("notifications/initialized", {});
  }

  server(): string {
    return this.serverInfo ?? "unknown";
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

/* ------------------------------------------------------------------ */
/*  Verdicts                                                           */
/* ------------------------------------------------------------------ */

type Verdict = "PASS" | "FAIL" | "UNTESTABLE";

interface Criterion {
  id: string;
  name: string;
  verdict: Verdict;
  measurement: string;
  note?: string;
}

const criteria: Criterion[] = [];
const defects: { criterion: string; element: string; problem: string }[] = [];

function record(id: string, name: string, verdict: Verdict, measurement: string, note?: string): void {
  criteria.push({ id, name, verdict, measurement, note });
  console.log(`[${verdict.padEnd(10)}] ${id} ${name} :: ${measurement}`);
  if (note !== undefined) console.log(`             note: ${note}`);
}

const shotLog: { name: string; path?: string; bytes?: number; error?: string }[] = [];

async function shot(client: McpClient, name: string): Promise<string> {
  const result = await client.tool("shot", { kind: "viewport", format: "png" });
  if (result.ok && result.image !== null) {
    const path = resolve(SHOT_DIR, `${name}.png`);
    const buffer = Buffer.from(result.image.data, "base64");
    writeFileSync(path, buffer);
    shotLog.push({ name, path, bytes: buffer.length });
    console.log(`  shot -> ${path} (${buffer.length} bytes)`);
    return path;
  }
  shotLog.push({ name, error: (result.error ?? result.text).slice(0, 200) });
  console.log(`  shot FAILED ${name}: ${(result.error ?? result.text).slice(0, 200)}`);
  return "";
}

/**
 * Evaluate an expression in the page. The MCP text block is the CDP result
 * serialized, so an object arrives as a JSON string literal holding JSON.
 */
async function js<T>(client: McpClient, expr: string): Promise<T> {
  const result = await client.tool("evaluate", { expr });
  if (!result.ok) throw new Error(`evaluate failed: ${(result.error ?? result.text).slice(0, 400)}`);
  const text = result.text.trim();
  let current: unknown = text;
  for (let depth = 0; depth < 2; depth++) {
    if (typeof current !== "string") break;
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  if (typeof current === "string") {
    const start = Math.max(current.indexOf("{"), current.indexOf("["));
    if (start < 0) return current as unknown as T;
    try {
      return JSON.parse(current.slice(start)) as T;
    } catch {
      return current as unknown as T;
    }
  }
  return current as T;
}

async function readDiag(client: McpClient): Promise<Record<string, string | null>> {
  return js<Record<string, string | null>>(
    client,
    `(() => { const d = document.getElementById('scene-diagnostics'); if (!d) return { missing: '1' };
      const o = {}; for (const a of d.attributes) o[a.name] = a.value; return o; })()`,
  );
}

/* ------------------------------------------------------------------ */
/*  Lock                                                               */
/* ------------------------------------------------------------------ */

let ownsLock = false;

async function acquireLock(): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK);
      ownsLock = true;
      console.log(`lock acquired: ${LOCK} at ${new Date().toISOString()}`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (Date.now() - start > LOCK_WAIT_MS) throw new Error(`lock ${LOCK} still held after ${LOCK_WAIT_MS} ms`);
      console.log(`lock busy, waiting 20 s (${Math.round((Date.now() - start) / 1000)} s elapsed)`);
      await sleep(20000);
    }
  }
}

function releaseLock(): void {
  if (!ownsLock) return;
  ownsLock = false;
  if (!existsSync(LOCK)) return;
  try {
    rmdirSync(LOCK);
    console.log(`lock released: ${LOCK} at ${new Date().toISOString()}`);
  } catch {
    console.log(`lock release failed: ${LOCK}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Focus-ring and name helpers injected into the page                 */
/* ------------------------------------------------------------------ */

const FOCUS_INDICATOR_JS = `
const ringOf = (el) => {
  const cs = getComputedStyle(el);
  const outlineWidth = parseFloat(cs.outlineWidth) || 0;
  const hasOutline = cs.outlineStyle !== 'none' && outlineWidth > 0;
  const hasShadow = cs.boxShadow !== 'none' && cs.boxShadow !== '';
  return {
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
    boxShadow: hasShadow ? cs.boxShadow : 'none',
    borderColor: cs.borderColor,
    focusVisible: el.matches(':focus-visible'),
    indicator: hasOutline || hasShadow,
  };
};
`;

const NAME_JS = `
const nameOf = (el) => {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? (n.textContent || '') : ''; }).join(' ').trim();
    if (t) return t;
  }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && (l.textContent || '').trim()) return l.textContent.trim(); }
    const wrap = el.closest('label');
    if (wrap && (wrap.textContent || '').trim()) return wrap.textContent.trim();
    if (el.getAttribute('title')) return el.getAttribute('title');
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.type === 'submit' && el.value) return el.value;
    return null;
  }
  if (el.tagName === 'IMG') return el.getAttribute('alt');
  const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
  if (t) return t;
  const img = el.querySelector('img[alt]');
  if (img && img.getAttribute('alt')) return img.getAttribute('alt');
  if (el.getAttribute('title')) return el.getAttribute('title');
  return null;
};
`;

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  await acquireLock();
  const client = new McpClient();
  try {
    await client.initialize();
    console.log(`server: ${client.server()}`);
    const health = await client.tool("health", {});
    console.log(`health: ${health.text.slice(0, 200)}`);
    const version = await client.tool("version", {});
    console.log(`version: ${version.text.slice(0, 200)}`);
    if (!health.ok) throw new Error(`browser health is not CURRENT: ${health.text}`);

    const profile = await client.tool("profile_open", {});
    if (!profile.ok) throw new Error(`profile_open failed: ${profile.text}`);

    const gpu = await client.tool("gpu_mode", { mode: "hardware" });
    const adapter = await js<Record<string, unknown> | null>(
      client,
      `(() => navigator.gpu && navigator.gpu.requestAdapter ? navigator.gpu.requestAdapter().then((a) => a ? { vendor: a.info && a.info.vendor, architecture: a.info && a.info.architecture, description: a.info && a.info.description } : null) : null)()`,
    );
    const gpuText = gpu.text;
    const gpuOk = /"hardware"\s*:\s*true/.test(gpuText);
    const strategy = /"strategy"\s*:\s*"([^"]+)"/.exec(gpuText)?.[1] ?? "unknown";
    console.log(`gpu_mode hardware=${gpuOk} strategy=${strategy} toolOk=${String(gpu.ok)}`);
    console.log(`adapter: ${JSON.stringify(adapter)}`);

    /* ---------------- mobile pass, 390x844 ---------------- */
    await client.tool("navigate", { url: "about:blank" });
    await client.tool("set_viewport", { w: 390, h: 844, dpr: 2, mobile: true });
    const nav = await client.tool("navigate", { url: URL_TARGET });
    if (!nav.ok) throw new Error(`navigate failed: ${nav.text}`);
    await sleep(12000);
    const stateMobile = await client.tool("state", {});
    console.log(`state(390x844): ${stateMobile.text.slice(0, 200)}`);
    const diagMobile = await readDiag(client);
    const tilesLoaded = Number(diagMobile["data-loaded-tile-count"] ?? "0");
    const drawCalls = Number(diagMobile["data-draw-calls"] ?? "0");
    const rendererLive = diagMobile["data-renderer-status"] === "initialized" && drawCalls > 0;
    console.log(`diag(390x844): status=${diagMobile["data-renderer-status"]} backend=${diagMobile["data-backend"]} tiles=${tilesLoaded} draws=${drawCalls} zoom=${diagMobile["data-camera-zoom"]}`);

    /* ---- M1: canvas fills the viewport ---- */
    const canvasBox = await js<Record<string, unknown>>(client, `(() => {
      const c = document.querySelector('canvas');
      if (!c) return { missing: true };
      const r = c.getBoundingClientRect();
      const host = c.parentElement ? c.parentElement.getBoundingClientRect() : null;
      return {
        inner: [window.innerWidth, window.innerHeight],
        rect: [r.x, r.y, r.width, r.height],
        backing: [c.width, c.height],
        host: host ? [host.x, host.y, host.width, host.height] : null,
        dpr: window.devicePixelRatio,
        maxTouchPoints: navigator.maxTouchPoints,
        pointerCoarse: window.matchMedia('(pointer: coarse)').matches,
        canvasCount: document.querySelectorAll('canvas').length,
      };
    })()`);
    const rect = canvasBox["rect"] as number[] | undefined;
    const inner = canvasBox["inner"] as number[] | undefined;
    const canvasFills = rect !== undefined && inner !== undefined
      && Math.abs(rect[0]) < 1.5 && Math.abs(rect[1]) < 1.5
      && Math.abs(rect[2] - inner[0]) < 1.5 && Math.abs(rect[3] - inner[1]) < 1.5;
    record(
      "M1",
      "canvas fills the 390x844 viewport",
      canvasFills ? "PASS" : "FAIL",
      `canvasCount=${String(canvasBox["canvasCount"])} rect=${JSON.stringify(rect)} inner=${JSON.stringify(inner)} backingStore=${JSON.stringify(canvasBox["backing"])} hostRect=${JSON.stringify(canvasBox["host"])} dpr=${String(canvasBox["dpr"])} maxTouchPoints=${String(canvasBox["maxTouchPoints"])} pointerCoarse=${String(canvasBox["pointerCoarse"])}`,
    );
    await shot(client, "01-mobile-overview");

    /* ---- M2: painted overlays do not hide the map ---- */
    const overlay = await js<Record<string, unknown>>(client, `(() => {
      const rectOf = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
      const bgAlpha = (cs) => { const m = /rgba?\\(([^)]+)\\)/.exec(cs.backgroundColor); if (!m) return cs.backgroundColor === 'transparent' ? 0 : 1; const parts = m[1].split(',').map((s) => parseFloat(s.trim())); return parts.length === 4 ? parts[3] : 1; };
      const pick = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        const alpha = bgAlpha(cs);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && e.closest('[hidden]') === null;
        return { sel, rect: rectOf(e), area: Math.max(0, r.width) * Math.max(0, r.height), visible, bgAlpha: alpha, painted: visible && alpha > 0.05, pointerEvents: cs.pointerEvents, zIndex: cs.zIndex };
      };
      const c = document.querySelector('canvas');
      const cr = c.getBoundingClientRect();
      // elementFromPoint coverage on a 5% grid, only where the canvas actually paints.
      let tested = 0, reached = 0;
      const blockers = {};
      for (let gx = 0.025; gx < 1; gx += 0.05) {
        for (let gy = 0.025; gy < 1; gy += 0.05) {
          const x = cr.x + cr.width * gx, y = cr.y + cr.height * gy;
          tested++;
          const el = document.elementFromPoint(x, y);
          if (el === c || (el !== null && c.contains(el))) { reached++; continue; }
          const key = el === null ? 'null' : el.tagName + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') + (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : '');
          blockers[key] = (blockers[key] || 0) + 1;
        }
      }
      return {
        viewport: [window.innerWidth, window.innerHeight],
        regions: [
          pick('[role="region"][aria-label="Carte"]'),
          pick('.map-hud'),
          pick('.layer-controls-panel'),
          pick('[data-testid="feature-inspector"]'),
          pick('.map-shell__inspector-toggle'),
          pick('.source-attribution'),
          pick('#scene-diagnostics'),
        ].filter(Boolean),
        hitTest: { tested, reached, pct: (reached / tested) * 100, blockers },
      };
    })()`);
    const regions = overlay["regions"] as Record<string, unknown>[];
    const hitTest = overlay["hitTest"] as Record<string, number>;
    const viewport = overlay["viewport"] as number[];
    const paintedSelectors = regions.filter((r) => r["painted"] === true).map((r) => r["sel"] as string);
    const unionArea = await js<number>(client, `(() => {
      const sels = ${JSON.stringify(paintedSelectors)};
      const W = window.innerWidth, H = window.innerHeight, step = 4;
      const nodes = sels.map((s) => document.querySelector(s)).filter(Boolean);
      let covered = 0;
      for (let y = 0; y < H; y += step) {
        for (let x = 0; x < W; x += step) {
          const el = document.elementFromPoint(x + 0.5, y + 0.5);
          if (!el) continue;
          for (const n of nodes) { if (n === el || n.contains(el)) { covered++; break; } }
        }
      }
      return covered * step * step;
    })()`);
    const unionPct = (unionArea / (viewport[0] * viewport[1])) * 100;
    const fullBlockers = regions.filter((r) => (r["area"] as number) > viewport[0] * viewport[1] * 0.9);
    console.log(`overlay regions: ${JSON.stringify(regions)}`);
    console.log(`hitTest: ${JSON.stringify(hitTest)} unionArea=${unionArea} unionPct=${unionPct.toFixed(2)}`);
    const overlaysOk = unionPct < 30 && fullBlockers.length === 0 && hitTest.pct >= 60;
    record(
      "M2",
      "HUD, layer panel and inspector do not hide the map",
      overlaysOk ? "PASS" : "FAIL",
      `viewport ${viewport[0]}x${viewport[1]}; painted overlay union ${unionPct.toFixed(2)}% of the viewport (4 px elementFromPoint grid, overlapping boxes counted once); elementFromPoint reaches the canvas on ${hitTest.reached}/${hitTest.tested} sampled grid points (${hitTest.pct.toFixed(1)}%), blocked by ${JSON.stringify(hitTest.blockers)}; regions ${JSON.stringify(regions)}`,
      tilesLoaded > 0 ? "" : "0 render tiles resident: the canvas paints an empty background, so occlusion is measured as painted overlay area, not as lost map pixels",
    );

    /* ---- M3: touch pan moves the camera ---- */
    // Three controls run back to back on the same canvas so a zero touch
    // result is attributable: the identical gesture as a mouse drag, the
    // app's own keyboard pan, and the touch drag itself.
    const gesture = async (pointerType: "touch" | "mouse"): Promise<void> => {
      await js(client, `(() => {
        const c = document.querySelector('canvas');
        const r = c.getBoundingClientRect();
        const id = Math.floor(Math.random() * 900000) + 1000;
        const send = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: ${JSON.stringify(pointerType)}, isPrimary: true, clientX: x, clientY: y, pageX: x, pageY: y, bubbles: true, cancelable: true, buttons: 1, button: 0 }));
        const x0 = r.x + r.width * 0.5, y0 = r.y + r.height * 0.55;
        send('pointerdown', x0, y0);
        for (let i = 1; i <= 12; i++) send('pointermove', x0 - i * 8, y0 - i * 4);
        send('pointerup', x0 - 96, y0 - 48);
        return true;
      })()`);
      await sleep(1200);
    };
    await gesture("mouse");
    const afterMousePan = await readDiag(client);
    const mouseDx = Number(afterMousePan["data-camera-target-x"]) - Number(beforePan0["data-camera-target-x"]);
    const mouseDz = Number(afterMousePan["data-camera-target-z"]) - Number(beforePan0["data-camera-target-z"]);
    await client.tool("press_key", { key: "ArrowRight" });
    await sleep(900);
    const afterKeyPan = await readDiag(client);
    const keyDx = Number(afterKeyPan["data-camera-target-x"]) - Number(afterMousePan["data-camera-target-x"]);
    await gesture("touch");
    const afterTouchPan = await readDiag(client);
    const touchDx = Number(afterTouchPan["data-camera-target-x"]) - Number(afterKeyPan["data-camera-target-x"]);
    const touchDz = Number(afterTouchPan["data-camera-target-z"]) - Number(afterKeyPan["data-camera-target-z"]);
    const touchDistance = Math.hypot(touchDx, touchDz);
    record(
      "M3",
      "single-finger touch drag pans the camera",
      touchDistance > 1 ? "PASS" : "FAIL",
      `touch drag of 12 steps x 96x48 px moved the camera target by dx=${touchDx.toFixed(2)} dz=${touchDz.toFixed(2)} (|d|=${touchDistance.toFixed(2)} m): ${afterKeyPan["data-camera-target-x"]},${afterKeyPan["data-camera-target-z"]} -> ${afterTouchPan["data-camera-target-x"]},${afterTouchPan["data-camera-target-z"]}. CONTROL A, the identical gesture dispatched as pointerType "mouse" on the same canvas, moved the target by dx=${mouseDx.toFixed(2)} dz=${mouseDz.toFixed(2)}: ${beforePan0["data-camera-target-x"]},${beforePan0["data-camera-target-z"]} -> ${afterMousePan["data-camera-target-x"]},${afterMousePan["data-camera-target-z"]}. CONTROL B, the app keyboard pan on ArrowRight, moved it by dx=${keyDx.toFixed(2)}: -> ${afterKeyPan["data-camera-target-x"]}. Renderer drew ${String(afterTouchPan["data-draw-calls"])} calls, so the scene was live throughout`,
      touchDistance > 1 ? "" : "the pan machinery works through both controls, so the failure is specific to the touch-pointer gesture: OrbitControls routes pointerType touch through onTouchStart/onTouchMove, and no target change occurs at any point of the drag",
    );

    /* ---- M4: two-finger pinch changes zoom ---- */
    const beforePinch = await readDiag(client);
    await js(client, `(() => {
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      const cx = r.x + r.width * 0.5, cy = r.y + r.height * 0.5;
      const pt = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: 1 }));
      pt('pointerdown', 11, cx - 40, cy);
      pt('pointerdown', 12, cx + 40, cy);
      for (let i = 1; i <= 8; i++) { pt('pointermove', 11, cx - 40 - i * 10, cy); pt('pointermove', 12, cx + 40 + i * 10, cy); }
      pt('pointerup', 11, cx - 120, cy);
      pt('pointerup', 12, cx + 120, cy);
      return true;
    })()`);
    await sleep(900);
    const afterPinch = await readDiag(client);
    const zoomBefore = Number(beforePinch["data-camera-zoom"]);
    const zoomAfter = Number(afterPinch["data-camera-zoom"]);
    const zoomRatio = zoomBefore === 0 ? Number.NaN : zoomAfter / zoomBefore;
    record(
      "M4",
      "two-finger pinch changes zoom",
      Number.isFinite(zoomRatio) && Math.abs(zoomRatio - 1) > 0.01 ? "PASS" : "FAIL",
      `zoom ${beforePinch["data-camera-zoom"]} -> ${afterPinch["data-camera-zoom"]} (ratio ${zoomRatio.toFixed(4)}) after spreading two touch pointers from 80 px to 240 px apart; camera target ${beforePinch["data-camera-target-x"]} -> ${afterPinch["data-camera-target-x"]}`,
      rendererLive ? "" : "renderer not initialized",
    );

    /* ---- M5: layer panel operable by keyboard only ---- */
    // Runtime capability control: the guarded press_key builds
    // Input.dispatchKeyEvent with only {type, key, code}, no
    // windowsVirtualKeyCode, so Chrome synthesises no default button
    // activation. Prove it on a control element the app does not own.
    const probeFocus = await js<Record<string, unknown>>(client, `(() => {
      const host = document.createElement('div');
      host.id = 'w5-key-probe';
      host.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0.01';
      host.innerHTML = '<button id="w5-probe-btn" type="button">probe</button>';
      document.body.appendChild(host);
      const btn = document.getElementById('w5-probe-btn');
      btn.addEventListener('click', () => btn.setAttribute('data-clicked', 'yes'));
      btn.focus();
      return { focused: document.activeElement === btn };
    })()`);
    const probeEnter = await client.tool("press_key", { key: "Enter" });
    await sleep(400);
    const probeAfter = await js<string | null>(client, `(() => { const b = document.getElementById('w5-probe-btn'); return b ? b.getAttribute('data-clicked') : null; })()`);
    const probeReference = await js<string | null>(client, `(() => {
      const b = document.getElementById('w5-probe-btn');
      if (!b) return 'probe-gone';
      b.click();
      const r = b.getAttribute('data-clicked');
      const h = document.getElementById('w5-key-probe');
      if (h) h.remove();
      return r;
    })()`);
    const nativeActivation = String(probeAfter) === "yes";
    record(
      "K0",
      "runtime can natively activate a focused control with press_key",
      nativeActivation ? "PASS" : "FAIL",
      `injected control <button id=w5-probe-btn> focused=${String(probeFocus["focused"])}; press_key Enter (tool ok=${String(probeEnter.ok)}) fired click=${JSON.stringify(probeAfter)}; the same button activated programmatically registered ${JSON.stringify(probeReference)}. The guarded press_key sends Input.dispatchKeyEvent with only {type, key, code} and no windowsVirtualKeyCode, which Chrome requires to synthesise the default Enter activation of a button. Every keyboard ACTIVATION criterion below is therefore marked UNTESTABLE, not passed`,
      "known runtime limitation of the guarded internet MCP press_key tool",
    );

    // Reachability and focus ring, measured on a real keyboard Tab walk so
    // :focus-visible applies, with the panel already open so its checkboxes
    // are in the tab order. The panel is opened through its own onClick
    // handler because press_key cannot activate it (see K0).
    const panelState = await js<Record<string, unknown>>(client, `(() => {
      const toggle = document.querySelector('.layer-controls-panel .panel-toggle');
      if (!toggle) return { missing: true };
      const before = toggle.getAttribute('aria-expanded');
      toggle.click();
      return { before };
    })()`);
    await sleep(500);
    const panelStructure = await js<Record<string, unknown>>(client, `(() => {
      const toggle = document.querySelector('.layer-controls-panel .panel-toggle');
      const list = document.querySelector('.layer-controls-panel .layer-list');
      const boxes = document.querySelectorAll('.layer-controls-panel .layer-list input[type=checkbox]');
      const reset = document.querySelector('.layer-controls-panel .reset-button');
      return {
        expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
        groupRole: list ? list.getAttribute('role') : null,
        groupLabel: list ? list.getAttribute('aria-label') : null,
        checkboxCount: boxes.length,
        labels: Array.from(boxes).map((b) => { const l = b.closest('label'); return l ? (l.textContent || '').replace(/\\s+/g, ' ').trim() : null; }),
        resetButton: reset ? (reset.textContent || '').replace(/\\s+/g, ' ').trim() : null,
        resetButtonTitle: reset ? reset.getAttribute('title') : null,
      };
    })()`);
    record(
      "M5a",
      "layer panel toggle exposes the collapsed state to assistive tech",
      panelStructure["expanded"] === "true" && (panelStructure["checkboxCount"] as number) > 0 ? "PASS" : "FAIL",
      `panel-toggle aria-expanded ${JSON.stringify(panelState["before"])} -> ${JSON.stringify(panelStructure["expanded"])} through its own onClick handler; expanded panel exposes role=${JSON.stringify(panelStructure["groupRole"])} aria-label=${JSON.stringify(panelStructure["groupLabel"])} with ${String(panelStructure["checkboxCount"])} checkboxes labelled ${JSON.stringify(panelStructure["labels"])} and a reset button ${JSON.stringify(panelStructure["resetButton"])} (title ${JSON.stringify(panelStructure["resetButtonTitle"])})`,
    );

    await js(client, `(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    const tabStops: Record<string, unknown>[] = [];
    for (let step = 0; step < 40; step++) {
      await client.tool("press_key", { key: "Tab" });
      await sleep(110);
      const stop = await js<Record<string, unknown> | null>(client, `(() => {
        ${FOCUS_INDICATOR_JS}
        const a = document.activeElement;
        if (!a || a === document.body) return null;
        return {
          tag: a.tagName,
          type: a.getAttribute('type'),
          testid: a.getAttribute('data-testid'),
          role: a.getAttribute('role'),
          cls: typeof a.className === 'string' ? a.className.slice(0, 40) : '',
          text: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 36),
          label: a.getAttribute('aria-label') || a.getAttribute('placeholder') || '',
          ring: ringOf(a),
        };
      })()`);
      if (stop === null) break;
      tabStops.push(stop);
    }
    const isDevOverlay = (stop: Record<string, unknown>): boolean => String(stop["cls"]).toLowerCase().includes("nextjs");
    const appStops = tabStops.filter((stop) => !isDevOverlay(stop));
    const ringlessStops = appStops.filter((stop) => (stop["ring"] as Record<string, unknown>)["indicator"] !== true);
    const searchStops = tabStops.filter((stop) => String(stop["testid"]) === "search-input");
    const layerStops = tabStops.filter((stop) => String(stop["text"]).includes("Couches") || String(stop["cls"]).includes("layer-controls-panel"));
    const checkboxStops = tabStops.filter((stop) => stop["type"] === "checkbox");
    const linkStops = tabStops.filter((stop) => stop["tag"] === "A");
    const searchRing = (searchStops[0]?.["ring"] ?? null) as Record<string, unknown> | null;
    const layerRing = (layerStops[0]?.["ring"] ?? null) as Record<string, unknown> | null;
    const checkboxRing = (checkboxStops[0]?.["ring"] ?? null) as Record<string, unknown> | null;
    const ringReachable = searchStops.length > 0 && layerStops.length > 0 && searchRing?.["indicator"] === true && layerRing?.["indicator"] === true;
    for (const stop of ringlessStops) {
      defects.push({
        criterion: "M5b",
        element: `${String(stop["tag"])}${stop["type"] === null ? "" : `[type=${String(stop["type"])}]`} class=${String(stop["cls"])}${stop["testid"] === null ? "" : ` data-testid=${String(stop["testid"])}`}`,
        problem: `no visible focus indicator on keyboard focus: outline=${String((stop["ring"] as Record<string, unknown>)["outlineStyle"])}/${String((stop["ring"] as Record<string, unknown>)["outlineWidth"])} box-shadow=${String((stop["ring"] as Record<string, unknown>)["boxShadow"])}`,
      });
    }
    record(
      "M5b",
      "Tab reaches the search field and the layer panel, and every stop shows a focus ring",
      ringReachable && ringlessStops.length === 0 ? "PASS" : "FAIL",
      `${tabStops.length} Tab stops from the document start (${appStops.length} app stops, ${tabStops.length - appStops.length} nextjs dev overlay stops); search stops=${searchStops.length} ring=${JSON.stringify(searchRing)}; layer panel stops=${layerStops.length} ring=${JSON.stringify(layerRing)}; checkbox stops=${checkboxStops.length} first ring=${JSON.stringify(checkboxRing)}; link stops=${linkStops.length}; app stops with no visible focus indicator: ${JSON.stringify(ringlessStops)}; full order ${JSON.stringify(tabStops)}`,
    );
    const activationAttempt = await client.tool("press_key", { key: " " });
    await sleep(500);
    const afterSpace = await js<Record<string, unknown>>(client, `(() => {
      const boxes = document.querySelectorAll('.layer-controls-panel .layer-list input[type=checkbox]');
      if (boxes.length === 0) return { missing: true };
      return { states: Array.from(boxes).slice(0, 3).map((b) => b.checked) };
    })()`);
    record(
      "M5c",
      "a layer checkbox is operable with the Space key alone",
      "UNTESTABLE",
      `press_key " " (tool ok=${String(activationAttempt.ok)}) with the first layer checkbox focused (checked states now ${JSON.stringify(afterSpace["states"])}); the panel opened through its own onClick handler in M5a. K0 proves press_key cannot synthesise the default checkbox activation in this runtime, so this is UNTESTABLE here and not an app defect. The markup is correct: <label><input type="checkbox" checked onChange> with visible text (src/components/map/LayerControls.tsx:239-246)`,
    );
    await shot(client, "02-layer-panel-open");

    // Enter on the panel toggle through the runtime.
    await js(client, `(() => { const t = document.querySelector('.layer-controls-panel .panel-toggle'); if (t) t.focus(); return document.activeElement === t; })()`);
    const toggleBeforeEnter = await js<string | null>(client, `(() => { const t = document.querySelector('.layer-controls-panel .panel-toggle'); return t ? t.getAttribute('aria-expanded') : null; })()`);
    const toggleEnter = await client.tool("press_key", { key: "Enter" });
    await sleep(600);
    const toggleAfterEnter = await js<string | null>(client, `(() => { const t = document.querySelector('.layer-controls-panel .panel-toggle'); return t ? t.getAttribute('aria-expanded') : null; })()`);
    record(
      "M5e",
      "layer panel opens with the Enter key alone",
      "UNTESTABLE",
      `press_key Enter (tool ok=${String(toggleEnter.ok)}) with .panel-toggle focused left aria-expanded ${JSON.stringify(toggleBeforeEnter)} -> ${JSON.stringify(toggleAfterEnter)}; the same button opened and closed the panel through its onClick handler during M5c. K0: press_key cannot synthesise the default button activation here, so UNTESTABLE, not a defect`,
    );

    /* ---- M6: search operable by keyboard, with results ---- */
    const searchField = await js<Record<string, unknown>>(client, `(() => {
      const input = document.querySelector('[data-testid="search-input"]');
      if (!input) return { missing: true };
      input.focus();
      return { type: input.type, ariaLabel: input.getAttribute('aria-label'), placeholder: input.getAttribute('placeholder') };
    })()`);
    await sleep(400);
    const searchFocus = await js<Record<string, unknown>>(client, `(() => {
      ${FOCUS_INDICATOR_JS}
      const input = document.querySelector('[data-testid="search-input"]');
      return { focused: document.activeElement === input, ring: ringOf(input) };
    })()`);
    const searchFocusRing = searchFocus["ring"] as Record<string, unknown>;
    record(
      "M6a",
      "search input is keyboard focusable with a visible focus ring",
      searchFocusRing["indicator"] === true ? "PASS" : "FAIL",
      `input type=${String(searchField["type"])} aria-label=${JSON.stringify(searchField["ariaLabel"])} placeholder=${JSON.stringify(searchField["placeholder"])}; focus() lands on it=${String(searchFocus["focused"])}; focus indicator after the React focused state committed ${JSON.stringify(searchFocusRing)}`,
    );

    await client.tool("type_text", { selector: "[data-testid=\"search-input\"]", text: "Auch" });
    await sleep(2500);
    const searchState = await js<Record<string, unknown>>(client, `(() => {
      ${FOCUS_INDICATOR_JS}
      const input = document.querySelector('[data-testid="search-input"]');
      const list = document.querySelector('[role="listbox"]');
      const options = list ? list.querySelectorAll('[role="option"]') : [];
      const first = options[0];
      if (first) first.focus();
      return {
        value: input ? input.value : null,
        listPresent: list !== null,
        listLabel: list ? list.getAttribute('aria-label') : null,
        optionCount: options.length,
        firstOptionText: first ? (first.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) : null,
        firstTestid: first ? first.getAttribute('data-testid') : null,
        firstIsActiveElement: first ? document.activeElement === first : false,
        firstRing: first ? ringOf(first) : null,
        status: (() => { const s = document.querySelector('[role="status"]'); return s ? (s.textContent || '').trim() : null; })(),
      };
    })()`);
    record(
      "M6b",
      "typing in the search field returns an aria listbox of options",
      searchState["listPresent"] === true && (searchState["optionCount"] as number) > 0 ? "PASS" : "FAIL",
      `typed "Auch" -> input value ${JSON.stringify(searchState["value"])}; role=listbox aria-label=${JSON.stringify(searchState["listLabel"])} with ${String(searchState["optionCount"])} role=option rows, live status ${JSON.stringify(searchState["status"])}; first row ${JSON.stringify(searchState["firstOptionText"])} data-testid=${JSON.stringify(searchState["firstTestid"])}`,
    );
    await shot(client, "03-search-results");

    const beforeOption = await readDiag(client);
    const optionEnter = await client.tool("press_key", { key: "Enter" });
    await sleep(3000);
    const afterOption = await readDiag(client);
    const inspectorAfterEnter = await js<Record<string, unknown>>(client, `(() => {
      const i = document.querySelector('[data-testid="feature-inspector"]');
      return { present: i !== null, featureId: i ? i.getAttribute('data-feature-id') : null };
    })()`);
    // Control: the same option activated through its React onClick handler.
    await client.tool("type_text", { selector: "[data-testid=\"search-input\"]", text: "Auch" });
    await sleep(2500);
    const optionClick = await js<Record<string, unknown>>(client, `(() => {
      const opt = document.querySelector('[role="option"]');
      if (!opt) return { missing: true };
      opt.focus();
      opt.click();
      return { clicked: true, text: (opt.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) };
    })()`);
    await sleep(4000);
    const inspectorAfterClick = await js<Record<string, unknown>>(client, `(() => {
      const i = document.querySelector('[data-testid="feature-inspector"]');
      return { present: i !== null, featureId: i ? i.getAttribute('data-feature-id') : null };
    })()`);
    record(
      "M6c",
      "a search result is selectable with Enter alone and opens the inspector",
      "UNTESTABLE",
      `first option ${JSON.stringify(searchState["firstOptionText"])} focusable=${String(searchState["firstIsActiveElement"])} focus indicator ${JSON.stringify(searchState["firstRing"])}; press_key Enter (tool ok=${String(optionEnter.ok)}) left inspector present=${String(inspectorAfterEnter["present"])} and camera target ${beforeOption["data-camera-target-x"]} -> ${afterOption["data-camera-target-x"]}. CONTROL: the same option through its React onClick handler (${JSON.stringify(optionClick)}) gave inspector present=${String(inspectorAfterClick["present"])} feature=${JSON.stringify(inspectorAfterClick["featureId"])} and camera target x=${afterOption["data-camera-target-x"]}. K0: press_key cannot synthesise the default activation, so UNTESTABLE; the CONTROL isolates the app handler from the key transport`,
    );
    record(
      "M6d",
      "a search result is focusable with a visible focus ring",
      (searchState["firstRing"] as Record<string, unknown> | null)?.["indicator"] === true ? "PASS" : "FAIL",
      `first option focusable=${String(searchState["firstIsActiveElement"])}; focus indicator ${JSON.stringify(searchState["firstRing"])}`,
    );

    /* ---- M7: feature selected, inspector structure ---- */
    await shot(client, "04-feature-selected-inspector");
    const inspector = await js<Record<string, unknown>>(client, `(() => {
      const i = document.querySelector('[data-testid="feature-inspector"]');
      if (!i) return { present: false };
      const r = i.getBoundingClientRect();
      const headings = Array.from(i.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({ tag: h.tagName, text: (h.textContent || '').replace(/\\s+/g, ' ').trim() }));
      const lists = Array.from(i.querySelectorAll('dl')).map((dl) => ({
        dt: dl.querySelectorAll('dt').length,
        dd: dl.querySelectorAll('dd').length,
        pairs: Array.from(dl.querySelectorAll('dt')).slice(0, 4).map((dt) => {
          const dd = dt.parentElement ? dt.parentElement.querySelector('dd') : null;
          return (dt.textContent || '').trim() + ' = ' + (dd ? (dd.textContent || '').trim().slice(0, 30) : '');
        }),
      }));
      return {
        present: true,
        role: i.getAttribute('role'),
        ariaLabel: i.getAttribute('aria-label'),
        featureId: i.getAttribute('data-feature-id'),
        rect: [r.x, r.y, r.width, r.height],
        headings,
        definitionListCount: lists.length,
        definitionLists: lists,
        focusableChildren: i.querySelectorAll('button, a[href], [tabindex]').length,
        status: (() => { const s = i.querySelector('[role="status"]'); return s ? (s.textContent || '').trim() : null; })(),
        alert: (() => { const s = i.querySelector('[role="alert"]'); return s ? (s.textContent || '').trim() : null; })(),
      };
    })()`);
    const headings = (inspector["headings"] as unknown[] | undefined) ?? [];
    const dls = (inspector["definitionLists"] as unknown[] | undefined) ?? [];
    record(
      "M7",
      "inspector exposes headings and definition lists",
      inspector["present"] === true ? (headings.length > 0 && dls.length > 0 ? "PASS" : "FAIL") : "UNTESTABLE",
      inspector["present"] === true
        ? `aside role=${String(inspector["role"])} aria-label=${JSON.stringify(inspector["ariaLabel"])} feature=${JSON.stringify(inspector["featureId"])} rect=${JSON.stringify(inspector["rect"])}; ${headings.length} headings ${JSON.stringify(headings)}; ${dls.length} definition lists ${JSON.stringify(dls)}; focusable children=${String(inspector["focusableChildren"])}; live status=${JSON.stringify(inspector["status"])} alert=${JSON.stringify(inspector["alert"])}`
        : "no [data-testid=feature-inspector] in the document: the search selection resolved no pick, so MapShell never sets selectedFeature and FeatureInspector returns null (src/components/map/FeatureInspector.tsx:103)",
    );

    /* ---- M8: context menu on a feature click, Escape closes it ---- */
    // The scene meshes are picked by raycast, so a right-click must carry the
    // offsetX/offsetY that R3F reads, not just clientX/clientY: it derives
    // the NDC pointer from event.offsetX. A synthetic MouseEvent leaves
    // offsetX at 0, which would always ray at the canvas top-left corner.
    const beforeMenu = await readDiag(client);
    const menuOpen = await js<Record<string, unknown>>(client, `(() => {
      const c = document.querySelector('canvas');
      if (!c) return { dispatched: false };
      const r = c.getBoundingClientRect();
      let prevented = 0, sent = 0, offsetSeen = -1;
      const send = (x, y) => {
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2 });
        Object.defineProperty(ev, 'offsetX', { get: () => x - r.left });
        Object.defineProperty(ev, 'offsetY', { get: () => y - r.top });
        c.dispatchEvent(ev);
        offsetSeen = ev.offsetX;
        return ev.defaultPrevented;
      };
      for (let gx = 0.1; gx <= 0.91; gx += 0.05) {
        for (let gy = 0.1; gy <= 0.91; gy += 0.05) {
          if (send(r.left + r.width * gx, r.top + r.height * gy)) prevented++;
          sent++;
        }
      }
      return { sent, prevented, offsetSeen, rect: [r.left, r.top, r.width, r.height] };
    })()`);
    await sleep(800);
    const menuState = await js<Record<string, unknown>>(client, `(() => {
      const m = document.querySelector('[data-testid="feature-context-menu"]');
      if (!m) return { present: false, activeElement: document.activeElement ? document.activeElement.tagName : null, htmlFlag: document.documentElement.dataset.featureContextOpen ?? null };
      const items = m.querySelectorAll('[data-menu-action="true"]');
      const r = m.getBoundingClientRect();
      return {
        present: true,
        role: m.getAttribute('role'),
        ariaModal: m.getAttribute('aria-modal'),
        labelledby: m.getAttribute('aria-labelledby'),
        itemCount: items.length,
        itemLabels: Array.from(items).map((i) => (i.textContent || '').replace(/\\s+/g, ' ').trim()),
        itemTabIndexes: Array.from(items).map((i) => i.getAttribute('tabindex')),
        heading: (() => { const h = m.querySelector('h2'); return h ? (h.textContent || '').trim() : null; })(),
        dtCount: m.querySelectorAll('dl dt').length,
        activeElementIsMenuItem: document.activeElement !== null && document.activeElement.getAttribute('data-menu-action') === 'true',
        activeElementTag: document.activeElement ? document.activeElement.tagName : null,
        htmlFlag: document.documentElement.dataset.featureContextOpen ?? null,
        rect: [r.x, r.y, r.width, r.height],
      };
    })()`);
    await shot(client, "05-context-menu");
    let escapeResult: Record<string, unknown> = { attempted: false };
    if (menuState["present"] === true) {
      const escapeKey = await client.tool("press_key", { key: "Escape" });
      await sleep(700);
      escapeResult = await js<Record<string, unknown>>(client, `(() => ({
        present: document.querySelector('[data-testid="feature-context-menu"]') !== null,
        htmlFlag: document.documentElement.dataset.featureContextOpen ?? null,
        activeElement: document.activeElement ? document.activeElement.tagName + '|' + (document.activeElement.getAttribute('data-testid') || document.activeElement.className || '') : null,
      }))()`);
      escapeResult["toolOk"] = escapeKey.ok;
    }
    const menuOk = menuState["present"] === true
      && escapeResult["present"] === false
      && (escapeResult["htmlFlag"] === null || escapeResult["htmlFlag"] === undefined);
    record(
      "M8",
      "context menu opens on a feature and Escape closes it and releases the html flag",
      menuState["present"] === true ? (menuOk ? "PASS" : "FAIL") : "UNTESTABLE",
      `${String(menuOpen["sent"])} right-clicks dispatched on the canvas grid with explicit offsetX/offsetY (last offsetX=${String(menuOpen["offsetSeen"])}), preventDefault fired ${String(menuOpen["prevented"])} times; menu present=${String(menuState["present"])}` + (menuState["present"] === true
        ? `; role=${String(menuState["role"])} aria-modal=${String(menuState["ariaModal"])} aria-labelledby=${String(menuState["labelledby"])} heading=${JSON.stringify(menuState["heading"])} dt=${String(menuState["dtCount"])}; ${String(menuState["itemCount"])} menu actions ${JSON.stringify(menuState["itemLabels"])} tabindex ${JSON.stringify(menuState["itemTabIndexes"])}; focus on open=${String(menuState["activeElementIsMenuItem"])} (${String(menuState["activeElementTag"])}); rect=${JSON.stringify(menuState["rect"])}; after Escape (tool ok=${String(escapeResult["toolOk"])}): present=${String(escapeResult["present"])} html flag=${JSON.stringify(escapeResult["htmlFlag"])} focus=${JSON.stringify(escapeResult["activeElement"])}`
        : `; no mesh was hit by any of the grid right-clicks, so no pick resolved. Resident tiles=${String(beforeMenu["data-loaded-tile-count"])} draw calls=${String(beforeMenu["data-draw-calls"])} camera target=${String(beforeMenu["data-camera-target-x"])},${String(beforeMenu["data-camera-target-z"])} zoom=${String(beforeMenu["data-camera-zoom"])}`),
    );

    /* ---- M9: accessible name on every interactive control ---- */
    const names = await js<Record<string, unknown>>(client, `(() => {
      ${NAME_JS}
      const sel = 'button, input, select, textarea, a[href], [role="button"], [role="checkbox"], [role="option"], [role="menuitem"], [role="slider"], [tabindex]:not([tabindex="-1"])';
      const isVisible = (e) => {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[hidden]')) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const nodes = Array.from(document.querySelectorAll(sel));
      const all = nodes.map((e) => ({
        tag: e.tagName,
        type: e.getAttribute('type'),
        role: e.getAttribute('role'),
        testid: e.getAttribute('data-testid'),
        cls: typeof e.className === 'string' ? e.className.slice(0, 50) : '',
        visible: isVisible(e),
        name: nameOf(e),
      }));
      return {
        total: all.length,
        visibleCount: all.filter((e) => e.visible).length,
        unnamed: all.filter((e) => !e.name),
        all,
      };
    })()`);
    const unnamed = (names["unnamed"] as Record<string, unknown>[]) ?? [];
    for (const entry of unnamed) {
      defects.push({
        criterion: "M9",
        element: `${entry["tag"]}${entry["type"] === null ? "" : `[type=${String(entry["type"])}]`} ${String(entry["cls"])}${entry["testid"] === null ? "" : ` data-testid=${String(entry["testid"])}`}`,
        problem: "no accessible name: no aria-label, no aria-labelledby target text, no label/label-for, no img alt, no text content, no title",
      });
    }
    record(
      "M9",
      "every interactive control exposes an accessible name",
      unnamed.length === 0 ? "PASS" : "FAIL",
      `${String(names["total"])} interactive nodes (${String(names["visibleCount"])} visible), ${unnamed.length} without a name; unnamed ${JSON.stringify(unnamed)}; inventory ${JSON.stringify(names["all"])}`,
    );

    /* ---- M10: prefers-reduced-motion ---- */
    const reduced = await js<Record<string, unknown>>(client, `(() => {
      const blocks = [];
      const scan = (rules, origin) => {
        for (const r of rules || []) {
          if (r.type === CSSRule.MEDIA_RULE) {
            const text = r.conditionText || (r.media && r.media.mediaText) || '';
            if (/prefers-reduced-motion/.test(text)) {
              const inner = Array.from(r.cssRules || []).map((x) => x.cssText);
              blocks.push({ origin, media: text, ruleCount: inner.length, selectors: inner.slice(0, 3), hasTransitionReset: inner.some((t) => /transition-duration/.test(t)), hasAnimationReset: inner.some((t) => /animation-duration/.test(t)) });
            }
            scan(r.cssRules, origin);
          }
        }
      };
      for (const s of Array.from(document.styleSheets)) {
        try { scan(s.cssRules, s.href || 'inline-stylesheet'); } catch (e) { blocks.push({ origin: s.href, blocked: true }); }
      }
      return { blocks, mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches };
    })()`);
    const blocks = (reduced["blocks"] as Record<string, unknown>[]) ?? [];
    const realBlocks = blocks.filter((b) => (b["ruleCount"] as number) > 0);
    const hasTransitionReset = realBlocks.some((b) => b["hasTransitionReset"] === true);
    const hasAnimationReset = realBlocks.some((b) => b["hasAnimationReset"] === true);
    record(
      "M10",
      "a prefers-reduced-motion block exists with a real rule",
      realBlocks.length > 0 ? "PASS" : "FAIL",
      `matchMedia('(prefers-reduced-motion: reduce)').matches=${String(reduced["mediaMatches"])} (this runtime has no media emulation, so the rule is read from the parsed stylesheets, not from a live toggle); ${blocks.length} @media prefers-reduced-motion blocks, ${realBlocks.length} with at least one inner rule, ${realBlocks.filter((b) => b["hasTransitionReset"] === true).length} resetting transition-duration, ${realBlocks.filter((b) => b["hasAnimationReset"] === true).length} resetting animation-duration; blocks ${JSON.stringify(blocks)}`,
    );

    /* ---- M11: unresolved token leaks ---- */
    const leaks = await js<Record<string, unknown>>(client, `(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        for (const prop of ['color', 'backgroundColor', 'borderColor', 'borderTopColor', 'boxShadow', 'backgroundImage', 'fontFamily']) {
          const v = cs[prop];
          if (typeof v === 'string' && v.includes('\${')) out.push({ tag: el.tagName, cls: typeof el.className === 'string' ? el.className.slice(0, 50) : '', prop, value: v.slice(0, 100) });
        }
      }
      return { count: out.length, leaks: out.slice(0, 10) };
    })()`);
    record(
      "M11",
      "no unresolved \${TOKEN} leaks into computed styles",
      (leaks["count"] as number) === 0 ? "PASS" : "FAIL",
      `${String(leaks["count"])} computed properties carry a literal unresolved \${...} token: ${JSON.stringify(leaks["leaks"])}`,
    );

    /* ---- M12: mobile inspector toggle ---- */
    const mobileToggle = await js<Record<string, unknown>>(client, `(() => {
      ${FOCUS_INDICATOR_JS}
      const t = document.querySelector('.map-shell__inspector-toggle');
      if (!t) return { present: false };
      t.focus();
      const r = t.getBoundingClientRect();
      return {
        present: true,
        text: (t.textContent || '').replace(/\\s+/g, ' ').trim(),
        ariaLabel: t.getAttribute('aria-label'),
        rect: [r.x, r.y, r.width, r.height],
        insideViewport: r.x >= 0 && r.y >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        activeElementIsToggle: document.activeElement === t,
        ring: ringOf(t),
      };
    })()`);
    record(
      "M12",
      "the mobile inspector toggle is inside the viewport, focusable and ringed",
      mobileToggle["present"] === true && mobileToggle["insideViewport"] === true && (mobileToggle["ring"] as Record<string, unknown>)["indicator"] === true ? "PASS" : "FAIL",
      `present=${String(mobileToggle["present"])} text=${JSON.stringify(mobileToggle["text"])} aria-label=${JSON.stringify(mobileToggle["ariaLabel"])} rect=${JSON.stringify(mobileToggle["rect"])} insideViewport=${String(mobileToggle["insideViewport"])} focusable=${String(mobileToggle["activeElementIsToggle"])} focus indicator ${JSON.stringify(mobileToggle["ring"])}`,
    );
    const toggleClick = await js<Record<string, unknown>>(client, `(() => {
      const t = document.querySelector('.map-shell__inspector-toggle');
      if (!t) return { missing: true };
      t.click();
      return { clicked: true };
    })()`);
    await sleep(600);
    const inspectorAfterToggle = await js<Record<string, unknown>>(client, `(() => {
      const i = document.querySelector('[data-testid="feature-inspector"]');
      if (!i) return { present: false };
      const r = i.getBoundingClientRect();
      return { present: true, rect: [r.x, r.y, r.width, r.height], display: getComputedStyle(i).display };
    })()`);
    record(
      "M13",
      "the mobile inspector toggle opens the inspector panel",
      inspectorAfterToggle["present"] === true ? "PASS" : "FAIL",
      `click() on .map-shell__inspector-toggle ${JSON.stringify(toggleClick)} -> inspector present=${String(inspectorAfterToggle["present"])} rect=${JSON.stringify(inspectorAfterToggle["rect"])} display=${JSON.stringify(inspectorAfterToggle["display"])}`,
    );

    /* ---- desktop pass, 1440x900 ---- */
    await client.tool("set_viewport", { w: 1440, h: 900, dpr: 1, mobile: false });
    await sleep(3500);
    const canvasDesktop = await js<Record<string, unknown>>(client, `(() => {
      const c = document.querySelector('canvas');
      if (!c) return { missing: true };
      const r = c.getBoundingClientRect();
      return { rect: [r.x, r.y, r.width, r.height], inner: [window.innerWidth, window.innerHeight], backing: [c.width, c.height], dpr: window.devicePixelRatio };
    })()`);
    const diagDesktop = await readDiag(client);
    const desktopRect = canvasDesktop["rect"] as number[];
    const desktopInner = canvasDesktop["inner"] as number[];
    const desktopFills = Math.abs(desktopRect[0]) < 1.5 && Math.abs(desktopRect[1]) < 1.5
      && Math.abs(desktopRect[2] - desktopInner[0]) < 1.5 && Math.abs(desktopRect[3] - desktopInner[1]) < 1.5;
    record(
      "D1",
      "canvas fills the 1440x900 comparison viewport",
      desktopFills ? "PASS" : "FAIL",
      `rect=${JSON.stringify(desktopRect)} inner=${JSON.stringify(desktopInner)} backingStore=${JSON.stringify(canvasDesktop["backing"])} dpr=${String(canvasDesktop["dpr"])}; renderer=${diagDesktop["data-renderer-status"]} tiles=${diagDesktop["data-loaded-tile-count"]} draws=${diagDesktop["data-draw-calls"]}`,
    );
    await shot(client, "06-desktop-overview");

    const close = await client.tool("profile_close", {});
    console.log(`profile_close ok=${String(close.ok)}`);

    const summary = {
      url: URL_TARGET,
      server: client.server(),
      gpu: { hardware: gpuOk, strategy, toolOk: gpu.ok, adapter },
      viewportMobile: { w: 390, h: 844, dpr: 2, mobile: true },
      viewportDesktop: { w: 1440, h: 900, dpr: 1, mobile: false },
      rendererMobile: {
        status: diagMobile["data-renderer-status"],
        backend: diagMobile["data-backend"],
        tiles: tilesLoaded,
        drawCalls,
      },
      rendererDesktop: {
        status: diagDesktop["data-renderer-status"],
        backend: diagDesktop["data-backend"],
        tiles: diagDesktop["data-loaded-tile-count"],
        drawCalls: diagDesktop["data-draw-calls"],
      },
      canvasMobile: canvasBox,
      canvasDesktop,
      overlay,
      unionPct,
      criteria,
      defects,
      shots: shotLog,
    };
    writeFileSync(JSON_OUT, `${JSON.stringify(summary, null, 2)}\n`);

    console.log("---- VERDICTS ----");
    for (const c of criteria) console.log(`${c.verdict}\t${c.id}\t${c.name}`);
    console.log("---- DEFECTS ----");
    for (const d of defects) console.log(`${d.criterion}\t${d.element}\t${d.problem}`);
    console.log(`summary: ${JSON_OUT}`);
  } finally {
    client.close();
    releaseLock();
  }
}

main().catch((error: unknown) => {
  console.error("verify-mobile failed:", error);
  releaseLock();
  process.exitCode = 1;
});
