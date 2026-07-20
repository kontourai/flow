---
status: current
subject: Definition Amendment
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow/issues/146
---
# Definition Amendment

An active Flow Run may receive one explicitly authorized, compatible successor
definition. It is neither a replacement run nor a migration. Flow retains
`definition.json` as the immutable start snapshot and stores the complete
normalized successor, prior and successor identities, exact prior state head,
authority, reason, and runtime-derived timestamp in the append-only
`state.json` amendment ledger.

The effective definition is the start snapshot when the ledger is absent, and
the last validated successor otherwise. Its identity is `{id, version, digest}`
where `digest` is SHA-256 of normalized canonical JSON. A version is opaque:
Flow rejects equal, reused, and rollback versions without inventing semantic
version ordering.

## Admission and compatibility

The request binds externally authenticated, provider-neutral authority to the
exact `expected_run_head`, current effective definition identity, and separately
supplied successor digest. Flow validates the authority record shape only;
consumers authenticate it and enforce their own envelopes. Reused `request_ref`
is always a conflict, never an idempotent replay.

Before and after taking the shared same-run mutation ticket, Flow requires an
active run, exact heads, unchanged definition id, a new identity, and a history
proof. Persisted steps, gates, transitions, accepted expectation contracts and
matched evidence identities, route-back/retry accounting, and current cursor
must still be valid under the successor. History-free current/future behavior
can change, such as adding a new route-back reason for the current gate.
The audit event stores the exact prior state without its amendment ledger. On
load, Flow reconstructs the preceding ledger prefix, verifies `prior_run_head`,
and replays compatibility against that boundary. Successor-created history
therefore cannot retroactively invalidate the amendment that enabled it.

## Persistence and recovery

`state.json` is the sole canonical amendment commit. Flow stages report JSON
and Markdown first and renames state last. Reports and Console projections are
disposable: every load derives the effective definition from the immutable
snapshot plus canonical state, and `flow report` repairs stale or ahead report
files. The evidence manifest and copied evidence remain bound to the start
snapshot and are never rewritten by amendment.

Flow performs no automatic legacy digest backfill, migration, downgrade, or
rollback. A correction after an accepted amendment is a new compatible
amendment with fresh authority and heads. Consumers holding the prior effective
identity must treat it as stale.
