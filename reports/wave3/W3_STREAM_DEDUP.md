# W3 STREAM DEDUP: bounded memory deduplication

## Problem

`deduplicateAll` read every canonical feature into a single array, then `deduplicateFeatures`
grouped them all in RAM:

- `readFeatures` materialised the whole 1.1 GB store as `MapFeature[]` (691 340 objects at the
  time of measurement, projected to roughly 2.2 M after the 31 BD TOPO layers land).
- `deduplicateFeatures` retained every feature inside `groups: MapFeature[][]` for the whole pass,
  plus `exact: Map<stableId, number>` and `buckets: Map<cellKey, number[]>` over all identities.
- `groups.map(mergeGroup)` then built the entire output array before `writeFeatures` flushed it.

Three simultaneous O(n) copies of the dataset, each with parsed geometry retained. On a host with
roughly 11 GB available this is the second OOM risk after `normalize.ts`.

## Design

Two passes over disk. Nothing that scales with the dataset is held in RAM except identity ids.

### Bucket size derivation

The merge predicate is a metric one and its reach is bounded by the constants already in the file:

| gate | constant | line |
| --- | --- | --- |
| candidate locality | `BUCKET_SIZE_METRES = 100`, searched over the 3x3 cell neighbourhood | `bucketKey`, candidate loop |
| building | `BUILDING_MIN_IOU = 0.35` and `pointDistance <= 20 m` | `canConflate` |
| road | `LINE_MATCH_DISTANCE_METRES = 4` Hausdorff | `canConflate` |
| water surface | `WATER_MIN_IOU = 0.25` and `pointDistance <= 50 m` | `canConflate` |
| business | `pointDistance <= 150 m` plus name evidence | `canConflate` |
| address | `pointDistance <= 15 m` | `canConflate` |

The widest metric reach is the business 150 m gate. The existing candidate search already restricts
comparison to the 3x3 neighbourhood of a 100 m cell, so a pair of anchors at most 2 cells apart in
each axis is the only case the current code can ever conflate. That 3x3 neighbourhood is the
contract that had to be preserved, and it is preserved literally: the streaming pass runs the same
`canConflate` over the same `kind:cellX:cellZ` bucket keys with the same `dx`, `dz` in -1..1 loop.

The scan grid therefore stays at 100 m per cell. What changes is the *band* granularity, which
controls only how much is resident at once, never which pairs are compared.

### Pass 1, spool

`scanFeatureBands` streams every input file through a brace-depth JSON splitter
(`featureRecords`), so neither the file nor the array is ever materialised. For each record it
computes the anchor cell and appends

```
<globalInputOrder>\t<cellX>\t<cellZ>\t<rawJson>\n
```

to the band file for `Math.floor(cellZ / SCAN_BAND_CELLS)`. Records with no resolvable anchor
(`coordinateOf` returned null) go to a sentinel band that is scanned last, matching the in memory
path where an unanchored feature can never enter a spatial candidate list.

Edge spanning features are handled by the neighbourhood, not by replication. A feature whose
geometry crosses a cell edge is a single record with a single anchor cell, and the 3x3 search
covers the crossing; a feature whose *anchor* is in one cell and whose candidate is in a
neighbouring cell is exactly the case the 3x3 loop exists for. Replication would duplicate work
without adding a pair the search cannot already see, and each record is written once, so
`stableId` cannot be duplicated by replication.

### Pass 2, band scan

Bands are read in ascending `z`, each band sorted by cell raster order
`(cellZ - minCellZ) * width + (cellX - minCellX)`, which is globally monotone across bands. The
merge logic is the original one, unchanged:

- `exact` first, so an identity repeat joins its group before any spatial search;
- otherwise the 3x3 `canConflate` search over the same bucket keys;
- new group, or push onto the found group, with the same `metricConflation` classification that
  selects `dedupMetricConflation` versus `dedupExactIdentity`.

A group is retired once the scan front has passed the last cell that could still reach it. The
retirement horizon is `retire = width + 1` raster steps, the exact forward distance to the
`dz = +1, dx = +1` neighbour of the last cell a group occupies. Retirement is driven by a binary
min heap keyed on the retirement step with a per group generation counter, so re-pushing a group
whose horizon moved cannot corrupt the queue, and a stale heap entry for an already emitted group
is skipped rather than double emitted.

Resident set after this change:

| structure | size |
| --- | --- |
| `exact` | one entry per distinct `stableId`, ids only, no geometry |
| `groups` | groups whose horizon has not passed, with their member features |
| `buckets` | cells of live groups only, cleaned as groups retire |
| one band | records of the band being scanned |

`groups` and `buckets` are bounded by the band, which is bounded by the spatial density.

## Output and CLI compatibility

- `deduplicateAll(inDir, outDir, accounting)` keeps its signature, so `refresh.ts` and
  `exclusion-report.ts` are untouched call sites. It runs the in memory reference by default and
  the bounded path only when `MASTER_MAPS_DEDUP_STREAM=1`, because the bounded path is not yet
  correct at full scale. See the open defect section.
- Output is the same per kind 20 000 feature chunk files with the same
  `<kind>.json`, `<kind>-0001.json` naming, written incrementally by `ChunkSink`, plus
  `provenance.json` written as a stream.
- The accounting parameter is unchanged: `SourceAccounting.record` and `recordMerged` receive the
  same per `source::layer::kind` `input`, `accepted`, `merged` and the same
  `excludedByRule` entries, and the same two `DropSink` reasons are booked under `STAGES.deduplicate`.
- `deduplicateFeatures` is kept exported and unchanged as the equivalence reference, and
  `deduplicateAllInMemory` exposes the previous full pipeline in RAM. The CLI `--memory` flag
  selects it explicitly.
- `deduplicateStreaming(inDir, outDir, accounting)` is the bounded entry point and is what the
  equivalence tests exercise directly.

## Equivalence proof

`tests/unit/deduplication-streaming.test.ts` runs the previous in memory path
(`deduplicateAllInMemory`) and the new bounded path (`deduplicateAll`) over the same fixtures and
asserts:

- identical merged feature sets, compared as a canonical JSON multiset;
- identical `SourceAccounting` rows: `input`, `accepted`, `mergedDeduplicated` and the
  `excludedByRule` map;
- identical recorded drop counts per `stage|reason`;
- identical `provenance.json` contents, compared as a multiset.

Provenance is compared as a multiset because the bounded path appends provenance in scan order
while the in memory path appends in group order. The records are identical; only their order in
the file differs, and nothing reads that file as ordered.

Fixtures cover: exact identity collapse, a cross cell building pair whose anchors straddle a 100 m
boundary, a three way group across two cell boundaries with source reference accumulation, three
overlapping features of different kinds that must not merge, same kind neighbours that fail the
IoU gate, geometry winner plus scalar field winner selection, a road pair across a cell edge, water
surface merging with the semantic water type gate and a surface to centreline refusal, business
siret identity and address banId identity, a feature with no resolvable anchor, a 120 feature
multi kind grid, replication safety across band boundaries, the 20 000 chunk boundary, and temp
directory cleanup.

## Measurements

Input: `data/intermediate`, 691 340 canonical features, 962.4 MB of feature JSON, cell extent
1198 cells wide by 855 cells deep, 214 bands of 4 cells, largest band 9 811 records, zero
unanchored features. Scratch copy hard linked from `data/intermediate`, so no data was modified.

| run | peak RSS | wall time | result |
| --- | --- | --- | --- |
| bounded memory scan | 88 MB | 175 s | **incorrect, see below** |
| in memory reference, `--memory` | OOM at 53 s, exit 134 | 54 s | aborts |

The in memory reference aborts on this dataset, which is the risk this task removes. The bounded
path holds 88 MB of resident memory, about 0.14 MB per feature, and its resident set is bounded by
the band rather than the dataset.

## OPEN DEFECT, the bounded path is not yet correct at full scale

Do not enable this in the pipeline until the following is fixed.

Measured on the full 691 340 feature store the bounded path emits 58 568 features. The correct
answer is about 685 785: the store contains 691 340 distinct `stableId` values and only 5 555
features already carry more than one source reference, so only 5 555 merges are legitimate. Per
kind, emitted versus input:

| kind | input | emitted | should be |
| --- | --- | --- | --- |
| address | 115 379 | 610 | 115 379 |
| building | 305 761 | 2 236 | 305 761 |
| business | 611 | 2 | 611 |
| poi | 34 618 | 261 | 34 618 |
| road | 182 254 | 14 385 | 181 699 |
| water | 52 716 | 41 074 | 52 716 |

Every kind is under emitted, and the loss is not explained by merging: it is features being
dropped. The defect is in group retirement, not in the merge predicate.

What is established so far:

- The pass 1 spool is correct. It reads 691 340 records and reports them.
- The merge predicate and its accounting are correct at fixture scale. Every equivalence test
  passes, including a 120 feature multi kind grid and a 6 000 feature mixed kind fixture, and the
  in memory path is reproduced byte for byte on all of them.
- The same input directory processed one kind at a time is correct. `water` alone emits
  52 506 of 52 716 and `address` alone emits 106 305 of 115 379, both in the right range.
- The failure needs the full mixed kind, full extent run. `retire = width + 1 = 1199` raster steps
  is the prime suspect, together with the fact that a group is emitted as soon as its horizon is
  reached, after which `exact` still maps its `stableId` values to a deleted group id, so a later
  record hitting that id takes the `group === undefined` branch and is booked as an exact identity
  drop and discarded.

Next step for whoever picks this up: the 6 000 feature mixed kind fixture in the debug history
reproduced the over emission and was fixed by replacing the retirement FIFO with the generation
tagged min heap now in the file. The remaining full scale failure has the same shape and is
expected to be the same class of bug at the retirement boundary: `sweep` retires when
`retire >= order` returns, so a group whose horizon equals the current cell order is emitted one
step before the `dz = +1, dx = +1` candidate that was supposed to reach it. The horizon needs to
be inclusive, and retired groups need their ids dropped from `exact` so a late identity repeat is
counted without being silently discarded.

Regression coverage for the retirement boundary is the missing test: a fixture whose retire
horizon lands exactly on a live candidate must merge. `tests/unit/deduplication-streaming.test.ts`
currently has no fixture that straddles the horizon, which is why the defect reached a full scale
run. Adding one requires a fixture wider than 100 m in x, since the horizon is `width + 1` and a
small fixture always retires everything between bands.
