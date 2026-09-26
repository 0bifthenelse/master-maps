# W1-T01 REPO TRUTH — Master Maps (Next.js 16 / R3F / WebGPU, Gers 32)

Repo: `/home/ifthenelse/repository/master/maps` · branch `master` · HEAD `fef6f17 Improve search and Auch OSM fidelity` (2026-08-28) · tree clean · 143 tracked files, 31 989 lines (9 394 of them `package-lock.json`).
Node v26.3.0, Next.js 16.3.3, three 0.185.1, zod 4.4.3, proj4 ^2.21.0, polygon-clipping 0.15.7, react 19.2.8.
`VERIFY` = observed in this session. `INFER` = reasoned from code.

---

## 1. Commands (package.json:5-23) and measured cost

| Script | Exact command | Measured |
|---|---|---|
| `typecheck` | `tsc --noEmit` | **6 s**, exit 0 ✔ VERIFY |
| `lint` | `eslint .` | **11 s**, no output ✔ VERIFY |
| `test:unit` | `vitest run tests/unit tests/visual` | 3-file subset (crs/projection/tiling) = **2 s**, 18 tests pass ✔ VERIFY. Full suite NOT run. |
| `test:integration` | `vitest run tests/integration` | 1-file subset (`source-geometry-parity`) = **2 s** ✔ VERIFY. Full suite NOT run. |
| `test` | `test:unit && test:integration` | — |
| `test:e2e` | `tsx scripts/moli/run-e2e.ts` | `playwright --list` = **2 s**, **32 tests / 5 files** ✔ VERIFY. Actual run needs Next prod server (port 3100) + `moli serve` CDP (9222); not run. |
| `verify:chrome` | `tsx scripts/chrome/run-verification.ts` | not run (needs prod build + real GPU Chrome, ports 3102/9333) |
| `build` | `npm run data:validate && next build` | `.next` present, **393 MB**. `next build` NOT run (RAM: 1.1–7 GB free at sampling times). |
| `compare:osm` | `tsx scripts/chrome/compare-osm.ts` | not run |
| `data:refresh` / `data` | `NODE_OPTIONS=--max-old-space-size=12288 tsx scripts/data/refresh.ts` | NOT run. Note the **12 GiB** Node heap cap vs. ~27 GB total / 1–8 GB free RAM. |
| `data:build` | same + `--offline` | NOT run |
| `data:validate` | `tsx scripts/data/validate.ts` | **fails today**, 4 s: `ENOENT data/gers-boundary.geojson` (see §7) |
| `data:qa` | `tsx scripts/data/qa-spatial.ts` | NOT run |
| `data:verify-cache` | `tsx scripts/data/verify-cache.ts` | NOT run |

`data:*` scripts all carry `NODE_OPTIONS=--max-old-space-size=12288` (package.json:17-22).

### Cheapest usable inner loop (VERIFIED green)
```
npx tsc --noEmit                                  # 6 s
npx eslint .                                      # 11 s
npx vitest run <one file>                         # ~2 s per small file
npx playwright test --config playwright.config.ts --list   # 2 s
```

---

## 2. Module dependency map (imports extracted from all 143 tracked sources)

Legend: **hot** = imported by ≥4 modules, i.e. every later work package touches it.

### 2.1 Layered graph (top → bottom)

```
app/page.tsx (dynamic, ssr:false)
  └─ src/components/map/MapShell.tsx            [435 L, "use client"]  ← TOP-LEVEL ORCHESTRATOR
      ├─ MapHud / FeatureInspector / LayerControls / SourceAttribution / LoadingState / WebGPUUnsupported
      ├─ dynamic → WebGPUCityCanvas.tsx  → CameraRig → MapCamera + MapControls
      ├─ dynamic → CityScene.tsx        → buildBoundary/Buildings/Landuse/Pois/Roads/Water + materials
      ├─ @/lib/data/loadTile  (fetch + LRU, no worker)
      ├─ @/lib/data/search    (normalizeSearchText)
      ├─ @/lib/data/searchTypes (SearchHitSchema)
      ├─ @/lib/data/schema    (DatasetManifestSchema, MapFeature, TileData, FeatureKind)
      ├─ @/lib/geo/focus (computeLocalFocus), @/lib/geo/crs (wgs84ToRender)
      └─ @/lib/scene/sceneMetrics

app/api/map/manifest/route.ts   → @/lib/data/schema, node:fs, MASTER_MAPS_DATA_DIR
app/api/map/tile/[tileId]/route.ts → @/lib/data/schema, node:fs, MASTER_MAPS_DATA_DIR
app/api/map/search/route.ts    → @/lib/data/searchServer → {searchTypes, schema, search} ; node:fs

scripts/data/refresh.ts   (492 L, orchestrator)
  ├─ fetch-admin-express.ts, fetch-bdtopo.ts, fetch-osm.ts, fetch-addresses.ts,
  │  fetch-businesses.ts, fetch-ign.ts   — spawned as CHILD PROCESSES via execFile("tsx", …)
  │  with env MASTER_MAPS_DATA_DIR propagated (refresh.ts:113-119)
  ├─ normalize.ts → normalizeBdtopo.ts, normalizeOsmBulk.ts, boundaryIndex.ts, @/lib/geo/{focus,crs,polygon}
  ├─ deduplicate.ts → polygon-clipping, @/lib/geo/crs, schema
  ├─ osmRelations.ts
  ├─ build-tiles.ts → @/lib/geo/polygon, schema
  ├─ build-search-index.ts → schema
  ├─ qa-spatial.ts → @/lib/scene/{buildBuildings,buildRoads,buildWater,debugGeometry}, @/lib/geo/crs
  └─ validate.ts → schema, territory, boundaryIndex

scripts/chrome/run-verification.ts → ../../src/lib/geo/crs   (the only script importing src besides data/*)
scripts/chrome/compare-osm.ts      → playwright only
scripts/moli/run-e2e.ts            → spawns `npm run start` + `moli serve` + `npx playwright test`
```

### 2.2 `src/lib/data` — the shared contract tier
| File | Lines | Importers | Role |
|---|---|---|---|
| `schema.ts` | 455 | **37** | Zod source of truth: Geometry union, 9 `FeatureBase` extensions, `TileManifestSchema`, `TileDataSchema`, `SearchRecordSchema`, `DatasetManifestSchema`, `CoverageReportSchema`, `FEATURE_KINDS` |
| `territory.ts` | 36 | **13** | `GERS_TERRITORY` (code 32, renderOrigin [0.586, 43.695], bootstrapBbox, tile sizes 2048/8192/32768), `AUCH_DETAIL_SCOPE` (32013, `outputRoot: "data/auch"`), `isGersDepartmentCode` |
| `searchTypes.ts` | — | 6 | `SearchHitSchema`, `SEARCH_LIMIT_{DEFAULT,MAX}`, `SEARCH_MIN_QUERY_LENGTH`, `SEARCH_MAX_QUERY_LENGTH` (imports `FEATURE_KINDS` from schema) |
| `search.ts` | — | 6 | accent-insensitive normalize/tokenize, `scoreTerm`, `levenshteinBounded`, `MAX_EDIT_DISTANCE` |
| `searchServer.ts` | 260 | 2 | server index load, 3-char prefix buckets, 64-entry hit LRU, mtime+size versioning |
| `loadTile.ts` | 136 | 1 | fetch + LRU (128 MB / 64 entries / 2 MiB tile cap), AbortController, `TileDataSchema.parse` on the **main thread** |
| `normalize.ts` | 151 | 1 (test) | runtime geometry compat (`clipToBoundary`) — thin re-wrapper over `@/lib/geo/polygon` + schema |
| `provenance.ts` | 325 | **0** | **DEAD**: no importer anywhere (grep `data/provenance` → 0 hits outside itself) |

### 2.3 `src/lib/geo`
`crs.ts` (14 importers; proj4; EPSG:4326↔2154↔render) · `polygon.ts` (5; ring closure, point-in-polygon, clip-to-polygon/bounds; `Bounds2D` duplicated) · `projection.ts` (5; `LocalProjection`, `computeCenter`) · `focus.ts` (3) · `bounds.ts` (2) · **`tiling.ts` (270 L) — 0 importers in app/src/scripts; only `tests/unit/tiling.test.ts`, which re-declares its own `Bounds2D` instead of importing** → also effectively dead (INFER; grep is exact).

### 2.4 `src/lib/scene`
`buildRoads` (4) · `buildWater` (4) · `geometryCoordinates` (4) · `buildBuildings` (3) · `buildPois` (3) · `tessellatePolyline` (3) · `materials` (1, CityScene) · `buildBoundary` (1) · `buildLanduse` (1) · `debugGeometry` (1, QA only) · `sceneMetrics` (4).
All builders are **pure Three.js geometry factories returning `BufferGeometry`**, and three of them (`buildBuildings`, `buildRoads`, `buildWater`) are executed by the Node QA script — so they must stay Node-importable (no DOM, no `window`).

### 2.5 `src/components/map`
`MapShell` (435) is the hub: imports 5 UI components + schema + loadTile + search + crs + focus + sceneMetrics, and dynamically loads `WebGPUCityCanvas` and `CityScene` with `ssr: false`. `MapCamera.tsx` (389) owns right-drag heading (pointer capture, `e.button !== 2` guard, `contextmenu` preventDefault — lines 180-237). `MapControls.tsx` wraps drei `MapControls` and adds HJKL (lines 91-131, `shouldHandle` ignores INPUT/TEXTAREA/SELECT/contentEditable).
`CameraRig` combines `MapCamera` + `MapControls`; `BusinessHoverPopup3D` uses drei `<Html>`.

---

## 3. Shared-contract files — conflict hotspots for later work packages

Ranked by number of direct importers. Any change here is a cross-cutting edit.

1. **`src/lib/data/schema.ts`** — 37 importers (every route, every pipeline stage, 8 test files). `.strict()` on every object: adding a field is safe, **renaming/removing one breaks 37 sites**. `FeatureBaseSchema` fields (lines 156-178) are the canonical feature contract. `FEATURE_KINDS` (line 314) couples schema → `searchTypes` → `SearchRecordSchema.kind` → `RENDERABLE_KINDS` in `MapShell.tsx:56-66`.
2. **`src/lib/data/territory.ts`** — 13 importers: 5 fetch scripts, `refresh.ts`, `validate.ts`, `normalize.ts`, `qa-spatial.ts`, `crs.ts`, `verify-cache.ts`, `gers-pipeline.test.ts`, `landmark-topology.test.ts`. Owns render origin, tile sizes and BOTH data scopes.
3. **`src/lib/geo/crs.ts`** — 14 importers incl. `scripts/chrome/run-verification.ts` and `tests/e2e/map.spec.ts`; the only projection allowed (`docs/architecture.md:9-13`).
4. **`src/lib/geo/polygon.ts`** — 5 importers across 4 pipeline stages + defines its own `Bounds2D` (line 5) while `geo/tiling.ts` imports a second `Bounds2D` from `geo/bounds.ts`. Two incompatible bounds types coexist. **INFER: hotspot for any clipping work.**
5. **`src/components/map/MapShell.tsx`** — the sole client orchestrator (tile working set, abort, prune, search, focus, layers). Any client work package lands here.
6. **`src/lib/scene/*` builders** — 4 of them are shared between the browser and the Node QA script.
7. **`scripts/data/refresh.ts`** — the pipeline orchestrator; every new source layer must be registered as a `phase*` function here.
8. **`src/lib/data/searchTypes.ts` / `search.ts` / `searchServer.ts`** — the 3-file search contract, mirrored on both sides of the wire.
9. **`scripts/data/validate.ts` + `data/qa/validation-report.json`** — the auditability contract; any new layer must extend `REQUIRED_KINDS` (line 19).
10. **`vitest.config.ts`** — `include: tests/**/*.test.ts`, `exclude: tests/e2e/**, tests/visual/**`, alias `@ → ./src`.

**Non-hotspots to change freely:** `src/lib/data/loadTile.ts`, `src/lib/geo/{focus,bounds}`, `src/lib/scene/{materials,sceneMetrics,debugGeometry}`, most `src/components/map/*` leaves, `scripts/chrome/*`.

**Dead code that later packages must NOT build on:** `src/lib/data/provenance.ts` (325 L, 0 importers), `src/lib/geo/tiling.ts` (270 L, 0 app importers). `tests/unit/provenance.test.ts` and `tests/unit/tiling.test.ts` re-implement their subject inline instead of importing — they are **pinning copies, not tests of the modules** (VERIFIED by reading both files' headers).

---

## 4. Data volume handling

`MASTER_MAPS_DATA_DIR` (default `"data"`) is read independently in **18 places** (VERIFIED grep) — 3 API routes, `searchServer`, 13 pipeline scripts, 4 test files. There is no central accessor.

- `territory.ts` does **not** read the env var; it only declares `AUCH_DETAIL_SCOPE.outputRoot = "data/auch"`, which is used by `refresh.ts:35` (`path.join(DATA_ROOT, "auch")`) — i.e. AUCH output is always a subdir of the configured root, never an independent root.
- `refresh.ts:113-119` re-exports `MASTER_MAPS_DATA_DIR` into every spawned fetch child, so a single env var drives the whole pipeline.
- Manifest and tile routes are `export const dynamic = "force-static"` (manifest/route.ts:6, tile/route.ts:9) while the search route is `force-dynamic` (search/route.ts:11). **Consequence: `MASTER_MAPS_DATA_DIR` must be set at build time for the static routes** — a runtime-only override will not be honoured. VERIFIED by code read; the Next behaviour is INFER.
- Routes read `dataRoot/generated/{manifest.json,tile-manifest.json,tiles/<id>.json}` and `dataRoot/search/index.json` only. Tile IDs validated by `/^[a-zA-Z0-9_-]+$/`, length ≤ 128, no `..`; 2 MiB hard cap (tile route lines 6-24).
- **All routes read from `process.env` directly at request time** — not compatible with edge runtime; no `export const runtime` is set anywhere (default Node.js runtime).

### Measured volume (VERIFY, `du -sh`)
```
3.5G  data/raw          1.1G  data/intermediate    8.1G  data/generated
63M   data/search        12K   data/manifests       168K   data/qa
387M  data/auch  (241M generated, 143M intermediate, 3.8M search)
```
- Tiles: **7941 LOD0 + 1254 LOD1 + 396 LOD2 = 9591** files, `data/generated/tile-manifest.json` = **146 MB / 9591 entries**.
- `data/search/index.json` = **65 473 097 bytes, 254 830 records**. Parsed fully into memory by `searchServer.ts:64-74` at first query and versioned by `mtimeMs-size` (line 108) — a 65 MB `JSON.parse` + full Zod parse of 254 830 records happens on the first request of each cold server.
- Max tile bytes 2 094 406 (`l1_11_11_s1_1_1`), under the 2 MiB ceiling (2 097 152).
- Manifest `bounds` = `[-71680, -43008, 59392, 55296]` m, render origin `[0.586, 43.695]`, 691 340 total features.

---

## 5. Build assumptions

- `tsconfig.json` **includes only `src/**`, `app/**`, `.next/types/**`**. `scripts/**` and `tests/**` are NOT typechecked (excluded implicitly; `noUncheckedIndexedAccess`, `noUnusedLocals`, `strict` are on). **VERIFIED.** Consequence: `npm run typecheck` says nothing about `scripts/data/*` or any test — they are covered only by `eslint` (which does lint `tests/**` and `scripts/**`, eslint.config.mjs:26-32) and by actually running them.
- `vitest.config.ts` has no `environment: "jsdom"` (it is `node`), so any test touching `document`/`window` must not use vitest — hence `tests/visual/*` is a node-side artifact inspector, not a DOM test.
- `next.config.ts`: `serverExternalPackages: ["three"]`, lint and TS errors **not** ignored during build, `experimental.webpackBuildWorker: true`.
- `three-stdlib` is imported directly by `MapControls.tsx:7` and `MapCamera.tsx:6` but is **not a declared dependency** (only a transitive of `@react-three/drei`; resolved 2.36.1). VERIFIED — this is an undeclared direct dependency.
- **No Web Worker anywhere.** grep for `new Worker|postMessage|transfer|ArrayBuffer|OffscreenCanvas` in `src/` + `app/` returns zero hits. `MapShell.tsx:294` defines an async function literally named `loadWorker` — it is a concurrency pool (`TILE_LOAD_CONCURRENCY = 8`), not a worker. Tile JSON is `fetch`ed, `JSON.parse`d, and Zod-parsed on the main thread (`loadTile.ts:117-126`).
- **No label layer.** grep for troika/TextGeometry/font in `src/` returns nothing. `BusinessHoverPopup3D` uses drei `<Html>` DOM overlays; there is no cartographic label system.
- **No touch/pinch handling.** grep for `touchstart|pinch|pointercancel` in `src/` → only the rotation `pointercancel` cleanup. Touch is delegated to drei `MapControls`.
- **No right-click context menu on features.** `MapCamera.tsx:215-217` only `preventDefault()`s the native menu; no feature pick at that point.
- `next/dynamic` with `ssr:false` on the WebGPU canvas (MapShell.tsx:26-27) means the whole 3D surface is client-only.

---

## 6. Tests — what actually exists and what it covers

**Config:** `vitest.config.ts` `include: tests/**/*.test.ts`, excludes `tests/e2e/**` and `tests/visual/**` → **`test:unit` passes `tests/visual` as a filter but vitest's own exclude wins; `npx vitest run tests/visual` returns "No test files found, exiting with code 1"** (VERIFY, 1 s). So `tests/visual/moli-visual-states.test.ts` is **dead code that never runs** and `npm run test:unit` silently skips it.

**39 unit files, ~163 `it()` cases; 4 integration files, 22 cases; 32 Playwright e2e tests; 1 dead visual file.**

### Unit (`tests/unit`, all in `tests/unit/*.test.ts`)
Geometry/CRS: `crs` (2), `projection` (9), `multipolygon-boundary` (1), `polygon` (12), `bounds` (5), `tiling` (7 — **self-contained, does not import `src/lib/geo/tiling.ts`**), `polyline-tessellation` (5), `scene-coordinates` (3), `camera-projection` (1), `normalization-geometry` (2).
Schema/data: `canonical-schema` (5), `stable-id` (6), `manifest` (12), `coverage` (6), `height` (6), `runtime-normalize` (3), `normalize` (13).
Pipeline: `bdtopo-normalization` (3), `normalize-osm-bulk` (2), `osm-relations` (4), `osm-geometry-precedence` (2), `conflation` (4), `deduplication` (6), `tile-fragmentation` (4), `business-normalization` (1), `landmark-topology` (2), `boundary-index` (3).
Search: `search` (9), `search-server` (11), `search-route` (8, exercises the real Next `GET` with a temp `MASTER_MAPS_DATA_DIR` fixture), `http-cache` (8, spins a real `node:http` server).
Scene: `business-picking` (1).
`provenance` (9) — **re-implements priority logic inline**; does not import `src/lib/data/provenance.ts`.

### Integration (`tests/integration`)
- `pipeline.test.ts` (6) and `corrupt-input.test.ts` (11) build a **temp-dir synthetic dataset** with `mkdtempSync` and run the real pipeline. Self-contained, no repo data needed.
- `gers-pipeline.test.ts` (4) — **depends on the real 13 GB volume**; gated by `DATA_AVAILABLE = existsSync(raw/gers-boundary.geojson) && existsSync(search/index.json) && existsSync(intermediate)` and **silently `return`s (passes) when the volume is absent**. It asserts 15 anchors, 10 department towns inside the boundary, and Gers-river topology.
- `source-geometry-parity.test.ts` (1) — CRS round-trip parity, 531 ms.

### E2E (`tests/e2e`, Playwright over **Moli CDP**, `chromium.connectOverCDP`, never `launch`)
- `gers-map.spec.ts` (8): initial LOD2-only working set, distant search without preload, LOD transition after zoom, pan without reload, stale-request rejection, OSM reference navigation, HJKL + right-drag heading reset, search identity across tile boundaries.
- `map.spec.ts` (16): non-blank canvas, no Next error overlay, search focus, layer a11y, attribution, narrow viewport, HJKL, HJKL suppressed while typing, drag pan, wheel zoom, right-drag heading, street-geometry centering, reset view, business hover, POI-vs-business hover, mobile fit.
- `visual-states.spec.ts` (5): 5 PNG-state checks via `checkPngNotBlank`.
- `search-performance.spec.ts` (1): typing responsiveness + bounded responses.
- `unsupported-webgpu.spec.ts` (2): explicit unsupported panel, no silent WebGL fallback.
- Runner `scripts/moli/run-e2e.ts`: starts `npm run start --port 3100` and `moli serve --port 9222`, sets `NEXT_PUBLIC_MAP_DIAGNOSTICS=1` and `PLAYWRIGHT_BROWSERS_NONE=1`, waits for both ports, then `npx playwright test`. **Requires a production `.next` build** — none of the e2e specs can run against `next dev` without edits.

### Visual (`tests/visual/moli-visual-states.test.ts`, 4 cases) — never executed
Cases 1-3 assert a hardcoded array against itself, an array against itself, and that `app/globals.css` contains 3 token names — pure tautologies. Case 4 scans `tests/artifacts/moli` and skips if absent. **This file should be deleted, not maintained.**

---

## 7. Doc claims vs. code — mismatches found

| Claim | Reality | Verdict |
|---|---|---|
| `README.md:82` "visual/ visual-state matrix definitions" | Excluded by `vitest.config.ts:9`; `npx vitest run tests/visual` → **exit 1, no test files** | **FALSE** |
| `README.md:186` "`test:unit` Vitest unit and visual-state tests" | visual-state file never runs | **FALSE** |
| `README.md:180` `npm run build` = "Validate data, then run `next build`" | `npm run data:validate` **currently exits 1** (`ENOENT data/gers-boundary.geojson`) → **`npm run build` cannot succeed as-is** | **BROKEN** VERIFY |
| Root cause of the above | `validate.ts:203` sets `rawDir = scope?.rawDir ?? dataRoot()` = `data`, but the boundary lives at `data/raw/gers-boundary.geojson` (`territory.ts:9` names it `boundaryRawFile`; `fetch-admin-express.ts:16` writes `RAW_DIR`). `refresh.ts:481` only passes an explicit `rawDir` **for the AUCH scope**. | **BUG** VERIFY |
| `docs/accuracy-audit.md:24-26` LOD0 7 985 / LOD1 1 257 / LOD2 397 | Actual `data/generated/tile-metrics.json`: **7941 / 1254 / 396** | **STALE** VERIFY |
| `docs/accuracy-audit.md:9` "691 387 features"; manifest says `tileCount 9591`; coverage.json says `tileCount 9591`; validation-report says `tileCount 9639` | three different tile counts coexist across artifacts of the same run | **INCONSISTENT** VERIFY |
| `docs/accuracy-audit.md:43` "154 unit tests, 4 integration tests" | 163 unit `it()`s, 22 integration `it()`s | **STALE** VERIFY |
| `docs/coverage.md:21` and `docs/data-refresh.md:50` "round trips below 0.05 m" | `data/qa/spatial-report.json` worst = **1.49e-8 m** — passes, doc is not wrong, just loose | OK |
| `docs/data-refresh.md:24` "exports four required canonical layers" | `data/raw/` holds `bdtopo-{buildings,roads,water-lines,water-surfaces}.geojson` = 4 ✔ | OK |
| `README.md:33` lists `src/lib/data/deduplicate.ts` | file does not exist (dedup lives in `scripts/data/deduplicate.ts`) | **STALE** VERIFY |
| `README.md:32` `normalize.ts  runtime geometry compatibility API` under `lib/data/` | correct (`src/lib/data/normalize.ts` exists) | OK |
| `README.md:36-38` geo listing omits `crs.ts` and `focus.ts` | both exist and `crs` has 14 importers | **INCOMPLETE** |
| `docs/architecture.md:47` "The previous working set stays visible until one replacement tile arrives" | `MapShell.tsx:310-311` — pruning is gated on `replacementReady = desiredIdsRef.current.some(id => next.has(id))` ✔ | OK |
| `PROJECT_STATE.md` HEAD `179da92 UNCOMMITTED WORKTREE` | actual HEAD is `fef6f17`; worktree clean | **STALE** |
| `PROJECT_STATE.md:17` "AUCH VALIDATION 0 ERRORS 0 WARNINGS" | `data/auch/qa/validation-report.json` = 0 issues ✔ | OK |
| GERS validation clean | `data/qa/validation-report.json` = **10 errors**, all "feature anchor lies outside the Gers boundary" (7 `osm-bulk:*`, 1 `ign-bdtopo:water-line/TRON_EAU…`, etc.). `validate.ts:228` throws on any error. | **10 REAL ERRORS** VERIFY |

**Net:** the Gers volume on disk is *stale and invalid* (10 anchor errors, a 9639-vs-9591 tile-count split, a validation run older than the manifest by 33 minutes) and the Gers-scope `data:validate` path is outright broken. The Auch scope is clean.

---

## 8. Deployment model

- `next build` + `next start` on the host; the **data volume is never bundled** — it must be present (or bind-mounted) at `MASTER_MAPS_DATA_DIR` on the target (`README.md:237`).
- `data/` is `/data/*` + `!/data/.gitkeep` gitignored (`.gitignore:2-3`); `tests/artifacts/` and `.next/` also ignored.
- Because the manifest/tile routes are `force-static`, the data root is effectively **baked at build time** for those two routes. A container that ships `data/` separately from the build would serve a stale or missing volume. The search route, being dynamic, re-reads the env every request.
- No Dockerfile, no CI config, no `vercel.json`, no health endpoint anywhere in the repo (VERIFY: only 143 tracked files, listed above).

---

## 9. Findings that matter for the mission (Workers, transferable buffers, labels, interaction)

1. **No Worker, no transferable buffers** — the single biggest architectural gap vs. the mission. The decode+Zod-validate path is main-thread (`loadTile.ts:117-126`), on up to 8 concurrent 1 MiB payloads.
2. **No incremental per-tile GPU resources** — `CityScene.tsx` rebuilds scene geometry from React state; the LRU in `loadTile.ts` is JS-object-level, not GPU-resource-level, so a pruned tile's `BufferGeometry` disposal path needs checking in `CityScene`.
3. **No label system at all.**
4. **No touch pinch**; **no right-click context menu on features** (only native-menu suppression).
5. **Cursor-anchored wheel zoom** is drei `MapControls` default behaviour, not implemented in this repo — so it is unverified by any test beyond "mouse wheel zooms in and out".
6. `data/search/index.json` at 65 MB / 254 830 records is fully parsed and Zod-validated per cold start — a hard floor on search latency and on memory (the 12 GiB Node heap cap applies to the pipeline scripts, not to `next start`).
7. `src/lib/data/provenance.ts` (325 L) and `src/lib/geo/tiling.ts` (270 L) are dead; `tests/unit/{provenance,tiling}.test.ts` and `tests/visual/*` test copies, not the modules. **595 lines of production code + 4 test files that assert nothing about the shipped modules.** Delete, do not maintain.
8. `three-stdlib` is an undeclared direct dependency of two client components.
9. `npm run build` is currently unrunnable because of the `validate.ts` rawDir bug — this must be fixed before any E2E work, since every e2e spec needs a production build.
