# Master Maps data sources

The production territory is the Gers department, code 32. `data/manifests/sources.json` records the source URL, edition, timestamp, license, CRS, SHA-256 value, and record count for each acquisition.

The manifest holds two generations of rows. The rows without an `etag` date from the 2026-08-27 acquisition. The `cadastre-*` rows, the second `ban` row, and `ban-auch` are a later 2026-09-26 acquisition kept alongside them.

## IGN Admin Express COG

The pipeline queries the IGN Géoplateforme WFS resource `ADMINEXPRESS-COG.LATEST:departement` with `code_insee=32`. The source uses EPSG:4326 and returns one complete MultiPolygon feature. The normalizer keeps every polygon and every ring.

## IGN BD TOPO

`fetch-bdtopo.ts` first queries the official Géoplateforme capabilities endpoint, then the filtered `BDTOPO` resource catalog. It selects the newest D032 GPKG edition from catalog metadata. It does not guess dates or archive names.

The verified package edition is `2026-06-15`. The selected package is `BDTOPO_3-5_TOUSTHEMES_GPKG_LAMB93_D032_2026-06-15`. Its archive size is 273308797 bytes and its SHA-256 value is `aed0afbcac474a38fb164411de467793673ee83b767b88020d429d83623562fa`.

The package source CRS is EPSG:2154. `ogrinfo` verified these canonical layers: `batiment`, `troncon_de_route`, `surface_hydrographique`, and `troncon_hydrographique`. The 2026-08-27 export counts recorded in the manifest are 397880 buildings, 166838 road segments, 13597 hydrographic surfaces, and 50274 hydrographic segments before normalization.

The workstation GDAL build has no GEOS support. The acquisition therefore uses `ogr2ogr -spat` for the Lambert-93 envelope. The typed normalizer performs exact boundary clipping with polygon operations. The manifest records this decision.

The reconciliation audit cross-checks the delivered package against the clipped outputs and records the 303 298 record difference as envelope clip loss, advisory rather than a contradiction. See `data/qa/source-reconciliation-audit.json`.

BD TOPO supplies canonical road, building, and water geometry. Road width uses `largeur_de_chaussee` only when that field contains a positive numeric value. Road strata use the actual `position_par_rapport_au_sol` enumeration. Water surfaces render as polygons. A true BD TOPO fictive hydrographic axis remains available as metadata but does not render as a duplicate ribbon.

## OpenStreetMap

`fetch-osm.ts` downloads the daily Gers extract `gers-latest.osm.pbf` from download.openstreetmap.fr, falling back to the Geofabrik `midi-pyrenees-latest.osm.pbf` extract. Osmium exports the tagged objects the map uses. Bulk normalization keeps service roads, tracks, paths, footways, cycleways and steps, shops, amenities and landmarks with their hours, phones, websites, brands and cuisine, and the category of every place. IGN remains canonical for buildings, the public road network and hydrographic geometry: OSM roads of the public network classes are not adopted, so no road is drawn twice.

The 2026-08-27 acquisition recorded 261798 Geofabrik records. The later parity run measured a 41 876 027-byte Gers PBF and 138252 highway ways. See `data/qa/osm-parity.json`.

The Overpass fallback uses the complete Gers bounding box. Normalization applies the full Admin Express MultiPolygon afterward. The fallback never reduces a MultiPolygon to its largest ring.

OSM object URLs and the extract resource are retained in source references. OSM data uses ODbL 1.0 attribution.

## Base Adresse Nationale

`fetch-addresses.ts` downloads the department file `adresses-32.csv.gz`. The 2026-08-27 run checked 115544 CSV data rows against every Admin Express boundary component and kept 115536 rows inside Gers, then collapsed 74 duplicate BAN identifiers to 115462 unique records. The later 2026-09-26 run repeats the acquisition and records 115462 records. The source CRS is EPSG:4326 and the license is Etalab Open Licence 2.0. See `data/qa/address-reconciliation.json`.

The reconciliation audit records an advisory disagreement here: the fetch-stage unique count is 115462 while the post-index accepted count is 115379, the difference being the addresses that the search index does not carry.

## SIRENE and business sources

`fetch-businesses.ts` queries the Annuaire des Entreprises API with department 32 filters. The verified run acquired 755 SIRENE records. SIRET is the primary business identity. Name, address evidence, and Lambert-93 distance provide the conservative fallback match.

OSM business queries and public-page fetches are corroborative. Overpass or page failures remain in the source manifest: `businesses-osm` is recorded with an error after HTTP 500 from the Overpass endpoint, and `businesses-web` contributed 3 records. The optional browser page fallback is opt-in with `MASTER_MAPS_BUSINESS_MOLI=1` because the installed browser binary can fail on a target page.

## Etalab cadastre

The 2026-09-26 acquisition adds the cadastre building and place-name extracts. The manifest marks both with `mergedIntoCanonicalData: false`, so the pipeline does not merge them into canonical features. Their licence is Licence Ouverte / Open Licence 2.0 (ETALAB).

`data/qa/cadastre-parity.json` is the independent comparison. It matched 267076 of 305761 canonical buildings, matched 278958 of 344466 cadastre buildings, and reports a parity ratio of 87.35%. The match rule is a 0.02 degree spatial hash with intersection over union of at least 0.2 and a centroid distance of at most 25 metres.

## Native workstation dependencies

The data pipeline uses these installed commands:

- `sci-libs/gdal` with the `tools` USE flag provides `ogrinfo`, `ogr2ogr`, and GDAL 3.13.1.
- `app-arch/p7zip` provides 7-Zip 17.05.
- `osmium-tool` has no matching package in the configured Gentoo eix repository. The verified workstation binary is `/home/ifthenelse/.local/bin/osmium`, version 1.19.1.

The pipeline does not use apt or systemd. A missing command is a hard prerequisite failure.

## OpenStreetMap comparison

Current `openstreetmap.org` views provide the geographic visual reference. The project does not ingest Google geometry, Google tiles, imagery, or bulk Places data. `scripts/chrome/compare-osm.ts` writes its comparison captures under `tests/artifacts/chrome`.
