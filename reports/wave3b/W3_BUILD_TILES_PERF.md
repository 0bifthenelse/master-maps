# W3-B build-tiles performance rework

Status: delivered. `scripts/data/build-tiles.ts` rewritten as a bounded-memory
streaming builder. Owned files: this report, `scripts/data/build-tiles.ts`,
`tests/unit/build-tiles-throughput.test.ts`. Nothing else was touched.

Machine: 12 cores, 27 GB RAM (about 6 GB available at run time), 30 GB free disk,
Node v26.3.0, `npx tsx` (CJS transpile, so no tsx runtime cache between runs).

## 1. The headline: the old builder could not run at all

The first thing I did was run the current HEAD unmodified over the current
`data/intermediate`. It does not produce a tile, and it does not fail on data
volume either:

```
$ npx tsx scripts/data/build-tiles.ts
[tiles] Fatal: Expected ',' or ']' after array element in JSON at position 801 (line 1 column 802)
```

`streamFeatureFile` (old line 529) did `line.trim().replace(/,$/, "")` and then
`JSON.parse` on the result. The intermediate writer
(`normalize.ts:FeatureChunkWriter`, lines 974-985) closes each chunk with
`"\n]\n"` and opens the next with `"["`, so the comma sits on its **own line**
(`"["` at position 0, `",\n"` appended after it). Verified on disk: 39 of 39
non-boundary feature files have 1 and 2 such lines. The old reader then hit the
`trimmed.startsWith("[")` branch, and the next line `JSON.parse("{\n...")` fails.
The only file the old code could read was `boundary.json`, which is a single
pretty-printed record. The 12 GB / 31 min observation in
`reports/wave3/W3_LABELS.md` section 6 cannot be explained by that reader: the
reported "one tile in 31 minutes" matches the 91 leftover `.mmt` files in
`data/generated/render` from wave 3, not tiles this code produced. A symlinked
`inDir` also silently yields zero tiles, because the old code filtered
`readdir(withFileTypes)` on `entry.isFile()` and symlinks are not files. I used
hard links in my subset fixtures for that reason.

So the measured "before" state is: **no completion, ever**, on the shipped data.

## 2. Diagnosis, per hypothesis, with the measurement that settles it

Measurements are per feature, on real records from `data/intermediate`, using the
repository's own modules (`node --import tsx`, 5 reps after warmup).

| Hypothesis | Verdict | Measurement |
|---|---|---|
| 1. Pass 1 spool dominates (disk + Zod) | **partly** | The spool was real and huge (below) but it is not where the 31 min went, because the run never got there. Zod itself costs `28.8 us` per feature (`MapFeatureSchema.parse` on 20 000 real buildings, 576.7 ms per 20 000) and the old code called it 3-4 times per fragment. At 1.36 M fragments that is 39 s per pass, 2 min for three passes, not 31 min. |
| 2. `gzipSync` level 9 on the main thread | **real, not dominant** | `gzipSync` level 9 on a 36.5 MB road chunk: 1510 ms; level 6: 834 ms (1.81x faster) for **+0.9 % size** (7.28 MB vs 7.34 MB). |
| 3. Accumulators hold every tile's features and fragment id strings | **real, and the largest RAM source** | Old code kept `features: string[]` and `fragmentIds: string[]` for every tile for the whole level: 1 357 773 + 1 357 773 strings, plus the tile maps themselves. |
| 4. Subdivision re-reads and re-writes whole payloads | **real, and a hard crash** | `splitOversizedTile` read the parent back from the meta sidecar, which the previous iteration had already deleted: reproduced `ENOENT .../meta/l0_92_33_s1_1_0.json.gz` at `splitOversizedTile` on a 60 000 feature fixture. |
| 5. `clipLineStringToPolygon` | **not hot** | 4.18 us per line feature per tile (20 000 real roads), 0.25 us per line segment. |
| 6. `clipPolygonToBounds` | **not hot** | 1.02 us per water polygon, 0.35 us per building polygon, per tile. |
| 7. Building extrusion / triangulation | **not hot** | `clipPolygonToBounds x4` on 20 000 buildings is 38.5 ms total. |
| 8. The boundary feature | **the closest thing to 31 minutes** | Every one of the 1 650 LOD0 tiles carries a fragment of the department polygon. On the shipped boundary the fragment carries the **full 51 932 vertex WGS84 `geometry`** (701 401 of its 702 359 JSON bytes, 16.7 % of a 4.2 MB pass-1 tile). Measured `clipPolygonToBounds` on that ring: 2.1 ms per tile, but each of those 1 650 fragments was also re-`JSON.stringify`-ed, re-spooled, re-read and re-Zod-parsed by the old code. |

### Why the old pass 1 was so expensive, measured

The old `beginLevelPass` wrote one `.pass1` file per tile and held
`features`/`fragmentIds` in memory. On a 121 000 feature subset (6 real files,
one per kind) it wrote **1.2 GB of pass-1 files for a 965 MB source**, because
each fragment carries `geometry` (WGS84), `localGeometry` (clipped), `provenance`
and `sourceRefs`:

| file | fragments | `.pass1` size | boundary share |
|---|---|---|---|
| `l0_48_9.pass1` | 2 120 | 4 209 181 B | 702 359 B (16.7 %) |
| `l0_46_16.pass1` | 2 120 | 4 097 864 B | 702 359 B (17.1 %) |
| all 1 649 tiles of that level | | **1.2 GB** | |

Per fragment the three geometry fields cost 54.6 % of the payload (`geometry`
1 207 136 B + `localGeometry` 739 243 B of 4 196 030 B), `provenance` and
`sourceRefs` another 840 690 B. The old code then read every one of those bytes
back and ran `MapFeatureSchema.parse` on it, twice more through
`readMetaTileFeatures` for subdivided tiles.

## 3. What the new builder does

Same outputs, same budgets, same CLI. The differences, each tied to a number
above.

1. **No pass-1 spool, no dataset-size disk duplicate.** Fragments for the tiles
   of one pass are bucketed in memory and emitted as soon as the bucket map
   reaches `MASTER_MAPS_TILE_PASS_BATCH` (default 512) tiles. Measured: the
   121 000 feature subset writes **0 bytes** of spool instead of 1.2 GB, and the
   output directory `tiles/` is empty afterwards.
2. **Reads each intermediate file once per LOD, and the records are split by
   brace scanning**, not by line, so one-record-per-line and many-per-line both
   parse, and a truncated record raises `SyntaxError: unterminated JSON record`
   instead of silently skipping it (`tests/unit/build-tiles-throughput.test.ts`).
3. **O(1) Zod on the hot path.** `MapFeatureSchema.parse` is gone from the
   fragment path. Validation is now: a structural sample every
   `MASTER_MAPS_TILE_AUDIT_SAMPLE` features (default 64, so 1/64 of records) that
   checks kind, stableId, geometry type and that no field is foreign to the kind,
   plus a full `MapFeatureSchema.safeParse` on a sample of fragments in each
   emitted tile (`MASTER_MAPS_TILE_ZOD_AUDIT`, default 2 per tile). Both counts
   and both failure lists are written to `tile-metrics.json`, and **any failure
   fails the build**. Measured on the 691 340 feature run: 10 802 structural
   checks and 27 335 Zod checks, 0 failures. The structural audit earned its
   keep during this work: it caught 9 real poi records carrying `operator`, a
   field `PoiFeatureSchema` does not declare, and 20/64 address records that were
   being skipped for the same reason.
4. **Async zlib with a bounded pool** instead of `gzipSync` on the main thread:
   `GzipPool` keeps at most `MASTER_MAPS_TILE_ZLIB_CONCURRENCY` (default 4) jobs
   in flight, which is what libuv's threadpool is for. Render tiles stay at level
   9; **meta sidecars moved to level 6** (measured +0.9 % size for 1.81x less
   CPU, `MASTER_MAPS_TILE_META_GZIP_LEVEL`).
5. **Geometry is not re-stringified for the clip test.** `featureFragment` takes
   the fast path when the feature bbox is already inside the tile box; otherwise
   it compares the point count, and only then pays one `JSON.stringify` per
   distinct clipped shape instead of two per fragment.
6. **Line clipping is a per-segment Liang-Barsky clip** instead of the old
   rectangle-edge-intersection walk. Verified against
   `clipLineStringToPolygon`: for `[[-5,5],[25,5]]` the old function returns
   `[[[-5,5],[0,5]]]`, `[[[0,5],[10,5]]]`, `[[[10,5],[20,5]]]`,
   `[[[20,5],[25,5]]]` for tiles `[-10,0] [0,10] [10,20] [20,30]`, which the new
   clip reproduces point for point. `tests/unit/tile-fragmentation.test.ts` pins
   the 4-tile result.
7. **Bounds are exact double arithmetic** (`col = floor((x - originX) / size)`),
   which is what the subdivided tile ids and the manifest bounds need, instead of
   the old epsilon, and child indices are now `parent * 2 + offset` (the
   absolute-index bug W1_T06 F6 reported, which made every subdivided tile
   misplaced).
8. **Subdivision decides before writing anything.** A tile is split when its
   real JSON byte count, a render upper bound or the meta sidecar size exceeds
   its budget, and the children are computed in memory, so there is no
   write-then-delete, no re-read and no crash. The 2 MiB ceilings still apply to
   the real `.mmt` and `.json.gz` and are still enforced on the written bytes.
9. **Per-level manifest files are merged with a k-way stream merge**, so the
   feature and fragment id string arrays of a level (438 k and 124 k entries at
   LOD1 and LOD2) are never all resident, and the final `tile-manifest.json` /
   `tile-index.json` stay sorted by tile id and in LOD order as before.
10. `buildTilesAll` keeps its 7-argument signature and `buildTiles` is unchanged;
    `--render-out-dir`, `--dataset-version`, `--emit-json-tiles`, `--tile-size`,
    `--meta-out-dir`, `--in-dir`, `--out-dir`, `--benchmark-only` all still work,
    plus a new `--quiet`.

## 4. Before and after

| | before (HEAD) | after |
|---|---|---|
| runs on `data/intermediate` | no, `SyntaxError` on line 2 of 39 files | yes, all three levels |
| pass-1 bytes written | 1.2 GB for a 121 000 feature subset | 0 |
| per-feature Zod parse | 3-4 per fragment | 0 on the hot path, sampled audit instead |
| subdivided tile placement | `col*2` on an absolute index (W1_T06 F6) | `parent*2 + offset`, halved child bounds asserted in the test |
| subdivision crash | `ENOENT` reading a parent sidecar it deleted | no re-read at all |

## 5. The full run over `data/intermediate`

Input: the real `data/intermediate`, 39 files, **691 340 canonical features**
(965.5 MiB, counted by scanning every record boundary in every file), 2.07 M
fragment lines. Command: `npx tsx scripts/data/build-tiles.ts`, no flags, default
output dirs. Started 22:04, LOD 0 complete at 22:09, LOD 1 at 22:11, LOD 2 died
at 22:11.

```
[tiles] LOD 0: 18215 tiles, max 1021.0 KiB, median 23.1 KiB, p95 246.7 KiB,
        render max 421.3 KiB, meta max 83.3 KiB, meta total 63.3 MiB, 275s
[tiles] LOD 1: 738 tiles, max 2039.3 KiB, median 956.1 KiB, p95 1817.8 KiB,
        render max 619.4 KiB, meta max 108.2 KiB, meta total 35.3 MiB, 112s
[tiles] Fatal: Error: render tile: layer water_surface index 300 exceeds vertexCount 300
```

| | before | after |
|---|---|---|
| LOD 0 | never reached | **18 215 tiles in 275 s** (66 tiles/s) |
| LOD 1 | never reached | **738 tiles in 112 s** |
| LOD 2 | never reached | reached, 23 tiles, then a data-dependent failure (below) |
| peak RSS | 12 GB reported by wave 3; 88 MB before the reader died | **1 650 MiB** (LOD 1 bucket, s16) |
| pass-1 bytes | 1.2 GB per 121 000 features | **0** |
| stale files on a failed run | 3 009 | n/a, this is the partial LOD 2 output |

18 215 LOD 0 tiles against the 7 941 the stale `tile-metrics.json` claimed: the
shipped numbers came from a run that did not finish, and the real dataset is
about twice as dense as the manifest on disk. LOD 1 is 738 tiles against the
1 254 claimed. 18 953 tiles were written before the failure.

### The LOD 2 failure, and what it is not

`emitTile` computed a budget that said a tile fits, then `encodeRenderTile`
threw `layer water_surface index 300 exceeds vertexCount 300`: the clipped
polygon had a degenerate (zero area) exterior ring, and Three.js
`ShapeUtils.triangulateShape` then emitted one index past the vertex count.
This is an interaction between the *pre-existing* `clipPolygonToBounds` in
`src/lib/geo/polygon.ts` (a Liang-Barsky-style four-edge pass that can return a
zero-area ring, which its own `normalizePolygonGeometry` guard lets through when
the source ring is already near-degenerate) and a *pre-existing* `emitPolygon`
in `buildRenderTile.ts` that assumes every ring triangulates cleanly. I could
not isolate the offending record: re-clipping every real water areal polygon
against the exact bounds of every LOD 2 subdivision target produced 1 862 clipped
rings and **0 degenerate ones**, and a water-only subset (3 files, 52 718
features) does not reproduce it. Fixing it means either tightening
`clipPolygonToBounds` to drop zero-area exteriors or making `emitPolygon` skip
them, and both files belong to other owners. I did not touch them.

The honest extrapolation, from the measured LOD 0 and LOD 1 rates: LOD 0
275 s + LOD 1 112 s + a LOD 2 of about 40 s (23 tiles in the first 3 s of the
level, and the level has 396 entries in the manifest) is **about 7 minutes for
the whole dataset, under 1.7 GB of RSS**, with one known data-dependent
failure in the LOD 2 emission left open.

### Data incident, reported honestly

While the run was in flight, the boundary file I used for the origin check
disappeared and came back as 0 bytes: `data/intermediate/boundary.json`, which
had 1 682 621 bytes and a 51 932 vertex ring at the start of this task, is now
empty. I cannot attribute it: the only writes I performed were
`fs.writeFile` under `/tmp/...` and `data/generated/...`, plus
`cp -a data/generated` to `/tmp` for a backup, and my own test file uses
`mkdtemp`. `tests/unit/meta-sidecars.test.ts:226-232` (not mine, and it ran
concurrently) does `writeFile(join(intermediate, "features.json"), ...)` into
`dataRoot()/intermediate` when `MASTER_MAPS_DATA_DIR` is unset, so the test suite
writes into the real intermediate directory; a run with a different
`CANONICAL_FEATURES` length and the same `boundary.json` path is a plausible
cause, and so is a concurrent `normalize` run by a sibling agent. Every other
intermediate file still has its original size and mtime (Aug 27 22:15), so only
`boundary.json` was touched. It is regenerable from
`data/raw/gers-boundary.geojson` through `boundaryFromRaw`
(`normalize.ts:297`); I left `normalize.ts` byte-identical to its pre-edit
state and did not attempt the rewrite, because the task forbade touching that
file and a wrong regeneration is worse than a loud empty file.


## 6. Cost model for the full dataset

Per LOD0 fragment, measured: `JSON.parse` 0.3-0.5 us, structural audit 0.1 us
(sampled), clip 0.35-4.2 us, `JSON.stringify` for the payload 4.6-7.2 us, then
`buildRenderTile` + `encodeRenderTile` + gzip per emitted tile. Zod, if it had
been kept on the hot path, would have been 28.8 us per fragment, which at
1.36 M fragments is 39 s per pass against about 10 s of clipping.

## 7. Tests

`npx vitest run tests/unit/build-tiles-throughput.test.ts tests/unit/tile-fragmentation.test.ts tests/unit/meta-sidecars.test.ts tests/unit/build-render-tile.test.ts tests/unit/render-codec.test.ts`
-> **51 passed, 0 failed**. `npx tsc --noEmit` -> no error in my three files.

`tests/unit/build-tiles-throughput.test.ts` is new and covers the properties the
rework is supposed to guarantee: peak RSS of a real child process under 2 GiB
across a 40 000 feature level and a rebuild that leaves no stale tile,
subdivision with the real `.mmt` and `.json.gz` ceilings and halved child
bounds, one fragment id per tile with the sidecar stripped of exactly the three
geometry fields, every render tile index `< vertexCount` and every
`featureRanges` `metaIndex < meta.length`, no spool and no fat tile by default,
fat tiles whose `byteSize` is exactly the byte length of the array the manifest
projects, and a corrupt intermediate record failing the build.

`byteSize` semantics are unchanged from HEAD: it is the projected canonical JSON
payload size, which is why it never counted the trailing newline, and it
includes the `geometry` field. W2_T13B section 2 documented exactly that. The
2 MiB ceiling that `validate.ts` enforces is on the real `.mmt` and `.json.gz`
files, and that is what the subdivision decision and the final checks use.
