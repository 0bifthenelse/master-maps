# Data Provenance — Conflict Resolution & Source Priority

Every feature in the Auch map may carry values from multiple sources that disagree on a property (e.g., name spelling, coordinates, address, height). The provenance system resolves each property independently, preserves every contender, and records the rationale in a `ProvenanceRecord` attached to the feature. These records are surfaced in the `FeatureInspector` component so users can evaluate data confidence.

---

## Source Priority Hierarchy

Sources are ordered by authority. A higher-priority source wins on every property where it provides a value, except where a specific property rule (see below) overrides the general priority.

| Priority | Source Family                | Rationale                                            |
|----------|------------------------------|------------------------------------------------------|
| 1 (highest) | Administrative boundaries  | Official government GIS (geo.api.gouv.fr) — authoritative commune contour |
| 2         | IGN Géoplateforme            | National mapping agency (Institut National de l'Information Géographique et Forestière) |
| 3         | OpenStreetMap / Overpass     | Volunteer-contributed but current, detailed geometry |
| 4         | Base Adresse Nationale (BAN) | Official French address repository (Etalab)          |
| 5         | SIRENE / Annuaire des Entreprises | Official legal establishment registry (INSEE)   |
| 6         | Official business websites   | Current public branding (verified via Moli fetch)    |
| 7 (lowest)| Google Maps / directories    | Corroboration only — never source of geometry or bulk data |

Every conflict becomes a `ProvenanceRecord` entry visible to the inspector.

---

## Property-Specific Rules

Some properties override the general source priority when a specific source is known to be more authoritative for that property.

### Geometry (coordinates, polygon shape)

- **Winner**: Administrative boundary geometry > IGN > OSM > BAN point > SIRENE > website.
- **Rationale**: Official or surveyed geometry outranks crowd-sourced or approximate points.
- **Retained**: All source coordinates are stored in the feature's `sourceReferences` for inspector display.

### Name (canonical name, display name)

- **Winner**: Official business website (if verified) > SIRENE legal name > OSM `name` tag > directory listing.
- **Rule**: For Nocibé, the verified PagesJaunes and SIRENE records set the canonical display name (`Nocibé`). Accent-insensitive search (via NFD normalization) resolves both `nocibe` and `nocibé` to the same record.
- **No fictional aliases**: Only source-backed names enter the search index and feature data.

### Address

- **Winner**: BAN > OSM `addr:*` tags > SIRENE > website.
- **Rationale**: BAN is the official French address repository and provides the validated housenumber, street name, and INSEE code.
- **Corrected name**: The verified street is `Avenue d'Alsace`. The map uses this spelling; there is no `Rue d'Alsace` or other invented street name.

### Building Height

- **Winner**: IGN > OSM `height` tag > OSM `building:levels` (derived) > category default.
- **Marking**: Explicit finite values are marked `active`. Values derived from `building:levels` are marked `inferred:levels`. Category defaults are marked `inferred:default`.
- **Rejection**: Negative values are rejected. Inferred values above `18.0` meters are rejected unless an explicit source value exists.
- **Height defaults by category** (used only when no explicit or levels-derived value exists):

| Category       | Default height |
|----------------|---------------|
| House          | 3.5 m         |
| Apartments     | 6.0 m         |
| Garage / shed  | 2.7 m         |
| Retail         | 5.0 m         |
| Industrial     | 6.0 m         |
| Church         | 12.0 m        |
| Generic building | 3.5 m        |

**Important**: Height metadata exists for the inspector and coverage report only. The map renders all building footprints at `y=0` — no extrusion.

### Road Width

- **Winner**: OSM `width` tag > class default.
- **Defaults by class** (used when no explicit `width` tag is present):

| Class       | Default width |
|-------------|---------------|
| Motorway    | 12.0 m        |
| Trunk       | 9.0 m         |
| Primary     | 9.0 m         |
| Secondary   | 7.0 m         |
| Tertiary    | 6.0 m         |
| Residential | 5.0 m         |
| Service     | 3.5 m         |
| Pedestrian  | 2.0 m         |
| Cycleway    | 2.0 m         |
| Path        | 1.5 m         |
| Track       | 2.5 m         |

- Explicit finite `width` values are marked `active`. Defaults are marked `inferred:class`.

### Business Status (active / closed)

- **Winner**: SIRENE `etatAdministratif` (official registry) > website current presence > OSM `disused:*` tag > directory confirmation.
- **Note**: A business with an active SIRENE registration but a website that returns a "page not found" error is marked `uncertain` and both sources are recorded in provenance.

---

## Stable ID Policy

Every feature receives a stable internal ID that is independent of acquisition order, array position, or random values. The ID policy is implemented in `src/lib/data/normalize.ts`.

- **Source-provided durable ID**: When the source gives a durable identifier (BAN ID, SIRET, OSM element ID), the stable ID preserves it as `sourceType:sourceId` (e.g., `ban:32013_0050_00028`, `sirene:12345678900012`, `osm:way/123456789`).
- **Hashed ID**: When no durable source ID exists, the stable ID is a SHA-256 prefix of: feature kind + normalized canonical name + normalized address + rounded WGS84 coordinate + normalized geometry hash.
- **Deduplication**: Two features with the same stable ID are merged via provenance rules. The merge preserves all source references and property disagreements.

---

## Retained Disagreements

Provenance does not discard losing values. Every `ProvenanceRecord` stores:

- `featureId` — the feature's stable ID
- `property` — the conflicting property name (e.g., `name`, `height`, `address`)
- `winner` — the winning value
- `winningSource` — the source family that provided the winner
- `contenders` — array of `{ value, source, timestamp }` for all participating sources
- `rationale` — the rule applied (e.g., "priority: BAN > OSM" or "property-specific: BAN address")

This data is serialised into the tile files and rendered by `FeatureInspector.tsx` in the UI.

---

## Implementation

Provenance logic lives in:

- **`src/lib/data/provenance.ts`** — `resolvePropertyConflict()`, `buildProvenanceRecord()`, `mergeFeatures()`, source priority constants.
- **`src/lib/data/normalize.ts`** — applies provenance during raw-to-typed transformation.
- **`src/lib/data/deduplicate.ts`** — stable-ID deduplication (distinct from property conflict resolution).

The `ProvenanceRecord` type is defined in `src/lib/data/schema.ts` alongside `SourceReference` and `MapFeature`.