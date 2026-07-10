import type {
  FlowLifecycleAction,
  FlowLifecycleAuthority,
  FlowLifecycleDiagnostic,
  FlowLifecycleEvent,
  FlowLifecycleRequest,
  FlowResumableStatus,
  FlowRunState,
  FlowRunStatus
} from "../contracts/flow-types.js";
import { isNonEmptyString, isObject } from "../shared/flow-utils.js";

const RESUMABLE = new Set<FlowRunStatus>(["active", "blocked", "needs_decision"]);
const CANCELABLE = new Set<FlowRunStatus>([...RESUMABLE, "paused"]);
const AUTHORITY_KINDS = new Set(["user_request", "operator_request"]);
export const FLOW_LIFECYCLE_TEXT_LIMITS = Object.freeze({
  actor: 256,
  request_ref: 2048,
  reason: 4096
});
const TERMINAL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export class FlowLifecycleError extends Error {
  readonly code: FlowLifecycleDiagnostic["code"];
  readonly diagnostics: FlowLifecycleDiagnostic[];

  constructor(diagnostic: FlowLifecycleDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "FlowLifecycleError";
    this.code = diagnostic.code;
    this.diagnostics = [diagnostic];
  }
}

function diagnostic(
  code: FlowLifecycleDiagnostic["code"],
  operation: FlowLifecycleDiagnostic["operation"],
  currentStatus: FlowRunStatus | undefined,
  path: string,
  message: string
): FlowLifecycleDiagnostic {
  return {
    code,
    severity: "error",
    path,
    message,
    operation,
    ...(currentStatus ? { current_status: currentStatus } : {})
  };
}

export function lifecycleEligibilityDiagnostic(
  operation: FlowLifecycleDiagnostic["operation"],
  status: FlowRunStatus
): FlowLifecycleDiagnostic | null {
  if (["evaluate", "advance", "attach_evidence", "accept_exception", "persist"].includes(operation)) {
    if (status === "paused") return diagnostic("flow.lifecycle.run_paused", operation, status, "$.status", `paused runs cannot ${operation.replaceAll("_", " ")}`);
    if (status === "canceled") return diagnostic("flow.lifecycle.run_canceled", operation, status, "$.status", `canceled runs cannot ${operation.replaceAll("_", " ")}`);
    return null;
  }
  if (operation === "pause" && !RESUMABLE.has(status)) {
    return diagnostic("flow.lifecycle.transition.invalid", operation, status, "$.status", `runs with status ${status} cannot be paused`);
  }
  if (operation === "resume" && status !== "paused") {
    return diagnostic("flow.lifecycle.transition.invalid", operation, status, "$.status", `runs with status ${status} cannot be resumed`);
  }
  if (operation === "cancel" && !CANCELABLE.has(status)) {
    return diagnostic(
      status === "canceled" ? "flow.lifecycle.replay.conflict" : "flow.lifecycle.run_terminal",
      operation,
      status,
      "$.status",
      `runs with status ${status} cannot be canceled`
    );
  }
  return null;
}

export function assertLifecycleEligible(operation: FlowLifecycleDiagnostic["operation"], status: FlowRunStatus) {
  const issue = lifecycleEligibilityDiagnostic(operation, status);
  if (issue) throw new FlowLifecycleError(issue);
}

export function validateLifecycleRequest(operation: FlowLifecycleAction, value: unknown): FlowLifecycleRequest {
  if (!isObject(value)) {
    throw new FlowLifecycleError(diagnostic("flow.lifecycle.request.invalid", operation, undefined, "$", "lifecycle request must be an object"));
  }
  const request = value as Record<string, any>;
  if (!isNonEmptyString(request.reason)) {
    throw new FlowLifecycleError(diagnostic("flow.lifecycle.request.invalid", operation, undefined, "$.reason", "reason must be a non-empty string"));
  }
  validateLifecycleText(operation, "reason", request.reason, FLOW_LIFECYCLE_TEXT_LIMITS.reason, "flow.lifecycle.request.invalid");
  if (!isObject(request.authority)) {
    throw new FlowLifecycleError(diagnostic("flow.lifecycle.authority.invalid", operation, undefined, "$.authority", "authority must be an object"));
  }
  const authority = request.authority as Record<string, any>;
  if (!AUTHORITY_KINDS.has(authority.kind)) {
    throw new FlowLifecycleError(diagnostic("flow.lifecycle.authority.invalid", operation, undefined, "$.authority.kind", "authority.kind must be user_request or operator_request"));
  }
  for (const field of ["actor", "request_ref", "requested_at"]) {
    if (!isNonEmptyString(authority[field])) {
      throw new FlowLifecycleError(diagnostic("flow.lifecycle.authority.invalid", operation, undefined, `$.authority.${field}`, `authority.${field} must be a non-empty string`));
    }
  }
  validateLifecycleText(operation, "authority.actor", authority.actor, FLOW_LIFECYCLE_TEXT_LIMITS.actor, "flow.lifecycle.authority.invalid");
  validateLifecycleText(operation, "authority.request_ref", authority.request_ref, FLOW_LIFECYCLE_TEXT_LIMITS.request_ref, "flow.lifecycle.authority.invalid");
  if (!Number.isFinite(Date.parse(authority.requested_at))) {
    throw new FlowLifecycleError(diagnostic("flow.lifecycle.authority.invalid", operation, undefined, "$.authority.requested_at", "authority.requested_at must be a date-time"));
  }
  const allowedRequest = new Set(["reason", "authority"]);
  const allowedAuthority = new Set(["kind", "actor", "request_ref", "requested_at"]);
  if (Object.keys(request).some((key) => !allowedRequest.has(key)) || Object.keys(authority).some((key) => !allowedAuthority.has(key))) {
    throw new FlowLifecycleError(diagnostic("flow.lifecycle.request.invalid", operation, undefined, "$", "lifecycle request contains unsupported fields"));
  }
  return {
    reason: request.reason,
    authority: {
      kind: authority.kind as FlowLifecycleAuthority["kind"],
      actor: authority.actor,
      request_ref: authority.request_ref,
      requested_at: authority.requested_at
    }
  };
}

function validateLifecycleText(
  operation: FlowLifecycleAction,
  field: string,
  value: string,
  maxLength: number,
  code: "flow.lifecycle.request.invalid" | "flow.lifecycle.authority.invalid"
) {
  if (TERMINAL_CONTROL.test(value)) {
    throw new FlowLifecycleError(diagnostic(code, operation, undefined, `$.${field}`, `${field} must not contain control characters`));
  }
  if ([...value].length > maxLength) {
    throw new FlowLifecycleError(diagnostic(code, operation, undefined, `$.${field}`, `${field} must be at most ${maxLength} characters`));
  }
}

export function validateRunLifecycle(state: FlowRunState) {
  const lifecycle = state.lifecycle;
  if (lifecycle === undefined) {
    if (state.status === "paused" || state.status === "canceled") {
      throw new Error(`flow.lifecycle.state.invalid: ${state.status} run requires lifecycle history`);
    }
    return state;
  }
  if (lifecycle.length === 0) {
    if (state.status === "paused" || state.status === "canceled") {
      throw new Error(`flow.lifecycle.state.invalid: ${state.status} run requires a lifecycle event`);
    }
    return state;
  }

  let pausedPrior: FlowResumableStatus | null = null;
  let terminal = false;
  let priorAt = -Infinity;
  for (const [index, event] of lifecycle.entries()) {
    if (terminal) throw new Error(`flow.lifecycle.state.invalid: lifecycle[${index}] follows terminal cancellation`);
    const eventTime = Date.parse(event.at);
    if (eventTime < priorAt) throw new Error(`flow.lifecycle.state.invalid: lifecycle[${index}].at precedes the prior event`);
    priorAt = eventTime;
    if (event.action === "pause") {
      if (pausedPrior !== null || !RESUMABLE.has(event.from_status) || event.prior_status !== event.from_status || event.to_status !== "paused") {
        throw new Error(`flow.lifecycle.state.invalid: lifecycle[${index}] pause does not capture its resumable from_status`);
      }
      pausedPrior = event.prior_status;
    } else if (event.action === "resume") {
      if (event.from_status !== "paused" || pausedPrior === null || event.prior_status !== pausedPrior || event.to_status !== pausedPrior) {
        throw new Error(`flow.lifecycle.state.invalid: lifecycle[${index}] resume does not restore the captured prior_status`);
      }
      pausedPrior = null;
    } else {
      const expectedPrior = event.from_status === "paused" ? pausedPrior : event.from_status;
      if ((pausedPrior !== null && event.from_status !== "paused") || !CANCELABLE.has(event.from_status) || expectedPrior === null || event.prior_status !== expectedPrior || event.to_status !== "canceled") {
        throw new Error(`flow.lifecycle.state.invalid: lifecycle[${index}] cancellation does not preserve prior resumable status`);
      }
      pausedPrior = null;
      terminal = true;
    }
  }

  const latest = lifecycle.at(-1)!;
  if (state.status === "paused" && (latest.action !== "pause" || latest.to_status !== "paused")) {
    throw new Error("flow.lifecycle.state.invalid: paused status must agree with the latest lifecycle event");
  }
  if (state.status === "canceled" && (latest.action !== "cancel" || latest.to_status !== "canceled")) {
    throw new Error("flow.lifecycle.state.invalid: canceled status must agree with the latest lifecycle event");
  }
  if (latest.to_status === "paused" && state.status !== "paused") {
    throw new Error("flow.lifecycle.state.invalid: latest pause event requires paused status");
  }
  if (latest.to_status === "canceled" && state.status !== "canceled") {
    throw new Error("flow.lifecycle.state.invalid: cancellation is terminal and cannot be reversed");
  }
  return state;
}

export function lifecycleRequestMatches(event: FlowLifecycleEvent, request: FlowLifecycleRequest) {
  return event.reason === request.reason
    && event.authority.kind === request.authority.kind
    && event.authority.actor === request.authority.actor
    && event.authority.request_ref === request.authority.request_ref
    && event.authority.requested_at === request.authority.requested_at;
}

export function priorResumableStatus(state: FlowRunState): FlowResumableStatus {
  if (RESUMABLE.has(state.status)) return state.status as FlowResumableStatus;
  if (state.status === "paused") {
    const pause = [...(state.lifecycle ?? [])].reverse().find((event) => event.action === "pause");
    if (pause) return pause.prior_status;
  }
  throw new FlowLifecycleError(diagnostic("flow.lifecycle.transition.invalid", "resume", state.status, "$.lifecycle", "paused run has no resumable pause record"));
}
