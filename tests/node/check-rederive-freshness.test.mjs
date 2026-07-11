/**
 * Flow follow-up §1 — re-derive instead of caching bundle_report.
 *
 * A freshness-bearing claim derives `verified` at T0 and `stale` at a later T1
 * across two re-derivations with different `now`. Proves:
 *  - the stored bundle_report is the LIVE report (re-derived), not a cache;
 *  - an append-only inquiry-record series is kept (one per re-derivation);
 *  - a fresh->stale freshness transition is emitted by the second pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reDeriveBundleReports } from "../../dist/index.js";

const T0 = "2026-06-10T00:00:00.000Z";
const EXPIRES = "2026-06-15T00:00:00.000Z";
const T1 = "2026-06-20T00:00:00.000Z";

function freshnessBearingManifest() {
  return {
    schema_version: "1",
    evidence: [
      {
        id: "ev.1",
        gate_id: "verify-gate",
        kind: "trust.bundle",
        requested_kind: "trust.bundle",
        status: "passed",
        bundle: {
          schemaVersion: 5,
          source: "test/freshness",
          claims: [
            {
              id: "claim.window",
              subjectType: "flow-step",
              subjectId: "verify",
              facet: "quality.tests",
              claimType: "quality.tests",
              fieldOrBehavior: "testsPass",
              value: true,
              createdAt: T0,
              updatedAt: T0,
              expiresAt: EXPIRES,
              verificationPolicyId: "policy.manual"
            }
          ],
          evidence: [
            {
              id: "evidence.window",
              claimId: "claim.window",
              evidenceType: "test_output",
              method: "validation",
              sourceRef: "ci:1",
              excerptOrSummary: "tests passed",
              observedAt: T0,
              collectedBy: "ci"
            }
          ],
          policies: [
            {
              id: "policy.manual",
              claimType: "quality.tests",
              requiredEvidence: ["test_output"],
              requiredMethods: ["validation"],
              requiresCorroboration: false,
              acceptanceCriteria: ["tests pass"],
              reviewAuthority: "ci",
              validityRule: { kind: "manual" },
              stalenessTriggers: ["window expires"],
              conflictRules: [],
              impactLevel: "high"
            }
          ],
          events: [
            {
              id: "event.window.verified",
              claimId: "claim.window",
              status: "verified",
              actor: "ci",
              method: "validation",
              evidenceIds: ["evidence.window"],
              createdAt: T0,
              verifiedAt: T0
            }
          ]
        }
      }
    ]
  };
}

function statusOf(manifest) {
  return manifest.evidence[0].bundle_report.claims.find((c) => c.id === "claim.window").status;
}

test("re-derive yields verified at T0 and stale at T1 (live, not cached)", () => {
  const manifest = freshnessBearingManifest();

  const t0Transitions = reDeriveBundleReports(manifest, new Date(T0));
  assert.equal(statusOf(manifest), "verified", "fresh at T0");
  assert.equal(t0Transitions.length, 0, "no transition on first derivation");
  assert.equal(manifest.evidence[0].inquiry_records.length, 1, "one inquiry record after first pass");

  const t1Transitions = reDeriveBundleReports(manifest, new Date(T1));
  assert.equal(statusOf(manifest), "stale", "stale at T1 (re-derived, not cached)");
  assert.equal(manifest.evidence[0].inquiry_records.length, 2, "inquiry records are append-only");

  // The second pass observes the fresh->stale flip and emits a transition.
  assert.equal(t1Transitions.length, 1, "one freshness transition at T1");
  assert.equal(t1Transitions[0].evidence_id, "ev.1");
  assert.equal(t1Transitions[0].claimId, "claim.window");
  assert.equal(t1Transitions[0].from, "fresh");
  assert.equal(t1Transitions[0].to, "stale");
});

test("unsupported leap seconds clear cached reports and preserve the raw bundle", () => {
  const manifest = freshnessBearingManifest();
  const leapSecond = "2016-12-31t23:59:60.000z";
  reDeriveBundleReports(manifest, new Date(T0));
  assert.equal(statusOf(manifest), "verified", "the valid bundle starts with a cached report");

  manifest.evidence[0].bundle.claims[0].expiresAt = leapSecond;
  const transitions = reDeriveBundleReports(manifest, new Date(T1));
  assert.equal(manifest.evidence[0].bundle_report, null, "an unsupported leap second cannot leave an accepted cached report");
  assert.equal(manifest.evidence[0].bundle.claims[0].expiresAt, leapSecond, "raw leap-second input remains unchanged");
  assert.deepEqual(transitions, []);
});

test("inquiry records pin statusFunctionVersion and an asOf", () => {
  const manifest = freshnessBearingManifest();
  reDeriveBundleReports(manifest, new Date(T0));
  const record = manifest.evidence[0].inquiry_records[0];
  assert.equal(record.statusFunctionVersion, "2");
  assert.ok(typeof record.asOf === "string" && record.asOf.length > 0);
  assert.equal(record.statusByClaimId["claim.window"], "verified");
});

test("legacy bundle with no freshness fields re-derives identically (no transition)", () => {
  const manifest = freshnessBearingManifest();
  // Strip the freshness field to make it a legacy (schema 3) bundle.
  delete manifest.evidence[0].bundle.claims[0].expiresAt;
  manifest.evidence[0].bundle.schemaVersion = 3;

  reDeriveBundleReports(manifest, new Date(T0));
  const a = statusOf(manifest);
  const transitions = reDeriveBundleReports(manifest, new Date(T1));
  const b = statusOf(manifest);
  assert.equal(a, b, "legacy bundle status is time-invariant");
  assert.equal(transitions.length, 0, "no freshness transition for a legacy bundle");
});
