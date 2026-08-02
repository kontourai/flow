import { createHash } from "node:crypto";

import { defaultFlowConfig } from "../config/flow-config.js";
import type { FlowEvidenceEntry, MutableRecord } from "../contracts/flow-types.js";
import { findGate } from "../definition/flow-definition.js";
import { validateTrustBundleSchema } from "../gates/trust-bundle-validator.js";
import { applyEvaluation, evaluateGate } from "../gates/flow-gates.js";
import { reportJson, renderMarkdownReport } from "../reports/flow-reports.js";
import { surfaceTimestampValidationView } from "../shared/rfc3339.js";
import { buildTrustReport, checkAuthorityActive, validateTrustBundle } from "@kontourai/surface";

/** The independently versioned, pure attachment-reducer contract. */
export const TRUST_ATTACHMENT_REDUCER_VERSION = "1.3.4";
export const TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID = "kontourai.flow.trust-attachment-reducer";
export type TrustAttachmentEvaluationMode = "evaluate" | "attach-only";

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
    checkAuthorityActive(actorRef: string, traces: MutableRecord[], now: Date): string;
  };
}

const reducerSurfaceValidate = (bundle: unknown) => validateTrustBundle(bundle) as MutableRecord;
const reducerSurfaceBuildReport = (bundle: MutableRecord, options: { now: Date }) => buildTrustReport(bundle as any, options) as MutableRecord;
const reducerSurfaceCheckAuthority = (actorRef: string, traces: MutableRecord[], now: Date) => checkAuthorityActive(actorRef, traces as any, now);

/**
 * The one supported reducer adapter. Exact helper references are part of the
 * trusted boundary: callers may pin and pass this object, but cannot substitute
 * closure state while retaining Flow's reducer identity.
 */
export const FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES: TrustAttachmentReducerDependencies = Object.freeze({
  hachure: Object.freeze({ package: "hachure" as const, version: "0.15.0", validate: validateTrustBundleSchema }),
  surface: Object.freeze({
    package: "@kontourai/surface" as const,
    version: "2.14.0",
    validate: reducerSurfaceValidate,
    buildReport: reducerSurfaceBuildReport,
    checkAuthorityActive: reducerSurfaceCheckAuthority
  })
});

/**
 * Reads an adapter once and returns the exact, immutable helper set the reducer
 * will execute. This is deliberately a snapshot rather than a validation pass:
 * an accessor or Proxy must not be able to present approved helpers for identity
 * validation and different helpers for bundle normalization or gate evaluation.
 */
function resolveSupportedReducerDependencies(dependencies: TrustAttachmentReducerDependencies): TrustAttachmentReducerDependencies {
  const supported = FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES;
  const hachure = dependencies?.hachure;
  const surface = dependencies?.surface;
  const snapshot = {
    hachure: {
      package: hachure?.package,
      version: hachure?.version,
      validate: hachure?.validate
    },
    surface: {
      package: surface?.package,
      version: surface?.version,
      validate: surface?.validate,
      buildReport: surface?.buildReport,
      checkAuthorityActive: surface?.checkAuthorityActive
    }
  };
  if (
    snapshot.hachure.package !== supported.hachure.package
    || snapshot.hachure.version !== supported.hachure.version
    || snapshot.hachure.validate !== supported.hachure.validate
    || snapshot.surface.package !== supported.surface.package
    || snapshot.surface.version !== supported.surface.version
    || snapshot.surface.validate !== supported.surface.validate
    || snapshot.surface.buildReport !== supported.surface.buildReport
    || snapshot.surface.checkAuthorityActive !== supported.surface.checkAuthorityActive
  ) {
    throw new Error("unsupported trust attachment reducer dependency adapter: use FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES");
  }
  return Object.freeze({
    hachure: Object.freeze(snapshot.hachure as TrustAttachmentReducerDependencies["hachure"]),
    surface: Object.freeze(snapshot.surface as TrustAttachmentReducerDependencies["surface"])
  });
}

export interface TrustAttachmentReducerIdentity {
  artifact_id: typeof TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID;
  version: typeof TRUST_ATTACHMENT_REDUCER_VERSION;
  dependency_versions: { hachure: string; surface: string };
  dependency_integrities: {
    hachure: { validate: string };
    surface: { validate: string; buildReport: string; checkAuthorityActive: string };
  };
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
  evaluation_mode?: TrustAttachmentEvaluationMode;
  now: string;
  dependencies: TrustAttachmentReducerDependencies;
}

export interface TrustAttachmentReducerWrite {
  path: "evidence/manifest.json" | "state.json" | "report.json" | "report.md";
  value: MutableRecord | string;
}

export interface TrustAttachmentReducerResult {
  identity: TrustAttachmentReducerIdentity;
  evaluation_mode: TrustAttachmentEvaluationMode;
  evidence: FlowEvidenceEntry;
  next_manifest: MutableRecord;
  next_state: MutableRecord;
  evaluation: MutableRecord | null;
  result: { evidence: FlowEvidenceEntry; evaluation: MutableRecord | null; state: MutableRecord };
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
  return trustAttachmentReducerIdentityFor(resolveSupportedReducerDependencies(dependencies));
}

function trustAttachmentReducerIdentityFor(dependencies: TrustAttachmentReducerDependencies): TrustAttachmentReducerIdentity {
  const dependency_versions = { hachure: dependencies.hachure.version, surface: dependencies.surface.version };
  const helperIntegrity = (helper: Function) => `sha256:${createHash("sha256").update(Function.prototype.toString.call(helper)).digest("hex")}`;
  const dependency_integrities = {
    hachure: { validate: helperIntegrity(dependencies.hachure.validate) },
    surface: {
      validate: helperIntegrity(dependencies.surface.validate),
      buildReport: helperIntegrity(dependencies.surface.buildReport),
      checkAuthorityActive: helperIntegrity(dependencies.surface.checkAuthorityActive)
    }
  };
  const hash = createHash("sha256")
    .update(canonicalJson({ artifact_id: TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID, version: TRUST_ATTACHMENT_REDUCER_VERSION, dependency_versions, dependency_integrities }))
    .digest("hex");
  return { artifact_id: TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID, version: TRUST_ATTACHMENT_REDUCER_VERSION, dependency_versions, dependency_integrities, hash: `sha256:${hash}` };
}

export function normalizeTrustAttachmentBundle(bundle: unknown, now: string, dependencies: TrustAttachmentReducerDependencies): { bundle: MutableRecord; bundle_report: MutableRecord } {
  return normalizeTrustAttachmentBundleWithDependencies(bundle, now, resolveSupportedReducerDependencies(dependencies));
}

function normalizeTrustAttachmentBundleWithDependencies(bundle: unknown, now: string, dependencies: TrustAttachmentReducerDependencies): { bundle: MutableRecord; bundle_report: MutableRecord } {
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
  for (const key of ["producer", "authority_trace", "authority_traces", "route_reason", "expectation_ids", "classifier", "diagnostics", "analytics"]) {
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
  const { run, attachment } = input;
  const dependencies = resolveSupportedReducerDependencies(input.dependencies);
  const evaluationMode = input.evaluation_mode ?? "evaluate";
  if (!["evaluate", "attach-only"].includes(evaluationMode)) throw new Error(`unsupported trust attachment evaluation mode: ${String(evaluationMode)}`);
  if (!findGate(run.definition, attachment.gate_id)) throw new Error(`unknown gate: ${attachment.gate_id}`);
  const now = new Date(input.now);
  if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid RFC3339 date-time");

  const normalized = normalizeTrustAttachmentBundleWithDependencies(input.bundle, input.now, dependencies);
  const evidence = attachmentMetadata(attachment) as FlowEvidenceEntry;
  evidence.bundle = normalized.bundle;
  evidence.bundle_report = normalized.bundle_report;

  const { next_manifest } = reduceTrustAttachmentManifest(run.manifest, evidence, attachment.supersede);

  const next_state = structuredClone(run.state) as MutableRecord;
  const evaluation = evaluationMode === "evaluate"
    ? evaluateGate(run.definition, next_state, next_manifest, attachment.gate_id, run.config ?? defaultFlowConfig(), now, dependencies.surface)
    : null;
  if (evaluation) applyEvaluation(run.definition, next_state, evaluation, input.now);
  const report = {
    json: reportJson(run.definition, next_state, next_manifest),
    markdown: renderMarkdownReport(run.definition, next_state, next_manifest)
  };
  return {
    identity: trustAttachmentReducerIdentityFor(dependencies),
    evaluation_mode: evaluationMode,
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
        ...(evaluationMode === "evaluate" ? [{ path: "state.json" as const, value: next_state }] : []),
        { path: "report.json", value: report.json },
        { path: "report.md", value: report.markdown }
      ]
    }
  };
}
