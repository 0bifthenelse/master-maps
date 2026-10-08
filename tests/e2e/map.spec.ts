import { test, expect, checkPngNotBlank, ARTIFACTS_DIR } from "./fixtures";
import { camera, diagnostic, mapToScreen, openMap, screenToMap, settle, stageBox, viewHash } from "./helpers";

test.describe("WebGL map", () => {
  test("renders the Gers in WebGL without errors", async ({ page, errors }) => {
    await openMap(page);
    expect(["webgl", "webgl2"]).toContain(await diagnostic(page, "backend"));
    await expect(page.locator("nextjs-portal")).toHaveCount(0);
    const path = `${ARTIFACTS_DIR}/render-overview.png`;
    await page.locator(".mm-stage").screenshot({ path });
    expect(checkPngNotBlank(path).notBlank).toBe(true);
    expect(errors.pageErrors).toEqual([]);
  });

  for (const [bearing, pitch] of [[0, 0], [45, 0], [0, 45], [-30, 40]] as const) {
    test(`keeps the point under the cursor fixed while wheel-zooming (bearing ${bearing}°, tilt ${pitch}°)`, async ({ page }) => {
      await openMap(page, viewHash(14, undefined, undefined, bearing, pitch));
      const box = await stageBox(page);
      const x = box.width * 0.32;
      const y = box.height * 0.6;
      const anchor = await screenToMap(page, x, y);
      const before = await camera(page);
      await page.mouse.move(box.x + x, box.y + y);
      await page.mouse.wheel(0, -240);
      const after = await settle(page);
      expect(after.zoom).toBeGreaterThan(before.zoom + 0.5);
      const [sx, sy] = await mapToScreen(page, anchor);
      expect(Math.abs(sx - x)).toBeLessThan(3);
      expect(Math.abs(sy - y)).toBeLessThan(3);
      await page.mouse.wheel(0, 240);
      const back = await settle(page);
      expect(back.zoom).toBeLessThan(after.zoom - 0.5);
      const [bx, by] = await mapToScreen(page, anchor);
      expect(Math.hypot(bx - x, by - y)).toBeLessThan(3);
    });
  }

  test("drags the map with the pointer", async ({ page }) => {
    await openMap(page, viewHash(15));
    const box = await stageBox(page);
    const start = { x: box.width * 0.5, y: box.height * 0.5 };
    const grabbed = await screenToMap(page, start.x, start.y);
    await page.mouse.move(box.x + start.x, box.y + start.y);
    await page.mouse.down();
    await page.mouse.move(box.x + start.x + 180, box.y + start.y + 90, { steps: 12 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    await settle(page);
    const [sx, sy] = await mapToScreen(page, grabbed);
    expect(Math.abs(sx - (start.x + 180))).toBeLessThan(4);
    expect(Math.abs(sy - (start.y + 90))).toBeLessThan(4);
  });

  test("right-drag turns the map clockwise and tilts it, and the compass agrees", async ({ page }) => {
    await openMap(page, viewHash(15));
    const box = await stageBox(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up({ button: "right" });
    const turned = await settle(page);
    expect(turned.headingRadians).toBeGreaterThan(0.2);
    /* Turning the map is not a right-click: no context menu, even where the browser asks for one on press. */
    await expect(page.getByRole("menu")).toHaveCount(0);
    const degrees = Math.round((((turned.headingRadians * 180) / Math.PI) % 360 + 360) % 360);
    await expect(page.locator(".mm-compass")).toHaveAttribute("aria-label", new RegExp(`heading ${degrees} degrees`));

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 120, { steps: 10 });
    await page.mouse.up({ button: "right" });
    const tilted = await settle(page);
    expect(tilted.pitchRadians).toBeGreaterThan(0.3);

    await page.locator(".mm-compass").click();
    const north = await settle(page);
    expect(Math.abs(north.headingRadians)).toBeLessThan(1e-3);
    expect(north.pitchRadians).toBeLessThan(1e-3);
  });

  test("a right-click without moving opens the context menu", async ({ page }) => {
    await openMap(page, viewHash(15));
    const box = await stageBox(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu).toContainText(/What's here|Open details/i);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("H J K L and the arrows reveal the map in that direction", async ({ page }) => {
    await openMap(page, viewHash(15));
    const start = await camera(page);
    await page.keyboard.press("l");
    const east = await settle(page);
    expect(east.target[0]).toBeGreaterThan(start.target[0] + 20);
    await page.keyboard.press("k");
    const north = await settle(page);
    expect(north.target[2]).toBeGreaterThan(east.target[2] + 20);
    await page.keyboard.press("ArrowLeft");
    const west = await settle(page);
    expect(west.target[0]).toBeLessThan(north.target[0] - 20);
  });

  test("typing in the search box never moves the map", async ({ page }) => {
    await openMap(page, viewHash(15));
    const start = await camera(page);
    await page.getByTestId("search-input").click();
    await page.keyboard.type("hjkl+-");
    await page.waitForTimeout(400);
    const after = await camera(page);
    expect(after.target).toEqual(start.target);
    expect(after.zoom).toBe(start.zoom);
  });

  test("restores a shared view from the URL", async ({ page }) => {
    await openMap(page, viewHash(16.5, 43.9386, 0.3722, 30, 20));
    const view = await camera(page);
    expect(view.zoom).toBeCloseTo(16.5, 1);
    expect((view.headingRadians * 180) / Math.PI).toBeCloseTo(30, 0);
    expect((view.pitchRadians * 180) / Math.PI).toBeCloseTo(20, 0);
  });

  test("switches to satellite imagery", async ({ page }) => {
    await openMap(page, viewHash(16));
    await page.getByLabel("Switch to satellite imagery").click();
    await expect(page.locator(".mm-shell")).toHaveAttribute("data-basemap", "satellite");
  });

  test("stays usable on a phone-sized screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openMap(page);
    await expect(page.getByTestId("search-input")).toBeVisible();
    await expect(page.getByLabel("Zoom in")).toBeVisible();
    const path = `${ARTIFACTS_DIR}/render-mobile.png`;
    await page.locator(".mm-stage").screenshot({ path });
    expect(checkPngNotBlank(path).notBlank).toBe(true);
  });
});
