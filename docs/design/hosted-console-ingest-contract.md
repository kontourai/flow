# Hosted-Console Ingest Contract

**Status:** **v1 (provisional — ratify when console confirms implementation).**

This is the HTTP contract by which Flow's `HostedConsoleSink`
(`src/console/console-sink.ts`) delivers its OWN typed projection
(`FlowConsoleProjection`) to a hosted console plane. It resolves the long-open
`## Needs decision — hosted-ingest API contract` in `docs/handoff/console.md`.

It extends the ConsoleSink seam (Decision #5 in
`docs/design/route-back-cascade-and-trust-recursion.md`): `FileConsoleSink`
stays the default local write/serve path; `HostedConsoleSink` is the optional,
config-gated HTTP push of the SAME Flow-owned payload.

---

## Ownership

- **Flow owns the `payload`** — the `FlowConsoleProjection`. Flow never produces
  the console envelope.
- **Console owns the `kontour.console.event` envelope** it wraps around the
  payload on ingest, plus the persisted `recordId`. Authority stays put: Flow
  owns process/projection, console aggregates read-only.
- Flow depends on **no** `@kontourai/console-*` package. It exports the typed
  contract (`FlowIngestRequest`, `FlowConsoleProjection`) from
  `@kontourai/flow/console-contract`; **console imports those types to validate
  incoming bodies.** The dependency arrow is therefore **console → flow** only.

---

## The contract

```
POST  <console-base>/ingest/flow
Auth: Authorization: Bearer <per-product token>   # env-configured; absent ⇒ HostedConsoleSink disabled (FileConsoleSink only)
Body (JSON):
  {
    "contractVersion": "1",
    "source": "flow",
    "type": "<FlowConsoleProjection record type>",   # e.g. the transition/projection type
    "idempotencyKey": "<runId>:<monotonic seq>",      # retries dedup on this
    "occurredAt": "<ISO-8601>",
    "payload": <FlowConsoleProjection>                 # Flow OWNS the payload
  }
Response: 202 { "recordId": "<id>" }    # console wraps payload into a kontour.console.event envelope
          4xx { "error": ... } on validation failure (bad contractVersion / shape)
```

The envelope is typed as `FlowIngestRequest<TPayload = FlowConsoleProjection>`
in `src/console/console-sink.ts` and re-exported from the
`@kontourai/flow/console-contract` subpath. It is console-package-free.

---

## Auth

- Per-product **bearer token**, sent as `Authorization: Bearer <token>`,
  env-configured Flow-side (`HostedConsoleSinkOptions.authToken`).
- **Absent token (or base URL) ⇒ the hosted sink is disabled.** `createConsoleSink`
  falls back to `FileConsoleSink` only — Flow never POSTs unauthenticated.

## Idempotency

- `idempotencyKey = "<runId>:<monotonic seq>"`. The sequence advances per emit
  per sink instance.
- Retries dedup on this key: re-POSTing the same `idempotencyKey` must be safe
  and return the same `recordId`. (Mirrors the existing flow-bridge property:
  `kontour.console.event` ids are deterministic and hub projections dedup by id.)

## Timeout

- The request keeps an `AbortController` timeout (default 10000 ms,
  `HostedConsoleSinkOptions.timeoutMs`).

---

## Cross-reference — Ephemeris

Ephemeris (the future standalone freshness scheduler, see
`docs/design/route-back-cascade-and-trust-recursion.md` Decision #1) reuses this
same emitted-artifact exposure: it reads the emitted bundle's `expiresAt` and
fires an idempotent `evaluateRun` trigger; the resulting re-derived projection is
delivered over this same `HostedConsoleSink` push path. Ephemeris triggers, never
authors — the ingest contract here is the exposure surface it reuses.

---

## Open (infra, not contract)

- The hosted **endpoint must actually be stood up console-side** (route mounting +
  real auth middleware). Console ships a tested ingest stub handler against this
  contract today; production server wiring/auth is a console infra follow-up (see
  `docs/handoff/console.md`).
