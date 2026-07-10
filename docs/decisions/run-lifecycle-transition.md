---
status: current
subject: Run Lifecycle Transition
decided: 2026-07-10
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow/issues/115
  - kind: session-archive
    ref: .kontourai/flow-agents/flow-run-authority-lifecycle/flow-run-authority-lifecycle--pull-work.md
---
# Run Lifecycle Transition

Pause, resume, and cancellation are Flow Run lifecycle transitions, not Step
transitions. They change whether the canonical run may continue while preserving
`current_step`, gate outcomes, evidence, exceptions, and the required path.

A lifecycle transition must not satisfy a Gate, count as predecessor passage,
advance to a Step edge, or create a second path through the Flow Definition.
Pause is nonterminal and resumable. Cancellation is terminal and requires a
structured external authority record. Flow validates and persists the authority
record's provider-neutral shape; the calling consumer remains responsible for
authenticating the user or operator request before invoking Flow.

Assignment release, archive, and resource cleanup are consumer concerns and are
not consequences that Flow core performs automatically.

## Rationale

Flow Run state is the continuation authority. Allowing a consumer to represent a
pause or cancellation only in its own projection would leave Flow active and
make reports, resume behavior, and enforcement disagree. Treating cancellation
as a Step transition would be worse: it would turn abandonment into apparent
path completion. A separate lifecycle transition preserves one canonical state
machine without weakening Flow Definition ordering.

## Consequences

- Run schemas and public APIs distinguish lifecycle records from Step transition
  history while keeping them visible in reports and Console projections.
- Evaluation and Step advancement reject paused and canceled runs.
- Evidence attachment and exception acceptance also reject paused and canceled
  runs before copying or writing. Generic run persistence is internal.
- Rejected lifecycle requests leave the run directory unchanged.
- Consumers may attach provider-specific request evidence outside Flow, but the
  stored Flow record stays provider-neutral and auditable.
- An identical terminal cancellation replay is a no-write success; a different
  request conflicts with the recorded terminal authority and is rejected.
- Compatible non-lifecycle run state with no lifecycle field normalizes to an
  empty ledger at load. Malformed or incoherent lifecycle data remains an error.
- The local store validates and projects all outputs before writing, then writes
  canonical state and derived reports sequentially. This is an honest
  single-writer filesystem boundary, not a multi-file transaction; consumers
  must avoid concurrent mutations and may regenerate stale derived reports
  after an exceptional partial I/O failure.
- Lifecycle output targets are opened with no-follow semantics and verified as
  regular files through their descriptors. Flow still assumes a trusted local
  single writer; it does not claim a general filesystem transaction.

## State table

| Operation | Allowed source | Result | Other sources |
| --- | --- | --- | --- |
| pause | `active`, `blocked`, `needs_decision` | `paused`, with exact prior status | rejected before mutation |
| resume | `paused` | exact recorded prior status | rejected before mutation |
| cancel | `active`, `blocked`, `needs_decision`, `paused` | terminal `canceled` | completed/canceled rejected, except identical cancellation replay |
| evaluate or Step advance | normal runnable statuses | existing Step behavior | paused/canceled rejected before mutation |

Ordinary Flow evaluation may change `active`, `blocked`, or `needs_decision`
between lifecycle events without adding a lifecycle record. Lifecycle validation
therefore pairs each resume with the most recent unmatched pause rather than
requiring adjacent lifecycle events to have identical boundary statuses.

Every successful lifecycle event contains an action, before/after and prior
status, reason, event time, and external authority with `kind`, `actor`,
immutable `request_ref`, and `requested_at`. Authority kinds are restricted to
`user_request` and `operator_request`; authentication is deliberately outside
Flow. `actor` (256 characters), `request_ref` (2048), and `reason` (4096) are
bounded printable Unicode text. C0, DEL, and C1 controls, including CR/LF and
terminal ESC/OSC sequences, are rejected before persistence. Markdown and
shell punctuation remain inert data and are escaped at Markdown boundaries.
