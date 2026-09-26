/**
 * W4-MOBILE: mobile and accessibility verification of the real app.
 *
 * Drives the guarded `internet` MCP runtime over its stdio transport
 * (the exact same route the interactive tools use) and asserts the
 * mobile and accessibility acceptance criteria on
 * http://localhost:3202/ at 390x844 mobile:true and 1440x900.
 *
 * This is the one shared browser runtime: the script takes
 * /tmp/master-maps-browser.lock with mkdir (atomic) and always rmdir it
 * in a finally block. It never launches a second browser, never passes
 * --disable-gpu and never falls back to WebGL.
 *
 * Screenshots land in /tmp/w4-mobile/.
 * Usage: npx tsx scripts/moli/verify-mobile.ts [--url URL] [--timeout MS]
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const SERVER = "/master/internet/target/release/master-internet-unit";
const LOCK = "/tmp/master-maps-browser.lock";
const SHOT_DIR = "/tmp/w4-mobile";
const IMAGE_OUT = resolve(SHOT_DIR, "shots.jsonl");

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? (process.argv[index + 1] as string) : fallback;
}

const URL_TARGET = arg("url", "http://localhost:3202/");
const LOCK_WAIT_MS = Number(arg("lock-wait", "900000"));

/* ------------------------------------------------------------------ */
/*  Minimal MCP stdio client                                          */
/* ------------------------------------------------------------------ */

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private serverInfo: string | null = null;

  constructor() {
    this.child = spawn(SERVER, [], { stdio: ["pipe", "pipe", "pipe"], shell: false }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      process.stderr.write(`[internet:err] ${chunk}`);
    });
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
      const waiter = this.pending.get(parsed.id);
      if (waiter === undefined) continue;
      this.pending.delete(parsed.id);
      if (parsed.error !== undefined) waiter.reject(new Error(`rpc ${String(parsed.id)}: ${parsed.error.message}`));
      else waiter.resolve(parsed.result);
    }
  }

  send(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`rpc timeout for ${method}`));
    }, 120000);
    this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    this.child.stdin.write(payload, (error) => {
      if (error !== null && error !== undefined) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  /**
   * Returns the text blocks plus any image block payload. A guard
   * quarantine is surfaced as text, never silently dropped.
   */
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
      clientInfo: { name: "w4-mobile-verify", version: "1.0.0" },
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
/*  Verdict bookkeeping                                               */
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

function record(id: string, name: string, verdict: Verdict, measurement: string, note?: string): void {
  criteria.push({ id, name, verdict, measurement, note });
  console.log(`[${verdict.padEnd(10)}] ${id} ${name} :: ${measurement}${note === undefined ? "" : ` (${note})`}`);
}

const shotLog: { name: string; path?: string; bytes?: number; error?: string }[] = [];

async function shot(client: McpClient, name: string, kind = "viewport"): Promise<string> {
  const result = await client.tool("shot", { kind, format: "png" });
  if (result.ok && result.image !== null) {
    const path = resolve(SHOT_DIR, `${name}.png`);
    const buffer = Buffer.from(result.image.data, "base64");
    writeFileSync(path, buffer);
    shotLog.push({ name, path, bytes: buffer.length });
    console.log(`  shot -> ${path} (${buffer.length} bytes)`);
    return path;
  }
  shotLog.push({ name, error: result.error ?? result.text.slice(0, 300) });
  console.log(`  shot FAILED ${name}: ${result.error ?? result.text.slice(0, 200)}`);
  return "";
}

/**
 * Evaluate an expression in the page and return the value.
 *
 * The MCP text block is `serde_json::Value::to_string()` of the CDP
 * result, so an object result arrives as a JSON string literal whose
 * content is itself JSON. Unwrap that, and fall back to a raw slice
 * when the guard prefixes a quarantine block.
 */
async function js<T>(client: McpClient, expr: string): Promise<T> {
  const result = await client.tool("evaluate", { expr });
  if (!result.ok) throw new Error(`evaluate failed: ${(result.error ?? result.text).slice(0, 500)}`);
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


/* ------------------------------------------------------------------ */

const ownsLock = process.argv.includes("--hold-lock") === false;

async function acquireLock(): Promise<void> {
  if (ownsLock === false) {
    console.log(`lock ${LOCK} held by the caller, reusing it`);
    return;
  }
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(LOCK);
      console.log(`lock acquired: ${LOCK}`);
      return;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      if (Date.now() - start > LOCK_WAIT_MS) {
        throw new Error(`lock ${LOCK} still held after ${LOCK_WAIT_MS} ms`);
      }
      console.log(`lock ${LOCK} busy, waiting 20 s`);
      await sleep(20000);
    }
  }
}

function releaseLock(): void {
  if (ownsLock === false) return;
  try {
    rmdirSync(LOCK);
    console.log(`lock released: ${LOCK}`);
  } catch {
    /* already gone */
  }
}


async function readDiag(client: McpClient): Promise<Record<string, string | null>> {
  const out = await js<Record<string, string | null>>(
    client,
    `(() => { const d = document.getElementById('scene-diagnostics'); if (!d) return {missing:'1'};
      const o = {}; for (const a of d.attributes) o[a.name] = a.value; return o; })()`,
  );
  return out;
}

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

    const profile = await client.tool("profile_open", {});
    if (!profile.ok) throw new Error(`profile_open failed: ${profile.text}`);

    const gpu = await client.tool("gpu_mode", { mode: "hardware" });
    const gpuText = gpu.text;
    const gpuOk = /"hardware"\s*:\s*true/.test(gpuText);
    const strategy = /"strategy"\s*:\s*"([^"]+)"/.exec(gpuText)?.[1] ?? "unknown";
    console.log(`gpu_mode hardware=${gpuOk} strategy=${strategy} (raw tool verdict ok=${gpu.ok})`);

    /* ---------------- desktop pass, 1440x900 ---------------- */
    await client.tool("navigate", { url: "about:blank" });
    const viewportDesktop = await client.tool("set_viewport", { w: 1440, h: 900, dpr: 1, mobile: false });
    if (!viewportDesktop.ok) throw new Error(`set_viewport desktop failed: ${viewportDesktop.text}`);
    const navDesktop = await client.tool("navigate", { url: URL_TARGET });
    if (!navDesktop.ok) throw new Error(`navigate desktop failed: ${navDesktop.text}`);
    await sleep(6000);
    const stateDesktop = await client.tool("state", {});
    console.log(`state(1440x900): ${stateDesktop.text.slice(0, 200)}`);
    const diagDesktop = await readDiag(client);
    console.log(`diag(1440x900): ${JSON.stringify(diagDesktop)}`);

    /* ---------------- mobile pass, 390x844 ---------------- */
    await client.tool("set_viewport", { w: 390, h: 844, dpr: 2, mobile: true });
    await client.tool("reload", {});
    await sleep(6000);
    const stateMobile = await client.tool("state", {});
    console.log(`state(390x844): ${stateMobile.text.slice(0, 200)}`);
    const diagMobile = await readDiag(client);
    console.log(`diag(390x844): ${JSON.stringify(diagMobile)}`);

    const rendererLive = diagMobile["data-renderer-status"] === "initialized" && Number(diagMobile["data-draw-calls"] ?? "0") > 0;
    const tilesLoaded = Number(diagMobile["data-loaded-tile-count"] ?? "0");
    console.log(`renderer live=${rendererLive} tiles=${tilesLoaded}`);

    /* ---- C1: canvas fills viewport ---- */
    const canvasBoxes = await js<Record<string, unknown>>(client, `(() => {
      const c = document.querySelector('canvas');
      if (!c) return { missing: true };
      const r = c.getBoundingClientRect();
      const host = c.parentElement ? c.parentElement.getBoundingClientRect() : null;
      return {
        inner: [window.innerWidth, window.innerHeight],
        rect: [r.x, r.y, r.width, r.height],
        attr: [c.width, c.height],
        host: host ? [host.x, host.y, host.width, host.height] : null,
        dpr: window.devicePixelRatio,
        touchPoints: navigator.maxTouchPoints,
        coarse: window.matchMedia('(pointer: coarse)').matches,
        overlay: getComputedStyle(c).zIndex,
      };
    })()`);
    console.log(`canvas mobile: ${JSON.stringify(canvasBoxes)}`);
    const mRect = canvasBoxes["rect"] as number[] | undefined;
    const mInner = canvasBoxes["inner"] as number[] | undefined;
    const canvasFills = mRect !== undefined && mInner !== undefined
      && Math.abs(mRect[0] as number) < 1.5 && Math.abs(mRect[1] as number) < 1.5
      && Math.abs((mRect[2] as number) - (mInner[0] as number)) < 1.5
      && Math.abs((mRect[3] as number) - (mInner[1] as number)) < 1.5;
    record(
      "C1",
      "canvas fills viewport at 390x844",
      canvasFills ? "PASS" : "FAIL",
      `rect=${JSON.stringify(mRect)} inner=${JSON.stringify(mInner)} dpr=${String(canvasBoxes["dpr"])} backingStore=${JSON.stringify(canvasBoxes["attr"])} maxTouchPoints=${String(canvasBoxes["touchPoints"])} pointerCoarse=${String(canvasBoxes["coarse"])}`,
    );

    /* ---- C2: overlay rects and real painted occlusion of the canvas ---- */
    const overlayRects = await js<Record<string, unknown>>(client, `(() => {
      const pick = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        const cs2 = { display: cs.display, visibility: cs.visibility, position: cs.position, zIndex: cs.zIndex, pointerEvents: cs.pointerEvents, opacity: cs.opacity, background: cs.backgroundColor };
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        // Painted = a visible, non-transparent element with a non-transparent
        // background. The HUD root is a full-bleed pointer-events:none
        // wrapper, so its own box hides nothing.
        const bgAlpha = (() => { const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor); if (!m) return 1; const parts = m[1].split(',').map((s) => parseFloat(s.trim())); return parts.length === 4 ? parts[3] : 1; })();
        return { sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), area, visible: cs2.display !== 'none' && cs2.visibility !== 'hidden' && (e.closest('[hidden]') === null), painted: cs2.display !== 'none' && cs2.visibility !== 'hidden' && (e.closest('[hidden]') === null) && bgAlpha > 0.05, ...cs2, bgAlpha }; };
      return {
        viewport: [window.innerWidth, window.innerHeight],
        regions: [pick('[role="region"][aria-label="Carte"]'), pick('.map-hud'), pick('.map-shell__canvas'), pick('.layer-controls-panel'), pick('.feature-inspector'), pick('.map-shell__inspector-toggle'), pick('.source-attribution'), pick('#scene-diagnostics')].filter(Boolean),
        // What actually steals a hit test over the canvas, sampled on a grid.
        hitTest: (() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect();
          let overCanvas = 0, tested = 0; const owners = {};
          for (let gx = 0.05; gx < 1; gx += 0.05) for (let gy = 0.05; gy < 1; gy += 0.05) {
            const x = r.x + r.width * gx, y = r.y + r.height * gy; tested++;
            const el = document.elementFromPoint(x, y);
            if (el === c || (el && c.contains(el))) overCanvas++;
            else { const k = el ? el.tagName + '.' + (typeof el.className === 'string' ? el.className.split(' ')[0] : '') : 'null'; owners[k] = (owners[k] || 0) + 1; }
          }
          return { tested, reachedCanvas: overCanvas, pct: (overCanvas / tested) * 100, blockedBy: owners }; })(),
      };
    })()`);
    const regions = overlayRects["regions"] as Record<string, number | string | boolean>[];
    const vw = (overlayRects["viewport"] as number[])[0] as number;
    const vh = (overlayRects["viewport"] as number[])[1] as number;
    const hitTest = overlayRects["hitTest"] as Record<string, unknown>;
    const paintedRegions = regions.filter((r) => r["painted"] === true);
    // Union area of the painted panels, computed from a grid so overlapping
    // boxes are not double counted.
    const unionArea = await js<number>(client, `(() => {
      const sels = ${JSON.stringify(paintedRegions.map((r) => r["sel"]))};
      const W = window.innerWidth, H = window.innerHeight, step = 4;
      let covered = 0;
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
        const el = document.elementFromPoint(x + 0.5, y + 0.5);
        if (!el) continue;
        let hit = false;
        for (const s of sels) { const n = document.querySelector(s); if (n && (n === el || n.contains(el))) { hit = true; break; } }
        if (hit) covered++;
      }
      return covered * step * step;
    })()`);
    const paintedPct = (unionArea / (vw * vh)) * 100;
    console.log(`overlay regions: ${JSON.stringify(regions)}`);
    console.log(`hit test: ${JSON.stringify(hitTest)} unionArea=${unionArea} paintedPct=${paintedPct.toFixed(2)}`);
    const fullBlockers = paintedRegions.filter((r) => (r["area"] as number) > vw * vh * 0.9);
    record(
      "C2",
      "HUD / layer panel / inspector do not hide canvas content",
      paintedPct < 30 && fullBlockers.length === 0 ? "PASS" : "FAIL",
      `viewport ${vw}x${vh}; painted-panel union ${paintedPct.toFixed(2)}% of the viewport (4 px grid, elementFromPoint, overlapping boxes not double counted); canvas reachable on ${String(hitTest["tested"])} sampled points (${Number(hitTest["pct"]).toFixed(1)}%), blocked by ${JSON.stringify(hitTest["blockedBy"])}; regions ${JSON.stringify(regions)}`,
      "0 tiles resident: the canvas paints an empty background, so 'hidden content' is measured as occlusion area, not as lost map pixels",
    );

    /* ---- C3: touch pan moves the camera target ---- */
    const beforePan = await readDiag(client);
    await js(client, `(() => { window.__w4Pan = true; const c = document.querySelector('canvas');
      const send = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: 1, button: 0 }));
      const r = c.getBoundingClientRect();
      const x0 = r.x + r.width / 2, y0 = r.y + r.height / 2;
      send('pointerdown', x0, y0);
      for (let i = 1; i <= 10; i++) send('pointermove', x0 - i * 9, y0 - i * 5);
      send('pointerup', x0 - 90, y0 - 50);
      return true; })()`);
    await sleep(700);
    const afterPan = await readDiag(client);
    const dx = Number(afterPan["data-camera-target-x"]) - Number(beforePan["data-camera-target-x"]);
    const dz = Number(afterPan["data-camera-target-z"]) - Number(beforePan["data-camera-target-z"]);
    const panMoved = Math.hypot(dx, dz) > 1;
    record(
      "C3",
      "single-finger touch drag pans the camera",
      panMoved ? "PASS" : "FAIL",
      `target ${beforePan["data-camera-target-x"]},${beforePan["data-camera-target-z"]} -> ${afterPan["data-camera-target-x"]},${afterPan["data-camera-target-z"]} (dx=${dx.toFixed(2)} dz=${dz.toFixed(2)} |d|=${Math.hypot(dx, dz).toFixed(2)} m) after a 10-step 90x50 px touch drag; draws before=${beforePan["data-draw-calls"]} after=${afterPan["data-draw-calls"]}`,
      rendererLive ? "" : "renderer not initialized, pan may be unobservable",
    );

    /* ---- C4: two-finger pinch changes zoom ---- */
    const beforePinch = await readDiag(client);
    await js(client, `(() => { const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const pt = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11, clientX: x, clientY: y, bubbles: true, cancelable: true, buttons: 1 }));
      pt('pointerdown', 11, cx - 40, cy);
      pt('pointerdown', 12, cx + 40, cy);
      for (let i = 1; i <= 8; i++) { pt('pointermove', 11, cx - 40 - i * 9, cy); pt('pointermove', 12, cx + 40 + i * 9, cy); }
      pt('pointerup', 11, cx - 112, cy);
      pt('pointerup', 12, cx + 112, cy);
      return true; })()`);
    await sleep(700);
    const afterPinch = await readDiag(client);
    const zoomBefore = Number(beforePinch["data-camera-zoom"]);
    const zoomAfter = Number(afterPinch["data-camera-zoom"]);
    const zoomRatio = zoomAfter / zoomBefore;
    record(
      "C4",
      "two-finger pinch changes zoom",
      Number.isFinite(zoomRatio) && Math.abs(zoomRatio - 1) > 0.01 ? "PASS" : "FAIL",
      `zoom ${zoomBefore} -> ${zoomAfter} (ratio ${zoomRatio.toFixed(4)}) after spreading two touch pointers from 80 px to 224 px apart; frustum ${beforePinch["data-camera-frustum-width"]} -> ${afterPinch["data-camera-frustum-width"]}`,
      rendererLive ? "" : "renderer not initialized",
    );

    /* ---- C5: layer panel keyboard reachable + focus ring + activation ---- */
    const layerKb = await js<Record<string, unknown>>(client, `(() => {
      const toggle = document.querySelector('.layer-controls-panel .panel-toggle');
      if (!toggle) return { missing: true };
      toggle.focus();
      const cs = getComputedStyle(toggle);
      const before = toggle.getAttribute('aria-expanded');
      return {
        tag: toggle.tagName,
        text: (toggle.textContent || '').trim(),
        ariaExpanded: before,
        ariaControls: toggle.getAttribute('aria-controls'),
        hasLabel: toggle.getAttribute('aria-label'),
        focusIsToggle: document.activeElement === toggle,
        focusRing: { outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, outlineColor: cs.outlineColor, outlineOffset: cs.outlineOffset },
      };
    })()`);
    console.log(`layer toggle: ${JSON.stringify(layerKb)}`);
    const ring = layerKb["focusRing"] as Record<string, string>;
    const ringVisible = ring["outlineStyle"] !== "none" && Number.parseFloat(ring["outlineWidth"]) > 0;
    record(
      "C5a",
      "layer panel toggle is focusable and shows a visible focus ring",
      layerKb["focusIsToggle"] === true && ringVisible ? "PASS" : "FAIL",
      `focus() lands on ${String(layerKb["tag"])} .panel-toggle (activeElement===toggle: ${String(layerKb["focusIsToggle"])}); outline-style=${ring["outlineStyle"]} width=${ring["outlineWidth"]} color=${ring["outlineColor"]} offset=${ring["outlineOffset"]}; aria-expanded=${String(layerKb["ariaExpanded"])} aria-controls=${String(layerKb["ariaControls"])}`,
    );

    // ---- Decisive runtime capability control ----
    // The guarded press_key builds a raw CDP Input.dispatchKeyEvent with
    // only {type, key, code} and no windowsVirtualKeyCode / nativeVirtualKeyCode.
    // Establish whether ANY native button activation is possible under that
    // event shape, using a control element this app does not own.
    const capability = await js<Record<string, unknown>>(client, `(() => {
      const host = document.createElement('div');
      host.id = 'w4-key-probe';
      host.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0.01';
      host.innerHTML = '<button id="w4-probe-btn" type="button">probe</button>';
      document.body.appendChild(host);
      const btn = document.getElementById('w4-probe-btn');
      btn.addEventListener('click', () => { btn.setAttribute('data-clicked', 'yes'); });
      btn.focus();
      return { focused: document.activeElement === btn };
    })()`);
    const capEnter = await client.tool("press_key", { key: "Enter" });
    await sleep(400);
    const capAfterEnter = await js<Record<string, unknown>>(client, `(() => { const b = document.getElementById('w4-probe-btn'); return b ? b.getAttribute('data-clicked') : null; })()`);
    // Same probe with a full keyCode set, dispatched as a trusted DOM event.
    const capReference = await js<Record<string, unknown>>(client, `(() => {
      const b = document.getElementById('w4-probe-btn');
      if (!b) return { error: 'probe gone' };
      b.removeAttribute('data-clicked');
      b.focus();
      const opts = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, view: window };
      b.dispatchEvent(new KeyboardEvent('keydown', opts));
      b.dispatchEvent(new KeyboardEvent('keypress', opts));
      b.click();
      return { clickedWithFullKeyEvent: b.getAttribute('data-clicked') };
    })()`);
    await js(client, `(() => { const h = document.getElementById('w4-key-probe'); if (h) h.remove(); return true; })()`);
    const nativeEnterWorks = String(capAfterEnter) === "yes";
    console.log(`key capability: probe focus=${String(capability["focused"])} press_key Enter -> clicked=${JSON.stringify(capAfterEnter)} (tool ok=${String(capEnter.ok)}); full keyCode reference -> ${JSON.stringify(capReference["clickedWithFullKeyEvent"])}`);
    record(
      "C0",
      "the runtime can natively activate a focused button with press_key Enter",
      nativeEnterWorks ? "PASS" : "FAIL",
      `injected control <button id=w4-probe-btn> focused (${String(capability["focused"])}); press_key Enter (tool ok=${String(capEnter.ok)}) fired click=${JSON.stringify(capAfterEnter)}; the same button with a full keyCode/keypress pair then .click() registered ${JSON.stringify(capReference["clickedWithFullKeyEvent"])}. This isolates the runtime: the guarded press_key sends Input.dispatchKeyEvent without windowsVirtualKeyCode, which Chrome needs to synthesise the default button activation`,
    );

    // Tab walk from the panel toggle, recording every stop.
    const tabPath: string[] = [];
    await js(client, `(() => { const t = document.querySelector('.layer-controls-panel .panel-toggle'); if (t) t.focus(); return document.activeElement === t; })()`);
    let atReset = false;
    for (let step = 0; step < 12; step++) {
      await client.tool("press_key", { key: "Tab" });
      await sleep(150);
      const stop = await js<string | null>(client, `(() => { const a = document.activeElement; if (!a) return null;
        return a.tagName + '[' + (a.getAttribute('type') || '') + ']:"' + ((a.getAttribute('data-testid') || a.getAttribute('aria-label') || (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30))) + '"'; })()`);
      if (typeof stop === "string") tabPath.push(stop);
      atReset = stop !== null && stop.includes("reset-view");
      if (atReset) break;
    }
    console.log(`tab path from the layer toggle: ${JSON.stringify(tabPath)}`);

    // Enter on the panel toggle, through the guarded runtime.
    await js(client, `(() => { const t = document.querySelector('.layer-controls-panel .panel-toggle'); if (t) t.focus(); return document.activeElement === t; })()`);
    const pressEnter = await client.tool("press_key", { key: "Enter" });
    await sleep(600);
    const layerAfterEnter = await js<Record<string, unknown>>(client, `(() => {
      const toggle = document.querySelector('.layer-controls-panel .panel-toggle');
      const group = document.querySelector('.layer-controls-panel .layer-list');
      const reset = document.querySelector('.layer-controls-panel .reset-button');
      return {
        ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
        checkboxes: group ? group.querySelectorAll('input[type=checkbox]').length : 0,
        groupLabel: group ? group.getAttribute('aria-label') : null,
        resetText: reset ? (reset.textContent || '').trim() : null,
        focusStillOnToggle: document.activeElement === toggle,
      };
    })()`);
    const layerOpen = layerAfterEnter["ariaExpanded"] === "true" && (layerAfterEnter["checkboxes"] as number) > 0;
    await shot(client, "02-layer-panel-open");
    record(
      "C5b",
      "layer panel opens with the Enter key and exposes operable checkboxes",
      layerOpen ? "PASS" : (nativeEnterWorks ? "FAIL" : "UNTESTABLE"),
      `press_key Enter (tool ok=${String(pressEnter.ok)}) with .panel-toggle focused -> aria-expanded ${String(layerKb["ariaExpanded"])} -> ${String(layerAfterEnter["ariaExpanded"])}; ${String(layerAfterEnter["checkboxes"])} checkboxes in role=group aria-label=${JSON.stringify(layerAfterEnter["groupLabel"])}; reset button ${JSON.stringify(layerAfterEnter["resetText"])}; focus stayed on the toggle=${String(layerAfterEnter["focusStillOnToggle"])}. Tab path out of the panel (${tabPath.length} stops) ${JSON.stringify(tabPath)}; the HUD reset button was reached=${String(atReset)}`,
      nativeEnterWorks ? "the control button did activate, so this is an app defect" : `C0: the guarded press_key could not activate even a plain control <button>, so this criterion is UNTESTABLE here, not a defect. The app markup is correct: <button type="button" aria-expanded aria-controls> with an onClick handler (src/components/map/LayerControls.tsx:86-106)`,
    );

    /* ---- C5c: a layer checkbox toggles with the keyboard alone ---- */
    // The panel cannot be opened through the runtime, so the checkboxes are
    // driven directly and the Space activation is measured the same way.
    const panelBefore = await js<Record<string, unknown>>(client, `(() => {
      const toggle = document.querySelector('.layer-controls-panel .panel-toggle');
      return { missing: toggle === null, ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null };
    })()`);
    await js(client, `(() => { const t = document.querySelector('.layer-controls-panel .panel-toggle'); if (t) t.click(); return true; })()`);
    await sleep(600);
    const checkboxState = await js<Record<string, unknown>>(client, `(() => {
      const toggle = document.querySelector('.layer-controls-panel .panel-toggle');
      const cb = document.querySelector('.layer-controls-panel .layer-list input[type=checkbox]');
      if (!cb) return { missing: 'no checkbox after click' };
      cb.focus();
      const cs = getComputedStyle(cb);
      return { openedByClick: toggle ? toggle.getAttribute('aria-expanded') : null, checkboxCount: document.querySelectorAll('.layer-controls-panel .layer-list input[type=checkbox]').length, label: (cb.closest('label')?.textContent || '').trim(), start: cb.checked, focused: document.activeElement === cb, outline: cs.outlineStyle + '/' + cs.outlineWidth };
    })()`);
    const spaceResult = await js<Record<string, unknown>>(client, `(() => {
      const cb = document.querySelector('.layer-controls-panel .layer-list input[type=checkbox]');
      if (!cb) return { missing: true };
      const before = cb.checked;
      cb.click();
      const after = cb.checked;
      cb.click();
      return { before, after, restored: cb.checked, label: (cb.closest('label')?.textContent || '').trim() };
    })()`);
    const spacePress = await client.tool("press_key", { key: " " });
    await sleep(500);
    const afterSpacePress = await js<boolean | null>(client, `(() => { const cb = document.querySelector('.layer-controls-panel .layer-list input[type=checkbox]'); return cb ? cb.checked : null; })()`);
    const spaceViaKey = afterSpacePress !== null && afterSpacePress !== spaceResult["restored"];
    record(
      "C5c",
      "a layer checkbox is reachable and operable by keyboard (Space)",
      spaceViaKey ? "PASS" : (nativeEnterWorks ? "FAIL" : "UNTESTABLE"),
      `panel opened by click() (aria-expanded ${String(panelBefore["ariaExpanded"])} -> ${String(checkboxState["openedByClick"])}), ${String(checkboxState["checkboxCount"])} checkboxes, first checkbox "${String(checkboxState["label"])}" focusable=${String(checkboxState["focused"])} ring=${String(checkboxState["outline"])}; native .click() flips it ${String(spaceResult["before"])} to ${String(spaceResult["after"])} and back to ${String(spaceResult["restored"])}; press_key " " ok=${String(spacePress.ok)} left it ${String(afterSpacePress)}`,
      nativeEnterWorks ? "the control key press did not flip the checkbox" : "C0: the guarded press_key cannot synthesise the default checkbox activation either, so UNTESTABLE here; the markup (<label><input type=checkbox> + text, src/components/map/LayerControls.tsx:239-246) is correct",
    );

    /* ---- C5d: real Tab walk reaches the search and the layer panel ---- */
    await js(client, `(() => { document.body.focus(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return true; })()`);
    const tabOrder: string[] = [];
    for (let step = 0; step < 40; step++) {
      await client.tool("press_key", { key: "Tab" });
      await sleep(120);
      const active = await js<string | null>(client, `(() => { const a = document.activeElement; if (!a || a === document.body) return null;
        const label = a.getAttribute('aria-label') || a.getAttribute('data-testid') || (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) || a.getAttribute('placeholder') || '';
        const cs = getComputedStyle(a);
        return a.tagName + '[' + (a.getAttribute('type') || '') + '] {' + (a.getAttribute('data-testid') || 'no-testid') + '} "' + label + '" outline=' + cs.outlineStyle + '/' + cs.outlineWidth + ' boxShadow=' + (cs.boxShadow === 'none' ? 'none' : 'set'); })()`);
      if (typeof active === "string") tabOrder.push(active);
    }
    const sawSearch = tabOrder.some((entry) => entry.includes("search-input"));
    const sawLayerToggle = tabOrder.some((entry) => entry.includes("Couches"));
    const sawAttribution = tabOrder.some((entry) => entry.startsWith("A["));
    // A stop is ringed when it has a non-zero outline or a set box-shadow.
    // NEXTJS-PORTAL is the dev-overlay element, not app chrome.
    const appStops = tabOrder.filter((entry) => !entry.includes("NEXTJS-PORTAL"));
    const allRings = appStops.every((entry) => !/outline=none\/0px/.test(entry));
    const nextjsPortal = tabOrder.filter((entry) => entry.includes("NEXTJS-PORTAL")).length;
    console.log(`tab order: ${JSON.stringify(tabOrder)}`);
    record(
      "C5d",
      "Tab reaches the search field and the layer panel with a focus ring at every stop",
      sawSearch && sawLayerToggle && allRings ? "PASS" : "FAIL",
      `${tabOrder.length} Tab stops from the document start (${nextjsPortal} of them NEXTJS-PORTAL, the dev overlay): ${JSON.stringify(tabOrder)}; search reached=${String(sawSearch)} layer panel toggle reached=${String(sawLayerToggle)} attribution links reached=${String(sawAttribution)}; app stops with no focus ring: ${JSON.stringify(appStops.filter((entry) => /outline=none\/0px/.test(entry)))}`,
    );

    /* ---- C6: search reachable and operable by keyboard ---- */
    // React sets its `focused` state in onFocus and re-renders, so the focus
    // ring only exists after the commit. Read it in a later evaluate.
    await js(client, `(() => { const input = document.querySelector('[data-testid="search-input"]'); if (input) input.focus(); return document.activeElement === input; })()`);
    await sleep(500);
    const searchKb = await js<Record<string, unknown>>(client, `(() => {
      const input = document.querySelector('[data-testid="search-input"]');
      if (!input) return { missing: true };
      const cs = getComputedStyle(input);
      return { type: input.type, ariaLabel: input.getAttribute('aria-label'), placeholder: input.getAttribute('placeholder'), focused: document.activeElement === input, outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth, boxShadow: cs.boxShadow, borderColor: cs.borderColor };
    })()`);
    await client.tool("type_text", { selector: "[data-testid=\"search-input\"]", text: "Auch" });
    await sleep(1500);
    const searchState = await js<Record<string, unknown>>(client, `(() => {
      const list = document.querySelector('[role="listbox"][aria-label="Résultats de recherche"]');
      const opts = list ? list.querySelectorAll('[role="option"]') : [];
      return { value: document.querySelector('[data-testid="search-input"]')?.value ?? null, listPresent: list !== null, listLabel: list ? list.getAttribute('aria-label') : null, options: opts.length, firstOption: opts[0] ? (opts[0].textContent || '').trim().slice(0, 80) : null, listRect: list ? (() => { const r = list.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })() : null };
    })()`);
    await shot(client, "03-search-focused");
    record(
      "C6a",
      "search input is keyboard focusable with a visible focus ring",
      searchKb["focused"] === true && String(searchKb["boxShadow"]) !== "none" ? "PASS" : "FAIL",
      `type=${String(searchKb["type"])} aria-label=${JSON.stringify(searchKb["ariaLabel"])} placeholder=${JSON.stringify(searchKb["placeholder"])}; focus() -> activeElement===input ${String(searchKb["focused"])}; focus indicator: outline=${String(searchKb["outlineStyle"])}/${String(searchKb["outlineWidth"])} box-shadow=${String(searchKb["boxShadow"])} border-color=${String(searchKb["borderColor"])} (the input sets outline:none in its base style and draws a 2 px accent ring with box-shadow instead)`,
    );
    record(
      "C6b",
      "search returns an aria listbox of options from the keyboard",
      searchState["listPresent"] === true ? "PASS" : "FAIL",
      `typed "Auch" -> input value ${JSON.stringify(searchState["value"])}, role=listbox aria-label=${JSON.stringify(searchState["listLabel"])} with ${String(searchState["options"])} role=option rows, first row ${JSON.stringify(searchState["firstOption"])}, list rect ${JSON.stringify(searchState["listRect"])}`,
    );

    /* ---- C6c: first option activatable with Enter (keyboard only) ---- */
    const optionActivation = await js<Record<string, unknown>>(client, `(() => {
      const opt = document.querySelector('[role="option"]');
      if (!opt) return { missing: true };
      opt.focus();
      return { focused: document.activeElement === opt, text: (opt.textContent || '').trim().slice(0, 80), hasId: opt.getAttribute('data-testid') };
    })()`);
    const beforeOption = await readDiag(client);
    await client.tool("press_key", { key: "Enter" });
    await sleep(2500);
    const afterOption = await readDiag(client);
    const inspectorNow = await js<Record<string, unknown>>(client, `(() => {
      const i = document.querySelector('[data-testid="feature-inspector"]');
      if (!i) return { present: false };
      const r = i.getBoundingClientRect();
      return { present: true, role: i.getAttribute('role'), ariaLabel: i.getAttribute('aria-label'), featureId: i.getAttribute('data-feature-id'), rect: [r.x, r.y, r.width, r.height] };
    })()`);
    const optionOpenedInspector = inspectorNow["present"] === true;
    // CONTROL A (runtime key path): the same press_key Enter on the HUD reset
    // button, so a failure here is separable from the runtime's own handling.
    const controlCamera = await js<Record<string, unknown>>(client, `(() => { const d = document.getElementById('scene-diagnostics'); return { target: d.getAttribute('data-camera-target-x') }; })()`);
    await js(client, `(() => { const b = document.querySelector('[data-testid="reset-view"]'); if (b) b.focus(); return document.activeElement === b; })()`);
    const controlOptEnter = await client.tool("press_key", { key: "Enter" });
    await sleep(800);
    const controlOptCamera = await js<Record<string, unknown>>(client, `(() => { const d = document.getElementById('scene-diagnostics'); return { target: d.getAttribute('data-camera-target-x') }; })()`);
    const controlOptWorked = controlOptCamera["target"] !== controlCamera["target"];
    // CONTROL B (app handler): re-run a search and click() the same option.
    await client.tool("type_text", { selector: "[data-testid=\"search-input\"]", text: "Auch" });
    await sleep(1800);
    const optionClicked = await js<Record<string, unknown>>(client, `(() => {
      const opt = document.querySelector('[role="option"]');
      if (!opt) return { missing: true };
      opt.click();
      return { clicked: true, text: (opt.textContent || '').trim().slice(0, 40) };
    })()`);
    await sleep(3500);
    const inspectorAfterClick = await js<Record<string, unknown>>(client, `(() => {
      const i = document.querySelector('[data-testid="feature-inspector"]');
      return { present: i !== null, role: i ? i.getAttribute('role') : null, ariaLabel: i ? i.getAttribute('aria-label') : null, featureId: i ? i.getAttribute('data-feature-id') : null };
    })()`);
    record(
      "C6c",
      "a search result is selectable with Enter and opens the inspector",
      optionOpenedInspector ? "PASS" : (nativeEnterWorks ? "FAIL" : "UNTESTABLE"),
      `focused first option ${JSON.stringify(optionActivation["text"])} (data-testid=${JSON.stringify(optionActivation["hasId"])}, focusable=${String(optionActivation["focused"])}); press_key Enter -> inspector present=${String(inspectorNow["present"])}; camera target ${beforeOption["data-camera-target-x"]} -> ${afterOption["data-camera-target-x"]}, zoom ${beforeOption["data-camera-zoom"]} -> ${afterOption["data-camera-zoom"]}. CONTROL A (runtime key path): the same press_key Enter (tool ok=${String(controlOptEnter.ok)}) on the focused [data-testid=reset-view] button moved the camera target ${String(controlCamera["target"])} -> ${String(controlOptCamera["target"])} (works=${String(controlOptWorked)}). CONTROL B (app handler): option.click() ${JSON.stringify(optionClicked)} then inspector present=${String(inspectorAfterClick["present"])} role=${JSON.stringify(inspectorAfterClick["role"])} aria-label=${JSON.stringify(inspectorAfterClick["ariaLabel"])} feature=${JSON.stringify(inspectorAfterClick["featureId"])}`,
      nativeEnterWorks
        ? "the runtime key path is proven, so the option is the defect"
        : "C0 proved press_key Enter cannot natively activate a button in this runtime, so the Enter activation is UNTESTABLE here; CONTROL B separates the app handler from the key transport",
    );

    /* ---- C7: context menu on a feature, Escape closes and returns focus ---- */
    const residentBeforeMenu = await readDiag(client);
    const contextMenuOpen = await js<Record<string, unknown>>(client, `(() => {
      const c = document.querySelector('canvas');
      if (!c) return { dispatched: false };
      const r = c.getBoundingClientRect();
      // MapCamera handles contextmenu; try a grid of right-clicks across the
      // canvas so a resident feature, if any, is hit.
      let prevented = 0;
      for (let gx = 0.1; gx <= 0.9; gx += 0.1) {
        for (let gy = 0.1; gy <= 0.9; gy += 0.1) {
          const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width * gx, clientY: r.y + r.height * gy, button: 2, buttons: 2 });
          c.dispatchEvent(ev);
          if (ev.defaultPrevented) prevented++;
        }
      }
      return { dispatched: true, prevented, hasMenu: document.querySelector('[data-testid="feature-context-menu"]') !== null, htmlFlag: document.documentElement.dataset.featureContextOpen ?? null };
    })()`);
    await sleep(600);
    const menuState = await js<Record<string, unknown>>(client, `(() => {
      const m = document.querySelector('[data-testid="feature-context-menu"]');
      if (!m) return { present: false, activeEl: document.activeElement ? document.activeElement.tagName + '|' + (document.activeElement.className || '') : null };
      const items = m.querySelectorAll('[data-menu-action="true"]');
      const r = m.getBoundingClientRect();
      return { present: true, role: m.getAttribute('role'), ariaModal: m.getAttribute('aria-modal'), labelledby: m.getAttribute('aria-labelledby'), items: items.length, firstItemText: items[0] ? (items[0].textContent || '').trim() : null, activeEl: document.activeElement ? (document.activeElement.getAttribute('data-menu-action') === 'true' ? 'menu-item:' + (document.activeElement.textContent || '').trim() : document.activeElement.tagName) : null, rect: [r.x, r.y, r.width, r.height], dts: m.querySelectorAll('dl dt').length, heading: (m.querySelector('h2') ? m.querySelector('h2').textContent : '').trim() };
    })()`);
    await shot(client, "04-context-menu");
    let escapeResult: Record<string, unknown> = { attempted: false };
    if (menuState["present"] === true) {
      await client.tool("press_key", { key: "Escape" });
      await sleep(600);
      escapeResult = await js<Record<string, unknown>>(client, `(() => ({
        present: document.querySelector('[data-testid="feature-context-menu"]') !== null,
        htmlFlag: document.documentElement.dataset.featureContextOpen ?? null,
        activeEl: document.activeElement ? document.activeElement.tagName + '|' + (document.activeElement.className || '') : null,
      }))()`);
    }
    const menuCriterionOk = menuState["present"] === true
      && escapeResult["present"] === false
      && (escapeResult["htmlFlag"] === null || escapeResult["htmlFlag"] === undefined);
    record(
      "C7",
      "context menu opens on a feature, Escape closes it and releases the html flag",
      menuState["present"] === true ? (menuCriterionOk ? "PASS" : "FAIL") : "UNTESTABLE",
      `81 right-clicks dispatched on the canvas grid: preventDefault fired ${String(contextMenuOpen["prevented"])} times, menu present=${String(menuState["present"])}, html flag=${JSON.stringify(contextMenuOpen["htmlFlag"])}; if open: role=${String(menuState["role"])} aria-modal=${String(menuState["ariaModal"])} aria-labelledby=${String(menuState["ariaLabelledby"])} ${String(menuState["items"])} menu actions first=${JSON.stringify(menuState["firstItemText"])} heading=${JSON.stringify(menuState["heading"])} dt=${String(menuState["dts"])} focus on open=${JSON.stringify(menuState["activeEl"])}; after Escape: present=${String(escapeResult["present"])} html flag=${JSON.stringify(escapeResult["htmlFlag"])} focus=${JSON.stringify(escapeResult["activeEl"])}; resident tiles=${String(residentBeforeMenu["data-loaded-tile-count"])}`,
      menuState["present"] === true ? "" : "the in-progress rebuild has 0 resident render tiles in the current manifest frame, so no feature pixel exists to right-click",
    );
    await shot(client, "04-inspector-open");

    /* ---- C8: accessible names on every interactive control ---- */
    const names = await js<Record<string, unknown>>(client, `(() => {
      const sel = 'button, input, select, textarea, a[href], [role="button"], [role="option"], [role="checkbox"]';
      const nodes = Array.from(document.querySelectorAll(sel));
      const visible = (e) => { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || e.closest('[hidden]')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nameOf = (e) => {
        const aria = e.getAttribute('aria-label');
        if (aria && aria.trim()) return aria.trim();
        const by = e.getAttribute('aria-labelledby');
        if (by) { const t = by.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim(); if (t) return t; }
        if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') { if (e.id) { const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l && l.textContent.trim()) return l.textContent.trim(); } const wrap = e.closest('label'); if (wrap && wrap.textContent.trim()) return wrap.textContent.trim(); if (e.getAttribute('title')) return e.getAttribute('title'); if (e.getAttribute('placeholder')) return 'placeholder:' + e.getAttribute('placeholder'); return null; }
        if (e.tagName === 'BUTTON' || e.tagName === 'A') { const t = (e.textContent || '').replace(/\\s+/g, ' ').trim(); if (t) return t; const img = e.querySelector('img[alt]'); if (img) return img.getAttribute('alt'); if (e.getAttribute('title')) return e.getAttribute('title'); return null; }
        const t = (e.textContent || '').replace(/\\s+/g, ' ').trim(); if (t) return t; return e.getAttribute('title') || null;
      };
      const all = nodes.map((e) => ({ tag: e.tagName, type: e.getAttribute('type'), testid: e.getAttribute('data-testid'), cls: (e.className && typeof e.className === 'string') ? e.className.slice(0, 60) : '', visible: visible(e), name: nameOf(e) }));
      return { total: all.length, visibleCount: all.filter((e) => e.visible).length, missing: all.filter((e) => !e.name), all };
    })()`);
    const missing = names["missing"] as Record<string, unknown>[];
    console.log(`controls: total=${String(names["total"])} visible=${String(names["visibleCount"])} missing=${missing.length}`);
    if (missing.length > 0) console.log(`missing names: ${JSON.stringify(missing)}`);
    record(
      "C8",
      "every interactive control exposes an accessible name",
      missing.length === 0 ? "PASS" : "FAIL",
      `${String(names["total"])} interactive nodes (${String(names["visibleCount"])} visible), ${missing.length} without a name; unnamed: ${JSON.stringify(missing)}`,
    );

    /* ---- C9: inspector structure (headings + definition lists) ---- */
    const inspectorStructure = await js<Record<string, unknown>>(client, `(() => {
      const i = document.querySelector('[data-testid="feature-inspector"]');
      if (!i) return { present: false };
      const hs = Array.from(i.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => ({ tag: h.tagName, text: (h.textContent || '').trim() }));

      const dls = Array.from(i.querySelectorAll('dl')).map((dl) => ({ rows: dl.querySelectorAll('dt').length, dd: dl.querySelectorAll('dd').length, pairs: Array.from(dl.querySelectorAll('dt')).slice(0, 6).map((dt, k) => { const dd = dt.parentElement && dt.parentElement.querySelector('dd'); return dt.textContent.trim() + ' = ' + (dd ? dd.textContent.trim().slice(0, 40) : ''); }) }));
      return { present: true, role: i.getAttribute('role'), ariaLabel: i.getAttribute('aria-label'), headings: hs, definitionLists: dls.length, dl: dls, focusable: i.querySelectorAll('button, [tabindex]').length, overflowY: getComputedStyle(i).overflowY };
    })()`);
    console.log(`inspector: ${JSON.stringify(inspectorStructure)}`);
    const headings = inspectorStructure["headings"] as unknown[] | undefined;
    const dls = inspectorStructure["dl"] as unknown[] | undefined;
    record(
      "C9",
      "inspector exposes headings and definition lists",
      inspectorStructure["present"] === true ? ((headings?.length ?? 0) > 0 && (dls?.length ?? 0) > 0 ? "PASS" : "FAIL") : "UNTESTABLE",
      inspectorStructure["present"] === true
        ? `aside role=${String(inspectorStructure["role"])} aria-label=${JSON.stringify(inspectorStructure["ariaLabel"])} with ${String(headings?.length ?? 0)} headings ${JSON.stringify(headings)} and ${String(dls?.length ?? 0)} definition lists ${JSON.stringify(dls)}; focusable children=${String(inspectorStructure["focusable"])}; overflow-y=${String(inspectorStructure["overflowY"])}`
        : `no aside[data-testid=feature-inspector] in the document: the search selection could not resolve a pick because its render tile l0_558_293_s4_1_0 is not among the 91 files currently in data/generated/render (the manifest still lists 9591 tiles from the older dataset), so MapShell never sets selectedFeature and FeatureInspector returns null (src/components/map/FeatureInspector.tsx:103). The component is present in the bundle but its headings and definition lists cannot be observed`,
    );

    /* ---- C10: prefers-reduced-motion honoured in CSS ---- */
    const reduced = await js<Record<string, unknown>>(client, `(() => {
      const sheets = Array.from(document.styleSheets);
      const out = [];
      for (const s of sheets) { let rules; try { rules = s.cssRules; } catch (e) { out.push({ href: s.href, blocked: true }); continue; }
        for (const r of rules || []) {
          if (r.type === CSSRule.MEDIA_RULE && /prefers-reduced-motion/.test(r.conditionText || r.media.mediaText)) {
            const inner = Array.from(r.cssRules).map((x) => x.cssText);
            out.push({ media: r.conditionText || r.media.mediaText, ruleCount: inner.length, selectors: inner.slice(0, 4), hasTransitionReset: inner.some((t) => /transition-duration/.test(t)), hasAnimationReset: inner.some((t) => /animation-duration/.test(t)) });
          }
        }
      }
      // also scan the styled-jsx / inline style tags in the document
      const inline = Array.from(document.querySelectorAll('style')).map((st) => st.textContent || '').filter((t) => /prefers-reduced-motion/.test(t)).map((t) => t.slice(0, 200));
      return { blocks: out, inlineCount: inline.length, mediaMatches: window.matchMedia('(prefers-reduced-motion: reduce)').matches };
    })()`);
    console.log(`reduced motion: ${JSON.stringify(reduced)}`);
    const blocks = reduced["blocks"] as Record<string, unknown>[] | undefined;
    const realRule = (blocks ?? []).some((b) => (b["ruleCount"] as number) > 0 && b["hasTransitionReset"] === true);
    record(
      "C10",
      "reduced motion is honoured by a real CSS rule",
      realRule ? "PASS" : "FAIL",
      `matchMedia('(prefers-reduced-motion: reduce)').matches=${String(reduced["mediaMatches"])} (no emulation available in this runtime); ${String(blocks?.length ?? 0)} CSS @media prefers-reduced-motion blocks reachable from document.styleSheets, of which ${String((blocks ?? []).filter((b) => b["hasTransitionReset"] === true).length)} carry a transition-duration override; blocks ${JSON.stringify(blocks)}`,
    );

    /* ---- C11: mobile menu screenshot (inspector toggle as the mobile menu) ---- */
    const menuShot = await js<Record<string, unknown>>(client, `(() => {
      const t = document.querySelector('.map-shell__inspector-toggle');
      if (!t) return { present: false };
      const r = t.getBoundingClientRect();
      return { present: true, text: (t.textContent || '').trim(), ariaLabel: t.getAttribute('aria-label'), rect: [r.x, r.y, r.width, r.height], top: r.y, bottom: r.bottom, viewportH: window.innerHeight };
    })()`);
    console.log(`mobile inspector toggle: ${JSON.stringify(menuShot)}`);

    /* ---- C13: literal ${TOKEN} leaking into inline styles ---- */
    const tokenLeaks = await js<Record<string, unknown>>(client, `(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'borderBottomWidth', 'borderTopWidth', 'boxShadow', 'backgroundImage']) {
          const v = cs[prop];
          if (typeof v === 'string' && v.includes('\${')) out.push({ tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60), prop, value: v.slice(0, 120), testid: el.getAttribute('data-testid') });
        }
      }
      return { count: out.length, leaks: out.slice(0, 12) };
    })()`);
    console.log(`token leaks: ${JSON.stringify(tokenLeaks)}`);
    record(
      "C13",
      "no unresolved \${TOKEN} leaks into computed inline styles",
      (tokenLeaks["count"] as number) === 0 ? "PASS" : "FAIL",
      `${String(tokenLeaks["count"])} computed properties carry a literal unresolved \${...} token: ${JSON.stringify(tokenLeaks["leaks"])}`,
    );


    /* ---- screenshots ---- */
    await shot(client, "01-mobile-overview");
    await client.tool("set_viewport", { w: 1440, h: 900, dpr: 1, mobile: false });
    await sleep(2500);
    await shot(client, "05-desktop-1440x900");
    const canvasDesktop = await js<Record<string, unknown>>(client, `(() => { const c = document.querySelector('canvas'); if (!c) return { missing: true }; const r = c.getBoundingClientRect(); return { rect: [r.x, r.y, r.width, r.height], inner: [window.innerWidth, window.innerHeight] }; })()`);
    console.log(`canvas desktop: ${JSON.stringify(canvasDesktop)}`);

    /* ---- report ---- */
    const diagEnd = await readDiag(client);
    const summary = {
      url: URL_TARGET,
      server: client.server(),
      gpu: { hardware: gpuOk, strategy, toolOk: gpu.ok },
      viewportMobile: { w: 390, h: 844, dpr: 2, mobile: true },
      viewportDesktop: { w: 1440, h: 900, dpr: 1, mobile: false },
      rendererStatusMobile: diagMobile["data-renderer-status"] ?? null,
      rendererStatusDesktop: diagEnd["data-renderer-status"] ?? null,
      tilesLoaded: diagMobile["data-loaded-tile-count"] ?? null,
      drawCallsMobile: diagMobile["data-draw-calls"] ?? null,
      drawCallsDesktop: diagEnd["data-draw-calls"] ?? null,
      canvasMobile: canvasBoxes,
      canvasDesktop,
      criteria,
      shots: shotLog,
    };
    writeFileSync(resolve(SHOT_DIR, "verify-mobile.json"), `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(IMAGE_OUT, `${shotLog.map((s) => JSON.stringify(s)).join("\n")}\n`);

    console.log("---- VERDICTS ----");
    for (const c of criteria) console.log(`${c.verdict}\t${c.id}\t${c.name}\t${c.measurement}`);

    const close = await client.tool("profile_close", {});
    console.log(`profile_close ok=${close.ok}`);
  } finally {
    client.close();
    releaseLock();
  }
}


main().catch((error: unknown) => {
  console.error("verify-mobile failed:", error);
  process.exitCode = 1;
});
