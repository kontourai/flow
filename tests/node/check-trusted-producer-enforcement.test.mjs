import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as flow from "../../dist/index.js";
import { execFile } from "./helpers/cli.mjs";
import { surfaceClaimEvidenceFixture, surfaceClaimFixture } from "./helpers/fixtures.mjs";

const cliPath = new URL("../../dist/cli.js", import.meta.url).pathname;

const configFor = (overrides = {}) => ({
  schema_version: flow.FLOW_SCHEMA_VERSION,
  trusted_producers: {},
  gate_overrides: {},
  ...overrides
});

async function passingFixture(producer, authorityTrace) {
  const manifest = await surfaceClaimEvidenceFixture("pass-trust-report.json");
  if (producer !== undefined) manifest.evidence[0].producer = producer;
  if (authorityTrace !== undefined) manifest.evidence[0].authority_trace = authorityTrace;
  return manifest;
}

async function gateState(runId) {
  const definition = await surfaceClaimFixture("flow-definition.json");
  const state = flow.initialState(definition, runId);
  state.current_step = "verify";
  return { definition, state };
}

function claimDiagnostic(outcome) {
  return outcome.diagnostics?.claim_evaluation?.find((entry) => entry.expectation_id === "tests-passed");
}

test("trusted producer pins reject missing and untrusted attribution, but admit the configured producer", async () => {
  const { definition, state } = await gateState("producer-pins");
  const config = configFor({
    trusted_producers: {
      "quality.tests": { producers: ["ci/trusted"] }
    }
  });

  for (const [label, manifest] of [
    ["unattributed", await passingFixture()],
    ["untrusted", await passingFixture("ci/untrusted")]
  ]) {
    const outcome = flow.evaluateGate(definition, structuredClone(state), manifest, "verify-gate", config);
    assert.equal(outcome.status, "route-back", `${label} evidence must not satisfy a pinned claim type`);
    assert.deepEqual(outcome.matched_expectations, []);
    assert.equal(claimDiagnostic(outcome)?.reason, "untrusted_producer");
  }

  const trusted = flow.evaluateGate(definition, structuredClone(state), await passingFixture("ci/trusted"), "verify-gate", config);
  assert.equal(trusted.status, "pass");
  assert.deepEqual(trusted.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: "ev.pass-trust-report" }]);
  assert.equal(trusted.diagnostics, undefined);
});

test("producer policy rejects malformed config and treats explicitly empty lists as deny-all", async () => {
  const { definition, state } = await gateState("producer-config-validation");
  const validManifest = await passingFixture("ci/trusted");
  const malformedConfigs = [
    configFor({ trusted_producers: { "quality.tests": { producers: "ci/trusted" } } }),
    configFor({ trusted_producers: { "quality.tests": { producers: ["ci/trusted", 42] } } }),
    configFor({ trusted_producers: { "quality.tests": { authority_traces: {} } } })
  ];
  for (const config of malformedConfigs) {
    assert.throws(
      () => flow.evaluateGate(definition, structuredClone(state), validManifest, "verify-gate", config),
      /flow config does not satisfy flow-config\.schema\.json/
    );
  }

  for (const mapping of [{ producers: [] }, { authority_traces: [] }, { producers: [], authority_traces: [] }]) {
    const outcome = flow.evaluateGate(definition, structuredClone(state), validManifest, "verify-gate", configFor({
      trusted_producers: { "quality.tests": mapping }
    }));
    assert.equal(outcome.status, "route-back");
    assert.equal(claimDiagnostic(outcome)?.reason, "untrusted_producer", JSON.stringify(mapping));
  }
});

test("loadFlowConfig validates normalized authored config before evaluation", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-invalid-project-config-"));
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify({
    schema_version: flow.FLOW_SCHEMA_VERSION,
    trusted_producers: { "quality.tests": { producers: ["ci/trusted", false] } },
    gate_overrides: {}
  })}\n`);
  await assert.rejects(() => flow.loadFlowConfig(cwd), /flow config does not satisfy flow-config\.schema\.json/);
});

test("expectation-level producer and authority-trace pins apply through the same evaluator", async () => {
  const { definition, state } = await gateState("expectation-pins");
  const config = configFor({
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": {
            trusted_producers: ["ci/expectation"],
            authority_traces: ["authority:quality"]
          }
        }
      }
    }
  });

  const producer = flow.evaluateGate(definition, structuredClone(state), await passingFixture("ci/expectation"), "verify-gate", config);
  assert.equal(producer.status, "pass");

  const trace = flow.evaluateGate(definition, structuredClone(state), await passingFixture(undefined, "authority:quality"), "verify-gate", config);
  assert.equal(trace.status, "pass");

  const rejected = flow.evaluateGate(definition, structuredClone(state), await passingFixture("ci/other"), "verify-gate", config);
  assert.equal(rejected.status, "route-back");
  assert.equal(claimDiagnostic(rejected)?.reason, "untrusted_producer");
});

test("an expectation-level pin cannot broaden a claim-type producer boundary", async () => {
  const { definition, state } = await gateState("pin-precedence");
  const config = configFor({
    trusted_producers: {
      "quality.tests": { producers: ["ci/baseline"] }
    },
    gate_overrides: {
      "verify-gate": {
        expectations: {
          "tests-passed": { trusted_producers: ["ci/specific"] }
        }
      }
    }
  });

  const broadened = flow.evaluateGate(definition, structuredClone(state), await passingFixture("ci/specific"), "verify-gate", config);
  assert.equal(broadened.status, "route-back");
  assert.equal(claimDiagnostic(broadened)?.reason, "untrusted_producer");

  const overlap = configFor({
    trusted_producers: { "quality.tests": { producers: ["ci/overlap"] } },
    gate_overrides: { "verify-gate": { expectations: { "tests-passed": { trusted_producers: ["ci/overlap"] } } } }
  });
  const accepted = flow.evaluateGate(definition, structuredClone(state), await passingFixture("ci/overlap"), "verify-gate", overlap);
  assert.equal(accepted.status, "pass", "a producer explicitly admitted by every configured scope remains valid");
});

test("producer pins do not relabel unrelated attachments as trusted-bundle failures", async () => {
  const { definition, state } = await gateState("mixed-kind");
  const config = configFor({
    trusted_producers: {
      "quality.tests": { producers: ["ci/trusted"] }
    }
  });
  const manifest = {
    schema_version: flow.FLOW_SCHEMA_VERSION,
    evidence: [{
      id: "ev.unrelated", gate_id: "verify-gate", kind: "file", requested_kind: "file",
      status: "passed", attached_at: "2026-08-02T00:00:00.000Z"
    }]
  };

  const outcome = flow.evaluateGate(definition, state, manifest, "verify-gate", config);
  assert.equal(outcome.status, "route-back");
  assert.equal(outcome.diagnostics, undefined, "unrelated evidence remains unrelated, not an untrusted bundle candidate");
});

test("concurrent attachment and evaluation contend for the mutation lock without losing a pinned projection", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-trusted-producer-concurrent-"));
  const definition = {
    id: "concurrent-trusted-producer", version: "1", steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [{
          id: "tests-passed", kind: "trust.bundle", required: true, description: "Trusted tests passed.",
          bundle_claim: {
            claimType: "quality.tests", subjectType: "flow-step", subjectId: "builder.verify", accepted_statuses: ["verified"]
          }
        }]
      }
    }
  };
  const evidence = await surfaceClaimEvidenceFixture("pass-trust-report.json");
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "evidence.json");
  await writeFile(definitionPath, `${JSON.stringify(definition)}\n`);
  await writeFile(evidencePath, `${JSON.stringify(evidence.evidence[0].bundle)}\n`);
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(configFor({
    trusted_producers: { "quality.tests": { producers: ["ci/trusted"] } }
  }))}\n`);
  const waitForQueuedContenders = async (runDir) => {
    const lockRoot = path.join(runDir, ".mutation.lock");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const tickets = (await readdir(lockRoot)).filter((entry) => entry.startsWith("ticket-"));
      // One ticket is the test holder. Seeing two additional tickets proves
      // the canonical attach and evaluate calls have both reached Flow's real
      // mutation queue before either is allowed to continue.
      if (tickets.length >= 3) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("attachEvidence and evaluateRun did not both contend for the run mutation lock");
  };

  const runContended = async (runId, invocationOrder) => {
    const started = await flow.startRun(definitionPath, { cwd, runId });
    let unlockHolder;
    const acquired = new Promise((resolve) => {
      unlockHolder = resolve;
    });
    let holderEntered;
    const holderEnteredPromise = new Promise((resolve) => {
      holderEntered = resolve;
    });
    const holder = flow.withRunMutationLock(runId, cwd, async () => {
      holderEntered();
      await acquired;
    });
    await holderEnteredPromise;

    const attach = () => flow.attachEvidence(runId, {
      cwd, gate: "verify-gate", file: evidencePath, kind: "trust.bundle", bundle: true, producer: "ci/trusted"
    });
    const evaluate = () => flow.evaluateRun(runId, { cwd, gate: "verify-gate" });
    const contenders = invocationOrder === "attach-first" ? [attach(), evaluate()] : [evaluate(), attach()];
    try {
      await waitForQueuedContenders(started.dir);
    } finally {
      unlockHolder();
      await holder;
    }
    const [first, second] = await Promise.allSettled(contenders);
    assert.equal(first.status, "fulfilled", `${invocationOrder} first contender must not fail`);
    assert.equal(second.status, "fulfilled", `${invocationOrder} second contender must not fail`);
    const attachment = invocationOrder === "attach-first" ? first.value : second.value;
    const evaluation = invocationOrder === "attach-first" ? second.value : first.value;
    assert.ok(["pass", "block"].includes(evaluation.outcomes[0].status), "evaluation may observe only a complete pre- or post-attachment snapshot");

    const beforeSettle = await flow.loadRun(runId, cwd);
    assert.equal(beforeSettle.manifest.evidence.length, 1, "the contended attach is recorded exactly once");
    assert.equal(beforeSettle.manifest.evidence[0].id, attachment.id);
    assert.equal(beforeSettle.manifest.evidence[0].producer, "ci/trusted");
    if (beforeSettle.state.status !== "completed") {
      const settled = await flow.evaluateRun(runId, { cwd });
      assert.equal(settled.outcomes.at(-1)?.status, "pass");
    }

    const completed = await flow.loadRun(runId, cwd);
    assert.equal(completed.state.status, "completed");
    const [persistedState, persistedManifest, persistedReport] = await Promise.all([
      readFile(path.join(started.dir, "state.json"), "utf8").then(JSON.parse),
      readFile(path.join(started.dir, "evidence", "manifest.json"), "utf8").then(JSON.parse),
      readFile(path.join(started.dir, "report.json"), "utf8").then(JSON.parse)
    ]);
    assert.deepEqual(persistedManifest.evidence.map((entry) => entry.id), [attachment.id]);
    assert.equal(persistedState.status, completed.state.status);
    assert.equal(persistedReport.state_head, flow.flowRunHead(persistedState));
    assert.equal(persistedReport.status, persistedState.status);
    assert.deepEqual(persistedReport.gate_summaries[0].evidence_refs, [attachment.id]);
  };

  await runContended("concurrent-attach-first", "attach-first");
  await runContended("concurrent-evaluate-first", "evaluate-first");
});

test("attachEvidence preserves plural authority traces for evaluator policy", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-trusted-producer-traces-"));
  const definition = {
    id: "plural-authority-traces", version: "1", steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [{
          id: "tests-passed", kind: "trust.bundle", required: true, description: "Trace-authorized tests passed.",
          bundle_claim: {
            claimType: "quality.tests", subjectType: "flow-step", subjectId: "builder.verify", accepted_statuses: ["verified"]
          }
        }]
      }
    }
  };
  const evidence = await surfaceClaimEvidenceFixture("pass-trust-report.json");
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "evidence.json");
  await writeFile(definitionPath, `${JSON.stringify(definition)}\n`);
  await writeFile(evidencePath, `${JSON.stringify(evidence.evidence[0].bundle)}\n`);
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(configFor({
    trusted_producers: { "quality.tests": { authority_traces: ["authority:trusted"] } }
  }))}\n`);
  await flow.startRun(definitionPath, { cwd, runId: "plural-authority-traces" });

  await flow.attachEvidence("plural-authority-traces", {
    cwd, gate: "verify-gate", file: evidencePath, kind: "trust.bundle", bundle: true,
    authorityTraces: ["authority:unrelated", "authority:trusted"]
  });
  const outcome = await flow.evaluateRun("plural-authority-traces", { cwd });
  assert.equal(outcome.outcomes[0].status, "pass");
  assert.deepEqual((await flow.loadRun("plural-authority-traces", cwd)).manifest.evidence[0].authority_traces, ["authority:unrelated", "authority:trusted"]);
});

test("attachEvidence validates its public options and preserves singular compatibility", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-attachment-options-"));
  const definition = {
    id: "attachment-options", version: "1", steps: [{ id: "verify", next: null }],
    gates: { "verify-gate": { step: "verify", expects: [] } }
  };
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "evidence.txt");
  await writeFile(definitionPath, `${JSON.stringify(definition)}\n`);
  await writeFile(evidencePath, "evidence\n");
  await flow.startRun(definitionPath, { cwd, runId: "attachment-options" });
  assert.throws(
    () => flow.attachEvidence("attachment-options", { cwd, gate: "verify-gate", file: evidencePath, authorityTraces: "authority:not-an-array" }),
    /flow\.attach_evidence\.options\.invalid: authorityTraces must be an array/
  );
  assert.throws(
    () => flow.attachEvidence("attachment-options", { cwd, gate: "verify-gate", file: evidencePath, unsupported: true }),
    /flow\.attach_evidence\.options\.invalid: unsupported option unsupported/
  );
  const attached = await flow.attachEvidence("attachment-options", {
    cwd, gate: "verify-gate", file: evidencePath, authorityTrace: "authority:legacy"
  });
  assert.equal(attached.authority_trace, "authority:legacy");
  assert.equal(attached.authority_traces, undefined);
});

test("CLI repeatable authority traces satisfy independently configured producer scopes", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-cli-authority-traces-"));
  const definition = {
    id: "cli-authority-traces", version: "1", steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [{
          id: "tests-passed", kind: "trust.bundle", required: true, description: "Trace-authorized tests passed.",
          bundle_claim: { claimType: "quality.tests", subjectType: "flow-step", subjectId: "builder.verify", accepted_statuses: ["verified"] }
        }]
      }
    }
  };
  const evidence = await surfaceClaimEvidenceFixture("pass-trust-report.json");
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "evidence.json");
  await writeFile(definitionPath, `${JSON.stringify(definition)}\n`);
  await writeFile(evidencePath, `${JSON.stringify(evidence.evidence[0].bundle)}\n`);
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(configFor({
    trusted_producers: { "quality.tests": { authority_traces: ["authority:one"] } },
    gate_overrides: { "verify-gate": { expectations: { "tests-passed": { authority_traces: ["authority:two"] } } } }
  }))}\n`);
  await flow.startRun(definitionPath, { cwd, runId: "cli-authority-traces" });
  await execFile(process.execPath, [
    cliPath, "attach-evidence", "cli-authority-traces", "--gate", "verify-gate", "--file", evidencePath,
    "--kind", "trust.bundle", "--authority-trace", "authority:one", "--authority-trace", "authority:two", "--cwd", cwd
  ]);
  const entry = (await flow.loadRun("cli-authority-traces", cwd)).manifest.evidence[0];
  assert.equal(entry.authority_trace, "authority:one");
  assert.deepEqual(entry.authority_traces, ["authority:one", "authority:two"]);
  assert.equal((await flow.evaluateRun("cli-authority-traces", { cwd })).outcomes[0].status, "pass");
});
