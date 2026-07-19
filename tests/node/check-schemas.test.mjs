import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FLOW_SCHEMA_VERSION,
  attachEvidence,
  authorizeRetry,
  evaluateRun,
  flowRunHead,
  flowTransitionRef,
  initialState,
  loadRun,
  reportJson,
  startRun
} from "../../dist/index.js";
import { requireSchemaDefFields, requireSchemaFields } from "./helpers/assertions.mjs";
import { json } from "./helpers/fixtures.mjs";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

test("schemas describe the runtime contract", async () => {
  const definitionSchema = await json("schemas/flow-definition.schema.json");
  const runSchema = await json("schemas/flow-run.schema.json");
  const evidenceSchema = await json("schemas/gate-evidence.schema.json");
  const commandEvidenceSchema = await json("schemas/command-evidence.schema.json");
  const reportSchema = await json("schemas/flow-report.schema.json");
  const configSchema = await json("schemas/flow-config.schema.json");
  const configMergeReportSchema = await json("schemas/flow-config-merge-report.schema.json");
  const transitionValidationRequestSchema = await json("schemas/flow-transition-validation-request.schema.json");
  const transitionValidationResultSchema = await json("schemas/flow-transition-validation-result.schema.json");
  const releaseReadinessPolicySchema = await json("schemas/release-readiness-policy.schema.json");
  const releaseReadinessResultSchema = await json("schemas/release-readiness-result.schema.json");
  const versionReleaseReportSchema = await json("schemas/version-release-report.schema.json");

  assert.deepEqual(definitionSchema.oneOf, [
    { $ref: "#/$defs/flat_definition" },
    { $ref: "#/$defs/resource_definition" }
  ]);
  assert.equal(definitionSchema.$defs.flat_definition.properties.version.type, "string");
  assert.equal(definitionSchema.$defs.flat_definition.properties.steps.$ref, "#/$defs/steps");
  assert.equal(definitionSchema.$defs.flat_definition.properties.gates.$ref, "#/$defs/gates");
  assert.equal(definitionSchema.$defs.resource_definition.properties.apiVersion.const, "flow.kontourai.io/v1alpha1");
  assert.equal(definitionSchema.$defs.resource_definition.properties.kind.const, "FlowDefinition");
  assert.equal(definitionSchema.$defs.resource_definition.properties.spec.$ref, "#/$defs/resource_spec");
  assert.equal(definitionSchema.$defs.resource_metadata.properties.name.$ref, "#/$defs/definition_name");
  assert.equal(definitionSchema.$defs.resource_metadata.properties.labels.$ref, "#/$defs/resource_string_map");
  assert.equal(definitionSchema.$defs.resource_metadata.properties.annotations.$ref, "#/$defs/resource_string_map");
  assert.equal(definitionSchema.$defs.resource_spec.properties.version.type, "string");
  assert.equal(definitionSchema.$defs.resource_spec.properties.steps.$ref, "#/$defs/steps");
  assert.equal(definitionSchema.$defs.resource_spec.properties.gates.$ref, "#/$defs/gates");
  assert.equal(definitionSchema.$defs.steps.items.$ref, "#/$defs/step");
  assert.equal(definitionSchema.$defs.gates.additionalProperties.$ref, "#/$defs/gate");
  assert.equal(runSchema.title, "Flow Run State");
  assert.match(runSchema.description, /state\.json/);
  assert.match(runSchema.description, /not a Resource Contract envelope/);
  assert.equal(runSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.match(runSchema.properties.run_id.description, /\.kontourai\/flow\/runs\/<run-id>/);
  assert.match(runSchema.properties.current_step.description, /step id/);
  assert.match(runSchema.properties.gate_outcomes.description, /gate decisions/);
  assert.match(runSchema.properties.gate_outcome_history.description, /Append-only/);
  assert.match(runSchema.properties.transitions.description, /route-back attempt counting/);
  assert.deepEqual(runSchema.properties.status.enum, ["active", "blocked", "needs_decision", "paused", "canceled", "completed", "failed", "accepted_by_exception"]);
  assert.equal(runSchema.properties.lifecycle.items.$ref, "#/$defs/lifecycle_event");
  assert.match(runSchema.properties.lifecycle.description, /never count as Step transitions/);
  assert.deepEqual(runSchema.$defs.lifecycle_authority.properties.kind.enum, ["user_request", "operator_request"]);
  assert.equal(runSchema.$defs.lifecycle_authority.properties.request_ref.minLength, 1);
  assert.equal(runSchema.$defs.lifecycle_authority.properties.actor.maxLength, 256);
  assert.equal(runSchema.$defs.lifecycle_authority.properties.request_ref.maxLength, 2048);
  assert.equal(runSchema.$defs.lifecycle_event.properties.reason.maxLength, 4096);
  assert.match(runSchema.$defs.lifecycle_authority.properties.actor.pattern, /u001F/);
  assert.equal(runSchema.allOf[0].then.properties.lifecycle.minItems, 1);
  assert.deepEqual(runSchema.$defs.lifecycle_event.properties.prior_status.enum, ["active", "blocked", "needs_decision"]);
  const retryTransitionContract = runSchema.$defs.transition.allOf[0].then;
  for (const field of ["gate_id", "route_reason", "selected_route", "blocked_transition_ref", "prior_run_head", "prior_retry_epoch", "retry_epoch", "authority"]) {
    assert.ok(retryTransitionContract.required.includes(field), `retry transition requires ${field}`);
  }
  assert.equal(retryTransitionContract.properties.status.const, "retry-authorized");
  assert.equal(runSchema.$defs.transition.allOf[1].then.properties.type.const, "retry_authorized");
  assert.equal(evidenceSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(commandEvidenceSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.deepEqual(commandEvidenceSchema.properties.command.items, { type: "string" });
  assert.equal(commandEvidenceSchema.properties.exit_code.type[1], "null");
  assert.equal(commandEvidenceSchema.properties.stdout.$ref, "#/$defs/output");
  assert.equal(commandEvidenceSchema.properties.stderr.$ref, "#/$defs/output");
  assert.equal(commandEvidenceSchema.properties.duration_ms.minimum, 0);
  assert.equal(commandEvidenceSchema.properties.output_sha256.pattern, "^[a-f0-9]{64}$");
  requireSchemaFields(commandEvidenceSchema, ["schema_version", "command", "exit_code", "stdout", "stderr", "duration_ms", "output_sha256"]);
  requireSchemaDefFields(commandEvidenceSchema, "output", ["content", "byte_count", "captured_byte_count", "truncated"]);
  assert.match(evidenceSchema.description, /\.kontourai\/flow\/runs\/<run-id>\/evidence\/manifest\.json/);
  assert.match(evidenceSchema.description, /standalone scenario manifests may omit/);
  assert.match(evidenceSchema.description, /not an authored Resource Contract/);
  assert.equal(evidenceSchema.properties.run_id.minLength, 1);
  assert.equal(evidenceSchema.properties.definition_id.minLength, 1);
  assert.equal(reportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(reportSchema.properties.state_head.pattern, "^[a-f0-9]{64}$");
  assert.deepEqual(configSchema.oneOf, [
    { $ref: "#/$defs/flat_config" },
    { $ref: "#/$defs/resource_config" }
  ]);
  assert.equal(configSchema.$defs.flat_config.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configSchema.$defs.flat_config.properties.trusted_producers.$ref, "#/$defs/trusted_producers");
  assert.equal(configSchema.$defs.flat_config.properties.gate_overrides.$ref, "#/$defs/gate_overrides");
  assert.equal(configSchema.$defs.resource_config.properties.apiVersion.const, "flow.kontourai.io/v1alpha1");
  assert.equal(configSchema.$defs.resource_config.properties.kind.const, "FlowProjectConfig");
  assert.equal(configSchema.$defs.resource_config.properties.spec.$ref, "#/$defs/config_spec");
  assert.equal(configSchema.$defs.resource_metadata.properties.name.$ref, "#/$defs/config_name");
  assert.equal(configSchema.$defs.resource_metadata.properties.labels.$ref, "#/$defs/resource_string_map");
  assert.equal(configSchema.$defs.resource_metadata.properties.annotations.$ref, "#/$defs/resource_string_map");
  assert.equal(configSchema.$defs.config_spec.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configSchema.$defs.config_spec.properties.trusted_producers.$ref, "#/$defs/trusted_producers");
  assert.equal(configSchema.$defs.config_spec.properties.gate_overrides.$ref, "#/$defs/gate_overrides");
  assert.deepEqual(configSchema.$defs.safe_map_key.not.enum, ["__proto__", "prototype", "constructor"]);
  assert.equal(configSchema.$defs.resource_string_map.propertyNames.$ref, "#/$defs/safe_map_key");
  assert.equal(configSchema.$defs.trusted_producers.propertyNames.$ref, "#/$defs/safe_map_key");
  assert.equal(configSchema.$defs.gate_overrides.propertyNames.$ref, "#/$defs/safe_map_key");
  assert.equal(configSchema.$defs.gate_override.properties.expectations.propertyNames.$ref, "#/$defs/safe_map_key");
  assert.equal(configMergeReportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configMergeReportSchema.properties.merged_config.$ref, "flow-config.schema.json#/$defs/flat_config");
  assert.equal(transitionValidationRequestSchema.title, "Flow Transition Validation Request");
  assert.equal(transitionValidationRequestSchema.properties.config.$ref, "flow-config.schema.json#/$defs/flat_config");
  assert.equal(transitionValidationResultSchema.title, "Flow Transition Validation Result");
  assert.equal(releaseReadinessPolicySchema.title, "Release Readiness Policy");
  assert.equal(releaseReadinessResultSchema.title, "Release Readiness Result");
  assert.equal(versionReleaseReportSchema.title, "Version Release Report");

  assert.ok(definitionSchema.$defs.gate.properties.on_route_back);
  assert.ok(definitionSchema.$defs.gate.properties.expects);
  assert.equal(definitionSchema.$defs.gate.properties.requires, undefined);
  assert.ok(definitionSchema.$defs.gate.properties.route_back_policy);
  assert.equal(definitionSchema.$defs.gate.properties.route_back_policy.properties.allow_unknown_reasons.type, "boolean");
  assert.ok(evidenceSchema.$defs.evidence.properties.route_reason);
  assert.ok(evidenceSchema.$defs.evidence.properties.bundle);
  assert.equal(evidenceSchema.$defs.evidence.properties.bundle.additionalProperties, true);
  assert.ok(evidenceSchema.$defs.evidence.properties.bundle.properties.claims);
  assert.ok(evidenceSchema.$defs.evidence.properties.authority_traces);
  assert.ok(evidenceSchema.$defs.evidence.properties.classifier);
  assert.ok(runSchema.$defs.gate_outcome.properties.route_reason);
  assert.ok(runSchema.$defs.gate_outcome.properties.retry_epoch);
  assert.ok(runSchema.$defs.transition.properties.route_reason);
  assert.ok(runSchema.$defs.transition.properties.retry_epoch);
  assert.ok(runSchema.$defs.transition.properties.blocked_transition_ref);
  assert.ok(runSchema.$defs.transition.properties.prior_run_head);
  assert.ok(runSchema.$defs.transition.properties.prior_retry_epoch);
  assert.ok(runSchema.$defs.transition.properties.authority);
  assert.ok(runSchema.$defs.lifecycle_event.properties.authority);
  assert.ok(reportSchema.properties.retry_authorizations);
  assert.ok(reportSchema.properties.retry_authorizations.items.required.includes("max_attempts"));
  assert.ok(reportSchema.properties.retry_authorizations.items.required.includes("consumed_attempts"));
  assert.ok(reportSchema.properties.retry_authorizations.items.required.includes("next_attempt"));
  assert.ok(reportSchema.properties.retry_authorizations.items.required.includes("remaining_attempts"));
  assert.ok(reportSchema.properties.retry_authorizations.items.required.includes("budget_status"));
  assert.ok(reportSchema.properties.gate_summaries.items.properties.route_reason);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.retry_epoch);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.selected_route);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.recovery_step);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.analytics_loop_key);
  assert.ok(transitionValidationRequestSchema.properties.definition);
  assert.ok(transitionValidationRequestSchema.properties.current_state);
  assert.ok(transitionValidationRequestSchema.properties.state);
  assert.ok(transitionValidationRequestSchema.properties.proposed_transition);
  assert.ok(transitionValidationRequestSchema.properties.transition);
  assert.ok(transitionValidationRequestSchema.properties.proposed_state);
  assert.ok(transitionValidationRequestSchema.properties.manifest);
  assert.ok(transitionValidationRequestSchema.properties.evidence_refs);
  assert.ok(transitionValidationRequestSchema.properties.config);
  assert.ok(transitionValidationRequestSchema.properties.now);
  assert.ok(transitionValidationResultSchema.properties.valid);
  assert.ok(transitionValidationResultSchema.properties.status);
  assert.ok(transitionValidationResultSchema.properties.diagnostics);
  assert.ok(transitionValidationResultSchema.properties.transition);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.route_reason);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.retry_epoch);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.evidence_refs);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.expectation_ids);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.classifier);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.diagnostics);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.analytics);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.analytics_loop_key);

  requireSchemaDefFields(definitionSchema, "flat_definition", ["id", "version", "steps", "gates"]);
  requireSchemaDefFields(definitionSchema, "resource_definition", ["apiVersion", "kind", "metadata", "spec"]);
  requireSchemaDefFields(definitionSchema, "resource_metadata", ["name"]);
  requireSchemaDefFields(definitionSchema, "resource_spec", ["version", "steps", "gates"]);
  requireSchemaFields(runSchema, ["schema_version", "run_id", "definition_id", "status", "current_step", "gate_outcomes", "transitions", "exceptions"]);
  requireSchemaFields(evidenceSchema, ["schema_version", "evidence"]);
  assert.ok(evidenceSchema.properties.run_id);
  assert.ok(evidenceSchema.properties.definition_id);
  requireSchemaFields(reportSchema, ["schema_version", "state_head", "run_id", "definition_id", "status", "summary", "current_step", "gate_summaries"]);
  requireSchemaDefFields(configSchema, "flat_config", ["schema_version"]);
  requireSchemaDefFields(configSchema, "resource_config", ["apiVersion", "kind", "metadata", "spec"]);
  requireSchemaDefFields(configSchema, "resource_metadata", ["name"]);
  requireSchemaDefFields(configSchema, "config_spec", ["schema_version"]);
  requireSchemaFields(configMergeReportSchema, ["schema_version", "mode", "status", "local_config_path", "proposal_path", "proposed_changes", "accepted_changes", "rejected_changes", "conflicts", "unchanged", "exceptions", "merged_config", "summary"]);
  requireSchemaFields(transitionValidationRequestSchema, ["definition"]);
  requireSchemaFields(transitionValidationResultSchema, ["valid", "status", "diagnostics", "transition"]);
  requireSchemaFields(releaseReadinessPolicySchema, ["schema_version", "id", "lanes", "risk_classes"]);
  requireSchemaFields(releaseReadinessResultSchema, ["schema_version", "policy_id", "decision", "risk_class", "subject", "required_lanes", "lanes", "evidence", "report_data"]);
  requireSchemaFields(versionReleaseReportSchema, ["schema_version", "version", "subject", "decision", "status", "summary", "changeset", "verification_evidence", "release_evidence", "exceptions", "accepted_risks", "gaps", "external_links", "native_refs", "report_data"]);
  assert.ok(configMergeReportSchema.$defs.change.properties.path);
  assert.ok(configMergeReportSchema.$defs.change.properties.section);
  assert.ok(configMergeReportSchema.$defs.change.properties.local_value);
  assert.ok(releaseReadinessPolicySchema.$defs.lane.properties.claim.properties.accepted_statuses);
  assert.deepEqual(releaseReadinessResultSchema.$defs.lane_outcome.properties.status.enum, ["pass", "hold", "not_required", "not_verified"]);
  assert.ok(releaseReadinessResultSchema.$defs.lane_outcome.properties.external_links);
  assert.ok(releaseReadinessResultSchema.$defs.lane_outcome.properties.native_refs);
  assert.deepEqual(versionReleaseReportSchema.properties.decision.enum, ["ready", "hold"]);
  assert.equal(versionReleaseReportSchema.properties.release_evidence.$ref, "release-readiness-result.schema.json");
  assert.deepEqual(versionReleaseReportSchema.$defs.gap.properties.kind.enum, ["verification_evidence", "release_lane"]);
});

test("runtime-generated run and report satisfy required schema fields", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  const state = initialState(definition, "schema-check", { subject: "feature-search-filters" });
  const report = reportJson(definition, state, { schema_version: FLOW_SCHEMA_VERSION, evidence: [] });
  assert.equal(state.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(state.definition_id, definition.id);
  assert.deepEqual(state.lifecycle, []);
  assert.equal(report.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(report.definition_id, definition.id);
});

test("transition-validation request schema round-trips a recovered retry-authorized state", async () => {
  const schemas = await Promise.all([
    json("schemas/flow-transition-validation-request.schema.json"),
    json("schemas/flow-definition.schema.json"),
    json("schemas/gate-evidence.schema.json"),
    json("schemas/flow-config.schema.json"),
    json("schemas/flow-run.schema.json")
  ]);
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const schema of schemas.slice(1)) ajv.addSchema(schema);
  const validate = ajv.compile(schemas[0]);
  const validateRun = ajv.getSchema("https://kontourai.io/schemas/flow-run.schema.json");

  const cwd = await mkdtemp(path.join(tmpdir(), "flow-schema-recovered-"));
  const definition = {
    id: "schema-recovered-retry", version: "1",
    steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify", expects: [],
        on_route_back: { implementation_defect: "verify", default: "verify" },
        route_back_policy: { max_attempts: 3, on_exceeded: "block" }
      }
    }
  };
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "failed.txt");
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  await writeFile(evidencePath, "failed\n");
  const started = await startRun(definitionPath, { cwd, runId: "schema-recovered-retry" });
  await attachEvidence(started.runId, {
    cwd, gate: "verify-gate", file: evidencePath, status: "failed", route_reason: "implementation_defect"
  });
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await evaluateRun(started.runId, { cwd, gate: "verify-gate", now: `2026-07-19T15:0${attempt}:00.000Z` });
  }
  const exhausted = await loadRun(started.runId, cwd);
  const blocked = exhausted.state.transitions.at(-1);
  const recovered = await authorizeRetry(started.runId, {
    cwd,
    request: {
      reason: "Operator approved another bounded epoch.", target_step: blocked.selected_route,
      blocked_transition_ref: flowTransitionRef(blocked), expected_run_head: flowRunHead(exhausted.state),
      authority: {
        kind: "operator_request", actor: "operator:test", request_ref: "request:schema-retry",
        requested_at: "2026-07-19T15:05:00.000Z"
      }
    }
  });
  const request = JSON.parse(JSON.stringify({
    definition: recovered.definition,
    current_state: recovered.state,
    proposed_transition: { from_step: "verify", to_step: null, status: "completed" },
    manifest: recovered.manifest,
    now: "2026-07-19T15:06:00.000Z"
  }));
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(request.current_state.transitions.at(-1).type, "retry_authorized");
  assert.equal(request.current_state.transitions.at(-1).status, "retry-authorized");
  assert.equal(validateRun(request.current_state), true, JSON.stringify(validateRun.errors));

  const wrongStatus = structuredClone(request);
  wrongStatus.current_state.transitions.at(-1).status = "blocked";
  assert.equal(validate(wrongStatus), false, "retry_authorized type requires retry-authorized status");
  const wrongType = structuredClone(request);
  wrongType.current_state.transitions.at(-1).type = "step";
  assert.equal(validate(wrongType), false, "retry-authorized status requires retry_authorized type");

  const hiddenAuthorization = structuredClone(request);
  hiddenAuthorization.current_state.transitions.at(-1).type = "step";
  hiddenAuthorization.current_state.transitions.at(-1).status = "allowed";
  assert.equal(validate(hiddenAuthorization), false, "authorization fields reserve the retry_authorized discriminator");
  assert.equal(validateRun(hiddenAuthorization.current_state), false, "flow-run schema also reserves authorization fields");

  const ambiguous = structuredClone(request);
  ambiguous.current_state.transitions.at(-2).blocked_transition_ref = "a".repeat(64);
  assert.equal(validate(ambiguous), false, "route-only and authorization-only fields cannot share a transition");
  assert.equal(validateRun(ambiguous.current_state), false, "flow-run schema rejects ambiguous field families");

  const partialRoute = structuredClone(request);
  partialRoute.proposed_transition.attempt = 1;
  assert.equal(validate(partialRoute), false, "route-only fields reserve the route_back discriminator");

  const sharedContext = structuredClone(request);
  sharedContext.proposed_transition.selected_route = "verify";
  assert.equal(validate(sharedContext), true, "selected_route alone remains valid shared transition context");
});
