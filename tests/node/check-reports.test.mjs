import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyEvaluation,
  evaluateGate,
  FLOW_SCHEMA_VERSION,
  initialState,
  markdownText,
  renderMarkdownReport,
  renderResume,
  renderSummary,
  reportJson
} from "../../dist/index.js";
import { failedEvidence, routeBackDefinition, routeBackManifest } from "./helpers/route-back-fixtures.mjs";

test("reports, summary, and resume expose route-back metadata", () => {
  const definition = routeBackDefinition({
    route_back_policy: { max_attempts: 1, on_exceeded: "recover" }
  });
  const state = initialState(definition, "report-route-back", { subject: "route report" });
  state.current_step = "verify";
  state.transitions = [
    { type: "route_back", gate_id: "verify-gate", route_reason: "implementation_defect", from_step: "verify", to_step: "implement", status: "blocked", reason: "implementation_defect", at: "2026-05-26T00:00:00.000Z" }
  ];
  const manifest = routeBackManifest([
    failedEvidence({
      id: "ev.report",
      route_reason: "implementation_defect",
      expectation_ids: ["tests-passed"],
      classifier: { kind: "rule", source: "smoke", confidence: 0.9 },
      diagnostics: { failing_command: "npm test" },
      analytics: { loop_key: "verify:implementation_defect" }
    })
  ]);
  const outcome = evaluateGate(definition, state, manifest, "verify-gate");
  applyEvaluation(definition, state, outcome);

  const report = reportJson(definition, state, manifest);
  const gate = report.gate_summaries.find((entry) => entry.gate_id === "verify-gate");
  const transition = state.transitions.at(-1);
  assert.equal(transition.route_reason, "implementation_defect");
  assert.equal(transition.selected_route, "implement");
  assert.equal(transition.to_step, "recover");
  assert.equal(transition.recovery_step, "recover");
  assert.equal(transition.attempt, 2);
  assert.equal(transition.max_attempts, 1);
  assert.equal(transition.limit_exceeded, true);
  assert.deepEqual(transition.evidence_refs, ["ev.report"]);
  assert.deepEqual(transition.expectation_ids, ["tests-passed"]);
  assert.deepEqual(transition.classifier, { kind: "rule", source: "smoke", confidence: 0.9 });
  assert.deepEqual(transition.diagnostics, { failing_command: "npm test" });
  assert.equal(transition.analytics.loop_key, "verify:implementation_defect");
  assert.equal(transition.analytics_loop_key, "verify:implementation_defect");
  assert.equal(gate.route_reason, "implementation_defect");
  assert.equal(gate.selected_route, "implement");
  assert.equal(gate.route_back_to, "recover");
  assert.equal(gate.recovery_step, "recover");
  assert.equal(gate.attempt, 2);
  assert.equal(gate.max_attempts, 1);
  assert.equal(gate.limit_exceeded, true);
  assert.deepEqual(gate.evidence_refs, ["ev.report"]);
  assert.deepEqual(gate.expectation_ids, ["tests-passed"]);
  assert.deepEqual(gate.classifier, { kind: "rule", source: "smoke", confidence: 0.9 });
  assert.deepEqual(gate.diagnostics, { failing_command: "npm test" });
  assert.equal(gate.analytics.loop_key, "verify:implementation_defect");
  assert.equal(gate.analytics_loop_key, "verify:implementation_defect");

  const markdown = renderMarkdownReport(definition, state, manifest);
  assert.match(markdown, /Route back: implementation_defect -> recover \(attempt 2\/1, limit exceeded: yes\)/);
  assert.match(markdown, /Selected route: implement/);
  assert.match(markdown, /Recovery step: recover/);
  assert.match(markdown, /Analytics loop: verify:implementation_defect/);

  const summary = renderSummary(definition, state);
  assert.match(summary, /route: implementation_defect -> recover; attempt 2\/1; limit exceeded: yes/);
  assert.match(summary, /recovery: recover/);
  assert.match(summary, /analytics loop: verify:implementation_defect/);

  const resume = renderResume(definition, state);
  assert.match(resume, /route backs: verify-gate implementation_defect -> recover attempt 2\/1, limit exceeded yes, recovery recover/);
});

test("Flow Markdown report escapes inline run data and normalizes line breaks", () => {
  const definition = {
    id: "report-<definition>",
    version: "1",
    steps: [{ id: "verify", next: null }],
    gates: {
      "verify-gate": {
        step: "verify",
        expects: [
          {
            id: "tests-passed",
            kind: "trust.bundle",
            required: true,
            description: "Tests passed.",
            bundle_claim: { claimType: "quality.tests" }
          }
        ]
      }
    }
  };
  const state = {
    schema_version: FLOW_SCHEMA_VERSION,
    run_id: "run-<script>",
    definition_id: definition.id,
    definition_version: definition.version,
    subject: "ok\n# injected <script>",
    status: "active",
    current_step: "verify",
    params: {},
    gate_outcomes: [
      {
        gate_id: "verify-gate",
        status: "block",
        summary: "missing <b>evidence</b>\n## injected",
        missing: ["tests-passed"],
        optional_missing: [],
        evidence_refs: ["ev.<bad>\n- injected"]
      }
    ],
    transitions: [],
    exceptions: [
      {
        gate_id: "verify-gate",
        reason: "human\n# injected",
        authority: "<owner>"
      }
    ],
    next_action: "attach evidence\n# injected",
    updated_at: "2026-06-09T00:00:00.000Z"
  };
  const manifest = {
    schema_version: FLOW_SCHEMA_VERSION,
    evidence: [
      {
        id: "ev.<bad>\n- injected",
        gate_id: "verify-gate",
        kind: "file\n# injected",
        sha256: "<sha>"
      }
    ]
  };

  const markdown = renderMarkdownReport(definition, state, manifest);
  assert.equal(markdownText("ok\r\n# injected <script>"), "ok # injected &lt;script&gt;");
  assert.match(markdown, /Subject: ok # injected &lt;script&gt;/);
  assert.match(markdown, /Next action: attach evidence # injected/);
  assert.match(markdown, /missing &lt;b&gt;evidence&lt;\/b&gt; ## injected/);
  assert.match(markdown, /Evidence: ev\.&lt;bad&gt; - injected/);
  assert.doesNotMatch(markdown, /^# injected/m);
  assert.doesNotMatch(markdown, /^## injected/m);
  assert.doesNotMatch(markdown, /<script>|<b>evidence<\/b>|<owner>|<sha>/);
});
