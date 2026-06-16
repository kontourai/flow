import { FLOW_SCHEMA_VERSION } from "../../../dist/index.js";

export function routeBackDefinition(overrides = {}) {
  return {
    id: "route-back-fixture",
    version: "2",
    steps: [
      { id: "plan", "next": "implement" },
      { id: "implement", "next": "verify" },
      { id: "verify", "next": "recover" },
      { id: "recover", "next": null }
    ],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [
          {
            id: "tests-passed",
            kind: "trust.bundle",
            required: true,
            description: "Tests passed.",
            bundle_claim: {
              claimType: "quality.tests",
              subjectType: "flow-step",
              subjectId: "builder.verify",
              accepted_statuses: ["verified"]
            }
          }
        ],
        on_route_back: {
          missing_evidence: "verify",
          implementation_defect: "implement",
          plan_gap: "plan",
          decision_gap: "plan",
          custom_vendor_reason: "recover",
          default: "implement"
        },
        route_back_policy: {
          max_attempts: 2,
          on_exceeded: "block"
        },
        ...overrides
      }
    }
  };
}

export function routeBackManifest(evidence) {
  return { schema_version: FLOW_SCHEMA_VERSION, evidence };
}

export function failedEvidence(fields = {}) {
  return {
    id: fields.id ?? "ev.failed",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "failed",
    attached_at: "2026-06-15T00:00:00.000Z",
    ...fields
  };
}
