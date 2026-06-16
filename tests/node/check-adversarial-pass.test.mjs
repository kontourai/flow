import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvaluation, evaluateGate, initialState, validateDefinition, validateRunTransition } from "../../dist/index.js";
import { json } from "./helpers/fixtures.mjs";
import { failedEvidence, routeBackDefinition, routeBackManifest } from "./helpers/route-back-fixtures.mjs";

test("adversarial-pass reference definition validates and documents route targets", async () => {
  const definition = await json("examples/adversarial-pass-flow.json");
  assert.equal(definition.id, "adversarial-pass-flow");
  assert.deepEqual(definition.steps.map((step) => step.id), ["produce", "adversarial-review", "resolve"]);

  const gate = definition.gates["adversarial-review-gate"];
  assert.equal(gate.step, "adversarial-review");
  assert.ok(gate.expects.every((expectation) => expectation.kind === "trust.bundle"));
  assert.deepEqual(gate.on_route_back, {
    conclusion_defect: "produce",
    framing_defect: "produce",
    completeness_defect: "produce",
    citation_defect: "resolve",
    missing_evidence: "adversarial-review",
    default: "resolve"
  });
  assert.deepEqual(gate.route_back_policy, {
    max_attempts: 2,
    on_exceeded: "block"
  });
  assert.doesNotThrow(() => validateDefinition(definition));
});

test("failed evidence routes standard route reasons to mapped steps", () => {
  const definition = routeBackDefinition();
  const cases = [
    ["missing_evidence", "verify"],
    ["implementation_defect", "implement"],
    ["plan_gap", "plan"],
    ["decision_gap", "plan"]
  ];

  for (const [routeReason, targetStep] of cases) {
    const state = initialState(definition, `route-${routeReason}`);
    state.current_step = "verify";
    const outcome = evaluateGate(definition, state, routeBackManifest([
      failedEvidence({ id: `ev.${routeReason}`, route_reason: routeReason })
    ]), "verify-gate");
    assert.equal(outcome.status, "route-back");
    assert.equal(outcome.route_reason, routeReason);
    assert.equal(outcome.reason, routeReason);
    assert.equal(outcome.route_back_to, targetStep);
    assert.equal(outcome.attempt, 1);
  }
});

test("adversarial-pass defect reasons route to documented targets and enforce per-case budget", async () => {
  const definition = await json("examples/adversarial-pass-flow.json");
  const gateId = "adversarial-review-gate";
  const cases = [
    ["conclusion_defect", "produce"],
    ["framing_defect", "produce"],
    ["completeness_defect", "produce"],
    ["citation_defect", "resolve"]
  ];

  for (const [routeReason, targetStep] of cases) {
    const state = initialState(definition, `adversarial-${routeReason}`);
    state.current_step = "adversarial-review";
    const manifest = routeBackManifest([
      {
        id: `ev.${routeReason}`,
        gate_id: gateId,
        kind: "trust.bundle",
        requested_kind: "trust.bundle",
        status: "failed",
        route_reason: routeReason,
        attached_at: "2026-06-08T00:00:00.000Z"
      }
    ]);
    const outcome = evaluateGate(definition, state, manifest, gateId);
    assert.equal(outcome.status, "route-back", routeReason);
    assert.equal(outcome.route_reason, routeReason);
    assert.equal(outcome.route_back_to, targetStep);
    assert.equal(outcome.selected_route, targetStep);
    assert.equal(outcome.attempt, 1);

    const validation = validateRunTransition({
      definition,
      current_state: state,
      proposed_transition: {
        type: "route_back",
        from_step: "adversarial-review",
        to_step: targetStep,
        status: "route-back",
        gate_id: gateId,
        route_reason: routeReason,
        evidence_refs: [`ev.${routeReason}`]
      },
      manifest
    });
    assert.equal(validation.valid, true, routeReason);
    assert.equal(validation.transition.to_step, targetStep);
    assert.equal(validation.transition.attempt, 1);
    assert.equal(validation.transition.max_attempts, 2);
  }

  const exceededState = initialState(definition, "adversarial-budget-exceeded");
  exceededState.current_step = "adversarial-review";
  exceededState.transitions = [
    { type: "route_back", gate_id: gateId, route_reason: "conclusion_defect", from_step: "adversarial-review", to_step: "produce", status: "blocked", reason: "conclusion_defect", at: "2026-06-08T00:00:00.000Z" },
    { type: "route_back", gate_id: gateId, route_reason: "conclusion_defect", from_step: "adversarial-review", to_step: "produce", status: "blocked", reason: "conclusion_defect", at: "2026-06-08T00:01:00.000Z" },
    { type: "route_back", gate_id: gateId, route_reason: "framing_defect", from_step: "adversarial-review", to_step: "produce", status: "blocked", reason: "framing_defect", at: "2026-06-08T00:02:00.000Z" }
  ];
  const exceededManifest = routeBackManifest([
    {
      id: "ev.conclusion-budget",
      gate_id: gateId,
      kind: "trust.bundle",
      requested_kind: "trust.bundle",
      status: "failed",
      route_reason: "conclusion_defect",
      attached_at: "2026-06-08T00:03:00.000Z"
    }
  ]);
  const exceededOutcome = evaluateGate(definition, exceededState, exceededManifest, gateId);
  assert.equal(exceededOutcome.status, "block");
  assert.equal(exceededOutcome.route_back_to, "produce");
  assert.equal(exceededOutcome.selected_route, "produce");
  assert.equal(exceededOutcome.route_reason, "conclusion_defect");
  assert.equal(exceededOutcome.attempt, 3);
  assert.equal(exceededOutcome.max_attempts, 2);
  assert.equal(exceededOutcome.limit_exceeded, true);

  const exceededValidation = validateRunTransition({
    definition,
    current_state: exceededState,
    proposed_transition: {
      type: "route_back",
      from_step: "adversarial-review",
      to_step: "produce",
      status: "route-back",
      gate_id: gateId,
      route_reason: "conclusion_defect",
      evidence_refs: ["ev.conclusion-budget"]
    },
    manifest: exceededManifest
  });
  assert.equal(exceededValidation.valid, false);
  assert.equal(exceededValidation.status, "blocked");
  assert.equal(exceededValidation.transition.attempt, 3);
  assert.equal(exceededValidation.transition.max_attempts, 2);
  assert.equal(exceededValidation.transition.limit_exceeded, true);
});

test("adversarial-pass reference routes missing required evidence to adversarial review", async () => {
  const definition = await json("examples/adversarial-pass-flow.json");
  const gateId = "adversarial-review-gate";
  const state = initialState(definition, "adversarial-missing-evidence");
  state.current_step = "adversarial-review";
  const manifest = routeBackManifest([]);

  const outcome = evaluateGate(definition, state, manifest, gateId);
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.route_reason, "missing_evidence");
  assert.equal(outcome.reason, "missing_evidence");
  assert.equal(outcome.route_back_to, "adversarial-review");
  assert.equal(outcome.selected_route, "adversarial-review");
  assert.deepEqual(outcome.expectation_ids, ["producer-output-claim", "adversarial-review-claim"]);

  const validation = validateRunTransition({
    definition,
    current_state: state,
    proposed_transition: {
      type: "route_back",
      from_step: "adversarial-review",
      to_step: "adversarial-review",
      status: "route-back",
      gate_id: gateId,
      route_reason: "missing_evidence",
      expectation_ids: ["producer-output-claim", "adversarial-review-claim"]
    },
    manifest
  });
  assert.equal(validation.valid, true);
  assert.equal(validation.transition.route_reason, "missing_evidence");
  assert.equal(validation.transition.to_step, "adversarial-review");
});

test("adversarial-pass reference uses default route for omitted and unmapped failed-evidence reasons", async () => {
  const definition = await json("examples/adversarial-pass-flow.json");
  const gateId = "adversarial-review-gate";
  const cases = [
    ["omitted", {}, undefined, "default"],
    ["unmapped", { route_reason: "vendor_unknown" }, "vendor_unknown", "vendor_unknown"]
  ];

  for (const [name, routeFields, expectedRouteReason, expectedReason] of cases) {
    const state = initialState(definition, `adversarial-default-${name}`);
    state.current_step = "adversarial-review";
    const manifest = routeBackManifest([
      {
        id: `ev.default-${name}`,
        gate_id: gateId,
        kind: "trust.bundle",
        requested_kind: "trust.bundle",
        status: "failed",
        attached_at: "2026-06-08T00:00:00.000Z",
        ...routeFields
      }
    ]);

    const outcome = evaluateGate(definition, state, manifest, gateId);
    assert.equal(outcome.status, "route-back", name);
    assert.equal(outcome.route_reason, expectedRouteReason, name);
    assert.equal(outcome.reason, expectedReason, name);
    assert.equal(outcome.route_back_to, "resolve", name);
    assert.equal(outcome.selected_route, "resolve", name);

    const validation = validateRunTransition({
      definition,
      current_state: state,
      proposed_transition: {
        type: "route_back",
        from_step: "adversarial-review",
        to_step: "resolve",
        status: "route-back",
        gate_id: gateId,
        ...(expectedRouteReason ? { route_reason: expectedRouteReason } : {}),
        evidence_refs: [`ev.default-${name}`]
      },
      manifest
    });
    assert.equal(validation.valid, true, name);
    assert.equal(validation.transition.to_step, "resolve", name);
    assert.equal(validation.transition.selected_route, "resolve", name);
  }
});

test("adversarial-pass reference counts persisted default route-backs against the budget", async () => {
  const definition = await json("examples/adversarial-pass-flow.json");
  const gateId = "adversarial-review-gate";
  const state = initialState(definition, "adversarial-default-budget-exceeded");
  state.current_step = "adversarial-review";
  state.transitions = [
    { type: "route_back", gate_id: gateId, reason: "default", from_step: "adversarial-review", to_step: "resolve", status: "blocked", at: "2026-06-08T00:00:00.000Z" },
    { type: "route_back", gate_id: gateId, reason: "default", from_step: "adversarial-review", to_step: "resolve", status: "blocked", at: "2026-06-08T00:01:00.000Z" },
    { type: "route_back", gate_id: gateId, route_reason: "citation_defect", reason: "citation_defect", from_step: "adversarial-review", to_step: "resolve", status: "blocked", at: "2026-06-08T00:02:00.000Z" }
  ];
  const manifest = routeBackManifest([
    {
      id: "ev.default-budget",
      gate_id: gateId,
      kind: "trust.bundle",
      requested_kind: "trust.bundle",
      status: "failed",
      attached_at: "2026-06-08T00:03:00.000Z"
    }
  ]);

  const outcome = evaluateGate(definition, state, manifest, gateId);
  assert.equal(outcome.status, "block");
  assert.equal(outcome.reason, "default");
  assert.equal(outcome.route_reason, undefined);
  assert.equal(outcome.route_back_to, "resolve");
  assert.equal(outcome.selected_route, "resolve");
  assert.equal(outcome.attempt, 3);
  assert.equal(outcome.max_attempts, 2);
  assert.equal(outcome.limit_exceeded, true);

  const validation = validateRunTransition({
    definition,
    current_state: state,
    proposed_transition: {
      type: "route_back",
      from_step: "adversarial-review",
      to_step: "resolve",
      status: "route-back",
      gate_id: gateId,
      reason: "default",
      evidence_refs: ["ev.default-budget"]
    },
    manifest
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.status, "blocked");
  assert.equal(validation.transition.reason, "default");
  assert.equal(validation.transition.attempt, 3);
  assert.equal(validation.transition.max_attempts, 2);
  assert.equal(validation.transition.limit_exceeded, true);
});

test("missing required evidence may infer missing_evidence only when Flow detects the missing expectation", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "missing-evidence-route");
  state.current_step = "verify";
  const outcome = evaluateGate(definition, state, routeBackManifest([]), "verify-gate");
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.route_reason, "missing_evidence");
  assert.equal(outcome.route_back_to, "verify");
  assert.deepEqual(outcome.expectation_ids, ["tests-passed"]);
});

test("missing and unknown route reasons use default or gate step fallback", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "fallbacks");
  state.current_step = "verify";

  const missingReason = evaluateGate(definition, state, routeBackManifest([
    failedEvidence({ id: "ev.no-reason" })
  ]), "verify-gate");
  assert.equal(missingReason.route_reason, undefined);
  assert.equal(missingReason.reason, "default");
  assert.equal(missingReason.route_back_to, "implement");

  const unknownReason = evaluateGate(definition, state, routeBackManifest([
    failedEvidence({ id: "ev.unknown", route_reason: "vendor_unknown" })
  ]), "verify-gate");
  assert.equal(unknownReason.route_reason, "vendor_unknown");
  assert.equal(unknownReason.route_back_to, "implement");

  const fallbackDefinition = routeBackDefinition({ on_route_back: undefined, route_back_policy: undefined });
  const fallbackMissingReason = evaluateGate(fallbackDefinition, state, routeBackManifest([
    failedEvidence({ id: "ev.fallback-no-reason" })
  ]), "verify-gate");
  assert.equal(fallbackMissingReason.route_back_to, "verify");
  assert.equal(fallbackMissingReason.reason, "default");

  const fallbackUnknownReason = evaluateGate(fallbackDefinition, state, routeBackManifest([
    failedEvidence({ id: "ev.fallback-unknown", route_reason: "vendor_unknown" })
  ]), "verify-gate");
  assert.equal(fallbackUnknownReason.route_reason, "vendor_unknown");
  assert.equal(fallbackUnknownReason.route_back_to, "verify");
});

test("route-back attempts count only matching persisted transitions", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "attempt-count");
  state.current_step = "verify";
  state.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:00:00.000Z" },
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:01:00.000Z" },
    { type: "route_back", gate_id: "verify-gate", route_reason: "plan_gap", from_step: "verify", to_step: "plan", status: "blocked", reason: "plan_gap", at: "2026-05-26T00:02:00.000Z" },
    { type: "route_back", gate_id: "other-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:03:00.000Z" },
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "plan", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:04:00.000Z" },
    { from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:05:00.000Z", gate_id: "verify-gate" }
  ];
  const outcome = evaluateGate(definition, state, routeBackManifest([
    failedEvidence({ route_reason: "implementation_defect" })
  ]), "verify-gate");
  assert.equal(outcome.attempt, 3);
  assert.equal(outcome.limit_exceeded, true);
});

test("max-attempt exceeded routes to recovery step or blocks with persisted route metadata", () => {
  const recoveryDefinition = routeBackDefinition({
    route_back_policy: { max_attempts: 1, on_exceeded: "recover" }
  });
  const recoveryState = initialState(recoveryDefinition, "recovery");
  recoveryState.current_step = "verify";
  recoveryState.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:00:00.000Z" }
  ];
  const recoveryOutcome = evaluateGate(recoveryDefinition, recoveryState, routeBackManifest([
    failedEvidence({ id: "ev.recovery", route_reason: "implementation_defect", expectation_ids: ["tests-passed"] })
  ]), "verify-gate");
  assert.equal(recoveryOutcome.status, "route-back");
  assert.equal(recoveryOutcome.route_back_to, "recover");
  assert.equal(recoveryOutcome.attempt, 2);
  assert.equal(recoveryOutcome.limit_exceeded, true);
  applyEvaluation(recoveryDefinition, recoveryState, recoveryOutcome);
  assert.equal(recoveryState.current_step, "recover");
  assert.equal(recoveryState.transitions.at(-1).type, "route_back");
  assert.equal(recoveryState.transitions.at(-1).route_reason, "implementation_defect");
  assert.equal(recoveryState.transitions.at(-1).selected_route, "implement");
  assert.equal(recoveryState.transitions.at(-1).recovery_step, "recover");
  assert.equal(recoveryState.transitions.at(-1).attempt, 2);
  assert.equal(recoveryState.transitions.at(-1).max_attempts, 1);
  assert.equal(recoveryState.transitions.at(-1).limit_exceeded, true);
  assert.deepEqual(recoveryState.transitions.at(-1).evidence_refs, ["ev.recovery"]);
  assert.deepEqual(recoveryState.transitions.at(-1).expectation_ids, ["tests-passed"]);

  const blockDefinition = routeBackDefinition({
    route_back_policy: { max_attempts: 1, on_exceeded: "block" }
  });
  const blockState = initialState(blockDefinition, "block");
  blockState.current_step = "verify";
  blockState.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "plan_gap", from_step: "verify", to_step: "plan", status: "blocked", reason: "plan_gap", at: "2026-05-26T00:00:00.000Z" }
  ];
  const blockOutcome = evaluateGate(blockDefinition, blockState, routeBackManifest([
    failedEvidence({ id: "ev.block", route_reason: "plan_gap" })
  ]), "verify-gate");
  assert.equal(blockOutcome.status, "block");
  assert.equal(blockOutcome.route_back_to, "plan");
  assert.equal(blockOutcome.limit_exceeded, true);
  applyEvaluation(blockDefinition, blockState, blockOutcome);
  assert.equal(blockState.status, "blocked");
  assert.equal(blockState.current_step, "verify");
  assert.equal(blockState.transitions.at(-1).type, "route_back");
  assert.equal(blockState.transitions.at(-1).limit_exceeded, true);
  assert.equal(blockState.transitions.at(-1).selected_route, "plan");
  assert.equal(blockState.transitions.at(-1).attempt, 2);
  assert.equal(blockState.transitions.at(-1).max_attempts, 1);
  assert.deepEqual(blockState.transitions.at(-1).evidence_refs, ["ev.block"]);
});

test("metadata other than route_reason is recorded but does not influence routing or attempts", () => {
  const definition = routeBackDefinition();
  const baseState = initialState(definition, "metadata-base");
  baseState.current_step = "verify";
  const noisyState = initialState(definition, "metadata-noisy");
  noisyState.current_step = "verify";
  noisyState.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", classifier: { kind: "different" }, diagnostics: { code: "old" }, analytics: { loop_key: "old" }, at: "2026-05-26T00:00:00.000Z" }
  ];

  const base = evaluateGate(definition, baseState, routeBackManifest([
    failedEvidence({
      route_reason: "implementation_defect",
      classifier: { kind: "probe", confidence: 0.1 },
      diagnostics: { claimed_target: "plan" },
      analytics: { loop_key: "a" }
    })
  ]), "verify-gate");
  assert.equal(base.route_back_to, "implement");
  assert.equal(base.attempt, 1);
  assert.deepEqual(base.classifier, { kind: "probe", confidence: 0.1 });

  const noisy = evaluateGate(definition, noisyState, routeBackManifest([
    failedEvidence({
      route_reason: "implementation_defect",
      classifier: { kind: "probe", confidence: 0.99 },
      diagnostics: { claimed_target: "recover" },
      analytics: { loop_key: "b" }
    })
  ]), "verify-gate");
  assert.equal(noisy.route_back_to, "implement");
  assert.equal(noisy.attempt, 2);
});
