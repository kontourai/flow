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

Flow Agents
  Agent-facing workflow distribution built with Flow.
  Modes, skills, runtime adapters, provider settings, hooks, Console.
```

## Surface Boundary

Surface owns the portable trust model. Flow can project process state into Surface claims, evidence, policies, and trust snapshots, but Surface does not decide what a process step or gate means.

Normal Flow users should not need to configure Surface directly.

Flow gates use `expects` entries to describe evidence expectations. When a gate needs rich claim-backed evidence, Flow uses `kind: "surface.claim"` and evaluates claim type, optional subject, accepted statuses, and the trusted producer mappings from Flow project config.

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

## Flow Agents Boundary

Flow Agents owns the agent-facing distribution:

- Work modes
- Skills
- Runtime adapters
- Native harness hooks
- Provider settings
- Project/global setup
- Console views
- Useful Flow Kits

Flow core should remain agent-agnostic. Flow Agents is responsible for projecting Flow semantics into Codex, Claude Code, Kiro CLI, Pi, Droid, Hermes, MCO, GitHub Actions, or future agent harnesses.

Flow Agents may author, adapt, install, or update Flow project config while coordinating kits and runtime adapters. It must not become the authority source of truth for trusted producer mappings, gate overrides, or what a Flow gate means. That authority stays in Flow Definitions and Flow project config.

Builder behavior should be distributed as a normal Flow Kit coordinated by Flow Agents, not as special behavior inside Flow core.

## Non-Goals

Flow should not become:

- an agent runtime
- a multi-agent orchestrator
- a task board
- a repo standards engine
- a CRM/work management product
- a replacement for Surface or Veritas

Flow should become the small process transparency kernel those products can use when work must follow a required path.

## v0.1 Contract

Flow v0.1 ships as `@kontourai/flow`, a local file-backed CLI and library. It owns `.flow/definitions/`, `.flow/runs/<run-id>/`, gate evaluation, evidence manifests, accepted exceptions, and Flow Reports.

The v0.1 package deliberately does not include distributed execution, hosted auth, Surface projection, agent runtime hooks, multi-agent dispatch, Veritas policy semantics, or a web UI.
