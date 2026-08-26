import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FLOW_RUN_RECOVERY_FENCE_PROTOCOL, attachEvidence, evaluateRun, loadRun, startRun, writeRunRecoveryFence } from "../../dist/index.js";
import { readGateEvaluation } from "../../dist/runtime/gate-evaluation-reader.js";
import { parseGateEvaluationReadResult } from "../../dist/contracts/gate-evaluation-contract.js";
import { json } from "./helpers/fixtures.mjs";

const at = "2026-08-25T12:01:00.000Z";
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

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

test("a passing trust.bundle evaluation round-trips its claimed ID through the immutable reader", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-evaluation-reader-pass-roundtrip-"));
  const definitionPath = path.join(repoRoot, "examples", "deploy-live-verify-flow.json");
  const bundlePath = path.join(repoRoot, "examples", "scenarios", "deploy-live-verify", "static-build.bundle.json");
  const started = await startRun(definitionPath, { cwd, runId: "reader-pass-roundtrip" });
  const attached = await attachEvidence(started.runId, {
    cwd,
    gate: "build-gate",
    file: bundlePath,
    kind: "trust.bundle"
  });
  const evaluated = await evaluateRun(started.runId, { cwd, now: at });
  assert.equal(evaluated.outcomes[0].status, "pass");

  // A fresh load is the persistence/restart boundary; all following assertions
  // use only the committed run artifacts and the public reader contract.
  const restarted = await loadRun(started.runId, cwd);
  const outcome = restarted.state.gate_outcomes.find((candidate) => candidate.gate_id === "build-gate");
  const history = restarted.state.gate_outcome_history.find((candidate) => candidate.gate_id === "build-gate");
  const record = restarted.state.gate_evaluation_ledger.records.find((candidate) => candidate.ref.evaluationId === outcome.evaluation_ref.evaluationId);
  const expectedClaimIds = ["claim.quality.tests.release-worker"];

  assert.deepEqual(outcome.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: attached.id, claim_ids: expectedClaimIds }]);
  assert.deepEqual(history.matched_expectations, outcome.matched_expectations);
  assert.deepEqual(history.evaluation_ref, outcome.evaluation_ref);
  assert.ok(record, "the current outcome must reference its exact committed evaluation record");
  assert.deepEqual(record.ref, outcome.evaluation_ref);
  assert.deepEqual(record.selections, [{ expectationId: "tests-passed", evidenceId: attached.id, sha256: attached.sha256, claimIds: expectedClaimIds }]);

  const result = await readGateEvaluation(record.ref, { cwd, authorize: () => true });
  assert.equal(result.status, "found");
  assert.deepEqual(result.evaluation.ref, record.ref);
  assert.deepEqual(parseGateEvaluationReadResult(result), result);

  const [readResultSchema, refSchema] = await Promise.all([
    json("schemas/gate-evaluation-read-result.schema.json"),
    json("schemas/gate-evaluation-ref.schema.json")
  ]);
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(refSchema);
  const validate = ajv.compile(readResultSchema);
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
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
