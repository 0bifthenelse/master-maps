# Data Sources — Auch Interactive Map

This document lists every URL queried during a full `npm run data:refresh`, the acquisition timestamp, response SHA-256 hash, applicable license, and the transformations applied to each source. The authoritative source manifest is written to `data/manifests/sources.json` after each successfully completed refresh.

The timestamps below are representative of the most recent successful refresh. Actual timestamps and hashes vary per refresh and are recorded in the manifest.

---

## 1. Commune Boundary — geo.api.gouv.fr

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **URL**        | `https://geo.api.gouv.fr/communes?codePostal=32000&fields=nom,code,codeDepartement,codeRegion,geometry&format=geojson&geometry=contour` |
| **Endpoint**   | geo.api.gouv.fr (Etalab / French government open-data API)           |
| **Parameters** | `codePostal=32000`, fields include geometry (contour), GeoJSON format |
| **Response**   | GeoJSON FeatureCollection, single Feature for Auch (INSEE code 32013) |
| **License**    | [Licence Ouverte / Open Licence 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence) (Etalab) |
| **Content**    | WGS84 Polygon geometry of the commune administrative boundary        |
| **SHA-256**    | Recorded per refresh in `data/manifests/sources.json`                |
| **Timestamp**  | Recorded per refresh in `data/manifests/sources.json`                |

### Transformations

1. Extract the `geometry.coordinates` array from the GeoJSON Feature.
2. Verify the commune code is `32013` and département is `32` (Gers).
3. Compute the authoritative WGS84 bounding box from the contour:
   - West: `0.486087`, East: `0.647019`
   - South: `43.617419`, North: `43.707701`
4. Store raw GeoJSON in `data/raw/boundary.geojson`.
5. This polygon is used as the clipping boundary for all subsequent source geometry.

---

## 2. OpenStreetMap Data — Overpass API

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **URL**        | `https://overpass-api.de/api/interpreter`                              |
| **Mirrors**    | `https://overpass.kumi.systems/api/interpreter` (fallback)             |
| **Method**     | HTTP POST with `data` parameter containing Overpass QL query           |
| **License**    | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) (OpenStreetMap contributors) |
| **Attribution**| `© OpenStreetMap contributors` required in application                 |
| **Rate limit** | Retry with exponential backoff on 429 / timeout; bounded retries       |

### Queries

Each query is constrained by the commune boundary polygon or the WGS84 bbox. Queries are split by theme to stay within response size limits.

| Theme          | Overpass Query Description                                            | Typical Size |
|----------------|-----------------------------------------------------------------------|-------------|
| Roads          | `way["highway"](bbox); (._;>;);` — all highway-tagged ways            | Largest     |
| Buildings      | `(way["building"](bbox); rel["building"](bbox);); (._;>;);`          | Large       |
| Water          | `(way["water"](bbox); way["waterway"](bbox); rel["water"](bbox);)`   | Medium      |
| Land use       | `(way["landuse"](bbox); rel["landuse"](bbox);)`                      | Medium      |
| Parks / Green  | `(node["leisure"="park"](bbox); way["leisure"](bbox);)`              | Small       |
| Facilities     | `(node["amenity"](bbox); way["amenity"](bbox);)`                     | Medium      |
| Parking        | `(node["amenity"="parking"](bbox); way["amenity"="parking"](bbox);)` | Medium      |
| Transit        | `(node["public_transport"](bbox); way["public_transport"](bbox);)`   | Small       |
| Addresses      | `(node["addr:housenumber"](bbox); way["addr:housenumber"](bbox);)`   | Large       |
| Shops / POIs   | `(node["shop"](bbox); way["shop"](bbox);)`                           | Medium      |
| Railway        | `(way["railway"](bbox);)`                                             | Small       |

### Transformations

1. Parse Overpass JSON response (elements array).
2. Classify each element by its primary tag: `highway` → RoadFeature, `building` → BuildingFeature, `water`/`waterway` → WaterFeature, etc.
3. Extract WGS84 node coordinates for each way (nodes are included via `(._;>;)`).
4. Filter elements to the commune boundary polygon (some elements near the bbox edge fall outside).
5. Apply default width/height rules (see `scripts/data/normalize.ts`).
6. Store raw response per theme in `data/raw/osm-{theme}.json`.

---

## 3. Addresses — Base Adresse Nationale (BAN)

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **URL**        | `https://api-adresse.data.gouv.fr/search/?q=&type=housenumber&city=Auch&limit=10000` (or departmental bulk download) |
| **Departmental bulk** | `https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-32.csv.gz` (Gers, département 32) |
| **API endpoint** | `https://api-adresse.data.gouv.fr/search/` with bbox or city filter   |
| **License**    | [Licence Ouverte / Open Licence 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence) (Etalab) |
| **Attribution**| Base Adresse Nationale — Etalab |

### Method

1. Attempt department-level bulk download (`adresses-32.csv.gz`) first for completeness.
2. Filter rows by commune code `32013` and boundary polygon.
3. Fall back to paging the BAN API with `city=Auch` and `limit=10000` if the bulk file is unavailable.
4. Record the response hash and license.

### Notable Resolved Address

| Feature           | Address                              | BAN ID             | Coordinates            |
|-------------------|--------------------------------------|---------------------|------------------------|
| Nocibé            | 28 avenue d'Alsace, 32000 Auch       | 32013_0050_00028    | 0.591913, 43.648231   |
| Place de Verdun   | —                                    | —                   | 0.592746, 43.648079   |
| Avenue d'Alsace   | —                                    | —                   | 0.591575, 43.648437   |
| Place Villaret    | 10 Place Villaret Joyeuse, Auch      | —                   | 0.588099, 43.649466   |

### Transformations

1. Parse BAN CSV (pipe-delimited) or JSON API response.
2. Filter by `code_insee = "32013"`.
3. Map columns to AddressFeature: `numero` + `voie` → address string, `lon`/`lat` → WGS84.
4. Compute `stableId` from BAN ID (`id` column).
5. Clip to boundary polygon (some addresses near the administrative edge may fall outside).
6. Store filtered records in `data/raw/addresses.json`.

---

## 4. IGN Géoplateforme — BD TOPO / Elevation

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **URL**        | `https://data.geopf.fr/wfs/ows` (Géoplateforme WFS)                   |
| **Layers**     | `BDTOPO_V3:batiment` for buildings (fallback), `ELEVATION:XXXX` for terrain |
| **License**    | [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence) (IGN / Etalab) |
| **CRS**        | EPSG:2154 (Lambert 93) — reprojected to WGS84 for internal storage    |
| **Status**     | Layer names are explored dynamically during refresh. If the required layer is unavailable or the service returns an incompatible schema, the source is recorded as unavailable rather than fabricating data. |

### Method

1. Probe `https://data.geopf.fr/wfs/ows?SERVICE=WFS&REQUEST=GetCapabilities` to discover available layers.
2. If a usable building or elevation layer is found, query with the commune bbox (in EPSG:2154).
3. Transform IGN coordinates (Lambert 93) to WGS84 using the `proj4` or equivalent library.
4. Store raw response in `data/raw/ign-{layer}.json`.

### Contingency

If IGN elevation data cannot be acquired or validated under a reusable license, the map renders a flat datum (`y=0`) and the terrain gap is recorded in `data/manifests/coverage.json`.

---

## 5. Businesses — SIRENE / Annuaire des Entreprises

| Field          | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| **URL**        | `https://annuaire-entreprises.data.gouv.fr/` (API)                    |
| **API**        | `https://api.annuaire-entreprises.data.gouv.fr/` (recherche par commune) |
| **License**    | [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence) |
| **SIRENE**     | INSEE SIRENE database — open data under the same licence              |

### Method

1. Query the Annuaire des Entreprises API for establishments in Auch (commune code `32013`).
2. Extract SIRET, SIREN, legal name, address, activity code (APE/NAF), and creation date.
3. Cross-reference with OSM `shop` and `amenity` records for business names and geometry.
4. For individually verified businesses (e.g., Nocibé), fetch public pages through Moli.

### Verified Businesses

| Name             | Address                              | Source                         | Status   |
|------------------|--------------------------------------|--------------------------------|----------|
| Nocibé           | 28 avenue d'Alsace, 32000 Auch       | BAN + PagesJaunes + Annuaire  | Verified |
| CRU              | 10 Place Villaret Joyeuse, Auch      | Search + website               | Verified |
| FANTOCHE         | 8 B Place Villaret Joyeuse, Auch     | Annuaire des Entreprises       | Verified |

### Transformations

1. Parse SIRENE / Annuaire JSON (establishments array).
2. Filter to active establishments (`etatAdministratif = "A"`).
3. Map fields to BusinessFeature: `siret` → source ID, `denomination` or `nomCommercial` → canonical name, `adresse` → address fields.
4. Cross-reference with BAN for precise coordinates when available.
5. Store in `data/raw/businesses.json`.

---

## 6. Corroborative Sources

| Source          | URL / Method                                                          | Purpose                         | License / Restrictions                                          |
|-----------------|-----------------------------------------------------------------------|---------------------------------|-----------------------------------------------------------------|
| PagesJaunes     | `https://www.pagesjaunes.fr/pros/08905195` (Nocibé listing)           | Verify current business presence| Public directory listing; not redistributed in bulk             |
| Google Maps     | Street View / Places API (read-only, corroboration only)              | Confirm current presence        | Google ToS; geometry and bulk data NOT redistributed            |
| Grand Auch      | `https://www.grandauch.com/` (communauté d'agglomération)             | Official Auch area information  | Public website; reasonable excerpts for attribution             |
| Gers Tourisme   | `https://www.tourisme-gers.com/`                                      | Tourism context                  | Public website                                                  |

**Important**: Google Maps geometry, tiles, imagery, and bulk business data are not redistributed. Google Maps is used only for corroboration of current business presence. No Google-derived data enters the generated tile set.

---

## Source Family Summary

| Priority | Source Family       | License                  | Data Provided                        |
|----------|---------------------|--------------------------|--------------------------------------|
| 1        | Administrative     | Licence Ouverte 2.0      | Commune boundary                     |
| 2        | IGN Géoplateforme  | Licence Ouverte 2.0      | Buildings, elevation (if available)  |
| 3        | OpenStreetMap / Overpass | ODbL 1.0             | Roads, buildings, water, land use, POIs |
| 4        | BAN (Base Adresse Nationale) | Licence Ouverte 2.0 | Addresses                            |
| 5        | SIRENE / Annuaire des Entreprises | Licence Ouverte 2.0 | Legal business records               |
| 6        | Official business websites | Varies              | Current branding, public hours       |
| 7        | Google Maps / directories | Corroboration only  | Presence confirmation (no geometry)  |

All source files, hashes, and acquisition timestamps are recorded in `data/manifests/sources.json`.