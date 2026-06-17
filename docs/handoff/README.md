# Cross-Repo Handoff — Trust Freshness, Bundle Recursion & Console Alignment

**Audience:** an agent/engineer with write access to the sibling Kontour repos
(`kontourai/hachure`, `kontourai/surface`, `kontourai/console`) — not just
`kontourai/flow`.

**Why this exists:** the design in
`docs/design/route-back-cascade-and-trust-recursion.md` spans four repos. The
Flow-only parts are **already implemented on this branch** (see "Done in Flow"
below). The remaining work lands in the other repos, plus follow-ups in Flow
that depend on them. Each task file here is self-contained: context, concrete
changes, acceptance criteria, and coordination notes.

## Vocabulary — do not interchange these

| Term | What it is | Tell |
|------|-----------|------|
| **TrustBundle** | the *container/artifact* you pass around and attach to a gate as evidence; holds `claims[]`, `evidence[]`, `events[]`, `policies[]` | **has no status of its own** |
| **Claim** | one *assertion* inside a bundle ("tests pass", "plan approved") | **the thing that has a status** (`verified`/`stale`/`disputed`/…) |
| **Evidence** | the proof backing a claim | referenced by `claimId` |
| **Event** | a line in a claim's append-only history ledger (who verified/revoked it, when) | not a fired signal — a record |
| **TrustReport** | Surface's derivation of a bundle | **bundle in → claim statuses out** |

Rule of thumb: **"Attach a bundle, verify a claim. Status lives on claims, never
on bundles."** Discriminator: *if it has a status, it's a claim; if it's the
thing carrying claims, it's a bundle.* In Flow terms: an evidence entry carries a
**bundle**; a gate's `expects` selects a **claim** (by `claimType` /
`subjectType` / `subjectId`) inside it.

## Read first

- `docs/design/route-back-cascade-and-trust-recursion.md` — the full design and
  the layer model (Hachure = shape, Surface = meaning, Flow = reaction).
- `docs/design/nested-trust-panel.md` — the `<surface-trust-panel>` embedding
  spec (drives the Surface packaging task and the Flow console follow-up).

## Done in Flow (this branch: `claude/route-backs-dag-deps-h07yat`)

- **Route-back cascade** — `descendantsOf` + `invalidateDescendants` in
  `src/definition/flow-definition.ts`; wired into the `route-back` branch of
  `applyEvaluation` (`src/gates/flow-gates.ts`); `invalidated_steps` added to
  the transition schema; tests in `tests/node/check-route-back-cascade.test.mjs`.
  This is the process-layer half of the freshness/cascade story and needs
  nothing from the other repos.

## Dependency order (do in this order)

1. **`hachure.md`** — schema fields for freshness + invalidation. Pure shape; no
   behaviour. Everything else keys off these field names + a `statusFunctionVersion`.
2. **`surface.md`** — make `buildTrustReport` time-aware and add checkpoint
   derivation; emit freshness transitions. Depends on (1).
3. **`flow-followups.md`** — Flow re-derives instead of caching; emits a
   run-output bundle and `.kontour/events`; wires the nested panel. Depends on
   (1) and (2), and on the Surface element packaging in (4).
4. **`console.md`** — consume Flow's events/projections; embed the Flow and
   Surface web components. Depends on (3) and the Surface element being
   consumable.

## Non-negotiable invariants (keep these true everywhere)

- **Authority stays put:** Surface owns claim trust state; Flow owns process.
  Console aggregates read-only — it never owns authoritative state.
- **Recursion is by reference, not embedding:** a parent cites a child bundle by
  `id + claim selector + statusFunctionVersion + asOf`; it never inlines the
  child's claims/events ledger. Keep the reference graph acyclic.
- **Flow stays time-neutral:** all freshness/TTL math lives in Surface. Flow
  only decides *when* to re-derive and *what* to re-run.

## Reporting findings back to Flow (return protocol)

The other repos are where you *do the work*; **this Flow repo is the durable
channel back** — the originating session is ephemeral, so anything that isn't
written here (or into a PR against `kontourai/flow`) is lost. After you answer an
open question or ship a change in `hachure`/`surface`/`console`:

1. **Append a `## Findings — YYYY-MM-DD` section to the handoff file you acted
   on** (`hachure.md` / `surface.md` / `console.md`), using the template below.
2. **If a finding changes a Flow assumption** (e.g. "Surface rollups *do* span
   referenced bundles and propagate"), also update the affected design doc
   (`docs/design/route-back-cascade-and-trust-recursion.md` or
   `nested-trust-panel.md`) and flag the impacted task in `flow-followups.md`.
3. **Land it as a PR against `kontourai/flow`**, base branch
   `claude/route-backs-dag-deps-h07yat`, titled
   `handoff-findings: <repo> — <topic>`. Do **not** push other repos' source
   into this repo — link to it instead.
4. **If you need a decision from the Flow owner**, put it under a
   `## Needs decision` heading rather than guessing, and stop there.

### Findings template

```md
## Findings — 2026-06-17
**Repo/PR:** kontourai/surface#123 (sha abc1234)
**Question answered:** can derived claims span referenced bundles? → YES / NO
**Answer / behaviour:** <one paragraph of what is actually true now>
**Impact on Flow:** <which flow-followups.md task changes, and how>
**Follow-up / open:** <anything still blocked, under "Needs decision" if so>
```
