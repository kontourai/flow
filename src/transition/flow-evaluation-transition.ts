import { defaultFlowConfig } from "../config/flow-config.js";
import { findGate, getStep } from "../definition/flow-definition.js";
import { validateRunTransition } from "../transition/flow-transition.js";
import { assertLifecycleEligible } from "../runtime/flow-run-lifecycle.js";

function proposedTransitionForOutcome(definition, gate, outcome, now = new Date().toISOString()) {
  const step = getStep(definition, gate.step);
  const nextStep = step?.next ?? null;
  if (outcome.status === "pass") {
    return {
      from_step: gate.step,
      to_step: nextStep,
      status: nextStep ? "allowed" : "completed",
      reason: outcome.accepted_exception_id ? "accepted exception" : "required evidence present",
      gate_id: outcome.gate_id,
      at: now
    };
  }
  if (outcome.status === "route-back" || outcome.limit_exceeded) {
    return {
      type: "route_back",
      from_step: gate.step,
      to_step: outcome.route_back_to,
      status: "route-back",
      reason: outcome.reason ?? outcome.route_reason ?? outcome.summary,
      route_reason: outcome.route_reason,
      selected_route: outcome.selected_route,
      recovery_step: outcome.recovery_step,
      attempt: outcome.attempt,
      retry_epoch: outcome.retry_epoch,
      max_attempts: outcome.max_attempts,
      limit_exceeded: outcome.limit_exceeded,
      evidence_refs: outcome.evidence_refs,
      expectation_ids: outcome.expectation_ids,
      classifier: outcome.classifier,
      diagnostics: outcome.diagnostics,
      analytics: outcome.analytics,
      analytics_loop_key: outcome.analytics_loop_key,
      gate_id: outcome.gate_id,
      at: now
    };
  }
  if (outcome.status === "block") {
    return {
      from_step: gate.step,
      to_step: nextStep,
      status: "blocked",
      reason: outcome.summary,
      gate_id: outcome.gate_id,
      evidence_refs: outcome.evidence_refs,
      at: now
    };
  }
  return null;
}

export function validateEvaluationTransition(definition, state, manifest, outcome, config = defaultFlowConfig(), now = new Date().toISOString()) {
  assertLifecycleEligible("evaluate", state.status);
  const gate = findGate(definition, outcome.gate_id);
  if (!gate) throw new Error(`unknown gate: ${outcome.gate_id}`);
  const transition = proposedTransitionForOutcome(definition, gate, outcome, now);
  if (!transition) {
    return {
      valid: true,
      status: "allowed",
      diagnostics: [],
      transition: null
    };
  }
  return validateRunTransition({
    definition,
    current_state: state,
    proposed_transition: transition,
    manifest,
    config,
    now
  });
}
