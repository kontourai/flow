# Kontour Flow

Flow is the product context for process transparency and gate enforcement. This glossary defines the language humans and agents should share when discussing how a process follows a required path and earns permission to advance.

## Language

**Flow**:
A process transparency and gate enforcement product for work that must follow an inspectable path. Flow shows which steps ran, which gates passed or blocked, what evidence supported transitions, and what should happen next.
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

**Step**:
A named process stage that performs or waits for work, such as plan, implement, verify, publish, or prepare. A step does not prove completion by itself; gates and evidence decide advancement.
_Avoid_: Requirement, task as the only meaning, repo work area

**Gate**:
A decision point that determines whether a Flow Run may advance, stop, ask for a decision, or route back. Gates evaluate required evidence, missing evidence, exceptions, and transition rules.
_Avoid_: Veritas requirement, generic approval, hidden prompt instruction

**Gate Expectation**:
A typed entry in a gate's `expects` array. A gate expectation states what evidence or claim must be present for the gate to pass, whether it is required, and how a human or agent should explore the missing evidence.
_Avoid_: Unstructured checklist item, hidden prompt instruction, provider-specific rule

**Surface Claim Expectation**:
A gate expectation with `kind: "surface.claim"` for rich evidence backed by a Surface claim. It names an expectation `id`, `required`, `description`, `claim.type`, optional `claim.subject`, optional `claim.accepted_statuses`, and optional `explore_hint`.
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
