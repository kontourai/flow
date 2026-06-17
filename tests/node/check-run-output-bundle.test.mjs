/**
 * Flow follow-up §2 — emit a run-output TrustBundle.
 *
 *  - claims = passed stages (members), evidence = by-reference pointers to the
 *    stage's gate-evidence bundles (NOT inlined), events = stage verifications.
 *  - the run-level "run verified" verdict is a SURFACE rollup (claimGroup,
 *    all-required), not Flow-computed.
 *  - the bundle validates against Hachure + Surface and round-trips as evidence
 *    into a second flow's gate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectRunOutputBundle,
  evaluateGate,
  initialState,
  defaultFlowConfig
} from "../../dist/index.js";
import { validateTrustBundle, buildTrustReport } from "@kontourai/surface";
import { validateTrustBundleSchema } from "../../dist/gates/trust-bundle-validator.js";

const NOW = new Date("2026-06-16T00:00:00.000Z");

// A two-stage flow: plan -> verify, both passed.
function passedRun() {
  const definition = {
    id: "child-flow",
    version: "1",
    steps: [
      { id: "plan", next: "verify" },
      { id: "verify", next: null, needs: ["plan"] }
    ],
    gates: {
      "plan-gate": { step: "plan", expects: [] },
      "verify-gate": { step: "verify", expects: [] }
    }
  };
  const state = initialState(definition, "child-run");
  state.status = "completed";
  state.current_step = null;
  state.gate_outcomes = [
    { gate_id: "plan-gate", status: "pass", summary: "passed", evidence_refs: [] },
    { gate_id: "verify-gate", status: "pass", summary: "passed", evidence_refs: [] }
  ];
  state.transitions = [
    { from_step: "plan", to_step: "verify", status: "allowed" },
    { from_step: "verify", to_step: null, status: "allowed" }
  ];

  // A leaf gate-evidence bundle attached to verify-gate, with a derived report.
  const leafBundle = {
    schemaVersion: 3,
    source: "ci/verify",
    claims: [
      {
        id: "claim.quality.tests",
        subjectType: "flow-step",
        subjectId: "child-flow:verify",
        surface: "quality",
        claimType: "quality.tests",
        fieldOrBehavior: "testsPass",
        value: true,
        createdAt: "2026-06-15T00:00:00.000Z",
        updatedAt: "2026-06-15T00:00:00.000Z"
      }
    ],
    evidence: [
      {
        id: "evidence.tests",
        claimId: "claim.quality.tests",
        evidenceType: "test_output",
        method: "validation",
        sourceRef: "ci:1",
        excerptOrSummary: "tests passed",
        observedAt: "2026-06-15T00:00:00.000Z",
        collectedBy: "ci"
      }
    ],
    policies: [],
    events: [
      {
        id: "event.tests.verified",
        claimId: "claim.quality.tests",
        status: "verified",
        actor: "ci",
        method: "validation",
        evidenceIds: ["evidence.tests"],
        createdAt: "2026-06-15T00:00:00.000Z",
        verifiedAt: "2026-06-15T00:00:00.000Z"
      }
    ]
  };
  const manifest = {
    schema_version: "1",
    evidence: [
      {
        id: "ev.verify",
        gate_id: "verify-gate",
        kind: "trust.bundle",
        requested_kind: "trust.bundle",
        status: "passed",
        bundle: leafBundle,
        bundle_report: buildTrustReport(validateTrustBundle(leafBundle), { now: NOW })
      }
    ]
  };
  return { definition, state, manifest };
}

test("run-output bundle validates against Hachure schema and Surface", () => {
  const { definition, state, manifest } = passedRun();
  const bundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });

  const schemaResult = validateTrustBundleSchema(bundle);
  assert.ok(schemaResult.valid, `Hachure schema errors: ${(schemaResult.errors ?? []).join("; ")}`);
  assert.doesNotThrow(() => validateTrustBundle(bundle), "Surface structural validation");

  // Member claims for both passed stages.
  const claimIds = bundle.claims.map((c) => c.id).sort();
  assert.deepEqual(claimIds, ["claim.flow.stage.plan", "claim.flow.stage.verify"]);

  // Evidence is by-reference (no inlined child claims/events).
  assert.ok(bundle.evidence.length >= 1);
  for (const ev of bundle.evidence) {
    assert.ok(ev.metadata?.bundleReference, "evidence carries a bundleReference");
    assert.ok(!("claims" in ev), "evidence does not inline child claims");
    assert.equal(ev.metadata.bundleReference.statusFunctionVersion, "2");
    assert.ok(ev.metadata.bundleReference.asOf, "reference pins asOf");
  }
});

test("run verified is a Surface rollup (all-required claimGroup), not Flow-computed", () => {
  const { definition, state, manifest } = passedRun();
  const bundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });

  // Flow emits the group definition; Surface derives the verdict.
  assert.equal(bundle.claimGroups.length, 1);
  assert.equal(bundle.claimGroups[0].rollupPolicy.mode, "all-required");

  const report = buildTrustReport(validateTrustBundle(bundle), { now: NOW });
  // All member stages derive verified, so the run-verified rollup is satisfied.
  for (const claim of report.claims) {
    assert.equal(claim.status, "verified", `${claim.id} should derive verified`);
  }
  const rollup = report.claimGroupRollups.find((g) => g.id === bundle.claimGroups[0].id);
  assert.ok(rollup, "claim group rollup is present");
  assert.equal(rollup.status, "verified", "Surface rolls up the run as verified");
});

test("run-output bundle round-trips as evidence into a parent flow's gate", () => {
  const { definition, state, manifest } = passedRun();
  const childBundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });

  // Parent flow gate selects the child run's stage claim.
  const parentDef = {
    id: "parent-flow",
    version: "1",
    steps: [{ id: "integrate", next: null }],
    gates: {
      "integrate-gate": {
        step: "integrate",
        expects: [
          {
            id: "child-verified",
            kind: "trust.bundle",
            required: true,
            description: "Child run verify stage passed.",
            bundle_claim: {
              claimType: "flow.stage.passed",
              subjectType: "flow-stage",
              subjectId: "child-flow:verify",
              accepted_statuses: ["verified"]
            }
          }
        ]
      }
    }
  };
  const parentState = initialState(parentDef, "parent-run");
  parentState.current_step = "integrate";

  const parentManifest = {
    schema_version: "1",
    evidence: [
      {
        id: "ev.child-run",
        gate_id: "integrate-gate",
        kind: "trust.bundle",
        requested_kind: "trust.bundle",
        status: "passed",
        bundle: childBundle,
        bundle_report: buildTrustReport(validateTrustBundle(childBundle), { now: NOW }),
        attached_at: NOW.toISOString()
      }
    ]
  };

  const outcome = evaluateGate(parentDef, parentState, parentManifest, "integrate-gate", defaultFlowConfig());
  assert.equal(outcome.status, "pass", "parent gate passes consuming the child run as a single claim");
});
