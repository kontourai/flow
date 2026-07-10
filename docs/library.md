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

The package root exports the public contract types — among them `FlowDefinition`, `FlowRunState`, `FlowGate`, `FlowExpectation`, `FlowEvidenceEntry`, `FlowEvidenceManifest`, `GateOutcome`, `FlowDiagnostic`, `TransitionValidationResult`, `ReleaseReadinessPolicy`, `ReleaseReadinessResult`, `VersionReleaseReport`, `ConfigMergeReport`, and the `FlowConsole*Projection` family. It also exports `flowRoot()`, `flowConfigPath()`, `flowRuntimeRoot()`, and canonical `runDir()` path helpers. The corresponding JSON Schemas live in [`schemas/`](../schemas/), and `npm test` fails if the runtime drifts from them. See [Runtime Roots](runtime-roots.md) for the semver-major `runDir()` contract and compatibility guidance.
