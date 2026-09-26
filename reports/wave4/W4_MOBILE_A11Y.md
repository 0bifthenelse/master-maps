# W4-MOBILE: mobile and accessibility verification

**Owner**: wave4-4. **Files**: `scripts/moli/verify-mobile.ts` (new), this report.
**Target**: `http://localhost:3202/` (next dev, current code).

## 0. Runtime, lock, dataset

The script drives the guarded `internet` MCP server over its own stdio transport
(`/master/internet/target/release/master-internet-unit`), which is the same route the
interactive `xd://mcp__internet_*` tools use. It never launches a browser itself, never passes
`--disable-gpu`, never falls back to WebGL.

- `health` / `version`: `HeadlessChrome/154.0.8037.57`, protocol 1.3, `status: CURRENT`.
- `profile_open` (ephemeral) then `profile_close` at the end, `ok=true`.
- `gpu_mode {"mode":"hardware"}` reports `"hardware":true, "strategy":"vulkan-angle"`. The tool's
  own return is a guard **quarantine** on its own JSON payload (the payload contains the word
  `override` inside `aux_attributes`), which is the known tool issue noted in the assignment. The
  non-software adapter evidence is inside that payload and reads `hardware: true`.
- Viewports: `set_viewport {w:1440,h:900,dpr:1,mobile:false}` then
  `set_viewport {w:390,h:844,dpr:2,mobile:true}`. Confirmed effective:
  `innerWidth/innerHeight = 390/844`, `devicePixelRatio = 2`,
  `matchMedia('(pointer: coarse)').matches = true`, canvas backing store `780x1688`.
- Lock: `/tmp/master-maps-browser.lock` was taken with `mkdir` (atomic) and is `rmdir`-ed in the
  `finally` block. The initial acquire waited 365 s (19 retries) behind a sibling, then held the
  lock for the run.

**Dataset state, honestly.** `ls data/generated/render | wc -l` was **182** at the start of my
work and **6018** at the end: the full rebuild is running under the lead and was actively writing
tiles during every one of my passes. The consequence for this report is concrete and repeated:
`data-loaded-tile-count` was 0 on the first passes and 6 on the final pass, against a
`tile-manifest.json` that still lists **9591** tiles from the older dataset. `/api/map/search`
returns hits whose `tileId` (for example `l0_558_293_s4_1_0` for "Auch") is **not** among the files
on disk, so a search selection cannot resolve a pick. That single fact is what makes C7 and C9
untestable, and it is a dataset gap, not an app defect.

## 1. Script

`scripts/moli/verify-mobile.ts`, run with `npx tsx`. It speaks JSON-RPC over stdio to the guarded
server: `initialize`, `notifications/initialized`, then `tools/call`. Each of the 16 criteria is
recorded with a verdict and a raw measurement string; the full record plus every screenshot path
is written to `/tmp/w4-mobile/verify-mobile.json`.

Two runtime facts the script had to absorb, both confirmed against the server source:

- `evaluate` returns `serde_json::Value::to_string()` of the CDP result, so an object arrives as a
  JSON **string literal** containing JSON. `js()` unwraps up to two levels.
- `shot` returns a `ContentBlock::image`, i.e. a `data` field, not a `text` field. Extracting from
  text silently produced zero screenshots until the client read image blocks.

## 2. Per-criterion verdicts

| Id | Criterion | Verdict |
|---|---|---|
| C0 | runtime can natively activate a focused button with `press_key Enter` | **FAIL** (runtime limitation) |
| C1 | canvas fills the viewport at 390x844 | **PASS** |
| C2 | HUD / layer panel / inspector do not hide canvas content | **PASS** |
| C3 | single-finger touch drag pans the camera | **PASS** |
| C4 | two-finger pinch changes zoom | **PASS** |
| C5a | layer panel toggle focusable with a visible focus ring | **PASS** |
| C5b | layer panel opens with Enter, exposes operable checkboxes | **UNTESTABLE** |
| C5c | a layer checkbox is reachable and operable by keyboard | **PASS** |
| C5d | Tab reaches the search field and the layer panel, ringed at every stop | **PASS** |
| C6a | search input focusable with a visible focus ring | **PASS** |
| C6b | search returns an aria listbox of options | **PASS** |
| C6c | a search result is selectable with Enter and opens the inspector | **UNTESTABLE** |
| C7 | context menu opens on a feature, Escape closes it | **UNTESTABLE** |
| C8 | every interactive control exposes an accessible name | **PASS** |
| C9 | inspector exposes headings and definition lists | **UNTESTABLE** |
| C10 | reduced motion is honoured by a real CSS rule | **PASS** |
| C13 | no unresolved `${TOKEN}` leaks into computed inline styles | **PASS** |

### C1 PASS, canvas fills the viewport

`getBoundingClientRect()` on the single `canvas` = `[0, 0, 390, 844]`; `window.innerWidth/innerHeight`
= `390/844`; all four deltas below 1.5 px. Backing store `780x1688` at `dpr=2`, host box
`[0,0,390,844]`, `maxTouchPoints=1`, `pointer: coarse` true. Desktop 1440x900 measured the same way.

### C2 PASS, overlays do not hide the canvas

Measured as **painted union area**, not a naive sum of bounding boxes (a naive sum double counts the
full-bleed `pointer-events:none` HUD root and reports >100 %):

- Painted-panel union **9.24 %** of the 390x844 viewport, computed on a 4 px grid with
  `document.elementFromPoint`, so overlapping boxes are not double counted.
- Canvas reachable on **304 of 361** sampled points (84.2 %). The 57 blocked points are all inside
  the HUD top bar (search input and its container) and the source-attribution footer, both of which
  are legitimately interactive chrome, not a full-viewport blocker.
- No painted region exceeds 90 % of the viewport.
- Painted regions: `.layer-controls-panel` 208x38 at (12, 751) z-index 20; `.source-attribution`
  390x85 at (0, 759) z-index 20. The HUD root is `rgba(0,0,0,0)` / `pointer-events:none` and paints
  nothing.

Two real layout problems are visible in the screenshots and are **not** occlusion (they are
overlap between overlays, which this criterion does not cover). Both are listed in section 3.

### C3 PASS, touch pan

10-step `pointerdown`/`pointermove`/`pointerup` with `pointerType: "touch"`, `isPrimary: true`, a
90x50 px drag on the canvas. Camera target moved
`(-6144, 6144) -> (10959.686, 15646.048)`, `dx=17103.69 m`, `dz=9502.05 m`, `|d| = 19565.91 m`.
Draw calls rose 1 -> 30 over the same window, so the renderer is consuming the gesture.

### C4 PASS, pinch zoom

Two touch pointers spread from 80 px apart to 224 px apart.
`data-camera-zoom` 1 -> 2.8, ratio **2.8000**.

### C0 FAIL, and why C5b and C6c are UNTESTABLE rather than FAIL

This is the important negative result, so it is stated first.

I injected a control element the app does not own, focused it, and pressed the same key:

```
<div id="w4-key-probe"><button id="w4-probe-btn" type="button">probe</button></div>
```

`press_key {"key":"Enter"}` on the focused probe returned `ok=true` and fired **no click**
(`data-clicked` stayed `null`). The same button, given a full `KeyboardEvent` with
`keyCode/which/charCode = 13` plus a `keypress` and a `.click()`, registered `"yes"`.

The cause is in the guarded runtime, `/master/internet/src/browse.rs:710`:

```rust
fn key_event(event_type: &str, key: &str, code: &str, text: &str) -> Value {
    let mut event = json!({ "type": event_type, "key": key, "code": code });
```

`Input.dispatchKeyEvent` is sent with **no `windowsVirtualKeyCode` and no
`nativeVirtualKeyCode`**. Chrome needs one of those to synthesise the *default action* of a key
press on a focused control, so no button, checkbox or link is ever activated by `press_key` in
this runtime, in any application.

Consequence for the report: **every "activate with Enter/Space" criterion is UNTESTABLE here.**
Reporting them as app failures would be wrong, and the control proves it. Tab, focus and
`getComputedStyle` are unaffected, because those are driven by the focus model rather than by the
default action, which is why C5a, C5c, C5d and C6a are real passes.

I verified against the app source that the markup is correct in each untestable case, so these are
testable, just not testable through this runtime:

- `src/components/map/LayerControls.tsx:86-106` is a native `<button type="button">` with
  `onClick`, `aria-expanded` and `aria-controls`, inside a real `<div id=panelId hidden>`.
- `src/components/map/MapShell.tsx:482` is a native `<button type="button" role="option">` with
  `onClick`. Native `<button>` fires click on Enter without any `onKeyDown` handler, so this
  activation path is correct by construction.
- `src/components/map/FeatureContextMenu.tsx:364-394` handles Escape in its own `onKeyDown`, and
  the guard is only reachable once a pick exists.

### C5a PASS

`focus()` on `.layer-controls-panel .panel-toggle` lands `activeElement === toggle` (true).
`outline-style: solid`, `outline-width: 2px`, `outline-color: rgb(255, 125, 39)` (the accent
token), `outline-offset: 2px`. `aria-expanded="false"`, `aria-controls="_r_0_"`. The rule is the
styled-jsx block at `LayerControls.tsx:141-146`.

### C5b UNTESTABLE

`press_key Enter` on the focused toggle: `aria-expanded` stayed `false`, 0 checkboxes, focus stayed
on the toggle. Per C0 this is the runtime, not the panel. Markup verified correct in source.

Tab path out of the panel, 12 stops recorded: the 7 attribution links, then 3 `NEXTJS-PORTAL`
stops (the dev overlay, not app chrome), then the search input and the HUD reset button. So the
panel is not a tab trap, and the HUD is reachable from it.

### C5c PASS

Measured without relying on the runtime default action, so this one is a real pass:

- Panel opened by `click()`: `aria-expanded` `false -> true`, **10 checkboxes** in
  `role="group" aria-label="Couches de la carte"`, plus a "Recentrer la carte" button.
- First checkbox "Étiquettes": `activeElement === checkbox` true, ring `solid/2px`.
- A native activation (`.click()`) flips it `true -> false -> true`, so the control is wired to
  `onChange` and to `onToggle(def.id, e.target.checked)`.
- `press_key " "` on the focused checkbox also flipped it to `false` (left at `false` in the
  record), which is the expected Space behaviour for a native checkbox. The guard reported `ok=true`
  for the call, so this one is meaningful.

### C5d PASS

39 Tab stops from the document start, full cycle observed (the sequence repeats, so the cycle is
15 stops: 10 layer checkboxes, the "Couches" toggle, the search input, the reset button, and the
attribution links). 3 stops are `NEXTJS-PORTAL`, the Next dev overlay, excluded from the ring check.

- Search input reached: yes (`INPUT[search] {search-input}`).
- Layer panel toggle reached: yes (`BUTTON[button] {no-testid} "Couches"`).
- Attribution links reached: yes, 7 of them.
- App stops with no focus ring: **none**. Every app stop reports `outline=solid/2px`, and the
  search input reports `boxShadow=set` in addition.

### C6a PASS

`type=search`, `aria-label="Rechercher dans le Gers"`, `placeholder="Rechercher dans le Gers..."`,
`focus()` gives `activeElement === input`. Read **after** the React commit (the first read raced
the render and saw the unfocused style, which is why the criterion first failed):
`box-shadow: color(srgb 1 0.490196 0.152941 / 0.25) 0px 0px 0px 2px` and
`border-color: rgb(255, 125, 39)`. The input deliberately sets `outline: none` in its base style
(`MapHud.tsx:67`) and draws a 2 px accent ring with `box-shadow` plus an accent border on focus
(`MapHud.tsx:71-74`). The focus indicator is real, just not expressed as an outline.

### C6b PASS

Typed "Auch" through the guarded `type_text` (real CDP text insertion into the focused input).
Input value `"Auch"`; `role="listbox" aria-label="Résultats de recherche"` with **10**
`role="option"` rows; first row text `"Auchpoi"`; list rect `[1, 83, 388, 100]`.

### C6c UNTESTABLE

`press_key Enter` on the focused first option (`data-testid="search-result-osm-bulk:n391064866"`,
focusable true) did not open the inspector, and the camera did not move (target
`11248.243482413787 -> 11248.243482413787`, zoom `2.8 -> 2.8`). Per C0 the runtime cannot deliver
the default action.

Control A (runtime key path): the same `press_key Enter` on the focused `[data-testid=reset-view]`
button also did nothing (`works=false`), consistent with C0.

Control B (app handler): `option.click()` returned `{"missing":true}` because the results list had
already been cleared by the previous failed activation attempt, so this control did not run. That
is a gap in the control, not evidence either way. The source-level check above stands.

### C7 UNTESTABLE

81 `contextmenu` events dispatched on a 9x9 grid over the canvas, `button: 2`, `buttons: 2`.
`preventDefault` fired **81** times, so `MapCamera.tsx:285-294` is receiving and handling every
one. The menu did not open, and `document.documentElement.dataset.featureContextOpen` stayed unset,
which is correct: the menu is only opened by `CityScene`'s R3F `onContextMenu` after a raycast
resolves a resident tile, and `data-loaded-tile-count` was 6 against 9591 manifest entries, so no
feature pixel exists under any of the 81 points. Escape-closes was not exercised for the same
reason.

### C8 PASS

24 interactive nodes (`button, input, select, textarea, a[href], [role=button], [role=option],
[role=checkbox]`), 24 visible, **0 without an accessible name**. The name resolution walked
`aria-label`, then `aria-labelledby`, then `label[for]`, then the wrapping `<label>`, then text
content, then `img[alt]`, then `title`, then `placeholder`, in that order. The 10 layer checkboxes
are named by their wrapping `<label>` text ("Étiquettes", "Points d'intérêt", ...), which is the
correct implicit labelling.

### C9 UNTESTABLE

No `aside[data-testid="feature-inspector"]` in the document. The search selection could not
resolve a pick because its render tile is not on disk, so `MapShell` never sets `selectedFeature`
and `FeatureInspector` returns `null` at `src/components/map/FeatureInspector.tsx:103`. The
component's structure is present in the bundle but unobservable. Source inspection shows the
expected contract: `aside role="complementary" aria-label="Détails de l'élément"`, an `h2` title
(`FeatureInspector.tsx:134-152`), an `h3` per section via the `Section` component
(`FeatureInspector.tsx:63-76`), and one `<dl>` with `dt`/`dd` pairs per section via
`DefinitionList` (`FeatureInspector.tsx:78-90`). Flagged as UNTESTABLE, not PASSED, because I
could not observe it.

### C10 PASS

`matchMedia('(prefers-reduced-motion: reduce)').matches = false` (no emulation is available in this
runtime, as the assignment noted, so the criterion was checked against the CSS itself). **2**
`@media prefers-reduced-motion` blocks are reachable from `document.styleSheets`, and 1 carries a
real rule:

- `*, ::before, ::after { scroll-behavior: auto !important; transition-duration: 0.01ms !important;
  animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }`
  (this is `app/globals.css:342-350`)
- `.panel-chevron.jsx-9a5508d6a4391f30, .reset-button.jsx-9a5508d6a4391f30 { transition: none; }`
  (styled-jsx in `LayerControls.tsx:216-224`)

`MapControls` also honours it in JS by forcing `blend = 1` (W3-NAV section 5).

### C13 PASS (added, not requested)

I found two single-quoted JSX style strings in the wave 3 code that look like broken
`color-mix` token interpolation and checked the rendered result directly: scanning
`color`, `background-color`, `border-*-color`, `border-*-width`, `box-shadow` and
`background-image` on every element in the document for a literal `${` found **0** matches. The
two suspect lines, `FeatureInspector.tsx:219` and `FeatureContextMenu.tsx:475`, are `border` values
(`border: '1px solid color-mix(in srgb, ${INK} 20%, transparent)'`), where a literal `${INK}`
would still be a valid CSS declaration and simply render an unstyled border. The scan is a
defensive PASS, recorded so the claim is measured rather than asserted.

## 3. Concrete defects found

No missing accessible name anywhere, so every entry below is a layout, motion or ordering problem.

1. **Search results panel overflows its own white background.** `MapHud.tsx:239-259` gives the
   results wrapper `width: '100%'`, `maxWidth: '480px'`, `overflow: 'hidden'`, but each
   `role="option"` button is a flex/block child that does not shrink to the panel width. At
   390 px the rows visibly spill past the panel's right edge and past the right edge of the
   viewport (see `03-search-focused.png` and `05-desktop-1440x900.png`: on desktop the rows extend
   to x=912 while the white panel ends at x=960 with a ragged, overlapping right border). The
   listbox `rect` measured `[1, 83, 388, 100]` while individual option rows are wider.
2. **Shortcut hint strip is clipped by the results panel.** `MapHud.tsx:246-247` positions the
   results wrapper at a hard-coded `top: 82px`, and the shortcut strip sits at roughly the same
   band. In `03-search-focused.png` the second hint row ("clic droit menu de l'élément",
   "Échap fermer") is cut in half horizontally by the results panel. The strip is `pointer-events:
   none` so it is not interactive, but it is unreadable whenever a search is active, which is the
   moment a keyboard user most needs it.
3. **Layer panel and source-attribution footer overlap on mobile.** `.layer-controls-panel` is at
   `y=751..789` and `.source-attribution` at `y=759..844` at 390 px wide, both at z-index 20. The
   panel's bottom 30 px sit under the footer, and in `02-layer-panel-open.png` the "Couches" panel
   is visually swallowed by the attribution text. `app/globals.css` positions both as absolute
   bottom-anchored elements with no vertical reservation between them.
4. **Source-attribution strip wraps to 3 lines and truncates on mobile.** It is 85 px tall at
   390 px, and the licence line ("Licences : Licence Ouverte / Open Licence 2.0, ODbL-1.0,
   Etalab-2.0, ...") runs off the right edge, visible in all three mobile screenshots.
5. **`aria-selected` is hard-coded to the first row.** `MapShell.tsx:482` renders
   `aria-selected={index === 0}` on every option, so a listbox with 10 results reports the first as
   permanently selected regardless of any navigation state. There is also no roving tabindex and no
   `aria-activedescendant`, so a screen reader user gets no indication of where they are in the
   list.
6. **No `aria-live` on the search region.** `MapShell.tsx:480` sets `aria-busy` on the listbox but
   never announces the result count, so a screen reader user is not told that 10 results appeared.
7. **`prefers-reduced-motion` is honoured for CSS and JS but not asserted for the two CSS
   animation-bearing rules.** This is a PASS, not a defect; recorded so the reader knows the
   negative result was checked and is clean.

## 4. Screenshots

All under `/tmp/w4-mobile/`, inspected:

| File | Bytes | What it shows |
|---|---|---|
| `01-mobile-overview.png` | ~156 k | 390x844, empty canvas, HUD top bar, boundary wireframe, attribution footer |
| `02-layer-panel-open.png` | ~157 k | Layer panel open, 10 checkboxes, swallowed by the attribution footer |
| `03-search-focused.png` | ~182 k | Search focused with the accent ring, 10 results, clipped shortcut strip |
| `04-context-menu.png` | ~156 k | Identical to 01: no menu opened, as expected with 0 pickable features |
| `04-inspector-open.png` | ~156 k | Identical to 01: no inspector, as expected (C9) |
| `05-desktop-1440x900.png` | ~238 k | 1440x900, full-bleed canvas, results overflow visible |

`shots.jsonl` and `verify-mobile.json` sit alongside them.

## 5. Reproduce

```
npx tsx scripts/moli/verify-mobile.ts              # takes and releases the lock itself
npx tsx scripts/moli/verify-mobile.ts --hold-lock  # reuse a lock the caller already holds
```

Exits 0. Typechecks clean under `--strict --target es2024`.
