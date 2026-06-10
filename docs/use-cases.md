# Use Cases

Flow is small on purpose: it records the required path, the evidence each gate expected, and why work was allowed to advance. That one contract shows up in very different teams. Each scenario below is buildable with Flow v0.1 as shipped — the definitions and commands are real, and the bundled examples referenced here are published with the npm package.

## 1. Guardrails for AI coding agents

**Who:** a product team running Claude Code, Codex, or Kiro agents on real feature work.

**The pain:** the agent plans well, then quietly skips verification when context gets long. It reports "all tests pass" after running half the suite. After a compaction or a new session, it forgets there was a plan at all. Nobody can reconstruct why a change was published.

**With Flow:** the team starts a run per work item using the bundled `agent-dev-flow` definition (`plan → implement → verify → publish`). The agent's harness — or the engineer driving it — attaches evidence at each gate and calls `flow evaluate` before advancing:

```sh
flow start .flow/definitions/agent-dev-flow.json --run-id feat-2104 --params subject=checkout-retry
flow attach-evidence feat-2104 --gate plan-gate --file ./acceptance-claim.json --trust-artifact
flow evaluate feat-2104
```

When the test run fails, the failure routes back to `implement` with an attempt budget instead of looping silently:

```text
route-back verify-gate: verify gate has failing evidence
current step: implement
next action: return to implement and replace failing evidence attempt 1/3
```

When a fresh session picks up the work — a new agent, a new engineer, or tomorrow — `flow resume feat-2104` reconstructs the exact state from files, not chat memory.

**What they get:** agents that cannot silently skip required gates, failed verification that appears as a blocked gate instead of a confident summary, and handoff that survives context loss. The [Agent Hooks guide](agent-hooks.md) has copyable Claude Code and CI recipes that enforce this with a five-line shell script.

## 2. Release decisions in a regulated environment

**Who:** a release manager at a fintech or healthcare company where every production release needs change approval, an open deployment window, and a clear freeze calendar.

**The pain:** the *facts* live in ServiceNow, the deployment calendar, and the freeze spreadsheet — but the *decision* lives in someone's head. "Why did this release proceed during freeze week?" has no inspectable answer.

**With Flow:** the team authors a release readiness policy (`schemas/release-readiness-policy.schema.json`) naming the required lanes per risk class — `change-approval`, `deployment-window`, `freeze-state` — and maps provider records into Flow evidence with adapters:

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
// result.decision: "pass" | "hold", with per-lane outcomes and evidence refs
```

Required lanes pass only when their claim satisfies the policy; missing, pending, rejected, stale, or untrusted lane evidence returns `decision: "hold"` — never a shrug. Adapters preserve provider-native ids and URLs as `native_refs` and `external_links`, so the decision record points back at the systems of record. Flow does not replace ServiceNow, PagerDuty, or the release manager; it records why the release was allowed to proceed or made to hold.

**What they get:** an inspectable, replayable release decision per version. See `examples/scenarios/release-readiness/` and the [Release Readiness guide](release-readiness.md).

## 3. Golden paths on an internal developer platform

**Who:** a platform engineering team that owns "the paved road" — service onboarding, production readiness reviews, and the org-wide definition of done.

**The pain:** the production readiness checklist is a wiki page. Teams skip steps, reviews go stale, and exceptions are granted in Slack and forgotten. The platform team cannot tell which services actually followed the path.

**With Flow:** the readiness review becomes a Flow Definition — steps like `security-review → slo-signoff → capacity-check → launch` — where each gate's `expects` names the claim a producing system must supply (`security.review`, `quality.slo-signoff`). The platform team distributes its standard config as a proposal, and each repo applies it with full visibility:

```sh
flow config preview ./platform-flow-config.json --format markdown
flow config apply ./platform-flow-config.json
```

Local `.flow/config.json` stays authoritative: additive proposals merge, conflicting ones are rejected unless a named authority accepts them explicitly:

```sh
flow config apply ./platform-flow-config.json \
  --accept-conflict '$.trusted_producers.security.review' \
  --exception-reason 'platform team rotated the scanning producer' \
  --authority 'platform-lead'
```

When a service launches without a passing capacity check, that is an `accept-exception` with a reason and an authority — visible in every report, instead of a forgotten thread.

**What they get:** golden paths that are enforced by evidence rather than memory, org-wide config distribution without silently overwriting project authority, and exceptions that are attributable instead of invisible. See [Project Config](project-config.md).

## 4. Adversarial review for generated work

**Who:** a team that generates high-stakes output with LLMs — research summaries, legal drafts, marketing claims — and requires an adversarial pass before anything ships.

**The pain:** "a second model reviewed it" is not a process. How many adversarial rounds ran? What defects were found? Why did round three get accepted when round two failed? Without records, adversarial review degenerates into a vibe.

**With Flow:** the bundled `examples/adversarial-pass-flow.json` models `produce → adversarial-review → resolve`. The review gate expects two claims — `adversarial.producer-output` (the thing being challenged) and `adversarial.review` (the per-round review evidence) — and maps defect reasons to deterministic targets:

- `conclusion_defect`, `framing_defect`, `completeness_defect` → back to `produce`
- `citation_defect` → forward to `resolve` (repairable without regeneration)
- `route_back_policy.max_attempts` is the per-case adversarial budget; exceeding it blocks the run rather than burning tokens forever

Attempt counting is derived from persisted transitions, so neither the producer nor the reviewer can fudge the round count. External reasoning systems own the actual review content; Flow owns only orchestration, route accounting, and the budget.

**What they get:** adversarial review as a measurable process — rounds, reasons, and budgets on the record — instead of an unaccountable loop.

## 5. Audit-ready change evidence

**Who:** an engineering org facing SOC 2, ISO 27001, or internal audit, where every production change needs demonstrable review and testing evidence.

**The pain:** at audit time, someone spends three weeks screenshotting CI runs and PR approvals into a spreadsheet. Evidence links rot. The map between "what we said our process is" and "what actually happened" is reconstructed by hand, annually, under duress.

**With Flow:** the change process is the Flow Definition; the audit trail is a byproduct of running it. Every run directory is a self-contained evidence package:

- `definition.json` — what the required process was at the time
- `state.json` — every transition, gate outcome, route-back, and exception, with timestamps
- `evidence/` — *copies* of the actual evidence files, not links that rot
- `report.md` / `report.json` — the human- and machine-readable explanation

The evidence manifest records integrity metadata, and gate evaluation reports precise diagnostic reason codes (`stale`, `untrusted_producer`, `authority_gap`, `integrity_mismatch`, …) instead of hiding weak evidence as a generic pass. For versioned releases, `flow version-release-report` projects the changeset, verification evidence, release readiness result, accepted exceptions, and risks into one deterministic artifact — and missing required evidence becomes an explicit `gap` with `decision: "hold"`, never a summarized "ready."

**What they get:** audits answered with `report.json` instead of a screenshot hunt, and an evidence trail that was produced by the process rather than reconstructed after it.

---

## A shared shape

All five scenarios are the same contract wearing different clothes:

> A required transition may advance only when its gate has inspectable evidence or an explicit, attributed exception.

If your team has a path that matters — where "it's done" needs to mean something — that contract is a Flow Definition away. Start with [Getting Started](getting-started.md), or copy the closest example from [`examples/`](../examples/README.md).
