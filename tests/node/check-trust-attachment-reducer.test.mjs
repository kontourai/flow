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
      on_route_back: { implementation_defect: "verify", default: "verify" }
    }
  }
};

function bundle({ id = "claim.review", expiresAt } = {}) {
  return {
    schemaVersion: 7, source: "test/reducer",
    claims: [{
      id, subjectType: "flow-step", subjectId: "verify", facet: "quality.review",
      claimType: "quality.review", fieldOrBehavior: "review", value: "accepted",
      createdAt: "2026-07-19T15:00:00.000Z", updatedAt: "2026-07-19T15:00:00.000Z",
      ...(expiresAt ? { expiresAt } : {})
    }],
    evidence: [], policies: [],
    events: [{ id: `event.${id}`, claimId: id, status: "verified", actor: "test/reviewer", method: "review", evidenceIds: [], createdAt: "2026-07-19T15:30:00.000Z", verifiedAt: "2026-07-19T15:30:00.000Z" }]
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

test("trust attachment reducer is pure, versioned, schema-valid, and returns the full write intent", async () => {
  const run = runInput();
  const before = structuredClone(run);
  const result = reduceTrustAttachment({ run, bundle: bundle(), attachment: attachment(), now: NOW, dependencies: FLOW_TRUST_ATTACHMENT_REDUCER_DEPENDENCIES });
  const schema = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../schemas/trust-attachment-reducer.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(schema));

  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.deepEqual(run, before, "the reducer must not mutate canonical inputs");
  assert.equal(result.identity.artifact_id, "kontourai.flow.trust-attachment-reducer");
  assert.equal(result.identity.version, "1.0.0");
  assert.deepEqual(result.identity.dependency_versions, { hachure: "0.15.0", surface: "2.12.0" });
  assert.match(result.identity.hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.evidence.kind, "trust.bundle");
  assert.equal(result.next_manifest.evidence.length, 1);
  assert.equal(result.evaluation.status, "pass");
  assert.equal(result.result.evidence.id, result.evidence.id);
  assert.equal(result.next_state.status, "completed");
  assert.deepEqual(result.write.artifacts.map((entry) => entry.path), ["evidence/manifest.json", "state.json", "report.json", "report.md"]);
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
  assert.equal(stale.evaluation.status, "block");
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
  const attached = await attachEvidence(started.runId, { cwd, gate: "verify-gate", file: bundlePath, kind: "trust.bundle" });
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
