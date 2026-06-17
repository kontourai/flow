# Route-Back Cascade, Trust Freshness & Bundle Recursion — Design Document

**Status:** Exploration. Not yet decided. Captures a design conversation so it
does not evaporate; individual pieces will graduate to ADRs / phased work.

**Branch context:** follows the Phase 1 dependency DAG
(`docs/design/dependency-dag.md`). That work added `needs`, `predecessorsOf`,
`readySteps`, `readyGates`, and `stageStatuses` as pure derivations over the
single-cursor model. This note explores what the DAG makes newly possible.

---

## Summary

Now that a step can have multiple dependents (`needs`), four threads connect:

1. **Route-back cascade** — a route-back to an upstream step should invalidate
   the gate outcomes of that step's DAG *descendants*, so dependent stages
   actually re-run instead of keeping stale green checkmarks.
2. **Trust freshness** — claim staleness (time-based or event-based) belongs in
   Surface, not Flow. Flow re-derives at evaluation and leaves a frozen
   *inquiry record* behind as the audit/checkpoint.
3. **Bundle recursion** — a flow run should be able to *emit* a TrustBundle, so
   a verified run becomes a single referenceable claim for a parent flow.
   Recursion is **by reference, not by embedding**.
4. **Ecosystem alignment** — `kontourai/console` already implements the
   event-sourcing + projection + freshness model we arrived at independently.
   Flow should emit into that convention and ship a dependency-free web
   component (as `surface` and `survey` do) that the console embeds.

---

## The Core Distinction: Two Different "Invalidations"

"Invalidate a claim" has been used for two genuinely different things. They
live in opposite directions and must not be conflated:

| | Means | Owner / direction |
|---|---|---|
| **(a) Truth changed** | the claim is now stale / disputed / superseded | Surface + Hachure (pushes *down* below Flow) |
| **(b) Process must re-run** | clear downstream green, walk the DAG forward again | Flow (stays *up* in the engine) |

The route-back cascade is purely (b). Freshness / TTL / claim-events are purely
(a). They meet at **one seam**: when a Surface-derived status flips from
accepted → not-accepted, Flow's gate outcome must be re-derived, and *that*
re-derivation is what fires the descendant cascade. Keeping this the only
coupling point is what preserves Flow's neutrality (ADR 0001).

---

## Layer Placement

| Layer | Owns | New responsibility |
|---|---|---|
| **Hachure** | neutral JSON Schema; the bundle *shape*; `events[]` ledger; `statusFunctionVersion` | optional `expiresAt` / validity fields; an invalidation/revocation event type (a new schema version) |
| **Surface** | claim **status derivation** `(bundle, now) → statuses` | becomes time-aware: `buildTrustReport(bundle, { now })`; folds `expiresAt` and invalidation events into `stale`/`superseded`/`rejected` |
| **Flow** | process, gates, transitions, DAG, route-back | *when* to re-derive; the descendant cascade; emitting a run-output bundle |

Time-based freshness **must** live in Surface, because Surface is the only
layer that maps a static bundle to a "current" status. Flow computing staleness
itself would re-own trust semantics and break neutrality. The half-built
precedent to *not* repeat is supersession, which today smears across all three
layers (`flow-run-store.ts` sets `superseded_by`, `flow-gates.ts` filters it,
Surface derives the `superseded` status). The goal is clean thirds: **fact in
Hachure, meaning in Surface, reaction in Flow.**

---

## Thread 1 — Route-Back Cascade (process layer, Flow)

### Problem

Today a route-back only moves the cursor and records a transition
(`src/gates/flow-gates.ts`, the `route-back` branch of `applyEvaluation`). It
does **not** touch downstream `gate_outcomes`. Because "passed" is decided
purely by the presence of a `pass` outcome with no run epoch
(`src/definition/flow-definition.ts`, `readySteps` / `stageStatuses`), a
route-back from `verify` → `plan` leaves `build`'s old `pass` in place. When
`plan` passes again, `readySteps()` filters `build` out as already-passed and it
never re-runs; the console keeps rendering it `passed`.

### Proposal

On a route-back to target `T`, invalidate the gate outcomes (and the
allowed transitions) of `T`'s **forward-reachable set** in the DAG — the
transitive closure of dependents. Then `readySteps()` re-triggers them for
free: `T` re-runs, and the readiness frontier advances back through the
descendants naturally. No new traversal engine — invert `predecessorsOf()`.

- Add a `descendantsOf(definition, stepId)` pure helper next to
  `predecessorsOf()`.
- In the route-back branch, prune descendants' `gate_outcomes` / allowed
  transitions before setting `current_step = T`.
- `max_attempts` (`route_back_policy`) counts the **cascade as one logical
  retry**, keyed to the route-back gate — not re-armed per re-run stage.
- Always cascade from the *selected* target so it composes with reason-based
  `on_route_back` routing (a `stale`-claim reason and a `disputed`-build reason
  can target different steps).

This is the smallest correctness fix and the foundation the other threads reuse:
"invalidate descendants" is the shared primitive.

---

## Thread 2 — Trust Freshness (trust layer, Surface) & the Inquiry Record

### Snapshot vs re-derive — resolved

Today `bundle_report` is computed once at attach time and cached
(`normalizeTrustBundle` in `flow-run-store.ts`; reused in `flow-gates.ts`). The
moment freshness is time-based, that cached copy is a lie — the same bundle
yields a different status as the clock advances. The cache is being asked to
play two roles at once. Split them:

- **Re-derive at each `evaluateRun`** with the current `now` → the *live*
  gate decision.
- **Leave a frozen inquiry record behind** per derivation → the immutable
  audit receipt: *"at T, status-fn vN, against evidence [...], gate G saw
  claim X as `stale`."* The old single `bundle_report` becomes a *series* of
  these.

So re-derive and snapshot are not competing options; they are the input and
output sides of one derivation. The decision: **re-derive for decisions, freeze
inquiry records for history.**

### The event system, plainly

A Hachure "event" is **not** a fired signal — it is a line in an append-only
**ledger inside the bundle**. Surface reads the whole ledger (+ `now` + TTL) and
computes "what is this claim as of now." Emitting a claim event = appending a
line (e.g. a `revoked`/`stale` event). Nothing is pushed; the next derivation
reads the new line. The mental model is three roles:

```
  INPUT LEDGER            LIVE FUNCTION                 OUTPUT RECEIPT
  Hachure events[]   →    Surface derive(bundle, now) →  inquiry record
  immutable history       recomputed each call           immutable history
  (what happened)         (what's true now)              (what we concluded)
```

Two immutable ledgers bracketing one live function. The output ledger (inquiry
records) lives in Flow run state, alongside transitions; the input ledger lives
in the bundle (Hachure); Surface in the middle stores nothing.

### The open fork

**Does Surface re-derive against wall-clock `now` (autonomous time-decay), or
does status only change when a new bundle event lands (strictly
event-driven)?** Time-decay gives "went stale on its own at 2am"; event-driven
is simpler and never changes status without a new event. The cost note below
leans on this choice.

---

## Thread 2b — Ledger Size & Recompute Cost

Re-deriving on every evaluation raises a cost question as `events[]` grows.
Mitigations, all of which reuse pieces already named:

- **Time-decay itself is cheap** — `expiresAt` vs `now` is O(claims), a
  comparison, not a replay. Only *event replay* is the cost center; keep the
  two separate.
- **Snapshot + replay-the-tail** — textbook event sourcing. Keep a checkpoint
  ("derived through event N / through T") and fold only the tail. The
  checkpoint **is the inquiry record** — so the audit receipt doubles as the
  performance lever.
- **Compaction is a last resort** — Hachure could fold old events (versioned by
  `statusFunctionVersion`) but loses history; prefer snapshot+tail.

Layering: Surface gains a "derive from checkpoint + tail" entry point; Flow
stores the checkpoint inside the inquiry record.

---

## Thread 3 — Bundle Emission & By-Reference Recursion

### Flow should emit a bundle

Today a run outputs a **Flow Report** (`schemas/flow-report.schema.json`) — an
audit/continuation artifact, not a TrustBundle. But it is already claim-and-
event shaped: a passed gate backed by evidence *is* a verified claim; a
transition/route-back *is* an event. Projecting a run into a TrustBundle (claims
= passed stages, evidence = refs, events = transitions) is a small step, and it
is the missing piece for composition. Emitting a bundle is **not** orchestration
(ADR 0001 stands) — it is producing an attestable artifact a *parent* flow can
consume as evidence.

### Recursion is by reference, not by embedding

`kontourai/console` shows the house pattern: claims map to **evidence refs /
action refs**; the console aggregates **read-only references** across products;
nobody inlines another product's authoritative state. So:

```
gate-evidence bundle   (leaf — actual proof of work; exists today)
        ↑ referenced by
flow-output bundle     (claims = "stage X passed"; evidence = refs to leaves)
        ↑ referenced by
parent flow's gate     (cites child bundle by id + claim selector)
        ↑ … unbounded, acyclic
```

Each hop carries **id + claim selector + `statusFunctionVersion` + `asOf`** —
never a copy of the child ledger. Reference beats embedding on the same three
axes we already worked through:

- **Cost** — a parent trusts the child's projection (checkpoint) and only
  re-resolves when `asOf`/freshness says it moved. Snapshot-as-checkpoint now
  works *across* bundle boundaries.
- **Authority** — Surface stays the single authority for each claim; a parent
  embedding a child's trust state forks the truth (console's "never own,
  aggregate read-only" rule).
- **Freshness cascade** — when a leaf goes stale, a freshness-transition event
  propagates *up the references* and re-derives parents. This is Thread 1's
  descendant cascade generalized to the bundle tree.

### Where to materialize bundles

- **Gate-evidence bundle** = leaf (already how evidence works).
- **Flow-output bundle** = the unit of composition; emit one per run, claims =
  stages, evidence = refs to the stage's gate-evidence.
- **Per-stage bundle** = only if a stage is independently referenced
  cross-flow; otherwise a stage is just a *claim* inside the flow bundle (the
  `needs` grouping already defines the boundary). Materializing a bundle per
  stage with no external referrer is ceremony.

Guardrails: keep the reference graph **acyclic** (reuse the DAG cycle-check
discipline, or freshness propagation loops), and make Flow **emit** as well as
consume.

---

## Thread 4 — Ecosystem Alignment & Web Components

### `kontourai/console` already is this model

Console is *"one operating plane for the whole suite: claim status, process
status, proof, queues, decisions, freshness, exceptions, next actions."* Its
architecture confirms what this note arrives at independently:

- **Event-sourced**: products emit to `.kontour/events/**/*.jsonl`; state lives
  in `.kontour/projections/**/*.json`; **deterministic replay** rebuilds it.
- **Never owns authority**: *"Surface owns claim trust state, Flow owns process
  transparency and gate control."* Console aggregates read-only refs.
- **Freshness in Surface**: state carries `{ status: "fresh"|"stale", asOf }`,
  with transitions as events (`surfaceFreshnessTransitionToEvent()`).

Mapping: our **inquiry record = a projection**; **re-derive = replay**;
freshness-with-`asOf` already exists, in Surface, exactly where we placed it.
Flow's job is to **align**, not invent: emit `.kontour/events` records (lift the
shapes from `@kontourai/console-core`) so the console plane aggregates runs.

### Web component pattern (from `surface` + `survey`)

Both products ship **dependency-free native Web Components** (shadow DOM, no
framework), read-only, fed pre-derived data, deriving nothing in the browser:

- `surface` → `<surface-trust-panel>`, shipped from `src/console/`, fed derived
  reports (verified / stale / disputed / missing).
- `survey` → `<survey-review-workbench>`, with modular subpath exports:
  `/review-workbench/element` (custom element), `/review-workbench` (direct
  mount), `/review-workbench/standalone.css`, `/review-workbench/server-review-session`.
  Server computes from snapshots + events, **never from browser payloads**.
- `console` (React + Vite) is the aggregation plane that **embeds** these custom
  elements over an SSE `/stream` (`ready` / `state` / `record.accepted`).

Web components are the interop boundary: a React console can drop any product's
custom element in with zero framework coupling — which is *why* surface/survey
chose framework-less elements.

### Proposal for Flow's `src/console`

Today `src/console` is a bespoke loopback projection over `.flow/runs/`. Re-shape
it to the house pattern:

1. Ship a dependency-free **`<flow-run-panel>`** (or `<flow-process-panel>`):
   shadow DOM, no framework, read-only, fed the already-derived flow projection
   (DAG via `stageStatuses` + `needs` edges, gates, evidence, route-backs, next
   action). Keep all derivation server-side (`projectFlowRunFromFiles`).
2. Package as subpath exports mirroring survey: `.../console/element`,
   `.../console` (direct mount), `.../console/standalone.css`, plus the loopback
   dev server helper.
3. **Embed `<flow-run-panel>` in `kontourai/console`** alongside
   `<surface-trust-panel>` and `<survey-review-workbench>`.
4. **Lift from console**: adopt `console-core` record/projection shapes and the
   emitter/sink contract; emit into `.kontour/events`; reuse the SSE event
   vocabulary. The bespoke `.flow/runs` projection thins to a dev-only view.

---

## Decisions To Make

1. **Freshness fork** — autonomous wall-clock time-decay vs strictly
   event-driven invalidation (Thread 2).
2. **Surface signature** — `buildTrustReport(bundle, { now })` and a
   derive-from-checkpoint entry point (Threads 2, 2b). Cross-repo with Surface.
3. **Hachure schema bump** — `expiresAt` + invalidation event type (Thread 2).
   Cross-repo with Hachure; new `statusFunctionVersion`.
4. **Bundle-emission schema** — the run-output TrustBundle projection (Thread 3).
5. **Console adoption depth** — depend on `@kontourai/console-core` and emit
   `.kontour/events`, vs keep `src/console` standalone (Thread 4).
   **CORRECTED 2026-06-16 (see `docs/handoff/console.md` Findings):** the
   premise is partly stale. The `kontourai/console` repo **already ingests Flow**
   via a read-only bridge (`console-server/.../flow-bridge.ts`,
   `deriveFlowRunEvents`) that reads Flow's owned `.flow/runs/<id>/state.json`
   and derives **`kontour.console.event` v0.1** records, then `buildPipeline()`
   from `@kontourai/console-core`. So the real record contract is
   `kontour.console.event` v0.1 (not a generic `.kontour/events` projection Flow
   redefines), and the seam already exists and is authority-correct. **Flow
   should NOT add a second emitter.** The open decision narrows to: keep the
   bridge (Flow unchanged for §3) vs have Flow push `kontour.console.event` v0.1
   directly and retire the bridge. Console already embeds `<surface-trust-panel>`
   and models freshness; the only net-new console work is embedding a
   `<flow-run-panel>` once Flow extracts one as a subpath-exported element. This
   is parked under `## Needs decision` in `console.md`.
6. **Surface rollup scope** — can a derived/group claim depend on claims in a
   *referenced* bundle, and does staleness propagate across that edge?
   **RESOLVED 2026-06-16 (see `docs/handoff/surface.md` Findings):**
   - Cross-bundle derivation/rollup: **NO.** Surface derivation and group
     rollup are strictly **intra-bundle**; there is no "bundle reference"
     concept in Surface at all. A claim cannot derive from a claim in another
     bundle.
   - Propagation: **YES, but only within a single bundle.** The derivation
     ceiling recomputes from live input statuses on every `buildTrustReport`,
     so intra-bundle staleness/dispute propagates automatically.

   **Consequence:** **Flow owns the cross-bundle re-resolution hop.** A child
   run going stale re-surfaces on the parent because *Flow* re-derives each
   referenced bundle level and propagates a Surface `FreshnessTransitionEvent`
   up the (Flow-owned) reference graph — Surface does not cross the boundary.
   The run-level `run verified` claim IS a Surface rollup, but only because Flow
   emits the per-stage member claims + the group definition **into the same
   run-output bundle**; Surface then derives `run verified` intra-bundle. Flow
   still must not hand-roll "all green ⇒ green". This blocks/decides
   `flow-followups.md` §2.

## Non-Goals

- Multi-cursor / concurrent step execution (still the dependency-DAG Phase 2
  boundary; ADR 0001 — Flow is a tracker, not an orchestrator).
- Flow owning trust semantics or time math (stays in Surface).
- Deep physical nesting of bundles (recursion is by reference).
