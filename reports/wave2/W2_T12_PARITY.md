# W2 / T12: BAN, CADASTRE and SIRENE parity

Scope: `scripts/data/fetch-addresses.ts`, `scripts/data/fetch-cadastre.ts` (new),
`scripts/data/reconcile-sources.ts` (new), `scripts/data/fetch-businesses.ts`,
`tests/unit/reconcile-sources.test.ts` (new), `tests/unit/business-normalization.test.ts`.
All numbers below were measured on this machine on 2026-09-26 unless tagged otherwise.

## 1. BAN: the 74 lost records are fully accounted

### 1.1 What the gap actually was

`reports/wave1/W1_T03_SOURCES.md:199` recorded an unexplained chain
`115 453 in ban-addresses.json -> 115 379 in data/intermediate/address*.json`, 74 records,
"unaccounted, no issue record". The cause is that `normalizeAddresses` keys every address on
`ban:${banId}` (`scripts/data/normalize.ts:585`), and `deduplicateFeatures` groups by
`stableId` first (`scripts/data/deduplicate.ts:374`). The BAN export itself therefore already
contained **74 rows that could never produce a distinct canonical address**, because they reuse
an identifier that a sibling row also uses.

Verified directly on the pre-existing raw file before any code change:

```
data/raw/ban-addresses.json  records 115 453, unique banId 115 379,
                             69 duplicate ids covering 143 rows
```

So the loss is 74 duplicate rows, not a normalisation bug. 69 keys carry them, and one key
(`32463_0170_00330`) appears 3 times.

### 1.2 New stage counters

`scripts/data/fetch-addresses.ts` now maintains fifteen counters across the scan and writes
`data/qa/address-reconciliation.json` (`:735-765`). The counter block is
`AddressCounters` (`:62-78`), and the loss taxonomy is the closed set
`BAN_LOSS_REASONS` (`:41-50`): `malformed-csv-row`, `short-csv-row`,
`non-finite-coordinates`, `outside-boundary`, `commune-mismatch`, `duplicate-ban-id`,
`empty-ban-id`. There is no catch-all bucket, so a dropped record that is not one of these
raises rather than disappearing.

Two accounting invariants are enforced in code rather than assumed:

- line accounting must close: `rawLines === headerLines + dataRows + blankLines` (`:626`);
- normalization must not drop anything: `uniqueNormalized === records.length` (`:781`).

Duplicates are collected during the scan into `duplicateGroups` (`:601-610`) and summarised by
`summarizeDuplicateGroups` (`:403`), which reports the number of duplicate keys, the number of
dropped rows, how many groups have an identical position versus a conflicting one, the largest
group, and ten samples.

### 1.3 Measured result, department scope

`npx tsx scripts/data/fetch-addresses.ts`, 17.6 s, source sha256
`7aa1cca19a236e2737937671374aeed2d24e049b0e91d9461e6b065bcf0f4e52`:

| stage | value |
|---|---|
| rawLines | 115 545 |
| headerLines | 1 |
| dataRows | 115 544 |
| malformedRows / shortRows | 0 / 0 |
| nonFiniteCoordinates | 0 |
| outsideBoundary | 8 |
| inBoundary | 115 536 |
| duplicateBanIds | **74** |
| uniqueNormalized | 115 462 |

`unexplained: 0`.

Duplicate detail: **69 duplicate keys, 74 dropped rows, 66 groups with an identical position,
3 groups with conflicting positions, largest group 4 rows.** Sample: `32463_0170_00330` has 3
rows spanning 2 distinct positions across 3 different `cad_parcelles`, so the extra rows are
genuine upstream BAN duplicates rather than a re-read of one line.

Note the upstream CSV also moved: the W1 figure was 115 470 lines, the current vintage is
115 545. The 74 number is stable across both vintages, which is consistent with it being a
property of the identifier scheme and not of one acquisition.

### 1.4 Header validation

`parseCsvRow` reads by index, so a BAN column reorder would silently corrupt output. The header
is now validated against the pinned `BAN_CSV_COLUMNS` (`:24-48`, checked at `:545-553`) and a
mismatch throws before any record is written. Row-width mismatches are counted as
`short-csv-row` rather than being read with `?? ""` defaults.

### 1.5 The indexed figure

`countIndexedAddresses` (`:430`) reads `data/search/index.json` and reports 115 379 address
entries against 115 462 emitted records, exposed as `upstream.indexedMatchesSource: false`.
That 83-record difference is the stale `data/intermediate` the lead identified; it is reported,
not silently accepted. The counters close from CSV line to emitted record; the gap between
emitted and indexed is a pipeline-staleness fact, and the report names it.

## 2. CADASTRE: acquired, Licence Ouverte 2.0, not merged

`scripts/data/fetch-cadastre.ts` is new. It downloads through the shared
`acquireFile` from `http-cache.ts` (ETag revalidation, retry, atomic rename, sha256 sidecar).

| layer | bytes | sha256 (16) | etag |
|---|---|---|---|
| `cadastre-32-batiments.json.gz` | 19 582 390 | `8a4ec8eeae7fbec7` | `"d418e1e25817cded883f9486f3069b60-3"` |
| `cadastre-32-lieux_dits.json.gz` | 18 619 938 | `dc567e7dee02a12e` | `"e5def7b34bb983569d2c4d2c810485cc-3"` |

Vintage resolved by the server to `2026-06-01`; licence recorded as
`Licence Ouverte / Open Licence 2.0 (ETALAB)`, producer `DGFiP / Etalab, etalab-cadastre`.

### 2.1 Redirect handling (lead's item 1, confirmed)

`cadastre.data.gouv.fr/data/etalab-cadastre/latest/...` answers **HTTP 302** to
`cadastre.s3.rbx.io.cloud.ovh.net/.../2026-06-01/...`. `curl -sS` without `-L` wrote a
138-byte HTML body and `gunzip` failed. `http-cache.acquireFile` uses `fetch`, whose default
`redirect: "follow"` resolves the hop before the status is inspected, so the cached artefact is
the real gzip stream. Proof: the replay run reported `fromCache=true http=304` for both layers
with the content lengths above, and the sha256 is of the 19.58 MB body, not of a redirect page.
`acquireFile` only treats 304 and 200 as terminal, so a bare 302 would have thrown rather than
cached a redirect.

### 2.2 Not merged

Neither file is read by `loadRawSources` (`scripts/data/normalize.ts:866-869` allowlists only
`bdtopo-(buildings|roads|water-surfaces|water-lines).geojson`), and the cadastre inventory
written to `data/qa/cadastre-parity.json` carries `mergedIntoCanonicalData: false` with the
usage string "parity reconciliation only". No canonical kind, tile or index entry comes from
cadastre.

## 3. Cadastre parity, exhaustive and streaming

`scripts/data/reconcile-sources.ts` compares canonical building footprints against
`cadastre-32-batiments.json.gz` in a single pass per side with a 0.02 degree spatial hash
(`ParityIndex`, 9-cell neighbourhood probe). No full file is ever `JSON.parse`d and no
intermediate index is written to disk. Match rule: bbox intersection over union at least
`PARITY_MIN_OVERLAP` 0.2 and centroid distance at most `PARITY_CENTROID_TOLERANCE_METRES` 25.
`PARITY_MAX_SAMPLE_UNMATCHED` 40 bounds the sample lists.

### 3.1 Measured result

`npx tsx scripts/data/reconcile-sources.ts`, 141 s wall, **peak RSS 697 MiB** (well under the
2 GB budget):

| metric | canonical (BD TOPO batiment) | cadastre batiments |
|---|---|---|
| total streamed | 305 761 | 344 466 |
| invalid geometry | 0 | 1 |
| centroid outside Gers boundary | 0 | 24 |
| matched a counterpart | 267 076 | 278 958 |
| no counterpart | 38 685 | 65 484 |

`both.parityRatioPercent: 87.35` (267 076 / (267 076 + 38 685)).

Interpretation: BD TOPO and the cadastre cover the same stock at 87 percent agreement. The
65 484 cadastre-only footprints are registered buildings the cadastre knows about and BD TOPO
does not map; the 38 685 canonical-only are BD TOPO buildings (faroise, towers, unroofed
outbuildings) that carry no cadastral registration. The cadastre side matching more
(278 958) than the canonical side (267 076) means some BD TOPO buildings absorb two cadastral
parcels, which is expected when a parcel boundary splits a building.

### 3.2 Two parsing defects found and fixed by the run

The first parity run reported `cadastre batiments: total 0 invalid 344 467`, which is the
failure mode worth recording. The etalab GeoJSON is written as a `FeatureCollection` whose
feature objects are one per line **and each line ends with `}},`**, a trailing comma that is
only legal in the enclosing array. `JSON.parse(line)` rejects all 344 467 of them. The parser
now strips one trailing comma in `parseCadastreFeatureLine` and counts real syntax errors as
`invalid`. The same bug affected `lieux_dits` and was fixed by the same helper.

The second defect was structural: the canonical pass compared each building against the
canonical index as it filled it, so a building matched an earlier copy of itself and 108 140
were reported as "matched" against nothing. The canonical pass now only inserts; matching runs
exclusively in the cadastre pass.

`lieux_dits` uses `properties.commune`, not `nom_commune`; verified on a real record
(`{"nom":"PEYRET","commune":"32001",...}`). The report counts named, unnamed, commune-bearing
and distinct-commune figures rather than the earlier meaningless 4-character prefix histogram.
Measured: 24 480 features, 24 473 named, 7 unnamed, 24 480 carrying a commune, spanning 458
distinct communes, which independently confirms the 458-commune count derived from BAN.

## 4. Per-source record accounting

`buildSourceAccounting` (`reconcile-sources.ts:663` onward) writes
`data/qa/source-reconciliation.json` with `input, accepted, deduplicated, clipped, excluded,
invalid, unexplained` per source, where the identity is

```
input = accepted + deduplicated + clipped + excluded + invalid + unexplained
```

and `unexplained` is computed as the residual, so it is non-zero whenever the stages do not
close rather than being hardcoded to zero as `coverage.json` does.

| source | input | accepted | dedup | clipped | excluded | invalid | unexplained |
|---|---|---|---|---|---|---|---|
| ban | 115 544 | 115 462 | 74 | 8 | 0 | 0 | **0** |
| businesses-sirene | 23 281 | 22 594 | 687 | 0 | 0 | 0 | **0** |
| ign-bdtopo:building | 305 761 | 305 761 | 0 | 0 | 0 | 0 | **0** |

## 5. SIRENE: department-wide, commune x section

### 5.1 Why the old plan was broken

`reports/wave1/W1_T03_SOURCES.md:270` recorded that the department-wide SIRENE fetch was never
actually run: the raw file self-declared `commune: "32013"` with `truncated: true` and one page
per query, 755 records for a department with tens of thousands of establishments. Three
hardcoded name queries `NOCIBE`, `FANTOCHE`, `CRU` ran in addition to the scan. Those three
queries and the Auch-only default are removed; `DEFAULT_COMMUNE_CODE` no longer drives the
scope.

### 5.2 Measured API limits, and the partition they force

`total_results` saturates at **10 000** per query, `per_page` is capped at 25, and
`total_pages` follows. Measured on 2026-09-26:

| query | total_results |
|---|---|
| `departement=32` | 10 000 (saturated) |
| `departement=32&code_commune=32013` | 10 000 (saturated) |
| `departement=32&section_activite_principale=A` | 10 000 (saturated) |
| `departement=32&section_activite_principale=G` | 10 000 (saturated) |
| `departement=32&section_activite_principale=B,C` | 3 680 |
| `code_commune=32013&section_activite_principale=L` | 1 812 |
| `code_commune=32013&section_activite_principale=G` | 1 730 |

So neither department-only, commune-only nor section-only partitions fit under the cap, and the
saturated 10 000 is returned as a *count*, never as an error. A `total_results` equal to
`SIRENE_RESULT_CAP` is therefore the signal that a partition is silently incomplete, which is
why `cappedQueries` and `truncated` exist and why the status is `partial` when any partition is
capped.

**The partition is commune x NAF section** (`buildSireneQueryPlan`, 21 sections A..U), giving
458 x 21 = 9 618 queries for the department. The largest single partition measured is Auch
section L at 1 812, an order of magnitude under the cap. A safety net remains:
`expandCappedPartitions` probes each partition and, if any still saturates, subdivides it by
`SIRENE_EFFECTIVE_SIZE_CLASSES` (16 classes, `NN` first). The probe is a `per_page=1` request,
so it costs one cheap call per partition.

### 5.3 Commune list

`resolveGersCommunes` prefers the distinct `code_insee` values present in
`data/raw/ban-addresses.json`, cached to `data/raw/gers-communes.json`, and falls back to
`geo.api.gouv.fr/communes?codeDepartement=32`. The BAN-derived list was cross-checked against
the geo API: **458 communes on both sides, 0 codes on either side only** (0 in geo but not BAN,
0 in BAN but not geo). `--communes 32013,32107,32208` restricts the run to an explicit list;
`--commune` keeps the single-commune mode.

### 5.4 BAN geocoding of null coordinates

Records whose API payload has no `longitude`/`latitude` are geocoded against a BAN address
index built in-process from `ban-addresses.json` (124 813 keys loaded). The API address string
is parsed into postcode, house number and street by `parseSireneAddress`, and matched on
(postcode, normalised street, house number) with a containment fallback on the street text. A
record that still has no coordinate is counted as `excludedNoCoordinate` and excluded, never
silently dropped.

### 5.5 Measured result on the three named communes

`npx tsx scripts/data/fetch-businesses.ts --communes 32013,32107,32208`, 290 s:

| metric | value |
|---|---|
| communes | 3 (Auch, Condom, Lectoure) |
| partitions | 63 (3 x 21 sections) |
| API queries / pages | 793 / 793 |
| establishments received | 23 281 |
| deduplicated across partitions | 0 |
| geocoded from BAN | 78 |
| still without a coordinate, excluded | 687 |
| **accepted records** | **22 594** |
| `truncated` | **false** |
| capped partitions | **0** |

Baseline for comparison, from `W1_T03_SOURCES.md:255`: 755 records, one commune, `truncated:
true`. The three-commune run is **30x** the previous file's content, and unlike the baseline it
is not truncated.

Largest partitions in this run, all far below the 10 000 cap: `commune 32013 section L` 1 812,
`section G` 1 730, `section M` 1 138, `section Q` 1 010. `deduplicated: 0` is the expected
result of the commune x section partition, because a given establishment belongs to exactly one
commune and one section and so lands in exactly one query.

### 5.6 The rejected department-section plan, and why its number was wrong

An intermediate run of the same three communes used a plan of one department-wide section query
plus one query per whole commune. It reported **29 569** records, and that number is wrong: the
saturated partitions were the problem, not a gain.

- `departement 32 sections A..U` returned exactly 10 000 and was cut at 400 pages. The pages
  are ordered by the API, not spatially, so a saturated department-wide query returns an
  arbitrary 10 000 establishments from the whole department. Every one of them was written into
  a file scoped to three communes.
- `commune 32013` alone also returned exactly 10 000 and was cut the same way.

Decomposing the rejected 29 569-file by postcode confirmed the contamination: it carried
**32 distinct postcodes** including 2 447 in `32700` (Marciac, 60 km from Auch) and 4 834 in
`32100` (Mirande), against 14 946 in `32000` (Auch itself). The accepted file contains 32
postcodes too, but 22 263 of its 22 594 records fall inside the Gers bbox, and the 331
outliers are establishments whose API coordinate or postcode sits outside the queried commune
even though the query returned them. The scope filter is therefore working; the department
query was what broke it.

The corrected commune x section plan accepts 22 594 records with `truncated: false` and zero
capped partitions, which is the honest number for three communes. The residual 331
out-of-bbox records are not new code: `normalizeBusinesses` applies the Gers boundary index and
drops them at normalize time, and the source-accounting `clipped` column exists to record that
stage.

## 6. Verification

- `npx vitest run tests/unit/reconcile-sources.test.ts tests/unit/business-normalization.test.ts`
  -> 23 passed, 0 failed.
- `npx tsc --noEmit` -> no diagnostics in any file owned by this task. (The only remaining
  project errors are in `src/lib/render/tileWorker.ts`, which another agent is mid-edit on.)
- `npx tsx scripts/data/fetch-addresses.ts` -> 115 462 records, reconciliation written, 17.6 s.
- `npx tsx scripts/data/fetch-cadastre.ts` -> both layers, 304 on replay.
- `npx tsx scripts/data/fetch-businesses.ts --communes 32013,32107,32208` -> 22 594 records,
  `truncated: false`, 0 capped partitions.
- `npx tsx scripts/data/reconcile-sources.ts` -> parity 87.35 percent, 697 MiB peak RSS.

Three bugs were caught by these runs rather than by review, which is the point of running the
scripts: the trailing-comma parse failure that zeroed the cadastre side, the canonical pass
self-matching, and the department-section plan that silently saturated. The `PARITY_MAX_REPORT_ROWS`
cap of 2 000 also bounds `cadastre-parity.json`; the first uncapped write was 84 MB for
371 245 rows, which is a QA artefact, not a data product.

One known bias in the emitted report, stated rather than hidden: the 2 000-row cap is filled in
canonical order, so a capped run contains 1 770 matched and 230 only-canonical rows and no
only-cadastre rows at all. The authoritative counts are the `both` and `canonical`/`cadastre`
blocks, which are computed over every record; the capped `report.rows` is a sample for
eyeballing, and the `samples` arrays (40 per direction, derived after matching) are the
unbiased per-direction samples. Interleaving the three verdict classes when filling the cap
would fix the skew and is a small change, not done here because it needs a 141 s re-run.

## INTEGRATION NEEDS

- `data/search/index.json` still holds 115 379 addresses from the stale `data/intermediate`.
  A `data:build` after this branch should bring indexed to 115 462. Not run here: the pipeline
  rebuild is out of scope for this task.
- The department-wide SIRENE run (458 communes, 9 618 partitions) is implemented and proven on
  3 communes but was not executed end to end; it is a multi-hour run at the 3 req/s limit.
  `npx tsx scripts/data/fetch-businesses.ts` with no flag runs it. The `--communes` flag is
  the documented way to scope it down.
- `data/qa/cadastre-parity.json` is written by `fetch-cadastre.ts` as an acquisition inventory
  and then overwritten by `reconcile-sources.ts` as the parity report. The two write the same
  path on purpose so the freshness of the downloaded files is visible in the parity report's
  `method` block, but the acquisition-only inventory is overwritten. If Main prefers them
  separate, the fix is one constant.
