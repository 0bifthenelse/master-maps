# master-maps

Interactive 2D WebGPU map of Auch (Gers, France) built with Next.js, React Three Fiber, and open data sources. The map renders flat building footprints, roads, water, land use, and POI markers on an orthographic camera. It has no 3D city model, no extruded buildings, and no terrain relief.

## Purpose

A cartographic visualisation of Auch that uses public open-data sources to produce a verified, source-backed city map. The primary use case is exploring the city centre, identifying the Nocibé commercial zone on Avenue d'Alsace, and auditing the commercial corridor toward Place Villaret Joyeuse.

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
      normalize.ts      OSM tag and address normalisation
      deduplicate.ts    stable-ID deduplication
    geo/
      projection.ts     LocalProjection (spherical equirectangular)
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
  discover-auch-boundary.ts geo.api.gouv.fr commune boundary
  fetch-osm.ts           Overpass queries (roads, buildings, POIs)
  fetch-addresses.ts     Base Adresse Nationale (BAN) records
  fetch-businesses.ts    SIRENE, Annuaire des Entreprises, PagesJaunes
  fetch-ign.ts           IGN Geoplateforme WFS layers
  normalize.ts           raw-source to typed features
  deduplicate.ts         stable-ID deduplication
  build-tiles.ts         tile budget and generation
  build-search-index.ts  accent-insensitive search index
  validate.ts            data validation
tests/
  unit/                  unit tests (projection, bounds, tiling)
  integration/           integration tests (pipeline, corrupt input)
  e2e/                   Playwright E2E tests over Moli CDP
  visual/                visual-state matrix definitions
  fixtures/              checked-in test fixtures
  artifacts/             ignored test output (screenshots, traces)
data/                    ignored city data volume
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

```
npm install
npm run data:refresh
npm run data:validate
npm run typecheck
npm run lint
npm test
npm run build
npm run start
npm run test:e2e
```

1. `npm install` installs pinned dependencies from `package-lock.json`.
2. `npm run data:refresh` acquires all configured sources, normalises, deduplicates, tiles, builds the search index, and validates.
3. `npm run data:validate` validates the generated data volume against strict contracts.
4. `npm run typecheck` runs TypeScript strict-mode check (`tsc --noEmit`).
5. `npm run lint` runs flat ESLint configuration.
6. `npm test` runs unit and integration Vitest suites.
7. `npm run build` validates data, then runs `next build`.
8. `npm run start` starts the production server.
9. `npm run test:e2e` starts Next and Moli, then runs Playwright E2E tests.

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
| OpenStreetMap (Overpass API) | Roads, buildings, water, land use, parks, facilities, POIs, addresses | ODbL |
| geo.api.gouv.fr | Commune boundary (contour), INSEE code, administrative geometry | Etalab OUVL |
| Base Adresse Nationale (BAN) | Addresses with coordinates, street names, postal codes | Etalab OUVL |
| IGN Geoplateforme (WFS) | Elevation, terrain, topographic references when available | Etalab OUVL (subject to layer availability) |
| INSEE SIRENE | Legal establishment records (business identity, address, activity code) | Etalab OUVL |
| Annuaire des Entreprises | Public business registry data | Etalab OUVL |
| PagesJaunes | Corroborative public business listings | Public directory reference only |
| Official business websites | Current public branding (fetched via Moli) | Fair use |
| Ville d'Auch / Grand Auch Coeur de Gascogne | Local administrative open data | Varies |
| Gers tourism | Public tourism and facility data | Varies |

Google Maps is used only for narrow corroborative presence checks. Google geometry, tiles, imagery, and bulk business data are never redistributed.

**Current dataset timestamp**: 2026-08-26.

**Completeness definition**: A feature is considered complete when it has a verified source, a stable internal ID, WGS84 coordinates, normalised geometry clipped to the commune boundary, provenance records for every property, and a status distinguishing active, uncertain, inferred, and unresolved values. The coverage report in `data/manifests/coverage.json` records actual counts, unresolved gaps, failed sources, and measured budgets.

## Licences and attribution

OpenStreetMap data is copyright the OpenStreetMap contributors and available under the Open Database Licence (ODbL). Map data from French government sources is subject to the Etalab Open Licence (OUVL) or compatible open-data licences as specified by each source. All source licences, acquisition timestamps, response hashes, and transformations are recorded in `data/manifests/sources.json`.

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
| `npm run test` | Unit and integration Vitest suites |
| `npm run test:unit` | Vitest unit tests (`tests/unit`) |
| `npm run test:integration` | Vitest integration tests (`tests/integration`) |
| `npm run test:e2e` | Moli CDP + Playwright E2E tests |
| `npm run data:refresh` | Full acquisition and generation pipeline |
| `npm run data:validate` | Validate the generated data volume |
| `npm run data:build` | Build from cached raw inputs (offline) |

## Moli requirement

Every headless browser interaction, rendered web page research, visual QA, screenshot capture, and CDP automation session uses Moli version 1.0.4 (or a recorded newer secure version). Moli is resolved from `PATH`. The project-local skill at `skills/moli-visual-tests/SKILL.md` documents the exact operations.

- **Research**: `moli fetch --dump markdown <URL>` or `moli fetch --dump semantic_tree_text <URL>`.
- **E2E testing**: `moli serve --layout --host 127.0.0.1 --port 9222` provides a CDP endpoint. Playwright connects via `chromium.connectOverCDP`. Playwright must never call `chromium.launch` or download its own Chromium.
- **Artifacts**: screenshots and traces go to `tests/artifacts/moli/`.
- **Prohibitions**: no CAPTCHA bypass, no login-wall circumvention, no robots.txt disregard, no silent browser fallback.
- **Failure**: if Moli is unavailable or crashes, the operation fails explicitly. No alternative browser automation tool substitutes.

## WebGPU requirements

The map renders through the Three.js `WebGPURenderer` backend. The client checks `navigator.gpu` before constructing the canvas. If WebGPU is unsupported, initialisation rejects, or the device is lost, `WebGPUUnsupported.tsx` renders an explicit error panel. The application never silently switches to WebGL.

**Required browser**: Chrome 113+ (or any browser with WebGPU support enabled). The GPU must support WebGPU device creation and shader compilation.

### Known Moli canvas limitation

Moli does not use a real GPU. Its canvas output is software-rendered and does not prove WebGPU device initialisation, shader compilation, or hardware-accelerated rendering. E2E tests relying on Moli assert DOM state and scene diagnostics (`renderer-status=initialized`, `backend=webgpu`, nonzero feature counts) but cannot validate canvas pixels. A supplementary check on a real GPU-capable browser is needed for pixel-level WebGPU validation.

## Nocibé search steps

1. Type `Nocibe` or `Nocibé` in the search control labelled `Rechercher dans Auch`.
2. The Nocibé result appears with the verified address `28 avenue d'Alsace, 32000 Auch`.
3. Select the result. The feature inspector opens with BAN coordinate `0.591913,43.648231`, source references, and provenance.
4. The orthographic camera focuses on the BAN coordinate.
5. The audited commercial perimeter (`nocibe-commercial-audit`) appears as a 750-metre radius around Nocibé with an 80-metre corridor geometry toward Place Villaret Joyeuse.
6. The corridor is drawn from connected OSM road or pedestrian geometry when available. If no source geometry connects the anchors, endpoints and an unresolved-route notice display instead of a fictional route.
7. The overlay is visible by default when Nocibé is selected and can be toggled in the layer panel.
8. Search also works with a one-character typo (e.g. `nocib`) and with the canonical name `Nocibé` and `Nocibe`.

Three verified corridor anchors exist in the generated manifest: Nocibé at `0.591913,43.648231`, Avenue d'Alsace at `0.591575,43.648437`, Place de Verdun at `0.592746,43.648079`, and Place Villaret Joyeuse at `0.588099,43.649466`.

If the commercial gallery identity around Place Villaret Joyeuse cannot be verified from direct public sources, the area is labelled `commercial area around Place Villaret Joyeuse` and the unresolved identity is recorded in the coverage report. CRU (`10 Place Villaret Joyeuse`) and FANTOCHE (`8 B Place Villaret Joyeuse`) are included only after direct source validation.

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
3. **Geometry**: clipped to the commune polygon, with finite coordinates, closed rings, and renderable polygons.
4. **Provenance**: every property conflict between sources is recorded in a `ProvenanceRecord` with winner, contenders, and priority rationale.
5. **Status**: each feature has a status distinguishing active, uncertain, inferred, and unresolved values.
6. **WGS84 preservation**: original WGS84 coordinates are preserved alongside local projected coordinates.

The coverage report (`data/manifests/coverage.json`) records actual clipped feature counts per category, source counts with ETags and acquisition timestamps, failed sources with error context, unresolved gaps with explanation, measured tile budgets (size, count), and measured validation results. No count or claim in documentation is estimated from a rectangular query or a genAI hallucination. Every value is copied from the generated coverage report after acquisition.