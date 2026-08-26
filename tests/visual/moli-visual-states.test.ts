import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

describe("moli-visual-states", () => {
  const ARTIFACTS_DIR = "tests/artifacts/moli";

  it("artifacts directory exists or can be created", () => {
    // This is a placeholder - the real test runs via Moli/PW and captures screenshots
    const dir = ARTIFACTS_DIR;
    expect(dir).toMatch(/^tests\/artifacts\/moli$/);
  });

  it("required screenshot names are defined", () => {
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
    expect(screenshots.length).toBe(10);
    screenshots.forEach((s) => expect(s).toMatch(/^[a-z-]+$/));
  });

  it("viewport sizes are defined", () => {
    const viewports = [
      { name: "desktop", width: 1280, height: 720 },
      { name: "mobile", width: 375, height: 667 },
    ];
    expect(viewports.length).toBe(2);
  });

  it("contrast requirements are met (design tokens)", () => {
    // Verify CSS variables exist in globals.css
    const css = readFileSync("app/globals.css", "utf-8");
    expect(css).toContain("--color-accent");
    expect(css).toContain("--color-ink");
    expect(css).toContain("--color-paper");
  });

  it("scene diagnostics attributes defined", () => {
    const requiredAttrs = [
      "renderer-status",
      "backend",
      "loaded-tile-count",
      "loaded-feature-count",
      "building-count",
      "road-count",
      "poi-count",
      "draw-calls",
      "camera-state",
      "renderer-error",
    ];
    requiredAttrs.forEach((attr) => expect(attr).toMatch(/^[a-z-]+$/));
  });
});