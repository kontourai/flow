# Contributing

This file is intentionally short.

The main docs in this repo are written for people installing and using Flow.
This file is the footnote for people developing the product itself.

## Development Rules

- Flow is the process-transparency kernel: definitions, runs, gates, evidence, route-back, reports — keep it provider-neutral; no agent-runtime, hosted-service, or product-specific behavior in core
- public contracts are JSON Schemas in `schemas/` and published examples in `examples/` — treat them as compatibility-sensitive
- `dist/`, `site/`, and `test-results/` are generated validation/build output; Flow-owned generated product state lives under `.kontourai/flow/` and must not be hand-edited; root `.flow/config.json` and `.flow/definitions/` are durable authored state
- `git add` new examples before running the package-contents test — it compares against tracked files
- see `docs/contributing.md` for detailed contributor guidance including hook setup and demo-GIF regeneration

## Setup

```bash
npm install
```

Node >= 22 is required.

## Verification

Before opening a PR:

```bash
npm test
```

This runs the build, contract type checks, Node tests, console smoke check, and browser tests.

Individual checks by change type:

- runtime/CLI/schema changes: `npm test`
- docs or docs-site changes: `npm run docs:check`
- new examples or scenarios: `git add` them first, then `npm run check:schemas`
- package metadata, exports, or files changes: `npm run check:package-contents`

## PR Expectations

- one concern per PR; keep diffs reviewable
- update `schemas/` and `examples/` when the public contract changes
- use conventional commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`) — releases are automated with release-please

## Releases

Releases are automated with release-please: merges to main accumulate into a release PR, and merging it tags the version and dispatches the npm publish workflow.

## Repository

https://github.com/kontourai/flow

All projects are Apache-2.0.
