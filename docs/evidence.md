# Evidence

Evidence is what makes a Flow gate mean something. A gate that passes on an agent's say-so is a checkbox; a gate that passes on inspectable, copied, typed evidence is a record you can trust later. This guide covers what counts as evidence, how gates declare expectations, and how trust artifacts are evaluated.

## Evidence kinds

`flow attach-evidence <run-id> --gate <gate> --file <file> --kind <kind>` accepts these built-in kinds:

| Kind | Use for |
| --- | --- |
| `command` | command output: test runs, lint results, build logs |
| `file` | any file artifact: a diff, a plan document, a screenshot |
| `ci` | CI job results |
| `surface.claim` | claim-backed evidence evaluated against typed gate expectations |
| `veritas-readiness` | repo/change readiness produced by a [Veritas](https://kontourai.io/veritas) tool |
| `human-attestation` | a recorded human statement or sign-off |
| `trace-link` | a pointer to an external trace or observability record |

Unknown kinds are accepted as `custom` and stored with the originally requested kind, so adapters can introduce their own vocabulary without breaking the manifest.

Every attached file is **copied** into `.flow/runs/<run-id>/evidence/` and indexed in `evidence/manifest.json` (shape: `schemas/gate-evidence.schema.json`). The run directory stays self-contained: links don't rot, and later edits to the original file don't silently change the record.

## Gate expectations

Gates declare what they expect *before* work runs, as typed `expects` entries. In v0.1, authored expectations use `kind: "surface.claim"`:

```json
{
  "id": "tests-passed",
  "kind": "surface.claim",
  "required": true,
  "description": "Test results are ready for verification.",
  "claim": {
    "type": "quality.tests",
    "subject": "builder.verify",
    "accepted_statuses": ["trusted"]
  },
  "explore_hint": "Run the suite and attach the trust report from CI."
}
```

| Field | Meaning |
| --- | --- |
| `id` | stable expectation id, referenced by evidence and reports |
| `required` | required expectations must be satisfied for the gate to pass |
| `description` | human-readable statement of what is expected |
| `claim.type` | the claim type evidence must carry (e.g. `quality.tests`) |
| `claim.subject` | optional subject scope (e.g. `builder.verify`) |
| `claim.accepted_statuses` | optional list of statuses that satisfy the gate |
| `explore_hint` | optional guidance shown when the evidence is missing |

`claim.subject` is an open vocabulary so projects and kits can name their own process subjects — common examples are `flow-run`, `flow-step`, `work-item`, `change`, `pull-request`, `release`, `decision`, and `artifact`.

## Trust artifacts

A `surface.claim` evidence entry can be backed by a copied [Surface](https://kontourai.io/surface) TrustReport or Trust Snapshot JSON file:

```sh
flow attach-evidence dev-1847 --gate verify-gate \
  --file ./trust-report.json --trust-artifact
```

Flow consumes a neutral artifact shape:

```json
{
  "schema_version": "0.1",
  "artifact_type": "trust-report",
  "subject": "builder.verify",
  "producer": "ci/main",
  "status": "trusted",
  "issued_at": "2026-05-26T00:00:00.000Z",
  "expires_at": "2026-06-02T00:00:00.000Z",
  "authority_traces": ["github:main"],
  "claims": [
    { "type": "quality.tests", "status": "trusted" }
  ]
}
```

`artifact_type` is `trust-report` or `trust-snapshot`. Flow projects the first claim into the normal `claim.type`, `claim.subject`, and `claim.status` matching fields. Explicit `--claim-type`, `--claim-subject`, `--claim-status`, `--producer`, and `--authority-trace` flags can override the parsed projection for local workflows.

This is a Surface-shaped contract, deliberately neutral: Flow does not import Surface services or Veritas-specific schema fields at runtime. Any tool that can write this JSON shape — CI, Veritas, a review bot, a script — is an evidence producer.

## How claim evidence is evaluated

A `surface.claim` expectation is satisfied only when **all** of these checks pass:

1. **Type** — the evidence claim type matches `claim.type`.
2. **Subject** — matches `claim.subject` when the expectation configures one.
3. **Status** — the claim status is in `accepted_statuses`.
4. **Freshness** — `issued_at` / `expires_at` are honored when present; expired artifacts are stale.
5. **Producer trust** — the producer is trusted for this claim type per `.flow/config.json` `trusted_producers`, or an authority trace covers it.
6. **Integrity** — local integrity metadata (file hashes recorded at attach time) still matches when present.

Unsatisfied artifacts are never hidden as generic missing evidence. Reports carry precise diagnostic reason codes:

| Code | Meaning |
| --- | --- |
| `stale` | the artifact expired or fails freshness checks |
| `rejected` | the claim status is not an accepted status |
| `untrusted_producer` | the producer is not trusted for this claim type |
| `authority_gap` | no trusted producer mapping or authority trace covers the claim |
| `integrity_mismatch` | the copied artifact no longer matches its recorded integrity metadata |
| `subject_mismatch` | the claim subject does not match the expectation |

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
