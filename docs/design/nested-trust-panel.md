# Nested Surface Trust Panel in the Flow Console — Design Document

**Status:** Exploration / spec for implementation. Drives `docs/handoff/surface.md`
(element packaging) and `docs/handoff/flow-followups.md` §4 (Flow wiring).

## Why

Flow consumes Hachure TrustBundles as gate evidence and stores the
Surface-derived `bundle_report` (a `TrustReport`) per evidence entry. Surface
already ships a read-only web component, `<surface-trust-panel>`, that renders a
`TrustReport`. Embedding it **inside** Flow's evidence drawer is the UI face of
the recursion: a Flow run is process state, and each piece of its evidence is a
trust surface you can drill into — rendered by the component that owns trust,
not reimplemented in Flow.

This dogfoods the "by reference, not embedding" rule at the UI layer: Flow does
not re-derive or re-style trust state; it hands Surface's element the
pre-derived report and lets Surface render it.

## The element contract (from Surface)

- **Tag:** `<surface-trust-panel>`
- **Import:** `@kontourai/surface/dist/src/trust-panel/surface-trust-panel.js`
  (registers the custom element). A stable subpath export is requested in
  `docs/handoff/surface.md`.
- **Input:** `.report` JS property — a **pre-derived `TrustReport`** (output of
  `buildTrustReport` / `surface report`). It **never re-derives** from a raw
  bundle. Alternatively `src` attribute to fetch a report by URL.
- **Optional:** `heading` attribute.
- **Theming:** inherits host via CSS custom properties `--k-text`,
  `--k-text-muted`, `--k-panel`, `--k-panel-raised`, `--k-line`, `--k-positive`,
  `--k-caution`, `--k-negative`, `--k-font-ui`.

The "pre-derived `TrustReport`" requirement is the key fit: Flow already has
exactly this object as `evidence.bundle_report`.

## Flow integration points (concrete)

1. **Projection passthrough** — `src/console/console-projection.ts`:
   - Add `bundle_report: Record<string, unknown> | null` to
     `FlowConsoleEvidenceProjection` (interface near line 75).
   - In `projectEvidence` (near line 368) add
     `bundle_report: entry.bundle_report ? stableClone(entry.bundle_report) : null`.
   - **Test impact:** `tests/node/check-console-projection.test.mjs` does an exact
     `assert.deepEqual(actual, expected)`; update the expected fixture so every
     evidence entry carries `bundle_report` (null where absent).

2. **Console-UI type** — `src/console-ui/types.ts`: add
   `bundle_report: Record<string, unknown> | null` to `ConsoleEvidence` and carry
   it through the projection→ConsoleEvidence mapper.

3. **Drawer mount** — `src/console-ui/drawer.ts`, in `renderEvidenceSection`
   (line 133): when `ev.bundle_report` is present, create a
   `<surface-trust-panel>`, set `el.report = ev.bundle_report`, and append it to
   the evidence row. Map the console's palette onto the `--k-*` variables so the
   nested panel matches the drawer. Degrade gracefully: if the element module is
   not loaded the unknown element renders empty (setting `.report` is harmless),
   so this never breaks the drawer.

4. **Element delivery (packaging — the cross-repo bit):** the element JS must be
   served to the browser. Options, in order of preference:
   - Surface publishes a consumable standalone bundle; Flow vendors it into
     `src/console-ui/vendor/` (a `vendor/` dir already exists) and imports it,
     mirroring how Survey ships `/review-workbench/element`.
   - Or the console plane (`kontourai/console`) hosts both elements and Flow's
     drawer is rendered there. See `docs/handoff/console.md`.

## Acceptance criteria

- An evidence entry with a `bundle_report` renders a `<surface-trust-panel>`
  showing the derived claim states (verified / stale / disputed / missing),
  themed to match the drawer.
- No trust derivation happens in Flow's browser code — the panel only receives
  the already-derived `TrustReport`.
- Projection and Playwright tests updated and green.

## Non-goals

- Flow re-implementing trust visualization (use Surface's element).
- Flow deriving or mutating trust state in the browser (pre-derived report only).
- Bundling Surface's full UI — only the dependency-free panel element.
