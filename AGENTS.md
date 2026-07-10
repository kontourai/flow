# Flow Agent Guidance

Flow is the process-transparency kernel: definitions, runs, gates, evidence, route-back, reports. Keep it provider-neutral — no agent-runtime, hosted-service, or product-specific behavior in core.

## Source Of Truth

- Product and vocabulary context: `CONTEXT.md`; docs map: [docs/README.md](docs/README.md).
- Runtime source lives in `src/` by domain; placement rules: [docs/repo-structure.md](docs/repo-structure.md).
- Public contracts are JSON Schemas in `schemas/`; published examples in `examples/` (registered by the package-contents test).
- `dist/`, `site/`, and `test-results/` are generated validation/build output. Flow-owned generated product state lives under `.kontourai/flow/`; never hand-edit it. Root `.flow/config.json` and `.flow/definitions/` are durable authored state.

## Pull More Context When Needed

- Gate semantics, route-back, transitions: [docs/gates-and-route-back.md](docs/gates-and-route-back.md).
- Evidence kinds, trust artifacts, supersession: [docs/evidence.md](docs/evidence.md).
- Ownership boundaries (Surface/Veritas/Flow Agents): [docs/product-vision.md](docs/product-vision.md).
- Contributor setup, hooks, demo-GIF regeneration, releases: [docs/contributing.md](docs/contributing.md).

## Match Checks To Change Type

- Runtime/CLI/schema changes: `npm test` (build, contract checks, Node tests, console smoke, browser tests).
- Docs or docs-site changes: `npm run docs:check`.
- New examples/scenarios: `git add` them first — the package-contents test compares against tracked files.
- Releases are automated (release-please); use conventional commit prefixes. See [docs/contributing.md](docs/contributing.md).

## Useful Commands

- `npm test` · `npm run typecheck` · `npm run docs:check` · `npm run check:schemas` · `node dist/cli.js --help`
