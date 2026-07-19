import { createHash } from "node:crypto";

import type { FlowLifecycleAuthority, FlowRetryAuthorizationRequest } from "../contracts/flow-types.js";
import { isNonEmptyString, isObject } from "../shared/flow-utils.js";
import { parseRfc3339Timestamp } from "../shared/rfc3339.js";

const AUTHORITY_KINDS = new Set(["user_request", "operator_request"]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const LIMITS = Object.freeze({ actor: 256, request_ref: 2048, reason: 4096, target_step: 512, reference: 128 });

export class FlowRetryAuthorizationError extends Error {
  readonly code: string;
  readonly diagnostics: Array<{ code: string; severity: "error"; path: string; message: string }>;

  constructor(code: string, path: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "FlowRetryAuthorizationError";
    this.code = code;
    this.diagnostics = [{ code, severity: "error", path, message }];
  }
}

function invalid(path: string, message: string) {
  return new FlowRetryAuthorizationError("flow.retry_authorization.request.invalid", path, message);
}

function authorityInvalid(path: string, message: string) {
  return new FlowRetryAuthorizationError("flow.retry_authorization.authority.invalid", path, message);
}

function text(value: unknown, path: string, limit: number, error = invalid): string {
  if (typeof value !== "string" || !isNonEmptyString(value)) throw error(path, `${path.slice(2)} must be a non-empty string`);
  if (CONTROL.test(value)) throw error(path, `${path.slice(2)} must not contain control characters`);
  if ([...value].length > limit) throw error(path, `${path.slice(2)} must be at most ${limit} characters`);
  return value;
}

function canonicalPersistedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPersistedJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalPersistedJson(object[key])}`).join(",")}}`;
}

/** Canonical hash input over the exact JSON persistence domain. */
export function canonicalJson(value: unknown): string {
  const persisted = JSON.stringify(value);
  if (persisted === undefined) throw invalid("$", "value is not representable as persisted JSON");
  return canonicalPersistedJson(JSON.parse(persisted));
}

export function flowRunHead(state: unknown): string {
  return createHash("sha256").update(canonicalJson(state)).digest("hex");
}

export function flowTransitionRef(transition: unknown): string {
  return createHash("sha256").update(canonicalJson(transition)).digest("hex");
}

/** Strictly validate only the provider-neutral authorization request payload. */
export function validateRetryAuthorizationRequest(value: unknown): FlowRetryAuthorizationRequest {
  if (!isObject(value)) throw invalid("$", "retry authorization request must be an object");
  const request = value as Record<string, unknown>;
  const allowed = new Set(["reason", "target_step", "blocked_transition_ref", "expected_run_head", "authority"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) throw invalid("$", "retry authorization request contains unsupported fields");
  const reason = text(request.reason, "$.reason", LIMITS.reason);
  const target_step = text(request.target_step, "$.target_step", LIMITS.target_step);
  const blocked_transition_ref = text(request.blocked_transition_ref, "$.blocked_transition_ref", LIMITS.reference);
  const expected_run_head = text(request.expected_run_head, "$.expected_run_head", LIMITS.reference);
  if (!/^[a-f0-9]{64}$/i.test(blocked_transition_ref)) throw invalid("$.blocked_transition_ref", "blocked_transition_ref must be a SHA-256 reference");
  if (!/^[a-f0-9]{64}$/i.test(expected_run_head)) throw invalid("$.expected_run_head", "expected_run_head must be a SHA-256 reference");
  if (!isObject(request.authority)) throw authorityInvalid("$.authority", "authority must be an object");
  const authority = request.authority as Record<string, unknown>;
  const allowedAuthority = new Set(["kind", "actor", "request_ref", "requested_at"]);
  if (Object.keys(authority).some((key) => !allowedAuthority.has(key))) throw authorityInvalid("$.authority", "authority contains unsupported fields");
  if (!AUTHORITY_KINDS.has(authority.kind as string)) throw authorityInvalid("$.authority.kind", "authority.kind must be user_request or operator_request");
  const actor = text(authority.actor, "$.authority.actor", LIMITS.actor, authorityInvalid);
  const request_ref = text(authority.request_ref, "$.authority.request_ref", LIMITS.request_ref, authorityInvalid);
  const requested_at = text(authority.requested_at, "$.authority.requested_at", LIMITS.reference, authorityInvalid);
  if (parseRfc3339Timestamp(requested_at) === null) throw authorityInvalid("$.authority.requested_at", "authority.requested_at must be an RFC 3339 timestamp");
  return { reason, target_step, blocked_transition_ref, expected_run_head, authority: { kind: authority.kind as FlowLifecycleAuthority["kind"], actor, request_ref, requested_at } };
}

export function retryAuthorizationMatches(transition: any, request: FlowRetryAuthorizationRequest): boolean {
  return transition?.type === "retry_authorized"
    && transition.reason === request.reason
    && transition.to_step === request.target_step
    && transition.blocked_transition_ref === request.blocked_transition_ref
    && transition.prior_run_head === request.expected_run_head
    && transition.authority?.kind === request.authority.kind
    && transition.authority?.actor === request.authority.actor
    && transition.authority?.request_ref === request.authority.request_ref
    && transition.authority?.requested_at === request.authority.requested_at;
}
