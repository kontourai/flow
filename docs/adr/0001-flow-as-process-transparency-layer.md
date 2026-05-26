# ADR 0001: Flow As Process Transparency Layer

Date: 2026-05-24

## Status

Accepted

## Context

Flow Agents needs portable workflow enforcement across agent harnesses. Veritas already provides repo and AI-agent governance for code changes, built with Surface. Surface already provides the foundation for claims, evidence, policies, trust snapshots, freshness, and transparency gaps.

If Flow Agents owns all workflow enforcement directly, it risks becoming an unfocused mix of agent distribution, process engine, governance system, dashboard, and orchestration platform. If Veritas owns all workflow enforcement, it risks expanding beyond repo/change governance into generic process semantics.

We need a focused layer for process transparency that can be used by agent products without duplicating Veritas or Surface.

## Decision

Create Kontour Flow as a standalone process transparency and gate enforcement layer built with Surface.

Flow owns:

- Flow Definitions
- Flow Runs
- Steps
- Gates
- Transitions
- Gate Evidence
- Exceptions
- Flow Reports
- Continuation state

Flow does not own:

- Surface trust semantics
- Veritas repo standards or merge readiness
- agent runtime execution
- multi-agent orchestration
- Flow Agents modes, skills, provider settings, or runtime adapters

Flow Agents will be the first consumer of Flow. It coordinates Flow Kits, runtime adapters, installs, and agent-facing control surfaces. Veritas may be used as an optional evidence provider for Flow gates that involve repo readiness.

## Consequences

Positive:

- Flow Agents can stay focused on agent-facing workflows and runtime portability.
- Veritas stays focused on repo/change governance.
- Flow can support non-development processes without importing Veritas concepts.
- Surface remains the shared transparency foundation.
- Agent harness support can live in Flow Agents instead of Flow core.

Trade-offs:

- There is one more product boundary to explain.
- Early Flow schemas must avoid duplicating Veritas requirements or Surface policies.
- Flow Agents will need an adapter layer from existing workflow sidecars to Flow runs.

## Alternatives Considered

### Keep Flow Inside Flow Agents

Rejected because workflow enforcement is useful beyond Flow Agents and would make Flow Agents responsible for both agent distribution and the generic enforcement kernel.

### Put Generic Workflow Enforcement Inside Veritas

Rejected because Veritas has a clear repo/change governance wedge. Expanding it into generic process flow would dilute Merge Readiness, Repo Standards, and Requirements.

### Use Surface Directly

Rejected because Surface models trust state, not process-specific semantics such as steps, gates, transitions, and continuation.
