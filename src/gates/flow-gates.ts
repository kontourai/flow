import type { GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import { defaultFlowConfig } from "../config/flow-config.js";
import {
  acceptedExceptionFor,
  attachedEvidenceFor,
  findGate,
  getStep,
  invalidateDescendants,
  nextActionForStep,
  routeBackDecision,
  routeReasonForFailedEvidence
} from "../definition/flow-definition.js";
import {
  expectationLabel,
  slugLabel
} from "../shared/flow-utils.js";
import { buildTrustReport, validateTrustBundle } from "@kontourai/surface";
import { validateTrustBundleSchema } from "./trust-bundle-validator.js";

export function expectationsForGate(gate: any, config: MutableRecord = defaultFlowConfig()) {
  const overrides = config.gate_overrides?.[gate.id]?.expectations ?? {};
  return (gate.expects ?? []).map((expectation) => ({
    ...expectation,
    bundle_claim: expectation.bundle_claim ? { ...expectation.bundle_claim } : undefined,
    ...(overrides[expectation.id] ?? {}),
    id: expectation.id
  }));
}

function findClaimInReport(report: any, selector: any): any | null {
  if (!report?.claims || !Array.isArray(report.claims)) return null;
  return report.claims.find((claim: any) => {
    if (claim.claimType !== selector.claimType) return false;
    if (selector.subjectType && claim.subjectType !== selector.subjectType) return false;
    if (selector.subjectId && claim.subjectId !== selector.subjectId) return false;
    return true;
  }) ?? null;
}

function deriveBundleReport(bundle: unknown): { report: any | null; error: string | null } {
  // First validate via Surface (referential/structural)
  let validated: any;
  try {
    validated = validateTrustBundle(bundle);
  } catch (err: any) {
    return { report: null, error: `bundle_invalid: ${err?.message ?? String(err)}` };
  }
  // Then derive statuses via Surface
  try {
    const report = buildTrustReport(validated);
    return { report, error: null };
  } catch (err: any) {
    return { report: null, error: `bundle_derivation_failed: ${err?.message ?? String(err)}` };
  }
}

function evidenceBundleDiagnostic(entry: any, expectation: any): string | null {
  if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") return null;
  if (entry.status === "failed") return "rejected";

  const bundle = entry.bundle;
  if (!bundle) return "bundle_invalid";

  // Schema validation
  const schemaResult = validateTrustBundleSchema(bundle);
  if (!schemaResult.valid) return "bundle_invalid";

  // Derive report
  const report = entry.bundle_report ?? deriveBundleReport(bundle).report;
  if (!report) return "bundle_invalid";

  const selector = expectation.bundle_claim ?? expectation.claim;
  if (!selector) return "bundle_invalid";

  const claim = findClaimInReport(report, selector);
  if (!claim) return "claim_not_found";

  const accepted = selector.accepted_statuses ?? ["verified"];
  const claimStatus = claim.status ?? "unknown";
  if (!accepted.includes(claimStatus)) {
    if (claimStatus === "stale") return "stale";
    if (claimStatus === "disputed") return "disputed";
    return "rejected";
  }

  return null;
}

export function evidenceMatchesExpectation(entry: any, expectation: any, _config: MutableRecord = defaultFlowConfig()) {
  if (expectation.kind !== "trust.bundle") return false;
  if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") return false;
  if (entry.status === "failed") return false;

  const bundle = entry.bundle;
  if (!bundle) return false;

  // Schema validation
  const schemaResult = validateTrustBundleSchema(bundle);
  if (!schemaResult.valid) return false;

  // Use cached bundle_report when present, otherwise derive
  let report = entry.bundle_report;
  if (!report) {
    const derived = deriveBundleReport(bundle);
    if (!derived.report) return false;
    report = derived.report;
  }

  const selector = expectation.bundle_claim ?? expectation.claim;
  if (!selector) return false;

  const claim = findClaimInReport(report, selector);
  if (!claim) return false;

  const accepted = selector.accepted_statuses ?? ["verified"];
  const claimStatus = claim.status ?? "unknown";
  return accepted.includes(claimStatus);
}

function claimDiagnosticsForExpectation(evidence: any[], expectation: any, _config: MutableRecord = defaultFlowConfig()) {
  const diagnostics: MutableRecord[] = [];
  for (const entry of evidence) {
    const reason = evidenceBundleDiagnostic(entry, expectation);
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

  // Superseded entries stay in the manifest for audit but no longer drive
  // gate outcomes: replacing failing evidence is how a route-back recovers.
  const evidence = attachedEvidenceFor(manifest, gateId).filter((entry) => !entry.superseded_by);
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
    // Cascade: clear gate outcomes for every step downstream of the target so
    // dependent stages re-run instead of keeping stale "passed" outcomes.
    const invalidated = invalidateDescendants(definition, state, outcome.route_back_to);
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
      invalidated_steps: invalidated.length ? invalidated : undefined,
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

  state.next_action = state.status === "completed"
    ? "run complete; no further action required"
    : nextActionForStep(definition, state.current_step, outcome);
  state.updated_at = new Date().toISOString();
}
