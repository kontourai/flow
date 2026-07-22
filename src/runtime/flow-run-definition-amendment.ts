import { createHash } from "node:crypto";

import type {
  FlowDefinitionAmendmentEvent,
  FlowDefinitionAmendmentRequest,
  FlowDefinitionIdentity,
  FlowLifecycleAuthority
} from "../contracts/flow-types.js";
import { findGate, validateDefinition } from "../definition/flow-definition.js";
import { isNonEmptyString, isObject } from "../shared/flow-utils.js";
import { parseRfc3339Timestamp } from "../shared/rfc3339.js";
import { canonicalJson, flowRunHead } from "./flow-run-retry-authorization.js";
import { validateRetryAuthorizationHistory } from "./flow-run-retry-proof.js";
import { validateRunStateSchema } from "./flow-run-validator.js";

const AUTHORITY_KINDS = new Set(["user_request", "operator_request"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LIMITS = Object.freeze({ actor: 256, request_ref: 2048, reason: 4096, reference: 128 });

export class FlowDefinitionAmendmentError extends Error {
  readonly code: string;
  readonly diagnostics: Array<{ code: string; severity: "error"; path: string; message: string }>;
  constructor(code: string, path: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "FlowDefinitionAmendmentError";
    this.code = code;
    this.diagnostics = [{ code, severity: "error", path, message }];
  }
}

function fail(code: string, path: string, message: string): never {
  throw new FlowDefinitionAmendmentError(code, path, message);
}

function text(value: unknown, path: string, limit: number, code = "flow.definition_amendment.request.invalid") {
  if (typeof value !== "string" || !isNonEmptyString(value) || CONTROL.test(value) || [...value].length > limit) {
    fail(code, path, `${path.slice(2)} must be a non-empty control-character-free string of at most ${limit} characters`);
  }
  return value;
}

function digestText(value: unknown, path: string) {
  const digest = text(value, path, LIMITS.reference);
  if (!/^[a-f0-9]{64}$/i.test(digest)) fail("flow.definition_amendment.request.invalid", path, `${path.slice(2)} must be a SHA-256 digest`);
  return digest.toLowerCase();
}

function authority(value: unknown): FlowLifecycleAuthority {
  if (!isObject(value)) fail("flow.definition_amendment.authority.invalid", "$.authority", "authority must be an object");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["kind", "actor", "request_ref", "requested_at"].includes(key))) {
    fail("flow.definition_amendment.authority.invalid", "$.authority", "authority contains unsupported fields");
  }
  if (!AUTHORITY_KINDS.has(candidate.kind as string)) fail("flow.definition_amendment.authority.invalid", "$.authority.kind", "authority.kind must be user_request or operator_request");
  const requested_at = text(candidate.requested_at, "$.authority.requested_at", LIMITS.reference, "flow.definition_amendment.authority.invalid");
  if (parseRfc3339Timestamp(requested_at) === null) fail("flow.definition_amendment.authority.invalid", "$.authority.requested_at", "authority.requested_at must be an RFC 3339 timestamp");
  return {
    kind: candidate.kind as FlowLifecycleAuthority["kind"],
    actor: text(candidate.actor, "$.authority.actor", LIMITS.actor, "flow.definition_amendment.authority.invalid"),
    request_ref: text(candidate.request_ref, "$.authority.request_ref", LIMITS.request_ref, "flow.definition_amendment.authority.invalid"),
    requested_at
  };
}

function identity(value: unknown, path: string): FlowDefinitionIdentity {
  if (!isObject(value)) fail("flow.definition_amendment.request.invalid", path, "expected definition identity must be an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["id", "version", "digest"].includes(key))) fail("flow.definition_amendment.request.invalid", path, "definition identity contains unsupported fields");
  return { id: text(record.id, `${path}.id`, LIMITS.reference), version: text(record.version, `${path}.version`, LIMITS.reference), digest: digestText(record.digest, `${path}.digest`) };
}

/** SHA-256 of the normalized persisted Flow Definition representation. */
export function definitionDigest(definition: unknown): string {
  return createHash("sha256").update(canonicalJson(validateDefinition(definition))).digest("hex");
}

export function definitionIdentity(definition: unknown): FlowDefinitionIdentity {
  const normalized = validateDefinition(definition);
  return { id: normalized.id, version: normalized.version, digest: definitionDigest(normalized) };
}

export function validateDefinitionAmendmentRequest(value: unknown): FlowDefinitionAmendmentRequest {
  if (!isObject(value)) fail("flow.definition_amendment.request.invalid", "$", "definition amendment request must be an object");
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => !["reason", "expected_run_head", "expected_definition", "successor_digest", "authority"].includes(key))) {
    fail("flow.definition_amendment.request.invalid", "$", "definition amendment request contains unsupported fields");
  }
  return {
    reason: text(request.reason, "$.reason", LIMITS.reason),
    expected_run_head: digestText(request.expected_run_head, "$.expected_run_head"),
    expected_definition: identity(request.expected_definition, "$.expected_definition"),
    successor_digest: digestText(request.successor_digest, "$.successor_digest"),
    authority: authority(request.authority)
  };
}

export function effectiveDefinitionIdentity(startDefinition: unknown, state: any): FlowDefinitionIdentity {
  return definitionIdentity(resolveEffectiveDefinition(startDefinition, state));
}

/** Resolve and verify the complete, self-contained definition amendment ledger. */
export function resolveEffectiveDefinition(startDefinition: unknown, state: any): any {
  let current = validateDefinition(startDefinition);
  let currentIdentity = definitionIdentity(current);
  const amendments = state?.definition_amendments;
  if (amendments !== undefined && !Array.isArray(amendments)) fail("flow.definition_amendment.compatibility.invalid", "$.definition_amendments", "definition_amendments must be an array");
  // Unamended runs retain the pre-amendment identity and validation contract.
  // In particular, do not require or interpret a digest for ordinary runs:
  // definition.json remains their sole definition head and the store's existing
  // identity checks retain their established diagnostics.
  if ((amendments?.length ?? 0) === 0) return current;
  const seenVersions = new Set([currentIdentity.version]);
  const seenDigests = new Set([currentIdentity.digest]);
  for (const [index, event] of (amendments ?? []).entries()) {
    if (!isObject(event) || event.type !== "definition_amended") fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}]`, "amendment event must have type definition_amended");
    const prior = identity(event.prior_definition, `$.definition_amendments[${index}].prior_definition`);
    const successor = identity(event.successor_definition, `$.definition_amendments[${index}].successor_definition`);
    if (canonicalJson(prior) !== canonicalJson(currentIdentity)) fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}].prior_definition`, "amendment prior identity does not continue the ledger");
    const next = validateDefinition(event.successor);
    if (next.id !== current.id || successor.id !== next.id || successor.version !== next.version || successor.digest !== definitionDigest(next)) {
      fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}]`, "amendment successor identity does not match its complete normalized successor");
    }
    if (seenVersions.has(successor.version) || seenDigests.has(successor.digest)) fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}]`, "amendment reuses a definition version or digest");
    if (!isObject(event.prior_state) || Object.hasOwn(event.prior_state, "definition_amendments")) {
      fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}].prior_state`, "prior_state must be an object without a nested amendment ledger");
    }
    const priorState = {
      ...event.prior_state,
      ...(index > 0 ? { definition_amendments: (amendments as any[]).slice(0, index) } : {})
    };
    try { validateRunStateSchema(priorState); } catch (error) {
      fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}].prior_state`, `prior_state is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (flowRunHead(priorState) !== event.prior_run_head) {
      fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}].prior_run_head`, "prior_run_head does not match the reconstructed pre-amendment state");
    }
    if (priorState.definition_id !== currentIdentity.id || priorState.definition_version !== currentIdentity.version
      || (index > 0 && priorState.definition_digest !== currentIdentity.digest)) {
      fail("flow.definition_amendment.compatibility.invalid", `$.definition_amendments[${index}].prior_state`, "prior_state definition identity does not match the ledger head");
    }
    assertDefinitionCompatibility(current, next, priorState, `$.definition_amendments[${index}].successor`);
    seenVersions.add(successor.version); seenDigests.add(successor.digest); current = next; currentIdentity = successor;
  }
  if (state?.definition_id !== current.id || state?.definition_version !== current.version) fail("flow.definition_amendment.compatibility.invalid", "$.definition_version", "state definition identity does not match the effective definition");
  if (state?.definition_digest !== currentIdentity.digest) fail("flow.definition_amendment.compatibility.invalid", "$.definition_digest", "state definition_digest does not match the effective definition");
  return current;
}

function same(value: unknown, other: unknown) { return canonicalJson(value) === canonicalJson(other); }

/** Strict history proof: history-bearing nodes and accepted contracts may not be reinterpreted. */
export function assertDefinitionCompatibility(prior: any, successor: any, state: any, path = "$.successor") {
  if (prior.id !== successor.id) fail("flow.definition_amendment.compatibility.invalid", `${path}.id`, "successor must retain the definition id");
  if (prior.version === successor.version) fail("flow.definition_amendment.compatibility.invalid", `${path}.version`, "successor must use a different opaque version");
  const successorSteps = new Map((successor.steps as any[]).map((step: any) => [step.id, step]));
  const historicalGateIds = new Set<string>();
  const projectedGateIds = new Set<string>((state?.gate_outcomes ?? []).map((outcome: any) => outcome?.gate_id).filter(Boolean));
  const exceptionGateIds = new Set<string>((state?.exceptions ?? []).map((exception: any) => exception?.gate_id).filter(Boolean));
  const stepIds = new Set<string>([state?.current_step]);
  for (const item of [...(state?.gate_outcomes ?? []), ...(state?.gate_outcome_history ?? []), ...(state?.transitions ?? []), ...(state?.exceptions ?? [])]) {
    if (item?.gate_id) historicalGateIds.add(item.gate_id);
    if (item?.from_step) stepIds.add(item.from_step);
    if (item?.to_step) stepIds.add(item.to_step);
    if (item?.selected_route) stepIds.add(item.selected_route);
    if (item?.route_back_to) stepIds.add(item.route_back_to);
  }
  for (const stepId of stepIds) {
    if (!stepId || !successorSteps.has(stepId)) fail("flow.definition_amendment.compatibility.invalid", path, `successor removes persisted step ${stepId}`);
    const oldStep = (prior.steps as any[]).find((step: any) => step.id === stepId);
    if (oldStep && !same(oldStep, successorSteps.get(stepId))) fail("flow.definition_amendment.compatibility.invalid", path, `successor reinterprets persisted step ${stepId}`);
  }
  for (const gateId of historicalGateIds) {
    const oldGate = findGate(prior, gateId); const nextGate = findGate(successor, gateId);
    if (!oldGate || !nextGate) fail("flow.definition_amendment.compatibility.invalid", path, `successor removes persisted gate ${gateId}`);
    if (oldGate.step !== nextGate.step) fail("flow.definition_amendment.compatibility.invalid", path, `successor reinterprets persisted gate ${gateId} step`);
    // Current projections and accepted exceptions still drive runtime behavior,
    // so their complete gate contract is immutable. Audit-only history is
    // instead protected by its referenced expectations plus semantic replay of
    // route-back/retry transitions below. That permits a new, unconsumed route
    // reason on a re-entered current gate without changing an earlier outcome.
    if ((projectedGateIds.has(gateId) || exceptionGateIds.has(gateId)) && !same(oldGate, nextGate)) {
      fail("flow.definition_amendment.compatibility.invalid", path, `successor reinterprets projected gate ${gateId}`);
    }
  }
  for (const outcome of [...(state?.gate_outcomes ?? []), ...(state?.gate_outcome_history ?? [])]) {
    for (const match of outcome?.matched_expectations ?? []) {
      const oldExpectation = findGate(prior, outcome.gate_id)?.expects?.find((entry: any) => entry.id === match.expectation_id);
      const nextExpectation = findGate(successor, outcome.gate_id)?.expects?.find((entry: any) => entry.id === match.expectation_id);
      if (!oldExpectation || !nextExpectation || !same(oldExpectation, nextExpectation)) fail("flow.definition_amendment.compatibility.invalid", path, `successor changes accepted expectation ${match.expectation_id}`);
    }
  }
  try { validateRetryAuthorizationHistory(successor, state); } catch (error) { fail("flow.definition_amendment.compatibility.invalid", path, `successor cannot revalidate retry history: ${error instanceof Error ? error.message : String(error)}`); }
}

export function assertExpectedDefinitionIdentity(startDefinition: unknown, state: any, expected: FlowDefinitionIdentity) {
  const actual = effectiveDefinitionIdentity(startDefinition, state);
  if (!same(actual, expected)) fail("flow.definition_amendment.definition_head.stale", "$.expected_definition", "expected definition identity does not match the effective definition");
  return actual;
}

export function amendmentRequestReplayExists(state: any, request: FlowDefinitionAmendmentRequest) {
  return (state?.definition_amendments ?? []).some((event: FlowDefinitionAmendmentEvent) => event?.authority?.request_ref === request.authority.request_ref);
}

export function amendmentPriorHeadMatches(state: any, request: FlowDefinitionAmendmentRequest) {
  return flowRunHead(state) === request.expected_run_head;
}
