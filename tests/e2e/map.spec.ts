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

async function readCameraState(page: Page): Promise<{ x: number; z: number; zoom: number }> {
  const diagnostics = page.locator("#scene-diagnostics");
  return diagnostics.evaluate((element) => ({
    x: Number(element.getAttribute("data-camera-target-x")),
    z: Number(element.getAttribute("data-camera-target-z")),
    zoom: Number(element.getAttribute("data-camera-zoom")),
  }));
}
type FullCameraState = {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  azimuthalAngle: number;
  headingRadians?: number;
  rotationZ?: number;
};

async function readFullCameraState(page: Page): Promise<FullCameraState> {
  const serialized = await page.locator("#scene-diagnostics").getAttribute("data-camera-state");
  if (!serialized) throw new Error("camera-state diagnostic is missing");
  return JSON.parse(serialized) as FullCameraState;
}

async function moveToSourceCoordinate(
  page: Page,
  coordinate: [number, number],
): Promise<void> {
  const manifest = await page.evaluate(async () => {
    const response = await fetch("/api/map/manifest");
    return await response.json() as {
      bounds: [number, number, number, number];
      projectionOrigin: [number, number];
    };
  });
  const camera = await readFullCameraState(page);
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas has no bounding box");
  const [originLon, originLat] = manifest.projectionOrigin;
  const metersPerDegree = 111_319.9;
  const originCosine = Math.cos(originLat * Math.PI / 180);
  const localX = (coordinate[0] - originLon) * metersPerDegree * originCosine;
  const localZ = (coordinate[1] - originLat) * metersPerDegree;
  const worldWidth = manifest.bounds[2] - manifest.bounds[0];
  const worldHeight = manifest.bounds[3] - manifest.bounds[1];
  const aspect = box.width / box.height;
  const frustumWidth = worldWidth / worldHeight > aspect
    ? worldWidth * 1.15
    : worldHeight * aspect * 1.15;
  const frustumHeight = worldWidth / worldHeight > aspect
    ? worldWidth / aspect * 1.15
    : worldHeight * 1.15;
  await page.mouse.move(
    box.x + box.width / 2 + (localX - camera.target[0]) * camera.zoom / frustumWidth * box.width,
    box.y + box.height / 2 - (localZ - camera.target[2]) * camera.zoom / frustumHeight * box.height,
  );
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
      water: Number(element.getAttribute("data-water-count")),
      businesses: Number(element.getAttribute("data-business-count")),
      draws: Number(element.getAttribute("data-draw-calls")),
      cameraTargetX: Number(element.getAttribute("data-camera-target-x")),
      cameraTargetZ: Number(element.getAttribute("data-camera-target-z")),
      cameraZoom: Number(element.getAttribute("data-camera-zoom")),
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
    expect(attrs.water).toBeGreaterThan(0);
    expect(attrs.businesses).toBeGreaterThan(0);
    expect(attrs.backend).toBe("webgpu");
    expect(attrs.buildings + attrs.roads + attrs.pois).toBeGreaterThan(0);
    expect(attrs.draws).toBeGreaterThan(0);
    expect(attrs.cameraZoom).toBeGreaterThan(0);
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
    await expect(results).toContainText(/nocib[eé]/i);
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

  test("H J K L move the camera in compass directions", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const canvas = page.locator("canvas");
    await canvas.click();
    const before = await readCameraState(page);
    await page.keyboard.press("KeyL"); // east
    await page.waitForFunction(
      (prevX) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) !== prevX,
      before.x,
      { timeout: 5000 },
    );
    const afterEast = await readCameraState(page);
    expect(afterEast.x).toBeGreaterThan(before.x);

    await page.keyboard.press("KeyK"); // north
    await page.waitForFunction(
      (prevZ) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-z")) !== prevZ,
      afterEast.z,
      { timeout: 5000 },
    );
    const afterNorth = await readCameraState(page);
    expect(afterNorth.z).toBeGreaterThan(afterEast.z);
    await page.keyboard.press("KeyH"); // west
    await page.waitForFunction(
      (prevX) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) !== prevX,
      afterNorth.x,
      { timeout: 5000 },
    );
    const afterWest = await readCameraState(page);
    expect(afterWest.x).toBeLessThan(afterNorth.x);

    await page.keyboard.press("KeyJ"); // south
    await page.waitForFunction(
      (prevZ) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-z")) !== prevZ,
      afterWest.z,
      { timeout: 5000 },
    );
    const afterSouth = await readCameraState(page);
    expect(afterSouth.z).toBeLessThan(afterWest.z);
  });

  test("H J K L do nothing while the search input is focused", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const searchInput = page.locator('input[type="search"]');
    await searchInput.focus();
    const before = await readCameraState(page);
    await page.keyboard.press("KeyH");
    await page.keyboard.press("KeyJ");
    await page.keyboard.press("KeyK");
    await page.keyboard.press("KeyL");
    await page.waitForTimeout(300);
    const after = await readCameraState(page);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
  });

  test("mouse drag pans the map", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    const before = await readCameraState(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 10 });
    await page.mouse.up();
    await page.waitForFunction(
      (prevX) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) !== prevX,
      before.x,
      { timeout: 5000 },
    );
    const after = await readCameraState(page);
    expect(after.x !== before.x || after.z !== before.z).toBe(true);
  });

  test("mouse wheel zooms in and out", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    const before = await readCameraState(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400); // zoom in
    await page.waitForFunction(
      (prevZoom) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-zoom")) !== prevZoom,
      before.zoom,
      { timeout: 5000 },
    );
    const zoomedIn = await readCameraState(page);
    expect(zoomedIn.zoom).toBeGreaterThan(before.zoom);
  });

  test("right-click drag rotates the top-down map heading", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");

    const before = await readFullCameraState(page);
    const headingBefore = (before as FullCameraState).headingRadians ?? (before as FullCameraState).rotationZ ?? before.azimuthalAngle;
    const targetBefore = [...before.target] as [number, number, number];

    // Right-drag horizontally to rotate heading
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up({ button: "right" });

    await page.waitForFunction(
      (prev: number) => {
        const s = document.getElementById("scene-diagnostics")?.getAttribute("data-camera-state");
        if (!s) return false;
        try {
          const j = JSON.parse(s) as FullCameraState;
          const h = j.headingRadians ?? j.rotationZ ?? j.azimuthalAngle;
          return Math.abs(h - prev) > 0.2;
        } catch {
          return false;
        }
      },
      headingBefore,
      { timeout: 5000 },
    );

    const after = await readFullCameraState(page);
    const headingAfter = (after as FullCameraState).headingRadians ?? (after as FullCameraState).rotationZ ?? after.azimuthalAngle;
    expect(Math.abs(headingAfter - headingBefore)).toBeGreaterThan(0.2);
    // Target must not have materially moved during rotation (pan threshold 50m vs 3000m world)
    const moved = Math.hypot(after.target[0] - targetBefore[0], after.target[2] - targetBefore[2]);
    expect(moved).toBeLessThan(50);

    // Rotation persists after pointer release
    await page.waitForTimeout(500);
    const persisted = await readFullCameraState(page);
    const headingPersisted = (persisted as FullCameraState).headingRadians ?? (persisted as FullCameraState).rotationZ ?? persisted.azimuthalAngle;
    expect(Math.abs(headingPersisted - headingAfter)).toBeLessThan(0.05);

    // Left drag still pans
    const beforePan = await readCameraState(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down({ button: "left" });
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, { steps: 10 });
    await page.mouse.up({ button: "left" });
    await page.waitForFunction(
      (prevX: number) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) !== prevX,
      beforePan.x,
      { timeout: 5000 },
    );
    const afterPan = await readCameraState(page);
    expect(afterPan.x !== beforePan.x || afterPan.z !== beforePan.z).toBe(true);

    // Wheel still zooms
    const beforeZoom = await readCameraState(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForFunction(
      (prevZoom: number) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-zoom")) !== prevZoom,
      beforeZoom.zoom,
      { timeout: 5000 },
    );
    const afterZoom = await readCameraState(page);
    expect(afterZoom.zoom).toBeGreaterThan(beforeZoom.zoom);

    // Reset restores corrected default heading (0)
    const reset = page.locator('button:has-text("Réinitialiser")');
    await reset.click();
    await page.waitForFunction(
      () => {
        const s = document.getElementById("scene-diagnostics")?.getAttribute("data-camera-state");
        if (!s) return false;
        try {
          const j = JSON.parse(s) as FullCameraState;
          const h = j.headingRadians ?? j.rotationZ ?? j.azimuthalAngle;
          return Math.abs(h) < 0.08;
        } catch {
          return false;
        }
      },
      undefined,
      { timeout: 5000 },
    );
    const afterReset = await readFullCameraState(page);
    const headingReset = (afterReset as FullCameraState).headingRadians ?? (afterReset as FullCameraState).rotationZ ?? afterReset.azimuthalAngle;
    expect(Math.abs(headingReset)).toBeLessThan(0.08);

    // No native context menu should have appeared (page should not have been blocked)
    // Verify canvas still responsive after right-drag
    await expect(page.locator("canvas")).toBeVisible();
  });

  test("searching a street centers the camera on its geometry", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const before = await readCameraState(page);
    const searchInput = page.locator('input[type="search"]');
    await searchInput.fill("Avenue d'Alsace");
    const results = page.locator('[role="listbox"]');
    await expect(results).toBeVisible();
    await results.locator('[role="option"]').first().click();
    await page.waitForFunction(
      (prevX) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) !== prevX,
      before.x,
      { timeout: 5000 },
    );
    const after = await readCameraState(page);
    expect(after.x !== before.x || after.z !== before.z).toBe(true);
  });

  test("reset view returns to the full-commune fit after pan and search", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const initial = await readCameraState(page);

    const searchInput = page.locator('input[type="search"]');
    await searchInput.fill("Nocibé");
    const results = page.locator('[role="listbox"]');
    await expect(results).toBeVisible();
    await results.locator('[role="option"]').first().click();
    await page.waitForFunction(
      (prevX) => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) !== prevX,
      initial.x,
      { timeout: 5000 },
    );

    const reset = page.locator('button:has-text("Réinitialiser")');
    await reset.click();
    await page.waitForFunction(
      (prevX) => Math.abs(Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-target-x")) - prevX) < 0.5,
      initial.x,
      { timeout: 5000 },
    );
    const afterReset = await readCameraState(page);
    expect(afterReset.x).toBeCloseTo(initial.x, 0);
    expect(afterReset.z).toBeCloseTo(initial.z, 0);
    const northUp = await readFullCameraState(page);
    expect(northUp.position[1]).toBeGreaterThan(0);
    expect(northUp.azimuthalAngle).toBeCloseTo(0, 6);
    expect(afterReset.zoom).toBeCloseTo(initial.zoom, 6);

    await searchInput.fill("Nocibé");
    await expect(results).toBeVisible();
  });

  test("hovers an individual business marker and clears on exit", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;

    const records = await page.evaluate(async () => {
      const response = await fetch("/api/map/search?q=NOCIBE");
      return await response.json() as Array<{
        featureId: string;
        canonicalName: string;
        kind: string;
        focusLon: number;
        focusLat: number;
      }>;
    });
    const business = records.find((record) => record.kind === "business");
    expect(business).toBeDefined();
    if (!business) return;

    const input = page.locator('[data-testid="search-input"]');
    await input.fill("NOCIBE");
    const option = page.locator('[role="option"][data-feature-kind="business"]').first();
    await expect(option).toBeVisible();
    await option.click();
    await page.waitForTimeout(500);

    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    if (!box) throw new Error("canvas has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -1200);
    await page.waitForFunction(
      () => Number(document.getElementById("scene-diagnostics")?.getAttribute("data-camera-zoom")) > 1,
      undefined,
      { timeout: 5000 },
    );
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.waitForTimeout(100);
    await moveToSourceCoordinate(page, [business.focusLon, business.focusLat]);

    const popup = page.locator('[data-testid="business-hover-popup"]');
    await expect(popup).toBeVisible({ timeout: 5000 });
    await expect(popup).toHaveAttribute("data-business-id", business.featureId);
    await page.screenshot({ path: `${ARTIFACTS_DIR}/map/business-hover.png` });

    await page.mouse.move(box.x + 4, box.y + 4);
    await expect(popup).toHaveCount(0);
  });

  test("generic POI hover does not show business details", async ({ page }) => {
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const records = await page.evaluate(async () => {
      const response = await fetch("/api/map/search?q=Musée%20des%20Amériques");
      return await response.json() as Array<{
        kind: string;
        focusLon: number;
        focusLat: number;
      }>;
    });
    const poi = records.find((record) => record.kind === "poi");
    expect(poi).toBeDefined();
    if (!poi) return;
    const input = page.locator('[data-testid="search-input"]');
    await input.fill("Musée des Amériques");
    const option = page.locator('[role="option"][data-feature-kind="poi"]').first();
    await expect(option).toBeVisible();
    await option.click();
    await page.waitForTimeout(500);
    await moveToSourceCoordinate(page, [poi.focusLon, poi.focusLat]);
    await expect(page.locator('[data-testid="business-hover-popup"]')).toHaveCount(0);
  });

  test("mobile viewport fits the commune without cropping", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    await waitForScene(page);
    const status = await page.locator("#scene-diagnostics").getAttribute("data-renderer-status");
    if (status !== "initialized") return;
    const state = await readCameraState(page);
    expect(state.zoom).toBeGreaterThan(0);
    const canvas = page.locator("canvas");
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeCloseTo(375, 0);
  });
});
