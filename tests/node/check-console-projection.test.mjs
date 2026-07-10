import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  projectFlowRun,
  projectFlowRunFromFiles,
  FLOW_RUN_DEFINITION_FILE,
  FLOW_RUN_EVIDENCE_MANIFEST_PATH,
  FLOW_RUN_LAYOUT,
  FLOW_RUN_REPORT_JSON_FILE,
  FLOW_RUN_REPORT_MARKDOWN_FILE,
  FLOW_RUN_STATE_FILE
} from "../../dist/index.js";
import * as implementationProjection from "../../dist/console/console-projection.js";

const fixtureSourceDir = fileURLToPath(new URL("../../examples/scenarios/console-projection/runtime-fixture/console-projection-fixture", import.meta.url));
const fixtureCwd = await mkdtemp(path.join(tmpdir(), "flow-console-projection-fixture-"));
const fixtureRunId = "console-projection-fixture";
const fixtureRunDir = path.join(fixtureCwd, ".kontourai", "flow", "runs", fixtureRunId);
await mkdir(path.dirname(fixtureRunDir), { recursive: true });
await cp(fixtureSourceDir, fixtureRunDir, { recursive: true });

async function readFixtureJson(name) {
  return JSON.parse(await readFile(path.join(fixtureRunDir, name), "utf8"));
}

async function readRepoJson(name) {
  return JSON.parse(await readFile(new URL(`../../${name}`, import.meta.url), "utf8"));
}

function byId(values, id) {
  const value = values.find((entry) => entry.id === id);
  assert.ok(value, `expected ${id}`);
  return value;
}

test("AC1 fixture Flow Run state follows the checked run schema contract", async () => {
  const state = await readFixtureJson("state.json");
  const manifest = await readFixtureJson(FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  const runSchema = await readRepoJson("schemas/flow-run.schema.json");
  const allowedStatuses = new Set(runSchema.$defs.transition.properties.status.enum);
  const allowedGateOutcomeStatuses = new Set(runSchema.$defs.gate_outcome.properties.status.enum);
  const allowedExceptionKeys = new Set(Object.keys(runSchema.$defs.exception.properties));

  assert.deepEqual(FLOW_RUN_LAYOUT, {
    definition: "definition.json",
    state: "state.json",
    evidenceDirectory: "evidence",
    evidenceManifest: "evidence/manifest.json",
    reportJson: "report.json",
    reportMarkdown: "report.md"
  });
  await readFixtureJson(FLOW_RUN_DEFINITION_FILE);
  await readFixtureJson(FLOW_RUN_STATE_FILE);
  await readFixtureJson(FLOW_RUN_EVIDENCE_MANIFEST_PATH);
  await readFixtureJson(FLOW_RUN_REPORT_JSON_FILE);
  await readFile(path.join(fixtureRunDir, FLOW_RUN_REPORT_MARKDOWN_FILE), "utf8");
  assert.equal(manifest.run_id, state.run_id);
  assert.equal(manifest.definition_id, state.definition_id);
  assert.equal(manifest.definition_version, state.definition_version);
  assert.ok(Array.isArray(manifest.evidence));

  for (const outcome of state.gate_outcomes) {
    assert.ok(allowedGateOutcomeStatuses.has(outcome.status), `${outcome.gate_id} gate outcome status must be schema-valid`);
  }

  for (const transition of state.transitions) {
    assert.ok(allowedStatuses.has(transition.status), `${transition.id} status must be schema-valid`);
  }

  for (const exception of state.exceptions) {
    for (const key of Object.keys(exception)) {
      assert.ok(allowedExceptionKeys.has(key), `${exception.id} exception key ${key} must be schema-valid`);
    }
  }
});

test("AC1 AC4 fixture Flow Run produces the expected console projection read model", async () => {
  const expected = await readFixtureJson("expected-projection.json");
  const actual = await projectFlowRunFromFiles(fixtureRunId, { cwd: fixtureCwd });

  assert.deepEqual(actual, expected);
  assert.equal(actual.run.run_id, fixtureRunId);
  assert.equal(actual.definition.id, "console-projection-flow");
  assert.deepEqual(actual.steps.map((step) => step.id), ["shape", "build", "verify", "release"]);
  assert.equal(actual.current_step, "verify");
  assert.deepEqual(actual.gates.map((gate) => gate.id), ["build-gate", "verify-gate"]);
  assert.deepEqual(actual.expectations.map((expectation) => expectation.id), ["missing-review", "tests-passed"]);
  assert.deepEqual(actual.evidence.map((entry) => entry.id), [
    "ev.failed-tests",
    "ev.scoped-diff",
    "ev.surface-tests",
    "ev.veritas-readiness"
  ]);
  assert.deepEqual(actual.exceptions.map((entry) => entry.id), ["ex.review-deferred"]);
  assert.deepEqual(actual.transitions.map((entry) => entry.id), ["tr.shape-build", "tr.verify-build"]);
  assert.deepEqual(actual.route_backs.map((entry) => entry.id), ["gate_outcome.1", "tr.verify-build"]);
  assert.equal(actual.next_action, "Fix the test failure and rerun verification.");
});

test("AC2 projection preserves missing evidence, failed evidence, accepted exceptions, and route-backs", async () => {
  const projection = await projectFlowRunFromFiles(fixtureRunId, { cwd: fixtureCwd });

  const buildGate = byId(projection.gates, "build-gate");
  assert.equal(buildGate.status, "pass");
  assert.deepEqual(buildGate.missing, ["missing-review"]);
  assert.equal(buildGate.accepted_exception_id, "ex.review-deferred");

  const failedEvidence = byId(projection.evidence, "ev.failed-tests");
  assert.equal(failedEvidence.status, "failed");
  assert.equal(failedEvidence.route_reason, "implementation_defect");
  assert.deepEqual(failedEvidence.expectation_ids, ["tests-passed"]);

  // §4 nested trust panel: the projection passes a trust.bundle entry's
  // pre-derived TrustReport through as bundle_report (null where absent), so
  // the drawer can mount <surface-trust-panel> without re-deriving in browser.
  const bundleEvidence = byId(projection.evidence, "ev.surface-tests");
  assert.ok(bundleEvidence.bundle_report, "trust.bundle evidence carries bundle_report");
  assert.ok(
    Array.isArray(bundleEvidence.bundle_report.claims),
    "bundle_report is a derived TrustReport with claims",
  );
  assert.equal(failedEvidence.bundle_report, null, "non-bundle evidence has null bundle_report");

  const acceptedException = byId(projection.exceptions, "ex.review-deferred");
  assert.equal(acceptedException.gate_id, "build-gate");
  assert.equal(acceptedException.authority, "fixture-owner");
  assert.deepEqual(acceptedException.evidence_refs, ["ev.scoped-diff"]);

  const routeBackTransition = byId(projection.route_backs, "tr.verify-build");
  assert.equal(routeBackTransition.source, "transition");
  assert.equal(routeBackTransition.from_step, "verify");
  assert.equal(routeBackTransition.to_step, "build");
  assert.equal(routeBackTransition.reason, "implementation_defect");
  assert.equal(routeBackTransition.attempt, 1);
  assert.equal(routeBackTransition.max_attempts, 2);
});

test("AC3 projection runtime exports and declarations are available at package boundaries", async () => {
  assert.equal(typeof projectFlowRun, "function");
  assert.equal(typeof projectFlowRunFromFiles, "function");
  assert.equal(typeof implementationProjection.projectFlowRun, "function");
  assert.equal(typeof implementationProjection.projectFlowRunFromFiles, "function");

  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.types, "./dist/index.d.ts");
  assert.equal(packageJson.exports["."].types, "./dist/index.d.ts");
  assert.equal(packageJson.exports["."].import, "./dist/index.js");
  assert.equal(packageJson.exports["./console-projection"], undefined);

  const indexTypes = await readFile(new URL("../../dist/index.d.ts", import.meta.url), "utf8");
  const projectionImplementationTypes = await readFile(new URL("../../dist/console/console-projection.d.ts", import.meta.url), "utf8");
  assert.match(indexTypes, /from "\.\/console\/console-projection\.js"/);
  assert.match(projectionImplementationTypes, /interface FlowConsoleProjection/);
  assert.match(projectionImplementationTypes, /function projectFlowRun/);
  assert.match(projectionImplementationTypes, /function projectFlowRunFromFiles/);
});

test("AC5 projection preserves explicit external link refs without synthesizing missing refs", async () => {
  const projection = await projectFlowRunFromFiles(fixtureRunId, { cwd: fixtureCwd });
  const linkKinds = new Set(projection.external_links.map((link) => link.kind));

  assert.ok(linkKinds.has("surface"));
  assert.ok(linkKinds.has("veritas"));
  assert.ok(linkKinds.has("artifact"));
  assert.ok(linkKinds.has("pull-request"));
  assert.ok(linkKinds.has("ci"));
  assert.ok(linkKinds.has("release-report"));
  assert.ok(projection.external_links.every((link) => link.href || link.path));
  assert.equal(byId(projection.external_links, "surface-claim-tests").href, "surface://claims/quality.tests/console-projection-fixture");
  assert.equal(byId(projection.external_links, "veritas-readiness-report").href, "veritas://readiness/console-projection-fixture");
  assert.equal(byId(projection.external_links, "artifact-scoped-diff").path, "artifacts/scoped-diff.txt");
  assert.equal(byId(projection.external_links, "pr-18").href, "https://github.com/kontourai/flow/pull/18");
  assert.equal(byId(projection.external_links, "ci-failed-tests").href, "https://ci.example.test/kontourai/flow/actions/runs/4242");
  assert.equal(byId(projection.external_links, "release-report-local").path, "reports/release-readiness.md");
});

test("AC5 projection ignores link-shaped arbitrary metadata outside explicit ref containers", async () => {
  const definition = await readFixtureJson("definition.json");
  const state = await readFixtureJson("state.json");
  const manifest = await readFixtureJson("evidence/manifest.json");

  manifest.evidence.push({
    id: "ev.metadata-only-ci",
    gate_id: "verify-gate",
    kind: "command",
    status: "passed",
    stored_path: "evidence/metadata-only-ci.txt",
    ci: [
      {
        id: "metadata-ci-should-not-project",
        kind: "ci",
        href: "https://ci.example.test/metadata-only"
      }
    ],
    diagnostics: {
      refs: [
        {
          id: "nested-diagnostic-should-not-project",
          kind: "artifact",
          path: "diagnostics/nested.txt"
        }
      ]
    }
  });

  const projection = projectFlowRun({ dir: fixtureRunDir, definition, state, manifest });

  assert.ok(byId(projection.external_links, "ev.metadata-only-ci:stored_path"));
  assert.equal(projection.external_links.some((link) => link.id === "metadata-ci-should-not-project"), false);
  assert.equal(projection.external_links.some((link) => link.id === "nested-diagnostic-should-not-project"), false);
});

test("AC6 projection is deterministic for repeat local-file reads and direct parts", async () => {
  const first = await projectFlowRunFromFiles(fixtureRunId, { cwd: fixtureCwd });
  const second = await projectFlowRunFromFiles(fixtureRunId, { cwd: fixtureCwd });
  assert.deepEqual(second, first);

  const definition = await readFixtureJson("definition.json");
  const state = await readFixtureJson("state.json");
  const manifest = await readFixtureJson("evidence/manifest.json");
  const report = await readFixtureJson(FLOW_RUN_REPORT_JSON_FILE);
  const fromParts = projectFlowRun({ dir: fixtureRunDir, definition, state, manifest, report });
  assert.deepEqual(fromParts, first);
});
