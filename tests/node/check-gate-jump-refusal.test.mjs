/**
 * flow#202 — `evaluate --gate` at a non-current step used to synthesise
 * `{...state, current_step: gate.step}` before validating, so the `jump.invalid`
 * guard compared the gate against itself and could never fire. The real cursor
 * then advanced, and the run persisted a transition naming a `from_step` it had
 * never been on, stamped `transition_validation.status: "allowed"`.
 *
 * The known-bad fixture is the first test: on pre-fix code the run walks
 * `plan (blocked) -> publish` and records `from_step: verify`.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acceptException,
  applyEvaluation,
  attachEvidence,
  evaluateRun,
  initialState,
  loadRun,
  reportJson,
  startRun
} from "../../dist/index.js";

function trustExpectation(id, step) {
  return [{
    id,
    kind: "trust.bundle",
    required: true,
    description: id,
    bundle_claim: {
      claimType: id,
      subjectType: "flow-step",
      subjectId: `jump.${step}`,
      accepted_statuses: ["verified"]
    }
  }];
}

const definition = {
  id: "gate-jump-flow",
  version: "1",
  steps: [
    { id: "plan", next: "verify" },
    { id: "verify", next: "publish" },
    { id: "publish", next: null }
  ],
  gates: {
    "plan-gate": { step: "plan", expects: trustExpectation("plan.ready", "plan") },
    "verify-gate": { step: "verify", expects: trustExpectation("quality.tests", "verify") },
    "publish-gate": { step: "publish", expects: trustExpectation("release.notes", "publish") }
  }
};

async function startJumpRun(runId) {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-gate-jump-"));
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  await startRun(definitionPath, { cwd, runId, params: { subject: "gate jump probe" } });
  return cwd;
}

test("evaluate --gate at a later step is refused and names the gates it would skip", async () => {
  const cwd = await startJumpRun("jump-1");

  // The plan gate genuinely blocks: no evidence is attached for it.
  await evaluateRun("jump-1", { cwd });
  const blocked = await loadRun("jump-1", cwd);
  assert.equal(blocked.state.current_step, "plan");
  assert.equal(blocked.state.status, "blocked");

  // An accepted exception on the *verify* gate would make it pass, which on
  // pre-fix code carried the run from plan straight to publish.
  await acceptException("jump-1", { cwd, gate: "verify-gate", reason: "probe", authority: "probe-operator" });

  await assert.rejects(
    evaluateRun("jump-1", { cwd, gate: "verify-gate" }),
    (error) => {
      assert.equal(error.code, "flow.evaluate.gate.not_current");
      assert.deepEqual(error.skipped_steps, ["plan"], "the diagnostic names the gate the request would skip");
      assert.match(error.message, /past the unevaluated gate\(s\) on: plan/);
      return true;
    }
  );

  const after = await loadRun("jump-1", cwd);
  assert.equal(after.state.current_step, "plan", "the refused request must not move the cursor");
  const fabricated = after.state.transitions.filter((entry) => entry.from_step === "verify");
  assert.deepEqual(fabricated, [], "no transition may name a step the run was never on");
});

test("a refused gate jump writes nothing at all", async () => {
  const cwd = await startJumpRun("jump-2");
  const before = await loadRun("jump-2", cwd);
  const stateBefore = await readFile(path.join(before.dir, "state.json"), "utf8");

  await assert.rejects(
    evaluateRun("jump-2", { cwd, gate: "publish-gate" }),
    (error) => {
      assert.equal(error.code, "flow.evaluate.gate.not_current");
      assert.deepEqual(error.skipped_steps, ["plan", "verify"]);
      return true;
    }
  );

  assert.equal(
    await readFile(path.join(before.dir, "state.json"), "utf8"),
    stateBefore,
    "a refused evaluation leaves the record byte-identical"
  );
});

// ---------------------------------------------------------------------------
// #223: evidence writes are refused for gates the run cannot appraise
// ---------------------------------------------------------------------------

test("#223: attach-evidence for a gate past an unevaluated gate is refused and writes nothing", async () => {
  const cwd = await startJumpRun("ev-unreached-1");
  const before = await loadRun("ev-unreached-1", cwd);
  const stateBefore = await readFile(path.join(before.dir, "state.json"), "utf8");
  const manifestBefore = await readFile(path.join(before.dir, "evidence", "manifest.json"), "utf8");

  // The run is on plan (never evaluated). publish-gate sits past the
  // unevaluated plan-gate AND verify-gate — the walk cannot reach it.
  const evidencePath = path.join(cwd, "premature.json");
  await writeFile(evidencePath, `${JSON.stringify({ premature: true })}\n`);
  await assert.rejects(
    attachEvidence("ev-unreached-1", { cwd, gate: "publish-gate", file: evidencePath }),
    (error) => {
      assert.equal(error.code, "flow.evidence.gate.unreached");
      assert.match(error.message, /publish-gate/);
      assert.match(error.message, /plan/);
      return true;
    }
  );

  assert.equal(await readFile(path.join(before.dir, "state.json"), "utf8"), stateBefore, "state untouched");
  assert.equal(await readFile(path.join(before.dir, "evidence", "manifest.json"), "utf8"), manifestBefore, "manifest untouched");
});

test("#223: attach-evidence for the gate the gateless walk lands on remains legal", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-ev-gateless-"));
  const gatelessDefinition = {
    id: "ev-gateless-flow",
    version: "1",
    steps: [
      { id: "produce", next: "review" },
      { id: "review", next: "signoff" },
      { id: "signoff", next: null }
    ],
    gates: {
      "review-gate": { step: "review", expects: [] },
      "signoff-gate": { step: "signoff", expects: [] }
    }
  };
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(gatelessDefinition, null, 2)}\n`);
  await startRun(definitionPath, { cwd, runId: "ev-gateless-1", params: { subject: "pre-stage" } });

  // Cursor is on gateless `produce`; review-gate is what the walk lands on.
  const evidencePath = path.join(cwd, "review.json");
  await writeFile(evidencePath, `${JSON.stringify({ ok: true })}\n`);
  const entry = await attachEvidence("ev-gateless-1", { cwd, gate: "review-gate", file: evidencePath });
  assert.equal(entry.gate_id, "review-gate");

  // But signoff-gate sits past the unevaluated review-gate — refused.
  await assert.rejects(
    attachEvidence("ev-gateless-1", { cwd, gate: "signoff-gate", file: evidencePath }),
    (error) => {
      assert.equal(error.code, "flow.evidence.gate.unreached");
      return true;
    }
  );

  // The cursor was NOT moved by the refused write.
  const run = await loadRun("ev-gateless-1", cwd);
  assert.equal(run.state.current_step, "produce");
});

test("#223: attach-evidence for an already-occupied step remains legal", async () => {
  const cwd = await startJumpRun("ev-occupied-1");

  // Evaluate plan-gate with an accepted exception so the cursor advances to verify.
  await acceptException("ev-occupied-1", { cwd, gate: "plan-gate", reason: "probe", authority: "probe-operator" });
  await evaluateRun("ev-occupied-1", { cwd, gate: "plan-gate" });
  const atVerify = await loadRun("ev-occupied-1", cwd);
  assert.equal(atVerify.state.current_step, "verify");

  // plan-gate's step is now behind the cursor — supersede/refresh writes stay legal.
  const evidencePath = path.join(cwd, "refresh.json");
  await writeFile(evidencePath, `${JSON.stringify({ refreshed: true })}\n`);
  const entry = await attachEvidence("ev-occupied-1", { cwd, gate: "plan-gate", file: evidencePath });
  assert.equal(entry.gate_id, "plan-gate");
});

test("a gateless step is left by an honest recorded transition, not a synthesised cursor", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-gateless-"));
  const gatelessDefinition = {
    id: "gateless-flow",
    version: "1",
    steps: [
      { id: "produce", next: "review" },
      { id: "review", next: null }
    ],
    // `produce` has no gate at all. `openGates` only ever returns the current
    // step's gates, so naming `review-gate` is the only way the run leaves it.
    gates: { "review-gate": { step: "review", expects: [] } }
  };
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(gatelessDefinition, null, 2)}\n`);
  await startRun(definitionPath, { cwd, runId: "gateless-1", params: { subject: "gateless" } });

  await evaluateRun("gateless-1", { cwd, gate: "review-gate" });

  const run = await loadRun("gateless-1", cwd);
  const produceExit = run.state.transitions.find((entry) => entry.from_step === "produce");
  assert.ok(produceExit, "leaving a gateless step is recorded as its own transition");
  assert.equal(produceExit.to_step, "review");
  assert.equal(produceExit.status, "allowed");
  assert.equal(produceExit.reason, "step has no gate");
  for (const transition of run.state.transitions) {
    assert.notEqual(transition.from_step, undefined);
    assert.ok(
      ["produce", "review"].includes(transition.from_step),
      `transition from_step ${transition.from_step} must be a step the run occupied`
    );
  }
});

test("applyEvaluation refuses a transition from a step the run never occupied", () => {
  const state = initialState(definition, "provenance-1", { subject: "provenance" });
  assert.equal(state.current_step, "plan");
  assert.throws(
    () => applyEvaluation(definition, state, { gate_id: "publish-gate", status: "pass", summary: "forced", evidence_refs: [] }),
    (error) => {
      assert.equal(error.code, "flow.transition.from_step.fabricated");
      return true;
    },
    "the write-time invariant holds even if a caller reintroduces a synthesised cursor upstream"
  );
  assert.deepEqual(state.transitions, [], "nothing is appended when provenance fails");
});

test("a gate with no recorded outcome reports unknown, not wait", async () => {
  const cwd = await startJumpRun("taxonomy-1");
  const run = await loadRun("taxonomy-1", cwd);
  const report = reportJson(run.definition, run.state, run.manifest);
  const byId = Object.fromEntries(report.gate_summaries.map((entry) => [entry.gate_id, entry]));

  for (const gateId of ["plan-gate", "verify-gate", "publish-gate"]) {
    assert.equal(byId[gateId].status, "unknown", `${gateId} has never been evaluated`);
    assert.match(byId[gateId].summary, /has no recorded outcome/);
  }

  // After a real evaluation the current gate is `wait`/`block` — an appraisal —
  // while the untouched gates stay `unknown`. That distinction is the whole
  // point: an operator can tell "waiting on evidence" from "never checked".
  await evaluateRun("taxonomy-1", { cwd });
  const evaluated = await loadRun("taxonomy-1", cwd);
  const after = Object.fromEntries(
    reportJson(evaluated.definition, evaluated.state, evaluated.manifest).gate_summaries.map((entry) => [entry.gate_id, entry])
  );
  assert.notEqual(after["plan-gate"].status, "unknown", "the evaluated gate carries a real appraisal");
  assert.equal(after["verify-gate"].status, "unknown");
  assert.equal(after["publish-gate"].status, "unknown");
});

// ---------------------------------------------------------------------------
// #212: acceptException for an unreached gate must not misreport run status
// ---------------------------------------------------------------------------

test("#212: exception for an unreached gate is recorded as pending, not accepted_by_exception", async () => {
  const cwd = await startJumpRun("exc-unreached-1");

  // Block the plan gate: no evidence is attached.
  await evaluateRun("exc-unreached-1", { cwd });
  const blocked = await loadRun("exc-unreached-1", cwd);
  assert.equal(blocked.state.status, "blocked");
  assert.equal(blocked.state.current_step, "plan");

  // Accept an exception for verify-gate — two steps ahead.
  await acceptException("exc-unreached-1", { cwd, gate: "verify-gate", reason: "pre-accepted", authority: "operator:test" });

  const after = await loadRun("exc-unreached-1", cwd);
  // The exception IS recorded.
  assert.equal(after.state.exceptions.length, 1);
  assert.equal(after.state.exceptions[0].gate_id, "verify-gate");
  // The run status must NOT change — the exception is pending, not effective.
  assert.equal(after.state.status, "blocked", "exception for unreached gate must not flip run status");
  assert.equal(after.state.current_step, "plan", "cursor must not move");
  assert.doesNotMatch(after.state.next_action ?? "", /verify/, "next_action must not name the unreached gate");
});

test("#212: exception for the current gate immediately flips status to accepted_by_exception", async () => {
  const cwd = await startJumpRun("exc-current-1");

  // Block the plan gate.
  await evaluateRun("exc-current-1", { cwd });
  const blocked = await loadRun("exc-current-1", cwd);
  assert.equal(blocked.state.status, "blocked");
  assert.equal(blocked.state.current_step, "plan");

  // Accept an exception for plan-gate — the CURRENT gate.
  await acceptException("exc-current-1", { cwd, gate: "plan-gate", reason: "unblock", authority: "operator:test" });

  const after = await loadRun("exc-current-1", cwd);
  assert.equal(after.state.exceptions.length, 1);
  assert.equal(after.state.status, "accepted_by_exception", "exception for current gate immediately applies");
  assert.match(after.state.next_action ?? "", /plan/, "next_action names the current gate");
});
