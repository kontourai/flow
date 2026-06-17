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

## Findings — 2026-06-16

**Repo:** kontourai/console (inspected at branch `main`; the checkout was on
`ci/standardize-release-machinery`, base branch is `main`). **No code changes
made here** — this task is largely PRE-EXISTING, and the parts that aren't are
blocked on a Flow-owner decision + a new Flow web component. Recorded per the
return protocol rather than guessed.

**What already exists in console (so this task is mostly done):**
- **Ingest Flow events — DONE.** `console-server/src/console-foundation/flow-bridge.ts`
  (`deriveFlowRunEvents`) reads Flow's owned `.flow/runs/<run-id>/state.json`
  read-only and derives `kontour.console.event` (v0.1) records, then
  `buildPipeline()` from `@kontourai/console-core`. Authority is correct (Console
  never owns Flow state). This supersedes `flow-followups.md` §3's assumption
  that Flow must emit a generic `.kontour/events/**/*.jsonl` — the real contract
  is **`kontour.console.event` v0.1** and the seam is a read-only bridge.
- **Embed `<surface-trust-panel>` — DONE.** `console-ui/public/surface-trust-panel.js`
  + `console-ui/src/surface-trust-panel-loader.ts` already register and mount the
  Surface element in the React tree.
- **Surface freshness — present.** `console-core/src/operating-state.ts` carries
  `freshness { status, asOf }` and `statusFunctionVersion`; `process-flow.ts`
  renders `freshness: <status>` on claim nodes.

**The real gaps (the only net-new work):**
1. **`<flow-run-panel>` does not exist yet.** console.md change #2 (embed the
   Flow web component) is blocked on Flow shipping a dependency-free
   `<flow-run-panel>` with a stable subpath export (mirroring how Surface now
   ships `@kontourai/surface/trust-panel/element` — see `surface.md`). Flow today
   has a bespoke `src/console-ui` (a full page, not a single embeddable element).
   **Action on Flow first:** extract a `<flow-run-panel>` custom element fed the
   already-derived `FlowConsoleProjection`, export it as a subpath, then console
   embeds it next to `<surface-trust-panel>`.
2. **§3 integration model is a decision, not an implementation.** Because the
   bridge already ingests Flow, do NOT add a second emitter. Confirm with the
   Flow owner whether to keep the bridge (Flow unchanged) or move Flow to push
   `kontour.console.event` v0.1 directly (then retire the bridge). See
   `## Needs decision`.

**Live SSE freshness (change #3):** the SSE `/stream` (`ready`/`state`/
`record.accepted`) and freshness model already exist in console; once a
`<flow-run-panel>` is embedded and Flow's §1 re-derivation emits freshness
transitions (it now does, via `diffFreshness`), the fresh→stale flip can ride
the existing stream. No console change is needed beyond wiring the new panel.

## Needs decision

**§3 integration model (Flow owner).** Two viable paths, both authority-correct:
- **(A) Keep the read-only bridge (recommended, zero Flow change for §3):** the
  console `flow-bridge` already derives `kontour.console.event` v0.1 from Flow's
  owned run files. Flow ships nothing new for §3; the §2 run-output bundle and
  §1 freshness transitions become richer payloads the bridge can pick up.
- **(B) Flow pushes `kontour.console.event` v0.1 directly:** Flow depends on
  `@kontourai/console-core`, emits the records itself, and the bridge is retired.
  More moving parts; only worth it if a push model is required. If chosen, the
  exact `kontour.console.event` shape must be agreed with the console owner
  before Flow implements it.

**STOP — do not implement §3's `.kontour/events` emitter or build
`<flow-run-panel>` until the Flow owner picks (A) or (B).** Implementing the
generic `.kontour/events` schema as originally written would conflict with the
existing bridge contract. Recorded, not guessed.
