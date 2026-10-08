import type { Page } from "@playwright/test";
import { expect } from "./fixtures";

export interface CameraState {
  target: [number, number, number];
  zoom: number;
  metresPerPixel: number;
  headingRadians: number;
  pitchRadians: number;
}

/** Auch, around the cathedral. */
export const AUCH = { lat: 43.6460, lon: 0.5864 };

export function viewHash(zoom: number, lat = AUCH.lat, lon = AUCH.lon, bearingDegrees = 0, pitchDegrees = 0): string {
  return `#map=${zoom}/${lat}/${lon}/${bearingDegrees}/${pitchDegrees}`;
}

export async function diagnostic(page: Page, key: string): Promise<string> {
  return (await page.locator("#scene-diagnostics").getAttribute(`data-${key}`)) ?? "";
}

export async function camera(page: Page): Promise<CameraState> {
  return JSON.parse(await diagnostic(page, "camera-state")) as CameraState;
}

/** Open the map (optionally at a view) and wait for WebGL and the first tiles. */
export async function openMap(page: Page, hash = ""): Promise<void> {
  await page.goto(`/${hash}`);
  await expect(page.locator("#scene-diagnostics")).toHaveAttribute("data-renderer-status", "initialized", { timeout: 60_000 });
  await expect.poll(async () => Number(await diagnostic(page, "loaded-tile-count")), { timeout: 60_000 }).toBeGreaterThan(0);
  await settle(page);
}

/** Wait until the camera stops moving (animations and inertia done). */
export async function settle(page: Page): Promise<CameraState> {
  let previous = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(150);
    const current = await diagnostic(page, "camera-state");
    if (current !== "" && current === previous) return JSON.parse(current) as CameraState;
    previous = current;
  }
  throw new Error("camera never settled");
}

export async function screenToMap(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([px, py]) => (window as unknown as { __masterMaps: { screenToMap: (x: number, y: number) => [number, number] } }).__masterMaps.screenToMap(px!, py!), [x, y]);
}

export async function mapToScreen(page: Page, point: [number, number]): Promise<[number, number]> {
  return page.evaluate(([e, n]) => (window as unknown as { __masterMaps: { mapToScreen: (e: number, n: number) => [number, number] } }).__masterMaps.mapToScreen(e!, n!), point);
}

/** Box of the map stage in page coordinates. */
export async function stageBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(".mm-stage").boundingBox();
  if (box === null) throw new Error("map stage not laid out");
  return box;
}
