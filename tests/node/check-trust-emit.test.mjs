import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildFlowTrustBundle,
  buildGateTrustBundle,
  FLOW_GATE_OUTCOME_CLAIM_TYPE,
  FLOW_RUN_OUTCOME_CLAIM_TYPE,
  FLOW_RUN_TRUST_RUN_BUNDLE_PATH,
  flowRunTrustGateBundlePath,
  gateOutcomeEventStatus,
  runDir,
  scaffoldDemoRun,
  validateTrustBundleSchema
} from "../../dist/index.js";

const NOW = "2026-06-18T00:00:00.000Z";

const passOutcome = {
  gate_id: "verify-gate",
  status: "pass",
  summary: "Tests passed satisfied",
  evidence_refs: ["ev.1"],
  matched_expectations: [{ expectation_id: "tests-passed", evidence_id: "ev.1" }]
};

const blockOutcome = {
  gate_id: "plan-gate",
  status: "block",
  summary: "Acceptance criteria missing",
  missing: ["acceptance"],
  evidence_refs: []
};

const routeBackOutcome = {
  gate_id: "implement-gate",
  status: "route-back",
  summary: "implementation defect",
  route_reason: "implementation_defect",
  evidence_refs: ["ev.2"]
};

async function surface() {
  return import("@kontourai/surface");
}

test("gate-outcome status maps onto Hachure verification-event statuses", () => {
  assert.equal(gateOutcomeEventStatus("pass"), "verified");
  assert.equal(gateOutcomeEventStatus("block"), "rejected");
  assert.equal(gateOutcomeEventStatus("route-back"), "disputed");
  assert.equal(gateOutcomeEventStatus("wait"), null);
});

test("per-gate bundle for a passing gate is schema-valid and derives verified", async () => {
  const { buildTrustReport, validateTrustBundle } = await surface();
  const bundle = buildGateTrustBundle(passOutcome, { runId: "r1", now: NOW });

  assert.equal(bundle.schemaVersion, 3);
  assert.equal(validateTrustBundleSchema(bundle).valid, true);
  assert.equal(bundle.claims.length, 1);
  assert.equal(bundle.claims[0].claimType, FLOW_GATE_OUTCOME_CLAIM_TYPE);
  assert.equal(bundle.claims[0].subjectType, "flow-gate");
  assert.equal(bundle.claims[0].subjectId, "r1/verify-gate");
  // Evidence = the gate's evidence manifest.
  assert.equal(bundle.evidence.length, 1);
  assert.match(bundle.evidence[0].excerptOrSummary, /tests-passed/);

  const report = buildTrustReport(validateTrustBundle(bundle));
  assert.equal(report.claims[0].status, "verified");
});

test("per-gate bundle for a failing gate is schema-valid and derives rejected", async () => {
  const { buildTrustReport, validateTrustBundle } = await surface();
  const bundle = buildGateTrustBundle(blockOutcome, { runId: "r1", now: NOW });

  assert.equal(validateTrustBundleSchema(bundle).valid, true);
  assert.equal(bundle.claims[0].subjectId, "r1/plan-gate");
  // A gate with no attached evidence still emits an inspectable manifest entry.
  assert.equal(bundle.evidence.length, 1);

  const report = buildTrustReport(validateTrustBundle(bundle));
  assert.equal(report.claims[0].status, "rejected");
});

test("per-gate route-back bundle derives disputed", async () => {
  const { buildTrustReport, validateTrustBundle } = await surface();
  const bundle = buildGateTrustBundle(routeBackOutcome, { runId: "r1", now: NOW });
  assert.equal(validateTrustBundleSchema(bundle).valid, true);
  const report = buildTrustReport(validateTrustBundle(bundle));
  assert.equal(report.claims[0].status, "disputed");
});

test("buildGateTrustBundle requires a gate outcome with a gate_id", () => {
  assert.throws(() => buildGateTrustBundle({}), /gate_id/);
});

test("run-level aggregate bundle has a claim for every gate plus a run rollup", async () => {
  const { buildTrustReport, validateTrustBundle } = await surface();
  const run = {
    state: {
      run_id: "r-multi",
      definition_id: "agent-dev",
      subject: "feature-search",
      status: "blocked",
      updated_at: NOW,
      gate_outcomes: [passOutcome, blockOutcome, routeBackOutcome]
    }
  };
  const bundle = buildFlowTrustBundle(run, { now: NOW });
  assert.equal(validateTrustBundleSchema(bundle).valid, true);

  // One claim per gate + the run-level rollup claim.
  const claimTypes = bundle.claims.map((c) => c.claimType);
  const gateClaims = bundle.claims.filter((c) => c.claimType === FLOW_GATE_OUTCOME_CLAIM_TYPE);
  const runClaims = bundle.claims.filter((c) => c.claimType === FLOW_RUN_OUTCOME_CLAIM_TYPE);
  assert.equal(gateClaims.length, 3, "one claim per gate");
  assert.equal(runClaims.length, 1, "one run-level rollup claim");

  // Every gate outcome is covered by a claim subject.
  const subjects = gateClaims.map((c) => c.subjectId).sort();
  assert.deepEqual(subjects, ["r-multi/implement-gate", "r-multi/plan-gate", "r-multi/verify-gate"]);

  // The run claim derives from each gate claim.
  assert.deepEqual(
    runClaims[0].derivedFrom.sort(),
    ["claim.flow.gate.implement-gate", "claim.flow.gate.plan-gate", "claim.flow.gate.verify-gate"]
  );

  const report = buildTrustReport(validateTrustBundle(bundle));
  const statusById = Object.fromEntries(report.claims.map((c) => [c.id, c.status]));
  assert.equal(statusById["claim.flow.gate.verify-gate"], "verified");
  assert.equal(statusById["claim.flow.gate.plan-gate"], "rejected");
  assert.equal(statusById["claim.flow.gate.implement-gate"], "disputed");
  // A run with failing gates rolls up to a non-verified status. Surface caps
  // the run claim by its weakest input (rejected here, via derivedFrom).
  assert.ok(["rejected", "disputed"].includes(statusById["claim.flow.run.r-multi"]));
  assert.notEqual(statusById["claim.flow.run.r-multi"], "verified");
  assert.ok(claimTypes.includes(FLOW_RUN_OUTCOME_CLAIM_TYPE));
});

test("an all-pass run rolls up to verified", async () => {
  const { buildTrustReport, validateTrustBundle } = await surface();
  const run = {
    state: {
      run_id: "r-pass",
      status: "completed",
      updated_at: NOW,
      gate_outcomes: [passOutcome, { ...passOutcome, gate_id: "publish-gate" }]
    }
  };
  const bundle = buildFlowTrustBundle(run, { now: NOW });
  const report = buildTrustReport(validateTrustBundle(bundle));
  const runClaim = report.claims.find((c) => c.claimType === FLOW_RUN_OUTCOME_CLAIM_TYPE);
  assert.equal(runClaim.status, "verified");
});

test("evaluating a run emits trust bundles to the run's artifact location", async () => {
  const { buildTrustReport, validateTrustBundle } = await surface();
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-trust-emit-"));
  await scaffoldDemoRun(cwd);
  const dir = runDir("demo", cwd);

  // Run-level bundle lands alongside report.json under trust/.
  const runBundle = JSON.parse(await readFile(path.join(dir, FLOW_RUN_TRUST_RUN_BUNDLE_PATH), "utf8"));
  assert.equal(validateTrustBundleSchema(runBundle).valid, true);
  const runReport = buildTrustReport(validateTrustBundle(runBundle));
  assert.ok(runReport.claims.some((c) => c.claimType === FLOW_RUN_OUTCOME_CLAIM_TYPE));

  // A per-gate bundle exists for the demo's plan-gate and round-trips.
  const gateBundle = JSON.parse(await readFile(path.join(dir, flowRunTrustGateBundlePath("plan-gate")), "utf8"));
  assert.equal(validateTrustBundleSchema(gateBundle).valid, true);
  const gateReport = buildTrustReport(validateTrustBundle(gateBundle));
  assert.equal(gateReport.claims[0].claimType, FLOW_GATE_OUTCOME_CLAIM_TYPE);
  assert.equal(gateReport.claims[0].status, "verified");

  const trustFiles = (await readdir(path.join(dir, "trust"))).sort();
  assert.deepEqual(trustFiles, ["gate.plan-gate.json", "run.json"]);
});
