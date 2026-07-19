import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import * as flow from "../../dist/index.js";
import { withRunMutationLock } from "../../dist/runtime/flow-run-store.js";
import { execFile } from "./helpers/cli.mjs";
import { hashRunTree } from "./helpers/run-tree.mjs";
import { routeBackDefinition } from "./helpers/route-back-fixtures.mjs";

const cliPath = new URL("../../dist/cli.js", import.meta.url).pathname;

function passingTestsBundle() {
  return {
    schemaVersion: 5,
    source: "ci/verify",
    claims: [{
      id: "claim.quality.tests", subjectType: "flow-step", subjectId: "builder.verify",
      facet: "quality", claimType: "quality.tests", fieldOrBehavior: "testsPass", value: true,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }],
    evidence: [{
      id: "evidence.tests", claimId: "claim.quality.tests", evidenceType: "test_output",
      method: "validation", sourceRef: "ci:1", excerptOrSummary: "tests passed",
      observedAt: "2026-01-01T00:00:00.000Z", collectedBy: "ci"
    }],
    policies: [],
    events: [{
      id: "event.tests.verified", claimId: "claim.quality.tests", status: "verified", actor: "ci",
      method: "validation", evidenceIds: ["evidence.tests"], createdAt: "2026-01-01T00:00:00.000Z",
      verifiedAt: "2026-01-01T00:00:00.000Z"
    }]
  };
}

async function exhaustedRun(runId = "retry-authorization") {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-retry-auth-"));
  const definition = routeBackDefinition({ route_back_policy: { max_attempts: 3, on_exceeded: "block" } });
  const definitionPath = path.join(cwd, "flow.json");
  await writeFile(definitionPath, `${JSON.stringify(definition)}\n`);
  const started = await flow.startRun(definitionPath, { cwd, runId });
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.status = "blocked";
  state.current_step = "verify";
  state.gate_outcomes = [{ gate_id: "verify-gate", status: "block", summary: "budget exhausted", evidence_refs: [], route_reason: "implementation_defect", selected_route: "implement", attempt: 4, max_attempts: 3, limit_exceeded: true }];
  state.gate_outcome_history = [
    { gate_id: "verify-gate", status: "pass", summary: "prior verified visit", evidence_refs: ["ev.prior"] },
    structuredClone(state.gate_outcomes[0])
  ];
  state.transitions = [{ from_step: "verify", to_step: "recover", status: "allowed", reason: "prior evidence present", at: "2026-07-19T14:59:00.000Z", gate_id: "verify-gate" }, ...[1, 2, 3, 4].map((attempt) => ({
    type: "route_back", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", route_reason: "implementation_defect", selected_route: "implement", attempt, max_attempts: 3, limit_exceeded: attempt === 4, gate_id: "verify-gate", at: `2026-07-19T15:0${attempt}:00.000Z`
  }))];
  state.updated_at = "2026-07-19T15:04:00.000Z";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const loaded = await flow.loadRun(runId, cwd);
  const block = loaded.state.transitions.at(-1);
  const request = {
    reason: "Operator approved one additional bounded round.",
    target_step: "implement",
    blocked_transition_ref: flow.flowTransitionRef(block),
    expected_run_head: flow.flowRunHead(loaded.state),
    authority: { kind: "operator_request", actor: "operator:test", request_ref: "request:retry-1", requested_at: "2026-07-19T15:05:00.000Z" }
  };
  return { cwd, definition, started, request };
}

async function assertMutationLockAbsent(runDir) {
  await assert.rejects(
    () => lstat(path.join(runDir, ".mutation.lock")),
    (error) => error?.code === "ENOENT"
  );
}

async function assertPristineRetryRejection(fixture, request, expected) {
  await assertMutationLockAbsent(fixture.started.dir);
  const before = await hashRunTree(fixture.started.dir);
  await assert.rejects(
    () => flow.authorizeRetry(fixture.started.runId, { cwd: fixture.cwd, request }),
    expected
  );
  assert.equal(await hashRunTree(fixture.started.dir), before);
  await assertMutationLockAbsent(fixture.started.dir);
}

async function rewriteRetryState(fixture, mutate) {
  const statePath = path.join(fixture.started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  mutate(state);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return {
    ...fixture.request,
    blocked_transition_ref: flow.flowTransitionRef(state.transitions.at(-1)),
    expected_run_head: flow.flowRunHead(state)
  };
}

async function rewriteRetryDefinition(fixture, mutate) {
  const definitionPath = path.join(fixture.started.dir, "definition.json");
  const definition = JSON.parse(await readFile(definitionPath, "utf8"));
  mutate(definition);
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
}

async function addUnrelatedCanonicalRouteHistory(fixture, corrupt = undefined) {
  await rewriteRetryDefinition(fixture, (definition) => {
    definition.gates["plan-gate"] = {
      step: "plan", expects: [], on_route_back: { default: "plan" }
    };
    definition.gates["recover-gate"] = {
      step: "recover", expects: [], on_route_back: { default: "recover" },
      route_back_policy: { max_attempts: 1, on_exceeded: "plan" }
    };
  });
  return rewriteRetryState(fixture, (state) => {
    const unrelated = [
      {
        type: "route_back", from_step: "plan", to_step: "plan", status: "blocked",
        reason: "default", selected_route: "plan", attempt: 1, retry_epoch: 1,
        limit_exceeded: false, gate_id: "plan-gate", at: "2026-07-19T14:50:00.000Z"
      },
      {
        type: "route_back", from_step: "recover", to_step: "recover", status: "blocked",
        reason: "default", selected_route: "recover", attempt: 1, retry_epoch: 1,
        max_attempts: 1, limit_exceeded: false, gate_id: "recover-gate", at: "2026-07-19T14:51:00.000Z"
      },
      {
        type: "route_back", from_step: "recover", to_step: "plan", status: "blocked",
        reason: "default", selected_route: "recover", recovery_step: "plan", attempt: 2,
        retry_epoch: 1, max_attempts: 1, limit_exceeded: true,
        gate_id: "recover-gate", at: "2026-07-19T14:52:00.000Z"
      }
    ];
    corrupt?.(unrelated);
    state.transitions.splice(1, 0, ...unrelated);
  });
}

/**
 * Pinned pre-ticket fixture derived from the exact prior root algorithm:
 * `mkdir(.mutation.lock)` with an optional root owner.json and no ticket
 * marker/sentinel. It models old persisted roots; the assertion exercises the
 * current runtime against that on-disk shape rather than running old code.
 */
async function writePreTicketMutationLockRoot(lockRoot, owner = undefined) {
  await mkdir(lockRoot);
  if (typeof owner === "string") await writeFile(path.join(lockRoot, "owner.json"), owner);
  if (owner && typeof owner === "object") await writeFile(path.join(lockRoot, "owner.json"), `${JSON.stringify(owner)}\n`);
}

/**
 * Pinned pre-ticket acquisition algorithm. Provenance: the #140 intermediate
 * root-owner implementation's `readMutationLockOwner`,
 * `mutationLockOwnerIsStale`, and root-owner admission/reclaim loop,
 * immediately before ticket roots replaced that root protocol. It reads an
 * owner, classifies released/local-dead owners as stale, reclaims their owner
 * record, and otherwise waits for admission. No released package contained
 * that temporary implementation; this fixture preserves its compatibility
 * semantics for the reverse-direction check.
 */
function pinnedPreTicketOwnerIsStale(owner, activeTokens) {
  if (owner.status === "released") return true;
  if (owner.host === hostname() && owner.pid === process.pid) return !activeTokens.has(owner.token);
  if (owner.host === hostname()) {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return error?.code === "ESRCH";
    }
  }
  return false;
}

async function acquirePinnedPreTicketRoot(lockRoot, timeoutMs = 80) {
  const ownerPath = path.join(lockRoot, "owner.json");
  const deadline = Date.now() + timeoutMs;
  // This models a distinct old client, so it has no local record of the
  // sentinel token. (The marked-root sentinel is deliberately foreign-host.)
  const activeTokens = new Set();
  for (;;) {
    try {
      await mkdir(lockRoot, { mode: 0o700 });
      await writeFile(ownerPath, `${JSON.stringify({ token: "pinned-pre-ticket", pid: process.pid, host: hostname(), status: "active", created_at: new Date().toISOString() })}\n`, { flag: "wx" });
      return { entered: true, reclaimed: false };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let owner;
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8"));
    } catch {
      return { entered: false, reclaimed: false, reason: "owner-unreadable" };
    }
    if (pinnedPreTicketOwnerIsStale(owner, activeTokens)) {
      await rm(ownerPath, { force: true });
      return { entered: false, reclaimed: true };
    }
    if (Date.now() >= deadline) return { entered: false, reclaimed: false, reason: "timeout" };
    await delay(5);
  }
}

test("authorized retry moves the same exhausted run to selected route and starts epoch two", async () => {
  const { cwd, definition, started, request } = await exhaustedRun();
  const result = await flow.authorizeRetry(started.runId, { cwd, request });
  assert.equal(result.idempotent, false);
  assert.equal(result.state.run_id, started.runId);
  assert.equal(result.state.status, "active");
  assert.equal(result.state.current_step, "implement");
  assert.equal(result.transition.type, "retry_authorized");
  assert.equal(result.transition.prior_retry_epoch, 1);
  assert.equal(result.transition.retry_epoch, 2);
  assert.equal(result.state.transitions.filter((entry) => entry.type === "route_back").length, 4);
  assert.equal(result.state.transitions.some((entry) => entry.status === "allowed"), true, "prior completion transition remains immutable history");
  assert.equal(result.state.transitions.filter((entry) => entry.type === "route_back").every((entry) => entry.retry_epoch === undefined), true, "legacy epoch-1 history is not rewritten");
  assert.deepEqual(result.state.gate_outcome_history, [
    { gate_id: "verify-gate", status: "pass", summary: "prior verified visit", evidence_refs: ["ev.prior"] },
    { gate_id: "verify-gate", status: "block", summary: "budget exhausted", evidence_refs: [], route_reason: "implementation_defect", selected_route: "implement", attempt: 4, max_attempts: 3, limit_exceeded: true }
  ]);
  assert.deepEqual(result.state.gate_outcomes, [], "the exhausted prior epoch remains audit history, not the current gate projection");
  const gate = flow.findGate(definition, "verify-gate");
  const next = flow.routeBackDecision(result.state, gate, "implementation_defect");
  assert.equal(next.retry_epoch, 2);
  assert.equal(next.attempt, 1);
  assert.equal(next.max_attempts, 3);
  const report = flow.reportJson(definition, result.state, result.manifest);
  assert.equal(report.retry_authorizations[0].blocked_transition_ref, request.blocked_transition_ref);
  assert.equal(report.retry_authorizations[0].authority.request_ref, "request:retry-1");
  assert.equal(report.retry_authorizations[0].max_attempts, 3);
  assert.equal(report.retry_authorizations[0].consumed_attempts, 0);
  assert.equal(report.retry_authorizations[0].next_attempt, 1);
  assert.equal(report.retry_authorizations[0].remaining_attempts, 3);
  assert.equal(report.retry_authorizations[0].budget_status, "current");
  assert.equal(report.gate_summaries.find((entry) => entry.gate_id === "verify-gate").status, "wait");
  const projection = flow.projectFlowRun({ ...result, report });
  assert.equal(projection.transitions.at(-1).type, "retry_authorized");
  assert.equal(projection.transitions.at(-1).retry_epoch, 2);
  result.state.transitions.push({
    type: "route_back", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect",
    route_reason: "implementation_defect", selected_route: "implement", attempt: 1, retry_epoch: 2,
    max_attempts: 3, limit_exceeded: false, gate_id: "verify-gate", at: "2026-07-19T15:07:00.000Z"
  });
  const advancedReport = flow.reportJson(definition, result.state, result.manifest);
  assert.equal(advancedReport.retry_authorizations[0].consumed_attempts, 1);
  assert.equal(advancedReport.retry_authorizations[0].next_attempt, 2);
  assert.equal(advancedReport.retry_authorizations[0].remaining_attempts, 2);
});

test("a separately authorized second exhausted epoch advances only to epoch three", async () => {
  const { cwd, started, request } = await exhaustedRun("retry-second-epoch");
  const first = await flow.authorizeRetry(started.runId, { cwd, request });
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.status = "blocked";
  state.current_step = "verify";
  state.transitions.push(...[1, 2, 3, 4].map((attempt) => ({
    type: "route_back", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", route_reason: "implementation_defect", selected_route: "implement", attempt, retry_epoch: 2, max_attempts: 3, limit_exceeded: attempt === 4, gate_id: "verify-gate", at: `2026-07-19T16:0${attempt}:00.000Z`
  })));
  state.updated_at = "2026-07-19T16:04:00.000Z";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const exhaustedAgain = await flow.loadRun(started.runId, cwd);
  const block = exhaustedAgain.state.transitions.at(-1);
  const second = await flow.authorizeRetry(started.runId, {
    cwd,
    request: {
      ...request,
      blocked_transition_ref: flow.flowTransitionRef(block),
      expected_run_head: flow.flowRunHead(exhaustedAgain.state),
      authority: { ...request.authority, request_ref: "request:retry-2" }
    }
  });
  assert.equal(first.transition.retry_epoch, 2);
  assert.equal(second.transition.prior_retry_epoch, 2);
  assert.equal(second.transition.retry_epoch, 3);
  const report = flow.reportJson(second.definition, second.state, second.manifest);
  assert.equal(report.retry_authorizations[0].budget_status, "historical");
  assert.equal(report.retry_authorizations[0].remaining_attempts, 0);
  assert.equal(report.retry_authorizations[0].next_attempt, null);
  assert.equal(report.retry_authorizations[1].budget_status, "current");
});

test("a default-route authorization starts a new epoch for the default loop, not its human reason", () => {
  const definition = routeBackDefinition();
  const gate = flow.findGate(definition, "verify-gate");
  const state = flow.initialState(definition, "default-epoch");
  state.transitions = [
    {
      type: "route_back", from_step: "verify", to_step: "implement", status: "blocked",
      gate_id: "verify-gate", route_reason: "default", reason: "default", selected_route: "implement",
      retry_epoch: 1, attempt: 4, max_attempts: 3, limit_exceeded: true, at: "2026-07-19T16:05:00.000Z"
    },
    {
      type: "retry_authorized", from_step: "verify", to_step: "implement", status: "retry-authorized",
      gate_id: "verify-gate", route_reason: "default", reason: "human approval text", selected_route: "implement",
      prior_retry_epoch: 1, retry_epoch: 2, at: "2026-07-19T16:06:00.000Z"
    }
  ];
  const route = flow.routeBackDecision(state, gate, undefined);
  assert.equal(route.retry_epoch, 2);
  assert.equal(route.attempt, 1);
});

test("retry authorization is exact-replay idempotent and rejects stale, forged, wrong-target, and conflicting requests before mutation", async () => {
  const { cwd, started, request } = await exhaustedRun("retry-rejection");
  for (const bad of [
    { ...request, expected_run_head: "0".repeat(64) },
    { ...request, blocked_transition_ref: "1".repeat(64) },
    { ...request, target_step: "plan" },
    { ...request, authority: { ...request.authority, actor: "" } }
  ]) {
    const before = await hashRunTree(started.dir);
    await assert.rejects(() => flow.authorizeRetry(started.runId, { cwd, request: bad }), /flow\.retry_authorization\./);
    assert.equal(await hashRunTree(started.dir), before);
    await assertMutationLockAbsent(started.dir);
  }
  const before = await hashRunTree(started.dir);
  await assert.rejects(() => flow.authorizeRetry(started.runId, { cwd, request, at: "2026-07-19T15:06:00.000Z" }), /timestamps are runtime-derived/);
  assert.equal(await hashRunTree(started.dir), before);
  await assertMutationLockAbsent(started.dir);
  const applied = await flow.authorizeRetry(started.runId, { cwd, request });
  const after = await hashRunTree(started.dir);
  const replay = await flow.authorizeRetry(started.runId, { cwd, request });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.transition, applied.transition);
  assert.equal(await hashRunTree(started.dir), after);
  await assert.rejects(() => flow.authorizeRetry(started.runId, { cwd, request: { ...request, reason: "different" } }), /flow\.retry_authorization\.replay\.conflict/);
  assert.equal(await hashRunTree(started.dir), after);
});

test("exact replay remains byte-stable and lock-free when its prior lock root is absent", async () => {
  const fixture = await exhaustedRun("retry-pristine-exact-replay");
  const applied = await flow.authorizeRetry(fixture.started.runId, { cwd: fixture.cwd, request: fixture.request });
  await rm(path.join(fixture.started.dir, ".mutation.lock"), { recursive: true });
  await assertMutationLockAbsent(fixture.started.dir);
  const before = await hashRunTree(fixture.started.dir);
  const replay = await flow.authorizeRetry(fixture.started.runId, { cwd: fixture.cwd, request: fixture.request });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.transition, applied.transition);
  assert.equal(await hashRunTree(fixture.started.dir), before);
  await assertMutationLockAbsent(fixture.started.dir);
});

test("a valid request from another run is rejected read-only before lock admission", async () => {
  const runA = await exhaustedRun("retry-cross-run-a");
  const runB = await exhaustedRun("retry-cross-run-b");
  await assertPristineRetryRejection(
    runB,
    runA.request,
    /flow\.retry_authorization\.run_head\.stale/
  );
});

test("Date.parse-compatible non-RFC3339 authority timestamps fail without writes", async () => {
  for (const [suffix, requestedAt] of [
    ["space", "2026-07-19 15:05:00Z"],
    ["missing-zone", "2026-07-19T15:05:00"],
    ["rolled-date", "2026-02-30T15:05:00Z"]
  ]) {
    assert.equal(Number.isFinite(Date.parse(requestedAt)), true, `${requestedAt} documents the former permissive admission`);
    const fixture = await exhaustedRun(`retry-pristine-timestamp-${suffix}`);
    await assertPristineRetryRejection(
      fixture,
      { ...fixture.request, authority: { ...fixture.request.authority, requested_at: requestedAt } },
      /authority\.requested_at must be an RFC 3339 timestamp/
    );
  }
});

test("same-epoch repeated exhaustion and discriminator hiding fail pristine preflight", async () => {
  const repeated = await exhaustedRun("retry-pristine-repeated-exhaustion");
  const repeatedRequest = await rewriteRetryState(repeated, (state) => {
    const firstExhaustion = state.transitions.at(-1);
    state.transitions.push({ ...firstExhaustion, attempt: 5, at: "2026-07-19T15:05:00.000Z" });
  });
  await assertPristineRetryRejection(repeated, repeatedRequest, /flow\.retry_authorization\.block\.invalid/);

  const hidden = await exhaustedRun("retry-pristine-hidden-predecessor");
  const hiddenRequest = await rewriteRetryState(hidden, (state) => {
    const routeBacks = state.transitions.filter((entry) => entry.type === "route_back");
    routeBacks[0].type = "step";
    routeBacks[0].status = "allowed";
    routeBacks[1].attempt = 1;
    routeBacks[2].attempt = 2;
    routeBacks[3].attempt = 3;
    routeBacks[3].limit_exceeded = false;
    state.transitions.push({
      ...routeBacks[3], type: "route_back", attempt: 4, limit_exceeded: true,
      at: "2026-07-19T15:05:00.000Z"
    });
  });
  await assertPristineRetryRejection(hidden, hiddenRequest, /state\.json is invalid|flow\.retry_authorization\.history\.invalid|flow\.retry_authorization\.block\.invalid/);

  const missingGate = await exhaustedRun("retry-pristine-hidden-missing-gate");
  const missingGateRequest = await rewriteRetryState(missingGate, (state) => {
    const routeBacks = state.transitions.filter((entry) => entry.type === "route_back");
    delete routeBacks[0].gate_id;
    routeBacks[1].attempt = 1;
    routeBacks[2].attempt = 2;
    routeBacks[3].attempt = 3;
    routeBacks[3].limit_exceeded = false;
    state.transitions.push({
      ...routeBacks[3], attempt: 4, limit_exceeded: true,
      at: "2026-07-19T15:05:00.000Z"
    });
  });
  await assertPristineRetryRejection(missingGate, missingGateRequest, /flow\.retry_authorization\.history\.invalid|flow\.retry_authorization\.block\.invalid/);

  const partialAuthorization = await exhaustedRun("retry-pristine-partial-auth-shape");
  const partialAuthorizationRequest = await rewriteRetryState(partialAuthorization, (state) => {
    state.transitions[0].blocked_transition_ref = "a".repeat(64);
  });
  await assertPristineRetryRejection(partialAuthorization, partialAuthorizationRequest, /state\.json is invalid|flow\.retry_authorization\.history\.invalid/);

  const ambiguous = await exhaustedRun("retry-pristine-ambiguous-shape");
  const ambiguousRequest = await rewriteRetryState(ambiguous, (state) => {
    state.transitions[1].authority = {
      kind: "operator_request", actor: "operator:forged",
      request_ref: "request:forged", requested_at: "2026-07-19T15:00:30.000Z"
    };
  });
  await assertPristineRetryRejection(ambiguous, ambiguousRequest, /state\.json is invalid|flow\.retry_authorization\.history\.invalid/);
});

test("canonical unrelated unbounded and recovery-policy route-backs do not deny retry", async () => {
  const valid = await exhaustedRun("retry-unrelated-canonical-history");
  const request = await addUnrelatedCanonicalRouteHistory(valid);
  const result = await flow.authorizeRetry(valid.started.runId, { cwd: valid.cwd, request });
  assert.equal(result.idempotent, false);
  assert.equal(result.transition.retry_epoch, 2);

  const malformed = await exhaustedRun("retry-unrelated-malformed-history");
  const malformedRequest = await addUnrelatedCanonicalRouteHistory(malformed, (unrelated) => {
    unrelated[0].attempt = 2;
  });
  await assertPristineRetryRejection(malformed, malformedRequest, /flow\.retry_authorization\.history\.invalid/);
});

test("the first pristine call for every retry semantic rejection class leaves no mutation lock", async () => {
  const malformedRoute = /flow\.retry_authorization\.history\.invalid/;
  const stale = await exhaustedRun("retry-pristine-stale");
  await assertPristineRetryRejection(
    stale,
    { ...stale.request, expected_run_head: "0".repeat(64) },
    /flow\.retry_authorization\.run_head\.stale/
  );

  const forged = await exhaustedRun("retry-pristine-forged-block");
  await assertPristineRetryRejection(
    forged,
    { ...forged.request, blocked_transition_ref: "1".repeat(64) },
    /flow\.retry_authorization\.block\.invalid/
  );

  const wrongTarget = await exhaustedRun("retry-pristine-wrong-target");
  await assertPristineRetryRejection(
    wrongTarget,
    { ...wrongTarget.request, target_step: "plan" },
    /flow\.retry_authorization\.block\.invalid/
  );

  const terminal = await exhaustedRun("retry-pristine-terminal");
  const terminalRequest = await rewriteRetryState(terminal, (state) => { state.status = "failed"; });
  await assertPristineRetryRejection(terminal, terminalRequest, /flow\.retry_authorization\.run_terminal/);

  const nonBlocked = await exhaustedRun("retry-pristine-non-blocked");
  const nonBlockedRequest = await rewriteRetryState(nonBlocked, (state) => { state.status = "active"; });
  await assertPristineRetryRejection(nonBlocked, nonBlockedRequest, /flow\.retry_authorization\.run_not_blocked/);

  const unbounded = await exhaustedRun("retry-pristine-unbounded");
  const unboundedRequest = await rewriteRetryState(unbounded, (state) => { delete state.transitions.at(-1).max_attempts; });
  await assertPristineRetryRejection(unbounded, unboundedRequest, /flow\.retry_authorization\.history\.invalid/);

  const wrongCurrentStep = await exhaustedRun("retry-pristine-current-step");
  const wrongCurrentStepRequest = await rewriteRetryState(wrongCurrentStep, (state) => { state.current_step = "implement"; });
  await assertPristineRetryRejection(wrongCurrentStep, wrongCurrentStepRequest, /flow\.retry_authorization\.block\.invalid/);

  const wrongRun = await exhaustedRun("retry-pristine-wrong-run");
  const wrongRunRequest = await rewriteRetryState(wrongRun, (state) => { state.run_id = "different-run"; });
  await assertPristineRetryRejection(wrongRun, wrongRunRequest, /run state run_id mismatch/);

  const wrongGate = await exhaustedRun("retry-pristine-wrong-gate");
  const wrongGateRequest = await rewriteRetryState(wrongGate, (state) => {
    state.transitions.at(-1).from_step = "implement";
    state.current_step = "implement";
  });
  await assertPristineRetryRejection(wrongGate, wrongGateRequest, malformedRoute);

  const undeclaredRoute = await exhaustedRun("retry-pristine-undeclared-route");
  const undeclaredRouteRequest = await rewriteRetryState(undeclaredRoute, (state) => {
    state.transitions.at(-1).to_step = "undeclared-step";
    state.transitions.at(-1).selected_route = "undeclared-step";
  });
  await assertPristineRetryRejection(
    undeclaredRoute,
    { ...undeclaredRouteRequest, target_step: "undeclared-step" },
    malformedRoute
  );

  const forgedToStep = await exhaustedRun("retry-pristine-forged-to-step");
  const forgedToStepRequest = await rewriteRetryState(forgedToStep, (state) => {
    state.transitions.at(-1).to_step = "recover";
  });
  await assertPristineRetryRejection(forgedToStep, forgedToStepRequest, malformedRoute);

  const forgedBudget = await exhaustedRun("retry-pristine-forged-budget");
  const forgedBudgetRequest = await rewriteRetryState(forgedBudget, (state) => {
    state.transitions.at(-1).max_attempts = 4;
  });
  await assertPristineRetryRejection(forgedBudget, forgedBudgetRequest, malformedRoute);

  const premature = await exhaustedRun("retry-pristine-premature-exhaustion");
  const prematureRequest = await rewriteRetryState(premature, (state) => {
    state.transitions.splice(-2, 1);
    state.transitions.at(-1).attempt = 3;
  });
  await assertPristineRetryRejection(premature, prematureRequest, malformedRoute);

  const nonBlockingPolicy = await exhaustedRun("retry-pristine-non-blocking-policy");
  await rewriteRetryDefinition(nonBlockingPolicy, (definition) => {
    definition.gates["verify-gate"].route_back_policy.on_exceeded = "recover";
  });
  const nonBlockingPolicyRequest = await rewriteRetryState(nonBlockingPolicy, () => undefined);
  await assertPristineRetryRejection(nonBlockingPolicy, nonBlockingPolicyRequest, malformedRoute);

  const forgedAttempt = await exhaustedRun("retry-pristine-forged-attempt");
  const forgedAttemptRequest = await rewriteRetryState(forgedAttempt, (state) => {
    state.transitions.at(-1).attempt = 5;
  });
  await assertPristineRetryRejection(forgedAttempt, forgedAttemptRequest, malformedRoute);

  const forgedEpoch = await exhaustedRun("retry-pristine-forged-epoch");
  const forgedEpochRequest = await rewriteRetryState(forgedEpoch, (state) => {
    state.transitions.at(-1).retry_epoch = 2;
  });
  await assertPristineRetryRejection(forgedEpoch, forgedEpochRequest, malformedRoute);

  const forgedRecovery = await exhaustedRun("retry-pristine-forged-recovery-step");
  const forgedRecoveryRequest = await rewriteRetryState(forgedRecovery, (state) => {
    state.transitions.at(-1).recovery_step = "recover";
  });
  await assertPristineRetryRejection(forgedRecovery, forgedRecoveryRequest, malformedRoute);

  const predecessorCorruptions = [
    ["attempt", (entry) => { entry.attempt = 99; }],
    ["epoch", (entry) => { entry.retry_epoch = 2; }],
    ["gate", (entry) => { entry.gate_id = "missing-gate"; }],
    ["reason", (entry) => { entry.reason = "plan_gap"; entry.route_reason = "plan_gap"; }],
    ["target", (entry) => { entry.to_step = "recover"; }],
    ["selected-route", (entry) => { entry.selected_route = "recover"; }],
    ["budget", (entry) => { entry.max_attempts = 99; }],
    ["status", (entry) => { entry.status = "allowed"; }],
    ["limit", (entry) => { entry.limit_exceeded = true; }],
    ["recovery-step", (entry) => { entry.recovery_step = "recover"; }]
  ];
  for (const [suffix, corrupt] of predecessorCorruptions) {
    const fixture = await exhaustedRun(`retry-pristine-predecessor-${suffix}`);
    const reboundRequest = await rewriteRetryState(fixture, (state) => {
      const predecessor = state.transitions.find((entry) => entry.type === "route_back" && entry.attempt === 2);
      corrupt(predecessor);
    });
    await assertPristineRetryRejection(fixture, reboundRequest, malformedRoute);
  }

  const conflict = await exhaustedRun("retry-pristine-replay-conflict");
  await flow.authorizeRetry(conflict.started.runId, { cwd: conflict.cwd, request: conflict.request });
  await rm(path.join(conflict.started.dir, ".mutation.lock"), { recursive: true });
  await assertPristineRetryRejection(
    conflict,
    { ...conflict.request, reason: "conflicting authorization reason" },
    /flow\.retry_authorization\.replay\.conflict/
  );
});

test("CLI authorizes the same public request contract", async () => {
  const { cwd, started, request } = await exhaustedRun("retry-cli");
  const requestPath = path.join(cwd, "request.json");
  await writeFile(requestPath, `${JSON.stringify(request)}\n`);
  const result = await execFile(process.execPath, [cliPath, "authorize-retry", started.runId, "--request", requestPath, "--cwd", cwd]);
  assert.match(result.stdout, /retry authorized: retry-cli/);
  assert.match(result.stdout, /epoch: 2/);
});

test("JSON-domain hashing matches persistence normalization", () => {
  assert.equal(flow.canonicalJson({ value: undefined }), flow.canonicalJson({}));
  assert.equal(flow.canonicalJson([undefined]), flow.canonicalJson([null]));
  assert.throws(() => flow.canonicalJson(undefined), /not representable as persisted JSON/);
});

test("concurrent same-head authorizations serialize to exactly one transition", async () => {
  const { cwd, started, request } = await exhaustedRun("retry-concurrent");
  const attempts = await Promise.allSettled([
    flow.authorizeRetry(started.runId, { cwd, request }),
    flow.authorizeRetry(started.runId, { cwd, request: { ...request, authority: { ...request.authority, request_ref: "request:retry-concurrent-2" } } })
  ]);
  assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);
  const loaded = await flow.loadRun(started.runId, cwd);
  assert.equal(loaded.state.transitions.filter((entry) => entry.type === "retry_authorized").length, 1);
});

test("shared mutation serialization prevents cross-operation authorization loss", async () => {
  const pauseFixture = await exhaustedRun("retry-race-pause");
  const pauseResults = await Promise.allSettled([
    flow.authorizeRetry(pauseFixture.started.runId, { cwd: pauseFixture.cwd, request: pauseFixture.request }),
    flow.pauseRun(pauseFixture.started.runId, {
      cwd: pauseFixture.cwd, reason: "operator pause during recovery",
      authority: { kind: "operator_request", actor: "operator:test", request_ref: "request:pause-race", requested_at: "2026-07-19T15:05:00.000Z" }
    })
  ]);
  const paused = await flow.loadRun(pauseFixture.started.runId, pauseFixture.cwd);
  assert.equal(paused.state.status, "paused");
  if (pauseResults[0].status === "fulfilled") assert.equal(paused.state.transitions.some((entry) => entry.type === "retry_authorized"), true);

  const attachFixture = await exhaustedRun("retry-race-attach");
  const evidencePath = path.join(attachFixture.cwd, "race.txt");
  await writeFile(evidencePath, "race evidence\n");
  const attachResults = await Promise.allSettled([
    flow.authorizeRetry(attachFixture.started.runId, { cwd: attachFixture.cwd, request: attachFixture.request }),
    flow.attachEvidence(attachFixture.started.runId, { cwd: attachFixture.cwd, gate: "verify-gate", file: evidencePath })
  ]);
  const attached = await flow.loadRun(attachFixture.started.runId, attachFixture.cwd);
  if (attachResults[0].status === "fulfilled") assert.equal(attached.state.transitions.some((entry) => entry.type === "retry_authorized"), true);
  if (attachResults[1].status === "fulfilled") assert.equal(attached.manifest.evidence.length, 1);

  const exceptionFixture = await exhaustedRun("retry-race-exception");
  const exceptionResults = await Promise.allSettled([
    flow.authorizeRetry(exceptionFixture.started.runId, { cwd: exceptionFixture.cwd, request: exceptionFixture.request }),
    flow.acceptException(exceptionFixture.started.runId, { cwd: exceptionFixture.cwd, gate: "verify-gate", reason: "operator exception", authority: "operator:test" })
  ]);
  const excepted = await flow.loadRun(exceptionFixture.started.runId, exceptionFixture.cwd);
  assert.equal(excepted.state.status, "accepted_by_exception", `race results: ${exceptionResults.map((entry) => entry.status === "rejected" ? String(entry.reason) : "fulfilled").join(" | ")}`);
  if (exceptionResults[0].status === "fulfilled") assert.equal(excepted.state.transitions.some((entry) => entry.type === "retry_authorized"), true);

  const evaluateFixture = await exhaustedRun("retry-race-evaluate");
  const evaluateResults = await Promise.allSettled([
    flow.authorizeRetry(evaluateFixture.started.runId, { cwd: evaluateFixture.cwd, request: evaluateFixture.request }),
    flow.evaluateRun(evaluateFixture.started.runId, { cwd: evaluateFixture.cwd })
  ]);
  const evaluated = await flow.loadRun(evaluateFixture.started.runId, evaluateFixture.cwd);
  if (evaluateResults[0].status === "fulfilled") assert.equal(evaluated.state.transitions.some((entry) => entry.type === "retry_authorized"), true);
  assert.ok(evaluateResults.some((entry) => entry.status === "fulfilled"));
});

test("every unmarked legacy root fails closed without migration or mutation", async () => {
  const variants = [
    ["ownerless", undefined],
    ["live", { token: "live-owner", pid: process.pid, host: hostname(), status: "active", created_at: "2026-01-01T00:00:00.000Z" }],
    ["dead", { token: "dead-owner", pid: 2_147_483_647, host: hostname(), status: "active", created_at: "2026-01-01T00:00:00.000Z" }],
    ["released", { token: "released-owner", pid: process.pid, host: hostname(), status: "released", created_at: "2026-01-01T00:00:00.000Z" }],
    ["malformed", "{\n"]
  ];
  for (const [suffix, owner] of variants) {
    const fixture = await exhaustedRun(`retry-legacy-${suffix}`);
    const lockRoot = path.join(fixture.started.dir, ".mutation.lock");
    await writePreTicketMutationLockRoot(lockRoot, owner);
    const before = await hashRunTree(fixture.started.dir);
    await assert.rejects(
      () => flow.authorizeRetry(fixture.started.runId, { cwd: fixture.cwd, request: fixture.request }),
      /flow\.run_mutation\.lock\.migration_required/
    );
    assert.equal(await hashRunTree(fixture.started.dir), before, suffix);
  }
});

test("atomic pending publication never exposes a ticket directory without a complete owner", async () => {
  const fixture = await exhaustedRun("retry-atomic-ticket-publication");
  const lockRoot = path.join(fixture.started.dir, ".mutation.lock");
  await withRunMutationLock(fixture.started.runId, fixture.cwd, async () => {
    const ticket = (await readdir(lockRoot)).find((entry) => /^ticket-\d/.test(entry));
    assert.ok(ticket, "holder has one visible ticket");
    const owner = JSON.parse(await readFile(path.join(lockRoot, ticket, "owner.json"), "utf8"));
    assert.equal(typeof owner.token, "string");
    assert.equal(Number.isInteger(owner.pid), true);
    assert.equal(typeof owner.host, "string");
    assert.equal(owner.status, "holding");
  });
  assert.deepEqual((await readdir(lockRoot)).sort(), ["owner.json", "ticket-lock-v1"]);
});

test("pinned pre-ticket client cannot enter, reclaim, or alter idle and active marked roots", async () => {
  for (const active of [false, true]) {
    const fixture = await exhaustedRun(`retry-pre-ticket-${active ? "active" : "idle"}`);
    const lockRoot = path.join(fixture.started.dir, ".mutation.lock");
    const exercise = async () => {
      const rootOwner = await readFile(path.join(lockRoot, "owner.json"), "utf8");
      const before = await hashRunTree(fixture.started.dir);
      const result = await acquirePinnedPreTicketRoot(lockRoot);
      assert.deepEqual(result, { entered: false, reclaimed: false, reason: "timeout" });
      assert.equal(await hashRunTree(fixture.started.dir), before, active ? "active root" : "idle root");
      assert.equal(await readFile(path.join(lockRoot, "owner.json"), "utf8"), rootOwner, "foreign-host sentinel remains byte-identical");
    };
    if (active) {
      await withRunMutationLock(fixture.started.runId, fixture.cwd, exercise);
    } else {
      await withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);
      await exercise();
    }
  }
});

test("ticket roots permanently retain the compatibility sentinel and marker across idle and active cleanup", async () => {
  const fixture = await exhaustedRun("retry-ticket-root-retention");
  const lockRoot = path.join(fixture.started.dir, ".mutation.lock");
  await withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);
  const firstOwner = await readFile(path.join(lockRoot, "owner.json"), "utf8");
  const firstMarker = await readFile(path.join(lockRoot, "ticket-lock-v1"), "utf8");
  assert.deepEqual((await readdir(lockRoot)).sort(), ["owner.json", "ticket-lock-v1"]);
  const held = withRunMutationLock(fixture.started.runId, fixture.cwd, async () => {
    const entries = (await readdir(lockRoot)).sort();
    assert.equal(entries.filter((entry) => entry === "owner.json").length, 1);
    assert.equal(entries.filter((entry) => entry === "ticket-lock-v1").length, 1);
    assert.equal(entries.filter((entry) => /^ticket-\d/.test(entry)).length, 1);
  });
  await held;
  await withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);
  assert.equal(await readFile(path.join(lockRoot, "owner.json"), "utf8"), firstOwner, "root owner sentinel is never rewritten or cleaned up");
  assert.equal(await readFile(path.join(lockRoot, "ticket-lock-v1"), "utf8"), firstMarker, "root marker is never cleaned up");
  assert.deepEqual((await readdir(lockRoot)).sort(), ["owner.json", "ticket-lock-v1"]);
});

test("marked roots with missing, malformed, or linked sentinel/marker fail closed without repair", async () => {
  const cases = [
    ["missing-owner", async (root) => rm(path.join(root, "owner.json"))],
    ["missing-marker", async (root) => rm(path.join(root, "ticket-lock-v1"))],
    ["malformed-owner", async (root) => writeFile(path.join(root, "owner.json"), "{\n")],
    ["malformed-marker", async (root) => writeFile(path.join(root, "ticket-lock-v1"), "wrong\n")],
    ["linked-owner", async (root) => { await rm(path.join(root, "owner.json")); await symlink("elsewhere", path.join(root, "owner.json")); }],
    ["linked-marker", async (root) => { await rm(path.join(root, "ticket-lock-v1")); await symlink("elsewhere", path.join(root, "ticket-lock-v1")); }]
  ];
  for (const [suffix, corrupt] of cases) {
    const fixture = await exhaustedRun(`retry-marked-${suffix}`);
    await withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);
    const root = path.join(fixture.started.dir, ".mutation.lock");
    await corrupt(root);
    const before = await hashRunTree(fixture.started.dir);
    await assert.rejects(
      () => flow.authorizeRetry(fixture.started.runId, { cwd: fixture.cwd, request: fixture.request }),
      /flow\.run_mutation\.lock\.root_invalid/
    );
    assert.equal(await hashRunTree(fixture.started.dir), before, suffix);
  }
});

test("initialization races leave a valid ticket root and do not auto-repair a partial generation", async () => {
  const fixture = await exhaustedRun("retry-ticket-root-race");
  const first = withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);
  const second = withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);
  const attempts = await Promise.allSettled([first, second]);
  assert.ok(attempts.some((entry) => entry.status === "fulfilled"));
  const root = path.join(fixture.started.dir, ".mutation.lock");
  assert.equal(JSON.parse(await readFile(path.join(root, "owner.json"), "utf8")).protocol, "flow.run-mutation.ticket-root.v1");
  assert.equal((await readFile(path.join(root, "ticket-lock-v1"), "utf8")).trim(), "ticket-lock-v1");
  await withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);
});

test("competing callers on an active marked root cannot detach a live successor ticket", async () => {
  const fixture = await exhaustedRun("retry-stale-reclaimers");
  await withRunMutationLock(fixture.started.runId, fixture.cwd, async () => undefined);

  let releaseFirst;
  let signalFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise((resolve) => { signalFirst = resolve; });
  let entered = 0;
  let active = 0;
  let maxActive = 0;
  const contender = () => withRunMutationLock(fixture.started.runId, fixture.cwd, async () => {
    entered += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (entered === 1) {
      signalFirst();
      await firstRelease;
    }
    await delay(5);
    active -= 1;
  });

  const first = contender();
  const second = contender();
  await firstEntered;
  const third = contender();
  await delay(40);
  assert.equal(maxActive, 1, "only one stale reclaimer successor may hold the run at a time");
  releaseFirst();
  await Promise.all([first, second, third]);
  assert.equal(maxActive, 1);
});

test("predecessor cleanup cannot delete a live successor lock generation", async () => {
  const fixture = await exhaustedRun("retry-lock-handoff");
  let releaseA;
  let releaseB;
  let signalAHeld;
  let signalBHeld;
  const aRelease = new Promise((resolve) => { releaseA = resolve; });
  const bRelease = new Promise((resolve) => { releaseB = resolve; });
  const aHeld = new Promise((resolve) => { signalAHeld = resolve; });
  const bHeld = new Promise((resolve) => { signalBHeld = resolve; });

  const predecessor = withRunMutationLock(fixture.started.runId, fixture.cwd, async () => {
    signalAHeld();
    await aRelease;
  }, {
    afterReleaseQuarantine: async () => {
      await bHeld;
    }
  });
  await aHeld;
  const successor = withRunMutationLock(fixture.started.runId, fixture.cwd, async () => {
    signalBHeld();
    await bRelease;
  });
  releaseA();
  await bHeld;
  await predecessor;

  let thirdEntered = false;
  const third = withRunMutationLock(fixture.started.runId, fixture.cwd, async () => {
    thirdEntered = true;
  });
  await delay(30);
  assert.equal(thirdEntered, false, "predecessor cleanup must leave the successor generation locked");
  releaseB();
  await successor;
  await third;
  assert.equal(thirdEntered, true);
});

test("persisted retry authorizations are relationally validated against the exhausted block", async () => {
  const { cwd, started, request } = await exhaustedRun("retry-forged-history");
  await flow.authorizeRetry(started.runId, { cwd, request });
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.transitions.at(-1).retry_epoch = 999;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(started.runId, cwd), /flow\.retry_authorization\.history\.invalid/);

  const rebound = await exhaustedRun("retry-rebound-forged-block");
  await flow.authorizeRetry(rebound.started.runId, { cwd: rebound.cwd, request: rebound.request });
  const reboundStatePath = path.join(rebound.started.dir, "state.json");
  const reboundState = JSON.parse(await readFile(reboundStatePath, "utf8"));
  const reboundBlock = reboundState.transitions.at(-2);
  reboundBlock.attempt = 99;
  reboundState.transitions.at(-1).blocked_transition_ref = flow.flowTransitionRef(reboundBlock);
  await writeFile(reboundStatePath, `${JSON.stringify(reboundState, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(rebound.started.runId, rebound.cwd), /flow\.retry_authorization\.history\.invalid/);

  const predecessor = await exhaustedRun("retry-forged-predecessor-history");
  await flow.authorizeRetry(predecessor.started.runId, { cwd: predecessor.cwd, request: predecessor.request });
  const predecessorStatePath = path.join(predecessor.started.dir, "state.json");
  const predecessorState = JSON.parse(await readFile(predecessorStatePath, "utf8"));
  predecessorState.transitions.find((entry) => entry.type === "route_back" && entry.attempt === 2).attempt = 77;
  await writeFile(predecessorStatePath, `${JSON.stringify(predecessorState, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(predecessor.started.runId, predecessor.cwd), /flow\.retry_authorization\.history\.invalid/);

  const repeated = await exhaustedRun("retry-repeated-exhaustion-history");
  await flow.authorizeRetry(repeated.started.runId, { cwd: repeated.cwd, request: repeated.request });
  const repeatedStatePath = path.join(repeated.started.dir, "state.json");
  const repeatedState = JSON.parse(await readFile(repeatedStatePath, "utf8"));
  const authorization = repeatedState.transitions.at(-1);
  const firstExhaustion = repeatedState.transitions.at(-2);
  const secondExhaustion = { ...firstExhaustion, attempt: 5, at: "2026-07-19T15:04:30.000Z" };
  repeatedState.transitions.splice(-1, 0, secondExhaustion);
  authorization.blocked_transition_ref = flow.flowTransitionRef(secondExhaustion);
  await writeFile(repeatedStatePath, `${JSON.stringify(repeatedState, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(repeated.started.runId, repeated.cwd), /flow\.retry_authorization\.history\.invalid/);

  const missingGate = await exhaustedRun("retry-missing-gate-history");
  await flow.authorizeRetry(missingGate.started.runId, { cwd: missingGate.cwd, request: missingGate.request });
  const missingGateStatePath = path.join(missingGate.started.dir, "state.json");
  const missingGateState = JSON.parse(await readFile(missingGateStatePath, "utf8"));
  const missingGateAuthorization = missingGateState.transitions.at(-1);
  const routeBacks = missingGateState.transitions.filter((entry) => entry.type === "route_back");
  delete routeBacks[0].gate_id;
  routeBacks[1].attempt = 1;
  routeBacks[2].attempt = 2;
  routeBacks[3].attempt = 3;
  routeBacks[3].limit_exceeded = false;
  const manufacturedExhaustion = {
    ...routeBacks[3], attempt: 4, limit_exceeded: true,
    at: "2026-07-19T15:04:30.000Z"
  };
  missingGateState.transitions.splice(-1, 0, manufacturedExhaustion);
  missingGateAuthorization.blocked_transition_ref = flow.flowTransitionRef(manufacturedExhaustion);
  await writeFile(missingGateStatePath, `${JSON.stringify(missingGateState, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(missingGate.started.runId, missingGate.cwd), /flow\.retry_authorization\.history\.invalid/);

  const hidden = await exhaustedRun("retry-hidden-discriminator-history");
  await flow.authorizeRetry(hidden.started.runId, { cwd: hidden.cwd, request: hidden.request });
  const hiddenStatePath = path.join(hidden.started.dir, "state.json");
  const hiddenState = JSON.parse(await readFile(hiddenStatePath, "utf8"));
  const hiddenAuthorization = hiddenState.transitions.at(-1);
  const hiddenRouteBacks = hiddenState.transitions.filter((entry) => entry.type === "route_back");
  hiddenRouteBacks[0].type = "step";
  hiddenRouteBacks[0].status = "allowed";
  hiddenRouteBacks[1].attempt = 1;
  hiddenRouteBacks[2].attempt = 2;
  hiddenRouteBacks[3].attempt = 3;
  hiddenRouteBacks[3].limit_exceeded = false;
  const hiddenManufacturedExhaustion = {
    ...hiddenRouteBacks[3], type: "route_back", status: "blocked", attempt: 4,
    limit_exceeded: true, at: "2026-07-19T15:04:30.000Z"
  };
  hiddenState.transitions.splice(-1, 0, hiddenManufacturedExhaustion);
  hiddenAuthorization.blocked_transition_ref = flow.flowTransitionRef(hiddenManufacturedExhaustion);
  await writeFile(hiddenStatePath, `${JSON.stringify(hiddenState, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(hidden.started.runId, hidden.cwd), /state\.json is invalid|flow\.retry_authorization\.history\.invalid/);

  const changedAuthorization = await exhaustedRun("retry-hidden-authorization-discriminators");
  await flow.authorizeRetry(changedAuthorization.started.runId, { cwd: changedAuthorization.cwd, request: changedAuthorization.request });
  const changedAuthorizationPath = path.join(changedAuthorization.started.dir, "state.json");
  const changedAuthorizationState = JSON.parse(await readFile(changedAuthorizationPath, "utf8"));
  changedAuthorizationState.transitions.at(-1).type = "step";
  changedAuthorizationState.transitions.at(-1).status = "allowed";
  await writeFile(changedAuthorizationPath, `${JSON.stringify(changedAuthorizationState, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(changedAuthorization.started.runId, changedAuthorization.cwd), /state\.json is invalid|flow\.retry_authorization\.history\.invalid/);

  const ambiguous = await exhaustedRun("retry-ambiguous-persisted-shape");
  await flow.authorizeRetry(ambiguous.started.runId, { cwd: ambiguous.cwd, request: ambiguous.request });
  const ambiguousPath = path.join(ambiguous.started.dir, "state.json");
  const ambiguousState = JSON.parse(await readFile(ambiguousPath, "utf8"));
  ambiguousState.transitions.at(-2).blocked_transition_ref = "b".repeat(64);
  await writeFile(ambiguousPath, `${JSON.stringify(ambiguousState, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(ambiguous.started.runId, ambiguous.cwd), /state\.json is invalid|flow\.retry_authorization\.history\.invalid/);
});

test("run loading rejects a partial exhausted route-back without its bounded budget", async () => {
  const { cwd, started } = await exhaustedRun("retry-missing-budget");
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.transitions.at(-1).max_attempts;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const before = await hashRunTree(started.dir);
  await assert.rejects(() => flow.loadRun(started.runId, cwd), /flow\.retry_authorization\.history\.invalid/);
  assert.equal(await hashRunTree(started.dir), before);
  await assertMutationLockAbsent(started.dir);
});

test("legacy no-descendant recovery seeds audit history before clearing the current outcome", async () => {
  const { cwd, started, request } = await exhaustedRun("retry-legacy-ledger");
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.gate_outcome_history;
  state.gate_outcomes[0].route_reason = "custom_vendor_reason";
  state.gate_outcomes[0].selected_route = "recover";
  for (const transition of state.transitions.filter((entry) => entry.type === "route_back")) {
    transition.reason = "custom_vendor_reason";
    transition.route_reason = "custom_vendor_reason";
    transition.to_step = "recover";
    transition.selected_route = "recover";
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const loaded = await flow.loadRun(started.runId, cwd);
  const blocked = loaded.state.transitions.at(-1);
  const result = await flow.authorizeRetry(started.runId, { cwd, request: {
    ...request,
    target_step: "recover",
    blocked_transition_ref: flow.flowTransitionRef(blocked),
    expected_run_head: flow.flowRunHead(loaded.state)
  } });
  assert.deepEqual(result.state.gate_outcomes, []);
  assert.equal(result.state.gate_outcome_history.length, 1);
  assert.equal(result.state.gate_outcome_history[0].route_reason, "custom_vendor_reason");
});

test("reserved retry status requires the retry_authorized type", async () => {
  const { cwd, started } = await exhaustedRun("retry-reserved-status");
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.transitions.push({ from_step: "verify", to_step: "implement", status: "retry-authorized", reason: "forged", at: "2026-07-19T15:07:00.000Z" });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await assert.rejects(() => flow.loadRun(started.runId, cwd), /state\.json is invalid|reserved retry-authorized status/);
});

test("self-route recovery cannot reuse evidence attached before authorization", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-retry-freshness-"));
  const definition = routeBackDefinition({ route_back_policy: { max_attempts: 3, on_exceeded: "block" } });
  const definitionPath = path.join(cwd, "flow.json");
  const bundlePath = path.join(cwd, "tests.bundle.json");
  await writeFile(definitionPath, `${JSON.stringify(definition)}\n`);
  await writeFile(bundlePath, `${JSON.stringify(passingTestsBundle())}\n`);
  const started = await flow.startRun(definitionPath, { cwd, runId: "retry-fresh-evidence" });
  await flow.attachEvidence(started.runId, { cwd, gate: "verify-gate", file: bundlePath, kind: "trust.bundle" });

  const manifestPath = path.join(started.dir, "evidence", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.evidence[0].attached_at = "2026-01-01T00:00:00.000Z";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.status = "blocked";
  state.current_step = "verify";
  state.gate_outcomes = [{ gate_id: "verify-gate", status: "block", summary: "budget exhausted", evidence_refs: [manifest.evidence[0].id], route_reason: "missing_evidence", selected_route: "verify", attempt: 4, retry_epoch: 1, max_attempts: 3, limit_exceeded: true }];
  state.gate_outcome_history = structuredClone(state.gate_outcomes);
  state.transitions = [1, 2, 3, 4].map((attempt) => ({
    type: "route_back", from_step: "verify", to_step: "verify", status: "blocked", reason: "missing_evidence",
    route_reason: "missing_evidence", selected_route: "verify", attempt, retry_epoch: 1, max_attempts: 3,
    limit_exceeded: attempt === 4, gate_id: "verify-gate", at: `2026-01-01T00:0${attempt}:00.000Z`
  }));
  state.updated_at = "2026-01-01T00:04:00.000Z";
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const blocked = await flow.loadRun(started.runId, cwd);
  const last = blocked.state.transitions.at(-1);
  await flow.authorizeRetry(started.runId, { cwd, request: {
    reason: "one more bounded self-route visit", target_step: "verify",
    blocked_transition_ref: flow.flowTransitionRef(last), expected_run_head: flow.flowRunHead(blocked.state),
    authority: { kind: "operator_request", actor: "operator:test", request_ref: "request:freshness", requested_at: "2026-07-19T15:05:00.000Z" }
  } });
  const evaluated = await flow.evaluateRun(started.runId, { cwd });
  assert.notEqual(evaluated.outcomes[0].status, "pass");
  assert.equal(evaluated.outcomes[0].route_reason, "missing_evidence");
  assert.equal(evaluated.outcomes[0].retry_epoch, 2);
});
