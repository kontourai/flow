import type { FlowDiagnostic, MutableRecord, TransitionValidationResult } from "./flow-types.js";
import { cloneJson, isNonEmptyString, isObject } from "./flow-utils.js";
import { defaultFlowConfig } from "./flow-config.js";
import {
  createDiagnostic,
  findGate,
  getStep,
  openGates,
  routeBackDecision,
  validateDefinitionWithDiagnostics
} from "./flow-definition.js";
import { evaluateGate } from "./flow-gates.js";

function transitionDiagnostic(code: string, path: string, message: string, related: MutableRecord = {}, severity = "error") {
  return {
    ...createDiagnostic(`transition.${code}`, path, message, related),
    severity
  };
}

function transitionGateOutcomeDiagnostic(outcome: any, path = "$.proposed_transition", severity = "error") {
  return transitionDiagnostic(
    `gate.${outcome.status}`,
    path,
    `gate ${outcome.gate_id} returned ${outcome.status}`,
    {
      gate_id: outcome.gate_id,
      status: outcome.status,
      ...(outcome.missing?.length ? { missing: outcome.missing } : {}),
      ...(outcome.route_back_to ? { route_back_to: outcome.route_back_to } : {}),
      ...(outcome.route_reason ? { route_reason: outcome.route_reason } : {}),
      ...(outcome.attempt ? { attempt: outcome.attempt } : {}),
      ...(outcome.max_attempts ? { max_attempts: outcome.max_attempts } : {}),
      ...(outcome.limit_exceeded !== undefined ? { limit_exceeded: outcome.limit_exceeded } : {})
    },
    severity
  );
}

function manifestFromTransitionRequest(request) {
  if (isObject(request.manifest)) {
    return {
      ...request.manifest,
      evidence: Array.isArray(request.manifest.evidence) ? request.manifest.evidence : []
    };
  }
  return {
    evidence: (request.evidence_refs ?? []).map((id) => ({ id, kind: "file", status: "attached" }))
  };
}

function currentStateFromTransitionRequest(request) {
  return request.current_state ?? request.state;
}

function proposedTransitionFromRequest(request, currentState) {
  if (request.proposed_transition ?? request.transition) {
    return cloneJson(request.proposed_transition ?? request.transition);
  }
  const proposedState = request.proposed_state;
  if (!isObject(proposedState)) return null;
  return {
    from_step: currentState?.current_step,
    to_step: proposedState.current_step ?? null,
    status: proposedState.status === "completed" ? "completed" : "allowed",
    proposed_status: proposedState.status
  };
}

function routePolicyClosesReasons(gate) {
  const policy = gate.route_back_policy ?? {};
  return policy.route_reasons === "closed"
    || policy.reasons === "closed"
    || policy.closed_reasons === true
    || policy.closed_route_reasons === true
    || policy.allow_unknown_reasons === false;
}

function transitionEvidenceFor(manifest, evidenceRefs = []) {
  const evidence = Array.isArray(manifest?.evidence) ? manifest.evidence : [];
  if (!evidenceRefs.length) return evidence;
  const requested = new Set(evidenceRefs);
  return evidence.filter((entry) => requested.has(entry.id));
}

function normalizeTransitionPreview(transition: MutableRecord, extras: MutableRecord = {}) {
  const limitExceeded = transition.limit_exceeded ?? extras.limit_exceeded;
  return {
    type: transition.type ?? extras.type ?? "step",
    from_step: transition.from_step ?? extras.from_step ?? null,
    to_step: transition.to_step ?? extras.to_step ?? null,
    status: extras.status ?? transition.status ?? "allowed",
    ...(transition.gate_id ?? extras.gate_id ? { gate_id: transition.gate_id ?? extras.gate_id } : {}),
    ...(transition.reason ?? extras.reason ? { reason: transition.reason ?? extras.reason } : {}),
    ...(transition.route_reason ?? extras.route_reason ? { route_reason: transition.route_reason ?? extras.route_reason } : {}),
    ...(transition.selected_route ?? extras.selected_route ? { selected_route: transition.selected_route ?? extras.selected_route } : {}),
    ...(transition.recovery_step ?? extras.recovery_step ? { recovery_step: transition.recovery_step ?? extras.recovery_step } : {}),
    ...(transition.attempt ?? extras.attempt ? { attempt: transition.attempt ?? extras.attempt } : {}),
    ...(transition.max_attempts ?? extras.max_attempts ? { max_attempts: transition.max_attempts ?? extras.max_attempts } : {}),
    ...(limitExceeded !== undefined ? { limit_exceeded: limitExceeded } : {}),
    ...(transition.evidence_refs ?? extras.evidence_refs ? { evidence_refs: cloneJson(transition.evidence_refs ?? extras.evidence_refs) } : {}),
    ...(transition.expectation_ids ?? extras.expectation_ids ? { expectation_ids: cloneJson(transition.expectation_ids ?? extras.expectation_ids) } : {}),
    ...(transition.classifier ?? extras.classifier ? { classifier: cloneJson(transition.classifier ?? extras.classifier) } : {}),
    ...(transition.diagnostics ?? extras.diagnostics ? { diagnostics: cloneJson(transition.diagnostics ?? extras.diagnostics) } : {}),
    ...(transition.analytics ?? extras.analytics ? { analytics: cloneJson(transition.analytics ?? extras.analytics) } : {}),
    ...(transition.analytics_loop_key ?? extras.analytics_loop_key ? { analytics_loop_key: transition.analytics_loop_key ?? extras.analytics_loop_key } : {}),
    ...(transition.at ?? extras.at ? { at: transition.at ?? extras.at } : {})
  };
}

export function validateRunTransition(request: MutableRecord = {}): TransitionValidationResult {
  const diagnostics: FlowDiagnostic[] = [];
  if (!isObject(request)) {
    return {
      valid: false,
      status: "invalid",
      diagnostics: [transitionDiagnostic("request.invalid", "$", "transition request must be an object")],
      transition: null
    };
  }

  const definition = request.definition;
  const currentState = currentStateFromTransitionRequest(request);
  const config = request.config ?? defaultFlowConfig();
  const manifest = manifestFromTransitionRequest(request);
  const transition = proposedTransitionFromRequest(request, currentState);

  const definitionResult = validateDefinitionWithDiagnostics(definition);
  diagnostics.push(...definitionResult.diagnostics);

  if (!isObject(currentState)) {
    diagnostics.push(transitionDiagnostic("current_state.invalid", "$.current_state", "current_state must be an object"));
  }
  if (!isObject(transition)) {
    diagnostics.push(transitionDiagnostic("proposed_transition.required", "$.proposed_transition", "proposed_transition or proposed_state is required"));
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return {
      valid: false,
      status: "invalid",
      diagnostics,
      transition: transition ? normalizeTransitionPreview(transition) : null
    };
  }

  const currentStepId = currentState.current_step;
  const currentStep = getStep(definition, currentStepId);
  const fromStep = transition.from_step ?? currentStepId;
  const toStep = transition.to_step ?? null;
  const isRouteBack = transition.type === "route_back" || transition.type === "route-back" || transition.status === "route-back";

  if (!isNonEmptyString(currentStepId) || !currentStep) {
    diagnostics.push(transitionDiagnostic("current_step.unknown", "$.current_state.current_step", `current step is unknown: ${currentStepId}`, { step: currentStepId }));
  }
  if (transition.from_step !== undefined && transition.from_step !== currentStepId) {
    diagnostics.push(transitionDiagnostic("current_state.stale", "$.proposed_transition.from_step", `proposed transition starts from ${transition.from_step}, but current state is ${currentStepId}`, { proposed_from_step: transition.from_step, current_step: currentStepId }));
  }
  if (fromStep !== currentStepId) {
    diagnostics.push(transitionDiagnostic("from_step.mismatch", "$.proposed_transition.from_step", `transition from_step must match current step ${currentStepId}`, { from_step: fromStep, current_step: currentStepId }));
  }
  if (toStep !== null && !getStep(definition, toStep)) {
    diagnostics.push(transitionDiagnostic("to_step.unknown", "$.proposed_transition.to_step", `transition target is unknown: ${toStep}`, { step: toStep }));
  }
  if (transition.gate_id !== undefined && !findGate(definition, transition.gate_id)) {
    diagnostics.push(transitionDiagnostic("gate.unknown", "$.proposed_transition.gate_id", `transition gate is unknown: ${transition.gate_id}`, { gate_id: transition.gate_id }));
  }
  if (diagnostics.length) {
    return {
      valid: false,
      status: "invalid",
      diagnostics,
      transition: normalizeTransitionPreview(transition, { from_step: fromStep, to_step: toStep })
    };
  }

  const gates = transition.gate_id ? [findGate(definition, transition.gate_id)] : openGates(definition, currentState);

  if (isRouteBack) {
    const gate = gates[0];
    if (!gate) {
      diagnostics.push(transitionDiagnostic("route_back.gate.required", "$.proposed_transition.gate_id", "route-back transition requires an open gate"));
      return { valid: false, status: "invalid", diagnostics, transition: normalizeTransitionPreview(transition, { type: "route_back", from_step: fromStep, to_step: toStep }) };
    }

    const routeReason = transition.route_reason ?? (transition.reason === "default" ? undefined : transition.reason);
    if (routeReason && routePolicyClosesReasons(gate) && !(gate.on_route_back ?? {})[routeReason]) {
      diagnostics.push(transitionDiagnostic("route_back.reason.undeclared", "$.proposed_transition.route_reason", `route reason is not declared for gate ${gate.id}: ${routeReason}`, { gate_id: gate.id, route_reason: routeReason }));
    }

    const evidence = transitionEvidenceFor(manifest, transition.evidence_refs ?? []);
    const route = routeBackDecision(currentState, gate, routeReason, evidence, { expectationIds: transition.expectation_ids });
    if (toStep !== route.route_back_to) {
      diagnostics.push(transitionDiagnostic("route_back.target.mismatch", "$.proposed_transition.to_step", `route-back target must be ${route.route_back_to}`, { gate_id: gate.id, route_reason: routeReason ?? "default", proposed_to_step: toStep, route_back_to: route.route_back_to }));
    }
    if (transition.attempt !== undefined && transition.attempt !== route.attempt) {
      diagnostics.push(transitionDiagnostic("route_back.attempt.mismatch", "$.proposed_transition.attempt", `route-back attempt must be ${route.attempt}`, { proposed_attempt: transition.attempt, attempt: route.attempt }));
    }

    if (diagnostics.length === 0) {
      diagnostics.push(transitionGateOutcomeDiagnostic(
        { ...route, gate_id: gate.id, status: route.status },
        "$.proposed_transition",
        "info"
      ));
    }

    const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const preview = normalizeTransitionPreview(transition, {
      type: "route_back",
      from_step: gate.step,
      to_step: route.route_back_to,
      gate_id: gate.id,
      ...route,
      status: route.status === "block" ? "blocked" : "route-back",
      at: transition.at ?? request.now
    });
    return {
      valid: errorDiagnostics.length === 0 && route.status !== "block",
      status: errorDiagnostics.length ? "invalid" : route.status === "block" ? "blocked" : route.status,
      diagnostics,
      transition: preview
    };
  }

  const expectedNext = currentStep.next ?? null;
  const completesCurrentStep = toStep === expectedNext;
  const proposedCompleted = transition.status === "completed" || transition.proposed_status === "completed";
  if (!completesCurrentStep) {
    diagnostics.push(transitionDiagnostic("jump.invalid", "$.proposed_transition.to_step", `transition target must be the current step next edge: ${expectedNext ?? "completed"}`, { current_step: currentStepId, proposed_to_step: toStep, expected_to_step: expectedNext }));
  }
  if (proposedCompleted && expectedNext !== null) {
    diagnostics.push(transitionDiagnostic("completion.premature", "$.proposed_state.status", "run cannot complete before the current step reaches a terminal edge", { current_step: currentStepId, expected_to_step: expectedNext }));
  }

  const outcomes = gates.map((gate) => evaluateGate(definition, currentState, manifest, gate.id, config));
  const blocking = outcomes.filter((outcome) => outcome.status !== "pass");
  diagnostics.push(...blocking.map((outcome) => transitionGateOutcomeDiagnostic(outcome)));

  const status = diagnostics.length
    ? (blocking[0]?.status === "route-back" ? "route-back" : blocking[0]?.status === "wait" ? "wait" : blocking[0]?.status === "block" ? "blocked" : "invalid")
    : "allowed";
  return {
    valid: diagnostics.length === 0,
    status,
    diagnostics,
    transition: normalizeTransitionPreview(transition, {
      from_step: currentStepId,
      to_step: expectedNext,
      status: diagnostics.length ? "blocked" : "allowed",
      gate_id: outcomes[0]?.gate_id,
      reason: diagnostics.length ? blocking[0]?.summary : "required gates passed",
      at: transition.at ?? request.now
    })
  };
}

export const validateTransitionRequest = validateRunTransition;
