# ADR 0003: Project Config Merge Semantics

Date: 2026-05-26

## Status

Accepted

## Context

Flow Agents and kits need a way to propose useful Flow project config during install or activation. Those proposals may include trusted producer mappings and gate overrides, which are authority-bearing choices for a project.

ADR 0002 makes `.flow/config.json` the authority source used during gate evaluation. A kit proposal cannot be treated as equally authoritative because that would let an installer silently replace trusted producers, authority traces, accepted statuses, or required gate expectations.

## Decision

Flow owns the project config merge primitive. The primitive compares kit-proposed config with local `.flow/config.json`, emits a machine-readable report, and writes only in explicit apply mode.

Merge reports include:

- `schema_version`
- `mode`
- `status`
- `local_config_path`
- `proposal_path`
- `proposed_changes`
- `accepted_changes`
- `rejected_changes`
- `conflicts`
- `unchanged`
- `exceptions`
- `merged_config`
- `summary`

Changes use machine-readable JSON paths under `trusted_producers` and `gate_overrides`, plus `section`, `operation`, `reason`, and source values. Local absent paths may accept additive kit proposals. Identical values are unchanged. Existing local values that differ from kit proposals are conflicts and rejected by default.

Explicit exception acceptance is required to apply conflicting authority changes. The exception records the accepted path, reason, authority, local value, proposed value, and accepted value.

## Flow Agents Boundary

Flow Agents may consume the JSON report during kit install or activation. It can display Markdown or summary output, detect conflicts, and ask the user or project authority to accept exceptions.

Flow Agents does not own the merge semantics. The authority rule lives in Flow so the same local `.flow/config.json` behavior applies regardless of which installer or adapter proposed the config.

## Non-Goals

This decision does not add UI Console behavior, remote trust verification, signature verification, hosted workflows, Flow Agents provider settings, or cross-repo Flow Agents implementation.

## Consequences

Positive:

- Kit installs can be previewed without writing local config.
- Flow Reports give external consumers a stable contract without handing them authority semantics.
- Local trusted producer mappings and gate overrides are preserved unless an exception is explicit and attributable.

Trade-offs:

- Installers must handle conflicts as a first-class outcome.
- Broad parent-path exception acceptance can intentionally accept multiple child conflicts, so callers should show the report before applying.
