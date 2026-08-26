# Data Refresh — Acquisition & Generation Workflow

A full data refresh acquires every source, normalises all records, deduplicates, tiles, builds the search index, and validates the output. The entry point is the single command `npm run data:refresh`.

---

## Quick Start

```bash
# Full refresh (requires network access to all source endpoints)
npm run data:refresh

# Validate the generated volume without re-acquiring
npm run data:validate

# Rebuild from cached raw inputs (no network)
npm run data:build
```

---

## Workflow Stages

```
npm run data:refresh
│
├── 1. discover-auch-boundary
│     Fetch commune contour from geo.api.gouv.fr
│     Store raw GeoJSON, compute authoritative bbox
│
├── 2. fetch-osm
│     Convert boundary polygon → Overpass QL queries (per theme)
│     Request from overpass-api.de (fallback: kumi.systems)
│     Bounded exponential retry on 429/timeout
│     Store raw per-theme responses
│
├── 3. fetch-addresses
│     Download BAN departmental bulk CSV (adresses-32.csv.gz)
│     OR page the BAN search API with city filter
│     Filter by commune code 32013 and boundary polygon
│     Store filtered address records
│
├── 4. fetch-businesses
│     Query SIRENE / Annuaire des Entreprises API
│     Extract active establishments in Auch
│     Cross-reference with OSM shop/amenity records
│     Verify individual businesses via Moli page fetch
│     Store business records
│
├── 5. fetch-ign
│     Probe IGN Géoplateforme WFS GetCapabilities
│     If usable layers exist, query with commune bbox
│     Transform from EPSG:2154 (Lambert 93) to WGS84
│     If unavailable, record explicit failure — no fabricated data
│
├── 6. normalize
│     Read all raw source files
│     Convert to typed discriminated unions (BuildingFeature, RoadFeature, …)
│     Clip geometry to commune boundary polygon
│     Derive local projected coordinates (meters, x=east z=north)
│     Apply height, width defaults and rejection rules
│     Compute stable IDs
│     Store normalised features as JSON lines
│
├── 7. deduplicate
│     Group features by stable ID
│     Merge property conflicts via provenance rules
│     Retain all source references and disagreements
│     Store deduplicated feature set
│
├── 8. build-tiles
│     Benchmark tile candidates (256, 384, 512 m)
│     Select smallest candidate with ≤256 tiles and ≤750 KiB max tile
│     Assign each feature to its deterministic tile
│     Build tile geometry batches (flat, y=0)
│     Write tile files to data/generated/tiles/
│
├── 9. build-search-index
│     Build accent-insensitive search index
│     Normalise names via NFD decomposition + lowercase
│     Tokenise: exact > prefix > contain > edit distance
│     Tag each entry with feature type, tile ID, focus coordinate
│     Write to data/generated/search/index.json
│
└── 10. validate
      Check finite coordinates, sensible bounds, ring closure
      Verify stable ID uniqueness, tile references, provenance presence
      Confirm required records: boundary, roads, buildings, Nocibé
      Fail with source/tile/feature context on error
```

---

## Data Directory Layout

```
data/
├─ .gitkeep                         # Policy marker (git-ignored otherwise)
├─ raw/                             # Unmodified source responses
│  ├─ boundary.geojson
│  ├─ osm-roads.json
│  ├─ osm-buildings.json
│  ├─ osm-water.json
│  ├─ osm-landuse.json
│  ├─ osm-pois.json
│  ├─ osm-addresses.json
│  ├─ addresses.json                # BAN records
│  ├─ businesses.json               # SIRENE / Annuaire records
│  └─ ign-batiment.json            # IGN (if available)
├─ intermediate/                    # Normalised, pre-tile features
│  ├─ features.jsonl
│  └─ deduplicated.jsonl
├─ generated/                       # Production output (served by routes)
│  ├─ manifest.json                 # Version, bbox, tiles, counts, focus
│  ├─ tiles/
│  │  ├── tile-000.json
│  │  ├── tile-001.json
│  │  └── ...
│  └─ search/
│      └── index.json
├─ manifests/                       # Source and coverage metadata
│  ├─ sources.json                  # Every source: URL, hash, timestamp, license
│  └─ coverage.json                 # Counts, gaps, failures, budgets
└─ qa/                              # Test artefacts (optional)
```

---

## Environment Variables

| Variable               | Default  | Purpose                                    |
|------------------------|----------|--------------------------------------------|
| `MASTER_MAPS_DATA_DIR` | `data`   | Root directory for all data files          |
| `MOLLI_BIN`            | `moli`   | Path to the Moli binary                    |

---

## Retry and Failure Policy

- **OSM Overpass queries**: Exponential backoff (1 s, 2 s, 4 s, 8 s, 16 s, 30 s max) on HTTP 429 and timeouts. Up to 3 mirrors attempted in sequence.
- **BAN addresses**: Fall back from bulk CSV download to paging the JSON API.
- **IGN Géoplateforme**: Probe capabilities first. If the layer is unavailable, incompatible, or the service rejects the query, record the failure in `sources.json` and `coverage.json`. The map will render without IGN data and the gap is documented.
- **Business pages (Moli)**: If Moli crashes (`bad_optional_access`, exit 134) on a specific page, the crash is recorded in the source manifest. The page is not retried with another browser or an access-control workaround.
- **General HTTP failures**: Structured error thrown by each fetch script — no swallowed HTTP failures. The refresh fails if any required source is absent after all retries.

---

## Offline Mode

```bash
npm run data:build   # Equivalent to data:refresh --offline
```

Uses previously cached raw responses stored in `data/raw/`. A previously successful hash and timestamp must be present for each source. If a source has no cached response, the build fails with a clear error.

---

## Known Limitations and Unresolved Gaps

The following are recorded limitations rather than data defects. They appear in `data/manifests/coverage.json` after every refresh and are visible in the application's diagnostics.

| Gap                                  | Status      | Notes                                                              |
|--------------------------------------|-------------|--------------------------------------------------------------------|
| IGN elevation layer                  | Unavailable | Layer name exploration did not resolve; flat datum at y=0          |
| Official Nocibé page via Moli        | Crash       | Moli exits with `bad_optional_access` (code 134); BAN + PagesJaunes + SIRENE used instead |
| Commercial gallery name at Place Villaret Joyeuse | Unresolved | Area labelled "commercial area around Place Villaret Joyeuse" in UI pending source verification |
| Overpass bulk response size          | Monitored   | Large themes split into per-theme queries to stay within limits    |
| Source timestamps                    | Per refresh | Acquisition timestamps recorded per source; data may not reflect real-time changes |

---

## Scripts Reference

| Script                          | Purpose                                                      |
|---------------------------------|--------------------------------------------------------------|
| `scripts/data/refresh.ts`       | Orchestrate the full sequential pipeline                     |
| `scripts/data/discover-auch-boundary.ts` | Fetch commune contour from geo.api.gouv.fr         |
| `scripts/data/fetch-osm.ts`     | Convert boundary → Overpass QL queries → fetch per theme     |
| `scripts/data/fetch-addresses.ts` | Download BAN bulk or page API for Auch addresses           |
| `scripts/data/fetch-businesses.ts` | Query SIRENE / Annuaire + Moli business page fetch        |
| `scripts/data/fetch-ign.ts`     | Probe IGN Géoplateforme WFS → fetch usable layers            |
| `scripts/data/normalize.ts`     | Convert raw → typed features, clip, derive local coordinates |
| `scripts/data/deduplicate.ts`   | Stable-ID grouping, provenance merge                         |
| `scripts/data/build-tiles.ts`   | Benchmark → select tile size → build tile files               |
| `scripts/data/build-search-index.ts` | Accent-insensitive search index generation               |
| `scripts/data/validate.ts`      | Full validation: geometry, IDs, coverage, constraints         |

Each script accepts `--help` and returns structured errors. All scripts run via `tsx`.