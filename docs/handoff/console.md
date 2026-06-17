# Handoff — Console: Aggregate Flow & Embed the Web Components

**Repo:** `kontourai/console` · **Layer:** read-only operating plane · **Depends
on:** Flow follow-ups (`flow-followups.md`), Surface element packaging
(`surface.md`).

## Context

`kontourai/console` is *"one operating plane for the whole suite: claim status,
process status, proof, queues, decisions, freshness, exceptions, next actions."*
It is event-sourced: products emit to `.kontour/events/**/*.jsonl`, state lives
in `.kontour/projections/**/*.json`, rebuilt by deterministic replay. It **never
owns authoritative state** — Surface owns claim trust, Flow owns process. UI is
React+Vite (`console-ui`); shared shapes in `console-core`; an SSE `/stream`
emits `ready` / `state` / `record.accepted`.

## Goal

Aggregate Flow runs into the plane and render them by embedding Flow's and
Surface's dependency-free web components — without centralizing authority.

## Changes

1. **Ingest Flow events:** consume the `.kontour/events` Flow emits
   (`flow-followups.md` §3) and project run state (process graph from
   `stageStatuses` + `needs` edges, gates, evidence, route-backs incl.
   `invalidated_steps`, next action). Treat them as read-only references back to
   Flow's owned run files; do not re-derive trust here.

2. **Embed `<flow-run-panel>`** (Flow's web component, to be built per
   `docs/design/nested-trust-panel.md` packaging) as a custom element in the
   React tree, alongside `<surface-trust-panel>` and
   `<survey-review-workbench>`. Web components are the interop seam — no
   framework coupling.

3. **Surface freshness:** the panels render Surface's `{ status, asOf }` and the
   freshness-transition events; reflect fresh→stale transitions live over the
   existing SSE stream rather than polling.

## Acceptance criteria

- A Flow run appears in the console plane purely from its emitted events, with no
  console-owned authoritative copy of trust or process state.
- `<flow-run-panel>` and `<surface-trust-panel>` render inside the React UI from
  pre-derived projections (no in-browser derivation).
- Recursion shows through: a parent flow's claim that references a child run is
  drillable to the child's panel, and a child going stale surfaces on the parent.

## Coordination

- Align `console-core` record shapes with what Flow emits (`flow-followups.md`
  §3) — ideally Flow depends on `@kontourai/console-core` rather than redefining.
- Element tag names + subpath exports: confirm `<flow-run-panel>` (Flow) and the
  `<surface-trust-panel>` export (Surface) so the React app can import/register
  both.
