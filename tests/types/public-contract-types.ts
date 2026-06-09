import type {
  FlowConfig,
  FlowDefinition,
  FlowDiagnostic,
  FlowEvidenceEntry,
  FlowExpectation,
  FlowGate,
  FlowRunState,
  FlowStep,
  ReleaseReadinessResult
} from "../../src/index.js";

const validStep: FlowStep = { id: "verify", next: "publish" };
const validTerminalStep: FlowStep = { id: "publish", next: null };

const validExpectation: FlowExpectation = {
  id: "review-claim",
  kind: "surface.claim",
  required: true,
  description: "Review claim is accepted.",
  explore_hint: "Attach this claim for review gates.",
  claim: {
    type: "review",
    subject: "change",
    accepted_statuses: ["accepted"]
  }
};

const validGate: FlowGate = {
  step: "verify",
  expects: [validExpectation],
  route_back_policy: {
    max_attempts: 2,
    on_exceeded: "block"
  }
};

const validDefinition: FlowDefinition = {
  id: "release-flow",
  version: "0.1",
  steps: [validStep, validTerminalStep],
  gates: {
    "verify-gate": validGate
  }
};

// @ts-expect-error FlowGate rejects stale gate-level requires.
const gateWithRequires: FlowGate = { step: "verify", requires: ["tests"] };

// @ts-expect-error FlowGate rejects unknown top-level authored fields.
const gateWithUnknownField: FlowGate = { step: "verify", unknown_gate_field: true };

// @ts-expect-error FlowGate identity is authored by the gates map key, not by an id field.
const gateWithId: FlowGate = { id: "verify-gate", step: "verify" };

// @ts-expect-error FlowDefinition rejects unknown top-level authored fields.
const definitionWithUnknownField: FlowDefinition = { id: "release-flow", version: "0.1", steps: [], gates: {}, owner: "team-a" };

// @ts-expect-error FlowExpectation rejects unknown top-level authored fields.
const expectationWithUnknownField: FlowExpectation = { id: "review-claim", kind: "surface.claim", required: true, description: "Review claim is accepted.", stale_requires: ["tests"] };

// @ts-expect-error FlowExpectation requires a claim for surface.claim expectations.
const expectationWithoutClaim: FlowExpectation = { id: "review-claim", kind: "surface.claim", required: true, description: "Review claim is accepted." };

// @ts-expect-error FlowExpectation claim.type is required.
const expectationWithoutClaimType: FlowExpectation = { id: "review-claim", kind: "surface.claim", required: true, description: "Review claim is accepted.", claim: {} };

// @ts-expect-error FlowExpectation claim rejects unknown authored claim fields.
const expectationWithUnknownClaimField: FlowExpectation = { id: "review-claim", kind: "surface.claim", required: true, description: "Review claim is accepted.", claim: { type: "review", project_detail: true } };

// @ts-expect-error FlowGate route_back_policy rejects unknown authored policy fields.
const gateWithUnknownRoutePolicyField: FlowGate = { step: "verify", route_back_policy: { max_attempts: 2, project_route_detail: true } };

// @ts-expect-error FlowStep rejects unknown top-level authored fields.
const stepWithUnknownField: FlowStep = { id: "verify", label: "Verify" };

// @ts-expect-error FlowStep next is required.
const stepWithoutNext: FlowStep = { id: "verify" };

const evidenceEntryWithOpenClaim: FlowEvidenceEntry = {
  id: "evidence-1",
  kind: "surface.claim",
  claim: {
    type: "review",
    custom_status: "accepted",
    project_payload: { sha: "abc123" }
  },
  project_evidence_detail: "kept-open"
};

const diagnosticWithOpenRelated: FlowDiagnostic = {
  code: "flow.test",
  severity: "info",
  path: "$.gates.verify",
  message: "diagnostic",
  related: {
    gate_id: "verify-gate",
    project_context: { source: "fixture" }
  },
  project_diagnostic_detail: true
};

const releaseResultWithOpenReportData: ReleaseReadinessResult = {
  schema_version: "0.1",
  policy_id: "release",
  decision: "pass",
  risk_class: "standard",
  subject: "change-1",
  required_lanes: ["review"],
  lanes: [],
  evidence: [evidenceEntryWithOpenClaim],
  report_data: {
    project_summary: "ready",
    nested: { lane_count: 1 }
  },
  project_release_detail: "kept-open"
};

const runStateWithOpenRuntimeMaps: FlowRunState = {
  run_id: "run-1",
  definition_id: validDefinition.id,
  definition_version: validDefinition.version,
  subject: "change-1",
  status: "active",
  current_step: "verify",
  params: {
    project_param: "value"
  },
  gate_outcomes: [],
  transitions: [{ project_transition_detail: "value" }],
  exceptions: [{ project_exception_detail: "value" }],
  next_action: "evaluate",
  updated_at: "2026-06-09T00:00:00Z",
  project_state_detail: "kept-open"
};

const configWithOpenTrustMaps: FlowConfig = {
  schema_version: "0.1",
  trusted_producers: {
    "review-bot": {
      trust_level: "trusted",
      project_trust_detail: { team: "platform" }
    }
  },
  gate_overrides: {
    "verify-gate": {
      project_override_detail: "value"
    }
  },
  project_config_detail: "kept-open"
};

void [
  validDefinition,
  gateWithId,
  gateWithRequires,
  gateWithUnknownField,
  definitionWithUnknownField,
  expectationWithUnknownField,
  expectationWithoutClaim,
  expectationWithoutClaimType,
  expectationWithUnknownClaimField,
  gateWithUnknownRoutePolicyField,
  stepWithUnknownField,
  stepWithoutNext,
  diagnosticWithOpenRelated,
  releaseResultWithOpenReportData,
  runStateWithOpenRuntimeMaps,
  configWithOpenTrustMaps
];
