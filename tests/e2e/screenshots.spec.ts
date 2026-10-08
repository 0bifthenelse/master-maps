import { mkdirSync } from "node:fs";
import { test, expect, checkPngNotBlank } from "./fixtures";
import { openMap, settle, viewHash } from "./helpers";

/** Reference captures of the main views, written to docs/media for the README. */
const OUT = process.env.SCREENSHOT_DIR ?? "tests/artifacts/screens";
mkdirSync(OUT, { recursive: true });

const VIEWS: Array<{ name: string; hash: string; satellite?: boolean; width?: number; height?: number }> = [
  { name: "gers-overview", hash: "" },
  { name: "auch-z16", hash: viewHash(16.2, 43.6457, 0.5868) },
  { name: "auch-3d", hash: viewHash(17.3, 43.6460, 0.5866, -32, 55) },
  { name: "condom-satellite", hash: viewHash(16.4, 43.9578, 0.3725), satellite: true },
  { name: "mobile-auch", hash: viewHash(15.2, 43.6465, 0.5860), width: 390, height: 844 },
];

for (const view of VIEWS) {
  test(`capture ${view.name}`, async ({ page }) => {
    await page.setViewportSize({ width: view.width ?? 1440, height: view.height ?? 900 });
    await openMap(page, view.hash);
    if (view.satellite === true) {
      await page.getByLabel("Switch to satellite imagery").click();
      await page.waitForLoadState("networkidle").catch(() => undefined);
    }
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await settle(page);
    await page.waitForTimeout(800);
    const path = `${OUT}/${view.name}.png`;
    await page.screenshot({ path });
    expect(checkPngNotBlank(path).notBlank).toBe(true);
  });
}
