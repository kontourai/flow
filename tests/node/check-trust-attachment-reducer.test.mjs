import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FLOW_SCHEMA_VERSION,
  FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES,
  reduceTrustAttachment,
  startRun,
  attachEvidence
} from "../../dist/index.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020");

const NOW = "2026-07-19T16:00:00.000Z";
const definition = {
  id: "trust-attachment-reducer", version: "1.0", steps: [{ id: "verify", next: null }],
  gates: {
    "verify-gate": {
      step: "verify",
      expects: [{
        id: "review-accepted", kind: "trust.bundle", required: true,
        description: "Review acceptance is attached.",
        bundle_claim: { claimType: "quality.review", subjectType: "flow-step", subjectId: "verify", accepted_statuses: ["verified"] }
      }],
      on_route_back: { implementation_defect: "verify", missing_evidence: "verify", default: "verify" },
      route_back_policy: { max_attempts: 3, on_exceeded: "block" }
    }
  }
};

function bundle({ id = "claim.review", expiresAt, producerId, authorityTrace } = {}) {
  return {
    schemaVersion: 7, source: "test/reducer",
    claims: [{
      id, subjectType: "flow-step", subjectId: "verify", facet: "quality.review",
      claimType: "quality.review", fieldOrBehavior: "review", value: "accepted",
      createdAt: "2026-07-19T15:00:00.000Z", updatedAt: "2026-07-19T15:00:00.000Z",
      ...(expiresAt ? { expiresAt } : {})
    }],
    evidence: [], policies: [],
    events: [{ id: `event.${id}`, claimId: id, status: "verified", actor: "test/reviewer", method: "review", evidenceIds: [], createdAt: "2026-07-19T15:30:00.000Z", verifiedAt: "2026-07-19T15:30:00.000Z" }],
    ...(producerId ? { producerId } : {}),
    ...(authorityTrace ? { authorityTrace } : {})
  };
}

function runInput() {
  const state = {
    schema_version: FLOW_SCHEMA_VERSION, run_id: "reducer-run", definition_id: definition.id,
    definition_version: definition.version, subject: "reducer subject", status: "active", current_step: "verify",
    gate_outcomes: [], transitions: [], exceptions: [], next_action: "attach evidence", updated_at: "2026-07-19T15:00:00.000Z"
  };
  return { definition, state, manifest: { schema_version: FLOW_SCHEMA_VERSION, run_id: state.run_id, definition_id: definition.id, definition_version: definition.version, evidence: [] }, config: { schema_version: FLOW_SCHEMA_VERSION, trusted_producers: {}, gate_overrides: {} } };
}

function attachment(id = "ev.reducer.1", overrides = {}) {
  return { id, gate_id: "verify-gate", attached_at: NOW, original_path: "review.json", stored_path: `evidence/${id}.json`, sha256: "a".repeat(64), ...overrides };
}

function reviewAuthorityTrace(overrides = {}) {
  return {
    id: "trace.review",
    subject: { subjectType: "flow-step", subjectId: "verify" },
    actorRef: "test/reviewer",
    authorityType: "role",
    authorityRef: "authority:review",
    sourceRef: "policy:review",
    observedAt: "2026-07-19T15:30:00.000Z",
    claimIds: ["claim.review"],
    ...overrides
  };
}

test("trust attachment reducer is pure, versioned, schema-valid, and returns the full write intent", async () => {
  const run = runInput();
  const before = structuredClone(run);
  const result = reduceTrustAttachment({ run, bundle: bundle(), attachment: attachment(), now: NOW, dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES });
  const schema = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../schemas/trust-attachment-reducer.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(schema));

  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.deepEqual(run, before, "the reducer must not mutate canonical inputs");
  assert.equal(result.identity.artifact_id, "kontourai.flow.trust-attachment-reducer");
  assert.equal(result.identity.version, "1.3.5");
  assert.equal(result.evaluation_mode, "evaluate");
  assert.deepEqual(result.identity.dependency_versions, { hachure: "0.15.0", surface: "2.14.0" });
  for (const integrity of [
    result.identity.dependency_integrities.hachure.validate,
    ...Object.values(result.identity.dependency_integrities.surface)
  ]) assert.match(integrity, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.identity.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.evidence.kind, "trust.bundle");
  assert.equal(result.next_manifest.evidence.length, 1);
  assert.equal(result.evaluation.status, "pass");
  assert.equal(result.result.evidence.id, result.evidence.id);
  assert.equal(result.next_state.status, "completed");
  assert.deepEqual(result.write.artifacts.map((entry) => entry.path), ["evidence/manifest.json", "state.json", "report.json", "report.md"]);
});

test("attach-only synchronization preserves state and route-back budget across supersession", async () => {
  const run = runInput();
  const beforeState = structuredClone(run.state);
  const first = reduceTrustAttachment({
    run,
    bundle: bundle({ id: "claim.unrelated.1" }),
    attachment: attachment("ev.unrelated.1"),
    evaluation_mode: "attach-only",
    now: NOW,
    dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });

  assert.equal(first.evaluation, null);
  assert.equal(first.result.evaluation, null);
  assert.deepEqual(first.next_state, beforeState);
  assert.deepEqual(first.write.artifacts.map((entry) => entry.path), ["evidence/manifest.json", "report.json", "report.md"]);

  const second = reduceTrustAttachment({
    run: { ...run, state: first.next_state, manifest: first.next_manifest },
    bundle: bundle({ id: "claim.unrelated.2" }),
    attachment: attachment("ev.unrelated.2", { supersede: "ev.unrelated.1" }),
    evaluation_mode: "attach-only",
    now: NOW,
    dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });

  assert.deepEqual(second.next_state, beforeState);
  assert.deepEqual(second.next_state.transitions, []);
  assert.equal(second.next_manifest.evidence[0].superseded_by, "ev.unrelated.2");

  const evaluated = reduceTrustAttachment({
    run: { ...run, state: second.next_state, manifest: second.next_manifest },
    bundle: bundle({ id: "claim.review.final" }),
    attachment: attachment("ev.review.final", { supersede: "ev.unrelated.2" }),
    now: NOW,
    dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });

  assert.equal(evaluated.evaluation_mode, "evaluate");
  assert.equal(evaluated.evaluation.status, "pass");
  assert.equal(evaluated.next_state.status, "completed");
  assert.equal(evaluated.next_state.transitions.some((entry) => entry.type === "route_back"), false);

  const schema = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../schemas/trust-attachment-reducer.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(schema));
  assert.equal(validate(second), true, JSON.stringify(validate.errors));
  assert.equal(validate(evaluated), true, JSON.stringify(validate.errors));
  const duplicateManifestWrites = structuredClone(second);
  duplicateManifestWrites.write.artifacts = duplicateManifestWrites.write.artifacts.map((entry) => ({
    ...entry,
    path: "evidence/manifest.json"
  }));
  assert.equal(validate(duplicateManifestWrites), false, "schema must reject duplicate artifact paths");
});

test("trust attachment reducer preserves attachEvidence supersession semantics for repaired critique", () => {
  const run = runInput();
  run.manifest.evidence.push({ ...attachment("ev.failed", { status: "failed", route_reason: "implementation_defect" }), kind: "file", requested_kind: "file" });
  const result = reduceTrustAttachment({
    run, bundle: bundle(), attachment: attachment("ev.repaired", { supersede: "ev.failed" }), now: NOW,
    dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  assert.equal(result.next_manifest.evidence[0].superseded_by, "ev.repaired");
  assert.equal(result.evaluation.status, "pass");
  assert.equal(result.next_state.status, "completed");
});

test("trust attachment reducer fails closed for invalid bundles and derives stale bundle outcomes at supplied now", () => {
  const run = runInput();
  assert.throws(
    () => reduceTrustAttachment({ run, bundle: { ...bundle(), schemaVersion: 999 }, attachment: attachment(), now: NOW, dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES }),
    /Hachure schema/
  );
  const stale = reduceTrustAttachment({
    run, bundle: bundle({ expiresAt: "2026-07-18T00:00:00.000Z" }), attachment: attachment("ev.stale"), now: NOW,
    dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  assert.equal(stale.evidence.bundle_report.claims[0].status, "stale");
  assert.equal(stale.evaluation.status, "route-back");
  assert.equal(stale.evaluation.attempt, 1);
  assert.throws(
    () => reduceTrustAttachment({
      run, bundle: bundle(), attachment: attachment("ev.bad-mode"), evaluation_mode: "later",
      now: NOW, dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
    }),
    /unsupported trust attachment evaluation mode/
  );
  for (const now of ["not-a-date", "06/16/2026"]) {
    assert.throws(
      () => reduceTrustAttachment({ run, bundle: bundle(), attachment: attachment(`ev.bad-now.${now}`), now, dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES }),
      /now must be a valid RFC3339 date-time/
    );
  }
});

test("trust attachment reducer enforces validated producer identity and gives opaque authority metadata zero trust weight", () => {
  const trustedConfig = {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: { "quality.review": { producers: ["review/trusted"] } },
    gate_overrides: {}
  };
  const trustedRun = runInput();
  trustedRun.config = trustedConfig;
  const trusted = reduceTrustAttachment({
    run: trustedRun, bundle: bundle({ producerId: "review/trusted" }), attachment: attachment("ev.trusted", { producer: "review/trusted" }), now: NOW,
    dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  assert.equal(trusted.evaluation.status, "pass");

  for (const attachmentInput of [attachment("ev.missing"), attachment("ev.untrusted", { producer: "review/other" })]) {
    const rejected = reduceTrustAttachment({
      run: trustedRun, bundle: bundle({ id: attachmentInput.id }), attachment: attachmentInput, now: NOW,
      dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
    });
    assert.equal(rejected.evaluation.status, "route-back");
    assert.equal(rejected.evaluation.diagnostics.claim_evaluation[0].reason, "untrusted_producer");
  }

  const authorityOnlyConfig = { schema_version: FLOW_SCHEMA_VERSION, trusted_producers: { "quality.review": { authority_refs: ["authority:review"] } }, gate_overrides: {} };
  const authority = reduceTrustAttachment({
    run: { ...trustedRun, config: authorityOnlyConfig }, bundle: bundle({ id: "claim.authority" }), attachment: attachment("ev.authority", {
      authority_trace: "authority:review", authority_traces: ["authority:other", "authority:review"]
    }), now: NOW, dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  assert.equal(authority.evaluation.status, "route-back");
  assert.deepEqual(authority.evaluation.diagnostics.claim_evaluation[0].authority, { code: "no_trace" });
  assert.deepEqual(authority.evidence.authority_traces, ["authority:other", "authority:review"]);

  const richAuthority = reduceTrustAttachment({
    run: { ...trustedRun, config: authorityOnlyConfig },
    bundle: bundle({ authorityTrace: [reviewAuthorityTrace()] }), attachment: attachment("ev.rich-authority"), now: NOW,
    dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  assert.equal(richAuthority.evaluation.status, "pass");

  const revokedDependencies = {
    ...FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES,
    surface: {
      ...FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES.surface,
      checkAuthorityActive: () => "revoked"
    }
  };
  assert.throws(
    () => reduceTrustAttachment({
      run: { ...trustedRun, config: authorityOnlyConfig },
      bundle: bundle({ authorityTrace: [reviewAuthorityTrace()] }), attachment: attachment("ev.injected-authority"), now: NOW,
      dependencies: revokedDependencies
    }),
    /unsupported trust attachment reducer dependency adapter/,
    "callers cannot substitute closure behavior while retaining Flow's reducer identity"
  );

  const malformedRun = runInput();
  malformedRun.config = { schema_version: FLOW_SCHEMA_VERSION, trusted_producers: { "quality.review": { producers: "review/trusted" } }, gate_overrides: {} };
  assert.throws(
    () => reduceTrustAttachment({ run: malformedRun, bundle: bundle(), attachment: attachment("ev.bad-config"), now: NOW, dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES }),
    /flow config does not satisfy flow-config\.schema\.json/
  );
});

test("trust attachment reducer snapshots a hostile adapter before identity and execution", () => {
  const authorityRun = runInput();
  authorityRun.config = {
    schema_version: FLOW_SCHEMA_VERSION,
    trusted_producers: { "quality.review": { authority_refs: ["authority:review"] } },
    gate_overrides: {}
  };
  let checkAuthorityReads = 0;
  let buildReportReads = 0;
  const flippingSurface = new Proxy({ ...FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES.surface }, {
    get(target, property, receiver) {
      if (property === "buildReport") {
        buildReportReads += 1;
        return buildReportReads === 1
          ? target.buildReport
          : () => ({ claims: [] });
      }
      if (property === "checkAuthorityActive") {
        checkAuthorityReads += 1;
        return checkAuthorityReads === 1
          ? target.checkAuthorityActive
          : () => "revoked";
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const dependencies = {
    ...FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES,
    surface: flippingSurface
  };

  const result = reduceTrustAttachment({
    run: authorityRun,
    bundle: bundle({ authorityTrace: [reviewAuthorityTrace()] }),
    attachment: attachment("ev.flipping-adapter"),
    now: NOW,
    dependencies
  });

  assert.equal(result.evaluation.status, "pass");
  assert.equal(buildReportReads, 1, "the reducer must execute the snapshotted report helper during gate evaluation");
  assert.equal(checkAuthorityReads, 1, "the reducer must execute the snapshotted authority helper during gate evaluation");
});

test("trust attachment reducer matches the canonical attachEvidence manifest projection", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "flow-trust-reducer-parity-"));
  const definitionPath = path.join(cwd, "definition.json");
  const bundlePath = path.join(cwd, "review.json");
  await writeFile(definitionPath, `${JSON.stringify(definition)}\n`);
  await writeFile(bundlePath, `${JSON.stringify(bundle())}\n`);
  const started = await startRun(definitionPath, { cwd, runId: "parity-run" });
  const before = runInput();
  before.state = started.state;
  before.manifest.run_id = started.state.run_id;
  const attached = await attachEvidence(started.runId, {
    cwd, gate: "verify-gate", file: bundlePath, kind: "trust.bundle"
  });
  const reduced = reduceTrustAttachment({
    run: before, bundle: bundle(), now: attached.attached_at,
    attachment: attachment(attached.id, {
      status: attached.status, attached_at: attached.attached_at, original_path: attached.original_path,
      stored_path: attached.stored_path, sha256: attached.sha256
    }), dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES
  });
  assert.deepEqual(
    reduced.next_manifest.evidence[0],
    { ...attached, bundle_report: reduced.next_manifest.evidence[0].bundle_report },
    "the reducer preserves canonical attachment fields; report time is explicitly supplied"
  );
});
