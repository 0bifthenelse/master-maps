# Architecture — Auch Interactive Map

## Overview

Master Maps is a flat two-dimensional WebGPU map of Auch, Gers, France. It renders a single commune's verified open geographic data as a browser-based interactive map using a tile-based scene graph, an orthographic camera locked to the x–z plane, and a Next.js App Router shell.

All production data lives under the Git-ignored `data/` directory. The application serves it through three restricted API routes that reject traversals, validate tile IDs, and return structured errors when the data volume is absent.

---

## Tech Stack

| Layer                    | Choice                         | Version     |
|--------------------------|--------------------------------|-------------|
| Framework                | Next.js (App Router)           | 16.3.3      |
| Rendering                | Three.js / three/webgpu        | 0.185.1     |
| React bindings           | @react-three/fiber (R3F)       | 9.7.0       |
| Utilities                | @react-three/drei              | 10.7.8      |
| Language                 | TypeScript (strict)            | 5.8.3       |
| Schema validation        | Zod                            | 4.4.3       |
| Unit / integration tests | Vitest                         | 4.1.11      |
| E2E / visual tests       | Playwright via Moli CDP        | 1.62.1      |
| Linter                   | ESLint (flat config)           | 9.26.0      |

---

## Directory Layout

```
maps-worktree/
├─ app/
│  ├─ globals.css            Design tokens, reset, focus, reduced motion
│  ├─ layout.tsx             Root layout (HTML lang=fr, metadata)
│  ├─ page.tsx               Entry point — dynamic import of MapShell
│  └─ api/
│     └─ map/
│        ├─ manifest/route.ts     GET /api/map/manifest
│        ├─ tile/[tileId]/route.ts  GET /api/map/tile/:tileId
│        └─ search/route.ts     GET /api/map/search?q=...
├─ src/
│  ├─ types/
│  │  └─ map.ts              MapFeature, BuildingFeature, RoadFeature, …
│  ├─ lib/
│  │  ├─ data/
│  │  │  ├─ schema.ts        Zod schemas + inferred types
│  │  │  ├─ provenance.ts    Source-priority conflict resolution
│  │  │  ├─ loadTile.ts      AbortController-aware LRU tile loader
│  │  │  ├─ search.ts        Accent-insensitive search index
│  │  │  ├─ normalize.ts     Raw-to-typed transformation rules
│  │  │  └─ deduplicate.ts   Stable-ID deduplication
│  │  ├─ geo/
│  │  │  ├─ projection.ts    LocalProjection (equirectangular, meters)
│  │  │  ├─ bounds.ts        Bounds2D, GeoJSON bounds, union, containment
│  │  │  ├─ tiling.ts        Deterministic half-open grid tiles
│  │  │  └─ polygon.ts       Ring closure, hole preservation, clipping
│  │  └─ scene/
│  │     ├─ materials.ts     Theme-aware shared materials (accent, ink, paper)
│  │     ├─ buildBuildings.ts  Flat footprint geometry at y=0
│  │     ├─ buildRoads.ts      Ribbon geometry from line classes
│  │     ├─ buildWater.ts      Water-body meshes
│  │     ├─ buildLanduse.ts    Land-use fills
│  │     ├─ buildPois.ts       POI markers (batch / InstancedMesh)
│  │     └─ sceneMetrics.ts    Per-tile draw-call and feature counts
│  └─ components/
│     └─ map/
│        ├─ MapShell.tsx          Tile loading, state, coord parent
│        ├─ CityScene.tsx         Scene tree: datum, boundary, layers
│        ├─ WebGPUCityCanvas.tsx  Async WebGPU renderer init + OrthographicCamera
│        ├─ WebGPUUnsupported.tsx  Fallback when navigator.gpu absent
│        ├─ LoadingState.tsx      Pre-renderer loading indicator
│        ├─ MapCamera.tsx         Camera focus, reset, in-plane rotation
│        ├─ MapControls.tsx       Pan (mouse + HJKL), zoom, damping
│        ├─ MapHud.tsx            Compact top search, layer toggle
│        ├─ SearchPanel.tsx       Dropdown results, Nocibé shortcut
│        ├─ FeatureInspector.tsx  Selected-feature details + provenance
│        ├─ LayerControls.tsx     Toggle visibility: roads, buildings, …
│        └─ SourceAttribution.tsx  Footer: OSM, BAN, IGN, Etalab
├─ scripts/
│  └─ data/
│     ├─ refresh.ts              Orchestrated acquisition → generate
│     ├─ discover-auch-boundary.ts
│     ├─ fetch-osm.ts
│     ├─ fetch-addresses.ts
│     ├─ fetch-businesses.ts
│     ├─ fetch-ign.ts
│     ├─ normalize.ts
│     ├─ deduplicate.ts
│     ├─ build-tiles.ts
│     ├─ build-search-index.ts
│     └─ validate.ts
├─ data/                          (ignored)
│  ├─ raw/
│  ├─ intermediate/
│  ├─ generated/
│  │  ├─ manifest.json
│  │  ├─ tiles/*.json
│  │  └─ search/index.json
│  ├─ manifests/
│  │  ├─ sources.json
│  │  └─ coverage.json
│  └─ qa/
├─ tests/
│  ├─ fixtures/                   Checked-in small data records
│  ├─ unit/                       Unit tests per module
│  ├─ integration/                Pipeline + corrupt-input tests
│  ├─ e2e/                        Playwright specs via Moli CDP
│  └─ visual/                     Visual-state matrix (moli-visual-states.test.ts)
├─ skills/
│  └─ moli-visual-tests/
│     └─ SKILL.md                 Mandatory Moli QA skill
├─ docs/
│  ├─ architecture.md             This file
│  ├─ data-sources.md             Source URLs, timestamps, licenses
│  ├─ data-provenance.md          Conflict resolution rules
│  ├─ data-refresh.md             Full refresh workflow
│  └─ coverage.md                 Coverage report placeholder
├─ .gitignore
├─ README.md
├─ package.json
└─ tsconfig.json
```

---

## Data Flow

```
┌─────────────────────────────────────────────────────┐
│  npm run data:refresh                                │
│                                                      │
│  Boundary Discovery  (geo.api.gouv.fr)               │
│       ↓                                              │
│  OSM Queries  (overpass-api.de)                      │
│       ↓                                              │
│  Addresses  (BAN API)                                │
│       ↓                                              │
│  Businesses  (SIRENE, Annuaire, pages web)           │
│       ↓                                              │
│  IGN Géoplateforme  (terrain, bâtiments)             │
│       ↓                                              │
│  Normalize → Deduplicate → Tile → Search Index       │
│       ↓                                              │
│  Validate                                             │
└─────────────────────────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  data/generated/        │
              │  ├─ manifest.json       │
              │  ├─ tiles/{id}.json     │
              │  └─ search/index.json   │
              └─────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────┐
│  Browser (Next.js runtime)                           │
│                                                      │
│  app/page.tsx  ──dynamic──►  MapShell                │
│                                │                     │
│                ┌────────────────┼─────────────┐      │
│                ▼                ▼             ▼      │
│          SearchPanel      CityScene       Feature   │
│                            │           Inspector    │
│                            ▼                        │
│                     WebGPUCityCanvas                │
│                      (OrthographicCamera,           │
│                       async WebGPU init)             │
│                            │                        │
│                ┌───────────┼───────────┐             │
│                ▼           ▼           ▼             │
│          Buildings     Roads      Water / Landuse   │
│          (flat y=0)   (ribbons)   (meshes)          │
│                            │                        │
│                      LayerControls                   │
│                      MapControls (HJKL)              │
│                      MapCamera (focus/reset)        │
└──────────────────────────────────────────────────────┘
```

### Server-side (API routes)

Three Next.js route handlers serve the generated data volume and **never** fetch arbitrary URLs or expose credentials:

| Route                          | Method | Purpose                                  |
|--------------------------------|--------|------------------------------------------|
| `/api/map/manifest`            | GET    | Dataset version, bbox, projection, focus |
| `/api/map/tile/[tileId]`       | GET    | Single tile geometry + feature metadata  |
| `/api/map/search?q={query}`    | GET    | Accent-insensitive search across features|

All three return `503 { code: "DATASET_UNAVAILABLE", message: "…" }` when the data volume is missing.

### Client-side (browser)

`MapShell.tsx` is the single client coordinator. It is imported dynamically with `ssr: false` because it depends on `navigator.gpu` and `window` APIs.

1. On mount, `MapShell` fetches the manifest to validate the dataset and load tile indices.
2. It renders `CityScene.tsx` which attaches the Three.js scene tree to the R3F `Canvas`.
3. `WebGPUCityCanvas.tsx` initialises a `WebGPURenderer` via the R3F async `gl` callback. If `navigator.gpu` is absent or init fails, it renders `WebGPUUnsupported.tsx` instead.
4. Each visible tile is loaded by `loadTile.ts` (LRU cache, AbortController), then passed to the per-type scene builders (`buildBuildings`, `buildRoads`, etc.) which produce flat geometry at `y=0`.
5. User interaction flows through `MapControls` (mouse pan, wheel zoom, HJKL), `SearchPanel` (API-backed dropdown), and `FeatureInspector` (selected feature details + provenance).

---

## Rendering Model

- **Camera**: `OrthographicCamera` looking down the `+y` axis onto the `x–z` plane. Never exposes pitch or 3D tilt.
- **Coordinate system**: Local equirectangular projection centered on Auch's commune centroid. `x` = east (meters), `z` = north (meters), `y` = 0 for all visible geometry.
- **Buildings**: Filled Polygon / MultiPolygon footprints at `y=0`. Height and level metadata are stored on feature records for the inspector and coverage report only — **no extrusion**.
- **Roads**: Ribbon geometry from OSM line classes, merged by layer and rendered with class-based widths.
- **Water / Land use**: Flat meshes with per-type colour fills from `materials.ts`.
- **POIs**: Batched `Points` or `InstancedMesh` markers using the `--color-accent` (#ff7d27) token.
- **Theme tokens**: `--color-accent: #ff7d27`, `--color-ink: #000000`, `--color-paper: #ffffff`. All scene materials derive from these three CSS custom properties and respond to `prefers-color-scheme`.

---

## Key Design Decisions

1. **Flat 2D, not 3D.** Despite using Three.js and R3F, the map is intentionally a flat orthographic view. No extrusion, no terrain relief, no camera pitch. Height metadata exists only for the inspector and coverage counting.
2. **WebGPU primary, no fallback to WebGL.** If the browser lacks WebGPU, the application renders the `WebGPUUnsupported` panel rather than silently switching renderers. This ensures honest capability reporting.
3. **Tile-based loading.** The commune is divided into a deterministic grid. Each tile file is self-contained flat geometry. The LRU cache keeps the active viewport performant.
4. **All data is Git-ignored.** The `data/` volume is generated by `npm run data:refresh` and must be present before the application builds or serves.
5. **Provenance-first.** Every feature carries a `ProvenanceRecord` that preserves all source disagreements. The inspector surfaces these records so users can evaluate data confidence.
6. **Moli for headless QA.** All E2E and visual tests run through `moli serve` (CDP) with Playwright connecting over `connectOverCDP`. Chromium is never launched by Playwright directly.

---

## Diagnostics

When `NEXT_PUBLIC_MAP_DIAGNOSTICS=1` or the environment is non-production, a semantic `#scene-diagnostics` element exposes:

- `renderer-status` — initialized / failed / unsupported
- `backend` — webgpu / unknown
- `loaded-tile-count`, `loaded-feature-count`
- `building-count`, `road-count`, `poi-count`
- `draw-calls`
- `camera-state` — target, zoom
- `renderer-error` — text or unknown

These values are throttled, not updated on every animation frame.

---

## Accessibility

- French language UI labels (`Rechercher dans Auch`, `Couches`, `Sources`).
- Semantic HTML outside the canvas: `main[role=application]`, `button` controls, `nav` for layers.
- `prefers-reduced-motion` respected; damping and map animations disabled.
- All controls have accessible names and visible `:focus-visible` rings.
- Theme respects `prefers-color-scheme`. Contrast meets WCAG AA (4.5:1 normal, 3:1 large).