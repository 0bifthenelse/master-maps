import { test, expect, type Page } from "./fixtures";

interface Manifest {
  territoryCode: string;
  tiles: Array<{ tileId: string; lod: number; featureCount: number; features: string[]; fragmentIds?: string[] }>;
}

interface SearchRecord {
  featureId: string;
  canonicalName: string;
  tileId: string;
  kind: string;
  focusLon: number;
  focusLat: number;
}

async function manifest(page: Page): Promise<Manifest> {
  const response = await page.request.get("/api/map/manifest");
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Manifest>;
}

async function waitForMetadata(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("#scene-diagnostics")).toBeAttached();
  await expect.poll(async () => (await page.request.get("/api/map/search")).status()).toBe(200);
}

async function searchAndSelect(page: Page, query: string): Promise<SearchRecord> {
  const records = await page.request.get(`/api/map/search?q=${encodeURIComponent(query)}`).then((response) => response.json() as Promise<SearchRecord[]>);
  const expected = records[0];
  expect(expected, `search result for ${query}`).toBeDefined();
  if (!expected) throw new Error(`No search result for ${query}`);
  const input = page.locator('[data-testid="search-input"]');
  await input.fill(query);
  const option = page.locator('[role="option"]').first();
  await expect(option).toBeVisible();
  await option.click();
  return expected;
}

function tileIds(urls: string[]): string[] {
  return urls.map((url) => decodeURIComponent(url.split("/api/map/tile/")[1] ?? "")).filter(Boolean);
}

async function cameraState(page: Page): Promise<{ target: [number, number, number]; zoom: number; headingRadians: number }> {
  const value = await page.locator("#scene-diagnostics").getAttribute("data-camera-state");
  if (!value) throw new Error("camera state diagnostic is unavailable");
  return JSON.parse(value) as { target: [number, number, number]; zoom: number; headingRadians: number };
}

async function hasCanvas(page: Page): Promise<boolean> {
  return page.locator("canvas").count().then((count) => count > 0);
}

test.describe("Gers viewport streaming through Moli", () => {
  test("loads only the initial overview working set", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/map/tile/")) requests.push(request.url());
    });
    await waitForMetadata(page);
    await page.waitForTimeout(800);
    const ids = tileIds(requests);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("l2_"))).toBe(true);
    const data = await manifest(page);
    expect(data.territoryCode).toBe("32");
    expect(ids.length).toBeLessThan(data.tiles.filter((tile) => tile.lod === 0).length);
  });

  test("searches distant Condom and L'Isle-Jourdain without department preload", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/map/tile/")) requests.push(request.url());
    });
    await waitForMetadata(page);
    const condom = await searchAndSelect(page, "Condom");
    await expect.poll(() => tileIds(requests).includes(condom.tileId), { timeout: 10000 }).toBe(true);
    const isle = await searchAndSelect(page, "L'Isle-Jourdain");
    await expect.poll(() => tileIds(requests).includes(isle.tileId), { timeout: 10000 }).toBe(true);
    await searchAndSelect(page, "Auch");
    const data = await manifest(page);
    expect(new Set(tileIds(requests)).size).toBeLessThan(data.tiles.length);
  });

  test("transitions from overview to detailed LOD after zoom", async ({ page }) => {
    await waitForMetadata(page);
    if (!(await hasCanvas(page))) return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/map/tile/")) requests.push(request.url());
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let index = 0; index < 12; index += 1) await page.mouse.wheel(0, -800);
    await expect.poll(() => tileIds(requests).some((id) => id.startsWith("l0_")), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => Number(await page.locator("#scene-diagnostics").getAttribute("data-loaded-tile-count")), { timeout: 10000 }).toBeGreaterThan(0);
  });

  test("panning changes requests without reloading an unchanged tile", async ({ page }) => {
    await waitForMetadata(page);
    if (!(await hasCanvas(page))) return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/map/tile/")) requests.push(request.url());
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 700, box.y + box.height / 2 + 400, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(1000);
    const ids = tileIds(requests);
    expect(new Set(ids).size).toBeGreaterThan(0);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("rapid panning does not let stale requests replace the working set", async ({ page }) => {
    await waitForMetadata(page);
    if (!(await hasCanvas(page))) return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    for (let index = 0; index < 5; index += 1) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + (index % 2 === 0 ? 500 : -500), box.y + box.height / 2, { steps: 2 });
      await page.mouse.up();
    }
    await page.waitForTimeout(1000);
    const loaded = Number(await page.locator("#scene-diagnostics").getAttribute("data-loaded-tile-count"));
    expect(loaded).toBeGreaterThan(0);
    const diagnostics = await page.evaluate(() => (window as unknown as { __masterMapsTileDiagnostics?: { aborted: string[] } }).__masterMapsTileDiagnostics);
    expect(diagnostics?.aborted.length ?? 0).toBeGreaterThan(0);
  });

  test("navigates the current OpenStreetMap reference view", async ({ page }) => {
    await page.goto("https://www.openstreetmap.org/#map=17/43.6475/0.5905", { waitUntil: "domcontentloaded", timeout: 30000 });
    await expect(page).toHaveURL(/openstreetmap\.org/);
    await page.waitForTimeout(1500);
    expect(await page.title()).toMatch(/OpenStreetMap/i);
  });

  test("keeps HJKL geographic directions and resets right-drag heading", async ({ page }) => {
    await waitForMetadata(page);
    if (!(await hasCanvas(page))) return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    await canvas.click();
    const initial = await cameraState(page);
    await page.keyboard.press("KeyL");
    await expect.poll(async () => (await cameraState(page)).target[0]).toBeGreaterThan(initial.target[0]);
    const east = await cameraState(page);
    await page.keyboard.press("KeyK");
    await expect.poll(async () => (await cameraState(page)).target[2]).toBeGreaterThan(east.target[2]);
    await page.keyboard.press("KeyH");
    await page.keyboard.press("KeyJ");
    await page.waitForTimeout(300);
    const returned = await cameraState(page);
    expect(returned.target[0]).toBeCloseTo(initial.target[0], 3);
    expect(returned.target[2]).toBeCloseTo(initial.target[2], 3);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up({ button: "right" });
    await expect.poll(async () => Math.abs((await cameraState(page)).headingRadians)).toBeGreaterThan(0.2);
    await page.getByText("Réinitialiser", { exact: true }).click();
    await expect.poll(async () => Math.abs((await cameraState(page)).headingRadians)).toBeLessThan(0.08);
  });

  test("keeps canonical search identity across tile boundaries", async ({ page }) => {
    await waitForMetadata(page);
    const data = await manifest(page);
    const fragmentIds = data.tiles.flatMap((tile) => tile.fragmentIds ?? []);
    expect(new Set(fragmentIds).size).toBe(fragmentIds.length);
    const search = await page.request.get("/api/map/search?q=Auch").then((response) => response.json() as Promise<SearchRecord[]>);
    expect(search.length).toBeGreaterThan(0);
    expect(search.every((record) => data.tiles.some((tile) => tile.tileId === record.tileId))).toBe(true);
  });
});
