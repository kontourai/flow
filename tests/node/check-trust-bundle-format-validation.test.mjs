import assert from "node:assert/strict";
import { test } from "node:test";
import { validateTrustBundleSchema } from "../../dist/gates/trust-bundle-validator.js";

// Regression for #183: the validator's Ajv instance had no ajv-formats
// registered, so every `format: "date-time"` in the Hachure schema logged
// an "unknown format ... ignored" warning AND was silently not validated.

function bundle(overrides = {}) {
  const id = "claim.review";
  return {
    schemaVersion: 7, source: "test/format-validation",
    claims: [{
      id, subjectType: "flow-step", subjectId: "verify", facet: "quality.review",
      claimType: "quality.review", fieldOrBehavior: "review", value: "accepted",
      createdAt: "2026-07-19T15:00:00.000Z", updatedAt: "2026-07-19T15:00:00.000Z",
      ...overrides
    }],
    evidence: [], policies: [],
    events: [{ id: `event.${id}`, claimId: id, status: "verified", actor: "test/reviewer", method: "review", evidenceIds: [], createdAt: "2026-07-19T15:30:00.000Z", verifiedAt: "2026-07-19T15:30:00.000Z" }]
  };
}

test("schema validation emits no unknown-format warnings and accepts a valid bundle", () => {
  const warnings = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => warnings.push(args.join(" "));
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    const result = validateTrustBundleSchema(bundle());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  const formatWarnings = warnings.filter((w) => w.includes("unknown format"));
  assert.deepEqual(formatWarnings, [], "no unknown-format warnings expected");
});

test("malformed date-time timestamps are rejected, not silently ignored", () => {
  const result = validateTrustBundleSchema(bundle({ createdAt: "yesterday-ish" }));
  assert.equal(result.valid, false, "malformed createdAt must fail format validation");
  assert.ok(
    result.errors.some((e) => e.includes("date-time") || e.includes("format")),
    `expected a date-time format error, got: ${JSON.stringify(result.errors)}`
  );
});
