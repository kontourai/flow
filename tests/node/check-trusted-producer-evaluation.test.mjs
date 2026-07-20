import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  attachEvidence,
  evaluateRun,
  loadRun,
  startRun
} from "../../dist/index.js";
import { surfaceClaimEvidenceFixture, surfaceClaimFixture } from "./helpers/fixtures.mjs";

async function pinnedRun(name) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `flow-producer-policy-${name}-`));
  const definition = await surfaceClaimFixture("flow-definition.json");
  definition.steps = definition.steps.filter((step) => step.id !== "plan");
  definition.gates["verify-gate"].on_route_back = {};
  const definitionPath = path.join(cwd, "definition.json");
  await writeFile(definitionPath, `${JSON.stringify(definition, null, 2)}\n`);
  const started = await startRun(definitionPath, {
    cwd,
    runId: name,
    params: { subject: `flow#${name}` }
  });

  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify({
    schema_version: "0.1",
    trusted_producers: {
      "quality.tests": { producers: ["ci/main"] }
    },
    gate_overrides: {}
  }, null, 2)}\n`);

  const manifest = await surfaceClaimEvidenceFixture("pass-trust-report.json");
  const bundlePath = path.join(cwd, "bundle.json");
  await writeFile(bundlePath, `${JSON.stringify(manifest.evidence[0].bundle, null, 2)}\n`);
  return { cwd, bundlePath, ...started };
}

test("concurrent attachment and evaluation cannot advance untrusted producer evidence", async () => {
  const fixture = await pinnedRun("concurrent-producer-pin");

  await Promise.all([
    attachEvidence(fixture.runId, {
      cwd: fixture.cwd,
      gate: "verify-gate",
      file: fixture.bundlePath,
      kind: "trust.bundle",
      producer: "station/command"
    }),
    evaluateRun(fixture.runId, { cwd: fixture.cwd })
  ]);

  const afterRace = await loadRun(fixture.runId, fixture.cwd);
  assert.equal(afterRace.manifest.evidence[0].producer, "station/command");
  assert.notEqual(afterRace.state.status, "completed");

  await attachEvidence(fixture.runId, {
    cwd: fixture.cwd,
    gate: "verify-gate",
    file: fixture.bundlePath,
    kind: "trust.bundle",
    producer: "station/command",
    supersede: afterRace.manifest.evidence.map((entry) => entry.id)
  });
  const evaluated = await evaluateRun(fixture.runId, { cwd: fixture.cwd });
  assert.notEqual(evaluated.state.status, "completed");
  assert.notEqual(evaluated.outcomes[0].status, "pass");
  assert.equal(
    evaluated.outcomes[0].diagnostics.claim_evaluation[0].reason,
    "untrusted_producer"
  );
});
