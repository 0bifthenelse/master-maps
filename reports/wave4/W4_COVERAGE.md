# W4-COVERAGE: stratified geographic coverage proof

Status: delivered. `scripts/data/qa-coverage-report.ts` (894 lines) writes
`data/qa/coverage-report.json` and exits non-zero on any verdict failure.
`tests/unit/qa-coverage-report.test.ts` covers the pure halves (32 tests, green).

No app code was modified. No existing script was modified.

## 1. What the script computes

| Block | Source | Content |
|---|---|---|
| `grid` | `data/raw/gers-boundary.geojson` via `scripts/data/boundaryIndex.ts` | 8x8 grid, origin = department bbox min corner, `cellSize = max(spanX, spanZ) / 7` so the department spans the grid with margin on the far edge. A cell is "intersecting" when at least one of 8x8 = 64 sample points at cell centres falls inside the department polygon (containment from `boundaryIndex`, no point-in-polygon reimplementation). |
| `kinds.canonical` | `data/qa/coverage.json`, then `data/manifests/coverage.json`, then `data/generated/manifests/coverage.json`, then `data/generated/coverage.json`, then `manifest.json featureCounts` | canonical count per kind; missing kinds are defaulted to 0 so the report always has all 11 adopted kinds. |
| `cells[]` | render tiles on disk + `data/intermediate/*.json` | per cell: declared LOD0 tiles, render tiles on disk, unique distributed features, per-kind counts, present kinds, absent kinds, and one `missing[]` entry per absent adopted kind with a reason. |
| `lod0Payload` | `data/generated/render/*.mmt` `stat` size | p0/p25/p50/p75/p90/p95/p99/p100 and mean, measured on disk, not from the manifest. |
| `searchability` | `data/search/index.json` streamed line by line | records per kind divided by canonical count per kind. |
| `verdicts` | derived | see section 3. |

### Where the per-kind geographic distribution comes from

`tile-manifest.json` (146 MB) declares `features: ["ign-bdtopo:road/TRONROUT1", ...]`, so its
ids are **source-prefixed**: the segment before the colon is the source (`ign-bdtopo`, `osm-bulk`,
`ban`, `boundary`, `business`), not the canonical kind. Parsing it for kinds yields zero
`building`, `road`, `water`, `address` or `poi` features, which is why the first run of this
script reported 1 to 2 "kinds" per cell. The tile manifest is therefore used only for tile
geometry and declared counts.

The distribution is measured from features that actually carry a canonical kind:

1. every `.mmt` render tile is decoded (MMT1 header + `featureMeta` section) and its
   `FeatureMeta` entries give `{ s: stableId, k: kind, a: [x, z] }`; each entry is binned by its
   anchor into a grid cell (`kindDistributionSource: "render-tiles"`);
2. `data/intermediate/*.json` is streamed with a byte-level top-level-object scanner that
   extracts `stableId`, `kind`, `lon`, `lat`, `x`, `z` without materialising 1.0 GiB of JSON.
   The 10 non-feature sidecar files (`provenance.json`, `bdtopo-manifest.json`,
   `osm-bulk-manifest.json`, `normalization-issues.json`, ...) are excluded by name.

Both feeds are merged into `Map<stableId, kind>` per cell, so a feature present in both is
counted once. `inputs.kindDistributionSource` records which feed was used.

`renderTilesWithoutDeclaration` and per-cell `renderTilesOnDisk` resolve render ids through
`baseTileId` (`l0_63_27_s1_1_1` -> `l0_63_27`): the declared `tile-manifest.json` is the pre-wave2
dataset (it still has `_s1_1_1` subdivision ids and was written 27 Aug), while the render
directory is being written by the current rebuild with plain `l0_<col>_<row>` ids.

## 2. Measured result on the live tree

Dataset `0.1.0`. Render-tile census at the start of the first run: **91 `.mmt` files**.
Render-tile census at the end of the run: **3009 `.mmt` files** (6018 directory entries
including `.mmt.gz`): LOD0 2087, LOD1 738, LOD2 183, plus `boundary.mmt`. The rebuild is still
running under the lead, so the render-tile counts move between runs. The department-cell
verdicts and the per-kind totals below are stable across every run.

Declared: 9591 tiles (LOD0 7941, LOD1 1254, LOD2 396), 1 357 773 declared feature ids,
`tile-manifest.json` 152 616 541 bytes.
Canonical: address 115 379, boundary 1, building 305 761, business 611, poi 34 618,
road 182 254, water 52 716, landuse 0, place 0, structure 0, transport 0.

Grid: 8x8, cellSize 17 098.6429 m, origin `[-70231.93, -42730.09]`,
department bbox `[-70231.93, -42730.09, 49458.57, 42748.01]`, **32 of 64 cells intersect the
department** (8 rows x 5 columns, row indices 0 to 4, column indices 0 to 6).

LOD0 payload from disk, measured on all 2087 LOD0 `.mmt` files present at the end of the run
(87 656 807 bytes of LOD0 payload, 330 274 098 bytes across all LODs):

| p0 | p25 | p50 | p75 | p90 | p95 | p99 | p100 | mean |
|---|---|---|---|---|---|---|---|---|
| 160 | 10 339.5 | 18 266 | 32 550.5 | 115 107 | 202 376.8 | 343 989.34 | 431 383 | 42 001.34 |

Cells with a kind, out of 32 intersecting cells:

| kind | canonical | searchable | ratio | cells with the kind |
|---|---|---|---|---|
| address | 115 379 | 115 378 | 1.0000 | 32 |
| boundary | 1 | 0 | 0.0000 | 2 |
| building | 305 761 | 0 | 0.0000 | 32 |
| business | 611 | 611 | 1.0000 | 30 |
| landuse | 0 | 0 | 0.0000 | 0 |
| place | 0 | 0 | 0.0000 | 0 |
| poi | 34 618 | 34 618 | 1.0000 | 32 |
| road | 182 254 | 85 900 | 0.4713 | 32 |
| structure | 0 | 0 | 0.0000 | 0 |
| transport | 0 | 0 | 0.0000 | 0 |
| water | 52 716 | 18 322 | 0.3476 | 32 |

This is the substantive answer to "is coverage concentrated in Auch": for the six kinds the
dataset actually carries, address / building / poi / road / water are present in **all 32**
intersecting cells and business in 30. The concentration claim is false on the current data.
`business` is absent from 2 cells, both of which are corner cells with 1 and 4 department
sample points out of 64.

## 3. Verdict rules and the exact failures

Rules (all evaluated in `computeVerdicts`, `scripts/data/qa-coverage-report.ts:358`):

1. any grid cell that intersects the department has zero tiles on disk -> fail;
2. any adopted kind (boundary, building, road, water, landuse, poi, transport, place, address,
   business, structure) absent dataset-wide -> fail;
3. any kind with a searchability ratio of exactly 0 and a non-zero canonical count -> fail.

Per-cell counts are written even when the run passes, so the report proves distribution rather
than asserting it. Exit code is 1 when `verdicts.passed` is false.

Failures on the current data (6, unchanged across the two runs):

```
FAIL adopted kind "landuse" is absent dataset-wide (0 canonical features)
FAIL adopted kind "transport" is absent dataset-wide (0 canonical features)
FAIL adopted kind "place" is absent dataset-wide (0 canonical features)
FAIL adopted kind "structure" is absent dataset-wide (0 canonical features)
FAIL kind "boundary" has a searchability ratio of 0 (0 of 1 canonical features searchable)
FAIL kind "building" has a searchability ratio of 0 (0 of 305761 canonical features searchable)
```

The 32-cell "no tiles on disk" failure from the first run (91 render tiles on disk) is gone as
the rebuild progressed: 1047 render tiles now fall inside the 32 department cells and every one
of the 32 has at least one, so rule 1 passes. That is a partial pass, not a complete one:
5854 of 7941 declared LOD0 tiles are still missing, so the counts above are lower bounds that
will rise as the rebuild lands. The 6 remaining failures are dataset gaps, not report gaps:

- `landuse`, `place`, `structure`, `transport` are 0 in `data/manifests/coverage.json`
  (acquisition 27 Aug) and 0 in `data/intermediate`, so the pre-wave2 normalisation never
  emitted them. `reports/wave2/CONTRACTS.md` section 1 declares all four as adopted kinds, so
  this is a real pipeline gap.
- `building` searchability ratio 0: `build-search-index.ts:117` derives a name via
  `featureName()`, and buildings have no `name`, no `businessName` and no address fields, so
  0 of 305 761 buildings reach `data/search/index.json`. Buildings are meant to be reached by
  address, so this is a policy question, not a data loss; the rule is applied as specified.
- `boundary` ratio 0: one feature, no name, excluded by the same name rule. The department
  boundary is rendered from `data/generated/render/boundary.mmt` (present) and is not a
  searchable target.

The partial-dataset caveat from the first run is stated here rather than hidden: with 91 of
9591 declared tiles on disk, rule 1 failed for all 32 intersecting cells. That was the honest
state of the tree at the time, not a defect in the script.

## 4. Unit tests

`tests/unit/qa-coverage-report.test.ts`, 32 tests, all green:

- grid assignment: cell index from point, edges taken at the lower bound, points outside the
  grid clamped into the first and last cell, 64 distinct indices and labels, cell bounds
  containing their own centre, `gridCellSize` including the degenerate bbox, `baseTileId`
  subdivision stripping;
- department flags: a square polygon over a 16-cell region marks exactly those 16 cells, the
  centre cell has 64 sample points, a corner cell has 0, and the derived department bbox
  brackets the polygon;
- percentiles: known 4-element series, empty sample, order insensitivity, fraction clamping;
- verdict rules: pass case, failing cell, non-department cell ignored, each absent kind
  reported, zero-ratio kind reported, a kind absent from the dataset not also called
  unsearchable;
- missing reasons: `tile-absent` when the cell has no render tile, `no-tiles-declared` for an
  undeclared cell, `kind-absent-in-distributed-features` when tiles exist;
- render tile decoding: a hand-built MMT1 buffer decodes tile id, bounds and both entries;
  a non-MMT1 buffer returns null;
- streaming: search index per kind, missing search index tolerated, canonical records read
  across files with escaped quotes and no coordinates, truncated file counted as malformed,
  non-feature sidecars ignored;
- end to end on a synthetic dataset built in a temp dir: cells come only from department
  cells, canonical records are read, searchability ratio is computed;
- the artefact itself: `data/qa/coverage-report.json` parses and carries `grid`, `kinds`,
  `cells`, `lod0Payload`, `searchability` and a boolean `verdicts.passed`.

Two real bugs were caught by these tests and fixed in the script:

1. the canonical-record scanner appended only the text after a closing quote, so every string
   value was empty and every canonical record decoded as `{ id: "", kind: "" }`. The scanner
   now tracks `inString` / `escaped` explicitly and never resets the partial object on a comma
   inside a string;
2. the grid cell size was hardcoded to 4096 m, which put only 8 of 64 cells over the
   department. It is now derived from the department bbox.

A third defect was found while reading the output rather than by a test: `renderFileBytes`
parsed the payload size out of the file name (returning 3 to 10 bytes for a 1.2 MB tile). The
size is now the `stat`/read size of the `.mmt` file.

## 5. Known limits

- `tile-manifest.json` is fully parsed (152 MB, ~3 s of the 43 s run). A streaming reader is
  the next optimisation if this becomes a `refresh.ts` gate.
- The distribution depends on `data/intermediate`, which is the pre-rebuild canonical set
  (691 340 records, 39 files, 1 012 368 418 bytes, 0 malformed). If the rebuild replaces it,
  the numbers move; the report records `inputs.canonicalFiles` and
  `inputs.canonicalRecordsRead` so a run can be compared with its inputs.
- The grid is square in metres. The Gers bbox is 119 690 m east-west by 85 478 m north-south,
  so the 8x8 grid wastes the top three rows. `cells[]` reports only the 32 intersecting
  cells, so the report is unaffected.
- Not wired into `package.json`; `npm run data:qa` still runs `qa-spatial.ts` and
  `refresh.ts` does not call this script. Wiring belongs to the lead.
