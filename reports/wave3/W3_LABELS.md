# W3-LABELS — Labels + address rendering (wave3-2)

Status: implementation complete, tsc clean, 16/16 unit tests green. Browser evidence PARTIAL:
the render-tile dataset is not built (see section 6), so the four required screenshot views
could not be captured. Every measurement below is tagged VERIFIED or NOT MEASURED.

Owned files (edited/created, nothing else):
- `src/lib/scene/labels.ts` (new) — pure label logic
- `src/components/map/LabelLayer.tsx` (new) — canvas-atlas sprite layer
- `src/components/map/LayerControls.tsx` — toggles
- `src/components/map/CityScene.tsx` — mount only
- `tests/unit/labels.test.ts` (new) — 16 tests

---

## 1. Does tile meta carry names? (measured from real decoded tiles)

Decoded every `.mmt` in `data/generated/render` (91 files) and counted named meta per
`layerId|meta.k`. **VERIFIED.**

| layer | meta.k | total | named | share |
|---|---|---|---|---|
| poi | poi | 2403 | 2403 | **100%** |
| poi | poi (in address-layer ranges) | 10606 | 10606 | 100% |
| address | address | 1167 | 1167 | **100%** |
| road_normal | road | 1437 | 1047 | 73% |
| road_bridge | road | 26 | 14 | 54% |
| road_tunnel | road | 360 | 278 | 77% |
| boundary | boundary | 1 | 0 | 0% |

**The single most important finding: there is no `place` layer at all.** No meta entry in any
decoded tile has `k === "place"`. Settlements arrive on the `poi` layer with a settlement
`poiType`, and 100% of them are named. Measured category census on the `poi` layer:

```
891 isolated_dwelling   621 poi        271 restaurant   207 locality
203 hamlet               72 townhall     23 convenience   23 neighbourhood
  8 car                   6 clothes       4 books          4 school
  ... 45 more single-count categories (bakery, pharmacy, museum, theatre, ...)
```

`buildMeta` in `src/lib/render/buildRenderTile.ts:352` sets `n` from `feature.name ?? feature.displayName`
and never composes one, so an address only gets `n` because the pipeline already writes
`"name": "821 Chemin de Route"` onto address features. `labels.ts` therefore reads `meta.n` and
never reconstructs text from `p.street`/`p.housenumber`.

`labels.ts:SETTLEMENT_CATEGORIES` maps those categories onto the place family
(town/city/commune=1, village/locality/townhall=2, hamlet=3, quarter/neighbourhood=4,
isolated_dwelling=5) and `importanceOf` borrows the importance from the category when the meta
carries none. Without this the department overview would show **zero** place labels, because
there is no `place` layer to read.

## 2. Zoom gating (camera zoom units, 1 = whole department ~131 km)

`labels.ts:LABEL_ZOOM_MIN` — place 1, transport 8, poi/business 14, street 30, address 60.
`ZOOM_BANDS` quantises the live zoom so the metadata pass runs only when the camera crosses a
band, keeping it off the per-frame path. Place importance additionally gates: at zoom 1 only
importance<=3, at 2.5 <=4, at 6 <=5, at 24 all. **Addresses only above zoom 60**, documented in
the module header, and additionally capped at `MAX_ADDRESS_LABELS_PER_MEGAPIXEL = 90` per
megapixel of viewport (1440x900 = 1.296 MP -> cap 116) on top of the global
`MAX_VISIBLE_LABELS = 320`.

## 3. Collision and caps

`layoutLabels` walks candidates in descending priority (total tie-break on `tileId:stableId`,
so two frames over the same input always agree) and places a label only when **every** grid
cell its box covers is free. That is strictly stronger than single-cell occupancy, so two placed
labels can never overlap at any zoom or heading. `findOverlaps` is the audit used by the tests
and exposed to the browser probe. Candidate pool is truncated to `MAX_CANDIDATE_POOL = 3000`.

## 4. LabelLayer rendering

One `<mesh>` with a single merged quad geometry, billboarded by cancelling the camera heading
(the app flips NDC-Y, so a single vertical flip about the anchor keeps glyphs upright). Glyphs
come from one canvas atlas (2048px wide, rebuilt only when the placed set changes), so the
static case pays rasterisation once. Quad extent is derived from the measured pixel box, so
labels keep a constant on-screen pixel size at every zoom. `depthTest: true`, `depthWrite: false`,
`renderOrder 40`, `toneMapped: false`. Colours derive from the three roots only: ink `#000000`
for place/street/address, accent `#ff7d27` for poi/business/transport.

**Caveat, stated honestly:** `buildingMat` in `src/lib/scene/materials.ts:112` sets
`depthWrite: false`, so buildings never write depth and cannot occlude anything, labels
included. `depthTest: true` is correct and is what I ship, but in the current top-down scene
it will not by itself hide a label behind a building. Making it actually occlude requires a
depth-writing building material, which is `materials.ts`, not mine.

Reduced motion: opacity snaps to target instead of fading. Fades are 160 ms otherwise.

## 5. LayerControls

Kept `Étiquettes`, added `Transports`, `Structures`, `Lieux` wired to the `transport`,
`structures`, `places` keys `visible()`/`layerHidden()` in CityScene already read, plus the
existing families and a `Limite du département` toggle for `boundary`. Dropped the
`Zone de chalandise Nocibé` checkbox: W1_T07 proved it is a one-way set in MapShell read
nowhere, and `commercialAudit` stays harmlessly in state for the lead's FeatureInspector work.
Unified the two reset buttons: the layer panel one said `Réinitialiser` with
`aria-label="Réinitialiser les couches"` while calling `onReset` -> `resetView`, i.e. the
camera. It is now `Recentrer la carte`, labelled for what it does. Added `aria-controls`/`hidden`
to the disclosure, removed the redundant `aria-label` duplicating the visible label, and added
`:focus-visible` rings on the disclosure, every checkbox and the reset button. The chevron and
button transitions are disabled under `prefers-reduced-motion`.

## 6. Browser evidence — NOT MEASURED, and why

Environment: guarded internet MCP, HeadlessChrome/154.0.8037.57, hardware GPU mode on,
WebGPU adapter **amd / gcn-5** (Radeon), viewport 1440x900, `http://localhost:3202`.
(Next dev blocks cross-origin dev resources from `127.0.0.1`; the app hangs on its loading
fallback from that host. Use `localhost`.)

**What I did verify in the real browser (VERIFIED):** the app mounts, the renderer reaches
`canvas: true`, and `window.__masterMapsLabels` is published by the live LabelLayer:
`{"placed":0,"candidates":0,"zoom":1,"counts":{place:0,street:0,poi:0,business:0,transport:0,address:0},"overlaps":0,"atlasCells":0,"reducedMotion":false,"worldPerPixel":125.61,"visible":true}`.
So the mount, the frame loop and the diagnostics hook are real and running.

**Why the four screenshots are missing.** `data/generated/render` holds 91 `.mmt` files while
`data/generated/manifest.json` declares `tileCount: 9591`. The map requests LOD2 tiles at the
department view and every one returns `HTTP 503 DATASET_UNAVAILABLE` (captured in
`.next/dev/logs/next-development.log`). A full `scripts/data/build-tiles.ts` run was started,
reached 12 GB RSS at 18% CPU and produced one tile in 31 minutes, so I killed it as
unviable inside this window. I then generated real LOD0 tiles for the Auch area
(x -5000..12000, z -6000..14000, 30 tiles, 1.9 MB) with a throwaway script using the real
`buildRenderTile` + `encodeRenderTile`, which is how the name census in section 1 was measured.
That script has been deleted. But my browser session ran out before I could drive the camera to
the town view that would load those LOD0 tiles.

**Consequence for acceptance:** labels-rendered-per-view, frame p95 with labels on, and the
no-overlap assertion in the live scene are **NOT MEASURED in the browser**. The no-overlap
guarantee **is** proven by unit test over 400 colliding candidates at zoom 6
(`findOverlaps(placed)` is empty). Someone with a built dataset should re-run: load at zoom 1
(read `__masterMapsLabels.counts.place`), zoom to a town (`counts.poi`/`counts.transport` rise),
zoom to 80 (`counts.street` and `counts.address` rise), then untick `Étiquettes` and confirm
`placed` goes to 0. Those four numbers are already plumbed.

I also could not measure frame p95 with labels on. `__masterMapsLabels` deliberately does not
carry a timing field, because a per-frame `performance.now()` in the label loop is exactly the
hot path W1_T05 warns about; the honest measurement is a DevTools/Performance trace, not a
self-reported counter.

## 7. Registry dependency (applied, no patch owed)

Label text needs `FeatureMeta`, which `putDecodedTile` discards. wave3-4 owns
`tileGpuCache.ts` and landed one registry serving me and wave3-3:
`getResidentDecodedTile(tileId): DecodedRenderTile | undefined` and
`getResidentDecodedTiles(): ReadonlyMap<string, DecodedRenderTile>`, fed inside `putDecodedTile`,
deleted in `evictTile`, cleared in `clearTileGpuCache`, Map in LRU = render order.
`LabelLayer` reads it directly; no MapShell change and no shim were needed.
I also removed a first-draft `src/lib/scene/labelTileRegistry.ts` rather than ship a second
registry. **No REQUIRED MAPSHELL PATCH and no REQUIRED TILEGPU PATCH from me.**

## 8. Validation

- `npx tsc --noEmit`: **0 errors in my four files.** The 10 project errors are all in
  sibling-owned files (MapShell `TileMeta` not found + `setSelectedFeature` type mismatches,
  `FeatureContextMenu.tsx` unused `displayValue`, `loadTile.ts` `'cache'` possibly null);
  broadcast to the owners.
- `npx vitest run tests/unit/labels.test.ts`: **16/16 pass.**
- `npx vitest run tests/unit/build-render-tile.test.ts tests/unit/labels.test.ts`: 28/28 pass.
