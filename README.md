# Kontour Flow

Process transparency for any required-path work. Flow shows why a process was allowed to move forward — gate by gate, with the evidence behind each transition.

Agents skip steps, accept weak evidence, summarize work as complete, and lose the thread after compaction. Flow is the small thing missing in the middle: a record of the required path, the evidence each gate expected, the evidence that was actually collected, and the exceptions that need explicit human trust. It does not run agents or replace CI. It does not replace the systems that run work. It explains why the work was allowed to advance.

## Quickstart

```sh
npm install -D @kontourai/flow
npx flow init
npx flow validate-definition examples/agent-dev-flow.json --json
npx flow start examples/agent-dev-flow.json --run-id dev-1847
npx flow attach-evidence dev-1847 --gate verify-gate \
  --file ./test-output.json --kind command
npx flow report dev-1847
```

## Status

Flow v0.1 is local and file-backed.

## First Wedge

Agentic development workflows are the first wedge: plan, implementation, verification, publish, release, and learning gates with evidence that survives handoff and context compaction.

## Example Summary

```sh
npx flow init
npx flow start .flow/definitions/agent-dev-flow.json --run-id dev-1847 --params subject=feature-search-filters
npx flow attach-evidence dev-1847 --gate plan-gate --file ./acceptance.md --kind acceptance-criteria
npx flow evaluate dev-1847
npx flow status dev-1847 --format summary
```

The summary output is designed for humans and agents:

```text
flow run: agent-dev-flow / feature-search-filters
current step: verify

PASS  plan gate: acceptance criteria linked
PASS  implementation gate: scoped files changed
BLOCK verify gate: browser evidence missing
      expected: tests, lint, screenshot, Veritas readiness

next action: run browser check before publish
continuation: resume from verify, not chat memory
report: .flow/runs/dev-1847/report.md
```

## CLI

```text
flow init
flow validate-definition <path> [--json]
flow start <definition> [--run-id <id>] [--params key=value ...]
flow status <run-id> [--format summary|json|markdown]
flow attach-evidence <run-id> --gate <gate> --file <file> [--kind <kind>] [--route-reason <reason>] [--route-metadata <json-file>]
flow evaluate <run-id> [--gate <gate>]
flow accept-exception <run-id> --gate <gate> --reason <reason> --authority <authority>
flow report <run-id> [--format summary|markdown|json]
flow resume <run-id>
flow list
```

## Local Run Store

Flow v0.1 is local and file-backed. A run is stored at `.flow/runs/<run-id>/`:

- `definition.json` is the Flow Definition snapshot from run start.
- `state.json` records the current step, transition history, gate outcomes, accepted exceptions, and next action.
- `evidence/manifest.json` records attached gate evidence metadata.
- `evidence/<id>.*` contains copied evidence files.
- `report.md` is the human-readable Flow Report.
- `report.json` is the machine-readable Flow Report.

The continuation contract is intentionally simple: `flow resume <run-id>` reads only the run directory and prints the current step, next action, open gates, accepted exceptions, and a one-line instruction for the next agent.

## Evidence Kinds

`flow attach-evidence --kind <kind>` accepts these documented kinds:

- `command`
- `file`
- `ci`
- `veritas-readiness`
- `human-attestation`
- `trace-link`

Unknown kinds are accepted as `custom` and stored with the originally requested kind. The v0.1 CLI attaches evidence from files; richer adapters can write the same manifest shape.

Failed evidence can carry route-back metadata:

```sh
flow attach-evidence dev-1847 --gate verify-gate --file ./test-output.json \
  --kind command --status failed --route-reason implementation_defect \
  --classifier-kind manual --classifier-source cli --classifier-confidence 0.75 \
  --analytics-loop-key verify:implementation_defect --expectation-id tests-passed
```

For nested metadata, pass `--route-metadata ./route-metadata.json`. The file may contain `route_reason`, `expectation_ids`, `classifier`, `diagnostics`, and `analytics`. CLI flags override overlapping `route_reason`, `classifier`, `analytics.loop_key`, and `expectation_ids` values from the file. Flow uses only `route_reason`, the Flow Definition route map/policy, and persisted route-back transitions to select the route; classifier, diagnostics, and analytics are recorded for reports and learning but do not affect routing.

## Gate Expectations

Flow Definitions describe what each gate expects before a run can advance. The typed form is `expects`, an array of expectation entries. Use `kind: "surface.claim"` when a gate needs rich evidence backed by a Surface claim instead of a simple evidence-kind string.

A `surface.claim` expectation includes:

- `id`
- `kind: "surface.claim"`
- `required`
- `description`
- `claim.type`
- optional `claim.subject`
- optional `claim.accepted_statuses`
- optional `explore_hint`

`claim.subject` is intentionally open so projects and kits can name their own process subjects. Common examples include `flow-run`, `flow-step`, `work-item`, `change`, `pull-request`, `release`, `decision`, and `artifact`.

Project config owns trusted producer mappings and gate overrides. Flow Agents may author, adapt, or install that config as part of a kit or runtime adapter, but the authoritative source of truth is the Flow project config that Flow loads for the run.

## Gate Evaluation

For the current step, `flow evaluate` applies the v0.1 rules:

- all required evidence kinds present and not failed: `pass`
- any required evidence kind missing: `block`
- any evidence marked failed: `route-back`
- no required evidence and no decision: `wait`
- an accepted exception on a gate counts as `pass`

When a gate passes, Flow advances to the step's `next` value. When a gate blocks, Flow keeps enough state for another process or agent to resume without chat memory.

## Route Back

A gate can route failed evidence back to a specific step by adding `on_route_back` to the gate definition:

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
    "max_attempts": 2,
    "on_exceeded": "block"
  }
}
```

Route reason ids are open strings. Flow documents these standard recommended ids but does not enforce a closed enum:

- `missing_evidence`: Flow or an evidence producer found that required gate evidence is absent.
- `implementation_defect`: the implementation failed the gate and should return to implementation.
- `plan_gap`: the plan or acceptance shape is insufficient and should return to planning.
- `decision_gap`: the work needs a decision or clarification before it can proceed.

Custom reason ids are allowed when a project, kit, or adapter needs narrower routing. Add custom ids to `on_route_back` when they should select a specific step, and include `default` for unknown or omitted reasons. If a failed evidence item has no `route_reason`, Flow uses `default` when present and otherwise preserves the legacy fallback to the gate's own `step`. Flow only infers `missing_evidence` when Flow itself detects missing required evidence.

Route-back attempts are deterministic. Flow counts prior persisted `route_back` transitions with the same gate id, route reason or `default`, source step, and selected target step. Timestamps, classifier data, diagnostics, analytics metadata, and in-memory counters do not affect routing or attempt counts.

When `route_back_policy.max_attempts` is exceeded, `on_exceeded` decides the outcome. A step id routes the run to that recovery step and records both the selected route and recovery step. The special value `block` blocks the run at the current step while recording the exceeded route-back attempt. Flow validates new route targets against defined step ids; `block` is only special for `route_back_policy.on_exceeded`.

Flow Run state and reports expose route-back details for continuation and analysis: selected route, final route target, route reason, attempt, max attempts, exceeded state, evidence refs, expectation ids, classifier, diagnostics, analytics loop key, and recovery step. The CLI records these metadata fields through `flow attach-evidence`, but Flow core remains neutral: Builder Kit or Flow Agents policy can choose reason ids and mappings, while Flow itself only applies the authored Flow Definition, `route_reason`, and persisted transition history.

## Definition Validation

Validate arbitrary Flow Definition JSON before starting a run:

```sh
npx flow validate-definition examples/builder-kit-flow.json
npx flow validate-definition examples/invalid-claim-expectation-flow.json --json
```

`--json` emits a stable machine-readable payload:

```json
{
  "valid": false,
  "path": "examples/invalid-claim-expectation-flow.json",
  "error_count": 6,
  "diagnostics": [
    {
      "code": "definition.expectation.claim.required",
      "severity": "error",
      "path": "$.gates.verify-gate.expects[0].claim",
      "message": "surface.claim expectations must include claim"
    }
  ]
}
```

Diagnostics cover shape errors, unknown gate step references, route-back targets, malformed `expects`, invalid `kind: "surface.claim"` entries, missing `claim.type`, optional expectations, `claim.subject`, `claim.accepted_statuses`, and legacy `requires` entries. The legacy `validateDefinition(definition)` API is still pass/throw; it now uses the same diagnostics internally and throws the first diagnostic message for invalid definitions.

## Library

The package also exports the runtime primitives used by the CLI:

```js
import {
  startRun,
  attachEvidence,
  evaluateRun,
  loadRun,
  validateDefinitionWithDiagnostics
} from "@kontourai/flow";

const result = validateDefinitionWithDiagnostics(definition);
if (!result.valid) console.error(result.diagnostics);
```

## Schemas

Runtime code and tests reference the JSON Schemas in `schemas/`:

- `flow-definition.schema.json`
- `flow-run.schema.json`
- `gate-evidence.schema.json`
- `flow-report.schema.json`

`npm test` and `npm pack` fail if the checked schemas drift from the v0.1 runtime contract.

## Boundaries

Flow is not an agent runtime, multi-agent orchestrator, task board, repo standards engine, hosted service, or web UI. Surface owns portable trust state, Veritas owns repo readiness semantics, and Flow Agents owns agent-facing workflow distribution.
