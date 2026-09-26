# TASK 07 — NAVIGATION / UX AUDIT (Wave 1)

**Repo:** `/home/ifthenelse/repository/master/maps` · HEAD `fef6f17` · branch `master` · tree clean (no edits made)
**Target under test:** production baseline already running read-only at `http://127.0.0.1:3100/` (no build, no second server started)
**Date:** 2026-09-26
**Method:** static read of every named component + real-browser exercise. Sections are tagged
`VERIFIED` (observed in a running browser or read from dependency source) or `INFERENCE`.

**Browser tooling note (per user directive):** the numeric browser measurements below were collected
BEFORE the directive to move to the guarded `internet` MCP arrived, using the omp-managed
`google-chrome-stable` channel via the `browser` eval global (screenshot capture + Puppeteer
`page.mouse` low-level input + `page.evaluate`). Tool used is labelled per finding. The guarded
`internet` runtime is the required route going forward; a confirmation pass on the guarded runtime is
recorded in section 12 and was blocked on the shared lock for the whole session window.

---

## 1. ENVIRONMENT / RUNTIME FACTS

| Fact | Value | Tag | Tool |
|---|---|---|---|
| `navigator.gpu` present | `true` | VERIFIED | Chrome 1790439696983 |
| WebGPU adapter, default managed Chromium | `null` (no adapter) | VERIFIED | `tab.evaluate` |
| WebGPU adapter, swiftshader flags | `{vendor:"google", architecture:"swiftshader"}` | VERIFIED | `tab.evaluate` |
| Renderer status with adapter | `initialized`, `backend=webgpu`, `renderer-error=none` | VERIFIED | `#scene-diagnostics` |
| Renderer status without adapter | `unsupported`, "Aucun adaptateur WebGPU n'est disponible." | VERIFIED | `#scene-diagnostics` |

**Consequence:** the map is a hard WebGPU-only app. With no adapter, `MapShell.tsx:421` swaps in
`WebGPUUnsupported` and the whole navigation surface (search, layers, inspector) still renders
(`MapShell.tsx:423-424` are gated on `!hasCriticalError && !loading`, NOT on `webGpuStatus`), so
**the search box and layer panel are interactive over a blank screen with no map**. That is a
definite UX defect on any machine without a WebGPU adapter (headless CI, older GPUs, Safari/Firefox stable).

---

## 2. THE #1 DEFECT — THE MAP IS SQUEEZED TO ~15% OF THE VIEWPORT (VERIFIED BY GEOMETRY)

### Root cause (VERIFIED, `file:line`)

`MapShell.tsx:413`
```tsx
<div className="map-shell" ... style={{ position:"fixed", inset:0, overflow:"hidden",
     display:"flex", flexDirection:"column", ... }}>
```
The shell is a **column flexbox**. Its children are rendered as **sibling flex rows**:

- `MapShell.tsx:416` `.map-shell__canvas` — has inline `flex: 1` ✅
- `MapShell.tsx:423` `<MapHud>` → `MapHud.tsx:127` `position:absolute; inset:0` (out of flow, OK)
- `MapShell.tsx:424` `<LayerControls>` → **in flow**, `LayerControls.tsx:76` `.layer-controls-panel` (no `position`)
- `MapShell.tsx:425` `<FeatureInspector>` → **in flow**, `FeatureInspector.tsx:96` `.feature-inspector` (no `position`)
- `MapShell.tsx:426` `<SourceAttribution>` → **in flow**, `SourceAttribution.tsx:39` `footer` (no `position`)
- `MapShell.tsx:428` `.map-shell__inspector-toggle` button → **in flow**, unstyled

### Measured (VERIFIED, `getBoundingClientRect`, Chrome)

At viewport `1440 x 900` with the inspector open, the shell's children measured:

| Child | y | height |
|---|---|---|
| `.map-shell__canvas` | 0 | **139** |
| MapHud overlay | 0 | 900 (absolute, no effect) |
| `.layer-controls-panel` | 139 | 264 |
| `.feature-inspector` | 403 | **419** |
| `.source-attribution` | 822 | 50 |
| `#scene-diagnostics` | 853 | 15 |
| `.map-shell__inspector-toggle` | 872 | 28 |

**Canvas = 1440 x 139 px in a 900 px viewport — 15.4% of the height.**
Canvas backing store was `1800 x 173` (dpr 1.25 applied to the squashed box).

Siblings total 776 px of intrinsic height, so `flex:1` receives the 139 px remainder.
Opening the layer panel costs a further ~230 px.

### Why the CSS never saves it (VERIFIED)

`bash find . -name "*.css" -not -path ./node_modules/* -not -path ./.next/*` returns exactly one
project stylesheet: **`app/globals.css`**. It contains **zero** rules for `.map-shell__canvas`,
`.layer-controls-panel`, `.feature-inspector`, `.map-shell__inspector-toggle`, or `.source-attribution`.
Every panel position comes from inline `style` objects or `<style jsx>` blocks, none of which set
`position: absolute` for these panels. There is no responsive layout anywhere in the project.

**This is the shared-layout-contract bug class the designer skill warns about**: one
`flex-direction: column` parent with `position: fixed` children that were never taken out of flow.
Fixing it means giving the canvas a real full-viewport box (`position:absolute; inset:0`) and
overlaying the panels with `position:absolute` + `z-index`, not tuning the flex numbers.

---

## 3. NAVIGATION INPUT — WHAT ACTUALLY WORKS

| Gesture / key | Result | Evidence | Tag |
|---|---|---|---|
| Mouse wheel zoom | **Works, and IS cursor-anchored** | wheel `deltaY:-600` at (700,400): `target` stayed `[-6144, 0, 6144]`, `zoom 1 → 1.0526` | VERIFIED (Chrome) |
| Left-drag pan | **Works** | drag (900,500)→(780,440): `target [-6144,·,6144] → [-165,·,9131]` | VERIFIED (Chrome) |
| Right-drag heading | **Works**, 1:1 with `ROTATION_SENSITIVITY = 0.005` | 180 px drag → heading `0 → 0.900` rad (180 × 0.005 = 0.90) | VERIFIED (Chrome) |
| Right-drag double-rotation | **Not a bug** — OrbitControls' own `RIGHT=ROTATE` is inert because `enableRotate={false}` | numeric match above | VERIFIED |
| Right-click context menu | **Native menu suppressed, no custom menu** | `contextmenu` fires on `CANVAS` with `defaultPrevented === true` | VERIFIED (Chrome) |
| `H`/`J`/`K`/`L` | **Works but catastrophically overscaled** (see §4) | `L`: `target.x 1587 → 63371` (a **62 km** jump) | VERIFIED (Chrome) |
| Arrow keys | **No effect** | `ArrowRight` left target unchanged | VERIFIED (Chrome) |
| `+` / `-` keys | **No effect** | `zoom` 1.0526315789473684 before, during, after both keys | VERIFIED (Chrome) |
| Reset button | **Works** | `Réinitialiser` → `target [-6144,·,6144]`, `zoom 1`, `heading 0` | VERIFIED (Chrome) |
| Typing in search box | **No key leak** — `shouldHandle()` correctly excludes text tags | typed `auch` with input focused: target/zoom/heading all bit-identical | VERIFIED (Chrome) |
| Search → result → focus | **Works** | `zoom 1 → 19.99`, target moved to Auch, inspector opened | VERIFIED (Chrome) |
| Map click → select feature | **DOES NOT EXIST** (see §5) | source-level | VERIFIED (source) |
| One-finger touch pan | Works (`touches.ONE = TOUCH.PAN`) | `OrbitControls.js:874`, `MapControls.tsx:165` | VERIFIED (dep source) |
| Two-finger pinch | Zoom only; **rotate component inert** | `OrbitControls.js:875` sets `touches.TWO = DOLLY_ROTATE`; `OrbitControls.js:768-773` only reaches `handleTouchStartDollyRotate()` when `enableRotate !== false`; `MapControls.tsx:162` sets `enableRotate={false}` | VERIFIED (dep source) |
| Mobile heading rotation | **Impossible** | `MapCamera.tsx:180-203` gates on `e.button !== 2`; touch has no button 2. `enableRotate={false}` kills the touch path. No two-finger/keyboard alternative exists anywhere. | VERIFIED (source) |

### Why wheel zoom is cursor-anchored despite `zoomToCursor` never being set (VERIFIED)

`MapControls.tsx:156-172` does not pass `zoomToCursor`, and `OrbitControls.js:58` defaults it to
`false`. But `OrbitControls.js:222` reads:
```js
if (scope.zoomToCursor && performCursorZoom || scope.object.isOrthographicCamera) {
```
This is an orthographic camera (`MapCamera.tsx:376` `<orthographicCamera>`), so the anchored branch
runs regardless. **No fix needed — recorded so a future refactor doesn't "fix" it by adding
`zoomToCursor` and change behaviour.**

---

## 4. HJKL PANNING IS ~25x TOO BIG (VERIFIED)

`MapControls.tsx:104-105`
```ts
const halfSpanX = ((camera.right - camera.left) / camera.zoom) * 0.25;
const halfSpanZ = ((camera.top  - camera.bottom)  / camera.zoom) * 0.25;
```
`camera.right - camera.left` is the **full frustum width in world units**, set by
`MapCamera.tsx:103-106` to the **entire territory width × 1.15 padding**. At the default
department view (`zoom = 1`, Gers ≈ 123 km wide) the visible span is ~141 km, so one keypress
moves the target ~35 km.

Measured at `zoom 1.05`: one `L` press moved `target.x` by **61 784 m**. The comment on
`MapControls.tsx:103` says "Move target by 25% of the visible span per keypress" — that is
mathematically what it does, and it is the wrong constant for a map that opens fully zoomed out.
A fixed pixel-denominated step (or a step clamped to a few hundred metres) is required.
`territoryBounds` is accepted on `MapControlsProps:50` and used only as a truthiness guard
(`MapControls.tsx:94`); it never bounds the movement, so **HJKL can pan the camera arbitrarily far
outside the department with no clamp**.

---

## 5. NO CLICK-TO-SELECT, NO CONTEXT MENU, NO HIGHLIGHT (VERIFIED BY SOURCE)

- `MapShell.tsx:175` declares `selectedFeature`. The **only** call site that sets it is
  `MapShell.tsx:374`, inside `handleSearchResultSelect`. Nothing else in `src/` calls
  `setSelectedFeature` (grep-verified).
- `CityScene.tsx:174` wires `onPointerOver` / `onPointerMove` / `onPointerEnter` / `onPointerOut`
  on the business instanced mesh **only** (hover popup). There is **no `onClick`** anywhere in
  `CityScene.tsx` (grep-verified), and the `onFeatureSelect` prop declared at
  `CityScene.tsx:40` is **never passed and never called** — `MapShell.tsx:419` renders
  `<CityScene features={sceneFeatures} layers={layers} />` with two props.
- Roads, buildings, water, landuse, boundary, POIs have **no pointer handlers at all**
  (`CityScene.tsx:169-176` are bare `<mesh>`/`<primitive>` elements).
- Right-click: `MapCamera.tsx:215-217` calls `e.preventDefault()` on `contextmenu` for the canvas
  and nothing else. There is no menu component anywhere in `src/components/map/`.

**Net:** the mission's "right-click context menu on companies/roads with highlight" is entirely
absent, and a user cannot inspect anything except a search result. The hover popup
(`BusinessHoverPopup3D.tsx`) is the only pointer affordance, and it is mouse-only with no
keyboard/touch equivalent.

---

## 6. DEAD UI — FOUR CONTROLS THAT DO NOTHING (VERIFIED)

| Control | Location | Evidence |
|---|---|---|
| **`Étiquettes` (labels) layer** | `LayerControls.tsx:57`, state at `LayerControls.tsx:15,26` | Toggling it changed **nothing**: `building-count 4417`, `road-count 1724`, `water-count 62`, `poi-count 459`, `draw-calls 9` — all **bit-identical** before and after. `CityScene.tsx:43-50` `visible()` never reads `layers.labels`; grep for `labels` across `src/` matches **only** `LayerControls.tsx`. **There is no label rendering code in the project at all** — grep for `Html|Sprite|TextGeometry|texture|font` across `src/components/map/CityScene.tsx` and `src/lib/scene/**` returns **no matches**. Labels are a mission requirement and are entirely unimplemented. |
| **`Zone de chalandise Nocibé` in the inspector** | `FeatureInspector.tsx:140` guard `isNocibe && onToggleAudit` | `MapShell.tsx:425` passes **only** `feature` and `onClose`. `onToggleAudit` is `undefined`, so the guard is always false and the section can never render. The `commercialAudit` layer is settable from `LayerControls.tsx:58` but is read **nowhere** except `MapShell.tsx:375` (a one-way set) — `CityScene.tsx:43-50` has no branch for it. |
| **`Détails` / `Fermer` toggle button** | `MapShell.tsx:428` | `mobileInspectorOpen` (`MapShell.tsx:188`) is **write-only** — grep-verified it is never read except in the button's own label/text. `FeatureInspector` gets no visibility prop, so it renders whenever `feature` is non-null. Clicking flips the label and changes nothing else. Measured: a full-width `1918 x 28` button bar pinned at the bottom of the shell. |
| **`aria-selected` on search results** | `MapShell.tsx:404` | `aria-selected={index === 0}` hard-marks the first of ten results as the selected option regardless of focus, hover, or keyboard position. Actively misleading to screen readers. |

**Also:** the layer `Réinitialiser` button (`LayerControls.tsx:124`) is wired to `resetView`
(`MapShell.tsx:424` → `MapShell.tsx:396`), which resets the **camera**, not the layers. The
`aria-label` says "Réinitialiser les couches" (reset the layers) but the layers are untouched.
`onReset` is typed as a layer reset (`LayerControlsProps:38` "Called to reset all layers to default")
and does something else entirely.

---

## 7. SEARCH UX FRICTION (VERIFIED)

`MapShell.tsx:401-410` renders results as bare `<button role="option">` elements with
**no styling whatsoever** — no `<style jsx>`, no class names, no CSS in `globals.css`. The
container `MapHud.tsx:168-188` gives a white background and a border, but the buttons inherit the
global `input,button,textarea,select { font: inherit; color: inherit }` reset
(`globals.css:106-112`) and render as default UA buttons.

Measured result of typing `Auch`: 10 buttons whose visible text reads
`"Auchpoi"`, `"Auch Caniparcpoi"`, `"Auch Gare Routièrepoi"` — the `canonicalName` span and the
`kind` span are rendered **adjacent with no separator** (`MapShell.tsx:405-406`) and the buttons
run together with no padding or gap, producing an illegible grey block. Confirmed visually in
`/tmp/w1-ux/05-search-auch.png`.

Other measured search friction:
- **Duplicate top results.** Query `Auch` returns three separate `canonicalName: "Auch"` POIs
  (`n391064866` town, `n4197199099` station, `n779169400` stop) and the first ten are dominated by
  near-duplicate stops/stations with no ranking affordance or grouping. The user cannot tell the
  commune from its bus stops.
- **No keyboard navigation.** `role="listbox"` with `role="option"` children but no
  `aria-activedescendant`, no roving `tabIndex`, and no ArrowUp/Down handler. Arrow keys do nothing
  (§3). The list is reachable only by `Tab`-cycling ten buttons.
- **Results vanish on blur with no recovery.** Observed twice: after `page.click` on a result, the
  list was already unmounted. The list unmounts whenever `searchQuery` shortens below
  `SEARCH_MIN_QUERY_LENGTH` (`MapShell.tsx:249-252`) or the user clicks away, and there is no
  Escape-to-close, no focus return, and no persisted selection.
- **`aria-busy` is invisible.** `MapShell.tsx:402` sets `aria-busy={searchPending}` on the listbox,
  but `MapShell.tsx:401` only renders the listbox when `searchHits.length > 0`. During the pending
  window the element carrying the busy state does not exist.
- **The 150 ms debounce** (`MapShell.tsx:275`) re-runs `runSearch` on every keystroke with no
  in-flight cache; the `AbortController` is correct (`MapShell.tsx:246`) but there is no result
  caching, so re-typing a previous query always re-hits the 63 MB index.

**No URL/deep-link surface exists.** Grep for `useSearchParams|searchParams|window.location|
URLSearchParams|hashchange|location.search` across `src/` and `app/` matches **only** the server
route `app/api/map/search/route.ts:14,20`. There is no `?lat=&lon=` or `#lon,lat,zoom` support, so
a location found in the search box cannot be shared, bookmarked, or reloaded. There is likewise no
`window.__masterMaps*` hook for programmatic focus: the only globals are
`window.__masterMapsTileDiagnostics` (`MapShell.tsx:45`) and the `#scene-diagnostics` DOM element
(`MapShell.tsx:427`). Focusing a coordinate required going through the search API in this audit.

---

## 8. INSPECTOR + DIAGNOSTICS OVERLAP (VERIFIED)

With the inspector open, the layout stacks (all left-aligned, all full-bleed on the left edge):
`.layer-controls-panel` y=139 h=264 → `.feature-inspector` y=403 h=419 →
`.source-attribution` y=822 h=50 → `#scene-diagnostics` y=853 h=15 → toggle y=872 h=28.

`#scene-diagnostics` (`MapShell.tsx:427`) is `position:absolute; bottom:2rem` with
`whiteSpace:"pre"` and a 3499 px measured width — it **overflows the viewport horizontally** and
sits underneath the attribution footer and the toggle button. It is `aria-hidden="true"` but
**visually rendered** at `opacity: 0.6`, printing a raw
`renderer-status=… │ backend=… │ …` diagnostic string over the map in production. There is no
dev-only guard (no `NODE_ENV` check, no devtools query flag).

The inspector itself (`FeatureInspector.tsx:210-218`) is `width: 320px; max-height: 100%` with no
`position`, so it becomes a 419 px flex row rather than a fixed right-hand side panel — it is
directly under the layer panel, not beside the map.

---

## 9. THEME SYSTEM IS DEAD CODE (VERIFIED BY SOURCE)

Three independent breaks:

1. **`setThemeTokens` / `syncThemeFromCss` have zero callers.** Grep across `src/` and `tests/`
   excluding the definition file returns nothing. `src/lib/scene/materials.ts:21-23` therefore
   always uses its module-level defaults: accent `#ff7d27`, ink `#000000`, **paper `#f7f4ed`**.
2. **Token mismatch.** `app/globals.css:26` declares `--color-paper: #ffffff`, but
   `materials.ts:23` defaults `_paper` to `#f7f4ed`, and `CityScene.tsx:167` uses
   `getPaperColor()` for the 3D background. The 3D background is `#f7f4ed` while the HTML chrome
   around it is `#ffffff` — a visible seam (VERIFIED in every screenshot: cream map, white panels).
3. **The dark theme is unreachable and half-applied.** `MapShell.tsx:169-174` computes `theme` from
   `localStorage["map-theme"]` or `prefers-color-scheme` into a `useState` **with no setter**
   (destructured as `const [theme]`), and writes it to `data-theme` (`MapShell.tsx:413`). Grep
   confirms **no CSS rule anywhere matches `[data-theme]`** — the only dark rules are the
   `prefers-color-scheme` media query at `globals.css:53-64`. So an OS-dark user gets
   **black panels (`--color-surface: var(--color-ink)`) surrounding a `#f7f4ed` cream map**, and
   there is no UI to change the theme. `map-theme` in localStorage is read but never written by any
   control.

---

## 10. DESIGN-SYSTEM CONFORMANCE (designer rule: exactly 3 roots, one is `#ff7d27`)

The token file `app/globals.css:24-26` correctly declares the three roots:
`--color-accent: #ff7d27`, `--color-ink: #000000`, `--color-paper: #ffffff`. The header comment
(`globals.css:13-19`) documents contrast ratios. **The token layer is compliant.**

**The component layer is not.** 13 raw hex values bypass the tokens entirely
(`grep -rnoE "#[0-9a-fA-F]{3,8}" src/components/map/*.tsx src/lib/scene/*.ts`, excluding the three
roots and their paper variant):

| Hex | Location | Role | Derived from a root? |
|---|---|---|---|
| `#22c55e` | `FeatureInspector.tsx:281` | success / `status-active` | **No — unrelated brand green** |
| `#15803d` | `FeatureInspector.tsx:282` | success text | No |
| `#f59e0b` | `FeatureInspector.tsx:286` | warning / `status-uncertain` | **No — unrelated brand amber** |
| `#b45309` | `FeatureInspector.tsx:287` | warning text | No |
| `#3b82f6` | `FeatureInspector.tsx:291` | info / `status-inferred` | **No — unrelated brand blue** |
| `#1d4ed8` | `FeatureInspector.tsx:292` | info text | No |
| `#ef4444` | `FeatureInspector.tsx:296` | error / `status-unresolved` | **No — unrelated brand red** |
| `#b91c1c` | `FeatureInspector.tsx:297` | error text | No |
| `#6da8dc` | `materials.ts:47` | water fill | No |
| `#c8dcc0` | `materials.ts:53` | landuse fill | No |
| `#d34f2f` | `buildPois.ts:64`, `BusinessHoverPopup3D.tsx:53` | business marker | No |
| `#ffb000` | `buildPois.ts:65` | business hover highlight | No |
| `#a43824` | `BusinessHoverPopup3D.tsx:96` | popup link | No |
| `#171717` | `BusinessHoverPopup3D.tsx:74` | popup body text | No |

`cortex/rule/DESIGN_SYSTEM` (read this session) is explicit: *"DO NOT INTRODUCE UNRELATED BRAND
COLORS FOR SUCCESS, WARNING, ERROR, LINKS, FOCUS, OR CHARTS. DERIVE SEMANTIC STATES FROM THE ROOTS
WHILE PRESERVING ACCESSIBILITY."* The four status-badge pairs are a direct, textbook violation —
`--color-accent #ff7d27` already supplies both the fill and the text at 7.0:1/10.2:1 per
`globals.css:16-18`, and the four semantic states can be carried by accent plus ink-alpha steps
instead. `BusinessHoverPopup3D.tsx` and `buildPois.ts` bypass the token system entirely because
they are not styled-components — they hardcode, so they also **ignore the theme system that is
already dead (§9) and will never respond to it**.

**Direction check:** the current chrome (white rounded panels, `border-radius: 6-7px`, blur
backdrop on the top bar at `MapHud.tsx:28-29`, plain system-ui type at
`globals.css:43-44`) is the "default template appearance" the designer skill bans. The mandated
direction is cinematic / game-adjacent / HUD-like / bevelled / restrained, with the accent used as
an emissive edge. There is no bevel, no emissive treatment, and no elevation logic anywhere —
`MapHud.tsx:28` uses exactly the "unstructured glassmorphism" pattern that is called out as banned.

---

## 11. ACCESSIBILITY FINDINGS (VERIFIED)

- `app/page.tsx:36` puts `role="application"` on `<main>`. This is a well-known anti-pattern: it
  forces screen readers out of browse mode and strips the page's navigation affordances for a map
  that is not a full-screen text application.
- **The `<canvas>` has no accessible name and no fallback content.** No `aria-label` is set on it
  anywhere, and the only alternative text lives in the diagnostics div which is `aria-hidden`.
- **The search listbox is keyboard-unreachable** — `role="listbox"`/`role="option"` with no
  `aria-activedescendant` and no arrow-key handler (§7). `aria-selected` is hardcoded to index 0.
- **Focus visibility is correct.** `globals.css:128-131` defines a 2 px `--color-focus-ring`
  outline at 2 px offset, and `globals.css:134-136` correctly keeps it for `:focus-visible` only.
  `MapHud.tsx:146-149` adds an accent border + 2 px accent glow on input focus. This is the one
  accessibility area that is genuinely in good shape.
- **Reduced motion is respected at the CSS level** (`globals.css:180-189` collapses all
  animation/transition durations), but the **camera damping is a JS animation loop and is not
  affected**: `MapCamera.tsx:47` `DAMPING = 0.08` and `MapControls.tsx:73-74`
  `enableDamping`/`dampingFactor` run regardless of `prefers-reduced-motion`.
- **The mobile toggle button has no `type="button"` sibling issue**, but `.inspector-close`
  (`FeatureInspector.tsx:104-107`) has no `type` attribute either — it defaults to `type="submit"`
  and sits inside no form, so it is currently harmless, but it is a latent form-submit bug.
- **No `lang` mismatch**: `app/layout.tsx:17` sets `lang="fr"` correctly and all user-facing copy
  is French. Copy honesty is good — real source names, real licenses, real version/date, no
  fabricated metrics. Attribution (`SourceAttribution.tsx`) correctly links OSM/IGN/BAN.

---

## 12. GUARDED `internet` RUNTIME PASS

**Blocked on the shared lock for the entire session window.** `mkdir /tmp/master-maps-browser.lock`
was attempted; the directory already existed (a sibling agent held it) and the retry loop ran past
the session. Per the skill contract I did not silently substitute another runtime for the guarded
one during the window it was unavailable — the measurements in §1-§8 are the pre-directive Chrome
runs, labelled with the tool used, and they stand on their own as observed facts. What the
guarded pass would add is only confirmation of: `gpu_mode {"mode":"hardware"}` adapter evidence,
a `390x844` mobile viewport capture of the §2 squash, and `PerformanceObserver`/rAF frame deltas.
None of the §2-§11 findings depend on it — every one is either a `getBoundingClientRect`
measurement, a `#scene-diagnostics` attribute read, a screenshot, or a source/dependency grep.

**Lock was not released by me because I never acquired it.**

---

## 13. PERF / RESOURCE OBSERVATIONS (VERIFIED, Chrome)

Measured at 1440x900, department view, swiftshader:

| Metric | Value |
|---|---|
| Tiles loaded, default view | **119** |
| Features loaded, default view | **36 009** |
| Roads / water / POI | 31 430 / 3 585 / 240 |
| Buildings / landuse | **0 / 0** |
| Draw calls | 7 |
| Tiles after focusing Auch | 19 (5 658 features) |
| Tiles after focusing Masseube | 54 (21 515 features, 12 714 buildings, 180 businesses) |

- **`landuse-count` is 0 at every camera position tested** (department, Auch, Masseube), and
  `building-count` is 0 at the department view. `landuse` is therefore a **no-op toggle in
  practice**, matching the dead-UI pattern of §6. [INFERENCE] the LOD2 tiles probably carry no
  landuse/building geometry; the LOD0 town tiles do carry buildings.
- **`renderer-status=initialized` is not sufficient evidence of a working frame.** At the
  department view the console emitted **250+ uncaptured WebGPU validation errors per capture**:
  `THREE.WebGPURenderer: Uncaptured WebGPU GPUValidationError: Vertex buffer slot 0 required by
  [RenderPipeline "renderPipeline_MeshBasicMaterial_17"] was not set.` … `DrawIndexed(7920, 1, 0, 0, 0)`,
  each followed by `[Invalid CommandBuffer from CommandEncoder "renderContext_0"] is invalid due to
  a previous error.` The result on screen was a **fully black map** at the department view while
  the same app rendered correctly once zoomed into a town. This is the single worst defect found:
  **the default landing view of the entire Gers renders black.** [INFERENCE] a merged geometry is
  being rebuilt/disposed while still referenced by an in-flight render pass, most likely the
  `buildingResult`/`landuseResult` path in `CityScene.tsx:153-163` whose cleanup disposes geometries
  on every `groups` change — note `landuse-count` and `building-count` are both 0 there, so the
  geometry being disposed is exactly the one that is empty.
- One browser tab **crashed outright** (`Target crashed` on `Runtime.callFunctionOn`) during
  search interaction under swiftshader with 36 k features loaded. The box had ~7 GB free with 35
  concurrent Chrome processes from sibling agents, so OOM is the likely cause and is an artefact
  of the concurrent audit, not necessarily of the app. Reported as observed, not attributed.

---

## 14. FRICTION POINTS, RANKED

| # | Severity | Finding | Root cause `file:line` |
|---|---|---|---|
| 1 | **Blocker** | Default department view renders a **black map**; 250+ WebGPU `Vertex buffer slot 0 ... was not set` validation errors per capture | Geometry disposed while an in-flight pass references it — `CityScene.tsx:153-163` dispose-on-groups-change; `landuse`/`building` counts are 0 there |
| 2 | **Blocker** | Map canvas occupies **139 px of a 900 px viewport (15%)** whenever the inspector is open; the layer panel eats a further 230 px | `MapShell.tsx:413` column flexbox + in-flow siblings at `:424`, `:425`, `:426`, `:428`; no CSS for these classes in `app/globals.css` |
| 3 | **Blocker** | **No labels anywhere**; the `Étiquettes` toggle is a verified no-op | `LayerControls.tsx:57`; never read in `CityScene.tsx:43-50`; no text-rendering code in the project |
| 4 | **Blocker** | **No click-to-select, no right-click context menu, no highlight** on any feature | only `setSelectedFeature` call is `MapShell.tsx:374`; `onFeatureSelect` (`CityScene.tsx:40`) never wired; `MapCamera.tsx:215-217` suppresses the native menu and offers nothing |
| 5 | **Major** | `H`/`J`/`K`/`L` move the camera by tens of km per press and are unclamped | `MapControls.tsx:104-105` scales by full frustum width; `territoryBounds` (`:50`, `:94`) never clamps |
| 6 | **Major** | Search results are unstyled, unspaced, `Auchpoi`-concatenated, duplicated, and keyboard-unreachable | `MapShell.tsx:401-410` no styles; `:405-406` no separator; `:404` `aria-selected={index===0}`; no arrow-key handler |
| 7 | **Major** | Theme system is entirely dead; OS-dark users get black panels around a cream map; no toggle exists | `setThemeTokens`/`syncThemeFromCss` have 0 callers; `globals.css:26` `#ffffff` vs `materials.ts:23` `#f7f4ed`; no `[data-theme]` CSS rule; `MapShell.tsx:169` state has no setter |
| 8 | **Major** | 13 raw hex colours violate the 3-root rule | `FeatureInspector.tsx:281-297` (8), `materials.ts:47,53`, `buildPois.ts:64,65`, `BusinessHoverPopup3D.tsx:53,74,96` |
| 9 | **Major** | Mobile users **cannot rotate the map at all** | `MapControls.tsx:162` `enableRotate={false}` kills `touches.TWO=DOLLY_ROTATE` (`OrbitControls.js:768-773`); `MapCamera.tsx:180` needs `button===2` |
| 10 | **Moderate** | Diagnostics string rendered over the map in production, overflowing to 3499 px | `MapShell.tsx:427`, no dev-only guard |
| 11 | **Moderate** | Search and layers are interactive over a blank screen when WebGPU is unavailable | `MapShell.tsx:423-424` not gated on `webGpuStatus` |
| 12 | **Moderate** | Two "reset" controls do different things than their labels claim; `onReset` resets the camera, not layers | `MapShell.tsx:424` → `:396`; `LayerControls.tsx:38,124` |
| 13 | **Moderate** | Three dead toggles: inspector `Détails` button, Nocibé audit section, `commercialAudit` layer | `MapShell.tsx:428` write-only state; `:425` omits `onToggleAudit`; `CityScene.tsx:43-50` has no branch |
| 14 | **Moderate** | `landuse` layer is a no-op in practice (count 0 at every position) | `landuse-count=0` measured at 3 camera positions |
| 15 | **Minor** | `role="application"` on `<main>`; canvas has no accessible name | `app/page.tsx:36` |
| 16 | **Minor** | No URL/deep-link for a focused location; no programmatic focus hook | grep over `src/`+`app/` finds no `useSearchParams`/`URLSearchParams`/`hashchange` |
| 17 | **Minor** | Camera damping ignores `prefers-reduced-motion` | `MapCamera.tsx:47`; `globals.css:180-189` covers CSS only |
| 18 | **Minor** | Chrome is glassmorphic/rounded-card, not the mandated cinematic HUD direction | `MapHud.tsx:28-29,54-57`; `LayerControls.tsx:145` `border-radius:6px`; `globals.css:43-44` |

---

## 15. SUGGESTED FIX ORDER (INFERENCE — not applied, this was an audit)

1. `CityScene.tsx:153-163` dispose logic — restore the black default view.
2. `MapShell.tsx:413` layout contract — take the canvas out of the flex column
   (`position:absolute; inset:0`) and absolutely position the four panels over it. One shared
   constant, no per-panel pixel tuning.
3. Remove or implement `labels`; wire click-to-select and the context menu; pass `onToggleAudit`
   and remove the write-only `mobileInspectorOpen`.
4. `MapControls.tsx:104-105` — clamp the HJKL step.
5. `MapShell.tsx:401-410` — style the result list, add a name/kind separator, add arrow-key
   navigation, fix `aria-selected`.
6. Collapse the 13 raw hexes into the three roots and add the missing `setThemeTokens` call so the
   scene follows the theme.
7. Guard `#scene-diagnostics` behind a dev-only condition.

---

## 16. EVIDENCE INDEX

- Screenshots: `/tmp/w1-ux/00-initial.png`, `01-baseline-department.png`, `02-sample.png`,
  `03-wheel-zoom-in.png`, `04-search-results.png`, `05-search-auch.png`, `06-inspector-open.png`,
  `07-layers-toggled.png`, `08-rural-masseube.png`, `09-canvas-139px.png`, `10-baseline-1440.png`
- Source read: `src/components/map/{MapShell,MapHud,MapCamera,CameraRig,MapControls,LayerControls,
  FeatureInspector,BusinessHoverPopup3D,SourceAttribution,CityScene,WebGPUCityCanvas,
  WebGPUUnsupported,LoadingState}.tsx`, `app/{page.tsx,layout.tsx,globals.css}`,
  `src/lib/{scene/materials.ts,scene/sceneMetrics.ts,scene/buildPois.ts}`
- Dependency source: `node_modules/three-stdlib/controls/OrbitControls.js:46-79,222-263,427-437,
  551,734-814,868-875`, `node_modules/@react-three/drei/core/MapControls.js`
- Commands: `curl /api/map/search?q=…` (5 queries, all returning hits), `grep` for hex/labels/aria/
  `setSelectedFeature`/`setThemeTokens`/`useSearchParams`, `find -name "*.css"`
- Memory read: `cortex/rule/DESIGN_SYSTEM` (authoritative 3-root rule)
