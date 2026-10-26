import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { FlowDefinitionIdentity, FlowRetryAuthorizationRequest, FlowRunState, GateOutcome } from "../contracts/flow-types.js";
import type { GateEvaluationRef } from "../contracts/gate-evaluation-contract.js";
import { assertSafeRunArtifactWritePath } from "./flow-files.js";
import { canonicalJson, flowRunHead, flowTransitionRef, validateRetryAuthorizationRequest, retryAuthorizationMatches } from "./flow-run-retry-authorization.js";
import { definitionIdentity } from "./flow-run-definition-amendment.js";

export const FLOW_CHECKED_OPERATION_LIMITS = Object.freeze({ receipts: 128, snapshotBytes: 8 * 1024 * 1024, totalSnapshotBytes: 64 * 1024 * 1024, snapshotFiles: 256, receiptBytes: 64 * 1024, ledgerBytes: 4 * 1024 * 1024 });
export interface FlowCheckedOperationIdentity { id: string; intentDigest: string }
export type FlowCheckedOperationRequest =
  | { kind: "evaluate"; runId: string; expectedRunHead: string; gate: string | null; now: string | null }
  | { kind: "authorize-retry"; runId: string; request: FlowRetryAuthorizationRequest };
export interface FlowCheckedOperationRecord {
  version: "1";
  operation: FlowCheckedOperationIdentity;
  kind: FlowCheckedOperationRequest["kind"];
  runId: string;
  request: FlowCheckedOperationRequest;
  requestSemanticDigest: string;
  originDefinition: FlowDefinitionIdentity;
  priorRunHead: string;
  snapshotDigest: string;
  priorReceiptDigest: string | null;
  transitionRefs: string[];
  evaluationRefs: GateEvaluationRef[];
  transitionStart: number;
  evaluationStart: number;
  outcomes: GateOutcome[];
}
export interface FlowCheckedRunOperationReceipt extends FlowCheckedOperationRecord { originalResultHead: string }
export interface FlowCheckedOperationLedger { version: "1"; records: FlowCheckedOperationRecord[] }
const directory = "checked-operations";
const digestPattern = /^[a-f0-9]{64}$/;
export function checkedFailure(reason: string): never { throw new Error(`flow.checked_operation.${reason}`); }
export function checkedIdentity(value: FlowCheckedOperationIdentity): FlowCheckedOperationIdentity {
  if (!value || Object.keys(value).sort().join() !== "id,intentDigest" || typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.id) || typeof value.intentDigest !== "string" || !digestPattern.test(value.intentDigest)) checkedFailure("identity.invalid");
  return { id: value.id, intentDigest: value.intentDigest };
}
export function checkedRecords(state: FlowRunState): FlowCheckedOperationRecord[] { return state.checked_operation_ledger?.records ?? []; }
export function checkedPriorHead(request: FlowCheckedOperationRequest): string { return request.kind === "evaluate" ? request.expectedRunHead : request.request.expected_run_head; }

/** Pure joins used by every canonical run validator, including historical snapshots. */
export function validateCheckedOperations(startDefinition: unknown, state: FlowRunState): void {
  const records = checkedRecords(state);
  if (Buffer.byteLength(canonicalJson(records)) > FLOW_CHECKED_OPERATION_LIMITS.ledgerBytes) checkedFailure("ledger.capacity");
  for (const amendment of state.definition_amendments ?? []) {
    const prior = amendment.prior_state.checked_operation_ledger?.records ?? [];
    if (canonicalJson(records.slice(0, prior.length)) !== canonicalJson(prior)) checkedFailure("history.truncated");
  }
  const definitions = [startDefinition, ...(state.definition_amendments ?? []).map(event => event.successor)].map(definitionIdentity);
  const outcomeHistory = new Map((state.gate_outcome_history ?? []).filter(entry => entry.evaluation_ref).map(entry => [entry.evaluation_ref.evaluationId, entry]));
  const ids = new Set<string>(), effects = new Set<string>();
  let lastTransition = 0, lastEvaluation = 0;
  for (const [recordIndex, record] of records.entries()) {
    if (record.priorReceiptDigest !== (recordIndex ? flowRunHead(records[recordIndex - 1]) : null)) checkedFailure("history.prefix");
    if (Buffer.byteLength(canonicalJson(record)) > FLOW_CHECKED_OPERATION_LIMITS.receiptBytes) checkedFailure("receipt.capacity");
    checkedIdentity(record.operation);
    if (ids.has(record.operation.id)) checkedFailure("identity.duplicate");
    ids.add(record.operation.id);
    if (record.runId !== state.run_id || record.request.runId !== state.run_id || record.kind !== record.request.kind || flowRunHead(record.request) !== record.requestSemanticDigest || checkedPriorHead(record.request) !== record.priorRunHead || !definitions.some(definition => canonicalJson(definition) === canonicalJson(record.originDefinition))) checkedFailure("record.binding");
    if (record.request.kind === "authorize-retry" && canonicalJson(validateRetryAuthorizationRequest(record.request.request)) !== canonicalJson(record.request.request)) checkedFailure("request.invalid");
    if (record.transitionStart < lastTransition || record.evaluationStart < lastEvaluation) checkedFailure("history.order");
    const transitions = state.transitions.slice(record.transitionStart, record.transitionStart + record.transitionRefs.length);
    const evaluations = (state.gate_evaluation_ledger?.records ?? []).slice(record.evaluationStart, record.evaluationStart + record.evaluationRefs.length);
    if (canonicalJson(transitions.map(flowTransitionRef)) !== canonicalJson(record.transitionRefs) || canonicalJson(evaluations.map(entry => entry.ref)) !== canonicalJson(record.evaluationRefs)) checkedFailure("effect.missing");
    for (const ref of record.evaluationRefs) {
      const key = canonicalJson(ref);
      if (effects.has(key)) checkedFailure("effect.rebound");
      effects.add(key);
    }
    if (record.kind === "evaluate") {
      if (!evaluations.length || canonicalJson(record.outcomes.map(outcome => outcome.evaluation_ref)) !== canonicalJson(record.evaluationRefs)) checkedFailure("evaluation.invalid");
      for (let index = 0; index < evaluations.length; index++) {
        if (evaluations[index].originalVerdict !== record.outcomes[index].status || canonicalJson(evaluations[index].definition) !== canonicalJson(record.originDefinition)) checkedFailure("evaluation.binding");
        const outcome = record.outcomes[index];
        const historical = outcomeHistory.get(outcome.evaluation_ref.evaluationId);
        if (!historical) checkedFailure("evaluation.history");
        const { invalidated_steps, ...observed } = outcome;
        const { invalidated_steps: _oldInvalidation, ...recorded } = historical;
        if (canonicalJson(observed) !== canonicalJson(recorded)
          || (invalidated_steps !== undefined && !transitions.some(entry => entry.gate_id === outcome.gate_id && canonicalJson(entry.invalidated_steps ?? null) === canonicalJson(invalidated_steps)))) checkedFailure("evaluation.history");
      }
    } else if (transitions.length !== 1 || transitions[0].type !== "retry_authorized" || record.evaluationRefs.length || record.outcomes.length || record.request.kind !== "authorize-retry" || !retryAuthorizationMatches(transitions[0], record.request.request)) checkedFailure("retry.invalid");
    lastTransition = record.transitionStart + record.transitionRefs.length;
    lastEvaluation = record.evaluationStart + record.evaluationRefs.length;
  }
}

async function syncSnapshotDirectory(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function confirmCheckedRunDurability(dir: string, state: FlowRunState): Promise<void> {
  const identity = await lstat(dir);
  const handle = await open(path.join(dir, "state.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) checkedFailure("state.unsafe");
    const bytes = await handle.readFile();
    if (flowRunHead(JSON.parse(bytes.toString("utf8"))) !== flowRunHead(state)) checkedFailure("state.changed");
    await handle.sync();
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) checkedFailure("state.changed");
    const named = await lstat(path.join(dir, "state.json"));
    if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino) checkedFailure("state.changed");
    await syncSnapshotDirectory(dir);
    await sameSnapshotDirectory(dir, identity);
  } finally { await handle.close(); }
}

async function sameSnapshotDirectory(location: string, expected: Awaited<ReturnType<typeof lstat>>) {
  const actual = await lstat(location);
  if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) checkedFailure("snapshot.changed");
}

async function snapshotDirectory(dir: string, create = false): Promise<string> {
  const target = await assertSafeRunArtifactWritePath(dir, `${directory}/placeholder`);
  const location = path.dirname(target);
  if (create) { await mkdir(location, { recursive: true, mode: 0o700 }); await syncSnapshotDirectory(dir); }
  const stat = await lstat(location);
  if (!stat.isDirectory() || stat.isSymbolicLink()) checkedFailure("snapshot.unsafe");
  return location;
}
export async function checkCheckedOperationCapacity(dir: string, state: FlowRunState): Promise<void> {
  if (process.platform === "win32") checkedFailure("durability.unavailable");
  await syncSnapshotDirectory(dir);
  if (checkedRecords(state).length >= FLOW_CHECKED_OPERATION_LIMITS.receipts || Buffer.byteLength(canonicalJson(checkedRecords(state))) + FLOW_CHECKED_OPERATION_LIMITS.receiptBytes > FLOW_CHECKED_OPERATION_LIMITS.ledgerBytes) checkedFailure("capacity");
  let location: string;
  location = await snapshotDirectory(dir, true);
  await syncSnapshotDirectory(location);
  const files = await readdir(location);
  let bytes = 0;
  for (const name of files) {
    const stat = await lstat(path.join(location, name));
    if (!/^[a-f0-9]{64}\.json$/.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > FLOW_CHECKED_OPERATION_LIMITS.snapshotBytes) checkedFailure("snapshot.unsafe");
    bytes += stat.size;
  }
  // Reserve a complete maximum-sized snapshot before evaluating any effect.
  if (files.length >= FLOW_CHECKED_OPERATION_LIMITS.snapshotFiles || bytes + FLOW_CHECKED_OPERATION_LIMITS.snapshotBytes > FLOW_CHECKED_OPERATION_LIMITS.totalSnapshotBytes) checkedFailure("capacity");
}
export async function readCheckedSnapshot(dir: string, digest: string, confirmDurability = false): Promise<unknown> {
  if (!digestPattern.test(digest)) checkedFailure("snapshot.digest");
  const rootIdentity = await lstat(dir);
  const location = await snapshotDirectory(dir);
  const directoryIdentity = await lstat(location);
  const file = path.join(location, `${digest}.json`);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > FLOW_CHECKED_OPERATION_LIMITS.snapshotBytes) checkedFailure("snapshot.unsafe");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(file);
    if (named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1 || offset !== stat.size) checkedFailure("snapshot.changed");
    const text = bytes.subarray(0, offset).toString("utf8");
    const value: unknown = JSON.parse(text);
    if (flowRunHead(value) !== digest || canonicalJson(value) !== text) checkedFailure("snapshot.digest");
    if (confirmDurability) {
      await handle.sync();
      await syncSnapshotDirectory(location);
    }
    await sameSnapshotDirectory(location, directoryIdentity);
    await sameSnapshotDirectory(dir, rootIdentity);
    return value;
  } finally { await handle.close(); }
}
export async function writeCheckedSnapshot(dir: string, state: FlowRunState): Promise<string> {
  const { checked_operation_ledger: _ledger, ...snapshot } = state;
  const bytes = canonicalJson(snapshot), digest = flowRunHead(snapshot);
  if (Buffer.byteLength(bytes) > FLOW_CHECKED_OPERATION_LIMITS.snapshotBytes) checkedFailure("snapshot.capacity");
  const rootIdentity = await lstat(dir);
  const location = await snapshotDirectory(dir, true);
  const directoryIdentity = await lstat(location);
  let handle;
  try { handle = await open(path.join(location, `${digest}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error?.code !== "EEXIST") throw error; await readCheckedSnapshot(dir, digest, true); return digest; }
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await syncSnapshotDirectory(location);
  await syncSnapshotDirectory(dir);
  await sameSnapshotDirectory(location, directoryIdentity);
  await sameSnapshotDirectory(dir, rootIdentity);
  return digest;
}
