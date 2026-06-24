# Legacy Surface Claim Fixture Directory

This directory name is legacy. The fixtures now exercise Flow matching for neutral `trust.bundle` evidence and current `bundle_claim` gate expectations. They are disk-backed examples for tests and contributors, not generated reports and not provider-specific contracts.

## Files

- `flow-definition.json` defines `surface-claim-fixture-flow` with one required `trust.bundle` expectation, `tests-passed`.
- `flow-config.json` defines neutral trusted producer policy for `quality.tests`.
- `evidence/*.json` files are Flow gate evidence manifests. Each file is valid JSON shaped for `gate-evidence.schema.json`.

## Trust Bundle Shape

Evidence entries use neutral Hachure TrustBundle fields under `bundle`: `schemaVersion`, `source`, `claims`, `evidence`, `policies`, and `events`.

Producer ids are intentionally generic, such as `surface-fixture/ci`, `surface-fixture/review`, and `external/untrusted`. The fixtures do not encode generated tool internals or provider-specific readiness concepts.

## Matrix

| Fixture | Expected Flow result | Expected diagnostic |
| --- | --- | --- |
| `pass-trust-report.json` | `pass`, matches `tests-passed` | none |
| `pass-trust-snapshot.json` | `pass`, matches `tests-passed` | none |
| `fail-missing-claim.json` | `route-back`, missing `tests-passed` | none |
| `fail-stale-claim.json` | `route-back`, missing `tests-passed` | `stale` |
| `fail-rejected-claim.json` | `route-back`, missing `tests-passed` | `rejected` |
| `fail-untrusted-producer.json` | `route-back`, missing `tests-passed` | `untrusted_producer` |
| `fail-subject-mismatch.json` | `route-back`, missing `tests-passed` | `subject_mismatch` |
| `fail-integrity-mismatch.json` | `route-back`, missing `tests-passed` | `integrity_mismatch` |
| `fail-authority-gap.json` | `route-back`, missing `tests-passed` | `authority_gap` |

`fail-missing-claim.json` uses an empty evidence manifest. A trust bundle without `claims` is invalid for normalization, so runtime missing-claim behavior is represented as no matching `trust.bundle` evidence instead of a malformed artifact.

## Naming

Use `pass-` for fixtures expected to satisfy the gate. Use `fail-` for fixtures expected to route back. Names should describe Flow behavior, such as `subject-mismatch` or `authority-gap`, rather than an implementation that produced the evidence.
