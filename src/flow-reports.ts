import { writeFile } from "node:fs/promises";
import path from "node:path";

import { writeJson } from "./flow-files.js";
import { FLOW_SCHEMA_VERSION } from "./flow-types.js";
import type { MutableRecord } from "./flow-types.js";
import {
  attachedEvidenceFor,
  continuationLine,
  findGate,
  openGates
} from "./flow-definition.js";
import { expectationsForGate } from "./flow-gates.js";
import { evidenceLabel, expectationLabel, markdownText, slugLabel, STATUS_ORDER } from "./flow-utils.js";

export function reportJson(definition: any, state: any, manifest: any) {
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
      const summary: MutableRecord = {
        gate_id: gateId,
        status: outcome?.status ?? "wait",
        summary: outcome?.summary ?? `${slugLabel(gateId)} waiting`,
        evidence_refs: evidence.map((entry) => entry.id),
        missing: outcome?.missing ?? [],
        optional_missing: outcome?.optional_missing ?? [],
        matched_expectations: outcome?.matched_expectations ?? []
      };
      for (const field of [
        "route_back_to",
        "selected_route",
        "recovery_step",
        "route_reason",
        "attempt",
        "max_attempts",
        "limit_exceeded",
        "expectation_ids",
        "classifier",
        "diagnostics",
        "analytics",
        "analytics_loop_key",
        "transition_validation"
      ]) {
        if (outcome?.[field] !== undefined) summary[field] = outcome[field];
      }
      return summary;
    })
  };
}

export function renderMarkdownReport(definition, state, manifest) {
  const report = reportJson(definition, state, manifest);
  const lines = [
    `# Flow Report: ${markdownText(state.run_id)}`,
    "",
    `- Definition: ${markdownText(definition.id)} v${markdownText(definition.version)}`,
    `- Subject: ${markdownText(state.subject)}`,
    `- Status: ${markdownText(state.status)}`,
    `- Current step: ${markdownText(state.current_step)}`,
    `- Next action: ${markdownText(state.next_action)}`,
    `- Continuation: ${markdownText(report.continuation)}`,
    "",
    "## Gates",
    ""
  ];
  for (const gate of report.gate_summaries) {
    lines.push(`- ${markdownText(String(gate.status).toUpperCase())} ${markdownText(slugLabel(gate.gate_id))}: ${markdownText(gate.summary)}`);
    if (gate.missing?.length) lines.push(`  - Missing: ${gate.missing.map(evidenceLabel).map(markdownText).join(", ")}`);
    if (gate.optional_missing?.length) lines.push(`  - Optional missing: ${gate.optional_missing.map(evidenceLabel).map(markdownText).join(", ")}`);
    if (gate.diagnostics?.claim_evaluation?.length) {
      lines.push(`  - Claim diagnostics: ${gate.diagnostics.claim_evaluation.map((entry) => markdownText(`${entry.expectation_id}/${entry.evidence_id}:${entry.reason}`)).join(", ")}`);
    }
    if (gate.evidence_refs.length) lines.push(`  - Evidence: ${gate.evidence_refs.map(markdownText).join(", ")}`);
    if (gate.status === "route-back" || gate.limit_exceeded) {
      const attempt = gate.attempt ? `${gate.attempt}${gate.max_attempts ? `/${gate.max_attempts}` : ""}` : "n/a";
      lines.push(`  - Route back: ${markdownText(gate.route_reason ?? gate.reason ?? "default")} -> ${markdownText(gate.route_back_to)} (attempt ${markdownText(attempt)}, limit exceeded: ${gate.limit_exceeded ? "yes" : "no"})`);
      if (gate.selected_route && gate.selected_route !== gate.route_back_to) lines.push(`  - Selected route: ${markdownText(gate.selected_route)}`);
      if (gate.recovery_step) lines.push(`  - Recovery step: ${markdownText(gate.recovery_step)}`);
      if (gate.expectation_ids?.length) lines.push(`  - Expectations: ${gate.expectation_ids.map(markdownText).join(", ")}`);
      if (gate.classifier?.kind) lines.push(`  - Classifier: ${markdownText(gate.classifier.kind)}${gate.classifier.source ? ` from ${markdownText(gate.classifier.source)}` : ""}`);
      if (gate.analytics_loop_key) lines.push(`  - Analytics loop: ${markdownText(gate.analytics_loop_key)}`);
    }
    if (gate.transition_validation?.diagnostics?.length) {
      lines.push(`  - Transition diagnostics: ${gate.transition_validation.diagnostics.map((entry) => markdownText(`${entry.code}:${entry.message}`)).join(", ")}`);
    }
  }
  lines.push("", "## Accepted Exceptions", "");
  if (state.exceptions.length) {
    for (const exception of state.exceptions) {
      lines.push(`- ${markdownText(exception.gate_id)}: ${markdownText(exception.reason)} (${markdownText(exception.authority)})`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("", "## Evidence Manifest", "");
  if (manifest.evidence.length) {
    for (const entry of manifest.evidence) {
      lines.push(`- ${markdownText(entry.id)}: ${markdownText(entry.kind)} for ${markdownText(entry.gate_id)} (${markdownText(entry.sha256)})`);
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
      lines.push(`      expected: ${expectationsForGate(gate).filter((entry) => entry.required).map(expectationLabel).join(", ")}`);
    }
    if (outcome?.diagnostics?.claim_evaluation?.length) {
      lines.push(`      claim diagnostics: ${outcome.diagnostics.claim_evaluation.map((entry) => entry.reason).join(", ")}`);
    }
    if (outcome?.status === "route-back" || outcome?.limit_exceeded) {
      const attempt = outcome.attempt ? `${outcome.attempt}${outcome.max_attempts ? `/${outcome.max_attempts}` : ""}` : "n/a";
      lines.push(`      route: ${outcome.route_reason ?? outcome.reason ?? "default"} -> ${outcome.route_back_to}; attempt ${attempt}; limit exceeded: ${outcome.limit_exceeded ? "yes" : "no"}`);
      if (outcome.recovery_step) lines.push(`      recovery: ${outcome.recovery_step}`);
      if (outcome.analytics_loop_key) lines.push(`      analytics loop: ${outcome.analytics_loop_key}`);
    }
    if (outcome?.transition_validation?.diagnostics?.length) {
      lines.push(`      transition diagnostics: ${outcome.transition_validation.diagnostics.map((entry) => entry.code).join(", ")}`);
    }
  }
  lines.push("", `next action: ${state.next_action}`);
  lines.push(`continuation: ${continuationLine(state)}`);
  lines.push(`report: .flow/runs/${state.run_id}/report.md`);
  return `${lines.join("\n")}\n`;
}

export function renderResume(definition, state) {
  const gates = openGates(definition, state);
  const routeBacks = state.gate_outcomes.filter((outcome) => outcome.status === "route-back" || outcome.limit_exceeded);
  const lines = [
    `flow run: ${definition.id} / ${state.subject}`,
    `current step: ${state.current_step}`,
    `next action: ${state.next_action}`,
    `open gates: ${gates.length ? gates.map((gate) => gate.id).join(", ") : "none"}`,
    `accepted exceptions: ${state.exceptions.length ? state.exceptions.map((entry) => `${entry.gate_id} by ${entry.authority}`).join(", ") : "none"}`,
    `route backs: ${routeBacks.length ? routeBacks.map((outcome) => {
      const attempt = outcome.attempt ? `${outcome.attempt}${outcome.max_attempts ? `/${outcome.max_attempts}` : ""}` : "n/a";
      const recovery = outcome.recovery_step ? `, recovery ${outcome.recovery_step}` : "";
      return `${outcome.gate_id} ${outcome.route_reason ?? outcome.reason ?? "default"} -> ${outcome.route_back_to} attempt ${attempt}, limit exceeded ${outcome.limit_exceeded ? "yes" : "no"}${recovery}`;
    }).join("; ") : "none"}`,
    `guidance: continue from recorded Flow state; ${state.next_action}`
  ];
  return `${lines.join("\n")}\n`;
}

export function sortStatus(a, b) {
  return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
}

export * from "./console-projection.js";
