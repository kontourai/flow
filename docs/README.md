# Flow Docs

Use this page as the map for durable Flow documentation.

## Start Here

- [README](../README.md): package usage, CLI surface, local run store, evidence, gates, reports, and library exports.
- [Contributing](contributing.md): local setup, validation commands, optional repo hooks, source layout, and release prep.
- [Repo Structure](repo-structure.md): where source, schemas, examples, tests, docs, generated output, and local runtime state belong.

## Product And Architecture

- [Developer Architecture](developer-architecture.md): implementation lifecycle, gate evaluation, transition enforcement, route-back behavior, run files, reports, console projection, and ownership boundaries.
- [Product Boundaries](product-boundaries.md): what Flow owns versus Surface, Veritas, Flow Agents, and Builder Kit.
- [Product Vision](product-vision.md): why Flow exists and the v0.1 product shape.
- [Market Positioning](market-positioning.md): category, differentiation, competitive framing, and near-term wedge.
- [Adversarial-Pass Flow Definition](adversarial-pass.md): the adversarial review example and its boundary with reasoning systems.

## Decisions

- [ADR 0001: Flow As Process Transparency Layer](adr/0001-flow-as-process-transparency-layer.md)
- [ADR 0002: Gate Expectations And Project Authority](adr/0002-gate-expectations-and-project-authority.md)
- [ADR 0003: Project Config Merge Semantics](adr/0003-project-config-merge-semantics.md)

## Placement Rules

- Runtime and CLI behavior belongs in `src/`.
- Public schemas belong in `schemas/`.
- Published examples and scenarios belong in `examples/`.
- Node tests belong in domain files under `tests/node/`; shared test helpers belong in `tests/node/helpers/`.
- Browser tests belong in `tests/browser/`.
- Operational repo tooling belongs in `scripts/`.
- Durable product, architecture, contributor, and decision records belong in `docs/`.

Generated output and local runtime state stay out of source control unless a tracked fixture explicitly documents the exception.
