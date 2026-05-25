# Kontour Flow

Process transparency for agentic work.

Flow records the required path for a piece of work, the evidence each gate expected, the evidence that was actually collected, and any exceptions accepted by a human authority. It does not run agents or replace CI. It explains why work was allowed to advance.

## Install

```sh
npm install -D @kontourai/flow
```

## Quickstart

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

Flow is not an agent runtime, multi-agent orchestrator, task board, repo standards engine, hosted service, or web UI. Surface owns portable trust state, Veritas owns repo readiness semantics, and Kagents owns agent-facing workflow distribution.
