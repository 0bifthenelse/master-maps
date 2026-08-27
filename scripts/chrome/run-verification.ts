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

    try {
      await page.waitForFunction(
        () => {
          const diagnostics = document.querySelector("#scene-diagnostics");
          if (!diagnostics) return false;
          const status = diagnostics.getAttribute("data-renderer-status");
          const draws = Number(diagnostics.getAttribute("data-draw-calls"));
          if (status === "errored" || status === "unsupported") return true;
          return status === "initialized" && draws > 0;
        },
        undefined,
        { timeout: 20000 },
      );
    } catch (error) {
      const diagnostics = await page.locator("#scene-diagnostics").textContent().catch(() => null);
      console.error("Scene diagnostics before wait failure:", diagnostics);
      console.error("Console errors before wait failure:", JSON.stringify(consoleErrors));
      console.error("Page errors before wait failure:", JSON.stringify(pageErrors));
      throw error;
    }

    const diagAttrs = await page.locator("#scene-diagnostics").evaluate((el) => ({
      status: el.getAttribute("data-renderer-status"),
      backend: el.getAttribute("data-backend"),
      tiles: el.getAttribute("data-loaded-tile-count"),
      features: el.getAttribute("data-loaded-feature-count"),
      buildings: el.getAttribute("data-building-count"),
      roads: el.getAttribute("data-road-count"),
      water: el.getAttribute("data-water-count"),
      landuse: el.getAttribute("data-landuse-count"),
      pois: el.getAttribute("data-poi-count"),
      businesses: el.getAttribute("data-business-count"),
      draws: el.getAttribute("data-draw-calls"),
      camera: el.getAttribute("data-camera-state"),
      error: el.getAttribute("data-renderer-error"),
    }));
    console.log("Scene diagnostics:", JSON.stringify(diagAttrs, null, 2));

    if (diagAttrs.status === "initialized") {
      const camera = JSON.parse(diagAttrs.camera ?? "null") as {
        position?: [number, number, number];
        azimuthalAngle?: number;
      } | null;
      if (
        !camera
        || !camera.position
        || camera.position[1] <= 0
        || Math.abs(camera.azimuthalAngle ?? Number.NaN) > 1e-6
      ) {
        throw new Error(`Expected north-up camera, got ${diagAttrs.camera}`);
      }
      if (Number(diagAttrs.water) <= 0 || Number(diagAttrs.businesses) <= 0) {
        throw new Error(`Expected source-backed water and business counts, got ${JSON.stringify(diagAttrs)}`);
      }
    }

    await sleep(1500);

    const screenshotPath = resolve(ARTIFACTS_DIR, "after-overview.png");
    await page.screenshot({ path: screenshotPath });
    console.log(`Screenshot saved: ${screenshotPath}`);
    if (diagAttrs.status === "initialized") {
      const manifest = await page.evaluate(async () => {
        const response = await fetch("/api/map/manifest");
        return await response.json() as {
          bounds: [number, number, number, number];
          projectionOrigin: [number, number];
        };
      });
      const canvas = page.locator("canvas");
      const canvasBox = await canvas.boundingBox();
      if (!canvasBox) throw new Error("canvas has no bounding box");

      const readCamera = async (): Promise<{
        position: [number, number, number];
        target: [number, number, number];
        zoom: number;
        azimuthalAngle: number;
      }> => {
        const serialized = await page.locator("#scene-diagnostics").getAttribute("data-camera-state");
        if (!serialized) throw new Error("camera-state diagnostic is missing");
        return JSON.parse(serialized) as {
          position: [number, number, number];
          target: [number, number, number];
          zoom: number;
          azimuthalAngle: number;
        };
      };

      const capture = async (name: string): Promise<void> => {
        const path = resolve(ARTIFACTS_DIR, `${name}.png`);
        await page.screenshot({ path });
        console.log(`Screenshot saved: ${path}`);
      };

      const northUpTarget = (await readCamera()).target;
      const resetView = async (): Promise<void> => {
        await page.locator('button[aria-label="Réinitialiser la vue"]').click();
        await page.waitForFunction(
          (targetX) => Math.abs(Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) - targetX) < 0.5,
          northUpTarget[0],
          { timeout: 5000 },
        );
        await sleep(350);
      };

      const selectSearch = async (query: string, kind?: string): Promise<void> => {
        const input = page.locator('[data-testid="search-input"]');
        await input.fill(query);
        const selector = kind
          ? `[role="option"][data-feature-kind="${kind}"]`
          : '[role="option"]';
        const option = page.locator(selector).first();
        await option.waitFor({ state: "visible", timeout: 5000 });
        await option.click();
        await sleep(700);
      };

      const moveToSourceCoordinate = async (coordinate: [number, number]): Promise<[number, number]> => {
        const camera = await readCamera();
        const [originLon, originLat] = manifest.projectionOrigin;
        const metersPerDegree = 111_319.9;
        const originCosine = Math.cos(originLat * Math.PI / 180);
        const localX = (coordinate[0] - originLon) * metersPerDegree * originCosine;
        const localZ = (coordinate[1] - originLat) * metersPerDegree;
        const worldWidth = manifest.bounds[2] - manifest.bounds[0];
        const worldHeight = manifest.bounds[3] - manifest.bounds[1];
        const aspect = canvasBox.width / canvasBox.height;
        const frustumWidth = worldWidth / worldHeight > aspect
          ? worldWidth * 1.15
          : worldHeight * aspect * 1.15;
        const frustumHeight = worldWidth / worldHeight > aspect
          ? worldWidth / aspect * 1.15
          : worldHeight * 1.15;
        const screenX =
          canvasBox.x + canvasBox.width / 2
          + (localX - camera.target[0]) * camera.zoom / frustumWidth * canvasBox.width;
        const screenY =
          canvasBox.y + canvasBox.height / 2
          - (localZ - camera.target[2]) * camera.zoom / frustumHeight * canvasBox.height;
        console.log("Source coordinate screen position:", JSON.stringify({
          coordinate,
          local: [localX, localZ],
          camera,
          canvas: canvasBox,
          screen: [screenX, screenY],
        }));
        await page.mouse.move(screenX, screenY);
        return [screenX, screenY];
      };

      await capture("after-overview");
      await selectSearch("Gare d'Auch");
      await capture("gare-area");
      await resetView();
      await selectSearch("Cathédrale Sainte-Marie");
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await page.mouse.wheel(0, -800);
      await sleep(500);
      await capture("historic-centre");
      await resetView();
      await selectSearch("Musée des Amériques", "poi");
      await capture("museum-area");
      await resetView();
      await selectSearch("Le Gers", "water");
      await capture("gers-area");
      await resetView();

      const businessRecords = await page.evaluate(async () => {
        const response = await fetch("/api/map/search?q=NOCIBE");
        return await response.json() as Array<{
          featureId: string;
          canonicalName: string;
          kind: string;
          focusLon: number;
          focusLat: number;
        }>;
      });
      const business = businessRecords.find((record) =>
        record.kind === "business" && /nocibe/i.test(record.canonicalName));
      if (!business) throw new Error("No NOCIBE business search record available");
      await selectSearch("NOCIBE", "business");
      await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        if ((await readCamera()).zoom >= 100) break;
        await page.mouse.wheel(0, -1200);
        await sleep(10);
      }
      if ((await readCamera()).zoom < 100) {
        throw new Error("Hardware zoom did not reach a business-picking scale");
      }
      await sleep(500);
      await page.mouse.move(canvasBox.x + 10, canvasBox.y + 10);
      await sleep(100);
      const businessScreen = await moveToSourceCoordinate([business.focusLon, business.focusLat]);
      const r3fObjects = await page.evaluate(() => {
        const found: Array<{ tag: string; keys: string[]; rootKeys: string[] }> = [];
        for (const element of document.querySelectorAll("*")) {
          const value = (element as HTMLElement & { __r3f?: { root?: unknown } }).__r3f;
          if (!value) continue;
          const root = value.root;
          found.push({
            tag: element.tagName,
            keys: Object.keys(value),
            rootKeys: typeof root === "object" && root !== null ? Object.keys(root) : [],
          });
        }
        return found.slice(0, 8);
      });
      console.log("R3F DOM diagnostics:", JSON.stringify(r3fObjects));
      const hitElements = await page.evaluate(([screenX, screenY]) =>
        document.elementsFromPoint(screenX, screenY).map((element) => ({
          tag: element.tagName,
          id: element.id,
          className: typeof element.className === "string" ? element.className : "",
          pointerEvents: getComputedStyle(element).pointerEvents,
        })),
      businessScreen);
      console.log("Business DOM hit elements:", JSON.stringify(hitElements));
      const raycast = await page.evaluate(([screenX, screenY]) => {
        interface RaycastState {
          pointer: { set: (x: number, y: number) => void };
          raycaster: {
            setFromCamera: (pointer: unknown, camera: unknown) => void;
            intersectObjects: (objects: unknown[], recursive: boolean) => Array<{
              object: { type: string; userData: Record<string, unknown> };
              instanceId?: number;
            }>;
          };
          camera: unknown;
          scene: { children: unknown[] };
        }
        const canvas = document.querySelector("canvas");
        if (!canvas) return { error: "canvas missing" };
        const root = (canvas as HTMLCanvasElement & {
          __r3f?: { root?: { getState: () => RaycastState } };
        }).__r3f?.root;
        if (!root) return { error: "R3F root missing" };
        const state = root.getState();
        const rect = canvas.getBoundingClientRect();
        const pointerX = (screenX - rect.left) / rect.width * 2 - 1;
        const pointerY = -((screenY - rect.top) / rect.height * 2 - 1);
        state.pointer.set(pointerX, pointerY);
        state.raycaster.setFromCamera(state.pointer, state.camera);
        return state.raycaster.intersectObjects(state.scene.children, true).slice(0, 12).map((hit) => ({
          type: hit.object.type,
          instanceId: hit.instanceId,
          userDataKeys: Object.keys(hit.object.userData),
        }));
      }, businessScreen);
      console.log("Business raycast diagnostics:", JSON.stringify(raycast));
      const popup = page.locator('[data-testid="business-hover-popup"]');
      await page.mouse.move(canvasBox.x + 10, canvasBox.y + 10);
      await sleep(100);
      await page.mouse.move(businessScreen[0], businessScreen[1]);
      console.log("Business pointer moved to exact projected coordinate");
      try {
        await popup.waitFor({ state: "visible", timeout: 5000 });
      } catch (error) {
        console.error("Business popup did not appear:", error);
        console.error("Business search record:", JSON.stringify(business));
        console.error("Camera state:", await readCamera());
        await capture("business-hover-failed");
        throw error;
      }
      if (await popup.getAttribute("data-business-id") !== business.featureId) {
        throw new Error("Business popup resolved to the wrong stable ID");
      }
      await capture("business-hover");
      await page.mouse.move(canvasBox.x + 4, canvasBox.y + 4);
      await popup.waitFor({ state: "detached", timeout: 5000 });

      await resetView();
      await canvas.click();
      const hklInitial = await readCamera();
      await page.keyboard.press("KeyL");
      await sleep(150);
      await page.keyboard.press("KeyK");
      await sleep(150);
      await page.keyboard.press("KeyH");
      await sleep(150);
      await page.keyboard.press("KeyJ");
      await sleep(350);
      const hklFinal = await readCamera();
      console.log("HJKL camera transition:", JSON.stringify({ initial: hklInitial, final: hklFinal }));
      if (
        Math.abs(hklFinal.target[0] - hklInitial.target[0]) > 1e-6
        || Math.abs(hklFinal.target[2] - hklInitial.target[2]) > 1e-6
        || Math.abs(hklFinal.azimuthalAngle) > 1e-6
      ) {
        throw new Error("HJKL did not return the camera to the same north-up world state");
      }
      await capture("h-j-k-l");

      await selectSearch("Avenue d'Alsace", "road");
      await capture("avenue-d-alsace");
    }

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
