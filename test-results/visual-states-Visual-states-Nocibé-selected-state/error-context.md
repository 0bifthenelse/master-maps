# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: visual-states.spec.ts >> Visual states >> Nocibé selected state
- Location: tests/e2e/visual-states.spec.ts:35:7

# Error details

```
TimeoutError: locator.fill: Timeout 10000ms exceeded.
Call log:
  - waiting for locator('input[type="search"], input[placeholder*="Rechercher"]')

```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - application "Carte interactive d'Auch" [ref=e2]:
    - generic [ref=e3]:
      - generic [ref=e5]:
        - heading "Impossible de charger la carte" [level=2] [ref=e6]
        - paragraph [ref=e7]: "DATASET_UNAVAILABLE: 503 {\"error\":\"DATASET_UNAVAILABLE\",\"code\":\"DATASET_UNAVAILABLE\"}"
        - paragraph [ref=e8]:
          - text: Vérifiez que les données sont générées avec
          - code [ref=e9]: npm run data:refresh
          - text: .
      - generic: "renderer-status=unsupported │ backend=webgpu │ loaded-tile-count=0 │ loaded-feature-count=0 │ building-count=unknown │ road-count=unknown │ poi-count=unknown │ draw-calls=unknown │ camera-state=idle │ renderer-error=DATASET_UNAVAILABLE: 503 {\"error\":\"DATASET_UNAVAILABLE\",\"code\":\"DATASET_UNAVAILABLE\"}"
  - alert [ref=e11]
```

# Test source

```ts
  1  | import { test, expect } from "./fixtures";
  2  | 
  3  | test.describe("Visual states", () => {
  4  |   const VIEWPORTS = [
  5  |     { name: "desktop", width: 1280, height: 720 },
  6  |     { name: "mobile", width: 375, height: 667 },
  7  |   ] as const;
  8  | 
  9  |   for (const vp of VIEWPORTS) {
  10 |     test(`initial load at ${vp.name}`, async ({ page }) => {
  11 |       await page.setViewportSize({ width: vp.width, height: vp.height });
  12 |       await page.goto("/");
  13 |       await page.waitForLoadState("networkidle");
  14 | 
  15 |       // Main landmark should be visible
  16 |       await expect(page.locator('[role="application"]')).toBeVisible({ timeout: 15000 });
  17 | 
  18 |       // No horizontal overflow
  19 |       const overflowX = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  20 |       expect(overflowX).toBe(true);
  21 |     });
  22 |   }
  23 | 
  24 |   test("search panel open state", async ({ page }) => {
  25 |     await page.goto("/");
  26 |     await page.waitForLoadState("networkidle");
  27 | 
  28 |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
  29 |     await searchInput.fill("Nocibé");
  30 | 
  31 |     const results = page.locator('[role="listbox"], [data-testid="search-results"]');
  32 |     await expect(results).toBeVisible({ timeout: 5000 });
  33 |   });
  34 | 
  35 |   test("Nocibé selected state", async ({ page }) => {
  36 |     await page.goto("/");
  37 |     await page.waitForLoadState("networkidle");
  38 | 
  39 |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
> 40 |     await searchInput.fill("Nocibé");
     |                       ^ TimeoutError: locator.fill: Timeout 10000ms exceeded.
  41 | 
  42 |     const results = page.locator('[role="listbox"], [data-testid="search-results"]');
  43 |     await expect(results).toBeVisible({ timeout: 5000 });
  44 | 
  45 |     const firstResult = results.locator('[role="option"], [data-testid="search-result"]').first();
  46 |     await firstResult.click();
  47 | 
  48 |     // Inspector should show Nocibé details
  49 |     const inspector = page.locator('[data-testid="feature-inspector"]');
  50 |     if (await inspector.isVisible({ timeout: 5000 }).catch(() => false)) {
  51 |       await expect(inspector).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  52 |       await expect(inspector).toContainText(/Avenue d'Alsace/, { timeout: 5000 });
  53 |     }
  54 |   });
  55 | 
  56 |   test("layer menu open state", async ({ page }) => {
  57 |     await page.goto("/");
  58 |     await page.waitForLoadState("networkidle");
  59 | 
  60 |     const layerButton = page.locator('button:has-text("Couches")');
  61 |     if (await layerButton.isVisible({ timeout: 5000 }).catch(() => false)) {
  62 |       await layerButton.click();
  63 | 
  64 |       // Layer panel visible
  65 |       const layerPanel = page.locator('[data-testid="layer-controls"]');
  66 |       await expect(layerPanel).toBeVisible({ timeout: 3000 });
  67 |     }
  68 |   });
  69 | 
  70 |   test("loading state visible before data ready", async ({ page }) => {
  71 |     // Intercept data requests to slow them down
  72 |     await page.route("**/api/map/**", async (route) => {
  73 |       await new Promise((r) => setTimeout(r, 2000));
  74 |       await route.continue();
  75 |     });
  76 | 
  77 |     await page.goto("/");
  78 | 
  79 |     // Loading state should be visible
  80 |     const loading = page.locator("text=Chargement");
  81 |     await expect(loading).toBeVisible({ timeout: 5000 });
  82 |   });
  83 | 
  84 |   test("accessible focus visibility", async ({ page }) => {
  85 |     await page.goto("/");
  86 |     await page.waitForLoadState("networkidle");
  87 | 
  88 |     // Tab through focusable elements
  89 |     await page.keyboard.press("Tab");
  90 |     const focused = page.locator(":focus");
  91 |     await expect(focused).toBeVisible({ timeout: 3000 });
  92 |   });
  93 | });
```