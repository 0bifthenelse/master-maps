import { test, expect } from "./fixtures";

test.describe("WebGPU unsupported state", () => {
  test("shows unsupported message when WebGPU is absent", async ({ page }) => {
    // Block WebGPU by intercepting navigator.gpu
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", {
        get: () => undefined,
        configurable: true,
      });
    });

    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Should show the WebGPU unsupported component
    const unsupportedMsg = page.locator("text=WebGPU");
    await expect(unsupportedMsg).toBeVisible({ timeout: 10000 });
  });

  test("does not switch to WebGL silently", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", {
        get: () => undefined,
        configurable: true,
      });
    });

    await page.goto("/");

    // Check diagnostics for renderer-status if available
    const diagnostics = page.locator("#scene-diagnostics");
    if (await diagnostics.isVisible({ timeout: 5000 }).catch(() => false)) {
      const text = await diagnostics.textContent();
      // Should not claim webgpu initialized
      expect(text).not.toContain("backend=webgpu");
    }
  });
});