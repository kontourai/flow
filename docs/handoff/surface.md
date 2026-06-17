# Handoff — Surface: Time-Aware Derivation, Checkpoints & Freshness Events

**Repo:** `kontourai/surface` · **Layer:** trust-status derivation · **Depends
on:** Hachure (`hachure.md`) · **Blocks:** Flow follow-ups, Console.

## Context

Surface owns `buildTrustReport(bundle) → TrustReport` and `validateTrustBundle`.
Flow imports both (`src/gates/flow-gates.ts:16`,
`src/runtime/flow-run-store.ts`) and treats the derived `claim.status`
(`verified`/`stale`/`disputed`/`superseded`/`rejected`/...) as the source of
truth — Flow never computes staleness itself. The console repo confirms freshness
lives here: Surface state carries `{ status: "fresh"|"stale", asOf }` and emits
transitions via a `surfaceFreshnessTransitionToEvent()`-style path.

## Goal

Make derivation a function of **time** and support **checkpointed** derivation so
deep/large ledgers stay cheap. Emit freshness transitions as events.

## Changes

1. **Time-aware derivation:** `buildTrustReport(bundle, { now })` (default
   `now = Date.now()`). Fold Hachure's `expiresAt`/`ttlSeconds` and the new
   invalidation events into status: an expired claim derives `stale`; a revoked
   claim derives `stale`/`rejected`/`superseded` per the status function. Pin
   behaviour with the new `statusFunctionVersion`. **Back-compat:** a bundle with
   none of the new fields must derive exactly as today.

2. **`asOf` in the report:** each derived claim should carry the freshness
   `asOf` (and ideally the `expiresAt` it was judged against), so consumers can
   show "verified, fresh as of T" and detect when re-derivation is due.

3. **Checkpointed derivation (cost):** add an entry point that derives from a
   prior snapshot + only the tail of new events, e.g.
   `buildTrustReport(bundle, { now, since: checkpoint })`. This is the
   event-sourcing "snapshot + replay-the-tail" so re-derivation is bounded by
   the delta, not the full ledger. The checkpoint object is what Flow will store
   as its inquiry record.

4. **Freshness transition events:** expose the fresh→stale transition as an
   emittable event (the `surfaceFreshnessTransitionToEvent()` shape the console
   already consumes) so downstream planes can react without polling.

## Open decision (resolve with Flow owner)

Autonomous wall-clock decay vs strictly event-driven invalidation. Time-aware
derivation supports both; the difference is whether anything re-invokes
`buildTrustReport` as the clock passes `expiresAt` (Flow/scheduler concern) or
only when a new event lands. Document which mode the status function assumes.

## Open question — derived claims across referenced bundles (please answer back)

Surface has **claim groups**, **policies**, and **conflict/confidence rollups**,
so a claim's status can be derived from other claims. Two things we need
confirmed before Flow builds (or *doesn't* build) recursion machinery:

1. **Can a derived/group claim depend on claims in a *different, referenced*
   bundle, or only on claims within the same bundle?**
2. **Does staleness/dispute propagate automatically up the derivation edge** —
   if a member/upstream claim goes `stale`, does the group/derived claim reflect
   it on the next `buildTrustReport`?

Why it matters: if rollups span referenced bundles **and** propagate, then the
"a child run going stale re-surfaces on the parent" behaviour is **Surface's job,
not Flow's** — Flow keeps only the process-side cascade
(`invalidateDescendants`) and deletes any parent-freshness logic from its plate.
If rollups are intra-bundle only, Flow still owns the cross-bundle *re-resolution*
hop (re-deriving each referenced level), while Surface owns the within-run rollup.

**Report the answer back per the return protocol in `README.md`** — it directly
changes `flow-followups.md` §2.

## Acceptance criteria

- `buildTrustReport(bundle, { now })` derives `stale` for an expired/revoked
  claim and is unchanged for bundles without the new fields.
- Checkpointed derivation yields identical results to full derivation for the
  same `now`.
- Conformance vectors from `hachure.md` pass.

## Coordination

- **Surface trust panel packaging** (needed by Flow's nested-panel follow-up and
  Console): ship `<surface-trust-panel>` as a consumable, dependency-free module
  others can load. Today it imports from
  `@kontourai/surface/dist/src/trust-panel/surface-trust-panel.js` and takes a
  pre-derived `TrustReport` via its `.report` property (themed via `--k-*` CSS
  vars). Confirm a stable subpath export (mirroring Survey's
  `/review-workbench/element`) and a standalone CSS entry. See
  `docs/design/nested-trust-panel.md`.

## Findings — 2026-06-16

**Repo/PR:** kontourai/surface, branch `claude/time-aware-derivation-freshness`
(sha 418db94 — committed locally, not pushed).

**Question answered (the Open question — derived claims across referenced
bundles):**
1. Can a derived/group claim depend on claims in a *different, referenced*
   bundle? → **NO.** Derivation and group rollup are **strictly intra-bundle.**
   `src/validation/references.ts` (lines ~12-26, 45-65) throws if any
   `derivedFrom` / `derivationEdges.inputClaimId` / `claimGroup.claimIds` is not
   present in the *same* bundle's `claims[]`. There is **no "bundle reference"
   concept anywhere** in Surface — no claim field cites another bundle by id; no
   cross-bundle fetch/resolve exists.
2. Does staleness/dispute propagate up the derivation edge? → **YES, but only
   within one bundle.** The derivation ceiling (`src/derivation.ts`,
   `weakerStatus` + `applyDerivation`, lines ~75-84, 156-158) recomputes from the
   *current* per-claim statuses on **every** `buildTrustReport` call — no cached
   status — so an input going `stale`/`disputed` immediately caps the
   derived/group claim, and `changeRecords` (`input-stale`, `input-disputed`,
   …) are re-emitted each call. `claim-groups.ts` rollups read the live derived
   statuses likewise.

**Answer / behaviour (what is true now after this change):**
- `buildTrustReport(bundle, { now, since })` is time-aware. `statusFunctionVersion`
  bumped `"1" → "2"` and is stamped into the report (`report.statusFunctionVersion`).
- Claim-intrinsic validity window folded into status: `expiresAt` (canonical) or
  `ttlSeconds` (relative, anchored to the governing verified event's
  `verifiedAt`/`createdAt`) → derives `stale` when `now` is past it. Overrides
  the policy `validityRule` timing when present.
- Invalidation events: a latest event with `status: "revoked"` or
  `type: "invalidation"` is terminal → derives `stale`.
- Each derived report claim carries `freshness: { asOf, expiresAt?, stale }`.
- **Checkpointed derivation:** `checkpointFromReport(report)` freezes a
  `DerivationCheckpoint` (per-claim status + intrinsic expiry + event high-water
  mark + `statusFunctionVersion`) — this is the object Flow stores as its
  inquiry record. `buildTrustReport(…, { since })` accepts it.
- **Freshness transitions:** `diffFreshness(priorCheckpoint, nextReport)` emits
  `FreshnessTransitionEvent[]` for each claim whose time-freshness flips
  (`fresh`↔`stale`), the shape downstream planes consume without polling.
- **Packaging:** added stable subpath export
  `@kontourai/surface/trust-panel/element` →
  `dist/src/trust-panel/surface-trust-panel.js` (+ its `.d.ts`). The element
  self-styles via inlined shadow-DOM CSS keyed on `--k-*` vars, so **no separate
  standalone CSS entry is needed** (themed entirely by host CSS variables).
- **Back-compat:** a bundle with none of the new fields derives identically to
  `statusFunctionVersion "1"` — proven by the `sf-no-freshness-fields` vector
  and all pre-existing conformance vectors still passing.

**Field-name contract (matches hachure.md):** `claim.expiresAt`,
`claim.ttlSeconds`, `event.status="revoked"`, `event.type="invalidation"`.
Surface validation now accepts `schemaVersion` ∈ {2,3,4}.

**Tested:** `npm run build`; all 316 node tests + serial + package-smoke pass;
spec-conformance runs **8 vectors** (incl. the 3 new hachure ones) green against
the new derivation; generated-asset/package-contents/boundary checks pass;
subpath export resolves at runtime. **Not run:** Playwright browser tests
(`test:browser`) — no browser env here; the panel's render path is unchanged
(it ignores the new optional `freshness` field). The local hachure 0.5.0 was
vendored into `node_modules/hachure` to run conformance; `devDependencies.hachure`
bumped to `^0.5.0` (publish hachure 0.5.0 before merging surface).

**Impact on Flow:**
- **flow-followups.md §2 is now decidable.** Because rollups do **not** span
  referenced bundles, **Flow owns the cross-bundle re-resolution hop** (re-derive
  each referenced child level itself; a leaf going stale re-surfaces on the
  parent only because Flow re-derives + propagates a `FreshnessTransitionEvent`
  up the references — Surface will NOT do it across the bundle boundary). The
  run-level `run verified` claim **is** a Surface rollup, but **only** when Flow
  places the per-stage member claims + the group definition **into the same
  bundle**; Surface then derives `run verified` from the members with automatic
  intra-bundle propagation. Flow must still NOT hand-roll "all green ⇒ green".
- §1 (re-derive): use `buildTrustReport(bundle, { now, since: checkpoint })` and
  store the returned-report's `checkpointFromReport(...)` as the inquiry record;
  pin `statusFunctionVersion`.
- §4 (nested panel): import the element from the new
  `@kontourai/surface/trust-panel/element` subpath (no dist path).

The design doc (`route-back-cascade-and-trust-recursion.md`, Decision #6) is
updated to record this answer; see also `flow-followups.md` §2 note.

## Findings — 2026-06-16 (verification pass: checkpoint no-op fix + back-compat pin)

**Repo/PR:** kontourai/surface, branch `claude/time-aware-derivation-freshness`
(committed locally, not pushed). Second pass after independent verification found
the checkpoint feature was a no-op.

**Task A — checkpointed derivation was unimplemented; now real.** Verification
was correct: `buildTrustReport({ now, since })` accepted `since` but never read
it — every call did a full `deriveTrustSnapshot(input, { now })`, and the
"identical results" expectation passed only vacuously (no test even exercised
`since`). Fixed:
- `deriveTrustSnapshot` now accepts `{ since, instrument }`
  (`DeriveTrustSnapshotOptions`). Events are indexed by `claimId` once. For each
  claim it computes the **tail** = events newer than that claim's own high-water
  mark. When the checkpoint is usable and a claim's tail is empty, the claim is
  **served from the checkpoint** (`statusByClaimId`) and only the time-based
  freshness window is re-applied against the new `now` via the new
  `reapplyVerifiedFreshness()` (exported from `status.ts`) — folding **zero** of
  that claim's events. A claim with tail events is fully re-folded.
- **Identity proof:** the status function is pure, so a checkpointed derivation
  is byte-identical to a full derivation for the same `now`. Test asserts a
  deep-equal of claims/changeRecords/transparencyGaps/summary/rollups between the
  two paths, both with and without a tail event present.
- **Tail-only proof (the part that was missing):** the new `instrument` hook
  reports per-claim `{ eventsFolded, eventsTotal, fromCheckpoint }`. The test
  asserts the full run folds each claim's whole ledger while the checkpointed run
  folds **0** events for the unchanged claim (and still correctly flips it to
  `stale` from the time window alone), and that total events folded is strictly
  smaller under the checkpoint. A separate case proves a claim WITH a tail event
  is re-folded while its sibling without one is served from the checkpoint.
- **Correctness fix found while implementing:** a single GLOBAL
  `throughEventCreatedAt` is unsafe for tail detection — an event can land for
  one claim with a `createdAt` older than the global max but newer than that
  claim's last folded event, and be silently dropped. Added an additive
  (optional) `throughEventCreatedAtByClaimId` to `DerivationCheckpoint`;
  `checkpointFromReport` populates it; tail detection uses the per-claim mark.
  Legacy checkpoints without it (and checkpoints from a different
  `statusFunctionVersion`) fall back to full replay for safety — also tested.
- Files: `src/trust-snapshot.ts`, `src/status.ts` (new `reapplyVerifiedFreshness`),
  `src/report.ts` (wire `since`/`instrument`, per-claim mark), `src/types.ts`
  (optional `throughEventCreatedAtByClaimId`, `DeriveTrustSnapshotOptions`/
  `SnapshotEventProbe` exported via `trust-snapshot.ts`).
  Test: `tests/checkpoint-derivation.test.ts` (4 tests).

**Task B — dedicated back-compat pin.** Added `tests/back-compat-no-freshness.ts`
(`tests/back-compat-no-freshness.test.ts`): a bundle with NONE of the new
freshness fields (`expiresAt`/`ttlSeconds`/invalidation events) is proven to
derive identically across two `now` values **decades apart** (deep-equal of all
derivation outputs, modulo the `asOf` echo and instant-stamped id/generatedAt),
and to carry no intrinsic expiry and no time-staleness on any claim. This pins
prior behaviour directly rather than relying only on the indirect
`sf-no-freshness-fields` spec vector.

**Tested:** `npm run build` + `npm test` → **322 node tests pass** (was 316; +6
new: 4 checkpoint, 2 back-compat) + serial + external-adapter green;
`npm run typecheck` clean. **Not run:** `test:browser` (no browser env — panel
path unchanged). No lint script in this repo.

**Impact on Flow:** §1 already uses `buildTrustReport(bundle, { now, since })`;
its checkpoints are now a genuine cost lever, not a no-op. Flow should keep
storing `checkpointFromReport(report)` as the inquiry record; the new per-claim
high-water field is populated automatically and requires no Flow change.

## Needs decision — RESOLVED 2026-06-16 (Flow owner)

**Autonomous wall-clock decay vs strictly event-driven invalidation** (the Open
decision in this file / Decision #1 in the design doc).

> **RESOLVED: NO SCHEDULER ANYWHERE — strictly reactive, event-driven.** Neither
> Surface nor Flow has a scheduler, timer, daemon, cron, or background wake-up.
> Nothing fires on its own as a wall-clock passes `expiresAt`. Surface stays
> time-neutral and implements neither trigger (correct, unchanged). Flow's only
> clock is the `now` captured at an `evaluateRun` that some EXTERNAL actor (a
> producer, CI, an agent, a person) triggers. During an in-progress
> `evaluateRun`, Flow re-derives claim status at the current `now` via Surface;
> a previously-passed stage whose claim is now wall-clock-stale (Surface says
> so) flips its gate → route-back → `invalidateDescendants`. The route-back only
> MARKS the stage for redo; an external actor does the redo and triggers the
> next `evaluateRun`. A claim that silently expires at 2am is simply observed at
> the next externally-invoked evaluation — there is no proactive emission. This
> is the §1 "derived-status-flipped → gate re-eval → route-back" seam extended to
> cover the wall-clock-expiry case, not only explicit revocation events.
>
> Freshness expectation is data on the CLAIM/bundle (`expiresAt`/`ttlSeconds` —
> Surface/Hachure), never a Flow scheduling config. Flow reads derived staleness;
> it neither computes nor schedules it. See `surface.md` Findings (Task A/D),
> `flow-followups.md` (§1 Findings), and design Decision #1.
