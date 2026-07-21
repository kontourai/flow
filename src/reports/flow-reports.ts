import { writeFile } from "node:fs/promises";
import path from "node:path";

import { assertSafeRunArtifactWritePath, writeJson } from "../runtime/flow-files.js";
import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type { MutableRecord } from "../contracts/flow-types.js";
import {
  attachedEvidenceFor,
  continuationLine,
  findGate,
  openGates,
  projectedNextAction
} from "../definition/flow-definition.js";
import { expectationsForGate } from "../gates/flow-gates.js";
import { evidenceLabel, expectationLabel, markdownText, slugLabel, STATUS_ORDER } from "../shared/flow-utils.js";
import { flowRunHead } from "../runtime/flow-run-retry-authorization.js";
import { definitionIdentity } from "../runtime/flow-run-definition-amendment.js";

export function reportJson(definition: any, state: any, manifest: any) {
  const effective_definition = definitionIdentity(definition);
  const firstAmendment = state.definition_amendments?.[0];
  const start_definition = firstAmendment?.prior_definition ?? {
    id: manifest.definition_id ?? definition.id,
    version: manifest.definition_version ?? definition.version
  };
  const definition_amendments = (state.definition_amendments ?? []).map((event) => ({
    prior_definition: event.prior_definition,
    successor_definition: event.successor_definition,
    prior_run_head: event.prior_run_head,
    authority: event.authority,
    reason: event.reason,
    at: event.at
  }));
  const lifecycle = (state.lifecycle ?? []).map((event) => ({
    action: event.action,
    from_status: event.from_status,
    to_status: event.to_status,
    prior_status: event.prior_status,
    reason: event.reason,
    authority: {
      kind: event.authority.kind,
      actor: event.authority.actor,
      request_ref: event.authority.request_ref,
      requested_at: event.authority.requested_at
    },
    at: event.at
  }));
  const retry_authorizations = (state.transitions ?? [])
    .map((transition, index) => ({ transition, index }))
    .filter(({ transition }) => transition.type === "retry_authorized")
    .map(({ transition, index }) => {
      const blocked = state.transitions[index - 1];
      const maxAttempts = blocked?.max_attempts;
      const matchingLaterTransitions = state.transitions.slice(index + 1).filter((candidate) =>
        candidate.type === "route_back"
        && candidate.gate_id === transition.gate_id
        && candidate.from_step === transition.from_step
        && candidate.selected_route === transition.selected_route
        && (candidate.route_reason ?? candidate.reason) === transition.route_reason
        && (candidate.retry_epoch ?? 1) === transition.retry_epoch
      );
      const consumedAttempts = Math.min(matchingLaterTransitions.length, maxAttempts);
      const remainingAttempts = Math.max(maxAttempts - consumedAttempts, 0);
      const superseded = state.transitions.slice(index + 1).some((candidate) =>
        candidate.type === "retry_authorized"
        && candidate.gate_id === transition.gate_id
        && candidate.from_step === transition.from_step
        && candidate.selected_route === transition.selected_route
        && candidate.route_reason === transition.route_reason
        && candidate.prior_retry_epoch === transition.retry_epoch
      );
      return {
      blocked_transition_ref: transition.blocked_transition_ref,
      prior_run_head: transition.prior_run_head,
      gate_id: transition.gate_id,
      route_reason: transition.route_reason ?? transition.reason,
      target_step: transition.to_step,
      prior_retry_epoch: transition.prior_retry_epoch,
      retry_epoch: transition.retry_epoch,
      max_attempts: maxAttempts,
      consumed_attempts: consumedAttempts,
      next_attempt: remainingAttempts > 0 ? consumedAttempts + 1 : null,
      remaining_attempts: remainingAttempts,
      budget_status: superseded ? "historical" : "current",
      authority: transition.authority,
      reason: transition.reason,
      invalidated_steps: transition.invalidated_steps ?? [],
      at: transition.at
      };
    });
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    state_head: flowRunHead(state),
    run_id: state.run_id,
    definition_id: definition.id,
    definition_version: definition.version,
    ...(state.definition_digest !== undefined || definition_amendments.length ? { effective_definition, start_definition } : {}),
    ...(definition_amendments.length ? { definition_amendments } : {}),
    subject: state.subject,
    status: state.status,
    summary: `${definition.id} / ${state.subject}`,
    current_step: state.current_step,
    next_action: projectedNextAction(state),
    continuation: continuationLine(state),
    lifecycle,
    ...(retry_authorizations.length ? { retry_authorizations } : {}),
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
        "retry_epoch",
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
    `- State head: ${markdownText(report.state_head)}`,
    `- Current step: ${markdownText(state.current_step)}`,
    `- Next action: ${markdownText(report.next_action)}`,
    `- Continuation: ${markdownText(report.continuation)}`,
    "",
    "## Lifecycle",
    ""
  ];
  if (report.effective_definition) {
    lines.splice(4, 0,
      `- Start definition snapshot: ${markdownText(report.start_definition.id)} v${markdownText(report.start_definition.version)}`,
      `- Effective definition: ${markdownText(report.effective_definition.id)} v${markdownText(report.effective_definition.version)} (${markdownText(report.effective_definition.digest)})`
    );
  }
  if (report.definition_amendments?.length) {
    lines.push(`- Definition amendments: ${report.definition_amendments.length}`);
    for (const amendment of report.definition_amendments) {
      lines.push(`  - ${markdownText(amendment.prior_definition.version)} -> ${markdownText(amendment.successor_definition.version)} by ${markdownText(amendment.authority.actor)} (${markdownText(amendment.authority.request_ref)})`);
    }
  }
  if (report.lifecycle.length) {
    for (const event of report.lifecycle) {
      lines.push(`- ${markdownText(event.action)}: ${markdownText(event.from_status)} -> ${markdownText(event.to_status)} at ${markdownText(event.at)}`);
      lines.push(`  - Reason: ${markdownText(event.reason)}`);
      lines.push(`  - Authority: ${markdownText(event.authority.kind)} by ${markdownText(event.authority.actor)}`);
      lines.push(`  - Request: ${markdownText(event.authority.request_ref)} at ${markdownText(event.authority.requested_at)}`);
      lines.push(`  - Prior resumable status: ${markdownText(event.prior_status)}`);
    }
  } else {
    lines.push("No lifecycle events.");
  }
  lines.push("", "## Retry Authorizations", "");
  if (report.retry_authorizations?.length) {
    for (const authorization of report.retry_authorizations) {
      lines.push(`- Epoch ${markdownText(String(authorization.prior_retry_epoch))} -> ${markdownText(String(authorization.retry_epoch))}: ${markdownText(authorization.gate_id)} -> ${markdownText(authorization.target_step)} at ${markdownText(authorization.at)}`);
      lines.push(`  - Block: ${markdownText(authorization.blocked_transition_ref)}`);
      lines.push(`  - ${authorization.budget_status === "current" ? "Current" : "Historical final"} budget: next attempt ${authorization.next_attempt === null ? "none" : `${markdownText(String(authorization.next_attempt))}/${markdownText(String(authorization.max_attempts))}`}; ${markdownText(String(authorization.remaining_attempts))} attempts remaining; ${markdownText(String(authorization.consumed_attempts))} consumed`);
      lines.push(`  - Authority: ${markdownText(authorization.authority.kind)} by ${markdownText(authorization.authority.actor)} (${markdownText(authorization.authority.request_ref)})`);
    }
  } else {
    lines.push("No retry authorizations.");
  }
  lines.push(
    "",
    "## Gates",
    ""
  );
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
  const jsonPath = await assertSafeRunArtifactWritePath(dir, "report.json");
  const markdownPath = await assertSafeRunArtifactWritePath(dir, "report.md");
  await writeJson(jsonPath, reportJson(definition, state, manifest));
  await writeFile(markdownPath, renderMarkdownReport(definition, state, manifest));
}

export function renderSummary(definition, state, reportPath = `.kontourai/flow/runs/${state.run_id}/report.md`) {
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
      const required = expectationsForGate(gate).filter((entry) => entry.required);
      lines.push(`      expected: ${required.map(expectationLabel).join(", ")}`);
      for (const entry of required) {
        if (outcome.missing.includes(entry.id) && entry.explore_hint) {
          lines.push(`      hint: ${entry.explore_hint}`);
        }
      }
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
  lines.push("", `status: ${state.status}`);
  lines.push(`next action: ${projectedNextAction(state)}`);
  lines.push(`continuation: ${continuationLine(state)}`);
  lines.push(`report: ${reportPath}`);
  return `${lines.join("\n")}\n`;
}

export function renderResume(definition, state) {
  const gates = openGates(definition, state);
  const routeBacks = state.gate_outcomes.filter((outcome) => outcome.status === "route-back" || outcome.limit_exceeded);
  const lines = [
    `flow run: ${definition.id} / ${state.subject}`,
    `current step: ${state.current_step}`,
    `status: ${state.status}`,
    `next action: ${projectedNextAction(state)}`,
    `open gates: ${gates.length ? gates.map((gate) => gate.id).join(", ") : "none"}`,
    `accepted exceptions: ${state.exceptions.length ? state.exceptions.map((entry) => `${entry.gate_id} by ${entry.authority}`).join(", ") : "none"}`,
    `route backs: ${routeBacks.length ? routeBacks.map((outcome) => {
      const attempt = outcome.attempt ? `${outcome.attempt}${outcome.max_attempts ? `/${outcome.max_attempts}` : ""}` : "n/a";
      const recovery = outcome.recovery_step ? `, recovery ${outcome.recovery_step}` : "";
      return `${outcome.gate_id} ${outcome.route_reason ?? outcome.reason ?? "default"} -> ${outcome.route_back_to} attempt ${attempt}, limit exceeded ${outcome.limit_exceeded ? "yes" : "no"}${recovery}`;
    }).join("; ") : "none"}`,
    `guidance: ${continuationLine(state)}`
  ];
  for (const gate of gates) {
    const outcome = state.gate_outcomes.find((entry) => entry.gate_id === gate.id);
    if (!outcome?.missing?.length) continue;
    for (const expectation of expectationsForGate(gate)) {
      if (outcome.missing.includes(expectation.id) && expectation.explore_hint) {
        lines.push(`hint (${gate.id}): ${expectation.explore_hint}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function sortStatus(a, b) {
  return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
}

export * from "../console/console-projection.js";
