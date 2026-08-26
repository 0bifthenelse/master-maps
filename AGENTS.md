# Agent instructions — master-maps

This file defines canonical agent policy for the master-maps repository. Every agent working in this repository MUST load and follow these rules before editing any file, writing any text, or performing any research.

## Mandatory skill requirements

### 1. Moli skill for headless browser and visual QA

Every agent that needs to perform headless browser interaction, rendered web page research, visual QA, screenshot capture, or CDP automation MUST load the project-local Moli skill before proceeding:

- **Path**: `skills/moli-visual-tests/SKILL.md`
- **Discovery**: `moli` is resolved from `PATH` first. No alternative browser automation tool may substitute for Moli unless Moli fails entirely and the failure is recorded.
- **Requirements**: Moli `serve --layout --host 127.0.0.1 --port 9222` for CDP. Playwright connects via `chromium.connectOverCDP`. Never call `chromium.launch` or permit Playwright to download its own Chromium.
- **Prohibitions**:
  - Never bypass CAPTCHA, login walls, robots restrictions, rate limits, cookies, or profiles.
  - Never treat an error page or login wall as successful evidence.
  - Never silently fall back to another browser.
  - Never claim WebGPU pixel correctness from a Moli-captured canvas.
- **Diagnostics**: Every visual QA session MUST assert DOM state, scene diagnostics (`#scene-diagnostics` element values, or diagnostic route responses), and screenshot inspection via vision when available. Canvas appearance is supplement, not evidence.
- **Artifacts**: Store screenshots, traces, and profiles under ignored `tests/artifacts/moli/`.
- **Failure recording**: Record every Moli failure, crash, or limitation in the source manifest or coverage report. Never silently skip or retry with a different browser.

### 2. Master-writing skill for human-facing prose

Every agent that writes, edits, or rewrites any of the following MUST load the master-writing skill before composing:

- `README.md`
- Any file under `docs/`
- UI copy (labels, messages, error text, accessible names)
- Commit subjects (imperative mood, under 72 characters, factual)
- Commit bodies
- Release notes or changelog entries

**Load path**: The master-writing skill is available as a session-level skill (`skill://master-writing`). Load it explicitly before all prose work. Do not compose UI copy, documentation, or commit messages without it.

**English core**: All human-facing prose MUST use correct English typography with the documented English voice. French labels (`Rechercher dans Auch`, `Couches`, `Sources`) are permitted in UI copy where the plan explicitly calls for them. Documentation, commit subjects, and commit bodies are in English.

### 3. Always-english skill

The always-english skill is ALWAYS active. Every response MUST be written in English and in all caps by default. This skill is not overridden by any project-local file.

## Data policy

### Source-backed data only

Every piece of data that enters the repository — whether as a fixture, a production feature, a search index entry, or a documented claim — MUST have a verified source. Prohibited data origins:

- Invented coordinates, addresses, business names, or building geometry.
- Data derived from unvalidated search snippets without direct source-page verification.
- Data from a source that returned an error, crash, or CAPTCHA wall, unless the exact failure is recorded.
- Data from a worker that returned no structured result.
- Google proprietary geometry, tiles, imagery, or bulk business content.

**Permitted sources**: OpenStreetMap (via Overpass), geo.api.gouv.fr, Base Adresse Nationale (BAN), IGN Géoplateforme (under reusable license), INSEE SIRENE, Annuaire des Entreprises, official business websites, Ville d'Auch, Grand Auch Coeur de Gascogne, Gers tourism, public transport operators, and limited corroborative Google Maps presence checks.

### Ignored data/ volume

All raw downloads, intermediate records, generated tiles, manifests, search indexes, QA artifacts, and runtime data MUST live under the `data/` directory and remain Git-ignored. The `data/` directory is the canonical runtime dataset.

- `data/raw/` — downloaded source responses with hashes, timestamps, and licenses.
- `data/intermediate/` — transformed records before deduplication and tiling.
- `data/generated/` — final tiles, manifest, search index, and coverage report.
- `data/manifests/` — source records, coverage reports, and acquisition metadata.
- `data/search/` — generated search index.
- `data/qa/` — validation reports.
- `data/.gitkeep` — tracked file that keeps the ignored directory visible.

Routes that serve data MUST read from the configured `data/` root (default: `data/`, overridable via `MASTER_MAPS_DATA_DIR`). Routes MUST reject traversal, reject unexpected tile IDs, bound file size, and return structured `503 DATASET_UNAVAILABLE` when the volume is missing.

### No secrets, no proprietary geometry

- Never commit secrets, credentials, API keys, tokens, or private profiles.
- Never redistribute Google Maps tiles, imagery, geometry, or bulk business data.
- Never commit raw downloaded data, generated tiles, or intermediate records to Git.
- Never commit screenshots, traces, Moli profiles, or Playwright artifacts.
- Never commit `node_modules/`, `.next/`, `.env`, or IDE configuration.

## WebGPU diagnostics

Every agent that implements, modifies, or tests the WebGPU renderer MUST ensure these diagnostic rules are followed:

- A `#scene-diagnostics` element MUST exist when `NEXT_PUBLIC_MAP_DIAGNOSTICS=1` or the environment is non-production.
- Diagnostic attributes and text MUST expose: `renderer-status`, `backend`, `loaded-tile-count`, `loaded-feature-count`, `building-count`, `road-count`, `poi-count`, `draw-calls`, `camera-state`, and `renderer-error`.
- Use `unknown` when a metric is genuinely unavailable. Never fill diagnostics with test-only constants or fake data.
- Per-frame updates stay in refs or renderer-native state. Throttled snapshots publish to the diagnostics element, not React state on every frame.
- When WebGPU is unsupported (`navigator.gpu` absent, initialization rejection, device loss), render `WebGPUUnsupported.tsx` or an explicit renderer-error panel. Never silently switch to WebGL.

## Commit policy

Every commit MUST follow these rules:

1. **Subject**: imperative mood, under 72 characters, factual, no humor.
2. **Body**: optional but structured when present. Use English typography per the master-writing skill.
3. **Scope**: a commit addresses exactly one logical change. Do not mix data-model changes with UI changes, or acquisition scripts with scene builders.
4. **Verification**: every commit in a merge or feature branch MUST be green — passing typecheck, lint, and its relevant test scope before it is committed.

## Branch policy

- Feature branches are created from the foundation branch and merged into `feature/auch-2d-map` in dependency order.
- No force pushes to shared branches. No force updates to `master`.
- Never commit city data, generated output, or ignored artifacts.
- Push only `feature/auch-2d-map` after all gates are green.

## Prohibited patterns

- Never invent a street name, address, business name, or feature. Use verified source data.
- Never fabricate a relief, elevation, or terrain grid.
- Never commit a `Rue d'Alsace` feature — the verified name is `Avenue d'Alsace`.
- Never claim WebGPU initialization was successful when it was not.
- Never replace a failed worker's missing report with a pass label or ignored gap.
- Never commit a narrowed test that covers only the success path while ignoring observable error states.
- Never commit a TODO, placeholder, stub, mock, no-op, `// implement later`, or `FIXME` to a tracked branch.

## Canonical document

This file (`AGENTS.md`) is the canonical agent policy for the master-maps repository. It overrides any agent habits, global skills, or default behaviors that conflict with the rules stated here. If a contradiction is found between this file and another file in the repository, this file takes precedence for agent behavior.