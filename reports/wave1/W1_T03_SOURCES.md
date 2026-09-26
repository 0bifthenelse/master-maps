# W1 / T03 — OSM, BAN, CADASTRE, SIRENE parity audit (Gers 32)

Repo: `/home/ifthenelse/repository/master/maps` @ `fef6f17`. Wave 1 = investigation only, no tracked file edited.
All numbers below are **VERIFIED** unless explicitly tagged `[INFERENCE]`.

---

## 1. OSM acquisition — two mutually exclusive paths

### 1.1 Bulk path (the one that actually runs) — `scripts/data/fetch-osm.ts`

`fetch-osm.ts:686-689`:

```ts
if (process.env.OSM_USE_OVERPASS !== "1") {
  await fetchBulkOsm(forceRefresh);
  return;
}
```

So the 14 Overpass themes are **dead code by default**. `fetchBulkOsm` (`fetch-osm.ts:509-562`) is:

1. `acquireFile` of `https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf` → `data/raw/midi-pyrenees-latest.osm.pbf` (`fetch-osm.ts:387`, `:516`).
2. Reuse gate on `sourceSha256` + `boundarySha256` + output existence (`fetch-osm.ts:520-524`).
3. `osmium extract -p data/raw/gers-boundary.geojson … -o data/raw/gers-osm.osm.pbf` (`fetch-osm.ts:525`).
4. `osmium tags-filter` → `data/raw/gers-osm-enrichment.osm.pbf` (`fetch-osm.ts:526-532`).
5. `osmium export --add-unique-id type_id` → `data/raw/osm-bulk.geojson` (`fetch-osm.ts:533`).
6. Manifest → `data/intermediate/osm-bulk-manifest.json`.

**Exact tags-filter expression (VERIFIED, `fetch-osm.ts:527-532`):**

```
w/highway=path,footway,cycleway,bridleway,track,pedestrian,steps
n/amenity  n/shop  n/tourism  n/historic  n/name
w/amenity  w/shop  w/tourism  w/historic  w/name
r/amenity  r/shop  r/tourism  r/historic  r/name
```

Note this list is **misleading as written**: osmium 1.19.1 `tags-filter` takes positional expressions OR `-e FILE`; when given several positional expressions it ORs them but the leading `w/highway=...` clause is one of many. Measured behaviour (§4) confirms the effective extract is far wider than "enrichment" suggests.

Measured extract sizes (`osmium fileinfo -e`, VERIFIED):

| file | nodes | ways | relations | total objects | bbox |
|---|---|---|---|---|---|
| `data/raw/gers-osm.osm.pbf` (full Gers extract) | 4 748 117 | 652 835 | 6 294 | **5 407 246** | -0.4290724, 43.1709563, 1.3421527, 45.0672133 |
| `data/raw/gers-osm-enrichment.osm.pbf` | 1 004 981 | 81 721 | 2 760 | **1 089 462** | -0.2898124, 43.2948401, 1.3421527, 44.15413 |
| `data/raw/midi-pyrenees-latest.osm.pbf` | — | — | — | 360 526 940 B | upstream |
| `data/raw/auch-osm.osm.pbf` (Auch scope only) | — | — | — | 2 304 279 B | — |

`osm-bulk.geojson`: **261 798 features** (VERIFIED, `node -e` JSON.parse). Geometry split: Point 173 094 / LineString 81 550 / MultiPolygon 7 154.

### 1.2 Enrichment extract actual content (VERIFIED, `osmium tags-count -m 1`)

`gers-osm-enrichment.osm.pbf` carries **66 205 `highway`, 26 398 `place`, 12 897 `waterway`, 8 805 `amenity`, 2 123 `building`, 2 091 `historic`, 1 114 `shop`, 811 `tourism`, 765 `railway`, 509 `landuse`, 303 `leisure`, 292 `public_transport`, 267 `natural`, 255 `office`, 105 `craft`, 69 813 `name`**.

So the filter pulls in essentially every named `highway` way (not only paths), every `place` node, and every `waterway` way — i.e. it is a *substantial partial mirror of the department*, not a thin enrichment layer. (The declared `w/highway=path,…` list is 13 030 objects; the 66 205 `highway` count comes from the `w/name` expression ORed in.)

### 1.3 Gers extract tag totals (VERIFIED, `osmium tags-count`)

```
316280  "building"        145545  "highway"       62101  "landuse"     35842 "waterway"
31465   "natural"         26430   "place"          8805  "amenity"      1114 "shop"
870     "railway"          349    "public_transport"
```

Value histograms for the ten requested keys are reproduced in §7 (the largest: `building=yes` 308 178, `highway=service` 78 770, `highway=track` 27 775, `landuse=forest` 21 285, `landuse=farmland` 15 273, `waterway=stream` 23 508, `natural=water` 10 590, `place=isolated_dwelling` 17 753, `amenity=parking` 1 974, `shop=bakery` 82, `railway=abandoned` 363, `public_transport=platform` 310).

### 1.4 Per-object-type reachability (VERIFIED, one `osmium tags-filter -e FILE` + `fileinfo -g` per expression)

Caveat found the hard way: osmium 1.19.1's `tags-filter -e` silently mis-handles boolean expressions (`and`/`or`/`not` yield **0 objects**), so every number below comes from a **single-expression** filter and `osmium fileinfo -e -g data.count.*`. Node counts include referenced untagged nodes.

| expression | nodes | ways | relations |
|---|---|---|---|
| `w/building` | 1 521 216 | **315 950** | 0 |
| `r/building` | 6 962 | 645 | **314** |
| `w/highway` | 929 691 | **138 252** | 0 |
| `w/landuse` | 1 128 079 | **59 740** | 0 |
| `r/landuse` | 386 884 | 7 050 | **2 361** |
| `w/natural` | 286 474 | **24 902** | 0 |
| `w/waterway` | 301 013 | **34 748** | 0 |
| `w/railway` | 5 584 | **672** | 0 |
| `w/leisure` | 30 130 | 4 146 | 0 |
| `r/boundary=administrative` | 143 352 | 4 854 | **611** |
| `r/route` | 56 084 | 5 774 | **189** |
| `w/power` | 35 044 | 6 391 | 0 |
| `w/aeroway` | 1 307 | 169 | 0 |
| `w/man_made` | 23 570 | 1 969 | 0 |
| `n/place` | **26 105** | 0 | 0 |
| `n/amenity` | **4 512** | 0 | 0 |
| `n/shop` | **954** | 0 | 0 |
| `n/leisure` | **518** | 0 | 0 |
| `n/public_transport` | **315** | 0 | 0 |
| `n/railway` | **194** | 0 | 0 |
| `n/man_made` | **3 308** | 0 | 0 |
| `n/waterway` | **80** | 0 | 0 |
| `n/addr:housenumber` | **17 554** | 0 | 0 |
| `n/aeroway` | 33 | 0 | 0 |
| `n/tourism` | 649 | 0 | 0 |
| `n/emergency` | 622 | 0 | 0 |

`osmium tags-count -m 1 -t way` reproduces the way-side numbers (e.g. `highway=service` 78 770 ways, `building=yes` 307 891 ways), so the `-e` results are trustworthy for whole-key counts.

### 1.5 Overpass theme path (dead by default) — `fetch-osm.ts:33-212`

14 themes: `buildings`, `roads`, `paths`, `structures`, `rail`, `water`, `landuse`, `parks`, `facilities`, `parking`, `transit`, `addresses`, `shops`, `named-pois`. They use `poly:"…"` rewritten to a bbox selector (`fetch-osm.ts:731-732`) — the boundary polygon is never actually used, only its bbox. Raw files present in `data/raw` from an older run (VERIFIED, `elements.length`):

| file | elements | | file | elements |
|---|---|---|---|---|
| `osm-buildings.json` | 121 058 | | `osm-paths.json` | 12 601 |
| `osm-roads.json` | 34 259 | | `osm-water.json` | 7 893 |
| `osm-landuse.json` | 30 761 | | `osm-facilities.json` | 5 062 |
| `osm-parks.json` | 2 445 | | `osm-named-pois.json` | 1 139 |
| `osm-structures.json` | 1 095 | | `osm-transit.json` | 269 |
| `osm-parking.json` | 1 859 | | `osm-shops.json` | 519 |
| `osm-addresses.json` | 19 016 | | | |

`data/raw/osm.json` (the merge of those themes, written by `scripts/data/refresh.ts:180`) holds **209 644** deduped elements (178 831 node / 30 723 way / 90 relation). **This whole file is ignored at normalize time**: `normalize.ts:861-862` — `if ((osmBulk.features?.length ?? 0) > 0) osm = { elements: [], … }` — because `osm-bulk.geojson` exists. So all 14 theme files + `osm.json` are dead weight on disk, not inputs.

---

## 2. `normalizeOsmBulk` — what survives

`scripts/data/normalizeOsmBulk.ts`. Two retention modes.

### 2.1 `retention: "enrichment"` (the Gers department default, `normalizeOsmBulk.ts:28-34`, called at `normalize.ts:982` with **no** config → `DEFAULT_OSM_NORMALIZE_CONFIG`)

A feature is kept when (`normalizeOsmBulk.ts:505-509`):

- **road**: `highway` present AND (`highway ∈ ENRICHMENT_HIGHWAYS` **OR** `name` present).
  `ENRICHMENT_HIGHWAYS` = `path, footway, cycleway, bridleway, track, pedestrian, steps, corridor, via_ferrata` (`:14-16`).
- **poi**: `name` present AND at least one of `amenity, shop, tourism, historic, office, craft, leisure, public_transport, railway, building, place` (`:479-482`).
- Geometry gate: road requires non-Point geometry (`:535`); POI is collapsed to the anchor point.

Emission kinds: `road` and `poi` only.

### 2.2 `retention: "complete"` (Auch commune only — `normalize.ts:102-106`, `:989`)

`classifyCompleteTags` (`normalizeOsmBulk.ts:43-69`) priority order, **first match wins**:

1. `building` — `building` or `building:part` present
2. `water` — `waterway`, or `natural ∈ {water, wetland}`, or `landuse=reservoir`
3. `landuse` — `landuse` or `leisure`
4. `road` — `highway`
5. `transport` — `railway` **or** `public_transport` (subtype = railway ?? public_transport ?? `"other"`)
6. `poi` — `name` present and one of `place, shop, amenity, tourism, historic, office, craft`
7. else `null` → dropped

Geometry gates (`:121-126`): `building`/`landuse` areal only; `water` areal or linear; `road` linear only; `transport` Point or linear (so **polygonal** `public_transport` areas are dropped).

### 2.3 Replaying both classifiers over the actual `osm-bulk.geojson` (VERIFIED, `node -e`)

```
complete-mode  : building 4212 | water 12541 | landuse 1446 | road 66366 | transport 558 | poi 30252 | DROPPED 146423
enrichment-mode: road 60223 | poi 34365 | DROPPED 167210
Point features without a name: 142972
features with none of the 16 classifier keys: 134083
```

Signatures of the dropped mass (top): `source` 125 851 (admin boundary relations with `source`+`admin_level`+`boundary` 2 022), `addr:housenumber` 1 694, `man_made`+`ele`+`description` 1 612, `barrier` 709, `traffic_calming` 442, `entrance` 103.

**Only ~13 % of the 261 798 bulk features can ever become a map feature.** Everything keyed on `man_made`, `barrier`, `entrance`, `power`, `aeroway`, `route`, `boundary`, `addr:housenumber`, `crossing`, `traffic_signals`, `man_made=pier/breakwater/lighthouse` is silently discarded with **no** entry in any exclusion report.

### 2.4 `transport` is effectively absent from the Gers dataset (VERIFIED)

- `data/generated/manifest.json` and `data/manifests/coverage.json` `featureCounts` keys: `address, boundary, building, business, poi, road, water` — **no `transport`, no `landuse`**.
- `data/intermediate/road-0009.json` (the tail chunk) is 2 254 records, 100 % `IGN BD TOPO` (`ign-bdtopo:road/TRONROUT…`). `road.json`..`road-0008.json` likewise 100 % BD TOPO. **Zero OSM road features reach `data/intermediate/`.**
- `data/intermediate/poi*.json` is 100 % `osm-bulk` (`osm-bulk:n4431132812` …). OSM buildings/landuse/water never survive dedup against BD TOPO.

So the department-wide `retention: "complete"` path (with its `transport` and `landuse` kinds) has **never been exercised for Gers**; only the Auch commune extract uses it.

### 2.5 `osmRelations.ts`

Used only by the Overpass merge path (`refresh.ts:181`, `deduplicateOsmElements`) and the relation-multipolygon reconstruction. `data/intermediate/relation-issues.json` contains `[]` (3 bytes) — no relation failures recorded, but this is vacuous: the Overpass `osm.json` is discarded before relation reconstruction matters, and the bulk path never calls `reconstructMultipolygonRelation` for the department (only 7 154 MultiPolygon features exist in `osm-bulk.geojson`, and the 2 361 `r/landuse` + 611 `r/boundary=administrative` relations are dropped by the filter, not reconstructed).

---

## 3. BAN (Base Adresse Nationale)

### 3.1 Acquisition — `scripts/data/fetch-addresses.ts`

- URL: `https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-32.csv.gz` (`:11-12`), file `data/raw/adresses-32.csv.gz` (4 288 866 B).
- License const `BAN_LICENSE = "Etalab-2.0"` (`:19`); CRS `WGS84 (EPSG:4326)`, transformation `none` (`:20-21`).
- Header is **semicolon**-delimited with 23 columns; `parseCsvRow` reads **by index** (`:194-215`) — `lon`=idx 12, `lat`=idx 13, `type_position`=14, `nom_ld`=16, `libelle_acheminement`=17, `nom_afnor`=18, `source_position`=19, `certification_commune`=21, `cad_parcelles`=22. Verified header: `id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;code_insee_ancienne_commune;nom_ancienne_commune;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles` — indices match. **This is index-based, so a BAN column reordering silently corrupts output; there is no header-name validation.**
- Filter: `pointInBoundary([lon,lat], gers-boundary.geojson)` after a finite-coords check (`:311-320`). `--commune 32013` also applies an INSEE code filter (`:306-309`).

### 3.2 Count parity (VERIFIED)

| quantity | value | source |
|---|---|---|
| `zcat data/raw/adresses-32.csv.gz \| wc -l` | **115 470** | VERIFIED |
| CSV data rows (total − header) | **115 469** | VERIFIED (no blank/odd-quote lines) |
| `ban-addresses.json` `stats.departmentTotal` | **115 461** | VERIFIED |
| `ban-addresses.json` `stats.boundaryFiltered` / `recordCount` / `addresses.length` | **115 453** | VERIFIED |
| `data/manifests/sources.json` `ban-addresses.recordCount` | **115 453** | VERIFIED |
| `data/generated/manifest.json` `featureCounts.address` | **115 379** | VERIFIED |
| `data/intermediate/address.json` + `address-0001..0005.json` union | **115 379** (20 000×5 + 15 379) | VERIFIED, 0 overlap |
| `ban-addresses-auch.json` (commune 32013) | **9 351** | VERIFIED |

**Delta chain:** CSV rows 115 469 → parsed 115 461 (8 rows dropped for non-finite lon/lat) → boundary-filtered 115 453 (8 more outside Gers) → normalized 115 379 (**74 lost between `ban-addresses.json` and `data/intermediate/address*.json`, unaccounted, no issue record**). Also `sources.json` `ban-auch.filteredRecordCount` = 106 118 and `retainedRecordCount` = 9 351 → 115 469 − 9 351 = 106 118, consistent.

`address.json` is a *chunk*, not a full set — the family of 6 files is the real set (see the earlier `overlap = 0` measurement). Any consumer reading only `data/intermediate/address.json` sees 20 000 of 115 379 addresses (17 %).

### 3.3 BAN in the map

`address-0001.json` records: `{stableId: "ban:32458_0090_00849", kind: "address", sourceId, …, street, housenumber, postcode, city, banId}` — 100 % `sourceRefs[0].source === "ban"`. Uses the FANTOIR id as `sourceId` and the fantoir `id` as `banId`.

**Not used anywhere:** `cad_parcelles` is parsed into `cadastreParcelles` (`fetch-addresses.ts:238`) and then dropped — `normalizeAddresses` has no parcel linkage. `certification_commune`, `type_position`, `source_position`, `nom_ld` survive into the raw JSON only. This is the only place cadastral identifiers exist in the repo.

---

## 4. CADASTRE — **absent**

`grep -ri 'cadastre|etalab|CADASTRE' src scripts package.json README.md docs` → **no matches** (VERIFIED). The only cadastre-adjacent string in the repo is the BAN CSV column `cad_parcelles` (§3.3).

**No cadastral source is acquired, normalized, or rendered.** The official open source, verified live:

- Index: `https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements/` — resolves to vintage **`2026-06-01`** (VERIFIED by directory listing read on 2026-09-26). Gers = `/32/`.
- Gers layer files (VERIFIED, `/32/` listing, all `.json.gz`, dated 2026-07-02):

| file | bytes | offers |
|---|---|---|
| `cadastre-32-batiments.json.gz` | 19 582 390 | registered building footprints (subset of BD TOPO `batiment`) |
| `cadastre-32-parcelles.json.gz` | 115 171 744 | **parcels** — the only public cadastral geometry of record |
| `cadastre-32-lieux_dits.json.gz` | 18 619 938 | **lieux-dits** (toponymy) |
| `cadastre-32-sections.json.gz` | 7 035 118 | sections |
| `cadastre-32-prefixes_sections.json.gz` | 3 083 806 | section prefixes |
| `cadastre-32-subdivisions_fiscales.json.gz` | 11 544 631 | fiscal subdivisions (fiscalievres) |
| `cadastre-32-feuilles.json.gz` | 8 625 032 | sheets (map sheets) |
| `cadastre-32-communes.json.gz` | 3 052 369 | commune boundaries |

License: **Licence Ouverte / Open Licence 2.0** (Etalab), reuse allowed with source + vintage citation.

**URL pattern for a per-department pull:**
`https://cadastre.data.gouv.fr/data/etalab-cadastre/{vintage}/geojson/departements/32/cadastre-32-{layer}.json.gz` where `latest` is a symlink to the current vintage (currently `2026-06-01`). Note the dated path is required for a reproducible, citable vintage.

**[INFERENCE]** For this project the only layers that add geometry BD TOPO/OSM do not already carry: `parcelles` (parcel boundaries — a new `landuse`-like or dedicated `parcel` render layer) and `lieux_dits` (a label source, currently only `place=locality` 6 753 / `place=hamlet` 668 / `lieu_dit_non_habite` is unconsumed from BD TOPO). `batiments` duplicates BD TOPO `batiment` (315 950 ways already ingested).

---

## 5. SIRENE / business acquisition — `scripts/data/fetch-businesses.ts`

### 5.1 Mechanism

- Endpoint: `https://recherche-entreprises.api.gouv.fr/search` (`:175`, `:461`) — the **Annuaire des Entreprises** API (not the raw SIRENE stock). Rate limited to **3 req/s** (`:176-177`), 4 attempts, 20 s timeout (`:181`, `:478`).
- Scope: `departement=32` (department mode) or `code_commune=32013` (commune mode) (`:499-501`).
- Paging: `per_page=25`, capped at `Math.min(maxSirenePages, 400)` pages (`:502-503`) → **hard ceiling of 10 000 establishments**.
- **Geocoding is not done by this repo.** Coordinates come from the API payload: `longitude`/`latitude` on `matching_etablissements[0]` or `siege` (`:422-423`, `:618-619`). No BAN/adresse-parcours call, no address-string geocoder. If the API has no coords, `coordinate: null` and the record is dropped by the boundary test at `normalize.ts:695`.
- Three hardcoded name queries `NOCIBE`, `FANTOCHE`, `CRU` are run in addition to the scan (`:596-600`) — **hardcoded Auch-specific lookups in a department-wide fetch**, `[INFERENCE]` a leftover from the commune-scope prototype.
- Raw output: `data/raw/businesses-sirene.json`; license `Licence Ouverte / Open Licence 2.0 (ETALAB)` (`:183`).

### 5.2 Counts (VERIFIED)

| metric | value |
|---|---|
| `businesses-sirene.json` `totalUniqueRecords` / `records.length` | **755** |
| `totalQueries` / all statuses `ok` | **33** |
| `truncated` | **true** |
| scope actually used | `commune: "32013"` (Auch), **not** `departement: 32` |
| records with a coordinate | **748** (7 without) |
| from scan / from named query | 750 / 5 |
| per-page `recordCount` histogram | `{25: 30, 4: 1, 1: 2}` — all pages are page 1; the targeted queries dominate |
| max page reached | **1** |
| top NAF codes | `68.20A` 38, `68.20B` 34, `86.22C` 29, `94.99Z` 24, `47.71Z` 22, `78.20Z` 16, `65.12Z` 15, `35.11Z` 15 |
| `data/raw/businesses-osm.json` | status `ok`, **346** elements, bbox 0.5287–0.6323 / 43.6275–43.6997 (**Auch only**) |
| `data/raw/businesses-web.json` | 3 results: 2 `error`, 1 `ok` (`web:crue-auch`) |
| `data/intermediate/business.json` | **611** business features, 100 % source `sirene` |
| `data/generated/manifest.json` `featureCounts.business` | **611** |
| `data/manifests/sources.json` `businesses-sirene.recordCount` | 755 |

**The department-wide business fetch was never actually run.** `sources.json` claims `businesses-sirene.recordCount: 755` with department 32, but the raw file self-declares `commune: "32013"` and `truncated: true` with a single page per query. Gers has ~30 000+ establishments; **611 businesses for the whole department is ~2 % of reality**, and the truncation is flagged but not acted on.

Note also `sources.json` records `businesses-osm` as `status: "error"` with `recordCount: 0` while `businesses-osm.json` on disk is `status: "ok"` with 346 elements — **the manifest is stale relative to the raw file** and `businesses-web` `recordCount: 3` counts 2 failures as successes.

### 5.3 SIRENE priorities in merge (`normalize.ts:651`)

`official-website` 90 > `sirene` 80 > `annuaire-entreprises` 75 > `osm` 60 > 40. `businesses-osm.json` is consumed at `normalize.ts:730-768` but yields nothing new because its 346 elements are all inside Auch where the 611 SIRENE features already sit, and OSM elements are only merged when a SIRENE record with the same SIRET or a name+≤150 m match exists.

---

## 6. IGN / Admin Express / HTTP cache

- **Admin Express** (`fetch-admin-express.ts:16`): WFS `ADMINEXPRESS-COG.LATEST:departement`, `SRSNAME=EPSG:4326`, `CQL_FILTER=code_insee='32'`, `maxBytes: 16 MiB`. Commune variant at `:31` (`code_insee='32013'`). License **Licence Ouverte / Open Licence 2.0**, edition `LATEST`. Outputs `data/raw/gers-boundary.geojson` + `data/intermediate/boundary-source.json`. This polygon is the clip filter for OSM and BAN.
- **BD TOPO** (`fetch-bdtopo.ts:47-50`): only **4 of 57** GPKG layers are exported — `batiment`, `troncon_de_route`, `surface_hydrographique`, `troncon_hydrographique`. Unused layers (VERIFIED present in the GPKG, `ogrinfo -so`): `troncon_de_voie_ferree`, `route_numerotee_ou_nommee`, `itineraire_autre`, `equipement_de_transport`, `aerodrome`, `cimetiere`, `construction_*`, `reservoir`, `pylone`, `terrain_de_sport`, `cours_d_eau`, `plan_d_eau`, `canalisation`, `ligne_electrique`, `poste_de_transformation`, `erp`, `zone_d_habitation`, **`lieu_dit_non_habite`**, `detail_orographique`, `zone_de_vegetation`, `haie`, `foret_publique`, `parc_ou_reserve`, `voie_nommee`, **`adresse_ban`**, **`batiment_rnb_lien_bdtopo`**, `toponymie`, `arrondissement`, `canton`, `commune`, `epci`, `collectivite_territoriale`, `departement`, `region`, `section_de_points_de_repere`. Several of these are exactly the "missing categories" (rail, aerodrome, cemetery, power lines, sports grounds, public parks, lieux-dits, BAN↔BD TOPO links).
- **`fetch-ign.ts`** only probes WFS **elevation** layers (`ELEVATION.*`, `LIDAR-HD`, `RGEALTI`, keyword `altitude`) at `https://data.geopf.fr/wfs/ows`, `COUNT=5000` (`:83`, `:191`). All 11 raw `ign-*.json` files are **147 bytes** (empty FeatureCollections) and `data/intermediate/ign-unavailable.json` records *"No practical elevation grid is available from IGN Géoplateforme: contour lines were not acquired"*. License recorded as `https://cartes.gouv.fr/cgu` (`:362`) — **not** Licence Ouverte. `normalizeIgn` (`normalize.ts:805-818`) turns IGN WFS features into `building` features, so this script's only conceivable output is more buildings.
- **`http-cache.ts`**: shared `acquireFile` (GET, ETag/If-Modified-Since, 304 handling, streaming sha256, atomic `.part`+rename, `<dest>.cache.json` sidecar) and `acquireJson` (GET or POST, `maxBytes`, in-body cache). Retry: 4 attempts, retryable `{408,425,429,500,502,503,504}`, `Retry-After` honoured capped at 60 s, jittered exponential backoff capped at 30 s. **`fetch-ign.ts` does not use it at all** — it uses bare `fetch` with a 30 s timeout (`:89-96`), so IGN has no caching, no retry, no ETag revalidation. This is the likely cause of the elevation failure being a hard-coded dead end rather than a transient outage.

---

## 7. Value histograms on the Gers extract (VERIFIED, `osmium tags-count -m 1 gers-osm.osm.pbf "k=*"`)

<details><summary>highway (41 values, 145 545 total)</summary>

```
78770 service | 27775 track | 8249 unclassified | 6009 residential | 5900 path | 3814 tertiary
3322 footway | 2655 crossing | 2145 secondary | 1480 stop | 1198 primary | 984 turning_circle
815 give_way | 557 street_lamp | 398 steps | 326 turning_loop | 310 bus_stop | 208 living_street
141 trunk | 103 pedestrian | 62 raceway | 54 mini_roundabout | 49 traffic_signals | 48 trunk_link
42 construction | 41 cycleway | 23 speed_camera | 21 motorway_junction | 9 secondary_link
7 rest_area | 6 bridleway | 5 primary_link | 4 tertiary_link | 3 road | 2 emergency_access_point
2 milestone | 2 traffic_mirror | 1 busway | 1 platform | 1 sign
```
</details>

<details><summary>natural (22 values, 31 465)</summary>

`10590 water | 9991 tree_row | 5322 tree | 2498 wood | 1843 scrub | 988 spring | 78 grassland | 39 heath | 21 shrub | 18 cave_entrance | 18 wetland | 16 beach | 14 stone | 9 cliff | 8 shingle | 3 sand | 3 shrubbery | 2 earth_bank | 2 peak | 1 bare_rock | 1 gorge`
</details>

<details><summary>landuse (28 values, 62 101)</summary>

`21285 forest | 15273 farmland | 11139 meadow | 6855 residential | 4424 vineyard | 868 farmyard | 806 grass | 470 cemetery | 255 orchard | 234 industrial | 70 basin | 68 railway | 66 commercial | 55 retail | 37 greenhouse_horticulture | 30 allotments | 30 flowerbed | 27 construction | 24 military | 19 education | 16 plant_nursery | 10 reservoir | 7 greenfield | 6 quarry | 4 greenery | 4 landfill | 4 recreation_ground | 3 animal_keeping | 3 religious | 2 aquaculture | 2 civic_admin | 1 apiary | 1 brownfield | 1 churchyard | 1 institutional | 1 village_green`
</details>

<details><summary>waterway (11 values, 35 842)</summary>

`23508 stream | 10536 ditch | 751 river | 519 drain | 227 canal | 173 weir | 94 dam | 29 lock_gate | 3 fish_pass | 1 stream_end | 1 waterfall`
</details>

<details><summary>place (14 values, 26 430)</summary>

`17753 isolated_dwelling | 6753 locality | 668 hamlet | 468 village | 437 neighbourhood | 301 square | 23 islet | 10 farm | 5 region | 4 quarter | 2 city_block | 2 suburb | 2 town | 1 island | 1 supranational_union`
</details>

<details><summary>amenity (top 40 of 130 values, 8 805)</summary>

`1974 parking | 831 parking_space | 787 bench | 748 place_of_worship | 462 townhall | 431 recycling | 381 waste_basket | 239 school | 227 grave_yard | 225 restaurant | 206 community_centre | 175 toilets | 149 waste_disposal | 146 post_box | 123 drinking_water | 115 bicycle_parking | 110 shelter | 107 lavoir | 102 post_office | 80 social_facility | 79 fountain | 74 bank | 63 fuel | 59 public_bookcase | 58 charging_station | 58 pharmacy | 53 bar | 50 library | 43 fire_station | 43 vending_machine | 39 cafe | 37 fast_food | 35 car_wash | 34 atm | 33 police | 32 theatre | 26 doctors | 22 marketplace | 22 sanitary_dump_station | 21 water_point`
</details>

<details><summary>shop (68 values, 1 114) / railway (14, 870) / public_transport (4, 349) / building (41 sampled, 316 280)</summary>

`shop`: bakery 82, hairdresser 72, car_repair 69, convenience 56, supermarket 56, clothes 55, alcohol 46, car 46, vacant 36, butcher 33, doityourself 33, gas 31, garden_centre 30, beauty 25 …

`railway`: abandoned 363, disused 134, level_crossing 130, razed 94, rail 76, switch 34, crossing 10, buffer_stop 9, platform 7, stop 6, station 3, halt 1, proposed 1, train_station_entrance 1, turntable 1

`public_transport`: platform 310, stop_position 31, station 7, stop_area 1

`building`: yes 308178, roof 1579, house 912, detached 834, ruins 740, apartments 676, greenhouse 611, church 539, storage_tank 222, school 209, shed 164, silo 145, retail 142, chapel 118, industrial 108, farm_auxiliary 101, garage 98, civic 95, terrace 87 …
</details>

---

## 8. Missing categories — measured, not guessed

`gers-osm.osm.pbf` object counts by single-expression filter, weighted by what the current filter/classifier can never emit:

| category | in Gers extract | reachable today? |
|---|---|---|
| `w/building` | 315 950 | yes via `complete` mode (Auch only); **not** for Gers |
| `r/building` | 314 | dropped by tags-filter? no — dropped by normalizer (no multipolygon reconstruction in bulk path) |
| `w/highway` | 138 252 | only named or 7-path-value subset; 73 318 `highway=service/track/unclassified/…` unnamed-but-valuable ways survive (see delta below) |
| `w/landuse` | 59 740 | no for Gers |
| `r/landuse` | 2 361 | no for Gers |
| `w/natural` | 24 902 | partial (`water`/`wetland` only) |
| `w/waterway` | 34 748 | partial (all `waterway=*` are `water` kind in complete mode) |
| `r/boundary=administrative` | **611** | no — **all 611 commune/admin boundaries discarded**; boundary comes only from Admin Express |
| `r/route` | **189** | no — no bus route relations |
| `w/railway` | **672** | no for Gers (no `kind: transport` in the department) |
| `w/leisure` | 4 146 | no for Gers |
| `w/man_made` | 1 969 | no |
| `n/man_made` | 3 308 | no (this is where `pier`/`breakwater`/`lighthouse` would live) |
| `w/power` | 6 391 | no — no power lines |
| `w/aeroway` | 169 | no |
| `n/place` | 26 105 | yes → `poi` in enrichment mode (26 105 place nodes vs 30 231 names in the enrichment PBF) |
| `n/addr:housenumber` | 17 554 | **no** — OSM addresses entirely dropped; BAN is the only address source |
| `w/addr:housenumber` | (part of 62 096 node closure) | no |
| `w/highway=crossing` | 2 655 | no — no pedestrian crossings |
| `w/highway=construction` | 42 | no |
| `w/highway=traffic_signals` | 49 | no |
| `w/highway=street_lamp` | 557 | no |
| `w/highway=bus_stop` | 310 | no — no transit stops rendered |
| `w/highway=give_way` / `stop` / `turning_circle` | 815 / 1 480 / 984 | no |
| barrier / entrance / traffic_calming (from `osm-bulk.geojson` signatures) | 709 / 103 / 442 | no |

**Named-vs-unnamed road reality (VERIFIED via `osmium tags-count -m 1`):** `gers-osm.osm.pbf` has 145 545 `highway` objects. The 7 ENRICHMENT_HIGHWAYS values sum to 13 030 (`track 27 775` dominates and is *included*, `path 5 900`, `footway 3 322`, `steps 398`, `pedestrian 103`, `cycleway 41`, `bridleway 6`). The remaining named-value roads reach the map only if they carry a `name`. `highway=service` alone is **78 770** objects — farm-track and courtyard services, mostly unnamed, mostly dropped as OSM but supplied instead by BD TOPO `troncon_de_route` (which the Gers road chunks are 100 % made of). This is a defensible design (BD TOPO wins roads), but the OSM road enrichment is then effectively zero-value in the department, while the POI enrichment carries the whole OSM contribution (34 618 POIs, 100 % `osm-bulk`).

---

## 9. Invalid / stale assumptions found (VERIFIED)

1. **"osm-bulk" is not bulk.** The name promises a department-wide mirror; it holds 13 % of the extract's addressable features. `normalizeOsmBulk.ts` is a *classifier*, not a converter: 134 083 of 261 798 features carry none of its 16 keys.
2. **`retention: "complete"` is unreachable for Gers.** Only `AUCH_OSM_CONFIG` (`normalize.ts:102-106`) uses it, and `AUCH_DETAIL_SCOPE` is a single commune. The department's `kind: landuse` and `kind: transport` counts are structurally 0, so the `FEATURE_KINDS` entries `"landuse"` and `"transport"` (`src/lib/data/schema.ts:238`, `:290`) are dead for Gers.
3. **The 14 Overpass themes and `osm.json` are dead on disk.** `normalize.ts:861-862` discards `osm.json` whenever `osm-bulk.geojson` has features; `refresh.ts:157-160` even short-circuits `mergeOverpassThemes` when the bulk file exists. 80 MB+ of raw JSON (14 files + 31 MB `osm.json`) that nothing reads, and `OSM_USE_OVERPASS=1` would re-enable a bbox-based (not polygon-based) fetch — the `poly:""` → `bbox:` rewrite at `fetch-osm.ts:731` means the Overpass path is *not* boundary-exact, so flipping the env var silently changes semantics.
4. **BAN loses 74 records with no trace.** 115 453 in `ban-addresses.json` → 115 379 in `data/intermediate/address*.json`. `normalization-issues.json` holds **111** entries, all schema-validation failures, not address count. There is no input→output reconciliation for addresses.
5. **`address.json` is a chunk, not the dataset.** Six files, 115 379 records, 0 overlap. Grep-by-filename consumers would silently under-read.
6. **`sources.json` disagrees with the raw files.** `businesses-osm` recorded `status: "error"`, `recordCount: 0`; the file on disk is `ok` with 346 elements. `businesses-web` `recordCount: 3` counts 2 errors. `businesses-sirene` `recordCount: 755` labelled department-32 while the file says `commune: 32013`, `truncated: true`.
7. **The department-wide SIRENE fetch never ran**; 611 businesses ≈ 2 % of Gers establishments, `truncated: true`, max page 1.
8. **No geocoding is performed for SIRENE.** Coordinates are copied from the API; `null` coords are silently dropped at `normalize.ts:695` (7 of 755 records already).
9. **BD TOPO: 4 of 57 layers consumed.** Rail (`troncon_de_voie_ferree`, 672 OSM ways show the category is non-empty), aerodromes, cemeteries, power lines, sports grounds, parks/reserves, `lieu_dit_non_habite`, `toponymie`, `adresse_ban` and `batiment_rnb_lien_bdtopo` are all present in the delivered GPKG and unconsumed.
10. **IGN elevation is a hard-coded dead end.** `fetch-ign.ts` uses bare `fetch` (no `http-cache`), requires `ELEVATION.CONTOUR.LINE:courbe` specifically (`:387`), and 11 raw files are 147-byte empty FeatureCollections. `ign-unavailable.json` is written and the pipeline continues — the "unavailable" report is truthful, but the retry/fallback surface is nil.
11. **No cadastral source at all**, and the two layers that would add real geometry (`parcelles`, `lieux_dits`) plus BAN's already-parsed `cad_parcelles` are all unused.
12. **`osmium tags-filter -e` with boolean expressions silently returns 0 objects** in osmium 1.19.1 (verified: `n/place and n/name`, `w/highway=crossing`, `w/natural=tree` all → 0, exit 0). Any future counting or filtering script that reaches for `and`/`or`/`not` will produce confident, wrong zeros. The repo's own `fetch-osm.ts:527-532` does **not** use `-e`, so the pipeline itself is unaffected — but this is a live footgun for QA tooling.

---

## 10. Licences / attribution (VERIFIED from code + manifests)

| source | license string in code | where |
|---|---|---|
| OSM (Geofabrik PBF + enrichment) | `ODbL-1.0` | `normalizeOsmBulk.ts:149`, `:520`; `osm-bulk-manifest.json`; `sources.json` |
| OSM business elements | `Open Database License (ODbL) v1.0` | `fetch-businesses.ts:184`; `normalize.ts:745` (`ODbL-1.0`) |
| BAN | `Etalab-2.0` | `fetch-addresses.ts:19`; `sources.json` |
| SIRENE / Annuaire des Entreprises | `Licence Ouverte / Open Licence 2.0 (ETALAB)` | `fetch-businesses.ts:183` |
| IGN Admin Express COG | `Licence Ouverte / Open Licence 2.0` | `fetch-admin-express.ts:90`; `sources.json` |
| IGN BD TOPO | `Licence Ouverte / Open Licence 2.0` | `bdtopo-manifest.json`; `sources.json` |
| IGN Géoplateforme (fetch-ign) | `https://cartes.gouv.fr/cgu` | `fetch-ign.ts:362` |
| Cadastre Etalab (not used) | Licence Ouverte / Open Licence 2.0 | verified from cadastre.data.gouv.fr |

**Attribution gap:** ODbL requires visible attribution to "© OpenStreetMap contributors". No `sourceRefs[0].license`-driven attribution surface or credit line was found in `src/`; the `MapFeature` schema only carries per-feature `sourceRefs[].license`. Google Maps data: not present anywhere.

---

## 11. Commands used (all read-only)

```
osmium fileinfo -e data/raw/gers-osm.osm.pbf                       # 4 748 117 / 652 835 / 6 294
osmium fileinfo -e data/raw/gers-osm-enrichment.osm.pbf
osmium fileinfo -e -g data.count.{nodes,ways,relations} <filtered>  # 41 single-expression filters
osmium tags-count -m 1 <pbf> highway railway public_transport place amenity shop landuse natural waterway building
osmium tags-count -m 1 <pbf> "highway=*" "natural=*" "landuse=*" …  # 14 value histograms
osmium tags-filter <pbf> <single-expr> -o /tmp/x.pbf -O
ogrinfo -so data/raw/bdtopo/…/BDT_3-5_GPKG_LAMB93_D032-ED2026-06-15.gpkg   # 57 layers
zcat data/raw/adresses-32.csv.gz | wc -l                          # 115 470
node -e '<JSON.parse counts>' data/raw/{ban-addresses,osm-bulk.geojson,businesses-*}.json
grep -ri 'cadastre|etalab' src scripts package.json README.md docs # no matches
read https://cadastre.data.gouv.fr/data/etalab-cadastre/latest/geojson/departements/32/
```
