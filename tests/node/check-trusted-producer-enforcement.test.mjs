import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import * as flow from "../../dist/index.js";
import { evaluateGateWithReducerDependencies } from "../../dist/gates/flow-gates.js";
import { readGateEvaluation } from "../../dist/runtime/gate-evaluation-reader.js";
import { surfaceDerivationWithinBudget } from "../../dist/gates/surface-derivation-budget.js";
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
  assert.deepEqual(trusted.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: "ev.pass-trust-report", claim_ids: ["claim.quality.tests.verify"], authority_witness: null }]);
  assert.equal(trusted.diagnostics, undefined);

  const mismatchedAssertion = await passingFixture("ci/trusted");
  mismatchedAssertion.evidence[0].producer = "ci/untrusted";
  const mismatch = flow.evaluateGate(definition, structuredClone(state), mismatchedAssertion, "verify-gate", config);
  assert.equal(mismatch.status, "route-back");
  assert.deepEqual(claimDiagnostic(mismatch)?.authority, { code: "producer_mismatch" });
});

test("a trust.bundle receipt records only the authority decision witness", async () => {
  const { definition, state } = await gateState("authority-witness-only");
  const config = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  const manifest = await authorityFixture();
  const bundle = manifest.evidence[0].bundle;
  // A bundle-level producer id is deliberately not pinned here. The second
  // otherwise-valid claim is producer-authored/untrusted for this selector;
  // only the original has an active, scoped quality authority trace.
  bundle.producerId = "ci/untrusted";
  bundle.claims.push({ ...bundle.claims[0], id: "claim.quality.tests.untrusted" });
  bundle.evidence.push({ ...bundle.evidence[0], id: "evidence.quality.tests.untrusted", claimId: "claim.quality.tests.untrusted", collectedBy: "ci/untrusted" });
  bundle.events.push({ ...bundle.events[0], id: "event.quality.tests.untrusted", claimId: "claim.quality.tests.untrusted", evidenceIds: ["evidence.quality.tests.untrusted"], actor: "ci/untrusted" });

  const outcome = flow.evaluateGate(definition, structuredClone(state), manifest, "verify-gate", config, "2026-06-16T00:00:00.000Z");
  assert.equal(outcome.status, "pass");
  assert.deepEqual(outcome.matched_expectations, [{
    expectation_id: "tests-passed",
    evidence_id: "ev.pass-trust-report",
    claim_ids: ["claim.quality.tests.verify"],
    authority_witness: { claimId: "claim.quality.tests.verify", traceId: "trace.quality", governingEventId: "event.quality.tests.verified" }
  }]);
});

test("a future authority candidate before a valid one cannot widen the witness", async () => {
  const { definition, state } = await gateState("authority-witness-future-first");
  const config = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  const manifest = await authorityFixture(authorityTrace({
    id: "trace.future",
    claimIds: ["claim.quality.tests.future"],
    validFrom: "2026-06-17T00:00:00.000Z"
  }));
  const bundle = manifest.evidence[0].bundle;
  bundle.producerId = "ci/untrusted";
  bundle.claims[0].id = "claim.quality.tests.future";
  bundle.evidence[0].claimId = "claim.quality.tests.future";
  bundle.events[0].claimId = "claim.quality.tests.future";
  bundle.claims.push({ ...bundle.claims[0], id: "claim.quality.tests.valid" });
  bundle.evidence.push({ ...bundle.evidence[0], id: "evidence.quality.tests.valid", claimId: "claim.quality.tests.valid" });
  bundle.events.push({ ...bundle.events[0], id: "event.quality.tests.valid", claimId: "claim.quality.tests.valid", evidenceIds: ["evidence.quality.tests.valid"] });
  bundle.authorityTrace.push(authorityTrace({ id: "trace.valid", claimIds: ["claim.quality.tests.valid"] }));

  const outcome = flow.evaluateGate(definition, structuredClone(state), manifest, "verify-gate", config, "2026-06-16T00:00:00.000Z");
  assert.equal(outcome.status, "pass");
  assert.deepEqual(outcome.matched_expectations, [{
    expectation_id: "tests-passed",
    evidence_id: "ev.pass-trust-report",
    claim_ids: ["claim.quality.tests.valid"],
    authority_witness: { claimId: "claim.quality.tests.valid", traceId: "trace.valid", governingEventId: "event.quality.tests.valid" }
  }]);
});

test("Surface-accepted claim freshness and event chronology retain exact RFC3339 precision", async () => {
  const { definition, state } = await gateState("exact-claim-freshness");
  const evaluate = (manifest, now) => flow.evaluateGate(
    definition,
    structuredClone(state),
    manifest,
    "verify-gate",
    configFor(),
    now
  );
  const now = "2026-06-16T00:00:00.0001Z";

  const expired = await passingFixture();
  expired.evidence[0].bundle.claims[0].expiresAt = "2026-06-16T00:00:00.00005Z";
  const expiredOutcome = evaluate(expired, now);
  assert.equal(expiredOutcome.status, "route-back", "a claim expired 50 microseconds ago must not pass through Date truncation");
  assert.equal(claimDiagnostic(expiredOutcome)?.reason, "stale");

  const staleAcceptedDefinition = structuredClone(definition);
  staleAcceptedDefinition.gates["verify-gate"].expects[0].bundle_claim.accepted_statuses = ["stale"];
  const staleAccepted = await passingFixture();
  staleAccepted.evidence[0].bundle.claims[0].expiresAt = "2026-06-16T00:00:00.00005Z";
  assert.equal(
    flow.evaluateGate(staleAcceptedDefinition, structuredClone(state), staleAccepted, "verify-gate", configFor(), "2026-06-16T00:00:00.0011Z").status,
    "pass",
    "an expectation that explicitly accepts stale must retain the Surface-stale claim at a fractional expiry boundary"
  );

  for (const [label, expiresAt] of [
    ["at the exact expiry boundary", "2026-06-16T00:00:00.0001Z"],
    ["after the evaluation instant", "2026-06-16T00:00:00.00015Z"],
    ["at the same instant through an RFC3339 offset", "2026-06-15T18:00:00.0001-06:00"]
  ]) {
    const manifest = await passingFixture();
    manifest.evidence[0].bundle.claims[0].expiresAt = expiresAt;
    assert.equal(evaluate(manifest, now).status, "pass", label);
  }

  const ordinaryVerification = await passingFixture();
  delete ordinaryVerification.evidence[0].bundle.events[0].verifiedAt;
  assert.equal(evaluate(ordinaryVerification, now).status, "pass", "an ordinary event may omit optional verifiedAt");

  const sameMillisecondConflict = await passingFixture();
  sameMillisecondConflict.evidence[0].bundle.events[0].createdAt = "2026-06-16T00:00:00.00001Z";
  sameMillisecondConflict.evidence[0].bundle.events[0].verifiedAt = "2026-06-16T00:00:00.00001Z";
  sameMillisecondConflict.evidence[0].bundle.events.push({
    id: "event.quality.tests.rejected",
    claimId: "claim.quality.tests.verify",
    status: "rejected",
    actor: "ci/main",
    method: "validation",
    evidenceIds: ["evidence.quality.tests.output"],
    createdAt: "2026-06-16T00:00:00.00009Z"
  });
  const ambiguousOutcome = evaluate(sameMillisecondConflict, now);
  assert.equal(ambiguousOutcome.status, "route-back", "lossy same-millisecond event ordering must not choose an authorization result");
  assert.equal(claimDiagnostic(ambiguousOutcome)?.reason, "claim_time_ambiguous");

  const assumedWithExpiry = await passingFixture();
  assumedWithExpiry.evidence[0].bundle.claims[0].expiresAt = "2026-06-15T00:00:00.00005Z";
  assumedWithExpiry.evidence[0].bundle.events[0].status = "assumed";
  delete assumedWithExpiry.evidence[0].bundle.events[0].verifiedAt;
  const assumedDefinition = structuredClone(definition);
  assumedDefinition.gates["verify-gate"].expects[0].bundle_claim.accepted_statuses = ["assumed"];
  assert.equal(
    flow.evaluateGate(assumedDefinition, structuredClone(state), assumedWithExpiry, "verify-gate", configFor(), now).status,
    "pass",
    "an accepted assumed claim retains Surface's expiry-bypassing status"
  );

  const resolutionWithExpiry = await passingFixture();
  resolutionWithExpiry.evidence[0].bundle.claims[0].expiresAt = "2026-06-15T00:00:00.00005Z";
  resolutionWithExpiry.evidence[0].bundle.authorityTrace = [authorityTrace()];
  resolutionWithExpiry.evidence[0].bundle.events.push({
    id: "event.quality.tests.resolved",
    claimId: "claim.quality.tests.verify",
    status: "verified",
    actor: "ci/main",
    method: "review",
    evidenceIds: ["evidence.quality.tests.output"],
    createdAt: "2026-06-15T00:00:00.001Z",
    resolvesDispute: true
  });
  assert.equal(
    evaluate(resolutionWithExpiry, now).status,
    "pass",
    "an authority-gated resolution retains Surface's expiry-bypassing status"
  );

  const malformedExpiry = await passingFixture();
  malformedExpiry.evidence[0].bundle.claims[0].expiresAt = "2016-12-31T23:59:60Z";
  const malformedOutcome = evaluate(malformedExpiry, now);
  assert.equal(malformedOutcome.status, "route-back");
  assert.equal(claimDiagnostic(malformedOutcome)?.reason, "bundle_invalid");
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

  for (const mapping of [
    { producers: [] },
    { authority_refs: [] },
    { producers: [], authority_refs: [] },
    { producers: [], authority_refs: ["authority:quality"] },
    { producers: ["ci/trusted"], authority_refs: [] }
  ]) {
    const outcome = flow.evaluateGate(definition, structuredClone(state), validManifest, "verify-gate", configFor({
      trusted_producers: { "quality.tests": mapping }
    }));
    assert.equal(outcome.status, "route-back");
    assert.equal(claimDiagnostic(outcome)?.reason, "untrusted_producer", JSON.stringify(mapping));
    assert.deepEqual(claimDiagnostic(outcome)?.authority, { code: "deny_all" }, JSON.stringify(mapping));
  }
});

test("validated derivation budgets reject before Surface buildReport", async () => {
  const { definition, state } = await gateState("derivation-budget");
  const manifest = await passingFixture();
  const bundle = manifest.evidence[0].bundle;
  bundle.events[0].resolvesDispute = true;
  bundle.events.push(...Array.from({ length: 64 }, (_, index) => ({
    ...structuredClone(bundle.events[0]),
    id: `event.budget.${index}`
  })));
  bundle.authorityTrace = Array.from({ length: 65 }, (_, index) => authorityTrace({ id: `trace.budget.${index}` }));
  let builds = 0;
  const outcome = evaluateGateWithReducerDependencies(
    definition,
    structuredClone(state),
    manifest,
    "verify-gate",
    configFor(),
    "2026-06-16T00:00:00.000Z",
    {
      validate: (value) => value,
      buildReport: () => {
        builds += 1;
        throw new Error("must not run after the validated derivation preflight");
      },
      checkAuthorityActive: () => "active"
    }
  );
  assert.equal(builds, 0, "the resolution-event × trace ceiling is checked before Surface's report fold");
  assert.equal(outcome.status, "route-back");
  assert.equal(claimDiagnostic(outcome)?.reason, "bundle_invalid");
});

test("resolution budget boundary allows one complete Surface and exact pass", async () => {
  const { definition, state } = await gateState("resolution-budget-boundary");
  const manifest = await passingFixture();
  const bundle = manifest.evidence[0].bundle;
  bundle.events[0].resolvesDispute = true;
  bundle.events.push(...Array.from({ length: 45 }, (_, index) => ({
    ...structuredClone(bundle.events[0]),
    id: `event.boundary.${index}`
  })));
  bundle.authorityTrace = Array.from({ length: 46 }, (_, index) => authorityTrace({ id: `trace.boundary.${index}` }));
  const outcome = flow.evaluateGate(
    definition,
    structuredClone(state),
    manifest,
    "verify-gate",
    configFor(),
    "2026-06-16T00:00:00.000Z"
  );
  assert.equal(outcome.status, "pass", "46×46 candidates stay below each independent reconciliation pass limit");
});

test("raw derivation preflight bounds policies and nested Surface collections before schema or report work", async () => {
  const { definition, state } = await gateState("derivation-policy-budget");
  const manifest = await passingFixture();
  const bundle = manifest.evidence[0].bundle;
  bundle.policies = Array.from({ length: 100_000 }, (_, index) => ({ id: `policy.budget.${index}`, references: [`policy-ref.${index}`] }));
  let validations = 0;
  let builds = 0;
  const outcome = evaluateGateWithReducerDependencies(
    definition,
    structuredClone(state),
    manifest,
    "verify-gate",
    configFor(),
    "2026-06-16T00:00:00.000Z",
    {
      validate: (value) => {
        validations += 1;
        return value;
      },
      buildReport: () => {
        builds += 1;
        throw new Error("must not build an over-budget policy payload");
      },
      checkAuthorityActive: () => "active"
    }
  );
  assert.equal(validations, 0, "raw policy payload is rejected before Surface validation");
  assert.equal(builds, 0, "raw policy payload is rejected before Surface report derivation");
  assert.equal(outcome.status, "route-back");
  assert.equal(claimDiagnostic(outcome)?.reason, "bundle_invalid");
});

test("direct gate evaluation snapshots an access-varying bundle before budget and validation", async () => {
  const { definition, state } = await gateState("direct-bundle-snapshot");
  const manifest = await passingFixture();
  const accepted = manifest.evidence[0].bundle;
  let reads = 0;
  Object.defineProperty(manifest.evidence[0], "bundle", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? accepted : { ...accepted, claims: new Array(100_000) };
    }
  });
  const outcome = flow.evaluateGate(definition, structuredClone(state), manifest, "verify-gate", configFor(), "2026-06-16T00:00:00.000Z");
  assert.equal(reads, 1, "one immutable snapshot feeds direct budget, validation, and report derivation");
  assert.equal(outcome.status, "pass");
});

test("one evidence entry cannot splice separate snapshots across required expectations", async () => {
  const { definition, state } = await gateState("cross-expectation-snapshot");
  const multiExpectationDefinition = structuredClone(definition);
  multiExpectationDefinition.gates["verify-gate"].expects.push({
    id: "lint-passed",
    kind: "trust.bundle",
    required: true,
    description: "Lint result is attached.",
    bundle_claim: {
      claimType: "quality.lint",
      subjectType: "flow-step",
      subjectId: "builder.verify",
      accepted_statuses: ["verified"]
    }
  });
  const manifest = await passingFixture();
  const testsOnly = manifest.evidence[0].bundle;
  const lintOnly = structuredClone(testsOnly);
  lintOnly.claims[0] = {
    ...lintOnly.claims[0],
    id: "claim.quality.lint.verify",
    facet: "quality.lint",
    claimType: "quality.lint",
    fieldOrBehavior: "lintPasses",
    verificationPolicyId: "policy.quality.lint"
  };
  lintOnly.evidence[0] = { ...lintOnly.evidence[0], id: "evidence.quality.lint.output", claimId: "claim.quality.lint.verify" };
  lintOnly.events[0] = { ...lintOnly.events[0], id: "event.quality.lint.verified", claimId: "claim.quality.lint.verify", evidenceIds: ["evidence.quality.lint.output"] };
  lintOnly.policies[0] = { ...lintOnly.policies[0], id: "policy.quality.lint", claimType: "quality.lint" };
  let reads = 0;
  Object.defineProperty(manifest.evidence[0], "bundle", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? testsOnly : lintOnly;
    }
  });
  const outcome = flow.evaluateGate(
    multiExpectationDefinition,
    structuredClone(state),
    manifest,
    "verify-gate",
    configFor(),
    "2026-06-16T00:00:00.000Z"
  );
  assert.equal(reads, 1, "the entry is snapshotted once for all expectations");
  assert.equal(outcome.status, "route-back");
  assert.deepEqual(outcome.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: "ev.pass-trust-report", claim_ids: ["claim.quality.tests.verify"], authority_witness: null }]);
  assert.deepEqual(outcome.missing, ["lint-passed"]);
});

test("gate input snapshot prevents access-varying entry kind from becoming a trust bundle", async () => {
  const { definition, state } = await gateState("entry-kind-snapshot");
  const manifest = await passingFixture();
  manifest.evidence[0].requested_kind = "file";
  let kindReads = 0;
  let bundleReads = 0;
  Object.defineProperty(manifest.evidence[0], "kind", {
    enumerable: true,
    get() {
      kindReads += 1;
      return kindReads === 1 ? "file" : "trust.bundle";
    }
  });
  Object.defineProperty(manifest.evidence[0], "bundle", {
    enumerable: false,
    get() {
      bundleReads += 1;
      throw new Error("non-trust bundle getter must stay lazy");
    }
  });
  const outcome = flow.evaluateGate(definition, state, manifest, "verify-gate", configFor(), "2026-06-16T00:00:00.000Z");
  assert.equal(kindReads, 1);
  assert.equal(bundleReads, 0, "a snapshotted non-trust entry must not derive/read its bundle");
  assert.equal(outcome.status, "route-back");
});

test("gate input snapshot uses one producer and one trusted-producer policy view", async () => {
  const { definition, state } = await gateState("producer-config-snapshot");
  const producerManifest = await passingFixture("ci/trusted");
  let producerReads = 0;
  Object.defineProperty(producerManifest.evidence[0], "producer", {
    enumerable: true,
    get() {
      producerReads += 1;
      return producerReads === 1 ? "ci/untrusted" : "ci/trusted";
    }
  });
  const producerOutcome = flow.evaluateGate(
    definition,
    state,
    producerManifest,
    "verify-gate",
    configFor({ trusted_producers: { "quality.tests": { producers: ["ci/trusted"] } } }),
    "2026-06-16T00:00:00.000Z"
  );
  assert.equal(producerReads, 1);
  assert.equal(producerOutcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(producerOutcome)?.authority, { code: "producer_mismatch" });

  const configManifest = await passingFixture("ci/trusted");
  let configReads = 0;
  const accessVaryingConfig = {
    schema_version: flow.FLOW_SCHEMA_VERSION,
    gate_overrides: {},
    get trusted_producers() {
      configReads += 1;
      return configReads === 1
        ? { "quality.tests": { producers: ["ci/strict"] } }
        : { "quality.tests": { producers: ["ci/trusted"] } };
    }
  };
  const configOutcome = flow.evaluateGate(definition, state, configManifest, "verify-gate", accessVaryingConfig, "2026-06-16T00:00:00.000Z");
  assert.equal(configReads, 1);
  assert.equal(configOutcome.status, "route-back");
  assert.equal(claimDiagnostic(configOutcome)?.reason, "untrusted_producer");
});

test("gate input snapshot keeps matched evidence identity and evidence refs coherent", async () => {
  const { definition, state } = await gateState("entry-id-snapshot");
  const manifest = await passingFixture();
  let idReads = 0;
  Object.defineProperty(manifest.evidence[0], "id", {
    enumerable: true,
    get() {
      idReads += 1;
      return idReads === 1 ? "ev.first" : "ev.second";
    }
  });
  const outcome = flow.evaluateGate(definition, state, manifest, "verify-gate", configFor(), "2026-06-16T00:00:00.000Z");
  assert.equal(idReads, 1);
  assert.deepEqual(outcome.matched_expectations, [{ expectation_id: "tests-passed", evidence_id: "ev.first", claim_ids: ["claim.quality.tests.verify"], authority_witness: null }]);
  assert.deepEqual(outcome.evidence_refs, ["ev.first"]);
});

test("gate snapshot failures expose a stable message without hostile getter detail", async () => {
  const { definition, state } = await gateState("snapshot-error-sanitized");
  Object.defineProperty(definition, "id", {
    enumerable: true,
    get() {
      throw new Error("secret gate filesystem path");
    }
  });
  await assert.rejects(
    async () => flow.evaluateGate(definition, state, await passingFixture(), "verify-gate", configFor()),
    (error) => error?.message === "flow gate inputs cannot be snapshotted"
      && !error.message.includes("secret")
      && error.cause === undefined
  );
});

test("raw derivation budget rejects oversized sparse arrays without reading their items", () => {
  const oversized = new Proxy(new Array(100_000), {
    get(target, property, receiver) {
      if (property !== "length") throw new Error(`budget must not read sparse item/property ${String(property)}`);
      return Reflect.get(target, property, receiver);
    }
  });
  assert.equal(surfaceDerivationWithinBudget({ claims: oversized }), false);
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
    ["future-observation", authorityTrace({ observedAt: "2026-06-16T00:00:00.0001Z" }), "not_yet_valid"],
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

  for (const [label, trace, expectedStatus, expectedAuthority] of [
    ["valid-from-100-microseconds-future", authorityTrace({ validFrom: "2026-06-16T00:00:00.0001Z" }), "route-back", "not_yet_valid"],
    ["valid-from-100-microseconds-past", authorityTrace({ validFrom: "2026-06-15T23:59:59.9999Z" }), "pass", undefined],
    ["valid-until-100-microseconds-future", authorityTrace({ validUntil: "2026-06-16T00:00:00.0001Z" }), "pass", undefined],
    ["valid-until-100-microseconds-past", authorityTrace({ validUntil: "2026-06-15T23:59:59.9999Z" }), "route-back", "expired"],
    ["revocation-100-microseconds-future", authorityTrace({ revokedAt: "2026-06-16T00:00:00.0001Z" }), "pass", undefined],
    ["revocation-100-microseconds-past", authorityTrace({ revokedAt: "2026-06-15T23:59:59.9999Z" }), "route-back", "revoked"]
  ]) {
    const outcome = flow.evaluateGate(definition, structuredClone(state), await authorityFixture(trace), "verify-gate", config, now);
    assert.equal(outcome.status, expectedStatus, label);
    if (expectedAuthority) assert.deepEqual(claimDiagnostic(outcome)?.authority, { code: expectedAuthority }, label);
  }

  const fractionallyExpired = flow.evaluateGate(
    definition,
    structuredClone(state),
    await authorityFixture(authorityTrace({ validUntil: "2026-06-16T00:00:00.00005Z" })),
    "verify-gate",
    config,
    "2026-06-16T00:00:00.0001Z"
  );
  assert.equal(fractionallyExpired.status, "route-back", "Flow must retain fractions beyond Date precision");
  assert.deepEqual(claimDiagnostic(fractionallyExpired)?.authority, { code: "expired" });

  const mismatchedEventAuthority = await authorityFixture(authorityTrace({ claimIds: undefined, evidenceIds: ["evidence.quality.tests.output"] }));
  mismatchedEventAuthority.evidence[0].bundle.events[0].authorityRef = "authority:other";
  mismatchedEventAuthority.evidence[0].bundle.events[0].actor = "ci/other";
  const mismatchedEventOutcome = flow.evaluateGate(definition, structuredClone(state), mismatchedEventAuthority, "verify-gate", config, now);
  assert.equal(mismatchedEventOutcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(mismatchedEventOutcome)?.authority, { code: "actor_mismatch" });

  const forgedCache = await authorityFixture();
  forgedCache.evidence[0].bundle.events[0].status = "disputed";
  const forgedCacheOutcome = flow.evaluateGate(definition, structuredClone(state), forgedCache, "verify-gate", config, now);
  assert.equal(forgedCacheOutcome.status, "route-back", "cached bundle_report display data must never authorize a gate");
  assert.equal(claimDiagnostic(forgedCacheOutcome)?.reason, "disputed");

  const injectedReportHelper = {
    validate: () => forgedCache.evidence[0].bundle,
    buildReport: () => ({ claims: [{
      id: "claim.quality.tests.verify", claimType: "quality.tests", subjectType: "flow-step", subjectId: "builder.verify", status: "verified"
    }] }),
    checkAuthorityActive: () => "active"
  };
  const injectedReportOutcome = flow.evaluateGate(
    definition,
    structuredClone(state),
    forgedCache,
    "verify-gate",
    config,
    now,
    injectedReportHelper
  );
  assert.equal(injectedReportOutcome.status, "route-back", "public gate evaluation must ignore injected trust helpers");
  assert.equal(claimDiagnostic(injectedReportOutcome)?.reason, "disputed");

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

  const fractionalProjectionState = structuredClone(state);
  fractionalProjectionState.updated_at = "2026-06-16T00:00:00.0001Z";
  const fractionallyExpiredProjection = flow.projectFlowRun({
    definition,
    state: fractionalProjectionState,
    manifest: await authorityFixture(authorityTrace({ validUntil: "2026-06-16T00:00:00.00005Z" })),
    config
  });
  assert.equal(
    fractionallyExpiredProjection.gates.find((gate) => gate.id === "verify-gate").status,
    "route-back",
    "Console projection must preserve fractional RFC3339 evaluation instants beyond Date precision"
  );

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

test("exact reconciliation fences future facts, duration freshness, and resolution chronology without replacing Surface status policy", async () => {
  const { definition, state } = await gateState("exact-reconciliation");
  const evaluate = (manifest, now, selectedDefinition = definition) => flow.evaluateGate(
    selectedDefinition,
    structuredClone(state),
    manifest,
    "verify-gate",
    configFor(),
    now
  );
  const now = "2026-06-16T00:00:00.0001Z";

  const assumedDefinition = structuredClone(definition);
  assumedDefinition.gates["verify-gate"].expects[0].bundle_claim.accepted_statuses = ["assumed"];
  const futureAssumption = await passingFixture();
  futureAssumption.evidence[0].bundle.events[0].status = "assumed";
  futureAssumption.evidence[0].bundle.claims[0].createdAt = "2026-06-16T00:00:00.00015Z";
  futureAssumption.evidence[0].bundle.claims[0].updatedAt = "2026-06-16T00:00:00.00015Z";
  const futureOutcome = evaluate(futureAssumption, now, assumedDefinition);
  assert.equal(futureOutcome.status, "route-back", "a custom accepted status cannot authorize a claim authored after the exact evaluation instant");
  assert.equal(claimDiagnostic(futureOutcome)?.reason, "claim_not_current");

  const equivalentSameMillisecond = await passingFixture();
  equivalentSameMillisecond.evidence[0].bundle.events[0].createdAt = "2026-06-15T00:00:00.00001Z";
  equivalentSameMillisecond.evidence[0].bundle.events[0].verifiedAt = "2026-06-15T00:00:00.00001Z";
  equivalentSameMillisecond.evidence[0].bundle.events.push({
    ...structuredClone(equivalentSameMillisecond.evidence[0].bundle.events[0]),
    id: "event.quality.tests.equivalent",
    createdAt: "2026-06-15T00:00:00.00009Z",
    verifiedAt: "2026-06-15T00:00:00.00009Z"
  });
  assert.equal(evaluate(equivalentSameMillisecond, now).status, "pass", "same-millisecond events with identical status and authorization semantics preserve Surface's result");

  const duration = await passingFixture();
  delete duration.evidence[0].bundle.claims[0].expiresAt;
  duration.evidence[0].bundle.events[0].createdAt = "2026-06-15T00:00:00.00005Z";
  duration.evidence[0].bundle.events[0].verifiedAt = "2026-06-15T00:00:00.00005Z";
  duration.evidence[0].bundle.policies[0].validityRule = { kind: "duration", durationDays: 1 };
  const durationOutcome = evaluate(duration, now);
  assert.equal(durationOutcome.status, "route-back", "a duration policy expires at RFC3339 precision, not Date milliseconds");
  assert.equal(claimDiagnostic(durationOutcome)?.reason, "stale");

  for (const [label, ttlNow, expected] of [
    ["immediately before", "2026-06-15T00:00:01.000049Z", "pass"],
    ["at the exact expiry boundary", "2026-06-15T00:00:01.00005Z", "pass"],
    ["immediately after", "2026-06-15T00:00:01.000051Z", "route-back"]
  ]) {
    const ttl = await passingFixture();
    delete ttl.evidence[0].bundle.claims[0].expiresAt;
    ttl.evidence[0].bundle.claims[0].ttlSeconds = 1;
    ttl.evidence[0].bundle.events[0].createdAt = "2026-06-15T00:00:00.00005Z";
    ttl.evidence[0].bundle.events[0].verifiedAt = "2026-06-15T00:00:00.00005Z";
    const ttlOutcome = evaluate(ttl, ttlNow);
    assert.equal(ttlOutcome.status, expected, `one-second TTL ${label} must retain exact seconds without duration-day rounding`);
    if (expected === "route-back") assert.equal(claimDiagnostic(ttlOutcome)?.reason, "stale");
  }

  const resolutionWithNewerBlockingEvidence = await passingFixture();
  resolutionWithNewerBlockingEvidence.evidence[0].bundle.authorityTrace = [authorityTrace()];
  resolutionWithNewerBlockingEvidence.evidence[0].bundle.events[0].status = "rejected";
  resolutionWithNewerBlockingEvidence.evidence[0].bundle.events[0].createdAt = "2026-06-14T00:00:00.000Z";
  resolutionWithNewerBlockingEvidence.evidence[0].bundle.events.push({
    id: "event.quality.tests.resolution",
    claimId: "claim.quality.tests.verify",
    status: "verified",
    actor: "ci/main",
    method: "review",
    evidenceIds: ["evidence.quality.tests.output"],
    createdAt: "2026-06-16T00:00:00.00001Z",
    resolvesDispute: true
  });
  resolutionWithNewerBlockingEvidence.evidence[0].bundle.evidence.push({
    id: "evidence.quality.tests.blocking",
    claimId: "claim.quality.tests.verify",
    evidenceType: "test_output",
    method: "validation",
    sourceRef: "ci:blocking",
    excerptOrSummary: "a newer failure",
    observedAt: "2026-06-16T00:00:00.00009Z",
    collectedBy: "ci/main",
    passing: false,
    blocking: true
  });
  const resolutionOutcome = evaluate(resolutionWithNewerBlockingEvidence, now);
  assert.equal(resolutionOutcome.status, "route-back", "a blocking failure exactly newer than a resolution must re-open the dispute");
  assert.equal(claimDiagnostic(resolutionOutcome)?.reason, "claim_time_ambiguous");

  const citedOnlyFailure = structuredClone(resolutionWithNewerBlockingEvidence);
  citedOnlyFailure.evidence[0].bundle.evidence.at(-1).supportStrength = "cited";
  const citedOnlyOutcome = evaluate(citedOnlyFailure, now);
  assert.equal(citedOnlyOutcome.status, "pass", JSON.stringify(citedOnlyOutcome));

  const lexicallyAuthorizedButExactlyFuture = structuredClone(resolutionWithNewerBlockingEvidence);
  lexicallyAuthorizedButExactlyFuture.evidence[0].bundle.evidence.pop();
  lexicallyAuthorizedButExactlyFuture.evidence[0].bundle.authorityTrace = [authorityTrace({
    validFrom: "2026-06-15T18:00:00.00002-06:00"
  })];
  const resolutionAuthorityOutcome = evaluate(lexicallyAuthorizedButExactlyFuture, now);
  assert.equal(resolutionAuthorityOutcome.status, "route-back", "resolution authority must be active at its exact decision instant even through an offset");
  assert.equal(claimDiagnostic(resolutionAuthorityOutcome)?.reason, "claim_time_ambiguous");
});

test("producer authority binds to Surface's governing authorization event, never a historical accepted event", async () => {
  const { definition, state } = await gateState("governing-event-actor");
  const config = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  const manifest = await authorityFixture();
  const bundle = manifest.evidence[0].bundle;
  bundle.events[0].createdAt = "2026-06-15T00:00:00.001Z";
  bundle.events[0].verifiedAt = "2026-06-15T00:00:00.001Z";
  bundle.events.push(
    {
      id: "event.quality.tests.untrusted-rejected",
      claimId: "claim.quality.tests.verify",
      status: "rejected",
      actor: "ci/untrusted",
      method: "validation",
      evidenceIds: ["evidence.quality.tests.output"],
      createdAt: "2026-06-15T00:00:00.002Z"
    },
    {
      id: "event.quality.tests.untrusted-verified",
      claimId: "claim.quality.tests.verify",
      status: "verified",
      actor: "ci/untrusted",
      method: "validation",
      evidenceIds: ["evidence.quality.tests.untrusted"],
      createdAt: "2026-06-15T00:00:00.003Z",
      verifiedAt: "2026-06-15T00:00:00.003Z"
    }
  );
  bundle.evidence.push({
    id: "evidence.quality.tests.untrusted",
    claimId: "claim.quality.tests.verify",
    evidenceType: "test_output",
    method: "validation",
    sourceRef: "ci:untrusted",
    excerptOrSummary: "new untrusted verification",
    observedAt: "2026-06-15T00:00:00.003Z",
    collectedBy: "ci/untrusted",
    integrityRef: "commit:abc123"
  });
  const outcome = flow.evaluateGate(definition, structuredClone(state), manifest, "verify-gate", config, "2026-06-16T00:00:00.000Z");
  assert.equal(outcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(outcome)?.authority, { code: "actor_mismatch" }, JSON.stringify(outcome));
});

test("event-driven stale binds its invalidation event instead of a historical verification", async () => {
  const { definition, state } = await gateState("event-stale-governing-event");
  const staleDefinition = structuredClone(definition);
  staleDefinition.gates["verify-gate"].expects[0].bundle_claim.accepted_statuses = ["stale"];
  const config = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  const manifest = await authorityFixture();
  manifest.evidence[0].bundle.events.push({
    id: "event.quality.tests.revoked-untrusted",
    claimId: "claim.quality.tests.verify",
    status: "revoked",
    actor: "ci/untrusted",
    method: "validation",
    evidenceIds: ["evidence.quality.tests.revoked-untrusted"],
    createdAt: "2026-06-15T00:00:00.001Z"
  });
  manifest.evidence[0].bundle.evidence.push({
    id: "evidence.quality.tests.revoked-untrusted",
    claimId: "claim.quality.tests.verify",
    evidenceType: "test_output",
    method: "validation",
    sourceRef: "ci:untrusted",
    excerptOrSummary: "untrusted revocation",
    observedAt: "2026-06-15T00:00:00.001Z",
    collectedBy: "ci/untrusted"
  });
  const outcome = flow.evaluateGate(staleDefinition, structuredClone(state), manifest, "verify-gate", config, "2026-06-16T00:00:00.000Z");
  assert.equal(outcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(outcome)?.authority, { code: "actor_mismatch" }, JSON.stringify(outcome));
});

test("resolution authority cannot splice decision-time and current trace facts", async () => {
  const { definition, state } = await gateState("resolution-trace-splice");
  const config = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  const manifest = await authorityFixture();
  const bundle = manifest.evidence[0].bundle;
  bundle.events[0].status = "rejected";
  bundle.events.push({
    id: "event.quality.tests.resolution-splice",
    claimId: "claim.quality.tests.verify",
    status: "verified",
    actor: "ci/main",
    method: "review",
    evidenceIds: ["evidence.quality.tests.output"],
    createdAt: "2026-06-15T00:00:00.001Z",
    resolvesDispute: true
  });
  bundle.authorityTrace = [
    authorityTrace({ id: "trace.decision-only", subject: { subjectType: "flow-step", subjectId: "other" } }),
    authorityTrace({ id: "trace.current-only", validFrom: "2026-06-15T00:00:00.002Z" })
  ];
  const outcome = flow.evaluateGate(definition, structuredClone(state), manifest, "verify-gate", config, "2026-06-16T00:00:00.000Z");
  assert.equal(outcome.status, "route-back");
  assert.equal(claimDiagnostic(outcome)?.reason, "claim_time_ambiguous", "the exact claim-aware resolution fence rejects the bundle before optional producer pins can authorize it");
});

test("resolution authority is claim-aware without pins and survives validated-clone pin correlation", async () => {
  const { definition, state } = await gateState("resolution-claim-aware");
  const resolutionManifest = async (trace) => {
    const manifest = await authorityFixture(trace);
    const bundle = manifest.evidence[0].bundle;
    bundle.events[0].status = "rejected";
    bundle.events.push({
      id: "event.quality.tests.resolution-claim-aware",
      claimId: "claim.quality.tests.verify",
      status: "verified",
      actor: "ci/main",
      method: "review",
      evidenceIds: ["evidence.quality.tests.output"],
      createdAt: "2026-06-15T00:00:00.001Z",
      resolvesDispute: true
    });
    return manifest;
  };
  const now = "2026-06-16T00:00:00.000Z";

  for (const [label, trace] of [
    ["wrong subject", authorityTrace({ subject: { subjectType: "flow-step", subjectId: "other" } })],
    ["future observation", authorityTrace({ observedAt: "2026-06-16T00:00:00.0001Z" })]
  ]) {
    const outcome = flow.evaluateGate(definition, structuredClone(state), await resolutionManifest(trace), "verify-gate", configFor(), now);
    assert.equal(outcome.status, "route-back", `${label} cannot authorize an unpinned resolution`);
    assert.equal(claimDiagnostic(outcome)?.reason, "claim_time_ambiguous");
  }

  const retrospective = await resolutionManifest(authorityTrace({ observedAt: "2026-06-15T00:00:00.002Z" }));
  assert.equal(
    flow.evaluateGate(definition, structuredClone(state), retrospective, "verify-gate", configFor(), now).status,
    "pass",
    "an observation recorded after a decision but before evaluation remains valid"
  );

  const pinned = await resolutionManifest(authorityTrace());
  const pinnedConfig = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  assert.equal(
    flow.evaluateGate(definition, structuredClone(state), pinned, "verify-gate", pinnedConfig, now).status,
    "pass",
    "a valid resolution trace remains usable after Surface validation clones the bundle"
  );
});

test("governing-event actor binding preserves linked collectors and explicit evaluation-time authority", async () => {
  const { definition, state } = await gateState("governing-event-collector");
  const config = configFor({ trusted_producers: { "quality.tests": { authority_refs: ["authority:quality"] } } });
  const now = "2026-06-16T00:00:00.000Z";

  const collectorBound = await authorityFixture(authorityTrace({
    actorRef: "ci/collector",
    validFrom: "2026-06-15T00:00:00.500Z",
    evidenceIds: ["evidence.quality.tests.output"]
  }));
  collectorBound.evidence[0].bundle.evidence[0].collectedBy = "ci/collector";
  assert.equal(
    flow.evaluateGate(definition, structuredClone(state), collectorBound, "verify-gate", config, now).status,
    "pass",
    "a trace may bind the governing event's linked evidence collector and need only be active at Flow's explicit evaluation instant"
  );

  const unrelatedCollector = structuredClone(collectorBound);
  unrelatedCollector.evidence[0].bundle.evidence.push({
    id: "evidence.quality.tests.unrelated",
    claimId: "claim.quality.tests.verify",
    evidenceType: "test_output",
    method: "validation",
    sourceRef: "ci:unrelated",
    excerptOrSummary: "not referenced by the governing event",
    observedAt: "2026-06-15T00:00:00.100Z",
    collectedBy: "ci/collector"
  });
  unrelatedCollector.evidence[0].bundle.evidence[0].collectedBy = "ci/other";
  const unrelatedOutcome = flow.evaluateGate(definition, structuredClone(state), unrelatedCollector, "verify-gate", config, now);
  assert.equal(unrelatedOutcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(unrelatedOutcome)?.authority, { code: "actor_mismatch" });

  const historicalCollector = structuredClone(collectorBound);
  historicalCollector.evidence[0].bundle.events.push({
    id: "event.quality.tests.historical",
    claimId: "claim.quality.tests.verify",
    status: "verified",
    actor: "ci/historical",
    method: "validation",
    evidenceIds: ["evidence.quality.tests.historical"],
    createdAt: "2026-06-15T00:00:00.001Z",
    verifiedAt: "2026-06-15T00:00:00.001Z"
  });
  historicalCollector.evidence[0].bundle.evidence.push({
    id: "evidence.quality.tests.historical",
    claimId: "claim.quality.tests.verify",
    evidenceType: "test_output",
    method: "validation",
    sourceRef: "ci:historical",
    excerptOrSummary: "historical collector",
    observedAt: "2026-06-15T00:00:00.001Z",
    collectedBy: "ci/collector"
  });
  historicalCollector.evidence[0].bundle.events[0].createdAt = "2026-06-15T00:00:00.002Z";
  historicalCollector.evidence[0].bundle.events[0].verifiedAt = "2026-06-15T00:00:00.002Z";
  historicalCollector.evidence[0].bundle.evidence[0].collectedBy = "ci/other";
  const historicalOutcome = flow.evaluateGate(definition, structuredClone(state), historicalCollector, "verify-gate", config, now);
  assert.equal(historicalOutcome.status, "route-back");
  assert.deepEqual(claimDiagnostic(historicalOutcome)?.authority, { code: "actor_mismatch" });
});

test("canonical filesystem evaluation uses the same rich authority path and pinned instant", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-trusted-producer-canonical-"));
  const definition = await surfaceClaimFixture("flow-definition.json");
  const manifest = await authorityFixture();
  manifest.evidence[0].bundle.authorityTrace[0].validUntil = "2026-06-16T00:00:01.000Z";
  // This later active trace is intentionally not the trace selected at pass.
  // A current reader must not let it heal the captured trace after expiry.
  manifest.evidence[0].bundle.authorityTrace.push(authorityTrace({ id: "trace.later-active", validFrom: "2026-06-16T00:00:01.000Z" }));
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
  const persisted = await flow.loadRun(started.runId, cwd);
  assert.equal(persisted.state.gate_outcomes.at(-1)?.status, "pass");
  const ref = persisted.state.gate_outcomes.at(-1)?.evaluation_ref;
  const initial = await readGateEvaluation(ref, { cwd, now: "2026-06-16T00:00:00.000Z", authorize: () => true });
  const expired = await readGateEvaluation(ref, { cwd, now: "2026-06-16T00:00:02.000Z", authorize: () => true });
  assert.equal(initial.status, "found");
  assert.equal(initial.evaluation.selectedEvidence[0].authority, "active");
  assert.equal(expired.status, "found");
  assert.equal(expired.evaluation.selectedEvidence[0].authority, "unavailable", "a later active unselected trace must not heal the captured trace");
  await assert.rejects(
    () => flow.evaluateRun(started.runId, { cwd, gate: "verify-gate", now: "06/16/2026" }),
    /flow\.evaluate\.now\.invalid: now must be an RFC3339 date-time/
  );
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
