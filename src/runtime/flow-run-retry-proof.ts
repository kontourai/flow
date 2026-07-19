import { descendantsOf, findGate, routeBackDecision } from "../definition/flow-definition.js";
import { isObject } from "../shared/flow-utils.js";
import {
  FlowRetryAuthorizationError,
  flowTransitionRef
} from "./flow-run-retry-authorization.js";

const routeBackOnlyFields = ["attempt", "max_attempts", "limit_exceeded", "recovery_step"];
const retryAuthorizationOnlyFields = ["blocked_transition_ref", "prior_run_head", "prior_retry_epoch", "authority"];

function hasOwn(record: any, field: string) {
  return isObject(record) && Object.prototype.hasOwnProperty.call(record, field);
}

function transitionShape(record: any) {
  const routeFamily = routeBackOnlyFields.some((field) => hasOwn(record, field));
  const authorizationFamily = retryAuthorizationOnlyFields.some((field) => hasOwn(record, field));
  return {
    routeFamily,
    authorizationFamily,
    routeBack: record?.type === "route_back" || routeFamily,
    retryAuthorization: record?.type === "retry_authorized"
      || record?.status === "retry-authorized"
      || authorizationFamily
  };
}

function routeBackRecordProof(definition: any, transitions: any[], index: number) {
  const record = transitions[index];
  if (!isObject(record) || record.type !== "route_back") return null;
  const gate = findGate(definition, record.gate_id);
  if (!gate) return null;
  const effectiveRouteReason = record.route_reason ?? record.reason;
  const routeReason = effectiveRouteReason === "default" ? null : effectiveRouteReason;
  const decision = routeBackDecision(
    { transitions: transitions.slice(0, index) },
    gate,
    routeReason
  );
  const selectedRouteDeclared = (definition.steps ?? []).some((step) => step.id === decision.selected_route);
  const valid = record.gate_id === gate.id
    && record.from_step === gate.step
    && record.reason === decision.reason
    && record.route_reason === decision.route_reason
    // Both an ordinary route-back and an exhausted block persist as a
    // `blocked` transition; the derived decision distinguishes their outcome.
    && record.status === "blocked"
    && ["route-back", "block"].includes(decision.status)
    && record.to_step === decision.route_back_to
    && record.selected_route === decision.selected_route
    && record.recovery_step === decision.recovery_step
    && selectedRouteDeclared
    && record.max_attempts === decision.max_attempts
    && record.attempt === decision.attempt
    // Missing epoch is the sole legacy compatibility form and means epoch 1.
    && (record.retry_epoch ?? 1) === decision.retry_epoch
    && record.limit_exceeded === decision.limit_exceeded;
  return valid ? { record, gate, decision, routeReason } : null;
}

/**
 * Prove the first and only canonical exhaustion in one exact route-back epoch.
 * Each matching predecessor is independently derived from its immutable
 * prefix. Matching uses the loop identity rather than the type discriminator,
 * so changing `route_back` to another type cannot hide a predecessor.
 */
export function exhaustedRouteBackProof(definition: any, transitions: any[], blockedIndex: number) {
  const proof = routeBackRecordProof(definition, transitions, blockedIndex);
  if (!proof
    || proof.gate.route_back_policy?.on_exceeded !== "block"
    || !Number.isInteger(proof.gate.route_back_policy?.max_attempts)
    || proof.decision.status !== "block"
    || proof.decision.limit_exceeded !== true) return null;
  const loopReason = proof.record.route_reason ?? proof.record.reason;
  const retryEpoch = proof.decision.retry_epoch;
  for (let index = 0; index < blockedIndex; index += 1) {
    const predecessor = transitions[index];
    const shape = transitionShape(predecessor);
    if (shape.routeFamily && shape.authorizationFamily) return null;
    if (!shape.routeBack) continue;
    const predecessorProof = routeBackRecordProof(definition, transitions, index);
    if (!predecessorProof) return null;
    const sameLoop = predecessorProof.gate.id === proof.gate.id
      && predecessorProof.gate.step === proof.gate.step
      && (predecessorProof.record.route_reason ?? predecessorProof.record.reason) === loopReason
      && predecessorProof.decision.selected_route === proof.decision.selected_route;
    if (sameLoop && predecessorProof.decision.retry_epoch === retryEpoch
      && (predecessorProof.decision.status === "block" || predecessorProof.decision.limit_exceeded === true)) return null;
  }
  return { blocked: proof.record, gate: proof.gate, decision: proof.decision, routeReason: proof.routeReason };
}

export function validateRetryAuthorizationHistory(definition: any, state: any) {
  for (const [index, transition] of (state.transitions ?? []).entries()) {
    const shape = transitionShape(transition);
    if (shape.routeFamily && shape.authorizationFamily) {
      throw new FlowRetryAuthorizationError("flow.retry_authorization.history.invalid", `$.transitions[${index}]`, "transition mixes reserved route-back and retry-authorization field families");
    }
    if (shape.routeBack && !routeBackRecordProof(definition, state.transitions, index)) {
      throw new FlowRetryAuthorizationError("flow.retry_authorization.history.invalid", `$.transitions[${index}]`, "reserved route-back shape is not a canonical route_back derived from its exact history prefix");
    }
    if (!shape.retryAuthorization) continue;
    const proof = exhaustedRouteBackProof(definition, state.transitions, index - 1);
    const blocked = proof?.blocked;
    const expectedInvalidated = descendantsOf(definition, transition.to_step);
    const actualInvalidated = transition.invalidated_steps ?? [];
    const valid = transition.type === "retry_authorized"
      && transition.status === "retry-authorized"
      && retryAuthorizationOnlyFields.every((field) => hasOwn(transition, field))
      && proof !== null
      && flowTransitionRef(blocked) === transition.blocked_transition_ref
      && transition.from_step === blocked.from_step
      && transition.to_step === blocked.selected_route
      && transition.selected_route === blocked.selected_route
      && transition.gate_id === blocked.gate_id
      && transition.route_reason === (blocked.route_reason ?? blocked.reason)
      && transition.prior_retry_epoch === (blocked.retry_epoch ?? 1)
      && transition.retry_epoch === transition.prior_retry_epoch + 1
      && JSON.stringify(actualInvalidated) === JSON.stringify(expectedInvalidated);
    if (!valid) throw new FlowRetryAuthorizationError("flow.retry_authorization.history.invalid", `$.transitions[${index}]`, "persisted retry authorization is inconsistent with its exhausted block and Flow Definition");
  }
}
