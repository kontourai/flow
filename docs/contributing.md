# Contributing

This document is for people changing this repository. Package behavior and user-facing CLI/library contracts stay in the README.

## Local Setup

```sh
npm install
npm run build
npm test
```

`npm run build` syncs Console Kit assets, compiles the TypeScript runtime, compiles the local console UI, and writes package output under `dist/`.

`npm test` runs the full local lane: build, Node contract checks, local console smoke, and Playwright browser tests.

## Optional Git Hooks

Flow includes optional repo-local Git hooks for contributors:

```sh
npm run setup:repo-hooks
npm run validate:repo-hooks
```

Setup is idempotent and writes only this repository's local Git config: `core.hooksPath=.githooks`. The tracked `pre-push` hook runs the bounded local lane, `npm test` and `npm run check:schemas`.

These hooks are contributor tooling. They are not Flow Definition semantics, not Flow Run state, not gate evaluation, not Flow Console behavior, and not CI or merge authority.

## Source Layout

Flow core runtime sources live under domain folders in `src/`: contracts, runtime storage, shared helpers, config, definitions, gates, transitions, reports, release checks, console implementation, and console UI. The root `src/index.ts` is the package public API surface, and `src/cli.ts` is the `flow` CLI entrypoint.

`npm run typecheck` validates runtime sources without writing output, and `npm run build` emits the package runtime to `dist/` with `.d.ts` declarations. Package consumers use the package root, root declarations, and the `dist/cli.js` bin; `prepack` runs the typecheck and local tests so the published package is built from the TypeScript sources.

Node test suites live under domain files in `tests/node/`, shared Node test helpers live under `tests/node/helpers/`, and browser tests live under `tests/browser/`. The remaining JavaScript/MJS files in `scripts/` are operational repository tools, `.githooks/pre-push` is shell contributor tooling, and schemas, examples, and scenarios remain JSON/data assets rather than TypeScript modules.

For placement rules and generated artifact policy, see [repo-structure.md](repo-structure.md).

Root `.kontourai/` is the common ignored boundary for generated Kontour product state; each product owns its namespace beneath it, including `.kontourai/flow/`, `.kontourai/surface/`, and `.kontourai/veritas/`. Authored `.flow/config.json` and `.flow/definitions/` are durable and Git-visible. Older `.flow/runs/` state is also visible so operators can migrate it explicitly; current runtime commands do not read it. The console projection source fixture lives under `examples/scenarios/console-projection/runtime-fixture/` and is materialized into the ignored canonical root for runtime checks.

## Docs Site

The GitHub Pages site is generated from `README.md` content and `docs/` by `scripts/docs-site/build.ts` (TypeScript, run directly with Node >= 22.18 native type stripping):

```sh
npm run docs:build
```

Output lands in `site/` (ignored). The `Docs` GitHub workflow builds and deploys the site on pushes to `main` that touch `docs/` or `scripts/docs-site/`. When adding, renaming, or retiring a guide, update both `docs/README.md` and the page list in `scripts/docs-site/build.ts`.

## Demo Recording

`docs/assets/flow-demo.gif` is recorded from the committed tape with [VHS](https://github.com/charmbracelet/vhs). Regenerate it after CLI output changes:

```sh
sh scripts/docs-site/record-demo.sh
```

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please): merges to main accumulate into a release PR, and merging that PR tags the version and dispatches the npm publish workflow. For the automation to infer versions, use conventional commit prefixes on main-bound changes: `feat:` (minor), `fix:` (patch), `feat!:`/`BREAKING CHANGE` (major), and `docs:`/`chore:`/`refactor:` for no-release changes.

## Release Prep

Before a release PR, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, then run:

```sh
npm run typecheck
npm run build
npm test
npm pack --dry-run --cache /private/tmp/flow-npm-cache
```

Publishing is handled by the repository's tag-triggered GitHub workflow after the release PR is merged.
