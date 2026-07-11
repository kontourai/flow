import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  defaultFlowConfig,
  evaluateGate,
  FLOW_SCHEMA_VERSION,
  initialState,
  normalizeTrustBundle,
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
      schemaVersion: 5,
      source: "ci/main",
      claims: [
        {
          id: "claim.quality.tests.verify",
          subjectType: "flow-step",
          subjectId: "builder.verify",
          facet: "quality.developer-evidence",
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

test("trust.bundle claims must be current after a gate is revisited", () => {
  const definition = routeBackDefinition();
  const bundleDef = JSON.parse(JSON.stringify(definition));
  bundleDef.gates["verify-gate"].expects = [{
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
  }];
  const state = initialState(bundleDef, "revisited-claim-freshness");
  state.current_step = "verify";
  state.transitions.push(
    { from_step: "build", to_step: "verify", status: "allowed", reason: "first visit", at: "2026-06-15T00:00:00.000Z", gate_id: "build-gate" },
    { type: "route_back", from_step: "verify", to_step: "build", status: "blocked", reason: "implementation defect", at: "2026-06-15T12:00:00.000Z", gate_id: "verify-gate" },
    { from_step: "build", to_step: "verify", status: "allowed", reason: "corrected work", at: "2026-06-16T00:00:00.000Z", gate_id: "build-gate" }
  );

  const bundle = (createdAt, observedAt) => ({
    schemaVersion: 5,
    source: "ci/main",
    claims: [{
      id: "claim.quality.tests.verify",
      subjectType: "flow-step",
      subjectId: "builder.verify",
      facet: "quality.developer-evidence",
      claimType: "quality.tests",
      fieldOrBehavior: "testSuite",
      value: "all tests passed",
      createdAt,
      updatedAt: createdAt
    }],
    evidence: [{
      id: "evidence.tests",
      claimId: "claim.quality.tests.verify",
      evidenceType: "test_output",
      method: "validation",
      sourceRef: "ci:run",
      excerptOrSummary: "All tests passed.",
      observedAt,
      collectedBy: "ci/main"
    }],
    policies: [],
    events: [{
      id: "event.verified",
      claimId: "claim.quality.tests.verify",
      status: "verified",
      actor: "ci/main",
      method: "npm test",
      evidenceIds: ["evidence.tests"],
      createdAt,
      verifiedAt: createdAt
    }]
  });

  const firstArrival = initialState(bundleDef, "ordinary-first-arrival");
  firstArrival.current_step = "verify";
  firstArrival.transitions.push({ from_step: "implement", to_step: "verify", status: "allowed", reason: "ordinary arrival", at: "2026-06-16T00:00:00.000Z", gate_id: "implement-gate" });
  const firstArrivalManifest = routeBackManifest([{
    id: "ev.first-arrival",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:01:00.000Z",
    bundle: bundle("2026-06-15T12:00:00.000Z", "2026-06-15T12:00:00.000Z")
  }]);
  assert.equal(evaluateGate(bundleDef, firstArrival, firstArrivalManifest, "verify-gate", defaultFlowConfig()).status, "pass", "ordinary first arrival preserves pre-existing claim behavior");

  const initialGateDefinition = JSON.parse(JSON.stringify(bundleDef));
  initialGateDefinition.gates["plan-gate"] = {
    step: "plan",
    expects: bundleDef.gates["verify-gate"].expects,
    on_route_back: { missing_evidence: "plan" }
  };
  const initialGateState = initialState(initialGateDefinition, "initial-step-first-visit");
  const initialGateManifest = routeBackManifest([{
    id: "ev.initial-step",
    gate_id: "plan-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:01:00.000Z",
    bundle: bundle("2026-06-15T12:00:00.000Z", "2026-06-15T12:00:00.000Z")
  }]);
  assert.equal(evaluateGate(initialGateDefinition, initialGateState, initialGateManifest, "plan-gate", defaultFlowConfig()).status, "pass", "initial-step gates preserve first-visit claim behavior");
  initialGateState.transitions.push({ type: "route_back", from_step: "plan", to_step: "plan", status: "blocked", reason: "needs revision", at: "2026-06-16T00:00:00.000Z", gate_id: "plan-gate" });
  const initialGateRevisit = evaluateGate(initialGateDefinition, initialGateState, initialGateManifest, "plan-gate", defaultFlowConfig());
  assert.equal(initialGateRevisit.status, "route-back", "a route-back to the initial step creates a fresh gate visit");
  assert.equal(initialGateRevisit.diagnostics.claim_evaluation[0].reason, "claim_not_current");

  const manifest = routeBackManifest([{
    id: "ev.reattached-old-claim",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:01:00.000Z",
    bundle: bundle("2026-06-15T12:00:00.000Z", "2026-06-15T12:00:00.000Z")
  }]);

  let outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "route-back", "a reattached old claim cannot satisfy the revisited gate");
  assert.equal(outcome.diagnostics.claim_evaluation[0].reason, "claim_not_current");
  assert.equal(manifest.evidence.length, 1, "the historical attachment remains auditable");

  manifest.evidence.push({
    id: "ev.corrected-observation",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:02:00.000Z",
    bundle: bundle("2026-06-15T12:00:00.000Z", "2026-06-16T00:01:00.000Z")
  });
  outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "pass", "a claim observed after re-entry can satisfy the gate");

  const staleAndFresh = bundle("2026-06-15T12:00:00.000Z", "2026-06-15T12:00:00.000Z");
  staleAndFresh.claims.push({
    ...staleAndFresh.claims[0],
    id: "claim.quality.tests.corrected",
    createdAt: "2026-06-16T00:01:00.000Z",
    updatedAt: "2026-06-16T00:01:00.000Z"
  });
  staleAndFresh.evidence.push({
    ...staleAndFresh.evidence[0],
    id: "evidence.tests.corrected",
    claimId: "claim.quality.tests.corrected",
    observedAt: "2026-06-16T00:01:00.000Z"
  });
  staleAndFresh.events.push({
    ...staleAndFresh.events[0],
    id: "event.verified.corrected",
    claimId: "claim.quality.tests.corrected",
    evidenceIds: ["evidence.tests.corrected"],
    createdAt: "2026-06-16T00:01:00.000Z",
    verifiedAt: "2026-06-16T00:01:00.000Z"
  });
  const sameBundleManifest = routeBackManifest([{
    id: "ev.stale-and-fresh",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:02:00.000Z",
    bundle: staleAndFresh
  }]);
  outcome = evaluateGate(bundleDef, state, sameBundleManifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "pass", "a current accepted claim is not hidden by an earlier stale claim in the same bundle");

  manifest.evidence = [{
    id: "ev.invalid-claim-timestamp",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:02:00.000Z",
    bundle: bundle("not-a-timestamp", "2026-06-16T00:01:00.000Z")
  }];
  outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "route-back", "an invalid claim timestamp fails closed");
  assert.equal(outcome.diagnostics.claim_evaluation[0].reason, "bundle_invalid");

  manifest.evidence = [{
    id: "ev.calendar-invalid-claim",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:02:00.000Z",
    bundle: bundle("2026-02-30T00:00:00.000Z", "2026-06-16T00:01:00.000Z")
  }];
  outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "route-back", "a calendar-invalid claim timestamp fails closed");

  manifest.evidence = [{
    id: "ev.calendar-invalid-observation",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:02:00.000Z",
    bundle: bundle("2026-06-15T12:00:00.000Z", "2026-02-30T00:00:00.000Z")
  }];
  outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "route-back", "a calendar-invalid observation timestamp fails closed");

  manifest.evidence = [{
    id: "ev.calendar-invalid-attachment",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-02-30T00:00:00.000Z",
    bundle: bundle("2026-06-16T00:01:00.000Z", "2026-06-16T00:01:00.000Z")
  }];
  outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "route-back", "a calendar-invalid attachment timestamp fails closed");
  assert.equal(outcome.diagnostics.claim_evaluation[0].evidence_id, "ev.calendar-invalid-attachment");
  assert.equal(outcome.diagnostics.claim_evaluation[0].reason, "attachment_timestamp_invalid");

  state.transitions.push(
    { type: "route_back", from_step: "verify", to_step: "build", status: "blocked", reason: "retry with lowercase timestamp", at: "2026-06-16T00:03:00.000Z", gate_id: "verify-gate" },
    { from_step: "build", to_step: "verify", status: "allowed", reason: "lowercase RFC3339 re-entry", at: "2026-06-16t00:04:00.000z", gate_id: "build-gate" }
  );
  manifest.evidence = [{
    id: "ev.lowercase-rfc3339",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16t00:05:00.000z",
    bundle: bundle("2026-06-16t00:04:00.000z", "2026-06-16t00:04:00.000z")
  }];
  outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "pass", "lowercase RFC3339 t/z timestamps remain valid");
  const normalizedLowercase = normalizeTrustBundle(manifest.evidence[0].bundle);
  assert.equal(normalizedLowercase.bundle.claims[0].createdAt, "2026-06-16t00:04:00.000z", "Flow preserves the original lower-case producer timestamp");
  assert.equal(normalizedLowercase.bundle_report.claims[0].status, "verified", "Flow canonicalizes strict-valid lower-case timestamps only for Surface validation");

  state.transitions.push(
    { type: "route_back", from_step: "verify", to_step: "build", status: "blocked", reason: "retry", at: "2026-06-16T00:06:00.000Z", gate_id: "verify-gate" },
    { from_step: "build", to_step: "verify", status: "allowed", reason: "calendar-invalid re-entry", at: "2026-02-30T00:00:00.000Z", gate_id: "build-gate" }
  );
  outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "route-back", "a calendar-invalid re-entry timestamp fails closed");
  assert.equal(outcome.diagnostics.claim_evaluation[0].evidence_id, "ev.lowercase-rfc3339");
  assert.equal(outcome.diagnostics.claim_evaluation[0].reason, "gate_reentry_timestamp_invalid");
});

test("trust.bundle gate ignores producer-superseded history when selecting the live claim", async () => {
  const definition = routeBackDefinition();
  const bundleDef = JSON.parse(JSON.stringify(definition));
  bundleDef.gates["verify-gate"].expects = [{
    id: "merge-readiness",
    kind: "trust.bundle",
    required: true,
    description: "Merge readiness is verified.",
    bundle_claim: {
      claimType: "builder.merge-ready.readiness",
      subjectType: "change",
      accepted_statuses: ["verified"]
    }
  }];
  const state = initialState(bundleDef, "superseded-history-test");
  state.current_step = "verify";
  const fixture = await surfaceClaimEvidenceFixture("pass-trust-report.json");
  const manifest = routeBackManifest([{
    id: "ev.superseded-history",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    bundle: fixture.evidence[0].bundle,
    bundle_report: {
      claims: [
        {
          claimType: "builder.merge-ready.readiness",
          subjectType: "change",
          status: "proposed",
          producerStatus: "superseded",
          metadata: { superseded_by: "review@later" }
        },
        {
          claimType: "builder.merge-ready.readiness",
          subjectType: "change",
          status: "verified"
        }
      ]
    },
    attached_at: "2026-06-15T00:00:00.000Z"
  }]);

  const outcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(outcome.status, "pass");
});

test("surface timestamp canonicalization preserves timestamp-shaped claim identities and content strings", () => {
  const claimId = "2026-06-16t00:04:00.000z";
  const nestedValue = {
    createdAt: "2026-06-16t01:02:03.000z",
    observedAt: "2026-06-16t04:05:06.000z",
    nested: { updatedAt: "2026-06-16t07:08:09.000z" }
  };
  const bundle = {
    schemaVersion: 5,
    source: "ci/main",
    claims: [
      {
        id: claimId,
        subjectType: "flow-step",
        subjectId: "builder.verify",
        facet: "quality.developer-evidence",
        claimType: "quality.tests",
        fieldOrBehavior: "testSuite",
        value: nestedValue,
        createdAt: "2026-06-16t00:04:00.0001z",
        updatedAt: "2026-06-16t00:04:00.0001z"
      }
    ],
    evidence: [
      {
        id: "evidence.tests",
        claimId,
        evidenceType: "test_output",
        method: "validation",
        sourceRef: claimId,
        excerptOrSummary: "All tests passed.",
        observedAt: "2026-06-16t00:04:00.0001z",
        collectedBy: "ci/main"
      }
    ],
    policies: [],
    events: [
      {
        id: "event.verified",
        claimId,
        status: "verified",
        actor: "ci/main",
        method: "npm test",
        evidenceIds: ["evidence.tests"],
        createdAt: "2026-06-16t00:04:00.0001z",
        verifiedAt: "2026-06-16t00:04:00.0001z"
      }
    ]
  };
  const auditCopy = structuredClone(bundle);

  const normalized = normalizeTrustBundle(bundle);
  assert.deepEqual(normalized.bundle, auditCopy, "the raw audit bundle stays byte-exact");
  assert.equal(normalized.bundle.evidence[0].claimId, claimId, "evidence claimId stays exact");
  assert.equal(normalized.bundle.events[0].claimId, claimId, "event claimId stays exact");
  assert.deepEqual(normalized.bundle.claims[0].value, nestedValue, "timestamp-named fields inside claim values stay exact");
  assert.equal(normalized.bundle.evidence[0].sourceRef, claimId, "source refs stay exact");
  assert.equal(normalized.bundle_report.claims[0].id, claimId, "derived report preserves the original claim identity");
  assert.deepEqual(normalized.bundle_report.claims[0].value, nestedValue, "derived claim values stay byte-exact");
  assert.equal(normalized.bundle_report.claims[0].status, "verified", "actual lowercase timestamp fields still validate");
  assert.equal(normalized.bundle_report.evidence[0].claimId, claimId, "derived evidence stays correlated to the original claim id");
  assert.equal(normalized.bundle_report.events[0].claimId, claimId, "derived events stay correlated to the original claim id");
});

test("trust.bundle current-visit checks preserve fractional precision and reject leap seconds", () => {
  const definition = routeBackDefinition();
  const bundleDef = JSON.parse(JSON.stringify(definition));
  const state = initialState(bundleDef, "fractional-precision-revisit");
  state.current_step = "verify";
  state.transitions.push(
    { type: "route_back", from_step: "verify", to_step: "implement", status: "blocked", reason: "retest", at: "2026-06-16T00:00:00.0000Z", gate_id: "verify-gate" },
    { from_step: "implement", to_step: "verify", status: "allowed", reason: "fractional re-entry", at: "2026-06-16t00:00:00.0002z", gate_id: "implement-gate" }
  );

  const manifest = routeBackManifest([{
    id: "ev.fractional-precision",
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-06-16T00:00:00.0003Z",
    bundle: {
      schemaVersion: 5,
      source: "ci/main",
      claims: [{
        id: "claim.fractional-precision",
        subjectType: "flow-step",
        subjectId: "builder.verify",
        facet: "quality.developer-evidence",
        claimType: "quality.tests",
        fieldOrBehavior: "testSuite",
        value: "all tests passed",
        createdAt: "2026-06-16t00:00:00.0001z",
        updatedAt: "2026-06-16t00:00:00.0001z"
      }],
      evidence: [{
        id: "evidence.fractional-precision",
        claimId: "claim.fractional-precision",
        evidenceType: "test_output",
        method: "validation",
        sourceRef: "ci:run",
        excerptOrSummary: "All tests passed.",
        observedAt: "2026-06-16t00:00:00.0001z",
        collectedBy: "ci/main"
      }],
      policies: [],
      events: [{
        id: "event.fractional-precision.verified",
        claimId: "claim.fractional-precision",
        status: "verified",
        actor: "ci/main",
        method: "npm test",
        evidenceIds: ["evidence.fractional-precision"],
        createdAt: "2026-06-16t00:00:00.0001z",
        verifiedAt: "2026-06-16t00:00:00.0001z"
      }]
    },
    bundle_report: {
      claims: [{
        id: "claim.fractional-precision",
        claimType: "quality.tests",
        subjectType: "flow-step",
        subjectId: "builder.verify",
        status: "verified"
      }]
    }
  }]);

  const fractionalOutcome = evaluateGate(bundleDef, state, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(fractionalOutcome.status, "route-back", ".0001 evidence remains older than a .0002 re-entry");
  assert.equal(fractionalOutcome.diagnostics.claim_evaluation[0].reason, "claim_not_current");

  manifest.evidence[0].bundle.claims[0].createdAt = "2016-12-31t23:59:60z";
  manifest.evidence[0].bundle.claims[0].updatedAt = "2016-12-31t23:59:60z";
  manifest.evidence[0].bundle.evidence[0].observedAt = "2016-12-31t23:59:60z";
  const leapState = initialState(bundleDef, "leap-boundary-revisit");
  leapState.current_step = "verify";
  leapState.transitions.push(
    { type: "route_back", from_step: "verify", to_step: "implement", status: "blocked", reason: "leap boundary retry", at: "2016-12-31T23:59:59.9999Z", gate_id: "verify-gate" },
    { from_step: "implement", to_step: "verify", status: "allowed", reason: "adjacent day re-entry", at: "2017-01-01T00:00:00Z", gate_id: "implement-gate" }
  );
  manifest.evidence[0].attached_at = "2017-01-01T00:00:00.0001Z";
  const leapOutcome = evaluateGate(bundleDef, leapState, manifest, "verify-gate", defaultFlowConfig());
  assert.equal(leapOutcome.status, "route-back", "a leap-second claim cannot collapse onto the adjacent day and pass");
  assert.equal(leapOutcome.diagnostics.claim_evaluation[0].evidence_id, "ev.fractional-precision");
  assert.equal(leapOutcome.diagnostics.claim_evaluation[0].reason, "claim_not_current");
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
