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

## Contributor Git Hooks

Flow includes optional repo-local Git hooks for contributors:

```sh
npm run setup:repo-hooks
npm run validate:repo-hooks
```

Setup is idempotent and writes only this repository's local Git config: `core.hooksPath=.githooks`. The tracked `pre-push` hook runs the bounded local lane, `npm test` and `npm run check:schemas`.

These hooks are contributor tooling. They are not Flow Definition semantics, not Flow Run state, not gate evaluation, not Flow Console behavior, and not CI or merge authority.

## TypeScript Development

Flow core runtime sources live in `src/*.ts`. `npm run typecheck` validates those sources without writing output, and `npm run build` emits the package runtime to `dist/` with `.d.ts` declarations. Package consumers use `dist/index.js`, `dist/index.d.ts`, and the `dist/cli.js` bin; `prepack` runs the typecheck and local tests so the published package is built from the TypeScript sources.

The remaining JavaScript/MJS files are intentional exceptions: `scripts/*.mjs` are Node support and verification scripts, `.githooks/pre-push` is shell contributor tooling, and schemas, examples, and fixtures remain JSON/data assets rather than TypeScript modules.

Repo structure guide: [docs/repo-structure.md](docs/repo-structure.md) explains where source, schemas, examples, fixtures, console assets, tests, scripts, generated output, and workflow artifacts belong.

## Status

Flow v0.1 is local and file-backed.

Developer architecture guide: [docs/developer-architecture.md](docs/developer-architecture.md) explains Flow lifecycle and enforcement diagrams, product ownership boundaries, and current versus future Resource Contract alignment.

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
flow validate-transition <request-json>
flow start <definition> [--run-id <id>] [--params key=value ...]
flow status <run-id> [--format summary|json|markdown]
flow attach-evidence <run-id> --gate <gate> --file <file> [--kind <kind>] [--route-reason <reason>] [--route-metadata <json-file>]
flow evaluate <run-id> [--gate <gate>]
flow accept-exception <run-id> --gate <gate> --reason <reason> --authority <authority>
flow config preview <proposal> [--format summary|markdown|json]
flow config apply <proposal> [--accept-conflict <path> ...] [--exception-reason <reason>] [--authority <authority>] [--format summary|markdown|json]
flow report <run-id> [--format summary|markdown|json]
flow version-release-report <fixture-json> [--format json|markdown]
flow console --run <run-id> [--cwd <path>] [--host 127.0.0.1|localhost|::1] [--port <port>]
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

## Console Projection

Downstream console code can project a local Flow Run into a deterministic read model:

```js
import { projectFlowRunFromFiles } from "@kontourai/flow/console-projection";

const projection = await projectFlowRunFromFiles("dev-1847", {
  cwd: process.cwd()
});

console.log(projection.current_step);
console.log(projection.gates);
```

The root package also exports `projectFlowRun` and `projectFlowRunFromFiles` from `@kontourai/flow`. Type declarations are available from both package boundaries.

`projectFlowRunFromFiles` reads local `.flow/runs/<run-id>/definition.json`, `state.json`, `evidence/manifest.json`, and optional `report.json`. It is read-only, local-file-first, deterministic, and Flow-owned. It preserves explicit external refs for Surface, Veritas, artifacts, pull requests, CI, and release reports when those refs already exist in local run files; it does not synthesize refs from git, network calls, hosted services, or Markdown report parsing.

This API is the Flow boundary for console consumers. Browser UI, hosted behavior, companion console startup, and `kontour-console` integration are outside this Flow issue.

## Local Flow Console

`flow console --run <id>` starts a loopback-only local operator console for a run stored under `.flow/runs/<run-id>/`. The server reads the run through `projectFlowRunFromFiles`, serves static compiled UI assets, and exposes the projection at `/api/projection`.

```sh
npm run build
node dist/cli.js console --run console-projection-fixture --cwd examples/fixtures/console-projection --port 0
```

The console shows the process graph, transition timeline, current run status, gate details, evidence, and links from the local projection. It does not start hosted services, authenticate users, collaborate across machines, or discover remote Surface/Veritas systems.

Surface and Veritas refs keep normal HTTP(S) URLs when provided. Companion-scheme refs are mapped to deterministic local companion URLs: `surface://...` becomes `http://127.0.0.1:51231/...`, and `veritas://...` becomes `http://127.0.0.1:51232/...`. When a ref only has a local artifact path, the console links it through `/artifacts/<relative-path>` if the path stays inside the selected run directory; unsafe absolute or parent-traversal paths are displayed as fallback text instead of being served.

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

### Surface TrustReport Evidence

A `surface.claim` evidence entry may be backed by a copied Surface TrustReport or Trust Snapshot JSON file:

```sh
npx flow attach-evidence <run-id> \
  --gate verify-gate \
  --file ./trust-report.json \
  --trust-artifact
```

Flow consumes a neutral artifact shape:

```json
{
  "schema_version": "0.1",
  "artifact_type": "trust-report",
  "subject": "builder.verify",
  "producer": "ci/main",
  "status": "trusted",
  "issued_at": "2026-05-26T00:00:00.000Z",
  "expires_at": "2026-06-02T00:00:00.000Z",
  "authority_traces": ["github:main"],
  "claims": [
    { "type": "quality.tests", "status": "trusted" }
  ]
}
```

`artifact_type` is `trust-report` or `trust-snapshot`. Flow projects the first claim into the normal `claim.type`, `claim.subject`, and `claim.status` matching fields. Explicit `--claim-*`, `--producer`, and `--authority-trace` flags still work and can override the parsed projection for local workflows.

Gate evaluation accepts only claims whose type, optional subject, accepted status, freshness, trusted producer or authority trace, and local integrity metadata satisfy the Flow expectation and `.flow/config.json`. Unsatisfied artifacts are not hidden as generic missing evidence: reports include claim diagnostic reason codes such as `stale`, `rejected`, `untrusted_producer`, `authority_gap`, `integrity_mismatch`, and `subject_mismatch`.

This is a Surface-shaped Flow contract. Flow does not import Veritas internals or use Veritas-specific schema fields as the runtime contract. Veritas may produce evidence, but Flow evaluates only the neutral artifact fields above plus the Flow Definition and project config.

## Release Readiness Lanes

Release readiness is a local-file-first Flow contract for deciding whether a release should proceed or hold. It defines lane policy and adapter output shape; it does not replace ServiceNow, Jira, PagerDuty, deployment systems, freeze calendars, or approval systems.

`schemas/release-readiness-policy.schema.json` describes:

- open lane ids such as `change-approval`, `deployment-window`, and `freeze-state`
- the `surface.claim` each lane requires
- open risk classes such as `medium` or `high`
- the required lanes for each risk class

`schemas/release-readiness-result.schema.json` describes normalized output for later report rendering: `decision`, `risk_class`, `required_lanes`, lane outcomes, evidence refs, `external_links`, and `native_refs`.

Fixture adapters map provider-shaped local JSON into Flow evidence, not opaque approval booleans. Each adapter emits `kind: "surface.claim"` with `claim.type`, `claim.subject`, `claim.status`, `producer`, `authority_traces`, copied `external_links`, and copied `native_refs`.

```js
import {
  changeManagementFixtureAdapter,
  deploymentWindowFixtureAdapter,
  evaluateReleaseReadiness,
  freezeStateFixtureAdapter
} from "@kontourai/flow";

const evidence = [
  ...changeManagementFixtureAdapter(changeRecord, { subject: "kai-2026.06" }),
  ...deploymentWindowFixtureAdapter(deploymentState, { subject: "kai-2026.06" }),
  ...freezeStateFixtureAdapter(freezeState, { subject: "kai-2026.06" })
];

const result = evaluateReleaseReadiness(policy, {
  subject: "kai-2026.06",
  riskClass: "high",
  evidence
});
```

Required lanes pass only when their Surface-shaped claim satisfies the policy. Missing, pending, rejected, stale, untrusted, or authority-gap evidence returns `decision: "hold"`. See `examples/fixtures/release-readiness/` for the fixture policy, adapter records, and equivalent Flow Definition expectation.

## Version Release Report

The Version Release Report is a local-file-first artifact projection for a versioned release. It combines a changeset, Flow-shaped verification evidence, a `ReleaseReadinessResult`, accepted exceptions, accepted risks, `native_refs`, and `external_links` into deterministic JSON or Markdown.

Generate from an explicit local fixture file:

```sh
npm run build
node dist/cli.js version-release-report examples/fixtures/version-release-report/complete.json --format json
node dist/cli.js version-release-report examples/fixtures/version-release-report/missing-required-evidence.json --format markdown
```

Use the library API when embedding the projection:

```js
import {
  projectVersionReleaseReport,
  renderVersionReleaseReportMarkdown
} from "@kontourai/flow";

const report = projectVersionReleaseReport(fixtureJson);
console.log(renderVersionReleaseReportMarkdown(report));
```

`schemas/version-release-report.schema.json` describes the projected report. Missing required verification evidence or required release lanes become explicit `gaps` and set `decision: "hold"`; they are never summarized as ready. Provider-native ids and URLs are preserved as data in `native_refs` and `external_links`; Flow does not call hosted release portals, replace release managers, or invent provider-specific semantics for this artifact. See `examples/fixtures/version-release-report/` for complete and missing-evidence inputs.

## Project Config Merge

Kits can propose Flow project config, but local `.flow/config.json` remains authoritative. Preview a proposal before applying it:

```sh
npx flow config preview ./kit-flow-config.json --format json
npx flow config preview ./kit-flow-config.json --format markdown
```

Preview is read-only. The JSON report includes stable buckets for `proposed_changes`, `accepted_changes`, `rejected_changes`, `conflicts`, `unchanged`, `exceptions`, `merged_config`, and `summary`. Each change records a machine-readable `path`, `section`, `operation`, `reason`, and source values when relevant.

Apply is explicit:

```sh
npx flow config apply ./kit-flow-config.json --format json
```

Additive proposals under `trusted_producers` and `gate_overrides` are accepted when the local path is absent. Matching values are recorded as unchanged. Differing local trusted producer mappings or gate overrides are conflicts and are rejected by default, so Flow does not silently overwrite project authority.

To accept a conflicting proposal, pass the exact conflict path or a parent path plus an exception reason and authority:

```sh
npx flow config apply ./kit-flow-config.json \
  --accept-conflict '$.trusted_producers.quality.tests' \
  --exception-reason 'project owner accepted kit producer update' \
  --authority 'project-owner'
```

Flow Agents kit install or activation may consume the JSON report to show install logs, detect conflicts, and decide whether to ask for explicit exception acceptance. Flow Agents consumes this contract; it does not own the authority semantics. Flow core does not add UI Console behavior, remote trust or signature verification, hosted workflows, provider settings, or cross-repo Flow Agents implementation as part of config merge.

## Gate Evaluation

For the current step, `flow evaluate` applies the v0.1 rules:

- all required evidence kinds present and not failed: `pass`
- any required evidence kind missing: `block`
- any evidence marked failed: `route-back`
- no required evidence and no decision: `wait`
- an accepted exception on a gate counts as `pass`

When a gate passes, Flow advances to the step's `next` value. When a gate blocks, Flow keeps enough state for another process or agent to resume without chat memory.

## Transition Validation

Flow core owns provider-neutral transition legality. A runtime, adapter, or agent workflow can propose a transition, but Flow decides whether that transition matches the authored Flow Definition, current state, gate outcomes, route-back policy, and persisted transition history.

Validate a proposed transition from a file:

```sh
npx flow validate-transition ./transition-request.json
```

The request shape is intentionally small and stable:

```json
{
  "definition": { "id": "agent-dev-flow", "version": "0.1", "steps": [], "gates": {} },
  "current_state": { "status": "active", "current_step": "verify", "transitions": [] },
  "proposed_transition": {
    "from_step": "verify",
    "to_step": "publish",
    "status": "allowed",
    "gate_id": "verify-gate"
  },
  "manifest": { "schema_version": "0.1", "evidence": [] }
}
```

The result is machine-readable:

```json
{
  "valid": false,
  "status": "route-back",
  "diagnostics": [
    {
      "code": "transition.gate.route-back",
      "severity": "error",
      "path": "$.proposed_transition",
      "message": "gate verify-gate returned route-back"
    }
  ],
  "transition": {
    "from_step": "verify",
    "to_step": "implement",
    "status": "blocked",
    "gate_id": "verify-gate"
  }
}
```

Definitions that do not declare stricter route or gate policy keep the permissive v0.1 behavior. Route reason ids remain open unless a gate declares a closed route policy such as `route_back_policy.allow_unknown_reasons: false`. Attempt counting is deterministic: Flow derives attempts from persisted `state.transitions`, not caller-supplied counters.

Flow Agents consumes this contract downstream when writing its own workflow state, but Flow does not know about Flow Agents sidecars, GitHub pull requests, boards, or any other provider. A Builder Kit-like path such as `verify -> evidence -> publish-change -> release-readiness -> merge` is just a Flow Definition with steps and gates; Flow rejects jumps across required gates because the proposed transition does not match the definition and evidence state, not because those names are special.

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

For an adversarial-review pattern, see the reference definition in `examples/adversarial-pass-flow.json` and the boundary notes in [docs/adversarial-pass.md](docs/adversarial-pass.md). The example models `produce -> adversarial-review -> resolve`, routes adversarial defect reasons back to the documented steps, and treats external Survey escalation records as per-round evidence while Flow owns only orchestration, route-back policy, and transition accounting.

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
  validateRunTransition,
  validateDefinitionWithDiagnostics
} from "@kontourai/flow";

const result = validateDefinitionWithDiagnostics(definition);
if (!result.valid) console.error(result.diagnostics);

const transitionResult = validateRunTransition({
  definition,
  current_state: state,
  proposed_transition: { from_step: "verify", to_step: "publish", gate_id: "verify-gate" },
  manifest
});
if (!transitionResult.valid) console.error(transitionResult.diagnostics);
```

Config merge helpers are exported for local installers and adapters:

```js
import {
  previewFlowConfigMerge,
  applyFlowConfigMerge,
  renderConfigMergeMarkdown
} from "@kontourai/flow";

const report = previewFlowConfigMerge(localConfig, proposedConfig);
console.log(renderConfigMergeMarkdown(report));
```

## Schemas

Runtime code and tests reference the JSON Schemas in `schemas/`:

- `flow-definition.schema.json`
- `flow-run.schema.json`
- `gate-evidence.schema.json`
- `flow-report.schema.json`
- `flow-transition-validation-request.schema.json`
- `flow-transition-validation-result.schema.json`

`npm test` and `npm pack` fail if the checked schemas drift from the v0.1 runtime contract.

## Boundaries

Flow is not an agent runtime, multi-agent orchestrator, task board, repo standards engine, hosted service, or web UI. Surface owns portable trust state, Veritas owns repo readiness semantics, and Flow Agents owns agent-facing workflow distribution.
