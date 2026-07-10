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
  await access(path.join(cwd, ".flow", "config.json"), constants.R_OK);
});

test("AC-111-01 and AC-111-05 CLI start prints and writes the canonical runtime root without moving authored .flow state", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-runtime-root-"));
  const definition = new URL("../../examples/agent-dev-flow.json", import.meta.url).pathname;
  await execFile(process.execPath, [cliPath, "init", "--cwd", cwd]);
  const result = await execFile(process.execPath, [cliPath, "start", definition, "--run-id", "canonical-cli", "--cwd", cwd]);

  assert.match(result.stdout, /report: \.kontourai\/flow\/runs\/canonical-cli\/report\.md/);
  await access(path.join(cwd, ".kontourai", "flow", "runs", "canonical-cli", "state.json"), constants.R_OK);
  await assert.rejects(access(path.join(cwd, ".flow", "runs", "canonical-cli", "state.json"), constants.F_OK), /ENOENT/);
  await access(path.join(cwd, ".flow", "definitions", "agent-dev-flow.json"), constants.R_OK);
  await access(path.join(cwd, ".flow", "config.json"), constants.R_OK);
});

test("AC-111-02 and AC-111-05 CLI init --demo ignores generated state from older versions", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-old-demo-"));
  const legacyState = path.join(cwd, ".flow", "runs", "demo", "state.json");
  await mkdir(path.dirname(legacyState), { recursive: true });
  await writeFile(legacyState, "older generated state\n");
  const init = await execFile(process.execPath, [cliPath, "init", "--demo", "--cwd", cwd]);
  assert.match(init.stdout, /demo run ready: demo/);
  await access(path.join(cwd, ".kontourai", "flow", "runs", "demo", "state.json"), constants.R_OK);
  assert.equal(await readFile(legacyState, "utf8"), "older generated state\n");

  const listed = await execFile(process.execPath, [cliPath, "list", "--cwd", cwd]);
  assert.match(listed.stdout, /demo/);
  assert.doesNotMatch(`${listed.stdout}${listed.stderr}`, /legacy|compatibility/i);
});

test("CLI init --demo scaffolds a resumable demo run past the plan gate", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-init-demo-"));
  const result = await execFile(process.execPath, [cliPath, "init", "--demo", "--cwd", cwd]);
  assert.match(result.stdout, /demo run ready: demo/);
  assert.match(result.stdout, /flow resume demo/);
  await access(path.join(cwd, ".kontourai", "flow", "demo", "acceptance-bundle.json"), constants.R_OK);
  await assert.rejects(access(path.join(cwd, ".flow", "demo", "acceptance-bundle.json"), constants.F_OK), /ENOENT/);

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

test("completed runs report completion instead of a stale next action", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-complete-"));
  const scenario = new URL("../../examples/scenarios/adversarial-survey/", import.meta.url).pathname;
  const definition = new URL("../../examples/adversarial-pass-flow.json", import.meta.url).pathname;
  await execFile(process.execPath, [cliPath, "init", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "start", definition, "--run-id", "done-1", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "attach-evidence", "done-1", "--gate", "adversarial-review-gate",
    "--file", path.join(scenario, "producer-output.trust.json"), "--bundle", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "attach-evidence", "done-1", "--gate", "adversarial-review-gate",
    "--file", path.join(scenario, "review-round-2-trusted.trust.json"), "--bundle", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "evaluate", "done-1", "--gate", "adversarial-review-gate", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "attach-evidence", "done-1", "--gate", "resolve-gate",
    "--file", path.join(scenario, "resolution.trust.json"), "--bundle", "--cwd", cwd]);
  const final = await execFile(process.execPath, [cliPath, "evaluate", "done-1", "--cwd", cwd]);
  assert.match(final.stdout, /next action: run complete; no further action required/);

  const state = JSON.parse(await readFile(path.join(cwd, ".kontourai", "flow", "runs", "done-1", "state.json"), "utf8"));
  assert.equal(state.status, "completed");
  assert.equal(state.next_action, "run complete; no further action required");
});

test("CLI supersede replaces failed evidence so a route-back can recover", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-supersede-"));
  const scenario = new URL("../../examples/scenarios/adversarial-survey/", import.meta.url).pathname;
  const definition = new URL("../../examples/adversarial-pass-flow.json", import.meta.url).pathname;
  await execFile(process.execPath, [cliPath, "init", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "start", definition, "--run-id", "adv-1", "--cwd", cwd]);
  await execFile(process.execPath, [cliPath, "attach-evidence", "adv-1", "--gate", "adversarial-review-gate",
    "--file", path.join(scenario, "producer-output.trust.json"), "--bundle", "--cwd", cwd]);
  const failed = await execFile(process.execPath, [cliPath, "attach-evidence", "adv-1", "--gate", "adversarial-review-gate",
    "--file", path.join(scenario, "review-round-1-completeness-defect.trust.json"),
    "--bundle", "--status", "failed", "--route-reason", "completeness_defect", "--cwd", cwd]);
  const failedId = failed.stdout.match(/attached evidence: (\S+)/)[1];

  const routeBack = await execFile(process.execPath, [cliPath, "evaluate", "adv-1", "--gate", "adversarial-review-gate", "--cwd", cwd]);
  assert.match(routeBack.stdout, /route-back adversarial-review-gate/);

  await execFile(process.execPath, [cliPath, "attach-evidence", "adv-1", "--gate", "adversarial-review-gate",
    "--file", path.join(scenario, "review-round-2-trusted.trust.json"),
    "--bundle", "--supersede", failedId, "--cwd", cwd]);
  const pass = await execFile(process.execPath, [cliPath, "evaluate", "adv-1", "--gate", "adversarial-review-gate", "--cwd", cwd]);
  assert.match(pass.stdout, /pass adversarial-review-gate/);
  assert.match(pass.stdout, /current step: resolve/);

  // superseded entry stays in the manifest for audit
  const manifest = JSON.parse(await readFile(path.join(cwd, ".kontourai", "flow", "runs", "adv-1", "evidence", "manifest.json"), "utf8"));
  const superseded = manifest.evidence.find((entry) => entry.id === failedId);
  assert.ok(superseded.superseded_by, "failed evidence records superseded_by");

  // superseding evidence on another gate is rejected
  await assert.rejects(
    execFile(process.execPath, [cliPath, "attach-evidence", "adv-1", "--gate", "resolve-gate",
      "--file", path.join(scenario, "resolution.trust.json"), "--bundle", "--supersede", failedId, "--cwd", cwd]),
    /cannot supersede evidence/
  );
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
            kind: "trust.bundle",
            required: true,
            description: "Tests passed.",
            explore_hint: "Run the suite and attach the CI trust report.",
            bundle_claim: { claimType: "quality.tests", accepted_statuses: ["verified"] }
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
  const acceptanceBundle = {
    schemaVersion: 5,
    source: "cli/acceptance",
    claims: [{
      id: "claim.builder.acceptance.cwd",
      subjectType: "flow-step",
      subjectId: "resource-contract-flow",
      facet: "builder.acceptance",
      claimType: "builder.acceptance",
      fieldOrBehavior: "acceptanceCriteria",
      value: "acceptance criteria linked",
      createdAt: "2026-06-10T00:00:00.000Z",
      updatedAt: "2026-06-10T00:00:00.000Z"
    }],
    evidence: [{
      id: "evidence.builder.acceptance.cwd",
      claimId: "claim.builder.acceptance.cwd",
      evidenceType: "human_attestation",
      method: "attestation",
      sourceRef: "cli:cwd-smoke",
      excerptOrSummary: "Acceptance criteria reviewed.",
      observedAt: "2026-06-10T00:00:00.000Z",
      collectedBy: "cli/acceptance"
    }],
    policies: [],
    events: [{
      id: "event.builder.acceptance.cwd.verified",
      claimId: "claim.builder.acceptance.cwd",
      status: "verified",
      actor: "cli/acceptance",
      method: "attestation",
      evidenceIds: ["evidence.builder.acceptance.cwd"],
      createdAt: "2026-06-10T00:00:00.000Z",
      verifiedAt: "2026-06-10T00:00:00.000Z"
    }]
  };
  await writeFile(path.join(flowCwd, "acceptance-bundle.json"), `${JSON.stringify(acceptanceBundle, null, 2)}\n`);
  await writeFile(path.join(flowCwd, "route-metadata.json"), `${JSON.stringify({ route_reason: "plan_gap", expectation_ids: ["acceptance-criteria"] }, null, 2)}\n`);

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
    "acceptance-bundle.json",
    "--bundle",
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

  const runPath = path.join(flowCwd, ".kontourai", "flow", "runs", "cwd-smoke");
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
  assert.equal(manifest.evidence[0].original_path, "acceptance-bundle.json");
  assert.equal(manifest.evidence[0].kind, "trust.bundle");
  assert.ok(manifest.evidence[0].bundle, "bundle field should be present");
  assert.equal(manifest.evidence[0].bundle.claims[0].claimType, "builder.acceptance");
  assert.equal(manifest.evidence[0].route_reason, "plan_gap");
  assert.deepEqual(manifest.evidence[0].expectation_ids, ["acceptance-criteria"]);
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
  const exceptionState = JSON.parse(await readFile(path.join(flowCwd, ".kontourai", "flow", "runs", "cwd-exception", "state.json"), "utf8"));
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

  const manifest = JSON.parse(await readFile(path.join(cwd, ".kontourai", "flow", "runs", "cli-route", "evidence", "manifest.json"), "utf8"));
  const entry = manifest.evidence[0];
  assert.equal(entry.route_reason, "implementation_defect");
  assert.deepEqual(entry.classifier, { kind: "manual", source: "cli", confidence: 0.75 });
  assert.deepEqual(entry.diagnostics, { claimed_target: "plan" });
  assert.deepEqual(entry.analytics, { loop_key: "cli:flag-loop" });
  assert.deepEqual(entry.expectation_ids, ["tests-passed"]);

  const report = JSON.parse(await readFile(path.join(cwd, ".kontourai", "flow", "runs", "cli-route", "report.json"), "utf8"));
  const gate = report.gate_summaries.find((item) => item.gate_id === "verify-gate");
  assert.equal(gate.route_back_to, "implement");
  assert.equal(gate.route_reason, "implementation_defect");
  assert.equal(gate.analytics_loop_key, "cli:flag-loop");
  assert.deepEqual(gate.diagnostics, { claimed_target: "plan" });
});

test("CLI attaches trust.bundle evidence and reports claim diagnostics", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-trust-"));
  const cli = cliPath;
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(routeBackDefinition(), null, 2)}\n`);

  const verifiedBundle = {
    schemaVersion: 5,
    source: "ci/main",
    claims: [{
      id: "claim.quality.tests.verify",
      subjectType: "flow-step",
      subjectId: "builder.verify",
      facet: "quality.developer-evidence",
      claimType: "quality.tests",
      fieldOrBehavior: "testSuite",
      value: "all tests passed",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z"
    }],
    evidence: [{
      id: "evidence.quality.tests.output",
      claimId: "claim.quality.tests.verify",
      evidenceType: "test_output",
      method: "validation",
      sourceRef: "ci:run-1",
      excerptOrSummary: "All tests passed.",
      observedAt: "2026-05-26T00:00:00.000Z",
      collectedBy: "ci/main"
    }],
    policies: [],
    events: [{
      id: "event.quality.tests.verified",
      claimId: "claim.quality.tests.verify",
      status: "verified",
      actor: "ci/main",
      method: "npm test",
      evidenceIds: ["evidence.quality.tests.output"],
      createdAt: "2026-05-26T00:00:00.000Z",
      verifiedAt: "2026-05-26T00:00:00.000Z"
    }]
  };
  await writeFile(path.join(cwd, "verified-bundle.json"), `${JSON.stringify(verifiedBundle, null, 2)}\n`);
  await execFile(process.execPath, [cli, "start", "definition.json", "--run-id", "cli-trust-pass", "--params", "subject=cli-trust"], { cwd });
  await execFile(process.execPath, [
    cli,
    "attach-evidence",
    "cli-trust-pass",
    "--gate",
    "verify-gate",
    "--file",
    "verified-bundle.json",
    "--bundle"
  ], { cwd });
  await execFile(process.execPath, [cli, "evaluate", "cli-trust-pass", "--gate", "verify-gate"], { cwd });
  const passReport = JSON.parse((await execFile(process.execPath, [cli, "report", "cli-trust-pass", "--format", "json"], { cwd })).stdout);
  const passGate = passReport.gate_summaries.find((item) => item.gate_id === "verify-gate");
  assert.equal(passGate.status, "pass");
  assert.equal(passGate.matched_expectations[0].expectation_id, "tests-passed");
  assert.equal(passGate.evidence_refs.length, 1);

  const rejectedBundle = {
    ...verifiedBundle,
    events: [{
      id: "event.quality.tests.rejected",
      claimId: "claim.quality.tests.verify",
      status: "rejected",
      actor: "ci/main",
      method: "npm test",
      evidenceIds: ["evidence.quality.tests.output"],
      createdAt: "2026-05-26T00:00:00.000Z"
    }]
  };
  await writeFile(path.join(cwd, "rejected-bundle.json"), `${JSON.stringify(rejectedBundle, null, 2)}\n`);
  await execFile(process.execPath, [cli, "start", "definition.json", "--run-id", "cli-trust-rejected", "--params", "subject=cli-trust"], { cwd });
  await execFile(process.execPath, [
    cli,
    "attach-evidence",
    "cli-trust-rejected",
    "--gate",
    "verify-gate",
    "--file",
    "rejected-bundle.json",
    "--bundle"
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
      assert.equal(payload.diagnostics[0].code, "definition.expectation.bundle_claim.required");
      assert.equal(payload.diagnostics[0].path, "$.gates.verify-gate.expects[0].bundle_claim");
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
