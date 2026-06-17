# Ephemeris — External Freshness Scheduler / Event-Bridge

**Status:** design sketch (future, separate repo) · **Layer:** time actor ·
**Depends on:** Flow's emitted run-output TrustBundle (`docs/design/route-back-cascade-and-trust-recursion.md`, Thread 3).

> *Ephemeris* (n.) — in surveying/GNSS, a table of time-indexed positions that
> has an age, goes stale, and must be refreshed. The name carries the
> freshness/expiry meaning for free.

## Why this exists

`route-back-cascade-and-trust-recursion.md` Decision #1 resolved that **neither
Surface nor Flow has a scheduler.** Flow's only clock is the `now` captured at an
`evaluateRun` that **some external actor** (producer / CI / agent / person)
triggers. A claim that silently expires at 2am is only *observed* at the next
externally-invoked evaluation — there is no proactive emission.

That leaves a deliberate hole: *something* has to notice "claim X expires at T"
and actually produce the trigger at T. Putting that in its own product is how the
hole gets filled **without** putting a timer back into the two layers that must
not have one. Ephemeris **is** that external actor, productized — for the
wall-clock case specifically.

## What it is

A long-lived, stateful, always-on daemon that:

1. **Ingests** Flow's emitted run-output TrustBundles and reads each referenced
   claim's `expiresAt` / `ttlSeconds` (Hachure freshness fields — already in the
   bundle; **no new schema**).
2. **Arms** a durable timer per claim deadline (data-derived instants, not cron).
3. **Fires** an idempotent trigger at T — invokes Flow's `evaluateRun` entry
   point (or pings the producer to re-verify).

That is its entire job: **turn time → a trigger.**

## What it owns — and what it must NOT

| Owns | Does NOT own |
|------|-------------|
| The clock — arming/firing timers off claim deadlines | Claim trust state (Surface owns it) |
| Durable persistence of armed wake-ups (survive restart) | Process state / gate outcomes (Flow owns them) |
| Idempotent, deduped dispatch of triggers | Any authoritative copy of anything |

Two hard rules, inherited from the layer model:

- **It triggers, it never authors.** Ephemeris writes **nothing** to the ledger.
  When it fires, that is only a *nudge*: Flow re-derives at the real `now`,
  Surface decides for real. Because it is never the source of truth, an
  over-fire is harmless — the claim may already have been refreshed, and the
  re-derivation simply finds it fresh.
- **Expiry is derived; invalidation is an event.** Time passing → Surface derives
  `stale` from `expiresAt` (no record written). An *explicit* decision → a real
  `revoked`/invalidation **ledger event**, authored by the producer/actor
  Ephemeris woke — never synthesized by Ephemeris itself. (This is exactly the
  "don't materialize expiry as a synthetic event" boundary: doing so would
  re-couple "something must write to the bundle on a timer," the dependency we
  removed.)

## Why a separate repo, not rolled into an existing layer

The defining property is a **stateful, always-on, data-driven timer firing
programmatic triggers.** Walk the candidates:

- **Console** — read-only operating plane that must *never* trigger or own state.
  Making it fire `evaluateRun` violates its core invariant. ❌
- **Flow / Surface** — Flow "just emits artifacts" (ADR 0001); Surface is a
  derivation library. Neither is a daemon, and both were kept scheduler-free by
  decision. ❌
- **`boo`** — a *cron* daemon that runs *agent prompts* as personal automation.
  Three mismatches: cron patterns ≠ thousands of dynamic per-claim deadlines;
  agent-prompt execution ≠ a programmatic trigger; personal-machine automation ≠
  server-side infra watching production bundles. Wrong primitive, wrong
  deployment domain. ❌

None of the existing layers can host it without breaking an invariant or a
design stance. It needs a daemon home, and the only correct one is **its own** —
deployed server-side alongside Flow/Console.

## Relation to `HostedConsoleSink`

Ephemeris is the **same edge-adapter shape** as the `HostedConsoleSink`: both
consume Flow's neutral emitted artifact and translate it outward, while Flow
stays ignorant of both. The difference in direction: the console sink is purely
*outbound* (Flow → console API); Ephemeris closes a *feedback loop* (bundle →
timer → trigger back into Flow's `evaluateRun`). That feedback direction is why
they stay distinct components rather than one outbound layer.

This reinforces the broader pattern: **Flow's emitted bundle/projection is
becoming the stable integration seam** that multiple external products consume,
and Flow depends on none of them.

## Open questions (pin before it's real)

- **Emits *to* what:** directly call Flow's `evaluateRun` entry point, notify the
  producer, or drop onto a generic event bus adapters consume?
- **Discovery:** how it learns which bundles/claims to watch — subscribe to
  emitted bundles, a registry, watch a stream/directory?
- **Durability:** armed wake-ups must persist across restarts (a real scheduler
  requirement).
- **Idempotency / backpressure:** dedup so a flappy claim doesn't storm triggers.
- **Shared seam:** the hosted-ingest contract that `HostedConsoleSink` also needs
  (`docs/handoff/console.md`) is the same surface Ephemeris consumes — design the
  emitted-bundle contract once, for both.

## Non-goals

- Not an orchestrator and not a trust authority. It schedules; it does not decide.
- Not a replacement for the producer/CI/person trigger paths — it is one more
  external trigger source, specialized for wall-clock expiry.
