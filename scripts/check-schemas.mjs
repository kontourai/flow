import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  defaultFlowConfig,
  evaluateGate,
  FLOW_SCHEMA_VERSION,
  initialState,
  reportJson
} from "../src/index.js";

async function json(file) {
  return JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
}

function requireSchemaFields(schema, fields) {
  for (const field of fields) {
    assert.ok(schema.required.includes(field), `${schema.title} must require ${field}`);
    assert.ok(schema.properties[field], `${schema.title} must define ${field}`);
  }
}

test("schemas describe the runtime contract", async () => {
  const definitionSchema = await json("schemas/flow-definition.schema.json");
  const runSchema = await json("schemas/flow-run.schema.json");
  const evidenceSchema = await json("schemas/gate-evidence.schema.json");
  const reportSchema = await json("schemas/flow-report.schema.json");
  const configSchema = await json("schemas/flow-config.schema.json");

  assert.equal(definitionSchema.properties.version.type, "string");
  assert.equal(runSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(evidenceSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(reportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);

  requireSchemaFields(definitionSchema, ["id", "version", "steps", "gates"]);
  requireSchemaFields(runSchema, ["schema_version", "run_id", "definition_id", "status", "current_step", "gate_outcomes", "transitions", "exceptions"]);
  requireSchemaFields(evidenceSchema, ["schema_version", "evidence"]);
  requireSchemaFields(reportSchema, ["schema_version", "run_id", "definition_id", "status", "summary", "current_step", "gate_summaries"]);
  requireSchemaFields(configSchema, ["schema_version"]);
});

test("example definition matches the v0.1 runtime shape", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  assert.equal(definition.id, "agent-dev-flow");
  assert.equal(definition.version, "1");
  assert.deepEqual(definition.steps.map((step) => step.id), ["plan", "implement", "verify", "publish"]);
  assert.equal(definition.gates["verify-gate"].expects[0].kind, "surface.claim");
  assert.equal(definition.gates["verify-gate"].expects[0].claim.subject, "builder.verify");
  assert.notEqual(definition.gates["verify-gate"].expects[0].kind, "surface-claim");
});

test("runtime-generated run and report satisfy required schema fields", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  const state = initialState(definition, "schema-check", { subject: "feature-search-filters" });
  const report = reportJson(definition, state, { schema_version: FLOW_SCHEMA_VERSION, evidence: [] });
  assert.equal(state.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(state.definition_id, definition.id);
  assert.equal(report.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(report.definition_id, definition.id);
});

test("surface claim expectations evaluate required, optional, trusted producer, and overrides", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  const state = initialState(definition, "claim-check", { subject: "feature-search-filters" });
  const emptyManifest = { schema_version: FLOW_SCHEMA_VERSION, evidence: [] };
  const trustedConfig = {
    ...defaultFlowConfig(),
    trusted_producers: {
      "quality.tests": { producers: ["ci/main"] },
      "quality.browser-evidence": { producers: ["browser/check"] }
    }
  };

  const missing = evaluateGate(definition, state, emptyManifest, "verify-gate", trustedConfig);
  assert.equal(missing.status, "block");
  assert.deepEqual(missing.missing, ["tests-passed"]);
  assert.deepEqual(missing.optional_missing, ["browser-evidence-reviewed"]);

  const untrusted = evaluateGate(definition, state, {
    schema_version: FLOW_SCHEMA_VERSION,
    evidence: [{
      id: "ev.untrusted",
      gate_id: "verify-gate",
      kind: "surface.claim",
      requested_kind: "surface.claim",
      status: "passed",
      claim: { type: "quality.tests", subject: "builder.verify", status: "trusted" },
      producer: "ci/fork",
      attached_at: "2026-05-26T00:00:00.000Z"
    }]
  }, "verify-gate", trustedConfig);
  assert.equal(untrusted.status, "block");

  const accepted = evaluateGate(definition, state, {
    schema_version: FLOW_SCHEMA_VERSION,
    evidence: [{
      id: "ev.trusted",
      gate_id: "verify-gate",
      kind: "surface.claim",
      requested_kind: "surface.claim",
      status: "passed",
      claim: { type: "quality.tests", subject: "builder.verify", status: "trusted" },
      producer: "ci/main",
      attached_at: "2026-05-26T00:00:00.000Z"
    }]
  }, "verify-gate", trustedConfig);
  assert.equal(accepted.status, "pass");
  assert.deepEqual(accepted.optional_missing, ["browser-evidence-reviewed"]);

  const overrideConfig = {
    ...trustedConfig,
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": { required: false }
        }
      }
    }
  };
  const optionalOnly = evaluateGate(definition, state, emptyManifest, "verify-gate", overrideConfig);
  assert.equal(optionalOnly.status, "pass");
  assert.deepEqual(optionalOnly.optional_missing, ["tests-passed", "browser-evidence-reviewed"]);
});
