# Gers coverage

Master Maps production coverage is the Gers department, code 32. Auch anchors remain regression checks, not the dataset boundary.

## Spatial coverage

The boundary comes from IGN Admin Express COG. The current stored response is a complete MultiPolygon in EPSG:4326. The pipeline preserves all components and holes.

IGN BD TOPO provides canonical buildings, roads, hydrographic surfaces, and hydrographic segments in Lambert-93 source data. The client receives clipped fragments from detailed 2048 metre tiles and coarser 8192 metre and 32768 metre levels.

OpenStreetMap via Geofabrik provides regional enrichment. BAN provides all department addresses inside the authoritative boundary. SIRENE provides department business identity.

## Regression anchors

The fixture `tests/fixtures/auch-landmark-anchors.json` preserves Gare d'Auch, Cathédrale Sainte-Marie, Boulevard Sadi Carnot, Avenue d'Alsace, and related Auch references. `tests/fixtures/gers-landmark-anchors.json` adds Condom, Lectoure, Fleurance, Eauze, Vic-Fezensac, Mirande, Marciac, Nogaro, Samatan, and L'Isle-Jourdain.

## Verification

`npx tsx scripts/data/qa-spatial.ts` writes the spatial report. It checks EPSG:2154 round trips, source-to-render residuals, and stable-ID tile fragments. Unit tests check CRS conversion, MultiPolygon preservation, tile-edge clipping, tessellation joins, and north-up screen projection.

Google Maps can corroborate relationships around Auch during visual review. Google geometry, tiles, imagery, and bulk Places data do not enter the repository.

## Known source limits

IGN, BAN, SIRENE, and OSM are independently maintained datasets. Their names, update times, classification fields, and object segmentation can differ. The software records those differences and applies field-specific precedence. It does not claim that independent sources always equal Google Maps.
