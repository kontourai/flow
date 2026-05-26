# ADR 0002: Gate Expectations And Project Authority

Date: 2026-05-26

## Status

Accepted

## Context

Flow gates need to express more than unstructured evidence kinds. A gate may need a rich claim about a Flow run, step, work item, change, pull request, release, decision, or artifact. That claim may need to come from a trusted producer and may need a project-specific override for whether it is required or which statuses are accepted.

Flow Agents can package and install useful kits and adapters, but Flow must stay runtime-neutral. If trusted producer mappings or gate overrides live primarily in Flow Agents, the authority for a Flow Run becomes adapter-specific and can diverge from the Flow project.

## Decision

Flow gates use typed `expects` entries for gate expectations. A rich claim-backed expectation uses `kind: "surface.claim"` exactly.

A `surface.claim` expectation has:

- `id`
- `kind: "surface.claim"`
- `required`
- `claim.type`
- optional `claim.subject`
- optional `claim.accepted_statuses`
- `description`
- optional `explore_hint`

`claim.subject` remains open. Flow documentation and kits may use examples such as `flow-run`, `flow-step`, `work-item`, `change`, `pull-request`, `release`, `decision`, and `artifact`, but Flow should not close the schema around that list.

Flow project config owns trusted producer mappings and gate overrides. Flow Agents may author, adapt, install, or update that config when coordinating Flow Kits and runtime adapters, but Flow project config is the authority source of truth used during gate evaluation.

## Consequences

Positive:

- Flow Definitions can state clear gate expectations without hardcoding a runtime.
- Flow Reports can identify missing or unsatisfied expectation ids, not just missing evidence kinds.
- Projects can change trusted producers and gate overrides without changing Flow Agents.
- Flow Agents can coordinate Builder Kit behavior as a normal Flow Kit instead of special core behavior.

Trade-offs:

- Flow must document both simple evidence kinds and typed expectations during the transition.
- Kits need to be clear about subject vocabulary without treating examples as a closed enum.
- Adapter-generated config must be easy to inspect because project config is authoritative.

## Alternatives Considered

### Keep Gates As Evidence Kind Lists

Rejected because simple evidence-kind lists cannot express claim type, subject, accepted statuses, trusted producers, or expectation ids clearly enough for rich gate evaluation.

### Put Trusted Producer Authority In Flow Agents

Rejected because Flow Agents coordinates kits and runtime adapters. It should not own the project authority model that Flow uses to decide whether a gate passes.

### Close Claim Subjects To A Fixed Enum

Rejected because Flow needs to support future kits and project-specific process domains. Subject examples should guide kit authors without constraining the core schema.
