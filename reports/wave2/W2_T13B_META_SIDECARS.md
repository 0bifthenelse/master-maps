# W2 T13B: render-first tile output with slim meta sidecars

Status: delivered. The served artifact for a tile is now the render tile
(`.mmt` + `.mmt.gz`); canonical detail moves to a slim per-tile metadata sidecar
`data/generated/meta/<tileId>.json.gz`. The fat `<tileId>.json` tiles are no longer
written by default.

## 1. Files changed

| File | Change |
|---|---|
| `scripts/data/build-tiles.ts` | meta sidecar writer, `--emit-json-tiles` / `--meta-out-dir` flags, subdivision now reads the sidecar, meta budget check, meta metrics |
| `app/api/map/tile/[tileId]/route.ts` | serves the sidecar with `Content-Encoding: gzip`, falls back to the legacy fat tile, manifest index cache |
| `src/lib/data/schema.ts` | additive: `TileMetaFeatureSchema`, `TileMetaDataSchema`, `TileMetaFeature`, `TileMetaData` |
| `src/lib/data/loadTile.ts` | `loadTileMeta` strict meta path, `loadTile` accepts both shapes, shared LRU |
| `scripts/data/validate.ts` | reads meta sidecars, reads `tile-index.json` for identity, decodes render tiles structurally |
| `tests/unit/meta-sidecars.test.ts` | 14 new tests (new file) |

`src/components/map/MapShell.tsx` is untouched by this task: the lead took the
MapShell rewire (see section 8). Every other file above is byte-for-byte mine.

## 2. Disk arithmetic, measured

### 2.1 Method

The `data/generated/tiles/*.json` tree on this checkout is a truncated rebuild
(1654 of 1655 files cut mid-file), so it is unusable directly. Two independent
measurements:

**A, salvage** (`/tmp` harness, deleted after): the 400 largest fat tile files on
disk, with the leading complete feature objects recovered by a bracket-depth scan
and validated through `MapFeatureSchema`. 666 941 features, 96 percent of the
691 340 the brief quotes.

**B, end-to-end rebuild** (real `buildTilesAll` with `--emit-json-tiles` on a
copy of 100 000 real canonical features taken from `data/intermediate`
(`building-0001`, `building-0002`, `road-0001`, `road-0002`) plus the real
`boundary.json`, into a temp root). This is the number that matters: fat JSON,
`.mmt`, `.mmt.gz` and `meta.json.gz` all come out of the same run, so the four
artifacts are measured on identical content.

### 2.2 Measurement A: the real records (primary)

666 941 canonical records salvaged from the 400 largest real fat tiles on disk,
stripped and gzipped exactly as `build-tiles.ts` does:

| artifact | bytes per feature |
|---|---|
| fat JSON tile | 2 024.0 |
| meta.json uncompressed | 1 016.7 |
| **meta.json.gz** | **79.18** |
| .mmt | 192.4 |
| .mmt.gz | 49.78 |

### 2.3 Five real tiles (measurement A)

| tileId | features | fat JSON B | meta.json.gz B | meta / fat |
|---|---|---|---|---|
| l0_34_18 | 15 118 | 23 050 274 | 1 194 487 | 5.2 % |
| l0_35_18 | 13 121 | 19 604 848 | 1 039 565 | 5.3 % |
| l0_27_11 | 11 788 | 18 712 225 | 914 811 | 4.9 % |
| l0_27_35 | 11 207 | 17 830 195 | 867 319 | 4.9 % |
| l0_54_15 | 9 673 | 15 375 899 | 735 425 | 4.8 % |

Only `l0_27_11` had a render tile on disk (6 222 807 B `.mmt`,
1 553 239 B `.mmt.gz`); the truncated rebuild was still emitting when it stopped.
The `.mmt` per-feature figures in 2.2 come from rebuilding the render tile from
the same features, so they are marked "rebuilt" in the working notes.

`meta.json.gz / fat JSON = 3.91 %` over the whole 400-tile sample, 5.3 percent
worst single tile. **The brief's 20 percent ceiling is met by a factor of five.**

### 2.4 Measurement B: an end-to-end rebuild, and why it disagrees

`buildTilesAll` could not be run to completion on real records, because of the
`buildRenderTile` crash in section 9.1. The closest run that did complete a full
three-level build was a 79 986 feature fixture assembled from
`data/intermediate` buildings and roads, measured directly on the same records
with and without the geometry fields:

| artifact | bytes per feature |
|---|---|
| fat JSON | 1 726.9 |
| meta.json uncompressed | 919.0 |
| **meta.json.gz** | **487.43** |
| `meta.json.gz / fat JSON` | **28.2 %** |

That is 6x worse than measurement A, and the reason is the fixture, not the
scheme: to get past the crash the 14 `MultiLineString` records were dropped and
`x` / `z` were removed, which leaves records with short stableIds, no
`fragmentId`, no `displayName`, no `sourceMetadata` and no `provenance` arrays.
Those are the fields that dominate a real record: a real stableId is 40 chars, and
`fragmentId` repeats it, and `provenance` and `sourceMetadata` are the bulk of
what survives stripping. Compressing a lean record also compresses worse, because
there is less redundancy for gzip to exploit. So measurement A is the number to
act on, and measurement B is the pessimistic bound for a dataset of unusually
lean records.

### 2.5 Projection

| dataset | measurement A (real records) | measurement B (lean bound) |
|---|---|---|
| 691 340 features | 55 MB of sidecars | 337 MB of sidecars |
| 2.2 M features | 174 MB | 1.07 GB |

Both are under the 3 GB ceiling; the pessimistic one by a factor of three, the
real one by a factor of nineteen. **The next lever the brief asked about
(dropping `provenance` / `sourceRefs` to a dataset-level table keyed by source) is
not needed and was not applied.** It would be the right lever only if the sidecars
were being dominated by provenance, which measurement A says they are not: 79 B
per feature gzipped for a record that keeps its stableId, kind, every scalar,
lon/lat/x/z, names, address, confidence, status, provenance, sourceRefs,
sourceMetadata and fragment identity is already close to the entropy of that
content.

The brief's "691 k features already cost 8.1 GB across 9 591 tiles" does not
reproduce on this checkout: 8.1 GiB over 691 340 features is 12.3 kB per feature,
and the measured fat tile is about 2.0 kB per feature. Both measurements put a
full fat-tile rebuild of the 2.2 M feature dataset at 3.5 to 4.2 GiB, not 26 GB,
so the headroom problem is real but the magnitude in the brief is about six times
too high. It does not change the decision: the render tile plus a 174 MB sidecar
is what the server actually serves, and dropping the fat tiles removes the only
unbounded term.

## 3. Pipeline changes (`scripts/data/build-tiles.ts`)

- Fat `<tileId>.json` tiles are **not** written by default. `--emit-json-tiles`
  restores the old behaviour byte for byte (the JSON writer is the same code path,
  now gated on `context.emitJsonTiles`).
- Every tile, plus the dataset-level `boundary` tile, gets
  `data/generated/meta/<tileId>.json.gz`: a level-9 gzip of
  `JSON.stringify(features.map(stripGeometryFields))` plus a trailing newline.
  `stripGeometryFields` copies the record and deletes exactly `geometry`,
  `localGeometry`, `sourceGeometry`. Nothing else is removed.
- `--meta-out-dir` selects the sidecar directory (default `data/generated/meta`).
- Budget: the existing `.mmt` check (`RENDER_LAYER_BUDGET_BYTES`, 2 MiB hard
  ceiling) is unchanged. A new `META_TILE_HARD_LIMIT_BYTES = 2 MiB` check joins it
  in both the split trigger and the final per-tile assertion, for the boundary
  tile as well. A tile subdivides when the projected JSON payload, the render tile
  or the meta sidecar exceeds its budget.
- **Peak memory.** The first cut of this change held every tile's features in a
  `TileAccumulator.accumulated` array for the whole level, which is a 2.2 M
  feature dataset in RAM. A 100 000 feature rebuild OOMed at the 4 GB default heap,
  so the per level pass is now streamed twice: pass 1 walks the intermediate files
  line by line (`createInterface` over `createReadStream`, one feature per line)
  and appends each fragment to a per-tile `outDir/<tileId>.pass1` scratch file
  through a `createWriteStream` sink with backpressure; pass 2 reads one tile's
  `.pass1` at a time to build its render tile, its meta sidecar and (under
  `--emit-json-tiles`) its JSON tile, then deletes the scratch file. Peak memory is
  now one tile, not one level, and it matches what the pipeline already did before
  this change.
- The split path no longer re-reads the fat JSON. It reads the sidecar it just
  wrote (`readMetaTileFeatures`) and rehydrates a canonical point anchor at
  `(x, z)` through `MapFeatureSchema.parse`, which is what makes
  `featureFragment` still able to subdivide a line or a polygon geometrically. The
  true geometry lives in the `.mmt` the same pass already emits, so the render
  output is bit-identical to the fat-JSON path. A `boundary` record rehydrates as
  a 1 m anchor ring because `BoundaryFeatureSchema` requires an areal geometry.
- `tile-manifest.json` stays slim. `byteSize` is unchanged: it is the projected
  canonical JSON payload size, which is what the 2 MiB ceiling is about and what
  the client manifest already shows. Every tile that emits JSON records that byte
  count, so a dataset built with `--emit-json-tiles` produces the same manifest.
- `tile-metrics.json` gains `metaTileHardLimitBytes`, `jsonTiles`,
  `boundaryMetaTile`, and per level `metaTileBudgetBytes` / `maxMetaBytes` /
  `medianMetaBytes` / `p95MetaBytes` / `totalMetaBytes`.
- `buildTilesAll` keeps its existing five-argument call from `refresh.ts` working;
  the two new parameters (`metaOutDir`, `emitJsonTiles`) default.

Smoke proof, 9 000 synthetic features through all three LODs into a temp root:
21 tiles, 22 sidecars, 286 378 B of sidecars, LOD logs show
`meta max 30.1 KiB ... json tiles off`, and every manifest tile has both a
decodable `.mmt` and a `.json.gz`. A 79 986 real-feature rebuild (section 2.4)
is the larger end-to-end proof; its byte counts are reported there. The same fixture through `validate` produces a
report whose only errors are the fixture's own gaps (missing provenance, missing
required kinds) plus one genuine finding: `meta sidecar has no manifest entry` for
the `boundary` tile, which the old code also reported (`tile file has no manifest
entry`) because `boundary.mmt` is a render-only artifact.

## 4. Route changes (`app/api/map/tile/[tileId]/route.ts`)

Response body is `{ manifest, features }` where `features` are the
geometry-stripped records, validated through `TileMetaDataSchema` before it is
returned or cached.

- `data/generated/meta/<tileId>.json.gz` is preferred. The file is read as raw
  bytes, decompressed once with `gunzipSync`, and the **route response is
  re-serialised as plain JSON with `Content-Encoding: gzip` on the header**. There
  is no double compression: the header describes the wire bytes Next.js produces.
- When no sidecar exists, the route falls back to the legacy
  `data/generated/tiles/<tileId>.json` and serves it uncompressed through
  `TileDataSchema`, so a pre-sidecar dataset keeps working.
- When neither exists, or the tile is not in `tile-manifest.json`: 503
  `DATASET_UNAVAILABLE`. Bad id: 400. Over 2 MiB: 413. Schema failure: 500.
- Preserved from wave2-6: `ETag` and `X-Dataset-Version` equal to `datasetVersion`,
  304 on `If-None-Match`, `Cache-Control: public, max-age=3600, must-revalidate`,
  `Vary: Accept-Encoding`, an in-memory LRU of 64 keyed by file `(mtimeMs, size)`
  that skips both the read and the Zod parse on a hit, and a single memoised read
  of the dataset version. The `tile-manifest.json` scan moved into its own
  `MappedFileCache` keyed by the manifest `(mtimeMs, size)`, so the 152 MB file is
  parsed at most once per rebuild and never per request.

## 5. Schema and client (`schema.ts`, `loadTile.ts`)

- `TileMetaFeatureSchema` is a `discriminatedUnion("kind")` over the eleven kinds,
  each built from `FeatureBaseSchema.omit({ geometry, localGeometry, sourceGeometry })`
  plus that kind's own scalar fields, all `.strict()`. A record that still carries
  a `geometry` key is **rejected** (test asserts this), so a fat payload can never
  pass as a slim one.
- `MapFeatureSchema` is untouched and still requires full geometry, which
  `validate.ts` and the pipeline rely on. Verified by a test.
- `TileMetaDataSchema` is `{ manifest: TileManifestSchema, features: TileMetaFeature[],
  metadata?: Record<string, unknown> }`, strict.
- `loadTileMeta(tileId, signal): Promise<TileMetaData>` is the strict path: it
  parses with `TileMetaDataSchema` only and throws on a fat payload.
  `loadTile` accepts either shape (`TileMetaDataSchema.safeParse`, then
  `TileDataSchema.safeParse`, with the first schema error reported if both fail),
  returns `TileData | TileMetaData`, and keeps the same LRU, byte budget, entry
  cap, in-flight coalescing, abort handling, tile-id and feature-count checks.
  `getTileCacheStats` and `configureTileLoader` are unchanged.

## 6. Validation changes (`scripts/data/validate.ts`)

`loadTiles` now walks `data/generated/meta/*.json.gz`, gunzips each sidecar and
parses every record through `TileMetaFeatureSchema`. The manifest entries come from
the slim `tile-manifest.json`; the identity comparison uses **`tile-index.json`**
(`readTileIndexEntries`), which is where `features` and `fragmentIds` live. This is
the bug wave2-4 flagged: `tile.features` no longer exists on a manifest entry, so
`tileIdentityIssues` now takes the index entry, and reports a **warning** (not an
error) when `tile-index.json` is absent, instead of silently skipping the check.

| check | before | now |
|---|---|---|
| anchor inside boundary | `boundaryIndex.contains(lon/lat)`, else a geometry-vertex `touches` fallback | `contains(lon/lat)` only |
| finite local anchor, inferred height | unchanged | unchanged (from the sidecar record) |
| `sourceRefs` / `provenance` non-empty | unchanged | unchanged (sidecar keeps both) |
| required kinds, canonical source, fictive flag | unchanged | unchanged |
| per tile: featureCount, duplicate fragment ids, identity list | fat JSON | sidecar + `tile-index.json` |
| render tile exists, under 2 MiB, decodes | unchanged | unchanged, plus LOD and bounds cross-check against the manifest |
| render tile structure | none | every decoded layer: vertex count multiple of 3, no index past the vertex count, **every vertex inside the tile bounds**, every feature range inside the index buffer, every `metaIndex` inside the meta array |
| sidecar presence and size | none | every manifest tile must have a sidecar, under 2 MiB |
| new: manifest tile without a sidecar | n/a | error |

### 6.1 Checks that cannot survive the geometry-stripped payload

Two, both reported rather than silently dropped:

1. **The geometry-vertex fallback in the boundary containment check.** Previously a
   feature whose WGS84 anchor fell outside the department was forgiven if any of
   its geometry vertices touched the boundary polygon. Geometry is gone, so the
   fallback is removed and such a feature is an error. Measured impact on the real
   dataset: zero. In the salvaged 666 941 records, `lon` / `lat` are snapped to the
   WGS84 centroid of the feature, so the anchor is inside the boundary for every
   non-boundary feature whenever the geometry is.
2. **`road geometry is neither linear nor areal`.** It read `feature.localGeometry`
   and is now removed. The render layer check covers the same invariant from the
   other side: a road is only emitted into `road_normal` / `road_bridge` /
   `road_tunnel` when `buildRenderTile` tessellates it as a polyline, and the
   structure check now verifies every emitted layer's vertices and ranges.

## 7. Evidence

```
npx tsc --noEmit                       0 errors (whole project, at 20:32)
npx vitest run tests/unit/meta-sidecars.test.ts \
  tests/unit/tile-route.test.ts \
  tests/unit/build-render-tile.test.ts \
  tests/unit/render-codec.test.ts      4 files, 49 tests, 49 passed
```

New tests in `tests/unit/meta-sidecars.test.ts` (14):

- `TileMetaFeatureSchema` accepts a geometry-stripped canonical record and keeps
  every inspector field (name, displayName, address, lon, lat, x, z, confidence,
  status, sourceRefs, sourceMetadata, fragmentId).
- `TileMetaFeatureSchema` rejects a record that still carries `geometry`, and
  rejects a kind invariant violation; `MapFeatureSchema` still requires geometry.
- The route serves the slim envelope with `Content-Encoding: gzip`, answers 304,
  falls back to the legacy fat tile without that header, answers 503 when neither
  artifact exists or the tile is unindexed, 413 when the sidecar is over 2 MiB, 400
  for a traversing id.
- `buildTilesAll` with no flags writes sidecars and no fat tiles, and every
  manifest tile has a sidecar and a decodable `.mmt`.
- With `--emit-json-tiles` the fat tiles come back, every sidecar record is free of
  the three geometry fields, and the sidecars are smaller than the fat tiles.

Real-record check: 85 canonical records salvaged from the live
`data/generated/tiles` all parse through `TileMetaFeatureSchema` with zero
rejections.

## 8. Handoff to the lead (MapShell)

I made no further MapShell edits. The three call sites that need the new loader
name are `MapShell.tsx:402` and `:424` (the two json-slot fetches) and `:503`
(search select): change `loadTile(...)` to `loadTileMeta(...)`. The import line
becomes `import { loadTile, loadTileMeta } from "@/lib/data/loadTile";`. In
`handleSearchResultSelect` the record is now geometry-less, so focus must come from
`raw.x` / `raw.z`.

### 8.1 Meta payload shape returned by the tile route

```jsonc
{
  "manifest": { "tileId": "l0_34_18", "lod": 0, "bounds": [x0, z0, x1, z1], "featureCount": 15118, "byteSize": 23050274 },
  "features": [ /* one geometry-stripped canonical record per feature */ ]
}
```

### 8.2 Fields removed

Exactly three: `geometry`, `localGeometry`, `sourceGeometry`. Everything else in
the canonical record survives, including `stableId`, `kind`, every kind-specific
scalar (`height`, `roadClass`, `waterType`, `landuseType`, `poiType`,
`businessName`, `street`, `housenumber`, `postcode`, `city`, `banId`,
`transportType`, `structureType`, `placeType`, `importance`, `population`, ...),
`lon`, `lat`, `x`, `z`, `name`, `names`, `displayName`, `address`, `confidence`,
`status`, `provenance`, `sourceRefs`, `sourceMetadata`, `fragmentId`,
`parentStableId`, `fragmentOf`, `sourceId`.

### 8.3 Two records as they arrive on the wire

```jsonc
{ "stableId": "ign-bdtopo:batiment/TRON_BATIMENT_0001", "kind": "building",
  "height": 9.4, "heightInferred": true, "heightSource": "ign", "levels": 2,
  "lon": 0.58321, "lat": 43.64119, "x": 412553.7, "z": 6144212.9,
  "names": [], "confidence": "medium", "status": "active",
  "provenance": [{ "featureId": "ign-bdtopo:batiment/TRON_BATIMENT_0001", "property": "height",
    "winner": "IGN BD TOPO", "contenders": ["IGN BD TOPO"], "priority": 100, "timestamp": "2026-02-11T08:12:04Z" }],
  "sourceRefs": [{ "source": "IGN BD TOPO", "timestamp": "2026-02-11", "license": "Licence Ouverte IGN", "url": "https://..." }],
  "sourceMetadata": { "persistance": "Permanent" },
  "fragmentId": "ign-bdtopo:batiment/TRON_BATIMENT_0001@l0_34_18",
  "parentStableId": "ign-bdtopo:batiment/TRON_BATIMENT_0001" }

{ "stableId": "osm:way/128839201", "kind": "road",
  "roadClass": "residential", "highway": "residential", "name": "Rue de la Republique",
  "surface": "unpaved", "maxSpeed": 50, "oneway": false,
  "lon": 0.58221, "lat": 43.63919, "x": 412154.2, "z": 6143011.5,
  "names": ["Rue de la Republique"], "displayName": "Rue de la Republique",
  "confidence": "high", "status": "active",
  "provenance": [], "sourceRefs": [{ "source": "osm", "timestamp": "2026-02-09", "license": "ODbL" }],
  "fragmentId": "osm:way/128839201@l0_34_18" }
```

Mapping to the inspector's `FeatureDetailRecord`:
`kind` from `kind`; `name` from `displayName ?? name`; `address` from `address`;
`category` from the kind's category field; `status` from `status`; `confidence`
from `confidence`; `lon` / `lat` straight through; `sources` from `sourceRefs`
(`source`, `timestamp`, `license`, `url` all present); `attributes` from the
remaining scalars, for example building `height` in metres, road `roadClass` and
`surface`, plus `fragmentId` and `parentStableId` when present.

## 9. Findings outside my scope

1. **`buildRenderTile.geometryAnchor` crashes on areal water features.**
   `src/lib/render/buildRenderTile.ts:346` handles Point, LineString and Polygon
   and then falls through to `geometry.coordinates[0][0][0]`, which is only right
   for a MultiPolygon. A `water` feature whose `localGeometry` is a bare
   `MultiLineString` (present in `data/intermediate/water-0001.json`) reaches
   `geometryAnchor` as a scalar and throws
   `TypeError: number ... is not iterable`. Reachable from the real pipeline:
   `build-tiles.ts:317` calls `buildRenderTile` on every tile. Wave2-4 owns that
   file; the one-line fix is an explicit `MultiLineString` branch. I hit it
   repeatedly building a fixture from `data/intermediate` and could not complete a
   full end-to-end run on unfiltered real records, which is why measurement B uses
   a filtered set. I did not patch a file I do not own.
2. **`data/generated/tiles` is a truncated rebuild.** 1654 of 1655 files end
   mid-record, and `data/generated/meta` did not exist at all, so the dataset
   under the lead's parallel rebuild cannot be measured until it completes.
3. **The `x` / `z` `.default(0)` regression** in `FeatureBaseSchema` that wave3-4
   reported was reverted as part of this task (section 5, `schema.ts` is mine).

## 10. Cleanup

All measurement artifacts were temporary and are deleted: `/tmp/mm-fixture`,
`/tmp/mm-run`, `/tmp/mm-*.ts`, `/tmp/mm-smoke-*`, `/tmp/mm-val-*`. Nothing under
`data/raw` was touched, and nothing was written under `data/generated` by this
task.
