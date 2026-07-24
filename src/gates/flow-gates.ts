import type { GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import { defaultFlowConfig } from "../config/flow-config.js";
import {
  acceptedExceptionFor,
  attachedEvidenceFor,
  descendantsOf,
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
import { compareRfc3339Timestamps, parseRfc3339Timestamp, surfaceTimestampValidationView } from "../shared/rfc3339.js";
import type { ParsedRfc3339Timestamp } from "../shared/rfc3339.js";
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

function findClaimsInReport(report: any, selector: any): any[] {
  if (!report?.claims || !Array.isArray(report.claims)) return [];
  return report.claims.filter((claim: any) => {
    // Surface preserves producer-level supersession separately from its derived
    // status. Historical critique claims can therefore re-derive as `proposed`
    // while still carrying producerStatus=superseded. They remain audit history,
    // but must never compete with the live replacement claim at a gate.
    if (claim.producerStatus === "superseded" || claim.metadata?.superseded_by) return false;
    if (claim.claimType !== selector.claimType) return false;
    if (selector.subjectType && claim.subjectType !== selector.subjectType) return false;
    if (selector.subjectId && claim.subjectId !== selector.subjectId) return false;
    return true;
  });
}

function evidenceAuthorityTraces(entry: any): string[] {
  return [
    entry.authority_trace,
    ...(Array.isArray(entry.authority_traces) ? entry.authority_traces : [])
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function evidenceTrustPolicyDiagnostic(
  entry: any,
  expectation: any,
  config: MutableRecord
): "untrusted_producer" | "authority_gap" | null {
  const selector = expectation.bundle_claim ?? expectation.claim;
  const mapping = selector?.claimType
    ? config.trusted_producers?.[selector.claimType]
    : undefined;
  const trustedProducers = expectation.trusted_producers ?? mapping?.producers ?? [];
  const trustedTraces = expectation.authority_traces ?? mapping?.authority_traces ?? [];
  if (!trustedProducers.length && !trustedTraces.length) return null;

  if (trustedProducers.includes(entry.producer)) return null;
  const actualTraces = evidenceAuthorityTraces(entry);
  if (trustedTraces.some((trace: string) => actualTraces.includes(trace))) return null;

  return trustedProducers.length ? "untrusted_producer" : "authority_gap";
}

function claimIsCurrentForVisit(bundle: any, claim: any, enteredAt: ParsedRfc3339Timestamp): boolean {
  const bundleClaim = bundle?.claims?.find((candidate: any) => candidate?.id === claim.id);
  if (!bundleClaim) return false;

  const createdAt = parseRfc3339Timestamp(bundleClaim.createdAt);
  if (createdAt === null) return false;

  const observations = (bundle.evidence ?? [])
    .filter((evidence: any) => evidence?.claimId === bundleClaim.id)
    .map((evidence: any) => parseRfc3339Timestamp(evidence.observedAt));
  if (observations.some((observedAt) => observedAt === null)) return false;

  return compareRfc3339Timestamps(createdAt, enteredAt) >= 0
    || observations.some((observedAt) => compareRfc3339Timestamps(observedAt!, enteredAt) >= 0);
}

function routeBackAffectsStep(definition: any, transition: any, step: string): boolean {
  return ["route_back", "retry_authorized"].includes(transition?.type) && (
    transition.from_step === step
    || transition.to_step === step
    || (Array.isArray(transition.invalidated_steps) && transition.invalidated_steps.includes(step))
    || descendantsOf(definition, transition.to_step).includes(step)
  );
}

interface GateVisit {
  revisited: boolean;
  awaitingReentry: boolean;
  enteredAt: ParsedRfc3339Timestamp | null;
}

function currentGateVisit(definition: any, state: any, step: string): GateVisit {
  let awaitingReentry = false;
  let reentryAt: ParsedRfc3339Timestamp | null | undefined;
  for (const transition of state.transitions ?? []) {
    if (routeBackAffectsStep(definition, transition, step)) {
      awaitingReentry = transition.to_step !== step;
      reentryAt = transition.to_step === step ? parseRfc3339Timestamp(transition.at) : undefined;
    } else if (awaitingReentry && transition?.to_step === step) {
      awaitingReentry = false;
      reentryAt = parseRfc3339Timestamp(transition.at);
    }
  }
  return {
    revisited: reentryAt !== undefined || awaitingReentry,
    awaitingReentry,
    enteredAt: reentryAt ?? null
  };
}

function evidenceVisitDiagnostic(entry: any, visit: GateVisit): string | null {
  if (!visit.revisited) return null;
  if (visit.awaitingReentry) return "gate_reentry_pending";
  if (visit.enteredAt === null) return "gate_reentry_timestamp_invalid";

  const attachedAt = parseRfc3339Timestamp(entry.attached_at);
  if (attachedAt === null) return "attachment_timestamp_invalid";
  if (compareRfc3339Timestamps(attachedAt, visit.enteredAt) < 0) return "attachment_not_current";
  return null;
}

function deriveBundleReport(bundle: unknown): { report: any | null; error: string | null } {
  // First validate via Surface (referential/structural)
  let validated: any;
  try {
    validated = validateTrustBundle(surfaceTimestampValidationView(bundle));
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

function evidenceBundleDiagnostic(
  entry: any,
  expectation: any,
  config: MutableRecord,
  enteredAt: ParsedRfc3339Timestamp | null = null
): string | null {
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

  const claims = findClaimsInReport(report, selector);
  if (!claims.length) return "claim_not_found";

  const currentClaims = enteredAt === null
    ? claims
    : claims.filter((claim: any) => claimIsCurrentForVisit(bundle, claim, enteredAt));
  if (!currentClaims.length) {
    return "claim_not_current";
  }

  const accepted = selector.accepted_statuses ?? ["verified"];
  if (currentClaims.some((claim: any) => accepted.includes(claim.status ?? "unknown"))) {
    return evidenceTrustPolicyDiagnostic(entry, expectation, config);
  }

  const claimStatus = currentClaims[0].status ?? "unknown";
  if (!accepted.includes(claimStatus)) {
    if (claimStatus === "stale") return "stale";
    if (claimStatus === "disputed") return "disputed";
    return "rejected";
  }

  return null;
}

export function evidenceMatchesExpectation(entry: any, expectation: any, config: MutableRecord = defaultFlowConfig(), enteredAt: ParsedRfc3339Timestamp | null = null) {
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

  const accepted = selector.accepted_statuses ?? ["verified"];
  return findClaimsInReport(report, selector).some((claim: any) => {
    if (!accepted.includes(claim.status ?? "unknown")) return false;
    if (enteredAt !== null && !claimIsCurrentForVisit(bundle, claim, enteredAt)) return false;
    return evidenceTrustPolicyDiagnostic(entry, expectation, config) === null;
  });
}

function claimDiagnosticsForExpectation(evidence: any[], expectation: any, config: MutableRecord = defaultFlowConfig(), visit: GateVisit) {
  const diagnostics: MutableRecord[] = [];
  for (const entry of evidence) {
    const reason = evidenceVisitDiagnostic(entry, visit)
      ?? evidenceBundleDiagnostic(entry, expectation, config, visit.enteredAt);
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
  const visit = currentGateVisit(definition, state, gate.step);
  const attachedEvidence = attachedEvidenceFor(manifest, gateId).filter((entry) => !entry.superseded_by);
  // A failed attachment can never advance a pending revisit, but it must keep
  // its established route reason and attempt accounting until re-entry occurs.
  const evidence = attachedEvidence.filter((entry) => (
    evidenceVisitDiagnostic(entry, visit) === null
    || (entry.status === "failed" && visit.awaitingReentry)
  ));
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
    claimDiagnostics.push(...claimDiagnosticsForExpectation(attachedEvidence, expectationWithGate, config, visit));
    const match = visit.revisited && (visit.awaitingReentry || visit.enteredAt === null)
      ? undefined
      : evidence.find((entry) => evidenceMatchesExpectation(entry, expectationWithGate, config, visit.enteredAt));
    if (match) {
      matched.push({ expectation_id: expectation.id, evidence_id: match.id });
    } else if (expectation.required) {
      missingRequired.push(expectation.id);
    } else {
      missingOptional.push(expectation.id);
    }
  }
  const diagnosticPayload = claimDiagnostics.length ? { claim_evaluation: claimDiagnostics } : undefined;
  const outcomeEvidenceRefs = evidence.length
    ? evidence.map((entry) => entry.id)
    : [...new Set(claimDiagnostics.map((diagnostic) => diagnostic.evidence_id).filter(Boolean))];

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
        evidence_refs: outcomeEvidenceRefs,
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
      evidence_refs: outcomeEvidenceRefs
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
  if (!Array.isArray(state.gate_outcome_history)) {
    state.gate_outcome_history = structuredClone(state.gate_outcomes ?? []);
  }
  state.gate_outcome_history.push(structuredClone(outcome));
  const without = state.gate_outcomes.filter((entry) => entry.gate_id !== outcome.gate_id);
  state.gate_outcomes = [...without, outcome];
}

export function applyEvaluation(definition, state, outcome, at = new Date().toISOString()) {
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
      at,
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
        retry_epoch: outcome.retry_epoch,
        max_attempts: outcome.max_attempts,
        limit_exceeded: outcome.limit_exceeded,
        invalidated_steps: outcome.invalidated_steps,
        evidence_refs: outcome.evidence_refs,
        expectation_ids: outcome.expectation_ids,
        classifier: outcome.classifier,
        diagnostics: outcome.diagnostics,
        analytics: outcome.analytics,
        analytics_loop_key: outcome.analytics_loop_key,
        freshness_transitions: outcome.freshness_transitions,
        at,
        gate_id: outcome.gate_id
      });
    } else {
      state.transitions.push({
        from_step: gate.step,
        to_step: getStep(definition, gate.step)?.next ?? null,
        status: "blocked",
        reason: outcome.summary,
        invalidated_steps: outcome.invalidated_steps,
        evidence_refs: outcome.evidence_refs,
        expectation_ids: outcome.expectation_ids,
        freshness_transitions: outcome.freshness_transitions,
        at,
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
      retry_epoch: outcome.retry_epoch,
      max_attempts: outcome.max_attempts,
      limit_exceeded: outcome.limit_exceeded,
      invalidated_steps: invalidated.length ? invalidated : undefined,
      evidence_refs: outcome.evidence_refs,
      expectation_ids: outcome.expectation_ids,
      classifier: outcome.classifier,
      diagnostics: outcome.diagnostics,
      analytics: outcome.analytics,
      analytics_loop_key: outcome.analytics_loop_key,
      freshness_transitions: outcome.freshness_transitions,
      at,
      gate_id: outcome.gate_id
    });
  } else {
    state.status = "active";
  }

  state.next_action = state.status === "completed"
    ? "run complete; no further action required"
    : nextActionForStep(definition, state.current_step, outcome);
  state.updated_at = at;
}
