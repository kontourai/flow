export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type MutableRecord = Record<string, any>;

export interface FlowStep extends MutableRecord {
  id: string;
  next?: string;
}

export interface FlowExpectation extends MutableRecord {
  id: string;
  kind: "surface.claim";
  required: boolean;
  description: string;
  claim?: {
    type?: string;
    subject?: string;
    accepted_statuses?: string[];
    [key: string]: any;
  };
}

export interface FlowGate extends MutableRecord {
  id?: string;
  step: string;
  requires?: never;
  expects?: FlowExpectation[];
  on_route_back?: Record<string, string>;
  route_back_policy?: {
    max_attempts?: number;
    on_exceeded?: "block" | string;
    route_reasons?: "closed" | string;
    reasons?: "closed" | string;
    closed_reasons?: boolean;
    closed_route_reasons?: boolean;
    allow_unknown_reasons?: boolean;
    [key: string]: any;
  };
}

export interface FlowDefinition extends MutableRecord {
  id: string;
  version: string;
  steps: FlowStep[];
  gates: Record<string, FlowGate>;
}

export interface FlowDiagnostic extends MutableRecord {
  code: string;
  severity: "error" | "warning" | "info" | string;
  path: string;
  message: string;
  related?: MutableRecord;
}

export interface FlowEvidenceEntry extends MutableRecord {
  id: string;
  gate_id?: string;
  kind: string;
  requested_kind?: string;
  status?: string;
  claim?: MutableRecord;
  producer?: string;
  authority_trace?: string;
  authority_traces?: string[];
  route_reason?: string;
  expectation_ids?: string[];
}

export interface FlowEvidenceManifest extends MutableRecord {
  schema_version?: string;
  run_id?: string;
  definition_id?: string;
  definition_version?: string;
  evidence: FlowEvidenceEntry[];
}

export interface FlowRunState extends MutableRecord {
  schema_version?: string;
  run_id: string;
  definition_id: string;
  definition_version: string;
  subject: string;
  status: string;
  current_step: string;
  params?: MutableRecord;
  gate_outcomes: GateOutcome[];
  transitions: MutableRecord[];
  exceptions: MutableRecord[];
  next_action: string;
  updated_at: string;
}

export interface FlowConfig extends MutableRecord {
  schema_version: string;
  trusted_producers: Record<string, MutableRecord>;
  gate_overrides: Record<string, MutableRecord>;
}

export interface GateOutcome extends MutableRecord {
  gate_id: string;
  status: "pass" | "block" | "route-back" | "wait" | string;
  summary: string;
  evidence_refs?: string[];
  missing?: string[];
  optional_missing?: string[];
  matched_expectations?: Array<{ expectation_id: string; evidence_id: string }>;
}

export type ReleaseReadinessDecision = "pass" | "hold";
export type ReleaseLaneStatus = "pass" | "hold" | "not_required" | "not_verified";

export interface ReleaseLanePolicy extends MutableRecord {
  id: string;
  description: string;
  claim: {
    type: string;
    subject?: string;
    accepted_statuses?: string[];
    [key: string]: any;
  };
  adapter_ids?: string[];
}

export interface ReleaseReadinessPolicy extends MutableRecord {
  schema_version: string;
  id: string;
  lanes: ReleaseLanePolicy[];
  risk_classes: Record<string, { required_lanes: string[]; [key: string]: any }>;
}

export interface ReleaseReadinessContext extends MutableRecord {
  subject: string;
  gate_id?: string;
  attached_at?: string;
}

export interface ReleaseNativeRef extends MutableRecord {
  system: string;
  id: string;
  url?: string;
}

export interface ReleaseExternalLink extends MutableRecord {
  label: string;
  url: string;
}

export interface ReleaseLaneOutcome extends MutableRecord {
  lane_id: string;
  status: ReleaseLaneStatus;
  summary: string;
  required: boolean;
  evidence_refs: string[];
  external_links: ReleaseExternalLink[];
  native_refs: ReleaseNativeRef[];
}

export interface ReleaseReadinessResult extends MutableRecord {
  schema_version: string;
  policy_id: string;
  decision: ReleaseReadinessDecision;
  risk_class: string;
  subject: string;
  required_lanes: string[];
  lanes: ReleaseLaneOutcome[];
  evidence: FlowEvidenceEntry[];
  report_data: MutableRecord;
}

export type VersionReleaseReportDecision = "ready" | "hold";
export type VersionReleaseReportGapKind = "verification_evidence" | "release_lane";

export interface VersionReleaseReportGap extends MutableRecord {
  id: string;
  kind: VersionReleaseReportGapKind;
  summary: string;
}

export interface VersionReleaseReportInput extends MutableRecord {
  version: {
    id: string;
    name?: string;
    released_at?: string;
    [key: string]: any;
  };
  subject: string;
  changeset: MutableRecord[];
  verification_evidence: FlowEvidenceEntry[];
  release_readiness: ReleaseReadinessResult;
  required_verification_evidence?: string[];
  exceptions?: MutableRecord[];
  accepted_risks?: MutableRecord[];
  external_links?: ReleaseExternalLink[];
  native_refs?: ReleaseNativeRef[];
  summary?: string;
}

export interface VersionReleaseReport extends MutableRecord {
  schema_version: string;
  version: MutableRecord;
  subject: string;
  decision: VersionReleaseReportDecision;
  status: VersionReleaseReportDecision;
  summary: string;
  changeset: MutableRecord[];
  verification_evidence: FlowEvidenceEntry[];
  release_evidence: ReleaseReadinessResult;
  exceptions: MutableRecord[];
  accepted_risks: MutableRecord[];
  gaps: VersionReleaseReportGap[];
  external_links: ReleaseExternalLink[];
  native_refs: ReleaseNativeRef[];
  report_data: MutableRecord;
}

export interface TransitionValidationResult extends MutableRecord {
  valid: boolean;
  status: string;
  diagnostics: FlowDiagnostic[];
  transition: MutableRecord | null;
}

export interface ConfigMergeReport extends MutableRecord {
  schema_version: string;
  mode: string;
  status: string;
  local_config_path: string;
  proposal_path: string | null;
  proposed_changes: MutableRecord[];
  accepted_changes: MutableRecord[];
  rejected_changes: MutableRecord[];
  conflicts: MutableRecord[];
  unchanged: MutableRecord[];
  exceptions: MutableRecord[];
  merged_config: FlowConfig;
  summary: MutableRecord;
}

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
