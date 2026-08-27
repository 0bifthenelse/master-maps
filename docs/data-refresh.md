# Gers data refresh

## Commands

```bash
npm run data
npm run data:qa
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

`npm run data` performs an online refresh. `npm run data:build` uses cached raw files and skips network acquisition. Do not use offline mode as proof of current source data.

## Pipeline order

1. `fetch-admin-express.ts` writes `data/raw/gers-boundary.geojson` and its source record.
2. `fetch-bdtopo.ts` downloads the current official D032 package, extracts the GeoPackage, and writes required layer exports.
3. `fetch-osm.ts` downloads the current Geofabrik regional extract, clips it with Osmium, and writes OSM enrichment data.
4. `fetch-addresses.ts` downloads BAN D32 and applies complete-boundary containment.
5. `fetch-businesses.ts` queries department establishments and verified business sources.
6. `normalize.ts` derives Lambert-93 render coordinates and writes intermediate features.
7. `deduplicate.ts` performs conservative cross-source conflation.
8. `build-tiles.ts` writes the LOD tile pyramid.
9. `build-search-index.ts` writes spatial search records.
10. `validate.ts` checks final generated data.

The refresh fails when a required source or output is absent. It does not convert a failed acquisition into an empty successful dataset.

## Generated outputs

- `data/manifests/sources.json` records source URL, edition, license, CRS, hash, timestamp, and record count.
- `data/generated/manifest.json` records territory, CRS, render origin, LOD levels, and tile bounds.
- `data/generated/tile-manifest.json` records each tile and its byte size.
- `data/search/index.json` records searchable feature IDs, focus coordinates, and tile IDs.
- `data/qa/spatial-report.json` records CRS and source-to-render measurements.

## Source diagnostics

Run `npx tsx scripts/data/qa-spatial.ts <stable-id>` to print source coordinates, normalized coordinates, tile fragments, and render anchor data for one feature. The command also samples up to 1000 source vertices and reports the worst round-trip and render residual.

## Operational limits

The client loads visible tiles plus one margin. It does not load the full department at startup. Tile count can grow with territory coverage. The working-set limit belongs to the client LRU and per-tile byte budget, not to a global tile count.
