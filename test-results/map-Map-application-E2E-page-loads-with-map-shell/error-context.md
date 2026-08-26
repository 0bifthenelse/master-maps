# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: map.spec.ts >> Map application E2E >> page loads with map shell
- Location: tests/e2e/map.spec.ts:10:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('input[type="search"], input[placeholder*="Rechercher"]')
Expected: visible
Timeout: 10000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 10000ms
  - waiting for locator('input[type="search"], input[placeholder*="Rechercher"]')

```

```yaml
- application "Carte interactive d'Auch":
  - heading "Impossible de charger la carte" [level=2]
  - paragraph: "DATASET_UNAVAILABLE: 503 {\"error\":\"DATASET_UNAVAILABLE\",\"code\":\"DATASET_UNAVAILABLE\"}"
  - paragraph:
    - text: Vérifiez que les données sont générées avec
    - code: npm run data:refresh
    - text: .
- alert
```

# Test source

```ts
  1   | import { test, expect } from "./fixtures";
  2   | 
  3   | const MOLI_CDP = process.env.MOLI_CDP || "http://127.0.0.1:9222";
  4   | 
  5   | test.describe("Map application E2E", () => {
  6   |   test.beforeEach(async ({ page }) => {
  7   |     await page.goto("/");
  8   |   });
  9   | 
  10  |   test("page loads with map shell", async ({ page }) => {
  11  |     // Main app shell should be visible
  12  |     await expect(page.locator('[role="application"]')).toBeVisible({ timeout: 15000 });
  13  | 
  14  |     // Wait for loading state to resolve or renderer status to appear
  15  |     await page.waitForLoadState("networkidle");
  16  | 
  17  |     // Search input should be present
  18  |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
> 19  |     await expect(searchInput).toBeVisible({ timeout: 10000 });
      |                               ^ Error: expect(locator).toBeVisible() failed
  20  |   });
  21  | 
  22  |   test("no fatal Next.js error overlay", async ({ page }) => {
  23  |     // Check for the Next.js error overlay
  24  |     const errorOverlay = page.locator("nextjs-portal");
  25  |     await expect(errorOverlay).not.toBeVisible({ timeout: 5000 });
  26  |   });
  27  | 
  28  |   test("loading state resolves", async ({ page }) => {
  29  |     // Wait for data loading to complete (diagnostics show loaded tiles)
  30  |     const diagnostics = page.locator("#scene-diagnostics");
  31  |     if (await diagnostics.isVisible({ timeout: 10000 }).catch(() => false)) {
  32  |       await expect(diagnostics).toContainText(/loaded-tile-count|loaded-feature-count/, { timeout: 15000 });
  33  |     }
  34  |   });
  35  | 
  36  |   test("renderer status is initialized or unsupported", async ({ page }) => {
  37  |     const diagnostics = page.locator("#scene-diagnostics");
  38  |     if (await diagnostics.isVisible({ timeout: 10000 }).catch(() => false)) {
  39  |       // Either initialized or unsupported is valid
  40  |       const text = await diagnostics.textContent();
  41  |       const hasStatus = text?.includes("initialized") || text?.includes("unsupported") || text?.includes("error");
  42  |       expect(hasStatus).toBeTruthy();
  43  |     }
  44  |   });
  45  | 
  46  |   test("accent-insensitive Nocibé search", async ({ page }) => {
  47  |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
  48  |     await searchInput.fill("Nocibe");
  49  | 
  50  |     // Wait for results dropdown
  51  |     const results = page.locator('[role="listbox"], [data-testid="search-results"]');
  52  |     await expect(results).toBeVisible({ timeout: 5000 });
  53  | 
  54  |     // Should find Nocibé
  55  |     await expect(results).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  56  |   });
  57  | 
  58  |   test("Nocibé with accent works", async ({ page }) => {
  59  |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
  60  |     await searchInput.fill("Nocibé");
  61  | 
  62  |     const results = page.locator('[role="listbox"], [data-testid="search-results"]');
  63  |     await expect(results).toBeVisible({ timeout: 5000 });
  64  |     await expect(results).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  65  |   });
  66  | 
  67  |   test("one-character typo finds Nocibé", async ({ page }) => {
  68  |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
  69  |     await searchInput.fill("nocire");
  70  | 
  71  |     const results = page.locator('[role="listbox"], [data-testid="search-results"]');
  72  |     if (await results.isVisible({ timeout: 5000 }).catch(() => false)) {
  73  |       await expect(results).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  74  |     }
  75  |     // If no results, that's also acceptable for edge case
  76  |   });
  77  | 
  78  |   test("search selection updates inspector", async ({ page }) => {
  79  |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
  80  |     await searchInput.fill("Nocibé");
  81  | 
  82  |     const results = page.locator('[role="listbox"], [data-testid="search-results"]');
  83  |     await expect(results).toBeVisible({ timeout: 5000 });
  84  | 
  85  |     // Click first result
  86  |     const firstResult = results.locator('[role="option"], [data-testid="search-result"]').first();
  87  |     await firstResult.click();
  88  | 
  89  |     // Inspector should appear with feature info
  90  |     const inspector = page.locator('[data-testid="feature-inspector"], [class*="inspector"]');
  91  |     await expect(inspector).toBeVisible({ timeout: 5000 });
  92  |     await expect(inspector).toContainText(/[Nn]ocib[eé]/, { timeout: 5000 });
  93  |   });
  94  | 
  95  |   test("keyboard navigation works on search", async ({ page }) => {
  96  |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
  97  |     await searchInput.fill("auch");
  98  |     await expect(searchInput).toBeFocused();
  99  |   });
  100 | 
  101 |   test("layer controls are accessible", async ({ page }) => {
  102 |     const layerButton = page.locator('button:has-text("Couches"), [aria-label*="Couche"]');
  103 |     if (await layerButton.isVisible({ timeout: 5000 }).catch(() => false)) {
  104 |       await layerButton.click();
  105 |       // Layer panel should open
  106 |       const layerPanel = page.locator('[data-testid="layer-controls"], [class*="layers"]');
  107 |       await expect(layerPanel).toBeVisible({ timeout: 3000 });
  108 |     }
  109 |   });
  110 | 
  111 |   test("source attribution is visible", async ({ page }) => {
  112 |     const attribution = page.locator('footer, [class*="attribution"]');
  113 |     // Either footer or attribution element should exist
  114 |     const count = await attribution.count();
  115 |     expect(count).toBeGreaterThanOrEqual(0);
  116 |   });
  117 | 
  118 |   test("reset button is present", async ({ page }) => {
  119 |     const resetBtn = page.locator('button:has-text("Réinitialiser")');
```