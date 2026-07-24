import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { readFile, readdir, lstat, open, writeFile, mkdir, rename, rm, link } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
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
  readJson,
  runDir,
  writeJson
} from "./flow-files.js";
import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type { FlowDefinitionAmendmentEvent, FlowDefinitionAmendmentRequest, FlowDefinitionAmendmentResult, FlowEvidenceEntry, FlowLifecycleAction, FlowLifecycleEvent, FlowPausedGateContinuationOptions, FlowPausedGateContinuationResult, FlowRetryAuthorizationRequest, FlowRetryAuthorizationResult, FlowRetryAuthorizationTransition, FlowRunState, GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import { loadFlowConfig, defaultFlowConfig } from "../config/flow-config.js";
import {
  findGate,
  initialState,
  normalizeRunStateLifecycle,
  openGates,
  nextActionForStep,
  descendantsOf,
  invalidateDescendants,
  validateDefinition
} from "../definition/flow-definition.js";
import { applyEvaluation, evaluateGate, expectationsForGate } from "../gates/flow-gates.js";
import { validateEvaluationTransition } from "../transition/flow-evaluation-transition.js";
import { renderAndWriteReport, renderMarkdownReport, reportJson } from "../reports/flow-reports.js";
import { validateEvidenceManifestSchema, validateRunStateSchema } from "./flow-run-validator.js";
import { isNonEmptyString, isObject, normalizeEvidenceKind, slugLabel } from "../shared/flow-utils.js";
import { parseRfc3339Timestamp, surfaceTimestampValidationView } from "../shared/rfc3339.js";
import { buildTrustReport, validateTrustBundle, checkpointFromReport, diffFreshness } from "@kontourai/surface";
import { validateTrustBundleSchema } from "../gates/trust-bundle-validator.js";
import {
  FlowLifecycleError,
  assertLifecycleEligible,
  lifecycleRequestMatches,
  priorResumableStatus,
  validateLifecycleRequest
} from "./flow-run-lifecycle.js";
import {
  FlowRetryAuthorizationError,
  flowRunHead,
  flowTransitionRef,
  retryAuthorizationMatches,
  validateRetryAuthorizationRequest
} from "./flow-run-retry-authorization.js";
import { exhaustedRouteBackProof, validateRetryAuthorizationHistory } from "./flow-run-retry-proof.js";
import { normalizeTrustAttachmentBundle, reduceTrustAttachmentManifest, type TrustAttachmentReducerDependencies } from "./trust-attachment-reducer.js";
import {
  assertRunRecoveryFenceOpen,
  inspectRunRecoveryFence,
  publishOpenRunRecoveryFence,
  type FlowRunRecoveryFenceFinalizeRequest,
  withRunRecoveryFenceRead
} from "./flow-run-recovery-fence.js";

/**
 * Flow's adapter for the exact locked dependency APIs. The pure reducer accepts
 * this as data so a coordinator can pin its own artifact and dependencies.
 */
export const FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES: TrustAttachmentReducerDependencies = {
  hachure: { package: "hachure", version: "0.15.0", validate: validateTrustBundleSchema },
  surface: {
    package: "@kontourai/surface",
    version: "2.12.0",
    validate: (bundle) => validateTrustBundle(bundle) as MutableRecord,
    buildReport: (bundle, options) => buildTrustReport(bundle as any, options) as MutableRecord
  }
};
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
  validateRunStateSchema(stateValue);
  const state = normalizeRunStateLifecycle(stateValue);
  const definition = resolveEffectiveDefinition(startDefinition, state);
  validateRunStateIdentity(definition, state, options.runId ?? state.run_id);
  validateRetryAuthorizationHistory(definition, state);
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
  await writeJson(path.join(dir, FLOW_RUN_DEFINITION_FILE), definition);
  await writeJson(path.join(dir, FLOW_RUN_STATE_FILE), state);
  await writeJson(path.join(dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH), manifest);
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
  for (const target of targets) {
    try {
      if (await readExistingFileNoFollow(target.path) === target.contents) continue;
      await writeExistingFileNoFollow(target.path, target.contents);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      try {
        await createFileNoFollow(target.path, target.contents);
      } catch (createError) {
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") throw createError;
        await writeExistingFileNoFollow(target.path, target.contents);
      }
    }
  }
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

async function createFileNoFollow(file: string, contents: string) {
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(contents, "utf8");
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
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateRetryAuthorizationHistory(run.definition, run.state);
  validateEvidenceManifestIdentity(run.manifest, run.startDefinition ?? run.definition, run.state);
  await Promise.all([
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_STATE_FILE),
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH),
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson),
    assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown)
  ]);
  await writeJson(path.join(run.dir, FLOW_RUN_STATE_FILE), run.state);
  await writeJson(path.join(run.dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH), run.manifest);
  await renderAndWriteReport(run.definition, run.state, run.manifest, run.dir);
}

async function writeExistingFileNoFollow(file: string, contents: string) {
  const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const target = await handle.stat();
    if (!target.isFile()) throw new Error(`flow.run_location.invalid_artifact_path: ${file} is not a regular file`);
    await handle.truncate(0);
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
}

async function saveLifecycleState(run) {
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateEvidenceManifestIdentity(run.manifest, run.startDefinition ?? run.definition, run.state);
  const statePath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_STATE_FILE);
  const reportJsonPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson);
  const reportMarkdownPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown);
  const projectedJson = reportJson(run.definition, run.state, run.manifest);
  const projectedMarkdown = renderMarkdownReport(run.definition, run.state, run.manifest);
  const serializedState = `${JSON.stringify(run.state, null, 2)}\n`;
  const serializedReport = `${JSON.stringify(projectedJson, null, 2)}\n`;
  await writeExistingFileNoFollow(statePath, serializedState);
  await writeExistingFileNoFollow(reportJsonPath, serializedReport);
  await writeExistingFileNoFollow(reportMarkdownPath, projectedMarkdown);
}

function lifecycleTimestamp(options: MutableRecord, operation: FlowLifecycleAction) {
  const timestamp = options.at ?? new Date().toISOString();
  if (!isNonEmptyString(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new FlowLifecycleError({
      code: "flow.lifecycle.request.invalid",
      severity: "error",
      path: "$.at",
      message: "at must be a date-time when provided",
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

export type RunMutationLockHooks = {
  afterReleaseQuarantine?: (releasedPath: string) => Promise<void> | void;
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
    await rm(ticketPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { ticketName, ticketPath };
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
    if (mutationLockOwnerIsStale(owner)) {
      await rm(ticketPath, { recursive: true, force: true });
    } else {
      live.push({ name: entry.name, path: ticketPath, owner });
    }
  }
  return live;
}

async function awaitMutationTicket(lockRoot: string, ticketName: string, ticketPath: string, owner: MutationLockOwner) {
  await delay(25);
  for (let attempt = 0; ; attempt += 1) {
    const live = await scanLiveMutationTickets(lockRoot);
    const holding = live.find((entry) => entry.owner.status === "holding");
    const first = [...live].sort((left, right) => left.name.localeCompare(right.name))[0];
    if ((!holding || holding.owner.token === owner.token) && first?.owner.token === owner.token) {
      await publishMutationLockOwner(ticketPath, { ...owner, status: "holding" });
      return;
    }
    if (attempt >= 500) {
      throw runLocationError("flow.run_mutation.lock.timeout", "timed out waiting for the shared run mutation lock");
    }
    await delay(10);
  }
}

async function releaseMutationTicket(lockRoot: string, ticketPath: string, owner: MutationLockOwner, hooks: RunMutationLockHooks) {
  const releasedPath = path.join(lockRoot, `released-${owner.token}`);
  let quarantined = false;
  try {
    await rename(ticketPath, releasedPath);
    quarantined = true;
  } catch {
    await publishMutationLockOwner(ticketPath, { ...owner, status: "released", released_at: new Date().toISOString() }).catch(() => undefined);
  }
  try {
    if (quarantined) await hooks.afterReleaseQuarantine?.(releasedPath);
  } finally {
    activeMutationLockTokens.delete(owner.token);
    if (quarantined) await rm(releasedPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function withRunMutationLockCheck<T>(
  runId: string,
  cwd: string,
  operation: () => Promise<T>,
  hooks: RunMutationLockHooks,
  afterAcquire: () => Promise<void>
): Promise<T> {
  const location = await resolveRunLocation(runId, cwd);
  const token = randomUUID();
  const owner: MutationLockOwner = { token, pid: process.pid, host: hostname(), status: "active", created_at: new Date().toISOString() };
  const lockRoot = await prepareMutationLockRoot(location.dir);
  activeMutationLockTokens.add(token);
  let ticketPath: string | undefined;
  try {
    const ticket = await publishMutationTicket(lockRoot, owner);
    ticketPath = ticket.ticketPath;
    await awaitMutationTicket(lockRoot, ticket.ticketName, ticket.ticketPath, owner);
    await afterAcquire();
    return await operation();
  } catch (error) {
    activeMutationLockTokens.delete(token);
    if (ticketPath) await rm(ticketPath, { recursive: true, force: true }).catch(() => undefined);
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
  for (;;) {
    try {
      return await withRunMutationLockCheck(
        runId,
        cwd,
        operation,
        hooks,
        async () => {
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
            await assertRunRecoveryFenceOpen(runId, cwd);
          }
          const expected = awaitedRecovery;
          if (expected !== null && (
            observed.status !== "open"
            || observed.fence.recovery_id !== expected.fence.recovery_id
            || observed.directory.device !== expected.directory.device
            || observed.directory.inode !== expected.directory.inode
          )) {
            throw runLocationError(
              "flow.run_recovery.changed",
              `recovery fence for run "${runId}" did not publish the expected open successor`
            );
          }
        }
      );
    } catch (error) {
      if ((error as { code?: unknown })?.code !== "flow.run_recovery.active") throw error;
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
  cwd = process.cwd()
) {
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
    const opened = await publishOpenRunRecoveryFence(runId, {
      protocol: activeBefore.fence.protocol,
      run_id: runId,
      recovery_id: request.recovery_id,
      status: "open",
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

async function saveRetryAuthorizationState(run: any) {
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateRetryAuthorizationHistory(run.definition, run.state);
  validateEvidenceManifestIdentity(run.manifest, run.startDefinition ?? run.definition, run.state);
  const statePath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_STATE_FILE);
  const reportJsonPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportJson);
  const reportMarkdownPath = await assertSafeRunArtifactWritePath(run.dir, FLOW_RUN_LAYOUT.reportMarkdown);
  const suffix = `.retry-${randomUUID()}.tmp`;
  const staged = [
    { target: reportJsonPath, temp: `${reportJsonPath}${suffix}`, contents: `${JSON.stringify(reportJson(run.definition, run.state, run.manifest), null, 2)}\n` },
    { target: reportMarkdownPath, temp: `${reportMarkdownPath}${suffix}`, contents: renderMarkdownReport(run.definition, run.state, run.manifest) },
    { target: statePath, temp: `${statePath}${suffix}`, contents: `${JSON.stringify(run.state, null, 2)}\n` }
  ];
  const priorReports = [
    { target: reportJsonPath, contents: await readFile(reportJsonPath, "utf8") },
    { target: reportMarkdownPath, contents: await readFile(reportMarkdownPath, "utf8") }
  ];
  let committed = false;
  try {
    for (const entry of staged) await writeFile(entry.temp, entry.contents, { flag: "wx", mode: 0o600 });
    // Derived projections land first. state.json is the final atomic commit point.
    for (const entry of staged) await rename(entry.temp, entry.target);
    committed = true;
  } catch (error) {
    if (!committed) {
      // A normal I/O failure before the state commit restores both derived
      // projections to the prior authoritative state. Crash recovery still
      // treats state.json as the commit point and regenerates projections.
      await Promise.all(priorReports.map((entry) => writeExistingFileNoFollow(entry.target, entry.contents)));
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
    if (!stateCommitted) await Promise.all(priorReports.map((entry) => writeExistingFileNoFollow(entry.target, entry.contents)));
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
  const requestValue = options.request ?? Object.fromEntries(Object.entries(options).filter(([key]) => key !== "cwd"));
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
    await saveRetryAuthorizationState(run);
    return { ...run, transition, idempotent: false };
  });
}

export async function sha256File(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Normalize and validate a Hachure TrustBundle, returning the bundle and its
 * derived TrustReport. Throws on invalid bundle.
 */
export function normalizeTrustBundle(raw: unknown): { bundle: any; bundle_report: any } {
  return normalizeTrustAttachmentBundle(raw, new Date().toISOString(), FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES);
}

async function attachEvidenceUnlocked(runId: string, options: MutableRecord): Promise<FlowEvidenceEntry> {
  const run = await loadRun(runId, options.cwd);
  if (options.expectedRunHead !== undefined && flowRunHead(run.state) !== options.expectedRunHead) {
    throw new Error("flow.run_head.stale: expectedRunHead does not match the current run state");
  }
  assertRunMutationLifecycleEligible("attach_evidence", run);
  const prepared = await prepareEvidenceAttachment(run, options, { normalizeBundle: normalizeTrustBundle, attachedAt: () => new Date() });
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

export function attachEvidence(runId: string, options: MutableRecord): Promise<FlowEvidenceEntry> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let expectedRunHead: string | undefined;
  if (options.expectedRunHead !== undefined) {
    if (typeof options.expectedRunHead !== "string" || !/^[a-f0-9]{64}$/i.test(options.expectedRunHead)) {
      throw new Error("flow.run_head.invalid: expectedRunHead must be a SHA-256 hex digest");
    }
    expectedRunHead = options.expectedRunHead.toLowerCase();
  }
  return preflightRunMutationLifecycle(runId, cwd, "attach_evidence")
    .then(() => withRunMutationLock(runId, cwd, () => attachEvidenceUnlocked(runId, { ...options, cwd, expectedRunHead })));
}

type PreparedEvidenceAttachment = {
  evidence: FlowEvidenceEntry;
  nextManifest: MutableRecord;
  sourceBytes: Buffer;
  storedPath: string;
};

type EvidencePreparation = {
  normalizeBundle: (raw: unknown) => { bundle: any; bundle_report: any };
  attachedAt: () => Date;
};

function continuationNow(value: unknown) {
  if (value !== undefined && (typeof value !== "string" || !isNonEmptyString(value) || !Number.isFinite(Date.parse(value)))) {
    throw new Error("flow.paused_gate_continuation.request.invalid: now must be a date-time when provided");
  }
  const now = value === undefined ? new Date() : new Date(value as string);
  return now;
}

function pausedGateContinuationRequest(options: FlowPausedGateContinuationOptions) {
  if (typeof options.expectedRunHead !== "string" || !/^[a-f0-9]{64}$/i.test(options.expectedRunHead)) {
    throw new Error("flow.run_head.invalid: expectedRunHead must be a SHA-256 hex digest");
  }
  if (!isNonEmptyString(options.gate)) {
    throw new Error("flow.paused_gate_continuation.request.invalid: gate must be a non-empty string");
  }
  if (!isObject(options.evidence) || !isNonEmptyString(options.evidence.file)) {
    throw new Error("flow.paused_gate_continuation.request.invalid: evidence.file must be a non-empty string");
  }
  if (typeof options.resumeOnPass !== "boolean") {
    throw new Error("flow.paused_gate_continuation.request.invalid: resumeOnPass must be a boolean");
  }
  if (options.resumeOnPass && !options.resume) {
    throw new Error("flow.paused_gate_continuation.request.invalid: resume is required when resumeOnPass is true");
  }
  if (!options.resumeOnPass && options.resume !== undefined) {
    throw new Error("flow.paused_gate_continuation.request.invalid: resume is only allowed when resumeOnPass is true");
  }
  const now = continuationNow(options.now);
  const resumeOptions = options.resumeOnPass && options.resume!.at === undefined
    ? { ...options.resume!, at: now.toISOString() }
    : options.resume;
  const resume = options.resumeOnPass
    ? { request: validateLifecycleRequest("resume", { reason: resumeOptions!.reason, authority: resumeOptions!.authority }), at: lifecycleTimestamp(resumeOptions!, "resume") }
    : undefined;
  if (resume && Date.parse(resume.at) > now.getTime()) {
    throw new Error("flow.paused_gate_continuation.request.invalid: resume.at must not follow evaluation now");
  }
  return {
    cwd: path.resolve(options.cwd ?? process.cwd()),
    expectedRunHead: options.expectedRunHead.toLowerCase(),
    gate: options.gate,
    evidence: options.evidence,
    resumeOnPass: options.resumeOnPass,
    resume,
    now
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

async function prepareEvidenceAttachment(run: Awaited<ReturnType<typeof loadRun>>, options: MutableRecord, preparation: EvidencePreparation): Promise<PreparedEvidenceAttachment> {
  if (!findGate(run.definition, options.gate)) throw new Error(`unknown gate: ${options.gate}`);
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
    attached_at: preparation.attachedAt().toISOString()
  };
  if (normalizedBundle) {
    evidence.kind = "trust.bundle";
    evidence.requested_kind = "trust.bundle";
    evidence.bundle = normalizedBundle.bundle;
    evidence.bundle_report = normalizedBundle.bundle_report;
  }
  if (options.producer) evidence.producer = options.producer;
  if (options.authorityTrace) evidence.authority_trace = options.authorityTrace;
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
  const outcome = evaluateGate(run.definition, state, manifest, request.gate, run.config);
  const validation = validateEvaluationTransition(run.definition, state, manifest, outcome, run.config, request.now.toISOString());
  if (validation.status === "invalid") throw new Error(`invalid Flow transition for ${outcome.gate_id}: ${validation.diagnostics[0]?.message ?? "transition validation failed"}`);
  outcome.transition_validation = validation;
  applyEvaluation(run.definition, state, outcome, request.now.toISOString());
  return outcome;
}

/** Atomically continue a paused current gate; every non-commit result is dry. */
export async function continuePausedGate(runId: string, options: FlowPausedGateContinuationOptions): Promise<FlowPausedGateContinuationResult> {
  const request = pausedGateContinuationRequest(options);
  return withRunMutationLock(runId, request.cwd, async () => {
    const run = await loadRun(runId, request.cwd);
    assertPausedContinuation(run, request);
    const prepared = await prepareEvidenceAttachment(run, { ...request.evidence, cwd: request.cwd, gate: request.gate }, { normalizeBundle: (raw) => normalizeTrustAttachmentBundle(raw, request.now.toISOString(), FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES), attachedAt: () => request.now });
    const manifest = structuredClone(prepared.nextManifest) as MutableRecord;
    const rechecks = blockingFreshnessRechecks(run.definition, run.state.current_step, staleGateRechecks(run.definition, run.state, manifest, reDeriveBundleReports(manifest, request.now), run.config));
    if (rechecks.length) return { committed: false, outcomes: [staleContinuationOutcome(request.gate, rechecks)], run };
    const { nextState, event } = resumedContinuationState(run.state, request);
    if (request.resumeOnPass) validateRunStateConsistency(run.startDefinition, nextState, { runId });
    const outcome = evaluatePausedContinuation(run, nextState, manifest, request);
    if (outcome.status !== "pass" || !request.resumeOnPass) return { committed: false, outcomes: [outcome], run };
    const committedRun = { ...run, state: nextState, manifest };
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
export function reDeriveBundleReports(manifest: any, now: Date): MutableRecord[] {
  const transitions: MutableRecord[] = [];
  for (const entry of manifest.evidence ?? []) {
    if (entry.superseded_by) continue;
    if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") continue;
    if (!entry.bundle) continue;
    let validated: any;
    try {
      validated = validateTrustBundle(surfaceTimestampValidationView(entry.bundle));
    } catch {
      entry.bundle_report = null;
      continue; // leave invalid bundles for the gate diagnostics to report
    }
    const priorRecords: any[] = Array.isArray(entry.inquiry_records) ? entry.inquiry_records : [];
    const since = priorRecords.length > 0 ? priorRecords[priorRecords.length - 1] : undefined;
    let liveReport: any;
    try {
      liveReport = buildTrustReport(validated, since ? { now, since } : { now });
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

async function evaluateRunUnlocked(runId: string, options: MutableRecord = {}) {
  const run = await loadRun(runId, options.cwd);
  assertRunMutationLifecycleEligible("evaluate", run);
  // §1: re-derive freshness-bearing reports with the current `now` BEFORE
  // gates read them, so a claim that has gone stale flips the gate outcome.
  // The existing route-back cascade (invalidateDescendants) then clears any
  // downstream stale passes for free.
  const now = options.now ? new Date(options.now) : new Date();
  const freshnessTransitions = reDeriveBundleReports(run.manifest, now);
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
    const outcome = evaluateGate(run.definition, run.state, run.manifest, gate.id, run.config);
    run.state.pending_gate_rechecks = run.state.pending_gate_rechecks.filter((entry: any) => entry.gate_id !== gate.id);
    if (outcome.status === "pass") continue;
    outcome.freshness_transitions = rechecks;
    const validationState = { ...run.state, current_step: gate.step };
    const transitionValidation = validateEvaluationTransition(run.definition, validationState, run.manifest, outcome, run.config, now.toISOString());
    if (transitionValidation.status === "invalid") {
      const first = transitionValidation.diagnostics[0];
      throw new Error(`invalid Flow transition for ${outcome.gate_id}: ${first?.message ?? "transition validation failed"}`);
    }
    outcome.transition_validation = transitionValidation;
    if (outcome.status === "block") {
      const invalidated = invalidateDescendants(run.definition, run.state, gate.step);
      run.state.current_step = gate.step;
      outcome.invalidated_steps = invalidated.length ? invalidated : undefined;
    }
    applyEvaluation(run.definition, run.state, outcome, now.toISOString());
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
    for (const gate of gates) {
      const outcome = evaluateGate(run.definition, run.state, run.manifest, gate.id, run.config);
      const validationState = options.gate && gate.step !== run.state.current_step
        ? { ...run.state, current_step: gate.step }
        : run.state;
      const transitionValidation = validateEvaluationTransition(run.definition, validationState, run.manifest, outcome, run.config, now.toISOString());
      if (transitionValidation.status === "invalid") {
        const first = transitionValidation.diagnostics[0];
        throw new Error(`invalid Flow transition for ${outcome.gate_id}: ${first?.message ?? "transition validation failed"}`);
      }
      outcome.transition_validation = transitionValidation;
      applyEvaluation(run.definition, run.state, outcome, now.toISOString());
      outcomes.push(outcome);
      if (outcome.status !== "pass") break;
    }
  }
  await saveRun(run);
  return { ...run, outcomes, freshness_transitions: freshnessTransitions };
}

export async function evaluateRun(runId: string, options: MutableRecord = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  await preflightRunMutationLifecycle(runId, cwd, "evaluate");
  return withRunMutationLock(runId, cwd, () => evaluateRunUnlocked(runId, { ...options, cwd }));
}

async function acceptExceptionUnlocked(runId, options) {
  const run = await loadRun(runId, options.cwd);
  assertLifecycleEligible("accept_exception", run.state.status);
  if (!findGate(run.definition, options.gate)) throw new Error(`unknown gate: ${options.gate}`);
  const exception = {
    id: `ex.${Date.now()}.${run.state.exceptions.length + 1}`,
    gate_id: options.gate,
    reason: options.reason,
    authority: options.authority,
    accepted_at: new Date().toISOString()
  };
  run.state.exceptions.push(exception);
  run.state.status = "accepted_by_exception";
  run.state.next_action = `evaluate ${slugLabel(options.gate)} with accepted exception`;
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
