# W1 / TASK 08 — Verification harness audit

Repository: `/home/ifthenelse/repository/master/maps` @ `fef6f17` (clean tree)
Date: 2026-09-26
Scope: `scripts/moli/run-e2e.ts`, `scripts/chrome/run-verification.ts`, `scripts/chrome/compare-osm.ts`,
`playwright.config.ts`, `vitest.config.ts`, `tests/e2e/*`, `tests/visual/*`, `tests/integration/*`,
`scripts/data/qa-spatial.ts`, `scripts/data/validate.ts`, `src/lib/scene/sceneMetrics.ts`,
plus a live headless-Chrome WebGPU probe and a real baseline benchmark run.

No tracked file was modified. All probe artifacts live in `/tmp` (`/tmp/w1-t08-*.mjs`, `/tmp/w1-t08-baseline.json`).

---


### Measurement provenance (read before reusing any number)
All in-browser numbers in this report (§2 adapter probes, §7.5 baseline) were collected with a **hand-written
raw-CDP Node script** (`/tmp/w1-t08-gpu-probe.mjs`, `/tmp/w1-t08-baseline.mjs`) driving
`google-chrome-stable` directly — **not** Playwright, **not** the guarded `internet` MCP runtime. They were
captured before the later user directive that all in-browser runtime testing must go through
`skill://master-internet` + the `xd://mcp__internet_*` routes under the `/tmp/master-maps-browser.lock`
mutual-exclusion lock. Per that directive these numbers may be retained, labelled with the tool used.

**For all later waves: reproduce §7 with the guarded internet runtime, not the raw-CDP script.**
The procedure is unchanged — only the driver is:
1. `mkdir /tmp/master-maps-browser.lock` (retry every 20 s if it already exists; it is atomic).
2. `health`, `version`, `profile_open`, `gpu_mode {"mode":"hardware"}` (required for a real WebGPU adapter —
   `gpu_mode` is the supported way to guarantee hardware rather than SwiftShader).
3. `set_viewport {w:1440,h:900}`.
4. `navigate http://127.0.0.1:3100/`, then `state` to confirm the map mounted.
5. `evaluate` to install the `PerformanceObserver({type:"longtask"})` + `PerformanceObserver({type:"resource"})`
   + `requestAnimationFrame` collector, drive the scenario, and read the aggregate back out in one expression.
6. `shot` for the frame, `profile_close`, then `rmdir /tmp/master-maps-browser.lock`.

Keep each session under ~10 minutes. The adapter identity must still be recorded in the result file — on this
host `gpu_mode {"mode":"hardware"}` should yield `amd / gcn-5` (AMD Radeon RADV RENOIR, integrated), matching
§2. If it reports `google/swiftshader`, the run is CPU-rendered and its FPS numbers are not comparable to §7.5.
Node/curl measurements (the §7.1 API timings) are unaffected and stay as they are.


---

## 1. Harness inventory and how each launches the app

| Harness | Entry point | Server | Port(s) | Build mode | Browser |
|---|---|---|---|---|---|
| Moli E2E | `npm run test:e2e` → `scripts/moli/run-e2e.ts` | `npm run start -- --port 3100` (`:25`) | Next **3100**, Moli CDP **9222** (`:7-8`) | **prod** (`next start`), requires a prior `next build` | Moli 1.0.4 (`moli serve --layout --host 127.0.0.1 --port 9222 --timeout 600`, `:36`), Playwright only as a CDP client |
| Real-Chrome verification | `npm run verify:chrome` → `scripts/chrome/run-verification.ts` | `npm run start -- --port 3102` (`:32`, `:93`) | Next **3102**, CDP **9333** | **prod** | installed `/usr/bin/google-chrome-stable`, launched with a real on-screen X11 window, `connectOverCDP` |
| OSM comparison | `npm run compare:osm` → `scripts/chrome/compare-osm.ts` | `npm run start -- --port 3104` (`:10`, `:147`) | Next **3104**, CDP **9335** | **prod** | installed Chrome, same off-viewport X11 window |
| Unit + visual | `npm run test:unit` (`vitest run tests/unit tests/visual`) | none | — | node env | none |
| Integration | `npm run test:integration` (`vitest run tests/integration`) | none | — | node env | none |
| Data validation | `npm run data:validate`, `npm run data:qa` | none | — | node env | none |

Notable: **no harness uses `next dev`.** All three browser harnesses need an up-to-date `.next` production build.
A current build is present (`/.next/BUILD_ID` = `QV67xn4nmovRW6ejcg3cn`, mtime 2026-09-26 18:19, no `src`/`app`
file newer than it) — VERIFIED.

`next build` is wired to run data validation first (`package.json:7`
`"build": "npm run data:validate && next build"`), so a build cannot succeed without the full 8.1 GB dataset.

### Shared environment knobs
- `MASTER_MAPS_DATA_DIR` (default `data`) is honoured by the Next tile/search routes
  (`app/api/map/tile/[tileId]/route.ts:16`, `app/api/map/search/route.ts` via `searchServer.ts`) and by
  `compare-osm.ts` via `--data-dir=` (`:56-66`).
- `scripts/moli/run-e2e.ts:58-63` exports to the Playwright child: `MOLI_CDP`, `NEXT_PUBLIC_MAP_DIAGNOSTICS=1`,
  `PLAYWRIGHT_BROWSERS_NONE=1`. The last one is the enforcement of "never download Playwright Chromium".
- `playwright.config.ts:3` reads `NEXT_PORT` (default 3100) for `baseURL`; it defines **no projects** and never
  calls `chromium.launch` (`:17-20`).

---

## 2. How WebGPU is obtained — MEASURED on this workstation

Machine: AMD Cezanne / **AMD Radeon Graphics (RADV RENOIR, gcn-5)**, Mesa 26.1.8 radv, one `PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU`
(`vulkaninfo --summary`). `VK_EXT_headless_surface` **is** implemented by this loader (instance extension listed).
Chrome **149.0.7827.155**. No NVIDIA present.

Display: `XDG_SESSION_TYPE=wayland`, `WAYLAND_DISPLAY=wayland-1`, `DISPLAY=:0`, `/run/user/1000/wayland-1` present (Hyprland).
A headed Chrome with a real X11 surface is therefore **available** on this host — but, per the results below,
**not required**.

Probe: `/tmp/w1-t08-gpu-probe.mjs` (raw CDP: `Target.attachToTarget` → `Runtime.evaluate`), which calls
`navigator.gpu.requestAdapter()`, reads `adapter.info` / `adapter.limits` / `adapter.features`, then
`requestDevice()` + buffer alloc + `copyBufferToBuffer` + `createRenderPipeline` to prove the device is real
(not a degenerate/null adapter).

| Launch mode | `navigator.gpu` | adapter `info` | buffer+device | pipeline |
|---|---|---|---|---|
| `--headless=new` **default flags** | present | **`requestAdapter()` → null** | n/a | n/a |
| `--headless=new --enable-unsafe-webgpu` | present | `vendor=google, architecture=swiftshader` | ok | ok |
| `--headless=new --use-angle=vulkan --enable-features=Vulkan` | present | **`vendor=amd, architecture=gcn-5`** | **ok** | **ok** |
| `--headless=new --use-angle=vulkan --enable-features=Vulkan --enable-unsafe-webgpu` | present | `vendor=amd, architecture=gcn-5` | ok | ok |
| **headed** `--ozone-platform=x11 --window-position=-3000,-3000` + same Vulkan flags | present | `vendor=amd, architecture=gcn-5` | ok | ok |

`--dump-dom about:blank` probe also succeeds headless (exit 0, correct HTML) — cheap liveness check only.

Adapter limits (identical headless and headed): `maxBufferSize` 4 294 967 292, `maxStorageBufferBindingSize`
4 294 967 292, `maxUniformBufferBindingSize` 65 536, `maxVertexBuffers` 8, `maxBindGroups` 4,
`maxTextureDimension2D` 16 384. Features include `shader-f16`, `timestamp-query`,
`chromium-experimental-multi-draw-indirect`, `texture-compression-bc`, `rg11b10ufloat-renderable`.

**Conclusion — the header comment in `run-verification.ts:9-18` and `:99-107` is now factually stale for this host.**
It claims the NVIDIA ICD lacks `VK_EXT_headless_surface` and that headless WebGPU is unusable. On this AMD/radv
box headless WebGPU is fully functional with a real hardware adapter, no `--disable-gpu`, and the whole
`--headless=new` path is reproducible. The GPU here is integrated, so absolute FPS is not comparable to a
discrete RTX 4060, but *functional equivalence* holds. `[INFERENCE]` on the cause: the original diagnosis was
true for that NVIDIA driver and is not transferable; the flags remain correct, only the justification and the
mandate to use a headed window are obsolete.

Adapter evidence asserted by the harnesses themselves:
- `run-verification.ts:144-155` — `navigator.gpu` probe that hard-fails if `requestAdapter()` returns null.
- `run-verification.ts:178-195` — reads `#scene-diagnostics` `data-renderer-status` / `data-backend` and fails
  unless `status === "initialized" && backend === "webgpu"`.
- `tests/e2e/map.spec.ts:123` — `expect(attrs.backend).toBe("webgpu")`; `:115` accepts `unsupported` as a
  legal (degraded) state and asserts `renderer-error !== "none"`.
- My own benchmark confirms the live app reports `data-renderer-status=initialized`, `data-backend=webgpu`,
  `data-draw-calls=7`, adapter `amd / gcn-5`.

Browser profiles are persisted, gitignored directories: `.chrome-verify-profile/`
(`run-verification.ts:108`, `.gitignore:22-23`) and `.chrome-compare-profile/` (`compare-osm.ts:150`).
Neither window is visible: `--window-position=-3000,-3000` in both.

---

## 3. `compare-osm.ts` — policy assessment

**What it does** (`scripts/chrome/compare-osm.ts`):
- 13 Gers views (`:25-39`) or 5 Auch views with `--auch` (`:42-48`), coordinates from
  `tests/fixtures/gers-landmark-anchors.json` / `auch-landmark-anchors.json` (`:23-24`).
- For each view: loads the local app, picks the first search result, screenshots
  `tests/artifacts/visual/<slug>-master.png` (`:133`), computes an equivalent OSM zoom
  (`osmZoom()`, `:120-129`, using Web-Mercator resolution 156543.03392804097 · cos φ), then navigates to
  `https://www.openstreetmap.org/#map=<z>/<lat>/<lon>` (`:135`) and screenshots
  `<slug>-osm.png` after a fixed 3 s wait (`:137-138`).
- Emits `tests/artifacts/visual/comparison-report.json` (`:168`).

**What it does NOT do.** It never contacts `tile.openstreetmap.org`. There is no tile request anywhere in the
file; `www.openstreetmap.org` serves the single HTML document, and the tiles the browser subsequently loads
are osm.org's own first-party tiles for one human-viewable page. This is **one page view per coordinate, 5-13
per run, hard-coded from a committed fixture list** — a human-scale browse, not crawling.

**Policy risk — but the task statement and the code disagree with the current README.** The project mission
forbids *automated rendered-tile crawling*; `README.md:157` currently says "Current OpenStreetMap is the visual
reference for geographic comparison" and `README.md:132` documents the script. **VERIFIED conclusion: systematic
parity must be data-to-data** (compare `data/intermediate` / `data/generated` / `data/search` against the source
extracts), and `compare-osm.ts` must be demoted to an occasional, human-triggered sanity glance — it is not a
regression gate and must never be run in CI or unattended. Two concrete problems beyond policy:
1. It is **not deterministic**: OSM's rendered style and data change continuously, so a stored
   `<slug>-osm.png` has no stable expected value and cannot be diffed across runs.
2. **A live test asserts a live third party**: `tests/e2e/gers-map.spec.ts:142-147`
   (`"navigates the current OpenStreetMap reference view"`) hard-navigates to
   `https://www.openstreetmap.org/#map=17/43.6475/0.5905` and asserts the URL and `page.title()`.
   That test makes the *entire Moli E2E suite* fail whenever osm.org is slow, rate-limited, or changes its
   `<title>` — a real flake source, and it must be removed or replaced with a local data-to-data parity check.
   Note `moli fetch` is already in use for research (`README.md:200`), so non-rendered document fetches of
   osm.org are an accepted pattern; only the rendered-browse automation is the problem.

---

## 4. Performance metrics that exist today

### 4.1 `#scene-diagnostics` DOM surface (`src/lib/scene/sceneMetrics.ts`)
`publishSceneDiagnostics()` throttles to **100 ms** (`:44-52`) and writes **16 `data-*` attributes** plus a
`textContent` mirror (`:53-76`): `renderer-status`, `backend`, `loaded-tile-count`, `loaded-feature-count`,
`building-count`, `road-count`, `water-count`, `landuse-count`, `business-count`, `poi-count`, `draw-calls`,
`camera-target-x`, `camera-target-z`, `camera-zoom`, `camera-state` (JSON: position/target/zoom/azimuthalAngle/
headingRadians/rotationZ), `renderer-error`. The element is always in the DOM, `aria-hidden`, `pointer-events:none`
(`src/components/map/MapShell.tsx:427`).

**Important discrepancy (VERIFIED):** `README.md:99` claims diagnostics appear "when
`NEXT_PUBLIC_MAP_DIAGNOSTICS=1` or the environment is non-production". A repo-wide grep for
`NEXT_PUBLIC_MAP_DIAGNOSTICS` finds it in exactly two places — `README.md:99` and `scripts/moli/run-e2e.ts:61` —
and **nowhere in `src/`, `app/`, or `next.config.ts`**. `MapShell.tsx:427` renders the element
unconditionally and `sceneMetrics.ts:46-52` has no environment gate. The env var is **inert**; the Moli suite
sets a variable nothing reads, and the two Chrome harnesses (`run-verification.ts`, `compare-osm.ts`) do not set
it yet still read the attributes — which is why they work. Either wire the gate or delete the README claim and
the env var; leaving it as is misleads every later wave.

Metric sources: `sceneMetrics.drawCalls` is **not** `renderer.info.render.calls`; it is a *modelled* count —
`src/components/map/CityScene.tsx:143-150` sums the road strata + water strata + building + landuse + boundary
geometries that have a `position` attribute, plus 1 each for non-empty POI and business meshes. Status/backend
come from `WebGPUCityCanvas.tsx:70-149` (`loading | initialized | unsupported | errored | lost`). Counts are set
in a `useEffect` on `[features, groups, …]` (`CityScene.tsx:135-153`).

### 4.2 `window.__masterMapsTileDiagnostics` (the only `window.__*` hook)
`src/components/map/MapShell.tsx:44-54` — `{ requested: string[], aborted: string[], failed: string[],
loaded: string[] }`, lazily created on the tile-loading path (`:293-327`, `TILE_LOAD_CONCURRENCY` workers at
`:326`). Read by `tests/e2e/gers-map.spec.ts:138-139` to assert that rapid panning produces aborts.
There is **no** `window.__MASTER_MAPS_*` symbol anywhere in the repo (grep: 0 matches) — the task brief's
`__MASTER_MAPS_*` naming does not exist; the real hook is `__masterMapsTileDiagnostics`.

### 4.3 In-test-only instrumentation (injected via `addInitScript`, not shipped in app code)
- `tests/e2e/search-performance.spec.ts:69-83` — `window.__longTasks` via
  `PerformanceObserver({type:"longtask", buffered:true})` and `window.__inputLatency` via an `input` listener +
  `requestAnimationFrame`. Assertions: longest long task **< 200 ms** (`:117`), every search response
  **≤ 32 KiB** and **≤ 10 records** (`:62-63`), requests **≤ ceil(len/3)** (`:58-59`).
- `tests/e2e/fixtures.ts:117-122` — `window.__unhandledRejections`, asserted empty in
  `map.spec.ts:86-90`.
- No FPS, no frame-time, no heap, and no tile-timing metric exists in any tracked test. That is the gap the
  baseline procedure below fills.

### 4.4 Data-pipeline quality metrics (offline, not browser)
- `scripts/data/qa-spatial.ts` — CRS round-trip and normalization residuals. Thresholds:
  `MAX_ROUND_TRIP_METRES = 0.05`, `MAX_NORMALIZED_RESIDUAL_METRES = 0.1`, `MAX_TILE_RENDER_RESIDUAL_METRES = 0.1`
  (`:14-16`), ≥ 1000 sampled source vertices (`:13`, enforced `:272`). Writes
  `data/qa/spatial-report.json` and `data/qa/scene-geometry-debug.json` (`:329-331`) including
  `roadSegments`, `buildingVertices`, `waterVertices` and full `BufferGeometry` snapshots.
  Exports `runSpatialQa()` for reuse (`:265`).
- `scripts/data/validate.ts` — `MAX_TILE_BYTES = 2 MiB` (`:17`), `REQUIRED_KINDS = boundary/building/road/
  water/business/address` (`:18`), every feature needs finite WGS84 + local anchors inside the Gers boundary
  (`:81-97`), non-empty `sourceRefs` + `provenance` (`:99-104`), tile↔manifest identity reconciliation
  (`:116-124`), LOD 0/1/2 present and strictly decreasing feature counts (`:189-199`), search index
  cross-referenced to the tile manifest (`:173-187`). Writes `data/qa/validation-report.json` (`:225`).
  `--coverage-only` short-circuits with `process.exit(0)` (`:242`) — a deliberate no-op escape hatch.
  `next build` runs this first, so **no `next build` is possible without a complete, valid dataset**.

---

## 5. Which tests are expected to be green

`test-results/.last-run.json` = `{"status":"passed","failedTests":[]}` (stale, from an earlier run).

**`npm run test:unit` (34 files in `tests/unit` + `tests/visual/moli-visual-states.test.ts`)** — all green with
no data and no browser. `tests/visual/moli-visual-states.test.ts:43-60` is the only data-dependent case: it
walks `tests/artifacts/moli/**.png` and asserts none is blank (luminance variance > 80, `fixtures.ts:81`), and
`return`s early when the directory is absent. `tests/artifacts/moli/` currently exists with only empty
`map/` and `visual/` subdirectories, so it is vacuously green today. **Caution:** once real E2E screenshots land
in `tests/artifacts/moli/`, this test starts gating on them, and any legitimately sparse frame (e.g. an
`unsupported-webgpu` panel) could trip the variance threshold.

**`npm run test:integration`** — 4 files. `pipeline.test.ts` and `corrupt-input.test.ts` build synthetic data in
`mkdtempSync` directories and need nothing. `source-geometry-parity.test.ts` is pure math. `gers-pipeline.test.ts`
guards its three data-dependent cases with `DATA_AVAILABLE` and `if (!DATA_AVAILABLE) return;` (`:82, :99, :115`)
— with `data/` present (it is) they execute for real and assert the Gers river passes within 10 m of the
cathedral, prefecture and Boulevard Sadi Carnot anchors, Rue Pasteur within 150 m of the river, and Auch search
results resolve.

**`npm run test:e2e` (Moli + Playwright)** — 5 spec files, 1 worker, no retries, 60 s per test
(`playwright.config.ts:7-9`). All are expected green **but**:
- they are network-dependent via the live osm.org test in `gers-map.spec.ts:142-147` (§3);
- `gers-map.spec.ts:57-70` asserts the initial working set requests **only `l2_` tiles** and fewer than the
  total LOD0 count — an LOD-selection invariant, not a rendering assertion;
- `gers-map.spec.ts:120` asserts **no duplicate tile re-request during a pan** (`ids.length === new Set(ids).size`);
- `gers-map.spec.ts:138-139` requires `__masterMapsTileDiagnostics.aborted.length > 0` on rapid panning — if
  request cancellation is ever made lazy this becomes a false failure;
- `map.spec.ts:277-374` (right-drag heading) is a long multi-assertion test: rotate, persist after release,
  left-drag still pans, wheel still zooms, reset restores `|heading| < 0.08`, and no `nextjs-portal`;
- several tests are *conditionally skipped* by returning early when `data-renderer-status !== "initialized"`
  (`map.spec.ts:116, 174, 183, 225, 241, 260, 278, 378, 396, 431, 479, 506`), so on a machine without WebGPU
  the suite passes while asserting almost nothing. On this host WebGPU is available, so they all run.

**`npm run verify:chrome`** — not a "test" in the vitest/playwright sense; a bespoke script that
hard-fails on: null adapter, `status !== "initialized" || backend !== "webgpu"`, non-north-up initial camera
(`:196-209`), a NOCIBE business that cannot be found in `/api/map/search` (`:322-334`), hardware zoom not
reaching `zoom >= 100` within 240 wheel ticks (`:337-344`), the business hover popup not appearing within 5 s
or resolving to the wrong `data-business-id` (`:405-421`), HJKL not returning the camera to the identical
north-up state (`:426-445`), and **any** `console.error` or `pageerror` event (`:451-465`).

### Fixture assumptions
- Search-name hardcoding: `"Nocibé"` / `"NOCIBE"` must exist as a `business`; `"Musée des Amériques"` as a
  `poi`; `"Avenue d'Alsace"` as a `road`; `"Gare d'Auch"`; `"Cathédrale Sainte-Marie"`;
  `"Boulevard Sadi Carnot"`; `"Le Gers"` as a `water`; `"Gers"`/`"Auch"`/`"Condom"`/`"L'Isle-Jourdain"`.
- Anchors are committed coordinates in `tests/fixtures/{gers,auch}-landmark-anchors.json`; `compare-osm.ts`
  requires `cathedralSainteMarie` **or** `cathedral` in the Auch fixture (`:40-41`) and `gersSouth`/`gersNorth`/
  `boulevardSadiCarnot`/`nocibe`.
- Search must be **accent- and punctuation-insensitive** (`"Nocibé"` matches, `"Cathedrale Sainte Marie"`
  matches `Cathédrale Sainte-Marie`) — that is `normalizeSearchText`, unit-tested in `tests/unit/search.test.ts`.
- DOM contracts pinned by selectors: `#scene-diagnostics`, `canvas`, `input[type="search"]`,
  `[data-testid="search-input"]`, `[role="listbox"]`, `[role="option"][data-feature-kind="<kind>"]`,
  `[data-testid="business-hover-popup"][data-business-id]`, `button:has-text("Réinitialiser")`,
  `button[aria-label="Réinitialiser la vue"]`, `getByRole("complementary", { name: "Détails de l'élément" })`,
  `getByRole("contentinfo", { name: "Sources et attribution" })`, `getByRole("heading", { name: "WebGPU non disponible" })`,
  `[data-testid="map-loading"]`, and the absence of `nextjs-portal`.
- Camera projection math in tests is duplicated three times (`map.spec.ts:52-79`,
  `run-verification.ts:275-292`, `compare-osm.ts:120-129`) and each re-derives the frustum with a `1.15`
  fudge factor. Any change to the camera fit function must update all three or the pointer-to-coordinate
  tests will silently hover the wrong pixel.

---

## 6. Display / headless availability — VERIFIED

```
WAYLAND_DISPLAY=wayland-1  DISPLAY=:0  XDG_SESSION_TYPE=wayland
/run/user/1000/  ->  wayland-1, wayland-1.lock, hypr, ...   (Hyprland compositor)
```
`/dev/dri` has `card0` + `renderD128`. A headed Chrome with a real X11 surface works and yields the same
`amd / gcn-5` adapter as headless-with-Vulkan. So: **headed is available and works, but is unnecessary** —
see §2. `--headless=new` + `--use-angle=vulkan --enable-features=Vulkan` is the cheaper, window-less,
CI-friendly configuration and produces a real hardware adapter here.

---

## 7. Recommended baseline benchmark procedure (for later waves)

Script used to validate this procedure: `/tmp/w1-t08-baseline.mjs` (raw CDP, no Playwright/Chromium download).
Result archived at `/tmp/w1-t08-baseline.json`.

### 7.1 Preconditions
- A production build must exist and be current: `test .next/BUILD_ID` and confirm no `src/**`/`app/**` file is
  newer (`find src app -newer .next/BUILD_ID -name '*.ts*'`). Do **not** run `next build` casually — it triggers
  `data:validate` over the 8.1 GB dataset.
- `data/` present: 9591 tiles (7941 `l0_`, 1254 `l1_`, 396 `l2_`), `tile-manifest.json` 146 MB,
  `search/index.json` 63 MB, generated tiles 8.49 GB total, mean tile 885 KB.
- Free RAM: this host had **~2.0 GB available** at benchmark time. The app's own Next server was already
  resident at ~2.5 GB RSS. **A benchmark run needs ≥ 4 GB free or it OOMs** (observed: my own `next start` on
  3199 was killed mid-benchmark at `free -m` = 1.3 GB free).
- Server: `npm run start -- --port 3100` (or a free port). Measured API costs, prod build, this host:
  | Route | Status | Time | Size |
  |---|---|---|---|
  | `/` | 200 | 0.061 s | 6 579 B |
  | `/api/map/manifest` | 200 | **0.725 s** | **133 617 294 B (127 MiB)** |
  | `/api/map/search?q=Nocibe` | 200 | **2.495 s** (cold index load) | 935 B |
  | `/api/map/search?q=Auch` | 200 | **0.014 s** (warm) | 2 137 B |
  | `/api/map/tile/l0_0_17` (cold) | 200 | 1.508 s | 661 968 B |
  | `/api/map/tile/l0_0_17` (warm) | 200 | 0.010 s | 661 968 B |
  | `/api/map/tile/l2_4_3` (nonexistent) | 503 `DATASET_UNAVAILABLE` | 0.024 s | 60 B |
  The **127 MiB manifest** and the **2.5 s cold search** are the two largest fixed costs in the load path and
  should be the first targets of any data-serve optimisation.

### 7.2 Launch
```
google-chrome-stable --headless=new --no-sandbox --disable-dev-shm-usage --no-first-run \
  --use-angle=vulkan --enable-features=Vulkan --enable-unsafe-webgpu \
  --js-flags=--expose-gc --window-size=1440,900 \
  --remote-debugging-port=9360 --user-data-dir=$(mktemp -d)
```
Then via CDP: `Emulation.setDeviceMetricsOverride {1440, 900, dsf 1}`, `Page.addScriptToEvaluateOnNewDocument`
with the instrumentation below, `Page.navigate` to `http://127.0.0.1:<port>/`, and **always** log
`navigator.gpu.requestAdapter().info` so the run is attributable to a specific adapter.
Record `chrome://gpu`-equivalent facts (vendor/architecture/driver) in the result file.

### 7.3 Routes / scenarios to measure (each as its own run, cold browser profile)
1. **Cold overview** — navigate to `/`, wait for `renderer-status === "initialized" && draw-calls > 0`,
   hold 5 s idle. Measures manifest + initial `l2_` working set.
2. **Department zoom sweep** — 12 wheel steps of `-800` at canvas centre, then 3 s hold. Drives `l2_ → l1_ → l0_`
   transitions. This is the scenario that stresses tile fetch, worker decode and GPU resource growth.
3. **Pan sweep** — three left-drags of ±500 px, 1 s hold. Should abort in-flight tile requests
   (`__masterMapsTileDiagnostics.aborted`).
4. **Right-drag heading** — 200 px horizontal right-drag; confirm `headingRadians` changes and `target` drifts
   < 50 m.
5. **Search typing** — `pressSequentially("Boulevard Sadi Carnot", {delay: 55})`; assert request count
   ≤ `ceil(len/3)`, every response ≤ 32 KiB and ≤ 10 records.
6. **Search fly-to** — select a distant result (`"L'Isle-Jourdain"`), 2 s hold; captures remote tile fetch
   without a department preload.
7. **Mobile** — `setViewportSize 375×667`, reload, repeat scenario 1.

### 7.4 Metrics to collect (all measured from inside the page)
```js
// injected at document start
new PerformanceObserver(l => { for (const e of l.getEntries())
  window.__m.longTasks.push({ start: e.startTime, dur: e.duration }); })
  .observe({ type: "longtask", buffered: true });
new PerformanceObserver(l => { for (const e of l.getEntries())
  window.__m.resources.push({ name: e.name, start: e.startTime, dur: e.duration,
                             size: e.transferSize }); })
  .observe({ type: "resource", buffered: true });
const loop = t => { window.__m.frames.push(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
```
Collect, per phase:
- **FPS** from the rAF deltas: mean, **p50, p95, worst** (p95 is the number that matters, not the mean).
- **Long tasks**: count, max, total (`PerformanceObserver type:"longtask"` — the only existing budget is the
  `< 200 ms` ceiling in `search-performance.spec.ts:117`).
- **Tile fetch**: count, total `transferSize`, mean/max `duration`, split by `/api/map/tile/`, `/api/map/manifest`,
  `/api/map/search`.
- **Heap**: `performance.memory.usedJSHeapSize` before and after `window.gc()` (needs `--js-flags=--expose-gc`).
- **Scene state**: the full `#scene-diagnostics` attribute set at the end of each phase
  (`loaded-tile-count`, `loaded-feature-count`, `draw-calls`, per-kind counts, `camera-zoom`).
- **Console/page errors**: must be empty — `run-verification.ts:451-465` already treats any as failure.

### 7.5 Measured baseline — this host, prod build, headless Chrome 149, adapter `amd / gcn-5`, 1440×900
`readyAfterMs` (navigate → first frame with `draw-calls > 0`) = **67 977 ms**. That number includes my
`next start` restart and heavy machine contention; treat it as an upper bound, not a target.

| Metric | Cold overview | After 12-wheel zoom |
|---|---|---|
| frames sampled | 315 | 371 |
| FPS mean | 32.2 | 17.8 |
| frame p50 / p95 / worst | 16.7 / **116.7** / 400 ms | 16.7 / **266.7** / 400 ms |
| long tasks: count / max / total | 21 / **8319 ms** / 10 324 ms | 62 / 8319 / **17 348 ms** |
| tile requests / bytes | 66 / **82.5 MB** | 177 / **211.1 MB** |
| tile fetch mean / max | 25.6 / 143.6 ms | 19.1 / 143.6 ms |
| manifest requests | 1 | 1 |
| `loaded-tile-count` / `loaded-feature-count` | 62 / 19 771 | 169 / **50 111** |
| `draw-calls` | 7 | 7 |
| `building-count` / `landuse-count` / `business-count` | **0 / 0 / 0** | **0 / 0 / 0** |
| `road-count` / `water-count` / `poi-count` | 17 693 / 1 878 / 138 | 43 936 / 5 060 / 331 |
| JS heap (live) | 735 MB | 2 151 MB |
| JS heap after `gc()` | — | **1 196 MB** (limit 4192 MB) |
| console / page errors | none | none |

**Baseline findings worth carrying forward:**
1. **A single 8.3 s long task dominates the whole run** and repeats in both phases (identical max) — a fixed
   startup cost, almost certainly the 127 MiB manifest parse or the first `l0_`/search-index module.
2. **p95 frame time is 116.7 ms cold and 266.7 ms after zoom** — roughly 4 and 8 frames of budget blown. The
   p50 is a clean 16.7 ms, so the app is fast when idle and stalls on tile/geometry work.
3. **211 MB of tile JSON for a single zoom sweep** with a 19 ms mean fetch. The fetch itself is cheap; the
   main-thread JSON parse + `MapFeatureSchema.parse` is the cost. **VERIFIED: there is no Web Worker anywhere
   in `src/`** — a repo grep for `new Worker`, `Worker(`, `postMessage`, `MessageChannel` and `transferable`
   returns only the local `async` helper `loadWorker` at `MapShell.tsx:294`/`:326`, which is an `async`
   function racing `fetch` inside a `Promise.all`. All tile parsing and Zod validation therefore run on the
   main thread — exactly what a single 8.3 s long task looks like. This directly contradicts the mission
   requirement "render-ready tiles decoded in Web Workers with transferable buffers", which is **not
   implemented at all today**.
4. **Heap grows 735 MB → 2 151 MB → 1 196 MB after GC**, i.e. ~1.2 GB retained for 50 111 features. This is
   the number to watch for per-tile GPU-resource increments.
5. **`building-count`, `landuse-count` and `business-count` are 0** at department zoom — and this is a *data*
   property, not a rendering bug. Tile-file census: 40 sampled `l2_` (overview) tiles contain only `road`
   12 512, `water` 1 297, `poi` 96, `boundary` 40 — **no `building`, no `landuse`, no `business` at all**; 25
   sampled `l0_` (detailed) tiles contain `building` 920, `address` 287, `business` 1, `road` 712, `water` 329,
   `poi` 63, `boundary` 25. Consequences: (a) `map.spec.ts:121-122` asserts `businesses > 0` on the *overview*
   view, which can only be satisfied by a populated `l0_` tile — that assertion is expected to fail as written;
   (b) **`landuse` is absent from every sampled tile at both LODs** while the renderer and the E2E suite both
   treat it as a live layer (`RENDERABLE_KINDS`, `MapShell.tsx:56`; `data-landuse-count` in `sceneMetrics.ts:60`;
   `buildLanduse.ts` 145 lines). Note `validate.ts:18` `REQUIRED_KINDS` deliberately omits `landuse`, which is
   why `data:validate` never flagged it. Landuse is a real, currently-invisible coverage hole.

---

## 8. Concrete recommendations

1. **Stop treating the headed-window comment as truth.** `/tmp/w1-t08-gpu-probe.mjs` proves headless WebGPU
   with a real AMD adapter on this host. Update the comment in `run-verification.ts:9-18`/`:99-107`, and add
   the probe as a cheap precondition check so a later wave can tell "no WebGPU" from "degenerate adapter".
   Note `run-verification.ts:144-153` only checks `adapter !== null` — it cannot distinguish the degenerate
   headless adapter from a real one. Read `adapter.info.vendor`/`architecture` (and
   `"swiftshader"` ⇒ CPU) instead.
2. **Resolve the `NEXT_PUBLIC_MAP_DIAGNOSTICS` fiction** (README `:99` vs. no code reading it). Wire the gate or
   delete both the claim and the `run-e2e.ts:61` line.
3. **Retire the two live-osm.org dependencies** (§3): drop `gers-map.spec.ts:142-147` from the suite and demote
   `compare-osm.ts` to a manual script. Build the data-to-data parity gate from
   `scripts/data/qa-spatial.ts` + `scripts/data/validate.ts` + a new source-vs-generated count reconciliation —
   that is the only variant that can actually gate a regression.
4. **Add the missing metrics to the tracked suite** (§7.3-7.4). The cheapest correct home is a new
   `tests/e2e/performance-baseline.spec.ts` following the exact shape of `search-performance.spec.ts`'s
   `addInitScript` block, reading `#scene-diagnostics` for scene state and writing
   `tests/artifacts/performance/baseline.json` (gitignored today — a tracked
   `baselines/performance.json` would be needed if the numbers are to be diffed in CI).
5. **Respect the memory budget.** Nothing that parses tiles or builds geometry may be launched without ≥ 4 GB
   free; `data:refresh`, `data:build`, `next build` and full vitest/playwright suites are all out of reach at
   the current ~2 GB free.
6. **Move tile decode into real Web Workers with transferable buffers.** VERIFIED absent (§7.5 finding 3) and
   the single largest measured cost (8.3 s long task, 116-267 ms p95 frames). This is mission-mandated and
   currently unimplemented, so it belongs on the critical path for any "smooth navigation" goal.
7. **Decide what `landuse` is.** It is built (`buildLanduse.ts`), counted (`sceneMetrics.ts:60`), rendered
   (`RENDERABLE_KINDS`) and toggled in the layer UI, but it is present in **zero** sampled tiles at either LOD.
   Either source it, or remove it from the renderer, the metric and the layer control — do not ship a
   permanently empty toggle.
8. **Fix or scope the `businesses > 0` overview assertion** (`map.spec.ts:122`) — see §7.5 finding 5.
9. **Start with the 8.3 s long task and the 127 MiB manifest.** They are the two largest fixed costs in every
   measured phase, and the manifest is fetched on every single page load.
