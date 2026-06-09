import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  defaultFlowConfig,
  evaluateGate,
  FLOW_SCHEMA_VERSION,
  initialState,
  normalizeTrustArtifact,
  renderMarkdownReport,
  reportJson,
  validateDefinition
} from "../../dist/index.js";
import { assertSurfaceClaimManifestShape } from "./helpers/assertions.mjs";
import { json, surfaceClaimEvidenceFixture, surfaceClaimFixture } from "./helpers/fixtures.mjs";
import { routeBackDefinition, routeBackManifest } from "./helpers/route-back-fixtures.mjs";

test("neutral Surface trust artifacts normalize through Surface contract fields", () => {
  const normalized = normalizeTrustArtifact({
    schema_version: "0.1",
    artifact_type: "trust-report",
    subject: "builder.verify",
    producer: "ci/main",
    status: "trusted",
    issued_at: "2026-05-26T00:00:00.000Z",
    authority_traces: ["github:main"],
    claims: [{ type: "quality.tests", status: "trusted" }]
  }, "abc123", new Date("2026-05-26T00:00:00.000Z"));

  assert.equal(normalized.claim.type, "quality.tests");
  assert.equal(normalized.claim.subject, "builder.verify");
  assert.equal(normalized.claim.status, "trusted");
  assert.equal(normalized.producer, "ci/main");
  assert.deepEqual(normalized.authority_traces, ["github:main"]);
  assert.equal(normalized.trust_artifact.artifact_type, "trust-report");

  const stale = normalizeTrustArtifact({
    artifact_type: "trust-snapshot",
    expires_at: "2026-05-25T00:00:00.000Z",
    claims: [{ type: "quality.tests", subject: "builder.verify", status: "trusted" }]
  }, "abc123", new Date("2026-05-26T00:00:00.000Z"));
  assert.equal(stale.claim.status, "stale");

  const mismatch = normalizeTrustArtifact({
    artifact_type: "trust-report",
    integrity: { sha256: "expected" },
    claims: [{ type: "quality.tests", subject: "builder.verify", status: "trusted" }]
  }, "actual", new Date("2026-05-26T00:00:00.000Z"));
  assert.equal(mismatch.claim.status, "integrity_mismatch");
  assert.equal(mismatch.diagnostics.trust_artifact.reason, "integrity_mismatch");

  assert.throws(() => normalizeTrustArtifact({ artifact_type: "trust-report", claims: [{}] }, "abc123"), /claim.type/);
});

test("fixture-backed Surface claim manifests satisfy the neutral fixture shape", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");
  assert.doesNotThrow(() => validateDefinition(definition));
  assert.equal(definition.gates["verify-gate"].expects[0].kind, "surface.claim");

  const config = await surfaceClaimFixture("flow-config.json");
  assert.equal(config.schema_version, FLOW_SCHEMA_VERSION);
  assert.deepEqual(config.trusted_producers["quality.tests"].producers, ["surface-fixture/ci"]);
  assert.deepEqual(config.trusted_producers["quality.tests"].authority_traces, ["project-policy:main"]);

  const evidenceDir = new URL("../../examples/scenarios/surface-claims/evidence/", import.meta.url);
  const files = (await readdir(evidenceDir)).filter((file) => file.endsWith(".json")).sort();
  assert.deepEqual(files, [
    "fail-authority-gap.json",
    "fail-integrity-mismatch.json",
    "fail-missing-claim.json",
    "fail-rejected-claim.json",
    "fail-stale-claim.json",
    "fail-subject-mismatch.json",
    "fail-untrusted-producer.json",
    "pass-trust-report.json",
    "pass-trust-snapshot.json"
  ]);

  for (const file of files) {
    assertSurfaceClaimManifestShape(await surfaceClaimEvidenceFixture(file), file);
  }
});

test("fixture-backed Surface claim matching covers pass and diagnostic route-back cases", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");
  const config = await surfaceClaimFixture("flow-config.json");

  const passFiles = ["pass-trust-report.json", "pass-trust-snapshot.json"];
  for (const file of passFiles) {
    const state = initialState(definition, `fixture-${file}`);
    state.current_step = "verify";
    const outcome = evaluateGate(definition, state, await surfaceClaimEvidenceFixture(file), "verify-gate", config);
    assert.equal(outcome.status, "pass", file);
    assert.deepEqual(outcome.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: `ev.${file.replace(".json", "")}` }], file);
    assert.equal(outcome.diagnostics, undefined, file);
  }

  const missingState = initialState(definition, "fixture-fail-missing-claim");
  missingState.current_step = "verify";
  const missing = evaluateGate(definition, missingState, await surfaceClaimEvidenceFixture("fail-missing-claim.json"), "verify-gate", config);
  assert.equal(missing.status, "route-back");
  assert.equal(missing.route_reason, "missing_evidence");
  assert.deepEqual(missing.missing, ["tests-passed"]);
  assert.deepEqual(missing.matched_expectations, []);
  assert.equal(missing.diagnostics, undefined);

  const failureCases = [
    ["fail-stale-claim.json", "stale", config],
    ["fail-rejected-claim.json", "rejected", config],
    ["fail-untrusted-producer.json", "untrusted_producer", config],
    ["fail-subject-mismatch.json", "subject_mismatch", config],
    ["fail-integrity-mismatch.json", "integrity_mismatch", config],
    ["fail-authority-gap.json", "authority_gap", {
      ...config,
      trusted_producers: {
        "quality.tests": {
          authority_traces: ["project-policy:main"]
        }
      }
    }]
  ];

  for (const [file, reason, caseConfig] of failureCases) {
    const state = initialState(definition, `fixture-${file}`);
    state.current_step = "verify";
    const outcome = evaluateGate(definition, state, await surfaceClaimEvidenceFixture(file), "verify-gate", caseConfig);
    assert.equal(outcome.status, "route-back", file);
    assert.equal(outcome.route_reason, "missing_evidence", file);
    assert.deepEqual(outcome.missing, ["tests-passed"], file);
    assert.deepEqual(outcome.matched_expectations, [], file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].expectation_id, "tests-passed", file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].evidence_id, `ev.${file.replace(".json", "")}`, file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].reason, reason, file);
  }
});

test("surface claim expectations evaluate required, optional, trusted producer, and overrides", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  const state = initialState(definition, "claim-check", { subject: "feature-search-filters" });
  const emptyManifest = { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };
  const trustedConfig = {
    ...defaultFlowConfig(),
    trusted_producers: {
      "quality.tests": { producers: ["ci/main"] },
      "quality.browser-evidence": { producers: ["browser/check"] }
    }
  };

  const missing = evaluateGate(definition, state, emptyManifest, "verify-gate", trustedConfig);
  assert.equal(missing.status, "route-back");
  assert.equal(missing.route_reason, "missing_evidence");
  assert.deepEqual(missing.missing, ["tests-passed"]);
  assert.deepEqual(missing.optional_missing, ["browser-evidence-reviewed"]);

  const untrusted = evaluateGate(definition, state, {
    schema_version: FLOW_SCHEMA_VERSION,
    evidence: [{
      id: "ev.untrusted",
      gate_id: "verify-gate",
      kind: "surface.claim",
      requested_kind: "surface.claim",
      status: "passed",
      claim: { type: "quality.tests", subject: "builder.verify", status: "trusted" },
      producer: "ci/fork",
      attached_at: "2026-05-26T00:00:00.000Z"
    }]
  }, "verify-gate", trustedConfig);
  assert.equal(untrusted.status, "route-back");
  assert.equal(untrusted.route_reason, "missing_evidence");
  assert.equal(untrusted.diagnostics.claim_evaluation[0].reason, "untrusted_producer");

  const accepted = evaluateGate(definition, state, {
    schema_version: FLOW_SCHEMA_VERSION,
    evidence: [{
      id: "ev.trusted",
      gate_id: "verify-gate",
      kind: "surface.claim",
      requested_kind: "surface.claim",
      status: "passed",
      claim: { type: "quality.tests", subject: "builder.verify", status: "trusted" },
      producer: "ci/main",
      attached_at: "2026-05-26T00:00:00.000Z"
    }]
  }, "verify-gate", trustedConfig);
  assert.equal(accepted.status, "pass");
  assert.deepEqual(accepted.optional_missing, ["browser-evidence-reviewed"]);

  const overrideConfig = {
    ...trustedConfig,
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": { required: false }
        }
      }
    }
  };
  const optionalOnly = evaluateGate(definition, state, emptyManifest, "verify-gate", overrideConfig);
  assert.equal(optionalOnly.status, "pass");
  assert.deepEqual(optionalOnly.optional_missing, ["tests-passed", "browser-evidence-reviewed"]);
});

test("trust artifact claim diagnostics cover stale rejected subject integrity and authority gaps", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "trust-diagnostics");
  state.current_step = "verify";
  const base = {
    gate_id: "verify-gate",
    kind: "surface.claim",
    requested_kind: "surface.claim",
    status: "passed",
    attached_at: "2026-05-26T00:00:00.000Z"
  };
  const cases = [
    ["stale", { claim: { type: "quality.tests", subject: "builder.verify", status: "stale" } }, {}, "stale"],
    ["rejected", { claim: { type: "quality.tests", subject: "builder.verify", status: "rejected" } }, {}, "rejected"],
    ["subject", { claim: { type: "quality.tests", subject: "wrong.subject", status: "trusted" } }, {}, "subject_mismatch"],
    ["integrity", {
      claim: { type: "quality.tests", subject: "builder.verify", status: "integrity_mismatch" },
      trust_artifact: { integrity: { verified: false } }
    }, {}, "integrity_mismatch"],
    ["authority", {
      claim: { type: "quality.tests", subject: "builder.verify", status: "trusted" },
      producer: "ci/main"
    }, {
      ...defaultFlowConfig(),
      trusted_producers: { "quality.tests": { authority_traces: ["github:main"] } }
    }, "authority_gap"]
  ];

  for (const [id, entry, config, reason] of cases) {
    const outcome = evaluateGate(definition, state, routeBackManifest([{ id: `ev.${id}`, ...base, ...entry }]), "verify-gate", config);
    assert.equal(outcome.status, "route-back");
    assert.equal(outcome.missing[0], "tests-passed");
    assert.equal(outcome.diagnostics.claim_evaluation[0].reason, reason);
    const report = reportJson(definition, { ...state, gate_outcomes: [outcome] }, routeBackManifest([{ id: `ev.${id}`, ...base, ...entry }]));
    assert.equal(report.gate_summaries[0].diagnostics.claim_evaluation[0].reason, reason);
    assert.match(renderMarkdownReport(definition, { ...state, gate_outcomes: [outcome] }, routeBackManifest([{ id: `ev.${id}`, ...base, ...entry }])), new RegExp(reason));
  }
});
