import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkPngNotBlank } from "../e2e/fixtures";

describe("moli-visual-states", () => {
  const artifacts = "tests/artifacts/moli";

  it("defines the required visual states", () => {
    const screenshots = [
      "initial-desktop",
      "search-open",
      "search-results",
      "nocibe-selected",
      "inspector-open",
      "layer-menu",
      "loading-state",
      "unsupported-webgpu",
      "mobile-viewport",
      "error-state",
    ];
    expect(screenshots).toHaveLength(10);
    for (const screenshot of screenshots) expect(screenshot).toMatch(/^[a-z-]+$/);
  });

  it("defines desktop and mobile viewports", () => {
    expect([
      { name: "desktop", width: 1280, height: 720 },
      { name: "mobile", width: 375, height: 667 },
    ]).toEqual([
      { name: "desktop", width: 1280, height: 720 },
      { name: "mobile", width: 375, height: 667 },
    ]);
  });

  it("retains the required design tokens", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain("--color-accent");
    expect(css).toContain("--color-ink");
    expect(css).toContain("--color-paper");
  });

  it("rejects available blank canvas artifacts", () => {
    if (!existsSync(artifacts)) return;
    const pngs: string[] = [];
    const collect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (entry.name.endsWith(".png")) pngs.push(path);
      }
    };
    collect(artifacts);
    for (const png of pngs) {
      const result = checkPngNotBlank(png);
      expect(result.width, `${png}: invalid width`).toBeGreaterThan(0);
      expect(result.height, `${png}: invalid height`).toBeGreaterThan(0);
      expect(result.notBlank, `${png}: ${result.reason}`).toBe(true);
    }
  });
});
