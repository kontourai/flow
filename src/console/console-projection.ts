import { existsSync } from "node:fs";
import path from "node:path";

import { FLOW_RUN_REPORT_JSON_FILE } from "../runtime/flow-files.js";
import {
  attachedEvidenceFor,
  continuationLine,
  evaluateGate,
  expectationsForGate,
  findGate,
  loadRun,
  openGates,
  readJson,
  runDir,
  slugLabel
} from "../index.js";

export type FlowConsoleExternalLinkKind =
  | "surface"
  | "veritas"
  | "artifact"
  | "pull-request"
  | "ci"
  | "release-report";

export interface FlowConsoleExternalLinkRef {
  id: string;
  kind: FlowConsoleExternalLinkKind;
  label?: string;
  href?: string;
  path?: string;
  source: string;
  target_id?: string;
}

export interface FlowConsoleRunIdentity {
  run_id: string;
  definition_id: string;
  definition_version: string;
  subject: string | null;
  status: string | null;
  current_step: string | null;
  updated_at: string | null;
  params: Record<string, unknown>;
}

export interface FlowConsoleDefinitionProjection {
  id: string;
  version: string;
  title: string | null;
  description: string | null;
  raw: Record<string, unknown>;
}

export interface FlowConsoleStepProjection {
  id: string;
  index: number;
  label: string;
  next: string | null;
  gates: string[];
  raw: Record<string, unknown>;
}

export interface FlowConsoleExpectationProjection {
  id: string;
  gate_id?: string;
  kind: string | null;
  required: boolean;
  description: string | null;
  evidence_kind?: string;
  claim?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface FlowConsoleEvidenceProjection {
  id: string;
  gate_id: string | null;
  kind: string | null;
  requested_kind: string | null;
  status: string | null;
  expectation_ids: string[];
  producer: string | null;
  authority_trace: string | null;
  authority_traces: string[];
  stored_path: string | null;
  original_path: string | null;
  route_reason: string | null;
  claim: Record<string, unknown> | null;
  trust_artifact: Record<string, unknown> | null;
  diagnostics: Record<string, unknown> | null;
  /**
   * The Surface-derived TrustReport for a trust.bundle entry, passed through
   * read-only so the console drawer can mount a <surface-trust-panel>. Flow
   * never re-derives in the browser; this is the already-derived report.
   */
  bundle_report: Record<string, unknown> | null;
  external_links: FlowConsoleExternalLinkRef[];
  raw: Record<string, unknown>;
}

export interface FlowConsoleGateProjection {
  id: string;
  step_id: string;
  status: string;
  summary: string;
  is_open: boolean;
  expectations: FlowConsoleExpectationProjection[];
  evidence_refs: string[];
  evidence: FlowConsoleEvidenceProjection[];
  missing: string[];
  optional_missing: string[];
  matched_expectations: Array<Record<string, unknown>>;
  accepted_exception_id?: string;
  route_back_to?: string;
  selected_route?: string;
  recovery_step?: string;
  route_reason?: string;
  reason?: string;
  attempt?: number;
  max_attempts?: number;
  limit_exceeded?: boolean;
  expectation_ids?: string[];
  classifier?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
  analytics?: Record<string, unknown>;
  analytics_loop_key?: string;
  transition_validation?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface FlowConsoleExceptionProjection {
  id: string;
  gate_id: string | null;
  reason: string | null;
  authority: string | null;
  accepted_at: string | null;
  evidence_refs: string[];
  external_links: FlowConsoleExternalLinkRef[];
  raw: Record<string, unknown>;
}

export interface FlowConsoleTransitionProjection {
  id: string;
  type: string;
  from_step: string | null;
  to_step: string | null;
  status: string | null;
  gate_id: string | null;
  reason: string | null;
  route_reason: string | null;
  evidence_refs: string[];
  expectation_ids: string[];
  at: string | null;
  external_links: FlowConsoleExternalLinkRef[];
  raw: Record<string, unknown>;
}

export interface FlowConsoleRouteBackProjection {
  id: string;
  source: "gate_outcome" | "transition";
  gate_id: string | null;
  from_step: string | null;
  to_step: string | null;
  route_back_to: string | null;
  reason: string | null;
  selected_route: string | null;
  recovery_step: string | null;
  attempt: number | null;
  max_attempts: number | null;
  limit_exceeded: boolean;
  /**
   * Steps whose previously-passed outcomes were cleared by the route-back
   * cascade (`invalidateDescendants`), passed through read-only so the console
   * can show which downstream stages must re-run. Empty when the route-back
   * invalidated nothing downstream.
   */
  invalidated_steps: string[];
  evidence_refs: string[];
  expectation_ids: string[];
}

export interface FlowConsoleReportProjection {
  path: string | null;
  json: Record<string, unknown>;
}

export interface FlowConsoleProjection {
  schema_version: string;
  run: FlowConsoleRunIdentity;
  definition: FlowConsoleDefinitionProjection;
  steps: FlowConsoleStepProjection[];
  current_step: string | null;
  open_gates: string[];
  gates: FlowConsoleGateProjection[];
  expectations: FlowConsoleExpectationProjection[];
  evidence: FlowConsoleEvidenceProjection[];
  exceptions: FlowConsoleExceptionProjection[];
  transitions: FlowConsoleTransitionProjection[];
  route_backs: FlowConsoleRouteBackProjection[];
  external_links: FlowConsoleExternalLinkRef[];
  next_action: string | null;
  continuation: string;
  report: FlowConsoleReportProjection | null;
}

export interface FlowConsoleProjectionOptions {
  cwd?: string;
  config?: Record<string, unknown>;
}

export interface FlowConsoleRunParts {
  dir?: string | null;
  definition: Record<string, any>;
  state: Record<string, any>;
  manifest?: Record<string, any>;
  config?: Record<string, any>;
  report?: Record<string, unknown> | null;
  reportJson?: Record<string, unknown> | null;
}

const OPEN_LINK_KINDS = new Set([
  "surface",
  "veritas",
  "artifact",
  "pull-request",
  "ci",
  "release-report"
]);

const LINK_CONTAINER_KEYS = new Set(["links", "external_links", "external_refs", "refs", "references"]);

const LINK_KIND_ALIASES = {
  pr: "pull-request",
  pull_request: "pull-request",
  pullRequest: "pull-request",
  release_report: "release-report",
  releaseReport: "release-report",
  surface_claim: "surface",
  surfaceClaim: "surface",
  veritas_readiness: "veritas",
  veritasReadiness: "veritas"
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableClone(entry)])
  );
}

function stableArray(value) {
  return Array.isArray(value) ? stableClone(value) : [];
}

function stableObject(value) {
  return isObject(value) ? stableClone(value) : {};
}

function normalizeLinkKind(kind) {
  const normalized = LINK_KIND_ALIASES[kind] ?? kind;
  return OPEN_LINK_KINDS.has(normalized) ? normalized : null;
}

function firstLinkHref(ref) {
  return ref.href ?? ref.url ?? ref.web_url ?? ref.html_url ?? ref.link;
}

function linkFromRef(ref, source, targetId, fallbackKind = null) {
  if (!isObject(ref)) return null;
  const kind = normalizeLinkKind(ref.kind ?? ref.type ?? ref.rel ?? fallbackKind);
  if (!kind) return null;
  const href = firstLinkHref(ref);
  const pathValue = ref.path ?? ref.file ?? ref.stored_path ?? ref.original_path;
  const id = ref.id ?? ref.ref_id ?? ref.name ?? href ?? pathValue;
  return {
    id: id ?? `${source}:${kind}`,
    kind,
    ...(ref.label ?? ref.title ? { label: ref.label ?? ref.title } : {}),
    ...(href ? { href } : {}),
    ...(pathValue ? { path: pathValue } : {}),
    source,
    ...(targetId ? { target_id: targetId } : {})
  };
}

function pushLink(links, link) {
  if (!link) return;
  links.push(stableClone(link));
}

function collectNamedLinkRefs(value, links, source, targetId, insideContainer = false) {
  if (!isObject(value) && !Array.isArray(value)) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectNamedLinkRefs(entry, links, source, targetId, insideContainer));
    return;
  }

  if (insideContainer) pushLink(links, linkFromRef(value, source, targetId));
  for (const [key, entry] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (LINK_CONTAINER_KEYS.has(key)) {
      collectNamedLinkRefs(entry, links, source, targetId, true);
      continue;
    }
    const kind = normalizeLinkKind(key);
    if (insideContainer && kind) {
      const values = Array.isArray(entry) ? entry : [entry];
      values.forEach((ref) => {
        if (typeof ref === "string") {
          pushLink(links, { id: ref, kind, href: ref, source, ...(targetId ? { target_id: targetId } : {}) });
        } else {
          pushLink(links, linkFromRef(ref, source, targetId, kind));
        }
      });
      continue;
    }
  }
}

function linkSortKey(link) {
  return [
    link.source,
    link.target_id ?? "",
    link.kind,
    link.id ?? "",
    link.href ?? "",
    link.path ?? ""
  ].join("\u0000");
}

function uniqueLinks(links) {
  const unique = new Map();
  for (const link of links) {
    unique.set(linkSortKey(link), link);
  }
  return [...unique.values()].sort((left, right) => linkSortKey(left).localeCompare(linkSortKey(right)));
}

function evidenceLinks(entry) {
  const links = [];
  if (entry.stored_path) {
    pushLink(links, {
      id: `${entry.id}:stored_path`,
      kind: "artifact",
      path: entry.stored_path,
      source: "evidence",
      target_id: entry.id
    });
  }
  if (entry.original_path) {
    pushLink(links, {
      id: `${entry.id}:original_path`,
      kind: "artifact",
      path: entry.original_path,
      source: "evidence",
      target_id: entry.id
    });
  }
  collectNamedLinkRefs(entry, links, "evidence", entry.id);
  return uniqueLinks(links);
}

function projectExpectation(expectation) {
  return {
    id: expectation.id,
    kind: expectation.kind ?? null,
    required: expectation.required ?? false,
    description: expectation.description ?? null,
    ...(expectation.evidence_kind ? { evidence_kind: expectation.evidence_kind } : {}),
    ...(expectation.claim ? { claim: stableClone(expectation.claim) } : {}),
    raw: stableClone(expectation)
  };
}

function projectEvidence(entry) {
  return {
    id: entry.id,
    gate_id: entry.gate_id ?? null,
    kind: entry.kind ?? null,
    requested_kind: entry.requested_kind ?? null,
    status: entry.status ?? null,
    expectation_ids: stableArray(entry.expectation_ids),
    producer: entry.producer ?? null,
    authority_trace: entry.authority_trace ?? null,
    authority_traces: stableArray(entry.authority_traces),
    stored_path: entry.stored_path ?? null,
    original_path: entry.original_path ?? null,
    route_reason: entry.route_reason ?? null,
    claim: entry.claim ? stableClone(entry.claim) : null,
    trust_artifact: entry.trust_artifact ? stableClone(entry.trust_artifact) : null,
    diagnostics: entry.diagnostics ? stableClone(entry.diagnostics) : null,
    bundle_report: entry.bundle_report ? stableClone(entry.bundle_report) : null,
    external_links: evidenceLinks(entry),
    raw: stableClone(entry)
  };
}

function projectGate(definition, state, manifest, config, gateId) {
  const gate = findGate(definition, gateId);
  const outcome = state.gate_outcomes.find((entry) => entry.gate_id === gateId);
  const computed = evaluateGate(definition, state, manifest, gateId, config);
  const evidence = attachedEvidenceFor(manifest, gateId);
  const expectations = expectationsForGate(gate, config).map(projectExpectation);
  const status = outcome?.status ?? computed.status ?? "wait";
  const summary = outcome?.summary ?? computed.summary ?? `${slugLabel(gateId)} waiting`;
  const projected = {
    id: gateId,
    step_id: gate.step,
    status,
    summary,
    is_open: openGates(definition, state).some((openGate) => openGate.id === gateId),
    expectations,
    evidence_refs: stableArray(outcome?.evidence_refs ?? computed.evidence_refs ?? evidence.map((entry) => entry.id)),
    evidence: evidence.map(projectEvidence),
    missing: stableArray(outcome?.missing ?? computed.missing),
    optional_missing: stableArray(outcome?.optional_missing ?? computed.optional_missing),
    matched_expectations: stableArray(outcome?.matched_expectations ?? computed.matched_expectations),
    raw: stableClone(gate)
  };
  for (const field of [
    "accepted_exception_id",
    "route_back_to",
    "selected_route",
    "recovery_step",
    "route_reason",
    "reason",
    "attempt",
    "max_attempts",
    "limit_exceeded",
    "expectation_ids",
    "classifier",
    "diagnostics",
    "analytics",
    "analytics_loop_key",
    "transition_validation"
  ]) {
    if ((outcome ?? computed)?.[field] !== undefined) projected[field] = stableClone((outcome ?? computed)[field]);
  }
  return projected;
}

function projectTransition(transition, index) {
  const links = [];
  collectNamedLinkRefs(transition, links, "transition", transition.id ?? `transition.${index + 1}`);
  return {
    id: transition.id ?? `transition.${index + 1}`,
    type: transition.type ?? "step",
    from_step: transition.from_step ?? null,
    to_step: transition.to_step ?? null,
    status: transition.status ?? null,
    gate_id: transition.gate_id ?? null,
    reason: transition.reason ?? null,
    route_reason: transition.route_reason ?? null,
    evidence_refs: stableArray(transition.evidence_refs),
    expectation_ids: stableArray(transition.expectation_ids),
    at: transition.at ?? null,
    external_links: uniqueLinks(links),
    raw: stableClone(transition)
  };
}

function projectException(exception, index) {
  const links = [];
  collectNamedLinkRefs(exception, links, "exception", exception.id ?? `exception.${index + 1}`);
  return {
    id: exception.id ?? `exception.${index + 1}`,
    gate_id: exception.gate_id ?? null,
    reason: exception.reason ?? null,
    authority: exception.authority ?? null,
    accepted_at: exception.accepted_at ?? null,
    evidence_refs: stableArray(exception.evidence_refs),
    external_links: uniqueLinks(links),
    raw: stableClone(exception)
  };
}

function projectRouteBack(source, index, sourceType) {
  const routeBack = {
    id: source.id ?? `${sourceType}.${index + 1}`,
    source: sourceType,
    gate_id: source.gate_id ?? null,
    from_step: source.from_step ?? null,
    to_step: source.to_step ?? source.route_back_to ?? null,
    route_back_to: source.route_back_to ?? source.to_step ?? null,
    reason: source.route_reason ?? source.reason ?? null,
    selected_route: source.selected_route ?? null,
    recovery_step: source.recovery_step ?? null,
    attempt: source.attempt ?? null,
    max_attempts: source.max_attempts ?? null,
    limit_exceeded: source.limit_exceeded ?? false,
    invalidated_steps: stableArray(source.invalidated_steps),
    evidence_refs: stableArray(source.evidence_refs),
    expectation_ids: stableArray(source.expectation_ids)
  };
  return stableClone(routeBack);
}

function collectRouteBacks(state) {
  return [
    ...(state.gate_outcomes ?? [])
      .filter((outcome) => outcome.status === "route-back" || outcome.limit_exceeded || outcome.route_back_to)
      .map((outcome, index) => projectRouteBack(outcome, index, "gate_outcome")),
    ...(state.transitions ?? [])
      .filter((transition) => transition.type === "route_back" || transition.type === "route-back" || transition.status === "route-back")
      .map((transition, index) => projectRouteBack(transition, index, "transition"))
  ];
}

function collectExternalLinks({ manifest, state, report }) {
  const links = [];
  for (const entry of manifest.evidence ?? []) links.push(...evidenceLinks(entry));
  (state.transitions ?? []).forEach((transition, index) => {
    collectNamedLinkRefs(transition, links, "transition", transition.id ?? `transition.${index + 1}`);
  });
  (state.exceptions ?? []).forEach((exception, index) => {
    collectNamedLinkRefs(exception, links, "exception", exception.id ?? `exception.${index + 1}`);
  });
  (state.gate_outcomes ?? []).forEach((outcome) => {
    collectNamedLinkRefs(outcome, links, "gate_outcome", outcome.gate_id);
  });
  if (report) collectNamedLinkRefs(report, links, "report", report.run_id);
  return uniqueLinks(links);
}

function normalizeRunParts(runOrParts) {
  return {
    dir: runOrParts.dir ?? null,
    definition: runOrParts.definition,
    state: runOrParts.state,
    manifest: runOrParts.manifest ?? { evidence: [] },
    config: runOrParts.config,
    report: runOrParts.report ?? runOrParts.reportJson ?? null
  };
}

function projectRunIdentity(definition, state): FlowConsoleRunIdentity {
  return {
    run_id: state.run_id,
    definition_id: state.definition_id ?? definition.id,
    definition_version: state.definition_version ?? definition.version,
    subject: state.subject ?? null,
    status: state.status ?? null,
    current_step: state.current_step ?? null,
    updated_at: state.updated_at ?? null,
    params: stableObject(state.params)
  };
}

function projectDefinition(definition): FlowConsoleDefinitionProjection {
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title ?? definition.name ?? null,
    description: definition.description ?? null,
    raw: stableClone(definition)
  };
}

function projectSteps(definition, gateIds): FlowConsoleStepProjection[] {
  return (definition.steps ?? []).map((step, index) => ({
    id: step.id,
    index,
    label: step.label ?? slugLabel(step.id),
    next: step.next ?? null,
    gates: gateIds.filter((gateId) => definition.gates[gateId]?.step === step.id),
    raw: stableClone(step)
  }));
}

function projectAllExpectations(gates): FlowConsoleExpectationProjection[] {
  return gates.flatMap((gate) => gate.expectations.map((expectation) => ({ ...expectation, gate_id: gate.id })));
}

function projectAllEvidence(manifest): FlowConsoleEvidenceProjection[] {
  return (manifest.evidence ?? []).map(projectEvidence).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function projectReport(dir, report): FlowConsoleReportProjection | null {
  if (!report) return null;
  return {
    path: dir ? FLOW_RUN_REPORT_JSON_FILE : null,
    json: stableClone(report)
  };
}

export function projectFlowRun(
  runOrParts: FlowConsoleRunParts,
  options: FlowConsoleProjectionOptions = {}
): FlowConsoleProjection {
  const { dir, definition, state, manifest, config, report } = normalizeRunParts(runOrParts);
  const effectiveConfig = config ?? options.config;
  const gateIds = Object.keys(definition.gates ?? {}).sort((left, right) => left.localeCompare(right));
  const gates = gateIds.map((gateId) => projectGate(definition, state, manifest, effectiveConfig, gateId));
  const transitions = (state.transitions ?? []).map(projectTransition);
  const exceptions = (state.exceptions ?? []).map(projectException);
  const persistedReport = report ?? null;

  return stableClone({
    schema_version: "0.1",
    run: projectRunIdentity(definition, state),
    definition: projectDefinition(definition),
    steps: projectSteps(definition, gateIds),
    current_step: state.current_step ?? null,
    open_gates: openGates(definition, state).map((gate) => gate.id).sort((left, right) => left.localeCompare(right)),
    gates,
    expectations: projectAllExpectations(gates),
    evidence: projectAllEvidence(manifest),
    exceptions,
    transitions,
    route_backs: collectRouteBacks(state),
    external_links: collectExternalLinks({ manifest, state, report: persistedReport }),
    next_action: state.next_action ?? null,
    continuation: continuationLine(state),
    report: projectReport(dir, persistedReport)
  });
}

export async function projectFlowRunFromFiles(
  runId: string,
  options: FlowConsoleProjectionOptions = {}
): Promise<FlowConsoleProjection> {
  const cwd = options.cwd ?? process.cwd();
  const run = await loadRun(runId, cwd);
  const reportPath = path.join(runDir(runId, cwd), "report.json");
  const report = existsSync(reportPath) ? await readJson(reportPath) : null;
  return projectFlowRun({ ...run, report }, options);
}
