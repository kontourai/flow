import type {
  FlowConfig,
  FlowConsoleProjection,
  FlowDefinition,
  FlowDiagnostic,
  FlowEvidenceEntry,
  FlowExpectation,
  FlowGate,
  FlowIngestRequest,
  FlowRunState,
  FlowStep,
  ReleaseReadinessResult
} from "../../src/index.js";

// FlowIngestRequest — the hosted-console ingest contract v1 envelope. console
// imports THIS to validate ingest bodies (dependency arrow console → flow).
const validIngestRequest: FlowIngestRequest = {
  contractVersion: "1",
  source: "flow",
  type: "flow.console.projection.0.1",
  idempotencyKey: "run-1:0",
  occurredAt: "2026-06-16T00:00:00.000Z",
  payload: {} as FlowConsoleProjection
};

// @ts-expect-error contractVersion is the literal "1".
const ingestBadVersion: FlowIngestRequest = { ...validIngestRequest, contractVersion: "2" };

// @ts-expect-error source is the literal "flow".
const ingestBadSource: FlowIngestRequest = { ...validIngestRequest, source: "surface" };

void [validIngestRequest, ingestBadVersion, ingestBadSource];

const validStep: FlowStep = { id: "verify", next: "publish" };
const validTerminalStep: FlowStep = { id: "publish", next: null };

const validExpectation: FlowExpectation = {
  id: "review-claim",
  kind: "trust.bundle",
  required: true,
  description: "Review claim is accepted.",
  explore_hint: "Attach this claim for review gates.",
  bundle_claim: {
    claimType: "review",
    subjectType: "flow-step",
    subjectId: "change",
    accepted_statuses: ["verified"]
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
const expectationWithUnknownField: FlowExpectation = { id: "review-claim", kind: "trust.bundle", required: true, description: "Review claim is accepted.", stale_requires: ["tests"] };

// @ts-expect-error FlowExpectation requires bundle_claim for trust.bundle expectations.
const expectationWithoutBundleClaim: FlowExpectation = { id: "review-claim", kind: "trust.bundle", required: true, description: "Review claim is accepted." };

// @ts-expect-error FlowExpectation bundle_claim.claimType is required.
const expectationWithoutClaimType: FlowExpectation = { id: "review-claim", kind: "trust.bundle", required: true, description: "Review claim is accepted.", bundle_claim: {} };

// @ts-expect-error FlowGate route_back_policy rejects unknown authored policy fields.
const gateWithUnknownRoutePolicyField: FlowGate = { step: "verify", route_back_policy: { max_attempts: 2, project_route_detail: true } };

// @ts-expect-error FlowStep rejects unknown top-level authored fields.
const stepWithUnknownField: FlowStep = { id: "verify", label: "Verify" };

// @ts-expect-error FlowStep next is required.
const stepWithoutNext: FlowStep = { id: "verify" };

const evidenceEntryWithOpenBundle: FlowEvidenceEntry = {
  id: "evidence-1",
  kind: "trust.bundle",
  bundle: {
    schemaVersion: 5,
    source: "ci/main",
    claims: [],
    evidence: [],
    policies: [],
    events: []
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
  evidence: [evidenceEntryWithOpenBundle],
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
  expectationWithoutBundleClaim,
  expectationWithoutClaimType,
  gateWithUnknownRoutePolicyField,
  stepWithUnknownField,
  stepWithoutNext,
  diagnosticWithOpenRelated,
  releaseResultWithOpenReportData,
  runStateWithOpenRuntimeMaps,
  configWithOpenTrustMaps
];
