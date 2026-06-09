import { existsSync } from "node:fs";
import path from "node:path";

import { flowConfigPath, readJson, writeJson } from "../runtime/flow-files.js";
import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type { ConfigMergeReport, FlowConfig, MutableRecord } from "../contracts/flow-types.js";
import { cloneJson, isNonEmptyString, isObject, valueEquals } from "../shared/flow-utils.js";

const FLOW_PROJECT_CONFIG_RESOURCE_API_VERSION = "flow.kontourai.io/v1alpha1";
const FLOW_PROJECT_CONFIG_RESOURCE_KIND = "FlowProjectConfig";
const FLOW_PROJECT_CONFIG_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const UNSAFE_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function defaultFlowConfig(): FlowConfig {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: {},
    gate_overrides: {}
  };
}

export const FLOW_CONFIG_MERGE_REPORT_SCHEMA_VERSION = FLOW_SCHEMA_VERSION;

function isFlowProjectConfigResource(config: any) {
  return isObject(config)
    && (
      config.apiVersion !== undefined
      || config.kind !== undefined
      || config.metadata !== undefined
      || config.spec !== undefined
    );
}

function normalizeFlowConfig(config: any) {
  if (!isFlowProjectConfigResource(config)) return config;
  if (config.apiVersion !== FLOW_PROJECT_CONFIG_RESOURCE_API_VERSION) {
    throw new Error(`config.apiVersion must be ${FLOW_PROJECT_CONFIG_RESOURCE_API_VERSION}`);
  }
  if (config.kind !== FLOW_PROJECT_CONFIG_RESOURCE_KIND) {
    throw new Error(`config.kind must be ${FLOW_PROJECT_CONFIG_RESOURCE_KIND}`);
  }
  if (!isObject(config.metadata)) throw new Error("config.metadata must be an object");
  if (!isObject(config.spec)) throw new Error("config.spec must be an object");
  validateResourceMetadata(config.metadata);
  if (config.spec.schema_version !== FLOW_SCHEMA_VERSION) throw new Error(`config.spec.schema_version must be ${FLOW_SCHEMA_VERSION}`);
  return config.spec;
}

function assertSafeConfigKey(segment) {
  if (UNSAFE_CONFIG_KEYS.has(segment)) throw new Error(`unsafe config path segment: ${segment}`);
}

function validateResourceStringMap(value: any, path: string) {
  if (value === undefined) return;
  if (!isObject(value)) throw new Error(`${path} must be an object with string values`);
  for (const [key, entry] of Object.entries(value)) {
    assertSafeConfigKey(key);
    if (typeof entry !== "string") throw new Error(`${path}.${key} must be a string`);
  }
}

function validateResourceMetadata(metadata: any) {
  const allowed = new Set(["name", "labels", "annotations"]);
  for (const key of Object.keys(metadata)) {
    assertSafeConfigKey(key);
    if (!allowed.has(key)) throw new Error(`config.metadata.${key} is not supported`);
  }
  if (!isNonEmptyString(metadata.name) || !FLOW_PROJECT_CONFIG_NAME_PATTERN.test(metadata.name)) {
    throw new Error("config.metadata.name must match ^[a-z0-9][a-z0-9._-]*$");
  }
  validateResourceStringMap(metadata.labels, "config.metadata.labels");
  validateResourceStringMap(metadata.annotations, "config.metadata.annotations");
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
  return segments.reduce((value, segment) => {
    assertSafeConfigKey(segment);
    return isObject(value) ? value[segment] : undefined;
  }, root);
}

function setPathValue(root, segments, value) {
  let target = root;
  for (const segment of segments.slice(0, -1)) {
    assertSafeConfigKey(segment);
    target[segment] ??= {};
    target = target[segment];
  }
  const finalSegment = segments.at(-1);
  assertSafeConfigKey(finalSegment);
  target[finalSegment] = cloneJson(value);
}

function collectMergePaths(value: any, segments: string[] = []): string[][] {
  if (!isObject(value) || Object.keys(value).length === 0) return [segments];
  return Object.entries(value).flatMap(([key, entry]) => {
    assertSafeConfigKey(key);
    return collectMergePaths(entry, [...segments, key]);
  });
}

function proposedConfigFromEnvelope(proposal) {
  return normalizeFlowConfig(proposal?.flow_config ?? proposal?.config ?? proposal);
}

function normalizeAcceptedConflictPaths(values: any[] | any = []) {
  const paths = Array.isArray(values) ? values : [values];
  return new Set(paths.filter(Boolean));
}

function conflictAccepted(pathValue, acceptedPaths) {
  return acceptedPaths.has(pathValue) || [...acceptedPaths].some((acceptedPath) => pathValue.startsWith(`${acceptedPath}.`));
}

function configMergeSummary(report: ConfigMergeReport) {
  return {
    proposed: report.proposed_changes.length,
    accepted: report.accepted_changes.length,
    rejected: report.rejected_changes.length,
    conflicts: report.conflicts.length,
    unchanged: report.unchanged.length,
    exceptions: report.exceptions.length
  };
}

function configChange({ path: pathValue, operation, reason, localValue, proposedValue, acceptedValue }: MutableRecord) {
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

export function previewFlowConfigMerge(localConfig: MutableRecord = defaultFlowConfig(), kitProposal: MutableRecord = defaultFlowConfig(), options: MutableRecord = {}): ConfigMergeReport {
  const local = { ...defaultFlowConfig(), ...(normalizeFlowConfig(localConfig) ?? {}) };
  const proposed = { ...defaultFlowConfig(), ...(proposedConfigFromEnvelope(kitProposal) ?? {}) };
  const merged = cloneJson(local);
  const acceptedPaths = normalizeAcceptedConflictPaths(options.acceptConflicts ?? options.acceptedConflicts);
  const exceptionReason = options.exceptionReason;
  const exceptionAuthority = options.authority;
  if (acceptedPaths.size && (!exceptionReason || !exceptionAuthority)) {
    throw new Error("accepting config merge conflicts requires exception reason and authority");
  }

  const report: ConfigMergeReport = {
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

export async function previewFlowConfigMergeFile(proposalPath: string, options: MutableRecord = {}) {
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

export async function applyFlowConfigMerge(cwdOrProposalPath: string, proposalPathOrOptions?: string | MutableRecord, maybeOptions: MutableRecord = {}) {
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
  return { ...defaultFlowConfig(), ...normalizeFlowConfig(await readJson(file)) };
}
