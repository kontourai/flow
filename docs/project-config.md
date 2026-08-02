# Project Config

`.flow/config.json` is the project's authority model: which producers are trusted for which claim types, and which gates carry project-level overrides. Kits and platform teams can *propose* config, but the local file remains authoritative during gate evaluation — Flow never lets a proposal silently overwrite project authority.

## The config file

`flow init` writes the default:

```json
{
  "schema_version": "0.1",
  "trusted_producers": {},
  "gate_overrides": {}
}
```

- `trusted_producers` maps claim types to allow-lists, e.g. `{ "quality.tests": { "producers": ["ci/main"], "authority_refs": ["policy:quality"] } }`. `producers` matches only the validated bundle `producerId`; an attachment `producer` can only corroborate that same value. `authority_refs` matches only a validated embedded Surface `authorityTrace[].authorityRef`, never a trace id or an attachment string. A pinned trace must be active at Flow's explicit evaluation instant, have the exact matched claim subject, link that claim or its supporting evidence, and bind its actor to the accepted verification event or linked evidence collector. Every configured claim-type and expectation scope must admit the same producer or authority ref. `{}` reserves an unpinned claim type, while an explicitly empty `producers` **or** `authority_refs` array makes that whole mapping deny-all, even if its other route is populated.
- `gate_overrides` carries project-level gate adjustments applied during evaluation.

Two authored shapes are accepted: the flat v0.1 shape above, and the Resource Contract shape (`apiVersion`, `kind: "FlowProjectConfig"`, `metadata`, `spec`) shown in [`examples/flow-project-config-resource-contract.json`](../examples/flow-project-config-resource-contract.json). Resource-shaped files map `spec` to the same flat runtime config, and merge reports plus the applied `.flow/config.json` stay flat — existing tools that read `trusted_producers` and `gate_overrides` never need to migrate.

`authority_traces` was removed because opaque strings could not establish trace identity, subject, actor, scope, or validity. Migrate each configured value to `authority_refs` and put the corresponding rich `authorityTrace` record in the producer's trust bundle. Flow rejects old config before preview or apply can publish it.

## Preview before apply

Preview is read-only and safe to run on anything:

```sh
flow config preview ./kit-flow-config.json
```

```text
flow config merge: ready
proposed: 2; accepted: 1; rejected: 0; conflicts: 0; exceptions: 0
local config: /work/project/.flow/config.json
proposal: /work/project/kit-flow-config.json
```

`--format json` emits stable buckets for `proposed_changes`, `accepted_changes`, `rejected_changes`, `conflicts`, `unchanged`, `exceptions`, `merged_config`, and `summary`. Each change records a machine-readable `path`, `section`, `operation`, `reason`, and source values — installers and kit tooling consume this to show install logs and detect conflicts. `--format markdown` renders the same report for humans.

## Apply: a trusted host publishes accepted bytes

```sh
flow config apply ./kit-flow-config.json
```

The standalone CLI intentionally cannot publish config. It fails closed with
`flow.config.merge.publisher.unavailable` and directs you to `flow config
preview`. A desktop or other trusted host can call `applyFlowConfigMerge` with
an explicit publisher capability that atomically publishes the canonical bytes
on Flow's behalf.

Flow computes and validates the merge, then hands the host the target paths,
the SHA-256 of the config it merged from, and immutable canonical JSON bytes.
The host must use an anchored atomic filesystem primitive, verify that expected
input before replacement, and return a structured receipt bound to the exact
path and output digest. Flow validates that receipt's shape and binding but does
not treat it as evidence that Flow performed or verified the host's atomic I/O.

The merge rules are deliberately conservative:

- **Additive** proposals (the local path is absent) are accepted.
- **Matching** values are recorded as unchanged.
- **Differing** trusted producer mappings or gate overrides are conflicts — rejected by default, and the command exits non-zero:

```text
flow config merge: blocked
proposed: 2; accepted: 0; rejected: 1; conflicts: 1; exceptions: 0
```

## Accepting a conflict, on the record

Overriding local authority requires naming the exact conflict path (or a parent path), a reason, and an authority:

```sh
flow config apply ./kit-flow-config.json \
  --accept-conflict '$.trusted_producers.quality.tests' \
  --exception-reason 'platform team rotated the producer' \
  --authority 'platform-lead'
```

The exception is part of the merge report, so a host install log shows exactly which project authority was overridden, why, and by whom. A successful host publication also adds a structured `publisher_receipt`; this is an acknowledgement from that trusted host, not Flow I/O evidence.

## Who writes config, who owns it

Flow Agents and kits may author, adapt, install, or update project config as part of distribution — and may consume the JSON merge report to drive install UX. They do not own the authority semantics: the config that Flow loads for a run is the source of truth for trusted producers and gate overrides during gate evaluation. Flow core adds no UI behavior, remote trust verification, signatures, hosted workflows, provider settings, or a pathname-based config publisher to config merge.

Library consumers get the same machinery via `previewFlowConfigMerge`, `applyFlowConfigMerge`, and `renderConfigMergeMarkdown` — see [Library](library.md).
