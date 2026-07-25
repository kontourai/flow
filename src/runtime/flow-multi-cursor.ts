import { createHash } from "node:crypto";

import type {
  FlowDefinitionIdentity,
  FlowDurableStepClaim,
  FlowDurableStepClaimRequest,
  FlowMultiCursorState,
  FlowStepClaimActor
} from "../contracts/flow-types.js";
import { getStep, validateDefinition } from "../definition/flow-definition.js";
import { claimReadySteps, FLOW_MUTABLE_RESOURCE_LIMIT } from "../claims/flow-step-claims.js";
import { definitionIdentity } from "./flow-run-definition-amendment.js";
import { canonicalJson } from "./flow-run-retry-authorization.js";

export const FLOW_DURABLE_CLAIM_SCHEMA_VERSION = "1" as const;
export const FLOW_DURABLE_CLAIM_DEFAULT_LEASE_SECONDS = 300;
export const FLOW_DURABLE_CLAIM_MAX_LEASE_SECONDS = 3600;

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]*$/u;
const RESOURCE = /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._:-]*)*$/u;

export class FlowMultiCursorError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "FlowMultiCursorError";
  }
}

function invalid(code: string, message: string): never {
  throw new FlowMultiCursorError(code, message);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !IDENTIFIER.test(value)) {
    invalid("flow.multi_cursor.claim.invalid", `${field} must be a lowercase identifier`);
  }
  return value;
}

function actor(value: unknown): FlowStepClaimActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("flow.multi_cursor.claim.actor.invalid", "actor must be an object");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => key !== "key" && key !== "kind")) invalid("flow.multi_cursor.claim.actor.invalid", "actor contains unsupported fields");
  const key = identifier(entry.key, "actor.key");
  const kind = entry.kind === undefined ? undefined : identifier(entry.kind, "actor.kind");
  return { key, ...(kind === undefined ? {} : { kind }) };
}

function sameActor(left: FlowStepClaimActor, right: FlowStepClaimActor) {
  return left.key === right.key && left.kind === right.kind;
}

function resourceList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > FLOW_MUTABLE_RESOURCE_LIMIT) invalid("flow.multi_cursor.claim.invalid", "mutable_resources must be a bounded array");
  const resources = value.map((entry) => {
    if (typeof entry !== "string" || entry.length > 128 || !RESOURCE.test(entry)) invalid("flow.multi_cursor.claim.invalid", "mutable_resources contains an invalid resource id");
    return entry;
  });
  if (new Set(resources).size !== resources.length) invalid("flow.multi_cursor.claim.invalid", "mutable_resources contains duplicates");
  return resources;
}

function iso(value: unknown, field: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) invalid("flow.multi_cursor.claim.invalid", `${field} must be an RFC 3339 timestamp`);
  return value;
}

function claimIdentity(definition: unknown): FlowDefinitionIdentity {
  const normalized = validateDefinition(definition);
  if (normalized.execution?.mode !== "multi-cursor" || normalized.execution.claim_contract_version !== "1") {
    invalid("flow.multi_cursor.definition.required", "durable claims require execution.mode multi-cursor and claim_contract_version 1");
  }
  return definitionIdentity(normalized);
}

/** Initialize only the lease ledger; no semantic run field is modified. */
export function ensureMultiCursorState(state: any): FlowMultiCursorState {
  if (!state.multi_cursor) {
    state.multi_cursor = { schema_version: "1", active_claims: [], blocked_steps: [], claim_history: [] };
  }
  const cursor = state.multi_cursor as FlowMultiCursorState;
  if (cursor.schema_version !== "1" || !Array.isArray(cursor.active_claims) || !Array.isArray(cursor.blocked_steps) || !Array.isArray(cursor.claim_history)) {
    invalid("flow.multi_cursor.state.invalid", "multi_cursor must contain schema_version 1 and array ledgers");
  }
  return cursor;
}

/**
 * A claim base is a step-local projection of semantic run state.  It excludes
 * `multi_cursor` (including claims, renewals and history) and wall-clock
 * `updated_at`, so adding or renewing one claim can never invalidate itself
 * or an independent sibling.  It includes every predecessor settlement and
 * every route/retry transition that touches this step's prerequisite domain.
 */
export function claimBaseHead(definitionValue: unknown, state: any, stepId: string): string {
  const definition = validateDefinition(definitionValue);
  const identity = claimIdentity(definition);
  const step = getStep(definition, stepId);
  if (!step) invalid("flow.multi_cursor.step.unknown", `unknown step ${stepId}`);
  const relevant = new Set<string>([stepId]);
  const visit = (id: string) => {
    for (const predecessor of getStep(definition, id)?.needs ?? []) {
      if (!relevant.has(predecessor)) { relevant.add(predecessor); visit(predecessor); }
    }
  };
  visit(stepId);
  const gateFor = (id: string) => Object.entries(definition.gates ?? {})
    .filter(([, gate]: [string, any]) => gate.step === id)
    .map(([gateId]) => gateId)
    .sort();
  const relevantGates = new Set([...relevant].flatMap(gateFor));
  const routeTouchesDomain = (transition: any) => (
    relevant.has(transition?.from_step)
    || relevant.has(transition?.to_step)
    || (transition?.invalidated_steps ?? []).some((id: string) => relevant.has(id))
  );
  const domain = {
    schema_version: "1",
    run_id: state.run_id,
    definition: identity,
    step_id: stepId,
    status: state.status,
    predecessors: [...relevant].sort(),
    gate_outcomes: (state.gate_outcomes ?? [])
      .filter((outcome: any) => relevantGates.has(outcome?.gate_id))
      .map((outcome: any) => ({ gate_id: outcome.gate_id, status: outcome.status, evidence_refs: outcome.evidence_refs ?? [], route_back_to: outcome.route_back_to ?? null, retry_epoch: outcome.retry_epoch ?? 1 })),
    transitions: (state.transitions ?? [])
      .filter((transition: any) => transition?.status === "allowed" && relevant.has(transition?.from_step) || ["route_back", "retry_authorized"].includes(transition?.type) && routeTouchesDomain(transition))
      .map((transition: any) => ({ type: transition.type ?? null, from_step: transition.from_step ?? null, to_step: transition.to_step ?? null, status: transition.status ?? null, gate_id: transition.gate_id ?? null, invalidated_steps: transition.invalidated_steps ?? [], retry_epoch: transition.retry_epoch ?? 1, at: transition.at ?? null }))
  };
  return createHash("sha256").update(canonicalJson(domain)).digest("hex");
}

export function claimableMultiCursorSteps(definition: unknown, state: any): string[] {
  const cursor = ensureMultiCursorState(state);
  const blocked = new Set(cursor.blocked_steps.map((entry) => entry.step_id));
  const active = new Set(cursor.active_claims.map((entry) => entry.step_id));
  return claimReadySteps(definition, state).filter((stepId) => !blocked.has(stepId) && !active.has(stepId));
}

export function validateDurableStepClaim(definitionValue: unknown, state: any, value: unknown, now?: Date): FlowDurableStepClaim {
  const definition = validateDefinition(definitionValue);
  const identity = claimIdentity(definition);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("flow.multi_cursor.claim.invalid", "claim must be an object");
  const claim = value as Record<string, any>;
  const fields = new Set(["schema_version", "claim_id", "liveness_id", "run_id", "definition", "claim_base", "step_id", "actor", "mutable_resources", "issued_at", "renewed_at", "expires_at"]);
  if (Object.keys(claim).some((key) => !fields.has(key))) invalid("flow.multi_cursor.claim.invalid", "claim contains unsupported fields");
  if (claim.schema_version !== "1") invalid("flow.multi_cursor.claim.invalid", "claim schema_version must be 1");
  const claim_id = identifier(claim.claim_id, "claim_id");
  const liveness_id = identifier(claim.liveness_id, "liveness_id");
  const step_id = identifier(claim.step_id, "step_id");
  if (claim.run_id !== state.run_id) invalid("flow.multi_cursor.claim.stale", "claim run_id is stale");
  if (!claim.definition || claim.definition.id !== identity.id || claim.definition.version !== identity.version || claim.definition.digest !== identity.digest) invalid("flow.multi_cursor.claim.stale", "claim definition identity is stale");
  const declared = getStep(definition, step_id)?.mutable_resources;
  if (!declared) invalid("flow.multi_cursor.claim.step.unknown", `unknown step ${step_id}`);
  const resources = resourceList(claim.mutable_resources);
  if (resources.length !== declared.length || resources.some((resource) => !declared.includes(resource))) invalid("flow.multi_cursor.claim.invalid", "claim mutable_resources must equal the step declaration");
  if (!claim.claim_base || claim.claim_base.schema_version !== "1" || claim.claim_base.step_id !== step_id || typeof claim.claim_base.head !== "string" || !/^[a-f0-9]{64}$/u.test(claim.claim_base.head)) invalid("flow.multi_cursor.claim.invalid", "claim_base is invalid");
  if (claim.claim_base.head !== claimBaseHead(definition, state, step_id)) invalid("flow.multi_cursor.claim.stale", "claim base is stale for its step domain");
  const issued_at = iso(claim.issued_at, "issued_at");
  const renewed_at = iso(claim.renewed_at, "renewed_at");
  const expires_at = iso(claim.expires_at, "expires_at");
  if (Date.parse(expires_at) <= Date.parse(renewed_at) || Date.parse(renewed_at) < Date.parse(issued_at)) invalid("flow.multi_cursor.claim.invalid", "claim timestamps are not ordered");
  if (now && Date.parse(expires_at) <= now.getTime()) invalid("flow.multi_cursor.claim.expired", "claim liveness lease has expired");
  return { schema_version: "1", claim_id, liveness_id, run_id: state.run_id, definition: identity, claim_base: { schema_version: "1", step_id, head: claim.claim_base.head }, step_id, actor: actor(claim.actor), mutable_resources: resources, issued_at, renewed_at, expires_at };
}

/** Validate durable state on load without treating an expired lease as corrupt. */
export function validateMultiCursorState(definitionValue: unknown, state: any) {
  if (!state?.multi_cursor) return state;
  const definition = validateDefinition(definitionValue);
  claimIdentity(definition);
  const cursor = state.multi_cursor as FlowMultiCursorState;
  if (cursor.schema_version !== "1" || !Array.isArray(cursor.active_claims) || !Array.isArray(cursor.blocked_steps) || !Array.isArray(cursor.claim_history)) {
    invalid("flow.multi_cursor.state.invalid", "multi_cursor must contain schema_version 1 and array ledgers");
  }
  const ids = new Set<string>();
  const steps = new Set<string>();
  const resources = new Set<string>();
  for (const claim of cursor.active_claims) {
    const valid = validateDurableStepClaim(definition, state, claim);
    if (ids.has(valid.claim_id) || steps.has(valid.step_id)) invalid("flow.multi_cursor.state.invalid", "active claim ids and step ids must be unique");
    ids.add(valid.claim_id); steps.add(valid.step_id);
    for (const resource of valid.mutable_resources) {
      if (resources.has(resource)) invalid("flow.multi_cursor.state.invalid", "active claim mutable resources must not overlap");
      resources.add(resource);
    }
  }
  const blocked = new Set<string>();
  for (const entry of cursor.blocked_steps) {
    if (!entry || typeof entry !== "object" || blocked.has(entry.step_id) || steps.has(entry.step_id)) invalid("flow.multi_cursor.state.invalid", "blocked steps must be unique and unclaimed");
    blocked.add(entry.step_id);
  }
  return state;
}

export function buildDurableStepClaim(definitionValue: unknown, state: any, request: FlowDurableStepClaimRequest, now = new Date()): FlowDurableStepClaim {
  const definition = validateDefinition(definitionValue);
  const identity = claimIdentity(definition);
  const claim_id = identifier(request?.claim_id, "claim_id");
  const liveness_id = identifier(request?.liveness_id, "liveness_id");
  const step_id = identifier(request?.step_id, "step_id");
  if (!claimableMultiCursorSteps(definition, state).includes(step_id)) invalid("flow.multi_cursor.claim.not_ready", `step ${step_id} is not claimable`);
  const lease_seconds = request?.lease_seconds ?? FLOW_DURABLE_CLAIM_DEFAULT_LEASE_SECONDS;
  if (!Number.isInteger(lease_seconds) || lease_seconds < 1 || lease_seconds > FLOW_DURABLE_CLAIM_MAX_LEASE_SECONDS) invalid("flow.multi_cursor.claim.lease.invalid", `lease_seconds must be an integer between 1 and ${FLOW_DURABLE_CLAIM_MAX_LEASE_SECONDS}`);
  const issued_at = now.toISOString();
  const expires_at = new Date(now.getTime() + lease_seconds * 1000).toISOString();
  return {
    schema_version: "1", claim_id, liveness_id, run_id: state.run_id, definition: identity,
    claim_base: { schema_version: "1", step_id, head: claimBaseHead(definition, state, step_id) },
    step_id, actor: actor(request?.actor), mutable_resources: [...(getStep(definition, step_id)?.mutable_resources ?? [])], issued_at, renewed_at: issued_at, expires_at
  };
}

export function sameClaimActor(left: FlowDurableStepClaim, right: FlowStepClaimActor) { return sameActor(left.actor, right); }

export function releaseClaimsForSteps(state: any, steps: Set<string>, at: string, reason: string) {
  const cursor = ensureMultiCursorState(state);
  const released = cursor.active_claims.filter((claim) => steps.has(claim.step_id));
  cursor.active_claims = cursor.active_claims.filter((claim) => !steps.has(claim.step_id));
  cursor.claim_history.push(...released.map((claim) => ({ action: "invalidated" as const, claim_id: claim.claim_id, step_id: claim.step_id, at, reason })));
  return released;
}
