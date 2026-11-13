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
  assertEvidenceReferencesAcyclic,
  EvidenceReferenceCycleError,
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
    schemaVersion: 5,
    source: "ci/verify",
    claims: [
      {
        id: "claim.quality.tests",
        subjectType: "flow-step",
        subjectId: "child-flow:verify",
        facet: "quality",
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
        evidenceType: "test_output", passing: true,
        method: "validation",
        sourceRef: "ci:1",
        excerptOrSummary: "tests passed",
        observedAt: "2026-06-15T00:00:00.000Z",
        collectedBy: "ci"
      }
    ],
    policies: [{ id: "policy.fixture", claimType: "quality.tests", requiredEvidence: ["test_output"], requiredMethods: [], acceptanceCriteria: ["Fixture evidence"], reviewAuthority: "test", validityRule: { kind: "historical" }, stalenessTriggers: [], conflictRules: [], impactLevel: "medium" }],
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
    assert.equal(ev.metadata.bundleReference.statusFunctionVersion, "4");
    assert.ok(ev.metadata.bundleReference.asOf, "reference pins asOf");
  }
});

test("a passed stage without reference evidence cannot certify a run through Surface", () => {
  const { definition, state, manifest } = passedRun();
  const bundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });

  // Flow emits the group definition; Surface derives the verdict.
  assert.equal(bundle.claimGroups.length, 1);
  assert.equal(bundle.claimGroups[0].rollupPolicy.mode, "all-required");

  const report = buildTrustReport(validateTrustBundle(bundle), { now: NOW });
  // Only the stage with qualifying reference evidence can derive verified.
  for (const claim of report.claims) {
    assert.equal(claim.status, claim.id.endsWith(".plan") ? "proposed" : "verified", claim.id);
  }
  const rollup = report.claimGroupRollups.find((g) => g.id === bundle.claimGroups[0].id);
  assert.ok(rollup, "claim group rollup is present");
  assert.equal(rollup.status, "proposed", "Missing plan attestation leaves the rollup proposed");
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

// ---------------------------------------------------------------------------
// Task C — real acyclicity guard on the evidence-reference graph.
// ---------------------------------------------------------------------------

test("projectRunOutputBundle passes the evidence-reference acyclicity guard", () => {
  const { definition, state, manifest } = passedRun();
  // The guard runs inside projectRunOutputBundle; emission must not throw.
  assert.doesNotThrow(() => projectRunOutputBundle(definition, state, manifest, { now: NOW }));
});

test("acyclicity guard accepts a normal down-only reference graph", () => {
  // root references one leaf gate-evidence bundle that references nothing.
  const root = {
    source: "flow-run:child:r1",
    claims: [
      { id: "c1", metadata: { bundleReferences: [{ evidenceId: "ev.leaf" }] } }
    ]
  };
  const leaf = { source: "ci/leaf", claims: [] };
  const byId = new Map([["ev.leaf", leaf]]);
  assert.doesNotThrow(() => assertEvidenceReferencesAcyclic(root, byId));
});

test("acyclicity guard THROWS when a reference loops back to the root", () => {
  // root -> leaf -> root : a cycle introduced via a back-reference.
  const root = {
    source: "flow-run:child:r1",
    claims: [
      { id: "c1", metadata: { bundleReferences: [{ evidenceId: "ev.leaf" }] } }
    ]
  };
  const leaf = {
    source: "ci/leaf",
    // The leaf (itself a flow-output bundle) references back up to the root.
    claims: [
      { id: "c2", metadata: { bundleReferences: [{ evidenceId: "ev.root" }] } }
    ]
  };
  const byId = new Map([
    ["ev.leaf", leaf],
    ["ev.root", root]
  ]);

  assert.throws(
    () => assertEvidenceReferencesAcyclic(root, byId),
    (err) => {
      assert.ok(err instanceof EvidenceReferenceCycleError, "must be an EvidenceReferenceCycleError");
      assert.ok(err.cycle.includes("flow-run:child:r1"), "cycle names the root");
      return true;
    }
  );
});

test("acyclicity guard THROWS on a deeper multi-hop cycle (a -> b -> c -> a)", () => {
  const a = { source: "bundle.a", claims: [{ id: "ca", metadata: { bundleReferences: [{ evidenceId: "ev.b" }] } }] };
  const b = { source: "bundle.b", claims: [{ id: "cb", metadata: { bundleReferences: [{ evidenceId: "ev.c" }] } }] };
  const c = { source: "bundle.c", claims: [{ id: "cc", metadata: { bundleReferences: [{ evidenceId: "ev.a" }] } }] };
  const byId = new Map([
    ["ev.a", a],
    ["ev.b", b],
    ["ev.c", c]
  ]);
  assert.throws(() => assertEvidenceReferencesAcyclic(a, byId), EvidenceReferenceCycleError);
});

test("projectRunOutputBundle THROWS when a leaf bundle references the run being emitted", () => {
  const { definition, state, manifest } = passedRun();
  // Poison the leaf gate-evidence bundle so it references the run-output bundle
  // that projectRunOutputBundle is about to emit (source flow-run:child-flow:child-run).
  manifest.evidence[0].bundle.claims[0].metadata = {
    bundleReferences: [{ evidenceId: "ev.verify" }] // self-reference via its own id -> the leaf -> ... loop
  };
  // Add a second manifest entry whose bundle points back at the run output,
  // forming root -> ev.verify(leaf) -> ev.verify (cycle on the leaf node).
  assert.throws(
    () => projectRunOutputBundle(definition, state, manifest, { now: NOW }),
    EvidenceReferenceCycleError
  );
});

test("run-output re-derives legacy 5.4.0 reports before emitting reference attestations", () => {
  const { definition, state, manifest } = passedRun();
  // The cached report and historical pass remain verified, but the current
  // ledger no longer meets Surface 6's policy requirement.
  manifest.evidence[0].bundle.policies = [];
  assert.equal(manifest.evidence[0].bundle_report.claims[0].status, "verified");
  const bundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });
  assert.equal(bundle.evidence.length, 0);
  const report = buildTrustReport(bundle, { now: NOW });
  assert.equal(report.claims.find(claim => claim.id.endsWith(".verify")).status, "proposed");
  assert.equal(report.claimGroupRollups[0].status, "proposed");
});

test("real API optional-only gate cannot certify a proposed child bundle as a verified run", async t => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { startRun, attachEvidence, evaluateRun, loadRun } = await import("../../dist/index.js");
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-optional-rollup-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { manifest } = passedRun();
  const definition = {
    id: "optional-only", version: "1", steps: [{ id: "verify", next: null }],
    gates: { "verify-gate": { step: "verify", expects: [{
      id: "tests", kind: "trust.bundle", required: false, description: "Optional test evidence",
      bundle_claim: { claimType: "quality.tests", accepted_statuses: ["verified"] }
    }] } }
  };
  const file = path.join(cwd, "definition.json"), evidenceFile = path.join(cwd, "evidence.json");
  const child = manifest.evidence[0].bundle; child.policies = [];
  await writeFile(file, JSON.stringify(definition)); await writeFile(evidenceFile, JSON.stringify(child));
  await startRun(file, { cwd, runId: "optional" });
  await attachEvidence("optional", { cwd, gate: "verify-gate", file: evidenceFile, kind: "trust.bundle" });
  const evaluated = await evaluateRun("optional", { cwd });
  assert.equal(evaluated.outcomes[0].status, "pass");
  assert.deepEqual(evaluated.outcomes[0].matched_expectations, []);
  const run = await loadRun("optional", cwd);
  assert.equal(run.manifest.evidence[0].bundle_report.claims[0].status, "proposed");
  const bundle = projectRunOutputBundle(run.definition, run.state, run.manifest);
  assert.equal(bundle.evidence.length, 0);
  const report = buildTrustReport(bundle);
  assert.equal(report.claims[0].status, "proposed");
  assert.equal(report.claimGroupRollups[0].status, "proposed");
});

test("run-output references only the matched verified claim, not an unrelated proposed claim", () => {
  const { definition, state, manifest } = passedRun();
  state.gate_outcomes[1].matched_expectations = [{ evidence_id: "ev.verify", claim_ids: ["claim.quality.tests"] }];
  manifest.evidence[0].bundle.claims.push({ ...manifest.evidence[0].bundle.claims[0], id: "unrelated" });
  const bundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });
  assert.equal(bundle.evidence.length, 1);
  assert.equal(bundle.evidence[0].metadata.bundleReference.claimSelectors.length, 1);
  assert.equal(buildTrustReport(bundle, { now: NOW }).claims.find(claim => claim.id.endsWith(".verify")).status, "verified");
});

test("a qualifying reference cannot hide another recorded match that now derives proposed", () => {
  const { definition, state, manifest } = passedRun();
  const invalid = structuredClone(manifest.evidence[0]); invalid.id = "ev.other"; invalid.bundle.policies = [];
  manifest.evidence.push(invalid);
  state.gate_outcomes[1].matched_expectations = ["ev.verify", "ev.other"].map(evidence_id => ({ evidence_id, claim_ids: ["claim.quality.tests"] }));
  const bundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });
  assert.equal(bundle.evidence.length, 0);
  assert.equal(buildTrustReport(bundle, { now: NOW }).claims.find(claim => claim.id.endsWith(".verify")).status, "proposed");
});

test("pre-5.1 matches without claim_ids leave run-output trust proposed", () => {
  const { definition, state, manifest } = passedRun();
  state.gate_outcomes[1].matched_expectations = [{ expectation_id: "tests", evidence_id: "ev.verify" }];
  assert.equal(manifest.evidence[0].bundle_report.claims[0].status, "verified");
  const bundle = projectRunOutputBundle(definition, state, manifest, { now: NOW });
  assert.equal(bundle.evidence.length, 0);
  const report = buildTrustReport(bundle, { now: NOW });
  assert.equal(report.claims.find(claim => claim.id.endsWith(".verify")).status, "proposed");
  assert.equal(report.claimGroupRollups[0].status, "proposed");
});
