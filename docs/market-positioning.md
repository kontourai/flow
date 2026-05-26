# Market Positioning

Flow exists in a crowded market. That is useful pressure: it keeps the product focused.

The opportunity is not to build another workflow engine, agent framework, approval app, observability dashboard, or policy system. The opportunity is to make required agentic work inspectable by showing the path that was expected, the path that actually happened, the evidence that allowed each gate to advance, and the exceptions that need human trust.

## Category

Flow should define and defend the category of **agentic process transparency**.

In plain language:

> Flow proves why work was allowed to move forward.

Flow should be used when the important question is not only "what happened?" but:

- What process path was required?
- Which step is active?
- Which gate controls the next transition?
- What evidence does that gate expect?
- What evidence was actually collected?
- Is the evidence fresh, sufficient, and linked?
- Why was the transition allowed, blocked, routed back, or accepted by exception?
- Can another agent, runtime, reviewer, or automation resume from the recorded state?

## Existing Ecosystem

### Workflow and BPM engines

Products such as Camunda already own enterprise process orchestration: BPMN/DMN modeling, process execution, human tasks, operations, analytics, and high-scale runtime concerns.

Flow should not compete with BPMN engines. Flow should stay smaller and make process evidence portable across agent and automation runtimes.

### Durable execution systems

Products such as Temporal, Dapr Workflow, Inngest, and Trigger.dev own resilient long-running execution, retries, workers, event histories, and distributed runtime mechanics.

Flow should not own worker execution or retry semantics. A Flow Run can reference a durable execution run as evidence, or a durable workflow can call Flow before transitions that require evidence-backed gates.

### Agent graph frameworks

Products such as LangGraph, CrewAI, Microsoft Agent Framework, OpenAI Agents SDK, and similar frameworks own graph execution, agent loops, tool calls, interrupts, state, memory, and application-specific orchestration.

Flow should not become an agent graph DSL. Flow should describe required process state and gate evidence that can be enforced from those frameworks when trust matters.

### Human approval products

Human-in-the-loop products and automation platforms already pause work for approval, route decisions to humans, and resume after approve or deny.

Flow should treat approval as one possible evidence type, not the product's whole purpose. An approval without inspectable context is weak evidence. Flow's role is to attach the reason, evidence, authority, and exception record around the approval.

### Observability and eval platforms

Products such as Phoenix, LangSmith, AgentOps, and OpenTelemetry-compatible systems capture traces, spans, model calls, tool calls, costs, latency, and eval outcomes.

Flow should integrate with observability rather than replace it. A trace says what happened. Flow says whether what happened was enough to satisfy the required gate.

### Policy engines

Products such as Open Policy Agent own general policy-as-code. Security and governance systems own authorization, compliance, and runtime policy decisions.

Flow should not invent a broad policy language early. It should keep transition rules small, typed, and evidence-oriented, and allow external policy systems to serve as gate evaluators.

### Provenance and attestations

Supply-chain systems such as SLSA and in-toto show how useful provenance becomes when evidence is structured, comparable, and tied to expectations.

Flow should borrow this shape. Gate evidence should be explicit enough for another system to inspect later, not just a narrative summary from an agent.

### Multi-agent dispatch

Tools such as MCO and Hive coordinate multiple coding agents and aggregate outputs.

Flow should not dispatch agents. It should give dispatchers a shared contract for what gate evidence must exist before work can advance.

## Unique Combination

Flow is strongest when it combines concepts that are usually split across separate systems:

| Concept | Existing home | Flow combination |
| --- | --- | --- |
| Process path | BPM/workflow tools | Lightweight Flow Definitions and Flow Runs |
| Durable state | Temporal-style systems | Continuation state without owning execution |
| Evidence | Surface, Veritas, CI, traces | Gate Evidence tied to process transitions |
| Human decisions | HITL/approval tools | Approvals with context, authority, and exception records |
| Observability | OTel/Phoenix/LangSmith | Trace links interpreted against gate expectations |
| Policy | OPA/security systems | External policy results as gate evidence |
| Agent hooks | Claude, Codex, Kiro, GitHub Actions | Runtime-native enforcement of Flow gates |
| Reports | Dashboards and logs | Flow Reports that explain current state and next action |

The uniqueness is not any single ingredient. The uniqueness is the contract:

> A workflow may advance only when the gate has inspectable evidence or an explicit exception.

## Product Promise

Flow should make agentic work trustworthy without requiring users to operate a heavyweight workflow platform.

The product promise:

> Keep AI and automation on the required path, and show the evidence behind every transition.

Flow should feel:

- Smaller than BPM.
- More durable than a checklist.
- More actionable than a trace.
- More contextual than an approval button.
- More portable than a harness-specific hook.
- More inspectable than an agent's final summary.

## Product Boundaries

Flow owns:

- Flow Definitions
- Flow Runs
- Steps
- Gates
- Transition rules
- Gate Evidence
- Exceptions
- Continuation state
- Flow Reports
- Surface projections of process trust state

Flow does not own:

- distributed execution
- worker scheduling
- agent runtime support
- multi-agent dispatch
- repo standards
- code merge readiness
- generic policy semantics
- full observability storage
- business process modeling suites
- task boards or CRM workflows

Consumers can own those concerns. Flow Agents is the first expected consumer for agent harnesses. Veritas is the first expected evidence provider for repo/change readiness.

## Competitive Angle

The best public angle is:

> Kontour AI shows the work behind AI.

Surface makes claims inspectable.
Flow makes process transitions inspectable.
Veritas makes AI-authored code changes inspectable.
Flow Agents uses those foundations to keep agents useful in the tools people already use.

This lets each product stand alone:

- Surface can be adopted by any product that needs claim/evidence transparency.
- Flow can be adopted by any product that needs evidence-gated process transparency.
- Veritas can be adopted by software teams that need repo-local merge confidence.
- Flow Agents can be adopted by users who want portable agent workflows across runtimes.

And it lets the product line cohere:

> Kontour AI builds the transparency layer for a world where AI systems act, decide, summarize, recommend, and ship faster than humans can manually inspect.

## Messaging Tests

Good Flow messaging should pass these tests:

- It does not sound like a BPMN replacement.
- It does not claim to run all work.
- It does not require users to know Surface.
- It explains why a trace alone is insufficient.
- It treats approval as evidence, not trust.
- It makes agent continuation a first-class use case.
- It makes exceptions visible instead of shameful or hidden.
- It makes "why did this advance?" the central question.

## Near-Term Wedge

The first wedge should be agentic development workflows:

1. A user asks an agent to build something.
2. Flow Agents routes the work into a Flow-backed path.
3. Flow records plan, implementation, verification, publish, release, and learning gates.
4. Veritas supplies repo readiness evidence where relevant.
5. Hooks in Codex, Claude Code, Kiro, or GitHub Actions prevent premature stopping or advancement.
6. A Flow Report explains what happened, what evidence passed, what is blocked, and what should happen next.

This is narrow enough to build and broad enough to demonstrate the generic product.

## Research References

These references shaped the positioning:

- Camunda 8: enterprise process orchestration with BPMN/DMN, human tasks, agentic process support, auditability, and operations views.
  https://docs.camunda.io/docs/components/concepts/concepts-overview/
- Temporal: durable execution, event history, resumable workflow executions, and runtime reliability.
  https://docs.temporal.io/temporal
- LangGraph human-in-the-loop: persisted interrupts and resume behavior for graph-based agents.
  https://docs.langchain.com/oss/python/langgraph/human-in-the-loop
- n8n human-in-the-loop tools: AI tool-call approval, pause, approve/deny, and alternate approval channels.
  https://docs.n8n.io/advanced-ai/human-in-the-loop-tools/
- OpenTelemetry GenAI agent spans: emerging observability conventions for agents, tools, and workflows.
  https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
- Arize Phoenix: open-source AI observability and evaluation.
  https://github.com/arize-ai/phoenix
- Open Policy Agent: general-purpose policy-as-code engine.
  https://www.openpolicyagent.org/docs
- SLSA: provenance levels and expectations for supply-chain trust.
  https://slsa.dev/spec/v1.0/levels
- MCO/Hive lineage: neutral multi-agent CLI orchestration for coding agents.
  https://github.com/mco-org/mco
- Claude Code hooks: runtime-native lifecycle and tool hook enforcement points.
  https://code.claude.com/docs/en/hooks
- Kiro CLI hooks: runtime-native agent lifecycle and tool hook enforcement points.
  https://kiro.dev/docs/cli/hooks/
- Codex GitHub Action: Codex execution in GitHub Actions with scoped privileges.
  https://github.com/openai/codex-action
