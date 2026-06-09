import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvaluation,
  evaluateGate,
  initialState,
  renderMarkdownReport,
  renderSummary,
  reportJson,
  validateEvaluationTransition,
  validateRunTransition
} from "../../dist/index.js";
import { resourceDefinitionFixture } from "./helpers/fixtures.mjs";
import { failedEvidence, routeBackDefinition, routeBackManifest } from "./helpers/route-back-fixtures.mjs";

test("transition validator allows only legal forward transitions and keeps inputs immutable", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "transition-forward");
  state.current_step = "plan";
  const manifest = routeBackManifest([]);
  const request = {
    definition,
    current_state: state,
    proposed_transition: {
      from_step: "plan",
      to_step: "implement",
      status: "allowed"
    },
    manifest,
    now: "2026-05-30T00:00:00.000Z"
  };
  const before = JSON.stringify(request);
  const result = validateRunTransition(request);
  assert.equal(result.valid, true);
  assert.equal(result.status, "allowed");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.transition.from_step, "plan");
  assert.equal(result.transition.to_step, "implement");
  assert.equal(JSON.stringify(request), before);

  const stale = validateRunTransition({
    ...request,
    proposed_transition: { from_step: "verify", to_step: "implement", status: "allowed" }
  });
  assert.equal(stale.valid, false);
  assert.equal(stale.status, "invalid");
  assert.ok(stale.diagnostics.some((diagnostic) => diagnostic.code === "transition.current_state.stale"));

  const unknown = validateRunTransition({
    ...request,
    proposed_transition: { from_step: "plan", to_step: "missing", status: "allowed" }
  });
  assert.equal(unknown.valid, false);
  assert.ok(unknown.diagnostics.some((diagnostic) => diagnostic.code === "transition.to_step.unknown"));
});

test("transition validator accepts Resource-shaped request definitions", async () => {
  const definition = await resourceDefinitionFixture();
  const state = initialState(definition, "resource-transition");
  const result = validateRunTransition({
    definition,
    current_state: state,
    proposed_transition: {
      from_step: "plan",
      to_step: "implement",
      status: "allowed",
      gate_id: "plan-gate"
    },
    manifest: routeBackManifest([
      {
        id: "ev.acceptance",
        gate_id: "plan-gate",
        kind: "acceptance-criteria",
        requested_kind: "acceptance-criteria",
        status: "passed",
        attached_at: "2026-06-09T00:00:00.000Z"
      }
    ])
  });

  assert.equal(result.valid, true);
  assert.equal(result.status, "allowed");
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.transition.from_step, "plan");
  assert.equal(result.transition.to_step, "implement");
});

test("transition validator allows forward advancement through accepted exceptions", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "transition-exception");
  state.current_step = "verify";
  state.exceptions.push({
    id: "ex.transition.1",
    gate_id: "verify-gate",
    reason: "operator accepted missing evidence",
    authority: "release-owner",
    accepted_at: "2026-05-30T00:00:00.000Z"
  });
  const manifest = routeBackManifest([]);

  const direct = validateRunTransition({
    definition,
    current_state: state,
    proposed_transition: {
      from_step: "verify",
      to_step: "recover",
      status: "allowed",
      gate_id: "verify-gate"
    },
    manifest
  });
  assert.equal(direct.valid, true);
  assert.equal(direct.status, "allowed");
  assert.deepEqual(direct.diagnostics, []);

  const outcome = evaluateGate(definition, state, manifest, "verify-gate");
  assert.equal(outcome.status, "pass");
  assert.equal(outcome.accepted_exception_id, "ex.transition.1");
  const evaluated = validateEvaluationTransition(definition, state, manifest, outcome);
  assert.equal(evaluated.valid, true);
  assert.equal(evaluated.status, "allowed");
  assert.equal(evaluated.transition.reason, "accepted exception");
});

test("transition validator rejects gate skips and premature completion before required gates pass", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "transition-gate-skip");
  state.current_step = "verify";
  const manifest = routeBackManifest([]);

  const skip = validateRunTransition({
    definition,
    current_state: state,
    proposed_transition: {
      from_step: "verify",
      to_step: "recover",
      status: "allowed",
      gate_id: "verify-gate"
    },
    manifest
  });
  assert.equal(skip.valid, false);
  assert.equal(skip.status, "route-back");
  assert.ok(skip.diagnostics.some((diagnostic) => diagnostic.code === "transition.gate.route-back"));

  const complete = validateRunTransition({
    definition,
    current_state: state,
    proposed_state: {
      ...state,
      status: "completed",
      current_step: "recover"
    },
    manifest
  });
  assert.equal(complete.valid, false);
  assert.ok(complete.diagnostics.some((diagnostic) => diagnostic.code === "transition.completion.premature"));
});

test("transition validator preserves permissive route reasons unless route policy is closed", () => {
  const definitionSchemaPolicy = {
    max_attempts: 2,
    on_exceeded: "block",
    allow_unknown_reasons: false
  };
  const openDefinition = routeBackDefinition();
  const closedDefinition = routeBackDefinition({
    route_back_policy: definitionSchemaPolicy
  });
  assert.deepEqual(closedDefinition.gates["verify-gate"].route_back_policy, definitionSchemaPolicy);
  const state = initialState(openDefinition, "transition-route-policy");
  state.current_step = "verify";
  const manifest = routeBackManifest([failedEvidence({ id: "ev.vendor", route_reason: "vendor_reason" })]);
  const proposed = {
    type: "route_back",
    from_step: "verify",
    to_step: "implement",
    status: "route-back",
    gate_id: "verify-gate",
    route_reason: "vendor_reason",
    evidence_refs: ["ev.vendor"]
  };

  const open = validateRunTransition({
    definition: openDefinition,
    current_state: state,
    proposed_transition: proposed,
    manifest
  });
  assert.equal(open.valid, true);
  assert.equal(open.status, "route-back");
  assert.equal(open.transition.route_reason, "vendor_reason");
  assert.equal(open.transition.attempt, 1);

  const closed = validateRunTransition({
    definition: closedDefinition,
    current_state: state,
    proposed_transition: proposed,
    manifest
  });
  assert.equal(closed.valid, false);
  assert.equal(closed.status, "invalid");
  assert.ok(closed.diagnostics.some((diagnostic) => diagnostic.code === "transition.route_back.reason.undeclared"));
});

test("transition validator derives route-back attempts from persisted transitions and protects loops", () => {
  const definition = routeBackDefinition({
    route_back_policy: { max_attempts: 1, on_exceeded: "block" }
  });
  const state = initialState(definition, "transition-loop");
  state.current_step = "verify";
  state.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked" }
  ];
  const manifest = routeBackManifest([failedEvidence({ id: "ev.loop", route_reason: "implementation_defect" })]);
  const result = validateRunTransition({
    definition,
    current_state: state,
    proposed_transition: {
      type: "route_back",
      from_step: "verify",
      to_step: "implement",
      status: "route-back",
      gate_id: "verify-gate",
      route_reason: "implementation_defect",
      evidence_refs: ["ev.loop"]
    },
    manifest
  });
  assert.equal(result.valid, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.transition.attempt, 2);
  assert.equal(result.transition.max_attempts, 1);
  assert.equal(result.transition.limit_exceeded, true);
});

test("transition validator blocks Builder Kit-like merge before verify evidence and release gates complete", () => {
  const definition = {
    id: "builder-like-flow",
    version: "1",
    steps: [
      { id: "plan", next: "verify" },
      { id: "verify", next: "evidence" },
      { id: "evidence", next: "publish-change" },
      { id: "publish-change", next: "release-readiness" },
      { id: "release-readiness", next: "merge" },
      { id: "merge", next: null }
    ],
    gates: {
      "verify-gate": { step: "verify", requires: ["tests"], on_route_back: { missing_evidence: "verify", default: "plan" } },
      "evidence-gate": { step: "evidence", requires: ["evidence-report"] },
      "publish-gate": { step: "publish-change", requires: ["published-change"] },
      "release-gate": { step: "release-readiness", requires: ["release-readiness"] },
      "merge-gate": { step: "merge", requires: ["merged-change"] }
    }
  };
  const state = initialState(definition, "builder-like");
  state.current_step = "verify";
  const result = validateRunTransition({
    definition,
    current_state: state,
    proposed_state: {
      ...state,
      status: "completed",
      current_step: "merge"
    },
    manifest: routeBackManifest([])
  });
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "transition.jump.invalid"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "transition.completion.premature"));
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "transition.gate.route-back"));
});

test("evaluation transition guard records validation in reports", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "transition-report");
  state.current_step = "verify";
  const manifest = routeBackManifest([failedEvidence({ id: "ev.guard", route_reason: "implementation_defect" })]);
  const outcome = evaluateGate(definition, state, manifest, "verify-gate");
  const validation = validateEvaluationTransition(definition, state, manifest, outcome);
  assert.equal(validation.status, "route-back");
  outcome.transition_validation = validation;
  applyEvaluation(definition, state, outcome);
  const report = reportJson(definition, state, manifest);
  const gate = report.gate_summaries.find((entry) => entry.gate_id === "verify-gate");
  assert.equal(gate.transition_validation.status, "route-back");
  assert.equal(gate.transition_validation.transition.attempt, 1);
  assert.match(renderMarkdownReport(definition, state, manifest), /Transition diagnostics: transition\.gate\.route-back/);
  assert.match(renderSummary(definition, state), /transition diagnostics: transition\.gate\.route-back/);
});
