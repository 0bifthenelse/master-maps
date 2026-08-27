# Master Maps architecture

## Scope

Master Maps renders the complete Gers department, code 32. Auch is the primary regression area, but the dataset and search index cover the entire department.

## Coordinate contract

Source geometry uses WGS84 longitude and latitude, EPSG:4326. Metric processing uses Lambert-93, EPSG:2154, through `src/lib/geo/crs.ts` and `proj4`.

Render coordinates use `[x, z] = [easting - originEasting, northing - originNorthing]`. Three.js receives `[x, y, z]`, with x east, z north, and y scene elevation. `src/lib/data/territory.ts` owns the territory code, source files, render origin, and tile sizes.

No application code implements a second geographic projection. Metric distances, centroids, clipping, conflation, tessellation bounds, and QA use Lambert-93 or local Lambert coordinates.

## Data flow

1. `fetch-admin-express.ts` acquires the complete Admin Express COG department MultiPolygon.
2. `fetch-bdtopo.ts` queries the official IGN catalog, selects the newest D032 GPKG edition, verifies the archive with `ogrinfo`, and exports canonical layers.
3. `fetch-osm.ts` downloads the current Geofabrik Midi-Pyrenees extract and uses Osmium to extract Gers enrichment data.
4. `fetch-addresses.ts` acquires all BAN D32 addresses and checks each position against every boundary component.
5. `fetch-businesses.ts` acquires department SIRENE records and records optional OSM and public-page results.
6. `normalize.ts` parses source geometry, preserves source coordinates, derives local Lambert geometry, and validates every feature with `MapFeatureSchema`.
7. `deduplicate.ts` merges only exact identities or conservative metric matches. It retains all source references and provenance.
8. `build-tiles.ts` writes detailed 2048 metre base tiles and adaptively subdivides dense tiles, plus generalized 8192 metre tiles and overview 32768 metre tiles.
9. `build-search-index.ts` writes one canonical search identity with a detailed tile target.
10. `qa-spatial.ts` checks distributed source vertices, tile fragments, and scene-builder input.
11. `validate.ts` parses manifests, envelopes, features, and search records again before success.

## Geometry rules

IGN BD TOPO supplies canonical buildings, roads, and hydrographic geometry. The road layer is `troncon_de_route`. Hydrographic surfaces use `surface_hydrographique`. Linear hydrography uses `troncon_hydrographique`. The actual `fictif` field is parsed explicitly. Fictive axes remain source metadata and are not rendered as visible water lines.

A tile receives every feature whose local bounds intersect the tile. Lines use a small width-aware context bleed. Polygons clip at the tile edge while preserving holes and MultiPolygon components. Each tile representation has a deterministic `fragmentId`. `stableId` remains the canonical search identity, and clipped fragments also carry `parentStableId` and `fragmentOf`.

Roads use separate tunnel, normal, and bridge strata. Strata render in deterministic order. MultiLineString components remain independent. The polyline tessellator bounds acute joins and pinches near reversals instead of generating unbounded miters.

## Level of detail

LOD0 keeps source-faithful detail. LOD1 removes small buildings, minor paths, and subpixel points, then simplifies surviving geometry with a two metre tolerance. LOD2 keeps the boundary, major roads, primary hydrography, important land use, and settlement or landmark labels with a 25 metre tolerance. LOD0 geometry is never replaced by generalized geometry.

Every served tile stays below the two MiB payload ceiling. LOD0 targets about one MiB and adaptively subdivides dense tiles. The build writes per-LOD maximum, median, and p95 byte metrics.

## Client streaming

The client loads the manifest and search index first. Initial streaming selects only LOD2 overview tiles. Later selection uses the actual orthographic frustum width and height, divides by camera zoom, and computes the axis-aligned enclosing bounds after heading rotation.

In-flight requests live in a separate map from loaded tiles. A changed desired key aborts only stale requests. The previous working set stays visible until one replacement tile arrives. The client then prunes tiles outside the new working set. Search loads its detailed target tile directly and focuses through local geometry.

## API surface

- `GET /api/map/manifest` returns a Zod-validated dataset manifest with LOD and tile metadata.
- `GET /api/map/tile/{tileId}` returns a Zod-validated `TileData` envelope.
- `GET /api/map/search?q={query}` returns Zod-validated canonical search records.

The routes read only the configured generated data root. Tile identifiers reject traversal and unexpected characters. Missing data returns `DATASET_UNAVAILABLE`. Invalid generated data returns `DATASET_INVALID`.

## Verification

Moli provides CDP browser navigation, DOM inspection, request observation, search, pan, zoom, and OpenStreetMap navigation. Moli is not the pixel oracle for WebGPU.

`scripts/chrome/run-verification.ts` launches installed Chrome with the real GPU path, verifies `navigator.gpu`, initializes `WebGPURenderer`, checks draw and visible feature counts, and captures screenshots. It never disables GPU or uses a WebGL fallback.
