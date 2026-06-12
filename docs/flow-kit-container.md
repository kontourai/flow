# Flow Kit Container

A **Flow Kit** is Flow's distribution unit for portable workflow bundles. A kit packages one or more Flow Definitions — and optionally consumer-defined supporting assets — under a single validated manifest.

Flow owns the _container contract_: the core manifest fields, their validation rules, and the extension model by which consumer products add their own asset classes. This document is the authoritative specification of that contract.

Consumer products (such as Flow Agents) build on the container contract by declaring additional asset-class fields. Those fields are consumer-owned extensions. Core validation is container-aware: it enforces the core fields and ignores-but-permits unknown top-level fields.

## Container manifest: `kit.json`

Every Flow Kit is rooted at a directory that contains a `kit.json` file. The manifest is the kit's identity and declaration of contents.

### Required fields

| Field | Type | Rule |
|---|---|---|
| `schema_version` | string | Must be `"1.0"`. Identifies the manifest contract version. |
| `id` | string | Stable kebab-case identifier. Pattern: `^[a-z][a-z0-9-]*$`. Used as the kit's install key. |
| `name` | string | Non-empty human-readable display name. |
| `flows` | array | Non-empty list of Flow Definition entries. Each entry must include a `path` field. |

### Optional core fields

| Field | Type | Rule |
|---|---|---|
| `description` | string | Free-text description of the kit's purpose. |
| `product_name` | string | Branded product name when the kit is part of a named product. |

### `flows` entries

Each entry in `flows` represents one Flow Definition packaged in the kit.

| Field | Type | Rule |
|---|---|---|
| `path` | string | **Required.** Relative path to the Flow Definition file inside the kit directory. |
| `id` | string | Optional stable identifier for this entry within the kit. |
| `description` | string | Optional description of this entry's purpose. |

### Path rules

All declared paths must:

- Be relative (no leading `/`).
- Contain no `..` path traversal segments.
- Resolve inside the kit directory root.

These rules ensure a kit is fully self-contained and portable between machines, worktrees, and operating systems.

### Minimal example

```json
{
  "schema_version": "1.0",
  "id": "review-kit",
  "name": "Review Kit",
  "description": "A kit that adds a code review flow.",
  "flows": [
    {
      "id": "review-kit.review",
      "path": "flows/review.flow.json",
      "description": "Review a change against agreed criteria."
    }
  ]
}
```

### JSON Schema

The container manifest is formally specified by [`schemas/flow-kit-container.schema.json`](../schemas/flow-kit-container.schema.json) in this repository. The schema uses `additionalProperties: true` at the manifest root and at entry level so that consumer extensions round-trip without schema rejection.

## Validation rules

Core validation enforces the following rules, in order:

1. `kit.json` must exist at the kit root and be valid JSON.
2. `schema_version` must be `"1.0"`.
3. `id` must match `^[a-z][a-z0-9-]*$`.
4. `name` must be a non-empty string.
5. `flows` must be a non-empty array.
6. Each `flows` entry must have a `path` that is a non-empty string, relative, free of `..`, and resolves inside the kit directory.
7. Each declared `flows` path must point at an existing file.

Flow Definition _semantics_ (steps, gates, expectations, transitions) are validated separately by the Flow CLI's `validate-definition` command. Container validation confirms only that the manifest is well-formed and that declared paths exist.

Unknown top-level fields in `kit.json` are consumer extensions. Core validation ignores them without error.

## The extension model

Consumer products that build on Flow Kits may declare additional asset classes as top-level arrays in `kit.json`. Known examples:

- **Flow Agents** adds: `skills`, `docs`, `adapters`, `evals`, `assets` — each a list of entries with `id`, `path`, and optional `description`.

Consumer-defined extensions are opaque to Flow core. Flow owns the container contract and Flow Definition semantics. Consumer products own their extension fields, their activation logic, and any additional validation they apply.

This separation ensures:

- A kit authored to the container contract works with any consumer that understands it.
- Consumer extensions do not pollute the core contract namespace.
- Future extension fields are additive and non-breaking.

## Distribution directory layout

A well-formed kit directory looks like:

```text
<kit-id>/
  kit.json                  ← required container manifest
  flows/
    <definition>.flow.json  ← at least one Flow Definition
  docs/                     ← optional; consumer-defined
  skills/                   ← optional; consumer-defined
  adapters/                 ← optional; consumer-defined
  evals/                    ← optional; consumer-defined
  assets/                   ← optional; consumer-defined
```

The container contract requires only `kit.json` and the `flows` entries it declares. All other directories are consumer-defined extensions.

## Relationship to Flow Definitions

Flow Definitions are the process contracts a kit distributes. A kit is the _container_; a Flow Definition is the _contents_. The two contracts are separate:

- The kit container contract governs manifest validity and path resolution.
- Flow Definition validation governs steps, gates, expectations, route-back maps, and transition rules.

A kit's `flows` entries point at Flow Definitions, but the kit contract does not validate their internal semantics. Use `flow validate-definition <path>` to validate Flow Definition contents.

## Consumer interoperability

A Flow Kit is valid for any consumer that:

1. Reads `kit.json` and verifies the core fields.
2. Finds the declared `flows` entries.
3. Ignores unknown top-level fields.

A consumer that does _not_ understand a consumer-extension field should not fail — it should treat the field as opaque. This makes kits forward-compatible as new extensions are added.

## See also

- [`schemas/flow-kit-container.schema.json`](../schemas/flow-kit-container.schema.json) — formal JSON Schema for the container manifest.
- [`schemas/flow-definition.schema.json`](../schemas/flow-definition.schema.json) — formal JSON Schema for Flow Definitions.
- [`docs/cli.md`](cli.md) — `flow validate-definition` command reference.
- [Flow Agents kit-authoring-guide](https://kontourai.github.io/flow-agents/kit-authoring-guide) — Flow Agents' extension contract and install tooling for Flow Agents Kits.
