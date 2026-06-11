# Gates & Route-Back

Gates are where Flow earns its keep: they decide whether a run advances, blocks, routes back, or waits — from recorded evidence, never from narrative. This guide covers the evaluation rules, transition legality, route-back policy, and the adversarial-review pattern built on them.

## Gate evaluation rules

For the current step, `flow evaluate` applies the v0.1 rules in order:

| Condition | Outcome |
| --- | --- |
| an accepted exception exists on the gate | `pass` |
| any attached gate evidence is marked failed | `route-back` |
| any required typed expectation is missing or unsatisfied | `block` |
| all required typed expectations are satisfied | `pass` |
| no authored expectations and no decision | `wait` |

When a gate passes, Flow advances to the step's `next` value. When a gate blocks, Flow keeps enough state for another process or agent to resume without chat memory — the blocked expectation, its `explore_hint`, and the next action all land in the run state and reports.

How `surface.claim` expectations are matched (type, subject, status, freshness, producer trust, integrity) is covered in [Evidence](evidence.md).

## Exceptions

An accepted exception lets a gate pass without its expected evidence — explicitly, and on the record:

```sh
flow accept-exception dev-1847 --gate verify-gate \
  --reason "browser evidence unavailable in CI; verified manually on staging" \
  --authority "brian@kontour.ai"
```

The exception is stored in run state with its reason and authority, counts as a gate pass, and appears in every report and console view. Exceptions are visible by design — the failure mode Flow prevents is the *silent* bypass, not the justified one.

## Route-back

A gate routes failed evidence back to a specific step via `on_route_back`:

```json
{
  "step": "verify",
  "on_route_back": {
    "missing_evidence": "verify",
    "implementation_defect": "implement",
    "plan_gap": "plan",
    "decision_gap": "plan",
    "default": "implement"
  },
  "route_back_policy": {
    "max_attempts": 3,
    "on_exceeded": "block"
  }
}
```

Route reason ids are open strings. Flow documents four standard ids without enforcing a closed enum:

| Reason id | Meaning | Inferred by Flow? |
| --- | --- | --- |
| `missing_evidence` | Required gate evidence is absent | Yes — Flow infers this when evidence is missing |
| `implementation_defect` | Work failed the gate; return to implementation | No — producer or agent sets this |
| `plan_gap` | Plan or acceptance shape is insufficient | No — producer or agent sets this |
| `decision_gap` | Work needs a decision or clarification | No — producer or agent sets this |
| `default` | Fallback when reason is absent or unmapped | Special — not a reason id, used in `on_route_back` |

Custom ids are allowed: add them to `on_route_back` when they should select a specific step, and include `default` for unknown or omitted reasons. If failed evidence has no `route_reason`, Flow uses `default` when present, otherwise the gate's own `step`.

### Deterministic attempt counting

Route-back attempts are derived from **persisted state**, not memory. Flow counts prior `route_back` transitions in `state.transitions` with the same gate id, route reason (or `default`), source step, and selected target step. Timestamps, classifier data, diagnostics, analytics metadata, and caller-supplied counters never affect routing or attempt counts — so neither an agent nor an adapter can fudge the loop budget.

When `max_attempts` is exceeded, `on_exceeded` decides the outcome:

- a **step id** routes the run to that recovery step, recording both the selected route and the recovery step
- **`block`** stops the run at the current step while recording the exceeded attempt

Flow validates route targets against defined step ids; `block` is special only inside `route_back_policy.on_exceeded`.

This is what an exhausted budget looks like in practice (from a real run):

```text
route-back verify-gate: verify gate has failing evidence
current step: implement
next action: return to implement and replace failing evidence attempt 1/3
```

**Recovering** from a route-back means replacing the failing evidence: attach the new evidence with `--supersede <failed-evidence-id>`. The superseded entry stays in the manifest (reports still show the failed round happened) but stops driving the gate, so the next evaluation can pass on the replacement. The [adversarial-survey scenario](https://github.com/kontourai/flow/blob/main/examples/scenarios/adversarial-survey/README.md) walks the full loop with real output.

Run state and reports expose the full route-back record for continuation and analysis: selected route, final target, reason, attempt, max attempts, exceeded state, evidence refs, expectation ids, and any recorded classifier/diagnostics/analytics metadata.

## Transition validation

Flow core owns provider-neutral transition legality. A runtime, adapter, or agent can *propose* a transition; Flow decides whether it matches the authored definition, current state, gate outcomes, route-back policy, and persisted history:

```sh
flow validate-transition ./transition-request.json
```

The request carries the definition, current state, evidence manifest, and the proposed transition. The result is machine-readable — here is a real rejection of a stale jump from `plan` to `publish` while the run was actually at `verify`:

```json
{
  "valid": false,
  "status": "invalid",
  "diagnostics": [
    {
      "code": "transition.current_state.stale",
      "severity": "error",
      "path": "$.proposed_transition.from_step",
      "message": "proposed transition starts from plan, but current state is verify"
    },
    {
      "code": "transition.from_step.mismatch",
      "severity": "error",
      "path": "$.proposed_transition.from_step",
      "message": "transition from_step must match current step verify"
    }
  ]
}
```

`flow validate-transition` exits non-zero when the result status is `invalid`. Definitions that do not declare stricter policy keep permissive v0.1 behavior; a gate can close its reason vocabulary with `route_back_policy.allow_unknown_reasons: false`.

There is nothing special about step names. A [Builder Kit](https://kontourai.github.io/flow-agents/workflow-usage-guide.html)-like path such as `verify → evidence → publish-change → release-readiness → merge` is just a Flow Definition — Flow rejects jumps across required gates because the proposed transition does not match the definition and evidence state, not because the names mean anything to Flow core.

## Pattern: adversarial review with a defect budget

[`examples/adversarial-pass-flow.json`](../examples/adversarial-pass-flow.json) is a complete reference for a high-stakes review loop: `produce → adversarial-review → resolve`. The review gate expects two claims — `adversarial.producer-output` (the work being challenged) and `adversarial.review` (the per-round review result) — and routes defects deterministically:

| Route reason | Target | Why |
| --- | --- | --- |
| `conclusion_defect` | `produce` | the conclusion needs regeneration |
| `framing_defect` | `produce` | the task framing or assumptions need rework |
| `completeness_defect` | `produce` | missing coverage requires a new producer pass |
| `citation_defect` | `resolve` | repairable by fixing citations, no regeneration needed |
| `missing_evidence` | `adversarial-review` | required gate evidence is absent |
| `default` | `resolve` | unmapped or omitted reasons |

`max_attempts: 2` is the per-case adversarial budget; the third matching route-back exceeds it and `on_exceeded: "block"` stops the run with the exceeded state recorded. External systems own the actual review reasoning and may attach their records as per-round evidence — [Kontour Survey](https://kontourai.io/survey)'s [adversarial-pass records](https://kontourai.github.io/survey/adversarial-and-learning.html) are built for exactly this slot — while Flow owns only the orchestration, route accounting, and the budget.

## Validating definitions

Catch shape and policy errors before a run exists:

```sh
flow validate-definition .flow/definitions/agent-dev-flow.json
flow validate-definition examples/invalid-claim-expectation-flow.json --json
```

`--json` emits a stable payload with `valid`, `path`, `error_count`, and `diagnostics`; the command exits non-zero for invalid definitions, so it slots directly into CI. Diagnostics cover shape errors, unknown gate step references, route-back targets, malformed `expects` entries, and invalid `surface.claim` fields.

Flow accepts two authoring shapes — the flat v0.1 shape (top-level `id`, `version`, `steps`, `gates`) and the Resource Contract shape (`apiVersion`, `kind: "FlowDefinition"`, `metadata`, `spec`) shown in [`examples/flow-definition-resource-contract.json`](../examples/flow-definition-resource-contract.json). Both map to the same runtime model (`metadata.name` → `id`, `spec.version` → `version`, `spec.steps` → `steps`, `spec.gates` → `gates`), and existing flat definitions never need to migrate.
