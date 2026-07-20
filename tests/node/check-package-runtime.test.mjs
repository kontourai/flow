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
    "EvidenceReferenceCycleError",
    "FLOW_CONFIG_MERGE_REPORT_SCHEMA_VERSION",
    "FLOW_LIFECYCLE_TEXT_LIMITS",
    "FLOW_RUN_DEFINITION_FILE",
    "FLOW_RUN_EVIDENCE_DIR",
    "FLOW_RUN_EVIDENCE_MANIFEST_FILE",
    "FLOW_RUN_EVIDENCE_MANIFEST_PATH",
    "FLOW_RUN_LAYOUT",
    "FLOW_RUN_REPORT_JSON_FILE",
    "FLOW_RUN_REPORT_MARKDOWN_FILE",
    "FLOW_RUN_STATE_FILE",
    "FLOW_SCHEMA_VERSION",
    "FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES",
    "FileConsoleSink",
    "FlowDefinitionAmendmentError",
    "FlowLifecycleError",
    "FlowRetryAuthorizationError",
    "HostedConsoleSink",
    "TRUST_ATTACHMENT_REDUCER_ARTIFACT_ID",
    "TRUST_ATTACHMENT_REDUCER_VERSION",
    "acceptException",
    "acceptedExceptionFor",
    "amendRunDefinition",
    "applyEvaluation",
    "applyFlowConfigMerge",
    "assertDefinitionCompatibility",
    "assertEvidenceReferencesAcyclic",
    "assertExpectedDefinitionIdentity",
    "assertLifecycleEligible",
    "assertSafeRunId",
    "attachEvidence",
    "attachedEvidenceFor",
    "authorizeRetry",
    "cancelRun",
    "canonicalJson",
    "changeManagementFixtureAdapter",
    "continuationLine",
    "createConsoleSink",
    "createDiagnostic",
    "defaultFlowConfig",
    "definitionDiagnostics",
    "definitionDigest",
    "definitionIdentity",
    "deploymentWindowFixtureAdapter",
    "descendantsOf",
    "effectiveDefinitionIdentity",
    "ensureFlowLayout",
    "evaluateGate",
    "evaluateReleaseReadiness",
    "evaluateRun",
    "evidenceLabel",
    "evidenceMatchesExpectation",
    "evidenceMatchesRequirement",
    "examplePath",
    "expectationLabel",
    "expectationsForGate",
    "findGate",
    "flowConfigPath",
    "flowReadme",
    "flowRoot",
    "flowRunHead",
    "flowRuntimeRoot",
    "flowTransitionRef",
    "freezeStateFixtureAdapter",
    "gatesForStep",
    "getStep",
    "initialState",
    "invalidateDescendants",
    "lifecycleEligibilityDiagnostic",
    "lifecycleRequestMatches",
    "listRuns",
    "listRunsWithDiagnostics",
    "loadFlowConfig",
    "loadReleaseReadinessInputs",
    "loadRun",
    "markdownText",
    "mergeGateOutcome",
    "missingSummary",
    "moduleRoot",
    "nextActionForStep",
    "normalizeEvidenceKind",
    "normalizeRunStateLifecycle",
    "normalizeTrustAttachmentBundle",
    "normalizeTrustBundle",
    "openGates",
    "passSummary",
    "pauseRun",
    "predecessorsOf",
    "previewFlowConfigMerge",
    "previewFlowConfigMergeFile",
    "priorResumableStatus",
    "projectFlowRun",
    "projectFlowRunFromFiles",
    "projectRunOutputBundle",
    "projectVersionReleaseReport",
    "reDeriveBundleReports",
    "readJson",
    "readyGates",
    "readySteps",
    "reduceTrustAttachment",
    "reduceTrustAttachmentManifest",
    "renderAndWriteReport",
    "renderConfigMergeMarkdown",
    "renderConfigMergeSummary",
    "renderMarkdownReport",
    "renderResume",
    "renderSummary",
    "renderVersionReleaseReportMarkdown",
    "reportJson",
    "resolveEffectiveDefinition",
    "resumeRun",
    "retryAuthorizationMatches",
    "routeBackAttempt",
    "routeBackDecision",
    "routeBackEpoch",
    "routeReasonForFailedEvidence",
    "routeTargetForReason",
    "runDir",
    "scaffoldDemoRun",
    "sha256File",
    "slugLabel",
    "sortStatus",
    "stageStatuses",
    "startFlowConsoleServer",
    "startRun",
    "trustAttachmentReducerIdentity",
    "validateDefinition",
    "validateDefinitionAmendmentRequest",
    "validateDefinitionWithDiagnostics",
    "validateEvaluationTransition",
    "validateKitContainer",
    "validateKitContainerFile",
    "validateLifecycleRequest",
    "validateRetryAuthorizationRequest",
    "validateRunLifecycle",
    "validateRunStateConsistency",
    "validateRunTransition",
    "validateTransitionRequest",
    "writeJson"
  ];
  assert.deepEqual(Object.keys(flowRuntime).sort(), expectedRuntimeExports);
  assert.equal(Object.hasOwn(flowRuntime, "evaluateGate"), true);
  assert.equal(Object.hasOwn(flowRuntime, "flowRuntimeRoot"), true, "canonical runtime root is intentionally public");
  assert.equal(Object.hasOwn(flowRuntime, "legacyRunDir"), false, "no legacy runtime path API exists");
  assert.equal(Object.hasOwn(flowRuntime, "resolveExistingRunLocation"), false, "no dual-root resolver API exists");
});

test("AC-111-05 and AC-111-06 package documentation declares one runtime root and explicit older-version migration", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const structure = await readFile(new URL("../../docs/repo-structure.md", import.meta.url), "utf8");
  const fixture = await readFile(new URL("../../examples/scenarios/console-projection/README.md", import.meta.url), "utf8");
  const changelog = await readFile(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const publishedDocs = [readme, structure, fixture, changelog].join("\n");

  assert.match(publishedDocs, /\.kontourai\/flow\/runs\/<run-id>/, "published run layout names the canonical generated root");
  assert.match(structure, /\.flow\/config\.json/, "authored project configuration remains under .flow");
  assert.match(structure, /\.flow\/definitions/, "authored definitions remain under .flow");
  assert.match(fixture, /materializ/i, "published fixture explains canonical runtime materialization");
  assert.match(publishedDocs, /do(?:es)? not read .*\.flow\/runs|no runtime legacy support/is, "runtime legacy support is explicitly absent");
  assert.match(publishedDocs, /no auto(?:matic)? migration/i, "ordinary runtime commands do not migrate older state");
  assert.match(publishedDocs, /backup/i);
  assert.match(publishedDocs, /collision/i);
  assert.match(publishedDocs, /identity/i);
  assert.match(readme, /\[Runtime Roots\]\(docs\/runtime-roots\.md\)/, "README links the operator migration guide");
  assert.match(publishedDocs, /migrat(?:e|ion).*explicit/i, "migration is an explicit operator action");
  assert.match(publishedDocs, /rollback/i, "rollback risk is documented for the semver-major path change");
});
