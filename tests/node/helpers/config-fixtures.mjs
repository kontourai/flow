import { FLOW_SCHEMA_VERSION } from "../../../dist/index.js";

export function localConfigFixture() {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: {
      "quality.tests": {
        producers: ["ci/main"],
        authority_traces: ["github:main"]
      },
      "quality.browser-evidence": {
        producers: ["browser/main"]
      }
    },
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": {
            required: true,
            accepted_statuses: ["trusted"],
            trusted_producers: ["ci/main"]
          }
        }
      }
    }
  };
}

export function proposedConfigFixture() {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: {
      "quality.tests": {
        producers: ["ci/kit"],
        authority_traces: ["github:kit"]
      },
      "quality.browser-evidence": {
        producers: ["browser/main"]
      },
      "quality.lint": {
        producers: ["lint/kit"]
      }
    },
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": {
            required: false,
            accepted_statuses: ["trusted", "verified"],
            trusted_producers: ["ci/kit"]
          },
          "lint-passed": {
            required: true,
            accepted_statuses: ["trusted"]
          }
        }
      }
    }
  };
}

export function resourceConfigFixture(config = localConfigFixture()) {
  return {
    apiVersion: "flow.kontourai.io/v1alpha1",
    kind: "FlowProjectConfig",
    metadata: {
      name: "resource-project-config",
      labels: { example: "resource-contract" },
      annotations: { description: "Resource-shaped Flow Project Config example" }
    },
    spec: config
  };
}
