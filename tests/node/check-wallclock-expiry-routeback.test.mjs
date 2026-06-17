/**
 * Task D — wall-clock expiry routes back through the §1 seam, NO SCHEDULER.
 *
 * RESOLVED DECISION 1: neither Surface nor Flow has a scheduler/timer/daemon.
 * Flow is purely REACTIVE — its only clock is the `now` captured at an
 * `evaluateRun` that some EXTERNAL actor invokes. This test proves the §1
 * "derived-status-flipped → gate re-eval → route-back → invalidateDescendants"
 * seam ALSO fires for the wall-clock-expiry case (a claim that goes stale purely
 * because time passed), not only for explicit revocation events.
 *
 * The fixture is time-based — a claim fresh at T0, wall-clock-expired at T1 —
 * exercised across TWO explicit `evaluateRun` calls with different `now`. There
 * is NO timer anywhere: the two calls are made explicitly, exactly as an
 * external producer/CI/agent/person would trigger them. The SECOND call
 * re-derives the previously-passed stage's claim to stale, routes back, and
 * `invalidateDescendants` clears the downstream stale pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { startRun, loadRun, saveRun, evaluateRun } from "../../dist/index.js";

const T0 = "2026-06-10T00:00:00.000Z";
const EXPIRES = "2026-06-15T00:00:00.000Z";
const T1 = "2026-06-20T00:00:00.000Z";

// prepare -> verify -> release. The verify gate requires a freshness-bearing
// "approval valid" claim; on stale evidence it routes back to prepare. release
// is verify's descendant so a route-back to prepare must invalidate it.
function definition() {
  return {
    id: "wallclock-flow",
    version: "1",
    steps: [
      { id: "prepare", next: "verify" },
      { id: "verify", next: "release", needs: ["prepare"] },
      { id: "release", next: null, needs: ["verify"] }
    ],
    gates: {
      "prepare-gate": { step: "prepare", expects: [] },
      "verify-gate": {
        step: "verify",
        on_route_back: { missing_evidence: "prepare", default: "prepare" },
        expects: [
          {
            id: "approval-fresh",
            kind: "trust.bundle",
            required: true,
            description: "Approval is currently valid (not wall-clock expired).",
            bundle_claim: {
              claimType: "approval",
              subjectType: "release",
              subjectId: "wallclock-flow:release",
              accepted_statuses: ["verified"]
            }
          }
        ]
      },
      "release-gate": { step: "release", expects: [] }
    }
  };
}

// A trust.bundle whose claim carries an intrinsic validity window (expiresAt).
// Surface derives `verified` while now < EXPIRES and `stale` after — Flow does
// NO time math; it only reads the derived status.
function approvalBundle() {
  return {
    schemaVersion: 4,
    source: "approval/window",
    claims: [
      {
        id: "claim.approval",
        subjectType: "release",
        subjectId: "wallclock-flow:release",
        surface: "process.approval",
        claimType: "approval",
        fieldOrBehavior: "approvalValid",
        value: true,
        createdAt: T0,
        updatedAt: T0,
        expiresAt: EXPIRES,
        verificationPolicyId: "policy.approval"
      }
    ],
    evidence: [
      {
        id: "evidence.approval",
        claimId: "claim.approval",
        evidenceType: "human_attestation",
        method: "attestation",
        sourceRef: "approver",
        excerptOrSummary: "approved",
        observedAt: T0,
        collectedBy: "approver"
      }
    ],
    policies: [
      {
        id: "policy.approval",
        claimType: "approval",
        requiredEvidence: ["human_attestation"],
        requiredMethods: ["attestation"],
        requiresCorroboration: false,
        acceptanceCriteria: ["human approval"],
        reviewAuthority: "approver",
        validityRule: { kind: "manual" },
        stalenessTriggers: ["window expires"],
        conflictRules: [],
        impactLevel: "high"
      }
    ],
    events: [
      {
        id: "event.approval.verified",
        claimId: "claim.approval",
        status: "verified",
        actor: "approver",
        method: "attestation",
        evidenceIds: ["evidence.approval"],
        createdAt: T0,
        verifiedAt: T0
      }
    ]
  };
}

async function makeRun(cwd) {
  await mkdir(cwd, { recursive: true });
  const defPath = path.join(cwd, "flow.json");
  await writeFile(defPath, JSON.stringify(definition()));
  const { runId } = await startRun("flow.json", { cwd, runId: "wallclock-run" });

  // Inject: prepare already passed, the cursor is at verify, and the verify
  // gate carries the freshness-bearing approval bundle.
  const run = await loadRun(runId, cwd);
  run.state.current_step = "verify";
  run.state.status = "active";
  run.state.gate_outcomes = [
    { gate_id: "prepare-gate", status: "pass", summary: "passed", evidence_refs: [] }
  ];
  run.state.transitions = [
    { from_step: "prepare", to_step: "verify", status: "allowed", gate_id: "prepare-gate", at: T0 }
  ];
  run.manifest.evidence = [
    {
      id: "ev.approval",
      gate_id: "verify-gate",
      kind: "trust.bundle",
      requested_kind: "trust.bundle",
      status: "passed",
      bundle: approvalBundle()
    }
  ];
  await saveRun(run);
  return runId;
}

test("T0 evaluateRun: fresh claim → verify gate passes (no route-back)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-"));
  const runId = await makeRun(cwd);

  const result = await evaluateRun(runId, { cwd, gate: "verify-gate", now: T0 });
  const outcome = result.outcomes[0];
  assert.equal(outcome.status, "pass", "verify passes while the approval is fresh");

  // The bundle re-derived as verified at T0 — no freshness transition.
  assert.equal(result.freshness_transitions.length, 0);

  const after = await loadRun(runId, cwd);
  const approval = after.manifest.evidence[0].bundle_report.claims.find((c) => c.id === "claim.approval");
  assert.equal(approval.status, "verified", "claim derives verified at T0");
});

test("T1 evaluateRun: wall-clock-expired claim → route-back + invalidateDescendants (NO timer)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-"));
  const runId = await makeRun(cwd);

  // First (external) call at T0: passes, advances to release. verify is now a
  // previously-passed stage.
  await evaluateRun(runId, { cwd, gate: "verify-gate", now: T0 });
  let mid = await loadRun(runId, cwd);
  assert.equal(mid.state.current_step, "release", "advanced to release after T0 pass");
  assert.ok(
    mid.state.gate_outcomes.some((o) => o.gate_id === "verify-gate" && o.status === "pass"),
    "verify recorded as passed at T0"
  );

  // Second (external) call at T1 — the SAME verify gate is re-evaluated; the
  // only thing that changed is the wall clock. Surface now derives the approval
  // claim stale, so the gate no longer matches `accepted_statuses: [verified]`
  // and routes back to prepare. NOTHING fired on its own — this call is explicit.
  const result = await evaluateRun(runId, { cwd, gate: "verify-gate", now: T1 });
  const outcome = result.outcomes[0];
  assert.equal(outcome.status, "route-back", "stale approval routes the verify gate back");
  assert.equal(outcome.route_back_to, "prepare");

  // Surface (not Flow) decided the claim is stale; Flow only reacted.
  const stale = result.freshness_transitions.find(
    (t) => t.claimId === "claim.approval" && t.from === "fresh" && t.to === "stale"
  );
  assert.ok(stale, "a fresh→stale freshness transition was observed at T1");

  const after = await loadRun(runId, cwd);
  // Cursor walked back to the route-back target; run is active again.
  assert.equal(after.state.current_step, "prepare");
  assert.equal(after.state.status, "active");

  // invalidateDescendants cleared the downstream stale pass (verify, release).
  const passedGates = after.state.gate_outcomes.filter((o) => o.status === "pass").map((o) => o.gate_id);
  assert.ok(!passedGates.includes("verify-gate"), "verify's stale pass was invalidated");
  assert.ok(!passedGates.includes("release-gate"), "release (descendant) pass was invalidated");

  // The route-back transition records the cascade for audit.
  const routeBack = after.state.transitions.find((t) => t.type === "route_back");
  assert.ok(routeBack, "route_back transition recorded");
  assert.ok(
    Array.isArray(routeBack.invalidated_steps) && routeBack.invalidated_steps.includes("release"),
    "release is recorded among the invalidated descendants"
  );
});
