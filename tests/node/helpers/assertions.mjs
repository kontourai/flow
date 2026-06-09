import assert from "node:assert/strict";
import { FLOW_SCHEMA_VERSION } from "../../../dist/index.js";

export function requireSchemaFields(schema, fields) {
  for (const field of fields) {
    assert.ok(schema.required.includes(field), `${schema.title} must require ${field}`);
    assert.ok(schema.properties[field], `${schema.title} must define ${field}`);
  }
}

export function requireSchemaDefFields(schema, defName, fields) {
  const def = schema.$defs[defName];
  assert.ok(def, `${schema.title} must define ${defName}`);
  for (const field of fields) {
    assert.ok(def.required.includes(field), `${schema.title} ${defName} must require ${field}`);
    assert.ok(def.properties[field], `${schema.title} ${defName} must define ${field}`);
  }
}

export function assertSurfaceClaimManifestShape(manifest, file, schemaVersion = FLOW_SCHEMA_VERSION) {
  assert.equal(manifest.schema_version, schemaVersion, `${file} schema_version`);
  assert.ok(Array.isArray(manifest.evidence), `${file} evidence must be an array`);
  for (const entry of manifest.evidence) {
    assert.equal(entry.gate_id, "verify-gate", `${file} gate_id`);
    assert.equal(entry.kind, "surface.claim", `${file} kind`);
    assert.equal(entry.requested_kind, "surface.claim", `${file} requested_kind`);
    assert.ok(["passed", "failed", "unknown"].includes(entry.status), `${file} status`);
    assert.match(entry.attached_at, /^\d{4}-\d{2}-\d{2}T/, `${file} attached_at`);
    assert.equal(entry.claim?.type, "quality.tests", `${file} claim.type`);
    assert.ok(entry.claim?.status, `${file} claim.status`);
    assert.ok(entry.trust_artifact, `${file} trust_artifact`);
    assert.equal(entry.trust_artifact.schema_version, schemaVersion, `${file} trust_artifact.schema_version`);
    assert.ok(["trust-report", "trust-snapshot"].includes(entry.trust_artifact.artifact_type), `${file} artifact_type`);
    assert.ok(Array.isArray(entry.trust_artifact.claims), `${file} trust_artifact.claims`);
    assert.ok(entry.trust_artifact.claims.length > 0, `${file} trust_artifact.claims length`);
    for (const claim of entry.trust_artifact.claims) {
      assert.equal(claim.type, "quality.tests", `${file} trust_artifact claim.type`);
      const allowed = new Set(["type", "subject", "status", "producer", "issued_at", "expires_at", "authority_traces"]);
      assert.deepEqual(Object.keys(claim).filter((key) => !allowed.has(key)), [], `${file} trust_artifact claim has neutral fields`);
    }
  }
}
