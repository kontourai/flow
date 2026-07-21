import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  startRun,
  validateRunStateConsistency
} from "../../dist/index.js";
import { repairRunReports } from "../../dist/runtime/flow-run-store.js";
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
  assert.equal(Object.hasOwn(before.state, "definition_digest"), false, "ordinary runs keep the pre-amendment state contract");
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
  const manifestBeforeStaleAttachment = await readFile(manifestFile);
  await assert.rejects(
    attachEvidence(runId, {
      cwd, gate: "execute-gate", file: failedEvidence, status: "failed", route_reason: "plan_gap",
      expectedRunHead: flowRunHead(before.state)
    }),
    /flow\.run_head\.stale/
  );
  assert.deepEqual(await readFile(manifestFile), manifestBeforeStaleAttachment, "stale expected head rejects before evidence mutation");
  await attachEvidence(runId, {
    cwd, gate: "execute-gate", file: failedEvidence, status: "failed", route_reason: "plan_gap",
    expectedRunHead: flowRunHead(after.state)
  });
  const evaluated = await evaluateRun(runId, { cwd, gate: "execute-gate" });
  assert.equal(evaluated.state.current_step, "plan", "AC2: ordinary route-back uses the newly declared plan_gap route");
  const afterRoute = await loadRun(runId, cwd);
  assert.equal(afterRoute.state.current_step, "plan", "the amended ledger remains valid after successor-only history is recorded");
  const validated = validateRunStateConsistency(afterRoute.startDefinition, afterRoute.state, { runId });
  assert.deepEqual(validated.definition, afterRoute.definition, "the public pure validator returns the canonical effective definition");
  assert.deepEqual(validated.state, afterRoute.state, "the public pure validator returns normalized canonical state");
  const forgedRouteHistory = structuredClone(afterRoute.state);
  forgedRouteHistory.transitions.at(-1).attempt = 999;
  assert.throws(
    () => validateRunStateConsistency(afterRoute.startDefinition, forgedRouteHistory, { runId }),
    /flow\.retry_authorization\.history\.invalid/,
    "schema-valid forged route history is rejected by the same semantic validator as loadRun"
  );
  const later = structuredClone(next);
  later.version = "opaque-later-head";
  later.gates["plan-gate"] = { step: "plan", expects: [] };
  await amendRunDefinition(runId, { cwd, request: request(afterRoute, later, "request:definition-amendment-later"), definition: later });
  const twiceAmended = await loadRun(runId, cwd);
  assert.equal(twiceAmended.definition.version, later.version);
  assert.equal(twiceAmended.state.definition_amendments.length, 2, "each compatibility proof replays against its own exact prior state");
});

test("AC3 AC5: replay, stale heads, and pre-state faults reject without canonical mutation", async () => {
  const { cwd, runId, before } = await fixture("reject");
  const next = successor();
  const acceptedRequest = request(before, next);
  const stateFile = path.join(before.dir, "state.json");
  const reportFile = path.join(before.dir, "report.json");
  const snapshot = async () => Promise.all([readFile(stateFile), readFile(reportFile)]);
  const prior = await snapshot();
  assert.throws(
    () => attachEvidence(runId, { cwd, gate: "execute-gate", file: stateFile, expectedRunHead: "not-a-digest" }),
    /flow\.run_head\.invalid/
  );
  assert.deepEqual(await snapshot(), prior, "malformed attachment CAS rejects without canonical mutation");
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

  const amended = await loadRun(runId, cwd);
  const rollbackRequest = request(amended, initialDefinition, "request:definition-amendment-rollback");
  await assert.rejects(
    amendRunDefinition(runId, { cwd, request: rollbackRequest, definition: initialDefinition }),
    /flow\.definition_amendment\.compatibility\.invalid/
  );
  assert.deepEqual(await snapshot(), committed, "reusing the immutable start identity rejects before canonical mutation");
});

test("AC5: an interrupted ahead-report publication is repaired from the canonical state on load", async () => {
  const { cwd, runId, before } = await fixture("crash-repair");
  const next = successor();
  const successorPath = path.join(cwd, "successor.json");
  const requestPath = path.join(cwd, "request.json");
  await Promise.all([
    writeFile(successorPath, `${JSON.stringify(next, null, 2)}\n`),
    writeFile(requestPath, `${JSON.stringify(request(before, next, "request:definition-amendment-crash"), null, 2)}\n`)
  ]);
  const statePath = path.join(before.dir, "state.json");
  const reportJsonPath = path.join(before.dir, "report.json");
  const reportMarkdownPath = path.join(before.dir, "report.md");
  const prior = await Promise.all([readFile(statePath), readFile(reportJsonPath), readFile(reportMarkdownPath)]);
  const moduleUrl = new URL("../../dist/index.js", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import { amendRunDefinition } from ${JSON.stringify(moduleUrl)};
    const [cwd, successorPath, requestPath] = process.argv.slice(1);
    await amendRunDefinition("amendment-run", {
      cwd,
      definition: JSON.parse(fs.readFileSync(successorPath, "utf8")),
      request: JSON.parse(fs.readFileSync(requestPath, "utf8")),
      faultInjection(stage) { if (stage === "before_rename_state") process.exit(91); }
    });
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, cwd, successorPath, requestPath], { encoding: "utf8" });
  assert.equal(child.status, 91, child.stderr);
  assert.deepEqual(await readFile(statePath), prior[0], "state is still the sole commit point");
  assert.notDeepEqual(await readFile(reportJsonPath), prior[1], "the interrupted process left an ahead JSON projection");
  const reportResult = await execFile(process.execPath, [cliPath, "report", runId, "--cwd", cwd]);
  assert.match(reportResult.stdout, /report:/);
  assert.deepEqual(await readFile(reportJsonPath), prior[1], "canonical load repairs ahead JSON");
  assert.deepEqual(await readFile(reportMarkdownPath), prior[2], "canonical load repairs ahead Markdown");

  const stale = await loadRun(runId, cwd);
  await amendRunDefinition(runId, { cwd, request: request(stale, next, "request:definition-amendment-after-crash"), definition: next });
  await repairRunReports(stale);
  const latestReport = JSON.parse(await readFile(reportJsonPath, "utf8"));
  assert.equal(latestReport.effective_definition.version, next.version, "repair reloads under the mutation ticket instead of publishing a stale caller snapshot");
});

test("AC3: accepted history and same-head concurrency reject before a losing write", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-definition-amendment-history-"));
  const definition = structuredClone(initialDefinition);
  definition.gates["execute-gate"].expects = [{
    id: "scope-accepted", kind: "trust.bundle", required: true, description: "Accepted execution scope.",
    bundle_claim: { claimType: "builder.execute.scope", subjectId: "history-run", accepted_statuses: ["verified"] }
  }];
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  const started = await startRun(definitionPath, { cwd, runId: "history-run" });
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.gate_outcomes = [{
    gate_id: "execute-gate", status: "pass", summary: "scope accepted", evidence_refs: ["ev.scope"],
    matched_expectations: [{ expectation_id: "scope-accepted", evidence_id: "ev.scope" }]
  }];
  state.gate_outcome_history = structuredClone(state.gate_outcomes);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const before = await loadRun(started.runId, cwd);
  const removed = structuredClone(definition);
  removed.version = "removed-accepted-expectation";
  removed.gates["execute-gate"].expects = [];
  const bytes = await readFile(statePath);
  await assert.rejects(
    amendRunDefinition(started.runId, { cwd, request: request(before, removed, "request:remove-accepted"), definition: removed }),
    /successor (?:changes|reinterprets) accepted expectation|successor reinterprets persisted gate/
  );
  assert.deepEqual(await readFile(statePath), bytes);

  const race = await fixture("concurrent");
  const left = successor();
  left.version = "concurrent-left";
  const right = successor();
  right.version = "concurrent-right";
  right.gates["execute-gate"].on_route_back.decision_gap = "plan";
  const settled = await Promise.allSettled([
    amendRunDefinition(race.runId, { cwd: race.cwd, request: request(race.before, left, "request:concurrent-left"), definition: left }),
    amendRunDefinition(race.runId, { cwd: race.cwd, request: request(race.before, right, "request:concurrent-right"), definition: right })
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(settled.filter((entry) => entry.status === "rejected" && /flow\.definition_amendment\.run_head\.stale/.test(String(entry.reason))).length, 1);
  assert.equal((await loadRun(race.runId, race.cwd)).state.definition_amendments.length, 1);
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
  const amended = await loadRun(runId, cwd);
  assert.equal(amended.state.definition_version, "opaque-corrected-head");
  const evidencePath = path.join(cwd, "cli-evidence.txt");
  await writeFile(evidencePath, "definition-bound evidence\n");
  await assert.rejects(
    execFile(process.execPath, [
      cliPath, "attach-evidence", runId, "--gate", "execute-gate", "--file", evidencePath,
      "--expected-run-head", flowRunHead(before.state), "--cwd", cwd
    ]),
    (error) => /flow\.run_head\.stale/.test(error.stderr)
  );
  const attached = await execFile(process.execPath, [
    cliPath, "attach-evidence", runId, "--gate", "execute-gate", "--file", evidencePath,
    "--expected-run-head", flowRunHead(amended.state), "--cwd", cwd
  ]);
  assert.match(attached.stdout, /attached evidence:/);
});
