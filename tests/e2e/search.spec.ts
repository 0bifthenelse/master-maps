import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { camera, openMap, settle, viewHash } from "./helpers";

async function search(page: Page, query: string): Promise<string[]> {
  const input = page.getByTestId("search-input");
  await input.fill("");
  await input.fill(query);
  const list = page.getByRole("listbox", { name: "Search results" });
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
  return list.getByRole("option").allInnerTexts();
}

test.describe("search", () => {
  test("finds a commune by name, with its context", async ({ page }) => {
    await openMap(page);
    const results = await search(page, "condom");
    expect(results[0]).toMatch(/Condom/);
    expect(results[0]).toMatch(/COMMUNE/i);
  });

  test("finds roads by number in any spelling", async ({ page }) => {
    await openMap(page);
    expect((await search(page, "N124"))[0]).toMatch(/N124/);
    expect((await search(page, "rn 124"))[0]).toMatch(/N124/);
  });

  test("combines a category with a commune", async ({ page }) => {
    await openMap(page);
    const results = await search(page, "pharmacie auch");
    expect(results.length).toBeGreaterThan(0);
    for (const row of results.slice(0, 3)) expect(row).toMatch(/Pharmac/i);
    expect(results[0]).toMatch(/Auch/);
  });

  test("finds a landmark despite accents and hyphens", async ({ page }) => {
    await openMap(page);
    expect((await search(page, "abbaye flaran"))[0]).toMatch(/Flaran/i);
    expect((await search(page, "larressingle"))[0]).toMatch(/Larressingle/i);
  });

  test("finds a numbered address", async ({ page, request }) => {
    await openMap(page);
    /* Take a real address from the index so the test follows the data. */
    const sample = await request.get("/api/map/search?q=rue%20dessoles%20auch&limit=5").then((response) => response.json() as Promise<Array<{ canonicalName: string; kind: string }>>);
    const street = sample.find((hit) => hit.kind === "road")?.canonicalName ?? "Rue Dessoles";
    const addresses = await request.get(`/api/map/search?q=${encodeURIComponent(`1 ${street} auch`)}&limit=5`).then((response) => response.json() as Promise<Array<{ canonicalName: string; kind: string }>>);
    const address = addresses.find((hit) => hit.kind === "address");
    test.skip(address === undefined, "no numbered address on the sample street");
    const results = await search(page, `${address!.canonicalName} auch`);
    expect(results[0]).toContain(address!.canonicalName);
    expect(results[0]).toMatch(/ADDRESS/i);
  });

  test("selecting a result flies there and opens its dossier", async ({ page }) => {
    await openMap(page);
    const before = await camera(page);
    await search(page, "cathedrale sainte marie auch");
    await page.keyboard.press("Enter");
    const dossier = page.getByTestId("feature-dossier");
    await expect(dossier).toBeVisible({ timeout: 15_000 });
    await expect(dossier).toContainText(/Sainte-Marie/i);
    const after = await settle(page);
    expect(after.zoom).toBeGreaterThan(before.zoom + 3);
    await page.keyboard.press("Escape");
    await expect(dossier).toHaveCount(0);
  });

  test("a category chip lists nearby places on the map", async ({ page }) => {
    await openMap(page, viewHash(15));
    await page.getByRole("toolbar", { name: "Find nearby" }).getByRole("button", { name: "Pharmacies" }).click();
    const list = page.getByRole("listbox", { name: "Search results" });
    await expect(list).toHaveAttribute("aria-busy", "false", { timeout: 15_000 });
    const rows = await list.getByRole("option").allInnerTexts();
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, 5)) expect(row).toMatch(/Pharmac/i);
  });
});
