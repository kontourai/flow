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
