import assert from "node:assert/strict";
import { access, constants, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FLOW_SCHEMA_VERSION,
  loadRun,
  startRun,
  validateDefinition,
  validateDefinitionWithDiagnostics
} from "../../dist/index.js";
import {
  FLOW_RUN_DEFINITION_FILE,
  FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  FLOW_RUN_REPORT_JSON_FILE,
  FLOW_RUN_REPORT_MARKDOWN_FILE,
  FLOW_RUN_STATE_FILE
} from "../../dist/index.js";
import { json, resourceDefinitionFixture } from "./helpers/fixtures.mjs";
import { routeBackDefinition } from "./helpers/route-back-fixtures.mjs";

test("example definition matches the v0.1 runtime shape", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  assert.equal(definition.id, "agent-dev-flow");
  assert.equal(definition.version, "1");
  assert.deepEqual(definition.steps.map((step) => step.id), ["plan", "implement", "verify", "publish"]);
  assert.equal(definition.gates["verify-gate"].expects[0].kind, "surface.claim");
  assert.equal(definition.gates["verify-gate"].expects[0].claim.subject, "builder.verify");
  assert.notEqual(definition.gates["verify-gate"].expects[0].kind, "surface-claim");
  assert.deepEqual(definition.gates["verify-gate"].on_route_back, {
    implementation_defect: "implement",
    plan_gap: "plan",
    decision_gap: "plan",
    missing_evidence: "verify",
    default: "implement"
  });
  assert.equal(definition.gates["verify-gate"].route_back_policy.on_exceeded, "block");
  assert.doesNotThrow(() => validateDefinition(definition));
});

test("Resource-shaped definition normalizes for runtime validation", async () => {
  const definition = await resourceDefinitionFixture();
  const normalized = validateDefinition(definition);

  assert.deepEqual(normalized, {
    id: "resource-contract-flow",
    version: "1",
    steps: definition.spec.steps,
    gates: definition.spec.gates
  });
  assert.deepEqual(validateDefinitionWithDiagnostics(definition), {
    valid: true,
    diagnostics: []
  });
});

test("startRun stores and loadRun returns flat-compatible snapshots for Resource-shaped definitions", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-resource-start-"));
  const definition = await resourceDefinitionFixture();
  await writeFile(path.join(cwd, "flow-definition.json"), `${JSON.stringify(definition, null, 2)}\n`);

  const started = await startRun("flow-definition.json", {
    cwd,
    runId: "resource-contract-smoke",
    params: { subject: "resource-contract-smoke" }
  });
  const runPath = path.join(cwd, ".flow", "runs", "resource-contract-smoke");
  const storedDefinition = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_DEFINITION_FILE), "utf8"));
  const storedState = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_STATE_FILE), "utf8"));
  const storedManifest = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), "utf8"));
  const storedReport = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_REPORT_JSON_FILE), "utf8"));
  const loaded = await loadRun("resource-contract-smoke", cwd);

  assert.equal(started.state.definition_id, "resource-contract-flow");
  assert.equal(storedDefinition.id, "resource-contract-flow");
  assert.equal(storedDefinition.version, "1");
  assert.equal(storedDefinition.apiVersion, undefined);
  assert.equal(storedState.definition_id, "resource-contract-flow");
  assert.equal(storedState.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(storedState.run_id, "resource-contract-smoke");
  assert.equal(storedState.status, "active");
  assert.equal(storedState.current_step, "plan");
  assert.deepEqual(storedManifest, {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: "resource-contract-smoke",
    definition_id: "resource-contract-flow",
    definition_version: "1",
    evidence: []
  });
  assert.equal(storedReport.run_id, storedState.run_id);
  assert.equal(storedReport.definition_id, "resource-contract-flow");
  assert.equal(storedReport.definition_version, storedState.definition_version);
  assert.equal(storedReport.status, storedState.status);
  assert.equal(storedReport.current_step, storedState.current_step);
  assert.equal(storedReport.next_action, storedState.next_action);
  await access(path.join(runPath, FLOW_RUN_DEFINITION_FILE), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_STATE_FILE), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_REPORT_MARKDOWN_FILE), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_REPORT_JSON_FILE), constants.R_OK);
  assert.equal(loaded.definition.id, "resource-contract-flow");
  assert.equal(loaded.state.definition_id, "resource-contract-flow");
  assert.deepEqual(loaded.manifest, storedManifest);

  await writeFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), `${JSON.stringify({
    ...storedManifest,
    run_id: "different-run"
  }, null, 2)}\n`);
  await assert.rejects(
    loadRun("resource-contract-smoke", cwd),
    /evidence manifest run_id mismatch: expected resource-contract-smoke, got different-run/
  );
  await writeFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), `${JSON.stringify({
    schema_version: FLOW_SCHEMA_VERSION,
    definition_id: "resource-contract-flow",
    definition_version: "1",
    evidence: []
  }, null, 2)}\n`);
  await assert.rejects(
    loadRun("resource-contract-smoke", cwd),
    /evidence manifest run_id is required for run resource-contract-smoke/
  );
  await writeFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), `${JSON.stringify(storedManifest, null, 2)}\n`);
  await writeFile(path.join(runPath, FLOW_RUN_STATE_FILE), `${JSON.stringify({
    ...storedState,
    run_id: "different-run"
  }, null, 2)}\n`);
  await unlink(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH));
  await assert.rejects(
    loadRun("resource-contract-smoke", cwd),
    /run state run_id mismatch: expected resource-contract-smoke, got different-run/
  );
  await writeFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), `${JSON.stringify(storedManifest, null, 2)}\n`);
  await assert.rejects(
    loadRun("resource-contract-smoke", cwd),
    /run state run_id mismatch: expected resource-contract-smoke, got different-run/
  );
  await writeFile(path.join(runPath, FLOW_RUN_STATE_FILE), `${JSON.stringify({
    ...storedState,
    definition_id: "different-definition"
  }, null, 2)}\n`);
  await unlink(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH));
  await assert.rejects(
    loadRun("resource-contract-smoke", cwd),
    /run state definition_id mismatch: expected resource-contract-flow, got different-definition/
  );
  await writeFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), `${JSON.stringify(storedManifest, null, 2)}\n`);
  await assert.rejects(
    loadRun("resource-contract-smoke", cwd),
    /run state definition_id mismatch: expected resource-contract-flow, got different-definition/
  );
  await writeFile(path.join(runPath, FLOW_RUN_STATE_FILE), `${JSON.stringify(storedState, null, 2)}\n`);
  await writeFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), `${JSON.stringify({
    ...storedManifest,
    definition_id: "different-definition"
  }, null, 2)}\n`);
  await assert.rejects(
    loadRun("resource-contract-smoke", cwd),
    /evidence manifest definition_id mismatch: expected resource-contract-flow, got different-definition/
  );
});

test("flat definitions without route-back fields remain valid", () => {
  const flatDefinition = {
    id: "flat-flow",
    version: "1",
    steps: [
      { id: "plan", next: "verify" },
      { id: "verify", next: null }
    ],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [
          {
            id: "tests-passed",
            kind: "surface.claim",
            required: true,
            description: "Tests passed.",
            claim: { type: "quality.tests", subject: "flat-flow", accepted_statuses: ["trusted"] }
          }
        ]
      }
    }
  };
  assert.doesNotThrow(() => validateDefinition(flatDefinition));
});

test("gate-level requires is rejected in favor of typed expects", () => {
  const flatDefinition = {
    id: "flat-flow",
    version: "1",
    steps: [
      { id: "plan", next: "verify" },
      { id: "verify", next: null }
    ],
    gates: {
      "verify-gate": { step: "verify", requires: ["tests"] }
    }
  };
  const result = validateDefinitionWithDiagnostics(flatDefinition);
  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
    "definition.gate.field.unsupported"
  ]);
  assert.equal(result.diagnostics[0].path, "$.gates.verify-gate.requires");
  assert.match(result.diagnostics[0].message, /use typed expects entries/);
  assert.throws(() => validateDefinition(flatDefinition), /unsupported field requires; use typed expects entries/);
});

test("diagnostic validation preserves valid Builder Kit and flat definitions", async () => {
  const builderKitDefinition = await json("examples/builder-kit-flow.json");
  const result = validateDefinitionWithDiagnostics(builderKitDefinition);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.doesNotThrow(() => validateDefinition(builderKitDefinition));

  const flatDefinition = {
    id: "flat-flow",
    version: "1",
    steps: [
      { id: "plan", next: "verify" },
      { id: "verify", next: null }
    ],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [
          {
            id: "tests-passed",
            kind: "surface.claim",
            required: true,
            description: "Tests passed.",
            claim: { type: "quality.tests", subject: "flat-flow", accepted_statuses: ["trusted"] }
          },
          {
            id: "lint-passed",
            kind: "surface.claim",
            required: true,
            description: "Lint passed.",
            claim: { type: "quality.lint", subject: "flat-flow", accepted_statuses: ["trusted"] }
          }
        ]
      }
    }
  };
  assert.deepEqual(validateDefinitionWithDiagnostics(flatDefinition), {
    valid: true,
    diagnostics: []
  });
  assert.doesNotThrow(() => validateDefinition(flatDefinition));
});

test("diagnostic validation reports invalid claim expectations and route targets", async () => {
  const definition = await json("examples/invalid-claim-expectation-flow.json");
  const result = validateDefinitionWithDiagnostics(definition);
  assert.equal(result.valid, false);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
    "definition.expectation.claim.required",
    "definition.expectation.claim.type.required",
    "definition.expectation.claim.accepted_statuses.invalid",
    "definition.expectation.kind.unsupported",
    "definition.gate.route_back.target.unknown",
    "definition.gate.route_back_policy.on_exceeded.unknown"
  ]);
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.path), [
    "$.gates.verify-gate.expects[0].claim",
    "$.gates.verify-gate.expects[1].claim.type",
    "$.gates.verify-gate.expects[2].claim.accepted_statuses",
    "$.gates.verify-gate.expects[3].kind",
    "$.gates.verify-gate.on_route_back.implementation_defect",
    "$.gates.verify-gate.route_back_policy.on_exceeded"
  ]);
  assert.throws(() => validateDefinition(definition), /surface\.claim expectations must include claim/);
});

test("route-back definitions accept block on_exceeded and open route reasons", () => {
  const definition = routeBackDefinition();
  assert.doesNotThrow(() => validateDefinition(definition));
  assert.equal(definition.gates["verify-gate"].route_back_policy.on_exceeded, "block");
  assert.equal(definition.gates["verify-gate"].on_route_back.custom_vendor_reason, "recover");
});

test("route target validation rejects unknown route-back targets", () => {
  assert.throws(
    () => validateDefinition(routeBackDefinition({
      on_route_back: { implementation_defect: "missing-step" }
    })),
    /on_route_back\.implementation_defect references unknown step: missing-step/
  );

  assert.throws(
    () => validateDefinition(routeBackDefinition({
      route_back_policy: { max_attempts: 2, on_exceeded: "missing-step" }
    })),
    /route_back_policy\.on_exceeded references unknown step: missing-step/
  );
});
