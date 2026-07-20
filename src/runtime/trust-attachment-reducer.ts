import { createHash } from "node:crypto";

import { defaultFlowConfig } from "../config/flow-config.js";
import type { FlowEvidenceEntry, MutableRecord } from "../contracts/flow-types.js";
import { findGate } from "../definition/flow-definition.js";
import { applyEvaluation, evaluateGate } from "../gates/flow-gates.js";
import { reportJson, renderMarkdownReport } from "../reports/flow-reports.js";
import { surfaceTimestampValidationView } from "../shared/rfc3339.js";

/** The independently versioned, pure attachment-reducer contract. */
export const TRUST_ATTACHMENT_REDUCER_VERSION = "1.0.0";
export const TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID = "kontourai.flow.trust-attachment-reducer";

export interface TrustAttachmentReducerDependencies {
  hachure: {
    package: "hachure";
    version: string;
    validate(bundle: unknown): { valid: boolean; errors: string[] };
  };
  surface: {
    package: "@kontourai/surface";
    version: string;
    validate(bundle: unknown): MutableRecord;
    buildReport(bundle: MutableRecord, options: { now: Date }): MutableRecord;
  };
}

export interface TrustAttachmentReducerIdentity {
  artifact_id: typeof TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID;
  version: typeof TRUST_ATTACHMENT_REDUCER_VERSION;
  dependency_versions: { hachure: string; surface: string };
  hash: string;
}

export interface TrustAttachmentReducerInput {
  run: {
    definition: MutableRecord;
    state: MutableRecord;
    manifest: MutableRecord;
    config?: MutableRecord;
  };
  bundle: unknown;
  attachment: MutableRecord & {
    id: string;
    gate_id: string;
    attached_at: string;
    supersede?: string | string[];
  };
  now: string;
  dependencies: TrustAttachmentReducerDependencies;
}

export interface TrustAttachmentReducerWrite {
  path: "evidence/manifest.json" | "state.json" | "report.json" | "report.md";
  value: MutableRecord | string;
}

export interface TrustAttachmentReducerResult {
  identity: TrustAttachmentReducerIdentity;
  evidence: FlowEvidenceEntry;
  next_manifest: MutableRecord;
  next_state: MutableRecord;
  evaluation: MutableRecord;
  result: { evidence: FlowEvidenceEntry; evaluation: MutableRecord; state: MutableRecord };
  report: { json: MutableRecord; markdown: string };
  write: { intent: "replace"; artifacts: TrustAttachmentReducerWrite[] };
}

/** Pure manifest-only attachment step shared with the filesystem adapter. */
export function reduceTrustAttachmentManifest(
  manifest: MutableRecord,
  evidence: FlowEvidenceEntry,
  supersede: string | string[] | undefined
): { evidence: FlowEvidenceEntry; next_manifest: MutableRecord } {
  if (!Array.isArray(manifest.evidence)) throw new Error("evidence manifest evidence must be an array");
  if (manifest.evidence.some((entry: any) => entry?.id === evidence.id)) throw new Error(`evidence id already exists: ${evidence.id}`);
  const next_manifest = structuredClone(manifest) as MutableRecord;
  const supersedeIds = Array.isArray(supersede) ? supersede : supersede ? [supersede] : [];
  for (const supersededId of supersedeIds) {
    const superseded = next_manifest.evidence.find((entry: any) => entry?.id === supersededId);
    if (!superseded) throw new Error(`cannot supersede unknown evidence: ${supersededId}`);
    if (superseded.gate_id !== evidence.gate_id) {
      throw new Error(`cannot supersede evidence ${supersededId}: it belongs to gate ${superseded.gate_id}, not ${evidence.gate_id}`);
    }
    superseded.superseded_by = evidence.id;
  }
  next_manifest.evidence.push(structuredClone(evidence));
  return { evidence: structuredClone(evidence), next_manifest };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/**
 * A coordinator can pin this identity alongside the package integrity for the
 * reducer artifact. The hash intentionally covers only the public reducer
 * contract and its explicit dependency versions; it never reads package files
 * or ambient process state.
 */
export function trustAttachmentReducerIdentity(dependencies: TrustAttachmentReducerDependencies): TrustAttachmentReducerIdentity {
  const dependency_versions = { hachure: dependencies.hachure.version, surface: dependencies.surface.version };
  const hash = createHash("sha256")
    .update(canonicalJson({ artifact_id: TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID, version: TRUST_ATTACHMENT_REDUCER_VERSION, dependency_versions }))
    .digest("hex");
  return { artifact_id: TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID, version: TRUST_ATTACHMENT_REDUCER_VERSION, dependency_versions, hash: `sha256:${hash}` };
}

export function normalizeTrustAttachmentBundle(bundle: unknown, now: string, dependencies: TrustAttachmentReducerDependencies): { bundle: MutableRecord; bundle_report: MutableRecord } {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) throw new Error("trust bundle must be a JSON object");
  const validationView = surfaceTimestampValidationView(bundle);
  const schemaResult = dependencies.hachure.validate(validationView);
  if (!schemaResult.valid) {
    throw new Error(`trust bundle does not conform to Hachure schema: ${schemaResult.errors.slice(0, 3).join("; ")}`);
  }
  let validated: MutableRecord;
  try {
    validated = dependencies.surface.validate(validationView);
  } catch (error) {
    throw new Error(`trust bundle validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const evaluationTime = new Date(now);
  if (!Number.isFinite(evaluationTime.getTime())) throw new Error("now must be a valid RFC3339 date-time");
  return { bundle: structuredClone(bundle) as MutableRecord, bundle_report: dependencies.surface.buildReport(validated, { now: evaluationTime }) };
}

function attachmentMetadata(attachment: MutableRecord): MutableRecord {
  const evidence: MutableRecord = {
    id: attachment.id,
    gate_id: attachment.gate_id,
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: attachment.status ?? "passed",
    original_path: attachment.original_path,
    stored_path: attachment.stored_path,
    sha256: attachment.sha256,
    attached_at: attachment.attached_at
  };
  for (const key of ["producer", "authority_trace", "route_reason", "expectation_ids", "classifier", "diagnostics", "analytics"]) {
    if (attachment[key] !== undefined) evidence[key] = structuredClone(attachment[key]);
  }
  return evidence;
}

/**
 * Deterministically attaches one Hachure bundle to canonical in-memory run
 * inputs. It has no filesystem, network, environment, process, or clock
 * access: identifiers, attachment time, source metadata, and `now` are all
 * caller-supplied. The returned write set is descriptive; callers own I/O.
 */
export function reduceTrustAttachment(input: TrustAttachmentReducerInput): TrustAttachmentReducerResult {
  const { run, attachment, dependencies } = input;
  if (!findGate(run.definition, attachment.gate_id)) throw new Error(`unknown gate: ${attachment.gate_id}`);
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid RFC3339 date-time");

  const normalized = normalizeTrustAttachmentBundle(input.bundle, input.now, dependencies);
  const evidence = attachmentMetadata(attachment) as FlowEvidenceEntry;
  evidence.bundle = normalized.bundle;
  evidence.bundle_report = normalized.bundle_report;

  const { next_manifest } = reduceTrustAttachmentManifest(run.manifest, evidence, attachment.supersede);

  const next_state = structuredClone(run.state) as MutableRecord;
  const evaluation = evaluateGate(run.definition, next_state, next_manifest, attachment.gate_id, run.config ?? defaultFlowConfig());
  applyEvaluation(run.definition, next_state, evaluation, input.now);
  const report = {
    json: reportJson(run.definition, next_state, next_manifest),
    markdown: renderMarkdownReport(run.definition, next_state, next_manifest)
  };
  return {
    identity: trustAttachmentReducerIdentity(dependencies),
    evidence,
    next_manifest,
    next_state,
    evaluation,
    result: { evidence, evaluation, state: next_state },
    report,
    write: {
      intent: "replace",
      artifacts: [
        { path: "evidence/manifest.json", value: next_manifest },
        { path: "state.json", value: next_state },
        { path: "report.json", value: report.json },
        { path: "report.md", value: report.markdown }
      ]
    }
  };
}
