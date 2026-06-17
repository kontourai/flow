# Dependency DAG — Design Document

## Flow Is a Tracker, Not an Executor

Flow is a **state tracker**. A `FlowRun` records which step is active
(`current_step`), what gate outcomes have been recorded, and what evidence
was attached. Flow does **not** schedule work, fork goroutines, or own
concurrency. The single-cursor execution model (`current_step`) is the
authority for what a run is doing at any moment.

This constraint is load-bearing: agents, humans, and the console can all
read the same state file and agree on what the run expects next.

---

## Phases

### Phase 1 — Declare deps + derive readiness (this document)

Purely **additive**. Adds `needs?: string[]` to step objects so a step can
declare explicit predecessor steps. Derives four read-only views:

- `predecessorsOf` — effective predecessors of a step.
- `readySteps` — steps not yet passed whose every predecessor has passed.
- `readyGates` — gates belonging to ready steps.
- `stageStatuses` — per-step status enum for visualization.

The single-cursor `current_step` model is unchanged. `evaluateRun`,
`applyEvaluation`, and the run-state schema are unchanged.  Existing
linear definitions that only use `next` work identically.

### Phase 1.5 — Route-back cascade (implemented)

When a run routes back to an upstream target, the stages **downstream** of that
target were produced from work that is now being redone, so their recorded
`pass` outcomes are stale. Without intervention, `readySteps` filters them out
as "already passed" and they never re-run (and a single-`next` cursor cannot
re-reach fan-out branches at all). Phase 1.5 clears those stale passes on
route-back so the run re-derives everything below the target.

Two pure/mutating helpers:

- `descendantsOf(definition, stepId)` — transitive dependents of a step
  (inverse of `predecessorsOf`), in definition order.
- `invalidateDescendants(definition, state, targetStep)` — clears the stale
  `pass` gate outcomes and `allowed` transitions for every descendant of
  `targetStep`; preserves non-pass outcomes (the triggering failure, for
  reports) and all route-back transitions (so `routeBackAttempt` counting is
  unaffected). Returns the descendant step ids for audit.

`applyEvaluation` calls `invalidateDescendants` in its `route-back` branch and
records the result on the route-back transition as `invalidated_steps`. The
target itself is untouched — it becomes `current_step` and re-runs through the
normal cursor.

### Phase 2 — Concurrent multi-step execution (explicit NON-GOAL for Phase 1)

Concurrent execution across multiple ready steps at the same time requires a
multi-cursor run-state model, an orchestrator, and a new schema version.
This is a deliberate future boundary.  The console and bridge can start
rendering the DAG from `stageStatuses` + `needs`-edges today (Phase 1),
before a runtime that drives multiple steps in parallel exists.

---

## `needs` / `next` Composition Rule

Every step declares `next` (linear sugar pointing to the next step in the
chain). Phase 1 adds optional `needs` (an explicit list of predecessor step
ids).

**Composition rule:**

> A step's **effective predecessors** are:
> 1. The ids in its `needs` array, if `needs` is present (even if empty).
> 2. Otherwise, whichever step has `next` pointing to this step.

This means:

- Definitions that only use `next` are unchanged — `predecessorsOf` still
  returns the single predecessor derived from the chain.
- A step that declares `needs` can name multiple predecessors (fan-in) and
  the `next` pointer is ignored for predecessor resolution on that step.
- `next` still controls what `applyEvaluation` writes to `current_step`
  (Phase 1 does not touch `applyEvaluation`).

**Validation:**

- Every id in `needs` must reference an existing step id — unknown ids are
  errors (`definition.step.needs.unknown`).
- The effective dependency graph (needs-edges for steps that have `needs`,
  next-edges for steps that don't) must be acyclic — cycles are errors
  (`definition.steps.needs.cycle`) with the cycle path in the diagnostic
  `related` field.
- A definition that uses only `next` never fails these checks.

---

## Derivation Contract

All four functions are **pure** (no I/O, no mutations).  They derive from
the definition, state, and manifest passed in.

### `predecessorsOf(definition, stepId): string[]`

Returns the effective predecessor step ids for a given step, applying the
composition rule above.

### `readySteps(definition, state, manifest): string[]`

Returns step ids that:
- Are not yet passed (no gate with `status: "pass"` for all their gates, or
  no allowed transition for gate-less steps).
- Are not in a completed run (`state.status === "completed"`).
- Have all effective predecessors passed.

A step with no predecessors is always considered ready at start.

### `readyGates(definition, state, manifest): Gate[]`

Returns gates whose `step` is in `readySteps()`.

### `stageStatuses(definition, state, manifest): Record<string, StageStatus>`

Returns a per-step status. Evaluation order (first match wins):

| Status     | Condition |
|------------|-----------|
| `"failed"` | Step has a gate with `block` or `route-back` outcome and step ≠ `current_step` |
| `"current"`| `step.id === state.current_step` |
| `"passed"` | All gates for step have `pass` outcome (or gate-less step has an allowed transition) |
| `"ready"`  | Step is in `readySteps()` |
| `"blocked"`| Some effective predecessor has not passed |
| `"pending"`| Fallback |

This is the function the console/bridge uses to color the DAG nodes.

---

## DAG Rendering

The console renders the DAG from:
- `stageStatuses` — node color / label per step.
- `needs` edges (or derived `next` edges) — directed graph edges.
- `readySteps` — highlighted frontier.

The console reads `stageStatuses` via the JSON output of `flow status --format json`
(which now includes `readySteps` and `stageStatuses` fields) or directly from
the library export.
