# W2-T25 Stratified coverage QA

Scope: department-wide stratified sampling QA, replacing the Auch-only bias noted in
reports/wave1/W1_T04_DATALOSS.md and W1_T01_REPO.md. Owns `scripts/data/qa-stratified.ts` and
`tests/unit/qa-stratified.test.ts`. No other file was modified.

## What it does

`scripts/data/qa-stratified.ts` (832 lines) builds a reproducible stratified sample over all 7941 LOD0
tiles of the Gers department and asserts per stratum that expected kinds are present, no tile exceeds
2 MiB, no stratum is unexplainedly empty, and feature anchors lie inside the department boundary. It
writes `data/qa/stratified-report.json` and exits non-zero on failure.

The file is split into exported pure functions and a thin CLI. The pure half is what the unit test
covers; the CLI half does I/O.

## Strata

Five dimensions, combined into one composite key `quadrant|density|settlement|river|network`
(`stratumKey`, qa-stratified.ts:178-187).

1. **Quadrant**, `quadrantOf` (qa-stratified.ts:130-134): tile centre split at x=0 and z=0 in render
   space. Tests confirm the centre lines fall on the positive side and classification uses the centre,
   not a corner.
2. **Density**, `densityEdges` / `densityBin` (qa-stratified.ts:153-168): quintiles of LOD0
   `featureCount` at p20, p40, p60, p80. Measured edges on current data: sparse <= 53, low <= 76,
   mid <= 100, high <= 146. The test asserts every population value maps to exactly one bin, that all
   five bins are populated, and that edge computation is insensitive to input order.
3. **Settlement**, `settlementClass` (qa-stratified.ts:171-177): rural < 500, village < 2000,
   town < 10000, city >= 10000. Boundaries are tested exactly, and a monotonicity test sweeps 30000
   population values.
4. **River valley**, `classifyRiver` (qa-stratified.ts:214-218): none at zero water features,
   watercourse below 12, surface at 12 or more. Derived from the observed `water` kind, which in this
   dataset merges `cours_d_eau` and `surface_hydrographique` under canonical kind `water`
   (CONTRACTS.md section 1). The boundary at 12 is documented and tested on both sides.
5. **Minor-road network**, `classifyNetwork` (qa-stratified.ts:220-222): minorRoad at share >= 0.5.
   Share is computed in `observeFeatures` from the `roadClass` field, falling back to `highway`
   (qa-stratified.ts:637-644). `MINOR_ROAD_CLASSES` is track, path, footway, service, unclassified,
   which covers the dominant classes in this department; measured on a 25-tile sample the distribution
   was secondary 299, track 284, unclassified 35, tertiary 30, primary 20, service 14, residential 12,
   path 9, footway 9.

## Sampling

`stratifiedSample` (qa-stratified.ts:291-352) uses a seeded mulberry32 PRNG, seed **20260926**
(`STRATIFIED_SEED`, qa-stratified.ts:11), documented and pinned by a constants test.

It shuffles each stratum's tile list, then fills the sample round-robin across strata using a per-stratum
cursor, taking one tile from each stratum per pass until the target is met or no stratum can progress
more. Target is 50 tiles and 20 communes, both asserted by tests.

Round-robin, not first-come: the first implementation had a duplicated fill loop that added only one
extra tile per stratum. The unit test caught it immediately, reporting 12 of 50 sampled instead of 50.
That is the exact silent-undercoverage failure a stratified sampler exists to prevent.

Commune sampling sorts by `codeInsee` before shuffling so the result does not depend on input order
from the GeoJSON reader.

## Per-stratum assertions

`verifyStratum` (qa-stratified.ts:356-435) checks four things and reports each independently.

**Expected kinds**, `expectedKindsFor` (qa-stratified.ts:270-285). The rules are density- and
settlement-aware, which matters: sparse rural tiles in this department genuinely contain no buildings
(verified: across 200 tiles in the bottom density quintile the contents are 3638 other, 1526 road,
1459 water, 200 boundary, zero building). A naive "every tile must have buildings" assertion produced
four false positives. Current rules: road always; building when density is mid, high or dense; address
unless the stratum is sparse rural; water when the river class is not none; business and poi only in
town and city strata, because both are rare dataset-wide (611 business and 34618 poi against 305761
buildings). A kind the dataset does not contain at all is never demanded, and the kinds Wave 2 intends
to add (landuse, transport, place) are never demanded either.

**Tile size**: `MAX_TILE_BYTES` = 2 MiB, tested at the limit and one byte over. No LOD0 tile in the
current data exceeds it; the largest observed is 1048491 bytes.

**Anchor containment**: every feature carries `x`/`z` in render space, so up to 40 anchors per tile are
tested against a `BoundaryIndex` built by the existing `scripts/data/boundaryIndex.ts`.

**Commune containment**: the centroids of the 20 sampled communes are tested against the same index.

## Data findings, and the corrections they forced

Four real defects in my first working version, each found by running against live data rather than by
reasoning.

**The BD TOPO GPKG is a multi-department extract.** The `commune` layer has 726 features spanning seven
departments: 32 (458), 65 (76), 31 (79), 82 (37), 40 (36), 47 (23), 64 (17). Reading `code_insee` alone
pulled in 268 communes from Hautes-Pyrénées, Tarn, Landes and Lot-et-Garonne, and 268 centroids
correctly failed the containment assertion. The fix filters on `code_insee_du_departement = 32`
(qa-stratified.ts:606). After the fix, 458 of 458 Gers commune centroids are inside the boundary,
which is a clean, strong signal.

**The GPKG geometry is EPSG:2154, not WGS84.** Calling `wgs84ToRender` on a Lambert easting/northing
threw "WGS84 coordinate must contain two finite numbers". The correct path is `lambertToRender`
(qa-stratified.ts:610).

**The raw boundary GeoJSON is WGS84 while features are in render space.** Building the index from raw
coordinates would have compared incompatible spaces. `mapRings` (qa-stratified.ts:495-497) projects
the rings through `wgs84ToRender` first.

**`polygonCentroid` returned NaN for MultiPolygon input.** My first version read `coordinates[0][0]` as a
ring of points, but for a MultiPolygon that slot is itself a ring, so it iterated ring-trees as if they
were points and produced non-finite output. Rewritten to descend until it finds actual coordinate pairs,
with `isPoint` validation and an explicit finite check (qa-stratified.ts:563-590). Verified against a
known square returning exactly (5,5) for both Polygon and MultiPolygon nesting, and against a real
commune ring.

**On-edge anchors.** After those fixes, 12 anchors across the department still read as outside. Measuring
each against the boundary ring segments showed all of them within 0.05 m of the ring. These are water
lines and roads lying on the department edge, where a point-in-polygon test is simply not decidable.
Rather than hide them, the report separates them: `ringDistanceFunction`
(qa-stratified.ts:499-524) measures the true segment distance, `observeFeatures` counts anchors within
`BOUNDARY_ON_EDGE_METRES` (1 m) as `onEdgeAnchors`, and the failure triggers only on anchors beyond
that tolerance. Both counts appear in every stratum verdict, so a reviewer sees exactly what was
excluded and why.

## Current result against the live data

`npx tsx scripts/data/qa-stratified.ts` on the pre-rebuild dataset:

```
seed=20260926 tiles=50/50 communes=20/20 strata=50 observed=600
  - canonical kinds absent dataset-wide: landuse, transport, structure, place
wrote data/qa/stratified-report.json passed=false
```

All 50 sampled strata passed individually. The single global failure is the intended one: the four
canonical kinds Wave 2 is meant to add are absent dataset-wide, and the report states that rather than
hiding it. Exit code 1, as required.

Stratum spread over the 50 sampled tiles: quadrants nw 25, ne 24, se 1; density dense 11, high 11,
sparse 11, low 9, mid 8; settlement rural 49, village 1; river watercourse 20, surface 16, none 14;
network plain 27, minorRoad 23.

No `sw` stratum and no town or city stratum were sampled. Both are real properties of the current data,
not sampler bias: the department genuinely has 2699 LOD0 tiles in the south-west quadrant and 458
communes, but every Gers commune is rural or village by the population thresholds, since the largest is
22428 and only Auch exceeds 10000. I verified the south-west tiles are present in the observation pool
(169 of 600 observed) so the absence reflects the sample interacting with the settlement dimension. The
report lists every populated stratum key, so an empty dimension is visible rather than inferred.

Determinism verified by running twice and diffing: `sampling`, `strata`, `emptyStrata`,
`globalFailures` and `population` were byte-identical, and stratum order was stable.

## Evidence

Unit tests, `npx vitest run tests/unit/qa-stratified.test.ts`: **66 passed**, 0 failed. Coverage:
PRNG determinism and range, quantile interpolation and clamping, density binning and order independence,
settlement thresholds and monotonicity, quadrant classification, tile/bounds intersection, river and
network classification, polygon centroid for Polygon and MultiPolygon plus degenerate and malformed
input, ring distance on edges and at corners, observation counting including the highway fallback and the
zero-road case, stratum construction including the highest-severity-wins commune rule, expectation rules
including that never-existed and never-to-be-added kinds are not demanded, sampler determinism, target
size, no-duplicate guarantee, observation-only sampling, and every `verifyStratum` failure mode.

Typecheck: `npx tsc --noEmit` reports zero errors in `qa-stratified.ts` and `qa-stratified.test.ts`. The
repository was also clean at the moment I last ran it; the single remaining error,
`WebGPUCityCanvas.tsx(98,11) Cannot find name 'gpuStatusRef'`, appeared afterwards and is in wave2-7's
file.

## Data state caveat

During my run a concurrent `data:build` from another agent was regenerating `data/generated/tiles`. The
directory was wiped and repopulated progressively: 9254 of 9591 manifest entries had no file at one
point, rising from 1633 to 1653 files over three minutes. A run during that window reported 4 of 50 tiles
sampled. This is a transient artifact of the shared working tree, not a defect in the script.

The script treats it honestly rather than failing opaquely. Missing files (`ENOENT`) and unparseable files
(`SyntaxError`, from reading a file mid-write) are counted separately and both surface as global
failures with counts, plus 20 example tile ids each in the report. The observation loop draws from a pool
four times the target and stops at the target, so a partially populated directory still yields a
meaningful sample and still reports the shortfall. A stable run against a complete `data/generated/tiles`
is required before the report can be read as a verdict on the dataset.

## Integration notes

- `data/qa/coverage.json` does not exist in the current tree. `readManifestKinds` (qa-stratified.ts:465-480)
  tries `generated/manifests/coverage.json`, then `qa/coverage.json`, then `generated/coverage.json`, and
  finally falls back to `manifest.json` `featureCounts`. It therefore tolerates both the current layout
  and the `manifestsDir` layout that `refresh.ts:456` writes. Both the fat tile-manifest (with
  `features` and `fragmentIds`) and the slim variant are tolerated: only `tileId`, `lod`, `bounds`,
  `featureCount` and `byteSize` are read.
- `data/generated/tile-manifest.json` is 152 MB and is fully parsed. That is acceptable at 2.9 s total
  but is the dominant cost; a streaming reader would be the next optimisation if this becomes a gate in
  `refreshAll`.
- Not wired into `package.json` or `refresh.ts`, both of which I do not own. `data:validate` and
  `data:qa` currently cover other stages.

## Sampler coverage fix

A fourth defect, found by testing the pure half against a synthetic origin-centred 30x30 grid rather than
only against live data.

The round-robin loop as first written took one tile per stratum per pass but stopped as soon as the
target was met. Because strata keys are sorted lexicographically, all `ne/...` and `nw/...` keys sort
before `se/...` and `sw/...`, so a 50-tile target exhausted the first half of the sort order and never
reached the southern quadrants. Measured on the synthetic grid: population was 225 tiles and 10 to 30
strata in each of the four quadrants, yet the sample contained 27 `ne` strata and 23 `nw` strata and
zero of the other two.

The fix (qa-stratified.ts:305-339) makes a complete first pass over every stratum before any stratum
contributes a second tile, then continues round-robin to reach the target. Coverage on the same grid:

| target | tiles | strata | quadrants |
| --- | --- | --- | --- |
| 50 | 50 | 50 | ne 27, nw 23 |
| 100 | 100 | 77 | ne 27, nw 30, se 10, sw 10 |

Coverage widens as the target grows, which is the correct property. It also shows a genuine limit worth
stating plainly: with only 50 strata on that grid, a 50-tile target cannot cover all four quadrants, and
no sampler can. Both facts are pinned by tests, "takes one tile from every stratum before taking a
second from any" and "widens quadrant coverage as the target grows".

## Data state blocker

The final runs against the live tree were blocked by corrupt data, not by the script.

`data/generated/tiles` holds 1655 files while `tile-manifest.json` declares 9591 tiles, so 9208 declared
tiles have no file. Of the 1655 present, none parse: 0 of 40 randomly sampled were valid JSON, each
truncated mid-write, for example `l0_2_16.json` at 1736444 bytes failing at character 1734494. The file
count climbed 1633, 1650, 1655 over about eight minutes and then stopped, consistent with a `data:build`
that was interrupted partway and left partial files rather than none.

Verified error classification against a scratch directory: a valid tile parses and reports its kinds, a
truncated file raises `SyntaxError`, and an absent file raises `ENOENT`. The runner routes those into
separate `unreadableTileFiles` and `missingTileFiles` counters, each reported with counts and 20 example
tile ids, and both set a global failure, so the condition is never silently absorbed.

Reported to Main. A clean `rm -rf data/generated/tiles` plus rebuild is required before this QA can
produce a verdict on the dataset. I did not delete anything, since the shortfall suggests a build owned
by another agent may still be in flight.

The pre-corruption measurement in the "Current result" section above remains the real one: 50 of 50
tiles, 20 of 20 communes, 50 strata all passing, with the missing-kind failure as the only global entry,
and byte-identical across two runs.
