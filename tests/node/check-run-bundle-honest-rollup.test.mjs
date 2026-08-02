/**
 * flow#203 — the run-output TrustBundle must not certify a run that failed.
 *
 * `projectRunOutputBundle` filtered the `all-required` claim group's membership
 * to the PASSING stages, so the rollup was true by construction: every
 * counter-example was removed before Surface could see one. Delegating the
 * rollup to Surface is only meaningful if Surface receives the failures.
 * Separately, a stage that passed only because an exception was accepted emitted
 * `status: "verified"` with `evidenceIds: []` and no reference to the exception,
 * its reason, or who accepted it — indistinguishable from a stage backed by real
 * evidence.
 *
 * Both known-bad fixtures below roll up to `verified` on pre-fix code.
 *
 * Every rollup assertion is made by folding the emitted bundle THROUGH SURFACE
 * (`buildTrustReport`), never by reading Flow's own pre-fold output.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildTrustReport } from "@kontourai/surface";

import {
  acceptException,
  attachEvidence,
  evaluateRun,
  loadRun,
  projectRunOutputBundle,
  startRun
} from "../../dist/index.js";
import { validateTrustBundleSchema } from "../../dist/gates/trust-bundle-validator.js";

const NOW = new Date("2026-08-02T00:00:00.000Z");
const FIXED = "2026-07-01T00:00:00.000Z";

function expects(id, step) {
  return [{
    id,
    kind: "trust.bundle",
    required: true,
    description: id,
    bundle_claim: {
      claimType: id,
      subjectType: "flow-step",
      subjectId: `rollup.${step}`,
      accepted_statuses: ["verified"]
    }
  }];
}

const definition = {
  id: "rollup-flow",
  version: "1",
  steps: [
    { id: "plan", next: "verify" },
    { id: "verify", next: "publish" },
    { id: "publish", next: null }
  ],
  gates: {
    "plan-gate": { step: "plan", expects: expects("plan.ready", "plan") },
    "verify-gate": { step: "verify", expects: expects("quality.tests", "verify") },
    "publish-gate": { step: "publish", expects: expects("release.notes", "publish") }
  }
};

function gateBundle(claimType, step) {
  return {
    schemaVersion: 5,
    source: `rollup/${claimType}`,
    claims: [{
      id: `claim.${claimType}`, subjectType: "flow-step", subjectId: `rollup.${step}`,
      facet: "quality", claimType, fieldOrBehavior: "ok", value: true,
      createdAt: FIXED, updatedAt: FIXED
    }],
    evidence: [{
      id: `evidence.${claimType}`, claimId: `claim.${claimType}`, evidenceType: "test_output",
      method: "validation", sourceRef: "ci:1", excerptOrSummary: "ok",
      observedAt: FIXED, collectedBy: "ci"
    }],
    events: [{
      id: `event.${claimType}`, claimId: `claim.${claimType}`, status: "verified", type: "verification",
      actor: "ci", method: "validation", evidenceIds: [`evidence.${claimType}`],
      createdAt: FIXED, verifiedAt: FIXED
    }],
    policies: []
  };
}

async function startRollupRun(runId) {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-rollup-"));
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  await startRun(definitionPath, { cwd, runId, params: { subject: "rollup" } });
  return cwd;
}

async function passGate(runId, cwd, gate, claimType, step) {
  const file = path.join(cwd, `${claimType}.json`);
  await writeFile(file, `${JSON.stringify(gateBundle(claimType, step))}\n`);
  await attachEvidence(runId, { cwd, gate, file, kind: "trust.bundle", bundle: true });
  await evaluateRun(runId, { cwd });
}

function foldThroughSurface(run) {
  const bundle = projectRunOutputBundle(run.definition, run.state, run.manifest, { now: NOW });
  const report = buildTrustReport(bundle);
  return {
    bundle,
    report,
    statusById: Object.fromEntries(report.claims.map((claim) => [claim.id, claim.status])),
    rollup: report.claimGroupRollups[0]
  };
}

test("a run with a blocked stage does not roll up as verified through Surface", async () => {
  const cwd = await startRollupRun("rollup-blocked");
  await passGate("rollup-blocked", cwd, "plan-gate", "plan.ready", "plan");
  // verify has no evidence: its gate blocks.
  await evaluateRun("rollup-blocked", { cwd });

  const run = await loadRun("rollup-blocked", cwd);
  const { bundle, statusById, rollup } = foldThroughSurface(run);

  assert.deepEqual(
    bundle.claimGroups[0].claimIds,
    ["claim.flow.stage.plan", "claim.flow.stage.verify", "claim.flow.stage.publish"],
    "the all-required group's membership is the full stage set, not the passing subset"
  );
  assert.equal(statusById["claim.flow.stage.plan"], "verified");
  assert.equal(statusById["claim.flow.stage.verify"], "rejected", "the blocked stage carries its real derived status");
  assert.equal(
    statusById["claim.flow.stage.publish"],
    "unknown",
    "a stage the run never reached is `unknown` — nothing to appraise — not dropped and not verified"
  );

  assert.notEqual(rollup.status, "verified", "a run with a non-passing stage cannot roll up as verified");
  assert.equal(rollup.status, "rejected");
});

test("an exception-passed stage is a waiver on the record, not a verified stage", async () => {
  const cwd = await startRollupRun("rollup-waived");
  await passGate("rollup-waived", cwd, "plan-gate", "plan.ready", "plan");

  await acceptException("rollup-waived", {
    cwd,
    gate: "verify-gate",
    reason: "CI runner unavailable; checked by hand on staging",
    authority: "ops@example.test"
  });
  await evaluateRun("rollup-waived", { cwd });

  const run = await loadRun("rollup-waived", cwd);
  const { bundle, report, statusById, rollup } = foldThroughSurface(run);

  const claim = bundle.claims.find((entry) => entry.id === "claim.flow.stage.verify");
  const waiver = claim.metadata.waiver;
  assert.ok(waiver, "the accepted exception appears on the record as a hachure waivers.md waiver");
  assert.equal(waiver.reason, "CI runner unavailable; checked by hand on staging");
  assert.equal(waiver.approved_by, "ops@example.test");
  assert.ok(waiver.approved_at, "the waiver records when the gap was accepted");
  assert.match(waiver.exceptionId, /^ex\./, "the waiver names the exception on the run");

  const event = bundle.events.find((entry) => entry.claimId === "claim.flow.stage.verify");
  assert.equal(event.status, "assumed", "an accepted exception is a producer assertion, not a verification");
  assert.notEqual(event.status, "verified");

  assert.equal(statusById["claim.flow.stage.verify"], "assumed", "Surface derives assumed, not verified");
  assert.notEqual(rollup.status, "verified", "a run carrying a waived stage does not certify itself verified");

  // Surface reads the waiver as the spec profile defines it.
  assert.equal(report.waiverValidityByClaimId["claim.flow.stage.verify"].verdict, "complete-waiver");

  // The genuinely-verified stage cites the evidence this bundle carries rather
  // than a literal empty list, so "passed on evidence" and "passed on a waiver"
  // are distinguishable without consulting the run.
  const planEvent = bundle.events.find((entry) => entry.claimId === "claim.flow.stage.plan");
  assert.equal(planEvent.status, "verified");
  assert.ok(planEvent.evidenceIds.length > 0, "a verified stage cites its evidence");
  assert.deepEqual(event.evidenceIds, [], "a waived stage has no evidence, and that is now visible");
});

test("an all-passed run still rolls up as verified", async () => {
  const cwd = await startRollupRun("rollup-green");
  await passGate("rollup-green", cwd, "plan-gate", "plan.ready", "plan");
  await passGate("rollup-green", cwd, "verify-gate", "quality.tests", "verify");
  await passGate("rollup-green", cwd, "publish-gate", "release.notes", "publish");

  const run = await loadRun("rollup-green", cwd);
  const { statusById, rollup } = foldThroughSurface(run);
  for (const step of ["plan", "verify", "publish"]) {
    assert.equal(statusById[`claim.flow.stage.${step}`], "verified", `${step} passed on real evidence`);
  }
  assert.equal(rollup.status, "verified", "the honest rollup must still say verified when it is true");
});

// This one passes against pre-fix code too, and deliberately so: the pre-fix
// bundle was schema-valid, it was just dishonest. It is here for AC4 — proving
// the L1 validator actually compiled with its sibling $refs resolved, rather
// than silently passing everything (flow-agents#1126).
test("the emitted bundle validates against the spec schema, and the validator is really validating", async () => {
  const cwd = await startRollupRun("rollup-schema");
  await passGate("rollup-schema", cwd, "plan-gate", "plan.ready", "plan");
  await evaluateRun("rollup-schema", { cwd });

  const run = await loadRun("rollup-schema", cwd);
  const { bundle } = foldThroughSurface(run);

  const result = validateTrustBundleSchema(bundle);
  assert.equal(result.valid, true, `bundle must satisfy trust-bundle.schema.json: ${result.errors.join("; ")}`);

  // flow-agents#1126: Ajv silently caches a null validator when cross-file
  // $refs cannot resolve, and then everything "passes". Asserting that a
  // document passed proves nothing on its own. A known-bad document must be
  // rejected with a SCHEMA error — not a "validator error:" — which is only
  // possible if the schema and its siblings actually compiled.
  const broken = structuredClone(bundle);
  broken.claims[0].value = undefined;
  delete broken.claims[0].value;
  const rejected = validateTrustBundleSchema(broken);
  assert.equal(rejected.valid, false, "a claim missing a required field must be rejected");
  assert.ok(
    rejected.errors.some((message) => /required/i.test(message)),
    `the rejection must come from the compiled schema, not a validator failure: ${rejected.errors.join("; ")}`
  );
  assert.ok(
    !rejected.errors.some((message) => message.startsWith("validator error:")),
    "the validator compiled; a 'validator error' would mean $ref resolution failed"
  );

  // A sibling-schema constraint specifically: `status` is a $ref into
  // claim.schema.json's trustStatus enum, so an invalid value only fails when
  // sibling schemas were registered for $ref resolution.
  const badStatus = structuredClone(bundle);
  badStatus.claims[0].status = "definitely-not-a-trust-status";
  const statusResult = validateTrustBundleSchema(badStatus);
  assert.equal(statusResult.valid, false, "a $ref'd enum must be enforced, proving sibling schemas resolved");
});
