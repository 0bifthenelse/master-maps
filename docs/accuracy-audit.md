# Gers accuracy audit

Two acquisitions are in play, so read this page as two snapshots rather than one.

The audited acquisition is dated 2026-08-27 and is recorded in `data/manifests/sources.json` (BD TOPO edition 2026-06-15, sha256 `aed0afb…`; Admin Express sha256 `f576334…`; Geofabrik Midi-Pyrenees extract; BAN D32; SIRENE department scan).

The current generated volume is newer. `data/qa/source-reconciliation-audit.json` records the canonical store as of 2026-09-27 with 979 766 records. The counts below are grouped by which file owns them.

## Audited acquisition, 2026-08-27 (`data/manifests/coverage.json`)

| Metric | Value |
|--------|-------|
| Canonical features after deduplication | 691 340 |
| Buildings (IGN BD TOPO canonical) | 305 761 |
| Road segments | 182 254 |
| Water features (surfaces + lines) | 52 716 |
| POIs (Geofabrik enrichment) | 34 618 |
| Addresses (BAN, boundary-checked) | 115 379 |
| Businesses (SIRENE) | 611 |

## Current generated volume, 2026-09-27 (`data/qa/coverage-report.json`)

| Metric | Value |
|--------|-------|
| Canonical features | 979 728 |
| Buildings | 330 091 |
| Roads | 196 362 |
| Addresses | 116 538 |
| Places | 92 158 |
| Businesses | 84 599 |
| Water | 63 276 |
| Land use | 46 097 |
| POIs | 41 296 |
| Structures | 6 891 |
| Transport | 2 419 |
| Search records (index array count) | 427 293 |

The audited acquisition and the current volume do not reconcile. `data/qa/validation-report.json` matches no kind between the generated store and the coverage manifest and records 4 849 issues, including duplicate fragment identities inside tiles.

## Tile budgets

All served tiles respect the 2 MiB ceiling (`data/generated/tile-metrics.json`):

| LOD | Tiles | Whole tile max | Whole tile median | Whole tile p95 | Render max | Render median | Render p95 |
|-----|-------|----------------|-------------------|---------------|------------|---------------|------------|
| 0 (2048 m base, adaptive subdivision) | 5 386 | 1 047 445 B | 433 863 B | 924 654 B | 516 560 B | 130 003 B | 328 480 B |
| 1 (8192 m, generalized) | 1 747 | 2 096 575 B | 798 811 B | 1 729 763 B | 621 226 B | 196 570 B | 439 419 B |
| 2 (32768 m, overview) | 269 | 2 088 201 B | 716 532 B | 1 994 729 B | 411 241 B | 123 050 B | 379 470 B |

Render and whole-tile figures come from the same file: the render fields describe the payload slab, the other three columns add the per-tile metadata sidecar. Dense LOD0 tiles subdivide recursively (`_s<k>` fragment IDs) instead of exceeding the target.

## Spatial QA (`data/qa/spatial-report.json`)

- 1 000 distributed source vertices sampled across all eight source-family and kind groups, 125 vertices each.
- Worst CRS round-trip: 1.5e-8 m (threshold 0.05 m).
- Worst source-to-normalized residual: 1.3e-8 m (threshold 0.1 m).
- Worst tile render residual: 3.2e-12 m over 72 433 tile fragment vertices; clipping-edge vertices are evaluated against their tile envelope so subdivision clips are not false positives.
- 3 251 925 normalized comparisons, zero unexplained road segments.
- Renderer input built with the real scene builders; snapshots in `data/qa/scene-geometry-debug.json`.

## Regression checks

- Gers fixture anchors: Gare d'Auch, Cathédrale Sainte-Marie, Préfecture, Boulevard Sadi Carnot, Avenue d'Alsace resolve to generated features within 150 m (fixture precision limit; rounded prefecture anchor accounts for the largest residual). See `tests/fixtures/gers-landmark-anchors.json` and `tests/integration/gers-pipeline.test.ts`.
- Ten department towns (Condom, Lectoure, Fleurance, Eauze, Vic-Fezensac, Mirande, Marciac, Nogaro, Samatan, L'Isle-Jourdain): exact-name search records inside the boundary, within 10 km of anchor coordinates, detailed-tile targets.
- Central Auch topology: cathedral, prefecture, and Boulevard Sadi Carnot west of the Gers river; Avenue d'Alsace east; Rue Pasteur within 150 m of the river.
- The suites are `tests/unit` (664 cases), `tests/visual` (4 cases), and `tests/integration` (22 cases across 4 files). Counts are static `it()` sites, not a record of a passing run.

## Known residuals

- IGN elevation: no contour or LIDAR-HD grid layer returns features for Gers; recorded in `data/intermediate/ign-unavailable.json`. Terrain remains flat by design.
- Overpass business query failed during this refresh (HTTP 500); business identity rests on SIRENE plus verified web pages. Recorded as a failed optional source in `data/manifests/sources.json`.
- 111 invalid source geometries excluded, recorded in the same `failedSources` list. The exclusion report itself records zero invalid geometry in the current volume, so the two statements describe different runs.
- Overpass enrichment (`osm-bulk`) provides 94 585 POI and path features in the audited acquisition; OSM is the visual comparison reference, not a bulk dependency for canonical geometry.
- The reconciliation audit does not account the canonical store: it records an unattributed residual of 941 659 records, zero blocking cross-check failures, and 25 advisory disagreements. See `data/qa/source-reconciliation-audit.json`.
