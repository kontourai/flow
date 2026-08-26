import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { FLOW_RUN_RECOVERY_FENCE_PROTOCOL, attachEvidence, evaluateRun, loadRun, startRun, writeRunRecoveryFence } from "../../dist/index.js";
import { readGateEvaluation } from "../../dist/runtime/gate-evaluation-reader.js";
import { parseGateEvaluationReadResult } from "../../dist/contracts/gate-evaluation-contract.js";

const at = "2026-08-25T12:01:00.000Z";

async function fixture(name) {
  const cwd = await mkdtemp(path.join(tmpdir(), `flow-evaluation-reader-${name}-`));
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify({ id: "reader", version: "1", steps: [{ id: "verify", next: null }], gates: { "verify-gate": { step: "verify", expects: [] } } })}\n`);
  const started = await startRun(definitionPath, { cwd, runId: name });
  await evaluateRun(name, { cwd, now: at });
  const run = await loadRun(name, cwd);
  return { cwd, ...started, ref: run.state.gate_evaluation_ledger.records[0].ref };
}

test("authorized exact reader returns only persisted allowlisted data without mutation", async () => {
  const fixtureData = await fixture("found");
  const statePath = path.join(fixtureData.dir, "state.json");
  const manifestPath = path.join(fixtureData.dir, "evidence", "manifest.json");
  const before = await Promise.all([readFile(statePath), readFile(manifestPath)]);
  const result = await readGateEvaluation(fixtureData.ref, { cwd: fixtureData.cwd, authorize: ({ ref }) => ref.evaluationId === fixtureData.ref.evaluationId });
  const after = await Promise.all([readFile(statePath), readFile(manifestPath)]);
  assert.deepEqual(after, before);
  assert.equal(result.status, "found");
  assert.deepEqual(result.evaluation.ref, fixtureData.ref);
  assert.equal(result.evaluation.currentStanding, "current");
  assert.deepEqual(Object.keys(result.evaluation).sort(), ["currentPersistedGateRef", "currentRun", "currentStanding", "evaluatedAt", "kind", "originalVerdict", "ref", "selectedEvidence", "trigger"]);
  assert.doesNotMatch(JSON.stringify(result), /stored_path|original_path|bundle|authority/i);
});

test("denial and unknown IDs are opaque missing before a run load", async () => {
  const fixtureData = await fixture("opaque");
  let calls = 0;
  assert.deepEqual(await readGateEvaluation(fixtureData.ref, { cwd: fixtureData.cwd, authorize: () => { calls += 1; return false; } }), { status: "missing" });
  assert.equal(calls, 1);
  assert.deepEqual(await readGateEvaluation({ ...fixtureData.ref, evaluationId: "00000000-0000-4000-8000-000000000000" }, { cwd: fixtureData.cwd, authorize: () => true }), { status: "missing" });
});

test("legacy, future, and malformed ledger states do not produce a found projection", async () => {
  const fixtureData = await fixture("unsupported");
  const statePath = path.join(fixtureData.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  delete state.gate_evaluation_ledger;
  for (const outcome of [...state.gate_outcomes, ...state.gate_outcome_history]) delete outcome.evaluation_ref;
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  assert.deepEqual(await readGateEvaluation(fixtureData.ref, { cwd: fixtureData.cwd, authorize: () => true }), { status: "unsupported" });
  state.gate_evaluation_ledger = { version: "99", records: [] };
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  assert.deepEqual(await readGateEvaluation(fixtureData.ref, { cwd: fixtureData.cwd, authorize: () => true }), { status: "unsupported" });
  state.gate_evaluation_ledger = { version: "1", records: [{ nope: true }] };
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  assert.deepEqual(await readGateEvaluation(fixtureData.ref, { cwd: fixtureData.cwd, authorize: () => true }), { status: "unavailable" });
});

test("reader retains original selected evidence when a replacement or current policy state changes", async () => {
  const fixtureData = await fixture("selected");
  // Start again with one persisted selected file receipt. A no-expectation gate
  // waits, but its evaluator selection still records all attached evidence.
  const source = path.join(fixtureData.cwd, "old.txt");
  await writeFile(source, "old\n");
  const old = await attachEvidence(fixtureData.runId, { cwd: fixtureData.cwd, gate: "verify-gate", file: source, kind: "file" });
  await evaluateRun(fixtureData.runId, { cwd: fixtureData.cwd, now: "2026-08-25T12:02:00.000Z" });
  const original = (await loadRun(fixtureData.runId, fixtureData.cwd)).state.gate_evaluation_ledger.records.at(-1);
  const replacement = path.join(fixtureData.cwd, "new.txt");
  await writeFile(replacement, "new\n");
  await attachEvidence(fixtureData.runId, { cwd: fixtureData.cwd, gate: "verify-gate", file: replacement, kind: "file", supersede: old.id });
  const manifestPath = path.join(fixtureData.dir, "evidence", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const selected = manifest.evidence.find((entry) => entry.id === old.id);
  original.selections[0].claimIds = ["claim.old"];
  const statePath = path.join(fixtureData.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.gate_evaluation_ledger.records.at(-1).selections[0].claimIds = ["claim.old"];
  await writeFile(statePath, `${JSON.stringify(state)}\n`);
  selected.inquiry_records = [{ asOf: original.evaluatedAt, statusByClaimId: { "claim.old": "stale" } }];
  selected.bundle = { schemaVersion: 7, source: "test", claims: [], evidence: [], policies: [], events: [{ status: "revoked", createdAt: original.evaluatedAt }], authorityTrace: [{ revokedAt: original.evaluatedAt }] };
  selected.bundle_report = { claims: [{ id: "claim.old", status: "stale", freshness: { stale: true } }, { id: "claim.unrelated", status: "stale", freshness: { stale: true } }] };
  selected.bundle.events[0].claimId = "claim.old";
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  const result = await readGateEvaluation(original.ref, { cwd: fixtureData.cwd, authorize: () => true });
  assert.equal(result.status, "found");
  assert.equal(result.evaluation.originalVerdict, "wait", "the original verdict is never re-evaluated under a replacement or later policy");
  assert.equal(result.evaluation.selectedEvidence.length, 1);
  assert.equal(result.evaluation.selectedEvidence[0].evidenceId, old.id);
  assert.equal(result.evaluation.selectedEvidence[0].standing, "superseded");
  assert.equal(result.evaluation.selectedEvidence[0].freshness, "stale");
  assert.deepEqual(result.evaluation.selectedEvidence[0].revocationCodes, ["revoked"]);
  assert.deepEqual(parseGateEvaluationReadResult(result), result);
  assert.equal(parseGateEvaluationReadResult({ status: "found", evaluation: { ...result.evaluation, selectedEvidence: {} } }), undefined);
});

test("reader honors the native recovery fence without repairing or mutating the run", async () => {
  const fixtureData = await fixture("fenced");
  await writeRunRecoveryFence(fixtureData.runId, {
    protocol: FLOW_RUN_RECOVERY_FENCE_PROTOCOL,
    run_id: fixtureData.runId,
    recovery_id: "recovery:reader-test",
    status: "active",
    updated_at: at
  }, fixtureData.cwd);
  const before = await readFile(path.join(fixtureData.dir, "state.json"));
  assert.deepEqual(await readGateEvaluation(fixtureData.ref, { cwd: fixtureData.cwd, authorize: () => true }), { status: "unavailable" });
  assert.deepEqual(await readFile(path.join(fixtureData.dir, "state.json")), before);
});
