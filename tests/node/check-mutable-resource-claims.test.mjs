import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  FlowStepClaimError,
  buildActiveStepClaim,
  definitionDigest,
  invalidateDescendants,
  projectReadyStepFrontier,
  readySteps,
  validateActiveStepClaim,
  validateDefinitionWithDiagnostics
} from "../../dist/index.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");

function multiCursorDefinition({ shared = false } = {}) {
  return {
    id: "resource-flow",
    version: "1",
    execution: { mode: "multi-cursor", claim_contract_version: "1" },
    steps: [
      { id: "prepare", next: "publish", mutable_resources: ["dist"] },
      { id: "verify", next: "publish", mutable_resources: shared ? ["dist"] : ["reports"] },
      { id: "publish", next: null, needs: ["prepare", "verify"], mutable_resources: [] }
    ],
    gates: {
      "prepare-gate": { step: "prepare", expects: [] },
      "verify-gate": { step: "verify", expects: [] },
      "publish-gate": { step: "publish", expects: [] }
    }
  };
}

function state({ currentStep = "prepare", passed = [], runId = "resource-run" } = {}) {
  return {
    schema_version: "0.1",
    run_id: runId,
    definition_id: "resource-flow",
    definition_version: "1",
    subject: "resource claims",
    status: "active",
    current_step: currentStep,
    gate_outcomes: passed.map((gate_id) => ({ gate_id, status: "pass", summary: "passed" })),
    transitions: [],
    lifecycle: [],
    exceptions: [],
    next_action: "claim a ready step",
    updated_at: "2026-07-24T12:00:00.000Z"
  };
}

function request(step_id, suffix) {
  return {
    claim_id: `claim-${suffix}`,
    liveness_id: `lease-${suffix}`,
    step_id,
    actor: { key: `host-${suffix}`, kind: "host" }
  };
}

test("multi-cursor definitions require explicit bounded unambiguous mutable resources", async () => {
  const schema = JSON.parse(await readFile(new URL("../../schemas/flow-definition.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
  const definition = multiCursorDefinition();
  delete definition.steps[1].mutable_resources;
  definition.steps[0].mutable_resources = ["dist", "dist", "../outside", "dist/"];

  assert.equal(validate(definition), false, "public schema rejects missing and malformed declarations");
  const diagnostics = validateDefinitionWithDiagnostics(definition).diagnostics;
  assert.ok(diagnostics.some((entry) => entry.code === "definition.step.mutable_resources.required"));
  assert.ok(diagnostics.some((entry) => entry.code === "definition.step.mutable_resources.duplicate"));
  assert.ok(diagnostics.some((entry) => entry.code === "definition.step.mutable_resources.invalid"));
});

test("same-resource contention is exposed without dispatching host work", () => {
  const definition = multiCursorDefinition({ shared: true });
  const run = state();
  const prepare = buildActiveStepClaim(definition, run, request("prepare", "prepare"));
  const verify = buildActiveStepClaim(definition, run, request("verify", "verify"));
  const result = validateActiveStepClaim(definition, run, verify, [prepare]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.conflicts, [{ claim_id: prepare.claim_id, step_id: "prepare", mutable_resources: ["dist"] }]);
  assert.ok(result.diagnostics.some((entry) => entry.code === "flow.step_claim.conflict.resource"));
});

test("forged active-claim resources fail before conflict comparison", () => {
  const definition = multiCursorDefinition({ shared: true });
  const run = state();
  const prepare = buildActiveStepClaim(definition, run, request("prepare", "prepare"));
  const forged = { ...prepare, mutable_resources: [] };
  const verify = buildActiveStepClaim(definition, run, request("verify", "verify"));
  const result = validateActiveStepClaim(definition, run, verify, [forged]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.diagnostics.some((entry) => entry.code === "flow.step_claim.active.mutable_resources.mismatch"));
  assert.ok(!result.diagnostics.some((entry) => entry.code === "flow.step_claim.conflict.resource"));
});

test("stale active-claim head and definition identity fail before conflict comparison", () => {
  const definition = multiCursorDefinition({ shared: true });
  const run = state();
  const prepare = buildActiveStepClaim(definition, run, request("prepare", "prepare"));
  const verify = buildActiveStepClaim(definition, run, request("verify", "verify"));
  for (const [forged, expectedCode] of [
    [{ ...prepare, run_head: "f".repeat(64) }, "flow.step_claim.active.run_head.stale"],
    [{ ...prepare, definition: { ...prepare.definition, version: "2" } }, "flow.step_claim.active.definition.stale"]
  ]) {
    const result = validateActiveStepClaim(definition, run, verify, [forged]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.conflicts, []);
    assert.ok(result.diagnostics.some((entry) => entry.code === expectedCode));
    assert.ok(!result.diagnostics.some((entry) => entry.code === "flow.step_claim.conflict.resource"));
  }
});

test("a forged non-ready active claim cannot manufacture resource contention", () => {
  const definition = multiCursorDefinition({ shared: true });
  definition.steps.find((step) => step.id === "publish").mutable_resources = ["dist"];
  const run = state();
  const prepare = buildActiveStepClaim(definition, run, request("prepare", "prepare"));
  const verify = buildActiveStepClaim(definition, run, request("verify", "verify"));
  const forgedJoin = {
    ...prepare,
    claim_id: "claim-forged-join",
    liveness_id: "lease-forged-join",
    step_id: "publish",
    mutable_resources: ["dist"]
  };
  const result = validateActiveStepClaim(definition, run, verify, [forgedJoin]);

  assert.equal(result.valid, false);
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.diagnostics.some((entry) => entry.code === "flow.step_claim.active.frontier.not_ready"));
  assert.ok(!result.diagnostics.some((entry) => entry.code === "flow.step_claim.conflict.resource"));
});

test("disjoint ready claims bind exact run and definition identities", () => {
  const definition = multiCursorDefinition();
  const run = state();
  const prepare = buildActiveStepClaim(definition, run, request("prepare", "prepare"));
  const verify = buildActiveStepClaim(definition, run, request("verify", "verify"));
  const result = validateActiveStepClaim(definition, run, verify, [prepare]);

  assert.equal(result.valid, true);
  assert.equal(verify.run_id, run.run_id);
  assert.equal(verify.definition.id, definition.id);
  assert.equal(verify.definition.version, definition.version);
  assert.match(verify.definition.digest, /^[a-f0-9]{64}$/);
  assert.match(verify.run_head, /^[a-f0-9]{64}$/);
  assert.deepEqual(verify.mutable_resources, ["reports"]);
});

test("claim digests use the lowercase canonical schema representation", () => {
  const definition = multiCursorDefinition();
  const run = state();
  const claim = buildActiveStepClaim(definition, run, request("prepare", "canonical-digest"));
  for (const [forged, expectedCode] of [
    [{ ...claim, run_head: claim.run_head.toUpperCase() }, "flow.step_claim.run_head.invalid"],
    [{ ...claim, definition: { ...claim.definition, digest: claim.definition.digest.toUpperCase() } }, "flow.step_claim.definition.digest.invalid"]
  ]) {
    const result = validateActiveStepClaim(definition, run, forged);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((entry) => entry.code === expectedCode));
  }
});

test("claims fail closed after the run head changes", () => {
  const definition = multiCursorDefinition();
  const run = state();
  const claim = buildActiveStepClaim(definition, run, request("prepare", "prepare"));
  const changed = { ...run, updated_at: "2026-07-24T12:01:00.000Z" };
  const result = validateActiveStepClaim(definition, changed, claim);

  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "flow.step_claim.run_head.stale"));
});

test("frontier, build, and validation reject mismatched run definition identity", () => {
  const definition = multiCursorDefinition();
  const matchingDigest = definitionDigest(definition);
  for (const mutation of [
    { definition_id: "other-flow" },
    { definition_version: "2" },
    { definition_digest: "f".repeat(64) }
  ]) {
    const run = { ...state(), definition_digest: matchingDigest, ...mutation };
    assert.throws(() => projectReadyStepFrontier(definition, run), FlowStepClaimError);
    assert.throws(() => buildActiveStepClaim(definition, run, request("prepare", "identity")), FlowStepClaimError);
    const canonical = buildActiveStepClaim(definition, { ...state(), definition_digest: matchingDigest }, request("prepare", "canonical"));
    const result = validateActiveStepClaim(definition, run, canonical);
    assert.equal(result.valid, false);
    assert.ok(result.diagnostics.some((entry) => entry.code.includes("flow.step_claim.run.definition_")));
  }
});

test("run ids use Flow's canonical path-safe contract rather than claim identifier grammar", async () => {
  const definition = multiCursorDefinition();
  const run = state({ runId: "Run 2026" });
  const claim = buildActiveStepClaim(definition, run, request("prepare", "safe-run"));
  assert.equal(claim.run_id, "Run 2026");

  const claimSchema = JSON.parse(await readFile(new URL("../../schemas/flow-active-step-claim.schema.json", import.meta.url), "utf8"));
  const validateClaimSchema = new Ajv({ strict: false, allErrors: true }).compile(claimSchema);
  assert.equal(validateClaimSchema(claim), true);
  assert.throws(() => projectReadyStepFrontier(definition, state({ runId: "../escape" })), FlowStepClaimError);
  assert.equal(validateClaimSchema({ ...claim, run_id: "../escape" }), false);
});

test("frontier projects fan-out and consumes fan-in readiness", () => {
  const definition = multiCursorDefinition();
  const start = projectReadyStepFrontier(definition, state());
  assert.deepEqual(start.ready_steps.map((step) => step.step_id), ["prepare", "verify"]);

  const joined = projectReadyStepFrontier(definition, state({ currentStep: "publish", passed: ["prepare-gate", "verify-gate"] }));
  assert.deepEqual(joined.ready_steps.map((step) => step.step_id), ["publish"]);
  assert.deepEqual(joined.ready_steps[0].mutable_resources, []);
});

test("route-back requires the rerouted prerequisite to re-settle before a downstream join is claimable", () => {
  const definition = multiCursorDefinition();
  const run = state();
  const sibling = buildActiveStepClaim(definition, run, request("verify", "verify"));
  assert.equal(validateActiveStepClaim(definition, run, sibling).valid, true, "the sibling was claimable before route-back");
  run.current_step = "publish";
  run.gate_outcomes = [
    { gate_id: "prepare-gate", status: "pass", summary: "passed" },
    { gate_id: "verify-gate", status: "pass", summary: "passed" }
  ];
  const route = { type: "route_back", from_step: "publish", to_step: "prepare", status: "blocked", at: "2026-07-24T12:02:00.000Z" };
  run.transitions.push(route);
  route.invalidated_steps = invalidateDescendants(definition, run, "prepare");
  run.current_step = "prepare";
  run.updated_at = "2026-07-24T12:02:00.000Z";

  assert.deepEqual(readySteps(definition, run, { evidence: [] }), ["publish"], "legacy projection retains the target pass");
  assert.deepEqual(projectReadyStepFrontier(definition, run).ready_steps.map((step) => step.step_id), ["prepare"]);
  assert.throws(() => buildActiveStepClaim(definition, run, request("publish", "premature-join")), FlowStepClaimError);
  const result = validateActiveStepClaim(definition, run, sibling);
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "flow.step_claim.run_head.stale"));

  run.transitions.push({ from_step: "prepare", to_step: "publish", status: "allowed", gate_id: "prepare-gate", at: "2026-07-24T12:03:00.000Z" });
  run.updated_at = "2026-07-24T12:03:00.000Z";
  assert.deepEqual(projectReadyStepFrontier(definition, run).ready_steps.map((step) => step.step_id), ["publish"]);
});

test("legacy single-cursor definitions remain readable and serial", () => {
  const definition = multiCursorDefinition();
  delete definition.execution;
  definition.steps.forEach((step) => delete step.mutable_resources);
  const run = state();
  assert.equal(validateDefinitionWithDiagnostics(definition).valid, true);
  assert.deepEqual(readySteps(definition, run, { evidence: [] }), ["prepare", "verify"]);
  assert.throws(
    () => projectReadyStepFrontier(definition, run),
    (error) => error instanceof FlowStepClaimError && error.diagnostics.some((entry) => entry.code === "flow.step_claim.definition.multi_cursor.required")
  );
});
