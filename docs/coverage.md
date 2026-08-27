# Gers coverage

Master Maps covers the complete Gers department, code 32. Auch provides the tightest regression checks, not the dataset boundary.

## Spatial coverage

IGN Admin Express COG supplies the department MultiPolygon in EPSG:4326. The normalizer preserves every component and hole. BAN positions, OSM enrichment, and BD TOPO geometry use the complete boundary rather than the Auch bounding box.

IGN BD TOPO supplies canonical `batiment`, `troncon_de_route`, `surface_hydrographique`, and `troncon_hydrographique` records. LOD0 detailed tiles retain source geometry. LOD1 and LOD2 filter subpixel detail and simplify only their local geometry.

Geofabrik OSM enrichment supplies paths and named semantic POIs. SIRENE supplies department business identity. Source references and property provenance remain on every canonical feature.

## Regression locations

The Gers fixture `tests/fixtures/gers-landmark-anchors.json` covers Gare d'Auch, Cathédrale Sainte-Marie, the Préfecture, Boulevard Sadi Carnot, and Avenue d'Alsace as Auch regressions, plus Condom, Lectoure, Fleurance, Eauze, Vic-Fezensac, Mirande, Marciac, Nogaro, Samatan, and L'Isle-Jourdain as department references.

The integration suite resolves generated search records and source-backed anchors when the local data volume exists. It checks boundary containment, detailed tile targets, central river-side relationships, and Rue Pasteur proximity.

## Verification

`npm run data:qa` writes `data/qa/spatial-report.json`. It samples at least 1000 vertices across source families and feature kinds. It checks Lambert-93 round trips below 0.05 metres, normalized residuals below 0.10 metres, tile fragment residuals below 0.10 metres, and road segment traceability.

`data/qa/scene-geometry-debug.json` contains bounded snapshots from the real Three.js building, road, and water builders. `data/generated/tile-metrics.json` contains per-LOD maximum, median, and p95 payload sizes.

Moli checks browser requests, search, pan, zoom, reset, keyboard directions, stale-request aborts, and current OpenStreetMap navigation. Installed Chrome with the real GPU checks WebGPU adapter creation, renderer initialization, draw calls, visible counts, console errors, page errors, and screenshots. `compare-osm.ts` captures equal-viewport Master Maps and current OpenStreetMap reference pairs.

## Known source differences

IGN, BAN, SIRENE, and OSM use different update schedules and object segmentation. Names, classifications, bridges, and building outlines can differ between sources. The software records those differences and does not merge objects without identity and metric evidence.

OpenStreetMap is the visual reference for geographic comparison. Google geometry, tiles, imagery, and bulk Places data do not enter the repository.
