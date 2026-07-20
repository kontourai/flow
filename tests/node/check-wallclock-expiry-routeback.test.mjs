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

import { startRun, loadRun, evaluateRun, reDeriveBundleReports } from "../../dist/index.js";
import { hashRunTree } from "./helpers/run-tree.mjs";

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
      "release-gate": {
        step: "release", expects: [],
        on_route_back: { "release revision required": "prepare" }
      }
    }
  };
}

// A trust.bundle whose claim carries an intrinsic validity window (expiresAt).
// Surface derives `verified` while now < EXPIRES and `stale` after — Flow does
// NO time math; it only reads the derived status.
function approvalBundle() {
  return {
    schemaVersion: 5,
    source: "approval/window",
    claims: [
      {
        id: "claim.approval",
        subjectType: "release",
        subjectId: "wallclock-flow:release",
        facet: "process.approval",
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

function siblingDefinition() {
  return {
    id: "sibling-flow",
    version: "1",
    steps: [
      { id: "plan", next: "build" },
      { id: "build", next: "release", needs: ["plan"] },
      { id: "docs", next: null, needs: ["plan"] },
      { id: "release", next: null, needs: ["build"] }
    ],
    gates: {
      "plan-gate": { step: "plan", expects: [] },
      "build-gate": { step: "build", expects: [] },
      "docs-gate": {
        step: "docs",
        on_route_back: { missing_evidence: "plan" },
        expects: [
          {
            id: "docs-fresh",
            kind: "trust.bundle",
            required: true,
            description: "Documentation approval remains fresh.",
            bundle_claim: {
              claimType: "approval",
              subjectType: "flow-step",
              subjectId: "docs",
              accepted_statuses: ["verified"]
            }
          }
        ]
      },
      "release-gate": { step: "release", expects: [] }
    }
  };
}

function convergingDefinition() {
  const branchExpectation = (step) => ({
    id: `${step}-fresh`,
    kind: "trust.bundle",
    required: true,
    description: `${step} approval remains fresh.`,
    bundle_claim: {
      claimType: "approval",
      subjectType: "flow-step",
      subjectId: step,
      accepted_statuses: ["verified"]
    }
  });
  return {
    id: "converging-flow",
    version: "1",
    steps: [
      { id: "root", next: "left" },
      { id: "left", next: "merge", needs: ["root"] },
      { id: "right", next: "merge", needs: ["root"] },
      { id: "merge", next: null, needs: ["left", "right"] }
    ],
    gates: {
      "root-gate": { step: "root", expects: [] },
      "left-gate": { step: "left", on_route_back: { missing_evidence: "left" }, expects: [branchExpectation("left")] },
      "right-gate": { step: "right", on_route_back: { missing_evidence: "right" }, expects: [branchExpectation("right")] },
      "merge-gate": { step: "merge", expects: [] }
    }
  };
}

function branchApprovalBundle(step) {
  const bundle = approvalBundle();
  bundle.claims[0].id = `claim.${step}`;
  bundle.claims[0].subjectType = "flow-step";
  bundle.claims[0].subjectId = step;
  bundle.evidence[0].id = `evidence.${step}`;
  bundle.evidence[0].claimId = `claim.${step}`;
  bundle.events[0].id = `event.${step}.verified`;
  bundle.events[0].claimId = `claim.${step}`;
  bundle.events[0].evidenceIds = [`evidence.${step}`];
  return bundle;
}

async function makeRun(cwd, flowDefinition = definition()) {
  await mkdir(cwd, { recursive: true });
  const defPath = path.join(cwd, "flow.json");
  await writeFile(defPath, JSON.stringify(flowDefinition));
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
    { from_step: "prepare", to_step: "verify", status: "allowed", gate_id: "prepare-gate", reason: "prepare passed", at: T0 }
  ];
  run.manifest.evidence = [
    {
      id: "ev.approval",
      gate_id: "verify-gate",
      kind: "trust.bundle",
      requested_kind: "trust.bundle",
      status: "passed",
      attached_at: T0,
      bundle: approvalBundle()
    }
  ];
  await writeFile(path.join(run.dir, "state.json"), `${JSON.stringify(run.state, null, 2)}\n`);
  await writeFile(path.join(run.dir, "evidence", "manifest.json"), `${JSON.stringify(run.manifest, null, 2)}\n`);
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

test("explicit evaluation of a pending downstream revisit fails closed before the run re-enters it", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-"));
  const runId = await makeRun(cwd);
  const run = await loadRun(runId, cwd);
  run.state.current_step = "prepare";
  run.state.transitions.push({
    type: "route_back",
    from_step: "release",
    to_step: "prepare",
    status: "blocked",
    reason: "release revision required",
    route_reason: "release revision required",
    selected_route: "prepare",
    attempt: 1,
    limit_exceeded: false,
    at: T0,
    gate_id: "release-gate"
  });
  await writeFile(path.join(run.dir, "state.json"), `${JSON.stringify(run.state, null, 2)}\n`);

  const result = await evaluateRun(runId, { cwd, gate: "verify-gate", now: T0 });
  const outcome = result.outcomes[0];
  assert.equal(outcome.status, "route-back", "the explicit off-current evaluation cannot reuse verify evidence");
  assert.deepEqual(outcome.evidence_refs, ["ev.approval"], "the pending outcome retains the evidence named by its diagnostic");
  assert.equal(outcome.diagnostics.claim_evaluation[0].evidence_id, "ev.approval");
  assert.equal(outcome.diagnostics.claim_evaluation[0].reason, "gate_reentry_pending");

  const after = await loadRun(runId, cwd);
  assert.equal(after.state.current_step, "prepare", "the stale explicit evaluation cannot advance the run past the route-back target");
  const verifyRouteBack = after.state.transitions.findLast((transition) => transition.gate_id === "verify-gate" && transition.type === "route_back");
  assert.deepEqual(verifyRouteBack?.evidence_refs, ["ev.approval"], "the persisted route-back keeps the diagnostic evidence id");
});

test("T1 evaluateRun automatically re-evaluates selected stale upstream evidence and invalidates descendants", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-"));
  const runId = await makeRun(cwd);

  await evaluateRun(runId, { cwd, gate: "verify-gate", now: T0 });
  const beforeExpiry = await loadRun(runId, cwd);
  beforeExpiry.state.current_step = "release";
  beforeExpiry.state.gate_outcomes.push({
    gate_id: "release-gate",
    status: "pass",
    summary: "release passed",
    evidence_refs: []
  });
  beforeExpiry.state.transitions.push({
    from_step: "release",
    to_step: null,
    status: "allowed",
    gate_id: "release-gate",
    reason: "release passed",
    at: T0
  });
  await writeFile(path.join(beforeExpiry.dir, "state.json"), `${JSON.stringify(beforeExpiry.state, null, 2)}\n`);

  const result = await evaluateRun(runId, { cwd, now: T1 });

  assert.equal(result.outcomes.length, 1, "the stale upstream gate preempts normal current-gate evaluation");
  assert.equal(result.outcomes[0].gate_id, "verify-gate");
  assert.equal(result.outcomes[0].status, "route-back");
  assert.equal(result.outcomes[0].route_back_to, "prepare", "the upstream gate's policy selects the target");
  assert.deepEqual(result.outcomes[0].evidence_refs, ["ev.approval"], "the route-back preserves selected evidence refs");

  const after = await loadRun(runId, cwd);
  assert.equal(after.state.current_step, "prepare");
  assert.equal(after.state.status, "active");
  assert.deepEqual(
    after.state.gate_outcomes.filter((outcome) => outcome.status === "pass").map((outcome) => outcome.gate_id),
    ["prepare-gate"],
    "the stale upstream pass and its downstream release pass are invalidated"
  );
  const routeBack = after.state.transitions.findLast((transition) => transition.type === "route_back");
  assert.deepEqual(routeBack?.invalidated_steps, ["verify", "release"]);
  assert.deepEqual(routeBack?.evidence_refs, ["ev.approval"], "the persisted audit transition retains evidence refs");
  assert.deepEqual(routeBack?.freshness_transitions, [{
    gate_id: "verify-gate",
    evidence_id: "ev.approval",
    claimId: "claim.approval",
    from: "fresh",
    to: "stale"
  }], "the persisted route-back canonically records its freshness trigger");
  assert.equal(routeBack?.at, T1, "the route-back uses the evaluation instant");
  assert.equal(after.state.updated_at, T1, "the state update uses the same evaluation instant");
});

test("simultaneously stale converging ancestors are routed back one at a time without losing the second recheck", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-converging-"));
  await writeFile(path.join(cwd, "flow.json"), JSON.stringify(convergingDefinition()));
  const { runId } = await startRun("flow.json", { cwd, runId: "converging-run" });
  const run = await loadRun(runId, cwd);
  run.state.current_step = "merge";
  run.state.status = "active";
  run.state.gate_outcomes = ["root", "left", "right"].map((step) => ({
    gate_id: `${step}-gate`,
    status: "pass",
    summary: `${step} passed`,
    evidence_refs: step === "root" ? [] : [`ev.${step}`],
    matched_expectations: step === "root" ? [] : [{ expectation_id: `${step}-fresh`, evidence_id: `ev.${step}` }]
  }));
  run.manifest.evidence = ["left", "right"].map((step) => ({
    id: `ev.${step}`,
    gate_id: `${step}-gate`,
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: T0,
    bundle: branchApprovalBundle(step)
  }));
  reDeriveBundleReports(run.manifest, new Date(T0));
  await writeFile(path.join(run.dir, "state.json"), `${JSON.stringify(run.state, null, 2)}\n`);
  await writeFile(path.join(run.dir, "evidence", "manifest.json"), `${JSON.stringify(run.manifest, null, 2)}\n`);

  const first = await evaluateRun(runId, { cwd, now: T1 });
  assert.equal(first.outcomes[0].gate_id, "left-gate");
  assert.equal(first.outcomes[0].route_back_to, "left");
  let after = await loadRun(runId, cwd);
  assert.deepEqual(after.state.pending_gate_rechecks, [{
    gate_id: "right-gate",
    evidence_id: "ev.right",
    claimId: "claim.right",
    from: "fresh",
    to: "stale"
  }], "the other stale ancestor remains durably pending");

  after.state.current_step = "merge";
  after.state.status = "active";
  after.state.gate_outcomes = after.state.gate_outcomes.filter((outcome) => outcome.gate_id !== "left-gate");
  after.state.gate_outcomes.push({
    gate_id: "left-gate",
    status: "pass",
    summary: "left repaired",
    evidence_refs: ["ev.left"],
    matched_expectations: [{ expectation_id: "left-fresh", evidence_id: "ev.left" }]
  });
  await writeFile(path.join(after.dir, "state.json"), `${JSON.stringify(after.state, null, 2)}\n`);

  const second = await evaluateRun(runId, { cwd, now: T1 });
  assert.equal(second.outcomes[0].gate_id, "right-gate");
  assert.equal(second.outcomes[0].route_back_to, "right");
  after = await loadRun(runId, cwd);
  assert.deepEqual(after.state.pending_gate_rechecks, [], "the second stale ancestor is consumed only after its route-back");
  assert.deepEqual(
    after.state.transitions.filter((transition) => transition.type === "route_back").map((transition) => transition.gate_id),
    ["left-gate", "right-gate"]
  );
});

test("budget-exhausted stale ancestor blocks at its gate and preserves freshness audit evidence", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-exhausted-"));
  const flowDefinition = definition();
  flowDefinition.gates["verify-gate"].route_back_policy = { max_attempts: 1, on_exceeded: "block" };
  const runId = await makeRun(cwd, flowDefinition);
  await evaluateRun(runId, { cwd, gate: "verify-gate", now: T0 });

  const beforeExpiry = await loadRun(runId, cwd);
  beforeExpiry.state.gate_outcomes.push({
    gate_id: "release-gate",
    status: "pass",
    summary: "release passed",
    evidence_refs: []
  });
  beforeExpiry.state.transitions.push({
    type: "route_back",
    gate_id: "verify-gate",
    route_reason: "missing_evidence",
    reason: "missing_evidence",
    from_step: "verify",
    to_step: "prepare",
    selected_route: "prepare",
    attempt: 1,
    max_attempts: 1,
    limit_exceeded: false,
    status: "blocked",
    at: T0
  });
  await writeFile(path.join(beforeExpiry.dir, "state.json"), `${JSON.stringify(beforeExpiry.state, null, 2)}\n`);

  const result = await evaluateRun(runId, { cwd, now: T1 });
  assert.equal(result.outcomes[0].gate_id, "verify-gate");
  assert.equal(result.outcomes[0].status, "block");
  assert.equal(result.outcomes[0].limit_exceeded, true);

  const after = await loadRun(runId, cwd);
  assert.equal(after.state.status, "blocked");
  assert.equal(after.state.current_step, "verify", "the blocked stale ancestor owns the cursor");
  assert.ok(!after.state.gate_outcomes.some((outcome) => outcome.gate_id === "release-gate" && outcome.status === "pass"));
  const blockedRoute = after.state.transitions.findLast((transition) => transition.gate_id === "verify-gate");
  assert.equal(blockedRoute.type, "route_back");
  assert.deepEqual(blockedRoute.invalidated_steps, ["release"]);
  assert.deepEqual(blockedRoute.freshness_transitions, [{
    gate_id: "verify-gate",
    evidence_id: "ev.approval",
    claimId: "claim.approval",
    from: "fresh",
    to: "stale"
  }]);
  assert.equal(blockedRoute.at, T1);

  const blockedTree = await hashRunTree(after.dir);
  const blockedTransitionCount = after.state.transitions.filter((transition) => transition.gate_id === "verify-gate").length;
  await assert.rejects(
    () => evaluateRun(runId, { cwd, now: T1 }),
    (error) => error.code === "flow.lifecycle.run_blocked"
  );
  assert.equal(await hashRunTree(after.dir), blockedTree, "an exhausted blocked ancestor is immutable without retry authority");
  const retried = await loadRun(runId, cwd);
  assert.equal(retried.state.current_step, "verify");
  assert.equal(retried.state.transitions.filter((transition) => transition.gate_id === "verify-gate").length, blockedTransitionCount);
});

test("T1 evaluateRun ignores stale evidence that was not selected by the passed upstream gate", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-"));
  const runId = await makeRun(cwd);
  await evaluateRun(runId, { cwd, gate: "verify-gate", now: T0 });

  const run = await loadRun(runId, cwd);
  run.manifest.evidence[0].bundle.claims[0].expiresAt = "2026-07-15T00:00:00.000Z";
  const unrelated = structuredClone(run.manifest.evidence[0]);
  unrelated.id = "ev.unrelated";
  unrelated.bundle.claims[0].expiresAt = EXPIRES;
  unrelated.bundle.claims[0].id = "claim.unrelated";
  unrelated.bundle.claims[0].claimType = "unrelated";
  unrelated.bundle.claims[0].facet = "process.unrelated";
  unrelated.bundle.evidence[0].id = "evidence.unrelated";
  unrelated.bundle.evidence[0].claimId = "claim.unrelated";
  unrelated.bundle.events[0].id = "event.unrelated.verified";
  unrelated.bundle.events[0].claimId = "claim.unrelated";
  unrelated.bundle.events[0].evidenceIds = ["evidence.unrelated"];
  run.manifest.evidence.push(unrelated);
  await writeFile(path.join(run.dir, "evidence", "manifest.json"), `${JSON.stringify(run.manifest, null, 2)}\n`);

  await evaluateRun(runId, { cwd, now: T0 });
  const result = await evaluateRun(runId, { cwd, now: T1 });

  assert.equal(result.outcomes[0].gate_id, "release-gate", "normal current-gate behavior remains in control");
  assert.equal(result.outcomes[0].status, "wait");
  const after = await loadRun(runId, cwd);
  assert.equal(after.state.current_step, "release");
  assert.ok(after.state.gate_outcomes.some((outcome) => outcome.gate_id === "verify-gate" && outcome.status === "pass"));
  assert.ok(!after.state.transitions.some((transition) => transition.type === "route_back"), "unselected stale evidence cannot route the run back");
});

test("T1 evaluateRun ignores selected stale evidence from a sibling gate", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-wallclock-sibling-"));
  const definitionPath = path.join(cwd, "flow.json");
  await writeFile(definitionPath, JSON.stringify(siblingDefinition()));
  const { runId } = await startRun("flow.json", { cwd, runId: "sibling-run" });
  const run = await loadRun(runId, cwd);
  const docsBundle = approvalBundle();
  docsBundle.claims[0].subjectType = "flow-step";
  docsBundle.claims[0].subjectId = "docs";
  run.state.current_step = "release";
  run.state.gate_outcomes = [
    { gate_id: "plan-gate", status: "pass", summary: "passed", evidence_refs: [] },
    { gate_id: "build-gate", status: "pass", summary: "passed", evidence_refs: [] },
    {
      gate_id: "docs-gate",
      status: "pass",
      summary: "docs approved",
      evidence_refs: ["ev.docs"],
      matched_expectations: [{ expectation_id: "docs-fresh", evidence_id: "ev.docs" }]
    }
  ];
  run.state.transitions = [
    { from_step: "plan", to_step: "build", status: "allowed", gate_id: "plan-gate", reason: "passed", at: T0 },
    { from_step: "build", to_step: "release", status: "allowed", gate_id: "build-gate", reason: "passed", at: T0 }
  ];
  run.manifest.evidence = [{
    id: "ev.docs",
    gate_id: "docs-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: T0,
    bundle: docsBundle
  }];
  await writeFile(path.join(run.dir, "state.json"), `${JSON.stringify(run.state, null, 2)}\n`);
  await writeFile(path.join(run.dir, "evidence", "manifest.json"), `${JSON.stringify(run.manifest, null, 2)}\n`);

  await evaluateRun(runId, { cwd, now: T0 });
  const result = await evaluateRun(runId, { cwd, now: T1 });

  assert.equal(result.outcomes[0].gate_id, "release-gate");
  assert.equal(result.outcomes[0].status, "wait");
  const after = await loadRun(runId, cwd);
  assert.equal(after.state.current_step, "release");
  assert.ok(after.state.gate_outcomes.some((outcome) => outcome.gate_id === "docs-gate" && outcome.status === "pass"));
  assert.ok(!after.state.transitions.some((transition) => transition.type === "route_back"), "a stale sibling gate cannot route another branch back");
});
