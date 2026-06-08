# Adversarial-Pass Flow Definition

`examples/adversarial-pass-flow.json` is a reference Flow Definition for an adversarial pass over produced work. It models this authored process:

```text
produce -> adversarial-review -> resolve
```

The `adversarial-review-gate` expects Surface-shaped claims for the producer output and the adversarial review result:

- `adversarial.producer-output` for the output being challenged.
- `adversarial.review` for the per-round adversarial review evidence.

The gate's route-back map uses adversarial defect reasons:

- `conclusion_defect` routes to `produce` when the answer or conclusion needs regeneration.
- `framing_defect` routes to `produce` when the task framing or assumptions need to be reworked.
- `completeness_defect` routes to `produce` when missing coverage requires a new producer pass.
- `citation_defect` routes to `resolve` when the output can be repaired by fixing or reconciling citations.
- `missing_evidence` routes to `adversarial-review` when Flow detects absent required gate evidence.
- `default` routes to `resolve` for omitted or unmapped failed-evidence reasons.

`route_back_policy.max_attempts` is the per-case adversarial budget. Flow derives the next attempt from persisted `route_back` transitions with the same gate id, route reason or `default`, source step, and selected target step. It does not use caller-supplied counters, classifier metadata, diagnostics, analytics, timestamps, or in-memory state for the budget. In the reference definition, the third matching route-back exceeds `max_attempts: 2`; `on_exceeded: "block"` blocks the run at `adversarial-review` while recording the selected route, attempt, max attempts, evidence refs, and exceeded state.

## Survey Boundary

Survey escalation records from `kontourai/survey` are per-round evidence inputs for this pattern. A Flow adapter may attach or reference those records as evidence for `adversarial.review`, and Flow will preserve evidence refs and route metadata in run state and reports.

Flow owns the authored Flow Definition, gate evaluation, route-back selection, and persisted transition accounting. Flow does not own Survey reasoning records, interpret Survey reasoning, define Surface trust primitives, run agents, call LLMs, or wire model execution. Those systems can produce evidence, but Flow applies only the Flow Definition, attached evidence metadata, route reason, route-back policy, and persisted run transitions.
