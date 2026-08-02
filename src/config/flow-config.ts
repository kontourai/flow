import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { flowConfigPath, readJson } from "../runtime/flow-files.js";
import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type {
  ConfigMergeReport,
  ConfigMergeUnpublishedReport,
  FlowConfig,
  FlowConfigMergeApplyOptions,
  FlowConfigMergePublisher,
  FlowConfigMergePublisherReceipt,
  FlowConfigMergePublisherRequest,
  MutableRecord
} from "../contracts/flow-types.js";
import { cloneJson, isNonEmptyString, isObject, valueEquals } from "../shared/flow-utils.js";
import { validateFlatFlowConfig } from "./flow-config-validator.js";

const FLOW_PROJECT_CONFIG_RESOURCE_API_VERSION = "flow.kontourai.io/v1alpha1";
const FLOW_PROJECT_CONFIG_RESOURCE_KIND = "FlowProjectConfig";
const FLOW_PROJECT_CONFIG_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const UNSAFE_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const FLOW_CONFIG_MERGE_PUBLISHER_API_VERSION = "flow.kontourai.io/v1alpha1" as const;

function sha256(contents: string) {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function publisherUnavailableError() {
  return new Error("flow.config.merge.publisher.unavailable: this host cannot safely publish project config; use flow config preview or provide a trusted config merge publisher capability");
}

function publisherInvalidError() {
  return new Error("flow.config.merge.publisher.invalid: publisher must be a function");
}

class ConfigMergePublisherReceiptInvalidError extends Error {
  constructor() {
    super("flow.config.merge.publisher.receipt.invalid: publisher must return an applied receipt bound to the requested config path and bytes");
  }
}

function publisherReceiptInvalidError() {
  return new ConfigMergePublisherReceiptInvalidError();
}

function configMergePublisher(options: FlowConfigMergeApplyOptions): FlowConfigMergePublisher {
  if (options.publisher === undefined) throw publisherUnavailableError();
  if (typeof options.publisher !== "function") throw publisherInvalidError();
  return options.publisher;
}

async function loadFlowConfigMergeBase(configPath: string) {
  let contents: string | undefined;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    config: contents === undefined
      ? defaultFlowConfig()
      : validateFlatFlowConfig({ ...defaultFlowConfig(), ...normalizeFlowConfig(JSON.parse(contents)) }) as FlowConfig,
    expectedConfigSha256: contents === undefined ? null : sha256(contents)
  };
}

function publisherReceipt(value: unknown, request: FlowConfigMergePublisherRequest): FlowConfigMergePublisherReceipt {
  if (!isObject(value)) throw publisherReceiptInvalidError();
  const receipt = value as MutableRecord;
  // Read every host-owned property exactly once. Accessor-backed objects and
  // proxies must not be able to present one value for validation and another
  // for the receipt Flow returns to callers.
  const snapshot = Object.freeze({
    api_version: receipt.api_version,
    status: receipt.status,
    publisher: receipt.publisher,
    publication_id: receipt.publication_id,
    config_path: receipt.config_path,
    contents_sha256: receipt.contents_sha256
  });
  if (snapshot.api_version !== FLOW_CONFIG_MERGE_PUBLISHER_API_VERSION
    || snapshot.status !== "applied"
    || !isNonEmptyString(snapshot.publisher)
    || !isNonEmptyString(snapshot.publication_id)
    || snapshot.config_path !== request.config_path
    || snapshot.contents_sha256 !== request.contents_sha256
  ) {
    throw publisherReceiptInvalidError();
  }
  return snapshot as FlowConfigMergePublisherReceipt;
}

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

function assertSafeConfigTree(value: any) {
  if (!isObject(value) || Array.isArray(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    assertSafeConfigKey(key);
    assertSafeConfigTree(entry);
  }
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

export function previewFlowConfigMerge(localConfig: MutableRecord = defaultFlowConfig(), kitProposal: MutableRecord = defaultFlowConfig(), options: MutableRecord = {}): ConfigMergeUnpublishedReport {
  const normalizedLocal = normalizeFlowConfig(localConfig);
  const normalizedProposed = proposedConfigFromEnvelope(kitProposal);
  assertSafeConfigTree(normalizedLocal);
  assertSafeConfigTree(normalizedProposed);
  const local = validateFlatFlowConfig({ ...defaultFlowConfig(), ...(normalizedLocal ?? {}) });
  const proposed = validateFlatFlowConfig({ ...defaultFlowConfig(), ...(normalizedProposed ?? {}) });
  const merged = cloneJson(local);
  const acceptedPaths = normalizeAcceptedConflictPaths(options.acceptConflicts ?? options.acceptedConflicts);
  const exceptionReason = options.exceptionReason;
  const exceptionAuthority = options.authority;
  if (acceptedPaths.size && (!exceptionReason || !exceptionAuthority)) {
    throw new Error("accepting config merge conflicts requires exception reason and authority");
  }

  const report: ConfigMergeUnpublishedReport = {
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
  report.merged_config = validateFlatFlowConfig(report.merged_config) as FlowConfig;
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

export async function applyFlowConfigMerge(cwdOrProposalPath: string, proposalPathOrOptions?: string | FlowConfigMergeApplyOptions, maybeOptions: FlowConfigMergeApplyOptions = {}): Promise<ConfigMergeReport> {
  const cwd = typeof proposalPathOrOptions === "string" ? cwdOrProposalPath : (maybeOptions.cwd ?? process.cwd());
  const proposalPath = typeof proposalPathOrOptions === "string" ? proposalPathOrOptions : cwdOrProposalPath;
  const options: FlowConfigMergeApplyOptions = typeof proposalPathOrOptions === "string" ? maybeOptions : (proposalPathOrOptions ?? {});
  // Flow has no safe pathname-only publication primitive. Require the host
  // capability before reading or creating any project state, so `apply` in a
  // plain Node/CLI host is predictably fail-closed and side-effect free.
  const publisher = configMergePublisher(options);
  const projectDirectory = path.resolve(cwd);
  const resolvedProposalPath = path.resolve(cwd, proposalPath);
  const localConfigPath = flowConfigPath(projectDirectory);
  const configDirectory = path.dirname(localConfigPath);
  const [local, proposedConfig] = await Promise.all([
    loadFlowConfigMergeBase(localConfigPath),
    readJson(resolvedProposalPath)
  ]);
  const report = previewFlowConfigMerge(local.config, proposedConfig, {
    ...options,
    mode: "apply",
    cwd: projectDirectory,
    localConfigPath,
    proposalPath: resolvedProposalPath
  });
  if (report.conflicts.length) return { ...report, status: "blocked" };

  const contents = `${JSON.stringify(report.merged_config, null, 2)}\n`;
  const request = Object.freeze({
    api_version: FLOW_CONFIG_MERGE_PUBLISHER_API_VERSION,
    project_directory: projectDirectory,
    config_directory: configDirectory,
    config_path: localConfigPath,
    expected_config_sha256: local.expectedConfigSha256,
    contents,
    contents_sha256: sha256(contents)
  }) satisfies FlowConfigMergePublisherRequest;
  let receipt: FlowConfigMergePublisherReceipt;
  try {
    const response = await publisher(request);
    receipt = publisherReceipt(response, request);
  } catch (error) {
    if (error instanceof ConfigMergePublisherReceiptInvalidError) throw error;
    // Publisher failures can contain credentials, internal paths, or other
    // host-only diagnostics. Keep that value available to trusted embedders as
    // the cause, but never reflect it through Flow's public/CLI error message.
    throw new Error(
      "flow.config.merge.publisher.failed: trusted config merge publisher failed; inspect the trusted host's internal diagnostics",
      { cause: error }
    );
  }
  return { ...report, mode: "apply", status: "applied", publisher_receipt: receipt };
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
  return validateFlatFlowConfig({ ...defaultFlowConfig(), ...normalizeFlowConfig(await readJson(file)) }) as FlowConfig;
}
