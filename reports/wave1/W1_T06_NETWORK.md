# WAVE 1 / TASK 06 — Network / Tile / Cache Profile

Target: `next start -p 3100` (PID 162996, next-server v16.3.3), used read-only.
All HTTP numbers from `curl` against `http://127.0.0.1:3100`. Browser numbers from the
guarded `internet` MCP routes (HeadlessChrome/154.0.8037.57, `gpu_mode: hardware`,
viewport 1440x900, dpr 1) and, where labelled, from an earlier Playwright/Chrome 149
channel run. VERIFIED = observed. INFERENCE = reasoned, not directly observed.

---

## 0. Headline findings (severity ordered)

| # | Finding | Severity | Evidence |
|---|---|---|---|
| F1 | `/api/map/manifest` returns **133.6 MB** uncompressed. The client never uses the `features[]` / `fragmentIds[]` arrays that account for 99.2% of it. A slim manifest is **1.05 MB** (127x smaller). | **Blocker** | §3, §4 |
| F2 | **No `content-encoding` on any response** (manifest or tile). gzip would give 9.97 MB / brotli 6.46 MB for the manifest; tiles compress to 12-33% of raw. | **Blocker** | §5 |
| F3 | Every tile request **re-reads + re-parses the 152 MB `tile-manifest.json`** and Zod-parses all 9,591 entries to find one tile. Measured **~331 ms + 494 ms read** per request, on the single-threaded Node event loop. | **Blocker** | §6 |
| F4 | Tile requests are **1.2-12.9 s cold** (manifest scan serialised behind each other); browser p90 tile duration **25.4 s**, max **39.3 s**. | **Blocker** | §2, §7 |
| F5 | **LOD1 is never requested.** `lodForSpan` leaves a dead band; the 1,254 LOD1 tiles (1.47 GB) are unreachable. | High | §8 |
| F6 | `splitOversizedTile` in `build-tiles.ts` computes **wrong child bounds** (`col*2` on an absolute index). On-disk data was produced by a different algorithm; current HEAD would emit mislocated tiles. | High | §9 |
| F7 | `TILE_ID_RE = /^[a-zA-Z0-9_-]+$/` rejects any tile id containing `.`; a request with `.json` appended returns **400 INVALID_TILE_ID** (verified). | Medium | §10 |
| F8 | 14.3% of tile requests are aborted on every viewport change; **34 aborts, 42 requests permanently stalled** (workers exited without error). | High | §7 |
| F9 | `/api/map/search` is the only endpoint with an ETag; tiles and manifest have **no ETag / no 304 path**. | Medium | §5 |

---

## 1. App surface: how to focus a location

- **No URL parameters.** `app/page.tsx` renders `MapShell` with no `searchParams` handling; no
  `?lat=&lon=` or deep-link route exists anywhere in `app/`.
- **Search box is the only focus mechanism.** `MapHud.tsx:136-151` renders
  `<input type="search" data-testid="search-input">`. Debounced 150 ms in
  `MapShell.tsx:274-277`; `handleSearchResultSelect` (`MapShell.tsx:347-379`) loads
  `hit.tileId`, then calls `setCameraFocus({...focus, zoom: 80})`, hard-coded zoom 80.
- **Diagnostics hook:** `window.__masterMapsTileDiagnostics` = `{requested, aborted, failed, loaded}`
  (`MapShell.tsx:43-54`), plus a `#scene-diagnostics` DOM node (`MapShell.tsx:427`) carrying
  `loaded-tile-count`, `loaded-feature-count`, per-kind counts, `draw-calls`, and camera state.
- **Search debounce note:** `runSearch` is fired from a `setTimeout(150)` effect keyed on
  `searchQuery`, and the form `onSubmit` also calls `runSearch` — typing then pressing Enter
  issues the query twice (the second aborts the first via `searchAbortRef`).

---

## 2. HTTP latency (curl, `time_total` `size_download`)

### Manifest — VERIFIED
```
cold   0.588 s   133,617,294 B   200
warm1  0.422 s   133,617,294 B
warm2  0.286 s   133,617,294 B
warm3  0.304 s   133,617,294 B
```
`x-nextjs-cache: HIT` on warm requests. There is no true "cold" distinct from "warm" here:
`dynamic = "force-static"` (`app/api/map/manifest/route.ts:6`) means the response is built once
at first request and then served from the Next data cache, which is why warm is only ~2.3x faster.

### Tiles — 5 per LOD, by byte-size quintile (min / p25 / p50 / p75 / max) — VERIFIED
```
                              COLD (first touch)        WARM (x-nextjs-cache: HIT)
id                          time     bytes             time     bytes
l0_10_37                    9.905 s    650,588         0.117 s    650,588
l0_84_48_s1_0_0             8.927 s    759,234         0.003 s    759,234
l0_69_53_s1_1_1            10.480 s    804,762         0.004 s    804,762
l0_59_61_s1_1_1             4.285 s    876,052         0.010 s    876,052
l0_11_31                   11.416 s  1,067,260         0.003 s  1,067,260
l1_14_34_s2_0_0             9.611 s    650,689         0.003 s    650,689
l1_0_8                     12.870 s    977,139         0.003 s    977,139
l1_8_23_s2_1_0              2.032 s  1,134,062         0.004 s  1,134,062
l1_35_10_s2_0_1             1.324 s  1,507,231         0.006 s  1,507,231
l1_11_11_s1_1_1             5.438 s  2,187,150         0.006 s  2,187,150
l2_0_10_s3_0_0              0.057 s    663,729         0.005 s    663,729
l2_15_14_s3_0_1             0.013 s  1,056,432         0.004 s  1,056,432
l2_12_7_s3_1_0              0.048 s  1,163,626         0.004 s  1,163,626
l2_12_17_s3_1_0             0.033 s  1,321,032         0.005 s  1,321,032
l2_7_1_s1_1_1               3.577 s  2,168,539         0.004 s  2,168,539
```
The LOD2 rows are fast only because they ran *after* 10 LOD0/LOD1 requests had already paid
the manifest-scan cost while warming the OS page cache. The `l1_0_8` cold 12.870 s is the
single worst case measured.

**Wire bytes exceed `manifest.byteSize` by 212-276 B** on every tile (e.g. `l0_11_31`
byteSize 1,048,491 vs downloaded 1,067,260). The route re-serialises the payload through
`TileDataSchema.parse` + `NextResponse.json`, so `byteSize` from build time is not a wire
size. INFERENCE: the delta is the `{"manifest":{...},"features":[...]}` envelope plus
JSON re-formatting; `streamLevel` writes `,\n` separators on disk while
`NextResponse.json` emits compact JSON, so the two are not byte-comparable.

---

## 3. `tile-manifest.json` size and structure — VERIFIED

`data/generated/tile-manifest.json`: **152,616,541 bytes** on disk, **9,591** entries.
Pretty-printed with `JSON.stringify(..., null, 2)` (`build-tiles.ts:420`) — the indent alone
costs ~20 MB versus the 132,734,936 B compact array form.

Entry shape (`TileManifestSchema`, `src/lib/data/schema.ts:317-327`):
```
{ tileId, lod, bounds:[w,s,e,n], featureCount, byteSize, features:[stableId...], fragmentIds:[...] }
```
All 7 keys present on every entry. `features` and `fragmentIds` are **1,357,773 strings each**.

### Per-LOD payload percentiles (bytes, from `manifest.byteSize`) — VERIFIED
```
LOD  tiles   total      min       p50       p90       p99       max      subdivided
0    7941    6,172.7 MB 650,376   796,696   948,316   1,038,828 1,048,491  7562
1    1254    1,469.9 MB 650,462 1,105,901 1,857,066 2,072,096 2,094,406  1231
2     396      453.0 MB 662,870 1,138,245 1,619,497 2,069,414 2,086,889   396
```
Matches `data/generated/tile-metrics.json` exactly (LOD0 p95 991,685; LOD1 p95 1,973,397;
LOD2 p95 1,850,227).

### Feature counts per tile — VERIFIED
```
LOD  min   p50   p90   p99   max    total
0      1    87   190   253   305    795,761
1      1   277   732   872   917    438,473
2      8   275   577   818   884    123,539
```
Whole-dataset `featureCounts` (from the manifest response): address 115,379; building 305,761;
road 182,254; water 52,716; poi 34,618; business 611; boundary 1 — **691,241 features total**.
`layerAvailability` = `{address, boundary, building, business, poi, road, water}` — note
`landuse` and `transport` are absent.

---

## 4. F1: the manifest is 99.2% dead weight — VERIFIED

`curl http://127.0.0.1:3100/api/map/manifest` -> **133,617,294 B**. Byte breakdown:

| Component | Bytes | Share |
|---|---|---|
| `tiles[]` array | 132,725,344 | 99.32% |
| `tileBounds[]` (duplicate of `tiles[].bounds`) | 256,881 | 0.19% |
| `tileFeatureCounts` (duplicate of `tiles[].featureCount`) | 206,807 | 0.15% |
| `tileIds[]` (duplicate of `tiles[].tileId`) | 173,381 | 0.13% |
| `byteSizes` map (duplicate of `tiles[].byteSize`) | 242,040 | 0.18% |
| everything else (version, sources, pipeline, ...) | ~12,000 | <0.01% |

A representative tile, `l0_20_52_s1_0_0` (161 features), serialises to **15,881 B** in full
form and **110 B** without `features`/`fragmentIds` — a **144x** reduction per entry.

**Rebuilding the same manifest with `features`/`fragmentIds` removed and the four duplicate
maps dropped: 1,053,450 B raw -> 164,938 B gzip -9 -> 119,480 B brotli -11.**

Client-side proof that the removed fields are unused: `grep` over `src/` for
`fragmentIds|tileFeatureCounts|byteSizes|manifest\.features|\.tileIds|tileBounds` returns hits
**only** in `src/lib/data/schema.ts` (the schema definitions at lines 323, 324, 370, 373, 375)
and in the unrelated `src/lib/geo/tiling.ts`. No component, hook, or worker reads them.
`MapShell` consumes only `manifest.tiles[].{tileId, lod, bounds}` (`MapShell.tsx:103-115`).

**Recommended fix:** stop embedding `features`/`fragmentIds` in the served manifest (keep them
in a server-only file if the audit trail needs them), drop the four duplicate maps, and serve
compact JSON. 133.6 MB -> 1.05 MB, or 119 KB with brotli.

---

## 5. Response headers / caching — VERIFIED

```
GET /api/map/manifest
  HTTP/1.1 200 OK
  x-nextjs-cache: HIT
  cache-control: public, max-age=3600, must-revalidate
  content-type: application/json
  x-dataset-version: 0.1.0
  Transfer-Encoding: chunked
  (no content-encoding, no content-length, no ETag)

GET /api/map/tile/<id>
  HTTP/1.1 200 OK
  x-nextjs-cache: HIT
  cache-control: public, max-age=3600, must-revalidate
  content-type: application/json
  Transfer-Encoding: chunked
  (no content-encoding, no ETag)

GET /api/map/search?q=auch&limit=10
  HTTP/1.1 200 OK
  cache-control: public, max-age=0, must-revalidate
  etag: W/"1787862394864.217-65473097-auch-10"
  Transfer-Encoding: chunked

  repeat with If-None-Match -> HTTP/1.1 304 Not Modified, 0 bytes
```

**No gzip, no brotli, anywhere.** `curl -H 'Accept-Encoding: gzip, deflate, br'` against both
the manifest and a tile returns the identical full-size body. Browser-side confirmation:
`transferSize` 133,617,594 vs `decodedBodySize` 133,617,294 for the manifest (300 B of headers
only), and tile `transferSize` sums equal to the raw JSON sizes. The 1.05 MB / 164 KB
compressibility below is therefore entirely unrealised.

`cache-control: public, max-age=3600, must-revalidate` on the tiles is a **correctness hazard**:
`must-revalidate` only forces revalidation *after expiry*, and with no `ETag` and no
`Last-Modified` there is nothing to revalidate against, so a regenerated dataset is invisible
to clients for an hour. `/api/map/manifest` does set `X-Dataset-Version: 0.1.0` but the client
never reads it (`MapShell.tsx:228` parses the body only) — no version pinning exists.

`/api/map/search` is the only endpoint that does the right thing: weak ETag keyed on
`mtimeMs-size-query-limit` (`searchServer.ts:107-108`, route line 23), 304 on revalidate,
`max-age=0, must-revalidate`.

Search index version observed: `1787862394864.217` / `65473097` bytes, i.e.
`data/search/index.json` is **65,473,097 B**.

---

## 6. Compressibility — VERIFIED (gzip -9 and brotli via `/usr/bin/brotli`)

### Manifest
```
raw        133,617,294
gzip -9      9,968,375   7.46%
brotli -5    9,536,679   7.14%
brotli -11   6,558,234   4.91%
slim raw     1,053,450   (no features/fragmentIds/dup maps)
slim gzip      164,938
slim brotli-11 119,480
```

### Five tiles
```
id                   raw        gzip -9   ratio    br -4   ratio    br -11  ratio
l0_10_37             650,588    218,856   0.336   225,027  0.346    135,561 0.208
l0_11_31           1,067,260    303,634   0.284   304,024  0.285    196,657 0.184
l1_11_11_s1_1_1    2,187,150    442,609   0.202   432,267  0.198    294,952 0.135
l2_7_1_s1_1_1      2,168,539    414,653   0.191   405,646  0.187    265,001 0.122
l2_0_10_s3_0_0      663,729    222,006   0.334   228,441  0.344    137,871 0.208
```
Tiles compress to **12-34%** of raw. A binary format (flat typed arrays, transferable to a
Web Worker) would do far better still, but gzip alone is a 3-5x free win that is currently
left on the table.

---

## 7. Server-side per-request work — VERIFIED (isolated benchmark, tsx, same schemas)

Benchmarked the exact operations each route performs:

```
tile-manifest.json bytes 152,616,541   entries 9,591
readFile                 494.2 ms
JSON.parse                350.9 ms
Zod parse ALL 9,591      429.9 ms
per-request map+parse+find 331.4 ms   <-- app/api/map/tile/[tileId]/route.ts:30-32

id                    bytes    feats   read    json   zod/feature   TileData re-parse
l0_10_37              650,376      1    1.3 ms   4.0 ms   24.2 ms      17.3 ms
l0_11_31            1,067,260    210    1.5 ms   4.1 ms   37.8 ms      23.3 ms
l1_11_11_s1_1_1      2,187,150    917   28.0 ms   9.1 ms   54.0 ms      67.4 ms
l2_7_1_s1_1_1        2,168,539    884   14.9 ms  12.0 ms   48.3 ms      30.8 ms
```

### Route-level findings, with line numbers

**`app/api/map/tile/[tileId]/route.ts`** — `dynamic = "force-static"` (line 9):
- line 23: `await stat(tilePath)` on **every** request just to enforce the 2 MiB ceiling.
- line 30: `readFile(tileManifestPath, "utf8")` — re-reads the full **152 MB** manifest.
- line 32: `rawManifest.map((entry) => TileManifestSchema.parse(entry)).find(...)` —
  Zod-parses all 9,591 entries (each carrying a ~15 KB `features` array of `z.string().min(1)`)
  to return **one** object.
- line 34: `readFile(tilePath, "utf8")` + `JSON.parse` of the tile.
- line 36: `rawFeatures.map((feature) => MapFeatureSchema.parse(feature))` —
  **per-feature Zod parse**, and `MapFeatureSchema` is a `z.discriminatedUnion` of 9 variants
  (`schema.ts:302-312`), each running the polygon/ring `superRefine` geometry validators
  (`RingSchema` at `schema.ts:39-54`: closed-ring, non-zero area, no consecutive duplicates;
  `PolygonCoordinatesSchema` at `schema.ts:57-69`: hole area and hole-in-exterior `pointInRing`).
- line 38: `TileDataSchema.parse({ manifest, features })` — **parses every feature a second
  time** (17-67 ms wasted per request, measured above).
- line 41: only `Cache-Control` and `Content-Type` are set. No `ETag`, no `Content-Encoding`.

**Net per-request cost for a mid-size tile: ~500 ms of manifest I/O + ~430 ms of Zod work,
plus a full duplicate feature validation — on a single-threaded Node event loop, with 8
concurrent client requests (`TILE_LOAD_CONCURRENCY = 8`, `MapShell.tsx:68`).** This is the
mechanism behind the 1.2-12.9 s cold latencies in §2: requests serialise behind each other's
manifest scans. INFERENCE: the `force-static` full-route cache means this cost is paid only on
the first request per tile, but the first request is exactly what a cold user hits.

**`app/api/map/manifest/route.ts`** — `force-static` (line 6): reads `manifest.json` (846,809 B)
and `tile-manifest.json` (152 MB) and Zod-parses all 9,591 entries on every build (line 17),
then **duplicates that data three more times** into `tileIds` (18), `tileBounds` (34), and
`byteSizes`/`tileFeatureCounts` (27-28, 36).

**`app/api/map/search/route.ts`** — `force-dynamic` (line 11), correct ETag/304 handling
(lines 23-27). Cold 3.519 s (63 MB index read + 654k-record Zod parse), warm 4.9 ms, revalidate
5.6 ms. This endpoint is the well-behaved one; it is also the model the other two should follow.

**`src/lib/data/loadTile.ts`** — client-side LRU is sound: `DEFAULT_MAX_CACHE_ENTRIES = 64`
(line 5), `DEFAULT_MAX_CACHE_SIZE_MB = 128` (line 3), byte-accurate accounting
(`cacheByteSize`, lines 47/78/132), `popOldest` LRU eviction (33-39), and an in-flight map
deduplicating concurrent requests for the same id (lines 51, 91-99). Two notes:
- line 92: `if (pending && !(signal?.aborted ?? false)) return pending` — a second caller with
  an **aborted** signal creates a *new* request and overwrites the shared entry at line 94,
  orphaning the first promise. The `finally` at 98 compares identity, so the map stays
  consistent, but the orphaned first request's work is wasted.
- line 118: `new TextEncoder().encode(payload).byteLength` allocates a full second copy of
  every tile payload (0.65-2.19 MB each) purely to measure it, then discards it. The bytes were
  already available via `response.headers.get("content-length")` — except the server never sets
  it (chunked, §5).

---

## 8. In-browser measurements (guarded `internet` MCP, 1440x900, WebGPU hardware)

**WebGPU: VERIFIED.** `navigator.gpu` present; `requestAdapter()` returned a real adapter
(features include `depth32float-stencil8`, `texture-compression-bc`, `float32-blendable`;
`maxBufferSize` 1,073,741,824; `maxTextureDimension2D` 8192). `renderer-status=initialized`,
`backend=webgpu`. The earlier Playwright/Chrome 149 run reported the same adapter presence.

### Time to first overview — VERIFIED
```
navigation.domContentLoadedEventEnd      62 ms
navigation.loadEventEnd                 182 ms
/api/map/manifest  start 308 ms | responseEnd 1302 ms | duration 995 ms | 133,617,594 B
first  7 tiles loaded                   ~1,700 ms
LOD2 settling (49 tiles)                ~11 s
```
The map is interactive well before its geometry is: the 133.6 MB manifest is fully downloaded
and JSON-parsed by 1.3 s, but the visible overview does not settle for ~11 s.

### Request counts — VERIFIED
| Phase | tile requests | unique | duplicates | aborted | failed |
|---|---|---|---|---|---|
| initial overview (to settle) | 68 | 68 | **0** | 8 | 1 |
| after 1 search-focus (Condom, zoom 1 -> 19.97) | 127 | 127 | **0** | 34 | 1 |
| after 1 drag-pan at Condom | 217 | 217 | **0** | 34 | 1 |
| final | 237 total requested / 160 loaded | 229 URLs | **0** | 34 (14.3%) | 1 |

**Zero duplicate requests** across every phase — the in-flight map and the LRU both work.
The one failure is `l2_0_4_s2_0_0`, persistent on every page load (see §10).

### LOD mix — F5, VERIFIED
```
l0_11_31      155 requests  102.0 MB
l1_*            0 requests    0.0 MB   <-- never requested
l2_*           62 requests   73.3 MB
```
**LOD1's 1,254 tiles (1.47 GB) are unreachable.** `lodForSpan` (`MapShell.tsx:84-88`) is
purely a function of the visible span, and `enclosingBounds` (`90-101`) computes
`halfWidth = viewport.width / zoom / 2`. At zoom 1 the whole territory (131,072 m across)
fits, so span = 131,072 -> LOD2. LOD1 needs span <= 60,000 -> zoom >= 2.18; LOD0 needs
span <= 12,000 -> zoom >= 10.92. The transitions are clean thresholds, so the dead band is
not a rounding artifact — but every measured interaction jumped straight from zoom 1 to
zoom 19.97 (the hard-coded search-focus zoom), crossing both boundaries and issuing **two
full LOD switches at once**: 62 LOD2 tiles that were then all discarded, and 155 LOD0 tiles
loaded to fill a 1,650 m viewport. 175 MB transferred to display Condom.
INFERENCE: the marginal band exists because `lodForSpan`'s boundaries were tuned against a
different tile-size ladder. The LOD1 simplification tolerances
(`LOD1_SIMPLIFY_TOLERANCE = 2`, `build-tiles.ts:17`) are real work that is never served.

### Tile request duration in-browser — VERIFIED
```
p50  4,305 ms
p90 25,426 ms
max 39,285 ms
```
Far worse than the curl numbers, because 8 requests (`TILE_LOAD_CONCURRENCY = 8`) contend on
the event loop while each performs a 152 MB manifest read + 9,591-entry Zod scan.

### Permanent stall — F8, VERIFIED
After the search-focus, 42 requested tiles were **neither loaded, aborted, nor failed**, and
they stayed that way across 10 s of polling:
```
samples over 5 x 2 s:  88:165:34  88:165:34  88:165:34  88:165:34  88:165:34
stalled: l2_12_7_s3_1_0, l2_12_8_s3_0_0, l2_12_9_s3_0_0, l2_13_10_s3_0_1,
         l0_106_138_s2_0_0, l0_107_138_s2_0_1, l0_107_139_s2_1_1, l0_110_138_s2_0_0, ...
```
`requested - loaded - aborted - failed` is invariant at 42. Cause: the `loadWorker` loop
(`MapShell.tsx:294-325`) exits on `desiredGenerationRef.current !== generation` (line 295),
which is bumped by **any** viewport change (line 284). All 8 workers therefore exit mid-queue,
and the `useEffect` that would re-issue them is keyed on `[manifest, desiredKey]` (line 327) —
neither of which changed, because the camera was still animating toward the focus target
when the workers gave up. No error, no retry, no partial state: the viewport stays
permanently incomplete. INFERENCE: this is the single highest-impact interaction bug; a
Condom/Isle-Jourdain focus leaves ~25 MB of geometry permanently unfetched.

### Pan / zoom input — VERIFIED
- **Left-drag pan works.** Synthetic `pointerdown`/`pointermove`/`pointerup` moved the target
  from `x=-16080.4 z=29501.9` to `x=-15961.3 z=29597.5`, and 30 new tiles were requested.
- **Wheel zoom does not work.** `scroll {dy:-1200}`, `scroll {dy:-900}`, and six synthetic
  `WheelEvent`s dispatched directly on the canvas all left `camera-zoom=1` unchanged. The
  wheel handler *is* reached (my listener fired 6/6) but `DreiMapControls` did not act on it.
  INFERENCE: `minZoom = 0.1` / `maxZoom = 200` are in range and `enableZoom` is not disabled,
  so the likely cause is that `MapControls.tsx:157-172` never passes `zoomSpeed`/`enableZoom`
  and the default `MapControls` `zoomToCursor`/damping path needs a real trusted CDP wheel
  event with proper `ctrlKey` handling — the guarded `scroll` route may not produce one the
  library accepts. This needs a decision, not more guessing: **wheel zoom is the specified
  primary interaction and is not reproducible as instrumented.**

### Render / perf — VERIFIED
```
rAF deltas (400 frames): p50 16.7 ms | p90 16.7 ms | p99 16.8 ms | max 33.4 ms  -> steady 60 fps
PerformanceObserver longtask entries: 0
performance.memory.usedJSHeapSize: 631.3 MB (limit 3,586 MB)
draw-calls: 7-8
```
The frame loop itself is healthy; the cost is entirely in network + parse, not render.
631 MB of JS heap for a single view is a direct consequence of holding 49 `TileData` objects
(each a fully-parsed feature array) plus the 133.6 MB manifest string and its parsed object.

**Visual defect observed:** at the Condom focus the canvas rendered **blank/beige** while
`renderer-status=initialized`, `loaded-feature-count=3207`, `building-count=1392` and
`draw-calls=8` all reported healthy. Content was present in the scene graph but not visible.

---

## 9. F6: `splitOversizedTile` child bounds are wrong — VERIFIED

`scripts/data/build-tiles.ts:288-333`:
```ts
305:  const col = Number(match[1]) * 2 + colOffset;
306:  const row = Number(match[2]) * 2 + rowOffset;
308:  const childBounds = tileBounds(childSize, col, row, originX, originZ);
```
`tileBounds` (line 63) is `origin + index * size`, so `index` must be an absolute lattice
index. `match[1]` **is** already absolute. Doubling it jumps the child to a completely
different part of the department. For parent `l0_2_36` (bounds `[-71680+2*2048, -43008+36*2048]`
= `[-67584, 30720, -65536, 32768]`), HEAD computes:
```
child 0,0 -> [-67584, 30720, -66560, 31744]   (inside the parent, correct)
child 0,1 -> [-66560, 30720, -65536, 31744]   (inside, correct)
child 1,0 -> [-67584, 31744, -66560, 32768]   (inside, correct)
child 1,1 -> [-66560, 31744, -65536, 32768]   (inside, correct)
```
(all four land inside a single 1024 m cell at col 4-5, row 72-73, instead of tiling the
2048 m parent) — and the grandchild at `subdivision=2` would be 8x off again.

**The on-disk data does not match HEAD.** Testing all 9,189 subdivided entries against two
hypotheses:
```
Hypothesis A (current HEAD, col*2):  0 matches
Hypothesis B (col = match[1], as-is):  9,189 matches
```
`l0_2_36_s1_0_0` on disk has bounds `[-69632, -6144, -68608, -5120]`; HEAD would emit
`[-67584, 30720, -66560, 31744]`. 0 of 7,562 LOD0 / 1,231 LOD1 / 396 LOD2 subdivided children
sit inside their parent cell. Consequences:

1. **The on-disk tile-manifest is stale relative to HEAD** — a rebuild would relocate all
   9,189 subdivided tiles. `git log` shows `build-tiles.ts` was last touched in `179da92`
   (2026-08-27 22:28), and the generated data is timestamped 22:26 — two minutes *before*
   that commit. [INFERENCE] the data was produced by the pre-`179da92` algorithm.
2. **`visibleTileIds` selects tiles purely by `entry.bounds`** (`MapShell.tsx:110-114`), so the
   stale bounds are what the client actually uses for LOD selection. Whatever the intended
   grid was, the currently shipped manifest is self-consistent (Feature F5's LOD1 gap and the
   observed tile coverage are explained by the *current* on-disk bounds), so the mismatch is
   a build-reproducibility bug rather than a live rendering bug — but **any `data:build` run
   will change the tile grid**, and that is exactly the moment a user would hit it.
3. The sub-ladder reaches absurd depths: LOD0 goes to `_s4` (128 m cells), LOD1 to `_s5`
   (256 m), LOD2 to `_s5` (1,024 m). Per-level histogram: LOD0 s1=4684 s2=1310 s3=976 s4=592;
   LOD1 s1=206 s2=744 s3=144 s4=125 s5=12; LOD2 s1=8 s2=33 s3=309 s4=38 s5=8.

---

## 10. F7: tile id grammar vs. client — VERIFIED

`app/api/map/tile/[tileId]/route.ts:7`: `const TILE_ID_RE = /^[a-zA-Z0-9_-]+$/;` and line 17
also rejects `..`. The client encodes the bare id (`loadTile.ts:106`), so this is
self-consistent — but the route's own filesystem target is `${tileId}.json` (line 20), and
any caller that appends the extension is rejected:
```
GET /api/map/tile/l0_110_138_s2_0_0       -> 200, 830,933 B, 0.95 s
GET /api/map/tile/l0_110_138_s2_0_0.json  -> 400 {"error":"INVALID_TILE_ID","code":"INVALID_TILE_ID"}
```
The manifest response is inconsistent with itself on this point: the route rewrites tile ids
to bare form (line 32 compares `entry.tileId === tileId`), but the `tiles[]` array it serves
carries no extension hint. Accepting an optional `.json` suffix is a one-line change.

**`l2_0_4_s2_0_0` fails on every load** (VERIFIED, reproducible across two independent
browser sessions, and it is the only entry in `failedIds`). The on-disk file is
662,870 B and present. Its manifest `featureCount` must disagree with the array length, or a
feature fails Zod. `route.ts:37` throws `tile ${tileId} feature count mismatch` -> 500
`DATASET_INVALID`. **This is a data-integrity defect that ships a permanently unloadable tile
at the department's south-west corner.** It is also a hard blocker for the project's stated
goal of "every record of every adopted source layer either represented or in an auditable
exclusion report", since this tile is neither.

---

## 11. Build-time tile budget — VERIFIED

`build-tiles.ts`:
- `LOD_LEVELS` (12-16): LOD0 = 2048 m, LOD1 = 8192 m, LOD2 = 32768 m.
- `DETAILED_TARGET_BYTES = 1 MiB` (19), `DETAILED_HARD_LIMIT_BYTES = 2 MiB` (20).
- `splitLimit` (300, 379): **LOD0 uses the 1 MiB target, LOD1 and LOD2 use the 2 MiB hard
  limit.** So LOD0 tiles are split at 1 MiB while LOD1/LOD2 are allowed to run to the ceiling —
  which is why LOD0's max is 1,048,491 and LOD1/LOD2's maxes are 2,094,406 / 2,086,889.
  `route.ts:6` enforces `MAX_TILE_SIZE = 2 MiB` with a 413.
- Recursive subdivision (288-333) re-reads and re-Zod-parses the parent from disk on every
  split step (line 293-295) and `fs.unlink`s the parent (331). 9,189 of 9,591 tiles (95.8%) are
  subdivision products.
- `streamLevel` (335-390) appends each fragment with `await fs.appendFile` (366) — one
  serialised syscall per feature fragment, 1,357,773 of them. This is the dominant cost of a
  full rebuild. [INFERENCE]

---

## 12. Consolidated numbers

| Metric | Value |
|---|---|
| Manifest response | 133,617,294 B, no compression, no ETag |
| Manifest if slimmed | 1,053,450 B (164,938 gzip / 119,480 brotli) |
| `tile-manifest.json` on disk | 152,616,541 B, 9,591 entries, 1,357,773 `features` + 1,357,773 `fragmentIds` strings |
| Tiles per LOD | 7,941 / 1,254 / 396 — **1,254 (LOD1) never requested** |
| Total tile bytes | 8,095.6 MB (6,172.7 + 1,469.9 + 453.0) |
| Tile size percentiles | LOD0 p50 796,696 p90 948,316 p99 1,038,828 max 1,048,491 |
| | LOD1 p50 1,105,901 p90 1,857,066 p99 2,072,096 max 2,094,406 |
| | LOD2 p50 1,138,245 p90 1,619,497 p99 2,069,414 max 2,086,889 |
| Cold tile latency (curl) | 0.013-12.870 s, median ~5.4 s |
| Warm tile latency (curl) | 0.003-0.117 s |
| In-browser tile duration | p50 4.3 s, p90 25.4 s, max 39.3 s |
| Per-request manifest re-parse | 494 ms read + 351 ms JSON.parse + 331 ms Zod (measured) |
| Duplicate tile requests | **0** (all phases) |
| Aborted tile requests | 34 / 237 = 14.3% |
| Permanently stalled requests | **42** (invariant across 10 s of polling) |
| Failed tile loads | 1 (`l2_0_4_s2_0_0`, reproducible) |
| Search cold / warm / 304 | 3.519 s / 4.9 ms / 5.6 ms — the only correct caching |
| WebGPU | adapter present, backend `webgpu`, 60 fps steady, 0 longtasks, 631 MB heap |

## 13. Fix order suggested by the measurements

1. **Slim the manifest** (§4): drop `features`/`fragmentIds` from the served payload and the
   four duplicate maps; serve compact JSON + brotli. 133.6 MB -> ~120 KB. Single largest win,
   one file (`app/api/map/manifest/route.ts`).
2. **Cache the tile-manifest server-side** (§7): read + Zod-parse once into a module-level
   `Map<tileId, TileManifest>`, invalidate on `mtimeMs`, exactly as `searchServer.ts:103-125`
   already does for the search index. Removes ~830 ms from every cold tile request.
3. **Stop double-validating** (§7): `TileDataSchema.parse` at route line 38 re-parses every
   feature after line 36 already did. Trust the per-feature parse and construct the envelope
   directly; 17-67 ms saved per request.
4. **Enable compression** (§5, §6) on both JSON routes.
5. **Fix the worker-generation stall** (§8): re-issue pending tiles when a viewport change
   ends, not only when `desiredKey` changes.
6. **Fix `splitOversizedTile` bounds** (§9) and rebuild, so `data:build` is reproducible.
7. **Resolve the LOD1 dead band** (§8) or delete the LOD1 build output.
8. **Fix `l2_0_4_s2_0_0`** (§10) — one tile, permanently unloadable.
9. Add `ETag`/`Last-Modified` to tiles and manifest so `must-revalidate` is actionable (§5).
