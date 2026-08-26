/**
 * Supplementary real (non-Moli) Chrome WebGPU verification.
 *
 * Independent of the Moli CDP suite. Discovers a locally installed
 * Chrome/Chromium executable and launches it with GPU/WebGPU enabled
 * against the production Next.js build, capturing a screenshot plus
 * console/pageerror diagnostics for VISION review.
 *
 * The browser window is real (on-screen, positioned off the visible
 * desktop area) rather than `--headless=new`: on this workstation the
 * NVIDIA proprietary Vulkan ICD does not implement
 * `VK_EXT_headless_surface`, so Chrome's headless GPU process falls
 * back to a degenerate Vulkan device (WebGPU adapter creation "succeeds"
 * but every buffer allocation fails). A real X11 surface avoids that gap
 * and gets the actual NVIDIA RTX 4060 (Lovelace) adapter.
 *
 * Never disables GPU. Never downloads Playwright's own Chromium —
 * Playwright is used only as a CDP client via connectOverCDP.
 *
 * Usage: tsx scripts/chrome/run-verification.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NEXT_PORT = 3102;
const CDP_PORT = 9333;
const ARTIFACTS_DIR = resolve(ROOT, "tests/artifacts/chrome");

const CHROME_CANDIDATES = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
];

async function findChrome(): Promise<{ bin: string; version: string }> {
  for (const bin of CHROME_CANDIDATES) {
    const found = await new Promise<string | null>((resolvePromise) => {
      const proc = spawn("command", ["-v", bin], { shell: "/bin/bash" });
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      proc.on("close", (code) => resolvePromise(code === 0 ? out.trim() : null));
      proc.on("error", () => resolvePromise(null));
    });
    if (found) {
      const version = await new Promise<string>((resolvePromise) => {
        const proc = spawn(found, ["--version"]);
        let out = "";
        proc.stdout?.on("data", (d: Buffer) => (out += d.toString()));
        proc.on("close", () => resolvePromise(out.trim()));
        proc.on("error", () => resolvePromise("unknown"));
      });
      return { bin: found, version };
    }
  }
  throw new Error(
    "No local Chrome/Chromium executable found (checked google-chrome-stable, google-chrome, chromium, chromium-browser). " +
      "Refusing to download Playwright's own Chromium per repository policy.",
  );
}

async function waitForPort(host: string, port: number, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://${host}:${port}/`);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function main() {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const { bin, version } = await findChrome();
  console.log(`Resolved Chrome executable: ${bin}`);
  console.log(`Chrome version: ${version}`);

  console.log("Starting Next.js production server...");
  const next: ChildProcess = spawn(
    "npm",
    ["run", "start", "--", "--port", String(NEXT_PORT)],
    { cwd: ROOT, shell: true },
  );
  next.stdout?.on("data", (d: Buffer) => process.stdout.write(`[next] ${d}`));
  next.stderr?.on("data", (d: Buffer) => process.stderr.write(`[next:err] ${d}`));

  // NOTE: `--headless=new` cannot get a real WebGPU adapter on this
  // workstation: the installed NVIDIA proprietary Vulkan ICD does not
  // implement `VK_EXT_headless_surface` (confirmed via
  // `VK_LOADER_DEBUG=error,warn`), so `vkCreateInstance()` fails with
  // VK_ERROR_INITIALIZATION_FAILED (-7) and Chrome's GPU process falls
  // back to a degenerate device with near-zero buffer limits. A real,
  // on-screen (but off-viewport) window uses the live X11 surface
  // instead and gets the real NVIDIA RTX 4060 (Lovelace) adapter with
  // GPU disabled nowhere and no `--disable-gpu` flag.
  const userDataDir = resolve(ROOT, ".chrome-verify-profile");
  const chromeArgs = [
    "--ozone-platform=x11",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--window-size=1440,900",
    "--window-position=-3000,-3000",
  ];
  const chromeEnv = { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" };
  const chromeProc: ChildProcess = spawn(bin, chromeArgs, { cwd: ROOT, env: chromeEnv });
  chromeProc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[chrome] ${d}`));
  chromeProc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[chrome:err] ${d}`));

  let exitCode = 0;
  try {
    await waitForPort("127.0.0.1", NEXT_PORT);
    console.log("Next.js ready.");
    await waitForPort("127.0.0.1", CDP_PORT);
    console.log("Chrome CDP ready.");

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = await context.newPage();

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(String(err)));

    await page.goto(`http://localhost:${NEXT_PORT}`, { waitUntil: "load" });

    const gpuInfo = await page.evaluate(async () => {
      const nav = navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } };
      if (!nav.gpu) return { supported: false, adapter: false };
      try {
        const adapter = await nav.gpu.requestAdapter();
        return { supported: true, adapter: adapter !== null };
      } catch (err) {
        return { supported: true, adapter: false, error: String(err) };
      }
    });
    console.log("navigator.gpu probe:", JSON.stringify(gpuInfo));

    await page.waitForFunction(
      () => {
        const diagnostics = document.querySelector("#scene-diagnostics");
        if (!diagnostics) return false;
        const status = diagnostics.getAttribute("data-renderer-status");
        const draws = Number(diagnostics.getAttribute("data-draw-calls"));
        if (status === "errored" || status === "unsupported") return true;
        // A freshly created WebGPU renderer flips to "initialized" before
        // the scene has evaluated a single frame of real geometry. Wait
        // for that first real frame instead of trusting renderer-status alone.
        return status === "initialized" && draws > 0;
      },
      undefined,
      { timeout: 20000 },
    );

    const diagAttrs = await page.locator("#scene-diagnostics").evaluate((el) => ({
      status: el.getAttribute("data-renderer-status"),
      backend: el.getAttribute("data-backend"),
      tiles: el.getAttribute("data-loaded-tile-count"),
      features: el.getAttribute("data-loaded-feature-count"),
      buildings: el.getAttribute("data-building-count"),
      roads: el.getAttribute("data-road-count"),
      pois: el.getAttribute("data-poi-count"),
      draws: el.getAttribute("data-draw-calls"),
      camera: el.getAttribute("data-camera-state"),
      error: el.getAttribute("data-renderer-error"),
    }));
    console.log("Scene diagnostics:", JSON.stringify(diagAttrs, null, 2));

    await sleep(1500); // allow a couple of frames to settle after diagnostics report initialized

    const screenshotPath = resolve(ARTIFACTS_DIR, "webgpu-map.png");
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved: ${screenshotPath}`);

    console.log("Console errors:", JSON.stringify(consoleErrors, null, 2));
    console.log("Page errors:", JSON.stringify(pageErrors, null, 2));

    await context.close();
    await browser.close();

    if (pageErrors.length > 0) {
      console.error("FAIL: pageerror events occurred during real Chrome verification.");
      exitCode = 1;
    }
    if (diagAttrs.status === "errored") {
      console.error("FAIL: renderer reported errored status in real Chrome.");
      exitCode = 1;
    }
  } catch (err) {
    console.error("Chrome verification failed:", err);
    exitCode = 1;
  } finally {
    chromeProc.kill();
    next.kill();
    await sleep(500);
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Chrome verification runner failed:", err);
  process.exit(1);
});
