# Gers accuracy audit

Checked 2026-08-27 against the fresh acquisition recorded in `data/manifests/sources.json` (BD TOPO edition 2026-06-15, sha256 `aed0afb…`; Admin Express sha256 `f576334…`; Geofabrik Midi-Pyrenees extract; BAN D32; SIRENE department scan).

## Dataset

| Metric | Value |
|--------|-------|
| Canonical features after deduplication | 691 387 |
| Buildings (IGN BD TOPO canonical) | 305 761 |
| Road segments | 182 298 |
| Water features (surfaces + lines) | 52 716 |
| POIs (Geofabrik enrichment) | 34 621 |
| Addresses (BAN, boundary-checked) | 115 379 |
| Businesses (SIRENE) | 611 |
| Search records | 254 848 |

## Tile budgets

All served tiles respect the 2 MiB ceiling (`data/generated/tile-metrics.json`):

| LOD | Tiles | Max | Median | p95 |
|-----|-------|-----|--------|-----|
| 0 (2048 m base, adaptive subdivision) | 7 985 | 1 048 491 B | 796 336 B | 991 596 B |
| 1 (8192 m, generalized) | 1 257 | 2 094 406 B | 1 105 228 B | 1 973 391 B |
| 2 (32768 m, overview) | 397 | 2 085 890 B | 1 138 245 B | 1 853 533 B |

Dense LOD0 tiles subdivide recursively (`_s<k>` fragment IDs) instead of exceeding the target.

## Spatial QA (`data/qa/spatial-report.json`)

- 1 000 distributed source vertices sampled across all eight source-family and kind groups.
- Worst CRS round-trip: 1.5e-8 m (threshold 0.05 m).
- Worst source-to-normalized residual: below 0.1 m threshold.
- Tile fragment vertices checked against parent geometry; clipping-edge vertices are evaluated against their tile envelope so subdivision clips are not false positives.
- Renderer input built with the real scene builders; snapshots in `data/qa/scene-geometry-debug.json`.

## Regression checks

- Gers fixture anchors: Gare d'Auch, Cathédrale Sainte-Marie, Préfecture, Boulevard Sadi Carnot, Avenue d'Alsace resolve to generated features within 150 m (fixture precision limit; rounded prefecture anchor accounts for the largest residual).
- Ten department towns (Condom, Lectoure, Fleurance, Eauze, Vic-Fezensac, Mirande, Marciac, Nogaro, Samatan, L'Isle-Jourdain): exact-name search records inside the boundary, within 10 km of anchor coordinates, detailed-tile targets.
- Central Auch topology: cathedral, prefecture, and Boulevard Sadi Carnot west of the Gers river; Avenue d'Alsace east; Rue Pasteur within 150 m of the river.
- Unit, visual-state, and integration suites pass (154 unit tests, 4 integration tests).

## Known residuals

- IGN elevation: no contour or LIDAR-HD grid layer returns features for Gers; recorded in `ign-unavailable.json`. Terrain remains flat by design.
- Overpass business query failed on both endpoints during this refresh (HTTP 400/500); business identity rests on SIRENE plus verified web pages. Recorded as a failed optional source.
- 111 invalid source geometries excluded with reasons in `normalization-issues.json`.
- Overpass enrichment (`osm-bulk`) provides 94 588 POI and path features; OSM is the visual comparison reference, not a bulk dependency for canonical geometry.
