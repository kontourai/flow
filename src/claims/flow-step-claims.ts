import type {
  FlowActiveStepClaim,
  FlowActiveStepClaimRequest,
  FlowActiveStepClaimValidation,
  FlowDefinitionIdentity,
  FlowReadyStepFrontier,
  FlowStepClaimActor,
  FlowStepClaimDiagnostic
} from "../contracts/flow-types.js";
import { definitionDiagnostics, getStep, readySteps, validateDefinition } from "../definition/flow-definition.js";
import { isNonEmptyString, isObject } from "../shared/flow-utils.js";
import { assertSafeRunId } from "../runtime/flow-files.js";
import { definitionIdentity } from "../runtime/flow-run-definition-amendment.js";
import { flowRunHead } from "../runtime/flow-run-retry-authorization.js";

export const FLOW_STEP_CLAIM_SCHEMA_VERSION = "1" as const;
export const FLOW_MUTABLE_RESOURCE_LIMIT = 32;

const RESOURCE_ID = /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._:-]*)*$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]*$/u;

export class FlowStepClaimError extends Error {
  readonly diagnostics: FlowStepClaimDiagnostic[];

  constructor(diagnostics: FlowStepClaimDiagnostic[]) {
    super(`${diagnostics[0]?.code ?? "flow.step_claim.invalid"}: ${diagnostics[0]?.message ?? "invalid step claim"}`);
    this.name = "FlowStepClaimError";
    this.diagnostics = diagnostics;
  }
}

function diagnostic(code: string, path: string, message: string, related: Record<string, unknown> = {}): FlowStepClaimDiagnostic {
  return { code, severity: "error", path, message, ...(Object.keys(related).length ? { related } : {}) };
}

function validResource(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && RESOURCE_ID.test(value);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && IDENTIFIER.test(value);
}

function validRunId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return assertSafeRunId(value) === value;
  } catch {
    return false;
  }
}

function sameResources(left: string[], right: string[]) {
  return left.length === right.length && left.every((resource) => right.includes(resource));
}

function multiCursorIdentity(definition: unknown, diagnostics: FlowStepClaimDiagnostic[]): FlowDefinitionIdentity | null {
  const definitionIssues = definitionDiagnostics(definition);
  if (definitionIssues.length > 0) {
    diagnostics.push(...definitionIssues.map((issue) => ({ ...issue, code: `flow.step_claim.definition.${issue.code}` })));
    return null;
  }
  const normalized = validateDefinition(definition);
  if (normalized.execution?.mode !== "multi-cursor" || normalized.execution.claim_contract_version !== FLOW_STEP_CLAIM_SCHEMA_VERSION) {
    diagnostics.push(diagnostic("flow.step_claim.definition.multi_cursor.required", "$.execution", "active-step claims require execution.mode multi-cursor with claim_contract_version 1"));
    return null;
  }
  return definitionIdentity(normalized);
}

function declaredResources(definition: unknown, stepId: string, diagnostics: FlowStepClaimDiagnostic[]): string[] | null {
  const step = getStep(definition, stepId);
  if (!step) {
    diagnostics.push(diagnostic("flow.step_claim.step.unknown", "$.step_id", `step ${stepId} does not exist in the definition`));
    return null;
  }
  if (!Array.isArray(step.mutable_resources)) {
    diagnostics.push(diagnostic("flow.step_claim.resources.declaration.required", "$.step_id", `step ${stepId} has no mutable_resources declaration`));
    return null;
  }
  return [...step.mutable_resources];
}

function validateStateBinding(identity: FlowDefinitionIdentity, state: unknown, diagnostics: FlowStepClaimDiagnostic[]): state is Record<string, any> {
  if (!isObject(state)) {
    diagnostics.push(diagnostic("flow.step_claim.run.invalid", "$", "run state must be an object"));
    return false;
  }
  const run = state as Record<string, any>;
  if (!validRunId(run.run_id)) diagnostics.push(diagnostic("flow.step_claim.run_id.invalid", "$.run_id", "run_id must be a canonical path-safe Flow run id"));
  if (run.definition_id !== identity.id) diagnostics.push(diagnostic("flow.step_claim.run.definition_id.mismatch", "$.definition_id", "run definition_id does not match the supplied definition", { expected: identity.id, actual: run.definition_id }));
  if (run.definition_version !== identity.version) diagnostics.push(diagnostic("flow.step_claim.run.definition_version.mismatch", "$.definition_version", "run definition_version does not match the supplied definition", { expected: identity.version, actual: run.definition_version }));
  if (run.definition_digest !== undefined && run.definition_digest !== identity.digest) {
    diagnostics.push(diagnostic("flow.step_claim.run.definition_digest.mismatch", "$.definition_digest", "run definition_digest does not match the supplied definition", { expected: identity.digest, actual: run.definition_digest }));
  }
  return true;
}

/**
 * The stricter multi-cursor frontier.  Unlike the legacy DAG projection this
 * also observes route-back invalidation records, so a join cannot be claimed
 * merely because an old pass remains in the historical outcome list.
 */
export function claimReadySteps(definition: unknown, state: any): string[] {
  const invalidated = new Set<string>();
  const transitions = Array.isArray(state?.transitions) ? state.transitions : [];
  for (const step of validateDefinition(definition).steps) {
    let invalidatedAt = -1;
    let completedAt = -1;
    transitions.forEach((transition: any, index: number) => {
      if (transition?.from_step === step.id && transition?.status === "allowed") completedAt = index;
      if (["route_back", "retry_authorized"].includes(transition?.type)
        && (transition?.to_step === step.id || transition?.invalidated_steps?.includes(step.id))) {
        invalidatedAt = index;
      }
    });
    if (invalidatedAt >= 0 && invalidatedAt >= completedAt) invalidated.add(step.id);
  }
  if (invalidated.size === 0) return readySteps(definition, state, { evidence: [] });
  const gates = validateDefinition(definition).gates;
  const filteredState = {
    ...state,
    gate_outcomes: (state.gate_outcomes ?? []).filter((outcome: any) => {
      if (outcome?.status !== "pass") return true;
      return !invalidated.has(gates?.[outcome.gate_id]?.step);
    })
  };
  return readySteps(definition, filteredState, { evidence: [] });
}

function validateActor(value: unknown, path: string, diagnostics: FlowStepClaimDiagnostic[]): FlowStepClaimActor | null {
  if (!isObject(value) || Object.keys(value).some((key) => key !== "key" && key !== "kind")) {
    diagnostics.push(diagnostic("flow.step_claim.actor.invalid", path, "actor must be an object containing key and optional kind"));
    return null;
  }
  const actor = value as Record<string, unknown>;
  if (!validIdentifier(actor.key)) {
    diagnostics.push(diagnostic("flow.step_claim.actor.key.invalid", `${path}.key`, "actor.key must be a lowercase identifier"));
    return null;
  }
  if (actor.kind !== undefined && !validIdentifier(actor.kind)) {
    diagnostics.push(diagnostic("flow.step_claim.actor.kind.invalid", `${path}.kind`, "actor.kind must be a lowercase identifier when present"));
    return null;
  }
  return { key: actor.key as string, ...(actor.kind === undefined ? {} : { kind: actor.kind as string }) };
}

function validateClaimShape(value: unknown, path: string, diagnostics: FlowStepClaimDiagnostic[]): FlowActiveStepClaim | null {
  if (!isObject(value)) {
    diagnostics.push(diagnostic("flow.step_claim.invalid", path, "active step claim must be an object"));
    return null;
  }
  const claim = value as Record<string, any>;
  const allowed = new Set(["schema_version", "claim_id", "liveness_id", "run_id", "definition", "run_head", "step_id", "actor", "mutable_resources"]);
  if (Object.keys(claim).some((key) => !allowed.has(key))) diagnostics.push(diagnostic("flow.step_claim.field.unsupported", path, "active step claim contains unsupported fields"));
  if (claim.schema_version !== FLOW_STEP_CLAIM_SCHEMA_VERSION) diagnostics.push(diagnostic("flow.step_claim.schema_version.invalid", `${path}.schema_version`, "schema_version must be 1"));
  for (const key of ["claim_id", "liveness_id", "step_id"] as const) {
    if (!validIdentifier(claim[key])) diagnostics.push(diagnostic(`flow.step_claim.${key}.invalid`, `${path}.${key}`, `${key} must be a lowercase identifier`));
  }
  if (!validRunId(claim.run_id)) diagnostics.push(diagnostic("flow.step_claim.run_id.invalid", `${path}.run_id`, "run_id must be a canonical path-safe Flow run id"));
  if (typeof claim.run_head !== "string" || !SHA_256.test(claim.run_head)) diagnostics.push(diagnostic("flow.step_claim.run_head.invalid", `${path}.run_head`, "run_head must be a SHA-256 digest"));
  const actor = validateActor(claim.actor, `${path}.actor`, diagnostics);
  if (!isObject(claim.definition) || Object.keys(claim.definition).some((key) => !["id", "version", "digest"].includes(key))) {
    diagnostics.push(diagnostic("flow.step_claim.definition.invalid", `${path}.definition`, "definition must contain id, version, and digest"));
  } else {
    if (!isNonEmptyString(claim.definition.id)) diagnostics.push(diagnostic("flow.step_claim.definition.id.invalid", `${path}.definition.id`, "definition.id must be a non-empty string"));
    if (!isNonEmptyString(claim.definition.version)) diagnostics.push(diagnostic("flow.step_claim.definition.version.invalid", `${path}.definition.version`, "definition.version must be a non-empty string"));
    if (typeof claim.definition.digest !== "string" || !SHA_256.test(claim.definition.digest)) diagnostics.push(diagnostic("flow.step_claim.definition.digest.invalid", `${path}.definition.digest`, "definition.digest must be a SHA-256 digest"));
  }
  if (!Array.isArray(claim.mutable_resources) || claim.mutable_resources.length > FLOW_MUTABLE_RESOURCE_LIMIT) {
    diagnostics.push(diagnostic("flow.step_claim.mutable_resources.invalid", `${path}.mutable_resources`, `mutable_resources must be an array of at most ${FLOW_MUTABLE_RESOURCE_LIMIT} resource ids`));
  } else {
    const resources = new Set<string>();
    claim.mutable_resources.forEach((resource, index) => {
      if (!validResource(resource)) diagnostics.push(diagnostic("flow.step_claim.mutable_resources.invalid", `${path}.mutable_resources[${index}]`, "mutable resource ids must be unambiguous lowercase identifiers or slash-separated identifier segments"));
      else if (resources.has(resource)) diagnostics.push(diagnostic("flow.step_claim.mutable_resources.duplicate", `${path}.mutable_resources[${index}]`, `duplicate mutable resource id: ${resource}`));
      else resources.add(resource);
    });
  }
  if (diagnostics.some((entry) => entry.path.startsWith(path))) return null;
  return {
    schema_version: FLOW_STEP_CLAIM_SCHEMA_VERSION,
    claim_id: claim.claim_id,
    liveness_id: claim.liveness_id,
    run_id: claim.run_id,
    definition: { id: claim.definition.id, version: claim.definition.version, digest: claim.definition.digest.toLowerCase() },
    run_head: claim.run_head.toLowerCase(),
    step_id: claim.step_id,
    actor: actor!,
    mutable_resources: [...claim.mutable_resources]
  };
}

/**
 * Derive the Flow-owned ready frontier for a valid multi-cursor definition.
 * It is a projection only; hosts decide if, when, and where to execute work.
 */
export function projectReadyStepFrontier(definition: unknown, state: any): FlowReadyStepFrontier {
  const diagnostics: FlowStepClaimDiagnostic[] = [];
  const identity = multiCursorIdentity(definition, diagnostics);
  if (!identity) throw new FlowStepClaimError(diagnostics);
  if (!validateStateBinding(identity, state, diagnostics) || diagnostics.length > 0) throw new FlowStepClaimError(diagnostics);
  return {
    schema_version: FLOW_STEP_CLAIM_SCHEMA_VERSION,
    run_id: state.run_id,
    definition: identity,
    run_head: flowRunHead(state),
    ready_steps: claimReadySteps(definition, state).map((step_id) => ({
      step_id,
      mutable_resources: [...(getStep(definition, step_id)?.mutable_resources ?? [])]
    }))
  };
}

/** Construct a canonical claim from the current Flow frontier without persisting it. */
export function buildActiveStepClaim(definition: unknown, state: any, request: FlowActiveStepClaimRequest): FlowActiveStepClaim {
  const frontier = projectReadyStepFrontier(definition, state);
  const resources = frontier.ready_steps.find((step) => step.step_id === request?.step_id)?.mutable_resources;
  if (!resources) throw new FlowStepClaimError([diagnostic("flow.step_claim.frontier.not_ready", "$.step_id", `step ${request?.step_id ?? "<missing>"} is not in the current ready frontier`)]);
  const claim = {
    schema_version: FLOW_STEP_CLAIM_SCHEMA_VERSION,
    claim_id: request?.claim_id,
    liveness_id: request?.liveness_id,
    run_id: frontier.run_id,
    definition: frontier.definition,
    run_head: frontier.run_head,
    step_id: request?.step_id,
    actor: request?.actor,
    mutable_resources: resources
  };
  const validation = validateActiveStepClaim(definition, state, claim);
  if (!validation.valid) throw new FlowStepClaimError(validation.diagnostics);
  return claim as FlowActiveStepClaim;
}

/**
 * Validate a candidate against the current frontier and supplied active claims.
 * Resource conflicts are returned deterministically; this function never
 * persists claims, changes a run, or dispatches host work.
 */
export function validateActiveStepClaim(definition: unknown, state: any, candidate: unknown, activeClaims: unknown[] = []): FlowActiveStepClaimValidation {
  const diagnostics: FlowStepClaimDiagnostic[] = [];
  const conflicts: FlowActiveStepClaimValidation["conflicts"] = [];
  const identity = multiCursorIdentity(definition, diagnostics);
  const claim = validateClaimShape(candidate, "$.claim", diagnostics);
  const stateBound = identity ? validateStateBinding(identity, state, diagnostics) : false;
  if (!identity || !claim || !stateBound || diagnostics.length > 0) return { valid: false, diagnostics, conflicts };
  if (state.status !== "active") diagnostics.push(diagnostic("flow.step_claim.run.not_claimable", "$.status", "only active runs may expose claimable steps"));
  if (claim.run_id !== state.run_id) diagnostics.push(diagnostic("flow.step_claim.run_id.stale", "$.claim.run_id", "claim run_id does not match the current run"));
  if (claim.run_head !== flowRunHead(state)) diagnostics.push(diagnostic("flow.step_claim.run_head.stale", "$.claim.run_head", "claim run_head does not match the current run head"));
  if (claim.definition.id !== identity.id || claim.definition.version !== identity.version || claim.definition.digest !== identity.digest) {
    diagnostics.push(diagnostic("flow.step_claim.definition.stale", "$.claim.definition", "claim definition identity does not match the current definition", { expected: identity, actual: claim.definition }));
  }
  const resources = declaredResources(definition, claim.step_id, diagnostics);
  if (resources && !sameResources(resources, claim.mutable_resources)) {
    diagnostics.push(diagnostic("flow.step_claim.mutable_resources.mismatch", "$.claim.mutable_resources", "claim mutable_resources must exactly match the step declaration", { declared: resources, claimed: claim.mutable_resources }));
  }
  const frontier = claimReadySteps(definition, state);
  if (!frontier.includes(claim.step_id)) diagnostics.push(diagnostic("flow.step_claim.frontier.not_ready", "$.claim.step_id", `step ${claim.step_id} is not in the current ready frontier`));

  activeClaims.forEach((entry, index) => {
    const existingDiagnostics: FlowStepClaimDiagnostic[] = [];
    const existing = validateClaimShape(entry, `$.active_claims[${index}]`, existingDiagnostics);
    if (!existing) {
      diagnostics.push(...existingDiagnostics);
      return;
    }
    if (existing.run_id !== state.run_id) existingDiagnostics.push(diagnostic("flow.step_claim.active.run_id.stale", `$.active_claims[${index}].run_id`, "active claim run_id does not match the current run"));
    if (existing.run_head !== flowRunHead(state)) existingDiagnostics.push(diagnostic("flow.step_claim.active.run_head.stale", `$.active_claims[${index}].run_head`, "active claim run_head does not match the current run head"));
    if (existing.definition.id !== identity.id || existing.definition.version !== identity.version || existing.definition.digest !== identity.digest) {
      existingDiagnostics.push(diagnostic("flow.step_claim.active.definition.stale", `$.active_claims[${index}].definition`, "active claim definition identity does not match the current definition"));
    }
    const existingResources = declaredResources(definition, existing.step_id, existingDiagnostics);
    if (existingResources && !sameResources(existingResources, existing.mutable_resources)) {
      existingDiagnostics.push(diagnostic("flow.step_claim.active.mutable_resources.mismatch", `$.active_claims[${index}].mutable_resources`, "active claim mutable_resources must exactly match the step declaration", { declared: existingResources, claimed: existing.mutable_resources }));
    }
    if (!frontier.includes(existing.step_id)) {
      existingDiagnostics.push(diagnostic("flow.step_claim.active.frontier.not_ready", `$.active_claims[${index}].step_id`, `active claim step ${existing.step_id} is not in the current ready frontier`));
    }
    if (existingDiagnostics.length > 0) {
      diagnostics.push(...existingDiagnostics);
      return;
    }
    if (existing.claim_id === claim.claim_id || existing.step_id === claim.step_id) {
      diagnostics.push(diagnostic("flow.step_claim.conflict.claim", "$.claim", `step ${claim.step_id} is already claimed`, { claim_id: existing.claim_id, step_id: existing.step_id }));
      conflicts.push({ claim_id: existing.claim_id, step_id: existing.step_id, mutable_resources: [...existing.mutable_resources] });
      return;
    }
    const overlap = claim.mutable_resources.filter((resource) => existing.mutable_resources.includes(resource)).sort();
    if (overlap.length > 0) {
      diagnostics.push(diagnostic("flow.step_claim.conflict.resource", "$.claim.mutable_resources", `claim conflicts with ${existing.claim_id} on mutable resources: ${overlap.join(", ")}`, { claim_id: existing.claim_id, step_id: existing.step_id, mutable_resources: overlap }));
      conflicts.push({ claim_id: existing.claim_id, step_id: existing.step_id, mutable_resources: overlap });
    }
  });
  conflicts.sort((left, right) => left.claim_id.localeCompare(right.claim_id) || left.step_id.localeCompare(right.step_id));
  return { valid: diagnostics.length === 0, diagnostics, conflicts };
}
