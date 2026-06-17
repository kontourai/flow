# Handoff — Flow Follow-ups (depend on Hachure + Surface)

**Repo:** `kontourai/flow` (this repo) · **Depends on:** `hachure.md`,
`surface.md`. These are the Flow-side changes that can only land once the trust
layers below support them. The route-back cascade is already done on this branch.

## 1. Re-derive instead of caching `bundle_report`

Today Flow derives a bundle's report **once at attach time** and stores it
(`normalizeTrustBundle` in `src/runtime/flow-run-store.ts`; reused in
`src/gates/flow-gates.ts` where `entry.bundle_report` is trusted if present).
Once Surface is time-aware this cached copy goes stale.

- On `evaluateRun`, **re-derive** with current `now` (Surface
  `buildTrustReport(bundle, { now, since })`) rather than trusting the stored
  `bundle_report` for freshness-bearing claims.
- Keep the stored report as a **point-in-time inquiry record** (audit snapshot +
  `statusFunctionVersion` + `asOf`), not the live source of truth. Append one per
  evaluation instead of overwriting once. This doubles as the Surface checkpoint.

**Seam to the cascade (already built):** when a re-derive flips a claim from an
accepted status to `stale`/`disputed`, the owning gate outcome must be
re-derived; if that turns it non-pass and triggers a route-back,
`invalidateDescendants` already clears the downstream stale passes. Wire the
"derived-status-flipped" path into a gate re-evaluation so this connects.

## 2. Emit a run-output TrustBundle

A completed run outputs a **Flow Report** (`schemas/flow-report.schema.json`),
not a bundle. Add a projection that emits a Hachure TrustBundle:
- claims = passed stages (`stageStatuses` / `needs` grouping),
- evidence = **references** to each stage's gate-evidence bundles (id + selector
  + `statusFunctionVersion` + `asOf`) — **by reference, not embedded**,
- events = transitions / route-backs.

This is what lets a parent flow consume a child run as a single claim. Keep the
reference graph acyclic (reuse the `needs` cycle-check discipline). Not an
orchestrator — Flow still just emits an artifact (ADR 0001 holds).

## 3. Emit `.kontour/events` for the console plane

Adopt `@kontourai/console-core` record/projection shapes and emit run lifecycle
to `.kontour/events/**/*.jsonl` (+ `.kontour/projections`) so
`kontourai/console` aggregates Flow alongside Surface/Survey. The bespoke
`.flow/runs` projection can thin to a dev-only view. See `console.md`.

## 4. Nested Surface trust panel in the console drawer

Implement `docs/design/nested-trust-panel.md`: pass `bundle_report` through the
projection (`projectEvidence` in `src/console/console-projection.ts` →
`FlowConsoleEvidenceProjection` → `ConsoleEvidence`) and mount a
`<surface-trust-panel>` per evidence entry in
`src/console-ui/drawer.ts` (`renderEvidenceSection`). Depends on Surface shipping
a consumable element (see `surface.md`). Update the projection fixture used by
`tests/node/check-console-projection.test.mjs` (exact `deepEqual`) and add a
Playwright assertion.

## Acceptance criteria

- Re-derivation path proven with a time-based fixture (claim fresh at T0, stale
  at T1 across two `evaluateRun` calls with different `now`).
- Run-output bundle validates against Hachure and round-trips as evidence into a
  second flow's gate.
- `.kontour/events` consumed by the console without Flow owning authoritative
  state.
