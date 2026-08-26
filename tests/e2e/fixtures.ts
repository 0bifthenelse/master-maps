import { test as base, type Browser, type BrowserContext, type Page, expect } from "@playwright/test";
import { chromium } from "@playwright/test";

const MOLI_CDP = process.env.MOLI_CDP || "http://127.0.0.1:9222";

// Extend base test with Moli CDP-connected fixtures.
// `page` is overridden to connect via Moli's CDP instead of launching Chromium.
export const test = base.extend<{
  moliBrowser: Browser;
  moliContext: BrowserContext;
  page: Page;
}>({
  moliBrowser: async ({}, use) => {
    const browser = await chromium.connectOverCDP(MOLI_CDP);
    await use(browser);
    await browser.close();
  },
  moliContext: async ({ moliBrowser }, use) => {
    const context = await moliBrowser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    await use(context);
    await context.close();
  },
  page: async ({ moliContext }, use) => {
    const page = await moliContext.newPage();
    await use(page);
  },
});

export { expect, chromium } from "@playwright/test";