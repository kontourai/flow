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

async function passingFixture(producer) {
  const manifest = await surfaceClaimEvidenceFixture("pass-trust-report.json");
  if (producer !== undefined) {
    manifest.evidence[0].producer = producer;
    manifest.evidence[0].bundle.producerId = producer;
  }
  return manifest;
}

function authorityTrace(overrides = {}) {
  return {
    id: "trace.quality",
    subject: { subjectType: "flow-step", subjectId: "builder.verify" },
    actorRef: "ci/main",
    authorityType: "system",
    authorityRef: "authority:quality",
    sourceRef: "policy:quality",
    observedAt: "2026-06-15T00:00:00.000Z",
    claimIds: ["claim.quality.tests.verify"],
    ...overrides
  };
}

async function authorityFixture(trace = authorityTrace()) {
  const manifest = await passingFixture();
  manifest.evidence[0].bundle.authorityTrace = [trace];
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

  const mismatchedAssertion = await passingFixture("ci/trusted");
  mismatchedAssertion.evidence[0].producer = "ci/untrusted";
  const mismatch = flow.evaluateGate(definition, structuredClone(state), mismatchedAssertion, "verify-gate", config);
  assert.equal(mismatch.status, "route-back");
  assert.deepEqual(claimDiagnostic(mismatch)?.authority, { code: "producer_mismatch" });
});

test("producer policy rejects malformed config and treats explicitly empty lists as deny-all", async () => {
  const { definition, state } = await gateState("producer-config-validation");
  const validManifest = await passingFixture("ci/trusted");
  const malformedConfigs = [
    configFor({ trusted_producers: { "quality.tests": { producers: "ci/trusted" } } }),
    configFor({ trusted_producers: { "quality.tests": { producers: ["ci/trusted", 42] } } }),
    configFor({ trusted_producers: { "quality.tests": { authority_refs: {} } } }),
    configFor({ trusted_producers: { "quality.tests": { authority_traces: ["legacy"] } } })
  ];
  for (const [index, config] of malformedConfigs.entries()) {
    assert.throws(
      () => flow.evaluateGate(definition, structuredClone(state), validManifest, "verify-gate", config),
      index === malformedConfigs.length - 1
        ? /authority_traces is removed; migrate its authority references to authority_refs/
        : /flow config does not satisfy flow-config\.schema\.json/
    );
  }

  for (const mapping of [{ producers: [] }, { authority_refs: [] }, { producers: [], authority_refs: [] }]) {
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

test("active, scoped embedded AuthorityTrace is the only authority path", async () => {
  const { definition, state } = await gateState("expectation-pins");
  const config = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  const now = new Date("2026-06-16T00:00:00.000Z");
  const active = flow.evaluateGate(definition, structuredClone(state), await authorityFixture(), "verify-gate", config, now);
  assert.equal(active.status, "pass");

  const opaque = await passingFixture();
  opaque.evidence[0].authority_trace = "authority:quality";
  opaque.evidence[0].authority_traces = ["authority:quality"];
  const rejectedOpaque = flow.evaluateGate(definition, structuredClone(state), opaque, "verify-gate", config, now);
  assert.equal(rejectedOpaque.status, "route-back", "the opaque metadata shortcut passed at 0bee but has zero trust weight now");
  assert.deepEqual(claimDiagnostic(rejectedOpaque)?.authority, { code: "no_trace" });

  for (const [label, trace, expected] of [
    ["future", authorityTrace({ validFrom: "2026-06-17T00:00:00.000Z" }), "not_yet_valid"],
    ["future-offset", authorityTrace({ validFrom: "2026-06-15T20:00:00-05:00" }), "not_yet_valid"],
    ["expired", authorityTrace({ validUntil: "2026-06-15T00:00:00.000Z" }), "expired"],
    ["revoked", authorityTrace({ revokedAt: "2026-06-15T00:00:00.000Z" }), "revoked"],
    ["wrong-ref", authorityTrace({ authorityRef: "authority:other" }), "authority_ref_mismatch"],
    ["wrong-actor", authorityTrace({ actorRef: "ci/other" }), "actor_mismatch"],
    ["wrong-subject", authorityTrace({ subject: { subjectType: "work-item", subjectId: "other" } }), "subject_mismatch"],
    ["unlinked", authorityTrace({ claimIds: undefined }), "scope_mismatch"]
  ]) {
    const outcome = flow.evaluateGate(definition, structuredClone(state), await authorityFixture(trace), "verify-gate", config, now);
    assert.equal(outcome.status, "route-back", label);
    assert.deepEqual(claimDiagnostic(outcome)?.authority, { code: expected }, label);
  }

  const wrongIdConfig = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["trace.quality"] } } });
  const wrongId = flow.evaluateGate(definition, structuredClone(state), await authorityFixture(), "verify-gate", wrongIdConfig, now);
  assert.deepEqual(claimDiagnostic(wrongId)?.authority, { code: "authority_ref_mismatch" });

  const activeSibling = await authorityFixture();
  activeSibling.evidence[0].bundle.authorityTrace = [
    authorityTrace({ id: "trace.expired", validUntil: "2026-06-15T00:00:00.000Z" }),
    authorityTrace({ id: "trace.active" })
  ];
  assert.equal(
    flow.evaluateGate(definition, structuredClone(state), activeSibling, "verify-gate", config, now).status,
    "pass",
    "an inactive qualifying trace must not mask a later active qualifying trace"
  );

  const mismatchedEventAuthority = await authorityFixture(authorityTrace({ claimIds: undefined, evidenceIds: ["evidence.quality.tests.output"] }));
  mismatchedEventAuthority.evidence[0].bundle.events[0].authorityRef = "authority:other";
  mismatchedEventAuthority.evidence[0].bundle.events[0].actor = "ci/other";
  const mismatchedEventOutcome = flow.evaluateGate(definition, structuredClone(state), mismatchedEventAuthority, "verify-gate", config, now);
  assert.equal(mismatchedEventOutcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(mismatchedEventOutcome)?.authority, { code: "scope_mismatch" });

  const forgedCache = await authorityFixture();
  forgedCache.evidence[0].bundle.events[0].status = "disputed";
  const forgedCacheOutcome = flow.evaluateGate(definition, structuredClone(state), forgedCache, "verify-gate", config, now);
  assert.equal(forgedCacheOutcome.status, "route-back", "cached bundle_report display data must never authorize a gate");
  assert.equal(claimDiagnostic(forgedCacheOutcome)?.reason, "disputed");

  const nextStep = definition.steps.find((step) => step.id === "verify").next;
  const transition = flow.validateRunTransition({
    definition,
    current_state: structuredClone(state),
    proposed_transition: { from_step: "verify", to_step: nextStep, status: "allowed", at: now.toISOString() },
    manifest: await authorityFixture(),
    config,
    now: now.toISOString()
  });
  assert.equal(transition.valid, true, JSON.stringify(transition.diagnostics));

  const projectionState = structuredClone(state);
  projectionState.updated_at = now.toISOString();
  const projection = flow.projectFlowRun({
    definition,
    state: projectionState,
    manifest: await authorityFixture(),
    config
  });
  assert.equal(projection.gates.find((gate) => gate.id === "verify-gate").status, "pass", "Console projection must use the canonical state instant for the same authority decision");

  const intersection = configFor({
    trusted_producers: { "quality.tests": { authority_refs: ["authority:one"] } },
    gate_overrides: { "verify-gate": { expectations: { "tests-passed": { authority_refs: ["authority:two"] } } } }
  });
  const widened = await authorityFixture();
  widened.evidence[0].bundle.authorityTrace = [authorityTrace({ authorityRef: "authority:one" }), authorityTrace({ id: "trace.two", authorityRef: "authority:two" })];
  const widenedOutcome = flow.evaluateGate(definition, structuredClone(state), widened, "verify-gate", intersection, now);
  assert.equal(widenedOutcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(widenedOutcome)?.authority, { code: "authority_ref_mismatch" });
});

test("canonical filesystem evaluation uses the same rich authority path and pinned instant", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-trusted-producer-canonical-"));
  const definition = await surfaceClaimFixture("flow-definition.json");
  const manifest = await authorityFixture();
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "quality-bundle.json");
  await mkdir(path.join(cwd, ".flow"), { recursive: true });
  await Promise.all([
    writeFile(definitionPath, `${JSON.stringify(definition)}\n`),
    writeFile(evidencePath, `${JSON.stringify(manifest.evidence[0].bundle)}\n`),
    writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(configFor({
      trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } }
    }))}\n`)
  ]);
  const started = await flow.startRun(definitionPath, { cwd, runId: "canonical-rich-authority" });
  await flow.attachEvidence(started.runId, { cwd, gate: "verify-gate", file: evidencePath, kind: "trust.bundle", bundle: true });
  const evaluated = await flow.evaluateRun(started.runId, { cwd, gate: "verify-gate", now: "2026-06-16T00:00:00.000Z" });
  assert.equal(evaluated.outcomes.at(-1)?.status, "pass");
  assert.equal((await flow.loadRun(started.runId, cwd)).state.gate_outcomes.at(-1)?.status, "pass");
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
  evidence.evidence[0].bundle.producerId = "ci/trusted";
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

test("attachEvidence rejects opaque authority metadata instead of preserving a trust shortcut", async () => {
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
  await flow.startRun(definitionPath, { cwd, runId: "plural-authority-traces" });

  assert.throws(() => flow.attachEvidence("plural-authority-traces", {
    cwd, gate: "verify-gate", file: evidencePath, kind: "trust.bundle", bundle: true,
    authorityTraces: ["authority:unrelated", "authority:trusted"]
  }), /unsupported option authorityTraces/);
});

test("attachEvidence rejects removed opaque authority options", async () => {
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
    /flow\.attach_evidence\.options\.invalid: unsupported option authorityTraces/
  );
  assert.throws(
    () => flow.attachEvidence("attachment-options", { cwd, gate: "verify-gate", file: evidencePath, unsupported: true }),
    /flow\.attach_evidence\.options\.invalid: unsupported option unsupported/
  );
  assert.throws(
    () => flow.attachEvidence("attachment-options", { cwd, gate: "verify-gate", file: evidencePath, authorityTrace: "authority:legacy" }),
    /flow\.attach_evidence\.options\.invalid: unsupported option authorityTrace/
  );
});

test("attachEvidence snapshots caller options before asynchronous preflight and persistence", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-attachment-option-snapshot-"));
  const definition = {
    id: "attachment-option-snapshot", version: "1", steps: [{ id: "verify", next: null }],
    gates: { "verify-gate": { step: "verify", expects: [] } }
  };
  const definitionPath = path.join(cwd, "definition.json");
  const evidencePath = path.join(cwd, "evidence.txt");
  await Promise.all([
    writeFile(definitionPath, `${JSON.stringify(definition)}\n`),
    writeFile(evidencePath, "initial evidence\n")
  ]);
  await flow.startRun(definitionPath, { cwd, runId: "attachment-option-snapshot" });
  const options = {
    cwd,
    gate: "verify-gate",
    file: evidencePath,
    classifier: { kind: "original", nested: { value: "original" } },
    diagnostics: { code: "original", nested: { value: "original" } },
    analytics: { loop_key: "original", nested: { value: "original" } }
  };
  const pending = flow.attachEvidence("attachment-option-snapshot", options);
  options.gate = "mutated-gate";
  options.file = path.join(cwd, "missing-after-invocation.txt");
  options.classifier.nested.value = "mutated";
  options.diagnostics.nested.value = "mutated";
  options.analytics.nested.value = "mutated";

  const attached = await pending;
  assert.equal(attached.gate_id, "verify-gate");
  assert.equal(attached.original_path, evidencePath);
  assert.deepEqual(attached.classifier, { kind: "original", nested: { value: "original" } });
  assert.deepEqual(attached.diagnostics, { code: "original", nested: { value: "original" } });
  assert.deepEqual(attached.analytics, { loop_key: "original", nested: { value: "original" } });

  assert.throws(
    () => flow.attachEvidence("attachment-option-snapshot", {
      cwd, gate: "verify-gate", file: evidencePath, diagnostics: { notCloneable: () => {} }
    }),
    /flow\.attach_evidence\.options\.invalid: options must be structured-cloneable/
  );
});

test("CLI rejects removed opaque authority-trace input", async () => {
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
  await flow.startRun(definitionPath, { cwd, runId: "cli-authority-traces" });
  await assert.rejects(
    () => execFile(process.execPath, [
      cliPath, "attach-evidence", "cli-authority-traces", "--gate", "verify-gate", "--file", evidencePath,
      "--kind", "trust.bundle", "--authority-trace", "authority:one", "--cwd", cwd
    ]),
    /--authority-trace is removed/
  );
});
