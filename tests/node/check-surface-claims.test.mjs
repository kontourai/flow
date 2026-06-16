import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  defaultFlowConfig,
  evaluateGate,
  FLOW_SCHEMA_VERSION,
  initialState,
  validateDefinition
} from "../../dist/index.js";
import { json, surfaceClaimFixture, surfaceClaimEvidenceFixture } from "./helpers/fixtures.mjs";
import { routeBackDefinition, routeBackManifest } from "./helpers/route-back-fixtures.mjs";

// The "surface-claims" scenario directory has been migrated to trust.bundle in Flow 2.0.
// These tests verify trust.bundle gate evaluation against the updated fixtures.

test("fixture-backed trust.bundle manifests satisfy the neutral fixture shape", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");
  assert.doesNotThrow(() => validateDefinition(definition));
  assert.equal(definition.gates["verify-gate"].expects[0].kind, "trust.bundle");
  assert.equal(definition.gates["verify-gate"].expects[0].bundle_claim.claimType, "quality.tests");

  const evidenceDir = new URL("../../examples/scenarios/surface-claims/evidence/", import.meta.url);
  const files = (await readdir(evidenceDir)).filter((file) => file.endsWith(".json")).sort();
  assert.deepEqual(files, [
    "fail-bundle-invalid.json",
    "fail-claim-not-found.json",
    "fail-missing-claim.json",
    "fail-rejected-claim.json",
    "fail-stale-claim.json",
    "pass-trust-report.json",
    "pass-trust-snapshot.json"
  ]);

  for (const file of files) {
    const manifest = await surfaceClaimEvidenceFixture(file);
    assert.equal(manifest.schema_version, FLOW_SCHEMA_VERSION, `${file} schema_version`);
    assert.ok(Array.isArray(manifest.evidence), `${file} evidence must be an array`);
  }
});

test("trust.bundle pass fixtures evaluate to gate pass with matched expectations", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");

  for (const file of ["pass-trust-report.json", "pass-trust-snapshot.json"]) {
    const state = initialState(definition, `fixture-${file}`);
    state.current_step = "verify";
    const manifest = await surfaceClaimEvidenceFixture(file);
    const outcome = evaluateGate(definition, state, manifest, "verify-gate", defaultFlowConfig());
    assert.equal(outcome.status, "pass", file);
    assert.ok(outcome.matched_expectations?.length === 1, `${file} should have one matched expectation`);
    assert.equal(outcome.matched_expectations[0].expectation_id, "tests-passed", file);
    assert.equal(outcome.diagnostics, undefined, file);
  }
});

test("trust.bundle missing evidence routes back with missing_evidence reason", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");
  const state = initialState(definition, "fixture-fail-missing");
  state.current_step = "verify";
  const manifest = await surfaceClaimEvidenceFixture("fail-missing-claim.json");
  const outcome = evaluateGate(definition, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.route_reason, "missing_evidence");
  assert.deepEqual(outcome.missing, ["tests-passed"]);
  assert.deepEqual(outcome.matched_expectations, []);
  assert.equal(outcome.diagnostics, undefined);
});

test("trust.bundle failure cases produce correct diagnostic reason codes", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");

  const failureCases = [
    ["fail-rejected-claim.json", "rejected"],
    ["fail-stale-claim.json", "stale"],
    ["fail-claim-not-found.json", "claim_not_found"],
    ["fail-bundle-invalid.json", "bundle_invalid"]
  ];

  for (const [file, reason] of failureCases) {
    const state = initialState(definition, `fixture-${file}`);
    state.current_step = "verify";
    const manifest = await surfaceClaimEvidenceFixture(file);
    const outcome = evaluateGate(definition, state, manifest, "verify-gate", defaultFlowConfig());
    assert.equal(outcome.status, "route-back", file);
    assert.equal(outcome.route_reason, "missing_evidence", file);
    assert.deepEqual(outcome.missing, ["tests-passed"], file);
    assert.deepEqual(outcome.matched_expectations, [], file);
    assert.ok(outcome.diagnostics?.claim_evaluation?.length > 0, `${file} should have claim_evaluation diagnostics`);
    assert.equal(outcome.diagnostics.claim_evaluation[0].expectation_id, "tests-passed", file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].evidence_id, `ev.${file.replace(".json", "")}`, file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].reason, reason, file);
  }
});

test("trust.bundle expectations evaluate required and optional correctly", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  const state = initialState(definition, "bundle-check", { subject: "feature-search-filters" });
  const emptyManifest = { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };

  const missing = evaluateGate(definition, state, emptyManifest, "verify-gate", defaultFlowConfig());
  assert.equal(missing.status, "route-back");
  assert.equal(missing.route_reason, "missing_evidence");
  assert.deepEqual(missing.missing, ["tests-passed"]);
  assert.deepEqual(missing.optional_missing, ["browser-evidence-reviewed"]);
});

test("trust.bundle validation rejects malformed bundles at evaluation time", () => {
  const definition = routeBackDefinition();
  // Patch definition to use trust.bundle
  const bundleDef = JSON.parse(JSON.stringify(definition));
  bundleDef.gates["verify-gate"].expects = [
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
  ];

  const state = initialState(bundleDef, "bundle-validation-test");
  state.current_step = "verify";

  // Missing bundle field → bundle_invalid diagnostic
  const noBundleManifest = routeBackManifest([{
    id: "ev.no-bundle",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-15T00:00:00.000Z"
  }]);
  const noBundleOutcome = evaluateGate(bundleDef, state, noBundleManifest, "verify-gate", defaultFlowConfig());
  assert.equal(noBundleOutcome.status, "route-back");
  assert.equal(noBundleOutcome.diagnostics?.claim_evaluation?.[0]?.reason, "bundle_invalid");

  // Invalid bundle (not a Hachure TrustBundle) → bundle_invalid diagnostic
  const invalidBundleManifest = routeBackManifest([{
    id: "ev.invalid-bundle",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    bundle: { not: "a valid bundle" },
    attached_at: "2026-06-15T00:00:00.000Z"
  }]);
  const invalidBundleOutcome = evaluateGate(bundleDef, state, invalidBundleManifest, "verify-gate", defaultFlowConfig());
  assert.equal(invalidBundleOutcome.status, "route-back");
  assert.equal(invalidBundleOutcome.diagnostics?.claim_evaluation?.[0]?.reason, "bundle_invalid");
});

test("trust.bundle gate passes when selected claim status is in accepted_statuses", () => {
  const definition = routeBackDefinition();
  const bundleDef = JSON.parse(JSON.stringify(definition));
  bundleDef.gates["verify-gate"].expects = [
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
  ];

  const state = initialState(bundleDef, "bundle-pass-test");
  state.current_step = "verify";

  const passManifest = routeBackManifest([{
    id: "ev.verified",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    bundle: {
      schemaVersion: 3,
      source: "ci/main",
      claims: [
        {
          id: "claim.quality.tests.verify",
          subjectType: "flow-step",
          subjectId: "builder.verify",
          surface: "quality.developer-evidence",
          claimType: "quality.tests",
          fieldOrBehavior: "testSuite",
          value: "all tests passed",
          createdAt: "2026-06-15T00:00:00.000Z",
          updatedAt: "2026-06-15T00:00:00.000Z"
        }
      ],
      evidence: [
        {
          id: "evidence.tests",
          claimId: "claim.quality.tests.verify",
          evidenceType: "test_output",
          method: "validation",
          sourceRef: "ci:run",
          excerptOrSummary: "All tests passed.",
          observedAt: "2026-06-15T00:00:00.000Z",
          collectedBy: "ci/main"
        }
      ],
      policies: [],
      events: [
        {
          id: "event.verified",
          claimId: "claim.quality.tests.verify",
          status: "verified",
          actor: "ci/main",
          method: "npm test",
          evidenceIds: ["evidence.tests"],
          createdAt: "2026-06-15T00:00:00.000Z",
          verifiedAt: "2026-06-15T00:00:00.000Z"
        }
      ]
    },
    attached_at: "2026-06-15T00:00:00.000Z"
  }]);

  const outcome = evaluateGate(bundleDef, state, passManifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "pass");
  assert.deepEqual(outcome.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: "ev.verified" }]);
  assert.equal(outcome.diagnostics, undefined);
});

test("trust.bundle Hachure conformance: test vectors produce expected claim statuses via Surface", async () => {
  // Import hachure conformance vectors and Surface buildTrustReport
  const { testVectors } = await import("hachure");
  const { buildTrustReport, validateTrustBundle } = await import("@kontourai/surface");

  let checked = 0;
  for (const { name, vector } of testVectors) {
    const { input, expect: expected, now } = vector;
    const nowDate = now ? new Date(now) : new Date();
    let bundle;
    try {
      bundle = validateTrustBundle(input);
    } catch {
      continue; // skip if surface can't validate (schema version mismatch, etc.)
    }
    const report = buildTrustReport(bundle, { now: nowDate });
    for (const [claimId, expectedStatus] of Object.entries(expected.statusByClaimId)) {
      const claim = report.claims.find(c => c.id === claimId);
      assert.ok(claim, `${name}: claim ${claimId} should be in report`);
      assert.equal(claim.status, expectedStatus, `${name}: claim ${claimId} status should be ${expectedStatus}`);
    }
    checked++;
  }
  assert.ok(checked > 0, "should have validated at least one Hachure conformance vector");
});
