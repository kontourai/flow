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

- `trusted_producers` maps claim types to producer ids and authority traces that may satisfy them, e.g. `{ "quality.tests": { "producers": ["ci/main"], "authority_traces": ["github:main"] } }`. When a claim type is pinned, evidence that matches neither an allowed producer nor an allowed authority trace cannot satisfy the expectation and receives `untrusted_producer` or `authority_gap` diagnostics.
- `gate_overrides` carries project-level gate adjustments applied during evaluation. An expectation override's `trusted_producers` or `authority_traces` replaces the claim-type mapping for that expectation, including an explicit empty array that clears the corresponding mapping.

Producer policy is evaluated from the same config snapshot as the gate transition while Flow holds the run mutation lock. Library consumers should call `evaluateRun`; they do not need to pre-filter evidence or duplicate config enforcement.

Two authored shapes are accepted: the flat v0.1 shape above, and the Resource Contract shape (`apiVersion`, `kind: "FlowProjectConfig"`, `metadata`, `spec`) shown in [`examples/flow-project-config-resource-contract.json`](../examples/flow-project-config-resource-contract.json). Resource-shaped files map `spec` to the same flat runtime config, and merge reports plus the applied `.flow/config.json` stay flat — existing tools that read `trusted_producers` and `gate_overrides` never need to migrate.

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

## Apply: additive merges in, conflicts blocked

```sh
flow config apply ./kit-flow-config.json
```

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

```text
flow config merge: applied
proposed: 2; accepted: 1; rejected: 0; conflicts: 0; exceptions: 1
```

The exception is part of the merge report, so a kit install log shows exactly which project authority was overridden, why, and by whom.

## Who writes config, who owns it

Flow Agents and kits may author, adapt, install, or update project config as part of distribution — and may consume the JSON merge report to drive install UX. They do not own the authority semantics: the config that Flow loads for a run is the source of truth for trusted producers and gate overrides during gate evaluation. Flow core adds no UI behavior, remote trust verification, signatures, hosted workflows, or provider settings to config merge.

Library consumers get the same machinery via `previewFlowConfigMerge`, `applyFlowConfigMerge`, and `renderConfigMergeMarkdown` — see [Library](library.md).
