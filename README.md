# Kontour Flow

Kontour Flow is a process transparency and gate enforcement product for work that must follow an inspectable path.

Flow is part of Kontour AI's transparency building blocks for the AI era:

- Surface makes claims inspectable.
- Flow makes required process paths inspectable.
- Veritas makes AI-authored code changes inspectable.
- Kagents applies those primitives inside agent runtimes.

Flow helps humans and agents answer:

- What process was supposed to run?
- Which step is active now?
- What evidence allowed each gate to pass?
- Which transition was blocked, skipped, or accepted by exception?
- What should happen next before anyone relies on the result?

Flow is built with Kontour Surface. Normal Flow users should not need to configure Surface directly.

## Product Boundary

Flow is not an agent runtime, multi-agent orchestrator, task board, or repo standards engine.

- Surface owns portable claims, evidence, policies, freshness, gaps, and trust snapshots.
- Flow owns process runs, steps, gates, transitions, exceptions, and Flow Reports.
- Veritas owns repo standards, repo maps, requirements, change guidance, and merge readiness.
- Kagents owns agent-facing modes, skills, runtime adapters, provider settings, and useful Flow-backed workflow packs.

## First Wedge

The first concrete use case is agent-assisted development workflow enforcement through Kagents:

```text
plan -> implement -> verify -> repo readiness -> publish -> release decision
```

For repo readiness, Flow may use Veritas as an evidence provider. Flow records the Veritas readiness artifact as gate evidence; it does not reinterpret repo standards.

## Repository Layout

- `CONTEXT.md` - product glossary and boundary language.
- `docs/product-vision.md` - north star, product-line fit, and success criteria.
- `docs/market-positioning.md` - competitive landscape, non-goals, and differentiation.
- `docs/product-boundaries.md` - how Flow relates to Surface, Veritas, and Kagents.
- `docs/adr/` - architecture and product decisions.
- `schemas/` - initial JSON Schema sketches for Flow definitions, runs, and reports.
- `examples/` - small example Flow definitions.

## Status

This repo is an early product boundary and schema sketch. It exists to keep process transparency focused instead of folding it into Kagents or duplicating Veritas.
