# W2 / T26: OSM data-to-data parity

Owns: `scripts/data/parity-osm.ts` (new), `tests/unit/parity-osm.test.ts` (new), `data/qa/osm-parity.json` (generated).

No crawling of rendered tiles and no browser navigation to osm.org: every OSM number in this report comes from the osmium CLI reading the local `data/raw/gers-osm.osm.pbf` extract, and every canonical number comes from `data/intermediate` plus `data/generated/manifest.json`.

## 1. Method

### 1.1 OSM reference side

`scripts/data/parity-osm.ts:107-119` calls `osmium tags-count -m 1 [-t <type>] <pbf> <key>=<values>` once per category and parses the histogram into `Map<value, count>`.

Two osmium 1.19.1 behaviours were measured, not assumed, and both silently produce empty output rather than an error:

| form | result on `gers-osm.osm.pbf` |
|---|---|
| `osmium tags-count -m 1 PBF "w/highway=*"` | **empty** (the `w/`, `n/`, `nwr/` prefix is a `tags-filter` form, not a `tags-count` form) |
| `osmium tags-count -m 1 -t way PBF "highway=*"` | 78770 `service`, 27775 `track`, ... (correct) |
| `osmium tags-count -M 3 PBF "highway"` | **empty** (the `-M/--max-count` option yields nothing) |

`tags-count` takes the object type from `-t`, never from a prefix in the expression, and `-M` is unusable in this build. The script therefore uses `-t` and never a prefixed expression, and never a boolean `and`/`or`/`not` expression (`-e`), matching the known 1.19.1 filter caveat. `-m 1` is used so the histogram keeps every value.

`-M` being broken and the prefixed form being empty are the same class of defect: the tool exits 0 with no rows. `runTagsCount` treats an empty result for a category the report expects to be non-empty as a zero, which is why the first run of this script reported every OSM count as 0 with a `represented` verdict; that was the bug the table above pins down.

Each `tags-count` invocation costs 0.2 s to 1.4 s on the 41 876 027-byte extract, so the whole reference side is 20 invocations and about 10 s. No `osmium export` to GeoJSONSeq is needed: the full export of this extract peaks at 195.6 MB RSS and 6.5 s, which was measured and then avoided in favour of the histogram path.

### 1.2 Canonical side

`loadCanonicalTallies` (`scripts/data/parity-osm.ts:120-155`) streams every non-ignored `data/intermediate/*.json` array once and tallies per `kind`, per category field (`roadClass`, `highway`, `waterType`, `landuseType`, `placeType`, `poiType`, `transportType`, `buildingType`, `structureType`, `territoryCode`), split by `stableId.startsWith("osm-")` into an OSM-sourced and an all-sources figure. Tallying per field rather than per kind matters: `road` carries both `roadClass` and `highway` with the same value, and a per-kind histogram would have double counted every road.

A category is compared against the **OSM-sourced** canonical figure. Canonical buildings and water are 100 % BD TOPO by adoption policy, so an all-sources denominator would have reported a false 0.97 ratio for a category the project does not source from OSM at all.

The total for a row sums only the canonical values that the extract actually observes for that spec, not every value of the field. Before this fix, `amenity`, `shop` and `tourism` all reported the whole 34618 POI count as their canonical total, because the three specs share the `poiType` field.

### 1.3 Verdict rules

`buildParityRow` (`scripts/data/parity-osm.ts:173-201`) evaluates in this order:

1. `exclusionReason` present: `excluded-by-policy`, ratio and counts still reported.
2. `osmCount === 0`: `represented`, with the reason that there is nothing in the extract to represent.
3. `adoptionNote` present: `adopted-from-other-source`, documenting that the kind is adopted from BD TOPO rather than OSM.
4. `canonicalCount === 0`: `missing`, with the observed count and the kind that is empty department-wide.
5. `ratio >= 0.95`: `represented`.
6. otherwise: `partially-represented`.

`compareOsmParity` collects the `missing` ids and `main` sets `process.exitCode = 1` when that list is non-empty. A ratio of 0 that carries an `exclusionReason` or an `adoptionNote` does not fail the run; a ratio of 0 with no documented reason does.

## 2. Measured baseline against the current data

Run: `npx tsx scripts/data/parity-osm.ts`, exit code **1**. Extract: `data/raw/gers-osm.osm.pbf`, 41 876 027 bytes.

| category | osmCount | canonicalCount | ratio | verdict |
|---|---|---|---|---|
| road.highway | 138252 | 54410 | 0.3936 | partially-represented |
| railway | 870 | 0 | 0 | **missing** |
| waterway | 34748 | 0 | 0 | adopted-from-other-source |
| natural.water | 10510 | 0 | 0 | adopted-from-other-source |
| landuse | 59740 | 0 | 0 | **missing** |
| natural.area | 24902 | 0 | 0 | **missing** |
| place | 26105 | 0 | 0 | **missing** |
| place.asPoi | 26105 | 26691 | 1.0224 | represented |
| amenity | 4512 | 4065 | 0.9009 | partially-represented |
| shop | 954 | 965 | 1.0115 | represented |
| tourism | 649 | 520 | 0.8012 | partially-represented |
| building | 315950 | 0 | 0 | adopted-from-other-source |
| excluded.power | 6391 | 0 | 0 | excluded-by-policy |
| excluded.barrier | 60899 | 0 | 0 | excluded-by-policy |
| excluded.boundaryAdmin | 5465 | 0 | 0 | excluded-by-policy |
| excluded.aeroway | 169 | 0 | 0 | excluded-by-policy |
| excluded.junctionNodes | 6916 | 5 | 0.0007 | excluded-by-policy |
| excluded.manMadeUtility | 222 | 0 | 0 | excluded-by-policy |
| excluded.landuseAgriculture | 15966 | 0 | 0 | excluded-by-policy |
| excluded.wall | 112869 | 0 | 0 | excluded-by-policy |

Summary: `{"represented":2,"partiallyRepresented":3,"missing":4,"excluded":8,"adoptedFromOtherSource":3}`.

The four `missing` rows are the pre-rebuild baseline the assignment predicted. `kind landuse`, `kind transport` and `kind place` are structurally 0 in `data/intermediate` today (measured: landuse 0 records, transport 0 records, place 0 records), while the extract holds 59 740 `landuse` ways, 24 902 `natural` ways, 870 `railway` objects and 26 105 `place` nodes. Re-running this script after the Wave 2 pipeline rebuild is the measurement that closes them.

The three `adopted-from-other-source` rows are zero by design, not data loss: `canonicalOsmCountsByKind` in the report reads `building: 0`, `water: 0`, `poi: 34618`, `road: 54410`, so the building and water kinds are entirely BD TOPO sourced.

## 3. Cross-check: canonical tallies against the manifest

`loadCanonicalTallies` over `data/intermediate` and `data/generated/manifest.json.featureCounts` agree exactly, feature for feature:

| kind | from data/intermediate | manifest.featureCounts |
|---|---|---|
| address | 115379 | 115379 |
| boundary | 1 | 1 |
| building | 305761 | 305761 |
| business | 611 | 611 |
| poi | 34618 | 34618 |
| road | 182254 | 182254 |
| water | 52716 | 52716 |

No `data/qa/coverage.json` exists in the current tree (it is written by `refresh.ts:456` during a full rebuild), so the manifest is the cross-check surface. Both figures are written into the report as `canonicalCountsByKind` and `manifestFeatureCounts`.

## 4. What the per-value histogram shows

The `byValue` array in each row is the diagnostic part of the report. The `road.highway` row:

| value | osmCount | canonicalCount | ratio |
|---|---|---|---|
| service | 78770 | 3313 | 0.0421 |
| track | 27775 | 26488 | 0.9537 |
| unclassified | 8249 | 5852 | 0.7094 |
| residential | 6009 | 4045 | 0.6732 |
| path | 5900 | 5532 | 0.9376 |

`highway=service` at 4.2 % is the enrichment-retention signature, not a geometry defect: the Gers default retention in the current build keeps a `highway` way only when it is in the enrichment set or carries a `name`, and `service` is overwhelmingly unnamed farm and courtyard track. `track` at 95.4 % shows the same code path keeping what it is meant to keep. The `amenity` row shows the same shape (`bench` 770 OSM against 2 canonical, `recycling` 392 against 66, `townhall` 395 against 398).

`place.asPoi` at 1.0224 is above 1 because the canonical POI layer also carries BD TOPO `lieu_dit_non_habite` and other named toponyms beyond the OSM `place` nodes; the ratio is reported as measured and is not clamped.

## 5. Policy exclusions recorded

Eight categories carry an explicit exclusion with a reason, so a zero ratio for them never fails the run:

- `excluded.power` (6391 ways): no utility-line kind in the canonical model; BD TOPO TRONRESEAU is the authority.
- `excluded.barrier` (60 899 objects): no barrier kind; render noise at every zoom.
- `excluded.boundaryAdmin` (5465): the department boundary comes from IGN ADMIN EXPRESS COG.
- `excluded.aeroway` (169): runways and aprons will come from BD TOPO AERODROME.
- `excluded.junctionNodes` (6916): junction, turning and traffic-sign nodes carry no line geometry the road network lacks.
- `excluded.manMadeUtility` (222): pipelines and utility works are BD TOPO TRONRESEAU territory.
- `excluded.landuseAgriculture` (15 966): micro-parcel texture below the render threshold of a department-scale map.
- `excluded.wall` (112 869): wall-tagged ways duplicate building outlines and match no canonical kind.

## 6. Tests

`npx vitest run tests/unit/parity-osm.test.ts`: **11 passed**, 189 ms. The suite covers the pure comparison only: full match, OSM-origin split, zero against non-empty extract, zero on both sides, the 0.95 partial threshold, an excluded category that still holds canonical objects, an adoption note routing a zero away from `missing`, the sum-over-observed-values rule, the `missing` list and the summary counts.

`npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --resolveJsonModule --noUncheckedIndexedAccess --noUnusedLocals --noUnusedParameters --skipLibCheck --types node scripts/data/parity-osm.ts tests/unit/parity-osm.test.ts`: exit 0. `npx tsc --noEmit -p tsconfig.json`: exit 0.

## 7. Re-run contract

```
npx tsx scripts/data/parity-osm.ts
```

Exit 0 when no category is silently missing, exit 1 when at least one category has a ratio of 0 with no exclusion and no adoption note, exit 2 when the extract is absent. `MASTER_MAPS_DATA_DIR` selects the data root. Output is always `data/qa/osm-parity.json`.

## INTEGRATION NEEDS

- `package.json` has no `data:parity` script and `package.json` is not owned by this task. Adding `"data:parity": "tsx scripts/data/parity-osm.ts"` would make the parity check reachable from `npm run`. The script currently has no non-zero exit that a `data:build` chain would trip over, since `refresh.ts` does not call it, so leaving it unwired changes nothing about the pipeline.
- `reports/wave2/CONTRACTS.md` section 6 lists the `data/qa` artefacts each stage must write. `osm-parity.json` is new and is not mentioned there; the section owner may want to add it.
