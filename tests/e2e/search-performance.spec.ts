import { test, expect, type Page } from "./fixtures";

interface LongTaskEntry {
  startTime: number;
  duration: number;
}

interface InputLatencyEntry {
  inputTime: number;
  frameTime: number;
}

interface BrowserMetrics {
  __longTasks: LongTaskEntry[];
  __inputLatency: InputLatencyEntry[];
}

interface SearchResponseMetric {
  url: string;
  status: number;
  bodyBytes: number;
  records: unknown[] | null;
}

const SEARCH_PATH = "/api/map/search";
const MAX_RESPONSE_BYTES = 32 * 1024;
const SEARCH_CASES = [
  { text: "Cathedrale Sainte Marie", expected: "Cathédrale Sainte-Marie" },
  { text: "Cathédrale Sainte-Marie", expected: "Cathédrale Sainte-Marie" },
  { text: "Boulevard Sadi Carnot", expected: "Boulevard Sadi Carnot" },
];

async function clearMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as BrowserMetrics;
    state.__longTasks.length = 0;
    state.__inputLatency.length = 0;
  });
}

function isSearchRequest(url: string): boolean {
  return new URL(url).pathname === SEARCH_PATH;
}

async function recordSearchCase(page: Page, text: string, expected: string, requests: string[], responses: SearchResponseMetric[], failures: string[], responsePromises: Promise<void>[]): Promise<void> {
  requests.length = 0;
  responses.length = 0;
  failures.length = 0;
  responsePromises.length = 0;
  await clearMetrics(page);
  const input = page.locator('[data-testid="search-input"]');
  await input.fill("");
  await input.pressSequentially(text, { delay: 55 });
  await expect(input).toHaveValue(text);
  await expect(page.locator('[role="option"]').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(250);
  await Promise.all(responsePromises.splice(0));
  expect(requests.length).toBeLessThanOrEqual(Math.ceil(text.length / 3));
  expect(requests.length).toBeLessThan(text.length);
  expect(failures).toHaveLength(0);
  expect(responses.some((response) => response.status === 200)).toBe(true);
  expect(responses.every((response) => response.bodyBytes <= MAX_RESPONSE_BYTES)).toBe(true);
  expect(responses.every((response) => Array.isArray(response.records) && response.records.length <= 10)).toBe(true);
  await expect(page.locator('[role="option"]').first()).toContainText(expected);
}

test.describe("bounded search typing performance", () => {
  test("keeps typing responsive and responses bounded", async ({ page }) => {
    await page.addInitScript(() => {
      const state = window as unknown as BrowserMetrics;
      state.__longTasks = [];
      state.__inputLatency = [];
      if (typeof PerformanceObserver !== "undefined") {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.__longTasks.push({ startTime: entry.startTime, duration: entry.duration });
        });
        observer.observe({ type: "longtask", buffered: true });
      }
      window.addEventListener("input", () => {
        const inputTime = performance.now();
        requestAnimationFrame(() => state.__inputLatency.push({ inputTime, frameTime: performance.now() }));
      });
    });
    const requests: string[] = [];
    const responses: SearchResponseMetric[] = [];
    const failures: string[] = [];
    const responsePromises: Promise<void>[] = [];
    page.on("request", (request) => {
      if (isSearchRequest(request.url())) requests.push(request.url());
    });
    page.on("requestfailed", (request) => {
      if (isSearchRequest(request.url())) failures.push(request.url());
    });
    page.on("response", (response) => {
      if (!isSearchRequest(response.url())) return;
      const responsePromise = (async () => {
        try {
          const body = await response.body();
          const parsed: unknown = JSON.parse(body.toString("utf8"));
          responses.push({ url: response.url(), status: response.status(), bodyBytes: body.byteLength, records: Array.isArray(parsed) ? parsed : null });
        } catch {
          responses.push({ url: response.url(), status: response.status(), bodyBytes: 0, records: null });
        }
      })();
      responsePromises.push(responsePromise);
    });
    await page.goto("/");
    await expect(page.locator("#scene-diagnostics")).toBeAttached();
    await clearMetrics(page);
    for (const searchCase of SEARCH_CASES) await recordSearchCase(page, searchCase.text, searchCase.expected, requests, responses, failures, responsePromises);
    await page.waitForTimeout(100);
    const browserMetrics = await page.evaluate(() => {
      const state = window as unknown as BrowserMetrics;
      return { longTasks: [...state.__longTasks], inputLatency: [...state.__inputLatency] };
    });
    expect(responses.length).toBeGreaterThan(0);
    expect(Math.max(0, ...browserMetrics.longTasks.map((entry) => entry.duration))).toBeLessThan(200);
    expect(browserMetrics.inputLatency.length).toBeGreaterThan(0);
  });
});
