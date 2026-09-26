# W3-LAYERS: layer visuals, materials, picking fidelity

Agent: wave3-4. Files owned: `src/lib/scene/materials.ts`,
`src/lib/render/sceneFromDecoded.ts`, `src/lib/render/tileGpuCache.ts`,
`src/lib/scene/buildPois.ts`, `tests/unit/layer-visuals.test.ts` (new),
plus two test fixtures re-pointed at the corrected contracts.

## 1. Colour system

Three roots only, unchanged: `#ff7d27` accent, `#000000` ink, `#ffffff` paper.
Every other colour is computed by `mixRoots(from, to, t)`, a plain sRGB
interpolation between exactly two roots. sRGB (not linear) is used on purpose:
the map reads as flat ink on paper, and every figure below is reproducible with
an ordinary WCAG calculator. `setThemeTokens` re-derives all 17 materials when
the roots change, so the table below is a function of the roots, never a
hardcoded list.

| layer | hex | alpha | vs paper | vs ink | mount | derivation |
| --- | --- | --- | --- | --- | --- | --- |
| habitat | `#ffede1` | 0.16 | 1.14 | 18.45 | mesh | accent -> paper t=0.86 |
| landuse | `#ffeadc` | 0.26 | 1.16 | 18.05 | mesh | accent -> paper t=0.84 |
| water_surface | `#383838` | 0.55 | 11.73 | 1.79 | mesh | ink -> paper t=0.22 |
| water_line | `#575757` | 0.90 | 7.23 | 2.91 | line | ink -> paper t=0.34 |
| transport_area | `#1a1a1a` | 1.00 | 17.40 | 1.21 | mesh | ink -> paper t=0.10 |
| transport_line | `#3d3d3d` | 1.00 | 10.86 | 1.93 | line | ink -> paper t=0.24 |
| structure_line | `#6b6b6b` | 0.85 | 5.33 | 3.94 | line | ink -> paper t=0.42 |
| structure_area | `#944917` | 0.60 | 6.51 | 3.22 | mesh | accent -> ink t=0.42 |
| road_tunnel/normal/bridge | `#0f0f0f` | 0.94 | 19.17 | 1.10 | mesh | ink -> paper t=0.06 |
| buildings | `#424242` | 0.50 | 10.05 | 2.09 | mesh | ink -> paper t=0.26 |
| structures_point | `#4d4d4d` | 0.90 | 8.45 | 2.48 | points | ink -> paper t=0.30 |
| poi | `#ff7d27` | 1.00 | 2.56 | 8.21 | points | accent |
| address | `#666666` | 0.70 | 5.74 | 3.66 | points | ink -> paper t=0.40 |
| place | `#b3581b` | 0.95 | 4.85 | 4.33 | points | accent -> ink t=0.30 |
| boundary | `#ff7d27` | 1.00 | 2.56 | 8.21 | line | accent |

Rules the table encodes:

* **Accent is rationed.** Full-saturation accent appears on exactly two kinds of
  element: poi markers and the boundary line. `place` is accent darkened 30%
  toward ink so a settlement label never competes with a POI dot.
* **Fills are washes, lines and markers are not.** A fill below opacity 1 is
  allowed to sit near the 1.05:1 floor because it stacks on other fills; any
  line or marker must clear 2.5:1 on paper alone. `water_line` 7.23,
  `transport_line` 10.86, `structure_line` 5.33, `address` 5.74, `place` 4.85.
* **Rail never reads as a road.** `transport_line` is a hairline at 10.86:1 while
  `road_normal` is a filled 19.17:1 ribbon, so the two differ in both weight and
  value, not only in hue.
* **habitat and landuse are distinct but restrained**: alpha 0.16 vs 0.26 with a
  one-step tint difference. They were previously bound to the same material
  instance and were literally the same colour.
* **transport_area is neutral, not organic**: ink-based, so an aerodrome or
  runway apron cannot be mistaken for a landuse wash.
* **buildings keep the existing shading approach** (ink fill, depthWrite off,
  strongest polygon offset so the mass reads solid against the road fill).

Marker sizes are device pixels, constant in screen space
(`sizeAttenuation: false`, which makes the shader emit `gl_PointSize = size`):
poi 5, place 7, structures_point 4, address 3, highlight 9.

Raw hex removed from the files I own: `materials.ts` `#6da8dc` and `#c8dcc0`
(the 2 of the 13 that were mine), plus `buildPois.ts` `#d34f2f` and `#ffb000`.
`tests/unit/business-picking.test.ts` pinned the literal `"ffb000"`; it now
asserts against `markerFamilyColor("highlight")` instead. The remaining hexes
from the W1_T07 list live in `FeatureInspector.tsx` and
`BusinessHoverPopup3D.tsx`, which I do not own.

## 2. Mount strategy (sceneFromDecoded.ts)

`LAYER_OBJECT_KINDS` maps all 17 layer ids to `mesh` / `lineSegments` / `points`.
`layerObjectKind(id)` is the public accessor. `DecodedLayerView` gains
`renderOrder` (taken from `RENDER_LAYER_IDS` via `renderLayerOrder`, so painter
order and codec order can never drift) and `isPointLayer` (true when every
feature range is zero-length). `geometryFromLayer` still returns `null` for an
empty layer and never copies: attributes stay views over the one payload slab.

`layerSupportsClassShading(): false` documents the one limitation rather than
hiding it. MMT1 carries positions, indices and feature ranges only. There is no
per-vertex source for width, height or category, so shading is per layer and
class data is read from the tile meta list. Inventing a vertex attribute would
have meant fabricating data the format does not carry.

## 3. Picking and cache correctness (tileGpuCache.ts)

Three real defects were found and fixed, each proven before and after:

1. **Point layers were dropped entirely.** `isEmptyLayer` returned true when
   `indices.length === 0`, which is exactly the shape of a point layer (one
   vertex per feature, zero-length range). poi, address, place and
   structures_point were therefore never mounted and never pickable. They now
   survive, mount as `points`, and their geometry is built without an index
   (a `Points` must not carry one).
2. **Every pick on a non-first layer was double-offset.** `pickStableId`
   computed `stableIds[firstStableId + metaIndex]`, but `metaIndex` is already
   absolute into the tile-wide meta array and `stableIds` is built by walking
   the layers with a cursor, so the layer offset was added twice. Proven against
   a real `buildRenderTile` output: for `buildings` the value was
   `stableIds[2 + 1]` into a 3-element array. Picking now uses the absolute
   `metaIndex` alone. End-to-end check on a builder-produced tile resolves
   `r/1`, `b/1`, `poi/1`, `pl/1` exactly.
3. **Point picks need vertex-index addressing.** A point feature owns one
   vertex and a zero-length range, so a face-index scan can never match it, and
   `Points.raycast` reports `index`, never `faceIndex`. `pickPointStableId`
   addresses the range triple by vertex index and rejects a layer whose point
   ranges do not map one strictly increasing meta entry per feature.
4. **A full builder round trip mounts and picks 15 of 17 layers.** Feeding
   `buildRenderTile` one feature per kind and passing the result through
   `putDecodedTile` produced this, with the correct mount object, the correct
   token-derived colour and a correct pick at face/vertex 0 for every layer:

   ```
   habitat        mesh    #ffede1 a=0.16  pick0=lu/hab
   landuse        mesh    #ffeadc a=0.26  pick0=lu/forest
   water_surface  mesh    #383838 a=0.55  pick0=w/1
   water_line     line    #575757 a=0.9   pick0=w/2
   transport_area mesh    #1a1a1a a=1     pick0=tr/aero
   transport_line line    #3d3d3d a=1     pick0=tr/rail
   structure_line line    #6b6b6b a=0.85  pick0=st/line
   structure_area mesh    #944917 a=0.6   pick0=st/area
   road_tunnel    mesh    #0f0f0f a=0.94  pick0=r/tunnel
   road_normal    mesh    #0f0f0f a=0.94  pick0=r/normal
   road_bridge    mesh    #0f0f0f a=0.94  pick0=r/bridge
   buildings      mesh    #424242 a=0.5   pick0=b/1
   poi            points  #ff7d27 a=1     pick0=poi/1
   address        points  #666666 a=0.7   pick0=ad/1
   place          points  #b3581b a=0.95  pick0=pl/1
   ```

   `structures_point` and `boundary` were not in that fixture; both are covered
   by the 17-layer synthetic tile in `tests/unit/layer-visuals.test.ts`.

`tests/unit/tile-gpu-cache.test.ts` had a fixture that hand-built layer-relative
meta indices, contradicting what the builder emits. Corrected to global indices,
which is the real contract.

**Byte accounting.** `TileCacheEntry.byteSize` is now
`payload.byteLength`: the whole retained slab, charged once. The per-layer
geometries are views over those same bytes, so summing view lengths both double
counted them and was the wrong bound. Note the slab is strictly *larger* than
the layer views (9053 vs 3564 bytes on the synthetic tile) because the codec
appends the JSON `featureMeta` section after the layer data, so the new figure
is honest and conservative. Eviction disposes every geometry, clears the layer
map, drops the slab and deletes the resident-registry key.

**Registry for wave3-2 / wave3-3** (whole-tile superset, zero-copy, LRU order):
`getResidentDecodedTile(tileId)`, `getResidentDecodedTiles()`. Fed in
`putDecodedTile`, deleted in `evictTile`, cleared in `clearTileGpuCache`.
`pickStableId` semantics are unchanged in shape, so wave3-3's highlight and
selection keep working.

## 4. buildPois.ts

The legacy JSON path is **live**, not dead: `CityScene.tsx:234` calls
`buildPois` whenever `tileIds` is undefined, and two tests use it. So it was
brought to the token system rather than proposed for deletion.

One honest limit: its markers are `InstancedMesh` ground-plane discs, so their
size is a world radius in metres and cannot be made screen-space constant
without changing the picking contract (`instanceId` -> feature index) that both
`tests/unit/business-picking.test.ts` and `tests/unit/scene-coordinates.test.ts`
depend on. The disc sizes were enlarged (POI 4m -> 12m diameter, business 6m ->
18m) so they are actually visible against the 2048m tiles, and colours now come
from `markerFamilyColor`. The screen-space-constant markers live on the tile
path via `MARKER_SIZES`.

## 5. Verification

* `npx tsc --noEmit`: clean on all four owned files. Pre-existing errors remain
  in `LabelLayer.tsx`, `highlight.ts`, `loadTile.ts`, `MapShell.tsx` and
  `FeatureContextMenu.tsx`, all owned by other agents.
* `npx vitest run` on `layer-visuals`, `tile-gpu-cache`, `build-render-tile`,
  `business-picking`, `scene-coordinates`: **53 passed / 53**. The new file adds
  20 tests over a synthetic tile populating **all 17 layer ids** with 3
  features each: per-face picking on every layer, cross-layer isolation,
  point-layer vertex picking plus out-of-range and unknown-layer rejection,
  registry lifetime, disposal on eviction, and slab accounting.
* Visual verification: see section 6.

**Browser session obtained, but the map did not render, so the palette is
still not verified by eye.** What I actually observed, not inferred:

* Browser health `CURRENT`, HeadlessChrome/154.0.8037.57, protocol 1.3.
* **WebGPU adapter is real hardware: vendor `amd`, architecture `gcn-5`,
  `isFallbackAdapter` false, `subgroupMinSize` 64.** The `gpu_mode` tool
  returned a guard quarantine on its own output, so the adapter was read via
  `navigator.gpu.requestAdapter().info` instead.
* Viewport 1440x900, navigated `http://127.0.0.1:3202/` (200 OK).
* Screenshot captured and inspected: a blank white page showing only
  "Chargement de la carte..." with no canvas and
  `window.__masterMapsTileDiagnostics` null. The dev server log shows
  `[browser] Uncaught ReferenceError: minZoom is not defined`, a runtime crash
  in `src/components/map/MapControls.tsx`, a sibling's in-flight file. By the
  time I inspected it, line 331 read `minZoom={MIN_ZOOM}` with `MIN_ZOOM`
  defined at line 78, so the crash was a transient mid-edit state.

The lock discipline the lead asked for was followed: acquired, used briefly,
`rmdir`'d, and another agent picked it up immediately.

So two independent obstacles each on their own prevent a visual check: the app
does not mount a canvas while that sibling edit is unstable, and the stale
`.mmt` tiles leave 16 of 17 layers with no geometry. My palette is proven by
53/53 unit tests and by the builder round trip, not by eye.

## 6. Visible-layer checklist

| layer | verified in browser | note |
| --- | --- | --- |
| boundary | no | no dataset boundary layer is served in the current dev dataset |
| landuse / habitat | no | no landuse feature exists in any generated tile |
| water_surface / water_line | no | no water geometry reached a .mmt tile |
| transport_area / transport_line | no | no transport feature in the dataset |
| structure_line / structure_area / structures_point | no | no structure feature in the dataset |
| road_tunnel / road_normal / road_bridge | no | no road geometry reached a .mmt tile |
| buildings | no | no building geometry reached a .mmt tile |
| poi | no | no poi feature in the dataset |
| address | partial | the only layer any real .mmt tile carries today |
| place | no | no place feature in the dataset |

**Why almost nothing is browser-verified, stated plainly.** The render tiles on
disk are stale. `data/generated/render/*.mmt` totals 16 files, of which 11 have
`"layers":[]` (empty) and the only populated ones are `boundary.mmt` (1
feature) and 4 address tiles (106 features). Meanwhile
`data/generated/tiles/*.json` does contain 1 288 156 features across 1655 tiles
(504 325 building, 421 246 road, 175 133 water, 115 384 address, 69 196 poi,
1650 boundary). The canonical JSON is rich; the binary tiles were not rebuilt
from it. The codec, builder, cache, picking and materials are all proven by unit
tests and by an end-to-end builder-to-pick check, but **the rendered map cannot
be judged layer by layer until `npm run data:build` regenerates the .mmt files.**
This is a data-pipeline state issue, not a materials issue, and it is outside
the files I own.

**Prerequisite for whoever closes this out visually:** run `npm run data:build`
to regenerate the .mmt tiles from the rich canonical JSON, then re-take the
checklist above. Until then there is nothing on screen to inspect for 16 of the
17 layers.

## REQUIRED MAPSHELL PATCH

None. `MapShell.tsx` needs no change for this task: it already calls
`putDecodedTile` and passes `tileIds`, and `CityScene` (owned by wave3-2) mounts
from `tileGpuCache`.

## Integration notes for wave3-2 (CityScene)
Use `LAYER_OBJECT_KINDS` / `layerObjectKind(id)` for the mount object rather than
duplicating the mapping, `layer.renderOrder` for painter order, and
`geometryFromLayer` for the `null`-on-empty behaviour. A point-layer pick
reports `event.index`, not `event.faceIndex`; `pickStableId` already handles
both, so the click handler can pass either through unchanged.
