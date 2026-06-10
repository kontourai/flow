# CLI Reference

Every command operates on local files. `--cwd <path>` scopes local Flow state and relative inputs for any command that reads or writes project state — for example, `flow start flow-definition.json --cwd /tmp/workspace` writes the run under `/tmp/workspace/.flow/` and resolves `flow-definition.json` from `/tmp/workspace`.

Commands exit `0` on success. Exit codes of `1` are noted per command below; unexpected errors always exit `1` with the message on stderr.

## flow init

```sh
flow init [--demo] [--cwd <path>]
```

Scaffolds `.flow/` with `config.json` (default authority model), `definitions/agent-dev-flow.json` (the bundled sample), `runs/`, and a README describing the layout. Idempotent, except that an existing `config.json` is preserved.

`--demo` additionally creates a ready-made run named `demo`: it writes a demo trust artifact under `.flow/demo/`, starts a run from the sample definition, attaches the plan-gate evidence, and evaluates it — leaving the run at `implement` so `flow status demo`, `flow resume demo`, and `flow console --run demo` immediately have something real to show. Re-running with an existing demo run is a no-op.

## flow validate-definition

```sh
flow validate-definition <path> [--json] [--cwd <path>]
```

Validates a Flow Definition — flat v0.1 shape or Resource Contract shape. `--json` emits a stable payload:

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

Exits `1` when the definition is invalid, so it slots directly into CI.

## flow start

```sh
flow start <definition> [--run-id <id>] [--params key=value ...] [--cwd <path>]
```

Starts a run: validates the definition, snapshots it to `.flow/runs/<run-id>/definition.json`, creates `state.json` at the first step, and writes initial reports. `--params subject=<value>` names the concrete work the run is about. Without `--run-id`, Flow generates one.

## flow status

```sh
flow status <run-id> [--format summary|json|markdown] [--cwd <path>]
```

Prints the run's current standing. `summary` (default) is the compact human/agent view; `json` and `markdown` print the full regenerated report.

```text
flow run: agent-dev-flow / feature-search-filters
current step: implement

PASS  plan gate: Acceptance criteria are ready for implementation. satisfied
WAIT  implementation gate: implementation gate waiting
WAIT  verify gate: verify gate waiting

next action: attach evidence for implementation gate
continuation: resume from implement, not chat memory
```

## flow attach-evidence

```sh
flow attach-evidence <run-id> --gate <gate> --file <file>
  [--kind <kind>] [--status failed] [--supersede <evidence-id> ...]
  [--trust-artifact] [--claim-type <type>] [--claim-subject <subject>] [--claim-status <status>]
  [--producer <id>] [--authority-trace <trace>]
  [--route-reason <reason>] [--expectation-id <id> ...]
  [--classifier-kind <kind>] [--classifier-source <source>] [--classifier-confidence <0..1>]
  [--analytics-loop-key <key>] [--route-metadata <json-file>]
  [--cwd <path>]
```

Copies the file into the run's `evidence/` directory and records it in the manifest.

- `--kind` is one of the [documented evidence kinds](evidence.md#evidence-kinds); unknown kinds are stored as `custom` with the original name preserved.
- `--trust-artifact` parses the file as a Surface-shaped trust report/snapshot and projects its first claim into the matching fields; the `--claim-*`, `--producer`, and `--authority-trace` flags override the parsed projection.
- `--status failed` marks failing evidence; pair it with `--route-reason` to drive [route-back](gates-and-route-back.md#route-back).
- `--supersede <evidence-id>` (repeatable) marks earlier evidence on the same gate as replaced by this entry. Superseded entries stay in the manifest for audit but no longer drive gate outcomes — this is how a route-back's "replace failing evidence" instruction is carried out.
- `--route-metadata` supplies nested `route_reason`, `expectation_ids`, `classifier`, `diagnostics`, and `analytics` from a JSON file; explicit flags win on overlap. Only `route_reason` affects routing — everything else is recorded for reports and learning.

## flow evaluate

```sh
flow evaluate <run-id> [--gate <gate>] [--exit-code] [--cwd <path>]
```

Evaluates the gate(s) for the current step and applies the outcome — advance, block, route back, or wait — printing one line per gate outcome plus the new current step and next action. See [gate evaluation rules](gates-and-route-back.md#gate-evaluation-rules).

`--exit-code` exits `1` unless every evaluated gate passed, which makes the command usable directly as a CI step or an agent-harness hook — see [Agent Hooks](agent-hooks.md).

## flow accept-exception

```sh
flow accept-exception <run-id> --gate <gate> --reason <reason> --authority <authority> [--cwd <path>]
```

Records an explicit exception on a gate. All three flags are required — an exception without a reason and an authority is exactly the kind of silent bypass Flow exists to prevent. The exception counts as a gate pass and appears in run state, reports, and the console.

## flow resume

```sh
flow resume <run-id> [--cwd <path>]
```

Reads only the run directory and prints the continuation contract: current step, next action, open gates, accepted exceptions, route-back history, and a one-line instruction for the next agent or person.

## flow report

```sh
flow report <run-id> [--format summary|markdown|json] [--cwd <path>]
```

Prints the regenerated run report. Reports are derived explanations — `state.json` remains the authority for evaluation and resume.

## flow list

```sh
flow list [--cwd <path>]
```

Lists local runs: id, status, current step, and `definition / subject`, tab-separated. Prints a short empty-state message when no runs exist.

## flow console

```sh
flow console --run <run-id> [--host 127.0.0.1|localhost|::1] [--port <port>] [--cwd <path>]
```

Starts the loopback-only local console for a run. The server reads the run through the same projection API exposed to the library (`projectFlowRunFromFiles`), serves the compiled UI, and exposes the read model at `/api/projection`. `--port 0` (default) picks a free port.

Surface and Veritas refs keep normal HTTP(S) URLs. Companion-scheme refs map to deterministic local companion URLs (`surface://…` → `http://127.0.0.1:51231/…`, `veritas://…` → `http://127.0.0.1:51232/…`). Local artifact paths are served through `/artifacts/<relative-path>` only when they stay inside the run directory; unsafe absolute or parent-traversal paths are displayed as text instead of served.

## flow config

```sh
flow config preview <proposal> [--format summary|markdown|json] [--cwd <path>]
flow config apply <proposal> [--accept-conflict <path> ...]
  [--exception-reason <reason>] [--authority <authority>]
  [--format summary|markdown|json] [--cwd <path>]
```

Preview is read-only; apply merges additive changes and rejects conflicts unless each is accepted with `--accept-conflict` plus a reason and authority. `apply` exits `1` when the merge is blocked by unaccepted conflicts. Full semantics: [Project Config](project-config.md).

## flow validate-transition

```sh
flow validate-transition <request-json> [--cwd <path>]
```

Validates a proposed transition against the definition, current state, and evidence manifest in the request file, printing the machine-readable result. Exits `1` when the result status is `invalid`. Request and result shapes: [Gates & Route-Back](gates-and-route-back.md#transition-validation) and `schemas/flow-transition-validation-*.schema.json`.

## flow version-release-report

```sh
flow version-release-report <fixture-json> [--format json|markdown] [--cwd <path>]
```

Projects a versioned release report from a local fixture file. Missing required evidence becomes explicit gaps with `decision: "hold"`. See [Release Readiness](release-readiness.md#version-release-reports).
