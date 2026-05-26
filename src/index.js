import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FLOW_SCHEMA_VERSION = "0.1";

export const BUILTIN_EVIDENCE_KINDS = new Set([
  "command",
  "file",
  "ci",
  "surface.claim",
  "veritas-readiness",
  "human-attestation",
  "trace-link"
]);

const STATUS_ORDER = ["pass", "block", "route-back", "wait"];

export function flowRoot(cwd = process.cwd()) {
  return path.join(cwd, ".flow");
}

export function flowConfigPath(cwd = process.cwd()) {
  return path.join(flowRoot(cwd), "config.json");
}

export function runDir(runId, cwd = process.cwd()) {
  return path.join(flowRoot(cwd), "runs", runId);
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function slugLabel(value) {
  if (value === "implement-gate") return "implementation gate";
  return value.replace(/-/g, " ");
}

export function normalizeEvidenceKind(kind) {
  if (!kind) return "file";
  return BUILTIN_EVIDENCE_KINDS.has(kind) ? kind : "custom";
}

export function evidenceMatchesRequirement(entry, requiredKind) {
  return entry.kind === requiredKind || entry.requested_kind === requiredKind;
}

export function evidenceLabel(kind) {
  const labels = {
    "acceptance-criteria": "acceptance criteria",
    "scoped-diff": "scoped files",
    "browser-evidence": "screenshot",
    "veritas-readiness": "Veritas readiness"
  };
  return labels[kind] ?? slugLabel(kind);
}

export function passSummary(kind) {
  const summaries = {
    "acceptance-criteria": "acceptance criteria linked",
    "scoped-diff": "scoped files changed",
    "browser-evidence": "browser evidence attached",
    "veritas-readiness": "Veritas readiness attached"
  };
  return summaries[kind] ?? `${evidenceLabel(kind)} attached`;
}

export function missingSummary(kind) {
  const summaries = {
    "browser-evidence": "browser evidence missing",
    "veritas-readiness": "Veritas readiness missing"
  };
  return summaries[kind] ?? `${evidenceLabel(kind)} missing`;
}

export function expectationLabel(expectation) {
  if (typeof expectation === "string") return evidenceLabel(expectation);
  return expectation.description || expectation.id || expectation.claim?.type || expectation.kind;
}

export function defaultFlowConfig() {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: {},
    gate_overrides: {}
  };
}

export const FLOW_CONFIG_MERGE_REPORT_SCHEMA_VERSION = FLOW_SCHEMA_VERSION;

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function valueEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathSegmentsToJsonPath(segments) {
  return `$${segments.map((segment) => `.${segment}`).join("")}`;
}

function mergeSectionForPath(pathValue) {
  if (pathValue.startsWith("$.trusted_producers")) return "trusted_producers";
  if (pathValue.startsWith("$.gate_overrides")) return "gate_overrides";
  return "config";
}

function getPathValue(root, segments) {
  return segments.reduce((value, segment) => (isObject(value) ? value[segment] : undefined), root);
}

function setPathValue(root, segments, value) {
  let target = root;
  for (const segment of segments.slice(0, -1)) {
    target[segment] ??= {};
    target = target[segment];
  }
  target[segments.at(-1)] = cloneJson(value);
}

function collectMergePaths(value, segments = []) {
  if (!isObject(value) || Object.keys(value).length === 0) return [segments];
  return Object.entries(value).flatMap(([key, entry]) => collectMergePaths(entry, [...segments, key]));
}

function proposedConfigFromEnvelope(proposal) {
  return proposal?.flow_config ?? proposal?.config ?? proposal;
}

function normalizeAcceptedConflictPaths(values = []) {
  const paths = Array.isArray(values) ? values : [values];
  return new Set(paths.filter(Boolean));
}

function conflictAccepted(pathValue, acceptedPaths) {
  return acceptedPaths.has(pathValue) || [...acceptedPaths].some((acceptedPath) => pathValue.startsWith(`${acceptedPath}.`));
}

function configMergeSummary(report) {
  return {
    proposed: report.proposed_changes.length,
    accepted: report.accepted_changes.length,
    rejected: report.rejected_changes.length,
    conflicts: report.conflicts.length,
    unchanged: report.unchanged.length,
    exceptions: report.exceptions.length
  };
}

function configChange({ path: pathValue, operation, reason, localValue, proposedValue, acceptedValue }) {
  return {
    path: pathValue,
    section: mergeSectionForPath(pathValue),
    operation,
    reason,
    ...(localValue !== undefined ? { local_value: cloneJson(localValue) } : {}),
    ...(proposedValue !== undefined ? { proposed_value: cloneJson(proposedValue) } : {}),
    ...(acceptedValue !== undefined ? { accepted_value: cloneJson(acceptedValue) } : {})
  };
}

export function previewFlowConfigMerge(localConfig = defaultFlowConfig(), kitProposal = defaultFlowConfig(), options = {}) {
  const local = { ...defaultFlowConfig(), ...(localConfig ?? {}) };
  const proposed = { ...defaultFlowConfig(), ...(proposedConfigFromEnvelope(kitProposal) ?? {}) };
  const merged = cloneJson(local);
  const acceptedPaths = normalizeAcceptedConflictPaths(options.acceptConflicts ?? options.acceptedConflicts);
  const exceptionReason = options.exceptionReason;
  const exceptionAuthority = options.authority;
  if (acceptedPaths.size && (!exceptionReason || !exceptionAuthority)) {
    throw new Error("accepting config merge conflicts requires exception reason and authority");
  }

  const report = {
    schema_version: FLOW_CONFIG_MERGE_REPORT_SCHEMA_VERSION,
    mode: options.mode ?? "preview",
    status: "ready",
    local_config_path: options.localConfigPath ?? flowConfigPath(options.cwd ?? process.cwd()),
    proposal_path: options.proposalPath ?? null,
    proposed_changes: [],
    accepted_changes: [],
    rejected_changes: [],
    conflicts: [],
    unchanged: [],
    exceptions: [],
    merged_config: merged,
    summary: {}
  };

  for (const section of ["trusted_producers", "gate_overrides"]) {
    for (const segments of collectMergePaths(proposed[section] ?? {}, [section])) {
      const pathValue = pathSegmentsToJsonPath(segments);
      const proposedValue = getPathValue(proposed, segments);
      const localValue = getPathValue(local, segments);
      if (proposedValue === undefined) continue;

      report.proposed_changes.push(configChange({
        path: pathValue,
        operation: localValue === undefined ? "add" : valueEquals(localValue, proposedValue) ? "unchanged" : "replace",
        reason: "kit proposed project config value",
        localValue,
        proposedValue
      }));

      if (localValue === undefined) {
        setPathValue(merged, segments, proposedValue);
        report.accepted_changes.push(configChange({
          path: pathValue,
          operation: "add",
          reason: "local path absent",
          proposedValue,
          acceptedValue: proposedValue
        }));
      } else if (valueEquals(localValue, proposedValue)) {
        report.unchanged.push(configChange({
          path: pathValue,
          operation: "unchanged",
          reason: "local value already matches proposal",
          localValue,
          proposedValue,
          acceptedValue: localValue
        }));
      } else if (conflictAccepted(pathValue, acceptedPaths)) {
        setPathValue(merged, segments, proposedValue);
        const exception = {
          path: pathValue,
          section: mergeSectionForPath(pathValue),
          reason: exceptionReason,
          authority: exceptionAuthority,
          local_value: cloneJson(localValue),
          proposed_value: cloneJson(proposedValue),
          accepted_value: cloneJson(proposedValue)
        };
        report.exceptions.push(exception);
        report.accepted_changes.push(configChange({
          path: pathValue,
          operation: "replace",
          reason: "explicit exception accepted conflicting proposal",
          localValue,
          proposedValue,
          acceptedValue: proposedValue
        }));
      } else {
        const change = configChange({
          path: pathValue,
          operation: "replace",
          reason: "local authority exists with a different value",
          localValue,
          proposedValue
        });
        report.conflicts.push(change);
        report.rejected_changes.push({
          ...change,
          reason: "preserved local authority; explicit exception required"
        });
      }
    }
  }

  report.status = report.conflicts.length ? "conflicts" : "ready";
  report.summary = configMergeSummary(report);
  return report;
}

export async function previewFlowConfigMergeFile(proposalPath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const resolvedProposalPath = path.resolve(cwd, proposalPath);
  const localConfigPath = flowConfigPath(cwd);
  const [localConfig, proposedConfig] = await Promise.all([
    loadFlowConfig(cwd),
    readJson(resolvedProposalPath)
  ]);
  return previewFlowConfigMerge(localConfig, proposedConfig, {
    ...options,
    mode: "preview",
    localConfigPath,
    proposalPath: resolvedProposalPath
  });
}

export async function applyFlowConfigMerge(cwdOrProposalPath, proposalPathOrOptions, maybeOptions = {}) {
  const cwd = typeof proposalPathOrOptions === "string" ? cwdOrProposalPath : (maybeOptions.cwd ?? process.cwd());
  const proposalPath = typeof proposalPathOrOptions === "string" ? proposalPathOrOptions : cwdOrProposalPath;
  const options = typeof proposalPathOrOptions === "string" ? maybeOptions : (proposalPathOrOptions ?? {});
  const resolvedProposalPath = path.resolve(cwd, proposalPath);
  const localConfigPath = flowConfigPath(cwd);
  const report = previewFlowConfigMerge(await loadFlowConfig(cwd), await readJson(resolvedProposalPath), {
    ...options,
    mode: "apply",
    cwd,
    localConfigPath,
    proposalPath: resolvedProposalPath
  });
  if (report.conflicts.length) return { ...report, status: "blocked" };
  await writeJson(localConfigPath, report.merged_config);
  return { ...report, status: "applied" };
}

function renderConfigMergeBucket(title, entries) {
  const lines = [`## ${title}`, ""];
  if (!entries.length) return [...lines, "- none", ""].join("\n");
  for (const entry of entries) {
    lines.push(`- ${entry.path} (${entry.section}, ${entry.operation}): ${entry.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function renderConfigMergeMarkdown(report) {
  return [
    "# Flow Project Config Merge Report",
    "",
    `Mode: ${report.mode}`,
    `Status: ${report.status}`,
    `Local config: ${report.local_config_path}`,
    `Proposal: ${report.proposal_path ?? "inline"}`,
    "",
    "## Summary",
    "",
    `- Proposed changes: ${report.summary.proposed}`,
    `- Accepted changes: ${report.summary.accepted}`,
    `- Rejected changes: ${report.summary.rejected}`,
    `- Conflicts: ${report.summary.conflicts}`,
    `- Exceptions: ${report.summary.exceptions}`,
    "",
    renderConfigMergeBucket("Accepted Changes", report.accepted_changes),
    renderConfigMergeBucket("Rejected Changes", report.rejected_changes),
    renderConfigMergeBucket("Conflicts", report.conflicts),
    renderConfigMergeBucket("Unchanged", report.unchanged),
    renderConfigMergeBucket("Exceptions", report.exceptions)
  ].join("\n");
}

export function renderConfigMergeSummary(report) {
  return [
    `flow config merge: ${report.status}`,
    `proposed: ${report.summary.proposed}; accepted: ${report.summary.accepted}; rejected: ${report.summary.rejected}; conflicts: ${report.summary.conflicts}; exceptions: ${report.summary.exceptions}`,
    `local config: ${report.local_config_path}`,
    `proposal: ${report.proposal_path ?? "inline"}`
  ].join("\n") + "\n";
}

export async function loadFlowConfig(cwd = process.cwd()) {
  const file = flowConfigPath(cwd);
  if (!existsSync(file)) return defaultFlowConfig();
  return { ...defaultFlowConfig(), ...(await readJson(file)) };
}

export function getStep(definition, stepId) {
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

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validateExpectation(expectation, path, diagnostics) {
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

export function definitionDiagnostics(definition) {
  const diagnostics = [];
  if (!isObject(definition)) {
    return [createDiagnostic("definition.invalid", "$", "definition must be an object")];
  }
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
    for (const [gateId, gate] of Object.entries(definition.gates)) {
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

export function validateDefinitionWithDiagnostics(definition) {
  const diagnostics = definitionDiagnostics(definition);
  return {
    valid: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics
  };
}

export function validateDefinition(definition) {
  const diagnostic = validateDefinitionWithDiagnostics(definition).diagnostics[0];
  if (diagnostic) throw new Error(diagnostic.message);
  const stepIds = new Set((definition.steps ?? []).map((step) => step.id));
  for (const [gateId, gate] of Object.entries(definition.gates ?? {})) {
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

export function gatesForStep(definition, stepId) {
  return Object.entries(definition.gates)
    .map(([id, gate]) => ({ id, ...gate }))
    .filter((gate) => gate.step === stepId);
}

export function findGate(definition, gateId) {
  const gate = definition.gates[gateId];
  return gate ? { id: gateId, ...gate } : null;
}

export function initialState(definition, runId, params = {}) {
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

export function nextActionForStep(definition, stepId, outcome = null) {
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

export function routeBackDecision(state, gate, routeReason, evidence = [], options = {}) {
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
  const routeData = {
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

export function expectationsForGate(gate, config = defaultFlowConfig()) {
  const overrides = config.gate_overrides?.[gate.id]?.expectations ?? {};
  if (gate.expects?.length) {
    return gate.expects.map((expectation) => ({
      ...expectation,
      claim: expectation.claim ? { ...expectation.claim } : undefined,
      ...(overrides[expectation.id] ?? {}),
      id: expectation.id
    }));
  }
  return (gate.requires ?? []).map((requiredKind) => ({
    id: requiredKind,
    kind: "evidence.kind",
    required: true,
    description: evidenceLabel(requiredKind),
    evidence_kind: requiredKind,
    ...(overrides[requiredKind] ?? {})
  }));
}

export function evidenceProducerTrusted(entry, expectation, config = defaultFlowConfig()) {
  const claimType = expectation.claim?.type;
  const override = config.gate_overrides?.[expectation.gate_id]?.expectations?.[expectation.id] ?? {};
  const mapping = claimType ? config.trusted_producers?.[claimType] : null;
  const trustedProducers = override.trusted_producers ?? mapping?.producers ?? [];
  const trustedTraces = override.authority_traces ?? mapping?.authority_traces ?? [];
  if (!trustedProducers.length && !trustedTraces.length) return true;
  return trustedProducers.includes(entry.producer) || trustedTraces.includes(entry.authority_trace);
}

export function evidenceMatchesExpectation(entry, expectation, config = defaultFlowConfig()) {
  if (expectation.kind === "evidence.kind") {
    return evidenceMatchesRequirement(entry, expectation.evidence_kind) && entry.status !== "failed";
  }
  if (expectation.kind !== "surface.claim") return false;
  if (entry.kind !== "surface.claim" && entry.requested_kind !== "surface.claim") return false;
  if (entry.status === "failed") return false;
  if (entry.claim?.type !== expectation.claim?.type) return false;
  if (expectation.claim?.subject && entry.claim?.subject !== expectation.claim.subject) return false;
  const accepted = expectation.accepted_statuses ?? expectation.claim?.accepted_statuses ?? ["trusted"];
  const claimStatus = entry.claim?.status ?? entry.trust_status ?? entry.status;
  if (!accepted.includes(claimStatus)) return false;
  return evidenceProducerTrusted(entry, expectation, config);
}

export function evaluateGate(definition, state, manifest, gateId, config = defaultFlowConfig()) {
  const gate = findGate(definition, gateId);
  if (!gate) throw new Error(`unknown gate: ${gateId}`);

  const exception = acceptedExceptionFor(state, gateId);
  if (exception) {
    return {
      gate_id: gateId,
      status: "pass",
      summary: "accepted exception",
      evidence_refs: exception.evidence_refs ?? [],
      accepted_exception_id: exception.id
    };
  }

  const evidence = attachedEvidenceFor(manifest, gateId);
  const failed = evidence.filter((entry) => entry.status === "failed");
  if (failed.length) {
    const routeReason = routeReasonForFailedEvidence(failed[0]);
    const route = routeBackDecision(state, gate, routeReason, failed);
    return {
      gate_id: gateId,
      status: route.status,
      summary: `${slugLabel(gate.id)} has failing evidence`,
      ...route
    };
  }

  const expectations = expectationsForGate(gate, config);
  const matched = [];
  const missingRequired = [];
  const missingOptional = [];
  for (const expectation of expectations) {
    const expectationWithGate = { ...expectation, gate_id: gateId };
    const match = evidence.find((entry) => evidenceMatchesExpectation(entry, expectationWithGate, config));
    if (match) {
      matched.push({ expectation_id: expectation.id, evidence_id: match.id });
    } else if (expectation.required) {
      missingRequired.push(expectation.id);
    } else {
      missingOptional.push(expectation.id);
    }
  }

  if (missingRequired.length) {
    const first = expectations.find((expectation) => expectation.id === missingRequired[0]);
    if (gate.on_route_back?.missing_evidence) {
      const route = routeBackDecision(state, gate, "missing_evidence", evidence, { expectationIds: missingRequired });
      return {
        gate_id: gateId,
        status: route.status,
        summary: `${expectationLabel(first)} missing`,
        missing: missingRequired,
        optional_missing: missingOptional,
        matched_expectations: matched,
        ...route
      };
    }
    return {
      gate_id: gateId,
      status: "block",
      summary: `${expectationLabel(first)} missing`,
      missing: missingRequired,
      optional_missing: missingOptional,
      matched_expectations: matched,
      evidence_refs: evidence.map((entry) => entry.id)
    };
  }

  if (!expectations.length) {
    return {
      gate_id: gateId,
      status: "wait",
      summary: `${slugLabel(gate.id)} waiting for evidence`,
      evidence_refs: evidence.map((entry) => entry.id),
      optional_missing: missingOptional,
      matched_expectations: matched
    };
  }

  return {
    gate_id: gateId,
    status: "pass",
    summary: `${expectationLabel(expectations[0])} satisfied`,
    evidence_refs: evidence.map((entry) => entry.id),
    optional_missing: missingOptional,
    matched_expectations: matched
  };
}

export function legacyEvaluateGate(definition, state, manifest, gateId) {
  const gate = findGate(definition, gateId);
  const evidence = attachedEvidenceFor(manifest, gateId);
  const missing = (gate.requires ?? []).filter((requiredKind) => {
    return !evidence.some((entry) => evidenceMatchesRequirement(entry, requiredKind) && entry.status !== "failed");
  });

  if (missing.length) {
    return {
      gate_id: gateId,
      status: "block",
      summary: missingSummary(missing[0]),
      missing,
      evidence_refs: evidence.map((entry) => entry.id)
    };
  }

  if (gate.requires.length === 0) {
    return {
      gate_id: gateId,
      status: "wait",
      summary: `${slugLabel(gate.id)} waiting for evidence`,
      evidence_refs: evidence.map((entry) => entry.id)
    };
  }

  return {
    gate_id: gateId,
    status: "pass",
    summary: passSummary(gate.requires[0]),
    evidence_refs: evidence.map((entry) => entry.id)
  };
}

export function mergeGateOutcome(state, outcome) {
  const without = state.gate_outcomes.filter((entry) => entry.gate_id !== outcome.gate_id);
  state.gate_outcomes = [...without, outcome];
}

export function applyEvaluation(definition, state, outcome) {
  const gate = findGate(definition, outcome.gate_id);
  mergeGateOutcome(state, outcome);

  if (outcome.status === "pass") {
    const step = getStep(definition, gate.step);
    const nextStep = step?.next ?? null;
    state.transitions.push({
      from_step: gate.step,
      to_step: nextStep,
      status: "allowed",
      reason: outcome.accepted_exception_id ? "accepted exception" : "required evidence present",
      at: new Date().toISOString(),
      gate_id: outcome.gate_id
    });
    state.current_step = nextStep ?? gate.step;
    state.status = nextStep ? "active" : "completed";
  } else if (outcome.status === "block") {
    state.status = "blocked";
    if (outcome.limit_exceeded) {
      state.transitions.push({
        type: "route_back",
        from_step: gate.step,
        to_step: outcome.route_back_to,
        status: "blocked",
        reason: outcome.reason ?? outcome.route_reason ?? outcome.summary,
        route_reason: outcome.route_reason,
        selected_route: outcome.selected_route,
        recovery_step: outcome.recovery_step,
        attempt: outcome.attempt,
        max_attempts: outcome.max_attempts,
        limit_exceeded: outcome.limit_exceeded,
        evidence_refs: outcome.evidence_refs,
        expectation_ids: outcome.expectation_ids,
        classifier: outcome.classifier,
        diagnostics: outcome.diagnostics,
        analytics: outcome.analytics,
        analytics_loop_key: outcome.analytics_loop_key,
        at: new Date().toISOString(),
        gate_id: outcome.gate_id
      });
    } else {
      state.transitions.push({
        from_step: gate.step,
        to_step: getStep(definition, gate.step)?.next ?? null,
        status: "blocked",
        reason: outcome.summary,
        at: new Date().toISOString(),
        gate_id: outcome.gate_id
      });
    }
  } else if (outcome.status === "route-back") {
    state.status = "active";
    state.current_step = outcome.route_back_to;
    state.transitions.push({
      type: "route_back",
      from_step: gate.step,
      to_step: outcome.route_back_to,
      status: "blocked",
      reason: outcome.reason ?? outcome.route_reason ?? outcome.summary,
      route_reason: outcome.route_reason,
      selected_route: outcome.selected_route,
      recovery_step: outcome.recovery_step,
      attempt: outcome.attempt,
      max_attempts: outcome.max_attempts,
      limit_exceeded: outcome.limit_exceeded,
      evidence_refs: outcome.evidence_refs,
      expectation_ids: outcome.expectation_ids,
      classifier: outcome.classifier,
      diagnostics: outcome.diagnostics,
      analytics: outcome.analytics,
      analytics_loop_key: outcome.analytics_loop_key,
      at: new Date().toISOString(),
      gate_id: outcome.gate_id
    });
  } else {
    state.status = "active";
  }

  state.next_action = nextActionForStep(definition, state.current_step, outcome);
  state.updated_at = new Date().toISOString();
}

export async function ensureFlowLayout(cwd = process.cwd()) {
  const root = flowRoot(cwd);
  await mkdir(path.join(root, "definitions"), { recursive: true });
  await mkdir(path.join(root, "runs"), { recursive: true });
  await writeFile(path.join(root, "README.md"), flowReadme());
  if (!existsSync(flowConfigPath(cwd))) await writeJson(flowConfigPath(cwd), defaultFlowConfig());
  const sample = await readJson(examplePath("agent-dev-flow.json"));
  await writeJson(path.join(root, "definitions", "agent-dev-flow.json"), sample);
  return root;
}

export function flowReadme() {
  return `# .flow\n\nLocal Flow state lives here.\n\n- definitions/ contains Flow Definition JSON files.\n- config.json is the project authority model for trusted producers and gate overrides.\n- runs/<run-id>/ contains definition.json, state.json, evidence/, report.md, and report.json.\n- runs/<run-id>/evidence/manifest.json records attached evidence metadata.\n\nThis directory is intentionally file-backed so a run can be resumed without chat history.\n`;
}

export function moduleRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

export function examplePath(file) {
  return path.join(moduleRoot(), "examples", file);
}

export async function startRun(definitionPath, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const definition = await readJson(path.resolve(cwd, definitionPath));
  validateDefinition(definition);
  const runId = options.runId ?? `run.${Date.now()}`;
  const dir = runDir(runId, cwd);
  if (existsSync(dir)) throw new Error(`run already exists: ${runId}`);
  const state = initialState(definition, runId, options.params ?? {});
  await mkdir(path.join(dir, "evidence"), { recursive: true });
  await writeJson(path.join(dir, "definition.json"), definition);
  await writeJson(path.join(dir, "state.json"), state);
  await writeJson(path.join(dir, "evidence", "manifest.json"), { schema_version: FLOW_SCHEMA_VERSION, evidence: [] });
  await renderAndWriteReport(definition, state, { schema_version: FLOW_SCHEMA_VERSION, evidence: [] }, dir);
  return { runId, dir, state };
}

export async function loadRun(runId, cwd = process.cwd()) {
  const dir = runDir(runId, cwd);
  const definition = await readJson(path.join(dir, "definition.json"));
  validateDefinition(definition);
  const state = await readJson(path.join(dir, "state.json"));
  const config = await loadFlowConfig(cwd);
  const manifestPath = path.join(dir, "evidence", "manifest.json");
  const manifest = existsSync(manifestPath)
    ? await readJson(manifestPath)
    : { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };
  return { dir, definition, state, manifest, config };
}

export async function saveRun(run) {
  await writeJson(path.join(run.dir, "state.json"), run.state);
  await writeJson(path.join(run.dir, "evidence", "manifest.json"), run.manifest);
  await renderAndWriteReport(run.definition, run.state, run.manifest, run.dir);
}

export async function sha256File(file) {
  const data = await readFile(file);
  return createHash("sha256").update(data).digest("hex");
}

export async function attachEvidence(runId, options) {
  const run = await loadRun(runId, options.cwd);
  const source = path.resolve(options.cwd ?? process.cwd(), options.file);
  await stat(source);
  const gate = findGate(run.definition, options.gate);
  if (!gate) throw new Error(`unknown gate: ${options.gate}`);
  const kind = normalizeEvidenceKind(options.kind);
  const requestedKind = options.kind ?? "file";
  const id = `ev.${Date.now()}.${run.manifest.evidence.length + 1}`;
  const ext = path.extname(source);
  const storedName = `${id}${ext}`;
  const storedPath = path.join(run.dir, "evidence", storedName);
  await copyFile(source, storedPath);
  const entry = {
    id,
    gate_id: options.gate,
    kind,
    requested_kind: requestedKind,
    status: options.status ?? "passed",
    original_path: options.file,
    stored_path: path.join("evidence", storedName),
    sha256: await sha256File(source),
    attached_at: new Date().toISOString()
  };
  if (options.claimType) {
    entry.kind = "surface.claim";
    entry.requested_kind = "surface.claim";
    entry.claim = {
      type: options.claimType,
      status: options.claimStatus ?? "trusted"
    };
    if (options.claimSubject) entry.claim.subject = options.claimSubject;
  }
  if (options.producer) entry.producer = options.producer;
  if (options.authorityTrace) entry.authority_trace = options.authorityTrace;
  if (options.route_reason) entry.route_reason = options.route_reason;
  if (options.expectation_ids) entry.expectation_ids = options.expectation_ids;
  if (options.classifier) entry.classifier = options.classifier;
  if (options.diagnostics) entry.diagnostics = options.diagnostics;
  if (options.analytics) entry.analytics = options.analytics;
  run.manifest.evidence.push(entry);
  await saveRun(run);
  return entry;
}

export async function evaluateRun(runId, options = {}) {
  const run = await loadRun(runId, options.cwd);
  const gates = options.gate ? [findGate(run.definition, options.gate)] : openGates(run.definition, run.state);
  if (!gates.length || gates.some((gate) => !gate)) throw new Error(options.gate ? `unknown gate: ${options.gate}` : "no gate for current step");
  const outcomes = [];
  for (const gate of gates) {
    const outcome = evaluateGate(run.definition, run.state, run.manifest, gate.id, run.config);
    applyEvaluation(run.definition, run.state, outcome);
    outcomes.push(outcome);
    if (outcome.status !== "pass") break;
  }
  await saveRun(run);
  return { ...run, outcomes };
}

export async function acceptException(runId, options) {
  const run = await loadRun(runId, options.cwd);
  if (!findGate(run.definition, options.gate)) throw new Error(`unknown gate: ${options.gate}`);
  const exception = {
    id: `ex.${Date.now()}.${run.state.exceptions.length + 1}`,
    gate_id: options.gate,
    reason: options.reason,
    authority: options.authority,
    accepted_at: new Date().toISOString()
  };
  run.state.exceptions.push(exception);
  run.state.status = "accepted_by_exception";
  run.state.next_action = `evaluate ${slugLabel(options.gate)} with accepted exception`;
  await saveRun(run);
  return exception;
}

export async function listRuns(cwd = process.cwd()) {
  const dir = path.join(flowRoot(cwd), "runs");
  if (!existsSync(dir)) return [];
  const ids = await readdir(dir);
  const runs = [];
  for (const id of ids) {
    try {
      const run = await loadRun(id, cwd);
      runs.push({
        run_id: id,
        definition_id: run.state.definition_id,
        subject: run.state.subject,
        status: run.state.status,
        current_step: run.state.current_step,
        updated_at: run.state.updated_at
      });
    } catch {
      // Ignore incomplete run directories.
    }
  }
  return runs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

export function reportJson(definition, state, manifest) {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: state.run_id,
    definition_id: definition.id,
    definition_version: definition.version,
    subject: state.subject,
    status: state.status,
    summary: `${definition.id} / ${state.subject}`,
    current_step: state.current_step,
    next_action: state.next_action,
    continuation: continuationLine(state),
    open_gates: openGates(definition, state).map((gate) => gate.id),
    accepted_exceptions: state.exceptions,
    gate_summaries: Object.keys(definition.gates).map((gateId) => {
      const outcome = state.gate_outcomes.find((entry) => entry.gate_id === gateId);
      const evidence = attachedEvidenceFor(manifest, gateId);
      const summary = {
        gate_id: gateId,
        status: outcome?.status ?? "wait",
        summary: outcome?.summary ?? `${slugLabel(gateId)} waiting`,
        evidence_refs: evidence.map((entry) => entry.id),
        missing: outcome?.missing ?? [],
        optional_missing: outcome?.optional_missing ?? [],
        matched_expectations: outcome?.matched_expectations ?? []
      };
      for (const field of [
        "route_back_to",
        "selected_route",
        "recovery_step",
        "route_reason",
        "attempt",
        "max_attempts",
        "limit_exceeded",
        "expectation_ids",
        "classifier",
        "diagnostics",
        "analytics",
        "analytics_loop_key"
      ]) {
        if (outcome?.[field] !== undefined) summary[field] = outcome[field];
      }
      return summary;
    })
  };
}

export function renderMarkdownReport(definition, state, manifest) {
  const report = reportJson(definition, state, manifest);
  const lines = [
    `# Flow Report: ${state.run_id}`,
    "",
    `- Definition: ${definition.id} v${definition.version}`,
    `- Subject: ${state.subject}`,
    `- Status: ${state.status}`,
    `- Current step: ${state.current_step}`,
    `- Next action: ${state.next_action}`,
    `- Continuation: ${report.continuation}`,
    "",
    "## Gates",
    ""
  ];
  for (const gate of report.gate_summaries) {
    lines.push(`- ${gate.status.toUpperCase()} ${slugLabel(gate.gate_id)}: ${gate.summary}`);
    if (gate.missing?.length) lines.push(`  - Missing: ${gate.missing.map(evidenceLabel).join(", ")}`);
    if (gate.optional_missing?.length) lines.push(`  - Optional missing: ${gate.optional_missing.map(evidenceLabel).join(", ")}`);
    if (gate.evidence_refs.length) lines.push(`  - Evidence: ${gate.evidence_refs.join(", ")}`);
    if (gate.status === "route-back" || gate.limit_exceeded) {
      const attempt = gate.attempt ? `${gate.attempt}${gate.max_attempts ? `/${gate.max_attempts}` : ""}` : "n/a";
      lines.push(`  - Route back: ${gate.route_reason ?? gate.reason ?? "default"} -> ${gate.route_back_to} (attempt ${attempt}, limit exceeded: ${gate.limit_exceeded ? "yes" : "no"})`);
      if (gate.selected_route && gate.selected_route !== gate.route_back_to) lines.push(`  - Selected route: ${gate.selected_route}`);
      if (gate.recovery_step) lines.push(`  - Recovery step: ${gate.recovery_step}`);
      if (gate.expectation_ids?.length) lines.push(`  - Expectations: ${gate.expectation_ids.join(", ")}`);
      if (gate.classifier?.kind) lines.push(`  - Classifier: ${gate.classifier.kind}${gate.classifier.source ? ` from ${gate.classifier.source}` : ""}`);
      if (gate.analytics_loop_key) lines.push(`  - Analytics loop: ${gate.analytics_loop_key}`);
    }
  }
  lines.push("", "## Accepted Exceptions", "");
  if (state.exceptions.length) {
    for (const exception of state.exceptions) {
      lines.push(`- ${exception.gate_id}: ${exception.reason} (${exception.authority})`);
    }
  } else {
    lines.push("None.");
  }
  lines.push("", "## Evidence Manifest", "");
  if (manifest.evidence.length) {
    for (const entry of manifest.evidence) {
      lines.push(`- ${entry.id}: ${entry.kind} for ${entry.gate_id} (${entry.sha256})`);
    }
  } else {
    lines.push("No evidence attached.");
  }
  return `${lines.join("\n")}\n`;
}

export async function renderAndWriteReport(definition, state, manifest, dir) {
  await writeJson(path.join(dir, "report.json"), reportJson(definition, state, manifest));
  await writeFile(path.join(dir, "report.md"), renderMarkdownReport(definition, state, manifest));
}

export function renderSummary(definition, state) {
  const lines = [
    `flow run: ${definition.id} / ${state.subject}`,
    `current step: ${state.current_step}`,
    ""
  ];
  for (const [gateId] of Object.entries(definition.gates)) {
    const gate = findGate(definition, gateId);
    const outcome = state.gate_outcomes.find((entry) => entry.gate_id === gateId);
    const status = outcome?.status ?? "wait";
    const statusLabel = status === "pass" ? "PASS" : status === "block" ? "BLOCK" : status === "route-back" ? "ROUTE-BACK" : "WAIT";
    lines.push(`${statusLabel.padEnd(5)} ${slugLabel(gateId)}: ${outcome?.summary ?? `${slugLabel(gateId)} waiting`}`);
    if (outcome?.missing?.length) {
      lines.push(`      expected: ${expectationsForGate(gate).filter((entry) => entry.required).map(expectationLabel).join(", ")}`);
    }
    if (outcome?.status === "route-back" || outcome?.limit_exceeded) {
      const attempt = outcome.attempt ? `${outcome.attempt}${outcome.max_attempts ? `/${outcome.max_attempts}` : ""}` : "n/a";
      lines.push(`      route: ${outcome.route_reason ?? outcome.reason ?? "default"} -> ${outcome.route_back_to}; attempt ${attempt}; limit exceeded: ${outcome.limit_exceeded ? "yes" : "no"}`);
      if (outcome.recovery_step) lines.push(`      recovery: ${outcome.recovery_step}`);
      if (outcome.analytics_loop_key) lines.push(`      analytics loop: ${outcome.analytics_loop_key}`);
    }
  }
  lines.push("", `next action: ${state.next_action}`);
  lines.push(`continuation: ${continuationLine(state)}`);
  lines.push(`report: .flow/runs/${state.run_id}/report.md`);
  return `${lines.join("\n")}\n`;
}

export function renderResume(definition, state) {
  const gates = openGates(definition, state);
  const routeBacks = state.gate_outcomes.filter((outcome) => outcome.status === "route-back" || outcome.limit_exceeded);
  const lines = [
    `flow run: ${definition.id} / ${state.subject}`,
    `current step: ${state.current_step}`,
    `next action: ${state.next_action}`,
    `open gates: ${gates.length ? gates.map((gate) => gate.id).join(", ") : "none"}`,
    `accepted exceptions: ${state.exceptions.length ? state.exceptions.map((entry) => `${entry.gate_id} by ${entry.authority}`).join(", ") : "none"}`,
    `route backs: ${routeBacks.length ? routeBacks.map((outcome) => {
      const attempt = outcome.attempt ? `${outcome.attempt}${outcome.max_attempts ? `/${outcome.max_attempts}` : ""}` : "n/a";
      const recovery = outcome.recovery_step ? `, recovery ${outcome.recovery_step}` : "";
      return `${outcome.gate_id} ${outcome.route_reason ?? outcome.reason ?? "default"} -> ${outcome.route_back_to} attempt ${attempt}, limit exceeded ${outcome.limit_exceeded ? "yes" : "no"}${recovery}`;
    }).join("; ") : "none"}`,
    `guidance: continue from recorded Flow state; ${state.next_action}`
  ];
  return `${lines.join("\n")}\n`;
}

export function sortStatus(a, b) {
  return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
}
