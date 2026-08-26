# Coverage Report — Auch 2D WebGPU Map

**Generated from:** `data/manifests/coverage.json` after a successful data refresh.

## Status: DATA REFRESH NOT YET COMPLETE

The automated data refresh (`npm run data:refresh`) has been attempted but cannot complete due to inter-script coordination gaps (parallel agent execution). Boundary discovery succeeded but subsequent scripts fail to locate the output.

## Manual Refresh Instructions

To acquire real data, run the following sequence:

```bash
# 1. Discover Auch boundary
npx tsx scripts/data/discover-auch-boundary.ts

# 2. Fetch OSM data (requires working overpass-api.de)
npx tsx scripts/data/fetch-osm.ts

# 3. Fetch BAN addresses
npx tsx scripts/data/fetch-addresses.ts

# 4. Fetch business records
npx tsx scripts/data/fetch-businesses.ts

# 5. Fetch IGN terrain (may report unavailable)
npx tsx scripts/data/fetch-ign.ts

# 6. Normalize and generate tiles
npx tsx scripts/data/refresh.ts --offline
```

## Required Coverage Metrics

After a successful refresh, `data/manifests/coverage.json` will contain:

| Metric | Expected |
|--------|----------|
| Dataset version | 0.1.0 |
| Boundary | Auch (INSEE 32013) |
| Bounding box | 0.486087,43.617419 to 0.647019,43.707701 |
| Sources | OSM, geo.api.gouv.fr, BAN, IGN, SIRENE |
| Nocibé | 28 avenue d'Alsace, BAN ID 32013_0050_00028 |

## Known Gaps

- Inter-script data path coordination (boundary source → OSM consumer)
- IGN terrain unavailability expected (recorded gracefully)
- Official Nocibé pages may crash Moli (recorded limitation)
- Place Villaret Joyeuse commercial gallery name unresolved