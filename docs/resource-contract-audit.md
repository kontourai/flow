# Resource Contract Alignment Audit

Date: 2026-06-02

This audit covers `kontourai/flow#13`: which Flow contracts should align to the Kontour Resource Contract default from ADR 0005, which should keep a product-native shape, and which should wait for later console or product-extension work.

## Sources

- Work item: `kontourai/flow#13`, "Audit Flow contracts for Kontour Resource Contract alignment": https://github.com/kontourai/flow/issues/13.
- Resource Contract authority: `/Users/brian/dev/github/kontourai/flow-agents/docs/adr/0005-kubernetes-inspired-resource-contracts.md`.
- Pickup Probe: `/Users/brian/dev/github/kontourai/flow-agents/.agents/flow-agents/flow-contract-audit-pickup/flow-contract-audit-pickup--pickup-probe.md`.
- Plan: `/Users/brian/dev/github/kontourai/flow-agents/.agents/flow-agents/flow-contract-resource-audit/flow-contract-resource-audit--plan.md`.
- Idea-to-backlog source artifact: `NOT_VERIFIED`. The named local path `/Users/brian/dev/github/kontourai/flow-agents/.agents/kagents/kontour-resource-contract-audits/kontour-resource-contract-audits--idea-to-backlog.md` was not found locally.
- Flow base audited: `origin/main` at `8d8bc13` (`Merge pull request #22 from kontourai/flow-definition-transition-guard-impl`).
- Provider-state caveat: GitHub issue `kontourai/flow#21` still appeared open or in progress during pickup, but its transition-validation implementation has merged to `main`. Treat the issue state as provider drift or pending project-board cleanup, not as absence of the transition-validation contracts.
- Residual branch delta observed for context only: `git diff --name-status origin/main...origin/flow-definition-transition-guard-impl` still reports `.gitignore`, `CONTEXT.md`, `docs/adr/0004-flow-console-review-queues-and-run-control.md`, `docs/console.md`, `docs/product-boundaries.md`, `package.json`, and `scripts/check-content-boundary.cjs`. This audit does not edit or rely on that branch as the source of truth for merged transition validation.

Primary Flow sources inspected:

- `CONTEXT.md`
- `README.md`
- `docs/product-boundaries.md`
- `docs/product-vision.md`
- `docs/market-positioning.md`
- `docs/adr/0001-flow-as-process-transparency-layer.md`
- `docs/adr/0002-gate-expectations-and-project-authority.md`
- `docs/adr/0003-project-config-merge-semantics.md`
- `schemas/`
- `examples/`
- `src/`

## ADR 0005 Default

ADR 0005 says new durable, agent-facing, provider-facing, CLI-facing, cross-product, or user-authored Kontour contracts should default to a Kubernetes-inspired resource shape:

- `apiVersion` for product namespace and version, for example `flow.kontourai.io/v1alpha1`.
- `kind` for the resource type.
- `metadata` for stable identity, names, labels, annotations, ownership, and overlap/discovery fields.
- `spec` for desired intent authored by a user, product, provider, adapter, CLI, or agent.
- `status` for observed facts, current state, results, and generated summaries.
- `status.conditions[]` for condition-style status summaries that can be inspected consistently across products.

The important distinction is desired versus observed state. Authored process shape, requested transitions, queue filters, and project authority intent belong in `spec`. Run position, gate outcomes, diagnostics, accepted exceptions, merge conflicts, validation results, and projections belong in `status`. Evidence remains separately inspectable and should be referenced from status instead of being hidden inside a summary.

ADR 0005 does not require every helper object to become a resource. Product-native internal types may remain native when Resource Contract shape would make them less clear, but durable exported artifacts should either migrate, map explicitly, or document an exception.

## Recommendation Vocabulary

- `migrate`: Convert the durable contract itself to Resource Contract shape in a follow-up slice.
- `map`: Keep the current artifact as a compatibility or embedded shape, but define a clear Resource Contract wrapper or projection.
- `exception`: Keep the current durable shape and document why Resource Contract shape would make that specific contract worse or less clear.
- `defer/observe`: Do not migrate now because the contract is directional, not implemented, or needs another product boundary first.
- `internal/not-a-contract`: Do not treat implementation-only helper shapes as exported product contracts.

## Inventory

| Contract | Owner | Current shape | Durability and audience | Recommendation | Rationale | Sources |
| --- | --- | --- | --- | --- | --- | --- |
| Flow Definition | Flow core | `schemas/flow-definition.schema.json`: top-level `id`, `version`, `steps`, `gates`; examples under `examples/*.json` | Durable, user-authored, CLI-facing, agent-facing process contract | `migrate` | This is the strongest Resource Contract candidate. Authored steps, gates, expectations, route maps, and policies are desired process intent and should move under `spec`; identity and labels should move to `metadata`; validation state can appear in `status.conditions` when generated. | `CONTEXT.md`, `README.md`, `schemas/flow-definition.schema.json`, `examples/agent-dev-flow.json`, ADR 0001, ADR 0002 |
| Flow Run / state | Flow core | `.flow/runs/<run-id>/state.json` with `schema_version`, `run_id`, `definition_id`, `status`, `current_step`, `gate_outcomes`, `transitions`, `exceptions` | Durable observed run state for continuation, CLI, agents, reports, and future consoles | `migrate` | Run state is observed process state. `metadata` should carry run identity and labels, `spec` should reference the definition and subject/params, and `status` should carry current step, gate outcomes, transitions, exceptions, next action, and conditions. | `README.md`, `CONTEXT.md`, `schemas/flow-run.schema.json`, `src/index.js` |
| Flow Report | Flow core | `report.md` plus `report.json` / `schemas/flow-report.schema.json`; summary-oriented projection of a run | Durable human- and agent-facing report artifact | `map` | A report is a generated explanation, not the authoritative desired or observed resource. Keep Markdown and JSON report outputs useful, but add or document a Resource Contract projection where report status maps from Flow Run status and conditions. | `README.md`, `CONTEXT.md`, `schemas/flow-report.schema.json`, ADR 0001 |
| Gate Evidence Manifest | Flow core | `.flow/runs/<run-id>/evidence/manifest.json` / `schemas/gate-evidence.schema.json`; array of evidence entries and copied files | Durable evidence index for gate evaluation and audit | `map` | Evidence manifests are append-only-ish evidence indexes, not desired resources. A full Resource Contract wrapper around every evidence file would obscure that it is a manifest of externally inspectable evidence. Map the manifest to a `FlowEvidenceManifest` resource only when a consumer needs metadata, ownership, or conditions for the manifest itself. | `README.md`, `schemas/gate-evidence.schema.json`, `src/index.js` |
| Neutral Surface TrustReport / Trust Snapshot evidence projection | Flow core with Surface boundary | Embedded `trust_artifact` projection under evidence entries: `artifact_type`, `subject`, `producer`, `status`, timestamps, authority traces, claims, integrity | Durable cross-product evidence projection consumed by Flow, but owned semantically by Surface | `exception` | Making this embedded projection a Flow Resource Contract would blur product ownership. The shape must stay neutral Surface-shaped evidence so Flow can evaluate claims without importing Surface services or Veritas fields. A Flow wrapper would make the contract less clear by pretending Flow owns claim-trust semantics. | `README.md`, `docs/product-boundaries.md`, `schemas/gate-evidence.schema.json`, `examples/scenarios/surface-claims/README.md` |
| Flow Project Config | Flow core | `.flow/config.json` / `schemas/flow-config.schema.json`: `schema_version`, `trusted_producers`, `gate_overrides` | Durable project authority config; local source of truth for gate evaluation | `migrate` | Project config is user/project-authored desired authority state. `spec.trustedProducers` and `spec.gateOverrides` would make authority intent explicit, while `metadata` can hold project identity and labels. Observed validation or conflict state can appear under `status.conditions`. | `README.md`, `CONTEXT.md`, `docs/product-boundaries.md`, ADR 0002, `schemas/flow-config.schema.json` |
| Flow Config Merge Report | Flow core | `schemas/flow-config-merge-report.schema.json`: preview/apply report with proposed, accepted, rejected, conflicts, exceptions, merged config, summary | Durable CLI/adaptor result artifact for kit installs and authority changes | `map` | The report is an observed result of comparing desired config proposals with local authority. Keep the stable result buckets, but define a Resource Contract result wrapper where request metadata goes under `spec` and conflicts/exceptions/summary go under `status.conditions` and `status`. | `README.md`, ADR 0003, `schemas/flow-config-merge-report.schema.json`, `src/index.js` |
| Flow Definition Validation Result | Flow core | `flow validate-definition --json` stable payload: `valid`, `path`, `error_count`, `diagnostics[]` with diagnostic `code`, `severity`, `path`, and `message` | Stable machine-readable CLI-facing observed validation result for users, agents, and automation before starting a run | `map` | This is observed validation status for an authored Flow Definition. Keep the direct CLI payload readable and compatibility-friendly, but define a Resource Contract projection if validation results are persisted, indexed, or consumed by a console/provider: the definition input reference belongs in `spec` or `metadata`, while `valid`, error counts, and diagnostics map naturally to `status` and `status.conditions`. | `README.md`, `src/cli.js`, `src/index.js` |
| Flow Transition Validation Request | Flow core | `schemas/flow-transition-validation-request.schema.json`: definition, current state, proposed transition/state, manifest, evidence refs, config, now | Durable-ish CLI/library input envelope for provider-neutral transition legality | `exception` | This is a transient validation request envelope, not desired long-lived state. Forcing it into `metadata/spec/status` would make the call harder to read because every important field is already request input and there is no observed status until the result. Keep it small and stable; if a persisted transition proposal is introduced later, that new durable object can be Resource Contract shaped. | `README.md`, `schemas/flow-transition-validation-request.schema.json`, `src/cli.js`, `src/index.js` |
| Flow Transition Validation Result | Flow core | `schemas/flow-transition-validation-result.schema.json`: `valid`, `status`, `diagnostics`, `transition` preview | Durable-ish machine-readable CLI/library result | `map` | The result is observed status and diagnostics, so it maps naturally to `status` and `status.conditions`. Keep the CLI result shape for direct validation calls, but define a Resource Contract projection if results are persisted, indexed, or consumed by a console/provider. | `README.md`, `schemas/flow-transition-validation-result.schema.json`, `src/cli.js`, `src/index.js` |
| Flow Console projection / read model | Flow product direction | Not implemented in current `main`; branch docs describe local-first projection/read-model files for runs, gates, evidence, review queues, run control, decisions, and next actions | Future durable console-facing projection | `migrate` | Console projections are durable, agent/user/provider-facing read models. They should be Resource Contract shaped from the start so local-first files and future Kontour Console adapters can inspect `apiVersion`, `kind`, `metadata`, `spec` filters/source refs, `status` summaries, and conditions consistently. | `CONTEXT.md`, `docs/product-boundaries.md`, `docs/product-vision.md`; branch-context docs `docs/adr/0004-flow-console-review-queues-and-run-control.md`, `docs/console.md` |
| Run Control API | Flow product direction | Prose-defined generic interface for inspecting/managing runs; current CLI commands cover pieces (`status`, `attach-evidence`, `evaluate`, `accept-exception`, `validate-transition`, `resume`) | Future API surface for Flow Console and consumers | `migrate` | Durable control intents such as pause, resume, transition proposal, exception acceptance, and evidence attachment should be explicit desired-state resources or commands with Resource Contract-shaped request/result records when persisted. This avoids provider-specific control envelopes. | `README.md`, `CONTEXT.md`; branch-context ADR 0004 |
| Review Queue | Flow product direction | Prose-defined queue of Review Items waiting for actor/producer/authority action; not schema-backed in current `main` | Future durable console-facing queue/read model | `migrate` | A queue is a durable projection with identity, grouping, filters, and observed item counts/status. Resource shape is useful for Console, adapters, and provider sync. | `CONTEXT.md`; branch-context ADR 0004 and `docs/console.md` |
| Review Item | Flow product direction | Prose-defined decision object with status, subject, evidence refs, available actions, extension payload | Future durable console-facing and possibly provider-facing item | `migrate` | Review Items are durable work/decision records. `spec` should carry requested decision/action context and extension payload; `status` should carry current decision state, evidence satisfaction, actor/authority outcome, and conditions. | `CONTEXT.md`; branch-context ADR 0004 and `docs/console.md` |
| Flow Product Extension | Flow product direction | Prose-defined extension metadata for labels, renderers, queue grouping, suggested actions, proof panels, branding; no current schema | Future product-supplied extension contract | `defer/observe` | The boundary is clear enough to say extensions must not redefine Flow semantics, but the concrete fields need proof from a reference extension before locking a resource shape. Default to Resource Contract when the extension contract becomes durable. | `CONTEXT.md`; branch-context ADR 0004 and `docs/console.md` |
| Examples and scenarios | Flow core docs/test assets | `examples/*.json` Flow Definitions; `examples/scenarios/surface-claims/*` config, definitions, evidence artifacts | Durable examples for users, tests, and docs; not independent product contracts | `map` | Examples should follow whichever contract they demonstrate. They should not become separate resources merely because they are durable files. When Flow Definition and Flow Project Config migrate, examples should migrate with them; Surface-shaped evidence scenarios should stay neutral evidence examples. | `examples/`, `README.md`, `examples/scenarios/surface-claims/README.md` |
| Internal runtime helper shapes | Flow core implementation | In-memory objects and helper return values in `src/index.js` and `src/cli.js`: diagnostics, projections, merge changes, route metadata, render inputs, normalized evidence entries before persistence | Implementation-only helpers | `internal/not-a-contract` | These are not standalone user-authored, provider-facing, or durable product contracts unless written into `.flow/` files or emitted by the CLI/library as documented JSON. Turning them into Resource Contracts would add ceremony and make local code paths less clear without improving interoperability. | `src/index.js`, `src/cli.js` |

## Migration Follow-Ups

Every `migrate` recommendation above needs a concrete implementation slice before schemas or runtime behavior change.

| Contract | Follow-up slice | Likely files | Expected verification |
| --- | --- | --- | --- |
| Flow Definition | Introduce `FlowDefinition` Resource Contract schema in `flow.kontourai.io/v1alpha1`, map existing `id/version/steps/gates` into `metadata.name`, `metadata.labels`, and `spec`, and keep a compatibility loader for v0.1 examples. | `schemas/`, `src/index.js`, `src/cli.js`, `examples/`, `README.md` | `npm test`, `npm run check:schemas`, definition validation fixtures for old and new shapes, CLI `validate-definition --json` snapshots. |
| Flow Run / state | Add `FlowRun` Resource Contract persisted at `.flow/runs/<run-id>/state.json` or a versioned migration path; map current step, transitions, outcomes, exceptions, next action, and continuation into `status` and `status.conditions`. | `schemas/flow-run.schema.json`, `src/index.js`, `README.md`, examples or scenarios | `npm test`, start/evaluate/resume/report integration tests, schema drift check, migration fixture from v0.1 state. |
| Flow Project Config | Add `FlowProjectConfig` Resource Contract with authority fields under `spec`; define how current `.flow/config.json` is loaded or migrated. | `schemas/flow-config.schema.json`, `src/index.js`, `README.md`, config merge tests | `npm test`, `npm run check:schemas`, config preview/apply tests for additive, unchanged, conflict, and explicit exception cases. |
| Flow Console projection / read model | Define initial `FlowConsoleProjection` or smaller projection resources for local-first Console read models, derived from Flow Runs and evidence without becoming the authority source. | Future `docs/console.md`, future schemas/projection generator | Projection fixture tests, schema validation, console read-model golden files, explicit proof that projection can be regenerated from authoritative run/evidence files. |
| Run Control API | Define Resource Contract-shaped persisted intents/results for run control operations that outgrow one-shot CLI calls, such as `FlowTransitionProposal`, `FlowExceptionAcceptance`, or `FlowRunControlAction`. | Future schemas, CLI/API docs, console docs | Request/result schema validation, transition guard tests, negative tests proving invalid jumps fail closed. |
| Review Queue | Define `FlowReviewQueue` projection schema with queue identity, grouping/filter spec, item refs, observed counts, freshness, and conditions. | Future schemas and console docs | Schema validation, projection fixture tests, queue grouping fixtures, stale/fresh condition tests. |
| Review Item | Define `FlowReviewItem` schema with subject, requested action, evidence refs, extension payload, decision status, authority, and conditions. | Future schemas and console docs | Schema validation, action transition tests, decision-history fixtures, extension payload passthrough tests. |

## Mapping Follow-Ups

These contracts should not be migrated directly in the next slice, but they need explicit mappings so future consumers do not guess.

| Contract | Mapping slice | Expected verification |
| --- | --- | --- |
| Flow Report | Document JSON report as a projection from `FlowRun.status`; optionally emit `apiVersion/kind/metadata/status` when `--format resource-json` is introduced. | Golden report fixtures comparing legacy report JSON with resource projection. |
| Gate Evidence Manifest | Define when the manifest itself needs `FlowEvidenceManifest` metadata and when plain manifest JSON remains sufficient; keep evidence files separately inspectable. | Manifest schema tests and evidence attach/evaluate tests. |
| Flow Config Merge Report | Add an optional resource projection where merge input references live in `spec` and conflicts/exceptions/summary live in `status`. | Preview/apply JSON fixtures and condition mapping tests. |
| Flow Definition Validation Result | Add a documented mapping from `valid/path/error_count/diagnostics` to `status.conditions` and validation summary fields if definition validation results are persisted, indexed, or exposed through a console/provider; keep `flow validate-definition --json` direct output unchanged. | Definition validation fixtures for valid definitions, malformed JSON, schema/shape failures, and semantic diagnostics; snapshot the legacy CLI JSON and the optional resource projection. |
| Flow Transition Validation Result | Add a documented mapping from `valid/status/diagnostics/transition` to `status.conditions` if results are persisted or indexed. | Transition validation fixtures for allowed, blocked, invalid, route-back, and wait results. |
| Examples and scenarios | Update examples only as the demonstrated contracts migrate; do not create standalone example resources. | Existing example validation plus schema drift checks. |

## Exceptions

- Neutral Surface TrustReport / Trust Snapshot evidence projection: `exception`. Resource Contract shape under Flow would make ownership less clear because this embedded artifact is intentionally Surface-shaped and product-neutral. Flow should evaluate the neutral fields and local integrity metadata, not wrap them as if Flow owns claim trust state.
- Flow Transition Validation Request: `exception`. Resource Contract shape would make this transient request envelope worse by adding status-oriented ceremony to a synchronous validation input. All meaningful fields are request inputs; the observed state belongs in the result.

No other durable contract is exempted from Resource Contract alignment. Contracts that are not ready to migrate are `map`, `defer/observe`, or `internal/not-a-contract`, not exceptions.

## Durable Versus Internal

Outward-facing durable artifacts:

- Flow Definition files.
- Flow Run state files.
- Flow Reports.
- Gate Evidence manifests and copied evidence.
- Flow Project Config.
- Flow Config Merge Reports.
- Transition validation request/result JSON accepted or emitted by CLI/library.
- Future Flow Console projections, Run Control records, Review Queues, Review Items, and Product Extension metadata once implemented.

Internal implementation-only shapes:

- Helper function inputs/outputs that are not documented CLI/library JSON contracts.
- In-memory normalized evidence, diagnostics, route metadata, merge change objects, projection objects, and render inputs before they are written or emitted.
- CLI argument parsing structures.
- Derived labels, summaries, and render-only view models.

Internal shapes should stay product-native unless a future change writes them to `.flow/`, documents them as stable API output, or exposes them to providers/adapters.

## Open Questions And Risks

- Resource Contract namespace and version for Flow should be confirmed before migration. ADR 0005 suggests `flow.kontourai.io/v1alpha1`; Flow v0.1 schemas currently use `schema_version: "0.1"` and `https://kontourai.io/schemas/...` identifiers.
- Backward compatibility needs an explicit policy. Existing examples and local `.flow` stores use v0.1 flat JSON shapes.
- The transition validation implementation is merged to `main`, but provider issue state for `flow#21` may lag. Before starting transition-related follow-up work, refresh provider state and issue/PR references.
- Flow Console, Review Queue, Review Item, Run Control API, and Flow Product Extension are directional contracts, not implemented schemas in current `main`. Their recommendation is planning guidance, not implementation evidence.
- The idea-to-backlog source artifact remains `NOT_VERIFIED`; do not cite it as durable source authority until found.
- Surface-shaped evidence is intentionally in scope only as Flow's neutral evidence projection. This audit does not evaluate Surface or Veritas native contracts.

## Publish And Verification Notes

- This document is the durable audit artifact for `flow#13`.
- No schema, runtime, package metadata, test, eval, or example migration is performed in this issue.
- The audit should be published or linked from `kontourai/flow#13` with the ADR 0005 source and the `NOT_VERIFIED` idea-to-backlog caveat.
- Future PRs should use this audit as planning input, not as proof that migration work already happened.
