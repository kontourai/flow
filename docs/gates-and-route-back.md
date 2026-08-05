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

### Reported gate status vs gate outcome

A gate's *outcome* (`pass`, `block`, `route-back`, `wait`) is what an evaluation
produced. A gate that has never been evaluated, or whose outcome a route-back
invalidated, has no outcome at all, and the report says so with `unknown` rather
than collapsing it into `wait`.

| Reported status | Means | Hachure `status-function.md` |
| --- | --- | --- |
| `pass` | evaluated and satisfied | `verified` |
| `block` / `route-back` | evaluated, and the run cannot proceed on it | appraised, not affirming |
| `wait` | evaluated, present, no verdict yet | `proposed` |
| `unknown` | no recorded outcome — nothing to appraise | `unknown` |

Before this distinction existed, a gate the run had walked past without checking
rendered byte-identically to a gate that was legitimately waiting on evidence.

### Evaluating a gate that is not on the current step

`flow evaluate --gate <id>` names a specific gate. Flow evaluates it against the
run's real cursor — it never synthesises a state in which the request would be
legal — so a request that would carry the run forward past a gate it never
evaluated is refused with `flow.evaluate.gate.not_current`, naming the gates it
would have skipped. Nothing is written.

Two off-current requests remain legal:

- **Leaving a step that has no gate.** A gateless step imposes no check, so Flow
  walks the cursor forward through it and records that step's completion as its
  own `allowed` transition — the run really moves, rather than the record
  claiming it was already there. This is the only way such a step is ever left.
- **Re-appraising a step the run already occupied**, for example a downstream
  gate failing closed on a pending re-entry. That can hold the cursor or move it
  backwards, never forward.

A persisted transition may never name a `from_step` the run was not on; this is
asserted at write time, not only at request time. If a gate genuinely cannot be
satisfied, the supported way past it is an accepted exception, which records a
reason and an accepting authority on the run.

When a gate passes, Flow advances to the step's `next` value. When a gate blocks, Flow keeps enough state for another process or agent to resume without chat memory — the blocked expectation, its `explore_hint`, and the next action all land in the run state and reports.

How `trust.bundle` expectations are matched (claim type, subject, status, freshness, producer trust, integrity) is covered in [Evidence](evidence.md).

### Freshness after advancement

Every `evaluateRun` re-derives attached trust bundles before evaluating gates. If that re-derivation marks a claim stale after its gate has already passed, Flow identifies the passed gate itself and evaluates it before the current gate when all of the following are true:

- the changed bundle is evidence selected by that passed gate outcome (with legacy outcomes falling back to their recorded evidence refs);
- the changed claim still matches one of that gate's `trust.bundle` selectors; and
- the gate's step is a strict upstream dependency of the current cursor in the authored Flow graph.

The resulting outcome uses the gate's ordinary route-back policy and preserves its evidence refs in the audit transition. A route-back invalidates all graph descendants through the normal cascade. A stale claim in unrelated evidence, or in a sibling branch, does not route the run back; normal current-gate evaluation continues. Flow does not depend on agent or product-specific step ids for this behavior.

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

**Budget keying.** Route reasons that name a declared `on_route_back` route carry their own budget identity. Any reason not declared in `on_route_back` — including a novel string invented by an agent or adapter — normalises to `"default"` for attempt-counting purposes, so it shares the budget with every other undeclared or omitted reason. A caller cannot mint a fresh, always-empty budget bucket by supplying a string the definition never declared.

### Deterministic attempt counting

Route-back attempts are derived from **persisted state**, not memory. Flow counts prior `route_back` transitions in `state.transitions` with the same gate id, normalised route reason (declared reasons keep their identity; undeclared reasons collapse to `default`), source step, selected target step, and retry epoch. Legacy transitions without an epoch are epoch 1. Timestamps, classifier data, diagnostics, analytics metadata, and caller-supplied counters never affect routing or attempt counts — so neither an agent nor an adapter can fudge the loop budget.

#### Counting logical failures, not evidence re-evaluations

Within one retry epoch, a fresh route-back transition is a **new logical attempt** only when something material has changed since the immediately preceding matching route-back. Otherwise the new transition is a **replay** of the same logical failure and inherits the prior attempt number. This keeps the budget tied to distinct failed gate visits rather than to the number of `flow attach-evidence` + `flow evaluate` cycles a consumer runs while recovering from one failure — the same failed visit re-evaluated any number of times consumes exactly one attempt.

The logical-identity discriminator is computed from persisted state alone, in two parts:

| Signal | Persisted-state evidence | Effect |
| --- | --- | --- |
| **New gate visit** | The prior route-back's target step differs from its source step (the run left the gate's step), **or** a subsequent allowed/route-back/retry-authorized transition re-enters the gate's source step from a different step. | New attempt. |
| **New failed-evidence id** | The new route-back carries a `failed_evidence_refs` entry that was not present on the immediately preceding matching route-back. | New attempt. |

If neither signal is present, the new transition is a replay: it is persisted (for audit and downstream reports) carrying the same attempt number as the prior one. Two replays of the same missing-evidence self-loop therefore record two route-back transitions, both at attempt 1, instead of consuming attempts 1, 2, and exhausting a `max_attempts: 3` budget without a single new implementation cycle.

The `failed_evidence_refs` field is itself persisted on every route-back transition (it is the list of failed evidence ids that drove the route-back decision) and is proof-carrying: the route-back record validator (`flow-run-retry-proof`) replays the attempt derivation against the record's own `failed_evidence_refs` so a forged record cannot claim an attempt number its failed set does not produce.

When `max_attempts` is exceeded, `on_exceeded` decides the outcome:

- a **step id** routes the run to that recovery step, recording both the selected route and the recovery step
- **`block`** stops the run at the current step while recording the exceeded attempt
- **omitted** defaults to `block` — a gate whose budget is exhausted with no explicit recovery target blocks rather than looping forever

A gate without an explicit `route_back_policy` inherits a bounded default (`max_attempts: 10`, `on_exceeded: block`). Authors should declare an explicit policy for any gate that needs a different bound or a recovery step.

Flow validates route targets against defined step ids; `block` is special only inside `route_back_policy.on_exceeded`.

This is what an exhausted budget looks like in practice (from a real run):

```text
route-back verify-gate: verify gate has failing evidence
current step: implement
next action: return to implement and replace failing evidence attempt 1/3
```

**Recovering** from a route-back means replacing the failing evidence: attach the new evidence with `--supersede <failed-evidence-id>`. The superseded entry stays in the manifest (reports still show the failed round happened) but stops driving the gate, so the next evaluation can pass on the replacement. The [adversarial-survey scenario](https://github.com/kontourai/flow/blob/main/examples/scenarios/adversarial-survey/README.md) walks the full loop with real output.

Run state and reports expose the full route-back record for continuation and analysis: selected route, final target, reason, attempt, max attempts, exceeded state, evidence refs, expectation ids, and any recorded classifier/diagnostics/analytics metadata.

### Authorized retry after an exhausted block

An exhausted `on_exceeded: "block"` route-back may begin one more bounded epoch on the same run only through an authority-bearing retry authorization. This is a `retry_authorized` run transition, not lifecycle resume and not a Gate pass. It never accepts an exception, deletes history, changes the retry limit, or selects a new recovery target.

Construct the request from the exact persisted state and exhausted transition using the exported hashes, then submit it through the library or CLI:

```ts
import { authorizeRetry, flowRunHead, flowTransitionRef, loadRun } from "@kontourai/flow";

const run = await loadRun("dev-1847");
const blocked = run.state.transitions.at(-1);
await authorizeRetry("dev-1847", {
  request: {
    reason: "Operator approved one additional bounded evidence round.",
    target_step: blocked.selected_route,
    blocked_transition_ref: flowTransitionRef(blocked),
    expected_run_head: flowRunHead(run.state),
    authority: {
      kind: "operator_request",
      actor: "operator:alex",
      request_ref: "change-request:418",
      requested_at: "2026-07-19T15:30:00.000Z"
    }
  }
});
```

```sh
flow authorize-retry dev-1847 --request ./retry-request.json
```

The request fails closed before any write unless the run is currently blocked, its current state hash matches `expected_run_head`, and `blocked_transition_ref` identifies the current exhausted route-back. `target_step` must equal that transition's declared `selected_route`. An exact replay is idempotent; reusing its `request_ref` with different content is rejected. The persisted `prior_run_head` is the event-time optimistic-concurrency and audit binding copied from `expected_run_head`; in unsigned local run state it is not an independently reconstructible, post-persistence tamper-evidence guarantee. Local unsigned state is a trusted persistence boundary: Flow detects malformed or partial reserved records and binds event-time requests, but does not claim resistance to an attacker who rewrites an entire valid ledger and recomputes every unsigned hash. Signed or externally anchored history belongs to the trust layer tracked in [#93](https://github.com/kontourai/flow/issues/93). Flow serializes every same-run mutation through unique owner-recorded, deterministically ordered tickets. A ticket root permanently publishes a reserved foreign-host `owner.json` compatibility sentinel plus its marker before any ticket; release and stale cleanup touch only the owner ticket, so neither root artifact is removed or rewritten. Any unmarked legacy root (including dead/released/malformed/ownerless forms) fails with `flow.run_mutation.lock.migration_required` without a write. Clean such a root only in an operator-confirmed quiescent window after verifying no process can use the run; never blindly delete the lock root. A marked root with a missing, malformed, or linked marker/sentinel fails closed. Flow derives the authorization timestamp internally and commits `state.json` last after staging its derived reports. The authorization records the old and new epochs, removes the exhausted prior-epoch outcome from the current projection, retains it with completion transitions in append-only audit history (including legacy no-descendant runs), and reports consumed, next, and remaining attempts as the new epoch evolves; an exhausted epoch reports no next attempt. Fresh evidence is required after re-entry before a gate can advance. Flow validates the provider-neutral request shape but the consumer authenticates the actor.

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

`--json` emits a stable payload with `valid`, `path`, `error_count`, and `diagnostics`; the command exits non-zero for invalid definitions, so it slots directly into CI. Diagnostics cover shape errors, unknown gate step references, route-back targets, malformed `expects` entries, and invalid `trust.bundle` / `bundle_claim` fields.

Flow accepts two authoring shapes — the flat v0.1 shape (top-level `id`, `version`, `steps`, `gates`) and the Resource Contract shape (`apiVersion`, `kind: "FlowDefinition"`, `metadata`, `spec`) shown in [`examples/flow-definition-resource-contract.json`](../examples/flow-definition-resource-contract.json). Both map to the same runtime model (`metadata.name` → `id`, `spec.version` → `version`, `spec.steps` → `steps`, `spec.gates` → `gates`), and existing flat definitions never need to migrate.
