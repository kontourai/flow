# ADR 0004: Flow Console Owns Review Queues And Run Control

Date: 2026-05-31

## Status

Accepted

## Context

Campfit is proving a reusable review surface: producers collect sources, propose field changes, reviewers inspect evidence and excerpts, approve or reject proposed values, and the product records field-level provenance and verification status.

That shape is broader than Campfit, but it crosses several Kontour products:

- Surface owns claim trust state, evidence, freshness, gaps, and current claim status.
- Survey owns producer-side fact-review records such as sources, observations, extractions, candidates, review records, and claim publication.
- Flow owns process paths, gates, transitions, evidence, exceptions, continuation, and run control.
- Flow Agents owns agent-facing distribution, runtime adapters, skills, hooks, and agent-specific console extensions.

If Survey owns the whole review queue and workflow console, Survey becomes the generic workflow authority instead of the fact-review record layer. If Flow Agents owns it, generic Flow control becomes tied to agent runtimes. If every product owns its own review console, the same queue, pause/resume, proof, and decision-history concepts will be duplicated.

## Decision

Flow owns the generic Flow Console contract for process visibility and management.

Flow Console includes:

- Flow Run visibility
- Run Control API surfaces
- Review Queues
- Review Items
- gate and evidence panels
- decision history
- exceptions
- route-back state
- pause, resume, progress, and transition controls
- next actions

Survey supplies fact-review record shapes and can provide Survey-specific Flow Definitions, Review Item payloads, and Flow Product Extensions for `ingest -> curate -> verify -> publish` processes.

Products supply Flow Product Extensions for labels, field renderers, queue grouping, suggested actions, proof panels, and branding. Campfit should be treated as the reference vertical app for this pattern. Flow Agents should be treated as an implementation and consumer on top of Flow, with agent-specific adapters and console views rather than ownership of the generic console contract.

Surface remains the place to inspect current claim status without starting from a run. Flow Runs and Review Items may explain how that status was reached or what process is actively changing it, but Surface owns claim/trust state.

Flow Console should mirror Surface Console architecturally:

- local-first shell over projection/read-model files
- stable product-owned projection contract
- extension registry for labels, renderers, queue grouping, suggested actions, and branding
- extension hints used by the console, not by core semantic derivation
- portable enough for a future Kontour Console to bridge Surface claim state and Flow process state

Kontour Console should be treated as the suite-level management and visibility product, not merely a shared shell or accidental later integration. The Kontour primitives should remain portable and useful on their own, while Kontour Console sells the comprehensive operating layer that correlates claim status, process status, proof, queues, decisions, freshness, exceptions, and next actions across products.

The early shared abstraction should be contracts and composition model: projection boundaries, identity links, queue and action vocabulary, route conventions, refresh semantics, and extension metadata. A shared console UI package should wait until Surface Console and Flow Console prove which components and shell behavior are actually common.

The first implementation focus should be Flow-owned, with Campfit as the reference extension sourced from the Campfit repo. A throwaway prototype is not required unless the Flow/Campfit boundary becomes unclear during implementation.

## Consequences

Positive:

- Flow keeps authority over generic process management while remaining runtime-agnostic.
- Survey stays focused on fact-review contracts instead of becoming a workflow platform.
- Flow Agents can expose agent work, decisions, proof, and pause/resume controls without forking Flow semantics.
- Vertical products can get a reusable console layer while still feeling native through extensions.
- Campfit can guide the first concrete console experience without becoming the generic contract.
- Surface Console and Flow Console can converge on a common console architecture before a unified Kontour Console exists.
- The eventual Kontour Console has stable integration points from the start instead of requiring a retrofit across products.
- Kontour Console can become the suite-level product without making the underlying primitives proprietary or hosted-only.

Trade-offs:

- Flow now has a product-surface boundary in addition to its core library and CLI boundary.
- Flow must define stable Review Queue, Review Item, Run Control API, and extension contracts.
- v0.1 remains file-backed and does not ship a hosted web UI, so early docs must distinguish product direction from current package scope.
- Console alignment introduces a shared architecture constraint across Surface and Flow that both products need to preserve as they evolve.
- Waiting to extract a shared UI package means some implementation duplication may be tolerated temporarily to protect product boundaries.

## Alternatives Considered

### Put Review Queues In Survey

Rejected because Survey owns fact-review records, not generic process authority. Survey should be able to plug into Flow-managed queues without becoming the Flow Console.

### Put The Console In Flow Agents

Rejected because agent workflows are only one consumer. Flow Agents should adapt Flow control to agent runtimes and provide agent-specific views, but generic run control and review queues belong to Flow.

### Let Each Product Build Its Own Console

Rejected because it duplicates pause/resume, gate inspection, proof review, decision history, route-back, and queue concepts across products.
