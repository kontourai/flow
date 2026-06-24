# Flow Documentation

Flow shows why a process was allowed to move forward — gate by gate, with the evidence behind each transition. This page is the map.

## Learn Flow

- [Getting Started](getting-started.md) — install → first run → evidence → route-back → resume, with real CLI output.
- [Use Cases](use-cases.md) — realistic team scenarios: agent guardrails, regulated releases, platform golden paths, adversarial review, audit evidence.

## Reference

- [CLI Reference](cli.md) — every command, flag, format, and exit code.
- [Library](library.md) — the typed API for embedding Flow: run lifecycle, validation, projections.
- [Evidence](evidence.md) — evidence kinds, `trust.bundle` expectations, trust artifacts, claim diagnostics.
- [Gates & Route-Back](gates-and-route-back.md) — evaluation rules, exceptions, route-back policy, transition validation.
- [Agent Hooks](agent-hooks.md) — enforcing Flow gates from Claude Code hooks, GitHub Actions, and Git hooks.
- [Project Config](project-config.md) — trusted producers, gate overrides, config merge preview/apply.
- [Release Readiness](release-readiness.md) — release lanes, pass/hold decisions, version release reports.
- [Flow Kit Container](flow-kit-container.md) — the core kit manifest contract, validation rules, and extension model.

## Product and architecture

- [Product Vision](product-vision.md) — why Flow exists, differentiation, product-line fit, and ownership boundaries.
- [Developer Architecture](developer-architecture.md) — lifecycle and enforcement internals, run files, console projection, Resource Contract direction.

## Contributing

- [Contributing](contributing.md) — local setup, validation lanes, optional repo hooks, release prep.
- [Repo Structure](repo-structure.md) — where source, schemas, examples, tests, docs, and generated output belong.

## Decisions

- [ADR 0001: Flow As Process Transparency Layer](adr/0001-flow-as-process-transparency-layer.md)
- [ADR 0002: Gate Expectations And Project Authority](adr/0002-gate-expectations-and-project-authority.md)
- [ADR 0003: Project Config Merge Semantics](adr/0003-project-config-merge-semantics.md)

## Placement rules

- Runtime and CLI behavior belongs in `src/`; public schemas in `schemas/`; published examples and scenarios in `examples/`.
- Node tests belong in domain files under `tests/node/`; browser tests in `tests/browser/`; operational tooling in `scripts/`.
- Durable product, architecture, contributor, and decision records belong in `docs/`. Update this map when adding, renaming, or retiring a guide.

Generated output and local runtime state stay out of source control unless a tracked fixture explicitly documents the exception.
