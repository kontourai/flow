import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  attachEvidence,
  evaluateRun,
  loadRun,
  normalizeTrustBundle,
  startRun,
  validateDefinition
} from "../../dist/index.js";
import { json } from "./helpers/fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const scenarioRoot = path.join(repoRoot, "examples", "scenarios", "deploy-live-verify");

// These fixtures use canonical Hachure schemaVersion 7 vocabulary, with a deliberately long validity window for executability.
test("deploy live-verify example blocks test-only evidence and completes on a live receipt", async () => {
  const definition = await json("examples/deploy-live-verify-flow.json");
  assert.doesNotThrow(() => validateDefinition(definition));

  const testOnly = await json("examples/scenarios/deploy-live-verify/test-only.bundle.json");
  const liveReceipt = await json("examples/scenarios/deploy-live-verify/live-receipt.bundle.json");
  const testOnlyReport = normalizeTrustBundle(testOnly).bundle_report;
  const liveReceiptReport = normalizeTrustBundle(liveReceipt).bundle_report;
  assert.equal(testOnlyReport.claims[0].status, "proposed");
  assert.deepEqual(
    testOnlyReport.transparencyGaps.map((gap) => gap.type),
    ["provenance_gap", "policy_violation"]
  );
  assert.equal(liveReceiptReport.claims[0].status, "verified");
  assert.deepEqual(liveReceiptReport.transparencyGaps, []);

  const cwd = await mkdtemp(path.join(tmpdir(), "flow-live-verify-"));
  const definitionPath = path.join(repoRoot, "examples", "deploy-live-verify-flow.json");
  const { runId } = await startRun(definitionPath, { cwd, runId: "deploy-live-verify" });

  await attachEvidence(runId, {
    cwd,
    gate: "build-gate",
    file: path.join(scenarioRoot, "static-build.bundle.json"),
    kind: "trust.bundle"
  });
  const build = await evaluateRun(runId, { cwd });
  assert.equal(build.outcomes[0].status, "pass");
  assert.equal(build.state.current_step, "deploy");

  await attachEvidence(runId, {
    cwd,
    gate: "deploy-gate",
    file: path.join(scenarioRoot, "deployed-sha.bundle.json"),
    kind: "trust.bundle"
  });
  const deploy = await evaluateRun(runId, { cwd });
  assert.equal(deploy.outcomes[0].status, "pass");
  assert.equal(deploy.state.current_step, "live-verify");

  const missing = await evaluateRun(runId, { cwd });
  assert.equal(missing.outcomes[0].status, "block");
  assert.deepEqual(missing.outcomes[0].missing, ["production-env-passthrough-confirmed"]);

  const testEntry = await attachEvidence(runId, {
    cwd,
    gate: "live-confirm-gate",
    file: path.join(scenarioRoot, "test-only.bundle.json"),
    kind: "trust.bundle"
  });
  assert.equal(testEntry.bundle_report.claims[0].status, "proposed");

  const testOnlyResult = await evaluateRun(runId, { cwd });
  assert.equal(testOnlyResult.outcomes[0].status, "block");
  assert.equal(testOnlyResult.outcomes[0].diagnostics.claim_evaluation[0].reason, "rejected");
  assert.equal(testOnlyResult.state.status, "blocked");

  const liveEntry = await attachEvidence(runId, {
    cwd,
    gate: "live-confirm-gate",
    file: path.join(scenarioRoot, "live-receipt.bundle.json"),
    kind: "trust.bundle"
  });
  assert.equal(liveEntry.bundle_report.claims[0].status, "verified");

  const complete = await evaluateRun(runId, { cwd });
  assert.equal(complete.outcomes[0].status, "pass");
  assert.equal(complete.state.status, "completed");
  assert.equal(complete.state.next_action, "run complete; no further action required");

  const persisted = await loadRun(runId, cwd);
  assert.equal(persisted.state.status, "completed");
});
