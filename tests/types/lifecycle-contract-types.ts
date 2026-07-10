import type {
  FlowLifecycleAuthority,
  FlowLifecycleDiagnostic,
  FlowLifecycleEvent,
  FlowLifecycleRequest,
  FlowRunState
} from "../../src/index.js";

const authority: FlowLifecycleAuthority = {
  kind: "user_request",
  actor: "user:brian",
  request_ref: "request:flow-115",
  requested_at: "2026-07-10T12:00:00.000Z"
};

const request: FlowLifecycleRequest = {
  reason: "User requested a pause",
  authority
};

const event: FlowLifecycleEvent = {
  action: "pause",
  from_status: "blocked",
  to_status: "paused",
  prior_status: "blocked",
  reason: request.reason,
  authority,
  at: "2026-07-10T12:00:01.000Z"
};

const diagnostic: FlowLifecycleDiagnostic = {
  code: "flow.lifecycle.transition.invalid",
  severity: "error",
  path: "$.status",
  message: "completed runs cannot be paused",
  operation: "pause",
  current_status: "completed"
};

const state = {
  lifecycle: [event],
  status: "paused"
} satisfies Pick<FlowRunState, "lifecycle" | "status">;

void [request, diagnostic, state];
