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

export function assertTrustBundleManifestShape(manifest, file, schemaVersion = FLOW_SCHEMA_VERSION) {
  assert.equal(manifest.schema_version, schemaVersion, `${file} schema_version`);
  assert.ok(Array.isArray(manifest.evidence), `${file} evidence must be an array`);
  for (const entry of manifest.evidence) {
    assert.equal(entry.gate_id, "verify-gate", `${file} gate_id`);
    assert.equal(entry.kind, "trust.bundle", `${file} kind`);
    assert.equal(entry.requested_kind, "trust.bundle", `${file} requested_kind`);
    assert.ok(["passed", "failed", "unknown"].includes(entry.status), `${file} status`);
    assert.match(entry.attached_at, /^\d{4}-\d{2}-\d{2}T/, `${file} attached_at`);
    assert.ok(entry.bundle, `${file} bundle must be present`);
    assert.ok([2, 3].includes(entry.bundle.schemaVersion), `${file} bundle.schemaVersion must be 2 or 3`);
    assert.ok(typeof entry.bundle.source === "string", `${file} bundle.source`);
    assert.ok(Array.isArray(entry.bundle.claims), `${file} bundle.claims`);
    assert.ok(Array.isArray(entry.bundle.evidence), `${file} bundle.evidence`);
    assert.ok(Array.isArray(entry.bundle.policies), `${file} bundle.policies`);
    assert.ok(Array.isArray(entry.bundle.events), `${file} bundle.events`);
  }
}

// Keep the old name as an alias for now, in case any test still imports it
export { assertTrustBundleManifestShape as assertSurfaceClaimManifestShape };
