import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  acceptException,
  attachEvidence,
  cancelRun,
  evaluateRun,
  initialState,
  loadRun,
  pauseRun,
  readyGates,
  readySteps,
  renderMarkdownReport,
  resumeRun,
  startRun,
  validateEvaluationTransition,
  validateRunLifecycle,
  validateRunTransition
} from "../../dist/index.js";
import { normalizeRunStateLifecycle } from "../../dist/definition/flow-definition.js";
import { hashRunTree, lifecycleStateMatrix, snapshotRunTree } from "./helpers/run-tree.mjs";
import { json } from "./helpers/fixtures.mjs";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

const at = "2026-07-10T12:00:00.000Z";
const authority = Object.freeze({
  kind: "user_request",
  actor: "user:brian",
  request_ref: "request:flow-115-pause",
  requested_at: at
});

function lifecycleEvent(overrides = {}) {
  return {
    action: "pause",
    from_status: "active",
    to_status: "paused",
    prior_status: "active",
    reason: "User requested a pause",
    authority,
    at,
    ...overrides
  };
}

async function validator() {
  const schema = await json("schemas/flow-run.schema.json");
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

async function validState() {
  const definition = await json("examples/agent-dev-flow.json");
  return initialState(definition, "lifecycle-contract", { subject: "flow#115" });
}

function request(requestRef, overrides = {}) {
  return {
    reason: overrides.reason ?? "User requested lifecycle change",
    authority: {
      ...authority,
      request_ref: requestRef,
      ...(overrides.authority ?? {})
    },
    at: overrides.at ?? at
  };
}

async function runtimeRun(name) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `flow-lifecycle-${name}-`));
  const definition = await json("examples/agent-dev-flow.json");
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  const started = await startRun(definitionPath, { cwd, runId: name, params: { subject: "flow#115" } });
  return { cwd, definition, ...started };
}

async function writeCanonicalState(fixture, state) {
  await writeFile(path.join(fixture.dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

test("new runs initialize a lifecycle ledger separate from Step transitions", async () => {
  const state = await validState();
  assert.deepEqual(state.lifecycle, []);
  assert.deepEqual(state.transitions, []);
  assert.notStrictEqual(state.lifecycle, state.transitions);
});

test("schema accepts paused and canceled states with valid lifecycle records", async () => {
  const validate = await validator();
  const paused = { ...await validState(), status: "paused", lifecycle: [lifecycleEvent()] };
  const canceled = {
    ...paused,
    status: "canceled",
    lifecycle: [...paused.lifecycle, lifecycleEvent({
      action: "cancel",
      from_status: "paused",
      to_status: "canceled",
      authority: { ...authority, kind: "operator_request", request_ref: "request:flow-115-cancel" }
    })]
  };
  assert.equal(validate(paused), true, JSON.stringify(validate.errors));
  assert.equal(validate(canceled), true, JSON.stringify(validate.errors));
});

test("schema constrains lifecycle authority and action/status combinations", async () => {
  const validate = await validator();
  const base = await validState();
  for (const event of [
    lifecycleEvent({ authority: { ...authority, kind: "agent_request" } }),
    lifecycleEvent({ authority: { ...authority, request_ref: "" } }),
    lifecycleEvent({ authority: { ...authority, actor: "" } }),
    lifecycleEvent({ action: "pause", to_status: "canceled" }),
    lifecycleEvent({ action: "resume", from_status: "active", to_status: "active" }),
    lifecycleEvent({ action: "cancel", from_status: "completed", to_status: "canceled" }),
    lifecycleEvent({ prior_status: "paused" })
  ]) {
    assert.equal(validate({ ...base, lifecycle: [event] }), false, JSON.stringify(event));
  }
});

test("legacy absence normalizes to an empty ledger without accepting malformed present data", async () => {
  const validate = await validator();
  const state = await validState();
  delete state.lifecycle;
  assert.equal(validate(state), true, JSON.stringify(validate.errors));
  const normalized = normalizeRunStateLifecycle(state);
  assert.deepEqual(normalized.lifecycle, []);
  assert.equal("lifecycle" in state, false, "normalization does not rewrite the parsed legacy object");

  for (const malformed of [null, {}, "pause", [null]]) {
    const candidate = { ...state, lifecycle: malformed };
    assert.equal(validate(candidate), false, `malformed present ledger ${JSON.stringify(malformed)} must fail`);
    assert.strictEqual(normalizeRunStateLifecycle(candidate), candidate, "normalization must not repair present data");
  }
});

test("lifecycle state matrix declares the later operation contract", () => {
  assert.deepEqual(lifecycleStateMatrix.pause.allowed, ["active", "blocked", "needs_decision"]);
  assert.deepEqual(lifecycleStateMatrix.resume.allowed, ["paused"]);
  assert.deepEqual(lifecycleStateMatrix.cancel.allowed, ["active", "blocked", "needs_decision", "paused"]);
  assert.deepEqual(lifecycleStateMatrix.evaluate.rejected, ["paused", "canceled"]);
  assert.deepEqual(lifecycleStateMatrix.advance.rejected, ["paused", "canceled"]);
});

test("run-tree helpers include paths and exact bytes in deterministic snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flow-lifecycle-tree-"));
  await mkdir(path.join(root, "evidence"));
  await writeFile(path.join(root, "state.json"), "same bytes\n");
  await writeFile(path.join(root, "evidence", "manifest.json"), "same bytes\n");
  const before = await snapshotRunTree(root);
  const firstHash = await hashRunTree(root);
  const secondHash = await hashRunTree(root);
  assert.deepEqual([...before.keys()], ["evidence/manifest.json", "state.json"]);
  assert.equal(firstHash, secondHash);
  await writeFile(path.join(root, "state.json"), "changed bytes\n");
  assert.notEqual(await hashRunTree(root), firstHash);
});

test("pause and resume preserve Step state and restore the exact prior resumable status", async () => {
  for (const priorStatus of ["active", "blocked", "needs_decision"]) {
    const fixture = await runtimeRun(`roundtrip-${priorStatus}`);
    const loaded = await loadRun(fixture.runId, fixture.cwd);
    loaded.state.status = priorStatus;
    await writeCanonicalState(fixture, loaded.state);
    const before = await loadRun(fixture.runId, fixture.cwd);
    const preserved = {
      current_step: before.state.current_step,
      transitions: before.state.transitions,
      gate_outcomes: before.state.gate_outcomes,
      exceptions: before.state.exceptions,
      manifest: before.manifest
    };

    const paused = await pauseRun(fixture.runId, { cwd: fixture.cwd, ...request(`request:pause:${priorStatus}`) });
    assert.equal(paused.state.status, "paused");
    assert.equal(paused.event.prior_status, priorStatus);
    assert.equal(paused.state.lifecycle.length, 1);
    assert.deepEqual({
      current_step: paused.state.current_step,
      transitions: paused.state.transitions,
      gate_outcomes: paused.state.gate_outcomes,
      exceptions: paused.state.exceptions,
      manifest: paused.manifest
    }, preserved);
    assert.deepEqual(readySteps(fixture.definition, paused.state, paused.manifest), []);
    assert.deepEqual(readyGates(fixture.definition, paused.state, paused.manifest), []);

    const resumed = await resumeRun(fixture.runId, { cwd: fixture.cwd, ...request(`request:resume:${priorStatus}`, { at: "2026-07-10T12:01:00.000Z" }) });
    assert.equal(resumed.state.status, priorStatus);
    assert.equal(resumed.state.lifecycle.length, 2);
    assert.equal(resumed.event.from_status, "paused");
    assert.equal(resumed.event.to_status, priorStatus);
    assert.deepEqual(resumed.state.transitions, preserved.transitions);
    assert.deepEqual(resumed.state.gate_outcomes, preserved.gate_outcomes);
    assert.deepEqual(resumed.manifest, preserved.manifest);
  }
});

test("ordinary resumable status evolution between lifecycle events permits later blocked pause and cancellation", async () => {
  const fixture = await runtimeRun("intervening-blocked");
  await pauseRun(fixture.runId, { cwd: fixture.cwd, ...request("request:first-pause") });
  await resumeRun(fixture.runId, { cwd: fixture.cwd, ...request("request:first-resume", { at: "2026-07-10T12:01:00.000Z" }) });

  const evolved = await loadRun(fixture.runId, fixture.cwd);
  evolved.state.status = "blocked";
  evolved.state.gate_outcomes = [{ gate_id: "plan-gate", status: "block", summary: "canonical evaluation blocked", evidence_refs: [] }];
  const preservedStep = evolved.state.current_step;
  const preservedGates = structuredClone(evolved.state.gate_outcomes);
  await writeCanonicalState(fixture, evolved.state);
  assert.equal((await loadRun(fixture.runId, fixture.cwd)).state.status, "blocked", "ordinary Flow status evolution remains canonical");

  const paused = await pauseRun(fixture.runId, { cwd: fixture.cwd, ...request("request:blocked-pause", { at: "2026-07-10T12:02:00.000Z" }) });
  assert.equal(paused.event.from_status, "blocked");
  assert.equal(paused.event.prior_status, "blocked");
  const resumed = await resumeRun(fixture.runId, { cwd: fixture.cwd, ...request("request:blocked-resume", { at: "2026-07-10T12:03:00.000Z" }) });
  assert.equal(resumed.state.status, "blocked");
  const canceled = await cancelRun(fixture.runId, { cwd: fixture.cwd, ...request("request:blocked-cancel", { at: "2026-07-10T12:04:00.000Z" }) });
  assert.equal(canceled.state.status, "canceled");
  assert.equal(canceled.event.from_status, "blocked");
  assert.equal(canceled.event.prior_status, "blocked");
  assert.equal(canceled.state.current_step, preservedStep);
  assert.deepEqual(canceled.state.gate_outcomes, preservedGates);
  assert.deepEqual(canceled.state.lifecycle.map((event) => [event.action, event.from_status, event.to_status]), [
    ["pause", "active", "paused"],
    ["resume", "paused", "active"],
    ["pause", "blocked", "paused"],
    ["resume", "paused", "blocked"],
    ["cancel", "blocked", "canceled"]
  ]);
});

test("cancel is terminal, authority-bearing, separate from transitions, and supports paused runs", async () => {
  const fixture = await runtimeRun("cancel-paused");
  await pauseRun(fixture.runId, { cwd: fixture.cwd, ...request("request:pause-before-cancel") });
  const before = await loadRun(fixture.runId, fixture.cwd);
  const definitionBytes = await readFile(path.join(fixture.dir, "definition.json"));
  const manifestBytes = await readFile(path.join(fixture.dir, "evidence", "manifest.json"));
  const transitions = structuredClone(before.state.transitions);

  const canceled = await cancelRun(fixture.runId, {
    cwd: fixture.cwd,
    ...request("request:cancel-paused", { authority: { kind: "operator_request" }, at: "2026-07-10T12:02:00.000Z" })
  });
  assert.equal(canceled.state.status, "canceled");
  assert.equal(canceled.event.from_status, "paused");
  assert.equal(canceled.event.to_status, "canceled");
  assert.equal(canceled.event.prior_status, "active");
  assert.equal(canceled.event.authority.kind, "operator_request");
  assert.deepEqual(canceled.state.transitions, transitions);
  assert.deepEqual(readySteps(fixture.definition, canceled.state, canceled.manifest), []);
  assert.deepEqual(await readFile(path.join(fixture.dir, "definition.json")), definitionBytes);
  assert.deepEqual(await readFile(path.join(fixture.dir, "evidence", "manifest.json")), manifestBytes);
});

test("evaluate and direct transition paths reject paused/canceled before mutation", async () => {
  for (const terminalStatus of ["paused", "canceled"]) {
    const fixture = await runtimeRun(`guard-${terminalStatus}`);
    if (terminalStatus === "paused") {
      await pauseRun(fixture.runId, { cwd: fixture.cwd, ...request("request:guard-pause") });
    } else {
      await cancelRun(fixture.runId, { cwd: fixture.cwd, ...request("request:guard-cancel") });
    }
    const run = await loadRun(fixture.runId, fixture.cwd);
    const beforeHash = await hashRunTree(fixture.dir);
    await assert.rejects(
      evaluateRun(fixture.runId, { cwd: fixture.cwd, now: "2030-01-01T00:00:00.000Z" }),
      (error) => error.code === `flow.lifecycle.run_${terminalStatus}`
    );
    assert.equal(await hashRunTree(fixture.dir), beforeHash, "evaluate rejection must precede freshness/report writes");

    const transition = validateRunTransition({
      definition: run.definition,
      current_state: run.state,
      proposed_transition: { from_step: run.state.current_step, to_step: null, status: "allowed" },
      manifest: run.manifest
    });
    assert.equal(transition.valid, false);
    assert.equal(transition.diagnostics[0].code, `flow.lifecycle.run_${terminalStatus}`);
    assert.throws(
      () => validateEvaluationTransition(run.definition, run.state, run.manifest, { gate_id: Object.keys(run.definition.gates)[0], status: "wait" }),
      (error) => error.code === `flow.lifecycle.run_${terminalStatus}`
    );
  }
});

test("lifecycle state matrix rejects invalid sources without writing", async () => {
  const operations = { pause: pauseRun, resume: resumeRun, cancel: cancelRun };
  for (const [operation, matrix] of Object.entries(lifecycleStateMatrix)) {
    if (!(operation in operations)) continue;
    for (const status of matrix.rejected) {
      const fixture = await runtimeRun(`reject-${operation}-${status}`);
      const run = await loadRun(fixture.runId, fixture.cwd);
      run.state.status = status;
      if (status === "paused") run.state.lifecycle.push(lifecycleEvent());
      if (status === "canceled") run.state.lifecycle.push(lifecycleEvent({ action: "cancel", from_status: "active", to_status: "canceled" }));
      await writeCanonicalState(fixture, run.state);
      const beforeHash = await hashRunTree(fixture.dir);
      await assert.rejects(
        operations[operation](fixture.runId, { cwd: fixture.cwd, ...request(`request:reject:${operation}:${status}`) }),
        (error) => error.code?.startsWith("flow.lifecycle.")
      );
      assert.equal(await hashRunTree(fixture.dir), beforeHash, `${operation} from ${status} must be a no-write rejection`);
    }
  }
});

test("malformed cancellation, identical replay, and conflicting replay are whole-tree byte stable", async () => {
  const fixture = await runtimeRun("cancel-replay");
  const beforeMalformed = await hashRunTree(fixture.dir);
  await assert.rejects(
    cancelRun(fixture.runId, { cwd: fixture.cwd, reason: "bad", authority: { kind: "agent_request" }, at }),
    (error) => error.code === "flow.lifecycle.authority.invalid"
  );
  assert.equal(await hashRunTree(fixture.dir), beforeMalformed);

  const cancellation = request("request:stable-cancel", { at: "2026-07-10T12:03:00.000Z" });
  const first = await cancelRun(fixture.runId, { cwd: fixture.cwd, ...cancellation });
  assert.equal(first.state.lifecycle.filter((event) => event.action === "cancel").length, 1);
  const terminalSnapshot = await snapshotRunTree(fixture.dir);
  const terminalHash = await hashRunTree(fixture.dir);

  const replay = await cancelRun(fixture.runId, { cwd: fixture.cwd, ...cancellation, at: "2030-01-01T00:00:00.000Z" });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.state.lifecycle.filter((event) => event.action === "cancel").length, 1);
  assert.equal(await hashRunTree(fixture.dir), terminalHash);
  assert.deepEqual(await snapshotRunTree(fixture.dir), terminalSnapshot);

  await assert.rejects(
    cancelRun(fixture.runId, { cwd: fixture.cwd, ...request("request:conflicting-cancel", { reason: "Different request" }) }),
    (error) => error.code === "flow.lifecycle.replay.conflict"
  );
  assert.equal(await hashRunTree(fixture.dir), terminalHash);
  assert.deepEqual(await snapshotRunTree(fixture.dir), terminalSnapshot);
});

test("canonical lifecycle validation rejects forged, incoherent, reversed, and malformed histories", async () => {
  const base = await validState();
  const pause = lifecycleEvent();
  const resume = lifecycleEvent({
    action: "resume",
    from_status: "paused",
    to_status: "active",
    prior_status: "active",
    authority: { ...authority, request_ref: "request:resume" },
    at: "2026-07-10T12:01:00.000Z"
  });
  const cancel = lifecycleEvent({
    action: "cancel",
    from_status: "active",
    to_status: "canceled",
    prior_status: "active",
    authority: { ...authority, request_ref: "request:cancel" },
    at: "2026-07-10T12:02:00.000Z"
  });
  const invalid = [
    { ...base, status: "paused", lifecycle: [] },
    { ...base, status: "canceled", lifecycle: [] },
    { ...base, status: "active", lifecycle: [pause] },
    { ...base, status: "active", lifecycle: [cancel] },
    { ...base, status: "paused", lifecycle: [{ ...pause, prior_status: "blocked" }] },
    { ...base, status: "blocked", lifecycle: [pause, { ...resume, to_status: "blocked", prior_status: "active" }] },
    { ...base, status: "canceled", lifecycle: [pause, { ...cancel, from_status: "active" }] },
    { ...base, status: "active", lifecycle: [cancel, { ...pause, at: "2026-07-10T12:03:00.000Z" }] },
    { ...base, status: "active", lifecycle: [pause, { ...resume, at: "2026-07-10T11:59:00.000Z" }] }
  ];
  for (const state of invalid) {
    assert.throws(() => validateRunLifecycle(state), /flow\.lifecycle\.state\.invalid/);
  }
  assert.equal(validateRunLifecycle({ ...base, status: "canceled", lifecycle: [cancel] }).status, "canceled");

  const fixture = await runtimeRun("forged-cancel");
  await writeCanonicalState(fixture, { ...(await loadRun(fixture.runId, fixture.cwd)).state, status: "canceled", lifecycle: [] });
  await assert.rejects(loadRun(fixture.runId, fixture.cwd), /flow-run\.schema\.json|flow\.lifecycle\.state\.invalid/);
  const runtime = await import("../../dist/index.js");
  assert.equal("saveRun" in runtime, false, "generic mutable persistence is not a public authority bypass");
});

test("evidence and exception mutations reject paused/canceled runs before any write", async () => {
  for (const status of ["paused", "canceled"]) {
    const fixture = await runtimeRun(`mutation-guard-${status}`);
    if (status === "paused") await pauseRun(fixture.runId, { cwd: fixture.cwd, ...request(`request:${status}`) });
    else await cancelRun(fixture.runId, { cwd: fixture.cwd, ...request(`request:${status}`) });
    const source = path.join(fixture.cwd, "evidence.txt");
    await writeFile(source, "evidence\n");
    const before = await snapshotRunTree(fixture.dir);
    const beforeHash = await hashRunTree(fixture.dir);
    await assert.rejects(
      attachEvidence(fixture.runId, { cwd: fixture.cwd, gate: "plan-gate", file: source }),
      (error) => error.code === `flow.lifecycle.run_${status}`
    );
    assert.equal(await hashRunTree(fixture.dir), beforeHash);
    assert.deepEqual(await snapshotRunTree(fixture.dir), before);
    await assert.rejects(
      acceptException(fixture.runId, { cwd: fixture.cwd, gate: "plan-gate", reason: "no", authority: "test" }),
      (error) => error.code === `flow.lifecycle.run_${status}`
    );
    assert.equal(await hashRunTree(fixture.dir), beforeHash);
    assert.deepEqual(await snapshotRunTree(fixture.dir), before);
  }
});

test("lifecycle audit text rejects controls and oversize input while safely rendering printable punctuation", async () => {
  const fixture = await runtimeRun("audit-text");
  const invalidRequests = [
    request("request:esc\u001b]8;;https://evil.test\u0007", { authority: { actor: "user:test" } }),
    request("request:crlf", { reason: "line one\r\nline two" }),
    request("request:actor", { authority: { actor: `user:${"a".repeat(252)}` } }),
    request(`request:${"r".repeat(2041)}`),
    request("request:reason", { reason: "x".repeat(4097) })
  ];
  const baseline = await hashRunTree(fixture.dir);
  for (const invalid of invalidRequests) {
    await assert.rejects(cancelRun(fixture.runId, { cwd: fixture.cwd, ...invalid }), /must not contain control characters|must be at most/);
    assert.equal(await hashRunTree(fixture.dir), baseline);
  }

  const printable = request("request:$()[]`*;|&", {
    reason: "User approved [cancel](https://example.test) && $(not-a-command)",
    authority: { actor: "operator:<reviewer>" }
  });
  const canceled = await cancelRun(fixture.runId, { cwd: fixture.cwd, ...printable });
  const markdown = renderMarkdownReport(canceled.definition, canceled.state, canceled.manifest);
  assert.doesNotMatch(markdown, /\u001b|\u0007|\r|\nline two/);
  assert.match(markdown, /\\\[cancel\\\]\\\(https:\/\/example\.test\\\)/);
  assert.match(markdown, /operator:&lt;reviewer&gt;/);
  assert.match(markdown, /\$\\\(not-a-command\\\)/);
});
