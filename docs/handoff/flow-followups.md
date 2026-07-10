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

**The run-level `run verified` claim must be a Surface rollup, not Flow-computed.**
Flow emits the per-stage member claims + the group definition; Surface derives
whether the run is verified from the members. Do **not** hand-roll "all stages
green ⇒ run green" in Flow — that is claim logic, which Surface owns. The exact
shape depends on the answer to the Surface open question (rollup scope +
propagation); block this sub-task on that answer.

> **UNBLOCKED 2026-06-16 — Surface open question answered (see
> `surface.md` Findings + design Decision #6).** Surface rollups are
> **strictly intra-bundle**; there is no bundle-reference concept in Surface.
> Concrete shape for this sub-task:
> 1. Emit the per-stage `stage X passed` member claims **and** a `claimGroup`
>    (the `run verified` group, `rollupPolicy.mode = "all-required"`) **into the
>    same run-output bundle.** Surface then derives `run verified` from the
>    members with automatic intra-bundle propagation — Flow computes nothing.
> 2. The *evidence* for each member claim is still a **by-reference** pointer to
>    that stage's gate-evidence bundle (`id + selector + statusFunctionVersion +
>    asOf`) — references stay acyclic and are NOT inlined.
> 3. **Cross-bundle freshness is Flow's job:** when a referenced child bundle
>    goes stale, Surface will NOT propagate it across the reference edge. Flow
>    re-derives each referenced level itself and propagates a Surface
>    `FreshnessTransitionEvent` (from `diffFreshness`) up the Flow-owned
>    reference graph, re-deriving parents. This is Thread-1's descendant cascade
>    generalised to the bundle tree, and it is **Flow process logic**, not
>    Surface claim logic.
>
> Still gated by the **`## Needs decision`** in `surface.md` (wall-clock decay
> vs strictly event-driven): that decision only governs *when* Flow re-invokes
> derivation/propagation, not the bundle shape above. Implement the shape;
> wait on the owner for the trigger model before adding any scheduler.

## 3. Emit `.kontour/events` for the console plane

Adopt `@kontourai/console-core` record/projection shapes and emit run lifecycle
to `.kontour/events/**/*.jsonl` (+ `.kontour/projections`) so
`kontourai/console` aggregates Flow alongside Surface/Survey. The bespoke
`.kontourai/flow/runs` projection can thin to a dev-only view. See `console.md`.

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

## Findings — 2026-06-16

**Repo/PR:** kontourai/flow, branch `claude/route-backs-dag-deps-h07yat` (this
worktree; committed locally, not pushed). Deps bumped: `hachure ^0.5.0`,
`@kontourai/surface ^1.2.0` (both vendored locally to run tests — publish before
merge). All 162 node tests + 9 chromium-desktop Playwright tests pass.

**§1 — re-derive instead of caching `bundle_report`: DONE.**
- `reDeriveBundleReports(manifest, now)` (in `src/runtime/flow-run-store.ts`,
  exported) re-derives each trust.bundle entry via Surface
  `buildTrustReport(bundle, { now, since: lastCheckpoint })`; updates the LIVE
  `entry.bundle_report` and appends a frozen `DerivationCheckpoint` to
  `entry.inquiry_records` (append-only audit series + the checkpoint that bounds
  the next derivation). Emits `diffFreshness` transitions.
- `evaluateRun` calls it BEFORE gates read `bundle_report`, so a claim gone
  stale flips the gate → route-back → the existing `invalidateDescendants`
  cascade fires. The seam is wired; Flow stays time-neutral (picks `now`,
  Surface does the math).
- Proof: `tests/node/check-rederive-freshness.test.mjs` — fresh at T0, stale at
  T1; append-only records; legacy (no-freshness) bundle is time-invariant.

**§2 — emit a run-output TrustBundle: DONE (unblocked by the Surface answer).**
- `projectRunOutputBundle(definition, state, manifest, { now })` (in
  `src/reports/flow-run-bundle.ts`, exported). claims = passed stages; evidence
  = **by-reference** pointers to each stage's gate-evidence bundle (id + claim
  selector + `statusFunctionVersion` + `asOf`; never inlined); events = per-stage
  verifications. The run-level `run verified` is a **Surface rollup** (an
  all-required `claimGroup` over the member claims in the SAME bundle) — Flow
  computes nothing. Reference graph stays acyclic (refs point only down to leaf
  gate-evidence already on the run).
- Proof: `tests/node/check-run-output-bundle.test.mjs` — validates vs Hachure
  schema + Surface; the run-verified rollup derives `verified`; evidence is
  by-reference; round-trips as evidence into a parent flow's gate as one claim.

**§4 — nested Surface trust panel in the console drawer: DONE.**
- Projection passthrough (`bundle_report`) in `console-projection.ts` +
  `ConsoleEvidence`; drawer mounts `<surface-trust-panel>` per trust.bundle
  evidence (`src/console-ui/drawer.ts`), fed the pre-derived report, themed via
  `--k-*`; vendored the element from `@kontourai/surface/trust-panel/element`
  via `sync-ui-assets` and registered in `index.html`.
- Proof: `check-console-projection.test.mjs` updated (exact deepEqual, fixture
  regenerated with a derived `bundle_report`); Playwright asserts the nested
  panel mounts, upgrades, renders shadow content, and has `.report` set (no
  in-browser derivation).

**§3 — `.kontour/events` for the console plane: REFRAMED, not implemented.**
This finding changes the §3 assumption (see design-doc update + `console.md`).
The console repo **already ingests Flow** read-only via
`console-server/.../flow-bridge.ts` (`deriveFlowRunEvents`), which reads Flow's
owned `.kontourai/flow/runs/<run-id>/state.json` and derives `kontour.console.event`
(schema `kontour.console.event`, version `0.1`) records, then `buildPipeline`
from `@kontourai/console-core`. So:
- The actual record contract is **`kontour.console.event` v0.1** (fields:
  `producer`, `scope`, `subject`, `actor`, `correlationId`, `sequence`,
  `payload.after`), **not** a generic `@kontourai/console-core` projection that
  Flow redefines and writes to `.kontour/events/**/*.jsonl`.
- Authority is already correct: the bridge is read-only over Flow-owned files;
  Flow owns run state, Console aggregates. Having Flow *also* emit
  `.kontour/events` would **duplicate** the bridge and risk two emitters of the
  same records.
- **Recommended (needs Flow-owner confirmation, see `console.md`):** either
  (a) keep the bridge as the integration seam (Flow changes nothing for §3 — it
  already exposes everything the bridge needs, and §2's run-output bundle is a
  natural next payload), or (b) if a push model is wanted, have Flow emit the
  **`kontour.console.event` v0.1** shape directly (depend on
  `@kontourai/console-core`) so the bridge can be retired — but align the exact
  shape with the console owner first. Do NOT have Flow invent a parallel
  `.kontour/events` schema.

## Findings — 2026-06-16 (verification pass: acyclicity guard, wall-clock test, ConsoleSink)

**Repo/branch:** kontourai/flow worktree, `claude/route-backs-dag-deps-h07yat`
(committed locally, not pushed). Second pass after independent verification.
All **176 node tests + 15 chromium Playwright + console smoke** pass; `typecheck`
and the contracts typecheck (`tsconfig.types.json`) are clean.

**Task C — evidence-reference acyclicity is now a real RUNTIME guard.**
Verification was right: the reference graph was acyclic *by construction* with no
check; the existing DFS guarded only the `needs` step-DAG. Added
`assertEvidenceReferencesAcyclic(rootBundle, bundlesByEvidenceId)` +
`EvidenceReferenceCycleError` in `src/reports/flow-run-bundle.ts` (exported from
`index.ts`). `projectRunOutputBundle` builds an evidenceId→bundle lookup from the
manifest and runs the guard before returning, so emission throws if a reference
path loops back to the run-output bundle or revisits a node. Tests added to
`tests/node/check-run-output-bundle.test.mjs`: down-only graph passes; root
back-reference, an a→b→c→a multi-hop cycle, and a poisoned leaf that references
the emitted run all throw.

**Task D — wall-clock expiry routes back through the §1 seam; NO new machinery
(RESOLVED DECISION 1).** Verification outcome: **the §1 seam already covers
wall-clock expiry end-to-end.** `evaluateRun` → `reDeriveBundleReports(now)` →
`buildTrustReport({ now, since })` makes an `expiresAt`/`ttlSeconds` claim derive
`stale` purely from time; the current-step gate then no longer matches
`accepted_statuses` and routes back, and `invalidateDescendants` clears the
downstream stale pass. Only a test + docs were needed — **no scheduler, timer,
cadence, or re-runner was added.** New test
`tests/node/check-wallclock-expiry-routeback.test.mjs` drives TWO explicit
`evaluateRun` calls at T0 (fresh → pass → advance) and T1 (wall-clock-expired →
route-back to prepare + invalidate the `release` descendant) against a real temp
run dir. NO timer in the test; both calls are explicit, exactly as an external
producer/CI/agent/person would invoke them. Surface does all the staleness math;
Flow only reacts to the derived status at evaluation `now`.

**§3 — RESOLVED as the ConsoleSink seam (RESOLVED DECISION 2; supersedes the
prior "keep bridge vs push kontour.console.event" fork and the original generic
`.kontour/events` plan).** Flow does NOT emit generic `@kontourai/console-core`
records and depends on NO console package. Implemented (Task E):
- **`ConsoleSink` seam** (`src/console/console-sink.ts`): `ConsoleSink` interface
  + `FileConsoleSink` (writes the projection under the run dir — today's
  local/pull behaviour, DEFAULT) + `HostedConsoleSink` (POSTs the SAME
  `FlowConsoleProjection` payload over HTTP to a configurable console ingest
  endpoint; gated via `createConsoleSink({ mode: "hosted", hosted: { endpoint }
  })`, OFF by default, imports nothing from any console package — it knows only
  an HTTP contract whose body Flow owns). All exported from `index.ts`.
- **Stable contract subpath** `@kontourai/flow/console-contract`
  (`src/console/console-contract.ts`, declared in `package.json` `exports`,
  mirroring Surface's `trust-panel/element`): re-exports the
  `FlowConsoleProjection` contract types + the sink. Console depends on this and
  types its flow-bridge against Flow's exported types (see `console.md`).
- Console wraps the payload in its own `kontour.console.event` envelope on
  ingest — Flow never produces that envelope; authority stays put.
- Tests: `tests/node/check-console-sink.test.mjs` (file sink writes the exact
  payload; hosted sink POSTs the same payload with auth/headers via injected
  fetch; rejects non-OK; hosted is never the default; subpath re-export). The
  package API-boundary + export-stability tests were updated to admit the new
  `./console-contract` entrypoint and the new named exports.
- **Caveat FLAGGED (not invented):** the hosted ingest endpoint URL/auth/envelope
  is a console-side contract that does not exist yet. `HostedConsoleSink` is
  functional against any configurable URL; the concrete API shape is tracked as
  a follow-up in `console.md` (`## Needs decision — hosted-ingest API contract`).

**§1/§2/§4 unchanged from the first pass** beyond Task C's guard on §2's output.
The first-pass re-derive/checkpoint path (§1) now sits on a real Surface
checkpoint (Surface Task A fixed the `since` no-op); no Flow change was needed.
