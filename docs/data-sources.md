# Master Maps data sources

The production territory is the Gers department, code 32. `data/manifests/sources.json` records the source URL, edition, timestamp, license, CRS, SHA-256 value, and record count for each acquisition.

## IGN Admin Express COG

The pipeline queries the IGN Géoplateforme WFS resource `ADMINEXPRESS-COG.LATEST:departement` with `code_insee=32`. The source uses EPSG:4326 and returns one complete MultiPolygon feature. The normalizer keeps every polygon and every ring.

## IGN BD TOPO

`fetch-bdtopo.ts` first queries the official Géoplateforme capabilities endpoint, then the filtered `BDTOPO` resource catalog. It selects the newest D032 GPKG edition from catalog metadata. It does not guess dates or archive names.

The verified package edition is `2026-06-15`. The selected package is `BDTOPO_3-5_TOUSTHEMES_GPKG_LAMB93_D032_2026-06-15`. Its archive size is 273308797 bytes and its SHA-256 value is `aed0afbcac474a38fb164411de467793673ee83b767b88020d429d83623562fa`.

The package source CRS is EPSG:2154. `ogrinfo` verified these canonical layers: `batiment`, `troncon_de_route`, `surface_hydrographique`, and `troncon_hydrographique`. The current export counts are 397880 buildings, 166838 road segments, 13597 hydrographic surfaces, and 50274 hydrographic segments before normalization.

The workstation GDAL build has no GEOS support. The acquisition therefore uses `ogr2ogr -spat` for the Lambert-93 envelope. The typed normalizer performs exact boundary clipping with polygon operations. The manifest records this decision.

BD TOPO supplies canonical road, building, and water geometry. Road width uses `largeur_de_chaussee` only when that field contains a positive numeric value. Road strata use the actual `position_par_rapport_au_sol` enumeration. Water surfaces render as polygons. A true BD TOPO fictive hydrographic axis remains available as metadata but does not render as a duplicate ribbon.

## OpenStreetMap via Geofabrik

`fetch-osm.ts` downloads the current `midi-pyrenees-latest.osm.pbf` extract. Osmium extracts the complete Gers boundary and writes a smaller enrichment extract. Bulk normalization keeps path classes and semantic named points or areas. IGN remains canonical for buildings, roads, and hydrographic geometry.

The Overpass fallback uses the complete Gers bounding box. Normalization applies the full Admin Express MultiPolygon afterward. The fallback never reduces a MultiPolygon to its largest ring.

OSM object URLs and the Geofabrik resource are retained in source references. OSM data uses ODbL 1.0 attribution.

## Base Adresse Nationale

`fetch-addresses.ts` downloads the department file `adresses-32.csv.gz`. It checks all 115461 CSV rows against every Admin Express boundary component. The verified run kept 115453 addresses inside Gers. The source CRS is EPSG:4326 and the license is Etalab Open Licence 2.0.

## SIRENE and business sources

`fetch-businesses.ts` queries the Annuaire des Entreprises API with department 32 filters. The verified run acquired 755 SIRENE records. SIRET is the primary business identity. Name, address evidence, and Lambert-93 distance provide the conservative fallback match.

OSM business queries and public-page fetches are corroborative. Overpass or page failures remain in the source manifest. The optional Moli page fallback is opt-in with `MASTER_MAPS_BUSINESS_MOLI=1` because the installed Moli binary can fail on a target page.

## Native workstation dependencies

The data pipeline uses these installed commands:

- `sci-libs/gdal` with the `tools` USE flag provides `ogrinfo`, `ogr2ogr`, and GDAL 3.13.1.
- `app-arch/p7zip` provides 7-Zip 17.05.
- `osmium-tool` has no matching package in the configured Gentoo eix repository. The verified workstation binary is `/home/ifthenelse/.local/bin/osmium`, version 1.19.1.

The pipeline does not use apt or systemd. A missing command is a hard prerequisite failure.

## OpenStreetMap comparison

Current `openstreetmap.org` views provide the geographic visual reference. The project does not ingest Google geometry, Google tiles, imagery, or bulk Places data. OSM comparison screenshots remain temporary QA artifacts under `tests/artifacts/visual`.
