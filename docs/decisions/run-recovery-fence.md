---
status: current
subject: Run Recovery Fence
decided: 2026-07-23
evidence:
  - kind: issue
    ref: https://github.com/kontourai/flow-agents/issues/756
---
# Run Recovery Fence

Flow reserves `recovery-fence.json` at each fixed canonical Flow Run path as a
provider-neutral coordination boundary for an external recovery coordinator.
The v1 record is:

```json
{
  "protocol": "flow.run-recovery-fence.v1",
  "run_id": "dev-1847",
  "recovery_id": "recovery-01",
  "generation": "8aa8c1c4-07d1-4bd9-bd0b-5e473ce0b50f",
  "status": "active",
  "updated_at": "2026-07-23T12:00:00.000Z"
}
```

`active` closes the run. `open` records that the named recovery has completed
and allows access. No fence allows access for compatibility with runs created
before the protocol. Malformed records, unknown protocols, and unknown states
fail closed. Every persisted generation must be a canonical UUID v4.
`writeRunRecoveryFence()` accepts only `active` records; Flow creates a unique
generation for every atomic write and rejects a caller-supplied generation.
Every newly finalized `open` record also names the exact active
`previous_generation` it succeeded; legacy open records remain readable but
cannot prove this succession to a queued mutation.

## Rationale

A recovery coordinator can otherwise restore a valid sequence of individual
files while a Flow reader observes a mixed generation or a Flow mutation
publishes new state into the recovery window. Keeping one stable record outside
the coordinator's transactional postimages gives Flow and the coordinator a
shared boundary without moving canonical run paths or teaching Flow about the
coordinator's provider, backup format, or recovery algorithm.

## Supported boundary

- Supported full-file reads inspect the fence before reading and again after
  their definition, state, manifest, report, or projection work. The two safe
  snapshots must retain the exact persisted-byte digest, Flow-generated
  generation, and fixed run-directory device/inode. An open A to active B to
  open A recovery or a byte-identical directory replacement is therefore still
  rejected.
- Supported run mutations use Flow's native per-run mutation ticket and
  recheck the fence after their ticket enters the holding state. A coordinator
  may close the fence before waiting on the same ticket protocol; an earlier
  writer can finish, while later writers fail closed after acquiring.
- `list` reports a fenced or invalid run as a diagnostic instead of projecting
  it. New-run allocation never reclaims an existing fixed run path, including a
  fenced one.
- Console file-backed loading, optional report repair, and projection occur
  within one outer generation-bound read. Artifact serving and fixed-path
  rebinding use the same boundary. Console polling re-resolves a fixed run path
  after a directory generation is replaced. `FileConsoleSink` recomputes the
  current projection under its native mutation ticket rather than persisting a
  possibly stale caller projection.

The exported active-only fence writer atomically replaces only
`recovery-fence.json`. Recovery coordinators own authorization, durability,
and postimages.
`withRunRecoveryLock()` is the recovery-only entry to Flow's native mutation
ticket: it requires the exact active `recovery_id` both before waiting and after
the ticket is held, then verifies the same active generation again after the
callback and before ticket release. `finalizeRunRecoveryFence()` is the sole
supported `active` to `open` transition. It obtains a new native mutation
ticket, verifies the caller's exact expected active generation, fingerprint,
and run-directory identity after acquisition, durably publishes a fresh open
generation linked to that active predecessor while still holding that ticket,
and then releases it. A direct
writer cannot publish `open` in the same process or a different process.
Ordinary `withRunMutationLock()` calls that begin while a fence is already
active remain closed. A call that entered while the fence was open but reached
the native ticket after recovery activated releases and requeues its ticket.
It proceeds only after the same `recovery_id` publishes an open successor that
names the exact active generation it observed;
active-generation drift, removal, replacement by another recovery, or timeout
fails closed.

Fence publication writes through an exclusive no-follow temporary descriptor,
calls `fsync` on the file, renames it over the fixed fence path, then calls
`fsync` on the parent run directory. A failed pre-rename step leaves the prior
fence intact; a failed post-rename durability step reports failure while the
new complete record remains inspectable.

## Explicit exclusions

The guarantee applies to Flow's CLI and high-level package APIs. Arbitrary raw
filesystem access, pure in-memory projectors and validators, generic
`readJson`/`writeJson`, and report rendering to an arbitrary directory are
low-level primitives outside the fence guarantee. The fence is not a general
filesystem transaction and does not make unsupported direct writes safe.
