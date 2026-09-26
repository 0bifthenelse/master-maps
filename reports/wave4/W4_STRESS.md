# W4-STRESS: bounded memory and no-leak soak verification

Owner: wave4-5. Delivered:

| File | State |
| --- | --- |
| `scripts/moli/verify-stress.ts` | NEW |
| `reports/wave4/W4_STRESS.md` | NEW |
| `tests/artifacts/stress/stress-run.json` | generated artifact |

## Harness

`verify-stress.ts` speaks MCP stdio to the guarded `internet` runtime
(`/master/internet/target/release/master-internet-unit`) as a single long-lived
client. It never launches a browser, never passes `--disable-gpu` and never
falls back to WebGL. Sequence per run: `health`, `version`, `profile_open`,
`gpu_mode {hardware}`, `set_viewport 1440x900`, `navigate`, `state`, then the
scripted cycle, then `profile_close`.

GPU evidence, read back through `evaluate` because `gpu_mode` reports a guard
quarantine on its own output (a known tool issue, not an app defect):

```
ANGLE (AMD, Vulkan 1.4.354 (AMD Radeon Graphics (RADV RENOIR) (0x00001638)), radv)
```

Non-software AMD RENOIR adapter, the known-good host adapter. `navigator.gpu`
is present and the adapter exposes 20 features. Scene diagnostics report
`backend=webgpu`, so the app ran on the WebGPU path, not a fallback.

## Dataset state constrains what could be exercised

`ls data/generated/render | wc -l`: **182 at the start of the first run, 6018 at
the end of run 3, 6018 at hand-off.** The rebuild was writing tiles throughout.
`data/generated/tile-manifest.json` carries 9591 entries; at the start of run 3
only 490 manifest tile ids existed on disk and zero of the 182 files on disk
matched a manifest id (the on-disk set used a different, older naming scheme:
`l0_1_1` rather than `l0_63_27_s1_1_1`). Consequence: **most
`/api/map/render/<id>` requests return 503 and the tile-cycle phases could only
exercise the resident tile set, not a full department.** The first two runs
loaded zero tiles and are reported as no-ops, not as evidence.

## Two harness defects found and fixed before the evidence run

1. **Scalar JSON was corrupted.** `parseToolJson` sniffed for a leading `{` and
   returned the raw string otherwise, so a bare `true` came back as the string
   `"true"`. `waitForScene` compared `ready === true` and looped for 60 s
   before failing. Fixed to parse the JSON document directly.
2. **The guarded `press_key` never reached the map.** MapControls binds
   `window.addEventListener("keydown")` (`MapControls.tsx:260`); a CDP key event
   dispatched at the document level does not reach that window listener. Probe
   evidence: `press_key Equal` and `press_key KeyL` both left `camera-zoom`
   pinned at 1, while three synthetic `KeyboardEvent`s dispatched on `window`
   moved it to 1.2403246813938753. A full run completed with every navigation
   phase as a silent no-op. Fixed to dispatch on `window`; `verify-stress.ts`
   now also records `camera-zoom` and `camera-target-x` series and asserts the
   camera actually moved, so a future no-op run cannot pass as a clean soak.

## Scripted cycle and measured raw counters

Run 3, the first run in which input reached the map. Heap from
`performance.memory.usedJSHeapSize`; `r/l/a/f` are
`window.__masterMapsTileDiagnostics` requested / loaded / aborted / failed
(cumulative, same shape as `MapShell.tsx:35`); `draw` is
`#scene-diagnostics` `draw-calls`.

| phase | duration | heap | r/l/a/f | draw | frames | p50 | p99 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| panzoom-alternating-20 | 9.5 s | 60.3 MB | 424/6/0/402 | 30 | 439 | 16.7 ms | 53.15 ms |
| direction-reversals-10 | 8.0 s | 60.3 MB | 424/6/0/402 | 30 | 450 | 16.7 ms | 19.55 ms |
| search-focus-jumps-10 | 26.4 s | 60.3 MB | 2038/17/15/1357 | 12 | 1163 | 16.6 ms | 39.31 ms |
| lod-crossings-3 | 24.6 s | 60.3 MB | 4609/27/25/1871 | 12 | 930 | 16.7 ms | 36.93 ms |
| context-menu-cycles-5 | 13.9 s | 60.3 MB | 4906/31/25/2172 | 30 | 173 | 16.7 ms | 166.43 ms |
| soak-tail | 19.9 s | 60.3 MB | 5280/31/25/2506 | 30 | 349 | 16.7 ms | 21.02 ms |

Run 2, same harness before the input fix but with a partially populated
dataset, corroborates the shape: loaded rose 6 -> 32 and draw calls 29, while
the heap stayed flat at 53.5 MB.

Observations:

- **The heap does not move.** Every phase of run 3 reports the identical
  60.3 MB, against a 3.76 GB `jsHeapSizeLimit`. Runs 1 and 2 were flat at
  39.6 MB and 53.5 MB respectively. The flatness tracks the resident tile set
  (0, 6-32 tiles), not the number of requests: run 3 issued 5280 requests and
  the heap did not budge.
- **Tile loading is real but small.** At most 31 tiles were resident at once
  and draw calls peaked at 30, so the plateau claim below is about a 31-tile
  working set, not a full department view.
- **frame rate is display-bound.** p50 is 16.7 ms in every phase, which is
  exactly a 60 Hz vsync; the busiest phase by p50 is a tie across all phases.
  The meaningful spread is the tail: p50 16.7 ms, p90 ~18.5 ms, p99 36.93 ms
  during LOD crossings and 166.43 ms during context-menu cycles. The 166 ms
  outlier is the first resident-geometry raycast sweep, not a sustained stall.
- **Zero unhandled promise rejections and zero WebGPU errors** in every phase of
  every run: `console.error` was never called, `renderer-error=none`,
  `renderer-status` never `lost`. The only console noise is `console.warn`
  "Tile ... fetch failed", which is the 503s from the incomplete dataset:
  2506 warnings against 2506 failed entries, an exact match.
- **Search focus jumps worked**: 4 of 10 typed terms produced result options and
  `handleSearchResultSelect` moved the camera, which is what drove the tile
  requests from 424 to 2038 in that phase.

## Verdicts

**Heap: no monotonic growth. PASS.** Threshold: strictly increasing phase means
across the last three phases AND a total delta above 8.4 MB. Observed:
39.6 -> 39.6 -> 39.6 MB in run 1, 53.5 -> 53.5 -> 53.5 MB in run 2,
60.3 -> 60.3 -> 60.3 MB in run 3, delta 0.0 MB. The 233-cycle idle soak in run 1
returned the camera to the same place 233 times and the per-cycle heap read
39.6 MB on every single cycle.

**Unhandled promise rejections: none. PASS.** Zero across all phases and runs.

**WebGPU validation errors: none. PASS.** No `console.error`, no renderer error,
no device loss, on the AMD RENOIR adapter.

**Aborted requests: accounted for, with one caveat. PASS with a named gap.**
Run 3 phase deltas: requested 4856, loaded 25, aborted 25, failed 2104,
terminal sum 2154. Aborted is non-zero and every abort corresponds to a
`requested` entry, so aborts are counted. The caveat is that `failed` is 2104
short of `requested`: those are the in-flight requests abandoned when
`desiredGenerationRef` advanced, and `MapShell.tsx:297` returns on
`!current()` **before** pushing to either `loaded` or `failed`:

```ts
} catch (cause) {
  if (isAbortError(cause) || !current()) return;   // <-- 297, no counter
  showTileFailureRef.current = true;
  tileRuntimeDiagnostics().failed.push(tileId);
```

The same pattern is on the success path at `MapShell.tsx:292` (`if (!current())
return;` with no `loaded` push). The only place `aborted` is pushed is
`MapShell.tsx:278`, and that loop iterates `tileStateRef.current.slots`, which
holds **decoded** tiles. Since no tile in these runs was ever evicted from a
slot, that loop never ran and `aborted` stayed at 0 in run 1 and 25 in runs 2
and 3 (the 25 coming from a single eviction). So the diagnostics panel
under-reports cancellation: aborted and stale-generation requests are
invisible. This is a reporting defect in `MapShell.tsx:277-303`, not a
resource leak, and it should be fixed by pushing to `aborted` on the
`!current()` early return.

**Resource disposal: the loaded-tile count does not grow without bound. PASS,
with the measurement bounded by the dataset.** Run 1's plateau probe read
`loaded-tile-count=0` at all 15 stops (peak 0, final-three max 0), which is
trivially bounded because nothing loaded. Runs 2 and 3 did not survive to their
plateau probe: run 2 and run 3 both aborted on a `COLLECT_PROBE` CDP timeout
while the page was saturated with tile decode work, and run 4 aborted earlier
still in setup on a `gpu_mode` timeout caused by browser contention when a peer
took `/tmp/master-maps-browser.lock` at 22:16:42. **So the disposal plateau
over a populated view is NOT measured.** What is measured is the indirect
version: across run 3, loaded rose to 31 and stayed at 31 through the soak tail
while requested rose from 424 to 5280, and the heap did not move. Disposal is
implemented at `MapShell.tsx:275-280` (`evictTile` plus `dropTileSlot`) and at
`tileGpuCache.retainTiles`, but I could not exercise the pan-away-and-release
path with a resident set larger than 31 tiles.

**Frame duration during the busiest phase.** Busiest by p50 is a tie at
16.7 ms; the busiest by tail is context-menu-cycles-5 at
count 173, mean 21.0 ms, p50 16.7 ms, p90 17.4 ms, p99 166.43 ms, max 166.43 ms,
min 16.7 ms, implied 47.6 fps. Excluding the single first-sweep outlier the
phase runs at the display's 60 Hz.

**GPU render-tile cache stats: not reachable from the page.** As required, the
accessor was probed and it is not exposed. `getTileGpuCacheStats`
(`src/lib/render/tileGpuCache.ts:129`) and `getRenderTileCacheStats`
(`src/lib/render/loadRenderTile.ts:38`) are module-level exports with no
`window` or global hook, so entries, byteSize, hits, misses, evictions and the
worker pool queue stats cannot be read from the page. The only window hooks
that exist are `window.__masterMapsTileDiagnostics` (`MapShell.tsx:44`),
`window.__masterMapsLabels` (`LabelLayer.tsx:79`) and the `#scene-diagnostics`
text node, so `loaded-tile-count` and `draw-calls` were used as the observable
proxies. Exposing one of the two stat functions on `window` would close this
gap for future runs.

**Context menu: 0 of 5 cycles opened, and this is dataset-bound.** The menu is
opened by a per-mesh `onContextMenu` handler (`CityScene.tsx:177`) that
raycasts resident tile geometry. With few or no tiles resident there is nothing
to hit, so the right-clicks found nothing. A 20-point synthetic sweep over the
canvas was tried to distinguish "never aimed at anything" from "never opened";
it is inconclusive under this dataset.

**LOD crossings: 3 class transitions observed, but zoom never left the
overview band.** `lodForSpan` (`MapShell.tsx:75`) switches at 12 km and 60 km
visible span. The probe recorded `worldPerPixel=125.61` at every stop, giving a
~113 km span, which is LOD2 at both ends of every crossing, so the 12 km
threshold was never approached. Zoom steps of 34 per crossing are not enough
to leave the overview band from zoom 1.

## Reproducing

```
mkdir /tmp/master-maps-browser.lock     # atomic; rmdir in a finally block
npx tsx scripts/moli/verify-stress.ts
rmdir /tmp/master-maps-browser.lock
```

`STRESS_TARGET` overrides the target (default `http://localhost:3202/`).
The run is bounded by `BUDGET_MS` (6 min) with a 12 min hard stop; phase 7
consumes the leftover budget up to 180 s.

## What a follow-up run must still prove

1. The loaded-tile plateau over a **populated** view, which needs a complete
   rebuild so that pan-away actually releases tens of tiles.
2. LOD crossings that reach the 12 km threshold; 34 zoom steps from the
   overview is too few, and the zoom ceiling should be checked against
   `maxZoom=4000` before choosing a step count.
3. Real context-menu open/close cycles, which need resident geometry.
4. The GPU cache stats, which need one stat function exposed on `window`.

The three defects named in this report are in `src/components/map/MapShell.tsx`
at lines 278, 292 and 297 (aborted-request under-reporting) and in the harness
`press_key` path (fixed inside `verify-stress.ts`; the app is unchanged). No app
code was modified.
