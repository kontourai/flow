import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acceptException,
  amendRunDefinition,
  claimReadyStep,
  definitionDigest,
  effectiveDefinitionIdentity,
  evaluateClaimedStep,
  flowRunHead,
  loadRun,
  pauseRun,
  projectFlowRun,
  recoverExpiredStepClaims,
  releaseStepClaim,
  reopenMultiCursorStep,
  renewStepClaim,
  startRun
} from "../../dist/index.js";

const actor = { key: "host-a", kind: "host" };

function definition() {
  const expectation = {
    id: "evidence", kind: "trust.bundle", required: true, description: "evidence",
    bundle_claim: { claimType: "quality.tests" }
  };
  return {
    id: "multi-runtime", version: "1",
    execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [
      { id: "prepare", next: "publish", mutable_resources: ["dist"] },
      { id: "verify", next: "publish", mutable_resources: ["reports"] },
      { id: "publish", next: null, needs: ["prepare", "verify"], mutable_resources: [] }
    ],
    gates: {
      "prepare-gate": { step: "prepare", expects: [expectation], on_route_back: { missing_evidence: "prepare" } },
      "verify-gate": { step: "verify", expects: [expectation] },
      "publish-gate": { step: "publish", expects: [expectation] }
    }
  };
}

async function run(name, definitionValue = definition()) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `flow-multi-${name}-`));
  const file = path.join(cwd, "definition.json");
  await writeFile(file, `${JSON.stringify(definitionValue, null, 2)}\n`);
  return { cwd, ...(await startRun(file, { cwd, runId: name })) };
}

function request(step_id, suffix, lease_seconds = 300) {
  return { step_id, claim_id: `claim-${suffix}`, liveness_id: `lease-${suffix}`, actor, lease_seconds };
}

test("durable claims use a non-self-referential step domain and siblings remain renewable", async () => {
  const fixture = await run("multi-siblings");
  const now = "2026-07-24T12:00:00.000Z";
  const prepare = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now, ...request("prepare", "prepare") });
  const verify = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now, ...request("verify", "verify") });
  assert.notEqual(prepare.claim.claim_base.head, verify.claim.claim_base.head, "claim base is step-scoped");

  const renewed = await renewStepClaim(fixture.runId, {
    cwd: fixture.cwd, now: "2026-07-24T12:01:00.000Z", claim_id: verify.claim.claim_id,
    liveness_id: verify.claim.liveness_id, actor
  });
  assert.equal(renewed.claim.claim_base.head, verify.claim.claim_base.head, "renewal itself does not rewrite the bound semantic state");
  const loaded = await loadRun(fixture.runId, fixture.cwd);
  assert.equal(loaded.state.multi_cursor.active_claims.length, 2);
  assert.deepEqual(loaded.state.multi_cursor.claim_history.map((entry) => entry.action), ["claimed", "claimed", "renewed"]);
  const projection = projectFlowRun(loaded);
  assert.deepEqual(projection.multi_cursor.active_claims.map((claim) => claim.claim_id), [prepare.claim.claim_id, verify.claim.claim_id].sort());
  assert.deepEqual(projection.multi_cursor.ready_steps, []);
});

test("route-back invalidates only affected leases and retains an independent sibling", async () => {
  const fixture = await run("multi-route-back");
  const now = "2026-07-24T12:00:00.000Z";
  const prepare = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now, ...request("prepare", "prepare") });
  const verify = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now, ...request("verify", "verify") });
  const settled = await evaluateClaimedStep(fixture.runId, {
    cwd: fixture.cwd, now: "2026-07-24T12:02:00.000Z", claim_id: prepare.claim.claim_id, liveness_id: prepare.claim.liveness_id, actor
  });
  assert.equal(settled.outcomes[0].status, "route-back");
  const loaded = await loadRun(fixture.runId, fixture.cwd);
  assert.deepEqual(loaded.state.multi_cursor.active_claims.map((claim) => claim.claim_id), [verify.claim.claim_id]);
  const routeProjection = projectFlowRun(loaded);
  assert.ok(routeProjection.multi_cursor.ready_steps.includes("prepare"));
  assert.ok(!routeProjection.multi_cursor.ready_steps.includes("publish"), "Console consumes the same route-back-aware join frontier as claim admission");
  const renewed = await renewStepClaim(fixture.runId, {
    cwd: fixture.cwd, now: "2026-07-24T12:03:00.000Z", claim_id: verify.claim.claim_id, liveness_id: verify.claim.liveness_id, actor
  });
  assert.equal(renewed.claim.claim_id, verify.claim.claim_id);
});

test("idempotent replay persists cleanup of an expired sibling", async () => {
  const fixture = await run("multi-idempotent-cleanup");
  const prepare = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("prepare", "prepare", 300) });
  const verify = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("verify", "verify", 1) });
  const replay = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:02.000Z", ...request("prepare", "prepare", 300) });
  assert.equal(replay.idempotent, true);
  const loaded = await loadRun(fixture.runId, fixture.cwd);
  assert.deepEqual(loaded.state.multi_cursor.active_claims.map((claim) => claim.claim_id), [prepare.claim.claim_id]);
  assert.ok(loaded.state.multi_cursor.claim_history.some((event) => event.action === "expired" && event.claim_id === verify.claim.claim_id));
});

test("renewal time is monotonic and cannot regress lease or audit history", async () => {
  const fixture = await run("multi-renew-monotonic");
  const claimed = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("prepare", "renew") });
  await renewStepClaim(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:01:00.000Z", claim_id: claimed.claim.claim_id, liveness_id: claimed.claim.liveness_id, actor });
  const before = await loadRun(fixture.runId, fixture.cwd);
  await assert.rejects(
    renewStepClaim(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:30.000Z", claim_id: claimed.claim.claim_id, liveness_id: claimed.claim.liveness_id, actor }),
    /flow\.multi_cursor\.claim\.time\.regression/
  );
  const after = await loadRun(fixture.runId, fixture.cwd);
  assert.deepEqual(after.state, before.state);
});

test("claim ids are single-use attempt identities", async () => {
  const fixture = await run("multi-claim-replay");
  const claimed = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("prepare", "once") });
  await releaseStepClaim(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:01.000Z", claim_id: claimed.claim.claim_id, liveness_id: claimed.claim.liveness_id, actor, reason: "retry elsewhere" });
  await assert.rejects(
    claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:02.000Z", ...request("prepare", "once") }),
    /flow\.multi_cursor\.claim\.replay/
  );
});

test("unknown reopen cannot unblock a run and a real block must remain frontier-coherent", async () => {
  const blockedDefinition = definition();
  delete blockedDefinition.gates["prepare-gate"].on_route_back;
  const fixture = await run("multi-reopen", blockedDefinition);
  const prepare = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("prepare", "prepare") });
  const verify = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("verify", "verify") });
  await evaluateClaimedStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:01:00.000Z", claim_id: prepare.claim.claim_id, liveness_id: prepare.claim.liveness_id, actor });
  await evaluateClaimedStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:02:00.000Z", claim_id: verify.claim.claim_id, liveness_id: verify.claim.liveness_id, actor });
  const blocked = await loadRun(fixture.runId, fixture.cwd);
  assert.equal(blocked.state.status, "blocked");
  await assert.rejects(reopenMultiCursorStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:03:00.000Z", step_id: "publish" }), /flow\.multi_cursor\.block\.missing/);
  assert.equal((await loadRun(fixture.runId, fixture.cwd)).state.status, "blocked");
  const reopened = await reopenMultiCursorStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:04:00.000Z", step_id: "prepare" });
  assert.equal(reopened.state.status, "active");
  assert.ok(projectFlowRun(reopened).multi_cursor.ready_steps.includes("prepare"));
});

test("definition amendment rejects active leases before any canonical write", async () => {
  const fixture = await run("multi-amendment");
  await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("prepare", "amend") });
  const before = await loadRun(fixture.runId, fixture.cwd);
  const successor = definition();
  successor.version = "2";
  const amendment = {
    reason: "test active lease fence",
    expected_run_head: flowRunHead(before.state),
    expected_definition: effectiveDefinitionIdentity(before.startDefinition, before.state),
    successor_digest: definitionDigest(successor),
    authority: { kind: "operator_request", actor: "operator:test", request_ref: "request:active-lease", requested_at: "2026-07-24T12:01:00.000Z" }
  };
  await assert.rejects(amendRunDefinition(fixture.runId, { cwd: fixture.cwd, request: amendment, definition: successor }), /definition amendment requires every active multi-cursor claim/);
  const after = await loadRun(fixture.runId, fixture.cwd);
  assert.deepEqual(after.state, before.state);
});

test("expired claims recover atomically and pause revokes every remaining lease", async () => {
  const fixture = await run("multi-recovery");
  const claimed = await claimReadyStep(fixture.runId, {
    cwd: fixture.cwd, now: "2026-07-24T12:00:00.000Z", ...request("prepare", "short", 1)
  });
  const recovered = await recoverExpiredStepClaims(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:02.000Z" });
  assert.deepEqual(recovered.expired.map((claim) => claim.claim_id), [claimed.claim.claim_id]);
  const again = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:00:03.000Z", ...request("prepare", "replacement") });
  await pauseRun(fixture.runId, {
    cwd: fixture.cwd, at: "2026-07-24T12:00:04.000Z", reason: "operator pause",
    authority: { kind: "operator_request", actor: "operator", request_ref: "request:pause", requested_at: "2026-07-24T12:00:04.000Z" }
  });
  const loaded = await loadRun(fixture.runId, fixture.cwd);
  assert.equal(loaded.state.multi_cursor.active_claims.length, 0);
  assert.ok(loaded.state.multi_cursor.claim_history.some((entry) => entry.claim_id === again.claim.claim_id && entry.action === "released"));
});

test("fan-in settles out of order and terminal completion waits for the joined step", async () => {
  const fixture = await run("multi-fan-in");
  for (const gate of ["prepare-gate", "verify-gate", "publish-gate"]) {
    await acceptException(fixture.runId, { cwd: fixture.cwd, gate, reason: "test authority", authority: "test" });
  }
  const now = "2026-07-24T12:00:00.000Z";
  const prepare = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now, ...request("prepare", "prepare") });
  const verify = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now, ...request("verify", "verify") });
  await evaluateClaimedStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:01:00.000Z", claim_id: verify.claim.claim_id, liveness_id: verify.claim.liveness_id, actor });
  let afterVerify = await loadRun(fixture.runId, fixture.cwd);
  assert.equal(afterVerify.state.status, "active");
  assert.equal(afterVerify.state.multi_cursor.active_claims[0].claim_id, prepare.claim.claim_id);
  assert.deepEqual(projectFlowRun(afterVerify).multi_cursor.ready_steps, [], "join stays closed while one predecessor remains active");
  await evaluateClaimedStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:02:00.000Z", claim_id: prepare.claim.claim_id, liveness_id: prepare.claim.liveness_id, actor });
  afterVerify = await loadRun(fixture.runId, fixture.cwd);
  assert.deepEqual(projectFlowRun(afterVerify).multi_cursor.ready_steps, ["publish"]);
  const publish = await claimReadyStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:03:00.000Z", ...request("publish", "publish") });
  const completed = await evaluateClaimedStep(fixture.runId, { cwd: fixture.cwd, now: "2026-07-24T12:04:00.000Z", claim_id: publish.claim.claim_id, liveness_id: publish.claim.liveness_id, actor });
  assert.equal(completed.state.status, "completed");
  assert.equal(completed.state.multi_cursor.active_claims.length, 0);
});
