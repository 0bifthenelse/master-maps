# Gers coverage

Master Maps covers the complete Gers department, code 32. Auch provides the tightest regression checks, not the dataset boundary.

## Spatial coverage

IGN Admin Express COG supplies the department MultiPolygon in EPSG:4326. The normalizer preserves every component and hole. BAN positions, OSM enrichment, and BD TOPO geometry use the complete boundary rather than the Auch bounding box.

IGN BD TOPO supplies canonical `batiment`, `troncon_de_route`, `surface_hydrographique`, and `troncon_hydrographique` records. LOD0 detailed tiles retain source geometry. LOD1 and LOD2 filter subpixel detail and simplify only their local geometry.

OpenStreetMap supplies service roads, paths, and named shops, amenities and landmarks with their details. SIRENE supplies department business identity, merged with the OSM place when both describe the same shop. Source references and property provenance remain on every canonical feature.

`data/qa/coverage-report.json` samples the department on an 8 by 8 grid. Its report records 32 grid cells intersecting the department and every adopted kind present in all 32 cells, except transport with 31.

## Regression locations

The Gers fixture `tests/fixtures/gers-landmark-anchors.json` covers Gare d'Auch, Cathédrale Sainte-Marie, the Préfecture, Boulevard Sadi Carnot, and Avenue d'Alsace as Auch regressions, plus Condom, Lectoure, Fleurance, Eauze, Vic-Fezensac, Mirande, Marciac, Nogaro, Samatan, and L'Isle-Jourdain as department references.

The integration suite resolves generated search records and source-backed anchors when the local data volume exists. It checks boundary containment, detailed tile targets, central river-side relationships, and Rue Pasteur proximity. See `tests/integration/gers-pipeline.test.ts`.

## Verification

`npm run data:qa` writes `data/qa/spatial-report.json`. It samples at least 1000 vertices across source families and feature kinds. It checks Lambert-93 round trips below 0.05 metres, normalized residuals below 0.10 metres, tile fragment residuals below 0.10 metres, and road segment traceability.

`data/qa/scene-geometry-debug.json` contains bounded snapshots from the real Three.js building, road, and water builders. `data/generated/tile-metrics.json` contains per-LOD maximum, median, and p95 payload sizes, split between the render payload and the metadata sidecar.

`npm run test:e2e` runs `scripts/moli/run-e2e.ts`, which runs the Playwright specs for rendering, navigation and search against the production server. `npm run qa:benchmark` writes `docs/coverage-benchmark.md`. `npm run compare:osm` runs `scripts/chrome/compare-osm.ts`, which captures equal-viewport Master Maps and current OpenStreetMap reference pairs.

## Coverage limits

`data/qa/source-reconciliation-audit.json` does not account the canonical store. It records an unattributed residual of 941 659 records, zero blocking cross-check failures, and 25 advisory disagreements.

`data/qa/stratified-report.json` is a partial read. It sampled 4 tiles against a target of 50, and it read an older manifest that lacked the landuse, transport, structure, and place kinds, so its per-stratum expected-kind checks report false failures.

`data/qa/runtime-verification.json` does not confirm feature picking: no mesh sat under any of the 12 probed canvas points, so no right-click opened a feature context menu.

## Known source differences

IGN, BAN, SIRENE, and OSM use different update schedules and object segmentation. Names, classifications, bridges, and building outlines can differ between sources. The software records those differences and does not merge objects without identity and metric evidence.

OpenStreetMap is the visual reference for geographic comparison. Google geometry, tiles, imagery, and bulk Places data do not enter the repository.
