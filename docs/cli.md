# CLI Reference

Every command operates on local files. `--cwd <path>` scopes local Flow state and relative inputs for any command that reads or writes project state — for example, `flow start flow-definition.json --cwd /tmp/workspace` writes a new run under `/tmp/workspace/.kontourai/flow/` and resolves `flow-definition.json` from `/tmp/workspace`.

Commands exit `0` on success. Exit codes of `1` are noted per command below; unexpected errors always exit `1` with the message on stderr.

## flow init

```sh
flow init [--demo] [--cwd <path>]
```

Scaffolds `.flow/` with `config.json` (default authority model), `definitions/agent-dev-flow.json` (the bundled sample), and a README describing the authored layout. It also ensures `.kontourai/flow/runs/` is available for generated runs. Idempotent, except that an existing `config.json` is preserved.

`--demo` additionally creates a ready-made run named `demo`: it writes a disposable demo trust artifact under `.kontourai/flow/demo/`, starts a run from the sample definition, attaches the plan-gate evidence, and evaluates it — leaving the run at `implement` so `flow status demo`, `flow resume demo`, and `flow console --run demo` immediately have something real to show. Re-running with an existing demo run is a no-op.

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
      "code": "definition.expectation.bundle_claim.required",
      "severity": "error",
      "path": "$.gates.verify-gate.expects[0].bundle_claim",
      "message": "trust.bundle expectations must include bundle_claim"
    }
  ]
}
```

Exits `1` when the definition is invalid, so it slots directly into CI.

## flow amend-definition

```sh
flow amend-definition <run-id> --definition <successor-json> --request <request-json> [--cwd <path>]
```

Applies one authorized compatible successor to an active run. The request must
contain `expected_run_head`, `expected_definition` (`id`, opaque `version`, and
digest), `successor_digest`, reason, and provider-neutral authority. Obtain the
heads from `flow status <run-id> --format json` or the library, authenticate the
authority in the consumer, and create the request before invoking the command.
The command prints prior and effective identities.

It never edits `definition.json`, evidence, or the manifest. A stale head,
reused request reference, malformed successor, incompatible history, paused or
terminal run exits nonzero without canonical mutation. `flow report` and
Console read canonical state and repair disposable report files; no automatic
migration or rollback exists.

## flow kit

Agent-blind kit operations: fetch, validate, place, and report structure — without interpreting what a skill or adapter means. These commands know nothing about extension asset class semantics; that is [flow-agents'](https://kontourai.github.io/flow-agents/) responsibility. See [ADR 0008](adr/0008-kit-operation-boundary.md) for the boundary decision.

### flow kit validate

```sh
flow kit validate <kit-dir> [--json] [--cwd <path>]
```

Validates a Flow Kit container manifest (`kit.json`) at the given directory. Container validation checks the core manifest contract: `schema_version`, `id`, `name`, `flows`, path validity, and path existence. It does not validate Flow Definition semantics; use `flow validate-definition` for that.

`--json` emits a stable payload:

```json
{
  "valid": false,
  "path": "my-kit",
  "error_count": 2,
  "diagnostics": [
    {
      "code": "kit.id.invalid",
      "severity": "error",
      "path": "$.id",
      "message": ".id must be a kebab-case string matching ^[a-z][a-z0-9-]*$"
    }
  ]
}
```

Consumer extension fields (such as `skills`, `docs`, `adapters`) are ignored without error. Exits `1` when the kit is invalid.

See [Flow Kit Container](flow-kit-container.md) for the full container contract.

### flow kit install

```sh
flow kit install <source> [--dest <path>] [--ref <ref>]
```

Fetch a kit from a source, validate the container, and place the kit package at `<dest>/<kit-id>/`. Source formats:

- **Git URL** — `https://github.com/org/repo.git#main` or `git@github.com:org/repo.git`
- **Local path** — `/path/to/kit-dir` or `./relative/kit-dir`
- **file:// URL** — `file:///path/to/local-repo#branch` (useful in tests and CI)
- **npm spec** — `@scope/package@version`

`--ref` overrides any `#ref` fragment in a git URL.

**Agent-blind**: copies the entire kit package as-is. It does not interpret, filter, or process extension asset classes (skills, adapters, docs, evals). Consumer products such as flow-agents apply their own extension layer on top.

Exits `1` when the source cannot be fetched or the container is invalid.

### flow kit inspect

```sh
flow kit inspect <kit-dir> [--json]
```

Reports the structural (K0) view of a kit container: validity, declared flow ids, and the **names** of declared extension asset-class fields.

`--json` emits a stable payload:

```json
{
  "valid": true,
  "kitId": "review-kit",
  "kitName": "Review Kit",
  "flows": [
    { "id": "review-kit.review", "path": "flows/review.flow.json" }
  ],
  "assetClasses": ["skills", "docs"],
  "diagnostics": []
}
```

**Agent-blind**: `assetClasses` lists the _names_ of declared extension fields — it does not interpret their contents, derive K-levels, or infer runtime targets. Those operations belong to flow-agents' `flow-agents kit inspect`. Exits `1` when the kit is invalid.

## Migration

`flow validate-kit` was replaced by `flow kit validate` in 1.2.0 and removed in 1.3.0. Update any scripts or CI steps that use `flow validate-kit <kit-dir>` to use `flow kit validate <kit-dir>` instead.

## flow start

```sh
flow start <definition> [--run-id <id>] [--params key=value ...] [--cwd <path>]
```

Starts a run: validates the definition, snapshots it to `.kontourai/flow/runs/<run-id>/definition.json`, creates `state.json` at the first step, and writes initial reports. `--params subject=<value>` names the concrete work the run is about. Without `--run-id`, Flow generates one. The CLI does not discover or mutate `.flow/runs/<run-id>/`; migrate older generated state first.

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

The reported status is canonical. A paused or canceled run has no ready steps;
its current step remains visible for audit, but it is not permission to continue.

## flow pause, flow resume-run, and flow cancel

```sh
flow pause <run-id> --request <request-json> [--cwd <path>]
flow resume-run <run-id> --request <request-json> [--cwd <path>]
flow cancel <run-id> --request <request-json> [--cwd <path>]
```

These commands mutate the canonical Run lifecycle without moving its current
Step. `--request` names a JSON file, resolved relative to `--cwd`, containing a
provider-neutral, externally authorized request:

```json
{
  "reason": "The user asked to stop this run.",
  "authority": {
    "kind": "user_request",
    "actor": "user:brian",
    "request_ref": "conversation:01J2/request:42",
    "requested_at": "2026-07-10T12:00:00.000Z"
  }
}
```

`authority.kind` must be `user_request` or `operator_request`. Flow validates
and persists that constrained record; it does not infer authority from the
invoking agent or authenticate the actor. The consumer must authenticate the
request and provide an immutable `request_ref` before calling Flow. Unsupported
fields, missing fields, malformed JSON, agent-self-asserted authority, and
ineligible source states exit `1` with a stable `flow.lifecycle.*` diagnostic.
Audit text must be printable and is bounded: 256 characters for `actor`, 2048
for `request_ref`, and 4096 for `reason`. CR/LF, ESC/OSC, DEL, and other terminal
controls are rejected; Markdown and shell punctuation remain inert data.

Pause accepts `active`, `blocked`, and `needs_decision`, recording the exact
prior status. `resume-run` accepts only `paused` and restores that prior status.
Cancel accepts any of those nonterminal states, including `paused`, and is
terminal. Replaying the exact same cancellation request succeeds without
rewriting the event timestamp or any run file and prints `cancel (idempotent)`;
a different cancellation after cancellation fails with
`flow.lifecycle.replay.conflict` and performs no write.

Lifecycle history is separate from Step `transitions`: none of these commands
satisfies a Gate, advances a Step, or rewrites evidence, exceptions, or the
required path. Flow does not release assignments, update providers, archive
artifacts, or clean branches/worktrees as a side effect; those remain consumer
responsibilities.

## flow attach-evidence

```sh
flow attach-evidence <run-id> --gate <gate> --file <file>
  [--kind <kind>] [--bundle] [--status failed] [--supersede <evidence-id> ...]
  [--producer <id>] [--authority-trace <trace>]
  [--route-reason <reason>] [--expectation-id <id> ...]
  [--classifier-kind <kind>] [--classifier-source <source>] [--classifier-confidence <0..1>]
  [--analytics-loop-key <key>] [--route-metadata <json-file>]
  [--cwd <path>]
```

Copies the file into the run's `evidence/` directory and records it in the manifest.

- `--kind` is one of the [documented evidence kinds](evidence.md#evidence-kinds); unknown kinds are stored as `custom` with the original name preserved.
- `--bundle` (or `--kind trust.bundle`) parses the file as a Hachure TrustBundle, validates it against the Hachure schema, and stores the bundle plus its derived trust report on the evidence entry. See [Trust artifacts](evidence.md#trust-artifacts).
- `--status failed` marks failing evidence; pair it with `--route-reason` to drive [route-back](gates-and-route-back.md#route-back).
- `--supersede <evidence-id>` (repeatable) marks earlier evidence on the same gate as replaced by this entry. Superseded entries stay in the manifest for audit but no longer drive gate outcomes — this is how a route-back's "replace failing evidence" instruction is carried out.
- `--route-metadata` supplies nested `route_reason`, `expectation_ids`, `classifier`, `diagnostics`, and `analytics` from a JSON file; explicit flags win on overlap. Only `route_reason` affects routing — everything else is recorded for reports and learning.

`--trust-artifact` is a deprecated alias for `--bundle` / `--kind trust.bundle`: using it attaches the file through the same trust.bundle path and prints a deprecation warning to stderr. Prefer `--bundle` (or `--kind trust.bundle`) directly.

`--claim-type`, `--claim-subject`, and `--claim-status` are still accepted for backward compatibility but are deprecated no-ops with no effect on attached evidence, so they no longer appear in `--help`; the claim type and subject a Hachure TrustBundle satisfies come from the bundle's own claims, matched against the gate's `bundle_claim` expectation.

## flow capture

```sh
flow capture <run-id> --gate <gate> --kind command
  [--timeout <ms>] [--cwd <path>] -- <cmd...>
```

Runs the executable and argument vector after `--` without a shell, writes a
canonical command receipt, then attaches that completed file through the same
immutable-copy path as `flow attach-evidence`. Exit code `0` attaches `passed`
evidence; a nonzero exit, signal, launch error, or timeout attaches `failed`
evidence. After attachment, `flow capture` returns the command's nonzero exit
code (or `1` when no exit code exists).

The default timeout is 600000 ms (10 minutes). The receipt records the exact
argument vector, working directory, exit code or signal, duration, stdout,
stderr, truncation metadata, and a SHA-256 content hash. On POSIX systems the
command runs in its own process group; timeout sends the group `SIGTERM`, then
escalates the group to `SIGKILL` after a 5-second grace period. Captured stdout and
stderr share a 1 MiB budget; both streams receive space when both exceed the
budget. The stdout/stderr spool files on disk are not bounded while the command
runs; the 1 MiB limit is applied when Flow reads them back into the receipt.
`output_sha256` hashes the UTF-8-decoded recorded content; binary output is
lossily decoded, and truncation at a byte boundary can decode a split multibyte
character as U+FFFD. Its public shape is
`schemas/command-evidence.schema.json`.

This is optional authoring convenience. Use `flow attach-evidence` when another
tool already produced the evidence file. `flow evaluate` remains passive and
never executes the recorded command.

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

Reads only the run directory and prints the continuation contract: current step, next action, open gates, accepted exceptions, route-back history, and a one-line instruction for the next agent or person. This command is always read-only. It does not resume a paused lifecycle; use `flow resume-run <run-id> --request <request-json>` for that explicit, authority-bearing mutation. For canceled runs it reports terminal guidance rather than a continuation action.

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

## flow ready-steps

```sh
flow ready-steps <run-id> [--format json] [--cwd <path>]
```

Prints the ready frontier — the steps that are not yet passed and whose every
predecessor has passed its gate.  For a linear definition this is normally
the current step.  For a DAG definition with `needs`, it can include multiple
steps.

Default output:

```text
ready steps: implement
```

`--format json` emits:

```json
{
  "run_id": "my-run",
  "readySteps": ["implement"],
  "stageStatuses": {
    "plan": "passed",
    "shape": "passed",
    "implement": "current",
    "verify": "blocked",
    "publish": "blocked"
  }
}
```

`flow status --format json` also includes `readySteps` and `stageStatuses` in
its output; `--format summary` appends a `ready steps: …` line when the ready
frontier is non-empty.  `flow resume` similarly appends ready steps when
present.
