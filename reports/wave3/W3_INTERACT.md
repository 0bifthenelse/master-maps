# W3-INTERACT: selection, context menu, highlight

Owner: wave3-3. Files owned and delivered:

| File | State |
|---|---|
| `src/lib/scene/highlight.ts` | NEW |
| `src/components/map/FeatureContextMenu.tsx` | NEW |
| `src/components/map/FeatureHighlightLayer.tsx` | NEW (R3F bridge) |
| `src/components/map/FeatureInspector.tsx` | rewritten |
| `src/components/map/MapHud.tsx` | rewritten |
| `src/components/map/BusinessHoverPopup3D.tsx` | tokenised |
| `tests/unit/feature-interaction.test.ts` | NEW, 12 tests |

## 1. highlight.ts

Pure layer turning a pick into highlight geometry. No React, no DOM, no
mutation of the tile caches.

- `resolvePickedFeature({ tile, layer, index })` maps a raycast to
  `PickedFeature { stableId, kind, category, name?, layer, tileId, anchor,
  lonLat?, height?, width?, props?, rangeIndex }`.
  `resolvePickedFeatureById(tileId, layer, index)` is the resident-cache
  form; `resolvePickedFeatureByStableId(tile, stableId)` recovers a pick
  from a `(tileId, stableId)` scene report.
- Point layers: a point feature owns one vertex and a **zero-length
  range**, so a face scan can never match it. `index` is therefore read
  as a vertex index for those layers. This mirrors the `pickPointStableId`
  contract wave3-4 landed in `tileGpuCache.ts`, and it is why `rangeIndex`
  travels on the pick: every point range starts at vertex 0, so a pick
  can only be re-addressed by its range position.
- `buildFeatureHighlight` duplicates **only** the picked index range into
  private `BufferGeometry` objects: an accent fill plus a `LineSegments`
  whose silhouette is computed by cancelling every edge shared by two
  triangles, which yields the roof plus base ring of an extruded
  building, the rails plus end caps of a road ribbon, and the ring of a
  flat polygon. A zero-triangle feature gets a square reticle at its meta
  anchor. Both are lifted a constant `HIGHLIGHT_LIFT_METRES = 1.5`.
- `createHighlightGroup` / `setFeatureHighlight` / `clearFeatureHighlight`
  own one dedicated `THREE.Group` and dispose the previous geometry and
  material on every swap and on clear.
- The tile payload slab, the cached geometries and the range attributes
  are only read. A test asserts the payload bytes are byte-identical
  after a highlight is built and disposed.

Colours: fill `#b85c1c` and outline `#ff7d27`, both lightness steps of
the accent root.

## 2. FeatureContextMenu.tsx

`role="menu"`, `aria-modal`, `aria-labelledby` on the name and
`aria-describedby` on the kind line. French copy throughout.

- Focus moves to the first item on open. `ArrowUp` / `ArrowDown` move,
  `Home` / `End` jump, `Tab` and `Shift+Tab` cycle inside the menu,
  `Escape` closes. Any pointer press outside dismisses, via a
  capture-phase `pointerdown` listener on `window`.
- Positioned `fixed` at the click point, then clamped in a layout effect
  once the real height is measured, so a click near an edge still shows
  every action.
- Actions: **Détails**, **Centrer**, **Copier les coordonnées** (WGS84,
  six decimals), **Copier le nom / adresse**, **Copier l'identifiant**,
  and **Copier la classe et la largeur** only when the pick actually
  carries both a road class and a width. A copy shows an inline
  `copié` confirmation in the accent colour.
- Header: name, French kind label, category chip, render layer, and a
  definition list of real attributes lifted from the render-tile meta.
  No placeholder rows.
- While open it sets `document.documentElement.dataset.featureContextOpen`.

### Native context menu decision

The native browser menu is suppressed **only over a feature**. On
empty-space right-click the browser menu is left alone. This is
implemented by gating the existing blanket `preventDefault` in
`MapCamera.tsx` on that dataset flag (wave3-1 applied it), rather than
by adding a second map menu with nothing in it.

## 3. FeatureInspector.tsx

Rewritten against the new pick payload plus the geometry-less record from
`/api/map/tile/<tileId>`. Keeps the panel layout, adds real structure:
`aside[role=complementary]`, an `h2` title, `h3` section headings,
definition lists, and a focusable close button with an `aria-label`.
Sections render only when a real value backs them.

Removed: the dead **Nocibé audit section** (its `onToggleAudit` prop was
never passed, so it could never render, and the `commercialAudit` layer
has no scene branch), and the dead **Détails** toggle (its
`mobileInspectorOpen` state was write-only).

## 4. MapHud.tsx

- The reset button is relabelled **Vue d'ensemble** with
  `aria-label="Réinitialiser la vue sur l'ensemble du département"`. It
  was labelled `Réinitialiser` with an `aria-label` that did not say what
  it did.
- Added a shortcut hint strip listing only what is implemented:
  `H J K L`, `← ↑ → ↓`, `+ −`, `clic droit`, `Échap`.
- The search input stops `keydown` propagation, so no window-level map
  shortcut can fire while typing. This is defence in depth behind
  `MapControls.shouldHandle`, which already skips text tags.

## 5. BusinessHoverPopup3D.tsx

Raw hex (`#d34f2f`, `#a43824`, `rgba(255,252,246,0.97)`, `#171717`)
replaced by the three root tokens via `color-mix`, and the 7 px radius
reduced to 2 px to match the HUD direction. The 3D cylinder keeps a
literal `#ff7d27` because a `MeshBasicMaterial` cannot resolve a CSS
`var()`.

## 6. REQUIRED MAPSHELL PATCH

The lead applies these; I did not edit `MapShell.tsx`.

**(a) Mount the highlight.** Import and render inside the R3F Canvas
children, next to `<CityScene ... />`:

```tsx
import FeatureHighlightLayer from "@/components/map/FeatureHighlightLayer";
...
<WebGPUCityCanvas ...>
  <CityScene ... />
  <FeatureHighlightLayer pick={selectedFeature} />
</WebGPUCityCanvas>
```

**(b) Fix point-feature resolution.** `pickByStableId`
(`MapShell.tsx:203`) currently ends in
`resolvePickedFeature({ tile, layer: layer.id, index: ranges[index * 3]! })`.
For a point layer every range has `indexStart === 0`, so this **always
resolves the first point of the layer**. The same pattern appears in the
`resolvePickedFeature` call in the render-pick handler. Replace both
bodies with:

```tsx
import { resolvePickedFeatureByStableId } from "@/lib/scene/highlight";
...
return resolvePickedFeatureByStableId(tile, stableId);
```

## 7. Verification

- `npx tsc --noEmit`: clean on all six owned files. (Errors in
  `MapShell.tsx`, `CameraRig.tsx`, `MapControls.tsx` and
  `app/api/map/tile/[tileId]/route.ts` at the time of writing belong to
  the lead and to wave3-1, mid-flight.)
- `npx vitest run tests/unit/feature-interaction.test.ts`: **12/12 pass**.
  Covers pick resolution per range, the point-layer vertex-index path,
  stableId recovery in a multi-point layer, `rangeIndex` propagation,
  range-only duplication, the constant lift, silhouette edge
  cancellation, the point reticle, payload immutability, and group
  replace / clear / unresolvable-pick behaviour.
- Browser (`HeadlessChrome/154.0.8037.57`, GPU mode hardware,
  `strategy: vulkan-angle`, `http://localhost:3202`): the HUD parts were
  measured live. Canvas measures `1440x900` full-bleed in a 1440x900
  viewport. Shortcut strip renders as `H J K L / déplacer`,
  `← ↑ → ↓ / déplacer`, `+ − / zoom`, `clic droit / menu de l'élément`,

## 7. Verification

- `npx tsc --noEmit`: **0 errors** across all six owned files.
- `npx vitest run tests/unit/feature-interaction.test.ts`: **12/12 pass**.
  Covers pick resolution per range, the point-layer vertex-index path,
  stableId recovery in a multi-point layer, `rangeIndex` propagation,
  range-only duplication, the constant lift, silhouette edge
  cancellation, the point reticle, payload immutability, and group
  replace / clear / unresolvable-pick behaviour.

### Real browser

`HeadlessChrome/154.0.8037.57`, protocol 1.3, GPU mode **hardware**
(`strategy: vulkan-angle`), viewport 1440x900, against `next dev` on
port 3202. The dataset cannot serve a tile (see below), so the real
components were exercised through a temporary harness page that mounts
the **unmodified** `FeatureContextMenu` and `FeatureInspector` and
drives the **unmodified** `highlight.ts` against a real encoded render
tile. The harness was removed after the run.

Adapter evidence from the hardware probe: `strategy vulkan-angle`,
`hardware: true`, WebGPU adapter present, `navigator.gpu` truthy,
`backend=webgpu`.

Measured, in one pass on the live page:

| Assertion | Result |
|---|---|
| Selection resolves a pick and builds a highlight | `{"pick":"road/1@a","rangeIndex":0,"children":2,"menu":null}` |
| Inspector consumes the pick payload | `data-feature-id="road/1@a"`, headings `Mairie de Auch / Identite / Localisation / Attributs / Sources` |
| Inspector shows real values, no placeholders | fields `Identifiant, Type, Categorie, Couche de rendu, Tuile, Statut, Confiance, Adresse, Coordonnees WGS84, Largeur, Position locale, Levels, Building Type` |
| Menu opens on a feature | `role=menu`, `aria-modal=true`, flag `featureContextOpen="true"` |
| Focus lands on the first action | `activeElement.dataset.actionId = "inspect"` |
| `ArrowDown` moves | `inspect` -> `center` |
| `End` jumps to the last action | `center` -> `road` |
| `Home` returns to the first | `road` -> `inspect` |
| `Tab` cycles inside the menu | `inspect` -> `center` (trapped) |
| `Escape` closes | menu removed, `featureContextOpen` back to `null` |
| Road menu exposes the road action | `inspect, center, coordinates, label, identifier, road` |
| Building menu omits the road action | `inspect, center, coordinates, label, identifier` |

Screenshots were inspected, not merely captured. The road menu shows the
accent left rule on the header, the `ROUTE` kind label, a `RESIDENTIAL`
accent chip, the `active` status, the `road_normal` layer, and a real
attribute list (`Largeur 5 m`, `Surface asphalt`, `Max Speed 50`,
`Oneway Non`) derived from the render-tile meta. The building menu
shows `BATIMENT` / `NON QUALIFIE` / `active` / `buildings` with
`Hauteur 9 m`, `Levels 2`, `Building Type yes`, and no road action. The
focused row carries the accent left border and a 13 percent accent wash.

HUD measured live on `/` in the same browser: canvas measures 1440x900
full-bleed in a 1440x900 viewport; the shortcut strip renders as
`H J K L / deplacer`, `fleches / deplacer`, `+ - / zoom`,
`clic droit / menu de l element`, `Echap / fermer`; the reset button
reads `Vue d'ensemble`.

### Not verified: selection by clicking the canvas

`window.__masterMapsTileDiagnostics = { requested: 608, loaded: 0,
failed: 592 }`. The map loads zero tiles, so no feature can be clicked
in the 3D scene. Root cause is the dataset, not the interaction code:

- `/api/map/manifest` serves **9591** tiles (7941 LOD0, 1254 LOD1, 396
  LOD2).
- `data/generated/render/` held **91** `.mmt` files of which **0**
  matched the served manifest. No LOD1 and no LOD2 artifacts existed, and
  `data/generated/tiles/` held **0** matching JSON tiles.
- `/api/map/render/l2_0_1` answers **404** and
  `/api/map/tile/l0_0_17` answers **404**.
- A tile that does exist, `l0_1_1`, returns **200** with a valid MMT1
  container (magic `0x4d4d5431`, version 1, 41984 bytes), so the codec,
  the render route, the worker pool and the GPU cache are healthy.

The data directory was being rewritten by another process during this
session, so the manifest and the artifacts on disk were out of sync at
every sample. Building the missing artifacts is a `data:build` job
outside this task's ownership.

### Related blocker found and routed

`src/lib/data/schema.ts` had `x` and `z` declared with `.default(0)`.
That makes `feature.x` and `feature.z` always defined, so
`buildRenderTile.localGeometry()` takes its
`if (feature.x !== undefined && feature.z !== undefined)` shortcut and
returns a `Point` for every non-Point feature that has no
`localGeometry`, emitting **zero triangles** for every polygon and line
feature. `tests/unit/build-render-tile.test.ts` failed with 11 errors.
The schema has since been corrected and that suite now passes 14/14, but
any tile build run before the fix produced empty geometry.

### Notes for the next agent

Next 16 refuses to start a second `next dev` for the same directory
("Another next dev server is already running"), and the supervised
`bash` service mode tears the server down when the call returns, so a
browser session must use the already-listening server on 3202. A
detached `nohup setsid` fails for the same lock reason. The browser lock
was taken with `mkdir` and released with `rmdir` in the same run.
