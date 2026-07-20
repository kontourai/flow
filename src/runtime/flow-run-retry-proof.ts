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

function sameExhaustedLoop(first: any, candidate: any) {
  return candidate.gate.id === first.gate.id
    && candidate.record.from_step === first.record.from_step
    && candidate.record.to_step === first.record.to_step
    && candidate.record.reason === first.record.reason
    && (candidate.record.route_reason ?? candidate.record.reason) === (first.record.route_reason ?? first.record.reason)
    && candidate.record.selected_route === first.record.selected_route
    && candidate.record.recovery_step === first.record.recovery_step
    && (candidate.record.retry_epoch ?? 1) === (first.record.retry_epoch ?? 1)
    && candidate.record.max_attempts === first.record.max_attempts
    && candidate.record.status === "blocked"
    && candidate.record.limit_exceeded === true
    && candidate.decision.status === "block"
    && candidate.decision.limit_exceeded === true;
}

function isTerminalBlock(proof: any) {
  return proof.decision.status === "block" && proof.decision.limit_exceeded === true;
}

/**
 * Prove the terminal exhausted suffix of one exact route-back epoch. Historical
 * persistence could append the same canonical exhausted decision repeatedly;
 * that suffix is compatible only when it is contiguous, exact, and derived
 * from every immutable prefix. A different or interleaved exhausted loop is
 * never an alternate authorization target.
 */
export function exhaustedRouteBackProof(definition: any, transitions: any[], blockedIndex: number) {
  const proof = routeBackRecordProof(definition, transitions, blockedIndex);
  if (!proof
    || proof.gate.route_back_policy?.on_exceeded !== "block"
    || !Number.isInteger(proof.gate.route_back_policy?.max_attempts)
    || proof.decision.status !== "block"
    || proof.decision.limit_exceeded !== true) return null;
  let suffixStart = blockedIndex;
  let suffixFirst = proof;
  let expectedAttempt = proof.decision.attempt;
  while (suffixStart > 0) {
    const predecessor = transitions[suffixStart - 1];
    const shape = transitionShape(predecessor);
    if (shape.routeFamily && shape.authorizationFamily) return null;
    if (!shape.routeBack) break;
    const predecessorProof = routeBackRecordProof(definition, transitions, suffixStart - 1);
    if (!predecessorProof) return null;
    if (!sameExhaustedLoop(proof, predecessorProof)) break;
    if (predecessorProof.decision.attempt !== expectedAttempt - 1) return null;
    suffixFirst = predecessorProof;
    expectedAttempt = predecessorProof.decision.attempt;
    suffixStart -= 1;
  }
  if (suffixFirst.decision.attempt !== suffixFirst.decision.max_attempts + 1) return null;

  for (let index = 0; index < suffixStart; index += 1) {
    const predecessor = transitions[index];
    const shape = transitionShape(predecessor);
    if (shape.routeFamily && shape.authorizationFamily) return null;
    if (!shape.routeBack) continue;
    const predecessorProof = routeBackRecordProof(definition, transitions, index);
    if (!predecessorProof) return null;
    if (!isTerminalBlock(predecessorProof)) continue;
    if (predecessorProof.decision.attempt !== predecessorProof.decision.max_attempts + 1) return null;

    let end = index;
    let prior = predecessorProof;
    while (end + 1 < suffixStart) {
      const next = transitions[end + 1];
      const nextShape = transitionShape(next);
      if (nextShape.routeFamily && nextShape.authorizationFamily) return null;
      if (!nextShape.routeBack) break;
      const nextProof = routeBackRecordProof(definition, transitions, end + 1);
      if (!nextProof) return null;
      if (!sameExhaustedLoop(predecessorProof, nextProof)) break;
      if (nextProof.decision.attempt !== prior.decision.attempt + 1) return null;
      prior = nextProof;
      end += 1;
    }
    if (transitions[end + 1]?.type !== "retry_authorized") return null;
    index = end;
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
