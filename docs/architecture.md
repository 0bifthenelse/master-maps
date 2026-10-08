# Master Maps architecture

## Scope

Master Maps renders the complete Gers department, code 32. Auch is the primary regression area, but the dataset and search index cover the entire department.

## Coordinate contract

Source geometry uses WGS84 longitude and latitude, EPSG:4326. Metric processing uses Lambert-93, EPSG:2154, through `src/lib/geo/crs.ts` and `proj4`.

Render coordinates use `[x, z] = [easting - originEasting, northing - originNorthing]`. Three.js receives `[x, y, z]`, with x east, z north, and y scene elevation. `src/lib/data/territory.ts` owns the territory code, source files, render origin, and tile sizes.

No application code implements a second geographic projection. Metric distances, centroids, clipping, conflation, tessellation bounds, and QA use Lambert-93 or local Lambert coordinates.

## Data flow

1. `fetch-admin-express.ts` acquires the complete Admin Express COG department MultiPolygon.
2. `fetch-bdtopo.ts` queries the official IGN catalog, selects the newest D032 GPKG edition, verifies the archive with `ogrinfo`, and exports canonical layers, including all 458 Gers communes and every inhabited place.
3. `fetch-osm.ts` downloads the daily Gers extract from openstreetmap.fr (Geofabrik Midi-Pyrénées as a fallback) and uses Osmium to export the tagged objects the map uses.
4. `fetch-addresses.ts` acquires all BAN D32 addresses and checks each position against every boundary component.
5. `fetch-businesses.ts` partitions SIRENE by commune and activity section, keeps active, publicly listed establishments, and places those without coordinates on their exact BAN address, a neighbouring number, a compact street, or their BD TOPO lieu-dit. The HTTP cache replays a full acquisition in seconds; the rate limiter only paces real requests.
6. `normalize.ts` parses source geometry, derives local Lambert geometry, maps every OSM tag, NAF code and BD TOPO nature onto one category taxonomy (`src/lib/data/categories.ts`), drops non-place NAF activities, and validates every feature with `MapFeatureSchema`. Ways and areas wholly inside the department skip the exact boundary clip.
7. `conflate.ts` merges an OSM place and a SIRENE establishment with the same name within 150 m: OSM keeps the position, hours, phone and website, SIRENE adds the legal identity.
8. `deduplicate.ts` merges only exact identities or conservative metric matches. It retains all source references and provenance.
9. `build-tiles.ts` writes detailed 2048 metre base tiles and adaptively subdivides dense tiles, plus generalized 8192 metre tiles and overview 32768 metre tiles.
10. `build-search-index.ts` writes one record per thing people look for (see Search).
11. `qa-spatial.ts` and `validate.ts` check the output; `scripts/qa/benchmark-gers.ts` measures coverage (`docs/coverage-benchmark.md`).

## Geometry rules

IGN BD TOPO supplies canonical buildings, roads, and hydrographic geometry. The road layer is `troncon_de_route`; its class comes from `importance`, the administrative class and the nature (motorway, national, departmental, local, residential, track, path), and its number from `cpx_numero`. Hydrographic surfaces use `surface_hydrographique`. Linear hydrography uses `troncon_hydrographique`. Fictive axes remain source metadata and are not rendered as visible water lines.

A tile receives every feature whose local bounds intersect the tile. Lines use a small width-aware context bleed. Polygons clip at the tile edge while preserving holes and MultiPolygon components. Each tile representation has a deterministic `fragmentId`. `stableId` remains the canonical search identity, and clipped fragments also carry `parentStableId` and `fragmentOf`.

## Level of detail

LOD0 keeps source-faithful detail. LOD1 keeps buildings of 1,500 m² and more, roads down to local connectors, and every commune; LOD2 keeps the boundary, major roads, large water and land use, and the main places. LOD0 geometry is never replaced by generalized geometry. Every served tile stays below the two MiB payload ceiling.

## Render tile format

`src/lib/render/codec.ts` owns the MMT2 container: a 12-byte prefix (`0x4d4d5431` magic, format version 2, header length), a JSON header, and one contiguous payload slab. Each layer holds an interleaved Float32 vertex section, a Uint32 triangle index section, a feature range section and optional roof-outline edges:

- fill layers: `x, y, z, style`
- line layers: `x, y, z, extrudeX, extrudeZ, halfWidth, style, distance` — the centreline plus a miter-scaled extrusion vector, widened per frame in the shader so a road keeps a readable width at the overview and its true width up close
- extrusions: `x, y, z, height, style`

A range row is `indexStart, indexCount, metaIndex, vertexStart, vertexCount`. The encoder rejects any triangle that reaches outside its own feature's vertices, which rules out the cross-feature spikes of the earlier merged batches. Point features (places, addresses, POIs, businesses) live only in the metadata table; the overlay draws them. See `src/lib/render/buildRenderTile.ts`.

## Client

The renderer is three.js `WebGLRenderer` through React Three Fiber, with `frameloop="demand"`, so it runs in every current browser.

- `src/lib/map/transform.ts` is the camera model: centre, zoom (`metresPerPixel = 113 288 / 2^zoom`), bearing clockwise from north and pitch up to 60°. It owns the perspective camera, screen ↔ map conversion, the visible ground footprint and the anchored operations (`zoomAround`, `rotateAround`, `setLocationAtPoint`). All map content sits under one `scale(1, 1, -1)` group so north is up without a mirrored projection.
- `src/lib/map/controller.ts` turns pointer, wheel, touch and keyboard input into transform changes: drag pan with inertia, cursor-anchored wheel zoom (eased for mouse notches, immediate for trackpads), right/ctrl-drag rotate and tilt, two-finger pinch, twist and tilt, double-click/tap zoom, and `easeTo`, `flyTo` (van Wijk) and `fitBounds`.
- `src/components/map/tileScheduler.ts` plans tiles from the footprint polygon with a separating-axis test, keeps coarse tiles until fine ones arrive, and prefetches a ring.
- `src/lib/render/tileMaterials.ts` and `tileGeometry.ts` build one mesh per tile and layer with shader materials (screen-aware line width, casings, dashes, building shading with luminous roof edges). `src/components/map/SatelliteLayer.tsx` warps IGN orthophoto WMTS tiles into Lambert-93.
- `src/components/map/overlay/OverlayRenderer.ts` draws a 2D canvas over the map each frame: upright labels with collision, street names along their road, road-number shields, category markers, house numbers, hover and the selection brackets.
- The HUD lives in `src/components/map/hud/` (search console, dossier, navigation cluster, layer dock, telemetry, context menu, boot sequence, shortcuts) and `MapShell.tsx` wires it together, including the `#map=zoom/lat/lon/bearing/pitch` URL hash.

## Search

`scripts/data/build-search-index.ts` writes records for communes (ranked by population), hamlets and named places, streets merged per commune with their extent, road numbers merged across the department, every BAN address as "12 bis Rue X" in "32000 Auch", businesses, POIs, stations, named buildings and areas, and rivers. Each record carries its commune, postcode, street, category, anchor and extent; duplicates across sources collapse into the richest record.

`src/lib/data/searchEngine.ts` reduces each record to field-tagged tokens (name, aliases, street, commune, codes, category words, house number) using the shared tokenizer in `src/lib/data/search.ts`, which folds accents, hyphens and apostrophes, expands abbreviations (St → Saint, Av → Avenue) and joins road numbers (D 930 → D930). A query matches when every word matches some token exactly, by plural, by prefix while typing or within one or two typos; ranking combines match quality, name coverage, importance and distance from the view. A bare category ("pharmacies", "boulangerie") lists that category nearest first, with brands such as "leclerc" grouped ahead.

## API surface

- `GET /api/map/manifest` returns a Zod-validated dataset manifest with LOD and tile metadata.
- `GET /api/map/render/{tileId}` returns one MMT2 render tile.
- `GET /api/map/tile/{tileId}` returns a Zod-validated `TileData` envelope (the dossier reads full records from it).
- `GET /api/map/search?q={query}&near={x},{z}&limit={n}` returns ranked hits with context, anchor and extent.
- `GET /api/map/search?category={id}&near={x},{z}&radius={m}` lists a category family around a point.

The routes read only the configured generated data root. Tile identifiers reject traversal and unexpected characters. Missing data returns `DATASET_UNAVAILABLE`. Invalid generated data returns `DATASET_INVALID`.

## Verification

`npm test` runs the unit suite (camera math, codec, tile building, scheduler, search, taxonomy, pipeline). `npm run test:e2e` starts the production server (run `npm run build` first) and runs the Playwright specs in `tests/e2e/` against a Moli CDP browser when one is available, otherwise against the local Chromium with SwiftShader WebGL. The specs check rendering, cursor-anchored zoom at several bearings and tilts, drag, rotation, tilt, keyboard panning, URL views, satellite mode, the phone layout and search, and `screenshots.spec.ts` captures the reference views.
