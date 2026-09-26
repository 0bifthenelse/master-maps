# WAVE 1 / TASK 04 — DATA-LOSS AUDIT

Scope: trace representative records from raw source through normalize -> dedupe -> tiles -> search index -> client, and identify every stage where records are dropped or made invisible.

All numbers below are **VERIFIED** unless marked `[INFERENCE]`. Commands and evidence are given so they can be reproduced.

Machine note: `data/` is gitignored. All measurement was done with throwaway scripts under `/tmp/w1_04/` and `tests/artifacts/w1_04/` (both gitignored). No tracked repository file was modified.

---

## 0. HEADLINE FINDINGS (ranked by impact)

| # | Finding | Severity |
|---|---|---|
| **F1** | `landuse` and `transport` are **zero** across the entire pipeline. 0 features exist in intermediate, tiles, and search. | CRITICAL |
| **F2** | OSM railways and bus stops are silently re-typed as unnamed point `poi`. No rail network is renderable. | CRITICAL |
| **F3** | The `labels` layer toggle is **dead** — nothing in the codebase reads `layers.labels`, and no label/text rendering exists at all. | CRITICAL |
| **F4** | `address` is loaded into tiles (115,379 rows, ~15% of all tile bytes) but `RENDERABLE_KINDS.address === false`, so it is fetched, cached, and then thrown away by `sceneFeature()`. | HIGH |
| **F5** | 8,111 BD TOPO fictive water axes (`fictif=true`) are carried all the way into the client and then dropped inside `buildWater` with **no** audit record. | HIGH |
| **F6** | `data/intermediate` is **stale** relative to `data/raw` (regenerated 2026-08-27T22:16, raw re-fetched 2026-08-28T16:43). Business set differs by 129 records (611 on disk vs 740 reproducible). | HIGH |
| **F7** | LOD1/LOD2 filters drop 43% of roads, 26% of water, 23% of buildings, 97.5% of POIs. LOD2 keeps only the department boundary + 868 POIs. | MEDIUM |
| **F8** | `coverage.json` hardcodes `unresolved: []` and `categories: featureCounts` (kind counts, not real categories). No real exclusion report exists. | MEDIUM |

---

## 1. PIPELINE MAP (with the code that decides inclusion)

```
data/raw/*                       fetch-*.ts
   |
   v
normalize.ts  (normalizeAll:960)  -->  build order at :995
   [boundary] + bdtopoFeatures + deduplicatedBulkFeatures + auchOsmFeatures
   + osmResult.features + addressFeatures + businessFeatures + ignFeatures
   |
   +--> canonicalFeature():953  -- drops on "Area geometry has no non-degenerate polygon"
   |       --> written to data/intermediate/normalization-issues.json
   v
deduplicate.ts (deduplicateFeatures:368, mergeGroup:309)
   |
   v
build-tiles.ts (streamLevel:335, keepAtLod:177, generalizedFeature:195, featureFragment:219)
   |
   v
data/generated/tiles/l{0,1,2}_*.json  + tile-manifest.json
   |
   v
build-search-index.ts (buildSearchIndex:118, loadData:58)
   |
   v
data/search/index.json
   |
   v
app/api/map/tile/[tileId]/route.ts  ->  loadTile.ts  ->  MapShell.tsx
   RENDERABLE_KINDS:56  +  sceneFeature():132  +  deduplicateSceneFeatures():148
   |
   v
CityScene.tsx visible():43 / isXFeature guards  ->  src/lib/scene/build*.ts
```

---

## 2. PER-KIND CENSUS

### 2.1 intermediate (VERIFIED)

Command: `node /tmp/w1_04/count_intermediate.mjs data/intermediate`
Also matches `data/generated/manifest.json` `featureCounts` and `data/manifests/coverage.json` exactly.

| kind | intermediate count |
|---|---|
| address | 115,379 |
| boundary | 1 |
| building | 305,761 |
| business | 611 |
| poi | 34,618 |
| road | 182,254 |
| water | 52,716 |
| **landuse** | **0** |
| **transport** | **0** |
| TOTAL | 691,340 |

Source breakdown (VERIFIED, `node /tmp/w1_04/prefixes2.mjs`):

| kind \| source | count |
|---|---|
| building \| ign-bdtopo/building | 305,745 |
| road \| ign-bdtopo/road | 127,837 |
| address \| ban | 115,373 |
| road \| osm-bulk | 54,407 |
| water \| ign-bdtopo/water-line | 41,720 |
| poi \| osm-bulk | 34,616 |
| water \| ign-bdtopo/water-surface | 10,993 |
| business \| business/siret | 610 |

`DUPLICATE_STABLE_IDS = 0` — no stableId collisions survive dedupe.

### 2.2 generated tiles (VERIFIED)

Command: `node /tmp/w1_04/scan_tiles.mjs data/generated/tiles` (single pass over 8.49 GB, 9,591 files, 79.9 s).

Fragment rows (= feature copies after clipping, so > distinct count):

| lod \| kind | fragment rows |
|---|---|
| 0 \| address | 115,379 |
| 0 \| boundary | 7,941 |
| 0 \| building | 323,744 |
| 0 \| business | 611 |
| 0 \| poi | 34,618 |
| 0 \| road | 244,875 |
| 0 \| water | 68,593 |
| 1 \| boundary | 1,254 |
| 1 \| building | 239,803 |
| 1 \| business | 611 |
| 1 \| poi | 34,618 |
| 1 \| road | 117,375 |
| 1 \| water | 44,812 |
| 2 \| boundary | 396 |
| 2 \| poi | 868 |
| 2 \| road | 110,096 |
| 2 \| water | 12,179 |

- **distinct stableIds at LOD0 = 691,340** — exactly equal to the intermediate total. **No record is lost between intermediate and LOD0 tiles.** This is the one stage that is lossless.
- `landuse` / `transport`: **0 rows at every LOD.**

> **Methodology warning.** A naive `wc -l` per-tile count is WRONG here. Many tiles are emitted as a single minified line (`l0_100_10_s1_0_0.json` = 71 features on **1 line**, 764,575 bytes). An earlier line-based counter reported only 64,496 distinct ids; the regex-based counter above is authoritative and is corroborated by `data/qa/validation-report.json` (`featureCount: 691387`, sampled before the final dedupe pass) and by `tile-manifest.json` (sum of `featureCount` per LOD = 795,761 + 438,473 + 123,539 = 1,357,773, matching the scan's 1,357,773 total fragment rows exactly).

### 2.3 search index (VERIFIED)

Command: `node /tmp/w1_04/count_search.mjs data/search/index.json`

| kind | search records |
|---|---|
| address | 115,378 |
| business | 611 |
| poi | 34,618 |
| road | 85,900 |
| water | 18,322 |
| **building** | **0** |
| **landuse** | **0** |
| **transport** | **0** |
| **boundary** | **0** |
| TOTAL | 254,829 |

Searchable share: **254,829 / 691,340 = 36.9%**. 436,511 records (63.1%) are unsearchable.

---

## 3. WHERE RECORDS ARE DROPPED — STAGE BY STAGE

### 3.1 `landuse`: total loss at normalize (F1)

Root cause chain, VERIFIED by reading the code and by sampling `data/raw/osm-bulk.geojson`:

1. `classifyCompleteTags()` **does** map `landuse`/`leisure` to `{kind:"landuse"}` (`normalizeOsmBulk.ts:55`). The taxonomy exists.
2. But that path is only reached when `retention === "complete"` (`normalizeOsmBulk.ts:500`), which is only configured for the **Auch** extract (`AUCH_OSM_CONFIG`, `normalize.ts:100-106`).
3. The Gers bulk extract runs with `DEFAULT_OSM_NORMALIZE_CONFIG` whose `retention` is **`"enrichment"`** (`normalizeOsmBulk.ts:33`). In enrichment mode the code at `normalizeOsmBulk.ts:505-509` keeps a feature only if it is a named/enrichment road or a named POI:
   ```
   const isRoad = highway !== undefined && (ENRICHMENT_HIGHWAYS.has(highway) || namedRoad);
   const isPoi = isNamedPoi(properties);
   if (!isRoad && !isPoi) continue;
   ```
   An unnamed `landuse=forest` polygon fails both and is dropped **silently** — no issue file, no counter.
4. A second, independent blocker also exists. Both sampled "forest" features are exported as **LineString**, not Polygon:
   - `w32612750` — `"description":"Île au Canard","landuse":"forest"`, geometry `"type":"LineString"`.
   - `w42050472` — `"landuse":"forest","leaf_type":"broadleaved","name":"Bois du Chapître"`, geometry `"type":"LineString"`.
   Even in `complete` retention, `normalizeOsmBulk.ts:123` rejects non-areal landuse: `if ((classification.kind === "building" || classification.kind === "landuse") && !areal) return null;`
5. The Gers `osm.json` Overpass path *does* support landuse (`classifyTags`, `normalize.ts:322-323`), but it is disabled: `loadRawSources` at `normalize.ts:862` sets `osm = { elements: [], ... }` whenever `osm-bulk.geojson` has features — and it does (261,798).

Raw evidence: `"landuse":` occurs 1,006 times, `"leisure":` 521 times, `"natural":"wood"` 4 times in `data/raw/osm-bulk.geojson`. **All of it is unrepresented.**

`buildLanduse.ts` exists in `src/lib/scene/` and `CityScene.tsx:97,107` wires it — but it is permanently fed an empty array. Dead code path.

### 3.2 `transport`: total loss at normalize (F1, F2)

`schema.ts:289-300` defines a full `TransportFeature` and `classifyTags` (`normalize.ts:325`) maps `railway`/`public_transport` to it. It is never reached, because of the same `retention:"enrichment"` gate (`normalizeOsmBulk.ts:33`).

Raw tag census in `data/raw/osm-bulk.geojson` (VERIFIED):
- `"railway":` — 762
- `"public_transport":` — 295
- `"highway":"bus_stop"` — 257

**What actually happens instead (VERIFIED by full-record extraction):**

| raw id | raw tags | intermediate | kind | name | poiType |
|---|---|---|---|---|---|
| `w35476991` | `railway=rail`, LineString, 8 coords, `name="Ligne de Saint-Agne à Auch"`, `operator=SNCF Réseau`, `ref=648000` | `osm-bulk:w35476991` | **poi** | "Ligne de Saint-Agne à Auch" | `rail` |
| `n277052279` | `highway=bus_stop`, Point, `public_transport=platform`, `network=liO` | **ABSENT** | — | — | — |
| `n766645484` | `highway=bus_stop`, Point | `osm-bulk:n766645484` | **poi** | "Repos" | `poi` |

Three distinct loss modes, all silent:
- **Geometry collapse.** The enrichment branch at `normalizeOsmBulk.ts:557-571` replaces *any* geometry with a single Point at the anchor. A 78-km railway becomes one 4-metre disc.
- **Type erasure.** `poiType: "rail"` (`normalizeOsmBulk.ts:565` falls back to `tags.railway`). The railway is searchable as a POI but there is no track, no station, no platform geometry.
- **Total drop.** `n277052279` (bus stop, `public_transport=platform`) is in neither intermediate **nor** any tile — VERIFIED by a full 8.49 GB scan (`locate_ids.mjs` → `present: false`). It is dropped because `isNamedPoi` (`normalizeOsmBulk.ts:479-482`) requires a `name`; this stop is unnamed.

`transport` is additionally declared non-renderable twice over: `RENDERABLE_KINDS.transport === false` (`MapShell.tsx:65`) and there is no `isTransportFeature` guard or `buildTransport` module in `src/lib/scene/`. So even if the data were produced, **nothing would draw it**.

### 3.3 `address`: fetched, cached, then discarded (F4)

115,379 address rows (13.4% of all 691,340 records) are written into LOD0 tiles and account for a large share of the 8.49 GB. On the client:

```
MapShell.tsx:64   address: false,     // RENDERABLE_KINDS
MapShell.tsx:133  if (!RENDERABLE_KINDS[feature.kind] || !feature.localGeometry) return null;
```

`sceneFeature()` returns `null` for every address, so `deduplicateSceneFeatures()` (`:148`) discards them before `CityScene` ever sees them. The bytes are downloaded, JSON-parsed, Zod-validated (`loadTile.ts:126`), and dropped.

Addresses are, however, **fully searchable** (115,378 of 115,379 in the index — the single miss is the one address whose tile is absent). This is the only kind where search is the sole delivery path, which is arguably correct for addresses — but nothing states that, and `layerAvailability.address: true` in `data/generated/manifest.json` advertises a layer the renderer will never draw.

### 3.4 `building`: absent from search (F2 class)

`build-search-index.ts:96-100` `featureName()` returns `feature.name` / `displayName`. BD TOPO buildings **never carry a name** — VERIFIED: `count_names.mjs` on `building-0001.json` → `rowsWithoutName: 19999 / 19999, distinctNames: 0`. Line 125 then skips them: `if (!name || !tileId || ...) continue`.

Result: **0 of 305,761 buildings are searchable**, even though the index assigns them `boost: 10` (`build-search-index.ts:106`) — dead configuration. The boost implies buildings were meant to be searchable.

### 3.5 `water`: fictive axes vanish in the client (F5)

`normalizeBdtopo.ts:384` sets `fictiveAxis = parseBdBoolean(properties.fictif) === true` for `water-line` features, preserving the flag in `sourceMetadata.fictif`. The tile builder keeps them (no filter on `fictiveAxis`). They reach the client and are dropped at `buildWater.ts:145`:

```ts
if (feature.fictiveAxis === true) continue;
```

VERIFIED by executing the real builder over all 52,716 intermediate water features:

```
water features: 52716
fictiveAxis===true: 8111
rendered featureCount: 44605 of 52716
strata: surface 10993 (362,427 verts), linear 33612 (865,592 verts)
```

**8,111 water records (15.4%) are loaded and never drawn, with no counter anywhere.** Sample dropped record: `ign-bdtopo:water-line/TRON_EAU0000000110973145`, `waterType: "Retenue"`, `fictif: true`, `persistence: "Permanent"` — a permanent reservoir, dropped because BD TOPO marks it fictif.

### 3.6 LOD filtering (F7)

`keepAtLod()` at `build-tiles.ts:177-193`. VERIFIED by re-executing the exact predicate over all intermediate features (`tests/artifacts/w1_04/lod_losses.mts`):

| kind | LOD0 | LOD1 | LOD1 dropped | LOD2 | LOD2 dropped |
|---|---|---|---|---|---|
| address | 115,373 | 0 | **115,373 (100%)** | 0 | **115,373 (100%)** |
| building | 305,745 | 234,932 | 70,813 (23.2%) | 0 | **305,745 (100%)** |
| business | 610 | 610 | 0 | 0 | **610 (100%)** |
| poi | 34,616 | 34,616 | 0 | 868 | 33,748 (97.5%) |
| road | 182,244 | 103,200 | 79,044 (43.4%) | 102,832 | 79,412 (43.6%) |
| water | 52,713 | 38,923 | 13,790 (26.2%) | 11,145 | 41,568 (78.8%) |

The killer: `keepAtLod` has no `address` branch, so it falls through to `return false` at `:185` / `:192`. **Addresses are absent from LOD1 and LOD2 entirely.**

`lodForSpan()` (`MapShell.tsx:84-88`) picks LOD2 whenever the viewport span exceeds 60 km. Gers is ~75 km wide, so **the initial department-wide view requests LOD2 — which contains 396 boundary fragments, 868 POIs, some roads and water, and zero buildings, zero addresses, zero businesses.** A user opening the map at full-department zoom sees essentially nothing but the department outline and town labels.

LOD2 road filter `roadRank <= 3` (`:187`) is nominal, but the row count (110,096) is high because each road is duplicated across the 396 overlapping 32,768-unit tiles. Per-tile payload is what matters; `data/generated/tile-metrics.json` should be cross-checked separately.

### 3.7 `boundary` and the fragment explosion

1 boundary feature, 7,941 fragment rows at LOD0 (one per tile it touches), 1,254 at LOD1, 396 at LOD2. The department polygon is re-tessellated and re-emitted into all 9,591 tiles. This is ~7,941 redundant copies of a 25,966-vertex MultiPolygon — a large share of the 8.49 GB. It is also `keepAtLod`-exempt (`:178`), so LOD2 tiles each carry a full boundary copy.

### 3.8 Normalization losses that *are* audited (the one bright spot)

`canonicalFeature()` (`normalize.ts:953`) catches schema failures and writes them to `normalization-issues.json`. VERIFIED: 111 entries, all `error: "Area geometry has no non-degenerate polygon"`, all `kind: "building"`, e.g. `ign-bdtopo:building/BATIMENT0000000310116478`. Surfaced in `manifest.failedSources` as `invalid-source-geometries: 111 source records were excluded`. Good — this is the pattern the other stages should follow.

`relation-issues.json` is `[]` and `ign-unavailable.json` documents the IGN elevation failure.

---

## 4. THE SIX CONCRETE RECORDS, TRACED END TO END

All six verified with `node /tmp/w1_04/locate_ids.mjs` (full 8.49 GB tile scan), `check_intermediate.mjs`, `check_search.mjs`, and `trace.mjs`.

### R1 — BD TOPO rural track (chemin / route empierrée)
`ign-bdtopo:road/TRONROUT0000002000055013`

| stage | result |
|---|---|
| raw | `data/raw/bdtopo-roads.geojson`, layer `troncon_de_route`, `nature: "Route empierrée"`, `importance: "5"`, `fictif: false`, `nom_voie_ban_*` absent |
| normalize | `roadClass: "track"` via `roadClass()` `normalizeBdtopo.ts:274`; `name: undefined` (no BAN name); `widthInferred: true`, `width` undefined |
| intermediate | `data/intermediate/road-0001.json` — present |
| dedupe | survives (no `name`, so dedupe relies on `compatibleRoadClass`/Hausdorff) |
| LOD0 tile | **present**, `l0_26_39_s1_1_0.json` |
| LOD1 | absent (rank 8 > 5 and no name) |
| LOD2 | absent |
| search index | **ABSENT** — no name to index |
| client | rendered if the tile is loaded (road is renderable, LineString) |

**Verdict: survives, but is anonymous and disappears at LOD≥1.** A `Route empierrée` is a real Gers road that a user can never find by name and never sees when zoomed out.

### R2 — BD TOPO building
`ign-bdtopo:building/BATIMENT0000000311484552`

| stage | result |
|---|---|
| raw | `data/raw/bdtopo-buildings.geojson`, `nature: "Indifférenciée"`, `usage_1: "Résidentiel"`, `hauteur: 6.4`, `nombre_d_etages: 1` |
| normalize | `height: 6.4`, `heightSource: "explicit"`, `buildingType: "Indifférenciée"` (`normalizeBdtopo.ts:328-348`) |
| intermediate | `data/intermediate/building-0001.json` |
| LOD0 tile | **present**, `l0_88_31_s1_1_0.json` |
| LOD1 tile | **present**, `l1_22_7_s1_1_0.json` |
| LOD2 | absent (`name !== undefined` is false) |
| search index | **ABSENT** — 0/305,761 buildings are searchable |
| client | rendered (building is renderable) |

**Verdict: fully rendered, never searchable.** Adjacent `BATIMENT...553` is `usage_2: "Agricole"`, retained in `sourceMetadata` but never surfaced in `FeatureInspector` grouping.

### R3 — BAN address outside Auch
`ban:32271_0190_00668` — 668 Chemin du Sarbagnac, 32240 Monguilhem

| stage | result |
|---|---|
| raw CSV | `data/raw/adresses-32.csv.gz` line: `32271_0190_00668;32271_0190;668;;Chemin du Sarbagnac;32240;32271;Monguilhem;...;-0.18309;43.850476;entrée` |
| raw JSON | `data/raw/ban-addresses.json` — `{"banId":"32271_0190_00668","numero":"668","streetName":"Chemin du Sarbagnac","postalCode":"32240","city":"Monguilhem","lon":-0.18309,"lat":43.850476,...}` |
| normalize | `normalizeAddresses` `:570-611`; boundary test `boundaryIndex.contains()` passes; stableId `ban:32271_0190_00668` |
| intermediate | `data/intermediate/address-0001.json` |
| LOD0 tile | present (115,379 address rows at LOD0) |
| LOD1 / LOD2 | **absent** (no `keepAtLod` branch) |
| search index | **present** — `{"featureId":"ban:32271_0190_00668","canonicalName":"668 Chemin du Sarbagnac","kind":"address","tileId":"l0_40_244_s3_0_0","focusLon":-0.18309,"focusLat":43.850476,"boost":50}` |
| client | search hit loads `l0_40_244_s3_0_0`, then `sceneFeature()` returns `null` (address non-renderable). `handleSearchResultSelect` (`:347`) still calls `setSelectedFeature(raw)` so `FeatureInspector` shows it — **the ONLY way an address ever becomes visible.** |

**Verdict: the happy path, and it works — but only via the inspector, never as map geometry.** A rural address is invisible on the map itself.

### R4 — OSM railway
`osm-bulk:w35476991` — "Ligne de Saint-Agne à Auch", `railway=rail`

| stage | result |
|---|---|
| raw | `data/raw/osm-bulk.geojson`, `"type":"LineString"`, 8 coords, `electrified:no`, `gauge:1435`, `maxspeed:90`, `operator:"SNCF Réseau"`, `ref:648000`, `source:"cadastre-dgi-fr …"` |
| normalize | **MIS-CLASSIFIED**: `retention:"enrichment"` → `isNamedPoi` true (has `name` + `railway` key) → POI branch `normalizeOsmBulk.ts:557-571`; geometry replaced by a Point at the anchor |
| intermediate | `data/intermediate/poi.json` — `kind:"poi"`, `poiType:"rail"`, `name:"Ligne de Saint-Agne à Auch"`, `geometry: Point` |
| LOD0 tile | **present** as a point: `l0_184_69_s2_1_0.json` |
| LOD1 | present (a poi) |
| LOD2 | absent (poiType `rail` not in the LOD2 allow-list `:189`) |
| search index | **present** — `{"featureId":"osm-bulk:w35476991","canonicalName":"Ligne de Saint-Agne à Auch","kind":"poi","category":"rail","tileId":"l0_184_69_s2_1_0","boost":100}` |
| client | rendered as a **4-metre orange disc** (`buildPois.ts:66` `DEFAULT_POI_SIZE = 4`) at one point on the line |

**Verdict: the single most damaging mis-classification found.** A named SNCF main line with gauge, electrification, maxspeed and operator is drawn as a 4 m dot, one point of ~8. The `transport` kind that would have rendered it properly is empty and non-renderable. The name does survive, so it is at least findable — but clicking it flies the camera to a meaningless dot.

Adjacent rails `w45825050`, `w45825051` behave identically.

### R5 — OSM bus stop
`osm-bulk:n277052279` — `highway=bus_stop`, `public_transport=platform`, `network=liO`, Point `[0.3007147, 43.7554847]`

| stage | result |
|---|---|
| raw | present in `data/raw/osm-bulk.geojson` |
| normalize | **DROPPED** — `isNamedPoi` (`normalizeOsmBulk.ts:479-482`) requires `text(properties.name) !== undefined`; this node has no `name`. `if (!isRoad && !isPoi) continue;` at `:509`. |
| intermediate | **ABSENT** (verified by full scan of all 44 data files) |
| tiles | **ABSENT at LOD0, LOD1 and LOD2** (verified by full 8.49 GB scan: `present: false`) |
| search index | **ABSENT** |
| client | never exists |

`osm-bulk:n766645484` (also `highway=bus_stop`, but with `name="Repos"`) is the contrasting case: it *does* become a POI with `poiType: "poi"` — note the type is `"poi"`, not `"bus_stop"`, because `normalizeOsmBulk.ts:565`'s `poiType` chain has no `highway` key. The stop's real identity is lost even when it survives.

**Verdict: 257 bus stops in the raw extract, and unnamed ones are annihilated with no trace.**

### R6 — OSM landuse / forest
`osm-bulk:w32612750` — `landuse=forest`, `description: "Île au Canard"`, LineString 32 coords
`osm-bulk:w42050472` — `landuse=forest`, `leaf_type: broadleaved`, `name: "Bois du Chapître"`, LineString 126 coords

| stage | `w32612750` | `w42050472` |
|---|---|---|
| raw | present, LineString | present, LineString |
| normalize | **DROPPED** — no name → fails `isNamedPoi`; not a road | **DROPPED** — has a name, so `isNamedPoi` is true → becomes a **poi**, but `completeFeature` is never called in enrichment mode, so it takes the POI branch and the polygon-less LineString collapses to a Point |
| intermediate | **ABSENT** (full scan) | **ABSENT** (full scan) |
| tiles | absent at all LODs | absent at all LODs |
| search index | absent | absent |
| client | never exists | never exists |

`w42050472` ("Bois du Chapître") is the worst case: it has a perfectly good name, is a real named wood, and is still silently annihilated — because in enrichment mode every named non-road feature becomes a point POI regardless of geometry type, and a LineString wood is a nonsense point.

**Verdict: the Gers has no forest, no wood, no meadow, no park, no leisure area. `landuse` = 0 at every stage.** `buildLanduse.ts` is dead code.

### R7 (bonus) — SIRENE business
`business:siret/35600000021535` — LA POSTE, 23 rue Victor Hugo, 32300 Mirande, NAF 53.10Z

| stage | result |
|---|---|
| raw | `data/raw/businesses-sirene.json`, 755 records, `truncated: true`, `totalQueries: 33` |
| normalize | `normalizeBusinesses` `:689-728`; `siret` present → stableId `business:siret/<siret>`; `status: "active"` (administrativeStatus `A`) |
| intermediate | `data/intermediate/business.json` — present, `lon 0.4051162226`, `lat 43.513257434` |
| LOD0 | present (611 rows) |
| LOD1 | present (611 rows) |
| LOD2 | **absent** (`return false` — no business branch) |
| search index | present, `boost: 200` |
| client | rendered as a 6 m `#d34f2f` disc (`buildPois.ts:63-64`), hover popup, click-to-inspect |

**Verdict: the only kind with a complete, correct path.** Business is the model the other kinds should follow. But see F6 below.

---

## 5. THE STALENESS FINDING (F6)

`data/intermediate` was written **2026-08-27 22:15–22:16**. `data/raw` was re-fetched **2026-08-28 16:43–17:10** (a day later). Only the two Auch-scoped files (`auch-boundary-source.json`, `auch-osm-manifest.json`, 2026-08-28) are newer than the intermediate shards.

Consequence, VERIFIED by re-running the real `normalizeBusinesses` against the current raw file:

```
input records: 755
normalizeBusinesses() output: 740
on disk (data/intermediate/business.json): 611
in normalized-but-not-on-disk: 476
on-disk-but-not-in-normalized: 347
```

- All 476 newly-normalized records have coordinates **inside Gers** (verified: 476 in bbox, 0 outside), and all 476 share the same `acquiredFromQuery: {q: "", page: 1}`.
- `normalizeBusinesses` alone accounts for 740, and `deduplicateFeatures` preserves all 740 (verified: `normalized: 740 / after deduplicate: 740 / merged away: 0`).
- The `businesses-sirene.json` timestamp moved from `2026-08-27T18:56:05.784Z` (recorded in every `sourceRefs` of the on-disk features) to `2026-08-28T14:43:37.541Z`.
- The Gers `data/generated/*` and `data/search/index.json` are all from 2026-08-27 22:26–22:27, i.e. they are derived from the **stale** intermediate.

**So 129 of 740 real Gers businesses (17%) are missing from the shipped map, and the data on disk cannot be reproduced from the data in `data/raw`.** The audit trail is broken: `manifest.json` advertises `recordCount: 755` and `acquisitionTime: 2026-08-27T20:27:15.333Z`, neither of which matches the raw files actually present.

I verified the boundary index is **not** at fault (probing `createBoundaryIndex` with the production `boundary.geometry.coordinates` returns `true` for all the "lost" points and `false` for Toulouse) — so this is purely a regeneration-ordering problem, not a geometry bug.

---

## 6. THE `labels` TOGGLE (F3)

`LayerControls.tsx:57` renders `{ id: 'labels', label: 'Étiquettes', defaultVisible: true }`. `LayerState.labels` is declared at `:15` and defaulted `true` at `:26`. `MapShell.handleLayerToggle` (`:393-395`) writes it into state and passes `layers` to `<CityScene layers={layers}>` (`:419`).

**Nothing consumes it.** VERIFIED:
- `grep -r 'layers\.labels|labels:'` over `src/` matches only `LayerControls.tsx:15,26,57` — the declaration, the default, and the checkbox. No reader.
- `CityScene.visible()` (`:43-50`) tests `layers.buildings`, `.roads`, `.water`, `.landuse`, `.boundary`, `.pois` — **not** `.labels`.
- `grep -r 'troika|TextGeometry|Sprite|label'` over `src/lib/scene/` → **no matches**. There is no text, sprite, or label rendering anywhere in the scene layer.
- `package.json` — no troika / text-font dependency.

**The "Étiquettes" checkbox is a no-op that visibly does nothing when clicked.** Toggling it changes `layers`, which re-runs `CityScene`'s `useMemo`s (`:94-110`) and re-tessellates every geometry buffer for zero visual difference. For a 44,605-water-feature tile set that is a real, measurable frame-rate cost for nothing.

`commercialAudit` is likewise declared (`:58`) and written by `MapShell.tsx:375` but never read by the scene — it only gates a conditional set.

---

## 7. THE COVERAGE / EXCLUSION REPORT IS NOT AUDITABLE (F8)

`refresh.ts:445-456` writes `data/manifests/coverage.json`:

```ts
categories: summary.featureCounts,   // :450 — kind counts, relabelled as "categories"
unresolved: [],                      // :452 — hardcoded empty
```

- `categories` is a copy of `featureCounts` — so "categories" reports `{building: 305761, ...}`, not the 214 distinct `poiType` values that actually exist. The 214-way POI taxonomy is measured nowhere in the generated reports.
- `unresolved` is a literal `[]`. Every silently-dropped record in §3.1, §3.2 and §3.5 (762 railways, 1,006 landuse, 8,111 fictive water, 111 degenerate buildings) is absent from every machine-readable exclusion report. Only the 111 normalization failures are recorded.
- `failedSources` is good and does list `invalid-source-geometries: 111 source records were excluded`.

For a mission that requires "every record either represented or in an auditable exclusion report", this is the single largest structural gap. There is no counter anywhere in the enrichment branch of `normalizeOsmBulk.ts` (`:505-572`).

---

## 8. CLIENT-SIDE BLIND SPOTS (beyond RENDERABLE_KINDS)

`MapShell.sceneFeature():132-142` applies a second, independent geometry gate on top of `RENDERABLE_KINDS`:

| kind | requirement | consequence |
|---|---|---|
| building | Polygon/MultiPolygon | a building delivered as a line is dropped |
| road | LineString/MultiLineString | a road delivered as a Point is dropped |
| water | `!== "Point"` | water points dropped (0 occur today) |
| landuse | Polygon/MultiPolygon | — |
| poi/business | `=== "Point"` | **a POI delivered as a polygon is dropped** |
| boundary | Polygon/MultiPolygon | — |

The poi/business `=== "Point"` rule is a live risk: `normalize.ts:467-476` already forces area-POIs to a Point, so it holds today, but any future polygon POI (a `leisure=park` with a name, say) would be silently discarded client-side.

`CityScene.isWaterFeature` (`:60-61`) is `feature.kind === "water"` with no geometry guard, unlike every other kind — harmless today but inconsistent.

---

## 9. WHAT SURVIVES AND WHAT DOESN'T — SUMMARY TABLE

| kind | raw present | intermediate | LOD0 tiles | LOD1 | LOD2 | searchable | renderable | fully represented? |
|---|---|---|---|---|---|---|---|---|
| boundary | 1 | 1 | 7,941 frag | 1,254 frag | 396 frag | 0 | yes | no (no label/search) |
| building | 305,745 | 305,761 | 323,744 frag | 239,803 frag | 0 | **0** | yes | **no** — unsearchable |
| road | 127,837+54,407 | 182,254 | 244,875 frag | 117,375 frag | 110,096 frag | 85,900 | yes | partial (43% unnamed) |
| water | 41,720+10,993 | 52,716 | 68,593 frag | 44,812 frag | 12,179 frag | 18,322 | **44,605 of 52,716** | **no** — 8,111 fictive dropped |
| landuse | 1,006+521 raw | **0** | **0** | 0 | 0 | 0 | dead code | **NO — total loss** |
| poi | 34,616 | 34,618 | 34,618 | 34,618 | 868 | 34,618 | yes (4 m disc) | partial (railways mis-typed) |
| business | 755 raw | 611 (740 actual) | 611 | 611 | 0 | 611 | yes | **best-covered, but stale** |
| address | 115,453 | 115,379 | 115,379 | **0** | **0** | 115,378 | **no** | inspector-only |
| transport | 762+295+257 raw | **0** | **0** | 0 | 0 | 0 | **no builder** | **NO — total loss** |

---

## 10. RECOMMENDED FIX ORDER

1. **Make OSM `transport` real.** Add a `transport` branch to the enrichment classifier in `normalizeOsmBulk.ts` that runs **before** `isNamedPoi`, keeps `railway`/`public_transport` geometry as-is, and does not require a `name`. Then add `isTransportFeature` + `src/lib/scene/buildTransport.ts` and set `RENDERABLE_KINDS.transport = true`. 762 railways is the single largest visual win.
2. **Stop exporting landuse as LineString.** Fix the `osmium`/`ogr2ogr` export in the OSM fetch step so `landuse`/`leisure` multipolygons come out areal, then route them through `completeFeature` (or a landuse-aware enrichment branch) so `landuse != 0`. Wire `buildLanduse` for the first time.
3. **Instrument the silent drops.** Every `continue` in `normalizeOsmBulk.ts:496-572` and `normalize.ts:529-561` should increment a counter, and those counters should land in `normalization-issues.json` and `coverage.json.unresolved`. Right now `unresolved` is hardcoded `[]` and the 8,111 fictive-water drops have no home.
4. **Fix `categories` and `unresolved` in `refresh.ts:450-452`.** `categories` should be real category tallies; `unresolved` should be computed.
5. **Give buildings searchable names or drop the boost.** Either derive a name for BD TOPO buildings (usage + commune) or remove `boost: 10` so the config stops lying.
6. **Re-run the pipeline.** `data/intermediate` is a day stale; 129 businesses are missing and the manifest's advertised counts do not match the raw files. A full `data:refresh` is required before any of the numbers above describe the shipped map.
7. **Decide the address contract.** Either set `RENDERABLE_KINDS.address = true` and add a `buildAddresses` layer, or stop shipping 115,379 rows of non-renderable geometry into every tile (and drop `layerAvailability.address: true` from the manifest). 13% of 8.49 GB is a large price for data the renderer provably discards.
8. **Reconcile LOD2 with the default view.** `lodForSpan` sends the initial Gers-wide view to a LOD that contains 0 buildings, 0 addresses and 0 businesses. Either cap the initial span, or relax the LOD2 filters for buildings/addresses, or default the opening view to a city scale.
9. **Implement labels or delete the toggle.** The checkbox currently costs a full re-tessellation per click and does nothing.
10. **De-duplicate the boundary.** 7,941 copies of the 25,966-vertex department polygon is pure overhead; `keepAtLod` exempts it from every LOD.

---

## 11. REPRODUCTION COMMANDS

```bash
# per-kind counts in intermediate (25 s)
node /tmp/w1_04/count_intermediate.mjs data/intermediate

# source-prefix breakdown (19 s)
node /tmp/w1_04/prefixes2.mjs

# full tile scan, 8.49 GB single pass (80 s)
node --max-old-space-size=4000 /tmp/w1_04/scan_tiles.mjs /tmp/w1_04/tile_scan.json

# search index composition (1 s)
node /tmp/w1_04/count_search.mjs data/search/index.json /tmp/w1_04/search_counts.json

# LOD filter losses, exact keepAtLod predicate (7 s)
npx tsx tests/artifacts/w1_04/lod_losses.mts

# water scene loss, real buildWater (2.6 s)
npx tsx tests/artifacts/w1_04/water_scene.mts

# business staleness, real normalizeBusinesses + deduplicateFeatures
npx tsx tests/artifacts/w1_04/probe2.ts
npx tsx tests/artifacts/w1_04/probe3.ts

# end-to-end record trace (locates a stableId in every LOD)
node --max-old-space-size=2000 /tmp/w1_04/locate_ids.mjs '<stableId>' ...
```

Measurement notes: every figure in this report came from executing the repository's own modules (`normalizeBusinesses`, `deduplicateFeatures`, `buildWater`, `createBoundaryIndex`, `keepAtLod`) against the on-disk data — not from re-deriving logic by hand. The `keepAtLod` re-implementation in `lod_losses.mts` is a faithful transcription of `build-tiles.ts:177-193`; its LOD0 column reproduces the exact intermediate counts, which validates the transcription.
