# Release Readiness

Release readiness is Flow's local-file-first contract for one question: **should this release proceed or hold?** It defines lane policy and a normalized result shape. It does not replace ServiceNow, Jira, PagerDuty, deployment systems, freeze calendars, or your release manager — it records why the decision was what it was, with the evidence attached.

## Lanes and policy

A release readiness policy ([`schemas/release-readiness-policy.schema.json`](../schemas/release-readiness-policy.schema.json)) describes:

- open lane ids such as `change-approval`, `deployment-window`, and `freeze-state`
- the `surface.claim` each lane requires
- open risk classes such as `medium` or `high`
- which lanes are required for each risk class

Lane and risk-class ids are open vocabularies — name the lanes your org actually has.

## Adapters: provider records become evidence

Fixture adapters map provider-shaped local JSON into Flow evidence — real claims, not opaque approval booleans. Each adapter emits `kind: "surface.claim"` evidence with `claim.type`, `claim.subject`, `claim.status`, `producer`, `authority_traces`, plus copied `external_links` and `native_refs` so the result still points at the systems of record:

```ts
import {
  changeManagementFixtureAdapter,
  deploymentWindowFixtureAdapter,
  freezeStateFixtureAdapter,
  evaluateReleaseReadiness
} from "@kontourai/flow";

const evidence = [
  ...changeManagementFixtureAdapter(changeRecord, { subject: "kai-2026.06" }),
  ...deploymentWindowFixtureAdapter(deploymentState, { subject: "kai-2026.06" }),
  ...freezeStateFixtureAdapter(freezeState, { subject: "kai-2026.06" })
];

const result = evaluateReleaseReadiness(policy, {
  subject: "kai-2026.06",
  riskClass: "high",
  evidence
});

console.log(result.decision); // "pass" | "hold"
```

Required lanes pass only when their claim satisfies the policy. Missing, pending, rejected, stale, untrusted, or authority-gap evidence returns `decision: "hold"`. The normalized result ([`schemas/release-readiness-result.schema.json`](../schemas/release-readiness-result.schema.json)) records the decision, risk class, required lanes, per-lane outcomes, evidence refs, `external_links`, and `native_refs` for later report rendering.

A complete working scenario — policy, provider records, and the equivalent Flow Definition expectation — ships with the package in [`examples/scenarios/release-readiness/`](../examples/scenarios/release-readiness/).

## Version release reports

The Version Release Report combines everything known about a versioned release into one deterministic artifact: changeset, Flow-shaped verification evidence, a release readiness result, accepted exceptions, accepted risks, `native_refs`, and `external_links`.

```sh
flow version-release-report examples/scenarios/version-release-report/complete.json --format markdown
flow version-release-report examples/scenarios/version-release-report/missing-required-evidence.json --format json
```

Missing required verification evidence or required release lanes become explicit `gaps` and force `decision: "hold"` — never a summarized "ready." Real output from the bundled missing-evidence fixture:

```text
# Version Release Report: kai-2026.06

- Decision: hold
- Summary: kai-2026.06 release held for missing evidence

## Release Evidence

- change-approval: pass required - Required change record approval satisfied
- deployment-window: not_verified required - Deployment window is open not satisfied
- freeze-state: pass required - Release freeze is clear satisfied

## Gaps

- verification_evidence ev.verify.schemas: required verification evidence ev.verify.schemas is missing
```

Embed the same projection from the library:

```ts
import {
  projectVersionReleaseReport,
  renderVersionReleaseReportMarkdown
} from "@kontourai/flow";

const report = projectVersionReleaseReport(fixtureJson);
console.log(renderVersionReleaseReportMarkdown(report));
```

The projected shape is described by [`schemas/version-release-report.schema.json`](../schemas/version-release-report.schema.json). Provider-native ids and URLs are preserved as data; Flow does not call hosted release portals or invent provider-specific semantics for this artifact.
