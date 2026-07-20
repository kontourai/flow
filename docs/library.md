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
  file: "./acceptance-bundle.json",
  kind: "trust.bundle"
});

const result = await evaluateRun("dev-1847");
console.log(result.state.current_step, result.state.next_action);

const run = await loadRun("dev-1847"); // { dir, definition, state, manifest, config }
```

These functions read and write the same `.kontourai/flow/runs/<run-id>/` files as the CLI, so library and CLI usage interleave freely — an agent harness can attach evidence programmatically while a human inspects with `flow status`. They do not fall back to `.flow/runs/`; migrate generated state from older versions before loading it.

### Pure trust attachment reducer

`reduceTrustAttachment()` is the separately versioned `1.0.0` reducer for an
OS-owned lifecycle coordinator. It accepts canonical in-memory run state,
manifest, bundle, attachment metadata (including ID, source digest, and
timestamp), an explicit `now`, and version-pinned Hachure/Surface dependency
adapters. It returns the next manifest/state, derived report, evaluation result,
and a complete descriptive write set. It never reads files, uses ambient time,
or performs network/process operations.

The reducer does not embed Hachure schema or Surface trust semantics. A caller
supplies the `hachure@0.15.0` schema validator and `@kontourai/surface@2.12.0`
validator/report builder as explicit dependencies; `FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES`
is Flow's adapter for those locked package versions. Pin the published package
integrity plus `trustAttachmentReducerIdentity()` when a privileged coordinator
needs a stable reducer contract. The identity hash binds the reducer API version
and dependency versions, while package integrity binds the artifact bytes.

### Authorized definition amendment

`amendRunDefinition` changes the effective definition for an active run without
replacing that run. Read the exact state and effective identity first, have the
consumer authenticate its authority, then submit a complete successor and
request. `definition.json` and evidence remain immutable start artifacts.

```ts
import { amendRunDefinition, definitionDigest, effectiveDefinitionIdentity, flowRunHead, loadRun } from "@kontourai/flow";

const run = await loadRun("dev-1847");
const successor = { ...run.definition, version: "corrected-opaque-version" };
await amendRunDefinition("dev-1847", {
  definition: successor,
  request: {
    reason: "Authorized route correction.",
    expected_run_head: flowRunHead(run.state),
    expected_definition: effectiveDefinitionIdentity(run.startDefinition, run.state),
    successor_digest: definitionDigest(successor),
    authority: { kind: "operator_request", actor: "operator:42", request_ref: "request:42", requested_at: "2026-07-20T05:00:00.000Z" }
  }
});
```

The request is exact-head and non-idempotent: stale heads or a reused
`request_ref` reject without mutation. Flow validates the neutral authority
record but does not authenticate the actor. The repository decision record
`docs/decisions/definition-amendment.md` carries the durable rationale.

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
before retrying. Flow serializes public same-run mutations with the shared
owner-recorded mutation lock; consumers still must not write run files directly.
Lifecycle output targets use no-follow descriptor writes and regular-file
verification. This closes target-symlink swaps without expanding the trusted
single-writer boundary into a hostile multi-writer filesystem guarantee.

### Authorized retry epochs

`authorizeRetry()` recovers only the current exhausted `on_exceeded: "block"`
route-back on the same run. It appends a `retry_authorized` run transition,
moves the cursor only to that exhausted transition's `selected_route`, and
starts the next persisted retry epoch. It is separate from lifecycle resume and
does not pass a gate, accept an exception, remove failed history, or choose a
caller-selected recovery route.

```ts
import { authorizeRetry, flowRunHead, flowTransitionRef, loadRun } from "@kontourai/flow";

const run = await loadRun("dev-1847");
const block = run.state.transitions.at(-1);
const result = await authorizeRetry("dev-1847", {
  request: {
    reason: "Approved one additional bounded retry epoch.",
    target_step: block.selected_route,
    blocked_transition_ref: flowTransitionRef(block),
    expected_run_head: flowRunHead(run.state),
    authority: {
      kind: "operator_request",
      actor: "operator:alex",
      request_ref: "change-request:418",
      requested_at: "2026-07-19T15:30:00.000Z"
    }
  }
});
console.log(result.transition.retry_epoch); // 2
```

The matching request may be replayed exactly and returns the stored transition
without writing. A stale run head, forged block ref, wrong target, non-blocked
or terminal run, malformed authority, or changed request content under the
same `request_ref` fails before mutation. Flow records provider-neutral
authority but callers authenticate it. The stored `prior_run_head` is the
event-time optimistic-concurrency and audit binding copied from the request's
`expected_run_head`. Because local run state is unsigned, that value is not an
independently reconstructible post-persistence tamper-evidence guarantee;
authenticity requires a signature or an externally trusted append-only store.
Local unsigned state is a trusted persistence boundary: Flow rejects malformed
or partial reserved transition records and binds requests to event-time state,
but does not claim resistance to an attacker who rewrites an entire valid
ledger and recomputes every unsigned hash. Signed or externally anchored
history belongs to the trust layer tracked in
[#93](https://github.com/kontourai/flow/issues/93).
Routes without `retry_epoch` remain compatible epoch 1 records; later matching
failures count only within the new epoch.

All same-run state writers share an owner-recorded mutation lock. Each
contender owns a unique deterministically ordered ticket, release quarantines and removes only that
ticket, and stale recovery removes only a demonstrably dead ticket. Reclaimers
therefore never rename a shared canonical owner or detach a live successor.
New ticket roots permanently contain both a reserved foreign-host compatibility
`owner.json` sentinel and the `ticket-lock-v1` marker; neither is rewritten or
removed by ticket cleanup. An unmarked legacy root — including a dead, released,
malformed, live, or ownerless legacy owner — fails with
`flow.run_mutation.lock.migration_required` and Flow makes no change. A marked
root with a missing, malformed, or linked sentinel/marker likewise fails closed.
Perform any legacy-root cleanup only during an operator-confirmed quiescent
window after checking that no process can still use the run; never blindly
delete `.mutation.lock`. Live tickets serialize retry,
lifecycle, evidence, evaluation, and exception mutations. Retry authorization
reloads and rechecks the bound head inside that lock, derives its timestamp
internally, stages reports, and atomically replaces `state.json` as the final
commit point. Every report carries the represented `state_head`; a projection
observed across a crash boundary is current only when that value matches the
canonical state hash. `transitions` and
`gate_outcome_history` are audit ledgers; `gate_outcomes` is the compatible
current projection. Authorization removes the exhausted prior-epoch decision
from that current projection while retaining it in both audit ledgers. Reports
show the new epoch's evolving `consumed_attempts`, `next_attempt`, and
`remaining_attempts`, and distinguish current from historical epoch budgets.

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
