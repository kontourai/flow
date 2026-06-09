import type { GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import { defaultFlowConfig } from "../config/flow-config.js";
import {
  acceptedExceptionFor,
  attachedEvidenceFor,
  findGate,
  getStep,
  nextActionForStep,
  routeBackDecision,
  routeReasonForFailedEvidence
} from "../definition/flow-definition.js";
import {
  evidenceLabel,
  evidenceMatchesRequirement,
  expectationLabel,
  missingSummary,
  passSummary,
  slugLabel
} from "../shared/flow-utils.js";

export function expectationsForGate(gate: any, config: MutableRecord = defaultFlowConfig()) {
  const overrides = config.gate_overrides?.[gate.id]?.expectations ?? {};
  if (gate.expects?.length) {
    return gate.expects.map((expectation) => ({
      ...expectation,
      claim: expectation.claim ? { ...expectation.claim } : undefined,
      ...(overrides[expectation.id] ?? {}),
      id: expectation.id
    }));
  }
  return (gate.requires ?? []).map((requiredKind) => ({
    id: requiredKind,
    kind: "evidence.kind",
    required: true,
    description: evidenceLabel(requiredKind),
    evidence_kind: requiredKind,
    ...(overrides[requiredKind] ?? {})
  }));
}

export function evidenceProducerTrusted(entry: any, expectation: any, config: MutableRecord = defaultFlowConfig()) {
  const claimType = expectation.claim?.type;
  const override = config.gate_overrides?.[expectation.gate_id]?.expectations?.[expectation.id] ?? {};
  const mapping = claimType ? config.trusted_producers?.[claimType] : null;
  const trustedProducers = override.trusted_producers ?? mapping?.producers ?? [];
  const trustedTraces = override.authority_traces ?? mapping?.authority_traces ?? [];
  if (!trustedProducers.length && !trustedTraces.length) return true;
  return trustedProducers.includes(entry.producer) || trustedTraces.some((trace) => evidenceAuthorityTraces(entry).includes(trace));
}

function evidenceAuthorityTraces(entry) {
  return [
    entry.authority_trace,
    ...(Array.isArray(entry.authority_traces) ? entry.authority_traces : []),
    ...(Array.isArray(entry.trust_artifact?.authority_traces) ? entry.trust_artifact.authority_traces : [])
  ].filter(Boolean);
}

function evidenceClaimDiagnostic(entry: any, expectation: any, config: MutableRecord = defaultFlowConfig()) {
  if (entry.kind !== "surface.claim" && entry.requested_kind !== "surface.claim") return null;
  if (entry.status === "failed") return "rejected";
  if (entry.trust_artifact?.integrity?.verified === false || entry.diagnostics?.trust_artifact?.reason === "integrity_mismatch") return "integrity_mismatch";
  if (entry.claim?.type !== expectation.claim?.type) return null;
  if (expectation.claim?.subject && entry.claim?.subject !== expectation.claim.subject) return "subject_mismatch";
  const accepted = expectation.accepted_statuses ?? expectation.claim?.accepted_statuses ?? ["trusted"];
  const claimStatus = entry.claim?.status ?? entry.trust_status ?? entry.status;
  if (!accepted.includes(claimStatus)) return claimStatus === "stale" ? "stale" : "rejected";
  const claimType = expectation.claim?.type;
  const override = config.gate_overrides?.[expectation.gate_id]?.expectations?.[expectation.id] ?? {};
  const mapping = claimType ? config.trusted_producers?.[claimType] : null;
  const trustedProducers = override.trusted_producers ?? mapping?.producers ?? [];
  const trustedTraces = override.authority_traces ?? mapping?.authority_traces ?? [];
  if (trustedProducers.length && !trustedProducers.includes(entry.producer)) return "untrusted_producer";
  if (trustedTraces.length && !trustedTraces.some((trace) => evidenceAuthorityTraces(entry).includes(trace))) return "authority_gap";
  return null;
}

export function evidenceMatchesExpectation(entry: any, expectation: any, config: MutableRecord = defaultFlowConfig()) {
  if (expectation.kind === "evidence.kind") {
    return evidenceMatchesRequirement(entry, expectation.evidence_kind) && entry.status !== "failed";
  }
  if (expectation.kind !== "surface.claim") return false;
  if (entry.kind !== "surface.claim" && entry.requested_kind !== "surface.claim") return false;
  if (entry.status === "failed") return false;
  if (entry.claim?.type !== expectation.claim?.type) return false;
  if (expectation.claim?.subject && entry.claim?.subject !== expectation.claim.subject) return false;
  const accepted = expectation.accepted_statuses ?? expectation.claim?.accepted_statuses ?? ["trusted"];
  const claimStatus = entry.claim?.status ?? entry.trust_status ?? entry.status;
  if (!accepted.includes(claimStatus)) return false;
  return evidenceProducerTrusted(entry, expectation, config);
}

function claimDiagnosticsForExpectation(evidence: any[], expectation: any, config: MutableRecord = defaultFlowConfig()) {
  const diagnostics: MutableRecord[] = [];
  for (const entry of evidence) {
    const reason = evidenceClaimDiagnostic(entry, expectation, config);
    if (!reason) continue;
    diagnostics.push({
      expectation_id: expectation.id,
      evidence_id: entry.id,
      reason
    });
  }
  return diagnostics;
}

export function evaluateGate(definition: any, state: any, manifest: any, gateId: string, config: MutableRecord = defaultFlowConfig()): GateOutcome {
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
    const routeReason = routeReasonForFailedEvidence(failed[0]);
    const route = routeBackDecision(state, gate, routeReason, failed);
    return {
      gate_id: gateId,
      status: route.status,
      summary: `${slugLabel(gate.id)} has failing evidence`,
      ...route
    };
  }

  const expectations = expectationsForGate(gate, config);
  const matched: Array<{ expectation_id: string; evidence_id: string }> = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const claimDiagnostics: MutableRecord[] = [];
  for (const expectation of expectations) {
    const expectationWithGate = { ...expectation, gate_id: gateId };
    const match = evidence.find((entry) => evidenceMatchesExpectation(entry, expectationWithGate, config));
    if (match) {
      matched.push({ expectation_id: expectation.id, evidence_id: match.id });
    } else if (expectation.required) {
      missingRequired.push(expectation.id);
      claimDiagnostics.push(...claimDiagnosticsForExpectation(evidence, expectationWithGate, config));
    } else {
      missingOptional.push(expectation.id);
      claimDiagnostics.push(...claimDiagnosticsForExpectation(evidence, expectationWithGate, config));
    }
  }
  const diagnosticPayload = claimDiagnostics.length ? { claim_evaluation: claimDiagnostics } : undefined;

  if (missingRequired.length) {
    const first = expectations.find((expectation) => expectation.id === missingRequired[0]);
    if (gate.on_route_back?.missing_evidence) {
      const route = routeBackDecision(state, gate, "missing_evidence", evidence, { expectationIds: missingRequired });
      return {
        gate_id: gateId,
        status: route.status,
        summary: `${expectationLabel(first)} missing`,
        missing: missingRequired,
        optional_missing: missingOptional,
        matched_expectations: matched,
        ...route,
        ...(diagnosticPayload ? { diagnostics: { ...(route.diagnostics ?? {}), ...diagnosticPayload } } : {})
      };
    }
    return {
      gate_id: gateId,
      status: "block",
      summary: `${expectationLabel(first)} missing`,
      missing: missingRequired,
      optional_missing: missingOptional,
      matched_expectations: matched,
      ...(diagnosticPayload ? { diagnostics: diagnosticPayload } : {}),
      evidence_refs: evidence.map((entry) => entry.id)
    };
  }

  if (!expectations.length) {
    return {
      gate_id: gateId,
      status: "wait",
      summary: `${slugLabel(gate.id)} waiting for evidence`,
      evidence_refs: evidence.map((entry) => entry.id),
      optional_missing: missingOptional,
      matched_expectations: matched
    };
  }

  return {
    gate_id: gateId,
    status: "pass",
    summary: `${expectationLabel(expectations[0])} satisfied`,
    evidence_refs: evidence.map((entry) => entry.id),
    optional_missing: missingOptional,
    matched_expectations: matched,
    ...(diagnosticPayload ? { diagnostics: diagnosticPayload } : {})
  };
}

export function legacyEvaluateGate(definition: any, state: any, manifest: any, gateId: string): GateOutcome {
  const gate = findGate(definition, gateId);
  const evidence = attachedEvidenceFor(manifest, gateId);
  const missing = (gate.requires ?? []).filter((requiredKind) => {
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
    if (outcome.limit_exceeded) {
      state.transitions.push({
        type: "route_back",
        from_step: gate.step,
        to_step: outcome.route_back_to,
        status: "blocked",
        reason: outcome.reason ?? outcome.route_reason ?? outcome.summary,
        route_reason: outcome.route_reason,
        selected_route: outcome.selected_route,
        recovery_step: outcome.recovery_step,
        attempt: outcome.attempt,
        max_attempts: outcome.max_attempts,
        limit_exceeded: outcome.limit_exceeded,
        evidence_refs: outcome.evidence_refs,
        expectation_ids: outcome.expectation_ids,
        classifier: outcome.classifier,
        diagnostics: outcome.diagnostics,
        analytics: outcome.analytics,
        analytics_loop_key: outcome.analytics_loop_key,
        at: new Date().toISOString(),
        gate_id: outcome.gate_id
      });
    } else {
      state.transitions.push({
        from_step: gate.step,
        to_step: getStep(definition, gate.step)?.next ?? null,
        status: "blocked",
        reason: outcome.summary,
        at: new Date().toISOString(),
        gate_id: outcome.gate_id
      });
    }
  } else if (outcome.status === "route-back") {
    state.status = "active";
    state.current_step = outcome.route_back_to;
    state.transitions.push({
      type: "route_back",
      from_step: gate.step,
      to_step: outcome.route_back_to,
      status: "blocked",
      reason: outcome.reason ?? outcome.route_reason ?? outcome.summary,
      route_reason: outcome.route_reason,
      selected_route: outcome.selected_route,
      recovery_step: outcome.recovery_step,
      attempt: outcome.attempt,
      max_attempts: outcome.max_attempts,
      limit_exceeded: outcome.limit_exceeded,
      evidence_refs: outcome.evidence_refs,
      expectation_ids: outcome.expectation_ids,
      classifier: outcome.classifier,
      diagnostics: outcome.diagnostics,
      analytics: outcome.analytics,
      analytics_loop_key: outcome.analytics_loop_key,
      at: new Date().toISOString(),
      gate_id: outcome.gate_id
    });
  } else {
    state.status = "active";
  }

  state.next_action = nextActionForStep(definition, state.current_step, outcome);
  state.updated_at = new Date().toISOString();
}
