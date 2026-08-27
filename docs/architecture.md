# Master Maps architecture

## Scope

Master Maps renders the complete Gers department, code 32. Auch remains a regression area and a normal searchable location. The production boundary comes from IGN Admin Express COG.

## Coordinate contract

Source interchange geometry uses WGS84, EPSG:4326, with coordinates ordered as longitude and latitude. Metric processing uses Lambert-93, EPSG:2154, through `src/lib/geo/crs.ts` and the maintained `proj4` package.

Render coordinates use `[x, z] = [easting - originEasting, northing - originNorthing]`. The Three.js contract is `[x, y, z]`, where x is east, z is north, and y is scene elevation. `src/lib/data/territory.ts` is the only territory configuration.

## Data flow

1. `fetch-admin-express.ts` acquires the complete department boundary.
2. `fetch-bdtopo.ts` acquires the per-department IGN GeoPackage and exports required layers for WGS84 interchange.
3. `fetch-osm.ts` acquires the current Geofabrik Midi-Pyrenees extract. Osmium clips the extract to Gers and retains paths and named points for enrichment.
4. `fetch-addresses.ts` keeps all BAN D32 positions inside the department geometry.
5. `fetch-businesses.ts` queries the department and preserves SIRET identity.
6. `normalize.ts` retains source geometry and derives Lambert-93 render geometry.
7. `deduplicate.ts` applies conservative cross-source conflation and field-specific precedence.
8. `build-tiles.ts` creates 2048 metre, 8192 metre, and 32768 metre tile levels.
9. `build-search-index.ts` stores a feature tile reference and WGS84 focus coordinate.
10. `validate.ts` checks final data invariants.

## Geometry rules

IGN BD TOPO supplies canonical building, road, and hydrographic geometry. BAN supplies address identity and position. SIRENE supplies legal business identity. OSM supplies paths, names, POI detail, and corroboration.

A tile receives every feature whose complete render bounds intersect that tile. Lines and polygons are clipped to tile bounds. Each fragment keeps its parent stable ID. A MultiLineString component is tessellated independently.

Wide hydrographic surfaces use polygon geometry. A fictive hydrographic axis does not create a second synthetic river ribbon. Linear waterways use the bounded continuous tessellator in `src/lib/scene/tessellatePolyline.ts`.

## Client streaming

The client loads the manifest and search index first. It then selects visible tiles from camera target, zoom, and viewport size. It loads one tile margin, limits concurrent requests, aborts stale requests, and removes tiles outside the working set. The tile loader owns the LRU cache.

## API surface

- `GET /api/map/manifest` returns territory, CRS, render origin, LOD, and tile metadata.
- `GET /api/map/tile/{tileId}` returns one tile envelope.
- `GET /api/map/search` returns search records with tile references.

The APIs read only the configured generated data root. Tile identifiers reject path traversal.
