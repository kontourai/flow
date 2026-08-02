import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { attachEvidence, continuePausedGate, evaluateRun, flowRunHead, loadRun, pauseRun, reDeriveBundleReports, startRun } from "../../dist/index.js";
import { snapshotRunTree } from "./helpers/run-tree.mjs";

const TIME = "2026-07-22T12:00:00.000Z";
const EVALUATION_TIME = "2026-07-22T12:01:00.000Z";
const definition = {
  id: "paused-gate-continuation", version: "1",
  steps: [{ id: "verify", next: "publish" }, { id: "publish", next: null }],
  gates: {
    "verify-gate": {
      step: "verify",
      expects: [{
        id: "review-accepted", kind: "trust.bundle", required: true, description: "A review was accepted.",
        bundle_claim: { claimType: "quality.review", subjectType: "work-item", subjectId: "work-42", accepted_statuses: ["verified"] }
      }],
      on_route_back: { missing_evidence: "verify", default: "verify" }
    }
  }
};

function bundle(subjectId = "work-42", expiresAt, authorityTrace) {
  return {
    schemaVersion: 7, source: "test/paused-gate",
    claims: [{ id: "claim.review", subjectType: "work-item", subjectId, facet: "quality.review", claimType: "quality.review", fieldOrBehavior: "review", value: "accepted", createdAt: "2026-07-22T11:00:00.000Z", updatedAt: "2026-07-22T11:00:00.000Z", ...(expiresAt ? { expiresAt } : {}) }],
    evidence: [], policies: [],
    events: [{ id: "event.review", claimId: "claim.review", status: "verified", actor: "reviewer:test", method: "review", evidenceIds: [], createdAt: "2026-07-22T11:30:00.000Z", verifiedAt: "2026-07-22T11:30:00.000Z" }],
    ...(authorityTrace ? { authorityTrace: [authorityTrace] } : {})
  };
}

function reviewAuthorityTrace(overrides = {}) {
  return {
    id: "trace.review",
    subject: { subjectType: "work-item", subjectId: "work-42" },
    actorRef: "reviewer:test",
    authorityType: "role",
    authorityRef: "authority:review",
    sourceRef: "policy:review",
    observedAt: "2026-07-22T11:30:00.000Z",
    claimIds: ["claim.review"],
    ...overrides
  };
}

function authority(ref) {
  return { kind: "operator_request", actor: "operator:test", request_ref: ref, requested_at: TIME };
}

async function fixture(name, { priorStatus = "active", terminal = false, definitionValue, config } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), `flow-paused-gate-${name}-`));
  const definitionPath = path.join(cwd, "definition.json");
  const fixtureDefinition = structuredClone(definitionValue ?? definition);
  if (terminal) fixtureDefinition.steps[0].next = null;
  await writeFile(definitionPath, `${JSON.stringify(fixtureDefinition, null, 2)}\n`);
  if (config) {
    await mkdir(path.join(cwd, ".flow"), { recursive: true });
    await writeFile(path.join(cwd, ".flow", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  const started = await startRun(definitionPath, { cwd, runId: "paused-run", params: { subject: "work-42" } });
  const statePath = path.join(started.dir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.status = priorStatus;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  await pauseRun(started.runId, { cwd, reason: "Wait for review evidence.", authority: authority(`request:pause:${name}`), at: TIME });
  return { cwd, runId: started.runId, dir: started.dir, run: await loadRun(started.runId, cwd) };
}

function request(fixture, evidence, overrides = {}) {
  return {
    cwd: fixture.cwd, gate: "verify-gate", expectedRunHead: flowRunHead(fixture.run.state),
    evidence: { file: evidence, kind: "trust.bundle" }, resumeOnPass: true,
    resume: { reason: "Continue after accepted review.", authority: authority(`request:resume:${overrides.ref ?? "accepted"}`), at: "2026-07-22T12:01:00.000Z" },
    now: EVALUATION_TIME, ...overrides
  };
}

async function canonicalBytes(fixture) {
  return Promise.all([readFile(path.join(fixture.dir, "state.json")), readFile(path.join(fixture.dir, "evidence", "manifest.json"))]);
}

test("AC1 AC3: resumed continuation preserves applyEvaluation's active status for every resumable pause origin", async () => {
  for (const priorStatus of ["active", "blocked", "needs_decision"]) {
    const fixtureData = await fixture(`resume-${priorStatus}`, { priorStatus });
    const evidence = path.join(fixtureData.cwd, "accepted-review.json");
    await writeFile(evidence, `${JSON.stringify(bundle())}\n`);
    const result = await continuePausedGate(fixtureData.runId, request(fixtureData, evidence, { ref: priorStatus }));
    const persisted = await loadRun(fixtureData.runId, fixtureData.cwd);
    assert.equal(result.committed, true);
    assert.equal(result.outcomes[0].status, "pass");
    assert.equal(persisted.state.status, "active");
    assert.equal(persisted.state.current_step, "publish");
    assert.equal(persisted.state.transitions.at(-1).status, "allowed");
    assert.equal(persisted.state.lifecycle.at(-1).to_status, priorStatus);
  }
});

test("AC2: a stale selected ancestor is returned dry before the current paused gate is continued", async () => {
  const ancestorDefinition = structuredClone(definition);
  ancestorDefinition.steps = [{ id: "plan", next: "verify" }, ...ancestorDefinition.steps];
  ancestorDefinition.gates["plan-gate"] = {
    step: "plan",
    expects: [{ id: "plan-accepted", kind: "trust.bundle", required: true, description: "Plan accepted.", bundle_claim: { claimType: "quality.plan", subjectType: "work-item", subjectId: "plan", accepted_statuses: ["verified"] } }],
    on_route_back: { missing_evidence: "plan", default: "plan" }
  };
  const ancestor = await fixture("ancestor", { definitionValue: ancestorDefinition });
  const state = await loadRun(ancestor.runId, ancestor.cwd);
  state.state.status = "active";
  state.state.lifecycle = [];
  await writeFile(path.join(ancestor.dir, "state.json"), `${JSON.stringify(state.state, null, 2)}\n`);
  const planBundle = bundle("plan", "2099-01-01T00:00:00.000Z");
  planBundle.claims[0].claimType = "quality.plan";
  const planEvidence = path.join(ancestor.cwd, "plan.json");
  const verifyEvidence = path.join(ancestor.cwd, "verify.json");
  await Promise.all([writeFile(planEvidence, `${JSON.stringify(planBundle)}\n`), writeFile(verifyEvidence, `${JSON.stringify(bundle())}\n`)]);
  await attachEvidence(ancestor.runId, { cwd: ancestor.cwd, gate: "plan-gate", file: planEvidence, kind: "trust.bundle" });
  await evaluateRun(ancestor.runId, { cwd: ancestor.cwd });
  await pauseRun(ancestor.runId, { cwd: ancestor.cwd, reason: "Wait at verify.", authority: authority("request:pause:ancestor"), at: TIME });
  ancestor.run = await loadRun(ancestor.runId, ancestor.cwd);
  const before = await snapshotRunTree(ancestor.dir);
  const result = await continuePausedGate(ancestor.runId, request(ancestor, verifyEvidence, { now: "2100-01-01T00:00:00.000Z", ref: "ancestor" }));
  assert.equal(result.committed, false);
  assert.equal(result.outcomes[0].diagnostics.code, "flow.paused_gate_continuation.upstream_stale");
  assert.deepEqual(await snapshotRunTree(ancestor.dir), before);
});

test("AC2: stale selected sibling evidence does not block a paused current-gate continuation", async () => {
  const siblingDefinition = structuredClone(definition);
  siblingDefinition.steps.push({ id: "sibling", next: null });
  siblingDefinition.gates["sibling-gate"] = {
    step: "sibling",
    expects: [{ id: "sibling-accepted", kind: "trust.bundle", required: true, description: "Sibling accepted.", bundle_claim: { claimType: "quality.sibling", subjectType: "work-item", subjectId: "sibling", accepted_statuses: ["verified"] } }]
  };
  const sibling = await fixture("sibling", { definitionValue: siblingDefinition });
  const reset = await loadRun(sibling.runId, sibling.cwd);
  reset.state.status = "active";
  reset.state.lifecycle = [];
  await writeFile(path.join(sibling.dir, "state.json"), `${JSON.stringify(reset.state, null, 2)}\n`);
  const siblingBundle = bundle("sibling", "2099-01-01T00:00:00.000Z");
  siblingBundle.claims[0].claimType = "quality.sibling";
  const siblingEvidence = path.join(sibling.cwd, "sibling.json");
  const verifyEvidence = path.join(sibling.cwd, "verify.json");
  await Promise.all([writeFile(siblingEvidence, `${JSON.stringify(siblingBundle)}\n`), writeFile(verifyEvidence, `${JSON.stringify(bundle())}\n`)]);
  const attached = await attachEvidence(sibling.runId, { cwd: sibling.cwd, gate: "sibling-gate", file: siblingEvidence, kind: "trust.bundle" });
  const prepared = await loadRun(sibling.runId, sibling.cwd);
  reDeriveBundleReports(prepared.manifest, new Date(EVALUATION_TIME));
  prepared.state.gate_outcomes = [{ gate_id: "sibling-gate", status: "pass", summary: "sibling passed", evidence_refs: [attached.id], matched_expectations: [{ expectation_id: "sibling-accepted", evidence_id: attached.id }] }];
  await Promise.all([
    writeFile(path.join(sibling.dir, "state.json"), `${JSON.stringify(prepared.state, null, 2)}\n`),
    writeFile(path.join(sibling.dir, "evidence", "manifest.json"), `${JSON.stringify(prepared.manifest, null, 2)}\n`)
  ]);
  await pauseRun(sibling.runId, { cwd: sibling.cwd, reason: "Wait at verify.", authority: authority("request:pause:sibling"), at: TIME });
  sibling.run = await loadRun(sibling.runId, sibling.cwd);
  const result = await continuePausedGate(sibling.runId, request(sibling, verifyEvidence, { now: "2100-01-01T00:00:00.000Z", ref: "sibling" }));
  assert.equal(result.committed, true);
  assert.equal((await loadRun(sibling.runId, sibling.cwd)).state.current_step, "publish");
});

test("AC2 AC5: stale, wrong-gate, invalid, and wrong-subject non-passes leave state and manifest byte-identical", async () => {
  const fixtureData = await fixture("reject");
  const accepted = path.join(fixtureData.cwd, "accepted-review.json");
  const wrongSubject = path.join(fixtureData.cwd, "wrong-subject-review.json");
  const invalid = path.join(fixtureData.cwd, "invalid-review.json");
  await Promise.all([writeFile(accepted, `${JSON.stringify(bundle())}\n`), writeFile(wrongSubject, `${JSON.stringify(bundle("other-work"))}\n`), writeFile(invalid, "not a bundle\n")]);
  const before = await canonicalBytes(fixtureData);
  await assert.rejects(continuePausedGate(fixtureData.runId, { ...request(fixtureData, accepted), expectedRunHead: "0".repeat(64) }), /flow\.run_head\.stale/);
  await assert.rejects(continuePausedGate(fixtureData.runId, { ...request(fixtureData, accepted), gate: "not-current-gate" }), /paused_gate_continuation\.gate\.invalid/);
  await assert.rejects(continuePausedGate(fixtureData.runId, request(fixtureData, invalid)), /trust bundle JSON parsing failed/);
  const nonPassing = await continuePausedGate(fixtureData.runId, request(fixtureData, wrongSubject, { ref: "wrong-subject" }));
  assert.equal(nonPassing.committed, false);
  assert.equal(nonPassing.evidence, undefined);
  assert.equal(nonPassing.outcomes[0].status, "route-back");
  assert.deepEqual(await canonicalBytes(fixtureData), before);
});

test("AC4: terminal gates retain completed state on resume and an omitted resume request is dry", async () => {
  const terminal = await fixture("terminal", { priorStatus: "blocked", terminal: true });
  const terminalEvidence = path.join(terminal.cwd, "accepted-review.json");
  await writeFile(terminalEvidence, `${JSON.stringify(bundle())}\n`);
  await continuePausedGate(terminal.runId, request(terminal, terminalEvidence));
  const terminalPersisted = await loadRun(terminal.runId, terminal.cwd);
  assert.equal(terminalPersisted.state.status, "completed");
  assert.equal(terminalPersisted.state.lifecycle.at(-1).to_status, "blocked");

  for (const priorStatus of ["active", "blocked", "needs_decision"]) {
    const fixtureData = await fixture(`hold-${priorStatus}`, { priorStatus });
    const evidence = path.join(fixtureData.cwd, "accepted-review.json");
    await writeFile(evidence, `${JSON.stringify(bundle())}\n`);
    const result = await continuePausedGate(fixtureData.runId, request(fixtureData, evidence, { resumeOnPass: false, resume: undefined }));
    const persisted = await loadRun(fixtureData.runId, fixtureData.cwd);
    assert.equal(result.committed, false);
    assert.equal(persisted.state.status, "paused");
    assert.equal(persisted.state.current_step, "verify");
    assert.equal(persisted.manifest.evidence.length, 0);
  }
});

test("AC1: omitted now and resume.at share one operation timestamp", async () => {
  const fixtureData = await fixture("default-timestamp");
  const evidence = path.join(fixtureData.cwd, "accepted-review.json");
  await writeFile(evidence, `${JSON.stringify(bundle())}\n`);
  const result = await continuePausedGate(fixtureData.runId, request(fixtureData, evidence, {
    now: undefined,
    resume: { reason: "Continue after accepted review.", authority: authority("request:resume:default-timestamp") }
  }));
  assert.equal(result.committed, true);
});

test("paused gate continuation snapshots evidence before waiting for the mutation lock", async () => {
  const fixtureData = await fixture("option-snapshot");
  const evidencePath = path.join(fixtureData.cwd, "accepted-review.json");
  await writeFile(evidencePath, `${JSON.stringify(bundle())}\n`);
  const continuation = request(fixtureData, evidencePath, {
    evidence: {
      file: evidencePath,
      kind: "trust.bundle",
      classifier: { kind: "original", nested: { value: "original" } },
      diagnostics: { code: "original", nested: { value: "original" } },
      analytics: { loop_key: "original", nested: { value: "original" } }
    }
  });
  const pending = continuePausedGate(fixtureData.runId, continuation);
  continuation.gate = "mutated-gate";
  continuation.evidence.file = path.join(fixtureData.cwd, "missing-after-invocation.json");
  continuation.evidence.classifier.nested.value = "mutated";
  continuation.evidence.diagnostics.nested.value = "mutated";
  continuation.evidence.analytics.nested.value = "mutated";

  const result = await pending;
  assert.equal(result.committed, true);
  assert.equal(result.evidence.gate_id, "verify-gate");
  assert.equal(result.evidence.original_path, evidencePath);
  assert.deepEqual(result.evidence.classifier, { kind: "original", nested: { value: "original" } });
  assert.deepEqual(result.evidence.diagnostics, { code: "original", nested: { value: "original" } });
  assert.deepEqual(result.evidence.analytics, { loop_key: "original", nested: { value: "original" } });
});

test("paused continuation enforces the same active scoped authority trace as canonical and pure evaluation", async () => {
  const config = {
    schema_version: "0.1",
    trusted_producers: { "quality.review": { authority_refs: ["authority:review"] } },
    gate_overrides: {}
  };
  const fixtureData = await fixture("rich-authority", { config });
  const evidencePath = path.join(fixtureData.cwd, "accepted-review.json");
  await writeFile(evidencePath, `${JSON.stringify(bundle("work-42", undefined, reviewAuthorityTrace()))}\n`);
  const passed = await continuePausedGate(fixtureData.runId, request(fixtureData, evidencePath, { ref: "rich-authority" }));
  assert.equal(passed.committed, true);

  const rejectedFixture = await fixture("rich-authority-opaque", { config });
  const opaquePath = path.join(rejectedFixture.cwd, "accepted-review.json");
  await writeFile(opaquePath, `${JSON.stringify(bundle())}\n`);
  const rejected = await continuePausedGate(rejectedFixture.runId, request(rejectedFixture, opaquePath, {
    ref: "rich-authority-opaque",
    evidence: { file: opaquePath, kind: "trust.bundle" }
  }));
  assert.equal(rejected.committed, false);
  assert.equal(rejected.outcomes[0].status, "route-back");
  assert.deepEqual(rejected.outcomes[0].diagnostics.claim_evaluation[0].authority, { code: "no_trace" });
});

test("paused continuation retains fractional evaluation instants for authority, transition validation, and persistence", async () => {
  const config = {
    schema_version: "0.1",
    trusted_producers: { "quality.review": { authority_refs: ["authority:review"] } },
    gate_overrides: {}
  };
  const evaluatedAt = "2026-07-22T12:01:00.0001Z";

  const acceptedFixture = await fixture("fractional-authority-accepted", { config });
  const acceptedEvidence = path.join(acceptedFixture.cwd, "accepted-review.json");
  await writeFile(acceptedEvidence, `${JSON.stringify(bundle("work-42", undefined, reviewAuthorityTrace({ validUntil: "2026-07-22T12:01:00.0002Z" })))}\n`);
  const accepted = await continuePausedGate(acceptedFixture.runId, request(acceptedFixture, acceptedEvidence, { now: evaluatedAt, ref: "fractional-authority-accepted" }));
  assert.equal(accepted.committed, true);
  const acceptedPersisted = await loadRun(acceptedFixture.runId, acceptedFixture.cwd);
  assert.equal(acceptedPersisted.state.transitions.at(-1).at, evaluatedAt);
  assert.equal(acceptedPersisted.state.updated_at, evaluatedAt);
  assert.equal(acceptedPersisted.manifest.evidence.at(-1).attached_at, evaluatedAt);

  const expiredFixture = await fixture("fractional-authority-expired", { config });
  const expiredEvidence = path.join(expiredFixture.cwd, "expired-review.json");
  await writeFile(expiredEvidence, `${JSON.stringify(bundle("work-42", undefined, reviewAuthorityTrace({ validUntil: "2026-07-22T12:01:00.00005Z" })))}\n`);
  const expired = await continuePausedGate(expiredFixture.runId, request(expiredFixture, expiredEvidence, { now: evaluatedAt, ref: "fractional-authority-expired" }));
  assert.equal(expired.committed, false);
  assert.equal(expired.outcomes[0].status, "route-back", "an authority expired 50 microseconds before evaluation must not pass through Date truncation");
  assert.deepEqual(expired.outcomes[0].diagnostics.claim_evaluation[0].authority, { code: "expired" });
});

test("paused continuation rejects Date-parseable non-RFC3339 now without mutation", async () => {
  const fixtureData = await fixture("non-strict-now");
  const evidencePath = path.join(fixtureData.cwd, "accepted-review.json");
  await writeFile(evidencePath, `${JSON.stringify(bundle())}\n`);
  const before = await snapshotRunTree(fixtureData.dir);
  await assert.rejects(
    continuePausedGate(fixtureData.runId, request(fixtureData, evidencePath, { now: "2026-07-22 12:01:00Z", ref: "non-strict-now" })),
    /now must be an RFC3339 date-time/
  );
  assert.deepEqual(await snapshotRunTree(fixtureData.dir), before);
});

test("paused continuation compares resume ordering at full RFC3339 precision", async () => {
  const fixtureData = await fixture("fractional-resume-order");
  const evidencePath = path.join(fixtureData.cwd, "accepted-review.json");
  await writeFile(evidencePath, `${JSON.stringify(bundle())}\n`);
  const before = await snapshotRunTree(fixtureData.dir);
  await assert.rejects(
    continuePausedGate(fixtureData.runId, request(fixtureData, evidencePath, {
      now: "2026-07-22T12:01:00.0001Z",
      resume: {
        reason: "too late by 50 microseconds",
        authority: authority("request:fractional-resume-order"),
        at: "2026-07-22T12:01:00.00015Z"
      }
    })),
    /resume\.at must not follow evaluation now/
  );
  assert.deepEqual(await snapshotRunTree(fixtureData.dir), before);
});

test("AC2: prospective freshness and validation before staging leave the full run tree untouched", async () => {
  const freshness = await fixture("freshness");
  const oldBundle = path.join(freshness.cwd, "old-review.json");
  const marker = path.join(freshness.cwd, "marker.txt");
  await writeFile(oldBundle, `${JSON.stringify(bundle("work-42", "2099-01-01T00:00:00.000Z"))}\n`);
  await writeFile(marker, "new non-bundle evidence\n");
  // Attach before pause so its initial report is fresh; the continuation must
  // re-derive it at 2100 before deciding whether the new file can advance.
  const active = await loadRun(freshness.runId, freshness.cwd);
  active.state.status = "active";
  active.state.lifecycle = [];
  await writeFile(path.join(freshness.dir, "state.json"), `${JSON.stringify(active.state, null, 2)}\n`);
  await attachEvidence(freshness.runId, { cwd: freshness.cwd, gate: "verify-gate", file: oldBundle, kind: "trust.bundle" });
  await pauseRun(freshness.runId, { cwd: freshness.cwd, reason: "Wait again.", authority: authority("request:pause:freshness-again"), at: TIME });
  freshness.run = await loadRun(freshness.runId, freshness.cwd);
  const stale = await continuePausedGate(freshness.runId, request(freshness, marker, { evidence: { file: marker, kind: "file" }, now: "2100-01-01T00:00:00.000Z", ref: "expired" }));
  assert.equal(stale.committed, false);

  const validation = await fixture("validation");
  const validationEvidence = path.join(validation.cwd, "accepted-review.json");
  await writeFile(validationEvidence, `${JSON.stringify(bundle())}\n`);
  const beforeValidation = await snapshotRunTree(validation.dir);
  await assert.rejects(
    continuePausedGate(validation.runId, request(validation, validationEvidence, {
      resume: { reason: "invalid order", authority: authority("request:invalid-order"), at: "2026-07-22T11:00:00.000Z" }
    })),
    /precedes the prior event/
  );
  assert.deepEqual(await snapshotRunTree(validation.dir), beforeValidation);

});
