import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeManagementFixtureAdapter,
  deploymentWindowFixtureAdapter,
  evaluateReleaseReadiness,
  freezeStateFixtureAdapter
} from "../../dist/index.js";
import { releaseReadinessFixture } from "./helpers/fixtures.mjs";

test("release readiness fixture adapters emit Surface-shaped evidence and preserve refs", async () => {
  const changeRecord = await releaseReadinessFixture("change-records/approved.json");
  const evidence = changeManagementFixtureAdapter(changeRecord, { subject: "kai-2026.06", gate_id: "release-readiness-gate", attached_at: "2026-06-07T20:00:00.000Z" });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].kind, "surface.claim");
  assert.equal(evidence[0].requested_kind, "surface.claim");
  assert.deepEqual(evidence[0].claim, {
    type: "release.change.approved",
    subject: "release:kai-2026.06",
    status: "trusted"
  });
  assert.equal(evidence[0].producer, "release-fixture/change-management");
  assert.deepEqual(evidence[0].authority_traces, ["fixture:change-management"]);
  assert.equal(evidence[0].trust_artifact.claims[0].type, "release.change.approved");
  assert.equal(evidence[0].external_links[0].url, "https://change.example.test/changes/CHG-1847");
  assert.equal(evidence[0].external_links[0].provider, "change-fixture");
  assert.equal(evidence[0].external_links[1].href, "https://change.example.test/provider/CHG-1847");
  assert.equal(evidence[0].external_links[1].url, "https://change.example.test/provider/CHG-1847");
  assert.equal(evidence[0].native_refs[0].id, "CHG-1847");
  assert.equal(evidence[0].native_refs[0].native_type, "change_record");
  assert.equal(evidence[0].native_refs[1].key, "CHG-1847-provider-view");
  assert.equal(evidence[0].native_refs[1].id, "CHG-1847-provider-view");
  assert.equal(evidence[0].native_refs.length, 2);
});

test("release readiness holds for pending or missing required approval and passes when risk lanes are satisfied", async () => {
  const policy = await releaseReadinessFixture("release-policy.json");
  const approvedChange = await releaseReadinessFixture("change-records/approved.json");
  const pendingChange = await releaseReadinessFixture("change-records/pending.json");
  const deploymentOpen = await releaseReadinessFixture("deployment-state/open.json");
  const freezeClear = await releaseReadinessFixture("freeze-state/clear.json");

  const pendingEvidence = changeManagementFixtureAdapter(pendingChange, { subject: "kai-2026.06" });
  const pending = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence: pendingEvidence
  });
  assert.equal(pending.decision, "hold");
  assert.equal(pending.lanes.find((lane) => lane.lane_id === "change-approval").status, "hold");

  const missing = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence: []
  });
  assert.equal(missing.decision, "hold");
  assert.equal(missing.lanes.find((lane) => lane.lane_id === "change-approval").status, "not_verified");

  const wrongAdapterEvidence = changeManagementFixtureAdapter(approvedChange, { subject: "kai-2026.06" }).map((entry) => ({
    ...entry,
    source_adapter_id: "fixture/not-change-management"
  }));
  const wrongAdapter = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence: wrongAdapterEvidence
  });
  assert.equal(wrongAdapter.decision, "hold");
  assert.equal(wrongAdapter.lanes.find((lane) => lane.lane_id === "change-approval").status, "not_verified");

  const satisfiedEvidence = [
    ...changeManagementFixtureAdapter(approvedChange, { subject: "kai-2026.06" }),
    ...deploymentWindowFixtureAdapter(deploymentOpen, { subject: "kai-2026.06" }),
    ...freezeStateFixtureAdapter(freezeClear, { subject: "kai-2026.06" })
  ];
  const passed = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "high",
    evidence: satisfiedEvidence
  });
  assert.equal(passed.decision, "pass");
  assert.deepEqual(passed.required_lanes, ["change-approval", "deployment-window", "freeze-state"]);
  assert.deepEqual(passed.lanes.filter((lane) => lane.required).map((lane) => lane.status), ["pass", "pass", "pass"]);
});

test("release readiness report data preserves external links and native refs", async () => {
  const policy = await releaseReadinessFixture("release-policy.json");
  const changeRecord = await releaseReadinessFixture("change-records/approved.json");
  const evidence = changeManagementFixtureAdapter(changeRecord, { subject: "kai-2026.06" });
  const result = evaluateReleaseReadiness(policy, {
    subject: "kai-2026.06",
    riskClass: "medium",
    evidence
  });

  assert.equal(result.decision, "pass");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").external_links[0].url, "https://change.example.test/changes/CHG-1847");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").external_links[0].provider, "change-fixture");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").external_links[1].href, "https://change.example.test/provider/CHG-1847");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").native_refs[0].id, "CHG-1847");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").native_refs[0].native_type, "change_record");
  assert.equal(result.lanes.find((lane) => lane.lane_id === "change-approval").native_refs[1].key, "CHG-1847-provider-view");
  assert.equal(result.report_data.external_links[0].url, "https://change.example.test/changes/CHG-1847");
  assert.equal(result.report_data.external_links[0].provider, "change-fixture");
  assert.equal(result.report_data.external_links[1].href, "https://change.example.test/provider/CHG-1847");
  assert.equal(result.report_data.native_refs[0].id, "CHG-1847");
  assert.equal(result.report_data.native_refs[0].native_type, "change_record");
  assert.equal(result.report_data.native_refs[1].key, "CHG-1847-provider-view");
});
