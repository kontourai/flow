# Release Readiness Fixtures

These fixtures exercise local release-readiness lane evaluation. They are file-backed examples for adapters and tests, not production ServiceNow, Jira, PagerDuty, calendar, or deployment integrations.

## Contracts

`release-policy.json` defines open release lane ids and risk classes. Each lane names the `surface.claim` type and accepted statuses required for that lane.

Fixture adapters map local provider-shaped records into Flow evidence entries:

- `kind: "surface.claim"`
- `claim.type`, `claim.subject`, and `claim.status`
- `producer` and `authority_traces`
- `external_links` copied with provider metadata preserved and `url` normalized from provider fields such as `href` when needed
- `native_refs` copied with provider metadata preserved and `id` normalized from provider fields such as `ref` or `key` when needed, with a fixture-native id added when useful

Lane evaluation uses the same claim matching rules as Flow gates. Required lanes pass only when the Surface-shaped claim satisfies the lane policy and trusted producer config. Pending, rejected, stale, missing, untrusted, and authority-gap evidence leaves the readiness result on `hold`.

## Files

- `release-policy.json` requires `change-approval` for medium risk and adds `deployment-window` plus `freeze-state` for high risk.
- `flow-definition.json` shows equivalent Flow gate expectations for a release gate.
- `change-records/approved.json` produces trusted `release.change.approved` evidence.
- `change-records/pending.json` produces pending approval evidence and a hold.
- `deployment-state/open.json` produces trusted deployment-window evidence.
- `freeze-state/clear.json` produces trusted freeze-clear evidence.
