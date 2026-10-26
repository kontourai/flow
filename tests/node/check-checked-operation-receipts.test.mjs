import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, readdir, rm, writeFile, truncate, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as flow from "../../dist/index.js";
import { routeBackDefinition } from "./helpers/route-back-fixtures.mjs";

const identity = id => ({ id, intentDigest: flow.flowRunHead({ id }) });
const admission = { async acquire() { return { assertCurrent() {}, release() {} }; } };
async function fixture(t, definition) {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-operation-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const file = definition ? path.join(cwd, "definition.json") : new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;
  if (definition) await writeFile(file, JSON.stringify(definition));
  const run = await flow.startRun(file, { cwd, runId: "receipt" });
  const options = { cwd, expectedRunHead: flow.flowRunHead(run.state), gate: "plan-gate", admission, operation: identity("evaluate-1") };
  return { cwd, run, options };
}
const lookup = (f, operation = f.options.operation) => flow.readCheckedRunOperation(f.run.runId, { cwd: f.cwd, operation, admission });

// This keeper owns the historical attribution contract, not today's gate standing.
test("checked evaluation returns the original full head after later progress, amendment, reopen and cancellation", async t => {
  const f = await fixture(t, {
    id: "operation-history", version: "1", steps: [{ id: "plan", next: "later" }, { id: "later", next: "end" }, { id: "end", next: null }],
    gates: { "plan-gate": { step: "plan", expects: routeBackDefinition().gates["verify-gate"].expects, on_route_back: { missing_evidence: "plan", default: "plan" } }, "later-gate": { step: "later", expects: [] } }
  });
  const result = await flow.evaluateRunChecked(f.run.runId, f.options);
  const original = result.operationReceipt;
  assert.equal(original.originalResultHead, flow.flowRunHead(result.state));
  assert.equal(original.evaluationRefs.length, 1);
  await flow.evaluateRun(f.run.runId, { cwd: f.cwd, gate: "plan-gate" });
  const later = await flow.loadRun(f.run.runId, f.cwd);
  const successor = structuredClone(later.definition);
  successor.version += ".amended";
  await flow.amendRunDefinition(f.run.runId, { cwd: f.cwd, definition: successor, request: {
    reason: "Retain historical checked evaluation", expected_run_head: flow.flowRunHead(later.state),
    expected_definition: flow.effectiveDefinitionIdentity(later.startDefinition, later.state), successor_digest: flow.definitionDigest(successor),
    authority: { kind: "operator_request", actor: "test", request_ref: "amend:1", requested_at: "2026-10-26T00:00:00Z" }
  } });
  const replay = await flow.evaluateRunChecked(f.run.runId, f.options);
  assert.equal(replay.idempotent, true);
  assert.deepEqual(replay.operationReceipt, original);
  assert.equal(flow.flowRunHead(replay.state), original.originalResultHead);
  assert.notEqual(flow.flowRunHead((await flow.loadRun(f.run.runId, f.cwd)).state), original.originalResultHead);
  assert.deepEqual(await lookup(f), original);
  await flow.cancelRun(f.run.runId, { cwd: f.cwd, reason: "finished", authority: { kind: "operator_request", actor: "test", request_ref: "cancel:1", requested_at: "2026-10-26T00:00:00Z" } });
  assert.deepEqual(await lookup(f), original);
  assert.deepEqual((await flow.evaluateRunChecked(f.run.runId, f.options)).operationReceipt, original);
});

test("operation and semantic bytes are captured before host await; changed meaning and foreign intent refuse", async t => {
  const f = await fixture(t);
  const operation = structuredClone(f.options.operation);
  const options = { ...f.options, admission: { async acquire() {
    options.operation.id = "changed"; options.operation.intentDigest = "0".repeat(64); options.gate = "foreign";
    return { assertCurrent() {}, release() {} };
  } } };
  const result = await flow.evaluateRunChecked(f.run.runId, options);
  assert.deepEqual(result.operationReceipt.operation, operation);
  assert.equal(result.operationReceipt.request.gate, "plan-gate");
  assert.deepEqual(await lookup(f, operation), result.operationReceipt);
  await assert.rejects(lookup(f, { ...operation, intentDigest: "f".repeat(64) }), /checked_operation.conflict/);
  for (const delta of [{ gate: "implement-gate" }, { expectedRunHead: "0".repeat(64) }, { now: "2026-10-26T00:00:00Z" }]) {
    await assert.rejects(flow.evaluateRunChecked(f.run.runId, { ...f.options, operation, ...delta }), /checked_operation.conflict/);
  }
  assert.equal(await lookup(f, identity("uncommitted")), null);
});

test("snapshot durability precedes canonical receipt, and return loss is resolved without another evaluation", async t => {
  const f = await fixture(t);
  const original = await readFile(path.join(f.run.dir, "state.json"));
  flow.__setPublishRunArtifactsFaultHooks({ afterStage() { throw Error("before canonical commit"); } });
  try { await assert.rejects(flow.evaluateRunChecked(f.run.runId, f.options), /before canonical commit/); }
  finally { flow.__setPublishRunArtifactsFaultHooks(); }
  assert.deepEqual(await readFile(path.join(f.run.dir, "state.json")), original);
  assert.equal((await readdir(path.join(f.run.dir, "checked-operations"))).length, 1);
  assert.equal(await lookup(f), null, "durable orphan is not a committed operation");
  flow.__setPublishRunArtifactsFaultHooks({ afterCommit(_index, file) { if (file.endsWith("/state.json")) throw Error("lost return"); } });
  try { await assert.rejects(flow.evaluateRunChecked(f.run.runId, f.options), /lost return/); }
  finally { flow.__setPublishRunArtifactsFaultHooks(); }
  const committed = await lookup(f);
  assert.ok(committed);
  const before = await readFile(path.join(f.run.dir, "state.json"));
  const replay = await flow.evaluateRunChecked(f.run.runId, f.options);
  assert.deepEqual(replay.operationReceipt, committed);
  assert.deepEqual(await readFile(path.join(f.run.dir, "state.json")), before);
});

test("authority loss after blob durability prevents canonical publication; lookup still authenticates", async t => {
  const f = await fixture(t); let current = true;
  const host = { async acquire() { return { assertCurrent() { if (!current) throw Error("revoked"); }, release() {} }; } };
  flow.__setPublishRunArtifactsFaultHooks({ afterStage() { current = false; } });
  try { await assert.rejects(flow.evaluateRunChecked(f.run.runId, { ...f.options, admission: host }), /revoked/); }
  finally { flow.__setPublishRunArtifactsFaultHooks(); }
  assert.equal(await lookup(f), null);
  await assert.rejects(flow.readCheckedRunOperation(f.run.runId, { cwd: f.cwd, operation: f.options.operation, admission: host }), /revoked/);
});

test("anchored snapshot corruption or loss and duplicate/dangling/foreign receipts refuse", async t => {
  const f = await fixture(t);
  const result = await flow.evaluateRunChecked(f.run.runId, f.options);
  const file = path.join(f.run.dir, "checked-operations", `${result.operationReceipt.snapshotDigest}.json`);
  const original = await readFile(file);
  await writeFile(file, '{}');
  await assert.rejects(lookup(f), /snapshot/);
  await rm(file);
  await assert.rejects(flow.loadRun(f.run.runId, f.cwd), /ENOENT/);
  await writeFile(file, original);
  const stateFile = path.join(f.run.dir, "state.json"), stateBytes = await readFile(stateFile);
  for (const alter of [
    state => state.checked_operation_ledger.records.push(structuredClone(state.checked_operation_ledger.records[0])),
    state => state.checked_operation_ledger.records[0].evaluationRefs[0].evaluationId = "00000000-0000-4000-8000-000000000000",
    state => state.checked_operation_ledger.records[0].runId = "foreign",
    state => state.checked_operation_ledger.records[0].originDefinition.digest = "0".repeat(64)
  ]) {
    const state = JSON.parse(stateBytes); alter(state); await writeFile(stateFile, JSON.stringify(state));
    await assert.rejects(flow.loadRun(f.run.runId, f.cwd));
  }
  await writeFile(stateFile, stateBytes);
  assert.deepEqual(await lookup(f), result.operationReceipt);
});

test("orphan count and aggregate byte capacity refuse before effects, with exact lookup still available", async t => {
  const f = await fixture(t);
  const result = await flow.evaluateRunChecked(f.run.runId, f.options);
  const dir = path.join(f.run.dir, "checked-operations");
  const baseline = await readFile(path.join(f.run.dir, "state.json"));
  for (let i = 0; i < 8; i++) {
    const file = path.join(dir, `${i.toString(16).padStart(64, '0')}.json`);
    await writeFile(file, ''); await truncate(file, flow.FLOW_CHECKED_OPERATION_LIMITS.snapshotBytes);
  }
  await assert.rejects(flow.evaluateRunChecked(f.run.runId, { ...f.options, expectedRunHead: flow.flowRunHead(result.state), operation: identity("capacity") }), /checked_operation.capacity/);
  assert.deepEqual(await readFile(path.join(f.run.dir, "state.json")), baseline);
  assert.deepEqual(await lookup(f), result.operationReceipt);
  for (let i = 0; i < 8; i++) await rm(path.join(dir, `${i.toString(16).padStart(64, '0')}.json`));
  for (let i = 0; i < flow.FLOW_CHECKED_OPERATION_LIMITS.snapshotFiles; i++) await writeFile(path.join(dir, `${i.toString(16).padStart(64, '0')}.json`), '{}');
  await assert.rejects(flow.evaluateRunChecked(f.run.runId, { ...f.options, expectedRunHead: flow.flowRunHead(result.state), operation: identity("count") }), /checked_operation.capacity/);
  assert.deepEqual(await lookup(f), result.operationReceipt);
});

test("checked retry commits exactly one epoch, replays historically, and never backfills a legacy request", async t => {
  const definition = routeBackDefinition({ route_back_policy: { max_attempts: 1, on_exceeded: "block" }, on_route_back: { missing_evidence: "implement", default: "implement" } });
  const f = await fixture(t, definition);
  await flow.evaluateRun(f.run.runId, { cwd: f.cwd, gate: "verify-gate" });
  await flow.evaluateRun(f.run.runId, { cwd: f.cwd, gate: "verify-gate" });
  const before = await flow.loadRun(f.run.runId, f.cwd), blocked = before.state.transitions.at(-1);
  assert.equal(blocked.limit_exceeded, true);
  const request = { reason: "one bounded retry", target_step: blocked.selected_route, blocked_transition_ref: flow.flowTransitionRef(blocked), expected_run_head: flow.flowRunHead(before.state), authority: { kind: "operator_request", actor: "test", request_ref: "retry:1", requested_at: "2026-10-26T00:00:00Z" } };
  const options = { cwd: f.cwd, request, operation: identity("retry"), admission };
  const result = await flow.authorizeRetryChecked(f.run.runId, options);
  assert.equal(result.transition.retry_epoch, 2);
  assert.equal(result.operationReceipt.originalResultHead, flow.flowRunHead(result.state));
  await flow.evaluateRun(f.run.runId, { cwd: f.cwd, gate: "verify-gate" });
  const replay = await flow.authorizeRetryChecked(f.run.runId, options);
  assert.equal(replay.idempotent, true);
  assert.equal(replay.operationReceipt.originalResultHead, result.operationReceipt.originalResultHead);
  assert.equal((await flow.loadRun(f.run.runId, f.cwd)).state.transitions.filter(t => t.type === 'retry_authorized').length, 1);
  await assert.rejects(flow.authorizeRetryChecked(f.run.runId, { ...options, operation: identity("backfill") }), /backfill_refused/);
});


test("same-operation contenders publish one evaluation and a later receipt cannot lose its prefix", async t => {
  const f = await fixture(t);
  const results = await Promise.all([flow.evaluateRunChecked(f.run.runId, f.options), flow.evaluateRunChecked(f.run.runId, f.options)]);
  assert.deepEqual(results.map(r => r.idempotent).sort(), [false, true]);
  assert.equal((await flow.loadRun(f.run.runId, f.cwd)).state.gate_evaluation_ledger.records.length, 1);
  const next = await flow.evaluateRunChecked(f.run.runId, { ...f.options, expectedRunHead: results[0].operationReceipt.originalResultHead, operation: identity("second") });
  const file = path.join(f.run.dir, "state.json"), bytes = await readFile(file);
  const altered = JSON.parse(bytes); altered.checked_operation_ledger.records.shift();
  await writeFile(file, JSON.stringify(altered));
  await assert.rejects(flow.loadRun(f.run.runId, f.cwd), /history.prefix/);
  await writeFile(file, bytes);
  assert.deepEqual(await lookup(f, identity("second")), next.operationReceipt);
});

test("snapshot symlinks refuse without reading their target", async t => {
  const f = await fixture(t);
  const result = await flow.evaluateRunChecked(f.run.runId, f.options);
  const file = path.join(f.run.dir, "checked-operations", `${result.operationReceipt.snapshotDigest}.json`);
  const original = await readFile(file), target = path.join(f.cwd, "foreign.json");
  await writeFile(target, original); await rm(file); await symlink(target, file);
  await assert.rejects(lookup(f));
  assert.deepEqual(await readFile(target), original);
});

test("legacy operationless retry cannot be adopted by a new checked operation identity", async t => {
  const definition = routeBackDefinition({ route_back_policy: { max_attempts: 1, on_exceeded: "block" }, on_route_back: { missing_evidence: "implement", default: "implement" } });
  const f = await fixture(t, definition);
  for (let i = 0; i < 2; i++) await flow.evaluateRun(f.run.runId, { cwd: f.cwd, gate: "verify-gate" });
  const before = await flow.loadRun(f.run.runId, f.cwd), blocked = before.state.transitions.at(-1);
  const request = { reason: "legacy", target_step: blocked.selected_route, blocked_transition_ref: flow.flowTransitionRef(blocked), expected_run_head: flow.flowRunHead(before.state), authority: { kind: "operator_request", actor: "test", request_ref: "legacy-retry", requested_at: "2026-10-26T00:00:00Z" } };
  await flow.authorizeRetry(f.run.runId, { cwd: f.cwd, request });
  const bytes = await readFile(path.join(f.run.dir, "state.json"));
  await assert.rejects(flow.authorizeRetryChecked(f.run.runId, { cwd: f.cwd, request, operation: identity("new-owner"), admission }), /backfill_refused/);
  assert.equal(await lookup(f, identity("new-owner")), null);
  assert.deepEqual(await readFile(path.join(f.run.dir, "state.json")), bytes);
});

test("receipt limit rejects a new operation while exact reads, replay and ordinary evaluation preserve the ledger", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  let head = f.options.expectedRunHead, first;
  for (let index = 0; index < flow.FLOW_CHECKED_OPERATION_LIMITS.receipts; index++) {
    const result = await flow.evaluateRunChecked(f.run.runId, { ...f.options, expectedRunHead: head, operation: identity(`bounded-${index}`) });
    first ??= result.operationReceipt;
    head = result.operationReceipt.originalResultHead;
  }
  await assert.rejects(flow.evaluateRunChecked(f.run.runId, { ...f.options, expectedRunHead: head, operation: identity("over-cap") }), /checked_operation.capacity/);
  assert.deepEqual(await lookup(f, identity("bounded-0")), first);
  const replay = await flow.evaluateRunChecked(f.run.runId, { ...f.options, operation: identity("bounded-0") });
  assert.deepEqual(replay.operationReceipt, first);
  await flow.evaluateRun(f.run.runId, { cwd: f.cwd, gate: "plan-gate" });
  assert.equal((await flow.loadRun(f.run.runId, f.cwd)).state.checked_operation_ledger.records.length, flow.FLOW_CHECKED_OPERATION_LIMITS.receipts);
});


for (const target of ["file", "directory"]) test(`strict snapshot ${target} sync failure refuses without a canonical effect`, async t => {
  const f = await fixture(t);
  const state = await readFile(path.join(f.run.dir, "state.json"));
  const originalOpen = fs.promises.open; let reached = 0;
  fs.promises.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    const name = String(file);
    if (target === "file" ? /checked-operations\/[a-f0-9]{64}\.json$/.test(name) : name.endsWith('/checked-operations')) {
      handle.sync = async () => { reached++; throw Error("controlled snapshot durability failure"); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(flow.evaluateRunChecked(f.run.runId, f.options), /controlled snapshot durability failure/); }
  finally { fs.promises.open = originalOpen; syncBuiltinESMExports(); }
  assert.ok(reached > 0);
  assert.deepEqual(await readFile(path.join(f.run.dir, "state.json")), state);
  assert.equal(await lookup(f), null);
});

test("canonical directory sync loss after commit is resolved by exact durable lookup", async t => {
  const f = await fixture(t); let committed = false, reached = 0;
  const originalOpen = fs.promises.open;
  fs.promises.open = async function(file, ...args) {
    const handle = await originalOpen.call(this, file, ...args);
    if (committed && String(file) === f.run.dir) handle.sync = async () => { reached++; throw Error("controlled anchor sync failure"); };
    return handle;
  };
  syncBuiltinESMExports();
  flow.__setPublishRunArtifactsFaultHooks({ afterCommit(_index, file) { if (file.endsWith('/state.json')) committed = true; } });
  try { await assert.rejects(flow.evaluateRunChecked(f.run.runId, f.options), /controlled anchor sync failure/); }
  finally { fs.promises.open = originalOpen; syncBuiltinESMExports(); flow.__setPublishRunArtifactsFaultHooks(); }
  assert.ok(reached > 0);
  assert.ok(await lookup(f));
});


test("ordinary load refuses a non-target historical projection even with a rebound valid snapshot digest", async t => {
  const f = await fixture(t);
  const first = await flow.evaluateRunChecked(f.run.runId, f.options);
  const second = await flow.evaluateRunChecked(f.run.runId, { ...f.options, expectedRunHead: first.operationReceipt.originalResultHead, operation: identity("later") });
  const stateFile = path.join(f.run.dir, "state.json");
  const original = await readFile(stateFile), state = JSON.parse(original);
  const old = state.checked_operation_ledger.records[0];
  const snapshot = JSON.parse(await readFile(path.join(f.run.dir, "checked-operations", `${old.snapshotDigest}.json`), 'utf8'));
  snapshot.gate_outcomes[0].status = snapshot.gate_outcomes[0].status === 'pass' ? 'block' : 'pass';
  old.snapshotDigest = flow.flowRunHead(snapshot);
  state.checked_operation_ledger.records[1].priorReceiptDigest = flow.flowRunHead(old);
  await writeFile(path.join(f.run.dir, "checked-operations", `${old.snapshotDigest}.json`), flow.canonicalJson(snapshot));
  await writeFile(stateFile, JSON.stringify(state));
  await assert.rejects(flow.loadRun(f.run.runId, f.cwd), /gate_evaluation_ledger.outcome.conflict/);
  await assert.rejects(flow.evaluateRun(f.run.runId, { cwd: f.cwd, gate: "plan-gate" }), /gate_evaluation_ledger.outcome.conflict/);
  await assert.rejects(lookup(f, second.operationReceipt.operation), /gate_evaluation_ledger.outcome.conflict/);
});


test("a foreign store has no operation proof and a foreign run id cannot disclose this receipt", async t => {
  const f = await fixture(t), foreign = await fixture(t);
  await flow.evaluateRunChecked(f.run.runId, f.options);
  assert.equal(await flow.readCheckedRunOperation(f.run.runId, { cwd: foreign.cwd, operation: f.options.operation, admission }), null);
  await assert.rejects(flow.readCheckedRunOperation('different-run', { cwd: f.cwd, operation: f.options.operation, admission }));
});
