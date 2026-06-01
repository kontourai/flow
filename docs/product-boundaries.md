# Product Boundaries

Flow exists to keep process transparency focused.

## Product Stack

```text
Surface
  Product transparency foundation.
  Claims, evidence, policies, trust snapshots, freshness, gaps.

Flow
  Process transparency and gate enforcement built with Surface.
  Steps, gates, transitions, runs, exceptions, Flow Reports, Run Control API, Flow Console contracts.

Survey
  Fact-review record contracts built with Surface and Flow.
  Sources, observations, extractions, candidates, review records, claim publication.

Veritas
  Repo/change governance vertical built with Surface.
  Repo standards, requirements, evidence checks, merge readiness.

Flow Agents
  Agent-facing workflow distribution built with Flow.
  Modes, skills, runtime adapters, provider settings, hooks, agent-specific console extensions.

Kontour Console
  Suite-level management and visibility product built over the primitives.
  Cross-product claim status, process status, proof, queues, decisions, freshness, exceptions, and next actions.
```

## Surface Boundary

Surface owns the portable trust model. Flow can project process state into Surface claims, evidence, policies, and trust snapshots, but Surface does not decide what a process step or gate means.

Normal Flow users should not need to configure Surface directly.

Flow gates use `expects` entries to describe evidence expectations. When a gate needs rich claim-backed evidence, Flow uses `kind: "surface.claim"` and evaluates claim type, optional subject, accepted statuses, and the trusted producer mappings from Flow project config.

Flow may consume copied Surface TrustReport or Trust Snapshot JSON files as artifact-backed `surface.claim` evidence. The Flow-owned contract is neutral: `artifact_type`, `subject`, `producer`, `status`, `issued_at`, `expires_at`, `authority_traces`, `claims`, and local `integrity` metadata. Flow projects those fields into gate evaluation and reports diagnostics for stale, rejected, untrusted producer, authority gap, integrity mismatch, and subject mismatch cases.

Flow does not import Surface services at runtime for this local contract, and it does not make Veritas-specific field names part of the schema or runtime contract. A Veritas tool can produce a compatible Surface-shaped artifact, but Flow evaluates it as Surface evidence under the Flow Definition and `.flow/config.json`.

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

## Survey Boundary

Survey owns the producer-side fact-review record contract:

- Sources
- Observations
- Extractions
- Candidates
- Review records
- Claim publication into Surface

Survey may provide Flow Definitions, Review Item payloads, and Flow Product Extensions for managed `ingest -> curate -> verify -> publish` processes. Survey should not become the generic workflow authority, review queue manager, run-control surface, or hosted console. Those generic process-management contracts belong to Flow.

## Flow Console Boundary

Flow owns the generic Flow Console contract: run visibility, Run Control API, review queues, Review Items, gate/evidence panels, decisions, exceptions, route-back state, pause/resume/progress controls, and next actions.

Product-specific experiences should customize Flow Console through Flow Product Extensions. A vertical app can supply labels, field renderers, queue grouping, proof panels, suggested actions, and branding. Flow Agents can supply agent-runtime adapters and agent-specific views. Those extensions must not redefine Flow gate semantics, transition authority, route-back rules, or project config authority.

Flow Console should follow the same architectural pattern as Surface Console: a local-first shell over a product-owned projection/read model, schema-shaped extension points, domain vocabulary and branding as presentation inputs, and core semantics that remain independent from extension code. Surface Console and Flow Console should be interoperable enough that a future Kontour Console can bridge claim status, process status, proof, queues, and next actions without rewriting either product's core model.

The shared foundation for that future Kontour Console should be contracts first: projection shape, identity links, queue/action vocabulary, extension metadata, route conventions, and refresh semantics. A shared UI package should come after Surface Console and Flow Console prove which pieces are truly common.

The console boundary is product direction, not a claim that the v0.1 package already ships a hosted web UI.

## Kontour Console Boundary

Kontour Console is the suite-level product that brings the Kontour primitives together into one management plane. It is the comprehensive view operators and producers use to understand what is true, what is in progress, what is stale, what is blocked, what proof exists, what decisions were made, and what should happen next across products.

The primitives remain valuable without Kontour Console:

- Surface trust state remains portable, schema-first, and inspectable without a hosted service.
- Flow Runs and Flow Reports remain local, file-backed, and useful without a hosted service.
- Survey fact-review records remain producer-side contracts.
- Veritas readiness and evidence checks remain repo/change governance.
- Flow Agents runtime adapters and kits remain usable outside a suite-level console.

Kontour Console should sell the integrated operating experience, not become a hidden dependency required to use the primitives. It may host, aggregate, correlate, and manage cross-product state, but it must preserve each product's authority boundary.

## Non-Goals

Flow should not become:

- an agent runtime
- a multi-agent orchestrator
- a task board
- a repo standards engine
- a CRM/work management product
- a replacement for Surface or Veritas
- the full suite-level Kontour Console

Flow should become the small process transparency kernel those products can use when work must follow a required path.

## v0.1 Contract

Flow v0.1 ships as `@kontourai/flow`, a local file-backed CLI and library. It owns `.flow/definitions/`, `.flow/runs/<run-id>/`, gate evaluation, evidence manifests, accepted exceptions, and Flow Reports.

The v0.1 package deliberately does not include distributed execution, hosted auth, Surface projection, agent runtime hooks, multi-agent dispatch, Veritas policy semantics, or a hosted web UI.
