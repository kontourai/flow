import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
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

  assert.equal(definitionSchema.properties.version.type, "string");
  assert.equal(runSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(evidenceSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(reportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);

  requireSchemaFields(definitionSchema, ["id", "version", "steps", "gates"]);
  requireSchemaFields(runSchema, ["schema_version", "run_id", "definition_id", "status", "current_step", "gate_outcomes", "transitions", "exceptions"]);
  requireSchemaFields(evidenceSchema, ["schema_version", "evidence"]);
  requireSchemaFields(reportSchema, ["schema_version", "run_id", "definition_id", "status", "summary", "current_step", "gate_summaries"]);
});

test("example definition matches the v0.1 runtime shape", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  assert.equal(definition.id, "agent-dev-flow");
  assert.equal(definition.version, "1");
  assert.deepEqual(definition.steps.map((step) => step.id), ["plan", "implement", "verify", "publish"]);
  assert.deepEqual(definition.gates["verify-gate"].requires, ["tests", "lint", "browser-evidence", "veritas-readiness"]);
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
