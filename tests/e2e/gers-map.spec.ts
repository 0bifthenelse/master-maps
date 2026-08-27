import { test, expect } from "@playwright/test";

test.describe("Gers map streaming", () => {
  test("serves department metadata without requesting every tile", async ({ page }) => {
    const tileRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/map/tile/")) tileRequests.push(request.url());
    });
    await page.goto("/");
    const manifestResponse = await page.request.get("/api/map/manifest");
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json() as { territoryCode?: string; tiles?: unknown[]; tileIds?: unknown[] };
    expect(manifest.territoryCode).toBe("32");
    await expect(page.locator("#scene-diagnostics")).toBeAttached();
    expect(tileRequests.length).toBeLessThan(Math.max(1, (manifest.tiles ?? manifest.tileIds ?? []).length));
  });
});
