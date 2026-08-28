import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium, type Page } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NEXT_PORT = 3104;
const CDP_PORT = 9335;
const VIEWPORT = { width: 1280, height: 720 };
const ARTIFACTS_DIR = resolve(ROOT, "tests/artifacts/visual");
const CHROME_CANDIDATES = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];

type Coordinate = [number, number];
interface FixtureAnchor { coordinate: Coordinate; sourceUrl: string }
interface SearchRecord { featureId: string; canonicalName: string; tileId: string; kind: string; focusLon: number; focusLat: number }
interface Manifest { bounds: [number, number, number, number] }
interface View { slug: string; query: string; coordinate: Coordinate }
interface CompareOptions { auch: boolean; dataDir?: string }

const gersFixture = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/gers-landmark-anchors.json"), "utf8")) as { anchors: Record<string, FixtureAnchor> };
const auchFixture = JSON.parse(readFileSync(resolve(ROOT, "tests/fixtures/auch-landmark-anchors.json"), "utf8")) as { anchors: Record<string, FixtureAnchor> };
const gersViews: View[] = [
  { slug: "auch-centre", query: "Auch", coordinate: [0.5905, 43.6475] },
  { slug: "auch-cathedral", query: "Cathédrale Sainte-Marie", coordinate: gersFixture.anchors.cathedralSainteMarie.coordinate },
  { slug: "auch-river", query: "Gers", coordinate: [0.5905, 43.6475] },
  { slug: "condom", query: "Condom", coordinate: gersFixture.anchors.condom.coordinate },
  { slug: "lectoure", query: "Lectoure", coordinate: gersFixture.anchors.lectoure.coordinate },
  { slug: "fleurance", query: "Fleurance", coordinate: gersFixture.anchors.fleurance.coordinate },
  { slug: "eauze", query: "Eauze", coordinate: gersFixture.anchors.eauze.coordinate },
  { slug: "vic-fezensac", query: "Vic-Fezensac", coordinate: gersFixture.anchors.vicFezensac.coordinate },
  { slug: "mirande", query: "Mirande", coordinate: gersFixture.anchors.mirande.coordinate },
  { slug: "marciac", query: "Marciac", coordinate: gersFixture.anchors.marciac.coordinate },
  { slug: "nogaro", query: "Nogaro", coordinate: gersFixture.anchors.nogaro.coordinate },
  { slug: "samatan", query: "Samatan", coordinate: gersFixture.anchors.samatan.coordinate },
  { slug: "lisle-jourdain", query: "L'Isle-Jourdain", coordinate: gersFixture.anchors.lisleJourdain.coordinate },
];
const cathedralAnchor = auchFixture.anchors.cathedralSainteMarie ?? auchFixture.anchors.cathedral;
if (!cathedralAnchor) throw new Error("Auch cathedral anchor is missing");
const AUCH_VIEWS: View[] = [
  { slug: "auch-centre", query: "Auch", coordinate: [0.5905, 43.6475] },
  { slug: "auch-cathedral", query: "Cathédrale Sainte-Marie", coordinate: cathedralAnchor.coordinate },
  { slug: "auch-gers-river", query: "Le Gers", coordinate: midpoint(auchFixture.anchors.gersSouth.coordinate, auchFixture.anchors.gersNorth.coordinate) },
  { slug: "auch-dense-block", query: "Boulevard Sadi Carnot", coordinate: auchFixture.anchors.boulevardSadiCarnot.coordinate },
  { slug: "auch-commercial", query: "NOCIBE", coordinate: auchFixture.anchors.nocibe.coordinate },
];

function midpoint(first: Coordinate, second: Coordinate): Coordinate {
  return [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
}

function parseOptions(args: string[]): CompareOptions {
  let auch = false;
  let dataDir = process.env.MASTER_MAPS_DATA_DIR;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--auch") auch = true;
    else if (argument?.startsWith("--data-dir=")) dataDir = argument.slice("--data-dir=".length);
    else if (argument === "--data-dir") {
      const value = args[index + 1];
      if (!value) throw new Error("--data-dir requires a path");
      dataDir = value;
      index += 1;
    }
  }
  return { auch, dataDir };
}

async function waitForPort(host: string, port: number, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://${host}:${port}/`);
      if (response.status < 500) return;
    } catch {
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

async function findChrome(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    const resultWaiter = Promise.withResolvers<string | null>();
    const process = spawn("command", ["-v", candidate], { shell: "/bin/bash" });
    let output = "";
    process.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    process.on("close", (code) => resultWaiter.resolve(code === 0 ? output.trim() : null));
    process.on("error", () => resultWaiter.resolve(null));
    const result = await resultWaiter.promise;
    if (result) return result;
  }
  throw new Error("No installed Chrome or Chromium executable found");
}

async function readManifest(page: Page): Promise<Manifest> {
  const response = await page.request.get("/api/map/manifest");
  if (!response.ok()) throw new Error(`Master manifest failed with ${response.status()}`);
  return response.json() as Promise<Manifest>;
}

async function selectMaster(page: Page, view: View): Promise<{ record: SearchRecord; manifest: Manifest; zoom: number }> {
  await page.goto(`http://127.0.0.1:${NEXT_PORT}`, { waitUntil: "load" });
  await page.locator("#scene-diagnostics").waitFor({ state: "attached", timeout: 15_000 });
  const records = await page.request.get(`/api/map/search?q=${encodeURIComponent(view.query)}`).then((response) => response.json() as Promise<SearchRecord[]>);
  const record = records[0];
  if (!record) throw new Error(`Master search returned no result for ${view.query}`);
  const input = page.locator('[data-testid="search-input"]');
  await input.fill(view.query);
  await page.locator('[role="option"]').first().waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('[role="option"]').first().click();
  await sleep(1200);
  const state = await page.locator("#scene-diagnostics").getAttribute("data-camera-state");
  const camera = state ? JSON.parse(state) as { zoom?: number } : { zoom: 1 };
  return { record, manifest: await readManifest(page), zoom: camera.zoom ?? 1 };
}

function osmZoom(manifest: Manifest, zoom: number, latitude: number): number {
  const worldWidth = manifest.bounds[2] - manifest.bounds[0];
  const worldHeight = manifest.bounds[3] - manifest.bounds[1];
  const aspect = VIEWPORT.width / VIEWPORT.height;
  const frustumWidth = worldWidth / worldHeight > aspect ? worldWidth * 1.15 : worldHeight * aspect * 1.15;
  const groundWidth = frustumWidth / Math.max(zoom, 1e-6);
  const metresPerPixel = groundWidth / VIEWPORT.width;
  const equatorResolution = 156543.03392804097 * Math.cos(latitude * Math.PI / 180);
  return Math.max(1, Math.min(19, Math.round(Math.log2(equatorResolution / metresPerPixel))));
}

async function capturePair(page: Page, view: View, consoleErrors: string[], pageErrors: string[]): Promise<Record<string, unknown>> {
  const master = await selectMaster(page, view);
  await page.screenshot({ path: resolve(ARTIFACTS_DIR, `${view.slug}-master.png`) });
  const selectedZoom = osmZoom(master.manifest, master.zoom, view.coordinate[1]);
  const osmUrl = `https://www.openstreetmap.org/#map=${selectedZoom}/${view.coordinate[1]}/${view.coordinate[0]}`;
  await page.goto(osmUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await sleep(3000);
  await page.screenshot({ path: resolve(ARTIFACTS_DIR, `${view.slug}-osm.png`) });
  return { slug: view.slug, coordinate: view.coordinate, query: view.query, masterZoom: master.zoom, osmZoom: selectedZoom, masterTile: master.record.tileId, osmUrl, masterScreenshot: `${view.slug}-master.png`, osmScreenshot: `${view.slug}-osm.png`, consoleErrors: consoleErrors.splice(0), pageErrors: pageErrors.splice(0) };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const captureViews = options.auch ? AUCH_VIEWS : gersViews;
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const chrome = await findChrome();
  const next: ChildProcess = spawn("npm", ["run", "start", "--", "--port", String(NEXT_PORT)], { cwd: ROOT, shell: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(options.dataDir ? { MASTER_MAPS_DATA_DIR: options.dataDir } : {}) } });
  next.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[next] ${chunk}`));
  next.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[next:err] ${chunk}`));
  const profile = resolve(ROOT, ".chrome-compare-profile");
  const chromeProcess: ChildProcess = spawn(chrome, ["--ozone-platform=x11", "--use-angle=vulkan", "--enable-features=Vulkan", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", `--window-size=${VIEWPORT.width},${VIEWPORT.height}`, "--window-position=-3000,-3000"], { cwd: ROOT, env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ":0" }, stdio: ["ignore", "pipe", "pipe"] });
  chromeProcess.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[chrome:err] ${chunk}`));
  try {
    await waitForPort("127.0.0.1", NEXT_PORT);
    await waitForPort("127.0.0.1", CDP_PORT);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    const context = browser.contexts()[0] ?? await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    await page.setViewportSize(VIEWPORT);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const results: Record<string, unknown>[] = [];
    for (const view of captureViews) results.push(await capturePair(page, view, consoleErrors, pageErrors));
    await page.close();
    await browser.close();
    await writeFile(resolve(ARTIFACTS_DIR, "comparison-report.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), viewport: VIEWPORT, scope: options.auch ? "auch" : "gers", dataDir: options.dataDir, locations: results }, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, locations: results.length, report: resolve(ARTIFACTS_DIR, "comparison-report.json") }, null, 2));
  } finally {
    chromeProcess.kill("SIGTERM");
    next.kill("SIGTERM");
  }
}

main().catch((error: unknown) => {
  console.error(`[compare-osm] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
