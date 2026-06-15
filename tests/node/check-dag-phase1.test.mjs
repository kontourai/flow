/**
 * Tests for Phase 1 dependency-DAG: predecessorsOf, readySteps, readyGates,
 * stageStatuses, and needs validation (unknown refs + cycle detection).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  predecessorsOf,
  readySteps,
  readyGates,
  stageStatuses,
  validateDefinitionWithDiagnostics,
  validateDefinition,
  FLOW_SCHEMA_VERSION
} from "../../dist/index.js";
import { json } from "./helpers/fixtures.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal linear definition: plan -> implement -> verify -> publish */
function linearDefinition() {
  return {
    id: "linear-flow",
    version: "1",
    steps: [
      { id: "plan",      next: "implement" },
      { id: "implement", next: "verify" },
      { id: "verify",    next: "publish" },
      { id: "publish",   next: null }
    ],
    gates: {
      "plan-gate":      { step: "plan",      expects: [] },
      "implement-gate": { step: "implement", expects: [] },
      "verify-gate":    { step: "verify",    expects: [] }
    }
  };
}

/**
 * Fan-in definition: plan and shape are parallel root steps; implement needs
 * both.  Neither plan nor shape has a predecessor because no step has
 * next === "plan" or next === "shape".  implement.needs wins over next-chain
 * for implement's predecessor resolution.
 *
 *   plan  ─┐
 *           ├─> implement -> verify -> publish
 *   shape ─┘
 */
function fanInDefinition() {
  return {
    id: "fan-in-flow",
    version: "1",
    steps: [
      { id: "plan",      next: "implement" },
      { id: "shape",     next: "implement" },
      { id: "implement", next: "verify", needs: ["plan", "shape"] },
      { id: "verify",    next: "publish" },
      { id: "publish",   next: null }
    ],
    gates: {
      "plan-gate":      { step: "plan",      expects: [] },
      "shape-gate":     { step: "shape",     expects: [] },
      "implement-gate": { step: "implement", expects: [] },
      "verify-gate":    { step: "verify",    expects: [] }
    }
  };
}

/** Minimal state at a given step with given passed gate outcomes. */
function makeState(currentStep, passedGates = []) {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: "test-run",
    definition_id: "test-flow",
    definition_version: "1",
    subject: "test",
    status: "active",
    current_step: currentStep,
    gate_outcomes: passedGates.map((gateId) => ({
      gate_id: gateId,
      status: "pass",
      summary: "passed"
    })),
    transitions: passedGates.map((gateId, i, arr) => ({
      from_step: gateId.replace(/-gate$/, ""),
      to_step: arr[i + 1]?.replace(/-gate$/, "") ?? null,
      status: "allowed",
      gate_id: gateId,
      at: "2026-01-01T00:00:00.000Z"
    })),
    exceptions: [],
    next_action: "attach evidence",
    updated_at: "2026-01-01T00:00:00.000Z"
  };
}

const emptyManifest = { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };

// ---------------------------------------------------------------------------
// predecessorsOf — pure-linear (no needs)
// ---------------------------------------------------------------------------

test("predecessorsOf: first step in linear chain has no predecessors", () => {
  const def = linearDefinition();
  assert.deepEqual(predecessorsOf(def, "plan"), []);
});

test("predecessorsOf: linear chain derives from next pointer", () => {
  const def = linearDefinition();
  assert.deepEqual(predecessorsOf(def, "implement"), ["plan"]);
  assert.deepEqual(predecessorsOf(def, "verify"),    ["implement"]);
  assert.deepEqual(predecessorsOf(def, "publish"),   ["verify"]);
});

test("predecessorsOf: explicit needs overrides next-chain", () => {
  const def = fanInDefinition();
  // implement has needs: [plan, shape] — next-chain is ignored for implement.
  assert.deepEqual(predecessorsOf(def, "implement"), ["plan", "shape"]);
  // plan and shape have no needs and no step points to them via next,
  // so they are both root steps with no predecessors.
  assert.deepEqual(predecessorsOf(def, "plan"),  []);
  assert.deepEqual(predecessorsOf(def, "shape"), []);
});

test("predecessorsOf: unknown step returns empty array", () => {
  const def = linearDefinition();
  assert.deepEqual(predecessorsOf(def, "nonexistent"), []);
});

// ---------------------------------------------------------------------------
// readySteps — pure-linear
// ---------------------------------------------------------------------------

test("readySteps: first step ready at start (no passed gates)", () => {
  const def = linearDefinition();
  const state = makeState("plan", []);
  const ready = readySteps(def, state, emptyManifest);
  assert.ok(ready.includes("plan"), "plan should be ready");
  assert.ok(!ready.includes("implement"), "implement should NOT be ready yet");
});

test("readySteps: next step becomes ready after predecessor gate passes", () => {
  const def = linearDefinition();
  const state = makeState("implement", ["plan-gate"]);
  const ready = readySteps(def, state, emptyManifest);
  assert.ok(ready.includes("implement"), "implement should be ready");
  assert.ok(!ready.includes("verify"), "verify should NOT be ready yet");
});

test("readySteps: linear full pass — only the terminal step is ready", () => {
  const def = linearDefinition();
  const state = makeState("publish", ["plan-gate", "implement-gate", "verify-gate"]);
  const ready = readySteps(def, state, emptyManifest);
  assert.ok(ready.includes("publish"), "publish should be ready");
  assert.equal(ready.length, 1);
});

test("readySteps: completed run returns empty ready list", () => {
  const def = linearDefinition();
  const state = {
    ...makeState("publish", ["plan-gate", "implement-gate", "verify-gate"]),
    status: "completed"
  };
  const ready = readySteps(def, state, emptyManifest);
  assert.equal(ready.length, 0);
});

// ---------------------------------------------------------------------------
// readySteps — fan-in
// ---------------------------------------------------------------------------

test("readySteps fan-in: only plan and shape are ready at start", () => {
  const def = fanInDefinition();
  const state = makeState("plan", []);
  const ready = readySteps(def, state, emptyManifest);
  assert.ok(ready.includes("plan"),   "plan must be ready");
  assert.ok(ready.includes("shape"),  "shape must be ready (no predecessors)");
  assert.ok(!ready.includes("implement"), "implement must NOT be ready");
});

test("readySteps fan-in: implement blocked when only plan has passed", () => {
  const def = fanInDefinition();
  const state = makeState("shape", ["plan-gate"]);
  const ready = readySteps(def, state, emptyManifest);
  assert.ok(!ready.includes("implement"), "implement must NOT be ready with only plan passed");
});

test("readySteps fan-in: implement ready once both plan-gate and shape-gate have passed", () => {
  const def = fanInDefinition();
  const state = makeState("implement", ["plan-gate", "shape-gate"]);
  const ready = readySteps(def, state, emptyManifest);
  assert.ok(ready.includes("implement"), "implement must be ready after both predecessors pass");
});

// ---------------------------------------------------------------------------
// readyGates
// ---------------------------------------------------------------------------

test("readyGates: returns gates whose step is ready", () => {
  const def = fanInDefinition();
  const state = makeState("implement", ["plan-gate", "shape-gate"]);
  const gates = readyGates(def, state, emptyManifest);
  const gateIds = gates.map((g) => g.id);
  assert.ok(gateIds.includes("implement-gate"), "implement-gate must be in readyGates");
  assert.ok(!gateIds.includes("plan-gate"),  "plan-gate must NOT be in readyGates");
  assert.ok(!gateIds.includes("shape-gate"), "shape-gate must NOT be in readyGates");
});

test("readyGates: no ready gates when run is completed", () => {
  const def = linearDefinition();
  const state = {
    ...makeState("publish", ["plan-gate", "implement-gate", "verify-gate"]),
    status: "completed"
  };
  const gates = readyGates(def, state, emptyManifest);
  assert.equal(gates.length, 0);
});

// ---------------------------------------------------------------------------
// stageStatuses — linear
// ---------------------------------------------------------------------------

test("stageStatuses linear: initial state — plan is current, others blocked", () => {
  const def = linearDefinition();
  const state = makeState("plan", []);
  const statuses = stageStatuses(def, state, emptyManifest);
  assert.equal(statuses["plan"],      "current");
  assert.equal(statuses["implement"], "blocked");
  assert.equal(statuses["verify"],    "blocked");
  assert.equal(statuses["publish"],   "blocked");
});

test("stageStatuses linear: after plan passes, plan=passed, implement=current, rest=blocked", () => {
  const def = linearDefinition();
  const state = makeState("implement", ["plan-gate"]);
  const statuses = stageStatuses(def, state, emptyManifest);
  assert.equal(statuses["plan"],      "passed");
  assert.equal(statuses["implement"], "current");
  assert.equal(statuses["verify"],    "blocked");
  assert.equal(statuses["publish"],   "blocked");
});

test("stageStatuses linear: failed gate outcome", () => {
  const def = linearDefinition();
  const state = {
    ...makeState("implement", []),
    gate_outcomes: [{ gate_id: "implement-gate", status: "block", summary: "missing evidence" }]
  };
  const statuses = stageStatuses(def, state, emptyManifest);
  // implement is current_step and has a failed gate — current wins per spec order
  assert.equal(statuses["implement"], "current");
  // verify and publish are blocked (no predecessors passed)
  assert.equal(statuses["verify"],   "blocked");
  assert.equal(statuses["publish"],  "blocked");
});

// ---------------------------------------------------------------------------
// stageStatuses — fan-in
// ---------------------------------------------------------------------------

test("stageStatuses fan-in: initial state — plan and shape are ready", () => {
  const def = fanInDefinition();
  const state = makeState("plan", []);
  const statuses = stageStatuses(def, state, emptyManifest);
  assert.equal(statuses["plan"],      "current");
  assert.equal(statuses["shape"],     "ready",   "shape has no predecessors, should be ready");
  assert.equal(statuses["implement"], "blocked");
  assert.equal(statuses["verify"],    "blocked");
  assert.equal(statuses["publish"],   "blocked");
});

test("stageStatuses fan-in: implement ready once both predecessors passed", () => {
  const def = fanInDefinition();
  const state = makeState("implement", ["plan-gate", "shape-gate"]);
  const statuses = stageStatuses(def, state, emptyManifest);
  assert.equal(statuses["plan"],      "passed");
  assert.equal(statuses["shape"],     "passed");
  assert.equal(statuses["implement"], "current");
  assert.equal(statuses["verify"],    "blocked");
  assert.equal(statuses["publish"],   "blocked");
});

// ---------------------------------------------------------------------------
// Validation — needs unknown step
// ---------------------------------------------------------------------------

test("validation: needs references unknown step emits diagnostic", () => {
  const def = {
    id: "bad-needs-flow",
    version: "1",
    steps: [
      { id: "plan",      next: "implement" },
      { id: "implement", next: null, needs: ["plan", "nonexistent"] }
    ],
    gates: {
      "plan-gate":      { step: "plan",      expects: [] },
      "implement-gate": { step: "implement", expects: [] }
    }
  };
  const result = validateDefinitionWithDiagnostics(def);
  assert.equal(result.valid, false);
  const codes = result.diagnostics.map((d) => d.code);
  assert.ok(codes.includes("definition.step.needs.unknown"), "must emit definition.step.needs.unknown");
  const diag = result.diagnostics.find((d) => d.code === "definition.step.needs.unknown");
  assert.match(diag.message, /nonexistent/);
});

// ---------------------------------------------------------------------------
// Validation — cycle detection
// ---------------------------------------------------------------------------

test("validation: cyclic needs is rejected with diagnostic", () => {
  const def = {
    id: "cyclic-flow",
    version: "1",
    steps: [
      { id: "alpha", next: "beta",  needs: ["gamma"] },
      { id: "beta",  next: "gamma", needs: ["alpha"] },
      { id: "gamma", next: null,    needs: ["beta"] }
    ],
    gates: {
      "alpha-gate": { step: "alpha", expects: [] },
      "beta-gate":  { step: "beta",  expects: [] },
      "gamma-gate": { step: "gamma", expects: [] }
    }
  };
  const result = validateDefinitionWithDiagnostics(def);
  assert.equal(result.valid, false);
  const cycleDiag = result.diagnostics.find((d) => d.code === "definition.steps.needs.cycle");
  assert.ok(cycleDiag, "must emit definition.steps.needs.cycle diagnostic");
  assert.match(cycleDiag.message, /cycle detected/);
});

test("validation: pure linear definition (no needs) passes unchanged", () => {
  const def = linearDefinition();
  const result = validateDefinitionWithDiagnostics(def);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.doesNotThrow(() => validateDefinition(def));
});

test("validation: fan-in definition with valid needs passes", () => {
  const def = fanInDefinition();
  const result = validateDefinitionWithDiagnostics(def);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.doesNotThrow(() => validateDefinition(def));
});

// ---------------------------------------------------------------------------
// Example file from examples/
// ---------------------------------------------------------------------------

test("examples/flow-definition-dag.json validates cleanly", async () => {
  const def = await json("examples/flow-definition-dag.json");
  assert.doesNotThrow(() => validateDefinition(def));
  const result = validateDefinitionWithDiagnostics(def);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  // implement needs plan and shape
  assert.deepEqual(predecessorsOf(def, "implement"), ["plan", "shape"]);
});

test("examples/flow-definition-dag.json stageStatuses at start", async () => {
  const def = await json("examples/flow-definition-dag.json");
  const state = makeState("plan", []);
  const statuses = stageStatuses(def, state, emptyManifest);
  assert.equal(statuses["plan"],      "current");
  assert.equal(statuses["shape"],     "ready");
  assert.equal(statuses["implement"], "blocked");
  assert.equal(statuses["verify"],    "blocked");
  assert.equal(statuses["publish"],   "blocked");
});
