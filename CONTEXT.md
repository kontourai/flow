# Kontour Flow

Flow is the product context for process transparency and gate enforcement. This glossary defines the language humans and agents should share when discussing how a process follows a required path and earns permission to advance.

## Language

**Flow**:
A process transparency and gate enforcement product for work that must follow an inspectable path. Flow shows which steps ran, which gates passed or blocked, what evidence supported transitions, and what should happen next. Flow is a foundational primitive other Kontour products build on.
_Avoid_: Agent orchestrator, task board, repo standards engine, generic workflow app

**Process Transparency**:
The Flow promise that a user or agent can inspect what path was required, what actually happened, what evidence was collected, and why the process advanced, stopped, or needs a decision.
_Avoid_: Automation only, task tracking only, hidden workflow state

**Flow Definition**:
The authored description of a process path: its steps, gates, transition rules, evidence expectations, exception rules, and terminal outcomes.
_Avoid_: Runtime script, checklist, agent prompt

**Flow Run**:
One execution of a Flow Definition for a concrete piece of work. A Flow Run records current step, transition history, gate outcomes, evidence references, exceptions, and next action.
_Avoid_: Chat session, task board card, repo change

**Run Recovery Fence**:
A stable, provider-neutral record at a Flow Run's fixed canonical path that
closes supported reads and mutations while an external recovery coordinator
repairs that run. Flow validates the fence protocol and state but does not own
the recovery transaction, backup policy, or coordinator authorization. The
generic writer only closes; the exact-generation finalizer is the sole reopen
path and publishes while holding Flow's native mutation ticket.
_Avoid_: Recovery journal, provider lock, replacement runtime root

**Step**:
A named process stage that performs or waits for work, such as plan, implement, verify, publish, or prepare. A step does not prove completion by itself; gates and evidence decide advancement.
_Avoid_: Requirement, task as the only meaning, repo work area

**Gate**:
A decision point that determines whether a Flow Run may advance, stop, ask for a decision, or route back. Gates evaluate required evidence, missing evidence, exceptions, and transition rules.
_Avoid_: Veritas requirement, generic approval, hidden prompt instruction

**Gate Expectation**:
A typed entry in a gate's `expects` array. A gate expectation states what evidence or claim must be present for the gate to pass, whether it is required, and how a human or agent should explore the missing evidence.
_Avoid_: Unstructured checklist item, hidden prompt instruction, provider-specific rule

**Trust Bundle Expectation**:
A gate expectation with `kind: "trust.bundle"` for rich evidence backed by a trust bundle. It names an expectation `id`, `required`, `description`, `bundle_claim.type`, optional `bundle_claim.subject`, optional `bundle_claim.accepted_statuses`, and optional `explore_hint`.
_Avoid_: Provider-specific evidence kind, hardcoded adapter behavior

**Claim Subject**:
An open vocabulary string that scopes what a claim is about. Common Flow and kit examples include `flow-run`, `flow-step`, `work-item`, `change`, `pull-request`, `release`, `decision`, and `artifact`, but Flow schema should allow other project-specific subject strings.
_Avoid_: Closed enum unless a specific kit owns a narrower vocabulary

**Project Config**:
The Flow-owned project configuration that records trusted producer mappings and gate overrides for a project. Consumers may write or adapt this config, but Flow treats the project config as the authority source of truth during gate evaluation.
_Avoid_: Flow Agents authority, adapter-owned policy, duplicated producer trust rules

**Transition**:
The movement from one step to another, including the reason it was allowed, blocked, skipped, or accepted by exception.
_Avoid_: Implicit next step, uncontrolled agent continuation

**Run Lifecycle Transition**:
A recorded change to whether a Flow Run is active, paused, or terminal without moving its current step. Pause, resume, and cancellation are lifecycle transitions; they never satisfy a Gate, count as Step passage, or create an alternate path through the Flow Definition.
Lifecycle cancellation requires a structured external `user_request` or `operator_request`; Flow persists and validates that provider-neutral authority but does not authenticate it. Consumer products own authentication and any assignment release, provider update, archive, or cleanup that follows.
_Avoid_: Step Transition, skipped step, implicit abandonment, consumer-only status override

**Retry Authorization**:
A provider-neutral, authority-bearing `retry_authorized` run transition that starts one additional bounded retry epoch for the current exhausted route-back block. It binds an authenticated external request to the exact current run head and exhausted transition, returns only to that transition's declared selected route, preserves the exhausted decision in audit history while removing it from the current gate projection, and reports the new epoch's evolving current budget. The runtime serializes the mutation with unique owner tickets and derives its re-entry timestamp. It is not lifecycle resume, an exception, cancellation, restart, or a Gate pass; consumer products authenticate the authority.
_Avoid_: Arbitrary recovery target, retry-limit override, provider policy, hidden reset

**Retry Epoch**:
The persisted attempt-accounting scope for one exact route-back loop. Legacy route-back records without `retry_epoch` are epoch 1. A retry authorization records the next epoch, and only matching route-backs in that epoch consume its declared budget.
_Avoid_: Lifetime retry reset, deleting failures, in-memory counter

**Definition Amendment**:
An explicit, authority-bearing replacement of the effective Flow Definition for
one active Flow Run. It keeps the immutable start snapshot, subject, evidence,
and history; the complete normalized successor and audit event are appended only
to canonical `state.json` after strict history compatibility is proven.
_Avoid_: Editing definition.json, replacement run, automatic migration, patch-only audit

**Effective Definition Identity**:
The `{id, version, digest}` identity of the definition that currently governs a
run. The digest is SHA-256 over normalized canonical JSON. Consumers bind a
capability to this identity and must reject it after a compatible amendment.
_Avoid_: Version-only freshness, silent legacy backfill, provider envelope

**Route Back**:
A gate outcome that sends a Flow Run from the gate's step back to a selected step after failed or missing evidence. Route back is a Flow core transition primitive, not a Builder Kit policy.
_Avoid_: Hidden retry, agent-specific recovery prompt, Builder Kit-only behavior

**Route Reason**:
An open string id attached to failed gate evidence or inferred by Flow for missing required evidence. Recommended standard ids are `missing_evidence`, `implementation_defect`, `plan_gap`, and `decision_gap`; projects may define custom ids without changing Flow core.
_Avoid_: Closed enum, model-only diagnosis, unrecorded explanation

**Route-Back Transition**:
A persisted transition with route-back metadata: gate id, route reason, source step, selected target step, final route target, attempt, retry epoch, max attempts, exceeded state, evidence refs, expectation ids, and optional classifier, diagnostics, and analytics. Attempt counts are derived from persisted route-back transitions with the same gate id, reason, source step, selected target step, and retry epoch.
_Avoid_: Timestamp-based retry count, in-memory loop counter, chat-memory continuation

**Route-Back Policy**:
The gate-level loop protection settings `max_attempts` and `on_exceeded`. `on_exceeded` may name a recovery step or use `block` to stop at the current step with the exceeded condition recorded.
_Avoid_: Silent infinite loop, uninspectable retry limit, adapter-owned retry semantics inside Flow core

**Gate Evidence**:
Evidence attached to a gate outcome. Gate evidence may include tests, CI, review findings, Veritas readiness reports, human attestations, provider health checks, source pointers, or Surface trust snapshots.
_Avoid_: Agent confidence, summary without trace, Veritas evidence check as the generic term

**Exception**:
A recorded decision to advance or finish despite missing, stale, failing, or unavailable gate evidence. Exceptions should identify who or what had authority to accept the gap and why.
_Avoid_: Silent bypass, skipped gate, waiver without trace

**Flow Report**:
The human- and agent-facing report for a Flow Run. A Flow Report explains current step, gate outcomes, evidence, exceptions, blocked transitions, and next action.
_Avoid_: Surface trust report, Veritas readiness report, raw log dump

**Continuation**:
The ability to resume a Flow Run from recorded state rather than chat memory. Continuation should use current step, next action, open gates, evidence state, and exceptions.
_Avoid_: Agent memory only, best-effort prompt recall

**Built with Surface**:
The product signal that Flow projects process claims and evidence into Surface trust state. Flow users should not need to configure Surface directly for normal Flow usage.
_Avoid_: Surface as a required user-facing setup step

**Veritas Evidence Provider**:
The optional use of Veritas to supply repo readiness evidence for a Flow gate. Veritas owns repo standards and merge readiness; Flow records the Veritas readiness artifact as gate evidence.
_Avoid_: Flow-owned repo standards, duplicating Veritas requirements

**Flow Agents Consumer**:
The first expected consumer of Flow. Flow Agents coordinates kits, runtime adapters, installs, control surfaces, skills, hooks, provider settings, and Console views. It can author, adapt, and install Flow project config, but it is not the authority source of truth for gate expectations, trusted producers, or project overrides.
_Avoid_: Flow owning agent harness support directly

**Flow Core Neutrality**:
Flow core provides route-back mechanics, validation, persistence, reports, and CLI metadata capture. It does not encode Builder Kit-specific reason policy, recovery strategy, provider behavior, or agent orchestration semantics.
_Avoid_: Hardcoded kit policy, provider-specific route classifiers in Flow core, closed reason vocabulary

**Kit**:
The SEAM where Flow and Flow Agents meet: Flow owns the container (manifest + flows), Flow Agents owns the extension (skills, adapters, docs, activation). The dividing test is whether an operation must INTERPRET the agent extension or only the container: container-only kit operations (`validate`, `install`, `inspect`'s structural view) are agent-blind and live in Flow; extension-interpreting operations (`activate`, and the extension-aware parts of install/inspect) live in Flow Agents, which composes on Flow's primitives rather than reimplementing them.
_Avoid_: Flow interpreting skill or adapter semantics, Flow Agents reimplementing the container contract

## Flagged Ambiguities

**Requirement**:
Do not use requirement as the primary Flow term. Veritas owns Requirement as the unit of repo standards. Flow should use Gate, Gate Evidence, and Transition Rules.

**Readiness**:
Use readiness carefully. Veritas owns Merge Readiness for repo changes. Flow may describe gate readiness or process readiness only when the scope is explicit.

**Workflow**:
Workflow is acceptable in general prose, but Flow product language should prefer Flow Definition and Flow Run when precision matters.

**Runtime**:
Flow core should be agent- and runtime-agnostic. Runtime projection belongs in consumers such as Flow Agents unless a future Flow adapter package is deliberately created.

## Example Dialogue

Developer: "The agent says the feature is done."

Domain expert: "Check the Flow Report. Did it pass the verify gate, and what evidence allowed it to move to publish?"

Developer: "The verify gate passed local tests, but repo readiness is blocked."

Domain expert: "That means Flow should keep the run blocked or route back. Veritas owns why repo readiness failed."
