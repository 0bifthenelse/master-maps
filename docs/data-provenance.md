# Data provenance

Every canonical feature retains its source references and any conflict records produced during normalization or conservative deduplication. The Feature Inspector exposes these fields for the selected feature. The generated source and coverage manifests record acquisition time, licenses, hashes, counts, and failed optional sources.

## Source priority

The pipeline uses this default order when scalar values from comparable records disagree:

1. Official administrative boundary data
2. IGN geometry and surveyed data
3. OpenStreetMap geometry and semantic tags
4. Base Adresse Nationale address data
5. SIRENE and Annuaire des Entreprises identity data
6. Verified public business pages

This order does not make a source authoritative for every field. Boundary geometry comes from Admin Express. BD TOPO supplies canonical buildings, roads, and hydrography. BAN supplies address points and address text. SIRENE supplies legal business identity. OSM supplies current enrichment, names, paths, and semantic POIs.

## Geometry

The canonical `geometry` field preserves WGS84 source geometry. `sourceGeometry` preserves the source geometry when a transformed or clipped representation is also needed. `localGeometry` is EPSG:2154 Lambert-93 easting and northing relative to the configured render origin. All polygon rings are closed, finite, non-degenerate, and validated before serialization. Features are clipped against the complete Gers department boundary, including MultiPolygon components.

Geometry deduplication is conservative:

- Durable source IDs merge exact identities.
- Polygon candidates require meaningful intersection-over-union and centroid agreement.
- Line candidates require sampled metric agreement and compatible semantic class.
- Nearby parallel roads are not merged solely because their bounding boxes overlap.
- BD TOPO geometry has priority when an accepted merge contains both BD TOPO and enrichment geometry.

Every accepted merge retains unique source references. Losing scalar values create a `ProvenanceRecord` with the feature ID, property, winning value, contenders, priority, and source timestamp.

## Field rules

- Names are retained only when supplied by a source. Search is accent-insensitive and uses canonical feature IDs.
- Addresses prefer BAN text and identifiers. SIRENE and OSM values remain available through source references and provenance.
- Road widths use an explicit finite source width when available. Otherwise the renderer uses a class default and marks the width as inferred.
- BD TOPO bridge and tunnel position is preserved as explicit road stratum metadata. OSM bridge and tunnel tags are preserved when present.
- Water surface and water-line geometry are distinct. Fictive hydrographic axes are retained as metadata but are not rendered as visible water lines.
- Building height and levels are retained as metadata only. Buildings are rendered as flat footprints at `y=0`.

## Stable IDs

A durable source identifier is preferred. Canonical IDs include the source family and source identifier, for example `ign-bdtopo:building/<cleabs>`, `osm-bulk:way/<id>`, `ban:<id>`, and `sirene:<siret>`. A deterministic content hash is used only when no durable identifier exists. Tile fragments append `@<tile-id>` to the fragment identity while retaining the canonical stable ID as the parent identity.

## Evidence and limits

The current generated volume is authoritative only for the acquisition recorded in `data/manifests/sources.json` and `data/generated/manifest.json`. Optional sources can be unavailable without implying zero data. The coverage report and spatial QA report are the evidence for feature counts, tile budgets, source failures, CRS residuals, and scene-input checks.

Google geometry, tiles, imagery, and bulk Places data are not used as map sources. OpenStreetMap is the external visual comparison reference, not a redistributed dependency.
