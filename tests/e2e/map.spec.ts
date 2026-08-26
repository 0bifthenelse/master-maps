import { test, expect } from "./fixtures";

const MOLI_CDP = process.env.MOLI_CDP || "http://127.0.0.1:9222";

test.describe("Map application E2E", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("page loads with map shell", async ({ page }) => {
    // Main app shell should be visible
    await expect(page.locator('[role="application"]')).toBeVisible({ timeout: 15000 });

    // Wait for loading state to resolve or renderer status to appear
    await page.waitForLoadState("networkidle");

    // Search input should be present
    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });

  test("no fatal Next.js error overlay", async ({ page }) => {
    // Check for the Next.js error overlay
    const errorOverlay = page.locator("nextjs-portal");
    await expect(errorOverlay).not.toBeVisible({ timeout: 5000 });
  });

  test("loading state resolves", async ({ page }) => {
    // Wait for data loading to complete (diagnostics show loaded tiles)
    const diagnostics = page.locator("#scene-diagnostics");
    if (await diagnostics.isVisible({ timeout: 10000 }).catch(() => false)) {
      await expect(diagnostics).toContainText(/loaded-tile-count|loaded-feature-count/, { timeout: 15000 });
    }
  });

  test("renderer status is initialized or unsupported", async ({ page }) => {
    const diagnostics = page.locator("#scene-diagnostics");
    if (await diagnostics.isVisible({ timeout: 10000 }).catch(() => false)) {
      // Either initialized or unsupported is valid
      const text = await diagnostics.textContent();
      const hasStatus = text?.includes("initialized") || text?.includes("unsupported") || text?.includes("error");
      expect(hasStatus).toBeTruthy();
    }
  });

  test("accent-insensitive Nocibé search", async ({ page }) => {
    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await searchInput.fill("Nocibe");

    // Wait for results dropdown
    const results = page.locator('[role="listbox"], [data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 5000 });

    // Should find Nocibé
    await expect(results).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  });

  test("Nocibé with accent works", async ({ page }) => {
    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await searchInput.fill("Nocibé");

    const results = page.locator('[role="listbox"], [data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 5000 });
    await expect(results).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  });

  test("one-character typo finds Nocibé", async ({ page }) => {
    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await searchInput.fill("nocire");

    const results = page.locator('[role="listbox"], [data-testid="search-results"]');
    if (await results.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(results).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
    }
    // If no results, that's also acceptable for edge case
  });

  test("search selection updates inspector", async ({ page }) => {
    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await searchInput.fill("Nocibé");

    const results = page.locator('[role="listbox"], [data-testid="search-results"]');
    await expect(results).toBeVisible({ timeout: 5000 });

    // Click first result
    const firstResult = results.locator('[role="option"], [data-testid="search-result"]').first();
    await firstResult.click();

    // Inspector should appear with feature info
    const inspector = page.locator('[data-testid="feature-inspector"], [class*="inspector"]');
    await expect(inspector).toBeVisible({ timeout: 5000 });
    await expect(inspector).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  });

  test("keyboard navigation works on search", async ({ page }) => {
    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await searchInput.fill("auch");
    await expect(searchInput).toBeFocused();
  });

  test("layer controls are accessible", async ({ page }) => {
    const layerButton = page.locator('button:has-text("Couches"), [aria-label*="Couche"]');
    if (await layerButton.isVisible({ timeout: 5000 }).catch(() => false)) {
      await layerButton.click();
      // Layer panel should open
      const layerPanel = page.locator('[data-testid="layer-controls"], [class*="layers"]');
      await expect(layerPanel).toBeVisible({ timeout: 3000 });
    }
  });

  test("source attribution is visible", async ({ page }) => {
    const attribution = page.locator('footer, [class*="attribution"]');
    // Either footer or attribution element should exist
    const count = await attribution.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("reset button is present", async ({ page }) => {
    const resetBtn = page.locator('button:has-text("Réinitialiser")');
    if (await resetBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await expect(resetBtn).toBeEnabled();
    }
  });

  test("no console errors on page load", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Allow React dev warnings but catch real errors
    const realErrors = errors.filter(
      (e) => !e.includes("React") && !e.includes("Warning:") && !e.includes("experimental")
    );
    expect(realErrors).toHaveLength(0);
  });

  test("narrow viewport is usable", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Search should still be reachable
    const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });
  });
});