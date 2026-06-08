import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, constants, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  applyEvaluation,
  applyFlowConfigMerge,
  changeManagementFixtureAdapter,
  defaultFlowConfig,
  deploymentWindowFixtureAdapter,
  evaluateGate,
  evaluateReleaseReadiness,
  freezeStateFixtureAdapter,
  FLOW_SCHEMA_VERSION,
  initialState,
  normalizeTrustArtifact,
  projectVersionReleaseReport,
  previewFlowConfigMerge,
  renderMarkdownReport,
  renderConfigMergeMarkdown,
  renderVersionReleaseReportMarkdown,
  renderResume,
  renderSummary,
  reportJson,
  validateEvaluationTransition,
  validateDefinition,
  validateDefinitionWithDiagnostics,
  validateRunTransition
} from "../dist/index.js";

const execFile = promisify(execFileCallback);

async function json(file) {
  return JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
}

async function surfaceClaimFixture(file) {
  return json(`examples/fixtures/surface-claims/${file}`);
}

async function surfaceClaimEvidenceFixture(file) {
  return surfaceClaimFixture(`evidence/${file}`);
}

async function releaseReadinessFixture(file) {
  return json(`examples/fixtures/release-readiness/${file}`);
}

async function versionReleaseReportFixture(file) {
  return json(`examples/fixtures/version-release-report/${file}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireSchemaFields(schema, fields) {
  for (const field of fields) {
    assert.ok(schema.required.includes(field), `${schema.title} must require ${field}`);
    assert.ok(schema.properties[field], `${schema.title} must define ${field}`);
  }
}

test("package runtime points at emitted TypeScript output", async () => {
  const packageJson = await json("package.json");
  const cli = new URL("../dist/cli.js", import.meta.url);
  const declaration = new URL("../dist/index.d.ts", import.meta.url);

  assert.equal(packageJson.bin.flow, "dist/cli.js");
  assert.equal(packageJson.types, "./dist/index.d.ts");
  assert.deepEqual(packageJson.exports["."], {
    types: "./dist/index.d.ts",
    import: "./dist/index.js",
    default: "./dist/index.js"
  });
  assert.ok(packageJson.files.includes("dist/"));
  assert.ok(!packageJson.files.includes("src/"));

  assert.match(await readFile(cli, "utf8"), /^#!\/usr\/bin\/env node\n/);
  await access(declaration, constants.R_OK);
});

test("emitted package CLI and library entrypoints smoke test", async () => {
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const help = await execFile(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /flow validate-definition <path> \[--json\]/);
  assert.match(help.stdout, /flow version-release-report <fixture-json> \[--format json\|markdown\]/);

  const valid = await execFile(process.execPath, [cli, "validate-definition", "examples/agent-dev-flow.json", "--json"], {
    cwd: new URL("..", import.meta.url)
  });
  assert.equal(JSON.parse(valid.stdout).valid, true);

  const runtime = await import("../dist/index.js");
  assert.equal(typeof runtime.validateDefinition, "function");
  assert.equal(typeof runtime.validateRunTransition, "function");
  assert.equal(typeof runtime.projectVersionReleaseReport, "function");
  assert.equal(typeof runtime.renderVersionReleaseReportMarkdown, "function");
});

test("CLI version-release-report renders deterministic JSON and Markdown from local fixtures", async () => {
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const cwd = new URL("..", import.meta.url);

  const complete = await execFile(process.execPath, [
    cli,
    "version-release-report",
    "examples/fixtures/version-release-report/complete.json",
    "--format",
    "json"
  ], { cwd });
  const report = JSON.parse(complete.stdout);
  assert.equal(report.decision, "ready");
  assert.equal(report.release_evidence.lanes.find((lane) => lane.lane_id === "change-approval").status, "pass");
  assert.ok(report.native_refs.some((ref) => ref.id === "CHG-1847"));
  assert.ok(report.external_links.some((link) => link.url === "https://change.example.test/changes/CHG-1847"));

  const missing = await execFile(process.execPath, [
    cli,
    "version-release-report",
    "examples/fixtures/version-release-report/missing-required-evidence.json",
    "--format",
    "markdown"
  ], { cwd });
  assert.match(missing.stdout, /# Version Release Report: kai-2026\.06/);
  assert.match(missing.stdout, /Decision: hold/);
  assert.match(missing.stdout, /verification_evidence ev\.verify\.schemas/);
  assert.match(missing.stdout, /release_lane deployment-window/);
});

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
  const transitionValidationRequestSchema = await json("schemas/flow-transition-validation-request.schema.json");
  const transitionValidationResultSchema = await json("schemas/flow-transition-validation-result.schema.json");
  const releaseReadinessPolicySchema = await json("schemas/release-readiness-policy.schema.json");
  const releaseReadinessResultSchema = await json("schemas/release-readiness-result.schema.json");
  const versionReleaseReportSchema = await json("schemas/version-release-report.schema.json");

  assert.equal(definitionSchema.properties.version.type, "string");
  assert.equal(runSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(evidenceSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(reportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(configMergeReportSchema.properties.schema_version.const, FLOW_SCHEMA_VERSION);
  assert.equal(transitionValidationRequestSchema.title, "Flow Transition Validation Request");
  assert.equal(transitionValidationResultSchema.title, "Flow Transition Validation Result");
  assert.equal(releaseReadinessPolicySchema.title, "Release Readiness Policy");
  assert.equal(releaseReadinessResultSchema.title, "Release Readiness Result");
  assert.equal(versionReleaseReportSchema.title, "Version Release Report");

  assert.ok(definitionSchema.$defs.gate.properties.on_route_back);
  assert.ok(definitionSchema.$defs.gate.properties.route_back_policy);
  assert.ok(evidenceSchema.$defs.evidence.properties.route_reason);
  assert.ok(evidenceSchema.$defs.evidence.properties.trust_artifact);
  assert.equal(evidenceSchema.$defs.evidence.properties.trust_artifact.additionalProperties, false);
  assert.equal(evidenceSchema.$defs.evidence.properties.trust_artifact.properties.claims.items.additionalProperties, false);
  assert.ok(evidenceSchema.$defs.evidence.properties.authority_traces);
  assert.ok(evidenceSchema.$defs.evidence.properties.classifier);
  assert.ok(runSchema.$defs.gate_outcome.properties.route_reason);
  assert.ok(runSchema.$defs.transition.properties.route_reason);
  assert.ok(reportSchema.properties.gate_summaries.items.properties.route_reason);
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
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.evidence_refs);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.expectation_ids);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.classifier);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.diagnostics);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.analytics);
  assert.ok(transitionValidationResultSchema.$defs.transition_preview.properties.analytics_loop_key);

  requireSchemaFields(definitionSchema, ["id", "version", "steps", "gates"]);
  requireSchemaFields(runSchema, ["schema_version", "run_id", "definition_id", "status", "current_step", "gate_outcomes", "transitions", "exceptions"]);
  requireSchemaFields(evidenceSchema, ["schema_version", "evidence"]);
  requireSchemaFields(reportSchema, ["schema_version", "run_id", "definition_id", "status", "summary", "current_step", "gate_summaries"]);
  requireSchemaFields(configSchema, ["schema_version"]);
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

test("version release report projects complete local fixtures and preserves refs", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  const report = projectVersionReleaseReport(input);

  assert.equal(report.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(report.decision, "ready");
  assert.equal(report.status, "ready");
  assert.equal(report.gaps.length, 0);
  assert.equal(report.changeset.length, 2);
  assert.equal(report.verification_evidence[0].kind, "surface.claim");
  assert.equal(report.verification_evidence[0].claim.type, "quality.tests");
  assert.equal(report.release_evidence.decision, "pass");
  assert.deepEqual(report.release_evidence.required_lanes, ["change-approval", "deployment-window", "freeze-state"]);
  assert.deepEqual(report.release_evidence.lanes.filter((lane) => lane.required).map((lane) => lane.status), ["pass", "pass", "pass"]);
  assert.equal(report.exceptions[0].id, "ex.release.docs-late");
  assert.equal(report.accepted_risks[0].id, "risk.telemetry-delay");
  assert.ok(report.external_links.some((link) => link.url === "file://fixtures/version-release-report/release-notes.md"));
  assert.ok(report.external_links.some((link) => link.url === "https://change.example.test/changes/CHG-1847"));
  assert.ok(report.external_links.some((link) => link.url === "https://deploy.example.test/windows/production"));
  assert.ok(report.external_links.some((link) => link.url === "https://freeze.example.test/windows/freeze-2026-06"));
  assert.ok(report.native_refs.some((ref) => ref.system === "local-artifact" && ref.id === "release-notes"));
  assert.ok(report.native_refs.some((ref) => ref.system === "change-management-fixture" && ref.id === "CHG-1847"));
  assert.ok(report.native_refs.some((ref) => ref.system === "deployment-fixture" && ref.id === "production"));
  assert.ok(report.native_refs.some((ref) => ref.system === "freeze-fixture" && ref.id === "freeze-2026-06"));
  assert.equal(report.report_data.release_lane_statuses["change-approval"], "pass");
});

test("version release report holds when a required release lane is absent from lane outcomes", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  input.release_readiness.lanes = input.release_readiness.lanes.filter((lane) => lane.lane_id !== "deployment-window");
  input.release_readiness.decision = "pass";

  const report = projectVersionReleaseReport(input);

  assert.equal(report.decision, "hold");
  assert.ok(report.gaps.some((gap) => gap.kind === "release_lane" && gap.id === "deployment-window" && /absent/.test(gap.summary)));
});

test("version release report requires positive verification evidence claim status", async () => {
  const base = await versionReleaseReportFixture("complete.json");
  const rejectedStatuses = [
    { name: "pending", patch: { claim: { status: "pending" }, status: "passed" } },
    { name: "unknown", patch: { claim: {}, status: "unknown" } },
    { name: "untrusted", patch: { claim: { status: "untrusted" }, status: "passed" } },
    { name: "authority_gap", patch: { claim: { status: "authority_gap" }, status: "passed" } },
    { name: "omitted", patch: { claim: {}, status: undefined } }
  ];

  for (const { name, patch } of rejectedStatuses) {
    const input = clone(base);
    const entry = input.verification_evidence.find((candidate) => candidate.id === "ev.verify.tests");
    entry.claim = { type: "quality.tests", subject: "release:kai-2026.06", ...patch.claim };
    if (patch.status === undefined) delete entry.status;
    else entry.status = patch.status;

    const report = projectVersionReleaseReport(input);
    assert.equal(report.decision, "hold", name);
    assert.ok(report.gaps.some((gap) => gap.kind === "verification_evidence" && gap.id === "ev.verify.tests"), name);
    assert.ok(!report.report_data.satisfied_required_verification_evidence.includes("ev.verify.tests"), name);
  }
});

test("version release report fixtures include required gate evidence timestamps", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  const projected = projectVersionReleaseReport(input);

  assert.ok(projected.verification_evidence.every((entry) => typeof entry.attached_at === "string"));
  assert.ok(projected.release_evidence.evidence.every((entry) => typeof entry.attached_at === "string"));
});

test("version release report gap semantics hold for missing verification and release lanes", async () => {
  const input = await versionReleaseReportFixture("missing-required-evidence.json");
  const report = projectVersionReleaseReport(input);
  const markdown = renderVersionReleaseReportMarkdown(report);

  assert.equal(report.decision, "hold");
  assert.equal(report.status, "hold");
  assert.ok(report.gaps.some((gap) => gap.kind === "verification_evidence" && gap.id === "ev.verify.schemas"));
  assert.ok(report.gaps.some((gap) => gap.kind === "release_lane" && gap.id === "deployment-window"));
  assert.equal(report.report_data.release_lane_statuses["deployment-window"], "not_verified");
  assert.match(markdown, /## Gaps/);
  assert.match(markdown, /ev\.verify\.schemas/);
  assert.match(markdown, /deployment-window/);
});

test("version release report Markdown escapes controlled text and blocks unsafe link schemes", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  input.version.id = "kai<script>";
  input.subject = "release[bad](javascript:alert(1))";
  input.summary = "**owned** <img src=x onerror=alert(1)>";
  input.changeset[0].summary = "[click](javascript:alert(1)) <b>raw</b>";
  input.external_links = [
    { label: "unsafe link", url: "javascript:alert(1)" },
    { label: "safe", url: "https://example.test/release" }
  ];
  input.native_refs = [
    { system: "tracker", id: "ISSUE-17", url: "data:text/html,<script>alert(1)</script>" }
  ];

  const markdown = renderVersionReleaseReportMarkdown(projectVersionReleaseReport(input));

  assert.doesNotMatch(markdown, /<script>|<img|<b>raw<\/b>/);
  assert.doesNotMatch(markdown, /\[click\]\(javascript:alert\(1\)\)/);
  assert.doesNotMatch(markdown, /data:text\/html/);
  assert.match(markdown, /&lt;script&gt;/);
  assert.match(markdown, /\[blocked-url\]/);
  assert.match(markdown, /https:\/\/example\.test\/release/);
});

test("release readiness fixture adapters emit Surface-shaped evidence and preserve refs", async () => {
  const changeRecord = await releaseReadinessFixture("change-records/approved.json");
  const evidence = changeManagementFixtureAdapter(changeRecord, { subject: "kai-2026.06", gate_id: "release-readiness-gate", attached_at: "2026-06-07T20:00:00.000Z" });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "surface.claim");
  assert.equal(evidence[0].requested_kind, "surface.claim");
  assert.deepEqual(evidence[0].claim, {
    type: "release.change.approved",
    subject: "release:kai-2026.06",
    status: "trusted"
  });
  assert.equal(evidence[0].producer, "release-fixture/change-management");
  assert.deepEqual(evidence[0].authority_traces, ["fixture:change-management"]);
  assert.equal(evidence[0].trust_artifact.claims[0].type, "release.change.approved");
  assert.equal(evidence[0].external_links[0].url, "https://change.example.test/changes/CHG-1847");
  assert.equal(evidence[0].external_links[0].provider, "change-fixture");
  assert.equal(evidence[0].external_links[1].href, "https://change.example.test/provider/CHG-1847");
  assert.equal(evidence[0].external_links[1].url, "https://change.example.test/provider/CHG-1847");
  assert.equal(evidence[0].native_refs[0].id, "CHG-1847");
  assert.equal(evidence[0].native_refs[0].native_type, "change_record");
  assert.equal(evidence[0].native_refs[1].key, "CHG-1847-provider-view");
  assert.equal(evidence[0].native_refs[1].id, "CHG-1847-provider-view");
  assert.equal(evidence[0].native_refs.length, 2);
});

test("release readiness holds for pending or missing required approval and passes when risk lanes are satisfied", async () => {
  const policy = await releaseReadinessFixture("release-policy.json");
  const approvedChange = await releaseReadinessFixture("change-records/approved.json");
  const pendingChange = await releaseReadinessFixture("change-records/pending.json");
  const deploymentOpen = await releaseReadinessFixture("deployment-state/open.json");
  const freezeClear = await releaseReadinessFixture("freeze-state/clear.json");

  const pendingEvidence = changeManagementFixtureAdapter(pendingChange, { subject: "kai-2026.06" });
  const pending = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence: pendingEvidence
  });
  assert.equal(pending.decision, "hold");
  assert.equal(pending.lanes.find((lane) => lane.lane_id === "change-approval").status, "hold");

  const missing = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence: []
  });
  assert.equal(missing.decision, "hold");
  assert.equal(missing.lanes.find((lane) => lane.lane_id === "change-approval").status, "not_verified");

  const wrongAdapterEvidence = changeManagementFixtureAdapter(approvedChange, { subject: "kai-2026.06" }).map((entry) => ({
    ...entry,
    source_adapter_id: "fixture/not-change-management"
  }));
  const wrongAdapter = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence: wrongAdapterEvidence
  });
  assert.equal(wrongAdapter.decision, "hold");
  assert.equal(wrongAdapter.lanes.find((lane) => lane.lane_id === "change-approval").status, "not_verified");

  const satisfiedEvidence = [
    ...changeManagementFixtureAdapter(approvedChange, { subject: "kai-2026.06" }),
    ...deploymentWindowFixtureAdapter(deploymentOpen, { subject: "kai-2026.06" }),
    ...freezeStateFixtureAdapter(freezeClear, { subject: "kai-2026.06" })
  ];
  const passed = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "high",
    evidence: satisfiedEvidence
  });
  assert.equal(passed.decision, "pass");
  assert.deepEqual(passed.required_lanes, ["change-approval", "deployment-window", "freeze-state"]);
  assert.deepEqual(passed.lanes.filter((lane) => lane.required).map((lane) => lane.status), ["pass", "pass", "pass"]);
});

test("release readiness report data preserves external links and native refs", async () => {
  const policy = await releaseReadinessFixture("release-policy.json");
  const changeRecord = await releaseReadinessFixture("change-records/approved.json");
  const evidence = changeManagementFixtureAdapter(changeRecord, { subject: "kai-2026.06" });
  const result = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence
  });

  assert.equal(result.decision, "pass");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").external_links[0].url, "https://change.example.test/changes/CHG-1847");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").external_links[0].provider, "change-fixture");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").external_links[1].href, "https://change.example.test/provider/CHG-1847");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").native_refs[0].id, "CHG-1847");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").native_refs[0].native_type, "change_record");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").native_refs[1].key, "CHG-1847-provider-view");
  assert.equal(result.report_data.external_links[0].url, "https://change.example.test/changes/CHG-1847");
  assert.equal(result.report_data.external_links[0].provider, "change-fixture");
  assert.equal(result.report_data.external_links[1].href, "https://change.example.test/provider/CHG-1847");
  assert.equal(result.report_data.native_refs[0].id, "CHG-1847");
  assert.equal(result.report_data.native_refs[0].native_type, "change_record");
  assert.equal(result.report_data.native_refs[1].key, "CHG-1847-provider-view");
});

test("neutral Surface trust artifacts normalize through Surface contract fields", () => {
  const normalized = normalizeTrustArtifact({
    schema_version: "0.1",
    artifact_type: "trust-report",
    subject: "builder.verify",
    producer: "ci/main",
    status: "trusted",
    issued_at: "2026-05-26T00:00:00.000Z",
    authority_traces: ["github:main"],
    claims: [{ type: "quality.tests", status: "trusted" }]
  }, "abc123", new Date("2026-05-26T00:00:00.000Z"));

  assert.equal(normalized.claim.type, "quality.tests");
  assert.equal(normalized.claim.subject, "builder.verify");
  assert.equal(normalized.claim.status, "trusted");
  assert.equal(normalized.producer, "ci/main");
  assert.deepEqual(normalized.authority_traces, ["github:main"]);
  assert.equal(normalized.trust_artifact.artifact_type, "trust-report");

  const stale = normalizeTrustArtifact({
    artifact_type: "trust-snapshot",
    expires_at: "2026-05-25T00:00:00.000Z",
    claims: [{ type: "quality.tests", subject: "builder.verify", status: "trusted" }]
  }, "abc123", new Date("2026-05-26T00:00:00.000Z"));
  assert.equal(stale.claim.status, "stale");

  const mismatch = normalizeTrustArtifact({
    artifact_type: "trust-report",
    integrity: { sha256: "expected" },
    claims: [{ type: "quality.tests", subject: "builder.verify", status: "trusted" }]
  }, "actual", new Date("2026-05-26T00:00:00.000Z"));
  assert.equal(mismatch.claim.status, "integrity_mismatch");
  assert.equal(mismatch.diagnostics.trust_artifact.reason, "integrity_mismatch");

  assert.throws(() => normalizeTrustArtifact({ artifact_type: "trust-report", claims: [{}] }, "abc123"), /claim.type/);
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
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
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

test("adversarial-pass reference definition validates and documents route targets", async () => {
  const definition = await json("examples/adversarial-pass-flow.json");
  assert.equal(definition.id, "adversarial-pass-flow");
  assert.deepEqual(definition.steps.map((step) => step.id), ["produce", "adversarial-review", "resolve"]);

  const gate = definition.gates["adversarial-review-gate"];
  assert.equal(gate.step, "adversarial-review");
  assert.ok(gate.expects.every((expectation) => expectation.kind === "surface.claim"));
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

test("transition validator preserves legacy permissive route reasons unless route policy is closed", () => {
  const openDefinition = routeBackDefinition();
  const closedDefinition = routeBackDefinition({
    route_back_policy: {
      max_attempts: 2,
      on_exceeded: "block",
      allow_unknown_reasons: false
    }
  });
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

test("runtime-generated run and report satisfy required schema fields", async () => {
  const definition = await json("examples/agent-dev-flow.json");
  const state = initialState(definition, "schema-check", { subject: "feature-search-filters" });
  const report = reportJson(definition, state, { schema_version: FLOW_SCHEMA_VERSION, evidence: [] });
  assert.equal(state.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(state.definition_id, definition.id);
  assert.equal(report.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(report.definition_id, definition.id);
});

function assertSurfaceClaimManifestShape(manifest, file) {
  assert.equal(manifest.schema_version, FLOW_SCHEMA_VERSION, `${file} schema_version`);
  assert.ok(Array.isArray(manifest.evidence), `${file} evidence must be an array`);
  for (const entry of manifest.evidence) {
    assert.equal(entry.gate_id, "verify-gate", `${file} gate_id`);
    assert.equal(entry.kind, "surface.claim", `${file} kind`);
    assert.equal(entry.requested_kind, "surface.claim", `${file} requested_kind`);
    assert.ok(["passed", "failed", "unknown"].includes(entry.status), `${file} status`);
    assert.match(entry.attached_at, /^\d{4}-\d{2}-\d{2}T/, `${file} attached_at`);
    assert.equal(entry.claim?.type, "quality.tests", `${file} claim.type`);
    assert.ok(entry.claim?.status, `${file} claim.status`);
    assert.ok(entry.trust_artifact, `${file} trust_artifact`);
    assert.equal(entry.trust_artifact.schema_version, FLOW_SCHEMA_VERSION, `${file} trust_artifact.schema_version`);
    assert.ok(["trust-report", "trust-snapshot"].includes(entry.trust_artifact.artifact_type), `${file} artifact_type`);
    assert.ok(Array.isArray(entry.trust_artifact.claims), `${file} trust_artifact.claims`);
    assert.ok(entry.trust_artifact.claims.length > 0, `${file} trust_artifact.claims length`);
    for (const claim of entry.trust_artifact.claims) {
      assert.equal(claim.type, "quality.tests", `${file} trust_artifact claim.type`);
      const allowed = new Set(["type", "subject", "status", "producer", "issued_at", "expires_at", "authority_traces"]);
      assert.deepEqual(Object.keys(claim).filter((key) => !allowed.has(key)), [], `${file} trust_artifact claim has neutral fields`);
    }
  }
}

test("fixture-backed Surface claim manifests satisfy the neutral fixture shape", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");
  assert.doesNotThrow(() => validateDefinition(definition));
  assert.equal(definition.gates["verify-gate"].expects[0].kind, "surface.claim");

  const config = await surfaceClaimFixture("flow-config.json");
  assert.equal(config.schema_version, FLOW_SCHEMA_VERSION);
  assert.deepEqual(config.trusted_producers["quality.tests"].producers, ["surface-fixture/ci"]);
  assert.deepEqual(config.trusted_producers["quality.tests"].authority_traces, ["project-policy:main"]);

  const evidenceDir = new URL("../examples/fixtures/surface-claims/evidence/", import.meta.url);
  const files = (await readdir(evidenceDir)).filter((file) => file.endsWith(".json")).sort();
  assert.deepEqual(files, [
    "fail-authority-gap.json",
    "fail-integrity-mismatch.json",
    "fail-missing-claim.json",
    "fail-rejected-claim.json",
    "fail-stale-claim.json",
    "fail-subject-mismatch.json",
    "fail-untrusted-producer.json",
    "pass-trust-report.json",
    "pass-trust-snapshot.json"
  ]);

  for (const file of files) {
    assertSurfaceClaimManifestShape(await surfaceClaimEvidenceFixture(file), file);
  }
});

test("fixture-backed Surface claim matching covers pass and diagnostic route-back cases", async () => {
  const definition = await surfaceClaimFixture("flow-definition.json");
  const config = await surfaceClaimFixture("flow-config.json");

  const passFiles = ["pass-trust-report.json", "pass-trust-snapshot.json"];
  for (const file of passFiles) {
    const state = initialState(definition, `fixture-${file}`);
    state.current_step = "verify";
    const outcome = evaluateGate(definition, state, await surfaceClaimEvidenceFixture(file), "verify-gate", config);
    assert.equal(outcome.status, "pass", file);
    assert.deepEqual(outcome.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: `ev.${file.replace(".json", "")}` }], file);
    assert.equal(outcome.diagnostics, undefined, file);
  }

  const missingState = initialState(definition, "fixture-fail-missing-claim");
  missingState.current_step = "verify";
  const missing = evaluateGate(definition, missingState, await surfaceClaimEvidenceFixture("fail-missing-claim.json"), "verify-gate", config);
  assert.equal(missing.status, "route-back");
  assert.equal(missing.route_reason, "missing_evidence");
  assert.deepEqual(missing.missing, ["tests-passed"]);
  assert.deepEqual(missing.matched_expectations, []);
  assert.equal(missing.diagnostics, undefined);

  const failureCases = [
    ["fail-stale-claim.json", "stale", config],
    ["fail-rejected-claim.json", "rejected", config],
    ["fail-untrusted-producer.json", "untrusted_producer", config],
    ["fail-subject-mismatch.json", "subject_mismatch", config],
    ["fail-integrity-mismatch.json", "integrity_mismatch", config],
    ["fail-authority-gap.json", "authority_gap", {
      ...config,
      trusted_producers: {
        "quality.tests": {
          authority_traces: ["project-policy:main"]
        }
      }
    }]
  ];

  for (const [file, reason, caseConfig] of failureCases) {
    const state = initialState(definition, `fixture-${file}`);
    state.current_step = "verify";
    const outcome = evaluateGate(definition, state, await surfaceClaimEvidenceFixture(file), "verify-gate", caseConfig);
    assert.equal(outcome.status, "route-back", file);
    assert.equal(outcome.route_reason, "missing_evidence", file);
    assert.deepEqual(outcome.missing, ["tests-passed"], file);
    assert.deepEqual(outcome.matched_expectations, [], file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].expectation_id, "tests-passed", file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].evidence_id, `ev.${file.replace(".json", "")}`, file);
    assert.equal(outcome.diagnostics.claim_evaluation[0].reason, reason, file);
  }
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
  assert.equal(untrusted.diagnostics.claim_evaluation[0].reason, "untrusted_producer");

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

test("trust artifact claim diagnostics cover stale rejected subject integrity and authority gaps", () => {
  const definition = routeBackDefinition();
  const state = initialState(definition, "trust-diagnostics");
  state.current_step = "verify";
  const base = {
    gate_id: "verify-gate",
    kind: "surface.claim",
    requested_kind: "surface.claim",
    status: "passed",
    attached_at: "2026-05-26T00:00:00.000Z"
  };
  const cases = [
    ["stale", { claim: { type: "quality.tests", subject: "builder.verify", status: "stale" } }, {}, "stale"],
    ["rejected", { claim: { type: "quality.tests", subject: "builder.verify", status: "rejected" } }, {}, "rejected"],
    ["subject", { claim: { type: "quality.tests", subject: "wrong.subject", status: "trusted" } }, {}, "subject_mismatch"],
    ["integrity", {
      claim: { type: "quality.tests", subject: "builder.verify", status: "integrity_mismatch" },
      trust_artifact: { integrity: { verified: false } }
    }, {}, "integrity_mismatch"],
    ["authority", {
      claim: { type: "quality.tests", subject: "builder.verify", status: "trusted" },
      producer: "ci/main"
    }, {
      ...defaultFlowConfig(),
      trusted_producers: { "quality.tests": { authority_traces: ["github:main"] } }
    }, "authority_gap"]
  ];

  for (const [id, entry, config, reason] of cases) {
    const outcome = evaluateGate(definition, state, routeBackManifest([{ id: `ev.${id}`, ...base, ...entry }]), "verify-gate", config);
    assert.equal(outcome.status, "route-back");
    assert.equal(outcome.missing[0], "tests-passed");
    assert.equal(outcome.diagnostics.claim_evaluation[0].reason, reason);
    const report = reportJson(definition, { ...state, gate_outcomes: [outcome] }, routeBackManifest([{ id: `ev.${id}`, ...base, ...entry }]));
    assert.equal(report.gate_summaries[0].diagnostics.claim_evaluation[0].reason, reason);
    assert.match(renderMarkdownReport(definition, { ...state, gate_outcomes: [outcome] }, routeBackManifest([{ id: `ev.${id}`, ...base, ...entry }])), new RegExp(reason));
  }
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
        kind: "surface.claim",
        requested_kind: "surface.claim",
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
      kind: "surface.claim",
      requested_kind: "surface.claim",
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
        kind: "surface.claim",
        requested_kind: "surface.claim",
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
      kind: "surface.claim",
      requested_kind: "surface.claim",
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

  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
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

test("CLI attaches Surface trust artifact evidence and reports claim diagnostics", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-trust-"));
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(routeBackDefinition(), null, 2)}\n`);

  const trustedArtifact = {
    schema_version: "0.1",
    artifact_type: "trust-report",
    subject: "builder.verify",
    producer: "ci/main",
    status: "trusted",
    issued_at: "2026-05-26T00:00:00.000Z",
    authority_traces: ["github:main"],
    claims: [{ type: "quality.tests", status: "trusted" }]
  };
  await writeFile(path.join(cwd, "trusted-report.json"), `${JSON.stringify(trustedArtifact, null, 2)}\n`);
  await execFile(process.execPath, [cli, "start", "definition.json", "--run-id", "cli-trust-pass", "--params", "subject=cli-trust"], { cwd });
  await execFile(process.execPath, [
    cli,
    "attach-evidence",
    "cli-trust-pass",
    "--gate",
    "verify-gate",
    "--file",
    "trusted-report.json",
    "--trust-artifact"
  ], { cwd });
  await execFile(process.execPath, [cli, "evaluate", "cli-trust-pass", "--gate", "verify-gate"], { cwd });
  const passReport = JSON.parse((await execFile(process.execPath, [cli, "report", "cli-trust-pass", "--format", "json"], { cwd })).stdout);
  const passGate = passReport.gate_summaries.find((item) => item.gate_id === "verify-gate");
  assert.equal(passGate.status, "pass");
  assert.equal(passGate.matched_expectations[0].expectation_id, "tests-passed");
  assert.equal(passGate.evidence_refs.length, 1);

  const rejectedArtifact = { ...trustedArtifact, status: "rejected", claims: [{ type: "quality.tests", status: "rejected" }] };
  await writeFile(path.join(cwd, "rejected-report.json"), `${JSON.stringify(rejectedArtifact, null, 2)}\n`);
  await execFile(process.execPath, [cli, "start", "definition.json", "--run-id", "cli-trust-rejected", "--params", "subject=cli-trust"], { cwd });
  await execFile(process.execPath, [
    cli,
    "attach-evidence",
    "cli-trust-rejected",
    "--gate",
    "verify-gate",
    "--file",
    "rejected-report.json",
    "--trust-artifact"
  ], { cwd });
  await execFile(process.execPath, [cli, "evaluate", "cli-trust-rejected", "--gate", "verify-gate"], { cwd });
  const rejectedMarkdown = (await execFile(process.execPath, [cli, "report", "cli-trust-rejected", "--format", "markdown"], { cwd })).stdout;
  assert.match(rejectedMarkdown, /Claim diagnostics: tests-passed\/ev\.[0-9]+\.[0-9]+:rejected/);
});

test("CLI validates arbitrary Flow Definition files with JSON diagnostics", async () => {
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
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

test("CLI validates provider-neutral transition request files", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-transition-"));
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const requestPath = path.join(cwd, "transition-request.json");
  const definition = routeBackDefinition();
  const state = initialState(definition, "cli-transition");
  state.current_step = "verify";
  await writeFile(requestPath, `${JSON.stringify({
    definition,
    current_state: state,
    proposed_transition: {
      from_step: "verify",
      to_step: "recover",
      status: "allowed",
      gate_id: "verify-gate"
    },
    manifest: routeBackManifest([])
  }, null, 2)}\n`);

  const output = await execFile(process.execPath, [cli, "validate-transition", "transition-request.json"], { cwd });
  const payload = JSON.parse(output.stdout);
  assert.equal(payload.valid, false);
  assert.equal(payload.status, "route-back");
  assert.equal(payload.diagnostics[0].code, "transition.gate.route-back");
});
