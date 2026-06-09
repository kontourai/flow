# Dead Code And Reference Audit

Date: 2026-06-09

This audit supports repo sprawl cleanup without moving or deleting runtime, package, source,
schema, example, fixture, or console files. It records package boundaries, script/tooling
references, fixture dependencies, generated artifact policy, and cleanup candidates that
need a decision before any removal.

## Boundary Guardrails

Flow remains the process transparency and gate enforcement layer described in `CONTEXT.md`
and ADRs 0001-0003. This cleanup must not reclassify Flow as an agent runtime, task board,
repo standards engine, Flow Agents adapter layer, Builder Kit special case, Surface authority,
or Veritas policy owner. The checked boundaries are:

- Flow owns Definitions, Runs, Steps, Gates, Transitions, Gate Evidence, Exceptions,
  Flow Reports, continuation state, and project config merge semantics.
- Flow does not own Surface trust semantics, Veritas repo standards or merge readiness,
  agent runtime execution, multi-agent orchestration, Flow Agents modes/skills/providers,
  or runtime adapters.
- `.flow/config.json` remains the project authority source for trusted producers and gate
  overrides. `kind: "surface.claim"` remains a typed Flow expectation, not a provider adapter.

No `src/`, `schemas/`, examples, fixtures, package manifest, README, or repo-structure docs
were edited by this audit.

## Commands Used

| Command | Concise result |
| --- | --- |
| `git status --short` | Clean before audit edits. |
| `rg --files .agents/flow-agents/repo-sprawl-cleanup-plan context/contracts docs \| sort` | Found plan/session sidecars and docs; `context/contracts/*.md` files were absent. |
| `find context evals -maxdepth 4 -print` | Initially found only empty local directories under `context/` and `evals/`; no files. Those empty local placeholders were removed with `rmdir`. |
| `git ls-files \| sort` | Tracked source includes `src/`, `schemas/`, `examples/`, scripts, browser tests, docs, workflows, hooks, and hidden console `.flow` fixture files. |
| `node -e "const p=require('./package.json'); ..."` | Package exposes root, `./console-projection`, `./console-server`, bin `flow`, files `dist/`, `schemas/`, `examples/`, `README.md`, `LICENSE`, and documented npm scripts. |
| `rg -n "scripts/\|check-schemas\|check-console-projection\|..." . --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json'` | Every tracked `scripts/*.mjs` file is referenced by `package.json`, another script, README, or hook tests. |
| `rg -n "examples/fixtures\|console-projection\|surface-claims\|release-readiness\|version-release-report\|\\.flow/runs" . --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json'` | Fixture trees are referenced by README, scripts/checks, browser server/tests, and docs. |
| `rg -n "console-kit\|vendor/console-kit\|tokens/\|copy-console-ui\|sync-console-kit-assets\|console-ui" . --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json'` | Vendored Console Kit assets are referenced by `src/console-ui/index.html`, sync/copy scripts, tsconfigs, package scripts, and dependency metadata. |
| `rg -n "from ['\"]\|import\\(\|require\\(" src scripts tests --glob '!node_modules/**' --glob '!dist/**'` | Import map confirms public exports and tests rely on built `dist/*` plus source internals. |
| `git status --short --ignored context evals dist test-results .agents .flow .surface .veritas node_modules \| head -200` | Ignored generated/local dirs present: `.agents/`, `dist/`, `node_modules/`, `test-results/`. `context/` and `evals/` were not tracked or ignored. |
| `git ls-files context evals dist test-results .agents .flow .surface .veritas node_modules` | No tracked files in those top-level local/generated directories. Tracked `.flow` files live only under the explicit fixture exception path. |
| `npm pack --dry-run --ignore-scripts` | Failed because the user npm cache has root-owned files under `/Users/brian/.npm/_cacache/tmp`. |
| `npm pack --dry-run --ignore-scripts --cache /private/tmp/flow-npm-cache` | Succeeded. Tarball has 74 files and includes `dist/`, `schemas/`, `examples/`, README, LICENSE, and the tracked `examples/fixtures/console-projection/.flow/...` fixture. |

## Package Boundary Map

`package.json` defines the public package surface:

| Surface | Source/build path | Disposition |
| --- | --- | --- |
| package root `@kontourai/flow` | `src/index.ts` builds to `dist/index.js` and `dist/index.d.ts` | Keep. Root public API and types. |
| `@kontourai/flow/console-projection` | `src/console-projection.ts` builds to `dist/console-projection.js` and `.d.ts` | Keep. Explicit export; README and checks import it. |
| `@kontourai/flow/console-server` | `src/console-server.ts` builds to `dist/console-server.js` and `.d.ts` | Keep. Explicit export; console smoke and browser server use it. |
| bin `flow` | `src/cli.ts` builds to `dist/cli.js` | Keep. CLI commands are documented and tested. |
| package files | `dist/`, `schemas/`, `examples/`, `README.md`, `LICENSE` | Keep as published surface unless a package migration is planned. |

`npm pack --dry-run --ignore-scripts --cache /private/tmp/flow-npm-cache` confirms the tarball currently includes built console UI assets, public schemas, public examples, fixture README files, and the hidden console projection `.flow` fixture.

## Script And Tooling Map

All tracked files in `scripts/` have live references:

| Script file | Referenced by | Purpose | Disposition |
| --- | --- | --- | --- |
| `scripts/sync-console-kit-assets.mjs` | `build`, `sync:console-kit`, `check:console-kit-assets` | Copies/checks vendored Console Kit assets from `@kontourai/console-kit`. | Keep. |
| `scripts/copy-console-ui.mjs` | `build` | Copies console HTML/CSS/vendor assets into `dist/console-ui`. | Keep. |
| `scripts/check-schemas.mjs` | `test`, `check:schemas`, `.githooks/pre-push`, hook tests | Node schema/runtime/fixture contract checks. | Keep. |
| `scripts/check-console-projection.mjs` | `test` | Projection fixture and package export checks. | Keep. |
| `scripts/check-console-smoke.mjs` | `test`, `check:console-smoke` | Local console smoke through built server/UI. | Keep. |
| `scripts/check-repo-hooks.mjs` | `test`, `check:repo-hooks`, `validate-repo-hooks` | Tests hook setup/validation scripts and README references. | Keep. |
| `scripts/setup-repo-hooks.mjs` | `setup:repo-hooks`, hook tests, README | Configures local `core.hooksPath=.githooks`. | Keep. |
| `scripts/validate-repo-hooks.mjs` | `validate:repo-hooks`, hook tests, README | Validates local hook config. | Keep. |

No tracked script is unreferenced by the package scripts/readme/test graph. Script organization may still be clarified in docs, but file moves would require package, README, hook, and CI updates.

## Tests And Fixture Reference Map

| Area | Evidence | Disposition |
| --- | --- | --- |
| `tests/browser/console-ui.spec.ts` | Uses Playwright against `tests/browser/serve-flow-console.mjs`; asserts console title/status for `console-projection-fixture`. | Keep. Browser lane. |
| `tests/browser/serve-flow-console.mjs` | Imports `dist/console-server.js`; serves run id `console-projection-fixture` from `examples/fixtures/console-projection`. | Keep. Depends on built dist and tracked fixture. |
| `examples/fixtures/console-projection/.flow/...` | Referenced by `scripts/check-console-projection.mjs`, `scripts/check-console-smoke.mjs`, browser server/tests, README console examples, and package dry-run. | Keep. Intentional tracked `.flow` exception. |
| `examples/fixtures/surface-claims/*` | Referenced by `scripts/check-schemas.mjs`, fixture README, and product boundary/resource docs. | Keep. Surface-shaped evidence fixture. |
| `examples/fixtures/release-readiness/*` | Referenced by `scripts/check-schemas.mjs`, README, fixture README, and docs. | Keep. Release readiness fixture. |
| `examples/fixtures/version-release-report/*` | Referenced by `scripts/check-schemas.mjs`, README commands, fixture README, and package dry-run. | Keep. CLI/report fixture. |
| `examples/*.json` | Public examples included by package files and README/docs. | Keep. Published package data. |

## Console Kit Vendor Map

`src/console-ui/vendor/console-kit/*` is tracked vendored source, not generated build output.
It is synchronized from `node_modules/@kontourai/console-kit` by `scripts/sync-console-kit-assets.mjs`,
checked by `npm run check:console-kit-assets`, linked by `src/console-ui/index.html`, copied to
`dist/console-ui/vendor` by `scripts/copy-console-ui.mjs`, and included in package output through
`dist/`.

Disposition: keep. Removing these tracked assets would break local source builds when package assets
are checked before copy, and would make the console dependent on package-manager state at runtime.

## Generated And Local Artifact Policy

| Path | Status | Disposition |
| --- | --- | --- |
| `dist/` | Ignored generated build output, but required package content via `package.json.files`. | Keep ignored; build/prepack must generate it before publish. |
| `node_modules/` | Ignored dependency install output. | Keep ignored. |
| `.agents/` | Ignored workflow artifact area. This task writes only session artifacts under `.agents/flow-agents/...`. | Keep ignored; not production Flow source. |
| `.flow/` | Ignored local Flow run/config store. | Keep ignored, except tracked fixture exception. |
| `examples/fixtures/console-projection/.flow/**` | Explicit tracked exception to `.flow/` ignore rule. | Keep tracked; package and tests depend on it. |
| `.surface/` | Ignored local Surface state/artifacts. | Keep ignored; Flow does not own Surface authority. |
| `.veritas/` | Ignored local Veritas state/artifacts. | Keep ignored; Flow does not own Veritas policy. |
| `test-results/`, `playwright-report/` | Ignored test output. | Keep ignored. |
| `context/` | Empty untracked local directories were present earlier in this checkout. | Removed with `rmdir`; no tracked files were affected. |
| `evals/` | Empty untracked local directories were present earlier in this checkout. | Removed with `rmdir`; no tracked files were affected. |

## Dead-Code Candidates And Disposition

| Candidate | Evidence | Classification | Disposition |
| --- | --- | --- | --- |
| Empty local `context/` directories | `find context evals -maxdepth 4 -print` found directories only; `git ls-files context` found none; referenced contract files were absent. | Safe local cleanup candidate. | Removed with `rmdir`; no tracked files were affected. |
| Empty local `evals/` directories | `find` found directories only; `git ls-files evals` found none. | Safe local cleanup candidate. | Removed with `rmdir`; no tracked files were affected. |
| Ignored local `dist/` | Ignored by `.gitignore`; package dry-run includes it because current workspace has built output and package files require it. | Generated output, not dead code. | Keep ignored; do not delete in cleanup unless explicitly doing local housekeeping after rebuild verification. |
| Ignored `.agents/`, `test-results/`, `node_modules/` | `git status --short --ignored ...` reports ignored dirs; no tracked files in top-level query. | Generated/local artifacts. | Keep ignored. Do not classify as source. |
| `examples/fixtures/console-projection/.flow/**` | Explicit `.gitignore` exception; referenced by projection/smoke/browser checks and included in package dry-run. | Not dead. | Keep. |
| `src/console-ui/vendor/console-kit/**` | Referenced by HTML, sync/copy scripts, package scripts, and package dependency. | Not dead. | Keep. |
| `scripts/*.mjs` | Every tracked script is referenced by package scripts, README, hook tests, or another script. | Not dead. | Keep; docs can group by purpose. |
| `examples/fixtures/*` under published `examples/` | Referenced by tests/docs and included in published package. | Needs product/package decision before any move. | Keep now; future relocation would need migration notes and package dry-run review. |
| `src/index.ts` monolith | Public root export and core implementation; large but referenced by CLI, projection, scripts, and package export. | Architecture/refactor candidate, not dead code. | Keep now; split only after API tests and plan approval. |

## Safe Removal Controls For Future Cleanup

Before deleting or relocating any candidate beyond local empty directories:

1. Re-run reference checks for exact paths and exported names.
2. Preserve `package.json` exports, bin, and `files` behavior or record an intentional package migration.
3. Run `npm run build`, `npm test`, `npm run check:schemas`, `npm run test:browser`,
   `npm run check:console-kit-assets`, and `npm pack --dry-run`.
4. Review `git diff --stat`, `git diff --name-only`, and targeted diffs for `src/`, `schemas/`,
   `examples/`, package exports, and docs.
5. Record migration notes when moving published examples/fixtures or public build outputs.

## Gaps And Risks

- `context/contracts/artifact-contract.md` and `context/contracts/execution-contract.md` were requested by the worker contract but are absent in this checkout. The task proceeded from the explicit plan and prompt.
- The first package dry-run failed on the user npm cache permissions. The rerun with `--cache /private/tmp/flow-npm-cache` succeeded and did not require source changes.
- This audit did not run the full build/test/browser suite because the requested change is docs-only metadata and package dry-run was the relevant package-boundary check. Future removal work should run the full controls above.
