import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";

import {
  FLOW_RUN_DEFINITION_FILE,
  FLOW_RUN_EVIDENCE_DIR,
  FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  FLOW_RUN_LAYOUT,
  FLOW_RUN_STATE_FILE,
  examplePath,
  flowConfigPath,
  flowRoot,
  readJson,
  runDir,
  writeJson
} from "./flow-files.js";
import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type { FlowEvidenceEntry, GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import { loadFlowConfig, defaultFlowConfig } from "../config/flow-config.js";
import {
  findGate,
  initialState,
  openGates,
  validateDefinition
} from "../definition/flow-definition.js";
import { applyEvaluation, evaluateGate } from "../gates/flow-gates.js";
import { validateEvaluationTransition } from "../transition/flow-evaluation-transition.js";
import { renderAndWriteReport } from "../reports/flow-reports.js";
import { isNonEmptyString, isObject, normalizeEvidenceKind, slugLabel } from "../shared/flow-utils.js";
import { buildTrustReport, validateTrustBundle, checkpointFromReport, diffFreshness } from "@kontourai/surface";
import { validateTrustBundleSchema } from "../gates/trust-bundle-validator.js";

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

export async function scaffoldDemoRun(cwd = process.cwd()) {
  const root = await ensureFlowLayout(cwd);
  const runId = "demo";
  if (existsSync(runDir(runId, cwd))) return { runId, created: false };
  const demoDir = path.join(root, "demo");
  const bundleFile = path.join(demoDir, "acceptance-bundle.json");
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
  return { runId, created: true, state: result.state };
}

export function flowReadme() {
  return `# .flow\n\nLocal Flow state lives here.\n\n- definitions/ contains authored Flow Definition JSON files.\n- config.json is the project authority model for trusted producers and gate overrides.\n- demo/ contains evidence fixtures written by \`flow init --demo\`.\n- runs/<run-id>/ is generated run state, not an authored Resource Contract.\n- runs/<run-id>/${FLOW_RUN_LAYOUT.definition} is the Flow Definition snapshot from run start.\n- runs/<run-id>/${FLOW_RUN_LAYOUT.state} is the authoritative mutable run state.\n- runs/<run-id>/${FLOW_RUN_LAYOUT.evidenceManifest} records attached evidence metadata for this run.\n- runs/<run-id>/${FLOW_RUN_LAYOUT.evidenceDirectory}/<id>.* contains copied evidence files.\n- runs/<run-id>/${FLOW_RUN_LAYOUT.reportMarkdown} and runs/<run-id>/${FLOW_RUN_LAYOUT.reportJson} are generated reports.\n\nThis directory is intentionally file-backed so a run can be resumed without chat history.\n`;
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
  const dir = runDir(runId, cwd);
  if (existsSync(dir)) throw new Error(`run already exists: ${runId}`);
  const state = initialState(definition, runId, options.params ?? {});
  const manifest = initialEvidenceManifest(definition, state);
  await mkdir(path.join(dir, FLOW_RUN_EVIDENCE_DIR), { recursive: true });
  await writeJson(path.join(dir, FLOW_RUN_DEFINITION_FILE), definition);
  await writeJson(path.join(dir, FLOW_RUN_STATE_FILE), state);
  await writeJson(path.join(dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH), manifest);
  await renderAndWriteReport(definition, state, manifest, dir);
  return { runId, dir, state };
}

export async function loadRun(runId, cwd = process.cwd()) {
  const dir = runDir(runId, cwd);
  const rawDefinition = await readJson(path.join(dir, FLOW_RUN_DEFINITION_FILE));
  const definition = validateDefinition(rawDefinition);
  const state = await readJson(path.join(dir, FLOW_RUN_STATE_FILE));
  validateRunStateIdentity(definition, state, runId);
  const config = await loadFlowConfig(cwd);
  const manifestPath = path.join(dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const manifest = existsSync(manifestPath)
    ? validateEvidenceManifestIdentity(await readJson(manifestPath), definition, state)
    : initialEvidenceManifest(definition, state);
  return { dir, definition, state, manifest, config };
}

export async function saveRun(run) {
  await writeJson(path.join(run.dir, FLOW_RUN_STATE_FILE), run.state);
  await writeJson(path.join(run.dir, FLOW_RUN_EVIDENCE_MANIFEST_PATH), run.manifest);
  await renderAndWriteReport(run.definition, run.state, run.manifest, run.dir);
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
  const source = path.resolve(options.cwd ?? process.cwd(), options.file);
  await stat(source);
  const gate = findGate(run.definition, options.gate);
  if (!gate) throw new Error(`unknown gate: ${options.gate}`);
  const kind = normalizeEvidenceKind(options.kind);
  const requestedKind = options.kind ?? "file";
  const id = `ev.${Date.now()}.${run.manifest.evidence.length + 1}`;
  const ext = path.extname(source);
  const storedName = `${id}${ext}`;
  const storedPath = path.join(run.dir, FLOW_RUN_EVIDENCE_DIR, storedName);
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
