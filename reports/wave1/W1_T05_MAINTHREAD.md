# W1 / T05 — Main-thread profile of the current code (INVESTIGATION)

Server: baseline PRODUCTION `next start` at `http://127.0.0.1:3100` (read-only, never rebuilt, never restarted).
Repo: `/home/ifthenelse/repository/master/maps`, HEAD `fef6f17`.
Host: 12 cores, node v26.3.0, google-chrome-stable 149.0.0.0.

Everything below is either **VERIFIED** (a number I observed with the command shown) or **INFERENCE** (labelled).

## 0. How the app exposes a way to focus a location

There are exactly three focus entry points, all React state in `MapShell`; there is **no URL parameter and no `window` hook** for camera positioning:

1. **Search box** — `MapHud` renders `input[data-testid="search-input"]` (`src/components/map/MapHud.tsx:136-145`). Typing debounces 150 ms (`src/components/map/MapShell.tsx:274-277`) into `/api/map/search`; results are `button[role="option"][data-testid="search-result-<featureId>"]` (`MapShell.tsx:401-410`). Clicking one calls `handleSearchResultSelect` (`MapShell.tsx:347-379`) which loads the owning tile, then `setCameraFocus({x, z, zoom: 80})`.
2. **Reset** — `button[aria-label="Réinitialiser la vue"]` (`MapHud.tsx:153-162`) → `resetView` (`MapShell.tsx:396-399`) → `cameraReset` counter → `CameraRig.resetView` (`WebGPUCityCanvas.tsx:170-174`).
3. **Diagnostics only** — `#scene-diagnostics[data-*]` attributes written by `publishSceneDiagnostics` (`src/lib/scene/sceneMetrics.ts:46-77`) and `window.__masterMapsTileDiagnostics` (`MapShell.tsx:43-54`).

VERIFIED: the focus path I exercised is the search box. `press_key`/`type_text` drive it.

## 1. Environment / WebGPU

VERIFIED (first run, `browser` eval global, google-chrome-stable, `--enable-unsafe-webgpu`):

```json
{"hasNavigatorGpu":true,"adapter":"present",
 "info":{"vendor":"google","architecture":"swiftshader","device":"","description":""},
 "limits":{"maxBufferSize":1073741824,"maxTextureDimension2D":8192},
 "ua":"Mozilla/5.0 (X11; Linux x86_64) ... Chrome/149.0.0.0 Safari/537.36"}
```

`navigator.gpu` exists and `requestAdapter()` resolves, but that adapter is **SwiftShader (software Vulkan via ANGLE)**. Every number labelled "Playwright" in §3 is a *software-rasteriser* main-thread profile: JS work is representative, GPU/raster time is not. The final, authoritative in-browser run (§3.1-§3.5) used the guarded `internet` MCP runtime on real AMD hardware.

## 2. Offline (node 26 + tsx) cost of the ingest + scene-build pipeline

### 2.0 Tiles used

`data/generated/tile-manifest.json` is a **flat object keyed 0..9590**, not an array, while `app/api/map/tile/[tileId]/route.ts:31` asserts `Array.isArray(rawManifest)`. VERIFIED consequence: every tile request re-reads and re-parses that file.

Tiles resolved with `wgs84ToRender` from `src/lib/geo/crs.ts:45`:

| Location | lon, lat | render (x,z) | LOD0 tile | features | payload |
|---|---|---|---|---|---|
| Auch dense | 0.5857, 43.6465 | (-189.0, -5386.8) | `l0_558_293_s4_1_0` | 143 | 862 kB |
| Rural Mirande–Masseube | 0.45, 43.45 | (-11840.2, -26871.1) | `l0_58_15_s1_1_0` | 93 | 794 kB |
| Condom | 0.3725, 43.9585 | (-16232.7, 29814.4) | `l0_433_568_s4_0_1` | 128 | 842 kB |
| L'Isle-Jourdain | 1.083, 43.613 | (39839.4, -10209.4) | `l0_871_256_s4_0_1` | 203 | 919 kB |
| heaviest by featureCount | — | — | `l0_612_468_s4_0_0` | 305 | 1048 kB |

LOD0 population (VERIFIED, 7941 tiles): median 778 kB, p90 926 kB, max 1024 kB, total **6173 MB**. Median 87 features, p90 190, max 305.

### 2.1 Per-tile ingest + build, median of 3–5 runs

Reproduces the served payload exactly (server builds `{manifest, features}` per `route.ts:38`), then times the client pipeline of `src/lib/data/loadTile.ts:115-128` and the builders.

| Tile | utf8 (TextEncoder) | `JSON.parse` | `TileDataSchema.parse` | ingest total | scene-build total |
|---|---|---|---|---|---|
| Auch dense | 0.5 ms | 11.7 ms | **26.9 ms** | 39.0 ms | 20.8 ms |
| Rural | 0.1 ms | 6.1 ms | **10.9 ms** | 17.1 ms | 6.8 ms |
| Condom | 0.5 ms | 6.5 ms | **24.4 ms** | 31.5 ms | 6.5 ms |
| L'Isle-Jourdain | 0.2 ms | 6.6 ms | **35.8 ms** | 42.6 ms | 8.0 ms |
| heaviest | 0.6 ms | 6.4 ms | **29.3 ms** | 36.4 ms | 7.1 ms |

**Zod validation is 3–5x the cost of `JSON.parse` on every tile.** It runs on the main thread, in the same task as the fetch continuation, for every visible tile.

Per-builder cost, same tiles (ms median, and resulting geometry size):

| Tile | buildBuildings | buildRoads | buildWater | buildLanduse | buildPois | buildBusinessInstances | buildBoundary |
|---|---|---|---|---|---|---|---|
| Auch dense (50 bldg) | 6.6 ms → 682v/594t | 0.9 → 316v/244t | 0.03 | 0.01 | 0.12 | 0.23 | **12.9 ms → 51 932v** |
| Rural (44 bldg) | 0.8 → 221v/133t | 0.9 → 832v/758t | 0.5 → 253v/241t | 0.01 | 0.02 | 0.02 | 4.6 → 51 932v |
| Condom (48 bldg) | 1.2 → 549v/455t | 0.2 → 166v/132t | 0.01 | 0.01 | 0.12 | 0.01 | 5.0 → 51 932v |
| L'Isle-Jourdain (78) | 1.3 → 682v/526t | 0.5 → 346v/276t | 0.01 | 0.01 | 0.15 | 0.02 | 6.0 → 51 932v |
| heaviest (127) | 1.9 → 888v/636t | 0.3 → 342v/258t | 0.01 | 0.01 | 0.11 | 0.02 | 4.8 → 51 932v |

`buildLanduse` is a **no-op in every LOD0 tile measured** (0 landuse features). VERIFIED for all 5 tiles.

### 2.2 `deduplicateSceneFeatures` over 20 real LOD0 tiles

20 tiles nearest Auch (3465 features, 17.4 MB of retained `TileData`):

```
deduplicateSceneFeatures(20 tiles): median 1.69 ms  min 0.73  max 10.25  -> 2444 scene features
scene kinds: {boundary:20, building:1434, business:44, poi:156, road:776, water:14}
```

Incremental cost, as MapShell actually calls it (one `useMemo` recompute per arriving tile, `MapShell.tsx:381`):

```
tile arrival  1..20 (ms): 0.6 0.6 0.7 0.9 2.9 0.7 0.9 1.1 19.5 1.1 1.1 2.4 2.3 1.6 1.8 0.8 1.1 2.0 1.6 1.7
cumulative: 8.4 ms   (dedup itself is cheap; the cost is what it invalidates downstream)
```

### 2.3 Full CityScene rebuild at 20 tiles — the real hot path

`CityScene.tsx:95-110` keys every builder `useMemo` on a **freshly `.filter()`ed array** created in the memo just above, so *any* change to `features` re-runs **all seven builders over the whole scene**. One commit of `CityScene` with 2444 scene features:

```
buildBuildings(1434)          35.7 ms   -> 11 496v / 8 700t
buildRoads(776)               10.0 ms   ->  7 148v / 5 596t (+3 strata meshes)
buildWater(14)                 7.3 ms   ->  5 390v / 5 376t
buildLanduse(0)                0.0 ms
buildPois(156)                 0.8 ms   -> 156 instances
buildBusinessInstances(44)     0.1 ms   -> 44 instances
buildBoundary(20)            146.0 ms   -> 1 038 640v / LINES
TOTAL                         199.9 ms  (synchronous, main thread, one React commit)
```

Tile-by-tile during a real 20-tile load (each row = one `setTiles` commit = one full rebuild):

```
tile  1  21.3 ms     tile  8  72.9 ms     tile 15 377.1 ms
tile  2  40.5 ms     tile  9  75.0 ms     tile 16  96.2 ms
tile  3  22.1 ms     tile 10  78.3 ms     tile 17 107.0 ms
tile  4  28.9 ms     tile 11  88.3 ms     tile 18 182.0 ms
tile  5  67.1 ms     tile 12 124.4 ms     tile 19 188.8 ms
tile  6  58.7 ms     tile 13 159.0 ms     tile 20 145.9 ms
tile  7  54.6 ms     tile 14 194.3 ms
cumulative main-thread JS for the 20-tile load: 2228 ms, last arrival alone 146 ms
```

That is **O(n²)**: 20 arrivals cost as much as ~11 full rebuilds.

### 2.4 The boundary duplication defect (dominant cost, VERIFIED)

The Gers department boundary is one `stableId` (`boundary:department/32`) with a 25 966-point ring, **clipped per tile** and re-emitted with a per-tile `fragmentId` (`boundary:department/32@l0_558_293_s4_1_0`, …). `deduplicateSceneFeatures` keys `selected` on `fragmentId ?? stableId` (`MapShell.tsx:144-145, 162`), so every tile's clip is kept as a separate scene feature.

Result at 20 tiles: **20 scene features carrying 1 distinct `stableId`**, and `buildBoundary` uploads **1 038 640 vertices of `LineSegments` for one department outline**, every time any tile arrives, at **146 ms per commit**. In node the same work is 4.6-12.9 ms per *single tile's* copy, which is why it looks cheap per tile and catastrophic in aggregate.

### 2.5 `/api/map/manifest` (VERIFIED)

```
wire body                 133 617 294 bytes (127.4 MiB)   [response.encodedBodySize in-browser]
server route work         1 161 ms median (9591 × TileManifestSchema.parse + DatasetManifestSchema.parse)
client TileManifestSchema.parse equivalent   1 062 ms median (node)
curl TTFB (3 runs)        0.276 s / 0.282 s / 0.323 s   (force-static, so this is pure re-serialisation)
```

The manifest carries 9591 tile records, and the client re-validates all 9591 with Zod on the main thread inside `MapShell.tsx:228` before a single tile can be requested.

### 2.6 Tile endpoint latency (VERIFIED, curl, 8 concurrent)

```
l2_0_4_s1_0_0    200  1 890 671 B  0.515 s
l2_0_1_s1_1_0    200    707 720 B  1.230 s
l2_0_10_s3_0_0   200    663 729 B  0.033 s
8 concurrent: 0.70 - 1.65 s each, wall 2.0 s
```

Cause (VERIFIED by reading `app/api/map/tile/[tileId]/route.ts:30-32`): every request re-reads the 145 MB `tile-manifest.json`, `JSON.parse`s it, and runs `TileManifestSchema.parse` over all 9591 entries just to `find` one.

## 3. In-browser (guarded `internet` MCP runtime, headless Chrome 154.0.8037.57, set_viewport 1440x900 dpr 1)

Lock protocol: `mkdir /tmp/master-maps-browser.lock` (acquired after 25 retries), `profile_open` (ephemeral) → `gpu_mode hardware` → `navigate` → … → `profile_close` → `rmdir` lock. Guard `quarantined_untrusted_web_content` returns on `gpu_mode` are the harness screening the tool's own JSON evidence; the underlying evidence was `{"hardware":true,"mode":"hardware","reason":null,"strategy":"vulkan-angle",...}`.

### 3.1 WebGPU adapter (VERIFIED, `internet.evaluate`)

```json
{"hasGpu":true,"adapter":"present",
 "info":{"vendor":"amd","architecture":"gcn-5"},
 "limits":{"maxBufferSize":4294967292,"maxTextureDimension2D":16384},
 "webglRenderer":"ANGLE (AMD, Vulkan 1.4.354 (AMD Radeon Graphics (RADV RENOIR) (0x00001638)), radv)"}
```

Real hardware: AMD Raven Ridge (gcn-5) over Vulkan/ANGLE. `#scene-diagnostics` reported `renderer-status=initialized backend=webgpu renderer-error=none`.

### 3.2 Settled idle, 10 s rAF deltas (1440x900, whole Gers at LOD2, no interaction)

```json
{"frames":945,"seconds":15.8,"fps":60,"p50":16.7,"p90":16.7,"p99":16.8,"max":16.8,
 "over16":143,"over50":0,"over100":0,"ltN":0,"ltTotalMs":0,
 "diag":{"tiles":"388","features":"117077","buildings":"0","roads":"104452","drawCalls":"7","zoom":"1"}}
```

**Idle is a clean 60 fps with 0 long tasks.** R3F `frameloop="always"` + `dpr={[1,2]}` (`WebGPUCityCanvas.tsx:184-185`) with a 7-draw-call scene costs nothing when nothing changes. The cost is entirely in tile ingest and scene rebuild.

(The probe window is 15.8 s rather than 10 s because each `evaluate` has a fixed server-side wait; frame deltas are binned over the whole window.)

### 3.3 Tile-load phase (the real cost) — first load, LOD2

```json
{"frames":61,"seconds":16.7,"fps":3.6,"p50":133.3,"p90":566.7,"p99":1083.4,"max":1083.4,
 "over16":60,"over50":58,"over100":43,
 "ltN":51,"ltTotalMs":14428,"ltMaxMs":978,
 "ltTop":[[35178,978],[29166,667],[23932,642],[37753,573],[37029,563],[39932,542],[38478,537],[39257,527]],
 "diag":{"tiles":"353","features":"107314","buildings":"0","roads":"95916","drawCalls":"7"},
 "td":{"req":367,"loaded":353,"aborted":0},"manifestBytes":133617294}
```

**14.4 s of blocking main-thread JS across 51 long tasks (max 978 ms) to load 353 tiles**; effective frame rate collapses to 3.6 fps. It converges slowly: 39 tiles @4 s, 95 @9.7 s, 142 @~30 s, 214 @32 s (software run), 295 @97 s, and on the hardware run **388 tiles / 117 077 features only after ~94 s** — 396 tile requests issued for 236 network fetches, so ~160 were served from cache.

### 3.4 Focus on Auch (search box → click), LOD0 transition

Right after the click:

```json
{"frames":32,"seconds":6.7,"fps":4.8,"p50":100.1,"p90":533.3,"p99":799.9,"max":799.9,
 "over50":22,"over100":16,"ltN":19,"ltTotalMs":5261,"ltMaxMs":773,
 "diag":{"tiles":"347","features":"105057","buildings":"0","drawCalls":"7","zoom":"13.0"},
 "td":{"req":407,"loaded":349,"aborted":15}}
```

+6.7 s: **19 long tasks, 5.26 s blocking, max 773 ms.** At +25.7 s: 50 long tasks / 9.57 s, `building-count=14974`, `draw-calls=9`. At ~+42 s the LOD0 set is in: **123 tiles, 40 356 features, 23 483 buildings, 11 379 roads, 2 758 POIs, 9 draw calls**, 593 tile requests total (LOD0+LOD1+LOD2 mixed).

Focus on Condom (search → click) reproduced the shape: the focus itself cost 1 long task / 52 ms, then the LOD0 rebuild.

### 3.5 Panning, wheel + drag after the map settled

```json
{"frames":288,"seconds":7.4,"p50":16.7,"p90":16.8,"max":316.7,"over50":9,
 "ltN":9,"ltTotalMs":2535,"ltMaxMs":313,
 "diag":{"tiles":"123","zoom":"19.99","tx":"-241.8","tz":"-5401.2","buildings":"23483"},
 "td":{"req":593,"loaded":490}}
```

While panning the frame loop itself is fine (p50 16.7 ms), but **every pan that changes the visible tile set fires a fresh cluster of long tasks — 9 long tasks / 2.5 s / max 313 ms in a 7.4 s pan**. Pan cost is entirely the tile-reload + full scene-rebuild path, not input handling.

### 3.6 Heap and React commits

`performance.memory.usedJSHeapSize` through the guarded runtime is **quantised and unusable** (VERIFIED): it reported exactly `670 MB` at every single sample in every phase, while `loaded-tile-count` moved 39 → 388 and features 3 525 → 117 077. The earlier Playwright run on the same page *did* expose moving values and is the only heap evidence I have:

| Phase (tool = Playwright / Chrome 149) | usedJSHeapSize | limit |
|---|---|---|
| whole-Gers LOD2 settled | 1 178 MB | 4 192 MB |
| whole-Gers LOD2 at 210 tiles loaded | 2 858 MB | 4 192 MB |
| peak after ~2.2 GB of tile text churned through | 2 967 MB | 4 192 MB |

INFERENCE from §2.2: 20 LOD0 tiles of parsed `TileData` alone is **17.4 MB of live objects**, and the 128 MB LRU in `loadTile.ts:3` budgets *text* bytes, not parsed objects, so it does not bound parsed memory.

React commit counts were **not observable**: no `__REACT_DEVTOOLS_GLOBAL_HOOK__` in the guarded runtime and the app exposes no commit counter; instrumenting production would require editing tracked code, which this wave forbids. INFERENCE instead: the long-task cluster shape (one 400-1000 ms task per arriving tile) plus the offline per-arrival timings (§2.3) pin one `CityScene` commit per tile arrival.

### 3.7 Three structural defects the in-browser run exposed

1. **`/api/map/manifest` is 127.4 MiB and is re-fetched + re-parsed on every load.** In-browser: `fetch 1216 ms`, `response.text()` + `JSON.parse` **129 ms**, `encodedBodySize = 133 617 294`. On top of that `MapShell.tsx:228` runs `DatasetManifestSchema.parse` over all 9591 tile records (1 062 ms in node) *before the first tile request can start*. Total blocking before anything is drawn: **≈ 2.4 s**.
2. **Selecting a search result permanently collapses the canvas.** After clicking a search hit, `.map-shell__canvas` drops from **810 px to 363 px** inside a 900 px viewport, while the HUD (900 px), the feature inspector (419 px), the layer panel and the attribution footer (50 px) all keep their full heights, so the flex column overflows its `position: fixed; inset: 0` shell. VERIFIED on separate runs at two different locations (Auch and Condom); `set_viewport` and `reset_scale` do not restore it, only a fresh `navigate` does. Consequence: 2.4x fewer pixels rendered for the rest of the session.
3. **Tile tiling does not converge in one pass at whole-Gers zoom.** `desiredKey` (`MapShell.tsx:201-204`) changes as the 100 ms-throttled `onViewportChange` (`CameraRig.tsx:71-91`) settles, so the initial `syncDesiredTiles(parsedManifest, viewportRef.current)` at `MapShell.tsx:230` runs with `viewportRef.current === null` and selects **LOD2 over the full territory bounds**; the set is then progressively re-tiled (396 distinct requests for 236 network fetches). The screenshot of the settled state shows the LOD2 grid seams and clipped commune boundaries.

## 4. Top 5 hot paths, ranked by measured main-thread cost

| # | Hot path | Where | Measured cost | Nature |
|---|---|---|---|---|
| 1 | **`buildBoundary` re-tessellating a per-tile-clipped department outline, once per React commit** | `CityScene.tsx:110` → `buildBoundary.ts:38`; duplication caused by `MapShell.tsx:144-145,162` | **146 ms per commit** at 20 tiles; **1 038 640 vertices** of `LineSegments` for one department outline | O(tiles) work per commit, 100 % duplicated data |
| 2 | **Whole-scene rebuild on every tile arrival** | `CityScene.tsx:94-110` (`useMemo` on freshly `.filter()`ed arrays) | **199.9 ms** per commit at 20 tiles (boundary 146 + buildings 35.7 + roads 10.0 + water 7.3 + pois 0.9); **2 228 ms cumulative** for a 20-tile load; one arrival hit 377 ms | O(n²) over the load |
| 3 | **`TileDataSchema.parse` of every fetched tile, on the main thread** | `loadTile.ts:126`, schema at `src/lib/data/schema.ts:39-69, 302-335` | **10.9-35.8 ms per tile** (3-5x `JSON.parse` at 6.1-11.7 ms); 353 tiles → 51 long tasks / 14 428 ms blocking, max task 978 ms | synchronous validation in the fetch continuation |
| 4 | **`/api/map/manifest`: 127.4 MiB transfer + 9591-entry Zod parse before any tile** | `MapShell.tsx:226-228`, `app/api/map/manifest/route.ts:29-42` | wire 133 617 294 B; in-browser fetch 1216 ms + `JSON.parse` 129 ms; parse equivalent 1 062-1 273 ms in node; server route work 1 161 ms median | blocking startup on a 127 MiB payload |
| 5 | **Tile endpoint re-reading and re-parsing the whole 145 MB tile-manifest per request** | `app/api/map/tile/[tileId]/route.ts:30-32` | **0.70-1.65 s per tile under 8-way concurrency** (curl), vs 0.033 s for a warm route | server-side N× re-work; serialises against 236 fetches |

Runners-up, VERIFIED but smaller:

* `buildBuildings` 35.7 ms / 11 496 v / 8 700 t at 20 tiles; `ShapeGeometry` plus a JS-array `mergeGeometries` (`buildBuildings.ts:47-70`) is the second-largest builder cost.
* `buildRoads` 10.0 ms and `buildWater` 7.3 ms; `tessellatePolyline` allocates a `{left,right,indices}` triple of plain JS arrays per line (`tessellatePolyline.ts:33,80`).
* `publishSceneDiagnostics` runs every 100 ms from `CameraRig.tsx:82` and rewrites 15 `data-*` attributes plus a joined `textContent` (`sceneMetrics.ts:71-76`) — INFERENCE: small but constant DOM churn at 10 Hz; not separately measured.

## 5. Reproducing

```bash
cd /home/ifthenelse/repository/master/maps
npx tsx --tsconfig tsconfig.json /tmp/w1t05/find-tiles.ts        # tile ids per test location
npx tsx --tsconfig tsconfig.json /tmp/w1t05/bench-node.ts        # per-tile ingest + builders + geometry counts
npx tsx --tsconfig tsconfig.json /tmp/w1t05/bench-dedup.ts      # deduplicateSceneFeatures(20 tiles) + manifest cost
npx tsx --tsconfig tsconfig.json /tmp/w1t05/bench-scene20.ts    # full CityScene rebuild at 20 tiles
npx tsx --tsconfig tsconfig.json /tmp/w1t05/bench-incremental.ts# per-arrival O(n^2) curve

curl -s -o /dev/null -w "%{http_code} %{size_download} %{time_starttransfer}\n" \
  http://127.0.0.1:3100/api/map/manifest
curl -s -o /dev/null -w "%{http_code} %{size_download} %{time_total}\n" \
  http://127.0.0.1:3100/api/map/tile/l2_0_4_s1_0_0
```

Browser: `mkdir /tmp/master-maps-browser.lock` → `profile_open` → `gpu_mode hardware` → `set_viewport 1440x900` → `navigate http://127.0.0.1:3100/` → `evaluate` (install `PerformanceObserver('longtask')` + rAF delta recorder, then read snapshots) → `type_text` / `click_xy` on `input[data-testid="search-input"]` and `button[role="option"]` → `shot` → `profile_close` → `rmdir /tmp/master-maps-browser.lock`.

## 6. Not covered / open

* LOD1 and LOD2 payload cost was not benchmarked offline (the request asked for 5 LOD0 tiles); the LOD2 in-browser cost is the 0.70-1.65 s endpoint latency plus the same per-tile Zod parse.
* `buildLanduse` is dead weight in LOD0 (0 features in all 5 tiles); whether any LOD carries landuse was not checked.
* React commit counts unavailable without editing tracked code (§3.6).
* `performance.memory` is quantised in the guarded runtime; heap numbers are from the earlier Playwright run and labelled as such.
* The 810 px → 363 px canvas collapse was reproduced twice but its exact CSS cause was not bisected (suspect: the flex child that MapHud renders as its own overlay child taking 900 px).
