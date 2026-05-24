# Product Boundaries

Flow exists to keep process transparency focused.

## Product Stack

```text
Surface
  Product transparency foundation.
  Claims, evidence, policies, trust snapshots, freshness, gaps.

Flow
  Process transparency and gate enforcement built with Surface.
  Steps, gates, transitions, runs, exceptions, Flow Reports.

Veritas
  Repo/change governance vertical built with Surface.
  Repo standards, requirements, evidence checks, merge readiness.

Kagents
  Agent-facing workflow distribution built with Flow.
  Modes, skills, runtime adapters, provider settings, hooks, Console.
```

## Surface Boundary

Surface owns the portable trust model. Flow can project process state into Surface claims, evidence, policies, and trust snapshots, but Surface does not decide what a process step or gate means.

Normal Flow users should not need to configure Surface directly.

## Veritas Boundary

Veritas owns repo-local development governance:

- Repo Standards
- Repo Map
- Requirements
- Evidence Checks
- Verification Authorities
- Merge Readiness
- Change Guidance
- Standards Feedback

Flow can use Veritas as an evidence provider when a process gate needs repo readiness evidence. Flow must not duplicate Veritas policy semantics or copy Veritas requirements into Flow definitions.

## Kagents Boundary

Kagents owns the agent-facing distribution:

- Work modes
- Skills
- Runtime adapters
- Native harness hooks
- Provider settings
- Project/global setup
- Console views
- Useful Flow-backed workflow packs

Flow core should remain agent-agnostic. Kagents is responsible for projecting Flow semantics into Codex, Claude Code, Kiro CLI, Pi, Droid, Hermes, MCO, GitHub Actions, or future agent harnesses.

## Non-Goals

Flow should not become:

- an agent runtime
- a multi-agent orchestrator
- a task board
- a repo standards engine
- a CRM/work management product
- a replacement for Surface or Veritas

Flow should become the small process transparency kernel those products can use when work must follow a required path.
