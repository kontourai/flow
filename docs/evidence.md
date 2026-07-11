# Evidence

Evidence is what makes a Flow gate mean something. A gate that passes on an agent's say-so is a checkbox; a gate that passes on inspectable, copied, typed evidence is a record you can trust later. This guide covers what counts as evidence, how gates declare expectations, and how trust artifacts are evaluated.

## Evidence kinds

`flow attach-evidence <run-id> --gate <gate> --file <file> --kind <kind>` accepts these built-in kinds:

| Kind | Use for |
| --- | --- |
| `command` | command output: test runs, lint results, build logs |
| `file` | any file artifact: a diff, a plan document, a screenshot |
| `ci` | CI job results |
| `trust.bundle` | Hachure TrustBundle evidence evaluated against typed gate expectations |
| `veritas-readiness` | repo/change readiness produced by a [Veritas](https://kontourai.io/veritas) tool |
| `human-attestation` | a recorded human statement or sign-off |
| `trace-link` | a pointer to an external trace or observability record |

Unknown kinds are accepted as `custom` and stored with the originally requested kind, so adapters can introduce their own vocabulary without breaking the manifest.

Every attached file is **copied** into `.kontourai/flow/runs/<run-id>/evidence/` and indexed in `evidence/manifest.json` (shape: `schemas/gate-evidence.schema.json`). The run directory stays self-contained: links don't rot, and later edits to the original file don't silently change the record. Runtime commands do not attach to `.flow/runs/`.

## Gate expectations

Gates declare what they expect *before* work runs, as typed `expects` entries. Claim-backed expectations use `kind: "trust.bundle"` with a `bundle_claim` selector:

```json
{
  "id": "tests-passed",
  "kind": "trust.bundle",
  "required": true,
  "description": "Test results are ready for verification.",
  "bundle_claim": {
    "claimType": "quality.tests",
    "subjectType": "flow-step",
    "subjectId": "builder.verify",
    "accepted_statuses": ["verified"]
  },
  "explore_hint": "Run the suite and attach the trust report from CI."
}
```

| Field | Meaning |
| --- | --- |
| `id` | stable expectation id, referenced by evidence and reports |
| `required` | required expectations must be satisfied for the gate to pass |
| `description` | human-readable statement of what is expected |
| `bundle_claim.claimType` | the claim type evidence must carry (e.g. `quality.tests`) |
| `bundle_claim.subjectType` | optional Hachure subject type scope (e.g. `flow-step`) |
| `bundle_claim.subjectId` | optional subject id scope (e.g. `builder.verify`) |
| `bundle_claim.accepted_statuses` | optional list of event statuses that satisfy the gate |
| `explore_hint` | optional guidance shown when the evidence is missing |

`bundle_claim.subjectType` and `bundle_claim.subjectId` are open vocabularies so projects and kits can name their own process subjects — common subject type examples are `flow-run`, `flow-step`, `work-item`, `change`, `pull-request`, `release`, `decision`, and `artifact`.

## Trust artifacts

A `trust.bundle` evidence entry is backed by a copied Hachure TrustBundle JSON file:

```sh
flow attach-evidence dev-1847 --gate verify-gate \
  --file ./trust-bundle.json --kind trust.bundle
```

Flow consumes a neutral bundle shape:

```json
{
  "schemaVersion": 3,
  "source": "ci/main",
  "claims": [
    {
      "id": "claim.quality.tests.verify",
      "subjectType": "flow-step",
      "subjectId": "builder.verify",
      "claimType": "quality.tests"
    }
  ],
  "evidence": [],
  "policies": [],
  "events": [
    {
      "id": "event.quality.tests.verified",
      "claimId": "claim.quality.tests.verify",
      "status": "verified",
      "actor": "ci/main",
      "createdAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

Flow matches `bundle_claim` selectors against bundle claims and derives the claim status from bundle events. The legacy `surface.claim` / `claim` projection was replaced by `trust.bundle` / `bundle_claim` during the trust-bundle migration.

This is a neutral contract: Flow does not import Surface services or Veritas-specific schema fields at runtime. Any tool that can write this JSON shape — CI, Veritas, a review bot, a script — is an evidence producer.

## How claim evidence is evaluated

A `trust.bundle` expectation is satisfied only when **all** of these checks pass:

1. **Type** — a bundle claim has `claimType` matching `bundle_claim.claimType`.
2. **Subject** — the claim matches `bundle_claim.subjectType` and `bundle_claim.subjectId` when the expectation configures them.
3. **Status** — the latest matching claim event status is in `accepted_statuses`.
4. **Freshness** — `issued_at` / `expires_at` are honored when present; expired artifacts are stale.
5. **Producer trust** — the producer is trusted for this claim type per `.flow/config.json` `trusted_producers`, or an authority trace covers it.
6. **Integrity** — local integrity metadata (file hashes recorded at attach time) still matches when present.

When a run returns to a gate, Flow also scopes claim evidence to that current gate visit. A reattached bundle cannot reuse a claim from before the latest transition into the gate's step: the matching claim's `createdAt`, or evidence for that claim's `observedAt`, must be at or after the transition. Re-entry, attachment, claim, and observation timestamps must be valid RFC3339 date-times; missing, malformed, calendar-invalid, or leap-second values do not satisfy a revisited gate. Lower-case RFC3339 `t` and `z` separators and arbitrary fractional precision are accepted and retained verbatim in the producer payload. Flow rejects leap-second notation because its dependencies do not provide a chronology that can compare those instants without collapsing them onto an adjacent second. Prior attachments remain in the manifest for audit.

Unsatisfied artifacts are never hidden as generic missing evidence. Reports carry precise diagnostic reason codes:

| Code | Meaning |
| --- | --- |
| `stale` | the artifact expired or fails freshness checks |
| `rejected` | the claim status is not an accepted status |
| `untrusted_producer` | the producer is not trusted for this claim type |
| `authority_gap` | no trusted producer mapping or authority trace covers the claim |
| `integrity_mismatch` | the copied artifact no longer matches its recorded integrity metadata |
| `subject_mismatch` | the claim subject does not match the expectation |
| `claim_not_current` | the matching claim predates the current gate visit, or has no valid current timestamp |
| `gate_reentry_pending` | a route-back affected the gate, but the run has not re-entered its step |
| `gate_reentry_timestamp_invalid` | the transition back into the gate has an invalid timestamp |
| `attachment_timestamp_invalid` | the evidence attachment timestamp is invalid |
| `attachment_not_current` | the evidence attachment predates the current gate visit |

Trusted producer mappings and gate overrides live in `.flow/config.json` — see [Project Config](project-config.md).

## Failed evidence and route metadata

Evidence can be attached as failed, which is how gates learn that work needs to go back:

```sh
flow attach-evidence dev-1847 --gate verify-gate \
  --file ./test-output.json --kind command \
  --status failed --route-reason implementation_defect
```

Only `route_reason` affects routing — Flow uses it with the gate's `on_route_back` map and persisted transitions to select the target step ([Gates & Route-Back](gates-and-route-back.md) has the full rules). Additional metadata is recorded for reports and learning without influencing routing:

```sh
flow attach-evidence dev-1847 --gate verify-gate \
  --file ./test-output.json --kind command --status failed \
  --route-reason implementation_defect \
  --classifier-kind manual --classifier-source cli --classifier-confidence 0.75 \
  --analytics-loop-key verify:implementation_defect \
  --expectation-id tests-passed
```

For nested metadata, pass `--route-metadata ./route-metadata.json` with any of `route_reason`, `expectation_ids`, `classifier`, `diagnostics`, and `analytics`; explicit CLI flags override overlapping values from the file.

To recover after failed evidence routed work back, attach the replacement with `--supersede <evidence-id>`: the failed entry stays in the manifest for audit but no longer drives the gate.

The v0.1 CLI attaches evidence from files. Richer adapters — CI jobs, agent harness hooks, release tooling — can write the same manifest shape directly through the [library API](library.md).
