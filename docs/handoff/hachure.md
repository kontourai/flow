# Handoff — Hachure: Freshness & Invalidation Schema

**Repo:** `kontourai/hachure` · **Layer:** neutral format contract (no runtime
behaviour) · **Depends on:** nothing · **Blocks:** Surface, Flow.

## Context

Hachure owns the normative JSON Schemas for `TrustBundle`, `Claim`, `Evidence`,
`Event`, `Policy`, plus `statusFunctionVersion`. Flow consumes bundles as gate
evidence; Surface derives claim status from them. Today a claim carries
`createdAt`/`updatedAt` and the bundle carries an `events[]` ledger, but there
is **no validity window** and **no explicit invalidation/revocation event** — so
"this claim is good until T" and "this claim was revoked" cannot be expressed.

## Goal

Add the *shape* for time-based freshness and explicit invalidation. Behaviour
(deriving a status from these) is Surface's job, not Hachure's.

## Changes

1. **Claim validity window (optional):**
   - `claim.expiresAt` — ISO-8601 timestamp; after this instant the claim is no
     longer fresh.
   - Optionally `claim.ttlSeconds` — relative alternative resolved against the
     governing event's timestamp. Pick one as canonical; document precedence if
     both are allowed.

2. **Invalidation event:** extend the `event.status` vocabulary (or add an
   `event.type`) so a ledger line can assert revocation/staleness explicitly,
   e.g. `status: "revoked"` / `"stale"`, with the existing `actor`, `method`,
   `evidenceIds`, `createdAt`. This is the "emit a claim event" primitive —
   appending a line, not firing a signal.

3. **Bump `schemaVersion`** and a new `statusFunctionVersion` value so derivers
   pin behaviour. Add conformance test vectors:
   - a claim past `expiresAt` (expects "no longer fresh"),
   - a claim with a later `revoked` event (expects "invalidated"),
   - a claim with neither (expects unchanged from current behaviour).

## Acceptance criteria

- New fields are **optional**; every existing valid bundle still validates.
- Schemas remain pure JSON Schema (Hachure adds no runtime code).
- Test vectors exist for fresh / expired / revoked and are referenced by the
  Surface task.

## Coordination

- Field names are the contract Surface reads — agree them with `surface.md`
  before merging.
- Flow validates bundles against these schemas via
  `src/gates/trust-bundle-validator.ts` (Ajv over Hachure's `schemas/`); after
  the bump, Flow picks up the new schema by upgrading the `hachure` dep.

## Findings — 2026-06-16

**Repo/PR:** hachure-org/spec, branch `claude/freshness-invalidation-schema`
(sha 185de4e — committed locally, not pushed). Package version bumped `0.4.0 → 0.5.0`.

**Question answered:** what is the concrete field contract for freshness +
invalidation, and does it stay back-compatible? → Done, fully optional.

**Answer / behaviour:**
- **Claim validity window (`claim.schema.json`):** added optional `expiresAt`
  (ISO-8601 `date-time`) and optional `ttlSeconds` (`integer ≥ 0`). **Canonical
  precedence: `expiresAt` wins when both are present.** `ttlSeconds` resolves
  against the governing verification event's `verifiedAt` (fallback
  `createdAt`). These are *claim-intrinsic* and override the policy
  `validityRule` timing when present.
- **Invalidation event (`verification-event.schema.json`):** added `"revoked"`
  to the event `status` enum, plus an optional `type` classifier
  (`"verification"` default | `"invalidation"`). An `invalidation` event is
  terminal; a `"revoked"` status derives `stale` (event-driven staleness).
  Existing `actor`/`method`/`evidenceIds`/`createdAt` shape unchanged.
- **Versions:** `trust-bundle.schema.json` now accepts `schemaVersion` ∈
  `{2,3,4}`; `statusFunctionVersion` bumped `"1" → "2"` in `index.mjs` (and the
  smoke test + `status-function.md` + `README.md` updated to match).
- **`inquiry-record.schema.json`:** `"revoked"` added to its status enums for
  consistency so a frozen inquiry record can record a revoked answer.
- **Conformance vectors added:** `sf-expired-window.json` (stale past
  `expiresAt` AND past `ttlSeconds`), `sf-revoked-event.json` (revoked
  invalidation event → stale), `sf-no-freshness-fields.json` (no new fields →
  derives `verified`, identical to v1). All 52 package tests pass
  (`npm test`).
- **Back-compat:** every new field is optional; no `required` array changed.
  Bundles valid at `schemaVersion` 3 remain valid. The `trust-bundle`
  `not`-constraint guard is untouched.

**Field-name contract (shared with surface.md):**
`claim.expiresAt` · `claim.ttlSeconds` · `event.status = "revoked"` ·
`event.type = "invalidation"`. Surface must read exactly these.

**Impact on Flow:** Flow's `trust-bundle-validator.ts` (Ajv over Hachure
schemas) keeps validating existing bundles after upgrading the `hachure` dep to
`0.5.0`. When Flow emits its run-output bundle it should stamp
`schemaVersion: 4` only if it uses the new fields (3 is still fine otherwise).
Flow must pin `statusFunctionVersion: "2"` in inquiry records / bundle
references once it upgrades Surface.

**Follow-up / open:** none for Hachure. Ajv is not installed in the hachure
repo (pure spec package), so schema-validation of the new fields is exercised
downstream in Surface/Flow, not here.
