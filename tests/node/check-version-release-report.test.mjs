import assert from "node:assert/strict";
import { test } from "node:test";
import { FLOW_SCHEMA_VERSION, projectVersionReleaseReport, renderVersionReleaseReportMarkdown } from "../../dist/index.js";
import { clone, versionReleaseReportFixture } from "./helpers/fixtures.mjs";

test("version release report projects complete local fixtures and preserves refs", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  const report = projectVersionReleaseReport(input);

  assert.equal(report.schema_version, FLOW_SCHEMA_VERSION);
  assert.equal(report.decision, "ready");
  assert.equal(report.status, "ready");
  assert.equal(report.gaps.length, 0);
  assert.equal(report.changeset.length, 2);
  assert.equal(report.verification_evidence[0].kind, "trust.bundle");
  assert.equal(report.verification_evidence[0].bundle.claims[0].claimType, "quality.tests");
  assert.equal(report.release_evidence.decision, "pass");
  assert.deepEqual(report.release_evidence.required_lanes, ["change-approval", "deployment-window", "freeze-state"]);
  assert.deepEqual(report.release_evidence.lanes.filter((lane) => lane.required).map((lane) => lane.status), ["pass", "pass", "pass"]);
  assert.equal(report.exceptions[0].id, "ex.release.docs-late");
  assert.equal(report.accepted_risks[0].id, "risk.telemetry-delay");
  assert.ok(report.external_links.some((link) => link.url === "file://scenarios/version-release-report/release-notes.md"));
  assert.ok(report.external_links.some((link) => link.url === "https://change.example.test/changes/CHG-1847"));
  assert.ok(report.external_links.some((link) => link.url === "https://deploy.example.test/windows/production"));
  assert.ok(report.external_links.some((link) => link.url === "https://freeze.example.test/windows/freeze-2026-06"));
  assert.ok(report.native_refs.some((ref) => ref.system === "local-artifact" && ref.id === "release-notes"));
  assert.ok(report.native_refs.some((ref) => ref.system === "change-management-fixture" && ref.id === "CHG-1847"));
  assert.ok(report.native_refs.some((ref) => ref.system === "deployment-fixture" && ref.id === "production"));
  assert.ok(report.native_refs.some((ref) => ref.system === "freeze-fixture" && ref.id === "freeze-2026-06"));
  assert.equal(report.report_data.release_lane_statuses["change-approval"], "pass");
});

test("version release report holds when a required release lane is absent from lane outcomes", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  input.release_readiness.lanes = input.release_readiness.lanes.filter((lane) => lane.lane_id !== "deployment-window");
  input.release_readiness.decision = "pass";

  const report = projectVersionReleaseReport(input);

  assert.equal(report.decision, "hold");
  assert.ok(report.gaps.some((gap) => gap.kind === "release_lane" && gap.id === "deployment-window" && /absent/.test(gap.summary)));
});

test("version release report requires positive verification evidence claim status", async () => {
  const base = await versionReleaseReportFixture("complete.json");
  const rejectedStatuses = [
    { name: "pending", patch: { claim: { status: "pending" }, status: "passed" } },
    { name: "unknown", patch: { claim: {}, status: "unknown" } },
    { name: "untrusted", patch: { claim: { status: "untrusted" }, status: "passed" } },
    { name: "authority_gap", patch: { claim: { status: "authority_gap" }, status: "passed" } },
    { name: "omitted", patch: { claim: {}, status: undefined } }
  ];

  for (const { name, patch } of rejectedStatuses) {
    const input = clone(base);
    const entry = input.verification_evidence.find((candidate) => candidate.id === "ev.verify.tests");
    entry.claim = { type: "quality.tests", subject: "release:kai-2026.06", ...patch.claim };
    if (patch.status === undefined) delete entry.status;
    else entry.status = patch.status;

    const report = projectVersionReleaseReport(input);
    assert.equal(report.decision, "hold", name);
    assert.ok(report.gaps.some((gap) => gap.kind === "verification_evidence" && gap.id === "ev.verify.tests"), name);
    assert.ok(!report.report_data.satisfied_required_verification_evidence.includes("ev.verify.tests"), name);
  }
});

test("version release report fixtures include required gate evidence timestamps", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  const projected = projectVersionReleaseReport(input);

  assert.ok(projected.verification_evidence.every((entry) => typeof entry.attached_at === "string"));
  assert.ok(projected.release_evidence.evidence.every((entry) => typeof entry.attached_at === "string"));
});

test("version release report gap semantics hold for missing verification and release lanes", async () => {
  const input = await versionReleaseReportFixture("missing-required-evidence.json");
  const report = projectVersionReleaseReport(input);
  const markdown = renderVersionReleaseReportMarkdown(report);

  assert.equal(report.decision, "hold");
  assert.equal(report.status, "hold");
  assert.ok(report.gaps.some((gap) => gap.kind === "verification_evidence" && gap.id === "ev.verify.schemas"));
  assert.ok(report.gaps.some((gap) => gap.kind === "release_lane" && gap.id === "deployment-window"));
  assert.equal(report.report_data.release_lane_statuses["deployment-window"], "not_verified");
  assert.match(markdown, /## Gaps/);
  assert.match(markdown, /ev\.verify\.schemas/);
  assert.match(markdown, /deployment-window/);
});

test("version release report Markdown escapes controlled text and blocks unsafe link schemes", async () => {
  const input = await versionReleaseReportFixture("complete.json");
  input.version.id = "kai<script>";
  input.subject = "release[bad](javascript:alert(1))";
  input.summary = "**owned** <img src=x onerror=alert(1)>";
  input.changeset[0].summary = "[click](javascript:alert(1)) <b>raw</b>";
  input.external_links = [
    { label: "unsafe link", url: "javascript:alert(1)" },
    { label: "safe", url: "https://example.test/release" }
  ];
  input.native_refs = [
    { system: "tracker", id: "ISSUE-17", url: "data:text/html,<script>alert(1)</script>" }
  ];

  const markdown = renderVersionReleaseReportMarkdown(projectVersionReleaseReport(input));

  assert.doesNotMatch(markdown, /<script>|<img|<b>raw<\/b>/);
  assert.doesNotMatch(markdown, /\[click\]\(javascript:alert\(1\)\)/);
  assert.doesNotMatch(markdown, /data:text\/html/);
  assert.match(markdown, /&lt;script&gt;/);
  assert.match(markdown, /\[blocked-url\]/);
  assert.match(markdown, /https:\/\/example\.test\/release/);
});
