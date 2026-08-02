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

test("canonical re-derivation keeps a fractional duration-policy checkpoint and transition exact", () => {
  const manifest = freshnessBearingManifest();
  const bundle = manifest.evidence[0].bundle;
  delete bundle.claims[0].expiresAt;
  bundle.claims[0].createdAt = "2026-06-15T00:00:00.00005Z";
  bundle.claims[0].updatedAt = "2026-06-15T00:00:00.00005Z";
  bundle.evidence[0].observedAt = "2026-06-15T00:00:00.00005Z";
  bundle.events[0].createdAt = "2026-06-15T00:00:00.00005Z";
  bundle.events[0].verifiedAt = "2026-06-15T00:00:00.00005Z";
  bundle.policies[0].validityRule = { kind: "duration", durationDays: 1 };

  const freshAt = "2026-06-16T00:00:00.00004Z";
  const staleAt = "2026-06-16T00:00:00.0001Z";
  reDeriveBundleReports(manifest, freshAt);
  assert.equal(statusOf(manifest), "verified");
  assert.equal(manifest.evidence[0].inquiry_records.at(-1).asOf, freshAt);

  const transitions = reDeriveBundleReports(manifest, staleAt);
  assert.equal(statusOf(manifest), "stale", "the canonical report becomes stale after the exact duration boundary even though Date rounds both instants to the same millisecond");
  assert.equal(manifest.evidence[0].bundle_report.generatedAt, staleAt);
  assert.equal(manifest.evidence[0].bundle_report.claims[0].freshness.expiresAt, "2026-06-16T00:00:00.00005Z");
  assert.equal(manifest.evidence[0].inquiry_records.at(-1).asOf, staleAt);
  assert.equal(manifest.evidence[0].inquiry_records.at(-1).expiresAtByClaimId["claim.window"], "2026-06-16T00:00:00.00005Z");
  assert.deepEqual(transitions.map(({ claimId, from, to }) => ({ claimId, from, to })), [{ claimId: "claim.window", from: "fresh", to: "stale" }]);

  const repeated = "2026-06-16T00:00:01.0001Z";
  assert.deepEqual(reDeriveBundleReports(manifest, repeated), [], "a later already-stale derivation does not invent a second transition");
  assert.equal(manifest.evidence[0].bundle_report.claims[0].freshness.expiresAt, "2026-06-16T00:00:00.00005Z", "the exact duration expiry survives a stale checkpoint short-circuit");
  assert.equal(manifest.evidence[0].inquiry_records.at(-1).expiresAtByClaimId["claim.window"], "2026-06-16T00:00:00.00005Z");
});

test("canonical re-derivation preserves fractional TTL expiry after the first stale report", () => {
  const manifest = freshnessBearingManifest();
  const bundle = manifest.evidence[0].bundle;
  delete bundle.claims[0].expiresAt;
  bundle.claims[0].ttlSeconds = 1;
  bundle.claims[0].createdAt = "2026-06-15T00:00:00.00005Z";
  bundle.claims[0].updatedAt = "2026-06-15T00:00:00.00005Z";
  bundle.evidence[0].observedAt = "2026-06-15T00:00:00.00005Z";
  bundle.events[0].createdAt = "2026-06-15T00:00:00.00005Z";
  bundle.events[0].verifiedAt = "2026-06-15T00:00:00.00005Z";

  const firstStale = "2026-06-15T00:00:01.0001Z";
  reDeriveBundleReports(manifest, firstStale);
  assert.equal(statusOf(manifest), "stale");
  assert.equal(manifest.evidence[0].bundle_report.claims[0].freshness.expiresAt, "2026-06-15T00:00:01.00005Z");

  reDeriveBundleReports(manifest, "2026-06-15T00:00:00.002Z");
  assert.equal(manifest.evidence[0].bundle_report.claims[0].freshness.expiresAt, "2026-06-15T00:00:01.00005Z");
  assert.equal(manifest.evidence[0].inquiry_records.at(-1).expiresAtByClaimId["claim.window"], "2026-06-15T00:00:01.00005Z");
});

test("exact stale base claim reapplies Surface's public derivation ceiling and projections", () => {
  const manifest = freshnessBearingManifest();
  const bundle = manifest.evidence[0].bundle;
  bundle.claims[0].expiresAt = "2026-06-15T00:00:00.00005Z";
  bundle.claims.push({
    ...structuredClone(bundle.claims[0]),
    id: "claim.derived",
    fieldOrBehavior: "derivedTestsPass",
    derivedFrom: ["claim.window"],
    expiresAt: undefined
  });
  bundle.evidence.push({
    ...structuredClone(bundle.evidence[0]),
    id: "evidence.derived",
    claimId: "claim.derived"
  });
  bundle.events.push({
    ...structuredClone(bundle.events[0]),
    id: "event.derived.verified",
    claimId: "claim.derived"
  });

  reDeriveBundleReports(manifest, "2026-06-15T00:00:00.0001Z");
  const report = manifest.evidence[0].bundle_report;
  assert.equal(report.claims.find((claim) => claim.id === "claim.window").status, "stale");
  assert.equal(report.claims.find((claim) => claim.id === "claim.derived").status, "stale", "a derived claim cannot remain verified above an exactly stale base");
  assert.ok(report.transparencyGaps.some((gap) => gap.id === "claim.window.gap.freshness-breach" && gap.type === "freshness_breach"));
  assert.ok(report.changeRecords.some((record) => record.claimId === "claim.derived" && record.reason === "input-stale"));
  assert.deepEqual(report.summary.staleClaims.sort(), ["claim.derived", "claim.window"]);

  reDeriveBundleReports(manifest, "2026-06-15T00:00:01.0001Z");
  const repeated = manifest.evidence[0].bundle_report;
  assert.equal(repeated.claims.find((claim) => claim.id === "claim.derived").status, "stale");
  assert.equal(repeated.transparencyGaps.filter((gap) => gap.id === "claim.window.gap.freshness-breach").length, 1, "the exact freshness gap is stable and deduplicated across re-derivations");
});

test("future non-verified facts persist as unknown rather than a trusted-looking Surface status", () => {
  const manifest = freshnessBearingManifest();
  const bundle = manifest.evidence[0].bundle;
  bundle.events[0].status = "assumed";
  bundle.claims[0].createdAt = "2026-06-10T00:00:00.0001Z";
  bundle.claims[0].updatedAt = "2026-06-10T00:00:00.0001Z";
  bundle.evidence[0].observedAt = "2026-06-10T00:00:00.0001Z";
  bundle.events[0].createdAt = "2026-06-10T00:00:00.0001Z";
  delete bundle.events[0].verifiedAt;
  reDeriveBundleReports(manifest, T0);
  assert.equal(statusOf(manifest), "unknown");
  assert.equal(manifest.evidence[0].inquiry_records.at(-1).statusByClaimId["claim.window"], "unknown");

  reDeriveBundleReports(manifest, "2026-06-10T00:00:00.001Z");
  assert.equal(statusOf(manifest), "assumed", "the full refold after future facts become current must recover Surface's assumed status");
  assert.equal(manifest.evidence[0].inquiry_records.at(-1).statusByClaimId["claim.window"], "assumed", "the recovery checkpoint records the newly current canonical status");
});

test("canonical re-derivation snapshots an access-varying bundle before raw budgeting and validation", () => {
  const manifest = freshnessBearingManifest();
  const accepted = manifest.evidence[0].bundle;
  let reads = 0;
  Object.defineProperty(manifest.evidence[0], "bundle", {
    enumerable: true,
    get() {
      reads += 1;
      return reads === 1 ? accepted : { ...accepted, policies: new Array(100_000) };
    }
  });
  reDeriveBundleReports(manifest, T0);
  assert.equal(reads, 1, "one immutable snapshot feeds canonical raw budget, validation, and derivation");
  assert.equal(statusOf(manifest), "verified");
});

test("event-driven stale retains exact intrinsic TTL expiry without Flow inventing a freshness breach", () => {
  const manifest = freshnessBearingManifest();
  const bundle = manifest.evidence[0].bundle;
  delete bundle.claims[0].expiresAt;
  bundle.claims[0].ttlSeconds = 1;
  bundle.claims[0].createdAt = "2026-06-15T00:00:00.00005Z";
  bundle.claims[0].updatedAt = "2026-06-15T00:00:00.00005Z";
  bundle.evidence[0].observedAt = "2026-06-15T00:00:00.00005Z";
  bundle.events[0].createdAt = "2026-06-15T00:00:00.00005Z";
  bundle.events[0].verifiedAt = "2026-06-15T00:00:00.00005Z";
  bundle.events.push({
    id: "event.window.revoked",
    claimId: "claim.window",
    type: "invalidation",
    status: "stale",
    actor: "ci",
    method: "validation",
    evidenceIds: ["evidence.window"],
    createdAt: "2026-06-15T00:00:00.001Z"
  });

  reDeriveBundleReports(manifest, "2026-06-15T00:00:00.0025Z");
  const report = manifest.evidence[0].bundle_report;
  assert.equal(report.claims[0].status, "stale");
  assert.equal(report.claims[0].freshness.expiresAt, "2026-06-15T00:00:01.00005Z");
  assert.equal(
    report.transparencyGaps.find((gap) => gap.id === "claim.window.gap.freshness-breach")?.createdAt,
    "2026-06-15T00:00:00.002Z",
    "Surface emits its normal stale gap; Flow must not replace it with an exact-time freshness projection for event-driven stale"
  );
});

test("exact freshness projection preserves evidence-authored gap ids that collide with canonical gaps", () => {
  const manifest = freshnessBearingManifest();
  const bundle = manifest.evidence[0].bundle;
  bundle.claims[0].expiresAt = "2026-06-15T00:00:00.00005Z";
  bundle.evidence[0].metadata = {
    transparencyGapHints: [{
      id: "claim.window.gap.freshness-breach",
      type: "contradiction",
      message: "producer evidence intentionally reuses the canonical-looking id"
    }]
  };
  reDeriveBundleReports(manifest, "2026-06-15T00:00:00.0001Z");
  const colliding = manifest.evidence[0].bundle_report.transparencyGaps
    .filter((gap) => gap.id === "claim.window.gap.freshness-breach");
  assert.equal(colliding.length, 2, "cross-provenance records must not overwrite each other merely because their ids collide");
  assert.ok(colliding.some((gap) => gap.metadata?.source === "evidence.metadata.transparencyGapHints"));
  assert.ok(colliding.some((gap) => gap.metadata?.source === "flow.exact-freshness"));
});

test("ordinary re-derivation preserves distinct evidence hints that reuse an id", () => {
  const manifest = freshnessBearingManifest();
  manifest.evidence[0].bundle.evidence[0].metadata = {
    transparencyGapHints: [
      { id: "evidence.duplicate-hint", type: "contradiction", message: "first authored observation" },
      { id: "evidence.duplicate-hint", type: "contradiction", message: "second authored observation" }
    ]
  };
  reDeriveBundleReports(manifest, T0);
  const hints = manifest.evidence[0].bundle_report.transparencyGaps
    .filter((gap) => gap.id === "evidence.duplicate-hint" && gap.metadata?.source === "evidence.metadata.transparencyGapHints");
  assert.deepEqual(hints.map((gap) => gap.message), ["first authored observation", "second authored observation"]);
});

test("exact status correction recomputes Surface conflict gaps and summary", () => {
  const manifest = freshnessBearingManifest();
  const bundle = manifest.evidence[0].bundle;
  bundle.claims[0].expiresAt = "2026-06-15T00:00:00.00005Z";
  bundle.policies[0].incompatibleStatuses = [{ statuses: ["verified", "stale"], message: "fresh and stale conflict" }];
  bundle.evidence[0].metadata = {
    transparencyGapHints: [{
      id: "evidence-authored-contradiction",
      type: "contradiction",
      message: "producer-recorded contradiction must remain visible"
    }]
  };
  bundle.claims.push({
    ...structuredClone(bundle.claims[0]),
    id: "claim.conflict-peer",
    fieldOrBehavior: "peerTestsPass",
    expiresAt: undefined
  });
  bundle.evidence.push({ ...structuredClone(bundle.evidence[0]), id: "evidence.conflict-peer", claimId: "claim.conflict-peer", metadata: undefined });
  bundle.events.push({
    ...structuredClone(bundle.events[0]),
    id: "event.conflict-peer.stale",
    claimId: "claim.conflict-peer",
    status: "stale",
    verifiedAt: undefined
  });

  reDeriveBundleReports(manifest, "2026-06-15T00:00:00.0001Z");
  const report = manifest.evidence[0].bundle_report;
  assert.equal(report.claims.find((claim) => claim.id === "claim.window").status, "stale");
  assert.equal(report.claims.find((claim) => claim.id === "claim.conflict-peer").status, "stale");
  assert.equal(report.transparencyGaps.some((gap) => gap.type === "contradiction" && ["policy.incompatibleValues", "policy.incompatibleStatuses"].includes(gap.metadata?.source)), false, "the stale Surface policy contradiction is removed after exact correction");
  assert.ok(report.transparencyGaps.some((gap) => gap.id === "evidence-authored-contradiction" && gap.metadata?.source === "evidence.metadata.transparencyGapHints"), "evidence-authored contradiction hints survive policy-conflict recomputation");
  assert.equal(report.summary.transparencyGapsByType.contradiction, 1);
});
