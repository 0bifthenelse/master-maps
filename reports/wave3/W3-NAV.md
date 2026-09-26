# W3-NAV: navigation, frame scheduling, layout CSS

**Files owned and changed**: `src/components/map/MapCamera.tsx`, `src/components/map/MapControls.tsx`,
`src/components/map/CameraRig.tsx`, `src/components/map/WebGPUCityCanvas.tsx`,
`app/globals.css`.
**Files added**: `src/components/map/mapNavigation.ts` (pure navigation math),
`src/components/map/useControlOrbit.ts` (dependency-level controls contract),
`tests/unit/map-navigation.test.ts` (18 tests).
**Not touched**: `MapShell.tsx` (lead owns it), `CityScene.tsx`, `LayerControls.tsx`
(wave3-2), `FeatureInspector.tsx` / `MapHud.tsx` (wave3-3).
**Typecheck**: `npx tsc --noEmit` clean on every owned file. `npx vitest run tests/unit/map-navigation.test.ts` 18/18 pass.

---

## 1. Keyboard panning: magnitude, direction, bounds

New pure module `mapNavigation.ts` holds the whole contract:

- `panStepFor(visibleWidth, visibleHeight)` = `clamp(0.12 * min(axis), 25, 400)`.
  The 0.25-of-frustum bug is gone: at department scale (visible 141 km x 88 km) the
  step is the 400 m ceiling instead of 61 784 m (W1_T07 measured that exact overshoot).
- `worldPanFor` rotates the screen direction by the live heading, so `L` always
  moves the map right on screen whatever the current north-up offset is.
  Heading 0.2589 rad: `L` = `(+386.7, -102.4)` m, `|d| = 400` m.
- `territoryBounds` is now a real clamp (previously only a truthiness guard): the
  target is bounded to the Gers expanded by 10 % of its own extent, in a `change`
  listener, so mouse drag, wheel and keys are all bounded.

## 2. Dead keys wired

`arrows` pan with the identical step (`ArrowRight` +400 m, `ArrowUp` +400 m measured),
`+`/`=`/`NumpadAdd` and `-`/`NumpadSubtract` zoom by 1.25 (measured 1 -> 1.2403 -> 1.0093),
`A`/`E`/`[`/`]` rotate the heading by 15 degrees (measured `headingRadians` 0 -> 0.2589 -> 0).
All ignore alt/ctrl/meta (browser zoom shortcut is preserved) and all are excluded while a
text field or `contenteditable` has focus.

## 3. Wheel and zoom range

`OrbitControls`' orthographic cursor-anchored path is untouched (it is already correct, as
W1_T07 recorded). Added: a capture-phase `wheel` listener that normalises `deltaMode` 1 and 2
to notches (16 px and 400 px) so the same physical notch moves the same amount at any
refresh rate, clamped to 3 notches. Zoom range is asserted at every source:
`minZoom` 1 / `maxZoom` 4000 in `MapCamera` and `MapControls`, with `OrbitControls` set to
0.01..4000 so wheel and pinch can never leave the range.

## 4. Touch rotation restored

`enableRotate={false}` stays (it is what gates the *mouse* rotate path), and
`useControlOrbit` forces the touch contract every mount: `touches.ONE = PAN`,
`touches.TWO = DOLLY_ROTATE`, `minPolarAngle = maxPolarAngle = 0`, `screenSpacePanning = false`,
`mouseButtons.LEFT = PAN`. Two-finger pinch zoom and two-finger rotate now both reach
`handleTouchStartDollyRotate` instead of being dropped on the floor. The right-drag handler in
`MapCamera` is narrowed to `e.pointerType === 'mouse'` so a touch never starts a heading drag
on top of the two-finger gesture.

## 5. Cancelable interpolation

`MapCamera` exposes `isInterpolating()` / `cancelInterpolation()`. `cancelInterpolation` snaps
`desiredHeading` and `desiredZoom` to the current values and stops the blend, so no
interpolation survives a user gesture. Every key in `MapControls` cancels first; a pan key
cancels only when an interpolation is actually running, so held-key panning stays crisp.
`prefers-reduced-motion` is honoured in JS (`blend = 1`, instant jumps) - previously the
`DAMPING` constant ignored it entirely.

## 6. Frame scheduling

`frameloop="always"` -> `frameloop="demand"`, dpr `[1, 2]` and `antialias: true` unchanged.
Invalidation sources that now exist:
- drei's `MapControls` `change` listener (pan, wheel, pinch) already calls `invalidate`;
- `useControlOrbit` adds an explicit `invalidate` on orbit `start` and `change`;
- `MapControls` runs a self-terminating rAF loop while the damping pan is unsettled
  (`controls.update()` returning false marks it settled, so the loop ends on settle, not on a
  timer);
- `MapCamera` calls `invalidate()` when it moves anything, which covers focus and reset;
- tile uploads already invalidate through R3F's reconciler (`invalidateInstance`);
- `FrameDemandBridge` (in `WebGPUCityCanvas`) adds a two-frame heartbeat per page view so a
  WebGPU device loss or a visibility change still repaints.

`CameraRig` no longer publishes viewport snapshots on a 100 ms timer. The publish is edge
triggered: identical target/zoom/frustum/heading is not republished, so a static map performs
zero DOM diagnostics work. It also asks for a frame while the camera or the controls are not
settled.

**Root cause found while measuring** (this was the real cost, not the timer): with a strict
top-down camera, `OrbitControls.update()` calls `camera.lookAt(target)` from a position
directly above the target. That is a degenerate basis - the view direction and the up vector
are parallel - so three falls back to the matrix Z axis and rolls the camera a few degrees on
every single update. The controls therefore reported a change forever, which kept a 60 Hz
frame loop alive. Fix: `MapCamera` neutralises `camera.lookAt` (the heading is owned by that
component and applied in `updateMatrixWorld`) and re-asserts the rotation every frame.

## 7. Layout

`app/globals.css` now owns the map layout contract that it previously defined none of:

- `.map-shell` is a block, not a flex column.
- `.map-shell__canvas` / `.map-canvas` are `position: absolute; inset: 0; z-index: 0`.
- `.feature-inspector` is an absolute right rail (`min(21rem, 100vw)`, accent left edge,
  bottom sheet under 640 px). `.layer-controls-panel` absolute bottom-left,
  `.source-attribution` absolute bottom strip, `.map-shell__inspector-toggle` absolute
  bottom-right, `#scene-diagnostics` absolute with `max-width` so it can no longer overflow
  3499 px. Overlays carry `z-index` 10..25 above the canvas.
- Tokens: `--hud-gap`, `--hud-panel-radius`, `--hud-panel-border`, `--hud-panel-shadow`,
  `--hud-accent-edge`, `--map-panel`, `--map-panel-solid`, `--map-edge`, `--map-scrim`, all
  derived from the three roots (`--color-paper` / `--color-ink` / `--color-accent #ff7d27`).
  No raw hex in any owned file.

### REQUIRED MAPSHELL PATCH (lead applies)

`MapShell.tsx:577` and `:580`. The inline `display:flex; flexDirection:column` on the shell and
`flex:1` on the canvas wrapper are the last two things fighting the new CSS. Replace:

```tsx
<div className="map-shell" data-theme={theme} style={{ position: "fixed", inset: 0, overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--color-paper, #ffffff)", color: "var(--color-ink, #000000)" }}>
```
with
```tsx
<div className="map-shell" data-theme={theme}>
```

and

```tsx
<div className="map-shell__canvas" style={{ flex: 1, position: "relative", overflow: "hidden" }}>
```
with
```tsx
<div className="map-shell__canvas">
```

That is the whole patch: `position`, `inset`, `overflow`, `display`, `flexDirection`,
`background`, `color`, `flex` and `position:relative` all come from `app/globals.css` now.
It also drops the two `var(--color-paper, #ffffff)` raw-hex fallbacks, so the token layer is
the only colour source in the tree.

---

## 8. Measured evidence

Guarded `internet` MCP runtime, `HeadlessChrome/154.0.8037.57`, `gpu_mode {"mode":"hardware"}`
returned `{"hardware":true,"strategy":"vulkan-angle","system":{"aux_attributes":{"amdSwitchable":false,...`,
i.e. real hardware over Vulkan/ANGLE on this host. Viewport 1440x900, dpr 1,
`http://localhost:3202/` (the Next dev server already running on 3202; 127.0.0.1 is blocked
cross-origin by dev, so `localhost` is mandatory). Lock `/tmp/master-maps-browser.lock`
acquired with `mkdir`, **released with `rmdir` at the end of every pass**.

| Measurement | Result |
|---|---|
| Canvas box | `1440 x 900` at (0,0), full bleed, with the layer panel open and the inspector present in the tree |
| Layer panel | `x12 y807 208x38 position:absolute z-index:20` |
| Attribution | `x0 y850 1440x50 position:absolute z-index:20` |
| `H`/`L`/`J`/`K` | -400 / +400 / -400 / +400 m at department zoom |
| `ArrowRight`, `ArrowUp` | +400 m x, +400 m z |
| `+` then `-` | zoom 1 -> 1.2403 -> 1.0093 |
| `E` | `headingRadians` 0 -> 0.2589, `rotation.z` matches, `A` returns to 0 |
| Pan with heading 0.2589 | `L` = `(+386.7, -102.4)`, screen-relative east |
| Wheel in / out | 1 -> 1.0526 -> 1.0000, cursor anchored |
| **R3F app frames, 3 s idle** | **0** (was 945 in W1_T05 3.2, 60 fps) |
| 60 fps baseline page, 3 s | 0 rAF callbacks issued at all, so the probe method is sound |
| R3F frames during a zoom settle | 220, i.e. active frames still happen |

Screenshots: `/tmp` capture inspected inline during the session (viewport shot shows the
full-bleed map, top HUD with search + `Vue d'ensemble` + shortcut strip, `Couches` panel
bottom-left, attribution strip at the bottom). The department view shows only the dataset
boundary because `data/generated/render/` holds ~91 `.mmt` files against 9591 manifest
entries, so every LOD1/LOD2 request 503s - a data gap routed to the lead by wave3-3/wave3-4,
not a navigation or rendering defect. It does not affect any measurement above, all of which
read the camera and controls state directly.

## 9. Not done / out of scope

- `MapShell.tsx` is not edited (lead owns it); the exact patch is in section 7.
- `onViewportChange` is still throttled by the lead's `syncDesiredTiles`; the rig now hands it
  a snapshot only when the viewport actually changed, which removes the periodic re-tile
  without touching the lead's function.
- The 60 fps/3 s that remains after the fix is `three`'s own `WebGPUAnimation` rAF chain
  (`_context.requestAnimationFrame(update)` in `three.webgpu.js`), which restarts itself
  unconditionally. It costs no render work (0 R3F frames, 1 draw call), and stopping it would
  mean patching a vendored dependency or abandoning `renderer.setAnimationLoop`, so it is
  reported rather than hacked.
