# master-maps

Interactive 2D WebGPU map of the full Gers department, France, built with Next.js, React Three Fiber, and open data sources. The map renders flat building footprints, roads, water, land use, and POI markers on an orthographic camera. It has no 3D city model, no extruded buildings, and no terrain relief.

## Purpose
A cartographic visualisation of Gers that uses public open-data sources to produce a verified, source-backed department map. Auch remains the primary regression area for commercial search, landmark selection, and corridor audits.

## Visual mode

The map is deliberately two-dimensional. Buildings render as flat footprints at y=0 with holes preserved. Roads merge into continuous ribbons with class-based widths. Water, land use, and parks are filled polygons. POIs appear as batched markers. Camera rotation is in-plane only. Pitch and 3D tilt are not exposed.

Height and building-level metadata remain available in the feature inspector and coverage report, but they never affect visible geometry. The terrain remains flat unless a verifiable IGN elevation source supports a clearly labelled hillshade or contour layer.

## Architecture

```
src/
  app/
    layout.tsx          root server layout with French metadata
    page.tsx            server page, dynamically imports MapShell
    globals.css         design tokens and global styles
    api/map/
      manifest/route.ts serves /api/map/manifest
      tile/[tileId]/    serves /api/map/tile/{tileId}
      search/route.ts   serves /api/map/search?q={query}
  lib/
    data/
      schema.ts         Zod schemas and TypeScript types
      loadTile.ts       tile loader with LRU cache, AbortController
      search.ts         accent-insensitive search with scoring
      provenance.ts     source-priority conflict resolution
      normalize.ts           runtime geometry compatibility API
      deduplicate.ts    stable-ID deduplication
    geo/
      projection.ts     LocalProjection backed by EPSG:2154 Lambert-93
      bounds.ts         2D bounding-box operations
      tiling.ts         deterministic tile assignment
      polygon.ts        ring closure, point-in-polygon, clipping
    scene/
      buildBuildings.ts flat building-footprint geometry builder
      buildRoads.ts     road-ribbon geometry builder
      buildWater.ts     water-polygon geometry builder
      buildLanduse.ts   land-use polygon geometry builder
      buildPois.ts      POI marker geometry builder
      materials.ts      Three.js materials from CSS design tokens
      sceneMetrics.ts   runtime diagnostics counters
  components/map/
    MapShell.tsx         root map shell (tile loading, search, layers)
    WebGPUCityCanvas.tsx async WebGPU renderer initialisation
    CityScene.tsx        flat scene composition
    MapCamera.tsx        orthographic camera controller
    MapControls.tsx      pan, zoom, rotate, HJKL navigation
    MapHud.tsx           heads-up overlay
    SearchPanel.tsx      search with keyboard navigation
    FeatureInspector.tsx selected-feature metadata
    LayerControls.tsx    theme-layer toggles
    SourceAttribution.tsx source and licence footer
    LoadingState.tsx     data-loading state
    WebGPUUnsupported.tsx renderer-failure panel
  types/
    map.ts               MapFeature discriminated union types
scripts/data/
  refresh.ts             full acquisition and generation pipeline
  discover-auch-boundary.ts compatibility entrypoint for the Gers boundary
  fetch-admin-express.ts IGN Admin Express COG department boundary
  fetch-bdtopo.ts        IGN BD TOPO GeoPackage layer exports
  fetch-osm.ts           Geofabrik extract and Overpass enrichment
  fetch-addresses.ts     Base Adresse Nationale (BAN) records
  fetch-businesses.ts    SIRENE, Annuaire des Entreprises, PagesJaunes
  fetch-ign.ts           IGN Geoplateforme WFS layers
  normalize.ts           raw-source to typed features
  normalizeBdtopo.ts     BD TOPO geometry normalization
  normalizeOsmBulk.ts    bulk OSM geometry normalization
  deduplicate.ts         stable-ID deduplication
  build-tiles.ts         LOD tile generation and clipping
  build-search-index.ts  accent-insensitive search index
  qa-spatial.ts          CRS and source-to-render diagnostics
  validate.ts            data validation
tests/
  unit/                  unit tests (projection, bounds, tiling)
  integration/           integration tests (pipeline, corrupt input)
  e2e/                   Playwright E2E tests over Moli CDP
  visual/                visual-state matrix definitions
  fixtures/              checked-in test fixtures
  artifacts/             ignored test output (screenshots, traces)
data/                    ignored department data volume
  raw/                   downloaded source responses
  intermediate/          transformed records
  generated/             tiles, manifest, search index, coverage
  manifests/             source records and coverage reports
  search/                search index
  qa/                    validation reports
  .gitkeep               tracked placeholder
```

**Renderer**: Three.js `WebGPURenderer` via `@react-three/fiber` (R3F) and `@react-three/drei`. The R3F `Canvas` component receives an async `gl` factory that constructs `new WebGPURenderer`, awaits `renderer.init()`, and returns the initialised instance. If `navigator.gpu` is absent, initialisation rejects, or the device is lost, `WebGPUUnsupported.tsx` renders. The renderer never falls back to WebGL.

**Data routes**: Three Next.js App Router routes under `/api/map/` read from the configured `data/` root (`MASTER_MAPS_DATA_DIR`, default `data/`). Routes reject path traversal, bound file size, and return structured `503` with code `DATASET_UNAVAILABLE` when the data volume is missing.

**Diagnostics**: A `#scene-diagnostics` element exposes `renderer-status`, `backend`, `loaded-tile-count`, `loaded-feature-count`, `building-count`, `road-count`, `poi-count`, `draw-calls`, `camera-state`, and `renderer-error` when `NEXT_PUBLIC_MAP_DIAGNOSTICS=1` or the environment is non-production. Throttled snapshots publish from refs, not React state.

**Design tokens**: Three CSS custom properties at `:root` drive all derived colours through opacity and lightness: `--color-accent: #ff7d27` (orange), `--color-ink: #000000`, `--color-paper: #ffffff`. Light and dark themes honour `prefers-color-scheme`. Contrast is verified at WCAG AA (4.5:1 normal text, 3:1 large text) across both themes.

## Data feed sequence

### Fresh acquisition

```bash
npm ci
npm run data:refresh
npm run data:qa
npm run data:validate
npm run typecheck
npm run lint
npm test
npm run build
npm run start
npm run test:e2e
npx tsx scripts/chrome/run-verification.ts
npx tsx scripts/chrome/compare-osm.ts
```

1. `npm ci` installs the locked dependencies.
2. `npm run data:refresh` acquires fresh source data, normalises it, deduplicates it, builds all LODs, builds search, runs spatial QA, and validates the generated volume.
3. `npm run data:qa` reruns the enforceable spatial and scene-input checks.
4. `npm run data:validate` reparses manifests, tile envelopes, features, and search records.
5. `npm run typecheck` runs the strict TypeScript check.
6. `npm run lint` runs ESLint.
7. `npm test` runs unit, visual-state, and integration Vitest suites.
8. `npm run build` creates the production Next.js build.
9. `npm run test:e2e` runs Moli CDP browser tests.
10. `run-verification.ts` checks the real GPU WebGPU canvas.
11. `compare-osm.ts` captures current OpenStreetMap pairs at equivalent views.

### Cached data (no network)

```
npm run data:build
npm run data:validate
```

`npm run data:build` runs `data:refresh --offline`, which uses previously hashed raw responses without network access.

## Source families

All data originates from verified public open-data sources.
| Source | Content | License |
|--------|---------|---------|
| IGN Admin Express COG | Complete Gers department boundary | Licence Ouverte / Open Licence 2.0 |
| IGN BD TOPO | Canonical buildings, roads, hydrographic surfaces, and hydrographic segments | Licence Ouverte / Open Licence 2.0 |
| OpenStreetMap via Geofabrik | Paths, semantic POIs, names, and corroboration | ODbL 1.0 |
| Base Adresse Nationale (BAN) | Department addresses and street names | Etalab Open Licence 2.0 |
| Annuaire des Entreprises and SIRENE | Department business identity and activity data | Licence Ouverte / Open Licence 2.0 |
| Official business pages | Corroborative public business details | Source-specific |

Current source editions and hashes come from `data/manifests/sources.json`. Runtime counts come from the generated coverage report.

Current OpenStreetMap is the visual reference for geographic comparison. Google geometry, tiles, imagery, and bulk Places data are never redistributed.

**Current dataset timestamp**: generated at refresh time and recorded in `data/generated/manifest.json`.
**Completeness definition**: A feature has a validated source reference, stable identity, WGS84 geometry, Lambert-93 local geometry, provenance, and an explicit confidence and status value. The coverage report records actual counts, failures, unresolved optional sources, and measured budgets.

## Licences and attribution

OpenStreetMap is copyright the OpenStreetMap contributors and uses the Open Database Licence (ODbL). French government data uses the applicable open-data licence recorded in the source manifest.

The required OSM attribution appears in `SourceAttribution.tsx`: `(c) OpenStreetMap contributors`.

## Ignored data policy

All raw downloads, intermediate records, generated tiles, manifests, search indexes, QA artifacts, and runtime data live under `data/` and are Git-ignored. The `.gitignore` rule `/data/*` with `!/data/.gitkeep` ensures the directory structure is visible without committing city data. Test artifacts live under `tests/artifacts/` and are also ignored.

The `MASTER_MAPS_DATA_DIR` environment variable overrides the data root. The default value is `data`.

Routes that serve data reject traversal, reject unexpected tile IDs, bound file size, and return structured `503 DATASET_UNAVAILABLE` when the volume is missing. They never fetch arbitrary external URLs or expose credentials.

## Local development commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Next.js development mode |
| `npm run build` | Validate data, then run `next build` |
| `npm run start` | Start production server |
| `npm run typecheck` | TypeScript strict check (`tsc --noEmit`) |
| `npm run lint` | Flat ESLint |
| `npm run test` | Unit, visual-state, and integration Vitest suites |
| `npm run test:unit` | Vitest unit and visual-state tests |
| `npm run test:integration` | Vitest integration tests |
| `npm run test:e2e` | Moli CDP and Playwright E2E tests |
| `npm run data:refresh` | Full acquisition, generation, QA, and validation pipeline |
| `npm run data:qa` | Enforceable spatial and scene-input QA |
| `npm run data:validate` | Validate the generated data volume |
| `npm run data:build` | Build from cached raw inputs |
| `npx tsx scripts/chrome/run-verification.ts` | Real-GPU WebGPU verification |
| `npx tsx scripts/chrome/compare-osm.ts` | Current OpenStreetMap comparison captures |

## Moli requirement

Moli version 1.0.4 is installed on this workstation. The official skills come from `https://github.com/lexmount/moli/tree/main/skills`. This repository does not contain a local `skills/moli-visual-tests/SKILL.md`.

- **Research**: Use `moli fetch --dump markdown <URL>` or `moli fetch --dump semantic_tree_text <URL>`.
- **E2E testing**: Use `moli serve --layout --host 127.0.0.1 --port 9222` and connect Playwright with `chromium.connectOverCDP`.
- **Artifacts**: Store Moli output under `tests/artifacts/moli/`.
- **Policy**: Do not bypass CAPTCHAs, login walls, robots rules, or access controls.
- **Failure**: Report Moli failures. Do not replace Moli with a bundled browser.

## WebGPU requirements

The map renders through the Three.js `WebGPURenderer` backend. The client checks `navigator.gpu` before constructing the canvas. If WebGPU is unsupported, initialisation rejects, or the device is lost, `WebGPUUnsupported.tsx` renders an explicit error panel. The application never silently switches to WebGL.

**Required browser**: Chrome 113+ (or any browser with WebGPU support enabled). The GPU must support WebGPU device creation and shader compilation.

### Known Moli canvas limitation

Moli does not provide the real GPU canvas oracle. Moli E2E checks DOM state, requests, camera diagnostics, and search behavior. Installed Chrome supplies the authoritative WebGPU screenshots and pixel evidence.

## Nocibé search steps

1. Type `Nocibe` or `Nocibé` in the search control labelled `Rechercher dans le Gers`.
2. Select the result. The feature inspector shows the business identity, source references, provenance, and coordinate.
3. The camera focuses through the canonical Lambert-93 local coordinate.
4. The business marker supports hover details when the real WebGPU scene is initialized.
5. Search accepts the unaccented spelling and bounded edit-distance matches.

## Production build procedure

```
npm install
npm run data:refresh        (or npm run data:build for offline)
npm run data:validate
npm run typecheck
npm run lint
npm test
npm run build               (requires validated data volume)
npm run start
```

For deployment, the generated `data/` directory must be packaged alongside the build artifact. The `data/` volume is not committed to Git; it must be separately generated or cached on the deployment target.

## Definition of completeness

A feature is considered complete when it meets six criteria:

1. **Source-backed**: every property has at least one verified source reference.
2. **Stable ID**: a durable internal ID derived from source type, source ID, or a stable hash of content, never from array position or random values.
3. **Geometry**: clipped to the complete Gers department boundary, with finite coordinates, closed rings, and renderable polygons.
4. **Provenance**: every property conflict between sources is recorded in a `ProvenanceRecord` with winner, contenders, and priority rationale.
5. **Status**: each feature has a status distinguishing active, uncertain, inferred, and unresolved values.
6. **WGS84 preservation**: original WGS84 coordinates are preserved alongside local projected coordinates.

The coverage report (`data/manifests/coverage.json`) records actual clipped feature counts per category, source counts with ETags and acquisition timestamps, failed sources with error context, unresolved gaps with explanation, measured tile budgets (size, count), and measured validation results. No count or claim in documentation is estimated from a rectangular query or a genAI hallucination. Every value is copied from the generated coverage report after acquisition.