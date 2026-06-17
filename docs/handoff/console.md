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

## Findings — 2026-06-16 (verification pass: typed flow-bridge ingest)

**Repo/PR:** kontourai/console, branch `claude/flow-contract-typed-ingest`
(off `main`; committed locally, not pushed). The checkout had UNRELATED dirty
work (`console-ui/public/surface-trust-panel.js`, `demo/grounded-answer/*`, a
stash) — left untouched; only my two files were staged.

**Task E.3 — flow-bridge now consumes Flow's EXPORTED contract types
(RESOLVED DECISION 2).** Replaces the original §3 "Flow must emit generic
`.kontour/events`" plan and the (A)/(B) fork below. The integration model is the
ConsoleSink seam:
- Added `@kontourai/flow` (`^1.3.0`) as a dependency of `console-server`.
- `console-server/src/console-foundation/flow-bridge.ts` now imports Flow's
  exported `FlowConsoleTransitionProjection` / `FlowConsoleRunIdentity` from the
  stable subpath `@kontourai/flow/console-contract` (type-only import with
  `resolution-mode: "import"` — the bridge is CJS, Flow is ESM) and uses them to
  type the on-disk transition/run-state shapes instead of redefining them inline.
- Authority is unchanged: the bridge stays **read-only** over Flow-owned files,
  pulls in **no** Flow runtime (the type imports erase at compile time — the
  compiled `flow-bridge.js` has zero `@kontourai/flow` reference), and console
  still wraps everything in its own `kontour.console.event` envelope on ingest.
  Console does NOT centralize authority.
- **Tested:** full console `typecheck` (all 4 workspaces) clean; console-server
  build clean; `console-server/test/flow-bridge.test.ts` (5) + the full
  console-server suite (126) + console-core (45) + content-boundary all pass.
  **Not run here:** the top-level `npm test` end-to-end (Playwright + dev-local)
  — the changed surface is type-only and covered by the bridge tests + typecheck.
- **Vendoring note (publish-before-merge):** `@kontourai/flow` 1.3.0 (with the
  new `./console-contract` subpath) and the updated `@kontourai/surface` are not
  published; Flow's built `dist` was vendored into console's
  `node_modules/@kontourai/flow` to typecheck/build. Publish Flow 1.3.0 (and the
  freshness-bearing Surface) before merging console. A runtime `import` of the
  contract module from console currently fails only because console's vendored
  Surface is 1.0.1 (lacks `checkpointFromReport`/`diffFreshness`); the bridge
  uses **type-only** imports so this never executes — but bump console's Surface
  when the freshness-bearing Surface ships.

**`<flow-run-panel>` (console.md change #2) remains a separate net-new task**,
unchanged by this pass: Flow still ships only `<surface-trust-panel>` (vendored)
in its console drawer; a dependency-free `<flow-run-panel>` subpath element has
not been extracted. Not in scope for this verification pass.

## Needs decision

**§3 integration model (Flow owner) — RESOLVED 2026-06-16: ConsoleSink seam.**
Flow does NOT emit generic `.kontour/events` and does NOT depend on
`@kontourai/console-core`. Flow owns the `FlowConsoleProjection` payload and a
`ConsoleSink` seam: `FileConsoleSink` (local, default) + `HostedConsoleSink`
(optional HTTP push of the SAME payload). Console depends on
`@kontourai/flow/console-contract` for the types (done above) and keeps the
read-only bridge as the local seam. The earlier (A)/(B) fork is superseded — Flow
neither emits `kontour.console.event` nor depends on console-core.

**Hosted-ingest API contract (CONSOLE owner) — OPEN, tracked follow-up.**
`HostedConsoleSink` POSTs Flow's `FlowConsoleProjection` to a configurable
endpoint with `content-type: application/json` and optional bearer auth. The
**console-side ingest endpoint does not exist yet** — its URL, auth scheme, and
the envelope/ack semantics are a console contract still to be defined. The sink
is functional against any URL today, but the request/response shape it assumes is
**NOT a ratified console API**. Console owner to define:
- the ingest route (path, method, expected status codes / ack body),
- auth (bearer token? mTLS? signed?),
- whether the body is the raw `FlowConsoleProjection` or a console-wrapped
  envelope, and idempotency/dedup keys for re-POST safety.
Until then, treat `HostedConsoleSink` as a functional-but-unwired push path; the
default `FileConsoleSink` + read-only bridge is the supported model. Recorded,
not fabricated.
