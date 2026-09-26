# W2-T13 render-tile codec and builder

Status: delivered. Implements CONTRACTS.md section 2 (MMT1 container) and section 3.1
(binding transfer amendment) plus the section 6 pipeline emission.

## 1. Files

| File | Lines | Role |
|---|---|---|
| `src/lib/render/codec.ts` | 300 | MMT1 encode/decode, shared payload slab, layer accessors |
| `src/lib/render/buildRenderTile.ts` | 386 | canonical `MapFeature[]` -> `RenderTileInput`, pure |
| `tests/unit/render-codec.test.ts` | 205 | container, round-trip, corruption, alignment |
| `tests/unit/build-render-tile.test.ts` | 262 | per-kind geometry, ranges/meta wiring, one real LOD0 tile |
| `scripts/data/build-tiles.ts` | 546 | emits `.mmt` + `.mmt.gz`, slim manifest, QA index, boundary tile |

## 2. Codec API (exact exports)

Constants: `RENDER_TILE_MAGIC` (0x4d4d5431), `RENDER_TILE_FORMAT_VERSION` (1),
`RENDER_TILE_ALIGNMENT` (4), `RENDER_LAYER_IDS` (17 ids, contract render order).

Functions:

- `encodeRenderTile(input: RenderTileInput): ArrayBuffer`
- `decodeRenderTile(buffer: ArrayBuffer): DecodedRenderTile`
- `renderLayerPositions(payload: ArrayBuffer, layer: DecodedRenderLayer): Float32Array`
- `renderLayerIndices(payload: ArrayBuffer, layer: DecodedRenderLayer): Uint32Array`
- `renderLayerRanges(payload: ArrayBuffer, layer: DecodedRenderLayer): Uint32Array`
- `alignRenderTileOffset(offset: number): number`
- `isRenderLayerId(value: string): value is RenderLayerId`
- `renderLayerOrder(id: RenderLayerId): number`
- `emptyRenderLayer(id: RenderLayerId): RenderLayerInput`

Types: `RenderLayerId`, `RenderBounds`, `FeatureMeta`, `RenderLayerInput`,
`RenderTileInput`, `RenderLayerHeader`, `RenderTileHeader`, `DecodedRenderLayer`,
`DecodedRenderTile`.

`DecodedRenderLayer` is the section 3.1 descriptor
(`{ id, positionOffset, positionLength, indexOffset, indexLength, rangeOffset, rangeLength }`);
`DecodedRenderTile` is `{ header, payload, layers, meta }` where `payload` is one
contiguous `ArrayBuffer` sliced from just after the header.

## 3. Transfer list

The worker transfers exactly one buffer: `[message.payload]`. The three accessors above
rebuild the typed-array views over that slab on the receiving side, so no per-layer
`ArrayBuffer` is ever transferred and no layer view is detached by a sibling transfer.
`sceneFromDecoded.ts` (W2 T15) already consumes this shape.

## 4. Container layout as built

`u32 magic | u32 version | u32 headerBytes | header JSON | payload`.

Payload per layer, in `RENDER_LAYER_IDS` order, empty layers dropped:
`Float32Array positions` (vertexCount*3), `Uint32Array indices`,
`Uint32Array featureRanges` (featureCount*3, `[indexStart, indexCount, metaIndex]`,
placed at `indexOffset + indexCount*4`), then 4-byte alignment padding.
The `featureMeta` JSON section starts at the aligned offset after the last layer
and the container ends 4-byte aligned. `featureMetaOffset` is a payload-relative
offset; the header itself is validated and range-checked on decode.

`encodeRenderTile` rejects, before allocating: non-multiple-of-3 positions/indices/ranges,
indices `>= vertexCount`, a gap or overrun in featureRanges, a featureRange `metaIndex`
outside the tile meta array, and unknown layer ids in a decoded header. Decode rejects
a bad magic, an unsupported version, a header that does not fit, and any section
descriptor pointing past the buffer.

## 5. Builder behaviour

`buildRenderTile(features: MapFeature[], options: BuildRenderTileOptions): RenderTileInput`,
pure, no filesystem, no Three.js scene objects (only `ShapeUtils.triangulateShape` and
`tessellatePolyline`).

- **buildings**: pre-extruded. Footprint rings are triangulated once (bottom + reversed
  top) and the contour plus each hole ring contributes wall quads. Height is
  `feature.height` when `> 0`, otherwise `DEFAULT_BUILDING_HEIGHT_METRES` (7);
  `heightInferred` is carried in `meta.p`.
- **roads**: `tessellatePolyline` ribbons, half width from `resolveRoadWidth`
  (explicit `width` then the class table: motorway 12 ... service 3.5). Strata split by
  `roadLayerFor` (tunnel/normal/bridge) with y = -1 / 0 / +0.6.
- **water**: polygons -> `water_surface`, lines -> `water_line` ribbons,
  `fictiveAxis === true` features are skipped entirely (no geometry, no meta entry).
- **landuse**: triangulated polygons split by `landuseLayerFor` into `habitat` and `landuse`.
- **transport**: areal or stop-like types -> `transport_area` (points as index-less
  position entries), rail/runway lines -> `transport_line` ribbons.
- **structures**: point -> `structures_point`, areal -> `structure_area`,
  linear -> `structure_line` ribbon.
- **poi + business** -> `poi`, **address** -> `address`, **place** -> `place`;
  positions only, one zero-count range entry each so picking resolves a metaIndex.
- **boundary**: skipped when `options.includeBoundary === false`.

`meta` is a single flat array; the third component of every featureRange is an index
into it, allocated only for features that actually emit geometry, so every entry is
reachable from at least one layer.

## 6. build-tiles.ts emission

After each canonical JSON tile is closed, the same file is re-read and converted, so
the render tile is built from exactly the JSON the manifest describes. Per tile the
builder writes `data/generated/render/<tileId>.mmt` and a `.mmt.gz` sidecar
(`zlib.gzipSync` level 9). The dataset-level `data/generated/render/boundary.mmt`
(+.gz) is written once from the boundary feature with `includeBoundary: true`.

Budget: the existing 1 MiB target / 2 MiB hard limit still apply to the JSON tile, and
`RENDER_LAYER_BUDGET_BYTES` (2 MiB) additionally caps the `.mmt`. A tile is subdivided
when either budget is exceeded; the child `.mmt` is re-emitted per child and the
parent `.mmt` plus `.mmt.gz` are removed with `removeRenderTile`, so no orphan render
files survive a split. A final check throws if any emitted tile is still over budget.

Outputs: `tile-manifest.json` is now the slim array
`{ tileId, lod, bounds, byteSize, featureCount }` (compact JSON, not indented).
`tile-index.json` is the QA-only array of full `TileManifestSchema` entries including
`features` and `fragmentIds`, same order, for `build-search-index` and `validate`.
`tile-metrics.json` gains `renderTileBudgetBytes`, `boundaryRenderTile`, per-level
`maxRenderBytes` / `medianRenderBytes` / `p95RenderBytes`, and a `renderLayerBytes` map.
New CLI flags: `--render-out-dir`, `--dataset-version` (default `0.1.0`, threaded
into every MMT1 header so the render route can emit `X-Dataset-Version`).
`buildTilesAll(inDir?, outDir?, forceSize?, renderOutDir?, datasetVersion?)` stays
source-compatible with the existing 3-argument call in `refresh.ts:476`.

## 7. Measured evidence

Full build was NOT run (RAM and sibling-activity rules). Proof is a synthetic
`buildTilesAll` run plus the unit tests.

Synthetic run (1 boundary, 400 roads, 600 buildings through all three LODs):

```
[tiles] LOD 0: 4 tiles, max 213.6 KiB, median 93.2 KiB, p95 153.4 KiB, render max 146.3 KiB
[tiles] LOD 1: 1 tiles, max 345.2 KiB, median 345.2 KiB, p95 345.2 KiB, render max 252.4 KiB
[tiles] LOD 2: 1 tiles, max 0.4 KiB, median 0.4 KiB, p95 0.4 KiB, render max 0.1 KiB
build took 708 ms
manifest entries 6 index entries 6
manifest keys ["tileId","lod","bounds","featureCount","byteSize"]
index keys ["tileId","lod","bounds","featureCount","byteSize","features","fragmentIds"]
renderLayerBytes {"boundary":108,"road_normal":100800,"buildings":302652}
render files 7 gz 7
boundary.mmt 444 layers [ 'boundary' ] meta 1
verified render files 7 total vertices 14414
```

Every emitted `.mmt` was decoded and checked: all indices `< vertexCount`, all
featureRange metaIndex values `< meta.length`.

Real data: `tests/unit/build-render-tile.test.ts` converts and decodes
`data/generated/tiles/l0_137_27_s2_1_1.json` (270 canonical features: 163 building,
69 address, 27 road, 8 water, 2 poi, 1 boundary) and asserts `buildings`, `road_normal`
and `address` layers are present, that the decoded arrays equal the encoded input
element for element, that the building layer carries one range entry per building, and
that more than one distinct building height survives extrusion.

Round-trip test result: `tests/unit/render-codec.test.ts` 12 passed,
`tests/unit/build-render-tile.test.ts` 14 passed, 26 total, 0 failed.
`npx tsc --noEmit` clean for `src/lib/render/codec.ts` and
`src/lib/render/buildRenderTile.ts`, and clean for the whole project at the time of
the final run.

## 8. Bugs found and fixed while building

1. Trailing alignment padding was placed before `featureMeta` while `featureMetaOffset`
   was computed from the pre-alignment cursor, so the meta section was read 1 to 3 bytes
   early and every non-empty tile failed to decode. Alignment now applies to the cursor
   after the last range, and the container ends aligned (`codec.ts:145`, `codec.ts:254`).
2. The first `streamLevel` render pass passed an empty feature list to
   `emitRenderTile`, producing 150-byte empty tiles. It now reads the closed tile JSON
   (`readTileFeatures`), and the split path reuses the same reader.
3. A duplicated `building` key in `EXTRA_META_KEYS` shadowed the real entry so
   `heightInferred` never reached `meta.p`, and the `poi` key was missing entirely.
4. Point-geometry transport features fell through to the ribbon path and emitted nothing;
   they now emit a position entry on `transport_area`.
5. Meta was allocated before the geometry decision for skipped features (fictive water
   axes, disabled boundary), leaving unreachable entries in `meta`.

## INTEGRATION NEEDS

- `scripts/data/validate.ts:119-122` reads `tile.features` from the slim
  `tile-manifest.json` to check fragment identity and manifest/payload agreement. It must
  read `tile-index.json` (or skip that check) now that the served manifest is slim.
  `validate.ts` is not my file.
- `scripts/data/build-search-index.ts:78-84` maps stableId -> tileId from
  `manifest.features`; wave2-6 confirmed it repoints at `data/generated/tile-index.json`.
- `refresh.ts:476` still calls `buildTilesAll(paths.intermediateDir, paths.tilesDir)`; the
  two new parameters default correctly, but the dataset version is hardcoded to `0.1.0`
  in `build-tiles.ts` while `refresh.ts` uses its own literal. One of the two should own
  it. Not my file.
- `src/lib/render/{tileWorker,workerPool,loadRenderTile}.ts` (wave2-5) need `payload`
  threaded through `DecodedResponse` and `workerPool.complete`; the API they need is
  listed in section 2 above and is live now.

The trailing `Fatal: Unexpected token ','` present in one background log line is not a
pipeline defect: two harness processes were launched against the same
`/tmp/mm-render-smoke` directory and raced on it. The figures above come from the run
whose log I read directly, which ended at the verification line with no fatal. The
harness and its temp output were deleted afterwards.
