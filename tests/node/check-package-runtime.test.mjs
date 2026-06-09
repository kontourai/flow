import assert from "node:assert/strict";
import { access, constants, readFile } from "node:fs/promises";
import { test } from "node:test";
import * as flowRuntime from "../../dist/index.js";
import { json } from "./helpers/fixtures.mjs";

test("package runtime points at emitted TypeScript output", async () => {
  const packageJson = await json("package.json");
  const cli = new URL("../../dist/cli.js", import.meta.url);
  const declaration = new URL("../../dist/index.d.ts", import.meta.url);

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

test("package root exports stay stable across source-domain splits", () => {
  const expectedRuntimeExports = [
    "BUILTIN_EVIDENCE_KINDS",
    "FLOW_CONFIG_MERGE_REPORT_SCHEMA_VERSION",
    "FLOW_SCHEMA_VERSION",
    "acceptException",
    "acceptedExceptionFor",
    "applyEvaluation",
    "applyFlowConfigMerge",
    "assertSafeRunId",
    "attachEvidence",
    "attachedEvidenceFor",
    "changeManagementFixtureAdapter",
    "continuationLine",
    "createDiagnostic",
    "defaultFlowConfig",
    "definitionDiagnostics",
    "deploymentWindowFixtureAdapter",
    "ensureFlowLayout",
    "evaluateGate",
    "evaluateReleaseReadiness",
    "evaluateRun",
    "evidenceLabel",
    "evidenceMatchesExpectation",
    "evidenceMatchesRequirement",
    "evidenceProducerTrusted",
    "examplePath",
    "expectationLabel",
    "expectationsForGate",
    "findGate",
    "flowConfigPath",
    "flowReadme",
    "flowRoot",
    "freezeStateFixtureAdapter",
    "gatesForStep",
    "getStep",
    "initialState",
    "legacyEvaluateGate",
    "listRuns",
    "loadFlowConfig",
    "loadReleaseReadinessInputs",
    "loadRun",
    "markdownText",
    "mergeGateOutcome",
    "missingSummary",
    "moduleRoot",
    "nextActionForStep",
    "normalizeEvidenceKind",
    "normalizeTrustArtifact",
    "openGates",
    "passSummary",
    "previewFlowConfigMerge",
    "previewFlowConfigMergeFile",
    "projectFlowRun",
    "projectFlowRunFromFiles",
    "projectVersionReleaseReport",
    "readJson",
    "renderAndWriteReport",
    "renderConfigMergeMarkdown",
    "renderConfigMergeSummary",
    "renderMarkdownReport",
    "renderResume",
    "renderSummary",
    "renderVersionReleaseReportMarkdown",
    "reportJson",
    "routeBackAttempt",
    "routeBackDecision",
    "routeReasonForFailedEvidence",
    "routeTargetForReason",
    "runDir",
    "saveRun",
    "sha256File",
    "slugLabel",
    "sortStatus",
    "startRun",
    "validateDefinition",
    "validateDefinitionWithDiagnostics",
    "validateEvaluationTransition",
    "validateRunTransition",
    "validateTransitionRequest",
    "writeJson"
  ];

  assert.deepEqual(Object.keys(flowRuntime).sort(), expectedRuntimeExports);
});
