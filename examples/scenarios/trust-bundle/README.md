# trust-bundle Scenario

Fixture-backed scenario demonstrating `trust.bundle` gate evidence evaluation in Flow 2.0.

## Shape

Gate `verify-gate` expects a `trust.bundle` evidence entry with:
- `bundle_claim.claimType`: `"quality.tests"`
- `bundle_claim.subjectType`: `"flow-step"`
- `bundle_claim.subjectId`: `"builder.verify"`
- `bundle_claim.accepted_statuses`: `["verified"]`

The `bundle` field carries a Hachure-format `TrustBundle` (schemaVersion 2 or 3). Flow validates the bundle against the Hachure JSON Schema, then calls Surface `buildTrustReport()` to derive claim statuses.

## Evidence fixtures

| File | Derived claim status | Gate outcome |
|------|---------------------|--------------|
| `pass-verified.json` | `verified` | pass |
| `fail-missing-claim.json` | (no evidence) | missing_evidence route-back |
| `fail-rejected-claim.json` | `rejected` | rejected diagnostic |
| `fail-stale-claim.json` | `stale` | stale diagnostic |
| `fail-disputed-claim.json` | `disputed` | disputed diagnostic |
| `fail-claim-not-found.json` | (wrong claimType) | claim_not_found diagnostic |
| `fail-bundle-invalid.json` | (invalid bundle) | bundle_invalid diagnostic |
