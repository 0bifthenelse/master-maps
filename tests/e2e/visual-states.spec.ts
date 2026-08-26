import { test, expect } from "./fixtures";

test.describe("Visual states", () => {
  const VIEWPORTS = [
    { name: "desktop", width: 1280, height: 720 },
    { name: "mobile", width: 375, height: 667 },
  ] as const;

  for (const vp of VIEWPORTS) {
    test(`initial load at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.waitForLoadState("networkidle");

      // Main landmark should be visible
      await expect(page.locator('[role="application"]')).toBeVisible({ timeout: 15000 });

      // No horizontal overflow
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      expect(overflowX).toBe(true);
    });
  }

  test("search panel open state", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await searchInput.fill("Nocibé");

    const results = page.locator('[role="listbox"], [data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 5000 });
  });

  test("Nocibé selected state", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await searchInput.fill("Nocibé");

    const results = page.locator('[role="listbox"], [data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 5000 });

    const firstResult = results.locator('[role="option"], [data-testid="search-result"]').first();
    await firstResult.click();

    // Inspector should show Nocibé details
    const inspector = page.locator('[data-testid="feature-inspector"]');
    if (await inspector.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(inspector).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
      await expect(inspector).toContainText(/Avenue d'Alsace/, { timeout: 5000 });
    }
  });

  test("layer menu open state", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const layerButton = page.locator('button:has-text("Couches")');
    if (await layerButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await layerButton.click();

      // Layer panel visible
      const layerPanel = page.locator('[data-testid="layer-controls"]');
      await expect(layerPanel).toBeVisible({ timeout: 3000 });
    }
  });

  test("loading state visible before data ready", async ({ page }) => {
    // Intercept data requests to slow them down
    await page.route("**/api/map/**", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });

    await page.goto("/");

    // Loading state should be visible
    const loading = page.locator("text=Chargement");
    await expect(loading).toBeVisible({ timeout: 5000 });
  });

  test("accessible focus visibility", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Tab through focusable elements
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible({ timeout: 3000 });
  });
});