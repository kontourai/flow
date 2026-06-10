import assert from "node:assert/strict";
import { access, constants, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { FLOW_SCHEMA_VERSION, initialState } from "../../dist/index.js";
import {
  FLOW_RUN_DEFINITION_FILE,
  FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  FLOW_RUN_LAYOUT,
  FLOW_RUN_REPORT_JSON_FILE,
  FLOW_RUN_REPORT_MARKDOWN_FILE,
  FLOW_RUN_STATE_FILE
} from "../../dist/index.js";
import { cliPath, execFile, repoRootPath, repoRootUrl } from "./helpers/cli.mjs";
import { resourceDefinitionFixture } from "./helpers/fixtures.mjs";
import { localConfigFixture, proposedConfigFixture, resourceConfigFixture } from "./helpers/config-fixtures.mjs";
import { routeBackDefinition, routeBackManifest } from "./helpers/route-back-fixtures.mjs";

test("emitted package CLI and library entrypoints smoke test", async () => {
  const cli = cliPath;
  const help = await execFile(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /flow validate-definition <path> \[--json\]/);
  assert.match(help.stdout, /flow version-release-report <fixture-json> \[--format json\|markdown\]/);

  const valid = await execFile(process.execPath, [cli, "validate-definition", "examples/agent-dev-flow.json", "--json"], {
    cwd: repoRootUrl
  });
  assert.equal(JSON.parse(valid.stdout).valid, true);

  const runtime = await import("../../dist/index.js");
  assert.equal(typeof runtime.validateDefinition, "function");
  assert.equal(typeof runtime.validateRunTransition, "function");
  assert.equal(typeof runtime.projectVersionReleaseReport, "function");
  assert.equal(typeof runtime.renderVersionReleaseReportMarkdown, "function");
});

test("CLI init scaffolds .flow with the packaged sample definition", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-init-"));
  const result = await execFile(process.execPath, [cliPath, "init", "--cwd", cwd]);
  assert.match(result.stdout, /initialized /);

  const sample = JSON.parse(await readFile(path.join(cwd, ".flow", "definitions", "agent-dev-flow.json"), "utf8"));
  assert.equal(sample.id, "agent-dev-flow");
  await access(path.join(cwd, ".flow", "README.md"), constants.R_OK);
});

test("CLI init --demo scaffolds a resumable demo run past the plan gate", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-init-demo-"));
  const result = await execFile(process.execPath, [cliPath, "init", "--demo", "--cwd", cwd]);
  assert.match(result.stdout, /demo run ready: demo/);
  assert.match(result.stdout, /flow resume demo/);

  const status = await execFile(process.execPath, [cliPath, "status", "demo", "--cwd", cwd]);
  assert.match(status.stdout, /current step: implement/);
  assert.match(status.stdout, /PASS\s+plan gate/);

  const again = await execFile(process.execPath, [cliPath, "init", "--demo", "--cwd", cwd]);
  assert.match(again.stdout, /demo run already exists: demo/);
});

test("CLI evaluate --exit-code fails on non-pass outcomes and list prints an empty state", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-exit-code-"));
  const emptyList = await execFile(process.execPath, [cliPath, "list", "--cwd", cwd]);
  assert.match(emptyList.stdout, /no flow runs found/);

  await execFile(process.execPath, [cliPath, "init", "--demo", "--cwd", cwd]);
  // demo run sits at implement with no evidence attached: block, so --exit-code exits 1
  await assert.rejects(
    execFile(process.execPath, [cliPath, "evaluate", "demo", "--exit-code", "--cwd", cwd]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stdout, /block implement-gate/);
      return true;
    }
  );
  // without --exit-code the same evaluation exits 0
  const plain = await execFile(process.execPath, [cliPath, "evaluate", "demo", "--cwd", cwd]);
  assert.match(plain.stdout, /block implement-gate/);
});

test("CLI status and resume surface explore_hint for missing expectations", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-hints-"));
  await mkdir(path.join(cwd, "defs"), { recursive: true });
  const definition = {
    id: "hint-flow",
    version: "1",
    steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [
          {
            id: "tests-passed",
            kind: "surface.claim",
            required: true,
            description: "Tests passed.",
            explore_hint: "Run the suite and attach the CI trust report.",
            claim: { type: "quality.tests", accepted_statuses: ["trusted"] }
          }
        ]
      }
    }
  };
  await writeFile(path.join(cwd, "defs", "hint-flow.json"), JSON.stringify(definition));
  await execFile(process.execPath, [cliPath, "start", "defs/hint-flow.json", "--run-id", "hints-1", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "evaluate", "hints-1", "--cwd", cwd]);

  const status = await execFile(process.execPath, [cliPath, "status", "hints-1", "--cwd", cwd]);
  assert.match(status.stdout, /hint: Run the suite and attach the CI trust report\./);

  const resume = await execFile(process.execPath, [cliPath, "resume", "hints-1", "--cwd", cwd]);
  assert.match(resume.stdout, /hint \(verify-gate\): Run the suite and attach the CI trust report\./);
});

test("CLI validate-definition accepts Resource-shaped definitions with stable JSON payload", async () => {
  const cli = cliPath;
  const result = await execFile(process.execPath, [
    cli,
    "validate-definition",
    "examples/flow-definition-resource-contract.json",
    "--json"
  ], {
    cwd: repoRootUrl
  });
  const payload = JSON.parse(result.stdout);

  assert.deepEqual(Object.keys(payload), ["valid", "path", "error_count", "diagnostics"]);
  assert.equal(payload.valid, true);
  assert.equal(payload.path, "examples/flow-definition-resource-contract.json");
  assert.equal(payload.error_count, 0);
  assert.deepEqual(payload.diagnostics, []);
});

test("CLI validate-definition rejects invalid Resource metadata string maps", async () => {
  const cli = cliPath;
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-resource-metadata-"));
  const definition = await resourceDefinitionFixture();
  definition.metadata.labels = { team: 42 };
  definition.metadata.annotations = ["not", "a", "map"];
  await writeFile(path.join(cwd, "flow-definition.json"), `${JSON.stringify(definition, null, 2)}\n`);

  await assert.rejects(
    execFile(process.execPath, [
      cli,
      "validate-definition",
      "flow-definition.json",
      "--json"
    ], { cwd }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.valid, false);
      assert.equal(payload.error_count, 2);
      assert.deepEqual(payload.diagnostics.map((diagnostic) => diagnostic.path), [
        "$.metadata.labels.team",
        "$.metadata.annotations"
      ]);
      return true;
    }
  );
});

test("CLI --cwd scopes run lifecycle commands and relative file inputs", async () => {
  const cli = cliPath;
  const repoCwd = repoRootUrl;
  const flowCwd = await mkdtemp(path.join(tmpdir(), "flow-cli-cwd-"));
  const definition = await resourceDefinitionFixture();
  await writeFile(path.join(flowCwd, "flow-definition.json"), `${JSON.stringify(definition, null, 2)}\n`);
  await writeFile(path.join(flowCwd, "acceptance.txt"), "acceptance criteria linked\n");
  await writeFile(path.join(flowCwd, "route-metadata.json"), `${JSON.stringify({ route_reason: "plan_gap", expectation_ids: ["plan-gate"] }, null, 2)}\n`);

  await execFile(process.execPath, [
    cli,
    "start",
    "flow-definition.json",
    "--run-id",
    "cwd-smoke",
    "--params",
    "subject=cwd-smoke",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });

  await execFile(process.execPath, [
    cli,
    "attach-evidence",
    "cwd-smoke",
    "--gate",
    "plan-gate",
    "--file",
    "acceptance.txt",
    "--claim-type",
    "builder.acceptance",
    "--claim-subject",
    "resource-contract-flow",
    "--claim-status",
    "trusted",
    "--route-metadata",
    "route-metadata.json",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });

  await execFile(process.execPath, [
    cli,
    "evaluate",
    "cwd-smoke",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });

  const status = await execFile(process.execPath, [
    cli,
    "status",
    "cwd-smoke",
    "--format",
    "json",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });
  const report = await execFile(process.execPath, [
    cli,
    "report",
    "cwd-smoke",
    "--format",
    "json",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });
  const resume = await execFile(process.execPath, [
    cli,
    "resume",
    "cwd-smoke",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });
  const list = await execFile(process.execPath, [
    cli,
    "list",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });

  const runPath = path.join(flowCwd, ".flow", "runs", "cwd-smoke");
  const statusPayload = JSON.parse(status.stdout);
  const reportPayload = JSON.parse(report.stdout);
  const storedDefinition = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_DEFINITION_FILE), "utf8"));
  const storedState = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_STATE_FILE), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), "utf8"));
  const storedReport = JSON.parse(await readFile(path.join(runPath, FLOW_RUN_REPORT_JSON_FILE), "utf8"));

  assert.equal(statusPayload.run_id, "cwd-smoke");
  assert.equal(statusPayload.current_step, "implement");
  assert.equal(reportPayload.run_id, "cwd-smoke");
  assert.equal(reportPayload.current_step, "implement");
  assert.match(resume.stdout, /current step: implement/);
  assert.match(list.stdout, /cwd-smoke\tactive\timplement\tresource-contract-flow \/ cwd-smoke/);
  assert.equal(manifest.evidence[0].original_path, "acceptance.txt");
  assert.equal(manifest.evidence[0].kind, "surface.claim");
  assert.deepEqual(manifest.evidence[0].claim, {
    type: "builder.acceptance",
    status: "trusted",
    subject: "resource-contract-flow"
  });
  assert.equal(manifest.evidence[0].route_reason, "plan_gap");
  assert.deepEqual(manifest.evidence[0].expectation_ids, ["plan-gate"]);
  assert.deepEqual(FLOW_RUN_LAYOUT, {
    definition: "definition.json",
    state: "state.json",
    evidenceDirectory: "evidence",
    evidenceManifest: "evidence/manifest.json",
    reportJson: "report.json",
    reportMarkdown: "report.md"
  });
  assert.equal(storedDefinition.apiVersion, undefined);
  assert.equal(storedDefinition.kind, undefined);
  assert.equal(storedDefinition.id, "resource-contract-flow");
  assert.equal(storedState.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(storedState.run_id, "cwd-smoke");
  assert.equal(storedState.definition_id, storedDefinition.id);
  assert.equal(storedState.definition_version, storedDefinition.version);
  assert.equal(storedState.status, "active");
  assert.equal(storedState.current_step, "implement");
  assert.equal(manifest.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(manifest.run_id, storedState.run_id);
  assert.equal(manifest.definition_id, storedState.definition_id);
  assert.equal(manifest.definition_version, storedState.definition_version);
  assert.equal(storedReport.run_id, storedState.run_id);
  assert.equal(storedReport.definition_id, storedState.definition_id);
  assert.equal(storedReport.definition_version, storedState.definition_version);
  assert.equal(storedReport.status, storedState.status);
  assert.equal(storedReport.current_step, storedState.current_step);
  assert.equal(storedReport.next_action, storedState.next_action);
  assert.equal(storedReport.subject, storedState.subject);
  await access(path.join(runPath, FLOW_RUN_DEFINITION_FILE), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_STATE_FILE), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_EVIDENCE_MANIFEST_PATH), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_REPORT_MARKDOWN_FILE), constants.R_OK);
  await access(path.join(runPath, FLOW_RUN_REPORT_JSON_FILE), constants.R_OK);

  await execFile(process.execPath, [
    cli,
    "start",
    "flow-definition.json",
    "--run-id",
    "cwd-exception",
    "--params",
    "subject=cwd-exception",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });
  await execFile(process.execPath, [
    cli,
    "accept-exception",
    "cwd-exception",
    "--gate",
    "plan-gate",
    "--reason",
    "cwd smoke",
    "--authority",
    "cli-test",
    "--cwd",
    flowCwd
  ], { cwd: repoCwd });
  const exceptionState = JSON.parse(await readFile(path.join(flowCwd, ".flow", "runs", "cwd-exception", "state.json"), "utf8"));
  assert.equal(exceptionState.exceptions[0].authority, "cli-test");
});

test("CLI version-release-report renders deterministic JSON and Markdown from local fixtures", async () => {
  const cli = cliPath;
  const cwd = repoRootUrl;

  const complete = await execFile(process.execPath, [
    cli,
    "version-release-report",
    "examples/scenarios/version-release-report/complete.json",
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
    "examples/scenarios/version-release-report/missing-required-evidence.json",
    "--format",
    "markdown"
  ], { cwd });
  assert.match(missing.stdout, /# Version Release Report: kai-2026\.06/);
  assert.match(missing.stdout, /Decision: hold/);
  assert.match(missing.stdout, /verification_evidence ev\.verify\.schemas/);
  assert.match(missing.stdout, /release_lane deployment-window/);
});

test("CLI config preview and apply support JSON and Markdown reports", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-config-merge-"));
  const repoCwd = repoRootUrl;
  const cli = cliPath;
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(localConfigFixture(), null, 2)}\n`);
  await writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(proposedConfigFixture(), null, 2)}\n`);

  const preview = await execFile(process.execPath, [cli, "config", "preview", "proposal.json", "--format", "json", "--cwd", cwd], { cwd: repoCwd });
  const previewReport = JSON.parse(preview.stdout);
  assert.equal(previewReport.mode, "preview");
  assert.equal(previewReport.status, "conflicts");
  const afterPreview = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.deepEqual(afterPreview.trusted_producers["quality.tests"].producers, ["ci/main"]);

  const markdown = await execFile(process.execPath, [cli, "config", "preview", "proposal.json", "--format", "markdown", "--cwd", cwd], { cwd: repoCwd });
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
    "cli-smoke",
    "--cwd",
    cwd
  ], { cwd: repoCwd });
  const applyReport = JSON.parse(applied.stdout);
  assert.equal(applyReport.status, "applied");
  assert.ok(applyReport.exceptions.some((entry) => entry.authority === "cli-smoke"));
});

test("CLI config preview and apply accept Resource-shaped project config proposals", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-resource-config-merge-"));
  const repoCwd = repoRootUrl;
  const cli = cliPath;
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(localConfigFixture(), null, 2)}\n`);
  await writeFile(path.join(cwd, "proposal.json"), `${JSON.stringify(resourceConfigFixture(proposedConfigFixture()), null, 2)}\n`);

  const preview = await execFile(process.execPath, [cli, "config", "preview", "proposal.json", "--format", "json", "--cwd", cwd], { cwd: repoCwd });
  const previewReport = JSON.parse(preview.stdout);
  assert.equal(previewReport.status, "conflicts");
  assert.equal(previewReport.merged_config.apiVersion, undefined);
  assert.deepEqual(previewReport.merged_config.trusted_producers["quality.tests"].producers, ["ci/main"]);

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
    "CLI accepted Resource-shaped project config proposal",
    "--authority",
    "cli-smoke",
    "--cwd",
    cwd
  ], { cwd: repoCwd });
  const applyReport = JSON.parse(applied.stdout);
  const stored = JSON.parse(await readFile(path.join(cwd, ".flow", "config.json"), "utf8"));
  assert.equal(applyReport.status, "applied");
  assert.equal(stored.apiVersion, undefined);
  assert.deepEqual(stored.trusted_producers["quality.tests"].producers, ["ci/kit"]);
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

  const cli = cliPath;
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
  const cli = cliPath;
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
  const cli = cliPath;
  const repoCwd = repoRootPath;
  const callerCwd = await mkdtemp(path.join(tmpdir(), "flow-cli-validate-definition-"));
  const valid = await execFile(process.execPath, [cli, "validate-definition", "examples/builder-kit-flow.json", "--json"], {
    cwd: repoCwd
  });
  const validPayload = JSON.parse(valid.stdout);
  assert.equal(validPayload.valid, true);
  assert.equal(validPayload.error_count, 0);
  assert.deepEqual(validPayload.diagnostics, []);

  const cwdValid = await execFile(process.execPath, [cli, "validate-definition", "examples/builder-kit-flow.json", "--json", "--cwd", repoCwd], {
    cwd: callerCwd
  });
  assert.equal(JSON.parse(cwdValid.stdout).valid, true);

  await assert.rejects(
    async () => execFile(process.execPath, [cli, "validate-definition", "examples/invalid-claim-expectation-flow.json", "--json", "--cwd", repoCwd], {
      cwd: callerCwd
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

  const requiresDefinitionPath = path.join(callerCwd, "requires-definition.json");
  await writeFile(requiresDefinitionPath, `${JSON.stringify({
    id: "requires-flow",
    version: "1",
    steps: [
      { id: "verify", next: null }
    ],
    gates: {
      "verify-gate": { step: "verify", requires: ["tests"] }
    }
  }, null, 2)}\n`);
  await assert.rejects(
    async () => execFile(process.execPath, [cli, "validate-definition", "requires-definition.json", "--json"], {
      cwd: callerCwd
    }),
    (error) => {
      const payload = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(payload.valid, false);
      assert.equal(payload.error_count, 1);
      assert.equal(payload.diagnostics[0].code, "definition.gate.field.unsupported");
      assert.equal(payload.diagnostics[0].path, "$.gates.verify-gate.requires");
      return true;
    }
  );
});

test("CLI validates provider-neutral transition request files", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-transition-"));
  const repoCwd = repoRootUrl;
  const cli = cliPath;
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

  const output = await execFile(process.execPath, [cli, "validate-transition", "transition-request.json", "--cwd", cwd], { cwd: repoCwd });
  const payload = JSON.parse(output.stdout);
  assert.equal(payload.valid, false);
  assert.equal(payload.status, "route-back");
  assert.equal(payload.diagnostics[0].code, "transition.gate.route-back");
});
