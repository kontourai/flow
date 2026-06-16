# Design: trust.bundle Evidence

**Status**: Implemented  
**Format change**: the `surface.claim` gate-evidence kind is replaced by the neutral `trust.bundle` (Hachure open format). Slotted as a minor release (no external consumers; the suite moves together).

## Context

Flow 1.x wired gate expectations and evidence to `kind: "surface.claim"` — a product-coupled term. The evidence entry carried a thin `claim: { type, subject, status }` projection normalised from an older Surface artifact shape (`artifact_type`, flat `claims[]` array with Flow-specific `schema_version: "0.1"`).

**Problems**:
1. `surface.claim` is a product name, not a neutral contract. Flow's declared principle is *Flow Core Neutrality* — no product-specific coupling in the gate model.
2. The 1.x trust artifact shape was Flow-invented, not a published open-format schema. Any tool wiring evidence had to match a non-public contract.
3. The thin claim projection (`type/subject/status`) lost provenance and derivation context that a full bundle carries.

## Hachure vs Surface

| Role | Package | What it is |
|------|---------|------------|
| **Format contract** | `hachure@0.4.0` | Open-format JSON Schemas for `TrustBundle`, `Claim`, `Evidence`, etc. + conformance test vectors + `statusFunctionVersion`. This is the neutral *schema* layer — no runtime behaviour, just the normative shape. |
| **Implementation** | `@kontourai/surface@1.0.1` | `buildTrustReport(bundle): TrustReport` derives claim statuses from a bundle according to the Hachure status function. Also exports `TrustBundle` / `Claim` TypeScript types and `validateTrustBundle`. |

Flow imports Hachure for schema validation and Surface for status derivation. Neither depends on a hosted service.

## New Evidence Shape

A `trust.bundle` evidence entry replaces `surface.claim`. The `bundle` field is a full [Hachure `TrustBundle`](https://hachure.dev) conformant object:

```json
{
  "id": "ev.1749000000.1",
  "gate_id": "verify-gate",
  "kind": "trust.bundle",
  "requested_kind": "trust.bundle",
  "status": "passed",
  "bundle": {
    "schemaVersion": 3,
    "source": "ci/main",
    "claims": [
      {
        "id": "claim.quality.tests",
        "subjectType": "flow-step",
        "subjectId": "builder.verify",
        "surface": "quality.developer-evidence",
        "claimType": "quality.tests",
        "fieldOrBehavior": "testSuite",
        "value": "all tests passed",
        "createdAt": "2026-06-15T00:00:00.000Z",
        "updatedAt": "2026-06-15T00:00:00.000Z"
      }
    ],
    "evidence": [],
    "policies": [],
    "events": []
  },
  "bundle_report": {
    "id": "report.1749000000",
    "generatedAt": "2026-06-15T00:00:00.000Z",
    "claims": [
      { "id": "claim.quality.tests", "claimType": "quality.tests", "status": "verified" }
    ],
    "summary": { "counts": { "total": 1, "byStatus": { "verified": 1 } } }
  },
  "attached_at": "2026-06-15T00:00:00.000Z"
}
```

`bundle` is validated against the Hachure `trust-bundle.schema.json` at attach time and evaluation time. `bundle_report` is the cached result of `buildTrustReport(bundle)` — derived claim statuses stored alongside the bundle so reports and the console can show derived status without re-computing.

## New Gate Expectation Shape

Gate `expects` entries use `kind: "trust.bundle"` with a `bundle_claim` selector that identifies which claim in the bundle must be present and what statuses are accepted:

```json
{
  "id": "tests-passed",
  "kind": "trust.bundle",
  "required": true,
  "description": "Test results are ready for verification.",
  "bundle_claim": {
    "claimType": "quality.tests",
    "subjectType": "flow-step",
    "subjectId": "builder.verify",
    "accepted_statuses": ["verified"]
  },
  "explore_hint": "Run the suite and attach the Hachure trust bundle from CI."
}
```

| Field | Meaning |
|-------|---------|
| `bundle_claim.claimType` | The Hachure claim `claimType` the evidence bundle must contain (required) |
| `bundle_claim.subjectType` | Optional Hachure `subjectType` to scope the claim match |
| `bundle_claim.subjectId` | Optional Hachure `subjectId` to scope the claim match |
| `bundle_claim.accepted_statuses` | Surface-derived `TrustStatus` values that satisfy the gate (default: `["verified"]`) |

`accepted_statuses` values are Hachure/Surface `TrustStatus` strings: `"unknown"`, `"proposed"`, `"assumed"`, `"verified"`, `"stale"`, `"disputed"`, `"superseded"`, `"rejected"`.

## Validation and Derivation Pipeline

Gate evaluation for `trust.bundle` follows this pipeline:

```
evidence.bundle
  ↓ validateTrustBundle()         (Surface) — structural + referential validity
  ↓ hachure trust-bundle.schema   (Hachure via Ajv) — JSON Schema conformance
  ↓ buildTrustReport(bundle)      (Surface) — derive claim statuses
  ↓ find claim matching selector  (claimType + optional subjectType/subjectId)
  ↓ check claim.status ∈ accepted_statuses
  → pass / fail / diagnostic
```

The JSON Schema validation uses the Hachure-exported `trust-bundle.schema.json` with Ajv (added as a dependency). This catches malformed bundles before derivation.

## Migration: surface.claim → trust.bundle

`surface.claim` is **fully removed** in Flow 1.3 (minor). There is no back-compat path. Consumers must:

1. Replace `kind: "surface.claim"` with `kind: "trust.bundle"` in gate definitions.
2. Replace `claim: { type, subject, accepted_statuses }` with `bundle_claim: { claimType, subjectType, subjectId, accepted_statuses }`.
3. Attach evidence as `--kind trust.bundle --bundle <path>` (or library `options.bundle`).
4. The bundle file must conform to the Hachure `TrustBundle` schema (`schemaVersion` 2 or 3).

The old thin trust artifact shape (`schema_version: "0.1"`, `artifact_type: "trust-report"`) is no longer accepted.

## Why a minor release

Although the gate-evidence contract changes, this ships as a MINOR release: the Kontour products are co-developed 1.x with no external consumers of the surface.claim evidence kind, so there is nothing to break in practice. Internally the affected surfaces are:
- The `kind` enum in `gate-evidence.schema.json` changes.
- The `expectation` shape in `flow-definition.schema.json` changes.
- The `FlowExpectation` TypeScript type changes.
- The `BUILTIN_EVIDENCE_KINDS` set changes.
- All evidence manifests using `surface.claim` must be re-authored.

Per semantic versioning this is a major-version increment: **Flow 1.3 (minor).0**.

## Downstream: flow-bridge

The Console flow-bridge consuming `trust.bundle` evidence should:

- Look at `evidence_entry.kind === "trust.bundle"` (not `"surface.claim"`).
- Read `evidence_entry.bundle_report.claims` to get derived statuses — no re-derivation needed.
- The `bundle_report` shape mirrors `TrustReport` from `@kontourai/surface`: `{ id, generatedAt, claims: [{ id, claimType, subjectType, subjectId, status, ... }], summary }`.
- `bundle` is the raw Hachure `TrustBundle` for audit/display.
- Matched expectations appear in `gate_outcome.matched_expectations[].expectation_id`.
- Diagnostic codes for failed `trust.bundle` evaluation: `"bundle_invalid"`, `"claim_not_found"`, `"rejected"`, `"stale"`, `"disputed"`.
