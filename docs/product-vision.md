# Product Vision

Flow is Kontour AI's process transparency product.

It exists because AI systems make work move faster than humans can inspect. Agents can plan, edit, summarize, call tools, request approvals, and declare work complete. What is often missing is a durable explanation of the required path and the evidence that allowed the system to move forward.

Flow gives products and agents a shared way to answer:

> Did this work follow the required path, and what evidence proves each transition?

## North Star

Flow should become the lightweight trust layer for required process paths.

It should make important work inspectable without forcing teams to adopt a heavyweight workflow engine. It should work inside existing tools, runtimes, and automation systems by recording the process contract and the evidence behind each transition.

## Why Now

AI changes the failure mode of workflows.

Traditional software usually fails by throwing errors, missing states, or breaking tests. Agentic software can fail more quietly:

- it skips a planning step
- it forgets acceptance criteria deep in context
- it calls a risky tool before review
- it accepts weak evidence as proof
- it summarizes success after partial verification
- it loses workflow state after compaction or handoff
- it treats human approval as a checkbox without enough context
- it cannot explain why a later step was allowed

Flow exists to make those failures visible and actionable.

## Core Belief

Trustworthy autonomy requires visible gates.

Agents should be allowed to move quickly when evidence is strong. They should be blocked, routed back, or asked for a decision when evidence is missing. They should be allowed to proceed by exception only when the exception is explicit and inspectable.

## Product Line Fit

Kontour AI builds transparency building blocks for the AI era.

```text
Surface
  Product transparency foundation.
  Claims, evidence, policies, trust snapshots, gaps.

Flow
  Process transparency.
  Steps, gates, transitions, runs, exceptions, reports.

Veritas
  Code/change transparency.
  Repo standards, requirements, evidence checks, merge readiness.

Kagents
  Agent-facing workflow distribution.
  Modes, skills, runtime adapters, hooks, providers, console.
```

Flow is built with Surface. Normal Flow users should not need to operate Surface directly.

Veritas can provide evidence to Flow when a process gate needs repo/change readiness.

Kagents can consume Flow when agent work needs stateful gates across Codex, Claude Code, Kiro, GitHub Actions, Hermes, Pi, Droid, and future runtimes.

## What Flow Makes Possible

### Required-path proof

Flow records what path was expected and what path actually happened. A report should make skipped steps, blocked gates, and accepted exceptions obvious.

### Evidence-gated transitions

A step does not complete just because an agent says it is done. Gates decide whether a transition is allowed, and gates require evidence.

### Context-safe continuation

A Flow Run should survive context loss. Another agent or session can inspect the run and know the current step, next action, open gates, accepted exceptions, and evidence state.

### Inspectable human decisions

Human approval should include what was being approved, why approval was needed, what evidence was available, what authority was used, and what gap remains.

### Runtime-native enforcement

Flow should not require a wrapper chat interface. Consumers can enforce Flow gates through hooks, CI jobs, workflow steps, MCP tools, CLIs, or embedded SDK calls.

### Portable reporting

A Flow Report should be useful to a person, an agent, a CI job, a console, or another product. The same run should be explainable in Markdown and machine-readable JSON.

## Differentiation

Flow is not trying to be the place where all work runs.

Flow is the place where required transitions become trustworthy.

The difference matters:

- A workflow engine runs the process.
- An observability system records what happened.
- A policy engine evaluates a rule.
- An approval tool asks a human.
- Flow explains why the process was allowed to advance.

## v0.1 Product Shape

The first publishable version is a local npm package:

- JSON Schema for Flow Definitions, Flow Runs, and Flow Reports
- a local file-backed run store
- a small gate evaluator
- CLI commands for init, start, status, attach-evidence, evaluate, accept-exception, report, resume, and list
- documented evidence kinds for command results, files, CI, Veritas readiness, human decisions, and trace links
- Markdown and JSON Flow Reports
- continuation from `.flow/runs/<run-id>/` without chat memory

Runtime hooks, hosted services, multi-agent dispatch, web UI, and Surface projection are intentionally outside v0.1.

## Success Criteria

Flow is working when:

- users can see why work advanced or stopped
- agents cannot silently skip required gates
- missing verification appears as a blocked gate, not a confident summary
- exceptions are visible and attributable
- workflow state survives handoff and context compaction
- evidence can be inspected after the fact
- consumers can integrate Flow without replacing their execution runtime
- Surface, Veritas, and Kagents each remain focused

## One-Sentence Positioning

Flow keeps AI and automation on the required path by making every important transition evidence-backed, inspectable, and resumable.
