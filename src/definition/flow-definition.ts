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

function normalizeFlowDefinition(definition: any) {
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
  if (expectation.kind !== "surface.claim") {
    diagnostics.push(createDiagnostic("definition.expectation.kind.unsupported", `${path}.kind`, "expectation.kind must be surface.claim"));
  }
  if (typeof expectation.required !== "boolean") {
    diagnostics.push(createDiagnostic("definition.expectation.required.invalid", `${path}.required`, "expectation.required must be a boolean"));
  }
  if (!isNonEmptyString(expectation.description)) {
    diagnostics.push(createDiagnostic("definition.expectation.description.required", `${path}.description`, "expectation.description must be a non-empty string"));
  }
  if (expectation.kind === "surface.claim" && !isObject(expectation.claim)) {
    diagnostics.push(createDiagnostic("definition.expectation.claim.required", `${path}.claim`, "surface.claim expectations must include claim"));
    return;
  }
  if (!isObject(expectation.claim)) return;
  if (!isNonEmptyString(expectation.claim.type)) {
    diagnostics.push(createDiagnostic("definition.expectation.claim.type.required", `${path}.claim.type`, "surface.claim expectations must include claim.type"));
  }
  if (expectation.claim.subject !== undefined && !isNonEmptyString(expectation.claim.subject)) {
    diagnostics.push(createDiagnostic("definition.expectation.claim.subject.invalid", `${path}.claim.subject`, "claim.subject must be a non-empty string when present"));
  }
  if (expectation.claim.accepted_statuses !== undefined) {
    if (!Array.isArray(expectation.claim.accepted_statuses) || expectation.claim.accepted_statuses.length === 0) {
      diagnostics.push(createDiagnostic("definition.expectation.claim.accepted_statuses.invalid", `${path}.claim.accepted_statuses`, "claim.accepted_statuses must be a non-empty array"));
    } else {
      expectation.claim.accepted_statuses.forEach((status, index) => {
        if (!isNonEmptyString(status)) {
          diagnostics.push(createDiagnostic("definition.expectation.claim.accepted_status.invalid", `${path}.claim.accepted_statuses[${index}]`, "accepted status must be a non-empty string"));
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
        if (!Array.isArray(gate.requires)) {
          diagnostics.push(createDiagnostic("definition.gate.requires.invalid", `${gatePath}.requires`, `gate ${gateId} requires must be an array`));
        } else {
          gate.requires.forEach((requiredKind, index) => {
            if (!isNonEmptyString(requiredKind)) {
              diagnostics.push(createDiagnostic("definition.gate.requires.kind.invalid", `${gatePath}.requires[${index}]`, "legacy requires entries must be non-empty strings"));
            }
          });
        }
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
    transitions: [],
    exceptions: [],
    next_action: nextActionForStep(definition, firstStep.id),
    updated_at: new Date().toISOString()
  };
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
  return `resume from ${state.current_step}, not chat memory`;
}

export function openGates(definition, state) {
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
  const reasonKey = routeReason ?? "default";
  const priorMatches = (state.transitions ?? []).filter((transition) => {
    return transition.type === "route_back"
      && transition.gate_id === gateId
      && (transition.route_reason ?? transition.reason) === reasonKey
      && transition.from_step === fromStep
      && transition.to_step === toStep;
  });
  return priorMatches.length + 1;
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
