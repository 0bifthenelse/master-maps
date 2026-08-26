import { test, expect, checkPngNotBlank, ARTIFACTS_DIR, type BrowserErrors } from "./fixtures";
import type { Page } from "@playwright/test";

async function waitForScene(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const diagnostics = document.querySelector("#scene-diagnostics");
    if (!diagnostics) return false;
    const status = diagnostics.getAttribute("data-renderer-status");
    const tiles = Number(diagnostics.getAttribute("data-loaded-tile-count"));
    const features = Number(diagnostics.getAttribute("data-loaded-feature-count"));
    const draws = Number(diagnostics.getAttribute("data-draw-calls"));
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

function assertNoRuntimeErrors(errors: BrowserErrors): void {
  expect(errors.pageErrors, "pageerror events").toEqual([]);
  expect(errors.consoleErrors, "console.error events").toEqual([]);
}

test.describe("Map application E2E", () => {
  test.beforeEach(async ({ page, errors }) => {
    await page.goto("/");
    await waitForScene(page);
    assertNoRuntimeErrors(errors);
    const unhandled = await page.evaluate(() => {
      const state = window as unknown as { __unhandledRejections?: string[] };
      return state.__unhandledRejections ?? [];
    });
    expect(unhandled, "unhandled promise rejections").toEqual([]);
  });

  test("renders the loaded Auch map, not an empty canvas", async ({ page }) => {
    await expect(page.locator('[role="application"]')).toBeVisible();
    await expect(page.locator("#scene-diagnostics")).toHaveCount(1);
    const diagnostics = page.locator("#scene-diagnostics");
    const attrs = await diagnostics.evaluate((element) => ({
      status: element.getAttribute("data-renderer-status"),
      backend: element.getAttribute("data-backend"),
      tiles: Number(element.getAttribute("data-loaded-tile-count")),
      features: Number(element.getAttribute("data-loaded-feature-count")),
      buildings: Number(element.getAttribute("data-building-count")),
      roads: Number(element.getAttribute("data-road-count")),
      pois: Number(element.getAttribute("data-poi-count")),
      draws: Number(element.getAttribute("data-draw-calls")),
      camera: element.getAttribute("data-camera-state"),
      error: element.getAttribute("data-renderer-error"),
    }));
    expect(attrs.tiles).toBeGreaterThan(0);
    expect(attrs.features).toBeGreaterThan(0);
    expect(["initialized", "unsupported"]).toContain(attrs.status);
    if (attrs.status === "unsupported") {
      expect(attrs.error).not.toBe("none");
      await page.screenshot({ path: `${ARTIFACTS_DIR}/map/default.png` });
      return;
    }
    expect(attrs.backend).toBe("webgpu");
    expect(attrs.buildings + attrs.roads + attrs.pois).toBeGreaterThan(0);
    expect(attrs.draws).toBeGreaterThan(0);
    expect(attrs.camera).not.toBe("unknown");
    expect(attrs.error).toBe("none");

    const canvas = page.locator("canvas");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
    const screenshotPath = `${ARTIFACTS_DIR}/map/default-canvas.png`;
    await canvas.screenshot({ path: screenshotPath });
    const content = checkPngNotBlank(screenshotPath);
    expect(content.notBlank, content.reason).toBe(true);
  });

  test("has no fatal Next.js error overlay", async ({ page }) => {
    await expect(page.locator("nextjs-portal")).not.toBeVisible();
  });

  test("search selection focuses a loaded feature", async ({ page }) => {
    const searchInput = page.locator('input[type="search"]');
    await searchInput.fill("Nocibé");
    const results = page.locator('[role="listbox"]');
    await expect(results).toBeVisible();
    await expect(results).toContainText(/[Nn]ocib[eé]/);
    await results.locator('[role="option"]').first().click();
    await expect(page.getByRole("complementary", { name: "Détails de l'élément" })).toBeVisible();
    await page.screenshot({ path: `${ARTIFACTS_DIR}/map/nocibe-selected.png` });
  });

  test("layer controls remain accessible", async ({ page }) => {
    const layerButton = page.locator('button:has-text("Couches"), [aria-label*="Couche"]');
    if (await layerButton.isVisible()) {
      await layerButton.click();
      await expect(page.locator('[data-testid="layer-controls"], [class*="layers"]')).toBeVisible();
    }
  });

  test("source attribution and reset remain visible", async ({ page }) => {
    await expect(page.getByRole("contentinfo", { name: "Sources et attribution" })).toBeVisible();
    const reset = page.locator('button:has-text("Réinitialiser")');
    if (await reset.count()) await expect(reset).toBeEnabled();
  });

  test("narrow viewport keeps the map surface usable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    await expect(page.locator('input[type="search"]')).toBeVisible();
    const state = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (state !== "initialized") return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);
  });
});
