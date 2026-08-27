import { test as base, type Browser, type BrowserContext, type Page, expect } from "@playwright/test";
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const MOLI_CDP = process.env.MOLI_CDP || "http://127.0.0.1:9222";
export const ARTIFACTS_DIR = "tests/artifacts/moli";
mkdirSync(ARTIFACTS_DIR, { recursive: true });

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function checkPngNotBlank(filePath: string): {
  width: number;
  height: number;
  notBlank: boolean;
  reason: string;
  luminanceVariance?: number;
} {
  const png = readFileSync(filePath);
  if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: 0, height: 0, notBlank: false, reason: "invalid PNG signature" };
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    return { width, height, notBlank: false, reason: "unsupported PNG pixel format" };
  }
  const channels = colorType === 6 ? 4 : 3;
  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  let compressed: Buffer;
  try {
    compressed = inflateSync(Buffer.concat(idat));
  } catch {
    return { width, height, notBlank: false, reason: "decompression failed" };
  }
  const stride = width * channels;
  const decoded = Buffer.alloc(height * stride);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = compressed[sourceOffset++];
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const raw = compressed[sourceOffset++];
      const left = x >= channels ? decoded[rowStart + x - channels] : 0;
      const above = y > 0 ? decoded[rowStart - stride + x] : 0;
      const upperLeft = y > 0 && x >= channels ? decoded[rowStart - stride + x - channels] : 0;
      const prediction = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0;
      decoded[rowStart + x] = (raw + prediction) & 255;
    }
  }
  const samples: number[] = [];
  for (let sy = 0; sy < 7; sy += 1) {
    for (let sx = 0; sx < 9; sx += 1) {
      const x = Math.min(width - 1, Math.floor((sx + 0.5) * width / 9));
      const y = Math.min(height - 1, Math.floor((sy + 0.5) * height / 7));
      const at = y * stride + x * channels;
      samples.push(0.299 * decoded[at] + 0.587 * decoded[at + 1] + 0.114 * decoded[at + 2]);
    }
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  return {
    width,
    height,
    notBlank: variance > 80,
    reason: variance > 80 ? "map content variance detected" : `near-uniform canvas (variance ${variance.toFixed(1)})`,
    luminanceVariance: variance,
  };
}

export interface BrowserErrors {
  consoleErrors: string[];
  pageErrors: string[];
}

export const test = base.extend<{
  moliBrowser: Browser;
  moliContext: BrowserContext;
  page: Page;
  errors: BrowserErrors;
}>({
  moliBrowser: async ({}, use) => {
    const browser = await chromium.connectOverCDP(MOLI_CDP);
    await use(browser);
    // connectOverCDP attaches a client to Moli's single long-lived browser
    // process; disconnecting (not closing) releases this test's CDP session
    // without tearing down the shared browser other tests still need.
    await browser.close();
  },
  moliContext: async ({ moliBrowser }, use) => {
    const context = await moliBrowser.newContext({ viewport: { width: 1280, height: 720 } });
    await use(context);
    // Each test opens a fresh context holding a full WebGPU canvas and the
    // full commune tile set; leaving contexts open across 20 sequential
    // tests accumulates memory in Moli's single browser process until it
    // crashes mid-suite. Close explicitly so only one context is live at a time.
    await context.close();
  },
  page: async ({ moliContext }, use) => {
    const page = await moliContext.newPage();
    await page.addInitScript(() => {
      (window as unknown as { __unhandledRejections: string[] }).__unhandledRejections = [];
      window.addEventListener("unhandledrejection", (event) => {
        window.__unhandledRejections.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
      });
    });
    await use(page);
  },
  errors: async ({ page }, use) => {
    const errors: BrowserErrors = { consoleErrors: [], pageErrors: [] };
    page.on("pageerror", (error) => errors.pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.consoleErrors.push(message.text());
    });
    await use(errors);
  },
});

export { expect, chromium } from "@playwright/test";
