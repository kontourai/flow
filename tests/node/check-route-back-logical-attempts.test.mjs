/**
 * Regression for kontourai/flow#153: route-back attempts must count logical
 * failures, not evidence re-evaluations. A gate that self-loops on
 * `missing_evidence` and is re-evaluated while still missing required evidence
 * must NOT exhaust its route-back budget on synchronization cycles. Only a
 * materially new failed gate visit — a re-entry after the run left the gate's
 * step, or a new failed-evidence id in the same visit — may increment.
 *
 * Mirrors the route-back cascade tests in style (state + applyEvaluation).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvaluation,
  evaluateGate,
  FLOW_SCHEMA_VERSION,
  initialState,
  routeBackAttempt
} from "../../dist/index.js";

// Linear flow with a self-loop missing_evidence gate. The verify step's gate
// routes missing_evidence back to itself, which is the exact shape that
// produced the original budget-exhaustion bug.
function selfLoopMissingEvidenceDefinition() {
  return {
    id: "logical-route-back-fixture",
    version: "1",
    steps: [
      { id: "implement", next: "verify" },
      { id: "verify", next: null }
    ],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [
          {
            id: "required-claim",
            kind: "trust.bundle",
            required: true,
            description: "Required claim that the partial evidence never satisfies.",
            bundle_claim: { claimType: "quality.tests", subjectId: "verify", accepted_statuses: ["verified"] }
          }
        ],
        on_route_back: {
          missing_evidence: "verify",
          implementation_defect: "verify",
          default: "verify"
        },
        route_back_policy: { max_attempts: 3, on_exceeded: "block" }
      }
    }
  };
}

function baselineState(currentStep = "verify") {
  const state = initialState(selfLoopMissingEvidenceDefinition(), "logical-attempts");
  state.current_step = currentStep;
  return state;
}

function attachAt(manifest, evidence) {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    evidence: [...(manifest?.evidence ?? []), evidence]
  };
}

function passingEvidence(id) {
  return {
    id,
    gate_id: "verify-gate",
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    attached_at: "2026-07-19T15:00:00.000Z",
    bundle: {
      claims: [{ id: `claim.${id}`, claimType: "quality.other", subjectType: "flow-step", subjectId: "verify", status: "verified", createdAt: "2026-07-19T14:00:00.000Z", updatedAt: "2026-07-19T14:00:00.000Z" }],
      evidence: [],
      events: [],
      authorityTrace: [],
      policies: []
    }
  };
}

function failedEvidence(id, routeReason = "implementation_defect", attachedAt = "2026-07-19T15:01:30.000Z") {
  return {
    id,
    gate_id: "verify-gate",
    kind: "file",
    requested_kind: "file",
    status: "failed",
    attached_at: attachedAt,
    route_reason: routeReason
  };
}

test("self-loop missing_evidence re-evaluation does not increment the attempt counter", () => {
  const definition = selfLoopMissingEvidenceDefinition();

  // First evaluation: no evidence attached. Gate routes back with
  // missing_evidence and the first route-back records attempt 1.
  let state = baselineState();
  let outcome = evaluateGate(definition, state, { schema_version: FLOW_SCHEMA_VERSION, evidence: [] }, "verify-gate");
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.route_reason, "missing_evidence");
  assert.equal(outcome.attempt, 1);
  assert.deepEqual(outcome.failed_evidence_refs, []);
  applyEvaluation(definition, state, outcome);
  const firstRouteBack = state.transitions.at(-1);
  assert.equal(firstRouteBack.attempt, 1);
  assert.deepEqual(firstRouteBack.failed_evidence_refs, []);

  // Attach partial evidence that does NOT satisfy the required expectation.
  // The gate still routes back with missing_evidence. Under the #153 fix the
  // failed-evidence set is unchanged (still empty) and the visit has not been
  // re-entered, so this evaluation replays attempt 1 instead of exhausting
  // the budget.
  let manifest = attachAt(null, passingEvidence("ev.partial-1"));
  outcome = evaluateGate(definition, state, manifest, "verify-gate", undefined, "2026-07-19T15:01:00.000Z");
  assert.equal(outcome.status, "route-back", "partial evidence still routes back via missing_evidence");
  assert.equal(outcome.attempt, 1, "partial evidence re-evaluation must NOT increment (issue #153)");
  assert.equal(outcome.limit_exceeded, false);
  applyEvaluation(definition, state, outcome, "2026-07-19T15:01:00.000Z");

  // Attach another piece of partial evidence. Same logical failure: the
  // required expectation is still missing and no failed entry exists.
  manifest = attachAt(manifest, passingEvidence("ev.partial-2"));
  outcome = evaluateGate(definition, state, manifest, "verify-gate", undefined, "2026-07-19T15:02:00.000Z");
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.attempt, 1, "another partial attachment still replays attempt 1");
  applyEvaluation(definition, state, outcome, "2026-07-19T15:02:00.000Z");

  // The route-back transitions are persisted (audit) but all carry attempt 1.
  const missingAttempts = state.transitions
    .filter((transition) => transition.type === "route_back" && transition.route_reason === "missing_evidence")
    .map((transition) => transition.attempt);
  assert.deepEqual(missingAttempts, [1, 1, 1], "idempotent replay writes attempt 1 for each re-evaluation");
});

test("a new failed-evidence id in the same visit increments the attempt exactly once", () => {
  const definition = selfLoopMissingEvidenceDefinition();
  let state = baselineState();
  let manifest = { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };

  // Burn the first missing-evidence logical attempt.
  let outcome = evaluateGate(definition, state, manifest, "verify-gate");
  assert.equal(outcome.attempt, 1);
  applyEvaluation(definition, state, outcome);

  // Re-evaluate with another partial attachment — replays attempt 1.
  manifest = attachAt(manifest, passingEvidence("ev.partial"));
  outcome = evaluateGate(definition, state, manifest, "verify-gate", undefined, "2026-07-19T15:01:00.000Z");
  assert.equal(outcome.attempt, 1, "same failed set within the visit replays");
  applyEvaluation(definition, state, outcome, "2026-07-19T15:01:00.000Z");

  // Now attach a piece of failed evidence that genuinely fails the gate, with
  // route_reason="missing_evidence" so it shares the same route-back loop.
  // The failed-evidence set grows from [] to [ev.failed], which is a
  // materially new logical failure within the same visit: attempt increments
  // exactly once to 2.
  manifest = attachAt(manifest, failedEvidence("ev.failed", "missing_evidence"));
  outcome = evaluateGate(definition, state, manifest, "verify-gate", undefined, "2026-07-19T15:02:00.000Z");
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.route_reason, "missing_evidence");
  assert.equal(outcome.attempt, 2, "a new failed-evidence id increments exactly once");
  assert.deepEqual(outcome.failed_evidence_refs, ["ev.failed"]);
  applyEvaluation(definition, state, outcome, "2026-07-19T15:02:00.000Z");

  // Re-evaluating the same failed evidence replays attempt 2 — no further
  // increment until something material changes again.
  outcome = evaluateGate(definition, state, manifest, "verify-gate", undefined, "2026-07-19T15:03:00.000Z");
  assert.equal(outcome.attempt, 2, "same failed set replays the latest attempt");
});

test("re-entry into the gate's step starts a new logical attempt", () => {
  const definition = selfLoopMissingEvidenceDefinition();
  const state = baselineState();

  // Record a first missing_evidence route-back.
  let manifest = { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };
  let outcome = evaluateGate(definition, state, manifest, "verify-gate");
  applyEvaluation(definition, state, outcome);
  assert.equal(outcome.attempt, 1);

  // The run leaves verify for implement and comes back. The re-entry into
  // verify is the persisted-state signal of a new gate visit.
  state.transitions.push({ from_step: "verify", to_step: "implement", status: "allowed", reason: "left to redo implementation", at: "2026-07-19T16:00:00.000Z", gate_id: "verify-gate" });
  state.transitions.push({ from_step: "implement", to_step: "verify", status: "allowed", reason: "returned to verification", at: "2026-07-19T16:30:00.000Z", gate_id: "implement-gate-implicit" });

  outcome = evaluateGate(definition, state, manifest, "verify-gate");
  assert.equal(outcome.attempt, 2, "re-entry into the gate's step begins a new logical attempt");
  assert.deepEqual(outcome.failed_evidence_refs, []);
});

test("routeBackAttempt treats consecutive non-self-loop route-backs as distinct visits (legacy compatibility)", () => {
  // Existing retry-authorization fixtures stack non-self-loop route-backs
  // verify→implement without intervening allowed transitions. Each prior
  // non-self-loop route-back ends the current visit, so the next one starts a
  // new logical attempt. This preserves the OLD counting behavior for any
  // persisted history built before #153.
  const state = baselineState("verify");
  state.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-07-19T15:01:00.000Z" },
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-07-19T15:02:00.000Z" }
  ];

  const attempt = routeBackAttempt(state, {
    gateId: "verify-gate",
    routeReason: "implementation_defect",
    fromStep: "verify",
    toStep: "implement"
  });
  assert.equal(attempt, 3, "prior non-self-loop route-backs each count as a new visit");
});
