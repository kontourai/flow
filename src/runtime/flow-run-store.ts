import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { readFile, readdir, lstat, open, stat, writeFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

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
import type { FlowEvidenceEntry, FlowLifecycleAction, FlowLifecycleEvent, FlowRunState, GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import { loadFlowConfig, defaultFlowConfig } from "../config/flow-config.js";
import {
  findGate,
  initialState,
  normalizeRunStateLifecycle,
  openGates,
  validateDefinition
} from "../definition/flow-definition.js";
import { applyEvaluation, evaluateGate } from "../gates/flow-gates.js";
import { validateEvaluationTransition } from "../transition/flow-evaluation-transition.js";
import { renderAndWriteReport, renderMarkdownReport, reportJson } from "../reports/flow-reports.js";
import { validateEvidenceManifestSchema, validateRunStateSchema } from "./flow-run-validator.js";
import { isNonEmptyString, isObject, normalizeEvidenceKind, slugLabel } from "../shared/flow-utils.js";
import { buildTrustReport, validateTrustBundle, checkpointFromReport, diffFreshness } from "@kontourai/surface";
import { validateTrustBundleSchema } from "../gates/trust-bundle-validator.js";
import {
  FlowLifecycleError,
  assertLifecycleEligible,
  lifecycleRequestMatches,
  priorResumableStatus,
  validateLifecycleRequest
} from "./flow-run-lifecycle.js";

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
    validateRunStateSchema(stateResult.value);
    validateRunStateIdentity(definition, stateResult.value, runId);
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
  const state = initialState(definition, runId, options.params ?? {});
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
  const definition = validateDefinition(rawDefinition);
  const parsedState = await readJson(path.join(dir, FLOW_RUN_STATE_FILE));
  validateRunStateSchema(parsedState);
  const state = normalizeRunStateLifecycle(parsedState);
  validateRunStateIdentity(definition, state, runId);
  const config = await loadFlowConfig(cwd);
  const manifestPath = path.join(dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const manifest = existsSync(manifestPath)
    ? validateEvidenceManifestIdentity(await readJson(manifestPath), definition, state)
    : initialEvidenceManifest(definition, state);
  const run = { dir, definition, state, manifest, config, diagnostics: location.diagnostics };
  resolvedRunContexts.set(run, { cwd: path.resolve(cwd) });
  return run;
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

export async function validateResolvedRunDirectory(runId: string, dir: string, cwd?: string) {
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

export async function loadRunAtResolvedLocation(runId: string, dir: string, cwd = process.cwd()) {
  const location = await validateResolvedRunDirectory(runId, dir, cwd);
  return readRunAtLocation(runId, location, cwd);
}

export async function loadRun(runId, cwd = process.cwd()) {
  const location = await resolveRunLocation(runId, cwd);
  return readRunAtLocation(runId, location, cwd);
}

async function saveRun(run) {
  const context = resolvedRunContexts.get(run) ?? inferResolvedRunContext(run.state.run_id, run.dir);
  await validateResolvedRunDirectory(run.state.run_id, run.dir, context.cwd);
  validateRunStateSchema(run.state);
  validateRunStateIdentity(run.definition, run.state, run.state.run_id);
  validateEvidenceManifestIdentity(run.manifest, run.definition, run.state);
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
  validateEvidenceManifestIdentity(run.manifest, run.definition, run.state);
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
  const run = await loadRun(runId, options.cwd);
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

export async function sha256File(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Normalize and validate a Hachure TrustBundle, returning the bundle and its
 * derived TrustReport. Throws on invalid bundle.
 */
export function normalizeTrustBundle(raw: unknown): { bundle: any; bundle_report: any } {
  if (!isObject(raw)) throw new Error("trust bundle must be a JSON object");

  // JSON Schema validation via Hachure
  const schemaResult = validateTrustBundleSchema(raw);
  if (!schemaResult.valid) {
    throw new Error(`trust bundle does not conform to Hachure schema: ${schemaResult.errors.slice(0, 3).join("; ")}`);
  }

  // Surface structural validation + status derivation
  let bundle: any;
  try {
    bundle = validateTrustBundle(raw);
  } catch (err: any) {
    throw new Error(`trust bundle validation failed: ${err?.message ?? String(err)}`);
  }

  let bundle_report: any;
  try {
    bundle_report = buildTrustReport(bundle);
  } catch (err: any) {
    throw new Error(`trust bundle status derivation failed: ${err?.message ?? String(err)}`);
  }

  return { bundle, bundle_report };
}

export async function attachEvidence(runId: string, options: MutableRecord): Promise<FlowEvidenceEntry> {
  const run = await loadRun(runId, options.cwd);
  assertLifecycleEligible("attach_evidence", run.state.status);
  const source = path.resolve(options.cwd ?? process.cwd(), options.file);
  await stat(source);
  const gate = findGate(run.definition, options.gate);
  if (!gate) throw new Error(`unknown gate: ${options.gate}`);
  const kind = normalizeEvidenceKind(options.kind);
  const requestedKind = options.kind ?? "file";
  const id = `ev.${Date.now()}.${run.manifest.evidence.length + 1}`;
  const ext = path.extname(source);
  const storedName = `${id}${ext}`;
  const storedPath = await assertSafeRunArtifactWritePath(run.dir, path.join(FLOW_RUN_EVIDENCE_DIR, storedName));
  await copyFile(source, storedPath);
  const sourceSha256 = await sha256File(source);
  const entry: FlowEvidenceEntry = {
    id,
    gate_id: options.gate,
    kind,
    requested_kind: requestedKind,
    status: options.status ?? "passed",
    original_path: options.file,
    stored_path: path.join(FLOW_RUN_EVIDENCE_DIR, storedName),
    sha256: sourceSha256,
    attached_at: new Date().toISOString()
  };

  // trust.bundle path: read the file as a Hachure TrustBundle, validate,
  // derive statuses via Surface buildTrustReport, store bundle + report.
  if (options.bundle || options.kind === "trust.bundle") {
    const raw = await readJson(source);
    const { bundle, bundle_report } = normalizeTrustBundle(raw);
    entry.kind = "trust.bundle";
    entry.requested_kind = "trust.bundle";
    entry.bundle = bundle;
    entry.bundle_report = bundle_report;
  }

  if (options.producer) entry.producer = options.producer;
  if (options.authorityTrace) entry.authority_trace = options.authorityTrace;
  if (options.route_reason) entry.route_reason = options.route_reason;
  if (options.expectation_ids) entry.expectation_ids = options.expectation_ids;
  if (options.classifier) entry.classifier = options.classifier;
  if (options.diagnostics) entry.diagnostics = options.diagnostics;
  if (options.analytics) entry.analytics = options.analytics;
  const supersedeIds: string[] = Array.isArray(options.supersede)
    ? options.supersede
    : options.supersede
      ? [options.supersede]
      : [];
  for (const supersededId of supersedeIds) {
    const superseded = run.manifest.evidence.find((existing) => existing.id === supersededId);
    if (!superseded) throw new Error(`cannot supersede unknown evidence: ${supersededId}`);
    if (superseded.gate_id !== options.gate) {
      throw new Error(`cannot supersede evidence ${supersededId}: it belongs to gate ${superseded.gate_id}, not ${options.gate}`);
    }
    superseded.superseded_by = id;
  }
  run.manifest.evidence.push(entry);
  await saveRun(run);
  return entry;
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
      validated = validateTrustBundle(entry.bundle);
    } catch {
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

export async function evaluateRun(runId: string, options: MutableRecord = {}) {
  const run = await loadRun(runId, options.cwd);
  assertLifecycleEligible("evaluate", run.state.status);
  // §1: re-derive freshness-bearing reports with the current `now` BEFORE
  // gates read them, so a claim that has gone stale flips the gate outcome.
  // The existing route-back cascade (invalidateDescendants) then clears any
  // downstream stale passes for free.
  const now = options.now ? new Date(options.now) : new Date();
  const freshnessTransitions = reDeriveBundleReports(run.manifest, now);
  const gates = options.gate ? [findGate(run.definition, options.gate)] : openGates(run.definition, run.state);
  if (!gates.length || gates.some((gate) => !gate)) throw new Error(options.gate ? `unknown gate: ${options.gate}` : "no gate for current step");
  const outcomes: GateOutcome[] = [];
  for (const gate of gates) {
    const outcome = evaluateGate(run.definition, run.state, run.manifest, gate.id, run.config);
    const validationState = options.gate && gate.step !== run.state.current_step
      ? { ...run.state, current_step: gate.step }
      : run.state;
    const transitionValidation = validateEvaluationTransition(run.definition, validationState, run.manifest, outcome, run.config);
    if (transitionValidation.status === "invalid") {
      const first = transitionValidation.diagnostics[0];
      throw new Error(`invalid Flow transition for ${outcome.gate_id}: ${first?.message ?? "transition validation failed"}`);
    }
    outcome.transition_validation = transitionValidation;
    applyEvaluation(run.definition, run.state, outcome);
    outcomes.push(outcome);
    if (outcome.status !== "pass") break;
  }
  await saveRun(run);
  return { ...run, outcomes, freshness_transitions: freshnessTransitions };
}

export async function acceptException(runId, options) {
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
      const location = await resolveRunLocation(id, cwd);
      const rawDefinition = await readJson(path.join(location.dir, FLOW_RUN_DEFINITION_FILE));
      const definition = validateDefinition(rawDefinition);
      const state = await readJson(path.join(location.dir, FLOW_RUN_STATE_FILE));
      validateRunStateIdentity(definition, state, id);
      runs.push({
        run_id: id,
        definition_id: state.definition_id,
        subject: state.subject,
        status: state.status,
        current_step: state.current_step,
        updated_at: state.updated_at
      });
      diagnostics.push(...location.diagnostics);
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
