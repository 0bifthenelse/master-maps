# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: map.spec.ts >> Map application E2E >> no console errors on page load
- Location: tests/e2e/map.spec.ts:125:7

# Error details

```
Error: expect(received).toHaveLength(expected)

Expected length: 0
Received length: 1
Received array:  ["Failed to load resource: the server responded with a status of 503 (Service Unavailable)"]
```

# Page snapshot

```yaml
- generic [active] [ref=f1e1]:
  - application "Carte interactive d'Auch" [ref=f1e2]:
    - generic [ref=f1e3]:
      - generic [ref=f1e5]:
        - heading "Impossible de charger la carte" [level=2] [ref=f1e6]
        - paragraph [ref=f1e7]: "DATASET_UNAVAILABLE: 503 {\"error\":\"DATASET_UNAVAILABLE\",\"code\":\"DATASET_UNAVAILABLE\"}"
        - paragraph [ref=f1e8]:
          - text: Vérifiez que les données sont générées avec
          - code [ref=f1e9]: npm run data:refresh
          - text: .
      - generic: "renderer-status=unsupported │ backend=webgpu │ loaded-tile-count=0 │ loaded-feature-count=0 │ building-count=unknown │ road-count=unknown │ poi-count=unknown │ draw-calls=unknown │ camera-state=idle │ renderer-error=DATASET_UNAVAILABLE: 503 {\"error\":\"DATASET_UNAVAILABLE\",\"code\":\"DATASET_UNAVAILABLE\"}"
  - alert [ref=f1e11]
```

# Test source

```ts
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
  120 |     if (await resetBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
  121 |       await expect(resetBtn).toBeEnabled();
  122 |     }
  123 |   });
  124 | 
  125 |   test("no console errors on page load", async ({ page }) => {
  126 |     const errors: string[] = [];
  127 |     page.on("console", (msg) => {
  128 |       if (msg.type() === "error") {
  129 |         errors.push(msg.text());
  130 |       }
  131 |     });
  132 |     await page.goto("/");
  133 |     await page.waitForLoadState("networkidle");
  134 | 
  135 |     // Allow React dev warnings but catch real errors
  136 |     const realErrors = errors.filter(
  137 |       (e) => !e.includes("React") && !e.includes("Warning:") && !e.includes("experimental")
  138 |     );
> 139 |     expect(realErrors).toHaveLength(0);
      |                        ^ Error: expect(received).toHaveLength(expected)
  140 |   });
  141 | 
  142 |   test("narrow viewport is usable", async ({ page }) => {
  143 |     await page.setViewportSize({ width: 375, height: 667 });
  144 |     await page.goto("/");
  145 |     await page.waitForLoadState("networkidle");
  146 | 
  147 |     // Search should still be reachable
  148 |     const searchInput = page.locator('input[type="search"], input[placeholder*="Rechercher"]');
  149 |     await expect(searchInput).toBeVisible({ timeout: 10000 });
  150 |   });
  151 | });
```