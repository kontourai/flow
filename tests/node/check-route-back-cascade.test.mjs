/**
 * Tests for the route-back cascade (Phase 1.5): descendantsOf and
 * invalidateDescendants, plus the end-to-end cascade through applyEvaluation.
 *
 * When a run routes back to an upstream target, every step downstream of the
 * target in the dependency DAG must re-run — its recorded gate outcomes (and
 * `allowed` transitions) are cleared so readiness re-derives them.  Route-back
 * transitions are preserved so attempt counting is unaffected.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  descendantsOf,
  invalidateDescendants,
  applyEvaluation,
  evaluateGate,
  routeBackAttempt,
  FLOW_SCHEMA_VERSION
} from "../../dist/index.js";

// ---------------------------------------------------------------------------
// Fixtures — a diamond DAG so a route-back fans out to multiple dependents:
//
//   plan ─┬─> build ─┐
//         └─> docs  ─┴─> verify
// ---------------------------------------------------------------------------

function diamondDefinition() {
  return {
    id: "diamond-flow",
    version: "1",
    steps: [
      { id: "plan",   next: "build" },
      { id: "build",  next: "verify", needs: ["plan"] },
      { id: "docs",   next: "verify", needs: ["plan"] },
      { id: "verify", next: null,     needs: ["build", "docs"] }
    ],
    gates: {
      "plan-gate":   { step: "plan",   expects: [] },
      "build-gate":  { step: "build",  expects: [] },
      "docs-gate":   { step: "docs",   expects: [] },
      "verify-gate": { step: "verify", expects: [], on_route_back: { default: "plan" } }
    }
  };
}

/** State with the given gates passed (and matching allowed transitions). */
function passedState(currentStep, passedGates) {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: "test-run",
    definition_id: "diamond-flow",
    definition_version: "1",
    subject: "test",
    status: "active",
    current_step: currentStep,
    gate_outcomes: passedGates.map((gateId) => ({
      gate_id: gateId,
      status: "pass",
      summary: "passed",
      evidence_refs: []
    })),
    transitions: passedGates.map((gateId) => ({
      from_step: gateId.replace(/-gate$/, ""),
      to_step: null,
      status: "allowed",
      gate_id: gateId,
      reason: "required evidence present",
      at: "2026-01-01T00:00:00.000Z"
    })),
    exceptions: [],
    next_action: "attach evidence",
    updated_at: "2026-01-01T00:00:00.000Z"
  };
}

// ---------------------------------------------------------------------------
// descendantsOf
// ---------------------------------------------------------------------------

test("descendantsOf: fan-out target returns all transitive dependents in order", () => {
  const def = diamondDefinition();
  assert.deepEqual(descendantsOf(def, "plan"), ["build", "docs", "verify"]);
});

test("descendantsOf: mid-graph target returns only downstream", () => {
  const def = diamondDefinition();
  assert.deepEqual(descendantsOf(def, "build"), ["verify"]);
});

test("descendantsOf: terminal step has no descendants", () => {
  const def = diamondDefinition();
  assert.deepEqual(descendantsOf(def, "verify"), []);
});

test("descendantsOf: unknown step has no descendants", () => {
  const def = diamondDefinition();
  assert.deepEqual(descendantsOf(def, "nonexistent"), []);
});

// ---------------------------------------------------------------------------
// invalidateDescendants
// ---------------------------------------------------------------------------

test("invalidateDescendants: clears descendant outcomes, keeps target + ancestors", () => {
  const def = diamondDefinition();
  const state = passedState("verify", ["plan-gate", "build-gate", "docs-gate"]);

  const invalidated = invalidateDescendants(def, state, "plan");

  assert.deepEqual(invalidated, ["build", "docs", "verify"]);
  // Only plan-gate survives; build/docs/verify gate outcomes are cleared.
  assert.deepEqual(state.gate_outcomes.map((o) => o.gate_id), ["plan-gate"]);
  // Allowed transitions for descendant steps are cleared; plan's remains.
  const remaining = state.transitions.map((t) => t.from_step);
  assert.ok(remaining.includes("plan"), "plan transition preserved");
  assert.ok(!remaining.includes("build"), "build transition cleared");
  assert.ok(!remaining.includes("docs"), "docs transition cleared");
});

test("invalidateDescendants: mid-graph target leaves siblings untouched", () => {
  const def = diamondDefinition();
  const state = passedState("verify", ["plan-gate", "build-gate", "docs-gate"]);

  const invalidated = invalidateDescendants(def, state, "build");

  assert.deepEqual(invalidated, ["verify"]);
  // build's sibling docs and the upstream plan keep their outcomes.
  assert.deepEqual(
    state.gate_outcomes.map((o) => o.gate_id).sort(),
    ["build-gate", "docs-gate", "plan-gate"]
  );
});

test("invalidateDescendants: terminal target is a no-op", () => {
  const def = diamondDefinition();
  const state = passedState("verify", ["plan-gate", "build-gate", "docs-gate"]);
  const before = state.gate_outcomes.length;

  const invalidated = invalidateDescendants(def, state, "verify");

  assert.deepEqual(invalidated, []);
  assert.equal(state.gate_outcomes.length, before);
});

// ---------------------------------------------------------------------------
// applyEvaluation — end-to-end cascade
// ---------------------------------------------------------------------------

test("applyEvaluation route-back: cascades to descendants and resets the cursor", () => {
  const def = diamondDefinition();
  const state = passedState("verify", ["plan-gate", "build-gate", "docs-gate"]);

  const outcome = {
    gate_id: "verify-gate",
    status: "route-back",
    route_back_to: "plan",
    route_reason: "tests_failed",
    reason: "tests_failed",
    selected_route: "plan",
    attempt: 1,
    max_attempts: 3,
    summary: "verification failed",
    evidence_refs: []
  };

  applyEvaluation(def, state, outcome);

  // Cursor walks back to the target and the run is active again.
  assert.equal(state.current_step, "plan");
  assert.equal(state.status, "active");

  // Stale descendant passes (build, docs) are cleared so they re-run; the
  // upstream plan pass and the failing verify route-back outcome are preserved.
  const byGate = Object.fromEntries(state.gate_outcomes.map((o) => [o.gate_id, o.status]));
  assert.deepEqual(byGate, { "plan-gate": "pass", "verify-gate": "route-back" });

  // The route-back transition records what was invalidated, for audit.
  const routeBack = state.transitions.find((t) => t.type === "route_back");
  assert.ok(routeBack, "route_back transition recorded");
  assert.deepEqual(routeBack.invalidated_steps, ["build", "docs", "verify"]);
});

test("applyEvaluation route-back: preserves attempt counting across the cascade", () => {
  const def = diamondDefinition();
  const state = passedState("verify", ["plan-gate", "build-gate", "docs-gate"]);

  const outcome = {
    gate_id: "verify-gate",
    status: "route-back",
    route_back_to: "plan",
    route_reason: "tests_failed",
    reason: "tests_failed",
    selected_route: "plan",
    attempt: 1,
    max_attempts: 3,
    summary: "verification failed",
    evidence_refs: []
  };

  applyEvaluation(def, state, outcome);

  // The route-back transition survives the cascade, so a subsequent attempt
  // with the same params counts as attempt #2.
  const nextAttempt = routeBackAttempt(state, {
    gateId: "verify-gate",
    routeReason: "tests_failed",
    fromStep: "verify",
    toStep: "plan"
  });
  assert.equal(nextAttempt, 2);
});

test("evaluateGate scopes evidence to the latest visit while retaining prior evidence for audit", () => {
  const definition = diamondDefinition();
  const state = passedState("verify", ["plan-gate", "build-gate", "docs-gate"]);
  state.transitions.push({
    from_step: "build",
    to_step: "verify",
    status: "allowed",
    reason: "corrected implementation re-entered verification",
    at: "2026-01-02T00:00:00.000Z",
    gate_id: "build-gate"
  });
  const manifest = {
    evidence: [
      { id: "old-failure", gate_id: "verify-gate", kind: "file", requested_kind: "file", status: "failed", attached_at: "2026-01-01T12:00:00.000Z" },
      { id: "current-observation", gate_id: "verify-gate", kind: "file", requested_kind: "file", status: "passed", attached_at: "2026-01-02T00:01:00.000Z" }
    ]
  };

  const outcome = evaluateGate(definition, state, manifest, "verify-gate");
  assert.equal(outcome.status, "wait", "the old failure no longer governs the new visit");
  assert.equal(manifest.evidence.length, 2, "historical failed evidence remains auditable");

  manifest.evidence.push({ id: "current-failure", gate_id: "verify-gate", kind: "file", requested_kind: "file", status: "failed", attached_at: "2026-01-02T00:02:00.000Z" });
  assert.equal(evaluateGate(definition, state, manifest, "verify-gate").status, "route-back", "a failure from the current visit still governs the gate");
});
