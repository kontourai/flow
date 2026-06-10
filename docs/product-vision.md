# Product Vision

Flow is Kontour AI's process transparency product. It exists because AI systems make work move faster than humans can inspect: agents plan, edit, summarize, call tools, request approvals, and declare work complete. What is missing is a durable explanation of the required path and the evidence that allowed the system to move forward.

Flow gives products and agents a shared way to answer one question:

> Did this work follow the required path, and what evidence proves each transition?

## North star

Flow should become the lightweight trust layer for required process paths — making important work inspectable without forcing teams to adopt a heavyweight workflow engine. It works inside existing tools, runtimes, and automation by recording the process contract and the evidence behind each transition.

## Why now

AI changes the failure mode of workflows. Traditional software fails loudly: errors, missing states, broken tests. Agentic software fails quietly:

- it skips a planning step
- it forgets acceptance criteria deep in context
- it calls a risky tool before review
- it accepts weak evidence as proof
- it summarizes success after partial verification
- it loses workflow state after compaction or handoff
- it treats human approval as a checkbox without context
- it cannot explain why a later step was allowed

Flow exists to make those failures visible and actionable.

## Core belief

Trustworthy autonomy requires visible gates. Agents should move quickly when evidence is strong, be blocked or routed back when evidence is missing, and proceed by exception only when the exception is explicit and inspectable.

## Differentiation

Flow is in a crowded space and is deliberately not competing with most of it:

- A workflow engine **runs** the process.
- An observability system **records** what happened.
- A policy engine **evaluates** a rule.
- An approval tool **asks** a human.
- Flow **explains why the process was allowed to advance.**

The uniqueness is not any single ingredient — it is the contract: *a workflow may advance only when the gate has inspectable evidence or an explicit exception.* A trace says what happened; Flow says whether what happened was enough to satisfy the required gate. An approval without inspectable context is weak evidence; Flow attaches the reason, evidence, authority, and remaining gap around the approval.

Flow should feel smaller than BPM, more durable than a checklist, more actionable than a trace, more contextual than an approval button, more portable than a harness-specific hook, and more inspectable than an agent's final summary.

## What Flow makes possible

- **Required-path proof.** Flow records what path was expected and what actually happened. Skipped steps, blocked gates, and accepted exceptions are obvious in every report.
- **Evidence-gated transitions.** A step does not complete because an agent says so. Gates decide, and gates require typed evidence — explicit enough to survive handoff.
- **Context-safe continuation.** A Flow Run survives context loss. Another agent or session can inspect the run and know the current step, next action, open gates, exceptions, and evidence state.
- **Inspectable human decisions.** Approval includes what was approved, why approval was needed, what evidence existed, what authority was used, and what gap remains.
- **Runtime-native enforcement.** Flow requires no wrapper chat interface. Consumers enforce gates through hooks, CI jobs, workflow steps, MCP tools, CLIs, or embedded SDK calls.
- **Portable reporting.** The same run is explainable in Markdown for humans and JSON for agents, CI, and consoles.

## Product line fit

Kontour AI shows the work behind AI:

```text
Surface       Product transparency foundation.
              Claims, evidence, policies, trust snapshots, gaps.

Flow          Process transparency.
              Steps, gates, transitions, runs, exceptions, reports.

Veritas       Code/change transparency.
              Repo standards, requirements, evidence checks, merge readiness.

Flow Agents   Agent-facing workflow distribution.
              Modes, skills, runtime adapters, hooks, providers, console.
```

Each product stands alone, and they cohere: Flow is built with [Surface](https://kontourai.io/surface), but normal Flow users never operate Surface directly. [Veritas](https://kontourai.io/veritas) can supply repo-readiness evidence when a process gate needs it. [Flow Agents](https://kontourai.io/flow-agents) consumes Flow when agent work needs stateful gates across Codex, Claude Code, Kiro, GitHub Actions, and future runtimes.

## Boundaries

Flow owns the provider-neutral process kernel:

- Flow Definitions, Flow Runs, steps, gates, transition rules
- gate evidence, accepted exceptions, continuation state
- Flow Reports and the local console projection
- project config merge semantics

Flow deliberately does not own — and must not grow into:

- an agent runtime or multi-agent orchestrator
- distributed execution or worker scheduling
- a task board or CRM/work-management product
- repo standards or merge readiness (Veritas)
- portable trust semantics (Surface)
- agent-facing distribution, kits, adapters, hooks (Flow Agents)
- generic policy languages or full observability storage

The boundary rules that affect runtime behavior:

- **Surface** owns the portable trust model. Flow consumes Surface-shaped trust artifacts as gate evidence, but Surface does not decide what a process step or gate means, and Flow does not import Surface services at runtime.
- **Veritas** owns repo-local development governance. Flow may record Veritas readiness as gate evidence; it must not duplicate Veritas policy semantics into Flow definitions.
- **Flow Agents** owns the agent-facing distribution and may author, adapt, or install Flow project config — but the authority source of truth for trusted producers, gate overrides, and gate meaning stays in Flow Definitions and `.flow/config.json`. Builder behavior is distributed as a normal Flow Kit, never as special behavior inside Flow core.

## First wedge

Agentic development workflows: plan, implementation, verification, publish, release, and learning gates with evidence that survives handoff and context compaction. A user asks an agent to build something; Flow records the gates; Veritas supplies repo evidence where relevant; runtime hooks prevent premature advancement; a Flow Report explains what happened, what passed, what is blocked, and what should happen next. Narrow enough to build, broad enough to demonstrate the generic product. The broader scenarios this unlocks are in [Use Cases](use-cases.md).

## v0.1 product shape

The first publishable version is a local npm package:

- JSON Schemas for Flow Definitions, Flow Runs, gate evidence, reports, transition validation, release readiness, and version release reports
- a local file-backed run store and a small gate evaluator
- the `flow` CLI: init, validate, start, status, attach-evidence, evaluate, accept-exception, config, report, resume, list, console
- typed gate expectations (`expects`, including `surface.claim`) and documented evidence kinds
- project config for trusted producer mappings and gate overrides
- Markdown and JSON Flow Reports; continuation from `.flow/runs/<run-id>/` without chat memory
- a loopback-only local Flow Console

Runtime hooks, hosted services, multi-agent dispatch, hosted web UI, and Surface projection are intentionally outside v0.1.

## Success criteria

Flow is working when:

- users can see why work advanced or stopped
- agents cannot silently skip required gates
- missing verification appears as a blocked gate, not a confident summary
- exceptions are visible and attributable
- workflow state survives handoff and context compaction
- evidence can be inspected after the fact
- consumers integrate Flow without replacing their execution runtime
- Surface, Veritas, and Flow Agents each remain focused

## One-sentence positioning

Flow keeps AI and automation on the required path by making every important transition evidence-backed, inspectable, and resumable.
