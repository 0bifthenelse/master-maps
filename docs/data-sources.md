# Master Maps data sources

The production territory is the Gers department, code 32. Source records under `data/manifests/sources.json` contain acquisition time, resource URL, license, CRS, hash, and record count.

## IGN Admin Express COG

The pipeline queries the IGN Geoplateforme WFS resource `ADMINEXPRESS-COG.LATEST:departement` and selects `code_insee=32`. The 2026-08-27 acquisition returned one complete MultiPolygon feature. The response used EPSG:4326. The open data license is Licence Ouverte / Open Licence 2.0.

The raw response stays in `data/raw/gers-boundary.geojson`. The normalizer preserves every polygon and every ring. It does not select the largest component.

## IGN BD TOPO

`fetch-bdtopo.ts` discovers a current D032 package from the official IGN distribution. The verified acquisition used edition 2026-06-15 and the resource `BDTOPO_3-5_TOUSTHEMES_GPKG_LAMB93_D032_2026-06-15`. The package source CRS is EPSG:2154. The open data license is Licence Ouverte / Open Licence 2.0.

The archive stays under `data/raw`. The pipeline exports buildings, road segments, hydrographic surfaces, and hydrographic segments as WGS84 GeoJSON copies. The archive preserves the original Lambert-93 coordinates and source identifiers. The normalizer gives BD TOPO geometry precedence for buildings, roads, and hydrography.

Wide water uses `surface_hydrographique`. A fictive centerline does not create a second visible river surface.

## OpenStreetMap via Geofabrik

`fetch-osm.ts` downloads `https://download.geofabrik.de/europe/france/midi-pyrenees-latest.osm.pbf`. The extract is current at acquisition time. Osmium clips it to the Gers boundary and exports an enrichment subset. The source license is ODbL 1.0.

OSM supplies paths, named points, POI semantics, names, opening hours, and corroboration. OSM does not replace canonical IGN geometry.

## BAN

`fetch-addresses.ts` downloads `https://adresse.data.gouv.fr/data/ban/adresses/latest/csv/adresses-32.csv.gz`. It keeps every valid D32 address whose WGS84 position lies inside the complete Admin Express boundary. The source CRS is EPSG:4326. The source license is Etalab Open Licence 2.0.

## SIRENE and business sources

`fetch-businesses.ts` queries the Annuaire des Entreprises API with the department filter. SIRET and SIREN values provide legal identity. BAN supplies address positioning. OSM and verified public pages can add names, phones, websites, and opening data when a conservative match exists.

## Google Maps

Google Maps is visual corroboration only. The project does not ingest Google geometry, tiles, imagery, or bulk Places data.
