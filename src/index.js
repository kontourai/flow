import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FLOW_SCHEMA_VERSION = "0.1";

export const BUILTIN_EVIDENCE_KINDS = new Set([
  "command",
  "file",
  "ci",
  "veritas-readiness",
  "human-attestation",
  "trace-link"
]);

const STATUS_ORDER = ["pass", "block", "route-back", "wait"];

export function flowRoot(cwd = process.cwd()) {
  return path.join(cwd, ".flow");
}

export function runDir(runId, cwd = process.cwd()) {
  return path.join(flowRoot(cwd), "runs", runId);
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function slugLabel(value) {
  if (value === "implement-gate") return "implementation gate";
  return value.replace(/-/g, " ");
}

export function normalizeEvidenceKind(kind) {
  if (!kind) return "file";
  return BUILTIN_EVIDENCE_KINDS.has(kind) ? kind : "custom";
}

export function evidenceMatchesRequirement(entry, requiredKind) {
  return entry.kind === requiredKind || entry.requested_kind === requiredKind;
}

export function evidenceLabel(kind) {
  const labels = {
    "acceptance-criteria": "acceptance criteria",
    "scoped-diff": "scoped files",
    "browser-evidence": "screenshot",
    "veritas-readiness": "Veritas readiness"
  };
  return labels[kind] ?? slugLabel(kind);
}

export function passSummary(kind) {
  const summaries = {
    "acceptance-criteria": "acceptance criteria linked",
    "scoped-diff": "scoped files changed",
    "browser-evidence": "browser evidence attached",
    "veritas-readiness": "Veritas readiness attached"
  };
  return summaries[kind] ?? `${evidenceLabel(kind)} attached`;
}

export function missingSummary(kind) {
  const summaries = {
    "browser-evidence": "browser evidence missing",
    "veritas-readiness": "Veritas readiness missing"
  };
  return summaries[kind] ?? `${evidenceLabel(kind)} missing`;
}

export function getStep(definition, stepId) {
  return definition.steps.find((step) => step.id === stepId);
}

export function gatesForStep(definition, stepId) {
  return Object.entries(definition.gates)
    .map(([id, gate]) => ({ id, ...gate }))
    .filter((gate) => gate.step === stepId);
}

export function findGate(definition, gateId) {
  const gate = definition.gates[gateId];
  return gate ? { id: gateId, ...gate } : null;
}

export function initialState(definition, runId, params = {}) {
  const firstStep = definition.steps[0];
  const subject = params.subject ?? params.feature ?? params.task ?? params.name ?? runId;
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: runId,
    definition_id: definition.id,
    definition_version: definition.version,
    subject,
    status: "active",
    current_step: firstStep.id,
    params,
    gate_outcomes: [],
    transitions: [],
    exceptions: [],
    next_action: nextActionForStep(definition, firstStep.id),
    updated_at: new Date().toISOString()
  };
}

export function nextActionForStep(definition, stepId, outcome = null) {
  if (outcome?.status === "block" && outcome.missing?.length) {
    if (outcome.missing.includes("browser-evidence")) return "run browser check before publish";
    return `attach ${outcome.missing.map(evidenceLabel).join(", ")} before continuing`;
  }
  if (outcome?.status === "route-back") {
    return `return to ${outcome.route_back_to} and replace failing evidence`;
  }
  const gate = gatesForStep(definition, stepId)[0];
  if (!gate) return "no open gate";
  return `attach evidence for ${slugLabel(gate.id)}`;
}

export function continuationLine(state) {
  return `resume from ${state.current_step}, not chat memory`;
}

export function openGates(definition, state) {
  return gatesForStep(definition, state.current_step);
}

export function acceptedExceptionFor(state, gateId) {
  return state.exceptions.find((exception) => exception.gate_id === gateId);
}

export function attachedEvidenceFor(manifest, gateId) {
  return manifest.evidence.filter((entry) => entry.gate_id === gateId);
}

export function evaluateGate(definition, state, manifest, gateId) {
  const gate = findGate(definition, gateId);
  if (!gate) throw new Error(`unknown gate: ${gateId}`);

  const exception = acceptedExceptionFor(state, gateId);
  if (exception) {
    return {
      gate_id: gateId,
      status: "pass",
      summary: "accepted exception",
      evidence_refs: exception.evidence_refs ?? [],
      accepted_exception_id: exception.id
    };
  }

  const evidence = attachedEvidenceFor(manifest, gateId);
  const failed = evidence.filter((entry) => entry.status === "failed");
  if (failed.length) {
    return {
      gate_id: gateId,
      status: "route-back",
      summary: `${slugLabel(gate.id)} has failing evidence`,
      evidence_refs: failed.map((entry) => entry.id),
      route_back_to: gate.step
    };
  }

  const missing = gate.requires.filter((requiredKind) => {
    return !evidence.some((entry) => evidenceMatchesRequirement(entry, requiredKind) && entry.status !== "failed");
  });

  if (missing.length) {
    return {
      gate_id: gateId,
      status: "block",
      summary: missingSummary(missing[0]),
      missing,
      evidence_refs: evidence.map((entry) => entry.id)
    };
  }

  if (gate.requires.length === 0) {
    return {
      gate_id: gateId,
      status: "wait",
      summary: `${slugLabel(gate.id)} waiting for evidence`,
      evidence_refs: evidence.map((entry) => entry.id)
    };
  }

  return {
    gate_id: gateId,
    status: "pass",
    summary: passSummary(gate.requires[0]),
    evidence_refs: evidence.map((entry) => entry.id)
  };
}

export function mergeGateOutcome(state, outcome) {
  const without = state.gate_outcomes.filter((entry) => entry.gate_id !== outcome.gate_id);
  state.gate_outcomes = [...without, outcome];
}

export function applyEvaluation(definition, state, outcome) {
  const gate = findGate(definition, outcome.gate_id);
  mergeGateOutcome(state, outcome);

  if (outcome.status === "pass") {
    const step = getStep(definition, gate.step);
    const nextStep = step?.next ?? null;
    state.transitions.push({
      from_step: gate.step,
      to_step: nextStep,
      status: "allowed",
      reason: outcome.accepted_exception_id ? "accepted exception" : "required evidence present",
      at: new Date().toISOString(),
      gate_id: outcome.gate_id
    });
    state.current_step = nextStep ?? gate.step;
    state.status = nextStep ? "active" : "completed";
  } else if (outcome.status === "block") {
    state.status = "blocked";
    state.transitions.push({
      from_step: gate.step,
      to_step: getStep(definition, gate.step)?.next ?? null,
      status: "blocked",
      reason: outcome.summary,
      at: new Date().toISOString(),
      gate_id: outcome.gate_id
    });
  } else if (outcome.status === "route-back") {
    state.status = "active";
    state.current_step = outcome.route_back_to;
    state.transitions.push({
      from_step: gate.step,
      to_step: outcome.route_back_to,
      status: "blocked",
      reason: outcome.summary,
      at: new Date().toISOString(),
      gate_id: outcome.gate_id
    });
  } else {
    state.status = "active";
  }

  state.next_action = nextActionForStep(definition, state.current_step, outcome);
  state.updated_at = new Date().toISOString();
}

export async function ensureFlowLayout(cwd = process.cwd()) {
  const root = flowRoot(cwd);
  await mkdir(path.join(root, "definitions"), { recursive: true });
  await mkdir(path.join(root, "runs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), flowReadme());
  const sample = await readJson(examplePath("agent-dev-flow.json"));
  await writeJson(path.join(root, "definitions", "agent-dev-flow.json"), sample);
  return root;
}

export function flowReadme() {
  return `# .flow\n\nLocal Flow state lives here.\n\n- definitions/ contains Flow Definition JSON files.\n- runs/<run-id>/ contains definition.json, state.json, evidence/, report.md, and report.json.\n- runs/<run-id>/evidence/manifest.json records attached evidence metadata.\n\nThis directory is intentionally file-backed so a run can be resumed without chat history.\n`;
}

export function moduleRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function examplePath(file) {
  return path.join(moduleRoot(), "examples", file);
}

export async function startRun(definitionPath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const definition = await readJson(path.resolve(cwd, definitionPath));
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
  const state = await readJson(path.join(dir, "state.json"));
  const manifestPath = path.join(dir, "evidence", "manifest.json");
  const manifest = existsSync(manifestPath)
    ? await readJson(manifestPath)
    : { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };
  return { dir, definition, state, manifest };
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

export async function attachEvidence(runId, options) {
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
  const entry = {
    id,
    gate_id: options.gate,
    kind,
    requested_kind: requestedKind,
    status: options.status ?? "passed",
    original_path: options.file,
    stored_path: path.join("evidence", storedName),
    sha256: await sha256File(source),
    attached_at: new Date().toISOString()
  };
  run.manifest.evidence.push(entry);
  await saveRun(run);
  return entry;
}

export async function evaluateRun(runId, options = {}) {
  const run = await loadRun(runId, options.cwd);
  const gates = options.gate ? [findGate(run.definition, options.gate)] : openGates(run.definition, run.state);
  if (!gates.length || gates.some((gate) => !gate)) throw new Error(options.gate ? `unknown gate: ${options.gate}` : "no gate for current step");
  const outcomes = [];
  for (const gate of gates) {
    const outcome = evaluateGate(run.definition, run.state, run.manifest, gate.id);
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
  const runs = [];
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

export function reportJson(definition, state, manifest) {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: state.run_id,
    definition_id: definition.id,
    definition_version: definition.version,
    subject: state.subject,
    status: state.status,
    summary: `${definition.id} / ${state.subject}`,
    current_step: state.current_step,
    next_action: state.next_action,
    continuation: continuationLine(state),
    open_gates: openGates(definition, state).map((gate) => gate.id),
    accepted_exceptions: state.exceptions,
    gate_summaries: Object.keys(definition.gates).map((gateId) => {
      const outcome = state.gate_outcomes.find((entry) => entry.gate_id === gateId);
      const evidence = attachedEvidenceFor(manifest, gateId);
      return {
        gate_id: gateId,
        status: outcome?.status ?? "wait",
        summary: outcome?.summary ?? `${slugLabel(gateId)} waiting`,
        evidence_refs: evidence.map((entry) => entry.id),
        missing: outcome?.missing ?? []
      };
    })
  };
}

export function renderMarkdownReport(definition, state, manifest) {
  const report = reportJson(definition, state, manifest);
  const lines = [
    `# Flow Report: ${state.run_id}`,
    "",
    `- Definition: ${definition.id} v${definition.version}`,
    `- Subject: ${state.subject}`,
    `- Status: ${state.status}`,
    `- Current step: ${state.current_step}`,
    `- Next action: ${state.next_action}`,
    `- Continuation: ${report.continuation}`,
    "",
    "## Gates",
    ""
  ];
  for (const gate of report.gate_summaries) {
    lines.push(`- ${gate.status.toUpperCase()} ${slugLabel(gate.gate_id)}: ${gate.summary}`);
    if (gate.missing?.length) lines.push(`  - Missing: ${gate.missing.map(evidenceLabel).join(", ")}`);
    if (gate.evidence_refs.length) lines.push(`  - Evidence: ${gate.evidence_refs.join(", ")}`);
  }
  lines.push("", "## Accepted Exceptions", "");
  if (state.exceptions.length) {
    for (const exception of state.exceptions) {
      lines.push(`- ${exception.gate_id}: ${exception.reason} (${exception.authority})`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("", "## Evidence Manifest", "");
  if (manifest.evidence.length) {
    for (const entry of manifest.evidence) {
      lines.push(`- ${entry.id}: ${entry.kind} for ${entry.gate_id} (${entry.sha256})`);
    }
  } else {
    lines.push("No evidence attached.");
  }
  return `${lines.join("\n")}\n`;
}

export async function renderAndWriteReport(definition, state, manifest, dir) {
  await writeJson(path.join(dir, "report.json"), reportJson(definition, state, manifest));
  await writeFile(path.join(dir, "report.md"), renderMarkdownReport(definition, state, manifest));
}

export function renderSummary(definition, state) {
  const lines = [
    `flow run: ${definition.id} / ${state.subject}`,
    `current step: ${state.current_step}`,
    ""
  ];
  for (const [gateId] of Object.entries(definition.gates)) {
    const gate = findGate(definition, gateId);
    const outcome = state.gate_outcomes.find((entry) => entry.gate_id === gateId);
    const status = outcome?.status ?? "wait";
    const statusLabel = status === "pass" ? "PASS" : status === "block" ? "BLOCK" : status === "route-back" ? "ROUTE-BACK" : "WAIT";
    lines.push(`${statusLabel.padEnd(5)} ${slugLabel(gateId)}: ${outcome?.summary ?? `${slugLabel(gateId)} waiting`}`);
    if (outcome?.missing?.length) {
      lines.push(`      expected: ${gate.requires.map(evidenceLabel).join(", ")}`);
    }
  }
  lines.push("", `next action: ${state.next_action}`);
  lines.push(`continuation: ${continuationLine(state)}`);
  lines.push(`report: .flow/runs/${state.run_id}/report.md`);
  return `${lines.join("\n")}\n`;
}

export function renderResume(definition, state) {
  const gates = openGates(definition, state);
  const lines = [
    `flow run: ${definition.id} / ${state.subject}`,
    `current step: ${state.current_step}`,
    `next action: ${state.next_action}`,
    `open gates: ${gates.length ? gates.map((gate) => gate.id).join(", ") : "none"}`,
    `accepted exceptions: ${state.exceptions.length ? state.exceptions.map((entry) => `${entry.gate_id} by ${entry.authority}`).join(", ") : "none"}`,
    `guidance: continue from recorded Flow state; ${state.next_action}`
  ];
  return `${lines.join("\n")}\n`;
}

export function sortStatus(a, b) {
  return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
}
