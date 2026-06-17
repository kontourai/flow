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
