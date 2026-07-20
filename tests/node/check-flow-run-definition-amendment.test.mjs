import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  FlowDefinitionAmendmentError,
  attachEvidence,
  amendRunDefinition,
  assertExpectedDefinitionIdentity,
  definitionDigest,
  effectiveDefinitionIdentity,
  flowRunHead,
  loadRun,
  evaluateRun,
  startRun
} from "../../dist/index.js";
import { cliPath, execFile } from "./helpers/cli.mjs";

const initialDefinition = {
  id: "definition-amendment-fixture",
  version: "1",
  steps: [{ id: "execute", next: null }, { id: "plan", next: "execute" }],
  gates: {
    "execute-gate": { step: "execute", expects: [], on_route_back: { default: "execute" } }
  }
};

function successor() {
  const next = structuredClone(initialDefinition);
  next.version = "opaque-corrected-head";
  next.gates["execute-gate"].on_route_back.plan_gap = "plan";
  return next;
}

async function fixture(name) {
  const cwd = await mkdtemp(path.join(tmpdir(), `flow-definition-amendment-${name}-`));
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(initialDefinition, null, 2)}\n`);
  const started = await startRun(definitionPath, { cwd, runId: "amendment-run", params: { subject: "definition amendment" } });
  const before = await loadRun(started.runId, cwd);
  return { cwd, runId: started.runId, before };
}

function request(before, next, requestRef = "request:definition-amendment") {
  return {
    reason: "Correct the active execute gate route.",
    expected_run_head: flowRunHead(before.state),
    expected_definition: effectiveDefinitionIdentity(before.startDefinition, before.state),
    successor_digest: definitionDigest(next),
    authority: {
      kind: "operator_request",
      actor: "operator:test",
      request_ref: requestRef,
      requested_at: "2026-07-20T05:00:00.000Z"
    }
  };
}

test("AC1 AC4 AC5: compatible amendment preserves immutable artifacts and projects an effective identity", async () => {
  const { cwd, runId, before } = await fixture("accepted");
  const definitionFile = path.join(before.dir, "definition.json");
  const manifestFile = path.join(before.dir, "evidence", "manifest.json");
  const [definitionBytes, manifestBytes] = await Promise.all([readFile(definitionFile), readFile(manifestFile)]);
  const next = successor();
  const result = await amendRunDefinition(runId, { cwd, request: request(before, next), definition: next });
  const after = await loadRun(runId, cwd);

  assert.equal(result.idempotent, false);
  assert.equal(after.definition.version, next.version);
  assert.equal(after.state.definition_digest, definitionDigest(next));
  assert.equal(after.state.definition_amendments.length, 1);
  assert.deepEqual(after.state.definition_amendments[0].successor, next);
  assert.deepEqual(await readFile(definitionFile), definitionBytes, "definition.json is the immutable start snapshot");
  assert.deepEqual(await readFile(manifestFile), manifestBytes, "evidence manifest remains start-bound");
  assert.throws(
    () => assertExpectedDefinitionIdentity(after.startDefinition, after.state, request(before, next).expected_definition),
    (error) => error instanceof FlowDefinitionAmendmentError && error.code === "flow.definition_amendment.definition_head.stale"
  );
  const failedEvidence = path.join(cwd, "failed.txt");
  await writeFile(failedEvidence, "route this correction back to plan\n");
  await attachEvidence(runId, { cwd, gate: "execute-gate", file: failedEvidence, status: "failed", route_reason: "plan_gap" });
  const evaluated = await evaluateRun(runId, { cwd, gate: "execute-gate" });
  assert.equal(evaluated.state.current_step, "plan", "AC2: ordinary route-back uses the newly declared plan_gap route");
});

test("AC3 AC5: replay, stale heads, and pre-state faults reject without canonical mutation", async () => {
  const { cwd, runId, before } = await fixture("reject");
  const next = successor();
  const acceptedRequest = request(before, next);
  const stateFile = path.join(before.dir, "state.json");
  const reportFile = path.join(before.dir, "report.json");
  const snapshot = async () => Promise.all([readFile(stateFile), readFile(reportFile)]);
  const prior = await snapshot();
  await assert.rejects(
    amendRunDefinition(runId, { cwd, request: { ...acceptedRequest, expected_run_head: "0".repeat(64) }, definition: next }),
    /flow\.definition_amendment\.run_head\.stale/
  );
  assert.deepEqual(await snapshot(), prior);
  await assert.rejects(
    amendRunDefinition(runId, { cwd, request: acceptedRequest, definition: next, faultInjection(stage) { if (stage === "before_rename_state") throw new Error("injected"); } }),
    /injected/
  );
  assert.deepEqual(await snapshot(), prior);
  await amendRunDefinition(runId, { cwd, request: acceptedRequest, definition: next });
  const committed = await snapshot();
  await assert.rejects(amendRunDefinition(runId, { cwd, request: acceptedRequest, definition: next }), /flow\.definition_amendment\.replay\.conflict/);
  assert.deepEqual(await snapshot(), committed);
});

test("AC2 AC6: CLI amends the same run and reports prior and effective identities", async () => {
  const { cwd, runId, before } = await fixture("cli");
  const next = successor();
  const successorPath = path.join(cwd, "successor.json");
  const requestPath = path.join(cwd, "request.json");
  await Promise.all([
    writeFile(successorPath, `${JSON.stringify(next, null, 2)}\n`),
    writeFile(requestPath, `${JSON.stringify(request(before, next, "request:definition-amendment-cli"), null, 2)}\n`)
  ]);
  const result = await execFile(process.execPath, [cliPath, "amend-definition", runId, "--definition", successorPath, "--request", requestPath, "--cwd", cwd]);
  assert.match(result.stdout, /definition amended: amendment-run/);
  assert.match(result.stdout, /prior: definition-amendment-fixture v1/);
  assert.match(result.stdout, /effective: definition-amendment-fixture vopaque-corrected-head/);
  assert.equal((await loadRun(runId, cwd)).state.definition_version, "opaque-corrected-head");
});
