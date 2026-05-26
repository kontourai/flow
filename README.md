# Kontour Flow

Process transparency for any required-path work. Flow shows why a process was allowed to move forward — gate by gate, with the evidence behind each transition.

Agents skip steps, accept weak evidence, summarize work as complete, and lose the thread after compaction. Flow is the small thing missing in the middle: a record of the required path, the evidence each gate expected, the evidence that was actually collected, and the exceptions that need explicit human trust. It does not run agents or replace CI. It does not replace the systems that run work. It explains why the work was allowed to advance.

## Quickstart

```sh
npm install -D @kontourai/flow
npx flow init
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
flow start <definition> [--run-id <id>] [--params key=value ...]
flow status <run-id> [--format summary|json|markdown]
flow attach-evidence <run-id> --gate <gate> --file <file> [--kind <kind>]
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

## Library

The package also exports the runtime primitives used by the CLI:

```js
import { startRun, attachEvidence, evaluateRun, loadRun } from "@kontourai/flow";
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
