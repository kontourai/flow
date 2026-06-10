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

Root `.flow/`, `.surface/`, and `.veritas/` are local product state and remain ignored. The tracked console projection scenario under `examples/scenarios/console-projection/.flow/` is the intentional exception.

## Release Prep

Before a release PR, update `package.json`, `package-lock.json`, and `CHANGELOG.md`, then run:

```sh
npm run typecheck
npm run build
npm test
npm pack --dry-run --cache /private/tmp/flow-npm-cache
```

Publishing is handled by the repository's tag-triggered GitHub workflow after the release PR is merged.
