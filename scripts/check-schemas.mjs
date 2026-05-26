import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  applyEvaluation,
  applyFlowConfigMerge,
  defaultFlowConfig,
  evaluateGate,
  FLOW_SCHEMA_VERSION,
  initialState,
  previewFlowConfigMerge,
  renderMarkdownReport,
  renderConfigMergeMarkdown,
  renderResume,
  renderSummary,
  reportJson,
  validateDefinition,
  validateDefinitionWithDiagnostics
} from "../src/index.js";

const execFile = promisify(execFileCallback);

async function json(file) {
  return JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
}

function requireSchemaFields(schema, fields) {
  for (const field of fields) {
    assert.ok(schema.required.includes(field), `${schema.title} must require ${field}`);
    assert.ok(schema.properties[field], `${schema.title} must define ${field}`);
  }
}

function routeBackDefinition(overrides = {}) {
  return {
    id: "route-back-fixture",
    version: "1",
    steps: [
      { id: "plan", "next": "implement" },
      { id: "implement", "next": "verify" },
      { id: "verify", "next": "recover" },
      { id: "recover", "next": null }
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
            claim: {
              type: "quality.tests",
              subject: "builder.verify",
              accepted_statuses: ["trusted"]
            }
          }
        ],
        on_route_back: {
          missing_evidence: "verify",
          implementation_defect: "implement",
          plan_gap: "plan",
          decision_gap: "plan",
          custom_vendor_reason: "recover",
          default: "implement"
        },
        route_back_policy: {
          max_attempts: 2,
          on_exceeded: "block"
        },
        ...overrides
      }
    }
  };
}

function routeBackManifest(evidence) {
  return { schema_version: FLOW_SCHEMA_VERSION, evidence };
}

function failedEvidence(fields = {}) {
  return {
    id: fields.id ?? "ev.failed",
    gate_id: "verify-gate",
    kind: "surface.claim",
    requested_kind: "surface.claim",
    status: "failed",
    attached_at: "2026-05-26T00:00:00.000Z",
    ...fields
  };
}

test("schemas describe the runtime contract", async () => {
  const definitionSchema = await json("schemas/flow-definition.schema.json");
  const runSchema = await json("schemas/flow-run.schema.json");
  const evidenceSchema = await json("schemas/gate-evidence.schema.json");
  const reportSchema = await json("schemas/flow-report.schema.json");
  const configSchema = await json("schemas/flow-config.schema.json");
  const configMergeReportSchema = await json("schemas/flow-config-merge-report.schema.json");

  assert.equal(definitionSchema.properties.version.type, "string");
  assert.equal(runSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(evidenceSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(reportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configMergeReportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);

  assert.ok(definitionSchema.$defs.gate.properties.on_route_back);
  assert.ok(definitionSchema.$defs.gate.properties.route_back_policy);
  assert.ok(evidenceSchema.$defs.evidence.properties.route_reason);
  assert.ok(evidenceSchema.$defs.evidence.properties.classifier);
  assert.ok(runSchema.$defs.gate_outcome.properties.route_reason);
  assert.ok(runSchema.$defs.transition.properties.route_reason);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.route_reason);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.selected_route);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.recovery_step);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.analytics_loop_key);

  requireSchemaFields(definitionSchema, ["id", "version", "steps", "gates"]);
  requireSchemaFields(runSchema, ["schema_version", "run_id", "definition_id", "status", "current_step", "gate_outcomes", "transitions", "exceptions"]);
  requireSchemaFields(evidenceSchema, ["schema_version", "evidence"]);
  requireSchemaFields(reportSchema, ["schema_version", "run_id", "definition_id", "status", "summary", "current_step", "gate_summaries"]);
  requireSchemaFields(configSchema, ["schema_version"]);
  requireSchemaFields(configMergeReportSchema, ["schema_version", "mode", "status", "local_config_path", "proposal_path", "proposed_changes", "accepted_changes", "rejected_changes", "conflicts", "unchanged", "exceptions", "merged_config", "summary"]);
  assert.ok(configMergeReportSchema.$defs.change.properties.path);
  assert.ok(configMergeReportSchema.$defs.change.properties.section);
  assert.ok(configMergeReportSchema.$defs.change.properties.local_value);
});

function localConfigFixture() {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: {
      "quality.tests": {
        producers: ["ci/main"],
        authority_traces: ["github:main"]
      },
      "quality.browser-evidence": {
        producers: ["browser/main"]
      }
    },
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": {
            required: true,
            accepted_statuses: ["trusted"],
            trusted_producers: ["ci/main"]
          }
        }
      }
    }
  };
}

function proposedConfigFixture() {
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: {
      "quality.tests": {
        producers: ["ci/kit"],
        authority_traces: ["github:kit"]
      },
      "quality.browser-evidence": {
        producers: ["browser/main"]
      },
      "quality.lint": {
        producers: ["lint/kit"]
      }
    },
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": {
            required: false,
            accepted_statuses: ["trusted", "verified"],
            trusted_producers: ["ci/kit"]
          },
          "lint-passed": {
            required: true,
            accepted_statuses: ["trusted"]
          }
        }
      }
    }
  };
}

test("config merge preview reports accepted, rejected, conflicts, unchanged without mutating inputs", () => {
  const local = localConfigFixture();
  const before = JSON.stringify(local);
  const report = previewFlowConfigMerge(local, proposedConfigFixture(), {
    localConfigPath: "/tmp/project/.flow/config.json",
    proposalPath: "/tmp/proposal.json"
  });

  assert.equal(JSON.stringify(local), before);
  assert.equal(report.mode, "preview");
  assert.equal(report.status, "conflicts");
  assert.ok(report.proposed_changes.length > 0);
  assert.ok(report.accepted_changes.some((change) => change.path === "$.trusted_producers.quality.lint.producers"));
  assert.ok(report.accepted_changes.some((change) => change.path === "$.gate_overrides.verify-gate.expectations.lint-passed.required"));
  assert.ok(report.unchanged.some((change) => change.path === "$.trusted_producers.quality.browser-evidence.producers"));
  assert.ok(report.conflicts.some((change) => change.path === "$.trusted_producers.quality.tests.producers"));
  assert.ok(report.rejected_changes.some((change) => change.path === "$.gate_overrides.verify-gate.expectations.tests-passed.required"));
  assert.deepEqual(report.merged_config.trusted_producers["quality.tests"].producers, ["ci/main"]);
  assert.equal(report.merged_config.gate_overrides["verify-gate"].expectations["tests-passed"].required, true);
  assert.deepEqual(Object.keys(report.summary), ["proposed", "accepted", "rejected", "conflicts", "unchanged", "exceptions"]);
});

test("config merge accepts conflicting authority only with explicit exception reason and authority", () => {
  assert.throws(
    () => previewFlowConfigMerge(localConfigFixture(), proposedConfigFixture(), {
      acceptConflicts: ["$.trusted_producers.quality.tests"]
    }),
    /requires exception reason and authority/
  );

  const report = previewFlowConfigMerge(localConfigFixture(), proposedConfigFixture(), {
    acceptConflicts: ["$.trusted_producers.quality.tests"],
    exceptionReason: "project owner accepted kit authority update",
    authority: "owner@example.com"
  });

  assert.ok(report.exceptions.length >= 2);
  assert.equal(report.exceptions[0].reason, "project owner accepted kit authority update");
  assert.equal(report.exceptions[0].authority, "owner@example.com");
  assert.deepEqual(report.merged_config.trusted_producers["quality.tests"].producers, ["ci/kit"]);
  assert.deepEqual(report.merged_config.trusted_producers["quality.tests"].authority_traces, ["github:kit"]);
  assert.ok(report.conflicts.every((change) => !change.path.startsWith("$.trusted_producers.quality.tests")));
});

test("config merge markdown exposes human review buckets", () => {
  const report = previewFlowConfigMerge(localConfigFixture(), proposedConfigFixture());
  const markdown = renderConfigMergeMarkdown(report);
  assert.match(markdown, /# Flow Project Config Merge Report/);
  assert.match(markdown, /## Accepted Changes/);
  assert.match(markdown, /## Rejected Changes/);
  assert.match(markdown, /## Conflicts/);
  assert.match(markdown, /\$\.trusted_producers\.quality\.tests\.producers/);
});

test("config merge apply writes only accepted changes unless conflicts are explicitly accepted", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-config-merge-"));
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(localConfigFixture(), null, 2)}\n`);
  await writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(proposedConfigFixture(), null, 2)}\n`);

  const blocked = await applyFlowConfigMerge(cwd, "proposal.json");
  assert.equal(blocked.status, "blocked");
  let config = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.deepEqual(config.trusted_producers["quality.tests"].producers, ["ci/main"]);
  assert.equal(config.gate_overrides["verify-gate"].expectations["tests-passed"].required, true);

  const applied = await applyFlowConfigMerge(cwd, "proposal.json", {
    acceptConflicts: [
      "$.trusted_producers.quality.tests",
      "$.gate_overrides.verify-gate.expectations.tests-passed"
    ],
    exceptionReason: "maintainer accepted kit update",
    authority: "flow-maintainer"
  });
  assert.equal(applied.status, "applied");
  assert.ok(applied.exceptions.length > 0);
  config = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.deepEqual(config.trusted_producers["quality.tests"].producers, ["ci/kit"]);
  assert.equal(config.gate_overrides["verify-gate"].expectations["tests-passed"].required, false);
  assert.deepEqual(config.trusted_producers["quality.lint"].producers, ["lint/kit"]);
});

test("CLI config preview and apply support JSON and Markdown reports", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-config-merge-"));
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(localConfigFixture(), null, 2)}\n`);
  await writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(proposedConfigFixture(), null, 2)}\n`);

  const preview = await execFile(process.execPath, [cli, "config", "preview", "proposal.json", "--format", "json"], { cwd });
  const previewReport = JSON.parse(preview.stdout);
  assert.equal(previewReport.mode, "preview");
  assert.equal(previewReport.status, "conflicts");
  const afterPreview = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.deepEqual(afterPreview.trusted_producers["quality.tests"].producers, ["ci/main"]);

  const markdown = await execFile(process.execPath, [cli, "config", "preview", "proposal.json", "--format", "markdown"], { cwd });
  assert.match(markdown.stdout, /## Conflicts/);

  const applied = await execFile(process.execPath, [
    cli,
    "config",
    "apply",
    "proposal.json",
    "--format",
    "json",
    "--accept-conflict",
    "$.trusted_producers.quality.tests",
    "--accept-conflict",
    "$.gate_overrides.verify-gate.expectations.tests-passed",
    "--exception-reason",
    "CLI smoke accepted kit update",
    "--authority",
    "cli-smoke"
  ], { cwd });
  const applyReport = JSON.parse(applied.stdout);
  assert.equal(applyReport.status, "applied");
  assert.ok(applyReport.exceptions.some((entry) => entry.authority === "cli-smoke"));
});

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

test("legacy definitions without route-back fields remain valid", () => {
  const legacyDefinition = {
    id: "legacy-flow",
    version: "1",
    steps: [
      { id: "plan", next: "verify" },
      { id: "verify", next: null }
    ],
    gates: {
      "verify-gate": { step: "verify", requires: ["tests"] }
    }
  };
  assert.doesNotThrow(() => validateDefinition(legacyDefinition));
});

test("diagnostic validation preserves valid Builder Kit and legacy definitions", async () => {
  const builderKitDefinition = await json("examples/builder-kit-flow.json");
  const result = validateDefinitionWithDiagnostics(builderKitDefinition);
  assert.equal(result.valid, true);
  assert.deepEqual(result.diagnostics, []);
  assert.doesNotThrow(() => validateDefinition(builderKitDefinition));

  const legacyDefinition = {
    id: "legacy-flow",
    version: "1",
    steps: [
      { id: "plan", next: "verify" },
      { id: "verify", next: null }
    ],
    gates: {
      "verify-gate": { step: "verify", requires: ["tests", "lint"] }
    }
  };
  assert.deepEqual(validateDefinitionWithDiagnostics(legacyDefinition), {
    valid: true,
    diagnostics: []
  });
  assert.doesNotThrow(() => validateDefinition(legacyDefinition));
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
  assert.equal(missing.status, "route-back");
  assert.equal(missing.route_reason, "missing_evidence");
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
  assert.equal(untrusted.status, "route-back");
  assert.equal(untrusted.route_reason, "missing_evidence");

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

test("missing and unknown route reasons use default or legacy gate step fallback", () => {
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

  const legacyDefinition = routeBackDefinition({ on_route_back: undefined, route_back_policy: undefined });
  const legacyMissingReason = evaluateGate(legacyDefinition, state, routeBackManifest([
    failedEvidence({ id: "ev.legacy-no-reason" })
  ]), "verify-gate");
  assert.equal(legacyMissingReason.route_back_to, "verify");
  assert.equal(legacyMissingReason.reason, "default");

  const legacyUnknownReason = evaluateGate(legacyDefinition, state, routeBackManifest([
    failedEvidence({ id: "ev.legacy-unknown", route_reason: "vendor_unknown" })
  ]), "verify-gate");
  assert.equal(legacyUnknownReason.route_reason, "vendor_unknown");
  assert.equal(legacyUnknownReason.route_back_to, "verify");
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

test("reports, summary, and resume expose route-back metadata", () => {
  const definition = routeBackDefinition({
    route_back_policy: { max_attempts: 1, on_exceeded: "recover" }
  });
  const state = initialState(definition, "report-route-back", { subject: "route report" });
  state.current_step = "verify";
  state.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:00:00.000Z" }
  ];
  const manifest = routeBackManifest([
    failedEvidence({
      id: "ev.report",
      route_reason: "implementation_defect",
      expectation_ids: ["tests-passed"],
      classifier: { kind: "rule", source: "smoke", confidence: 0.9 },
      diagnostics: { failing_command: "npm test" },
      analytics: { loop_key: "verify:implementation_defect" }
    })
  ]);
  const outcome = evaluateGate(definition, state, manifest, "verify-gate");
  applyEvaluation(definition, state, outcome);

  const report = reportJson(definition, state, manifest);
  const gate = report.gate_summaries.find((entry) => entry.gate_id === "verify-gate");
  const transition = state.transitions.at(-1);
  assert.equal(transition.route_reason, "implementation_defect");
  assert.equal(transition.selected_route, "implement");
  assert.equal(transition.to_step, "recover");
  assert.equal(transition.recovery_step, "recover");
  assert.equal(transition.attempt, 2);
  assert.equal(transition.max_attempts, 1);
  assert.equal(transition.limit_exceeded, true);
  assert.deepEqual(transition.evidence_refs, ["ev.report"]);
  assert.deepEqual(transition.expectation_ids, ["tests-passed"]);
  assert.deepEqual(transition.classifier, { kind: "rule", source: "smoke", confidence: 0.9 });
  assert.deepEqual(transition.diagnostics, { failing_command: "npm test" });
  assert.equal(transition.analytics.loop_key, "verify:implementation_defect");
  assert.equal(transition.analytics_loop_key, "verify:implementation_defect");
  assert.equal(gate.route_reason, "implementation_defect");
  assert.equal(gate.selected_route, "implement");
  assert.equal(gate.route_back_to, "recover");
  assert.equal(gate.recovery_step, "recover");
  assert.equal(gate.attempt, 2);
  assert.equal(gate.max_attempts, 1);
  assert.equal(gate.limit_exceeded, true);
  assert.deepEqual(gate.evidence_refs, ["ev.report"]);
  assert.deepEqual(gate.expectation_ids, ["tests-passed"]);
  assert.deepEqual(gate.classifier, { kind: "rule", source: "smoke", confidence: 0.9 });
  assert.deepEqual(gate.diagnostics, { failing_command: "npm test" });
  assert.equal(gate.analytics.loop_key, "verify:implementation_defect");
  assert.equal(gate.analytics_loop_key, "verify:implementation_defect");

  const markdown = renderMarkdownReport(definition, state, manifest);
  assert.match(markdown, /Route back: implementation_defect -> recover \(attempt 2\/1, limit exceeded: yes\)/);
  assert.match(markdown, /Selected route: implement/);
  assert.match(markdown, /Recovery step: recover/);
  assert.match(markdown, /Analytics loop: verify:implementation_defect/);

  const summary = renderSummary(definition, state);
  assert.match(summary, /route: implementation_defect -> recover; attempt 2\/1; limit exceeded: yes/);
  assert.match(summary, /recovery: recover/);
  assert.match(summary, /analytics loop: verify:implementation_defect/);

  const resume = renderResume(definition, state);
  assert.match(resume, /route backs: verify-gate implementation_defect -> recover attempt 2\/1, limit exceeded yes, recovery recover/);
});

test("CLI records route-back metadata and only route_reason selects the route", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-route-"));
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "evidence.txt");
  const metadataPath = path.join(cwd, "route-metadata.json");
  await writeFile(definitionPath, `${JSON.stringify(routeBackDefinition(), null, 2)}\n`);
  await writeFile(evidencePath, "failed test evidence\n");
  await writeFile(metadataPath, `${JSON.stringify({
    diagnostics: { claimed_target: "plan" },
    analytics: { loop_key: "cli:implementation_defect" }
  }, null, 2)}\n`);

  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  await execFile(process.execPath, [cli, "start", "definition.json", "--run-id", "cli-route", "--params", "subject=cli-route"], { cwd });
  await execFile(process.execPath, [
    cli,
    "attach-evidence",
    "cli-route",
    "--gate",
    "verify-gate",
    "--file",
    "evidence.txt",
    "--kind",
    "command",
    "--status",
    "failed",
    "--route-reason",
    "implementation_defect",
    "--classifier-kind",
    "manual",
    "--classifier-source",
    "cli",
    "--classifier-confidence",
    "0.75",
    "--analytics-loop-key",
    "cli:flag-loop",
    "--expectation-id",
    "tests-passed",
    "--route-metadata",
    "route-metadata.json"
  ], { cwd });
  await execFile(process.execPath, [cli, "evaluate", "cli-route", "--gate", "verify-gate"], { cwd });

  const manifest = JSON.parse(await readFile(path.join(cwd, ".flow", "runs", "cli-route", "evidence", "manifest.json"), "utf8"));
  const entry = manifest.evidence[0];
  assert.equal(entry.route_reason, "implementation_defect");
  assert.deepEqual(entry.classifier, { kind: "manual", source: "cli", confidence: 0.75 });
  assert.deepEqual(entry.diagnostics, { claimed_target: "plan" });
  assert.deepEqual(entry.analytics, { loop_key: "cli:flag-loop" });
  assert.deepEqual(entry.expectation_ids, ["tests-passed"]);

  const report = JSON.parse(await readFile(path.join(cwd, ".flow", "runs", "cli-route", "report.json"), "utf8"));
  const gate = report.gate_summaries.find((item) => item.gate_id === "verify-gate");
  assert.equal(gate.route_back_to, "implement");
  assert.equal(gate.route_reason, "implementation_defect");
  assert.equal(gate.analytics_loop_key, "cli:flag-loop");
  assert.deepEqual(gate.diagnostics, { claimed_target: "plan" });
});

test("CLI validates arbitrary Flow Definition files with JSON diagnostics", async () => {
  const cli = new URL("../src/cli.js", import.meta.url).pathname;
  const valid = await execFile(process.execPath, [cli, "validate-definition", "examples/builder-kit-flow.json", "--json"], {
    cwd: new URL("..", import.meta.url).pathname
  });
  const validPayload = JSON.parse(valid.stdout);
  assert.equal(validPayload.valid, true);
  assert.equal(validPayload.error_count, 0);
  assert.deepEqual(validPayload.diagnostics, []);

  await assert.rejects(
    async () => execFile(process.execPath, [cli, "validate-definition", "examples/invalid-claim-expectation-flow.json", "--json"], {
      cwd: new URL("..", import.meta.url).pathname
    }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(payload.valid, false);
      assert.equal(payload.error_count, 6);
      assert.equal(payload.diagnostics[0].code, "definition.expectation.claim.required");
      assert.equal(payload.diagnostics[0].path, "$.gates.verify-gate.expects[0].claim");
      return true;
    }
  );
});
