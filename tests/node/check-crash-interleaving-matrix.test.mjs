/**
 * flow#225 — crash-interleaving test matrix for recovery fences and atomic run writes.
 *
 * Flow's recovery-fence and atomic-write hardening has been reactive — each
 * release fixed one more field-discovered crash interleaving. This test takes
 * the opposite posture: enumerate the interleavings, then test the matrix.
 *
 * For every mutating operation, we inject a crash at each boundary between
 * durable writes (between staging steps, between commit renames, and after the
 * last commit but before the directory fsync) and then assert convergence:
 *
 *   - the run is either absent, fully pre-operation, or fully post-operation
 *     — never torn (state.json and manifest.json never disagree about an
 *     attached evidence entry; a gate outcome never references an evidence id
 *     the manifest lacks);
 *   - listRuns / listRunsWithDiagnostics never silently drops the run without
 *     a diagnostic;
 *   - a subsequent evaluation converges to a deterministic outcome (the same
 *     evaluation repeated twice yields the same outcome).
 *
 * The fault-injection bar: a known-bad (deliberately torn) write path is caught
 * by the harness — proving the matrix is discriminating, not vacuous.
 */
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  __setPublishRunArtifactsFaultHooks,
  acceptException,
  amendRunDefinition,
  attachEvidence,
  authorizeRetry,
  cancelRun,
  definitionDigest,
  effectiveDefinitionIdentity,
  evaluateRun,
  findGate,
  flowRunHead,
  flowTransitionRef,
  listRunsWithDiagnostics,
  loadRun,
  pauseRun,
  resumeRun,
  startRun
} from "../../dist/index.js";
import { routeBackDefinition } from "./helpers/route-back-fixtures.mjs";

const definitionPath = new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;
const EVAL_NOW = "2026-07-10T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function planBundle(index) {
  return {
    schemaVersion: 5,
    source: `crash-matrix/${index}`,
    claims: [{
      id: `claim.builder.acceptance.${index}`,
      subjectType: "flow-step",
      subjectId: "builder.plan",
      facet: "process",
      claimType: "builder.acceptance",
      fieldOrBehavior: "acceptanceCriteria",
      value: true,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }],
    evidence: [{
      id: `evidence.${index}`,
      claimId: `claim.builder.acceptance.${index}`,
      evidenceType: "attestation",
      method: "attestation",
      sourceRef: `crash-matrix:${index}`,
      excerptOrSummary: "x".repeat(2000),
      observedAt: "2026-07-10T00:00:00.000Z",
      collectedBy: "test"
    }],
    events: [{
      id: `event.${index}`,
      claimId: `claim.builder.acceptance.${index}`,
      status: "verified",
      type: "verification",
      actor: "test",
      method: "attestation",
      evidenceIds: [`evidence.${index}`],
      createdAt: "2026-07-10T00:00:00.000Z",
      verifiedAt: "2026-07-10T00:00:00.000Z"
    }],
    policies: []
  };
}

async function freshCwd(prefix) {
  return mkdtemp(path.join(tmpdir(), `flow-crash-matrix-${prefix}-`));
}

async function setupRun(runId, cwd) {
  return startRun(definitionPath, { cwd, runId });
}

async function attachPlanEvidence(runId, cwd, index = 0) {
  const source = path.join(cwd, `bundle-${index}.json`);
  await writeFile(source, `${JSON.stringify(planBundle(index))}\n`);
  return attachEvidence(runId, {
    cwd,
    gate: "plan-gate",
    file: source,
    kind: "trust.bundle",
    bundle: true
  });
}

/** Build a publishRunArtifacts hooks object that throws at the named crash point. */
function makePublishHook(crashPoint) {
  return {
    afterStage: (index) => {
      if (crashPoint === `afterStage:${index}`) throw new Error(`crash:${crashPoint}`);
    },
    afterCommit: (index) => {
      if (crashPoint === `afterCommit:${index}`) throw new Error(`crash:${crashPoint}`);
    },
    afterDirectoryFsync: () => {
      if (crashPoint === "afterDirectoryFsync") throw new Error(`crash:${crashPoint}`);
    }
  };
}

/** Build a faultInjection function that throws at the named stage. */
function makeFaultInjection(crashPoint) {
  return (stage) => {
    if (stage === crashPoint) throw new Error(`crash:${crashPoint}`);
  };
}

// ---------------------------------------------------------------------------
// Convergence harness
// ---------------------------------------------------------------------------

/**
 * Assert the four convergence invariants after a simulated crash:
 *   1. No torn state (state/manifest coherence).
 *   2. listRuns never silently drops the run without a diagnostic.
 *   3. (fence consistency is covered by loadRun's fence-read wrapper).
 *   4. A subsequent evaluation converges to a deterministic outcome.
 */
async function assertConvergence(runId, cwd, label) {
  // Invariant 2: listRuns / listRunsWithDiagnostics never silently drops the run.
  const listed = await listRunsWithDiagnostics(cwd);
  const runInList = listed.runs.some((r) => r.run_id === runId);
  const diagForRun = listed.diagnostics.find((d) => d.run_id === runId);

  let run;
  try {
    run = await loadRun(runId, cwd);
  } catch (error) {
    // The run is absent or incomplete — convergent as long as listRuns
    // reports a diagnostic rather than silently dropping it.
    assert.ok(diagForRun,
      `${label}: run ${runId} was silently dropped by listRuns without a diagnostic (load error: ${error.message})`);
    return;
  }

  // The run loaded — listRuns should list it, not just diagnose it.
  assert.ok(runInList,
    `${label}: run ${runId} loaded successfully but listRuns did not list it`);

  // Invariant 1: no torn state — every evidence_ref in gate_outcomes must
  // exist in the evidence manifest.
  const manifestEvidenceIds = new Set((run.manifest.evidence ?? []).map((e) => e.id));
  for (const outcome of run.state.gate_outcomes ?? []) {
    for (const ref of outcome.evidence_refs ?? []) {
      assert.ok(manifestEvidenceIds.has(ref),
        `${label}: TORN — gate outcome ${outcome.gate_id} references evidence ${ref} absent from manifest`);
    }
  }
  // Manifest evidence entries must reference gates that exist in the definition.
  for (const entry of run.manifest.evidence ?? []) {
    assert.ok(findGate(run.definition, entry.gate_id),
      `${label}: TORN — manifest evidence ${entry.id} references unknown gate ${entry.gate_id}`);
  }

  // Invariant 4: a subsequent evaluation converges to a deterministic outcome.
  // Only check when the run is in an evaluable lifecycle state.
  if (["active", "blocked", "accepted_by_exception"].includes(run.state.status)) {
    await assertDeterministicEvaluation(runId, cwd, label);
  }
}

/**
 * Evaluate the run on two independent copies of the run directory and assert
 * both evaluations produce identical outcomes. This proves the post-crash
 * state is deterministic — the same evaluation always yields the same result.
 */
async function assertDeterministicEvaluation(runId, cwd, label) {
  const srcRunsDir = path.join(cwd, ".kontourai", "flow", "runs");
  const tempDir = await mkdtemp(path.join(tmpdir(), "flow-determinism-"));
  try {
    // Copy the full .kontourai/flow/runs tree so the copy is a self-contained
    // Flow project. The .flow config directory is optional — loadFlowConfig
    // falls back to defaultFlowConfig() when it is absent.
    await cp(srcRunsDir, path.join(tempDir, ".kontourai", "flow", "runs"), { recursive: true });
    if (existsSync(path.join(cwd, ".flow"))) {
      await cp(path.join(cwd, ".flow"), path.join(tempDir, ".flow"), { recursive: true });
    }

    let outcomeA, outcomeB, errorA, errorB;
    try {
      const result = await evaluateRun(runId, { cwd, now: EVAL_NOW });
      outcomeA = result.outcomes;
    } catch (error) {
      errorA = error;
    }
    try {
      const result = await evaluateRun(runId, { cwd: tempDir, now: EVAL_NOW });
      outcomeB = result.outcomes;
    } catch (error) {
      errorB = error;
    }

    if (errorA || errorB) {
      assert.ok(errorA && errorB,
        `${label}: evaluation was non-deterministic — one copy threw and the other did not`);
      assert.equal(errorA.message, errorB.message,
        `${label}: evaluation errors diverged — non-deterministic post-crash state`);
    } else {
      assert.deepEqual(outcomeA, outcomeB,
        `${label}: evaluation outcomes diverged — non-deterministic post-crash state`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Drive the crash-interleaving matrix for one operation.
 *
 * @param label - test label prefix
 * @param crashPoints - array of crash-point strings
 * @param runFault - function(crashPoint, cwd) that sets the fault, calls the
 *   mutating operation, and expects it to throw
 * @param setup - async function(runId, cwd) that creates the pre-operation
 *   fixture (a started run, possibly with evidence)
 */
async function runMatrix(label, crashPoints, setup, runFault) {
  try {
    for (const crashPoint of crashPoints) {
      const cwd = await freshCwd(label);
      const runId = `matrix-${label}-${crashPoint.replace(/[^a-zA-Z0-9]/g, "_")}`;
      try {
        await setup(runId, cwd);
        await runFault(crashPoint, cwd, runId);
        // The fault should have thrown — if we get here, the fault was not
        // triggered, which is a test harness bug.
        assert.fail(`${label}: crash point ${crashPoint} did not throw — harness bug`);
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        // Expected: the injected fault threw. Now check convergence.
      }
      await assertConvergence(runId, cwd, `${label}/${crashPoint}`);
    }
  } finally {
    // Always clear module-level hooks, even if a crash point's convergence
    // check threw — otherwise stale hooks poison subsequent tests.
    __setPublishRunArtifactsFaultHooks(undefined);
  }
}

// ---------------------------------------------------------------------------
// saveRun publishes 4 entries: report.json(0), report.md(1), manifest.json(2),
// state.json(3). Crash points cover every stage boundary.
// ---------------------------------------------------------------------------

const SAVE_RUN_CRASH_POINTS = [
  "afterStage:0", "afterStage:1", "afterStage:2", "afterStage:3",
  "afterCommit:0", "afterCommit:1", "afterCommit:2", "afterCommit:3",
  "afterDirectoryFsync"
];

// saveLifecycleState publishes 3 entries: report.json(0), report.md(1),
// state.json(2).
const SAVE_LIFECYCLE_CRASH_POINTS = [
  "afterStage:0", "afterStage:1", "afterStage:2",
  "afterCommit:0", "afterCommit:1", "afterCommit:2",
  "afterDirectoryFsync"
];

// ---------------------------------------------------------------------------
// Matrix row: startRun
// ---------------------------------------------------------------------------

const START_RUN_CRASH_POINTS = [
  "before_definition", "before_state", "before_manifest", "before_reports"
];

test("matrix: startRun crash-interleaving", async () => {
  await runMatrix(
    "startRun",
    START_RUN_CRASH_POINTS,
    () => {}, // no pre-setup needed
    async (crashPoint, cwd, runId) => {
      await startRun(definitionPath, {
        cwd,
        runId,
        faultInjection: makeFaultInjection(crashPoint)
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Matrix row: attachEvidence
// ---------------------------------------------------------------------------

test("matrix: attachEvidence crash-interleaving", async () => {
  await runMatrix(
    "attachEvidence",
    SAVE_RUN_CRASH_POINTS,
    async (runId, cwd) => {
      await setupRun(runId, cwd);
      // Prepare the evidence source file so the fault is in saveRun, not in
      // the evidence file read.
      const source = path.join(cwd, "bundle.json");
      await writeFile(source, `${JSON.stringify(planBundle(0))}\n`);
    },
    async (crashPoint, cwd, runId) => {
      const source = path.join(cwd, "bundle.json");
      __setPublishRunArtifactsFaultHooks(makePublishHook(crashPoint));
      await attachEvidence(runId, {
        cwd,
        gate: "plan-gate",
        file: source,
        kind: "trust.bundle",
        bundle: true
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Matrix row: evaluateRun
// ---------------------------------------------------------------------------

test("matrix: evaluateRun crash-interleaving", async () => {
  await runMatrix(
    "evaluateRun",
    SAVE_RUN_CRASH_POINTS,
    async (runId, cwd) => {
      await setupRun(runId, cwd);
      await attachPlanEvidence(runId, cwd);
    },
    async (crashPoint, cwd, runId) => {
      __setPublishRunArtifactsFaultHooks(makePublishHook(crashPoint));
      await evaluateRun(runId, { cwd, now: EVAL_NOW });
    }
  );
});

// ---------------------------------------------------------------------------
// Matrix row: acceptException
// ---------------------------------------------------------------------------

test("matrix: acceptException crash-interleaving", async () => {
  await runMatrix(
    "acceptException",
    SAVE_RUN_CRASH_POINTS,
    async (runId, cwd) => {
      await setupRun(runId, cwd);
    },
    async (crashPoint, cwd, runId) => {
      __setPublishRunArtifactsFaultHooks(makePublishHook(crashPoint));
      await acceptException(runId, {
        cwd,
        gate: "plan-gate",
        reason: "accepted for crash-matrix testing",
        authority: {
          kind: "operator_request",
          actor: "operator:test",
          request_ref: "request:crash-matrix-accept",
          requested_at: "2026-07-10T00:00:00.000Z"
        }
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Matrix row: amendRunDefinition
// ---------------------------------------------------------------------------

const amendmentDefinition = {
  id: "crash-matrix-amendment",
  version: "1",
  steps: [{ id: "plan", next: "execute" }, { id: "execute", next: null }],
  gates: {
    "execute-gate": { step: "execute", expects: [], on_route_back: { default: "execute" } }
  }
};

function amendmentSuccessor() {
  const next = structuredClone(amendmentDefinition);
  next.version = "amended-v2";
  next.gates["execute-gate"].on_route_back.plan_gap = "plan";
  return next;
}

function amendmentRequest(before, next, requestRef = "request:crash-matrix-amend") {
  return {
    reason: "Amend for crash matrix.",
    expected_run_head: flowRunHead(before.state),
    expected_definition: effectiveDefinitionIdentity(before.startDefinition, before.state),
    successor_digest: definitionDigest(next),
    authority: {
      kind: "operator_request",
      actor: "operator:test",
      request_ref: requestRef,
      requested_at: "2026-07-10T00:00:00.000Z"
    }
  };
}

const AMEND_CRASH_POINTS = [
  "before_stage_report_json",
  "before_stage_report_markdown",
  "before_stage_state",
  "before_rename_report_json",
  "before_rename_report_markdown",
  "before_rename_state"
];

test("matrix: amendRunDefinition crash-interleaving", async () => {
  await runMatrix(
    "amendRunDefinition",
    AMEND_CRASH_POINTS,
    async (runId, cwd) => {
      const defPath = path.join(cwd, "definition.json");
      await writeFile(defPath, `${JSON.stringify(amendmentDefinition, null, 2)}\n`);
      await startRun(defPath, { cwd, runId, params: { subject: "crash-matrix amendment" } });
    },
    async (crashPoint, cwd, runId) => {
      const before = await loadRun(runId, cwd);
      const next = amendmentSuccessor();
      // Use a unique request_ref per crash point so replays don't conflict.
      const req = amendmentRequest(before, next, `request:crash-matrix-${crashPoint}`);
      await amendRunDefinition(runId, {
        cwd,
        request: req,
        definition: next,
        faultInjection: makeFaultInjection(crashPoint)
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Matrix row: authorizeRetry
// ---------------------------------------------------------------------------

/**
 * Set up a run in the "blocked by exhausted route-back" state that
 * authorizeRetry requires. Mirrors the exhaustedRun helper from the retry
 * authorization test.
 */
async function setupExhaustedRun(runId, cwd) {
  const definition = routeBackDefinition({ route_back_policy: { max_attempts: 3, on_exceeded: "block" } });
  const defPath = path.join(cwd, "flow.json");
  await writeFile(defPath, `${JSON.stringify(definition)}\n`);
  const started = await startRun(defPath, { cwd, runId });
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.status = "blocked";
  state.current_step = "verify";
  state.gate_outcomes = [{
    gate_id: "verify-gate", status: "block", summary: "budget exhausted",
    evidence_refs: [], route_reason: "implementation_defect",
    selected_route: "implement", attempt: 4, max_attempts: 3, limit_exceeded: true
  }];
  state.gate_outcome_history = [
    { gate_id: "verify-gate", status: "pass", summary: "prior verified visit", evidence_refs: ["ev.prior"] },
    structuredClone(state.gate_outcomes[0])
  ];
  state.transitions = [
    { from_step: "verify", to_step: "recover", status: "allowed", reason: "prior evidence present", at: "2026-07-19T14:59:00.000Z", gate_id: "verify-gate" },
    ...[1, 2, 3, 4].map((attempt) => ({
      type: "route_back", from_step: "verify", to_step: "implement", status: "blocked",
      reason: "implementation_defect", route_reason: "implementation_defect",
      selected_route: "implement", attempt, max_attempts: 3, limit_exceeded: attempt === 4,
      gate_id: "verify-gate", at: `2026-07-19T15:0${attempt}:00.000Z`
    }))
  ];
  state.updated_at = "2026-07-19T15:04:00.000Z";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const loaded = await loadRun(runId, cwd);
  const block = loaded.state.transitions.at(-1);
  return {
    request: {
      reason: "Operator approved one additional bounded round.",
      target_step: "implement",
      blocked_transition_ref: flowTransitionRef(block),
      expected_run_head: flowRunHead(loaded.state),
      authority: {
        kind: "operator_request", actor: "operator:test",
        request_ref: "request:crash-matrix-retry",
        requested_at: "2026-07-19T15:05:00.000Z"
      }
    }
  };
}

const RETRY_CRASH_POINTS = [
  "before_stage_report_json",
  "before_stage_report_markdown",
  "before_stage_state",
  "before_rename_report_json",
  "before_rename_report_markdown",
  "before_rename_state"
];

test("matrix: authorizeRetry crash-interleaving", async () => {
  await runMatrix(
    "authorizeRetry",
    RETRY_CRASH_POINTS,
    async (runId, cwd) => {
      await setupExhaustedRun(runId, cwd);
    },
    async (crashPoint, cwd, runId) => {
      const loaded = await loadRun(runId, cwd);
      const block = loaded.state.transitions.at(-1);
      const req = {
        reason: "Operator approved one additional bounded round.",
        target_step: "implement",
        blocked_transition_ref: flowTransitionRef(block),
        expected_run_head: flowRunHead(loaded.state),
        authority: {
          kind: "operator_request", actor: "operator:test",
          request_ref: `request:crash-matrix-retry-${crashPoint}`,
          requested_at: "2026-07-19T15:05:00.000Z"
        }
      };
      await authorizeRetry(runId, {
        cwd,
        request: req,
        faultInjection: makeFaultInjection(crashPoint)
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Matrix row: pauseRun / resumeRun / cancelRun
// ---------------------------------------------------------------------------

const lifecycleAuthority = {
  kind: "operator_request",
  actor: "operator:test",
  request_ref: "request:crash-matrix-lifecycle",
  requested_at: "2026-07-10T00:00:00.000Z"
};

test("matrix: pauseRun crash-interleaving", async () => {
  await runMatrix(
    "pauseRun",
    SAVE_LIFECYCLE_CRASH_POINTS,
    async (runId, cwd) => {
      await setupRun(runId, cwd);
    },
    async (crashPoint, cwd, runId) => {
      __setPublishRunArtifactsFaultHooks(makePublishHook(crashPoint));
      await pauseRun(runId, { cwd, reason: "crash matrix", authority: lifecycleAuthority });
    }
  );
});

test("matrix: resumeRun crash-interleaving", async () => {
  await runMatrix(
    "resumeRun",
    SAVE_LIFECYCLE_CRASH_POINTS,
    async (runId, cwd) => {
      await setupRun(runId, cwd);
      await pauseRun(runId, { cwd, reason: "setup for resume", authority: lifecycleAuthority });
    },
    async (crashPoint, cwd, runId) => {
      __setPublishRunArtifactsFaultHooks(makePublishHook(crashPoint));
      await resumeRun(runId, { cwd, authority: lifecycleAuthority });
    }
  );
});

test("matrix: cancelRun crash-interleaving", async () => {
  await runMatrix(
    "cancelRun",
    SAVE_LIFECYCLE_CRASH_POINTS,
    async (runId, cwd) => {
      await setupRun(runId, cwd);
    },
    async (crashPoint, cwd, runId) => {
      __setPublishRunArtifactsFaultHooks(makePublishHook(crashPoint));
      await cancelRun(runId, { cwd, reason: "crash matrix", authority: lifecycleAuthority });
    }
  );
});

// ---------------------------------------------------------------------------
// Known-bad proof: a deliberately torn state is caught by the harness.
//
// A non-atomic writer that commits state.json BEFORE manifest.json (reversed
// order) creates a tear: state.json has gate outcomes referencing evidence
// that manifest.json does not yet carry. The convergence harness MUST detect
// this — a matrix that passes against broken code has proven nothing.
// ---------------------------------------------------------------------------

test("known-bad: reversed commit order (state before manifest) is caught by the convergence harness", async () => {
  __setPublishRunArtifactsFaultHooks(undefined);
  const cwd = await freshCwd("known-bad");
  const runId = "known-bad";
  const run = await setupRun(runId, cwd);

  // Read the current (pre-operation) state and manifest.
  const statePath = path.join(run.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));

  // Simulate a non-atomic writer with REVERSED commit order: state.json is
  // committed with a gate outcome referencing an evidence id that manifest.json
  // does not yet carry (the manifest write was interrupted). This is exactly
  // the tear that committing state before manifest would produce.
  state.gate_outcomes = [{
    gate_id: "plan-gate",
    status: "pass",
    summary: "Simulated post-operation outcome with evidence reference.",
    evidence_refs: ["ev.torn.1"],
    matched_expectations: [{ expectation_id: "acceptance-criteria", evidence_id: "ev.torn.1" }],
    optional_missing: [],
    at: EVAL_NOW
  }];
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  // The convergence harness MUST detect this tear. If it passes, the matrix
  // is vacuous — it would accept a known-broken write path.
  await assert.rejects(
    () => assertConvergence(runId, cwd, "known-bad-reversed-commit"),
    /TORN/
  );
});

// ---------------------------------------------------------------------------
// Known-bad proof: a truncated (partially written) state.json — the classic
// non-atomic truncate-then-write failure — is caught by the convergence harness.
// ---------------------------------------------------------------------------

test("known-bad: truncated state.json (non-atomic truncate-then-write) is caught by the convergence harness", async () => {
  __setPublishRunArtifactsFaultHooks(undefined);
  const cwd = await freshCwd("known-bad-truncated");
  const runId = "known-bad-truncated";
  const run = await setupRun(runId, cwd);

  // Overwrite state.json with a partial JSON body — exactly what a crash
  // during truncate-then-write leaves behind.
  const statePath = path.join(run.dir, "state.json");
  const fullState = await readFile(statePath, "utf8");
  const truncated = fullState.slice(0, Math.floor(fullState.length / 2));
  await writeFile(statePath, truncated);

  // The harness must detect this: loadRun will throw (invalid JSON), and
  // listRunsWithDiagnostics must report a diagnostic (not silently drop).
  const listed = await listRunsWithDiagnostics(cwd);
  const diagForRun = listed.diagnostics.find((d) => d.run_id === runId);
  assert.ok(diagForRun,
    "known-bad-truncated: run was silently dropped by listRuns without a diagnostic for a corrupted state.json");
  assert.ok(!listed.runs.some((r) => r.run_id === runId),
    "known-bad-truncated: a run with corrupted state.json must not appear in listRuns");
});
