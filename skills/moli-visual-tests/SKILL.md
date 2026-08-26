# Moli visual tests — repository-local MCP skill

**Version**: 1.0 - 2026-08

This skill documents how to use **Moli** (version 1.0.4) for headless browser interaction, rendered-web research, and visual QA on the master-maps project. Moli is the mandatory headless browser engine for every automated browser task. Never use Playwright's `chromium.launch`, never download a second Chromium, and never silently fall back to a different browser.

---

## Operations

### Resolve `moli` from PATH

```bash
command -v moli      # must succeed
moli --version       # must report 1.0.4 or a recorded newer secure version
```

Moli is installed at the system level. Do not install it via npm, Homebrew, or any package manager.

---

### Read help before use

Read full subcommand help before any unfamiliar invocation to avoid ambiguous flag meanings or default changes:

```bash
moli --help
moli fetch --help
moli serve --help
```

Key flags documented from current help output:

- `moli fetch --dump <FORMAT>` — output format: `markdown`, `semantic_tree`, `semantic_tree_text`, `json`, `html`, `screenshot`, `screenshot_full`, `pdf`
- `moli fetch --wait-until <STAGE>` — lifecycle wait: `domcontentloaded`, `load`, `networkidle`, `domstable`, `done` (default)
- `moli fetch --wait-selector <CSS>` — wait for a specific selector before returning
- `moli fetch --wait-script <JS>` — wait until a JavaScript expression is truthy
- `moli fetch --obey-robots` — refuse fetch if origin's `/robots.txt` disallows it
- `moli serve --host <HOST>` — CDP listen address (default `127.0.0.1`)
- `moli serve --port <PORT>` — CDP listen port (default `9222`)
- `moli serve --layout` — enable real layout renderer and screenshot surfaces (required for screenshots and visual output)

---

### Use Moli for every headless browser interaction

Every automated browser interaction, rendered-web research, and visual test must use Moli. This includes:

- Fetching rendered pages for research
- Taking screenshots for visual QA
- Serving a CDP endpoint for Playwright connection
- Capturing UI state after interactions

Do not use Puppeteer, Playwright with a self-managed browser, or any other headless driver.

---

### Research with `moli fetch`

For research and data acquisition:

```
moli fetch --dump markdown <URL>
moli fetch --dump semantic_tree_text <URL>
moli fetch --dump semantic_tree --wait-until domstable <URL>
moli fetch --dump markdown --wait-selector "main" <URL>
moli fetch --dump markdown --wait-script "document.querySelectorAll('li').length > 10" <URL>
```

- `--dump markdown` — best for readable research output with extracted text structure
- `--dump semantic_tree_text` — linearised semantic tree for compact extraction
- `--dump semantic_tree` — structured JSON tree with accessibility roles
- `--dump json` — raw DOM extraction, can include `--trace-network` for request traces
- Add `--timeout <MS>` to override the default 25-second timeout
- Add `--wait-selector <CSS>` when content loads after the initial page paint
- Add `--wait-until domstable` for pages with late async rendering
- Add `--wait-script <JS>` for dynamic conditions (e.g., "list items rendered")

---

### Visual and interactive tests with `moli serve`

Start the Moli CDP server for Playwright-driven tests:

```bash
moli serve --layout --host 127.0.0.1 --port 9222
```

- `--layout` is **required** for screenshot surfaces and real layout rendering
- Default `--host 127.0.0.1`, default `--port 9222`
- Server runs until the timeout elapses without a client; default `--timeout 10` seconds

---

### Probe CDP and connect Playwright

In test setup or the E2E runner, verify the Moli CDP endpoint and connect:

```typescript
// Probe the CDP version endpoint
const versionResp = await fetch('http://127.0.0.1:9222/json/version');
const version = await versionResp.json();

// Connect Playwright over CDP — NEVER call chromium.launch
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = await browser.newContext();
const page = await context.newPage();
```

**Critical rule**: Always `connectOverCDP`, never `chromium.launch`. Moli provides the browser; Playwright is only a CDP client. Assert that Playwright did not download Chromium.

---

### Never call `chromium.launch` or permit Playwright to download Chromium

Playwright must never start its own browser process:

```typescript
// FORBIDDEN
const browser = await chromium.launch();  // NEVER

// REQUIRED — connect to Moli's CDP server
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
```

In `playwright.config.ts`, set `use.launchOptions` to empty or disable browser downloads. Ensure no Playwright install step downloads Chromium.

---

### Capture important UI states

Save screenshots and traces to the ignored directory:

```
tests/artifacts/moli/
```

Test setup must create this directory. Store:

- Full-page and viewport screenshots of key states
- Traces from CDP-connected sessions
- Captured DOM snapshots or page sources
- Scene diagnostic data extracted from the map application

Path convention: `tests/artifacts/moli/<test-name>/<state-name>.png`

This directory is Git-ignored (`tests/artifacts/`).

---

### Inspect screenshots with vision when available

When a vision-capable model is available, use it to inspect screenshots for:

- Clipping, truncation, or overlapping elements
- Visible contrast ratios and text legibility
- Focus visibility on interactive controls
- Layout correctness (no horizontal scrollbars on intended viewports)
- Color contrast between accent, paper, and ink surfaces
- Absence of runtime error overlays or blank canvas states

Example vision prompt:

```
"Inspect this screenshot of the Auch map application. Report:
1. Is the canvas rendering visible (not blank)?
2. Is the search control visible at top?
3. Are any error overlays visible?
4. Is text readable against background surfaces?"
```

---

### Verify DOM and scene diagnostics separately

Never interpret a blank or software-rendered canvas as WebGPU evidence. Moli does not use a real GPU — its canvas output is software-rendered.

**DOM verification** — assert HTML elements, ARIA labels, CSS state:

```typescript
await expect(page.locator('#map-shell')).toBeVisible();
await expect(page.locator('#scene-diagnostics')).toContainText('renderer-status=initialized');
await expect(page.locator('[data-testid="search-input"]')).toBeVisible();
```

**Scene diagnostics verification** — the `#scene-diagnostics` element exposes map runtime state:

```typescript
const diagText = await page.locator('#scene-diagnostics').textContent();
expect(diagText).toContain('backend=webgpu');
expect(diagText).toContain('loaded-tile-count=');
// Parse the numeric count — must be > 0
const loadedMatch = diagText.match(/loaded-tile-count=(\d+)/);
expect(loadedMatch).not.toBeNull();
expect(parseInt(loadedMatch[1], 10)).toBeGreaterThan(0);
```

**Known limitation**: Moli's canvas is software-rendered. Diagnostics and DOM assertions prove the WebGPU renderer initialized and loaded data, but do not prove GPU-pixel correctness. A supplementary check on a real GPU-capable browser is needed for pixel-level WebGPU validation.

---

### Never bypass security boundaries

Moli must never be used to bypass:

- CAPTCHA challenges
- Login walls or authentication prompts
- Robots.txt restrictions (`--obey-robots` flag enforces this)
- Rate limits or access controls
- Cookie consent or privacy controls
- Profiles or session boundaries

If a page presents a login wall, CAPTCHA, rate-limit response, or robots.txt rejection, **record the blocking response as the result** and do not attempt to circumvent it. Treat a blocked page as negative evidence, not something to work around.

---

### Never treat error or login pages as successful evidence

A 4xx/5xx response, login redirect, CAPTCHA page, or consent wall is not valid evidence. If Moli returns an error page:

1. Record the HTTP status and response body (or truncated body)
2. Note the failure in the source manifest with the exact URL
3. Do not fabricate data from an error response
4. Do not retry with different headers or profiles to bypass the block

---

### Never silently fall back to another browser

If Moli is unavailable, crashes, or cannot complete a task, the operation fails explicitly. Do not:

- Fall back to Playwright + system Chromium
- Fall back to Puppeteer
- Fall back to a headless Node.js HTTP client as a browser substitute
- Use `curl` or `wget` to fetch rendered pages

The only acceptable fallback is to record the Moli failure and stop. If Moli is needed but not running in `serve` mode, start it explicitly — do not substitute.

---

### Record clear limitation when Moli cannot validate GPU feature

Moli does not provide a real GPU, WebGPU, or WebGL hardware backend. Its canvas output is software-rendered and does not prove:

- WebGPU device initialization
- WebGPU shader compilation or execution
- Hardware-accelerated rendering
- Correct pixel output from GPU compute pipelines

When documenting Moli test results for GPU-dependent features, always include this limitation statement:

> "Moli CDP was used for DOM and diagnostics assertions. WebGPU rendering was verified through diagnostics (`renderer-status=initialized`, `backend=webgpu`) and nonzero feature counts, not through canvas pixel inspection. A real GPU-capable browser is required for pixel-level WebGPU validation."

---

## Critical rules

1. **`moli` from PATH first** — never use npm, Homebrew, or another installation path.
2. **Read `--help` before unfamiliar invocations** — flags may change between versions.
3. **Moli for every headless task** — no `chromium.launch`, no Puppeteer, no manual browser.
4. **`connectOverCDP` only** — Playwright is a client, never a browser launcher.
5. **`--layout` required for screenshots** — without it, no paint output exists.
6. **Ignore screenshots and traces** — store under `tests/artifacts/moli/`.
7. **Vision inspection is supplemental** — use it when available; never skip DOM assertions.
8. **Separate DOM and GPU diagnostics** — software canvas is not WebGPU evidence.
9. **Never bypass security** — CAPTCHA, login walls, robots.txt, rate limits, profiles.
10. **Error pages are negative evidence** — record failures, do not fabricate success.
11. **No browser fallback** — Moli failure means task failure.
12. **Record GPU limitations** — Moli cannot validate WebGPU pixels.

---

## Examples

### Fetch a rendered page for research

```bash
moli fetch --dump markdown --wait-selector "main" https://example.com
```

### Fetch with a custom wait script

```bash
moli fetch --dump semantic_tree_text --wait-script "document.querySelectorAll('[data-business]').length > 5" https://example.com
```

### Start CDP server for Playwright

```bash
moli serve --layout --host 127.0.0.1 --port 9222 --timeout 60
```

### Connect Playwright and take a screenshot

```typescript
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.newPage();
await page.goto('http://localhost:3100');
await page.waitForSelector('#map-shell');
await page.screenshot({ path: 'tests/artifacts/moli/load-state/map-shell.png' });
const diag = await page.locator('#scene-diagnostics').textContent();
console.log('Diagnostics:', diag);
await browser.close();
```

### Assert scene diagnostics after search

```typescript
await page.fill('[data-testid="search-input"]', 'Nocibe');
await page.press('[data-testid="search-input"]', 'Enter');
await page.waitForSelector('[data-testid="search-result-nocibe"]');
await page.click('[data-testid="search-result-nocibe"]');
const diag = await page.locator('#scene-diagnostics').textContent();
expect(diag).toContain('camera-state=focus');
expect(diag).toContain('backend=webgpu');
```

### Record a Moli fetch failure

```json
{
  "source": "Nocibé official page",
  "url": "https://www.nocibe.fr/parfumerie/nocibe-auch",
  "moli_status": "crashed",
  "error": "bad_optional_access",
  "exit_code": 134,
  "recorded": "2026-08-26T17:00:00Z",
  "resolution": "Use BAN + PagesJaunes + SIRENE as fallback sources"
}
```

---

## Related files

- `AGENTS.md` — repository agent instructions referencing this skill
- `scripts/moli/run-e2e.ts` — E2E test runner that starts Moli and Next
- `tests/e2e/map.spec.ts` — E2E tests using Moli CDP
- `tests/visual/moli-visual-states.test.ts` — visual-state matrix
- `playwright.config.ts` — Playwright config with CDP-only connection