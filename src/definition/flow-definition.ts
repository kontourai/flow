import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type { FlowDiagnostic, MutableRecord } from "../contracts/flow-types.js";
import { evidenceLabel, expectationLabel, isNonEmptyString, isObject, slugLabel } from "../shared/flow-utils.js";

const FLOW_DEFINITION_RESOURCE_API_VERSION = "flow.kontourai.io/v1alpha1";
const FLOW_DEFINITION_RESOURCE_KIND = "FlowDefinition";

function isFlowDefinitionResource(definition: any) {
  return isObject(definition)
    && (
      definition.apiVersion !== undefined
      || definition.kind !== undefined
      || definition.metadata !== undefined
      || definition.spec !== undefined
    );
}

export function normalizeFlowDefinition(definition: any) {
  if (!isFlowDefinitionResource(definition)) return definition;
  const metadata = isObject(definition.metadata) ? definition.metadata : {};
  const spec = isObject(definition.spec) ? definition.spec : {};
  return {
    id: metadata.name,
    version: spec.version,
    steps: spec.steps,
    gates: spec.gates
  };
}

function resourcePathForFlatPath(path: string) {
  if (path === "$.id") return "$.metadata.name";
  if (path === "$.version") return "$.spec.version";
  if (path === "$.steps") return "$.spec.steps";
  if (path.startsWith("$.steps[")) return `$.spec${path.slice(1)}`;
  if (path === "$.gates") return "$.spec.gates";
  if (path.startsWith("$.gates.")) return `$.spec${path.slice(1)}`;
  return path;
}

function resourceEnvelopeDiagnostics(definition: any) {
  const diagnostics: FlowDiagnostic[] = [];
  if (definition.apiVersion !== FLOW_DEFINITION_RESOURCE_API_VERSION) {
    diagnostics.push(createDiagnostic(
      "definition.resource.apiVersion.unsupported",
      "$.apiVersion",
      `definition.apiVersion must be ${FLOW_DEFINITION_RESOURCE_API_VERSION}`
    ));
  }
  if (definition.kind !== FLOW_DEFINITION_RESOURCE_KIND) {
    diagnostics.push(createDiagnostic(
      "definition.resource.kind.unsupported",
      "$.kind",
      `definition.kind must be ${FLOW_DEFINITION_RESOURCE_KIND}`
    ));
  }
  if (!isObject(definition.metadata)) {
    diagnostics.push(createDiagnostic("definition.resource.metadata.required", "$.metadata", "definition.metadata must be an object"));
  }
  if (!isObject(definition.spec)) {
    diagnostics.push(createDiagnostic("definition.resource.spec.required", "$.spec", "definition.spec must be an object"));
  }
  if (isObject(definition.metadata)) {
    validateResourceStringMap(definition.metadata.labels, "$.metadata.labels", "labels", diagnostics);
    validateResourceStringMap(definition.metadata.annotations, "$.metadata.annotations", "annotations", diagnostics);
  }
  return diagnostics;
}

function validateResourceStringMap(value: any, path: string, label: string, diagnostics: FlowDiagnostic[]) {
  if (value === undefined) return;
  if (!isObject(value)) {
    diagnostics.push(createDiagnostic(`definition.resource.metadata.${label}.invalid`, path, `definition.metadata.${label} must be an object with string values`));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      diagnostics.push(createDiagnostic(
        `definition.resource.metadata.${label}.value.invalid`,
        `${path}.${key}`,
        `definition.metadata.${label}.${key} must be a string`
      ));
    }
  }
}

function mapDiagnosticsToResourcePaths(diagnostics: FlowDiagnostic[]) {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    path: resourcePathForFlatPath(diagnostic.path)
  }));
}

export function getStep(definition, stepId) {
  definition = normalizeFlowDefinition(definition);
  return definition.steps.find((step) => step.id === stepId);
}

export function createDiagnostic(code, path, message, related = {}) {
  return {
    code,
    severity: "error",
    path,
    message,
    ...(Object.keys(related).length ? { related } : {})
  };
}

function validateExpectation(expectation: any, path: string, diagnostics: FlowDiagnostic[]) {
  if (!isObject(expectation)) {
    diagnostics.push(createDiagnostic("definition.expectation.invalid", path, "expectation must be an object"));
    return;
  }
  if (!isNonEmptyString(expectation.id)) {
    diagnostics.push(createDiagnostic("definition.expectation.id.required", `${path}.id`, "expectation.id must be a non-empty string"));
  }
  if (expectation.kind !== "trust.bundle") {
    diagnostics.push(createDiagnostic("definition.expectation.kind.unsupported", `${path}.kind`, "expectation.kind must be trust.bundle"));
  }
  if (typeof expectation.required !== "boolean") {
    diagnostics.push(createDiagnostic("definition.expectation.required.invalid", `${path}.required`, "expectation.required must be a boolean"));
  }
  if (!isNonEmptyString(expectation.description)) {
    diagnostics.push(createDiagnostic("definition.expectation.description.required", `${path}.description`, "expectation.description must be a non-empty string"));
  }
  if (expectation.kind === "trust.bundle" && !isObject(expectation.bundle_claim)) {
    diagnostics.push(createDiagnostic("definition.expectation.bundle_claim.required", `${path}.bundle_claim`, "trust.bundle expectations must include bundle_claim"));
    return;
  }
  if (!isObject(expectation.bundle_claim)) return;
  if (!isNonEmptyString(expectation.bundle_claim.claimType)) {
    diagnostics.push(createDiagnostic("definition.expectation.bundle_claim.claimType.required", `${path}.bundle_claim.claimType`, "trust.bundle expectations must include bundle_claim.claimType"));
  }
  if (expectation.bundle_claim.subjectType !== undefined && !isNonEmptyString(expectation.bundle_claim.subjectType)) {
    diagnostics.push(createDiagnostic("definition.expectation.bundle_claim.subjectType.invalid", `${path}.bundle_claim.subjectType`, "bundle_claim.subjectType must be a non-empty string when present"));
  }
  if (expectation.bundle_claim.subjectId !== undefined && !isNonEmptyString(expectation.bundle_claim.subjectId)) {
    diagnostics.push(createDiagnostic("definition.expectation.bundle_claim.subjectId.invalid", `${path}.bundle_claim.subjectId`, "bundle_claim.subjectId must be a non-empty string when present"));
  }
  if (expectation.bundle_claim.accepted_statuses !== undefined) {
    if (!Array.isArray(expectation.bundle_claim.accepted_statuses) || expectation.bundle_claim.accepted_statuses.length === 0) {
      diagnostics.push(createDiagnostic("definition.expectation.bundle_claim.accepted_statuses.invalid", `${path}.bundle_claim.accepted_statuses`, "bundle_claim.accepted_statuses must be a non-empty array"));
    } else {
      expectation.bundle_claim.accepted_statuses.forEach((status, index) => {
        if (!isNonEmptyString(status)) {
          diagnostics.push(createDiagnostic("definition.expectation.bundle_claim.accepted_status.invalid", `${path}.bundle_claim.accepted_statuses[${index}]`, "accepted status must be a non-empty string"));
        }
      });
    }
  }
}

export function definitionDiagnostics(definition: any): FlowDiagnostic[] {
  if (!isObject(definition)) {
    return [createDiagnostic("definition.invalid", "$", "definition must be an object")];
  }
  if (isFlowDefinitionResource(definition)) {
    return [
      ...resourceEnvelopeDiagnostics(definition),
      ...mapDiagnosticsToResourcePaths(flatDefinitionDiagnostics(normalizeFlowDefinition(definition)))
    ];
  }
  return flatDefinitionDiagnostics(definition);
}

function flatDefinitionDiagnostics(definition: any): FlowDiagnostic[] {
  const diagnostics: FlowDiagnostic[] = [];
  if (!isNonEmptyString(definition.id)) {
    diagnostics.push(createDiagnostic("definition.id.required", "$.id", "definition.id must be a non-empty string"));
  }
  if (!isNonEmptyString(definition.version)) {
    diagnostics.push(createDiagnostic("definition.version.required", "$.version", "definition.version must be a non-empty string"));
  }
  if (!Array.isArray(definition.steps) || definition.steps.length === 0) {
    diagnostics.push(createDiagnostic("definition.steps.required", "$.steps", "definition.steps must be a non-empty array"));
  }
  if (!isObject(definition.gates) || Object.keys(definition.gates).length === 0) {
    diagnostics.push(createDiagnostic("definition.gates.required", "$.gates", "definition.gates must be a non-empty object"));
  }

  const stepIds = new Set();
  if (Array.isArray(definition.steps)) {
    definition.steps.forEach((step, index) => {
      const stepPath = `$.steps[${index}]`;
      if (!isObject(step)) {
        diagnostics.push(createDiagnostic("definition.step.invalid", stepPath, "step must be an object"));
        return;
      }
      if (!isNonEmptyString(step.id)) {
        diagnostics.push(createDiagnostic("definition.step.id.required", `${stepPath}.id`, "step.id must be a non-empty string"));
      } else if (stepIds.has(step.id)) {
        diagnostics.push(createDiagnostic("definition.step.id.duplicate", `${stepPath}.id`, `duplicate step id: ${step.id}`));
      } else {
        stepIds.add(step.id);
      }
    });
  }

  // Validate needs references and detect cycles.
  if (Array.isArray(definition.steps) && stepIds.size > 0) {
    // Validate that every needs id references an existing step.
    definition.steps.forEach((step, index) => {
      if (!Array.isArray(step.needs)) return;
      const stepPath = `$.steps[${index}]`;
      step.needs.forEach((needId, needIndex) => {
        if (!stepIds.has(needId)) {
          diagnostics.push(createDiagnostic(
            "definition.step.needs.unknown",
            `${stepPath}.needs[${needIndex}]`,
            `step ${step.id} needs references unknown step: ${needId}`,
            { step: step.id, needs: needId }
          ));
        }
      });
    });

    // Build the effective dependency graph (composition rule: needs wins over next-chain).
    // Then check for cycles using DFS.
    const effectivePreds: Map<string, string[]> = new Map();
    const stepList: string[] = definition.steps
      .filter((s) => isNonEmptyString(s.id))
      .map((s) => s.id);

    for (const stepId of stepList) {
      const step = definition.steps.find((s) => s.id === stepId)!;
      if (Array.isArray(step.needs)) {
        effectivePreds.set(stepId, step.needs.filter((n) => stepIds.has(n)));
      } else {
        const predStep = definition.steps.find((s) => s.next === stepId);
        effectivePreds.set(stepId, predStep ? [predStep.id] : []);
      }
    }

    // DFS cycle detection — report the first cycle found.
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color: Map<string, number> = new Map(stepList.map((id) => [id, WHITE]));
    const cycleDetected = { found: false };

    function visit(nodeId: string, path: string[]): void {
      if (cycleDetected.found) return;
      if (color.get(nodeId) === BLACK) return;
      if (color.get(nodeId) === GRAY) {
        const cycleStart = path.indexOf(nodeId);
        const cycle = [...path.slice(cycleStart), nodeId];
        diagnostics.push(createDiagnostic(
          "definition.steps.needs.cycle",
          "$.steps",
          `dependency cycle detected: ${cycle.join(" -> ")}`,
          { cycle }
        ));
        cycleDetected.found = true;
        return;
      }
      color.set(nodeId, GRAY);
      for (const pred of (effectivePreds.get(nodeId) ?? [])) {
        visit(pred, [...path, nodeId]);
        if (cycleDetected.found) return;
      }
      color.set(nodeId, BLACK);
    }

    for (const stepId of stepList) {
      if (color.get(stepId) === WHITE) visit(stepId, []);
      if (cycleDetected.found) break;
    }
  }

  if (isObject(definition.gates)) {
    for (const [gateId, gate] of Object.entries(definition.gates) as Array<[string, any]>) {
      const gatePath = `$.gates.${gateId}`;
      if (!isObject(gate)) {
        diagnostics.push(createDiagnostic("definition.gate.invalid", gatePath, `gate ${gateId} must be an object`));
        continue;
      }
      if (!isNonEmptyString(gate.step)) {
        diagnostics.push(createDiagnostic("definition.gate.step.required", `${gatePath}.step`, `gate ${gateId} must include step`));
      } else if (!stepIds.has(gate.step)) {
        diagnostics.push(createDiagnostic("definition.gate.step.unknown", `${gatePath}.step`, `gate ${gateId} references unknown step: ${gate.step}`, { gate_id: gateId, step: gate.step }));
      }
      if (gate.expects !== undefined) {
        if (!Array.isArray(gate.expects)) {
          diagnostics.push(createDiagnostic("definition.gate.expects.invalid", `${gatePath}.expects`, `gate ${gateId} expects must be an array`));
        } else {
          gate.expects.forEach((expectation, index) => validateExpectation(expectation, `${gatePath}.expects[${index}]`, diagnostics));
        }
      }
      if (gate.requires !== undefined) {
        diagnostics.push(createDiagnostic(
          "definition.gate.field.unsupported",
          `${gatePath}.requires`,
          `gate ${gateId} uses unsupported field requires; use typed expects entries`
        ));
      }
      for (const [reason, targetStep] of Object.entries(gate.on_route_back ?? {})) {
        if (!stepIds.has(targetStep)) {
          diagnostics.push(createDiagnostic("definition.gate.route_back.target.unknown", `${gatePath}.on_route_back.${reason}`, `gate ${gateId} on_route_back.${reason} references unknown step: ${targetStep}`, { gate_id: gateId, reason, step: targetStep }));
        }
      }
      const exceededTarget = gate.route_back_policy?.on_exceeded;
      if (exceededTarget && exceededTarget !== "block" && !stepIds.has(exceededTarget)) {
        diagnostics.push(createDiagnostic("definition.gate.route_back_policy.on_exceeded.unknown", `${gatePath}.route_back_policy.on_exceeded`, `gate ${gateId} route_back_policy.on_exceeded references unknown step: ${exceededTarget}`, { gate_id: gateId, step: exceededTarget }));
      }
    }
  }
  return diagnostics;
}

export function validateDefinitionWithDiagnostics(definition: any) {
  const diagnostics = definitionDiagnostics(definition);
  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics
  };
}

export function validateDefinition(definition: any) {
  const diagnostic = validateDefinitionWithDiagnostics(definition).diagnostics[0];
  if (diagnostic) throw new Error(diagnostic.message);
  definition = normalizeFlowDefinition(definition);
  const stepIds = new Set((definition.steps ?? []).map((step) => step.id));
  for (const [gateId, gate] of Object.entries(definition.gates ?? {}) as Array<[string, any]>) {
    if (gate.step && !stepIds.has(gate.step)) {
      throw new Error(`gate ${gateId} references unknown step: ${gate.step}`);
    }
    for (const [reason, targetStep] of Object.entries(gate.on_route_back ?? {})) {
      if (!stepIds.has(targetStep)) {
        throw new Error(`gate ${gateId} on_route_back.${reason} references unknown step: ${targetStep}`);
      }
    }
    const exceededTarget = gate.route_back_policy?.on_exceeded;
    if (exceededTarget && exceededTarget !== "block" && !stepIds.has(exceededTarget)) {
      throw new Error(`gate ${gateId} route_back_policy.on_exceeded references unknown step: ${exceededTarget}`);
    }
  }
  return definition;
}

export function gatesForStep(definition: any, stepId: string) {
  definition = normalizeFlowDefinition(definition);
  return (Object.entries(definition.gates) as Array<[string, any]>)
    .map(([id, gate]) => ({ id, ...gate }))
    .filter((gate) => gate.step === stepId);
}

export function findGate(definition: any, gateId: string) {
  definition = normalizeFlowDefinition(definition);
  const gate = definition.gates[gateId];
  return gate ? { id: gateId, ...gate } : null;
}

export function initialState(definition: any, runId: string, params: MutableRecord = {}) {
  definition = validateDefinition(definition);
  const firstStep = definition.steps[0];
  const subject = params.subject ?? params.feature ?? params.task ?? params.name ?? runId;
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: runId,
    definition_id: definition.id,
    definition_version: definition.version,
    subject,
    status: "active",
    current_step: firstStep.id,
    params,
    gate_outcomes: [],
    gate_outcome_history: [],
    transitions: [],
    lifecycle: [],
    exceptions: [],
    next_action: nextActionForStep(definition, firstStep.id),
    updated_at: new Date().toISOString()
  };
}

/**
 * Normalize the sole additive compatibility case for run lifecycle history.
 * Callers must schema-validate first so a present malformed ledger fails closed.
 */
export function normalizeRunStateLifecycle(state: any) {
  if (state.lifecycle !== undefined) return state;
  return { ...state, lifecycle: [] };
}

export function nextActionForStep(definition: any, stepId: string, outcome: any = null) {
  definition = normalizeFlowDefinition(definition);
  if (outcome?.status === "block" && outcome.missing?.length) {
    if (outcome.missing.includes("browser-evidence")) return "run browser check before publish";
    return `attach ${outcome.missing.map(evidenceLabel).join(", ")} before continuing`;
  }
  if (outcome?.status === "route-back") {
    const attempt = outcome.attempt ? ` attempt ${outcome.attempt}${outcome.max_attempts ? `/${outcome.max_attempts}` : ""}` : "";
    return `return to ${outcome.route_back_to} and replace failing evidence${attempt}`;
  }
  const gate = gatesForStep(definition, stepId)[0];
  if (!gate) return "no open gate";
  return `attach evidence for ${slugLabel(gate.id)}`;
}

export function continuationLine(state) {
  if (state.status === "paused") {
    return `run paused at ${state.current_step}; resume requires a new authorized lifecycle request`;
  }
  if (state.status === "canceled") {
    return `run canceled at ${state.current_step}; no continuation is available`;
  }
  return `resume from ${state.current_step}, not chat memory`;
}

export function projectedNextAction(state) {
  if (state.status === "paused") return "await an authorized lifecycle resume request";
  if (state.status === "canceled") return "none; this run is terminally canceled";
  return state.next_action;
}

export function openGates(definition, state) {
  if (state.status === "paused" || state.status === "canceled") return [];
  return gatesForStep(definition, state.current_step);
}

export function acceptedExceptionFor(state, gateId) {
  return state.exceptions.find((exception) => exception.gate_id === gateId);
}

export function attachedEvidenceFor(manifest, gateId) {
  return manifest.evidence.filter((entry) => entry.gate_id === gateId);
}

export function routeReasonForFailedEvidence(entry) {
  return typeof entry?.route_reason === "string" && entry.route_reason.length ? entry.route_reason : null;
}

export function routeTargetForReason(gate, routeReason) {
  const routes = gate.on_route_back ?? {};
  if (routeReason && routes[routeReason]) return routes[routeReason];
  if (routes.default) return routes.default;
  return gate.step;
}

export function routeBackAttempt(state, { gateId, routeReason, fromStep, toStep }) {
  const retryEpoch = routeBackEpoch(state, { gateId, routeReason, fromStep, toStep });
  const reasonKey = routeReason ?? "default";
  const priorMatches = (state.transitions ?? []).filter((transition) => {
    return transition.type === "route_back"
      && transition.gate_id === gateId
      && (transition.route_reason ?? transition.reason) === reasonKey
      && transition.from_step === fromStep
      && transition.to_step === toStep
      && (transition.retry_epoch ?? 1) === retryEpoch;
  });
  return priorMatches.length + 1;
}

/** The current persisted retry epoch for one exact route-back loop. */
export function routeBackEpoch(state, { gateId, routeReason, fromStep, toStep }) {
  const reasonKey = routeReason ?? "default";
  const transitions = state.transitions ?? [];
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const authorization = transitions[index];
    const blocked = transitions[index - 1];
    if (authorization?.type === "retry_authorized"
      && authorization.status === "retry-authorized"
      && authorization.gate_id === gateId
      && (authorization.route_reason ?? authorization.reason) === reasonKey
      && authorization.from_step === fromStep
      && authorization.to_step === toStep
      && blocked?.type === "route_back"
      && blocked.status === "blocked"
      && blocked.limit_exceeded === true
      && blocked.gate_id === gateId
      && blocked.from_step === fromStep
      && blocked.selected_route === toStep
      && (blocked.route_reason ?? blocked.reason) === reasonKey
      && authorization.prior_retry_epoch === (blocked.retry_epoch ?? 1)
      && authorization.retry_epoch === authorization.prior_retry_epoch + 1) {
      return authorization.retry_epoch;
    }
  }
  return 1;
}

export function routeBackDecision(state: any, gate: any, routeReason: string | null | undefined, evidence: any[] = [], options: MutableRecord = {}) {
  const selectedTarget = routeTargetForReason(gate, routeReason);
  const maxAttempts = gate.route_back_policy?.max_attempts;
  const attempt = routeBackAttempt(state, {
    gateId: gate.id,
    routeReason,
    fromStep: gate.step,
    toStep: selectedTarget
  });
  const retryEpoch = routeBackEpoch(state, {
    gateId: gate.id,
    routeReason,
    fromStep: gate.step,
    toStep: selectedTarget
  });
  const limitExceeded = Number.isInteger(maxAttempts) && attempt > maxAttempts;
  const exceededTarget = gate.route_back_policy?.on_exceeded;
  const toStep = limitExceeded && exceededTarget && exceededTarget !== "block" ? exceededTarget : selectedTarget;
  const status = limitExceeded && exceededTarget === "block" ? "block" : "route-back";
  const routeData: MutableRecord = {
    route_back_to: toStep,
    selected_route: selectedTarget,
    recovery_step: limitExceeded && exceededTarget && exceededTarget !== "block" ? exceededTarget : undefined,
    route_reason: routeReason ?? undefined,
    reason: routeReason ?? "default",
    attempt,
    retry_epoch: retryEpoch,
    max_attempts: maxAttempts,
    limit_exceeded: limitExceeded,
    evidence_refs: evidence.map((entry) => entry.id),
    expectation_ids: options.expectationIds ?? evidence.flatMap((entry) => entry.expectation_ids ?? [])
  };
  const firstEvidence = evidence[0] ?? {};
  for (const field of ["classifier", "diagnostics", "analytics"]) {
    if (firstEvidence[field] !== undefined) routeData[field] = firstEvidence[field];
  }
  if (firstEvidence.analytics?.loop_key !== undefined) routeData.analytics_loop_key = firstEvidence.analytics.loop_key;
  return routeData.status ? routeData : { ...routeData, status };
}

// ---------------------------------------------------------------------------
// Phase 1 — Dependency DAG: predecessors, readiness, stage statuses
// ---------------------------------------------------------------------------

/**
 * Composition rule for next ↔ needs:
 *
 * A step's effective predecessors are computed as follows:
 *   1. If the step declares `needs` (even an empty array), those ids are the
 *      effective predecessors and the `next`-chain is ignored for this step.
 *   2. Otherwise, the effective predecessor is whichever step has `next`
 *      pointing to this step (at most one in a linear chain, zero for the
 *      first step).
 *
 * This means `next` remains "linear sugar" — existing definitions that only
 * use `next` continue to work identically.  A definition that mixes `next`
 * and `needs` is valid as long as the full graph (needs-edges + next-edges for
 * steps that lack `needs`) is acyclic.
 */

function normalizedSteps(definition: any): any[] {
  definition = normalizeFlowDefinition(definition);
  return Array.isArray(definition.steps) ? definition.steps : [];
}

/**
 * Return the effective predecessor step ids for `stepId`.
 * Uses the composition rule described above.
 */
export function predecessorsOf(definition: any, stepId: string): string[] {
  const steps = normalizedSteps(definition);
  const step = steps.find((s) => s.id === stepId);
  if (!step) return [];

  // Explicit needs wins.
  if (Array.isArray(step.needs)) return [...step.needs];

  // Fall back to whichever step has next === stepId.
  const predecessor = steps.find((s) => s.next === stepId);
  return predecessor ? [predecessor.id] : [];
}

/**
 * Return the transitive set of step ids that depend on `stepId` — its
 * descendants in the dependency DAG.  A step `D` is a descendant of `T` when
 * `T` is one of `D`'s transitive effective predecessors.  `stepId` itself is
 * excluded.  Result is in definition order for determinism.
 */
export function descendantsOf(definition: any, stepId: string): string[] {
  const steps = normalizedSteps(definition);
  // Forward adjacency: predecessor id -> ids of steps that need it.
  const children = new Map<string, string[]>();
  for (const step of steps) {
    for (const pred of predecessorsOf(definition, step.id)) {
      const list = children.get(pred) ?? [];
      list.push(step.id);
      children.set(pred, list);
    }
  }
  const seen = new Set<string>();
  const queue = [...(children.get(stepId) ?? [])];
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const child of children.get(id) ?? []) {
      if (!seen.has(child)) queue.push(child);
    }
  }
  return steps.map((s) => s.id).filter((id) => seen.has(id));
}

/**
 * Route-back cascade (Phase 1.5).
 *
 * When a run routes back to `targetStep`, the work that produced every step
 * downstream of the target is now suspect and must re-run. This clears stale
 * `pass` outcomes from the current projection while retaining the append-only
 * gate-outcome ledger and completion-transition history. Later route markers
 * make those historical completions non-current for readiness calculations.
 *
 * Only projected `pass` outcomes are cleared: a `pass` is what wrongly
 * suppresses a re-run. Non-pass outcomes (`block`/`route-back`/`wait`) and all
 * historical decisions remain represented for audit and attempt accounting.
 * The target itself is untouched: it becomes `current_step` and is
 * re-evaluated through the normal cursor.
 *
 * Mutates `state` in place.  Returns the descendant step ids (definition
 * order) marked for re-run, for audit.
 */
export function invalidateDescendants(definition: any, state: any, targetStep: string): string[] {
  const def = normalizeFlowDefinition(definition);
  const descendants = descendantsOf(def, targetStep);
  if (!Array.isArray(state.gate_outcome_history)) {
    state.gate_outcome_history = structuredClone(state.gate_outcomes ?? []);
  }
  if (descendants.length === 0) return [];
  const descendantSet = new Set(descendants);
  const descendantGateIds = new Set(
    (Object.entries(def.gates ?? {}) as Array<[string, any]>)
      .filter(([, gate]) => descendantSet.has(gate.step))
      .map(([id]) => id)
  );
  if (Array.isArray(state.gate_outcomes)) {
    state.gate_outcomes = state.gate_outcomes.filter(
      (outcome: any) => !(descendantGateIds.has(outcome.gate_id) && outcome.status === "pass")
    );
  }
  return descendants;
}

/** Whether the latest completion of a step is newer than every later invalidation marker. */
export function stepCompletionIsCurrent(state: any, stepId: string): boolean {
  let completedAt = -1;
  let invalidatedAt = -1;
  for (const [index, transition] of (state.transitions ?? []).entries()) {
    if (transition?.from_step === stepId && transition?.status === "allowed") completedAt = index;
    if (["route_back", "retry_authorized"].includes(transition?.type)
      && (transition?.to_step === stepId || transition?.invalidated_steps?.includes(stepId))) {
      invalidatedAt = index;
    }
  }
  return completedAt > invalidatedAt;
}

/**
 * Determine whether every predecessor of `stepId` has a passed gate.
 * A step with no predecessors is considered unblocked.
 */
function predecessorsPassed(definition: any, stepId: string, state: any): boolean {
  const preds = predecessorsOf(definition, stepId);
  if (preds.length === 0) return true;
  const steps = normalizedSteps(definition);
  return preds.every((predId) => {
    // A predecessor is "passed" if all its gates have pass outcomes or it has
    // no gates and has appeared in transitions as a completed step.
    const predStep = steps.find((s) => s.id === predId);
    if (!predStep) return false;
    const predGateIds = Object.entries((normalizeFlowDefinition(definition)).gates ?? {})
      .filter(([, g]: [string, any]) => g.step === predId)
      .map(([id]: [string, any]) => id);

    if (predGateIds.length === 0) {
      // No gate: passed if it appears in transitions with status "allowed".
      return stepCompletionIsCurrent(state, predId);
    }
    return predGateIds.every((gateId) =>
      (state.gate_outcomes ?? []).some(
        (o) => o.gate_id === gateId && o.status === "pass"
      )
    );
  });
}

/**
 * Return steps that are not yet passed and whose every predecessor has a
 * passed gate (or no gate).  A step with no predecessors is ready at start.
 */
export function readySteps(definition: any, state: any, _manifest: any): string[] {
  if (state.status === "paused" || state.status === "canceled") return [];
  const def = normalizeFlowDefinition(definition);
  const steps: any[] = normalizedSteps(def);

  return steps
    .filter((step) => {
      // Already passed?
      const stepGates = Object.entries(def.gates ?? {})
        .filter(([, g]: [string, any]) => g.step === step.id)
        .map(([id]: [string, any]) => id);

      const allGatesPassed =
        stepGates.length > 0 &&
        stepGates.every((gateId) =>
          (state.gate_outcomes ?? []).some(
            (o) => o.gate_id === gateId && o.status === "pass"
          )
        );

      if (allGatesPassed) return false;

      // For gate-less steps, check transitions.
      if (stepGates.length === 0) {
        const appearedInTransitions = stepCompletionIsCurrent(state, step.id);
        if (appearedInTransitions) return false;
      }

      // Is this the completed terminal step?
      if (state.status === "completed") return false;

      return predecessorsPassed(def, step.id, state);
    })
    .map((step) => step.id);
}

/**
 * Return the gates whose step is in readySteps().
 */
export function readyGates(definition: any, state: any, manifest: any): any[] {
  const ready = new Set(readySteps(definition, state, manifest));
  const def = normalizeFlowDefinition(definition);
  return (Object.entries(def.gates ?? {}) as Array<[string, any]>)
    .filter(([, gate]) => ready.has(gate.step))
    .map(([id, gate]) => ({ id, ...gate }));
}

export type StageStatus = "passed" | "current" | "ready" | "blocked" | "failed" | "pending";

/**
 * Return a per-step status for visualization.
 *
 * Rules (checked in order):
 *  - "failed"  — the step has a gate with a non-pass, non-wait outcome
 *                (i.e., block or route-back) and it is not the current step.
 *  - "current" — step.id === state.current_step
 *  - "passed"  — all gates for this step have a pass outcome, or the step
 *                appears in an allowed transition and has no gates.
 *  - "ready"   — in readySteps().
 *  - "blocked" — some predecessor has not passed.
 *  - "pending" — fallback.
 */
export function stageStatuses(definition: any, state: any, manifest: any): Record<string, StageStatus> {
  const def = normalizeFlowDefinition(definition);
  const steps: any[] = normalizedSteps(def);
  const readySet = new Set(readySteps(def, state, manifest));
  const result: Record<string, StageStatus> = {};

  for (const step of steps) {
    const stepGates = Object.entries(def.gates ?? {})
      .filter(([, g]: [string, any]) => g.step === step.id)
      .map(([id]: [string, any]) => id);

    // Failed: any gate for this step has a failing outcome.
    const hasFailed = stepGates.some((gateId) =>
      (state.gate_outcomes ?? []).some(
        (o) => o.gate_id === gateId && (o.status === "block" || o.status === "route-back")
      )
    );

    // Passed: all gates have pass outcomes (or gate-less step appeared in allowed transition).
    const allGatesPassed =
      stepGates.length > 0 &&
      stepGates.every((gateId) =>
        (state.gate_outcomes ?? []).some(
          (o) => o.gate_id === gateId && o.status === "pass"
        )
      );
    const gatelessPassed =
      stepGates.length === 0 &&
      stepCompletionIsCurrent(state, step.id);
    const passed = allGatesPassed || gatelessPassed;

    if (hasFailed && step.id !== state.current_step) {
      result[step.id] = "failed";
    } else if (step.id === state.current_step) {
      result[step.id] = "current";
    } else if (passed) {
      result[step.id] = "passed";
    } else if (readySet.has(step.id)) {
      result[step.id] = "ready";
    } else if (!predecessorsPassed(def, step.id, state)) {
      result[step.id] = "blocked";
    } else {
      result[step.id] = "pending";
    }
  }

  return result;
}
