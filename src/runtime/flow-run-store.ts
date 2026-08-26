import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { readFile, readdir, lstat, open, writeFile, mkdir, rename, rm, link } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";

import {
  FLOW_RUN_DEFINITION_FILE,
  FLOW_RUN_EVIDENCE_DIR,
  FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  FLOW_RUN_LAYOUT,
  FLOW_RUN_STATE_FILE,
  assertSafeRunArtifactWritePath,
  assertSafeRunId,
  assertSafeWorkingDirectory,
  ensureDirectoryPathWithoutSymlinks,
  examplePath,
  flowConfigPath,
  flowRuntimeRoot,
  flowRoot,
  publishRunArtifacts,
  readJson,
  runDir,
  writeJson,
  type PublishRunArtifactsHooks
} from "./flow-files.js";
import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type { FlowDefinitionAmendmentEvent, FlowDefinitionAmendmentRequest, FlowDefinitionAmendmentResult, FlowEvidenceAttachmentOptions, FlowEvidenceEntry, FlowLifecycleAction, FlowLifecycleEvent, FlowPausedGateContinuationOptions, FlowPausedGateContinuationResult, FlowRetryAuthorizationRequest, FlowRetryAuthorizationResult, FlowRetryAuthorizationTransition, FlowRunState, GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import { parseGateEvaluationLedger } from "../contracts/gate-evaluation-contract.js";
import type { GateEvaluationRecord, GateEvaluationRef } from "../contracts/gate-evaluation-contract.js";
import { loadFlowConfig, defaultFlowConfig } from "../config/flow-config.js";
import {
  findGate,
  gatesForStep,
  getStep,
  occupiedSteps,
  initialState,
  normalizeRunStateLifecycle,
  openGates,
  nextActionForStep,
  readySteps,
  descendantsOf,
  invalidateDescendants,
  validateDefinition
} from "../definition/flow-definition.js";
import { applyEvaluation, evaluateGate, expectationsForGate, mergeGateOutcome, reconcileSurfaceBundleReport } from "../gates/flow-gates.js";
import { surfaceDerivationWithinBudget } from "../gates/surface-derivation-budget.js";
import {
  buildDurableStepClaim,
  claimableMultiCursorSteps,
  ensureMultiCursorState,
  FLOW_DURABLE_CLAIM_DEFAULT_LEASE_SECONDS,
  FlowMultiCursorError,
  releaseClaimsForSteps,
  sameClaimActor,
  validateMultiCursorState,
  validateDurableStepClaim
} from "./flow-multi-cursor.js";
import type { FlowDurableStepClaimRequest, FlowStepClaimActor } from "../contracts/flow-types.js";
import { validateEvaluationTransition } from "../transition/flow-evaluation-transition.js";
import { renderAndWriteReport, renderMarkdownReport, reportJson } from "../reports/flow-reports.js";
import { validateEvidenceManifestSchema, validateRunStateSchema } from "./flow-run-validator.js";
import { isNonEmptyString, isObject, normalizeEvidenceKind, slugLabel } from "../shared/flow-utils.js";
import { compareRfc3339Timestamps, parseRfc3339Timestamp, surfaceTimestampValidationView } from "../shared/rfc3339.js";
import { buildTrustReport, validateTrustBundle, checkpointFromReport, diffFreshness } from "@kontourai/surface";
import {
  FlowLifecycleError,
  assertLifecycleEligible,
  lifecycleRequestMatches,
  priorResumableStatus,
  validateLifecycleRequest
} from "./flow-run-lifecycle.js";
import {
  FlowRetryAuthorizationError,
  canonicalJson,
  flowRunHead,
  flowTransitionRef,
  retryAuthorizationMatches,
  validateRetryAuthorizationRequest
} from "./flow-run-retry-authorization.js";
import { exhaustedRouteBackProof, validateRetryAuthorizationHistory } from "./flow-run-retry-proof.js";
import { FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES, normalizeTrustAttachmentBundle, reduceTrustAttachmentManifest } from "./trust-attachment-reducer.js";
import {
  assertRunRecoveryFenceOpen,
  assertActiveRunRecoveryFenceWrite,
  inspectRunRecoveryFence,
  publishActiveRunRecoveryFence,
  publishOpenRunRecoveryFence,
  resolveRunRecoveryDirectory,
  type FlowRunRecoveryFenceSnapshot,
  type FlowRunRecoveryFenceFinalizeRequest,
  type FlowRunRecoveryFenceWrite,
  type RunRecoveryFenceWriteHooks,
  withRunRecoveryFenceRead
} from "./flow-run-recovery-fence.js";

import {
  FlowDefinitionAmendmentError,
  amendmentRequestReplayExists,
  assertDefinitionCompatibility,
  assertExpectedDefinitionIdentity,
  definitionDigest,
  definitionIdentity,
  effectiveDefinitionIdentity,
  resolveEffectiveDefinition,
  validateDefinitionAmendmentRequest
} from "./flow-run-definition-amendment.js";

type RunLocationDiagnostic = {
  code: string;
  severity: "warning" | "error";
  run_id: string;
  message: string;
};

type RunCandidate = {
  dir: string;
  status: "absent" | "complete" | "incomplete";
  reason?: string;
};

type RunLocation = {
  runId: string;
  dir: string;
  diagnostics: RunLocationDiagnostic[];
};

const resolvedRunContexts = new WeakMap<object, { cwd: string }>();
const activeMutationLockTokens = new Set<string>();
const activeRunMutationTicket = new AsyncLocalStorage<{
  token: string;
  run_id: string;
  directory: { device: string; inode: string };
}>();
const RETRY_MUTATION_AFTER_RECOVERY = Symbol("retry-mutation-after-recovery");

/**
 * Test-only fault-injection hooks for the atomic publication path used by
 * saveRun and saveLifecycleState. When set, every publishRunArtifacts call
 * from those two functions receives these hooks, allowing the crash-
 * interleaving matrix to inject faults at each stage boundary without
 * threading optional parameters through every public mutating API.
 *
 * Production code never sets this; it defaults to undefined (no hooks).
 */
let _publishRunArtifactsFaultHooks: PublishRunArtifactsHooks | undefined;

/** @internal Test-only setter for crash-interleaving fault injection. */
export function __setPublishRunArtifactsFaultHooks(hooks?: PublishRunArtifactsHooks) {
  _publishRunArtifactsFaultHooks = hooks;
}

function flowRunsRoot(cwd = process.cwd()) {
  return path.join(flowRuntimeRoot(cwd), "runs");
}

function runLocationDiagnostic(
  code: string,
  severity: "warning" | "error",
  runId: string,
  message: string
): RunLocationDiagnostic {
  return { code, severity, run_id: runId, message };
}

function runLocationError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`);
  (error as Error & { code?: string }).code = code;
  return error;
}

function isMissingPathError(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT";
}

function inspectionError(runId: string, file: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return runLocationError("flow.run_location.inspection_failed", `cannot inspect run "${runId}" at ${file}: ${detail}`);
}

async function inspectRuntimeRoot(runId: string, cwd: string) {
  const base = await assertSafeWorkingDirectory(cwd);
  const root = flowRunsRoot(cwd);
  const relative = path.relative(base, root);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw runLocationError("flow.run_location.inspection_failed", `runtime root ${root} escapes working directory ${base}`);
  }

  let cursor = base;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw runLocationError("flow.run_location.inspection_failed", `runtime root component ${cursor} must be a real directory`);
      }
    } catch (error) {
      if (isMissingPathError(error)) return false;
      if ((error as Error & { code?: string })?.code === "flow.run_location.inspection_failed") throw error;
      throw inspectionError(runId, cursor, error);
    }
  }
  return true;
}

async function candidateFileJson(runId: string, dir: string, relativePath: string): Promise<{ value?: any; reason?: string }> {
  const parts = relativePath.split(/[\\/]/);
  let file = dir;
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    try {
      const fileStat = await lstat(file);
      if (fileStat.isSymbolicLink()) return { reason: `${relativePath} contains a symbolic link` };
      if (index < parts.length - 1 && !fileStat.isDirectory()) return { reason: `${relativePath} has a non-directory parent` };
      if (index === parts.length - 1 && !fileStat.isFile()) return { reason: `${relativePath} is not a file` };
    } catch (error) {
      if (isMissingPathError(error)) return { reason: `missing ${relativePath}` };
      throw inspectionError(runId, file, error);
    }
  }

  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw inspectionError(runId, file, error);
  }

  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { reason: `${relativePath} is not valid JSON` };
  }
}

async function inspectRunCandidate(runId: string, cwd: string): Promise<RunCandidate> {
  const dir = runDir(runId, cwd);
  if (!(await inspectRuntimeRoot(runId, cwd))) {
    return { dir, status: "absent", reason: "runtime root not present" };
  }
  let dirStat;
  try {
    dirStat = await lstat(dir);
  } catch (error) {
    if (isMissingPathError(error)) return { dir, status: "absent", reason: "not present" };
    throw inspectionError(runId, dir, error);
  }
  if (dirStat.isSymbolicLink()) return { dir, status: "incomplete", reason: "run directory is a symbolic link" };
  if (!dirStat.isDirectory()) return { dir, status: "incomplete", reason: "not a directory" };

  const definitionResult = await candidateFileJson(runId, dir, FLOW_RUN_DEFINITION_FILE);
  if (definitionResult.reason) return { dir, status: "incomplete", reason: definitionResult.reason };

  let definition;
  try {
    definition = validateDefinition(definitionResult.value);
  } catch {
    return { dir, status: "incomplete", reason: `${FLOW_RUN_DEFINITION_FILE} is not a valid Flow definition` };
  }

  const stateResult = await candidateFileJson(runId, dir, FLOW_RUN_STATE_FILE);
  if (stateResult.reason) return { dir, status: "incomplete", reason: stateResult.reason };
  try {
    validateRunStateConsistency(definition, stateResult.value, { runId });
  } catch (error) {
    return {
      dir,
      status: "incomplete",
      reason: `${FLOW_RUN_STATE_FILE} is invalid (${error instanceof Error ? error.message : String(error)})`
    };
  }

  const manifestResult = await candidateFileJson(runId, dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  if (manifestResult.reason) return { dir, status: "incomplete", reason: manifestResult.reason };
  const manifest = manifestResult.value;
  try {
    validateEvidenceManifestIdentity(manifest, definition, stateResult.value);
  } catch (error) {
    return {
      dir,
      status: "incomplete",
      reason: `${FLOW_RUN_EVIDENCE_MANIFEST_PATH} is invalid (${error instanceof Error ? error.message : String(error)})`
    };
  }
  return { dir, status: "complete" };
}

async function resolveRunLocation(runId: string, cwd = process.cwd()): Promise<RunLocation> {
  assertSafeRunId(runId);
  const candidate = await inspectRunCandidate(runId, cwd);
  if (candidate.status === "absent") {
    throw runLocationError("flow.run_location.not_found", `run \"${runId}\" was not found in ${candidate.dir}`);
  }
  if (candidate.status === "complete") return { runId, dir: candidate.dir, diagnostics: [] };
  throw runLocationError(
    "flow.run_location.no_complete_candidate",
    `canonical run directory ${candidate.dir} is incomplete (${candidate.reason})`
  );
}

async function allocateNewRunLocation(runId: string, cwd = process.cwd()): Promise<string> {
  assertSafeRunId(runId);
  const candidate = await inspectRunCandidate(runId, cwd);
  if (candidate.status !== "absent") {
    throw runLocationError("flow.run_location.allocation_collision", `run \"${runId}\" already has a candidate at ${candidate.dir}`);
  }
  await ensureDirectoryPathWithoutSymlinks(cwd, path.join(".kontourai", "flow", "runs"));
  const dir = runDir(runId, cwd);
  try {
    await mkdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw runLocationError("flow.run_location.allocation_collision", `run \"${runId}\" already has a candidate at ${dir}`);
    }
    throw error;
  }
  const claimed = await lstat(dir);
  if (claimed.isSymbolicLink() || !claimed.isDirectory()) {
    throw runLocationError("flow.run_location.allocation_collision", `run \"${runId}\" could not claim a real directory at ${dir}`);
  }
  return dir;
}

export async function ensureFlowLayout(cwd = process.cwd()) {
  const root = flowRoot(cwd);
  await ensureDirectoryPathWithoutSymlinks(cwd, path.join(".flow", "definitions"));
  await ensureDirectoryPathWithoutSymlinks(cwd, path.join(".kontourai", "flow", "runs"));
  const readmePath = await assertSafeRunArtifactWritePath(root, "README.md");
  const configPath = await assertSafeRunArtifactWritePath(root, "config.json");
  const samplePath = await assertSafeRunArtifactWritePath(root, path.join("definitions", "agent-dev-flow.json"));
  await writeFile(readmePath, flowReadme());
  if (!existsSync(configPath)) await writeJson(configPath, defaultFlowConfig());
  const sample = await readJson(examplePath("agent-dev-flow.json"));
  await writeJson(samplePath, sample);
  return root;
}

export async function scaffoldDemoRun(cwd = process.cwd()) {
  const root = await ensureFlowLayout(cwd);
  const runId = "demo";
  try {
    const location = await resolveRunLocation(runId, cwd);
    return { runId, created: false, diagnostics: location.diagnostics };
  } catch (error) {
    if ((error as Error & { code?: string })?.code !== "flow.run_location.not_found") throw error;
  }
  const demoDir = path.join(flowRuntimeRoot(cwd), "demo");
  await ensureDirectoryPathWithoutSymlinks(cwd, path.join(".kontourai", "flow", "demo"));
  const bundleFile = await assertSafeRunArtifactWritePath(demoDir, "acceptance-bundle.json");
  const now = new Date().toISOString();
  await writeJson(bundleFile, {
    schemaVersion: 5,
    source: "demo/reviewer",
    claims: [
      {
        id: "claim.builder.acceptance.demo",
        subjectType: "flow-step",
        subjectId: "builder.plan",
        facet: "builder.acceptance",
        claimType: "builder.acceptance",
        fieldOrBehavior: "acceptanceCriteria",
        value: "demo acceptance criteria reviewed",
        createdAt: now,
        updatedAt: now
      }
    ],
    evidence: [
      {
        id: "evidence.builder.acceptance.demo",
        claimId: "claim.builder.acceptance.demo",
        evidenceType: "human_attestation",
        method: "attestation",
        sourceRef: "demo:reviewer",
        excerptOrSummary: "Demo acceptance criteria reviewed and confirmed.",
        observedAt: now,
        collectedBy: "demo/reviewer"
      }
    ],
    policies: [],
    events: [
      {
        id: "event.builder.acceptance.demo.verified",
        claimId: "claim.builder.acceptance.demo",
        status: "verified",
        actor: "demo/reviewer",
        method: "attestation",
        evidenceIds: ["evidence.builder.acceptance.demo"],
        createdAt: now,
        verifiedAt: now
      }
    ]
  });
  await startRun(path.join(root, "definitions", "agent-dev-flow.json"), {
    cwd,
    runId,
    params: { subject: "demo-checkout-banner" }
  });
  await attachEvidence(runId, {
    cwd,
    gate: "plan-gate",
    file: bundleFile,
    bundle: true
  });
  const result = await evaluateRun(runId, { cwd });
  return { runId, created: true, state: result.state, diagnostics: [] };
}

export function flowReadme() {
  return `# .flow\n\nDurable Flow project state lives here.\n\n- definitions/ contains authored Flow Definition JSON files.\n- config.json is the project authority model for trusted producers and gate overrides.\n\nGenerated run state and demo evidence are written only under .kontourai/flow/. Generated state from older Flow versions must be migrated explicitly; current runtime commands do not read .flow/runs/.\n`;
}

export function initialEvidenceManifest(definition, state) {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: state.run_id,
    definition_id: definition.id,
    definition_version: definition.version,
    evidence: []
  };
}

export function validateRunStateIdentity(definition, state, runId) {
  if (state.run_id !== runId) {
    throw new Error(`run state run_id mismatch: expected ${runId}, got ${state.run_id}`);
  }
  if (state.definition_id !== definition.id) {
    throw new Error(`run state definition_id mismatch: expected ${definition.id}, got ${state.definition_id}`);
  }
  if (state.definition_version !== definition.version) {
    throw new Error(`run state definition_version mismatch: expected ${definition.version}, got ${state.definition_version}`);
  }
  return state;
}

function gateEvaluationRefKey(ref: GateEvaluationRef) {
  return `${ref.runId}\u0000${ref.gateId}\u0000${ref.evaluationId}`;
}

function gateEvaluationDigest(gate: unknown, config: MutableRecord) {
  // The authored gate alone is insufficient: evaluateGate applies Flow-owned
  // project overrides before selecting evidence. Persist the normalized
  // effective expectation set, not the mutable config object or its metadata.
  return createHash("sha256").update(canonicalJson({
    gate,
    expectations: expectationsForGate(gate, config),
    trusted_producers: config.trusted_producers ?? {},
    gate_override: config.gate_overrides?.[(gate as any).id] ?? null
  })).digest("hex");
}

// Receipt selection identity is a JSON tuple, never a delimiter-joined string:
// authored ids are open strings and must not be able to collide with a
// separator used by the validator.
function gateEvaluationSelectionKey(expectationId: unknown, evidenceId: unknown) {
  return JSON.stringify([expectationId, evidenceId]);
}

/**
 * `claim_ids` is a decision witness, not an advisory current-bundle query.
 * Preserve its order exactly, while rejecting duplicate or malformed witnesses
 * before comparing an immutable outcome to its corresponding receipt.
 */
function canonicalGateEvaluationClaimIds(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value];
}

function sameGateEvaluationClaimIds(left: string[] | undefined, right: string[] | undefined) {
  return left === undefined && right === undefined
    || (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right));
}

type CanonicalAuthorityWitness = { claimId: string; traceId: string; governingEventId: string };

function canonicalGateEvaluationAuthorityWitness(value: unknown): CanonicalAuthorityWitness | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isObject(value)) return false;
  const candidate = value as MutableRecord;
  if (typeof candidate.claimId !== "string" || !candidate.claimId || typeof candidate.traceId !== "string" || !candidate.traceId || typeof candidate.governingEventId !== "string" || !candidate.governingEventId || Object.keys(candidate).length !== 3) return false;
  return { claimId: candidate.claimId as string, traceId: candidate.traceId as string, governingEventId: candidate.governingEventId as string };
}

function sameGateEvaluationAuthorityWitness(left: CanonicalAuthorityWitness | null | undefined, right: CanonicalAuthorityWitness | null | undefined) {
  return left === right || (left !== undefined && right !== undefined && left !== null && right !== null
    && left.claimId === right.claimId && left.traceId === right.traceId && left.governingEventId === right.governingEventId);
}

function validateGateEvaluationSelections(record: GateEvaluationRecord, outcome: any) {
  const expected = new Map<string, { claimIds: string[] | undefined; authorityWitness: CanonicalAuthorityWitness | null | undefined }>();
  for (const match of outcome.matched_expectations ?? []) {
    const key = gateEvaluationSelectionKey(match?.expectation_id, match?.evidence_id);
    const claimIds = canonicalGateEvaluationClaimIds(match?.claim_ids);
    const authorityWitness = canonicalGateEvaluationAuthorityWitness(match?.authority_witness);
    if (typeof match?.expectation_id !== "string" || typeof match?.evidence_id !== "string" || claimIds === null || authorityWitness === false || expected.has(key)) {
      throw new Error(`flow.gate_evaluation_ledger.selection.conflict: ${record.ref.evaluationId}`);
    }
    expected.set(key, { claimIds, authorityWitness });
  }
  const evidenceRefs: Set<string> = new Set<string>((outcome.evidence_refs ?? []).filter((id: unknown): id is string => typeof id === "string"));
  const selectedEvidence = new Set<string>();
  const actual = new Set<string>();
  for (const selection of record.selections) {
    selectedEvidence.add(selection.evidenceId);
    if (selection.expectationId === undefined) {
      // A bare evidence ref is not a claim witness. It cannot carry one, and
      // it must name evidence the historical outcome actually referenced.
      if (selection.claimIds !== undefined || selection.authorityWitness !== undefined || !evidenceRefs.has(selection.evidenceId)) {
        throw new Error(`flow.gate_evaluation_ledger.selection.conflict: ${record.ref.evaluationId}`);
      }
      continue;
    }
    const key = gateEvaluationSelectionKey(selection.expectationId, selection.evidenceId);
    const claimIds = canonicalGateEvaluationClaimIds(selection.claimIds);
    const authorityWitness = canonicalGateEvaluationAuthorityWitness(selection.authorityWitness);
    const historical = expected.get(key);
    if (claimIds === null || authorityWitness === false || actual.has(key) || !historical || !sameGateEvaluationClaimIds(claimIds, historical.claimIds) || !sameGateEvaluationAuthorityWitness(authorityWitness, historical.authorityWitness)) {
      throw new Error(`flow.gate_evaluation_ledger.selection.conflict: ${record.ref.evaluationId}`);
    }
    actual.add(key);
  }
  if (actual.size !== expected.size || [...expected.keys()].some((key) => !actual.has(key))
    || [...evidenceRefs].some((evidenceId) => !selectedEvidence.has(evidenceId))) {
    throw new Error(`flow.gate_evaluation_ledger.selection.conflict: ${record.ref.evaluationId}`);
  }
}

/**
 * Fail closed on every causal relation that makes a persisted appraisal useful.
 * Legacy state deliberately has no ledger and remains readable; a present
 * ledger is never inferred, repaired, or silently downgraded.
 */
export function validateGateEvaluationLedger(definition: any, state: any, manifest?: any, historicalDefinitions: any[] = []) {
  const raw = state.gate_evaluation_ledger;
  if (raw === undefined) {
    if ([...(state.gate_outcomes ?? []), ...(state.gate_outcome_history ?? [])].some((outcome: any) => outcome?.evaluation_ref !== undefined)) {
      throw new Error("flow.gate_evaluation_ledger.missing: outcomes reference a missing ledger");
    }
    return undefined;
  }
  if (!isObject(raw) || raw.version !== "1") {
    throw new Error(`flow.gate_evaluation_ledger.unsupported: version ${String((raw as any)?.version)} is not supported`);
  }
  const ledger = parseGateEvaluationLedger(raw);
  if (!ledger) throw new Error("flow.gate_evaluation_ledger.invalid: ledger does not satisfy the v1 contract");
  const records = new Map<string, GateEvaluationRecord>();
  const lastByGate = new Map<string, GateEvaluationRecord>();
  for (const record of ledger.records) {
    const key = gateEvaluationRefKey(record.ref);
    if (records.has(key)) throw new Error(`flow.gate_evaluation_ledger.duplicate_id: ${record.ref.evaluationId}`);
    if (record.ref.runId !== state.run_id) throw new Error(`flow.gate_evaluation_ledger.run_mismatch: ${record.ref.evaluationId}`);
    const gate = findGate(definition, record.ref.gateId);
    if (!gate || record.gate.id !== record.ref.gateId) throw new Error(`flow.gate_evaluation_ledger.gate_mismatch: ${record.ref.evaluationId}`);
    // Definitions can be amended, so the record carries the immutable gate
    // digest. The current definition must still recognize the gate id, but a
    // historical record is not rewritten to fit a later effective definition.
    if (record.definition.id !== state.definition_id || !record.definition.digest || !record.gate.digest) {
      throw new Error(`flow.gate_evaluation_ledger.definition_mismatch: ${record.ref.evaluationId}`);
    }
    if (historicalDefinitions.length) {
      const snapshot = historicalDefinitions.find((candidate) => {
        const identity = definitionIdentity(candidate);
        return identity.id === record.definition.id && identity.version === record.definition.version && identity.digest === record.definition.digest;
      });
      if (!snapshot || !findGate(snapshot, record.ref.gateId)) {
        throw new Error(`flow.gate_evaluation_ledger.definition_mismatch: ${record.ref.evaluationId}`);
      }
    }
    const prior = lastByGate.get(record.ref.gateId);
    if (record.previousRef) {
      if (!prior || gateEvaluationRefKey(record.previousRef) !== gateEvaluationRefKey(prior.ref)) {
        throw new Error(`flow.gate_evaluation_ledger.previous_chain.invalid: ${record.ref.evaluationId}`);
      }
    } else if (prior) {
      throw new Error(`flow.gate_evaluation_ledger.previous_chain.invalid: ${record.ref.evaluationId}`);
    }
    records.set(key, record);
    lastByGate.set(record.ref.gateId, record);
  }
  const historyReferenced = new Set<string>();
  const historyOutcomes = new Set<string>();
  for (const outcome of state.gate_outcome_history ?? []) {
    if (!outcome?.evaluation_ref) continue;
    const ref = outcome.evaluation_ref as GateEvaluationRef;
    const key = gateEvaluationRefKey(ref);
    const record = records.get(key);
    if (!record) throw new Error(`flow.gate_evaluation_ledger.outcome_ref.dangling: ${ref.evaluationId}`);
    if (historyOutcomes.has(key)) throw new Error(`flow.gate_evaluation_ledger.outcome.conflict: ${ref.evaluationId}`);
    historyOutcomes.add(key);
    if (ref.runId !== state.run_id || ref.gateId !== outcome.gate_id || record.originalVerdict !== outcome.status) {
      throw new Error(`flow.gate_evaluation_ledger.outcome.conflict: ${ref.evaluationId}`);
    }
    validateGateEvaluationSelections(record, outcome);
    historyReferenced.add(key);
  }
  for (const outcome of [...(state.gate_outcomes ?? []), ...(state.gate_outcome_history ?? [])]) {
    if (!outcome?.evaluation_ref) continue;
    const ref = outcome.evaluation_ref as GateEvaluationRef;
    const record = records.get(gateEvaluationRefKey(ref));
    if (!record) throw new Error(`flow.gate_evaluation_ledger.outcome_ref.dangling: ${ref.evaluationId}`);
    if (ref.runId !== state.run_id || ref.gateId !== outcome.gate_id || record.originalVerdict !== outcome.status) {
      throw new Error(`flow.gate_evaluation_ledger.outcome.conflict: ${ref.evaluationId}`);
    }
    if (record.exceptionId !== outcome.accepted_exception_id) {
      throw new Error(`flow.gate_evaluation_ledger.exception.conflict: ${ref.evaluationId}`);
    }
    if (record.exceptionId && !(state.exceptions ?? []).some((exception: any) => exception.id === record.exceptionId && exception.gate_id === outcome.gate_id)) {
      throw new Error(`flow.gate_evaluation_ledger.exception.conflict: ${ref.evaluationId}`);
    }
    const routed = outcome.status === "route-back" || outcome.limit_exceeded === true;
    if (routed !== !!record.routeBack
      || (routed && (record.routeBack?.attempt !== outcome.attempt
        || record.routeBack?.maxAttempts !== outcome.max_attempts
        || record.routeBack?.retryEpoch !== outcome.retry_epoch
        || record.routeBack?.reason !== outcome.route_reason
        || record.routeBack?.selectedRoute !== outcome.selected_route))) {
      throw new Error(`flow.gate_evaluation_ledger.route_back.conflict: ${ref.evaluationId}`);
    }
    if (manifest) {
      const entries = new Map<string, any>((manifest.evidence ?? []).map((entry: any): [string, any] => [entry.id, entry]));
      for (const selection of record.selections) {
        const entry = entries.get(selection.evidenceId);
        if (entry && selection.sha256 !== undefined && entry.sha256?.toLowerCase() !== selection.sha256) {
          throw new Error(`flow.gate_evaluation_ledger.selection.digest_conflict: ${ref.evaluationId}`);
        }
      }
    }
  }
  for (const [key, record] of records) {
    if (!historyReferenced.has(key)) throw new Error(`flow.gate_evaluation_ledger.record.orphaned: ${record.ref.evaluationId}`);
  }
  return ledger;
}

function assertGateEvaluationLedgerVersionSupported(state: any) {
  const raw = state?.gate_evaluation_ledger;
  if (raw !== undefined && (!isObject(raw) || raw.version !== "1")) {
    throw new Error(`flow.gate_evaluation_ledger.unsupported: version ${String((raw as any)?.version)} is not supported`);
  }
}

/** Mint exactly one receipt from the evaluator's already-selected evidence. */
function mintGateEvaluation(run: any, outcome: GateOutcome, evaluatedAt: string, trigger: GateEvaluationRecord["trigger"]) {
  if (!new Set(["pass", "block", "route-back", "wait"]).has(outcome.status)) {
    throw new Error(`flow.gate_evaluation_ledger.verdict.invalid: ${outcome.status}`);
  }
  const ledger = run.state.gate_evaluation_ledger ?? { version: "1", records: [] };
  if (ledger.version !== "1" || !Array.isArray(ledger.records)) throw new Error("flow.gate_evaluation_ledger.invalid: cannot append to an invalid ledger");
  const gate = findGate(run.definition, outcome.gate_id);
  if (!gate) throw new Error(`flow.gate_evaluation_ledger.gate_mismatch: ${outcome.gate_id}`);
  const ref: GateEvaluationRef = { runId: run.state.run_id, gateId: outcome.gate_id, evaluationId: randomUUID() };
  const previous = [...ledger.records].reverse().find((record: GateEvaluationRecord) => record.ref?.gateId === outcome.gate_id);
  const evidence = new Map<string, any>((run.manifest.evidence ?? []).map((entry: any): [string, any] => [entry.id, entry]));
  const selections: GateEvaluationRecord["selections"] = [];
  const selected = new Set<string>();
  for (const match of outcome.matched_expectations ?? []) {
    const entry = evidence.get(match.evidence_id);
    selections.push({ expectationId: match.expectation_id, evidenceId: match.evidence_id, ...(typeof entry?.sha256 === "string" ? { sha256: entry.sha256.toLowerCase() } : {}), ...(Array.isArray(match.claim_ids) ? { claimIds: match.claim_ids.filter((id: unknown): id is string => typeof id === "string") } : {}), ...(Object.hasOwn(match, "authority_witness") ? { authorityWitness: match.authority_witness } : {}) });
    selected.add(match.evidence_id);
  }
  for (const evidenceId of outcome.evidence_refs ?? []) {
    if (selected.has(evidenceId)) continue;
    const entry = evidence.get(evidenceId);
    selections.push({ evidenceId, ...(typeof entry?.sha256 === "string" ? { sha256: entry.sha256.toLowerCase() } : {}) });
  }
  const identity = definitionIdentity(run.definition);
  const record: GateEvaluationRecord = {
    version: "1",
    ref,
    evaluatedAt,
    trigger,
    ...(previous ? { previousRef: previous.ref } : {}),
    definition: identity,
    gate: { id: gate.id, digest: gateEvaluationDigest(gate, run.config) },
    originalVerdict: outcome.status as GateEvaluationRecord["originalVerdict"],
    selections,
    ...(typeof outcome.accepted_exception_id === "string" ? { exceptionId: outcome.accepted_exception_id } : {}),
    ...((outcome.status === "route-back" || outcome.limit_exceeded) ? { routeBack: {
      ...(typeof outcome.attempt === "number" ? { attempt: outcome.attempt } : {}),
      ...(typeof outcome.max_attempts === "number" ? { maxAttempts: outcome.max_attempts } : {}),
      ...(typeof outcome.retry_epoch === "number" ? { retryEpoch: outcome.retry_epoch } : {}),
      ...(typeof outcome.route_reason === "string" ? { reason: outcome.route_reason } : {}),
      ...(typeof outcome.selected_route === "string" ? { selectedRoute: outcome.selected_route } : {})
    } } : {})
  };
  outcome.evaluation_ref = ref;
  run.state.gate_evaluation_ledger = { version: "1", records: [...ledger.records, record] };
  return record;
}

/**
 * Pure, complete validation of canonical Flow run state against its immutable
 * start definition. This performs the same schema, lifecycle, amendment-ledger,
 * effective-identity, and retry/route-history checks used by loadRun without
 * reading, repairing, or writing any run artifact.
 */
export function validateRunStateConsistency(
  startDefinitionValue: unknown,
  stateValue: unknown,
  options: { runId?: string } = {}
) {
  const startDefinition = validateDefinition(startDefinitionValue);
  assertGateEvaluationLedgerVersionSupported(stateValue);
  validateRunStateSchema(stateValue);
  const state = normalizeRunStateLifecycle(stateValue);
  const definition = resolveEffectiveDefinition(startDefinition, state);
  validateRunStateIdentity(definition, state, options.runId ?? state.run_id);
  validateRetryAuthorizationHistory(definition, state);
  validateMultiCursorState(definition, state);
  validateGateEvaluationLedger(definition, state, undefined, [startDefinition, ...(state.definition_amendments ?? []).map((event: any) => event.successor)]);
  return { startDefinition, definition, state };
}

export function validateEvidenceManifestIdentity(manifest, definition, state) {
  validateEvidenceManifestSchema(manifest);
  if (!isObject(manifest)) throw new Error("evidence manifest must be an object");
  if (manifest.schema_version !== FLOW_SCHEMA_VERSION) {
    throw new Error(`evidence manifest schema_version must be ${FLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(manifest.evidence)) throw new Error("evidence manifest evidence must be an array");
  const allowedKinds = new Set([
    "command", "file", "ci", "trust.bundle", "veritas-readiness",
    "human-attestation", "trace-link", "custom"
  ]);
  const allowedStatuses = new Set(["passed", "failed", "unknown"]);
  for (const [index, entry] of manifest.evidence.entries()) {
    if (!isObject(entry)) throw new Error(`evidence manifest evidence[${index}] must be an object`);
    for (const field of ["id", "gate_id", "kind", "requested_kind", "status", "attached_at"]) {
      if (!isNonEmptyString(entry[field])) {
        throw new Error(`evidence manifest evidence[${index}].${field} must be a non-empty string`);
      }
    }
    if (!allowedKinds.has(entry.kind)) throw new Error(`evidence manifest evidence[${index}].kind is invalid`);
    if (!allowedStatuses.has(entry.status)) throw new Error(`evidence manifest evidence[${index}].status is invalid`);
  }
  const checks = [
    ["run_id", state.run_id],
    ["definition_id", definition.id],
    // Evidence remains bound to the immutable start snapshot. An amendment
    // changes only state.json and never rebinds copied evidence.
    ["definition_version", definition.version]
  ];
  for (const [field, expected] of checks) {
    if (manifest[field] === undefined) {
      throw new Error(`evidence manifest ${field} is required for run ${state.run_id}`);
    }
    if (manifest[field] !== expected) {
      throw new Error(`evidence manifest ${field} mismatch: expected ${expected}, got ${manifest[field]}`);
    }
  }
  return manifest;
}

export async function startRun(definitionPath: string, options: MutableRecord = {}) {
  const cwd = options.cwd ?? process.cwd();
  const rawDefinition = await readJson(path.resolve(cwd, definitionPath));
  const definition = validateDefinition(rawDefinition);
  const runId = options.runId ?? `run.${Date.now()}`;
  const dir = await allocateNewRunLocation(runId, cwd);
  const state = initialState(definition, runId, options.params ?? {}) as FlowRunState;
  const manifest = initialEvidenceManifest(definition, state);
  await ensureDirectoryPathWithoutSymlinks(
    cwd,
    path.relative(path.resolve(cwd), path.join(dir, FLOW_RUN_EVIDENCE_DIR))
  );
  const faultInjection = options.faultInjection;
  if (faultInjection !== undefined && typeof faultInjection !== "function") {
    throw new Error("flow.start_run.options.invalid: faultInjection must be a function");
  }
  faultInjection?.("before_definition");
  await writeJson(path.join(dir, FLOW_RUN_DEFINITION_FILE), definition);
  faultInjection?.("before_state");
  await writeJson(path.join(dir, FLOW_RUN_STATE_FILE), state);
  faultInjection?.("before_manifest");
  await writeJson(path.join(dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH), manifest);
  faultInjection?.("before_reports");
  await renderAndWriteReport(definition, state, manifest, dir);
  return { runId, dir, state };
}

async function readRunAtLocation(runId: string, location: RunLocation, cwd: string) {
  const { dir } = location;
  const rawDefinition = await readJson(path.join(dir, FLOW_RUN_DEFINITION_FILE));
  const parsedState = await readJson(path.join(dir, FLOW_RUN_STATE_FILE));
  const { startDefinition, definition, state } = validateRunStateConsistency(rawDefinition, parsedState, { runId });
  const config = await loadFlowConfig(cwd);
  const manifestPath = path.join(dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const manifest = existsSync(manifestPath)
    ? validateEvidenceManifestIdentity(await readJson(manifestPath), startDefinition, state)
    : initialEvidenceManifest(startDefinition, state);
  const run = { dir, definition, startDefinition, state, manifest, config, diagnostics: location.diagnostics };
  validateGateEvaluationLedger(definition, state, manifest, [startDefinition, ...(state.definition_amendments ?? []).map((event: any) => event.successor)]);
  resolvedRunContexts.set(run, { cwd: path.resolve(cwd) });
  return run;
}

/** Repair disposable reports from an already validated canonical run. */
export async function repairRunReports(run: any) {
  const context = resolvedRunContexts.get(run) ?? inferResolvedRunContext(run.state.run_id, run.dir);
  return withRunMutationLock(run.state.run_id, context.cwd, async () => {
    // The caller's snapshot may be stale. Reload inside the same mutation
    // ticket used by state writers so repair can never publish an older
    // projection after a newer canonical commit.
    const current = await loadRunAtResolvedLocation(run.state.run_id, run.dir, context.cwd);
    await writeRunReportsIfChanged(current);
    return current;
  });
}

async function writeRunReportsIfChanged(run: any) {
  const targets = [
    {
      path: await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson),
      contents: `${JSON.stringify(reportJson(run.definition, run.state, run.manifest), null, 2)}\n`
    },
    {
      path: await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown),
      contents: renderMarkdownReport(run.definition, run.state, run.manifest)
    }
  ];
  const stale: Array<{ path: string; contents: string }> = [];
  for (const target of targets) {
    try {
      if (await readExistingFileNoFollow(target.path) === target.contents) continue;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    stale.push(target);
  }
  if (stale.length) await publishRunArtifacts(run.dir, stale);
}

async function readExistingFileNoFollow(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const target = await handle.stat();
    if (!target.isFile()) throw new Error(`flow.run_location.invalid_artifact_path: ${file} is not a regular file`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function inferResolvedRunContext(runId: string, dir: string) {
  const absolute = path.resolve(dir);
  if (path.basename(absolute) !== runId || path.basename(path.dirname(absolute)) !== "runs") {
    throw runLocationError("flow.run_location.resolved_dir_invalid", `directory ${dir} does not identify run "${runId}"`);
  }
  const owner = path.dirname(path.dirname(absolute));
  if (path.basename(owner) === "flow" && path.basename(path.dirname(owner)) === ".kontourai") {
    return { cwd: path.dirname(path.dirname(owner)) };
  }
  throw runLocationError("flow.run_location.resolved_dir_invalid", `directory ${dir} is not a canonical Flow run location`);
}

async function validateResolvedRunDirectoryUnchecked(runId: string, dir: string, cwd?: string) {
  const inferred = inferResolvedRunContext(runId, dir);
  const context = cwd ? { cwd: path.resolve(cwd) } : inferred;
  const expected = runDir(runId, context.cwd);
  if (path.resolve(dir) !== path.resolve(expected)) {
    throw runLocationError("flow.run_location.resolved_dir_invalid", `directory ${dir} is outside working directory ${context.cwd}`);
  }
  const candidate = await inspectRunCandidate(runId, context.cwd);
  if (candidate.status !== "complete") {
    throw runLocationError(
      "flow.run_location.resolved_dir_invalid",
      `resolved canonical directory ${dir} is ${candidate.status} (${candidate.reason})`
    );
  }
  return { runId, dir: path.resolve(dir), diagnostics: [] } satisfies RunLocation;
}

export async function validateResolvedRunDirectory(runId: string, dir: string, cwd?: string) {
  const context = path.resolve(cwd ?? inferResolvedRunContext(runId, dir).cwd);
  return withRunRecoveryFenceRead(
    runId,
    context,
    () => validateResolvedRunDirectoryUnchecked(runId, dir, context)
  );
}

export async function loadRunAtResolvedLocation(runId: string, dir: string, cwd = process.cwd()) {
  const context = path.resolve(cwd);
  return withRunRecoveryFenceRead(runId, context, async () => {
    const location = await validateResolvedRunDirectoryUnchecked(runId, dir, context);
    return readRunAtLocation(runId, location, context);
  });
}

export async function loadRun(runId, cwd = process.cwd()) {
  const context = path.resolve(cwd);
  return withRunRecoveryFenceRead(runId, context, async () => {
    const location = await resolveRunLocation(runId, context);
    return readRunAtLocation(runId, location, context);
  });
}

async function saveRun(run) {
  const context = resolvedRunContexts.get(run) ?? inferResolvedRunContext(run.state.run_id, run.dir);
  await validateResolvedRunDirectory(run.state.run_id, run.dir, context.cwd);
  assertGateEvaluationLedgerVersionSupported(run.state);
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateRetryAuthorizationHistory(run.definition, run.state);
  validateMultiCursorState(run.definition, run.state);
  validateEvidenceManifestIdentity(run.manifest, run.startDefinition ?? run.definition, run.state);
  validateGateEvaluationLedger(run.definition, run.state, run.manifest, [run.startDefinition ?? run.definition, ...(run.state.definition_amendments ?? []).map((event: any) => event.successor)]);
  const [statePath, manifestPath, reportJsonPath, reportMarkdownPath] = await Promise.all([
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_STATE_FILE),
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH),
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson),
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown)
  ]);
  // Commit order is load-bearing: derived projections, then the evidence
  // manifest, then state.json last. `state.json` is the canonical record and
  // may reference evidence, so it must never become visible ahead of the
  // manifest that carries it.
  await publishRunArtifacts(run.dir, [
    { path: reportJsonPath, contents: serializeJson(reportJson(run.definition, run.state, run.manifest)) },
    { path: reportMarkdownPath, contents: renderMarkdownReport(run.definition, run.state, run.manifest) },
    { path: manifestPath, contents: serializeJson(run.manifest) },
    { path: statePath, contents: serializeJson(run.state) }
  ], _publishRunArtifactsFaultHooks);
}

/** Canonical on-disk JSON encoding for run artifacts. */
function serializeJson(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function saveLifecycleState(run) {
  assertGateEvaluationLedgerVersionSupported(run.state);
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateMultiCursorState(run.definition, run.state);
  validateEvidenceManifestIdentity(run.manifest, run.startDefinition ?? run.definition, run.state);
  validateGateEvaluationLedger(run.definition, run.state, run.manifest, [run.startDefinition ?? run.definition, ...(run.state.definition_amendments ?? []).map((event: any) => event.successor)]);
  const statePath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_STATE_FILE);
  const reportJsonPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson);
  const reportMarkdownPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown);
  await publishRunArtifacts(run.dir, [
    { path: reportJsonPath, contents: serializeJson(reportJson(run.definition, run.state, run.manifest)) },
    { path: reportMarkdownPath, contents: renderMarkdownReport(run.definition, run.state, run.manifest) },
    { path: statePath, contents: serializeJson(run.state) }
  ], _publishRunArtifactsFaultHooks);
}

function lifecycleTimestamp(options: MutableRecord, operation: FlowLifecycleAction) {
  const timestamp = options.at ?? new Date().toISOString();
  if (!isNonEmptyString(timestamp) || parseRfc3339Timestamp(timestamp) === null) {
    throw new FlowLifecycleError({
      code: "flow.lifecycle.request.invalid",
      severity: "error",
      path: "$.at",
      message: "at must be an RFC3339 date-time when provided",
      operation
    });
  }
  return timestamp;
}

async function changeRunLifecycle(runId: string, operation: FlowLifecycleAction, options: MutableRecord = {}) {
  const request = validateLifecycleRequest(operation, { reason: options.reason, authority: options.authority });
  const at = lifecycleTimestamp(options, operation);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, async () => {
  const run = await loadRun(runId, cwd);
  const existingCancellation = [...(run.state.lifecycle ?? [])].reverse().find((event) => event.action === "cancel");
  if (operation === "cancel" && run.state.status === "canceled" && existingCancellation) {
    if (lifecycleRequestMatches(existingCancellation, request)) {
      return { ...run, event: existingCancellation, idempotent: true };
    }
    throw new FlowLifecycleError({
      code: "flow.lifecycle.replay.conflict",
      severity: "error",
      path: "$.authority.request_ref",
      message: "cancellation conflicts with the terminal cancellation already recorded",
      operation,
      current_status: run.state.status
    });
  }
  assertLifecycleEligible(operation, run.state.status);

  const fromStatus = run.state.status;
  const priorStatus = priorResumableStatus(run.state as FlowRunState);
  const toStatus = operation === "pause" ? "paused" : operation === "resume" ? priorStatus : "canceled";
  const event: FlowLifecycleEvent = {
    action: operation,
    from_status: fromStatus,
    to_status: toStatus,
    prior_status: priorStatus,
    reason: request.reason,
    authority: request.authority,
    at
  };
  // A paused or canceled run must never retain a live execution lease.  The
  // host may resume and claim anew, but cannot continue on an old authority.
  if ((operation === "pause" || operation === "cancel") && run.state.multi_cursor) {
    const cursor = ensureMultiCursorState(run.state);
    const released = cursor.active_claims.splice(0);
    cursor.claim_history.push(...released.map((claim) => ({
      action: "released" as const,
      claim_id: claim.claim_id,
      step_id: claim.step_id,
      at,
      reason: `run ${operation}`
    })));
  }
  run.state = {
    ...run.state,
    status: toStatus,
    lifecycle: [...(run.state.lifecycle ?? []), event],
    updated_at: at
  };
  await saveLifecycleState(run);
  return { ...run, event, idempotent: false };
  });
}

export function pauseRun(runId: string, options: MutableRecord = {}) {
  return changeRunLifecycle(runId, "pause", options);
}

export function resumeRun(runId: string, options: MutableRecord = {}) {
  return changeRunLifecycle(runId, "resume", options);
}

export function cancelRun(runId: string, options: MutableRecord = {}) {
  return changeRunLifecycle(runId, "cancel", options);
}

function multiCursorNow(options: MutableRecord = {}) {
  if (options.now !== undefined && (typeof options.now !== "string" || parseRfc3339Timestamp(options.now) === null)) {
    throw new FlowMultiCursorError("flow.multi_cursor.time.invalid", "now must be an RFC3339 date-time");
  }
  const value = options.now === undefined ? new Date() : new Date(options.now);
  if (!Number.isFinite(value.getTime())) throw new FlowMultiCursorError("flow.multi_cursor.time.invalid", "now must be an RFC3339 date-time");
  return value;
}

/**
 * Multi-cursor leases use Date arithmetic, but gate authority and durable audit
 * records need the caller's full RFC3339 precision. Never reconstruct the
 * latter from Date: JavaScript truncates fractions beyond milliseconds.
 */
function multiCursorEvaluationTime(options: MutableRecord = {}) {
  const exact = options.now === undefined ? new Date().toISOString() : options.now;
  if (typeof exact !== "string" || parseRfc3339Timestamp(exact) === null) {
    throw new FlowMultiCursorError("flow.multi_cursor.time.invalid", "now must be an RFC3339 date-time");
  }
  const surfaceNow = new Date(exact);
  if (!Number.isFinite(surfaceNow.getTime())) {
    throw new FlowMultiCursorError("flow.multi_cursor.time.invalid", "now must be an RFC3339 date-time");
  }
  return { exact, surfaceNow };
}

function multiCursorActor(value: unknown): FlowStepClaimActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FlowMultiCursorError("flow.multi_cursor.claim.actor.invalid", "actor must be an object");
  const actor = value as Record<string, unknown>;
  if (typeof actor.key !== "string") throw new FlowMultiCursorError("flow.multi_cursor.claim.actor.invalid", "actor.key is required");
  return { key: actor.key, ...(typeof actor.kind === "string" ? { kind: actor.kind } : {}) };
}

function recordClaimEvent(state: any, event: { action: "claimed" | "renewed" | "released" | "expired" | "settled"; claim_id: string; step_id: string; at: string; reason?: string }) {
  ensureMultiCursorState(state).claim_history.push(event);
}

function expireMultiCursorClaims(run: any, now: Date) {
  const cursor = ensureMultiCursorState(run.state);
  const expired = cursor.active_claims.filter((claim) => Date.parse(claim.expires_at) <= now.getTime());
  if (!expired.length) return expired;
  cursor.active_claims = cursor.active_claims.filter((claim) => Date.parse(claim.expires_at) > now.getTime());
  cursor.claim_history.push(...expired.map((claim) => ({ action: "expired" as const, claim_id: claim.claim_id, step_id: claim.step_id, at: now.toISOString(), reason: "liveness lease expired" })));
  return expired;
}

/** Remove only semantically superseded leases; malformed persisted claims fail closed. */
function invalidateStaleMultiCursorClaims(run: any, now: Date) {
  const cursor = ensureMultiCursorState(run.state);
  const invalidated: any[] = [];
  const retained: any[] = [];
  for (const claim of cursor.active_claims) {
    try {
      validateDurableStepClaim(run.definition, run.state, claim, now);
      retained.push(claim);
    } catch (error) {
      if (error instanceof FlowMultiCursorError && error.code === "flow.multi_cursor.claim.stale") {
        invalidated.push(claim);
        continue;
      }
      throw error;
    }
  }
  if (invalidated.length) {
    cursor.active_claims = retained;
    cursor.claim_history.push(...invalidated.map((claim) => ({ action: "invalidated" as const, claim_id: claim.claim_id, step_id: claim.step_id, at: now.toISOString(), reason: "claim base no longer current" })));
  }
  return invalidated;
}

function multiCursorTerminal(definition: any, state: any) {
  return definition.steps.every((step: any) => {
    const gates = Object.entries(definition.gates ?? {}).filter(([, gate]: [string, any]) => gate.step === step.id).map(([gateId]) => gateId);
    return gates.length
      ? gates.every((gateId) => state.gate_outcomes.some((outcome: any) => outcome.gate_id === gateId && outcome.status === "pass"))
      : state.transitions.some((transition: any) => transition.from_step === step.id && transition.status === "allowed");
  });
}

function projectMultiCursorCurrentStep(definition: any, state: any) {
  const cursor = ensureMultiCursorState(state);
  const ready = claimableMultiCursorSteps(definition, state);
  const active = cursor.active_claims.map((claim) => claim.step_id).sort();
  return ready[0] ?? active[0] ?? state.current_step;
}

/** Atomically claim exactly one Flow-ready multi-cursor step. Hosts schedule work separately. */
export async function claimReadyStep(runId: string, options: FlowDurableStepClaimRequest & MutableRecord) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, async () => {
    const run = await loadRun(runId, cwd);
    assertLifecycleEligible("persist", run.state.status);
    const now = multiCursorNow(options);
    const expired = expireMultiCursorClaims(run, now);
    const invalidated = invalidateStaleMultiCursorClaims(run, now);
    // An accepted exception authorizes the next gate evaluation, not a
    // permanent terminal lifecycle. Claim admission begins an active
    // multi-cursor epoch before deriving its claim base.
    if (run.state.status === "accepted_by_exception") run.state.status = "active";
    const cursor = ensureMultiCursorState(run.state);
    const existing = cursor.active_claims.find((claim) => claim.claim_id === options.claim_id);
    if (existing) {
      const candidate = validateDurableStepClaim(run.definition, run.state, existing, now);
      const requestedActor = multiCursorActor(options.actor);
      if (existing.step_id === options.step_id && existing.liveness_id === options.liveness_id && sameClaimActor(existing, requestedActor)) {
        if (expired.length || invalidated.length) {
          run.state.current_step = projectMultiCursorCurrentStep(run.definition, run.state);
          run.state.updated_at = now.toISOString();
          await saveRun(run);
        }
        return { ...run, claim: candidate, idempotent: true };
      }
      throw new FlowMultiCursorError("flow.multi_cursor.claim.conflict", `claim_id ${options.claim_id} is already in use`);
    }
    if (cursor.claim_history.some((event) => event.claim_id === options.claim_id)) {
      throw new FlowMultiCursorError("flow.multi_cursor.claim.replay", `claim_id ${options.claim_id} was already consumed by this run`);
    }
    const claim = buildDurableStepClaim(run.definition, run.state, options, now);
    const sameStep = cursor.active_claims.find((entry) => entry.step_id === claim.step_id);
    if (sameStep) throw new FlowMultiCursorError("flow.multi_cursor.claim.conflict", `step ${claim.step_id} is already claimed`);
    const conflict = cursor.active_claims.find((entry) => entry.mutable_resources.some((resource) => claim.mutable_resources.includes(resource)));
    if (conflict) throw new FlowMultiCursorError("flow.multi_cursor.claim.resource_conflict", `claim conflicts with ${conflict.claim_id}`);
    cursor.active_claims.push(claim);
    cursor.active_claims.sort((left, right) => left.claim_id.localeCompare(right.claim_id));
    recordClaimEvent(run.state, { action: "claimed", claim_id: claim.claim_id, step_id: claim.step_id, at: now.toISOString() });
    run.state.current_step = projectMultiCursorCurrentStep(run.definition, run.state);
    run.state.updated_at = now.toISOString();
    await saveRun(run);
    return { ...run, claim, idempotent: false };
  });
}

/** Renew a lease without changing its semantic claim base or sibling validity. */
export async function renewStepClaim(runId: string, options: { claim_id: string; liveness_id: string; actor: FlowStepClaimActor; lease_seconds?: number; cwd?: string; now?: string }) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, async () => {
    const run = await loadRun(runId, cwd);
    assertLifecycleEligible("persist", run.state.status);
    const now = multiCursorNow(options);
    expireMultiCursorClaims(run, now);
    invalidateStaleMultiCursorClaims(run, now);
    const cursor = ensureMultiCursorState(run.state);
    const claim = cursor.active_claims.find((entry) => entry.claim_id === options.claim_id);
    if (!claim) throw new FlowMultiCursorError("flow.multi_cursor.claim.missing", `active claim ${options.claim_id} does not exist`);
    if (now.getTime() < Date.parse(claim.renewed_at)) {
      throw new FlowMultiCursorError("flow.multi_cursor.claim.time.regression", "renewal time must not precede the persisted renewed_at boundary");
    }
    const checked = validateDurableStepClaim(run.definition, run.state, claim, now);
    if (checked.liveness_id !== options.liveness_id || !sameClaimActor(checked, multiCursorActor(options.actor))) throw new FlowMultiCursorError("flow.multi_cursor.claim.owner_mismatch", "only the exact claim actor and liveness identity may renew a claim");
    const seconds = options.lease_seconds ?? FLOW_DURABLE_CLAIM_DEFAULT_LEASE_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new FlowMultiCursorError("flow.multi_cursor.claim.lease.invalid", "lease_seconds must be an integer between 1 and 3600");
    claim.renewed_at = now.toISOString();
    claim.expires_at = new Date(now.getTime() + seconds * 1000).toISOString();
    recordClaimEvent(run.state, { action: "renewed", claim_id: claim.claim_id, step_id: claim.step_id, at: now.toISOString() });
    run.state.updated_at = now.toISOString();
    await saveRun(run);
    return { ...run, claim: structuredClone(claim) };
  });
}

/** Release an un-settled claim. The step remains ready for a future actor. */
export async function releaseStepClaim(runId: string, options: { claim_id: string; liveness_id: string; actor: FlowStepClaimActor; reason?: string; cwd?: string; now?: string }) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, async () => {
    const run = await loadRun(runId, cwd);
    const now = multiCursorNow(options);
    expireMultiCursorClaims(run, now);
    invalidateStaleMultiCursorClaims(run, now);
    const cursor = ensureMultiCursorState(run.state);
    const index = cursor.active_claims.findIndex((entry) => entry.claim_id === options.claim_id);
    if (index < 0) throw new FlowMultiCursorError("flow.multi_cursor.claim.missing", `active claim ${options.claim_id} does not exist`);
    const claim = validateDurableStepClaim(run.definition, run.state, cursor.active_claims[index], now);
    if (claim.liveness_id !== options.liveness_id || !sameClaimActor(claim, multiCursorActor(options.actor))) throw new FlowMultiCursorError("flow.multi_cursor.claim.owner_mismatch", "only the exact claim actor and liveness identity may release a claim");
    cursor.active_claims.splice(index, 1);
    recordClaimEvent(run.state, { action: "released", claim_id: claim.claim_id, step_id: claim.step_id, at: now.toISOString(), ...(options.reason ? { reason: options.reason } : {}) });
    run.state.current_step = projectMultiCursorCurrentStep(run.definition, run.state);
    run.state.updated_at = now.toISOString();
    await saveRun(run);
    return { ...run, claim };
  });
}

/** Recovery is host-neutral: expire abandoned leases and expose their ids for scheduling reconciliation. */
export async function recoverExpiredStepClaims(runId: string, options: { cwd?: string; now?: string } = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, async () => {
    const run = await loadRun(runId, cwd);
    const now = multiCursorNow(options);
    const expired = expireMultiCursorClaims(run, now);
    const invalidated = invalidateStaleMultiCursorClaims(run, now);
    if (expired.length || invalidated.length) {
      run.state.current_step = projectMultiCursorCurrentStep(run.definition, run.state);
      run.state.updated_at = now.toISOString();
      await saveRun(run);
    }
    return { ...run, expired: structuredClone(expired), invalidated: structuredClone(invalidated) };
  });
}

/** Clear a per-step block after its evidence has been replaced or amended. */
export async function reopenMultiCursorStep(runId: string, options: { step_id: string; cwd?: string; now?: string }) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, async () => {
    const run = await loadRun(runId, cwd);
    const now = multiCursorNow(options);
    const cursor = ensureMultiCursorState(run.state);
    const blocked = cursor.blocked_steps.find((entry) => entry.step_id === options.step_id);
    if (!blocked) throw new FlowMultiCursorError("flow.multi_cursor.block.missing", `step ${options.step_id} is not blocked`);
    cursor.blocked_steps = cursor.blocked_steps.filter((entry) => entry.step_id !== options.step_id);
    if (!claimableMultiCursorSteps(run.definition, run.state).includes(options.step_id)) {
      throw new FlowMultiCursorError("flow.multi_cursor.block.not_ready", `blocked step ${options.step_id} is not in the canonical ready frontier`);
    }
    if (run.state.status === "blocked") run.state.status = "active";
    run.state.current_step = projectMultiCursorCurrentStep(run.definition, run.state);
    run.state.updated_at = now.toISOString();
    await saveRun(run);
    return run;
  });
}

/**
 * Evaluate all gates for one active claimed step and atomically settle its
 * result. A sibling settlement changes only the sibling's base domain; a
 * route-back explicitly invalidates every affected active descendant lease.
 */
export async function evaluateClaimedStep(runId: string, options: { claim_id: string; liveness_id: string; actor: FlowStepClaimActor; cwd?: string; now?: string }) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, async () => {
    const run = await loadRun(runId, cwd);
    assertLifecycleEligible("evaluate", run.state.status);
    const evaluationTime = multiCursorEvaluationTime(options);
    const now = evaluationTime.surfaceNow;
    expireMultiCursorClaims(run, now);
    invalidateStaleMultiCursorClaims(run, now);
    const cursor = ensureMultiCursorState(run.state);
    const index = cursor.active_claims.findIndex((entry) => entry.claim_id === options.claim_id);
    if (index < 0) throw new FlowMultiCursorError("flow.multi_cursor.claim.missing", `active claim ${options.claim_id} does not exist`);
    const claim = validateDurableStepClaim(run.definition, run.state, cursor.active_claims[index], now);
    if (claim.liveness_id !== options.liveness_id || !sameClaimActor(claim, multiCursorActor(options.actor))) throw new FlowMultiCursorError("flow.multi_cursor.claim.owner_mismatch", "only the exact claim actor and liveness identity may settle a claim");
    const gates = Object.entries(run.definition.gates ?? {}).filter(([, gate]: [string, any]) => gate.step === claim.step_id).map(([gateId]) => gateId).sort();
    if (!gates.length) throw new FlowMultiCursorError("flow.multi_cursor.gate.required", `claimed step ${claim.step_id} has no gate to evaluate`);
    const integrityById = await evidenceIntegrityStatusById(run.manifest, run.dir);
    const evaluationManifest = manifestWithIntegrity(run.manifest, integrityById);
    const outcomes: GateOutcome[] = [];
    for (const gateId of gates) {
      const outcome = evaluateGate(run.definition, run.state, evaluationManifest, gateId, run.config, evaluationTime.exact);
      outcomes.push(outcome);
      if (outcome.status !== "pass") break;
    }
    const terminal = outcomes.at(-1)!;
    if (terminal.status === "wait") return { ...run, claim, outcomes, settled: false };
    // A waiting claim returns above without a state publication, so it must
    // never mint a reference. Every settled appraisal is minted immediately
    // before the same state publication that commits its outcome.
    for (const outcome of outcomes) {
      mintGateEvaluation(run, outcome, evaluationTime.exact, "claimed");
      mergeGateOutcome(run.state, outcome);
    }
    cursor.active_claims.splice(index, 1);
    if (terminal.status === "pass" && outcomes.length === gates.length) {
      const next = getStep(run.definition, claim.step_id)?.next ?? null;
      run.state.transitions.push({ from_step: claim.step_id, to_step: next, status: "allowed", reason: "required evidence present", at: evaluationTime.exact, gate_id: terminal.gate_id, claim_id: claim.claim_id });
      cursor.blocked_steps = cursor.blocked_steps.filter((entry) => entry.step_id !== claim.step_id);
      recordClaimEvent(run.state, { action: "settled", claim_id: claim.claim_id, step_id: claim.step_id, at: evaluationTime.exact });
    } else if (terminal.status === "route-back") {
      const target = terminal.route_back_to;
      const invalidatedDescendants = invalidateDescendants(run.definition, run.state, target);
      const invalidated = new Set<string>([target, ...invalidatedDescendants]);
      releaseClaimsForSteps(run.state, invalidated, now.toISOString(), `route-back from ${claim.step_id}`);
      cursor.blocked_steps = cursor.blocked_steps.filter((entry) => !invalidated.has(entry.step_id));
      // Keep the reserved route-back record byte-for-byte derivable from the
      // preceding transition history. Claim correlation stays in the separate
      // claim history ledger, not in this proof-carrying transition shape.
      run.state.transitions.push({ type: "route_back", from_step: claim.step_id, to_step: target, status: "blocked", reason: terminal.reason ?? terminal.route_reason ?? terminal.summary, route_reason: terminal.route_reason, selected_route: terminal.selected_route, recovery_step: terminal.recovery_step, attempt: terminal.attempt, retry_epoch: terminal.retry_epoch, max_attempts: terminal.max_attempts, limit_exceeded: terminal.limit_exceeded, invalidated_steps: invalidatedDescendants.length ? invalidatedDescendants : undefined, evidence_refs: terminal.evidence_refs, failed_evidence_refs: terminal.failed_evidence_refs, expectation_ids: terminal.expectation_ids, classifier: terminal.classifier, diagnostics: terminal.diagnostics, analytics: terminal.analytics, analytics_loop_key: terminal.analytics_loop_key, at: evaluationTime.exact, gate_id: terminal.gate_id });
      recordClaimEvent(run.state, { action: "settled", claim_id: claim.claim_id, step_id: claim.step_id, at: evaluationTime.exact, reason: "route-back" });
      run.state.current_step = target;
    } else {
      cursor.blocked_steps = [...cursor.blocked_steps.filter((entry) => entry.step_id !== claim.step_id), { step_id: claim.step_id, gate_id: terminal.gate_id, at: evaluationTime.exact, summary: terminal.summary }];
      run.state.transitions.push({ from_step: claim.step_id, to_step: getStep(run.definition, claim.step_id)?.next ?? null, status: "blocked", reason: terminal.summary, evidence_refs: terminal.evidence_refs, at: evaluationTime.exact, gate_id: terminal.gate_id, claim_id: claim.claim_id });
      recordClaimEvent(run.state, { action: "settled", claim_id: claim.claim_id, step_id: claim.step_id, at: evaluationTime.exact, reason: "blocked" });
    }
    if (multiCursorTerminal(run.definition, run.state)) run.state.status = "completed";
    else if (cursor.active_claims.length || claimableMultiCursorSteps(run.definition, run.state).length) run.state.status = "active";
    else if (cursor.blocked_steps.length) run.state.status = "blocked";
    run.state.current_step = projectMultiCursorCurrentStep(run.definition, run.state);
    run.state.updated_at = evaluationTime.exact;
    await saveRun(run);
    return { ...run, outcomes, settled: true };
  });
}

export type RunMutationLockHooks = {
  afterReleaseQuarantine?: (releasedPath: string) => Promise<void> | void;
};

export type FlowRunRecoveryFenceFinalizeHooks = {
  beforeOpen?: () => Promise<void> | void;
};

type MutationLockOwner = {
  token: string;
  pid: number;
  host: string;
  status: "active" | "holding" | "released";
  created_at: string;
  released_at?: string;
};

const MUTATION_LOCK_MARKER = "ticket-lock-v1";
const MUTATION_LOCK_ROOT_PROTOCOL = "flow.run-mutation.ticket-root.v1";
const MUTATION_LOCK_ROOT_TOKEN = "ticket-runtime-root-v1";
const MUTATION_LOCK_ROOT_HOST = "flow-ticket-runtime.invalid";
const MUTATION_LOCK_ROOT_CREATED_AT = "1970-01-01T00:00:00.000Z";
const MUTATION_TICKET_NAME = /^ticket-[0-9]{13}-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

async function readMutationLockOwner(file: string): Promise<MutationLockOwner> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error(`flow.run_location.invalid_artifact_path: ${file}`);
    const owner = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    if (!isNonEmptyString(owner?.token) || !Number.isInteger(owner?.pid) || !isNonEmptyString(owner?.host)) {
      throw new Error(`flow.run_mutation.lock.owner.invalid: ${file}`);
    }
    return owner;
  } finally {
    await handle.close();
  }
}

function mutationLockOwnerIsStale(owner: MutationLockOwner) {
  if (owner.status === "released") return true;
  if (owner.host === hostname() && owner.pid === process.pid) return !activeMutationLockTokens.has(owner.token);
  if (owner.host === hostname()) {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }
  return false;
}

async function publishMutationLockOwner(ticketPath: string, owner: MutationLockOwner) {
  const ownerPath = path.join(ticketPath, "owner.json");
  const tempPath = path.join(ticketPath, `.owner-${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
    await rename(tempPath, ownerPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function mutationLockRootOwner() {
  // This remains a valid owner record to pre-ticket runtimes. Its reserved
  // foreign host means their stale-owner logic cannot reclaim the root.
  return {
    token: MUTATION_LOCK_ROOT_TOKEN,
    pid: 1,
    host: MUTATION_LOCK_ROOT_HOST,
    status: "active",
    created_at: MUTATION_LOCK_ROOT_CREATED_AT,
    protocol: MUTATION_LOCK_ROOT_PROTOCOL
  } satisfies MutationLockOwner & { protocol: string };
}

function isMutationLockRootOwner(owner: any) {
  return owner?.token === MUTATION_LOCK_ROOT_TOKEN
    && owner?.pid === 1
    && owner?.host === MUTATION_LOCK_ROOT_HOST
    && owner?.status === "active"
    && owner?.created_at === MUTATION_LOCK_ROOT_CREATED_AT
    && owner?.protocol === MUTATION_LOCK_ROOT_PROTOCOL;
}

function mutationLockMigrationRequired(lockRoot: string) {
  return runLocationError(
    "flow.run_mutation.lock.migration_required",
    `unmarked legacy mutation lock at ${lockRoot} requires explicit quiescence-only operator cleanup before retry authorization`
  );
}

function mutationLockRootInvalid(lockRoot: string, detail: string) {
  return runLocationError("flow.run_mutation.lock.root_invalid", `ticket mutation lock root ${lockRoot} is invalid: ${detail}`);
}

async function readMutationLockMarker(markerPath: string) {
  const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw mutationLockRootInvalid(path.dirname(markerPath), "marker is not a regular file");
    const marker = await handle.readFile({ encoding: "utf8" });
    if (marker.trim() !== MUTATION_LOCK_MARKER) throw mutationLockRootInvalid(path.dirname(markerPath), "marker content does not identify the ticket runtime");
  } finally {
    await handle.close();
  }
}

async function publishMutationLockMarker(markerPath: string) {
  const tempPath = `${markerPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${MUTATION_LOCK_MARKER}\n`, { flag: "wx", mode: 0o600 });
    // link(2) gives us an exclusive, atomic publication of the final marker.
    await link(tempPath, markerPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function rootEntryExists(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function validateMutationLockRoot(lockRoot: string) {
  const root = await lstat(lockRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw mutationLockRootInvalid(lockRoot, "root is not a real directory");
  const markerPath = path.join(lockRoot, MUTATION_LOCK_MARKER);
  const ownerPath = path.join(lockRoot, "owner.json");
  const [marker, ownerFile] = await Promise.all([rootEntryExists(markerPath), rootEntryExists(ownerPath)]);
  if (!marker || !ownerFile) throw mutationLockRootInvalid(lockRoot, "root must retain both marker and owner sentinel");
  if (marker.isSymbolicLink() || ownerFile.isSymbolicLink()) throw mutationLockRootInvalid(lockRoot, "marker and owner sentinel must not be symbolic links");
  try {
    await readMutationLockMarker(markerPath);
    const owner = await readMutationLockOwner(ownerPath);
    if (!isMutationLockRootOwner(owner)) throw mutationLockRootInvalid(lockRoot, "owner.json is not the reserved ticket-root sentinel");
  } catch (error) {
    if ((error as Error & { code?: string }).code === "flow.run_mutation.lock.root_invalid") throw error;
    throw mutationLockRootInvalid(lockRoot, "owner sentinel is unreadable or malformed");
  }
  for (const entry of await readdir(lockRoot, { withFileTypes: true })) {
    if (entry.name === MUTATION_LOCK_MARKER || entry.name === "owner.json") continue;
    if (!/^(ticket|released)-/.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw mutationLockRootInvalid(lockRoot, `unexpected root artifact ${entry.name}`);
    }
  }
  return lockRoot;
}

async function classifyExistingMutationLockRoot(lockRoot: string, publicationWait = 0): Promise<string> {
  const root = await rootEntryExists(lockRoot);
  if (!root || !root.isDirectory() || root.isSymbolicLink()) throw mutationLockMigrationRequired(lockRoot);
  const markerPath = path.join(lockRoot, MUTATION_LOCK_MARKER);
  const ownerPath = path.join(lockRoot, "owner.json");
  const [marker, owner] = await Promise.all([rootEntryExists(markerPath), rootEntryExists(ownerPath)]);
  // A concurrently-created root can be observed between exclusive mkdir and
  // publication of its sentinel/marker. Wait only for that generation to
  // finish publishing; this never writes or repairs an existing root.
  if (!marker && publicationWait < 20) {
    await delay(5);
    return classifyExistingMutationLockRoot(lockRoot, publicationWait + 1);
  }
  if (!marker && !owner) throw mutationLockMigrationRequired(lockRoot);
  if (!marker) {
    try {
      const legacyOwner = await readMutationLockOwner(ownerPath);
      if (isMutationLockRootOwner(legacyOwner)) {
        if (publicationWait < 20) {
          await delay(5);
          return classifyExistingMutationLockRoot(lockRoot, publicationWait + 1);
        }
        throw mutationLockRootInvalid(lockRoot, "marked root is missing its marker");
      }
    } catch (error) {
      if ((error as Error & { code?: string }).code === "flow.run_mutation.lock.root_invalid") throw error;
    }
    throw mutationLockMigrationRequired(lockRoot);
  }
  // A marker denotes the ticket protocol. Its sentinel must never be repaired
  // or replaced automatically, regardless of whether it is malformed or linked.
  return validateMutationLockRoot(lockRoot);
}

async function prepareMutationLockRoot(runDirPath: string) {
  const lockRoot = path.join(runDirPath, ".mutation.lock");
  const markerPath = path.join(lockRoot, MUTATION_LOCK_MARKER);
  try {
    await mkdir(lockRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return classifyExistingMutationLockRoot(lockRoot);
  }
  // A newly claimed root publishes its compatibility sentinel first, then its
  // marker, and validates both before any ticket can be created.
  await writeFile(path.join(lockRoot, "owner.json"), `${JSON.stringify(mutationLockRootOwner())}\n`, { flag: "wx", mode: 0o600 });
  await publishMutationLockMarker(markerPath);
  return validateMutationLockRoot(lockRoot);
}

async function publishMutationTicket(lockRoot: string, owner: MutationLockOwner) {
  const ticketName = `ticket-${Date.now().toString().padStart(13, "0")}-${owner.token}`;
  const ticketPath = path.join(lockRoot, ticketName);
  // Construct outside the published lock root, then rename only the complete
  // owner-recorded directory into the visible ticket namespace. A reader can
  // therefore never observe ticket-* without a complete owner.json.
  const pendingPath = path.join(path.dirname(lockRoot), `.${path.basename(lockRoot)}.pending-${owner.token}`);
  await validateMutationLockRoot(lockRoot);
  await mkdir(pendingPath, { mode: 0o700 });
  try {
    await publishMutationLockOwner(pendingPath, owner);
    await rename(pendingPath, ticketPath);
    // Abort if the root changed or gained an unexpected artifact while the
    // pending directory was being constructed.
    await validateMutationLockRoot(lockRoot);
  } catch (error) {
    await rm(pendingPath, { recursive: true, force: true }).catch(() => undefined);
    await quarantineAndRemoveMutationTicket(lockRoot, ticketPath, owner.token).catch(() => undefined);
    throw error;
  }
  return { ticketName, ticketPath };
}

function canonicalMutationTicketToken(lockRoot: string, ticketPath: string, expectedToken?: string) {
  const canonicalRoot = path.resolve(lockRoot);
  const canonicalTicket = path.resolve(ticketPath);
  if (path.dirname(canonicalTicket) !== canonicalRoot) {
    throw mutationLockRootInvalid(lockRoot, "ticket cleanup target must be a direct child of the lock root");
  }
  const match = MUTATION_TICKET_NAME.exec(path.basename(canonicalTicket));
  if (!match || (expectedToken !== undefined && match[1] !== expectedToken)) {
    throw mutationLockRootInvalid(lockRoot, "ticket basename does not match its canonical owner token");
  }
  return match[1];
}

async function quarantineAndRemoveMutationTicket(lockRoot: string, ticketPath: string, expectedToken?: string) {
  const token = canonicalMutationTicketToken(lockRoot, ticketPath, expectedToken);
  const releasedPath = path.join(lockRoot, `released-${token}`);
  try {
    await rename(ticketPath, releasedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(releasedPath, { recursive: true, force: true });
}

async function scanLiveMutationTickets(lockRoot: string) {
  await validateMutationLockRoot(lockRoot);
  const live: Array<{ name: string; path: string; owner: MutationLockOwner }> = [];
  for (const entry of await readdir(lockRoot, { withFileTypes: true })) {
    if (entry.name === MUTATION_LOCK_MARKER || entry.name === "owner.json") continue;
    if (!entry.name.startsWith("ticket-")) continue;
    const ticketPath = path.join(lockRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`flow.run_location.symlink_not_allowed: ${ticketPath}`);
    let owner: MutationLockOwner;
    try {
      owner = await readMutationLockOwner(path.join(ticketPath, "owner.json"));
    } catch {
      const ticketStat = await lstat(ticketPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (!ticketStat) continue;
      throw runLocationError("flow.run_mutation.lock.owner_unreadable", `ticket has no readable owner: ${ticketPath}`);
    }
    canonicalMutationTicketToken(lockRoot, ticketPath, owner.token);
    if (mutationLockOwnerIsStale(owner)) {
      await quarantineAndRemoveMutationTicket(lockRoot, ticketPath, owner.token);
    } else {
      live.push({ name: entry.name, path: ticketPath, owner });
    }
  }
  return live;
}

async function awaitMutationTicket(
  lockRoot: string,
  ticketName: string,
  ticketPath: string,
  owner: MutationLockOwner,
  recoveryWait?: {
    refresh: () => Promise<void>;
    deadline: () => number | null;
    timeoutError: () => Error;
  }
) {
  const ordinaryDeadline = Date.now() + 5_000;
  const effectiveDeadline = () => recoveryWait?.deadline() ?? ordinaryDeadline;
  const timeoutError = () => recoveryWait?.timeoutError()
    ?? runLocationError("flow.run_mutation.lock.timeout", "timed out waiting for the shared run mutation lock");
  await delay(25);
  for (;;) {
    const live = await scanLiveMutationTickets(lockRoot);
    const holding = live.find((entry) => entry.owner.status === "holding");
    const first = [...live].sort((left, right) => left.name.localeCompare(right.name))[0];
    if ((!holding || holding.owner.token === owner.token) && first?.owner.token === owner.token) {
      await recoveryWait?.refresh();
      if (Date.now() >= effectiveDeadline()) throw timeoutError();
      await publishMutationLockOwner(ticketPath, { ...owner, status: "holding" });
      return;
    }
    if (Date.now() >= effectiveDeadline()) {
      await recoveryWait?.refresh();
      if (Date.now() >= effectiveDeadline()) throw timeoutError();
    }
    await delay(10);
  }
}

async function releaseMutationTicket(lockRoot: string, ticketPath: string, owner: MutationLockOwner, hooks: RunMutationLockHooks) {
  const releasedPath = path.join(lockRoot, `released-${owner.token}`);
  let quarantined = false;
  activeMutationLockTokens.delete(owner.token);
  try {
    await rename(ticketPath, releasedPath);
    quarantined = true;
  } catch {
    await publishMutationLockOwner(ticketPath, { ...owner, status: "released", released_at: new Date().toISOString() }).catch(() => undefined);
  }
  try {
    if (quarantined) await hooks.afterReleaseQuarantine?.(releasedPath);
  } finally {
    if (quarantined) await rm(releasedPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withRunMutationLockCheck<T>(
  runId: string,
  cwd: string,
  operation: () => Promise<T>,
  hooks: RunMutationLockHooks,
  afterAcquire: () => Promise<void>,
  recoveryWait?: {
    refresh: () => Promise<void>;
    deadline: () => number | null;
    timeoutError: () => Error;
  },
  locationOverride?: RunLocation
): Promise<T> {
  const location = locationOverride ?? await resolveRunLocation(runId, cwd);
  const locationEntry = await lstat(location.dir, { bigint: true });
  if (locationEntry.isSymbolicLink() || !locationEntry.isDirectory()) {
    throw runLocationError("flow.run_location.inspection_failed", `run directory ${location.dir} must be a real directory`);
  }
  const directory = { device: String(locationEntry.dev), inode: String(locationEntry.ino) };
  const token = randomUUID();
  const owner: MutationLockOwner = { token, pid: process.pid, host: hostname(), status: "active", created_at: new Date().toISOString() };
  const lockRoot = await prepareMutationLockRoot(location.dir);
  activeMutationLockTokens.add(token);
  let ticketPath: string | undefined;
  try {
    const ticket = await publishMutationTicket(lockRoot, owner);
    ticketPath = ticket.ticketPath;
    await awaitMutationTicket(lockRoot, ticket.ticketName, ticket.ticketPath, owner, recoveryWait);
    await afterAcquire();
    return await activeRunMutationTicket.run(
      { token, run_id: runId, directory },
      operation
    );
  } catch (error) {
    activeMutationLockTokens.delete(token);
    if (ticketPath) {
      await quarantineAndRemoveMutationTicket(lockRoot, ticketPath, owner.token).catch(() => undefined);
    }
    throw error;
  } finally {
    if (ticketPath && activeMutationLockTokens.has(token)) await releaseMutationTicket(lockRoot, ticketPath, owner, hooks);
  }
}

export async function withRunMutationLock<T>(
  runId: string,
  cwd: string,
  operation: () => Promise<T>,
  hooks: RunMutationLockHooks = {}
): Promise<T> {
  // A mutation that begins while recovery is already active fails closed.
  // A mutation that was already queued before the coordinator fenced the run
  // must not be discarded, though: release its ticket and requeue until that
  // exact recovery generation publishes its supported open successor.
  await assertRunRecoveryFenceOpen(runId, cwd);
  let awaitedRecovery: {
    fence: { recovery_id: string; generation: string };
    directory: { device: string; inode: string };
  } | null = null;
  const deadline = Date.now() + 30_000;
  const refreshRecovery = async () => {
    const observed = await inspectRunRecoveryFence(runId, cwd);
    if (observed.status === "active") {
      const expected = awaitedRecovery;
      if (expected !== null && (
        observed.fence.recovery_id !== expected.fence.recovery_id
        || observed.fence.generation !== expected.fence.generation
        || observed.directory.device !== expected.directory.device
        || observed.directory.inode !== expected.directory.inode
      )) {
        throw runLocationError(
          "flow.run_recovery.changed",
          `active recovery fence for run "${runId}" changed while a queued mutation waited`
        );
      }
      awaitedRecovery = observed;
      return observed;
    }
    const expected = awaitedRecovery;
    if (expected !== null && (
      observed.status !== "open"
      || observed.fence.recovery_id !== expected.fence.recovery_id
      || observed.fence.previous_generation !== expected.fence.generation
      || observed.directory.device !== expected.directory.device
      || observed.directory.inode !== expected.directory.inode
    )) {
      throw runLocationError(
        "flow.run_recovery.changed",
        `recovery fence for run "${runId}" did not publish the expected open successor`
      );
    }
    return observed;
  };
  for (;;) {
    try {
      return await withRunMutationLockCheck(
        runId,
        cwd,
        operation,
        hooks,
        async () => {
          const observed = await refreshRecovery();
          if (observed.status === "active") {
            throw RETRY_MUTATION_AFTER_RECOVERY;
          }
        },
        {
          refresh: async () => { await refreshRecovery(); },
          deadline: () => awaitedRecovery === null ? null : deadline,
          timeoutError: () => awaitedRecovery === null
            ? runLocationError("flow.run_mutation.lock.timeout", "timed out waiting for the shared run mutation lock")
            : runLocationError(
                "flow.run_recovery.wait_timeout",
                `timed out waiting for the active recovery fence for run "${runId}" to open`
              )
        }
      );
    } catch (error) {
      if (error !== RETRY_MUTATION_AFTER_RECOVERY) throw error;
      if (Date.now() >= deadline) {
        throw runLocationError(
          "flow.run_recovery.wait_timeout",
          `timed out waiting for the active recovery fence for run "${runId}" to open`
        );
      }
      await delay(10);
    }
  }
}

/**
 * Sole supported active-fence publication. Active generations share Flow's
 * native mutation ticket with recovery finalization so neither can overwrite
 * a generation published by the other.
 */
export async function writeRunRecoveryFence(
  runId: string,
  fence: FlowRunRecoveryFenceWrite,
  cwd = process.cwd(),
  hooks: RunRecoveryFenceWriteHooks = {}
): Promise<FlowRunRecoveryFenceSnapshot> {
  assertActiveRunRecoveryFenceWrite(runId, fence);
  const recoveryLocation = await resolveRunRecoveryDirectory(runId, cwd);
  const heldTicket = activeRunMutationTicket.getStore();
  if (heldTicket?.run_id === runId && activeMutationLockTokens.has(heldTicket.token)) {
    if (
      recoveryLocation.identity.device === heldTicket.directory.device
      && recoveryLocation.identity.inode === heldTicket.directory.inode
    ) {
      return publishActiveRunRecoveryFence(runId, fence, cwd, hooks);
    }
  }
  return withRunMutationLockCheck(
    runId,
    cwd,
    () => publishActiveRunRecoveryFence(runId, fence, cwd, hooks),
    {},
    async () => {
      const afterAcquire = await resolveRunRecoveryDirectory(runId, cwd);
      if (
        afterAcquire.identity.device !== recoveryLocation.identity.device
        || afterAcquire.identity.inode !== recoveryLocation.identity.inode
      ) {
        throw runLocationError(
          "flow.run_recovery.changed",
          `fixed run directory for "${runId}" changed before active fence publication acquired the native run lock`
        );
      }
    },
    undefined,
    { runId, dir: recoveryLocation.dir, diagnostics: [] }
  );
}

/**
 * Recovery-only entry to Flow's native mutation ticket. The coordinator must
 * close the stable fence first; after acquiring, Flow proves that the exact
 * same active fence generation still names the expected recovery.
 */
export async function withRunRecoveryLock<T>(
  runId: string,
  recoveryId: string,
  cwd: string,
  operation: () => Promise<T>,
  hooks: RunMutationLockHooks = {}
): Promise<T> {
  const before = await inspectRunRecoveryFence(runId, cwd);
  if (
    before.status !== "active" ||
    before.fence.recovery_id !== recoveryId
  ) {
    throw runLocationError(
      "flow.run_recovery.coordinator_fence_mismatch",
      `run "${runId}" does not have the expected active recovery fence "${recoveryId}"`
    );
  }
  return withRunMutationLockCheck(runId, cwd, async () => {
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      result = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    try {
      const after = await inspectRunRecoveryFence(runId, cwd);
      if (
        after.status !== "active" ||
        after.fence.recovery_id !== recoveryId ||
        after.fingerprint !== before.fingerprint ||
        after.fence.generation !== before.fence.generation ||
        after.directory.device !== before.directory.device ||
        after.directory.inode !== before.directory.inode
      ) {
        throw runLocationError(
          "flow.run_recovery.coordinator_fence_mismatch",
          `active recovery fence "${recoveryId}" changed before the coordinator released the native run lock`
        );
      }
    } catch (error) {
      if ((error as Error & { code?: string }).code === "flow.run_recovery.coordinator_fence_mismatch") {
        throw error;
      }
      const mismatch = runLocationError(
        "flow.run_recovery.coordinator_fence_mismatch",
        `active recovery fence "${recoveryId}" could not be verified before the coordinator released the native run lock`
      );
      (mismatch as Error & { cause?: unknown }).cause = error;
      throw mismatch;
    }
    if (operationFailed) throw operationError;
    return result as T;
  }, hooks, async () => {
    const after = await inspectRunRecoveryFence(runId, cwd);
    if (
      after.status !== "active" ||
      after.fence.recovery_id !== recoveryId ||
      after.fingerprint !== before.fingerprint ||
      after.fence.generation !== before.fence.generation ||
      after.directory.device !== before.directory.device ||
      after.directory.inode !== before.directory.inode
    ) {
      throw runLocationError(
        "flow.run_recovery.coordinator_fence_mismatch",
        `active recovery fence "${recoveryId}" changed before the coordinator acquired the native run lock`
      );
    }
  });
}

/**
 * Sole supported active -> open transition. Flow publishes the new generation
 * before releasing the same native mutation ticket used by recovery work.
 */
export async function finalizeRunRecoveryFence(
  runId: string,
  request: FlowRunRecoveryFenceFinalizeRequest,
  cwd = process.cwd(),
  hooks: FlowRunRecoveryFenceFinalizeHooks = {}
) {
  if (
    !hooks ||
    typeof hooks !== "object" ||
    (hooks.beforeOpen !== undefined && typeof hooks.beforeOpen !== "function")
  ) {
    throw runLocationError(
      "flow.run_recovery.finalize_malformed",
      `run "${runId}" recovery finalization hooks are malformed`
    );
  }
  const requestKeys = request && typeof request === "object"
    ? Object.keys(request as unknown as Record<string, unknown>).sort()
    : [];
  if (
    requestKeys.length !== 3 ||
    requestKeys[0] !== "expected_generation" ||
    requestKeys[1] !== "recovery_id" ||
    requestKeys[2] !== "updated_at" ||
    !isNonEmptyString(request.recovery_id) ||
    !isNonEmptyString(request.expected_generation) ||
    !isNonEmptyString(request.updated_at) ||
    parseRfc3339Timestamp(request.updated_at) === null
  ) {
    throw runLocationError(
      "flow.run_recovery.finalize_malformed",
      `run "${runId}" recovery finalization request is malformed`
    );
  }
  const before = await inspectRunRecoveryFence(runId, cwd);
  const matchesExpectedActive = (snapshot: typeof before) =>
    snapshot.status === "active" &&
    snapshot.fence.recovery_id === request.recovery_id &&
    snapshot.fence.generation === request.expected_generation;
  if (!matchesExpectedActive(before)) {
    throw runLocationError(
      "flow.run_recovery.coordinator_fence_mismatch",
      `run "${runId}" does not have expected active generation "${request.expected_generation}"`
    );
  }
  if (before.status !== "active") {
    throw runLocationError(
      "flow.run_recovery.coordinator_fence_mismatch",
      `run "${runId}" does not have an active recovery fence`
    );
  }
  const activeBefore = before;
  return withRunMutationLockCheck(runId, cwd, async () => {
    await hooks.beforeOpen?.();
    const afterAssertion = await inspectRunRecoveryFence(runId, cwd);
    if (
      !matchesExpectedActive(afterAssertion) ||
      afterAssertion.status !== "active" ||
      afterAssertion.fingerprint !== activeBefore.fingerprint ||
      afterAssertion.directory.device !== activeBefore.directory.device ||
      afterAssertion.directory.inode !== activeBefore.directory.inode
    ) {
      throw runLocationError(
        "flow.run_recovery.coordinator_fence_mismatch",
        `active recovery fence "${request.recovery_id}" changed during the pre-open assertion`
      );
    }
    const opened = await publishOpenRunRecoveryFence(runId, {
      protocol: activeBefore.fence.protocol,
      run_id: runId,
      recovery_id: request.recovery_id,
      status: "open",
      previous_generation: request.expected_generation,
      updated_at: request.updated_at
    }, cwd);
    if (
      opened.status !== "open" ||
      opened.fence.recovery_id !== request.recovery_id ||
      opened.fence.generation === request.expected_generation ||
      opened.directory.device !== activeBefore.directory.device ||
      opened.directory.inode !== activeBefore.directory.inode
    ) {
      throw runLocationError(
        "flow.run_recovery.coordinator_fence_mismatch",
        `run "${runId}" did not publish the expected open recovery fence`
      );
    }
    return opened;
  }, {}, async () => {
    const afterAcquire = await inspectRunRecoveryFence(runId, cwd);
    if (
      !matchesExpectedActive(afterAcquire) ||
      afterAcquire.status !== "active" ||
      afterAcquire.fingerprint !== activeBefore.fingerprint ||
      afterAcquire.directory.device !== activeBefore.directory.device ||
      afterAcquire.directory.inode !== activeBefore.directory.inode
    ) {
      throw runLocationError(
        "flow.run_recovery.coordinator_fence_mismatch",
        `active recovery fence "${request.recovery_id}" changed before finalization acquired the native run lock`
      );
    }
  });
}

async function saveRetryAuthorizationState(run: any, faultInjection?: (stage: string) => void) {
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateRetryAuthorizationHistory(run.definition, run.state);
  validateEvidenceManifestIdentity(run.manifest, run.startDefinition ?? run.definition, run.state);
  const statePath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_STATE_FILE);
  const reportJsonPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson);
  const reportMarkdownPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown);
  const suffix = `.retry-${randomUUID()}.tmp`;
  const staged = [
    { target: reportJsonPath, temp: `${reportJsonPath}${suffix}`, contents: `${JSON.stringify(reportJson(run.definition, run.state, run.manifest), null, 2)}\n`, stage: "report_json" },
    { target: reportMarkdownPath, temp: `${reportMarkdownPath}${suffix}`, contents: renderMarkdownReport(run.definition, run.state, run.manifest), stage: "report_markdown" },
    { target: statePath, temp: `${statePath}${suffix}`, contents: `${JSON.stringify(run.state, null, 2)}\n`, stage: "state" }
  ];
  const priorReports = [
    { target: reportJsonPath, contents: await readFile(reportJsonPath, "utf8") },
    { target: reportMarkdownPath, contents: await readFile(reportMarkdownPath, "utf8") }
  ];
  let stateCommitted = false;
  try {
    for (const entry of staged) {
      faultInjection?.(`before_stage_${entry.stage}`);
      await writeFile(entry.temp, entry.contents, { flag: "wx", mode: 0o600 });
    }
    for (const entry of staged) {
      faultInjection?.(`before_rename_${entry.stage}`);
      await rename(entry.temp, entry.target);
      if (entry.stage === "state") stateCommitted = true;
    }
  } catch (error) {
    if (!stateCommitted) {
      await publishRunArtifacts(run.dir, priorReports.map((entry) => ({ path: entry.target, contents: entry.contents })));
    }
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => rm(entry.temp, { force: true }).catch(() => undefined)));
  }
}

type DefinitionAmendmentPreflight = {
  run: Awaited<ReturnType<typeof loadRun>>;
  prior: ReturnType<typeof effectiveDefinitionIdentity>;
  successor: any;
};

function invokeAmendmentFault(options: MutableRecord, stage: string) {
  const hook = options.faultInjection;
  if (hook === undefined) return;
  if (typeof hook !== "function") {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.request.invalid", "$.faultInjection", "faultInjection must be a synchronous function");
  }
  const result = hook(stage);
  if (result && typeof result.then === "function") {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.request.invalid", "$.faultInjection", "faultInjection must not return a thenable");
  }
}

/** State is the only canonical amendment commit. Reports are repairable projections. */
async function saveDefinitionAmendmentState(run: any, options: MutableRecord) {
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateRetryAuthorizationHistory(run.definition, run.state);
  validateMultiCursorState(run.definition, run.state);
  validateEvidenceManifestIdentity(run.manifest, run.startDefinition ?? run.definition, run.state);
  const statePath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_STATE_FILE);
  const reportJsonPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson);
  const reportMarkdownPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown);
  const suffix = `.definition-amendment-${randomUUID()}.tmp`;
  const staged = [
    { target: reportJsonPath, temp: `${reportJsonPath}${suffix}`, contents: `${JSON.stringify(reportJson(run.definition, run.state, run.manifest), null, 2)}\n`, stage: "report_json" },
    { target: reportMarkdownPath, temp: `${reportMarkdownPath}${suffix}`, contents: renderMarkdownReport(run.definition, run.state, run.manifest), stage: "report_markdown" },
    { target: statePath, temp: `${statePath}${suffix}`, contents: `${JSON.stringify(run.state, null, 2)}\n`, stage: "state" }
  ];
  const priorReports = await Promise.all([reportJsonPath, reportMarkdownPath].map(async (target) => ({ target, contents: await readFile(target, "utf8") })));
  let stateCommitted = false;
  try {
    for (const entry of staged) {
      invokeAmendmentFault(options, `before_stage_${entry.stage}`);
      await writeFile(entry.temp, entry.contents, { flag: "wx", mode: 0o600 });
    }
    for (const entry of staged) {
      invokeAmendmentFault(options, `before_rename_${entry.stage}`);
      await rename(entry.temp, entry.target);
      if (entry.stage === "state") stateCommitted = true;
    }
  } catch (error) {
    if (!stateCommitted) await publishRunArtifacts(run.dir, priorReports.map((entry) => ({ path: entry.target, contents: entry.contents })));
    throw error;
  } finally {
    await Promise.all(staged.map((entry) => rm(entry.temp, { force: true }).catch(() => undefined)));
  }
}

async function preflightDefinitionAmendment(
  runId: string,
  cwd: string,
  request: FlowDefinitionAmendmentRequest,
  suppliedSuccessor: unknown
): Promise<DefinitionAmendmentPreflight> {
  const run = await loadRun(runId, cwd);
  if (amendmentRequestReplayExists(run.state, request)) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.replay.conflict", "$.authority.request_ref", "request_ref was already consumed by a definition amendment");
  }
  if (["canceled", "completed", "failed", "accepted_by_exception"].includes(run.state.status)) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.run_terminal", "$.status", `runs with status ${run.state.status} cannot amend their definition`);
  }
  if (run.state.status === "paused") {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.run_paused", "$.status", "paused runs cannot amend their definition");
  }
  if (run.state.status !== "active") {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.compatibility.invalid", "$.status", "definition amendment requires an active run");
  }
  if ((run.state.multi_cursor?.active_claims ?? []).length > 0) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.compatibility.invalid", "$.multi_cursor.active_claims", "definition amendment requires every active multi-cursor claim to be released or settled first");
  }
  const prior = effectiveDefinitionIdentity(run.startDefinition ?? run.definition, run.state);
  if (flowRunHead(run.state) !== request.expected_run_head) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.run_head.stale", "$.expected_run_head", "expected_run_head does not match the current run state");
  }
  assertExpectedDefinitionIdentity(run.startDefinition ?? run.definition, run.state, request.expected_definition);
  const successor = validateDefinition(suppliedSuccessor);
  const successorDigest = definitionDigest(successor);
  if (successorDigest !== request.successor_digest) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.request.invalid", "$.successor_digest", "successor_digest does not match the normalized supplied successor");
  }
  if (successor.id !== prior.id || successor.version === prior.version || successorDigest === prior.digest) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.compatibility.invalid", "$.successor", "successor must retain id and use a new version and digest");
  }
  const amendments = run.state.definition_amendments ?? [];
  const startIdentity = definitionIdentity(run.startDefinition ?? run.definition);
  if (successor.version === startIdentity.version || successorDigest === startIdentity.digest
    || amendments.some((event: FlowDefinitionAmendmentEvent) => event.successor_definition?.version === successor.version || event.successor_definition?.digest === successorDigest)) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.compatibility.invalid", "$.successor", "successor version or digest was already used in this run");
  }
  assertDefinitionCompatibility(run.definition, successor, run.state);
  return { run, prior, successor };
}

/**
 * Append one complete compatible successor to state.json. The caller supplies
 * externally authenticated authority; Flow validates only its neutral shape.
 */
export async function amendRunDefinition(runId: string, options: MutableRecord = {}): Promise<FlowDefinitionAmendmentResult & MutableRecord> {
  if (Object.hasOwn(options, "at")) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.request.invalid", "$.at", "amendment timestamps are runtime-derived and cannot be supplied by callers");
  }
  const requestValue = options.request ?? Object.fromEntries(Object.entries(options).filter(([key]) => !["cwd", "definition", "successor", "faultInjection"].includes(key)));
  const request = validateDefinitionAmendmentRequest(requestValue);
  const suppliedSuccessor = options.definition ?? options.successor;
  if (suppliedSuccessor === undefined) {
    throw new FlowDefinitionAmendmentError("flow.definition_amendment.request.invalid", "$.definition", "a complete successor definition is required");
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  await preflightDefinitionAmendment(runId, cwd, request, suppliedSuccessor);
  return withRunMutationLock(runId, cwd, async () => {
    const { run, prior, successor } = await preflightDefinitionAmendment(runId, cwd, request, suppliedSuccessor);
    const successorIdentity = definitionIdentity(successor);
    const at = new Date().toISOString();
    const { definition_amendments: _priorAmendments, ...priorState } = structuredClone(run.state);
    const event: FlowDefinitionAmendmentEvent = {
      type: "definition_amended",
      prior_definition: prior,
      successor_definition: successorIdentity,
      prior_run_head: request.expected_run_head,
      prior_state: priorState,
      successor,
      authority: request.authority,
      reason: request.reason,
      at
    };
    run.definition = successor;
    run.state = {
      ...run.state,
      definition_id: successor.id,
      definition_version: successor.version,
      definition_digest: successorIdentity.digest,
      definition_amendments: [...(run.state.definition_amendments ?? []), event],
      next_action: nextActionForStep(successor, run.state.current_step),
      updated_at: at
    };
    // Validate the completed ledger before state.json can become canonical.
    resolveEffectiveDefinition(run.startDefinition ?? run.definition, run.state);
    await saveDefinitionAmendmentState(run, options);
    return { ...run, event, idempotent: false, prior_definition: prior, effective_definition: successorIdentity };
  });
}

type RetryAuthorizationPreflight =
  | {
      kind: "replay";
      run: Awaited<ReturnType<typeof loadRun>>;
      transition: FlowRetryAuthorizationTransition;
    }
  | {
      kind: "ready";
      run: Awaited<ReturnType<typeof loadRun>>;
      blocked: MutableRecord;
    };

/**
 * Read-only semantic admission for retry authorization. Callers run this once
 * before acquiring the shared mutation lock so invalid requests cannot create
 * lock artifacts, and again after locking to close the state-change window.
 */
async function preflightRetryAuthorization(
  runId: string,
  cwd: string,
  request: FlowRetryAuthorizationRequest
): Promise<RetryAuthorizationPreflight> {
  const run = await loadRun(runId, cwd);
  const existing = (run.state.transitions ?? []).find(
    (transition) => transition?.authority?.request_ref === request.authority.request_ref
  );
  if (existing) {
    if (retryAuthorizationMatches(existing, request)) {
      return { kind: "replay", run, transition: existing as FlowRetryAuthorizationTransition };
    }
    throw new FlowRetryAuthorizationError("flow.retry_authorization.replay.conflict", "$.authority.request_ref", "request_ref conflicts with an existing retry authorization");
  }
  if (["canceled", "completed", "failed", "accepted_by_exception"].includes(run.state.status)) {
    throw new FlowRetryAuthorizationError("flow.retry_authorization.run_terminal", "$.status", `runs with status ${run.state.status} cannot authorize retry`);
  }
  if (run.state.status !== "blocked") {
    throw new FlowRetryAuthorizationError("flow.retry_authorization.run_not_blocked", "$.status", "retry authorization requires a blocked run");
  }
  const currentHead = flowRunHead(run.state);
  if (currentHead !== request.expected_run_head) {
    throw new FlowRetryAuthorizationError("flow.retry_authorization.run_head.stale", "$.expected_run_head", "expected_run_head does not match the current run state");
  }
  const blockedIndex = run.state.transitions.length - 1;
  const blocked = run.state.transitions[blockedIndex];
  if (!blocked || flowTransitionRef(blocked) !== request.blocked_transition_ref
    || run.state.current_step !== blocked.from_step) {
    throw new FlowRetryAuthorizationError("flow.retry_authorization.block.invalid", "$.blocked_transition_ref", "blocked_transition_ref must identify the current exhausted route-back transition");
  }
  const proof = exhaustedRouteBackProof(run.definition, run.state.transitions, blockedIndex);
  if (!proof) throw new FlowRetryAuthorizationError("flow.retry_authorization.block.invalid", "$.blocked_transition_ref", "current exhausted route-back transition is inconsistent with its history and Flow Definition");
  if (request.target_step !== blocked.selected_route) {
    throw new FlowRetryAuthorizationError("flow.retry_authorization.block.invalid", "$.target_step", "target_step must equal the exhausted transition selected_route");
  }
  return { kind: "ready", run, blocked };
}

/**
 * Authorize one new bounded epoch for the current exhausted route-back block.
 * This is a run transition, deliberately separate from pause/resume/cancel.
 */
export async function authorizeRetry(runId: string, options: MutableRecord = {}): Promise<FlowRetryAuthorizationResult & MutableRecord> {
  if (Object.hasOwn(options, "at")) {
    throw new FlowRetryAuthorizationError("flow.retry_authorization.request.invalid", "$.at", "authorization timestamps are runtime-derived and cannot be supplied by callers");
  }
  const requestValue = options.request ?? Object.fromEntries(Object.entries(options).filter(([key]) => !["cwd", "faultInjection"].includes(key)));
  const request = validateRetryAuthorizationRequest(requestValue) as FlowRetryAuthorizationRequest;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  // Reject all semantic failures before lock initialization. Exact replay is
  // itself read-only, so return the coherent run snapshot observed by this
  // preflight without initializing a lock root. As with loadRun, another
  // operation may advance the run after this snapshot has been read.
  const initialPreflight = await preflightRetryAuthorization(runId, cwd, request);
  if (initialPreflight.kind === "replay") {
    return { ...initialPreflight.run, transition: initialPreflight.transition, idempotent: true };
  }
  return withRunMutationLock(runId, cwd, async () => {
    const preflight = await preflightRetryAuthorization(runId, cwd, request);
    if (preflight.kind === "replay") {
      return { ...preflight.run, transition: preflight.transition, idempotent: true };
    }
    const { run, blocked } = preflight;
    const priorEpoch = blocked.retry_epoch ?? 1;
    const retryEpoch = priorEpoch + 1;
    const invalidated = invalidateDescendants(run.definition, run.state, request.target_step);
    // The exhausted decision remains in gate_outcome_history and transition
    // history, but it is no longer the current projection in the authorized
    // epoch. The gate returns to wait until fresh evidence is evaluated.
    run.state.gate_outcomes = (run.state.gate_outcomes ?? []).filter(
      (outcome) => outcome.gate_id !== blocked.gate_id
    );
    const at = new Date().toISOString();
    const transition: FlowRetryAuthorizationTransition = {
    type: "retry_authorized",
    from_step: blocked.from_step,
    to_step: request.target_step,
    status: "retry-authorized",
    reason: request.reason,
    gate_id: blocked.gate_id,
    // Persist the effective loop reason (`default` when the failed evidence
    // had none), rather than the operator's human reason, so future attempt
    // accounting selects this exact recovered loop.
    route_reason: blocked.route_reason ?? blocked.reason,
    selected_route: blocked.selected_route,
    blocked_transition_ref: request.blocked_transition_ref,
    prior_run_head: request.expected_run_head,
    prior_retry_epoch: priorEpoch,
    retry_epoch: retryEpoch,
    authority: request.authority,
    invalidated_steps: invalidated.length ? invalidated : undefined,
    at
    };
    run.state = {
      ...run.state,
      status: "active",
      current_step: request.target_step,
      transitions: [...run.state.transitions, transition],
      next_action: nextActionForStep(run.definition, request.target_step),
      updated_at: at
    };
    await saveRetryAuthorizationState(run, typeof options.faultInjection === "function" ? options.faultInjection : undefined);
    return { ...run, transition, idempotent: false };
  });
}

export async function sha256File(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Resolve a manifest entry's `stored_path` against the run directory, rejecting
 * absolute paths, traversal, null bytes, and anything outside the evidence
 * directory. Mirrors the write-time safety of assertSafeRunArtifactWritePath.
 */
function resolveEvidenceArtifactPath(runDir: string, storedPath: string): string {
  if (
    typeof storedPath !== "string" || !storedPath
    || path.isAbsolute(storedPath) || storedPath.includes("\0")
    || storedPath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`flow.evidence.integrity.unsafe_path: ${storedPath}`);
  }
  const parts = storedPath.split(/[\\/]/);
  if (parts[0] !== FLOW_RUN_EVIDENCE_DIR) {
    throw new Error(`flow.evidence.integrity.unsafe_path: ${storedPath}`);
  }
  const root = path.resolve(runDir);
  const resolved = path.resolve(root, storedPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`flow.evidence.integrity.unsafe_path: ${storedPath}`);
  }
  return resolved;
}

/**
 * Re-hash one copied evidence artifact and compare against its recorded digest.
 * Missing, unsafe, or unreadable files fail closed as integrity failures so a
 * deleted/locked artifact can never silently satisfy a gate.
 */
async function checkEvidenceIntegrity(entry: any, runDir: string): Promise<string> {
  let file: string;
  try {
    file = resolveEvidenceArtifactPath(runDir, entry.stored_path);
  } catch {
    return "missing";
  }
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) return "missing";
      const data = await handle.readFile();
      const digest = createHash("sha256").update(data).digest("hex");
      const recorded = typeof entry.sha256 === "string" ? entry.sha256.toLowerCase() : "";
      return digest === recorded ? "verified" : "mismatch";
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingPathError(error)) return "missing";
    return "unreadable";
  }
}

/** Reader seam: prove a retained artifact still matches its committed receipt. */
export async function verifyPinnedEvidenceDigest(runDir: string, entry: any, digest: string | undefined) {
  return typeof digest === "string"
    && typeof entry?.sha256 === "string"
    && entry.sha256.toLowerCase() === digest
    && await checkEvidenceIntegrity(entry, runDir) === "verified";
}

/**
 * Recompute the integrity of every non-superseded attached artifact that
 * carries a recorded digest, returning a map of evidence id to transient
 * verification status ("verified" | "mismatch" | "missing" | "unreadable").
 */
async function evidenceIntegrityStatusById(manifest: any, runDir: string): Promise<Map<string, string>> {
  const statusById = new Map<string, string>();
  for (const entry of manifest?.evidence ?? []) {
    if (entry.superseded_by) continue;
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) continue;
    if (typeof entry.stored_path !== "string" || !entry.stored_path) continue;
    statusById.set(entry.id, await checkEvidenceIntegrity(entry, runDir));
  }
  return statusById;
}

/**
 * Return a shallow manifest clone whose evidence entries carry a transient
 * `integrity` field when a digest was re-verified. The original manifest is
 * untouched so persisted state never records a computed verification label —
 * the exact defect (recorded-but-unchecked) this re-verification exists to
 * prevent. evaluateGate performs its own structuredClone, so shallow sharing
 * here is safe.
 */
function manifestWithIntegrity(manifest: any, statusById: Map<string, string>): any {
  if (!statusById.size) return manifest;
  return {
    ...manifest,
    evidence: (manifest.evidence ?? []).map((entry: any) => {
      const status = statusById.get(entry.id);
      return status ? { ...entry, integrity: status } : entry;
    })
  };
}

/**
 * Normalize and validate a Hachure TrustBundle, returning the bundle and its
 * derived TrustReport. Throws on invalid bundle.
 */
export function normalizeTrustBundle(raw: unknown): { bundle: any; bundle_report: any } {
  return normalizeTrustAttachmentBundle(raw, new Date().toISOString(), FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES);
}

async function attachEvidenceUnlocked(runId: string, options: FlowEvidenceAttachmentOptions): Promise<FlowEvidenceEntry> {
  const run = await loadRun(runId, options.cwd);
  if (options.expectedRunHead !== undefined && flowRunHead(run.state) !== options.expectedRunHead) {
    throw new Error("flow.run_head.stale: expectedRunHead does not match the current run state");
  }
  assertRunMutationLifecycleEligible("attach_evidence", run);
  const prepared = await prepareEvidenceAttachment(run, options, { normalizeBundle: normalizeTrustBundle, attachedAt: () => new Date().toISOString() });
  await writeFile(prepared.storedPath, prepared.sourceBytes, { flag: "wx" });
  run.manifest = prepared.nextManifest;
  await saveRun(run);
  return prepared.evidence;
}

function isExhaustedBlockedRun(run: Awaited<ReturnType<typeof loadRun>>) {
  const blockedIndex = run.state.transitions.length - 1;
  const blocked = run.state.transitions[blockedIndex];
  return run.state.status === "blocked"
    && blocked !== undefined
    && run.state.current_step === blocked.from_step
    && exhaustedRouteBackProof(run.definition, run.state.transitions, blockedIndex) !== null;
}

function assertRunMutationLifecycleEligible(
  operation: "attach_evidence" | "evaluate",
  run: Awaited<ReturnType<typeof loadRun>>
) {
  assertLifecycleEligible(operation, run.state.status, { blocked_by_exhaustion: isExhaustedBlockedRun(run) });
}

async function preflightRunMutationLifecycle(runId: string, cwd: string, operation: "attach_evidence" | "evaluate") {
  const run = await loadRun(runId, cwd);
  assertRunMutationLifecycleEligible(operation, run);
}

const ATTACH_EVIDENCE_OPTION_KEYS = new Set([
  "cwd", "gate", "file", "kind", "bundle", "trustArtifact", "expectedRunHead", "expectedSha256", "status", "supersede",
  "producer", "route_reason", "expectation_ids", "classifier", "diagnostics", "analytics"
]);

function attachmentOptionString(options: any, key: string, required = false) {
  const value = options[key];
  if (value === undefined && !required) return;
  if (!isNonEmptyString(value)) throw new Error(`flow.attach_evidence.options.invalid: ${key} must be a non-empty string`);
}

function attachmentOptionStrings(options: any, key: string) {
  const value = options[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    throw new Error(`flow.attach_evidence.options.invalid: ${key} must be an array of non-empty strings`);
  }
}

/** Reject malformed or silently ignored public attachment options before I/O. */
function validateEvidenceAttachmentOptions(options: unknown): FlowEvidenceAttachmentOptions {
  let candidate: MutableRecord;
  try {
    candidate = structuredClone(options) as MutableRecord;
  } catch {
    throw new Error("flow.attach_evidence.options.invalid: options must be structured-cloneable");
  }
  if (!isObject(candidate) || Array.isArray(candidate)) throw new Error("flow.attach_evidence.options.invalid: options must be an object");
  for (const key of Object.keys(candidate)) {
    if (!ATTACH_EVIDENCE_OPTION_KEYS.has(key)) throw new Error(`flow.attach_evidence.options.invalid: unsupported option ${key}`);
  }
  attachmentOptionString(candidate, "gate", true);
  attachmentOptionString(candidate, "file", true);
  for (const key of ["cwd", "kind", "expectedRunHead", "expectedSha256", "status", "producer", "route_reason"]) attachmentOptionString(candidate, key);
  for (const key of ["expectation_ids"]) attachmentOptionStrings(candidate, key);
  for (const key of ["bundle", "trustArtifact"]) {
    if (candidate[key] !== undefined && typeof candidate[key] !== "boolean") throw new Error(`flow.attach_evidence.options.invalid: ${key} must be a boolean`);
  }
  if (candidate.supersede !== undefined && (!isNonEmptyString(candidate.supersede) && (!Array.isArray(candidate.supersede) || candidate.supersede.some((entry) => !isNonEmptyString(entry))))) {
    throw new Error("flow.attach_evidence.options.invalid: supersede must be a non-empty string or an array of non-empty strings");
  }
  for (const key of ["classifier", "diagnostics", "analytics"]) {
    if (candidate[key] !== undefined && (!isObject(candidate[key]) || Array.isArray(candidate[key]))) throw new Error(`flow.attach_evidence.options.invalid: ${key} must be an object`);
  }
  return candidate as FlowEvidenceAttachmentOptions;
}

export function attachEvidence(runId: string, options: FlowEvidenceAttachmentOptions): Promise<FlowEvidenceEntry> {
  const validatedOptions = validateEvidenceAttachmentOptions(options);
  const cwd = path.resolve(validatedOptions.cwd ?? process.cwd());
  let expectedRunHead: string | undefined;
  if (validatedOptions.expectedRunHead !== undefined) {
    if (typeof validatedOptions.expectedRunHead !== "string" || !/^[a-f0-9]{64}$/i.test(validatedOptions.expectedRunHead)) {
      throw new Error("flow.run_head.invalid: expectedRunHead must be a SHA-256 hex digest");
    }
    expectedRunHead = validatedOptions.expectedRunHead.toLowerCase();
  }
  return preflightRunMutationLifecycle(runId, cwd, "attach_evidence")
    .then(() => withRunMutationLock(runId, cwd, () => attachEvidenceUnlocked(runId, { ...validatedOptions, cwd, expectedRunHead })));
}

type PreparedEvidenceAttachment = {
  evidence: FlowEvidenceEntry;
  nextManifest: MutableRecord;
  sourceBytes: Buffer;
  storedPath: string;
};

type EvidencePreparation = {
  normalizeBundle: (raw: unknown) => { bundle: any; bundle_report: any };
  attachedAt: () => string;
};

function continuationNow(value: unknown) {
  const exact = value === undefined ? new Date().toISOString() : value;
  if (typeof exact !== "string" || parseRfc3339Timestamp(exact) === null) {
    throw new Error("flow.paused_gate_continuation.request.invalid: now must be an RFC3339 date-time when provided");
  }
  const surfaceNow = new Date(exact);
  if (!Number.isFinite(surfaceNow.getTime())) {
    throw new Error("flow.paused_gate_continuation.request.invalid: now must be an RFC3339 date-time when provided");
  }
  return { exact, surfaceNow };
}

function pausedGateContinuationRequest(options: FlowPausedGateContinuationOptions) {
  let requestOptions: FlowPausedGateContinuationOptions;
  try {
    requestOptions = structuredClone(options) as FlowPausedGateContinuationOptions;
  } catch {
    throw new Error("flow.paused_gate_continuation.request.invalid: options must be structured-cloneable");
  }
  if (!isObject(requestOptions) || Array.isArray(requestOptions)) {
    throw new Error("flow.paused_gate_continuation.request.invalid: options must be an object");
  }
  if (typeof requestOptions.expectedRunHead !== "string" || !/^[a-f0-9]{64}$/i.test(requestOptions.expectedRunHead)) {
    throw new Error("flow.run_head.invalid: expectedRunHead must be a SHA-256 hex digest");
  }
  if (!isNonEmptyString(requestOptions.gate)) {
    throw new Error("flow.paused_gate_continuation.request.invalid: gate must be a non-empty string");
  }
  if (!isObject(requestOptions.evidence) || !isNonEmptyString(requestOptions.evidence.file)) {
    throw new Error("flow.paused_gate_continuation.request.invalid: evidence.file must be a non-empty string");
  }
  const cwd = path.resolve(requestOptions.cwd ?? process.cwd());
  const evidence = validateEvidenceAttachmentOptions({
    ...(requestOptions.evidence as MutableRecord),
    cwd,
    gate: requestOptions.gate
  });
  if (typeof requestOptions.resumeOnPass !== "boolean") {
    throw new Error("flow.paused_gate_continuation.request.invalid: resumeOnPass must be a boolean");
  }
  if (requestOptions.resumeOnPass && !requestOptions.resume) {
    throw new Error("flow.paused_gate_continuation.request.invalid: resume is required when resumeOnPass is true");
  }
  if (!requestOptions.resumeOnPass && requestOptions.resume !== undefined) {
    throw new Error("flow.paused_gate_continuation.request.invalid: resume is only allowed when resumeOnPass is true");
  }
  const evaluationTime = continuationNow(requestOptions.now);
  const resumeOptions = requestOptions.resumeOnPass && requestOptions.resume!.at === undefined
    ? { ...requestOptions.resume!, at: evaluationTime.exact }
    : requestOptions.resume;
  const resume = requestOptions.resumeOnPass
    ? { request: validateLifecycleRequest("resume", { reason: resumeOptions!.reason, authority: resumeOptions!.authority }), at: lifecycleTimestamp(resumeOptions!, "resume") }
    : undefined;
  if (resume) {
    const resumeAt = parseRfc3339Timestamp(resume.at);
    const evaluationAt = parseRfc3339Timestamp(evaluationTime.exact)!;
    if (resumeAt === null) {
      throw new Error("flow.paused_gate_continuation.request.invalid: resume.at must be an RFC3339 date-time");
    }
    if (compareRfc3339Timestamps(resumeAt, evaluationAt) > 0) {
      throw new Error("flow.paused_gate_continuation.request.invalid: resume.at must not follow evaluation now");
    }
  }
  return {
    cwd,
    expectedRunHead: requestOptions.expectedRunHead.toLowerCase(),
    gate: requestOptions.gate,
    evidence,
    resumeOnPass: requestOptions.resumeOnPass,
    resume,
    now: evaluationTime.exact,
    surfaceNow: evaluationTime.surfaceNow
  };
}

async function readEvidenceSource(options: MutableRecord) {
  const source = path.resolve(options.cwd ?? process.cwd(), options.file);
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let sourceBytes: Buffer;
  try {
    const sourceStat = await sourceHandle.stat();
    if (!sourceStat.isFile()) throw new Error(`evidence source must be a regular file: ${source}`);
    sourceBytes = await sourceHandle.readFile();
  } finally {
    await sourceHandle.close();
  }
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
  if (options.expectedSha256 !== undefined) {
    if (typeof options.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(options.expectedSha256)) {
      throw new Error("expectedSha256 must be a SHA-256 hex digest");
    }
    if (options.expectedSha256.toLowerCase() !== sourceSha256) {
      throw new Error("evidence source digest does not match expectedSha256");
    }
  }
  return { source, sourceBytes, sourceSha256 };
}

function normalizedEvidenceBundle(sourceBytes: Buffer, options: MutableRecord, preparation: EvidencePreparation) {
  if (!(options.bundle || options.kind === "trust.bundle" || options.trustArtifact)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(sourceBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`trust bundle JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return preparation.normalizeBundle(raw);
}

/**
 * Refuse an evidence write for a gate the run cannot legitimately appraise
 * from its present position.
 *
 * A gate's step is attachable when ANY of the following holds:
 *
 *  - it is the cursor step (the ordinary case);
 *  - it is on the current frontier (a ready step — covers multi-cursor
 *    fan-in siblings awaiting a claim);
 *  - the run has occupied it (re-evaluation, supersede, and route-back
 *    recovery writes remain legal);
 *  - it is reachable from the cursor by walking forward through gateless
 *    steps only — the same honest walk `evaluate --gate` performs (#202), so
 *    pre-staging evidence for the gate the walk lands on stays legal
 *    (examples/adversarial-pass-flow.json is built this way).
 *
 * Everything else is a write for a stage the run cannot appraise without
 * first passing an intervening gate: persisting it writes the record of
 * trust attributed to nobody, distinguishable from legitimate evidence only
 * by timestamp arithmetic (#223). Pre-staging beyond the walk is a
 * legitimate-sounding workflow the definition should opt into per gate; no
 * such opt-in exists yet, so the write is refused.
 */
function assertEvidenceGateReached(run: Awaited<ReturnType<typeof loadRun>>, gate: any) {
  if (gate.step === run.state.current_step) return;
  if (readySteps(run.definition, run.state, run.manifest).includes(gate.step)) return;
  if (occupiedSteps(run.definition, run.state).has(gate.step)) return;
  if (reachableThroughGatelessSteps(run.definition, run.state, gate.step)) return;
  const error = new Error(
    `flow.evidence.gate.unreached: refusing to attach evidence for gate "${gate.id}" on step "${gate.step}" — the run is on "${run.state.current_step}" and an unevaluated gate stands between the cursor and that step`
  );
  (error as Error & { code?: string }).code = "flow.evidence.gate.unreached";
  throw error;
}

/** Read-only twin of advanceThroughGatelessSteps: would the #202 walk land on targetStep? */
function reachableThroughGatelessSteps(definition: any, state: any, targetStep: string): boolean {
  let cursor: string | null = state.current_step;
  const seen = new Set<string>();
  while (cursor && cursor !== targetStep && !seen.has(cursor)) {
    // A real gate stands between the cursor and the target. The walk stops.
    if (gatesForStep(definition, cursor).length) return false;
    seen.add(cursor);
    cursor = getStep(definition, cursor)?.next ?? null;
  }
  return cursor === targetStep;
}

async function prepareEvidenceAttachment(run: Awaited<ReturnType<typeof loadRun>>, options: FlowEvidenceAttachmentOptions, preparation: EvidencePreparation): Promise<PreparedEvidenceAttachment> {
  const gate = findGate(run.definition, options.gate);
  if (!gate) throw new Error(`unknown gate: ${options.gate}`);
  assertEvidenceGateReached(run, gate);
  const { source, sourceBytes, sourceSha256 } = await readEvidenceSource(options);
  const kind = normalizeEvidenceKind(options.kind);
  const requestedKind = options.kind ?? "file";
  const normalizedBundle = normalizedEvidenceBundle(sourceBytes, options, preparation);
  const id = `ev.${Date.now()}.${run.manifest.evidence.length + 1}`;
  const storedName = `${id}${path.extname(source)}`;
  const storedPath = await assertSafeRunArtifactWritePath(run.dir, path.join(FLOW_RUN_EVIDENCE_DIR, storedName));
  const evidence: FlowEvidenceEntry = {
    id,
    gate_id: options.gate,
    kind,
    requested_kind: requestedKind,
    status: options.status ?? "passed",
    original_path: options.file,
    stored_path: path.join(FLOW_RUN_EVIDENCE_DIR, storedName),
    sha256: sourceSha256,
    attached_at: preparation.attachedAt()
  };
  if (normalizedBundle) {
    evidence.kind = "trust.bundle";
    evidence.requested_kind = "trust.bundle";
    evidence.bundle = normalizedBundle.bundle;
    evidence.bundle_report = normalizedBundle.bundle_report;
  }
  if (options.producer) evidence.producer = options.producer;
  if (options.route_reason) evidence.route_reason = options.route_reason;
  if (options.expectation_ids) evidence.expectation_ids = options.expectation_ids;
  if (options.classifier) evidence.classifier = options.classifier;
  if (options.diagnostics) evidence.diagnostics = options.diagnostics;
  if (options.analytics) evidence.analytics = options.analytics;
  const attachmentPlan = reduceTrustAttachmentManifest(run.manifest, evidence, options.supersede);
  return { evidence: attachmentPlan.evidence, nextManifest: attachmentPlan.next_manifest, sourceBytes, storedPath };
}

function assertPausedContinuation(run: Awaited<ReturnType<typeof loadRun>>, request: ReturnType<typeof pausedGateContinuationRequest>) {
  if (flowRunHead(run.state) !== request.expectedRunHead) throw new Error("flow.run_head.stale: expectedRunHead does not match the current run state");
  assertLifecycleEligible("resume", run.state.status);
  const gate = findGate(run.definition, request.gate);
  if (!gate || gate.step !== run.state.current_step) throw new Error(`flow.paused_gate_continuation.gate.invalid: ${request.gate} is not the persisted current open gate`);
}

function resumedContinuationState(state: FlowRunState, request: ReturnType<typeof pausedGateContinuationRequest>) {
  const nextState = structuredClone(state) as FlowRunState;
  const prior = priorResumableStatus(nextState);
  if (!request.resumeOnPass) return { nextState: { ...nextState, status: prior }, event: undefined };
  const event: FlowLifecycleEvent = { action: "resume", from_status: "paused", to_status: prior, prior_status: prior, reason: request.resume!.request.reason, authority: request.resume!.request.authority, at: request.resume!.at };
  return { nextState: { ...nextState, status: prior, lifecycle: [...(nextState.lifecycle ?? []), event], updated_at: event.at }, event };
}

function staleContinuationOutcome(gate: string, rechecks: MutableRecord[]) {
  return { gate_id: gate, status: "block", summary: "upstream passed gate evidence became stale", evidence_refs: [], diagnostics: { code: "flow.paused_gate_continuation.upstream_stale", freshness_rechecks: rechecks } } as GateOutcome;
}

function blockingFreshnessRechecks(definition: any, currentStep: string, rechecks: MutableRecord[]) {
  return rechecks.filter((recheck) => {
    const gate = findGate(definition, recheck.gate_id);
    return gate && (gate.step === currentStep || descendantsOf(definition, gate.step).includes(currentStep));
  });
}

function evaluatePausedContinuation(run: Awaited<ReturnType<typeof loadRun>>, state: FlowRunState, manifest: MutableRecord, request: ReturnType<typeof pausedGateContinuationRequest>) {
  const outcome = evaluateGate(run.definition, state, manifest, request.gate, run.config, request.now);
  const validation = validateEvaluationTransition(run.definition, state, manifest, outcome, run.config, request.now);
  if (validation.status === "invalid" || (outcome.status === "pass" && validation.valid !== true)) throw new Error(`invalid Flow transition for ${outcome.gate_id}: ${validation.diagnostics[0]?.message ?? "transition validation failed"}`);
  outcome.transition_validation = validation;
  return outcome;
}

/** Atomically continue a paused current gate; every non-commit result is dry. */
export async function continuePausedGate(runId: string, options: FlowPausedGateContinuationOptions): Promise<FlowPausedGateContinuationResult> {
  const request = pausedGateContinuationRequest(options);
  return withRunMutationLock(runId, request.cwd, async () => {
    const run = await loadRun(runId, request.cwd);
    assertPausedContinuation(run, request);
    const prepared = await prepareEvidenceAttachment(run, request.evidence, { normalizeBundle: (raw) => normalizeTrustAttachmentBundle(raw, request.now, FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES), attachedAt: () => request.now });
    const manifest = structuredClone(prepared.nextManifest) as MutableRecord;
    const rechecks = blockingFreshnessRechecks(run.definition, run.state.current_step, staleGateRechecks(run.definition, run.state, manifest, reDeriveBundleReports(manifest, request.now), run.config));
    if (rechecks.length) return { committed: false, outcomes: [staleContinuationOutcome(request.gate, rechecks)], run };
    const { nextState, event } = resumedContinuationState(run.state, request);
    if (request.resumeOnPass) validateRunStateConsistency(run.startDefinition, nextState, { runId });
    // Re-verify copied artifacts before evaluating the paused gate. Verify
    // against the PRE-ATTACHMENT manifest: the newly staged entry's file is not
    // written until commit, so it must be excluded from the disk re-hash. The
    // annotated clone is used for evaluation only; the committed run persists
    // the clean `manifest` (no recorded integrity label).
    const integrityById = await evidenceIntegrityStatusById(run.manifest, run.dir);
    const evaluationManifest = manifestWithIntegrity(manifest, integrityById);
    const outcome = evaluatePausedContinuation(run, nextState, evaluationManifest, request);
    if (outcome.status !== "pass" || !request.resumeOnPass) return { committed: false, outcomes: [outcome], run };
    const committedRun = { ...run, state: nextState, manifest };
    mintGateEvaluation(committedRun, outcome, request.now, "paused");
    applyEvaluation(committedRun.definition, nextState, outcome, request.now);
    validateRunStateConsistency(run.startDefinition, nextState, { runId });
    validateEvidenceManifestIdentity(manifest, run.startDefinition, nextState);
    await writeFile(prepared.storedPath, prepared.sourceBytes, { flag: "wx" });
    await saveRun(committedRun);
    return { committed: true, evidence: prepared.evidence, outcomes: [outcome], run: committedRun, event };
  });
}

/**
 * Re-derive each attached trust.bundle's report against the current `now`
 * (Flow stays time-neutral: it picks `now`, Surface does the freshness math).
 *
 * - Updates `entry.bundle_report` to the LIVE report so gate evaluation sees
 *   freshness as of this evaluation, not as of attach time.
 * - Appends a frozen inquiry record (Surface DerivationCheckpoint) to
 *   `entry.inquiry_records` — the immutable audit series + the checkpoint that
 *   bounds the next re-derivation.
 * - Returns the freshness transitions observed since the prior checkpoint, so
 *   callers can react to fresh→stale without polling.
 *
 * Back-compat: a bundle with no freshness-bearing fields re-derives to the same
 * statuses every time, so this is a no-op for legacy bundles beyond appending
 * an identical inquiry record.
 */
export function reDeriveBundleReports(manifest: any, now: Date | string): MutableRecord[] {
  const exactNow = now instanceof Date ? now.toISOString() : now;
  if (parseRfc3339Timestamp(exactNow) === null) throw new Error("flow.rederive.now.invalid: now must be an RFC3339 date-time");
  const surfaceNow = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(surfaceNow.getTime())) throw new Error("flow.rederive.now.invalid: now must be an RFC3339 date-time");
  const transitions: MutableRecord[] = [];
  for (const entry of manifest.evidence ?? []) {
    if (entry.superseded_by) continue;
    if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") continue;
    const rawBundle = entry.bundle;
    if (!rawBundle) continue;
    let snapshot: any;
    try {
      snapshot = structuredClone(rawBundle);
    } catch {
      entry.bundle_report = null;
      continue;
    }
    if (!surfaceDerivationWithinBudget(snapshot)) {
      entry.bundle_report = null;
      continue; // reject an oversized raw attachment before schema validation
    }
    let validated: any;
    try {
      validated = validateTrustBundle(surfaceTimestampValidationView(snapshot));
    } catch {
      entry.bundle_report = null;
      continue; // leave invalid bundles for the gate diagnostics to report
    }
    if (!surfaceDerivationWithinBudget(validated)) {
      entry.bundle_report = null;
      continue; // avoid an unbounded Surface fold on an adversarial attachment
    }
    const priorRecords: any[] = Array.isArray(entry.inquiry_records) ? entry.inquiry_records : [];
    const since = priorRecords.length > 0 ? priorRecords[priorRecords.length - 1] : undefined;
    const checkpointAsOf = since && parseRfc3339Timestamp(since.asOf);
    const timestamps = [
      ...(validated.claims ?? []).flatMap((claim: any) => [claim.createdAt, claim.updatedAt]),
      ...(validated.events ?? []).flatMap((event: any) => [event.createdAt, event.verifiedAt]),
      ...(validated.evidence ?? []).map((evidence: any) => evidence.observedAt),
      ...(validated.authorityTrace ?? []).map((trace: any) => trace.observedAt)
    ];
    // A prior exact fail-closed report may have seen facts that had not yet
    // occurred. Surface checkpoints only replay event tails, so reuse would
    // preserve that transient status forever. Once time has crossed any such
    // fact, force one full public Surface fold while retaining the truthful
    // exact checkpoint in the immutable inquiry series.
    const requiresFullRefold = checkpointAsOf
      && timestamps.some((value) => {
        const timestamp = parseRfc3339Timestamp(value);
        return timestamp !== null && compareRfc3339Timestamps(timestamp, checkpointAsOf) > 0;
      });
    let liveReport: any;
    try {
      const surfaceReport = buildTrustReport(validated, since && !requiresFullRefold ? { now: surfaceNow, since } : { now: surfaceNow });
      const reconciled = reconcileSurfaceBundleReport(validated, surfaceReport, exactNow);
      liveReport = reconciled.report;
    } catch {
      continue;
    }
    // Emit freshness transitions vs the prior checkpoint before overwriting it.
    if (since) {
      for (const transition of diffFreshness(since, liveReport)) {
        transitions.push({ evidence_id: entry.id, ...transition });
      }
    }
    entry.bundle_report = liveReport;
    entry.inquiry_records = [...priorRecords, checkpointFromReport(liveReport)];
  }
  return transitions;
}

function claimMatchesSelector(claim: any, selector: any) {
  return claim?.claimType === selector?.claimType
    && (!selector.subjectType || claim.subjectType === selector.subjectType)
    && (!selector.subjectId || claim.subjectId === selector.subjectId);
}

function evidenceWasSelected(outcome: any, evidenceId: string) {
  const matchedEvidenceRefs = (outcome.matched_expectations ?? [])
    .map((match: any) => match.evidence_id)
    .filter(Boolean);
  return (matchedEvidenceRefs.length ? matchedEvidenceRefs : outcome.evidence_refs ?? []).includes(evidenceId);
}

function staleGateRechecks(definition: any, state: any, manifest: any, freshnessTransitions: MutableRecord[], config: MutableRecord) {
  const evidenceById = new Map<string, any>((manifest.evidence ?? []).map((entry: any): [string, any] => [entry.id, entry]));
  const passedOutcomes = new Map<string, any>(
    (state.gate_outcomes ?? [])
      .filter((outcome: any) => outcome.status === "pass")
      .map((outcome: any): [string, any] => [outcome.gate_id, outcome])
  );
  const candidates = new Map<string, MutableRecord>();

  for (const transition of [...(state.pending_gate_rechecks ?? []), ...freshnessTransitions]) {
    if (transition.to !== "stale") continue;
    const entry = evidenceById.get(transition.evidence_id);
    const gateId = entry?.gate_id;
    const passedOutcome = passedOutcomes.get(gateId);
    if (!gateId || !passedOutcome || !evidenceWasSelected(passedOutcome, entry.id)) continue;

    const gate = findGate(definition, gateId);
    if (!gate) continue;

    const selectedClaim = entry.bundle_report?.claims?.find((claim: any) => claim.id === transition.claimId);
    const affectsExpectation = expectationsForGate(gate, config).some((expectation: any) => (
      expectation.kind === "trust.bundle"
      && claimMatchesSelector(selectedClaim, expectation.bundle_claim ?? expectation.claim)
    ));
    if (!affectsExpectation) continue;
    const key = `${gate.id}\u0000${transition.evidence_id}\u0000${transition.claimId}`;
    candidates.set(key, {
      gate_id: gate.id,
      evidence_id: transition.evidence_id,
      claimId: transition.claimId,
      from: transition.from,
      to: transition.to
    });
  }

  return [...candidates.values()];
}

/**
 * flow#202 — an explicitly requested gate is evaluated from the step the run is
 * actually on, never from a synthesised cursor.
 *
 * `evaluate --gate <g>` used to synthesise `{...state, current_step: g.step}`
 * before validating, so `validateRunTransition` compared the gate against
 * itself and the `jump.invalid` guard could never fire for the case it exists
 * to catch. The real cursor then advanced, and the run persisted a transition
 * naming a `from_step` it had never been on.
 *
 * Two off-current requests are legitimate and both are preserved:
 *
 *  - **Leaving a gateless step.** Flow allows steps with no gate, and
 *    `openGates` only ever returns the current step's gates, so naming a later
 *    gate is the ONLY way such a step is ever left
 *    (`examples/adversarial-pass-flow.json` is built this way). A gateless step
 *    imposes no check, so Flow walks the cursor forward through it and records
 *    that step's completion as its own honest `allowed` transition — the run
 *    really does move, rather than the record pretending it was already there.
 *  - **Re-appraising a step the run has already occupied.** A downstream gate
 *    can be explicitly re-evaluated to fail closed (a pending re-entry, a stale
 *    claim). That re-appraisal can only hold the cursor or move it backwards.
 *
 * What is refused is the request that would move the run FORWARD past a gate it
 * never evaluated. Flow does not offer a second way past such a gate:
 * `flow except` already records a bypass with a reason and an accepting
 * authority, and an unauthenticated jump would be strictly weaker than the
 * mechanism that already exists.
 */
function prepareOffCurrentGateEvaluation(definition: any, state: any, gate: any, at: string) {
  advanceThroughGatelessSteps(definition, state, gate, at);
  if (gate.step === state.current_step) return;
  if (occupiedSteps(definition, state).has(gate.step)) return;
  throw gateNotCurrentError(definition, state, gate);
}

/** Walk the cursor forward while only gateless steps separate it from `gate.step`. */
function advanceThroughGatelessSteps(definition: any, state: any, gate: any, at: string) {
  if (gate.step === state.current_step) return;
  const traversed: string[] = [];
  let cursor: string | null = state.current_step;
  const seen = new Set<string>();
  while (cursor && cursor !== gate.step && !seen.has(cursor)) {
    // A real gate stands between the cursor and the request. Do not advance;
    // the caller decides whether the request is a re-appraisal or a skip.
    if (gatesForStep(definition, cursor).length) return;
    seen.add(cursor);
    traversed.push(cursor);
    cursor = getStep(definition, cursor)?.next ?? null;
  }
  if (cursor !== gate.step) return;
  for (const step of traversed) {
    const next = getStep(definition, step)?.next ?? null;
    state.transitions.push({ from_step: step, to_step: next, status: "allowed", reason: "step has no gate", at });
    state.current_step = next;
  }
}

/**
 * A pass at an off-current gate would move the cursor to that gate's next edge,
 * carrying the run past every gate between here and there without evaluating
 * one of them. That is the #202 skip, and it is refused at the point the
 * outcome is known rather than guessed at beforehand.
 */
function assertOffCurrentOutcomeCannotAdvance(definition: any, state: any, gate: any, outcome: GateOutcome) {
  if (gate.step === state.current_step) return;
  if (outcome.status !== "pass") return;
  throw gateNotCurrentError(definition, state, gate);
}

function gateNotCurrentError(definition: any, state: any, gate: any) {
  const skipped = gatedStepsBetween(definition, state.current_step, gate.step);
  const detail = skipped.length
    ? `evaluating it would carry the run past the unevaluated gate(s) on: ${skipped.join(", ")}`
    : `"${gate.step}" is not a step this run has reached`;
  const error = new Error(
    `flow.evaluate.gate.not_current: gate "${gate.id}" belongs to step "${gate.step}" but the run is on "${state.current_step}"; ${detail}. `
    + `Evaluate the current step's gates, or record an accepted exception with "flow except" if a gate cannot be satisfied.`
  );
  (error as Error & { code?: string }).code = "flow.evaluate.gate.not_current";
  (error as Error & { skipped_steps?: string[] }).skipped_steps = skipped;
  return error;
}

/** Gated steps strictly between `from` and `to` along the definition's next edges. */
function gatedStepsBetween(definition: any, from: string, to: string): string[] {
  const between: string[] = [];
  let cursor: string | null = from;
  const seen = new Set<string>();
  while (cursor && cursor !== to && !seen.has(cursor)) {
    seen.add(cursor);
    if (gatesForStep(definition, cursor).length) between.push(cursor);
    cursor = getStep(definition, cursor)?.next ?? null;
  }
  return cursor === to ? between : [];
}

/**
 * The bounded ancestor-recheck cursor. Asserts the ancestry it depends on so
 * this helper cannot be reused to manufacture a forward jump.
 */
function ancestorRecheckState(definition: any, state: any, gate: any) {
  if (!descendantsOf(definition, gate.step).includes(state.current_step)) {
    throw new Error(
      `flow.transition.recheck.not_ancestor: gate "${gate.id}" at step "${gate.step}" is not an ancestor of the current step "${state.current_step}"`
    );
  }
  return { ...state, current_step: gate.step };
}

async function evaluateRunUnlocked(runId: string, options: MutableRecord = {}) {
  const run = await loadRun(runId, options.cwd);
  assertRunMutationLifecycleEligible("evaluate", run);
  // §1: re-derive freshness-bearing reports with the current `now` BEFORE
  // gates read them, so a claim that has gone stale flips the gate outcome.
  // The existing route-back cascade (invalidateDescendants) then clears any
  // downstream stale passes for free.
  if (typeof options.now !== "string" || parseRfc3339Timestamp(options.now) === null) {
    throw new Error("flow.evaluate.now.invalid: now must be an RFC3339 date-time");
  }
  const evaluationInstant = options.now;
  // Surface APIs accept Date; Flow retains `evaluationInstant` for every
  // chronology decision and persisted transition.
  const now = new Date(evaluationInstant);
  const freshnessTransitions = reDeriveBundleReports(run.manifest, evaluationInstant);
  // Re-verify each attached artifact's recorded sha256 against its copied file
  // BEFORE gate evaluation. The result annotates a transient clone only; the
  // persisted manifest never carries a computed integrity label.
  const integrityById = await evidenceIntegrityStatusById(run.manifest, run.dir);
  const evaluationManifest = manifestWithIntegrity(run.manifest, integrityById);
  const outcomes: GateOutcome[] = [];

  // A passed ancestor may become stale after the cursor has advanced. Queue
  // every affected gate before handling one route-back so simultaneous stale
  // branches are not lost when the first route changes the cursor.
  const pendingRechecks = staleGateRechecks(run.definition, run.state, run.manifest, freshnessTransitions, run.config);
  run.state.pending_gate_rechecks = pendingRechecks;
  const pendingByGate = new Map<string, MutableRecord[]>();
  for (const recheck of pendingRechecks) {
    const records = pendingByGate.get(recheck.gate_id) ?? [];
    records.push(recheck);
    pendingByGate.set(recheck.gate_id, records);
  }
  for (const gateId of Object.keys(run.definition.gates ?? {})) {
    const rechecks = pendingByGate.get(gateId);
    if (!rechecks?.length) continue;
    const gate = findGate(run.definition, gateId);
    if (!gate || !descendantsOf(run.definition, gate.step).includes(run.state.current_step)) continue;
    const outcome = evaluateGate(run.definition, run.state, evaluationManifest, gate.id, run.config, evaluationInstant);
    run.state.pending_gate_rechecks = run.state.pending_gate_rechecks.filter((entry: any) => entry.gate_id !== gate.id);
    if (outcome.status === "pass") continue;
    outcome.freshness_transitions = rechecks;
    // The ONLY place Flow validates against a cursor other than the real one,
    // and it is bounded: `gate.step` is a proven ancestor of `current_step`
    // (asserted above), the run genuinely occupied it, and the transition this
    // produces moves the cursor BACK to that ancestor. It is a re-appraisal of
    // a stage the run already passed, never a forward jump. `applyEvaluation`
    // re-checks the ancestry at write time.
    const validationState = ancestorRecheckState(run.definition, run.state, gate);
    const transitionValidation = validateEvaluationTransition(run.definition, validationState, evaluationManifest, outcome, run.config, evaluationInstant);
    if (transitionValidation.status === "invalid" || (outcome.status === "pass" && transitionValidation.valid !== true)) {
      const first = transitionValidation.diagnostics[0];
      throw new Error(`invalid Flow transition for ${outcome.gate_id}: ${first?.message ?? "transition validation failed"}`);
    }
    outcome.transition_validation = transitionValidation;
    if (outcome.status === "block") {
      const invalidated = invalidateDescendants(run.definition, run.state, gate.step);
      run.state.current_step = gate.step;
      outcome.invalidated_steps = invalidated.length ? invalidated : undefined;
    }
    mintGateEvaluation(run, outcome, evaluationInstant, "freshness");
    applyEvaluation(run.definition, run.state, outcome, evaluationInstant);
    const stillPassed = new Set(
      (run.state.gate_outcomes ?? [])
        .filter((entry: any) => entry.status === "pass")
        .map((entry: any) => entry.gate_id)
    );
    run.state.pending_gate_rechecks = run.state.pending_gate_rechecks.filter((entry: any) => stillPassed.has(entry.gate_id));
    outcomes.push(outcome);
    break;
  }

  if (!outcomes.length) {
    const gates = options.gate ? [findGate(run.definition, options.gate)] : openGates(run.definition, run.state);
    if (!gates.length || gates.some((gate) => !gate)) throw new Error(options.gate ? `unknown gate: ${options.gate}` : "no gate for current step");
    if (options.gate) prepareOffCurrentGateEvaluation(run.definition, run.state, gates[0], evaluationInstant);
    for (const gate of gates) {
      const outcome = evaluateGate(run.definition, run.state, evaluationManifest, gate.id, run.config, evaluationInstant);
      if (options.gate) assertOffCurrentOutcomeCannotAdvance(run.definition, run.state, gate, outcome);
      // No synthesised cursor: the jump guard in `validateRunTransition` sees
      // the run's real state and can fire for the case it exists to catch.
      const transitionValidation = validateEvaluationTransition(run.definition, run.state, evaluationManifest, outcome, run.config, evaluationInstant);
      if (transitionValidation.status === "invalid" || (outcome.status === "pass" && transitionValidation.valid !== true)) {
        const first = transitionValidation.diagnostics[0];
        throw new Error(`invalid Flow transition for ${outcome.gate_id}: ${first?.message ?? "transition validation failed"}`);
      }
      outcome.transition_validation = transitionValidation;
      mintGateEvaluation(run, outcome, evaluationInstant, "ordinary");
      applyEvaluation(run.definition, run.state, outcome, evaluationInstant);
      outcomes.push(outcome);
      if (outcome.status !== "pass") break;
    }
  }
  await saveRun(run);
  return { ...run, outcomes, freshness_transitions: freshnessTransitions };
}

export async function evaluateRun(runId: string, options: MutableRecord = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const now = options.now === undefined ? new Date().toISOString() : options.now;
  if (typeof now !== "string" || parseRfc3339Timestamp(now) === null) throw new Error("flow.evaluate.now.invalid: now must be an RFC3339 date-time");
  await preflightRunMutationLifecycle(runId, cwd, "evaluate");
  return withRunMutationLock(runId, cwd, () => evaluateRunUnlocked(runId, { ...options, cwd, now }));
}

async function acceptExceptionUnlocked(runId, options) {
  const run = await loadRun(runId, options.cwd);
  assertLifecycleEligible("accept_exception", run.state.status);
  const gate = findGate(run.definition, options.gate);
  if (!gate) throw new Error(`unknown gate: ${options.gate}`);
  const exception = {
    id: `ex.${Date.now()}.${run.state.exceptions.length + 1}`,
    gate_id: options.gate,
    reason: options.reason,
    authority: options.authority,
    accepted_at: new Date().toISOString()
  };
  run.state.exceptions.push(exception);
  // Only flip the run status when the exception applies to the current step.
  // An exception for a gate the run has not reached is pending — it is
  // recorded and will take effect when the run evaluates that gate, but it
  // must not misreport the run's present state as accepted_by_exception (#212).
  const isCurrentGate = gate.step === run.state.current_step;
  if (isCurrentGate) {
    run.state.status = "accepted_by_exception";
    run.state.next_action = `evaluate ${slugLabel(options.gate)} with accepted exception`;
  }
  await saveRun(run);
  return exception;
}

export function acceptException(runId, options) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  return withRunMutationLock(runId, cwd, () => acceptExceptionUnlocked(runId, { ...options, cwd }));
}

export async function listRuns(cwd = process.cwd()) {
  return (await listRunsWithDiagnostics(cwd)).runs;
}

export async function listRunsWithDiagnostics(cwd = process.cwd()) {
  const ids = new Set<string>();
  if (await inspectRuntimeRoot("*", cwd)) {
    const root = flowRunsRoot(cwd);
    try {
      for (const id of await readdir(root)) ids.add(id);
    } catch (error) {
      if (!isMissingPathError(error)) throw inspectionError("*", root, error);
    }
  }

  const runs: MutableRecord[] = [];
  const diagnostics: RunLocationDiagnostic[] = [];
  for (const id of [...ids].sort((left, right) => left.localeCompare(right))) {
    try {
      const run = await loadRun(id, cwd);
      runs.push({
        run_id: id,
        definition_id: run.state.definition_id,
        subject: run.state.subject,
        status: run.state.status,
        current_step: run.state.current_step,
        updated_at: run.state.updated_at
      });
      diagnostics.push(...run.diagnostics);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      diagnostics.push(runLocationDiagnostic(
        code ?? "flow.run_location.no_complete_candidate",
        "error",
        id,
        error instanceof Error ? error.message : String(error)
      ));
    }
  }
  runs.sort((left, right) => {
    const updated = String(right.updated_at).localeCompare(String(left.updated_at));
    return updated || String(left.run_id).localeCompare(String(right.run_id));
  });
  diagnostics.sort((left, right) =>
    String(left.run_id).localeCompare(String(right.run_id)) ||
    left.code.localeCompare(right.code)
  );
  return { runs, diagnostics };
}
