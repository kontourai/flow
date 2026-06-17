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
