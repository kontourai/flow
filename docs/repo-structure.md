# Flow Repo Structure

This guide documents where work belongs in the Flow repo and how to distinguish source, public contracts, fixtures, tooling, generated output, and workflow artifacts.

Flow is the process transparency and gate enforcement kernel. The repo structure must preserve that boundary: Flow is not an agent runtime, not Surface authority, not Veritas policy ownership, and not the Builder Kit adapter layer.

## Repo Areas

| Area | Purpose | Status and policy |
| --- | --- | --- |
| `src/` | Flow TypeScript source for the package runtime, CLI, transition validation, gate evaluation, reports, release readiness, and local run store behavior. | Tracked source. New Flow-owned runtime behavior belongs here. Keep provider-specific orchestration out of Flow core. |
| `src/console-ui/` | Local Flow Console browser UI source. | Tracked source. UI changes for `flow console` belong here. |
| `src/console-ui/vendor/console-kit/` | Vendored Console Kit styles and tokens used by the local console build. | Tracked vendor asset exception. Updated by `scripts/sync-console-kit-assets.mjs`; do not hand-edit generated copies without checking the sync script. |
| `schemas/` | Public JSON schemas for Flow Definitions, Flow Runs, Gate Evidence, Flow Reports, project config, config merge reports, transition validation, release readiness, and version release reports. | Tracked public contract assets and included in the npm package. New Flow-owned schema contracts belong here. |
| `examples/` | Published examples for authoring and using Flow Definitions. | Tracked package assets. New user-facing examples belong here. |
| `examples/fixtures/` | Fixture data used by checks and examples, including Surface claim evidence, release readiness records, version release reports, and console projection runs. | Tracked fixtures and included in the package. Keep test-only moves out of this tree until package contents and references are reviewed. |
| `examples/fixtures/console-projection/.flow/` | Intentionally tracked local-run fixture for console projection checks. | Tracked exception to the root `.flow/` ignore rule. This fixture proves console projection behavior and must stay inspectable. |
| `scripts/` | Node support tooling for schema/runtime checks, console projection checks, Console Kit asset sync/copy, console smoke checks, and repo hook setup/validation. | Tracked tooling. New repository support scripts belong here unless they are product runtime source. |
| `tests/browser/` | Playwright browser tests and the test server for the local Flow Console. | Tracked browser test lane. Browser-only console checks belong here. |
| `docs/` | Durable product, architecture, ADR, audit, and contributor documentation. | Tracked docs. New durable developer guidance belongs here; transient workflow notes do not. |
| `docs/adr/` | Accepted architecture decisions for Flow product boundaries and authority semantics. | Tracked decisions. Update through new ADRs when product authority changes. |
| `.github/` | GitHub Actions workflows for CI and package publishing. | Tracked repo operations. This is not Flow runtime behavior. |
| `.githooks/` | Optional contributor Git hooks. | Tracked contributor tooling. Installed locally by `npm run setup:repo-hooks`. |
| `.agents/` | Flow Agents and Kiro-style workflow artifacts for planning, execution, and handoff. | Ignored workflow artifacts. Current task artifacts may live under `.agents/flow-agents`, but production source must not depend on them. |
| `.flow/` | Local Flow project config and run store used by the CLI. | Ignored local runtime state at the repo root. The only tracked `.flow` tree is the console projection fixture under `examples/fixtures/console-projection/`. |
| `.surface/` | Local Surface state or artifacts. | Ignored local product state. Flow may consume Surface-shaped evidence files, but Surface owns trust semantics. |
| `.veritas/` | Local Veritas state or artifacts. | Ignored local product state. Veritas owns repo standards and merge readiness policy. |
| `dist/` | Build output for the npm package runtime, declarations, and compiled console assets. | Ignored generated output, but included by `package.json.files` after `npm run build` and `prepack`. Do not edit by hand. |
| `node_modules/` | Installed dependencies. | Ignored generated dependency install output. |
| `test-results/` | Playwright and local test output. | Ignored generated validation output. |
| `context/` | Optional local workflow context directories. | Not present in the clean repo. Do not make production code depend on it unless a future tracked contract is added deliberately. |
| `evals/` | Optional local evaluation workspace. | Not present in the clean repo. Treat future local eval material as untracked until tracked files define ownership. |

## Placement Rules

New Flow core behavior belongs in `src/`, with public exports preserved through the package root or explicit package subpath exports.

Flow core source is organized by runtime domain:

- `src/index.ts` is the package-root public export surface. Keep it thin.
- `src/flow-types.ts` owns public Flow contract types and schema/evidence constants.
- `src/flow-files.ts` owns `.flow` path helpers and JSON persistence helpers.
- `src/flow-utils.ts` owns shared labels, evidence-kind helpers, JSON cloning, and small type guards.
- `src/flow-config.ts` owns project config loading, preview/apply merge semantics, and config merge rendering.
- `src/flow-definition.ts` owns Flow Definition diagnostics, step/gate lookup, initial state, continuation, and route-back selection helpers.
- `src/flow-transition.ts` owns proposed transition validation.
- `src/flow-gates.ts` owns gate expectations, evidence matching, gate evaluation, and applying gate outcomes.
- `src/flow-evaluation-transition.ts` owns the bridge from evaluated gate outcomes to transition validation.
- `src/flow-release.ts` owns release readiness fixtures, lane evaluation, version release report projection, and version release Markdown rendering.
- `src/flow-run-store.ts` owns local run lifecycle operations, evidence attachment, trust artifact normalization, run evaluation, exceptions, and run listing.
- `src/flow-reports.ts` owns Flow Report JSON, Markdown report, summary, resume, and report file writing.

New CLI behavior belongs in `src/cli.ts` unless it becomes shared runtime behavior, in which case the shared logic should live in Flow-owned source and the CLI should remain a thin caller.

New local console UI code belongs in `src/console-ui/`. New console projection or server behavior belongs in `src/console-projection.ts` or `src/console-server.ts` when it is part of Flow's local console boundary.

New schemas belong in `schemas/` and should be validated by the schema check lane. New schema shape should use Flow vocabulary and avoid importing Surface, Veritas, Flow Agents, or Builder Kit authority into Flow core.

New docs belong in `docs/`. Use ADRs for durable decisions that change product ownership, authority, or compatibility expectations.

New examples belong in `examples/`. New fixtures belong in `examples/fixtures/` when they are package-visible examples or existing checks depend on published fixture paths. Use a separate migration plan before moving fixtures to a non-published test fixture tree.

New browser tests for the local console belong in `tests/browser/`. Node contract checks currently live in `scripts/check-*.mjs`; keep script moves separate from behavior changes because package scripts, hooks, and CI reference those paths.

New workflow planning, execution, review, or handoff artifacts belong under `.agents/flow-agents/` and remain ignored. They are evidence for work coordination, not Flow runtime contracts.

## Generated And Exported Artifacts

Generated local output stays ignored:

- `dist/` is generated by `npm run build`. It is ignored in git but exported in the npm package through `package.json.files`.
- `node_modules/` is dependency install output.
- `test-results/` and `playwright-report/` are browser validation output.
- Root `.flow/`, `.surface/`, `.veritas/`, and `.agents/` are local product or workflow state.

Tracked exceptions are intentional:

- `examples/fixtures/console-projection/.flow/**` is tracked even though root `.flow/` is ignored. It is a deterministic Flow Run fixture for console projection checks.
- `src/console-ui/vendor/console-kit/**` is tracked even though it is copied from `@kontourai/console-kit`. The local console build depends on these assets being present in source form before `dist/console-ui/` is generated.

Do not delete, move, or re-ignore tracked fixtures, schemas, examples, or vendored console assets without checking package contents, script references, browser tests, and `npm pack --dry-run`.

## Validation Lanes

`npm run build` syncs Console Kit assets, compiles Flow TypeScript, compiles console UI TypeScript, and copies console UI assets to `dist/console-ui/`.

`npm run typecheck` checks Flow TypeScript without writing output. `npm run typecheck:console-ui` checks the console UI project without writing output.

`npm test` runs the full local lane: build, Node check scripts, console smoke, and Playwright browser tests.

`npm run check:schemas` builds first, then runs schema and runtime contract checks in `scripts/check-schemas.mjs`.

`npm run check:console-kit-assets` verifies tracked vendored Console Kit assets match the installed package.

`npm run check:console-smoke` builds first, then validates the local console server smoke path.

`npm run test:browser` runs Playwright tests from `tests/browser/`.

`npm run check:repo-hooks`, `npm run setup:repo-hooks`, and `npm run validate:repo-hooks` cover contributor hook setup and validation. Hooks are repository tooling, not Flow gate semantics or merge authority.

## Boundary Reminders

Flow owns Flow Definitions, Flow Runs, Steps, Gates, Transitions, Gate Evidence, Exceptions, Flow Reports, continuation state, project config merge semantics, and local console projection.

Surface owns trust semantics. Flow consumes Surface-shaped artifacts where a gate expects `kind: "surface.claim"`, but Flow does not define global Surface trust meaning.

Veritas owns repo and change governance. Flow may record Veritas readiness as Gate Evidence, but Flow does not own Veritas requirements or merge readiness policy.

Flow Agents owns agent-facing distribution, modes, skills, runtime adapters, provider settings, and kit installation. Flow Agents may author or install Flow project config, but `.flow/config.json` remains the Flow authority source used during gate evaluation.

Builder Kit intent is represented to Flow as normal Flow Definitions, gate expectations, route-back maps, and config proposals. Flow core must not add Builder Kit-specific recovery policy or adapter behavior.
