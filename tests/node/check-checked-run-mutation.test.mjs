import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as flow from "../../dist/index.js";

const definition = new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;

async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-checked-mutation-"));
  const run = await flow.startRun(definition, { cwd, runId: "checked" });
  return { cwd, run, expectedRunHead: flow.flowRunHead(run.state) };
}

async function artifacts(dir) {
  return Promise.all(["state.json", "evidence/manifest.json", "report.json", "report.md"].map(name => readFile(path.join(dir, name), "utf8")));
}

// These are host leases: the host supplies authority, Flow owns publication.
function hostLease() {
  const state = { current: true, held: false, released: 0 };
  return {
    state,
    admission: { async acquire() {
      state.held = true;
      return {
        assertCurrent() { assert.ok(state.held); if (!state.current) throw new Error("host authority revoked"); },
        async release() { state.held = false; state.released++; }
      };
    } }
  };
}

test("checked evaluation refuses stale heads without publishing and releases the host lease", async () => {
  const { cwd, run, expectedRunHead } = await fixture();
  await flow.evaluateRun(run.runId, { cwd });
  const before = await artifacts(run.dir);
  const host = hostLease();
  await assert.rejects(flow.evaluateRunChecked(run.runId, { cwd, expectedRunHead, admission: host.admission }), /flow.run_head.stale/);
  assert.deepEqual(await artifacts(run.dir), before);
  assert.equal(host.state.released, 1);
});

test("checked evaluation rechecks authority after staging and holds its lease through canonical publication", async () => {
  const { cwd, run, expectedRunHead } = await fixture();
  const before = await artifacts(run.dir);
  const host = hostLease();
  flow.__setPublishRunArtifactsFaultHooks({ afterStage() { host.state.current = false; } });
  try {
    await assert.rejects(flow.evaluateRunChecked(run.runId, { cwd, expectedRunHead, admission: host.admission }), /host authority revoked/);
  } finally { flow.__setPublishRunArtifactsFaultHooks(); }
  assert.deepEqual(await artifacts(run.dir), before);
  assert.equal(host.state.released, 1);

  host.state.current = true;
  let commits = 0;
  flow.__setPublishRunArtifactsFaultHooks({ afterCommit() { assert.equal(host.state.held, true); commits++; } });
  try {
    const result = await flow.evaluateRunChecked(run.runId, { cwd, expectedRunHead, admission: host.admission });
    assert.equal(result.outcomes.length, 1);
  } finally { flow.__setPublishRunArtifactsFaultHooks(); }
  assert.equal(commits, 4);
  assert.equal(host.state.released, 2);
  assert.equal(host.state.held, false);
});

test("checked evaluation snapshots the operation before awaiting the host lease", async () => {
  const { cwd, run, expectedRunHead } = await fixture();
  const options = { cwd, expectedRunHead, gate: "plan-gate", admission: {
    async acquire() {
      options.gate = "foreign-gate";
      options.expectedRunHead = "0".repeat(64);
      options.cwd = path.join(cwd, "foreign-directory");
      return { assertCurrent() {}, release() {} };
    }
  } };
  const result = await flow.evaluateRunChecked(run.runId, options);
  assert.equal(result.outcomes[0].gate_id, "plan-gate");
});

test("operationless empty gate retains omitted-gate evaluation without receipt opt-in", async () => {
  const omitted = await fixture(), empty = await fixture();
  const now = new Date().toISOString();
  const first = await flow.evaluateRunChecked(omitted.run.runId, { cwd: omitted.cwd, expectedRunHead: omitted.expectedRunHead, now, admission: hostLease().admission });
  const second = await flow.evaluateRunChecked(empty.run.runId, { cwd: empty.cwd, expectedRunHead: empty.expectedRunHead, now, gate: "", admission: hostLease().admission });
  assert.deepEqual(second.outcomes.map(outcome => [outcome.gate_id, outcome.status]), first.outcomes.map(outcome => [outcome.gate_id, outcome.status]));
  assert.equal(second.state.current_step, first.state.current_step);
  assert.equal(second.state.status, first.state.status);
  assert.equal(Object.hasOwn(second.state, "checked_operation_ledger"), false);
  assert.equal(Object.hasOwn(second, "operationReceipt"), false);
});
