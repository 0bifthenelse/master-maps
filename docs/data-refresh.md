# Gers data refresh

## Commands

```bash
npm ci
npm run data:refresh
npm run data:qa
npm run data:validate
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npx tsx scripts/chrome/run-verification.ts
npx tsx scripts/chrome/compare-osm.ts
```

`npm run data:refresh` performs an online refresh. `npm run data:build` uses cached raw files and skips network acquisition. Offline mode never proves current source data.

## Pipeline order

1. `fetch-admin-express.ts` writes the complete Gers boundary and its source record.
2. `fetch-bdtopo.ts` discovers the current official D032 package from IGN catalog metadata. It inspects the archive with `ogrinfo` and exports four required canonical layers.
3. `fetch-osm.ts` downloads the current Geofabrik regional extract and uses Osmium for Gers enrichment.
4. `fetch-addresses.ts` downloads BAN D32 and applies complete-boundary containment.
5. `fetch-businesses.ts` queries department establishments and records corroborative sources.
6. `normalize.ts` creates canonical WGS84 and Lambert-93 feature records.
7. `deduplicate.ts` performs exact-ID merging and conservative metric conflation.
8. `build-tiles.ts` writes LOD0, LOD1, and LOD2 tiles.
9. `build-search-index.ts` writes canonical feature IDs with detailed tile targets.
10. `qa-spatial.ts` checks distributed source vertices, CRS round trips, normalized geometry, tile fragments, and scene-builder input.
11. `validate.ts` parses the final data volume and fails on contract or budget errors.

The refresh fails when required acquisition or generation data is absent. Optional IGN elevation failures are written to `data/intermediate/ign-unavailable.json` and `data/manifests/sources.json`.

## Generated outputs

- `data/manifests/sources.json` records source editions, timestamps, licenses, CRS values, hashes, counts, and failed optional sources.
- `data/manifests/coverage.json` records feature counts, source counts, and measured tile budgets.
- `data/generated/manifest.json` records territory, CRS, render origin, LOD levels, and local tile bounds.
- `data/generated/tile-manifest.json` records each tile, feature count, fragment IDs, and payload bytes.
- `data/generated/tile-metrics.json` records maximum, median, and p95 payload bytes by LOD.
- `data/search/index.json` records canonical searchable feature IDs, focus coordinates, and detailed tile IDs.
- `data/qa/spatial-report.json` records distributed samples, worst errors, offending IDs, source statistics, and render preparation counts.
- `data/qa/scene-geometry-debug.json` exports bounded Three.js geometry snapshots from the scene builders.

## Spatial QA thresholds

`qa-spatial.ts` requires at least 1000 distributed source vertices. The Lambert-93 round-trip error must stay below 0.05 metres. Source-to-normalized and non-clipping tile residuals must stay below 0.10 metres. Road source segments come from consecutive input vertices and the builder reports every segment used for rendering.

The command exits nonzero when a threshold fails. Pass a stable ID to inspect its source geometry, local geometry, tile fragments, and render preparation.

## Operational limits

The client requests the initial LOD2 overview working set. It does not preload detailed Gers tiles. It tracks loaded and in-flight tiles separately, aborts stale requests, keeps the previous working set until replacement data arrives, and prunes stale tiles after the transition.

All served LOD tiles stay below the 2 MiB payload ceiling. LOD0 targets about 1 MiB and adaptively subdivides dense tiles. LOD1 and LOD2 contain generalized and filtered geometry rather than copies of LOD0.

## Browser roles

Moli provides browser navigation, DOM inspection, request counts, search, pan, zoom, reset, keyboard, and OpenStreetMap navigation through its official CDP server skill. Moli does not prove hardware WebGPU pixels.

Installed Chrome provides the visual oracle. `run-verification.ts` checks the real adapter, renderer initialization, draw calls, visible feature counts, console errors, page errors, and screenshots. `compare-osm.ts` captures Master Maps and current OpenStreetMap at matching WGS84 locations and equivalent ground spans.
