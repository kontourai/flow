import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  __setPublishRunArtifactsFaultHooks, attachEvidence,
  acceptException, claimReadyStep, continuePausedGate, evaluateClaimedStep,
  evaluateRun, flowRunHead, loadRun, pauseRun, startRun
} from "../../dist/index.js";
import { parseGateEvaluationProjection, parseGateEvaluationRecord } from "../../dist/contracts/gate-evaluation-contract.js";

const authority = (ref) => ({ kind: "operator_request", actor: "operator:test", request_ref: ref, requested_at: "2026-08-25T12:00:00.000Z" });
const at = "2026-08-25T12:01:00.000Z";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function singleDefinition(overrides = {}) {
  return {
    id: "evaluation-ledger", version: "1",
    steps: [{ id: "verify", next: null }],
    gates: { "verify-gate": { step: "verify", expects: [] } },
    ...overrides
  };
}

async function fixture(name, definition = singleDefinition()) {
  const cwd = await mkdtemp(path.join(tmpdir(), `flow-evaluation-ledger-${name}-`));
  const file = path.join(cwd, "definition.json");
  await writeFile(file, `${JSON.stringify(definition)}\n`);
  return { cwd, ...(await startRun(file, { cwd, runId: name })) };
}

test("ordinary committed evaluations append opaque receipts without backfilling or changing retry accounting", async () => {
  const run = await fixture("ordinary");
  assert.deepEqual(run.state.gate_evaluation_ledger, { version: "1", records: [] });
  await evaluateRun(run.runId, { cwd: run.cwd, now: at });
  await evaluateRun(run.runId, { cwd: run.cwd, now: at });
  const persisted = await loadRun(run.runId, run.cwd);
  const records = persisted.state.gate_evaluation_ledger.records;
  assert.equal(records.length, 2);
  assert.notEqual(records[0].ref.evaluationId, records[1].ref.evaluationId, "each committed appraisal has a fresh opaque id even at the same timestamp");
  assert.deepEqual(records[1].previousRef, records[0].ref);
  assert.equal(persisted.state.gate_outcome_history.length, 2);
  assert.equal(persisted.state.gate_outcome_history[0].evaluation_ref.evaluationId, records[0].ref.evaluationId);
  assert.equal(persisted.state.gate_outcome_history[1].evaluation_ref.evaluationId, records[1].ref.evaluationId);
  assert.equal(parseGateEvaluationRecord(records[0])?.ref.evaluationId, records[0].ref.evaluationId);
  assert.equal(parseGateEvaluationRecord({ version: "1" }), undefined);
  assert.equal(parseGateEvaluationRecord({ ...records[0], evaluatedAt: "not-a-date" }), undefined);
  assert.equal(parseGateEvaluationRecord({ ...records[0], definition: { ...records[0].definition, rawBundle: {} } }), undefined);
  const throwingRef = {};
  Object.defineProperty(throwingRef, "runId", { enumerable: true, get() { throw new Error("must not execute"); } });
  assert.equal(parseGateEvaluationRecord({ ...records[0], ref: throwingRef }), undefined);
  assert.deepEqual(parseGateEvaluationProjection({ ref: records[0].ref, evaluatedAt: records[0].evaluatedAt, originalVerdict: records[0].originalVerdict }), { ref: records[0].ref, evaluatedAt: records[0].evaluatedAt, originalVerdict: records[0].originalVerdict });
  assert.equal(parseGateEvaluationProjection({ ref: records[0].ref, evaluatedAt: records[0].evaluatedAt, originalVerdict: records[0].originalVerdict, rawBundle: {} }), undefined);
});

test("ledger validation rejects dangling, mismatched, and broken causal references", async () => {
  const run = await fixture("invalid");
  await evaluateRun(run.runId, { cwd: run.cwd, now: at });
  const statePath = path.join(run.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.gate_outcomes[0].evaluation_ref.evaluationId = "00000000-0000-4000-8000-000000000000";
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await assert.rejects(loadRun(run.runId, run.cwd), /gate_evaluation_ledger\.outcome_ref\.dangling/);
});

test("ledger validation rejects a claim witness altered independently of immutable outcome history", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-evaluation-ledger-witness-"));
  const definitionPath = path.join(repoRoot, "examples", "deploy-live-verify-flow.json");
  const bundlePath = path.join(repoRoot, "examples", "scenarios", "deploy-live-verify", "static-build.bundle.json");
  const run = await startRun(definitionPath, { cwd, runId: "altered-witness" });
  await attachEvidence(run.runId, { cwd, gate: "build-gate", file: bundlePath, kind: "trust.bundle" });
  await evaluateRun(run.runId, { cwd, now: at });
  const statePath = path.join(run.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.gate_evaluation_ledger.records[0].selections[0].claimIds = ["claim.invented"];
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await assert.rejects(loadRun(run.runId, cwd), /gate_evaluation_ledger\.selection\.conflict/);
});

test("an unknown present ledger version is explicitly unsupported; only genuine legacy omission remains readable", async () => {
  const run = await fixture("unsupported");
  const statePath = path.join(run.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.gate_evaluation_ledger;
  for (const outcome of [...state.gate_outcomes, ...state.gate_outcome_history]) delete outcome.evaluation_ref;
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await assert.doesNotReject(loadRun(run.runId, run.cwd));
  state.gate_evaluation_ledger = { version: "99", records: [] };
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await assert.rejects(loadRun(run.runId, run.cwd), /gate_evaluation_ledger\.unsupported/);
});

test("a removed ledger cannot orphan committed outcome references", async () => {
  const run = await fixture("missing-ledger");
  await evaluateRun(run.runId, { cwd: run.cwd, now: at });
  const statePath = path.join(run.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.gate_evaluation_ledger;
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  await assert.rejects(loadRun(run.runId, run.cwd), /gate_evaluation_ledger\.missing/);
});

test("a failed publication before state.json leaves no phantom appraisal, while concurrent commits serialize a chain", async () => {
  const failed = await fixture("no-phantom");
  __setPublishRunArtifactsFaultHooks({ afterStage: (index) => { if (index === 2) throw new Error("injected-before-state"); } });
  try {
    await assert.rejects(evaluateRun(failed.runId, { cwd: failed.cwd, now: at }), /injected-before-state/);
  } finally {
    __setPublishRunArtifactsFaultHooks();
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(failed.dir, "state.json"), "utf8")).gate_evaluation_ledger.records, []);

  const concurrent = await fixture("concurrent");
  await Promise.all([evaluateRun(concurrent.runId, { cwd: concurrent.cwd, now: at }), evaluateRun(concurrent.runId, { cwd: concurrent.cwd, now: at })]);
  const records = (await loadRun(concurrent.runId, concurrent.cwd)).state.gate_evaluation_ledger.records;
  assert.equal(records.length, 2);
  assert.deepEqual(records[1].previousRef, records[0].ref);
});

test("claimed and paused writers mint only when their evaluations settle and publish", async () => {
  const multi = await fixture("claimed", singleDefinition({
    id: "claimed-ledger", version: "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "verify", next: null, mutable_resources: [] }], gates: { "verify-gate": { step: "verify", expects: [] } }
  }));
  const claim = await claimReadyStep(multi.runId, { cwd: multi.cwd, now: at, claim_id: "claim-a", liveness_id: "lease-a", step_id: "verify", actor: { key: "host" } });
  const waiting = await evaluateClaimedStep(multi.runId, { cwd: multi.cwd, now: at, claim_id: claim.claim.claim_id, liveness_id: claim.claim.liveness_id, actor: { key: "host" } });
  assert.equal(waiting.settled, false);
  assert.equal((await loadRun(multi.runId, multi.cwd)).state.gate_evaluation_ledger.records.length, 0);

  const settled = await fixture("claimed-settled", singleDefinition({
    id: "claimed-settled-ledger", version: "1", execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [{ id: "verify", next: null, mutable_resources: [] }], gates: { "verify-gate": { step: "verify", expects: [] } }
  }));
  await acceptException(settled.runId, { cwd: settled.cwd, gate: "verify-gate", reason: "test", authority: "operator" });
  const settledClaim = await claimReadyStep(settled.runId, { cwd: settled.cwd, now: at, claim_id: "claim-b", liveness_id: "lease-b", step_id: "verify", actor: { key: "host" } });
  assert.equal((await evaluateClaimedStep(settled.runId, { cwd: settled.cwd, now: at, claim_id: settledClaim.claim.claim_id, liveness_id: settledClaim.claim.liveness_id, actor: { key: "host" } })).settled, true);
  assert.equal((await loadRun(settled.runId, settled.cwd)).state.gate_evaluation_ledger.records[0].trigger, "claimed");

  const paused = await fixture("paused");
  await pauseRun(paused.runId, { cwd: paused.cwd, at, reason: "wait", authority: authority("pause") });
  const marker = path.join(paused.cwd, "marker.txt");
  await writeFile(marker, "marker\n");
  const before = await loadRun(paused.runId, paused.cwd);
  const result = await continuePausedGate(paused.runId, {
    cwd: paused.cwd, gate: "verify-gate", expectedRunHead: flowRunHead(before.state), evidence: { file: marker, kind: "file" }, resumeOnPass: false, now: at
  });
  assert.equal(result.committed, false);
  assert.equal((await loadRun(paused.runId, paused.cwd)).state.gate_evaluation_ledger.records.length, 0);
});
