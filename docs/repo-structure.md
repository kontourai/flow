# Flow Repo Structure

This guide documents where work belongs in the Flow repo and how to distinguish source, public contracts, examples, scenario data, tooling, and generated output.

Flow is the process transparency and gate enforcement kernel. The repo structure must preserve that boundary: Flow is not an agent runtime, not Surface authority, not Veritas policy ownership, and not the Builder Kit adapter layer.

## Repo Areas

| Area | Purpose | Status and policy |
| --- | --- | --- |
| `src/` | Flow TypeScript source for the package runtime, CLI, transition validation, gate evaluation, reports, release readiness, and local run store behavior, organized by domain folders. | Tracked source. New Flow-owned runtime behavior belongs here. Keep provider-specific orchestration out of Flow core. |
| `src/console-ui/` | Local Flow Console browser UI source. | Tracked source. UI changes for `flow console` belong here. |
| `src/console-ui/vendor/ui/` | Vendored Kontour UI styles, tokens, and the Flow product mark used by the local console build. | Tracked vendor asset exception. Updated by `scripts/sync-ui-assets.mjs`; do not hand-edit generated copies without checking the sync script. |
| `schemas/` | Public JSON schemas for Flow Definitions, Flow Runs, Gate Evidence, Flow Reports, project config, config merge reports, transition validation, release readiness, and version release reports. | Tracked public contract assets and included in the npm package. New Flow-owned schema contracts belong here. |
| `examples/` | Published examples for authoring and using Flow contracts. | Tracked package assets. New user-facing examples belong here and must be documented in `examples/README.md`. |
| `examples/scenarios/` | Published scenario data used by examples and checks, including Surface claim evidence, release readiness records, version release reports, and console projection runs. | Tracked package assets. Keep test-only data out of this tree unless it is also useful as a package-visible example and covered by the package contents check. |
| `examples/scenarios/console-projection/runtime-fixture/` | Durable source fixture for console projection checks. | Tests and smoke scripts copy it into ignored `.kontourai/flow/runs/` state before exercising runtime APIs. |
| `CHANGELOG.md` | Human-readable release history for published package versions. | Tracked package asset. Update when cutting a release that changes developer-facing behavior, package contents, or release operations. |
| `scripts/` | Operational Node tooling for Kontour UI asset sync/copy, console smoke checks, and repo hook setup/validation. | Tracked tooling. New repository support scripts belong here unless they are product runtime source or a test suite. |
| `scripts/docs-site/` | TypeScript generator, stylesheet, and favicon for the GitHub Pages docs site. | Tracked tooling. Built by `npm run docs:build` into the ignored `site/` directory and deployed by the `Docs` workflow. |
| `tests/node/` | Node test suites for schema/runtime contracts, package contents, repo hook wiring, and console projection. Domain files keep package runtime, CLI, config, definitions, transitions, release checks, Surface claim handling, route-back behavior, and reports separate. | Tracked Node test lane. Node tests belong here instead of `scripts/`. Shared test-only helpers belong in `tests/node/helpers/`. |
| `tests/browser/` | Playwright browser tests and the test server for the local Flow Console. | Tracked browser test lane. Browser-only console checks belong here. |
| `docs/` | Durable product, architecture, ADR, and contributor documentation. | Tracked docs. Start with `docs/README.md` when deciding which guide to edit. New durable developer guidance belongs here. |
| `docs/adr/` | Accepted architecture decisions for Flow product boundaries and authority semantics. | Tracked decisions. Update through new ADRs when product authority changes. |
| `.github/` | GitHub Actions workflows for CI and package publishing. | Tracked repo operations. This is not Flow runtime behavior. |
| `.githooks/` | Optional contributor Git hooks. | Tracked contributor tooling. Installed locally by `npm run setup:repo-hooks`. |
| `.flow/` | Durable authored Flow project state: config and definitions. | Project-native authored location. Older generated `.flow/runs/` state is migration input only and is not read by current runtime commands. |
| `.kontourai/` | Generated Flow runtime state. | Ignored repository boundary. New Flow Runs live under `.kontourai/flow/runs/`. |
| `.kontourai/surface/` | Local Surface-generated state or artifacts. | Ignored through the common `.kontourai/` boundary. Flow may consume Surface-shaped evidence files, but Surface owns trust semantics. |
| `.kontourai/veritas/` | Local Veritas-generated state or artifacts. | Ignored through the common `.kontourai/` boundary. Veritas owns repo standards and merge readiness policy. |
| `dist/` | Build output for the npm package runtime, declarations, and compiled console assets. | Ignored generated output, but included by `package.json.files` after `npm run build` and `prepack`. Do not edit by hand. |
| `node_modules/` | Installed dependencies. | Ignored generated dependency install output. |
| `test-results/` | Playwright and local test output. | Ignored generated validation output. |
| `site/` | Generated docs site output from `npm run docs:build`. | Ignored generated output. Deployed to GitHub Pages by the `Docs` workflow; do not edit by hand. |
| `docs/assets/` | Screenshots and images referenced by docs and the docs site. | Tracked docs assets. Regenerate screenshots from the real console when behavior changes. |
| `evals/` | Optional local evaluation workspace. | Not present in the clean repo. Treat future local eval material as untracked until tracked files define ownership. |

## Placement Rules

New Flow core behavior belongs in `src/`, with public exports preserved through the package root.

Flow core source is organized by runtime domain:

- `src/index.ts` is the package-root public export surface. Keep it thin.
- `src/contracts/flow-types.ts` owns public Flow contract types and schema/evidence constants.
- `src/runtime/flow-files.ts` owns authored `.flow` and generated `.kontourai/flow` path helpers plus JSON persistence helpers.
- `src/runtime/flow-run-store.ts` owns local run persistence, authority-bearing lifecycle operations, evidence attachment, trust artifact normalization, run evaluation, exceptions, and run listing; `src/runtime/flow-run-lifecycle.ts` owns provider-neutral lifecycle validation and diagnostics. Lifecycle history remains separate from Step transition history.
- `src/shared/flow-utils.ts` owns shared labels, evidence-kind helpers, JSON cloning, and small type guards.
- `src/config/flow-config.ts` owns project config loading, preview/apply merge semantics, and config merge rendering.
- `src/definition/flow-definition.ts` owns Flow Definition diagnostics, step/gate lookup, initial state, continuation, and route-back selection helpers.
- `src/transition/flow-transition.ts` owns proposed transition validation.
- `src/transition/flow-evaluation-transition.ts` owns the bridge from evaluated gate outcomes to transition validation.
- `src/gates/flow-gates.ts` owns gate expectations, evidence matching, gate evaluation, and applying gate outcomes.
- `src/release/flow-release.ts` owns release readiness fixtures, lane evaluation, version release report projection, and version release Markdown rendering.
- `src/reports/flow-reports.ts` owns Flow Report JSON, Markdown report, summary, resume, and report file writing.
- `src/console/` owns local console projection and server implementations.
- `src/kit/` owns Flow Kit container validation (`validateKitContainer`, `validateKitContainerFile`). The kit container contract is the distribution unit for portable workflow bundles; consumer products extend it rather than modifying it.

New CLI behavior belongs in `src/cli.ts` unless it becomes shared runtime behavior, in which case the shared logic should live in Flow-owned source and the CLI should remain a thin caller.

New local console UI code belongs in `src/console-ui/`. New console projection or server behavior belongs in `src/console/` when it is part of Flow's local console boundary.

New schemas belong in `schemas/` and should be validated by the schema check lane. New schema shape should use Flow vocabulary and avoid importing Surface, Veritas, Flow Agents, or Builder Kit authority into Flow core.

New docs belong in `docs/`. Update `docs/README.md` when adding, renaming, or retiring a durable guide. Use ADRs for durable decisions that change product ownership, authority, or compatibility expectations. Historical cleanup notes and one-time setup notes should be removed once their decisions are reflected in current docs or source.

New examples belong in `examples/`. New package-visible scenario data belongs in `examples/scenarios/`. Test-only fixtures should live with the tests that own them. Any new published example or scenario must be documented and asserted by `tests/node/check-package-contents.test.mjs`.

New browser tests for the local console belong in `tests/browser/`. New Node contract or package checks belong in the closest domain file under `tests/node/`, with reusable setup in `tests/node/helpers/`. Keep `scripts/` for operational tools that set up, build, copy, sync, or smoke-run repo behavior.

## Generated And Exported Artifacts

Generated local output stays ignored:

- `dist/` is generated by `npm run build`. It is ignored in git but exported in the npm package through `package.json.files`.
- `node_modules/` is dependency install output.
- `test-results/` and `playwright-report/` are browser validation output.
- Root `.kontourai/` is the common ignore boundary for generated product state, with product-owned namespaces such as `flow/`, `surface/`, and `veritas/`. `.flow/config.json` and `.flow/definitions/` remain durable authored Flow state.

Tracked exceptions are intentional:

- `examples/scenarios/console-projection/runtime-fixture/**` is durable source data, not live runtime state. Checks materialize it under the ignored canonical root before calling file-backed runtime APIs.
- `src/console-ui/vendor/ui/**` is tracked even though it is copied from `@kontourai/ui`. The local console build depends on these assets being present in source form before `dist/console-ui/` is generated.

Do not delete, move, or re-ignore tracked scenarios, schemas, examples, or vendored console assets without checking package contents, script references, browser tests, and `npm pack --dry-run`.

## Validation Lanes

`npm run build` syncs Kontour UI assets, compiles Flow TypeScript, compiles console UI TypeScript, and copies console UI assets to `dist/console-ui/`.

`npm run typecheck` checks Flow TypeScript without writing output. `npm run typecheck:console-ui` checks the console UI project without writing output.

`npm test` runs the full local lane: build, Node tests under `tests/node/`, console smoke, and Playwright browser tests.

`npm run check:schemas` builds first, then runs the split Node schema/runtime contract lane under `tests/node/`.

`npm run check:ui-assets` verifies tracked vendored Kontour UI assets match the installed package.

`npm run check:console-smoke` builds first, then validates the local console server smoke path.

`npm run test:browser` runs Playwright tests from `tests/browser/`.

`npm run docs:build` generates the GitHub Pages docs site into `site/` from `docs/` and the page list in `scripts/docs-site/build.ts`.

`npm run check:repo-hooks`, `npm run setup:repo-hooks`, and `npm run validate:repo-hooks` cover contributor hook setup and validation. Hooks are repository tooling, not Flow gate semantics or merge authority.

Contributor setup lives in [contributing.md](contributing.md).

`tests/node/check-package-contents.test.mjs` runs `npm pack --dry-run --ignore-scripts --json` and asserts the package includes only the intended top-level surfaces plus documented public examples and scenarios.

## Boundary Reminders

Flow owns Flow Definitions, Flow Runs, Steps, Gates, Transitions, Gate Evidence, Exceptions, Flow Reports, continuation state, project config merge semantics, and local console projection.

Local Flow Run directories under `.kontourai/flow/runs/<run-id>/` are generated runtime state. `definition.json` is the normalized definition snapshot, `state.json` is the authoritative continuation state, `evidence/manifest.json` is the evidence index, `evidence/<id>.*` are copied artifacts, and `report.md`/`report.json` are derived reports. `.flow/config.json` and `.flow/definitions/` remain durable authored state. Existing `.flow/runs/<run-id>/` directories must be migrated explicitly and are never runtime fallback locations.

Surface owns trust semantics. Flow consumes TrustBundle-compatible artifacts where a gate expects `kind: "trust.bundle"`, but Flow does not define global Surface trust meaning.

Veritas owns repo and change governance. Flow may record Veritas readiness as Gate Evidence, but Flow does not own Veritas requirements or merge readiness policy.

Flow Agents owns agent-facing distribution, modes, skills, runtime adapters, provider settings, and kit installation. Flow Agents may author or install Flow project config, but `.flow/config.json` remains the Flow authority source used during gate evaluation.

Builder Kit intent is represented to Flow as normal Flow Definitions, gate expectations, route-back maps, and config proposals. Flow core must not add Builder Kit-specific recovery policy or adapter behavior.
