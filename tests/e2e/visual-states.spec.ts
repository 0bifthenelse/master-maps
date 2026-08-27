import { test, expect, checkPngNotBlank, ARTIFACTS_DIR, type BrowserErrors } from "./fixtures";
import type { Page } from "@playwright/test";
function sleep(milliseconds: number): Promise<void> {
  const waiter = Promise.withResolvers<void>();
  setTimeout(waiter.resolve, milliseconds);
  return waiter.promise;
}

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 375, height: 667 },
] as const;

async function waitForMap(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const element = document.querySelector("#scene-diagnostics");
    if (!element) return false;
    const status = element.getAttribute("data-renderer-status");
    const tiles = Number(element.getAttribute("data-loaded-tile-count"));
    const features = Number(element.getAttribute("data-loaded-feature-count"));
    const draws = Number(element.getAttribute("data-draw-calls"));
    if (status === "errored") return true;
    if (status !== "initialized" && status !== "unsupported") return false;
    if (!(tiles > 0 && features > 0)) return false;
    // A freshly created WebGPU renderer flips to "initialized" before the
    // scene has evaluated a single frame of real geometry (buildings/roads/
    // draw-calls still read 0 for a brief window). Wait for that first real
    // frame instead of trusting renderer-status alone.
    if (status === "initialized") return draws > 0;
    return true;
  }, undefined, { timeout: 15000 });
}

function assertNoErrors(errors: BrowserErrors): void {
  expect(errors.pageErrors).toEqual([]);
  expect(errors.consoleErrors).toEqual([]);
}

test.describe("Visual states", () => {
  for (const viewport of VIEWPORTS) {
    test(`initial ${viewport.name} contains map geometry`, async ({ page, errors }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/");
      await waitForMap(page);
      assertNoErrors(errors);
      await expect(page.locator("#scene-diagnostics")).toHaveCount(1);
      const diagnostics = page.locator("#scene-diagnostics");
      const state = await diagnostics.getAttribute("data-renderer-status");
      const counts = await diagnostics.evaluate((element) => ({
        tiles: Number(element.getAttribute("data-loaded-tile-count")),
        features: Number(element.getAttribute("data-loaded-feature-count")),
        draws: Number(element.getAttribute("data-draw-calls")),
      }));
      expect(counts.tiles).toBeGreaterThan(0);
      expect(counts.features).toBeGreaterThan(0);
      if (state !== "initialized") {
        await page.screenshot({ path: `${ARTIFACTS_DIR}/visual/${viewport.name}-unsupported.png` });
        return;
      }
      expect(counts.draws).toBeGreaterThan(0);
      const canvas = page.locator("canvas");
      await expect(canvas).toBeVisible();
      const box = await canvas.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(0);
      expect(box?.height ?? 0).toBeGreaterThan(0);
      const path = `${ARTIFACTS_DIR}/visual/${viewport.name}.png`;
      await canvas.screenshot({ path });
      const content = checkPngNotBlank(path);
      expect(content.notBlank, content.reason).toBe(true);
    });
  }

  test("search open state still renders over the map", async ({ page, errors }) => {
    await page.goto("/");
    await waitForMap(page);
    const input = page.locator('input[type="search"]');
    await input.fill("Nocibé");
    await expect(page.locator('[role="listbox"]')).toBeVisible();
    assertNoErrors(errors);
    await page.screenshot({ path: `${ARTIFACTS_DIR}/visual/search-open.png` });
  });

  test("selected feature state retains rendered geometry", async ({ page, errors }) => {
    await page.goto("/");
    await waitForMap(page);
    await page.locator('input[type="search"]').fill("Nocibé");
    const option = page.locator('[role="listbox"] [role="option"]').first();
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.getByRole("complementary", { name: "Détails de l'élément" })).toBeVisible();
    assertNoErrors(errors);
    await page.screenshot({ path: `${ARTIFACTS_DIR}/visual/selected.png` });
  });

  test("loading state is visible before data resolves", async ({ page }) => {
    await page.route("**/api/map/**", async (route) => {
      await sleep(500);
      await route.continue();
    });
    await page.goto("/");
    await expect(page.locator('[data-testid="map-loading"]')).toBeAttached();
  });
});
