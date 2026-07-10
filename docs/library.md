# Library

`@kontourai/flow` exports the same primitives the CLI uses, fully typed for TypeScript. Public usage is limited to the package root and the `flow` CLI — `dist/` subpaths are implementation output, not API.

```ts
import {
  startRun,
  attachEvidence,
  evaluateRun,
  loadRun,
  validateDefinitionWithDiagnostics,
  validateRunTransition
} from "@kontourai/flow";
```

## Run lifecycle

```ts
import { startRun, attachEvidence, evaluateRun, loadRun, acceptException, listRuns } from "@kontourai/flow";

const { runId, state } = await startRun(".flow/definitions/agent-dev-flow.json", {
  cwd: process.cwd(),
  runId: "dev-1847",
  params: { subject: "feature-search-filters" }
});

await attachEvidence("dev-1847", {
  gate: "plan-gate",
  file: "./acceptance-claim.json",
  trustArtifact: true
});

const result = await evaluateRun("dev-1847");
console.log(result.state.current_step, result.state.next_action);

const run = await loadRun("dev-1847"); // { dir, definition, state, manifest, config }
```

These functions read and write the same `.kontourai/flow/runs/<run-id>/` files as the CLI, so library and CLI usage interleave freely — an agent harness can attach evidence programmatically while a human inspects with `flow status`. They do not fall back to `.flow/runs/`; migrate generated state from older versions before loading it.

Use `listRunsWithDiagnostics(cwd)` when corrupt or incomplete canonical entries must be surfaced alongside valid run summaries. `listRuns(cwd)` preserves the original summaries-only return shape.

### Pause, resume, and cancellation

```ts
import { pauseRun, resumeRun, cancelRun, FlowLifecycleError } from "@kontourai/flow";

const authority = {
  kind: "user_request" as const,
  actor: "user:brian",
  request_ref: "conversation:01J2/request:42",
  requested_at: "2026-07-10T12:00:00.000Z"
};

await pauseRun("dev-1847", {
  cwd: process.cwd(),
  reason: "The user asked to pause.",
  authority
});

await resumeRun("dev-1847", {
  cwd: process.cwd(),
  reason: "The user asked to continue.",
  authority: { ...authority, request_ref: "conversation:01J2/request:43" }
});

const canceled = await cancelRun("dev-1847", {
  cwd: process.cwd(),
  reason: "The user asked to stop.",
  authority: { ...authority, request_ref: "conversation:01J2/request:44" }
});
console.log(canceled.idempotent); // false on the first application
```

Lifecycle operations preserve `current_step`, Step `transitions`, gate
outcomes, evidence, and exceptions. Pause records whether the run was `active`,
`blocked`, or `needs_decision`; resume accepts only `paused` and restores that
exact status. Cancellation accepts declared nonterminal states including
`paused` and produces the terminal `canceled` status. Evaluation and Step
advancement reject both `paused` and `canceled` before freshness derivation or
persistence, and readiness returns an empty frontier.

All operations require the same structured external authority record as the
CLI. Flow accepts only `user_request` and `operator_request`; a calling product
must authenticate the actor and preserve the immutable request reference. Flow
does not infer an invoking agent's authority. Invalid requests throw
`FlowLifecycleError`, whose `code` and `diagnostics` use stable
`flow.lifecycle.*` identifiers. Exact cancellation replay returns the existing
event with `idempotent: true` and does not write. A conflicting replay throws
`flow.lifecycle.replay.conflict`, also without writing.

Lifecycle audit text is bounded printable Unicode: `actor` is limited to 256
characters, `request_ref` to 2048, and `reason` to 4096. C0, DEL, and C1 control
characters (including CR/LF and terminal ESC/OSC sequences) are rejected.
Markdown and shell punctuation remain inert data and are escaped when rendered.

The `state.lifecycle` ledger is distinct from Step `transitions`. A run created
by an older compatible release may omit `lifecycle`; `loadRun` normalizes that
absence to `[]` in memory without creating a second compatibility API or
rewriting the file. A present malformed ledger fails schema validation instead
of being repaired. Canonical validation also rejects broken event sequences,
incorrect prior-status restoration, status/latest-event disagreement, and
terminal cancellation reversal. Generic persistence is internal; public
consumers mutate canonical runs only through guarded domain operations.
Ordinary Flow evaluation may move among resumable statuses between lifecycle
events. Resume still pairs with and restores the most recent unmatched pause;
paused intervals accept only their matching resume or cancellation, and no
event may follow cancellation.

Lifecycle persistence is fail-closed before its first write: Flow validates the
request and eligibility and computes canonical state plus both report
projections first. The local file store then writes `state.json`, `report.json`,
and `report.md` sequentially. It is a single-writer filesystem contract, not a
multi-file transaction; an exceptional I/O failure between writes can leave a
stale derived report. Reload canonical `state.json` and regenerate reports
before retrying. Consumers must not run concurrent mutations against one run.
Lifecycle output targets use no-follow descriptor writes and regular-file
verification. This closes target-symlink swaps without expanding the trusted
single-writer boundary into a hostile multi-writer filesystem guarantee.

Flow owns canonical lifecycle validation and persistence only. Authentication,
provider updates, assignment release, artifact archival, and branch/worktree
cleanup belong to the calling consumer.

## Validation

```ts
import { validateDefinition, validateDefinitionWithDiagnostics, validateRunTransition } from "@kontourai/flow";

// pass/throw API
validateDefinition(definition);

// diagnostics API
const result = validateDefinitionWithDiagnostics(definition);
if (!result.valid) console.error(result.diagnostics);

// provider-neutral transition legality
const transition = validateRunTransition({
  definition,
  current_state: state,
  proposed_transition: { from_step: "verify", to_step: "publish", gate_id: "verify-gate" },
  manifest
});
if (!transition.valid) console.error(transition.diagnostics);
```

## Console projection

`projectFlowRunFromFiles` is the Flow boundary for console consumers: read-only, local-file-first, and deterministic. It reads authoritative `definition.json`, `state.json`, and `evidence/manifest.json`, then re-derives the report view instead of trusting disposable `report.json`. It preserves explicit external refs (Surface, Veritas, artifacts, pull requests, CI, release reports) when they already exist in authoritative run files — it never synthesizes refs from git, network calls, or Markdown parsing.

```ts
import { projectFlowRunFromFiles, startFlowConsoleServer } from "@kontourai/flow";

const projection = await projectFlowRunFromFiles("dev-1847", { cwd: process.cwd() });
console.log(projection.current_step);
console.log(projection.gates);

// or serve the packaged local console programmatically
const server = await startFlowConsoleServer({ runId: "dev-1847", cwd: process.cwd(), port: 0 });
console.log(server.url);
await server.close();
```

The packaged local console uses this same projection. Hosted behavior and companion console startup are outside the v0.1 package boundary.

## Release readiness and reports

```ts
import {
  evaluateReleaseReadiness,
  changeManagementFixtureAdapter,
  deploymentWindowFixtureAdapter,
  freezeStateFixtureAdapter,
  projectVersionReleaseReport,
  renderVersionReleaseReportMarkdown
} from "@kontourai/flow";
```

See [Release Readiness](release-readiness.md) for a worked example against the bundled scenario fixtures.

## Config merge

```ts
import {
  previewFlowConfigMerge,
  applyFlowConfigMerge,
  renderConfigMergeMarkdown
} from "@kontourai/flow";

const report = previewFlowConfigMerge(localConfig, proposedConfig);
console.log(renderConfigMergeMarkdown(report));
```

See [Project Config](project-config.md) for merge semantics and conflict handling.

## Types

The package root exports the public contract types — among them `FlowDefinition`, `FlowRunState`, `FlowRunStatus`, `FlowLifecycleAction`, `FlowLifecycleAuthority`, `FlowLifecycleEvent`, `FlowLifecycleRequest`, `FlowLifecycleDiagnostic`, `FlowGate`, `FlowExpectation`, `FlowEvidenceEntry`, `FlowEvidenceManifest`, `GateOutcome`, `FlowDiagnostic`, `TransitionValidationResult`, `ReleaseReadinessPolicy`, `ReleaseReadinessResult`, `VersionReleaseReport`, `ConfigMergeReport`, and the `FlowConsole*Projection` family. It also exports `flowRoot()`, `flowConfigPath()`, `flowRuntimeRoot()`, and canonical `runDir()` path helpers. The corresponding JSON Schemas live in [`schemas/`](../schemas/), and `npm test` fails if the runtime drifts from them. See [Runtime Roots](runtime-roots.md) for the semver-major `runDir()` contract and compatibility guidance.
