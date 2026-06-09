import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";

import { examplePath, flowConfigPath, flowRoot, readJson, runDir, writeJson } from "./flow-files.js";
import { FLOW_SCHEMA_VERSION } from "./flow-types.js";
import type { FlowEvidenceEntry, GateOutcome, MutableRecord } from "./flow-types.js";
import { loadFlowConfig, defaultFlowConfig } from "./flow-config.js";
import {
  findGate,
  initialState,
  openGates,
  validateDefinition
} from "./flow-definition.js";
import { applyEvaluation, evaluateGate } from "./flow-gates.js";
import { validateEvaluationTransition } from "./flow-evaluation-transition.js";
import { renderAndWriteReport } from "./flow-reports.js";
import { isNonEmptyString, isObject, normalizeEvidenceKind, slugLabel } from "./flow-utils.js";

export async function ensureFlowLayout(cwd = process.cwd()) {
  const root = flowRoot(cwd);
  await mkdir(path.join(root, "definitions"), { recursive: true });
  await mkdir(path.join(root, "runs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), flowReadme());
  if (!existsSync(flowConfigPath(cwd))) await writeJson(flowConfigPath(cwd), defaultFlowConfig());
  const sample = await readJson(examplePath("agent-dev-flow.json"));
  await writeJson(path.join(root, "definitions", "agent-dev-flow.json"), sample);
  return root;
}

export function flowReadme() {
  return `# .flow\n\nLocal Flow state lives here.\n\n- definitions/ contains Flow Definition JSON files.\n- config.json is the project authority model for trusted producers and gate overrides.\n- runs/<run-id>/ contains definition.json, state.json, evidence/, report.md, and report.json.\n- runs/<run-id>/evidence/manifest.json records attached evidence metadata.\n\nThis directory is intentionally file-backed so a run can be resumed without chat history.\n`;
}

export async function startRun(definitionPath: string, options: MutableRecord = {}) {
  const cwd = options.cwd ?? process.cwd();
  const definition = await readJson(path.resolve(cwd, definitionPath));
  validateDefinition(definition);
  const runId = options.runId ?? `run.${Date.now()}`;
  const dir = runDir(runId, cwd);
  if (existsSync(dir)) throw new Error(`run already exists: ${runId}`);
  const state = initialState(definition, runId, options.params ?? {});
  await mkdir(path.join(dir, "evidence"), { recursive: true });
  await writeJson(path.join(dir, "definition.json"), definition);
  await writeJson(path.join(dir, "state.json"), state);
  await writeJson(path.join(dir, "evidence", "manifest.json"), { schema_version: FLOW_SCHEMA_VERSION, evidence: [] });
  await renderAndWriteReport(definition, state, { schema_version: FLOW_SCHEMA_VERSION, evidence: [] }, dir);
  return { runId, dir, state };
}

export async function loadRun(runId, cwd = process.cwd()) {
  const dir = runDir(runId, cwd);
  const definition = await readJson(path.join(dir, "definition.json"));
  validateDefinition(definition);
  const state = await readJson(path.join(dir, "state.json"));
  const config = await loadFlowConfig(cwd);
  const manifestPath = path.join(dir, "evidence", "manifest.json");
  const manifest = existsSync(manifestPath)
    ? await readJson(manifestPath)
    : { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };
  return { dir, definition, state, manifest, config };
}

export async function saveRun(run) {
  await writeJson(path.join(run.dir, "state.json"), run.state);
  await writeJson(path.join(run.dir, "evidence", "manifest.json"), run.manifest);
  await renderAndWriteReport(run.definition, run.state, run.manifest, run.dir);
}

export async function sha256File(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

function firstArrayValue(value) {
  return Array.isArray(value) ? value[0] : undefined;
}

export function normalizeTrustArtifact(artifact, fileSha256, now = new Date()) {
  if (!isObject(artifact)) throw new Error("trust artifact must be a JSON object");
  const artifactType = artifact.artifact_type ?? artifact.type;
  if (!["trust-report", "trust-snapshot"].includes(artifactType)) throw new Error("trust artifact artifact_type must be trust-report or trust-snapshot");
  const claim = firstArrayValue(artifact.claims) ?? artifact.claim;
  if (!isObject(claim)) throw new Error("trust artifact must include a claim or claims[0]");
  if (!isNonEmptyString(claim.type)) throw new Error("trust artifact claim.type is required");
  const subject = claim.subject ?? artifact.subject;
  if (subject !== undefined && !isNonEmptyString(subject)) throw new Error("trust artifact subject must be a non-empty string when present");
  const expiresAt = artifact.expires_at ?? claim.expires_at;
  const artifactStatus = claim.status ?? artifact.status ?? "trusted";
  const stale = expiresAt ? Date.parse(expiresAt) <= now.getTime() : false;
  const expectedSha256 = artifact.integrity?.sha256 ?? artifact.sha256;
  const integrityVerified = !expectedSha256 || expectedSha256 === fileSha256;
  const status = !integrityVerified ? "integrity_mismatch" : stale ? "stale" : artifactStatus;
  const projection = {
    schema_version: artifact.schema_version ?? FLOW_SCHEMA_VERSION,
    artifact_type: artifactType,
    subject,
    producer: artifact.producer ?? claim.producer,
    status: artifact.status ?? artifactStatus,
    issued_at: artifact.issued_at ?? claim.issued_at,
    expires_at: expiresAt,
    authority_traces: artifact.authority_traces ?? claim.authority_traces ?? [],
    claims: Array.isArray(artifact.claims) ? artifact.claims : [claim],
    integrity: {
      ...(isObject(artifact.integrity) ? artifact.integrity : {}),
      verified: integrityVerified
    }
  };
  return {
    trust_artifact: projection,
    claim: {
      type: claim.type,
      status,
      ...(subject ? { subject } : {})
    },
    producer: projection.producer,
    authority_traces: projection.authority_traces,
    diagnostics: integrityVerified ? undefined : { trust_artifact: { reason: "integrity_mismatch", expected_sha256: expectedSha256, actual_sha256: fileSha256 } }
  };
}

export async function attachEvidence(runId: string, options: MutableRecord): Promise<FlowEvidenceEntry> {
  const run = await loadRun(runId, options.cwd);
  const source = path.resolve(options.cwd ?? process.cwd(), options.file);
  await stat(source);
  const gate = findGate(run.definition, options.gate);
  if (!gate) throw new Error(`unknown gate: ${options.gate}`);
  const kind = normalizeEvidenceKind(options.kind);
  const requestedKind = options.kind ?? "file";
  const id = `ev.${Date.now()}.${run.manifest.evidence.length + 1}`;
  const ext = path.extname(source);
  const storedName = `${id}${ext}`;
  const storedPath = path.join(run.dir, "evidence", storedName);
  await copyFile(source, storedPath);
  const sourceSha256 = await sha256File(source);
  const entry: FlowEvidenceEntry = {
    id,
    gate_id: options.gate,
    kind,
    requested_kind: requestedKind,
    status: options.status ?? "passed",
    original_path: options.file,
    stored_path: path.join("evidence", storedName),
    sha256: sourceSha256,
    attached_at: new Date().toISOString()
  };
  if (options.trustArtifact) {
    const artifact = await readJson(source);
    const normalized = normalizeTrustArtifact(artifact, sourceSha256);
    entry.kind = "surface.claim";
    entry.requested_kind = "surface.claim";
    entry.claim = normalized.claim;
    entry.trust_artifact = normalized.trust_artifact;
    if (normalized.producer) entry.producer = normalized.producer;
    if (normalized.authority_traces?.length) {
      entry.authority_traces = normalized.authority_traces;
      entry.authority_trace = normalized.authority_traces[0];
    }
    if (normalized.diagnostics) entry.diagnostics = normalized.diagnostics;
  }
  if (options.claimType) {
    entry.kind = "surface.claim";
    entry.requested_kind = "surface.claim";
    entry.claim = {
      ...(entry.claim ?? {}),
      type: options.claimType,
      status: options.claimStatus ?? entry.claim?.status ?? "trusted"
    };
    if (options.claimSubject) entry.claim.subject = options.claimSubject;
  }
  if (options.producer) entry.producer = options.producer;
  if (options.authorityTrace) entry.authority_trace = options.authorityTrace;
  if (options.route_reason) entry.route_reason = options.route_reason;
  if (options.expectation_ids) entry.expectation_ids = options.expectation_ids;
  if (options.classifier) entry.classifier = options.classifier;
  if (options.diagnostics) entry.diagnostics = options.diagnostics;
  if (options.analytics) entry.analytics = options.analytics;
  run.manifest.evidence.push(entry);
  await saveRun(run);
  return entry;
}

export async function evaluateRun(runId: string, options: MutableRecord = {}) {
  const run = await loadRun(runId, options.cwd);
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
  return { ...run, outcomes };
}

export async function acceptException(runId, options) {
  const run = await loadRun(runId, options.cwd);
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
  const dir = path.join(flowRoot(cwd), "runs");
  if (!existsSync(dir)) return [];
  const ids = await readdir(dir);
  const runs: MutableRecord[] = [];
  for (const id of ids) {
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
    } catch {
      // Ignore incomplete run directories.
    }
  }
  return runs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}
