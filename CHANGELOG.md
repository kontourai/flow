# Changelog

## [0.2.0](https://github.com/kontourai/flow/compare/v0.1.20...v0.2.0) (2026-06-12)


### Features

* Flow Kit container spec — kits are Flow's distribution unit ([df68d6e](https://github.com/kontourai/flow/commit/df68d6e72028754b556f385003a2a2ad9b6f9777))
* Flow Kit container spec — kits are Flow's distribution unit ([32d5351](https://github.com/kontourai/flow/commit/32d5351efe0d6cb337fdaa33651b425e7c48edf7))


### Fixes

* register Flow Kit Container page in docs site build ([3f51985](https://github.com/kontourai/flow/commit/3f51985c05bae7a4f9217abe470658d6043dea29))

## [0.1.20](https://github.com/kontourai/flow/compare/v0.1.19...v0.1.20) (2026-06-12)


### Fixes

* **ci:** author release PRs via kontour-release-bot app token ([0bb0684](https://github.com/kontourai/flow/commit/0bb068425331348a16b1537499881a3e8235896c))


### Documentation

* route-back reason reference table; governance files ([49c7546](https://github.com/kontourai/flow/commit/49c75465ec4e0c510267b2326c00231188e5f63b))

## [0.1.19](https://github.com/kontourai/flow/compare/v0.1.18...v0.1.19) (2026-06-11)


### Documentation

* AGENTS.md — small map with links for fresh agents ([#63](https://github.com/kontourai/flow/issues/63)) ([f7a3692](https://github.com/kontourai/flow/commit/f7a3692f74ee5c6e5d3c9e73feea904b3f1d87a1))

## 0.1.18

- Completed runs now report "run complete; no further action required"
  instead of repeating the final gate's attach-evidence instruction.
- Commits the VHS demo tape and a regeneration script
  (`scripts/docs-site/record-demo.sh`) so the README recording can be
  refreshed when CLI output changes.
- Adds evidence supersession: `flow attach-evidence --supersede <evidence-id>`
  marks earlier same-gate evidence as replaced. Superseded entries stay in the
  manifest for audit but no longer drive gate outcomes, making the route-back
  "replace failing evidence" instruction executable.
- Adds the `examples/scenarios/adversarial-survey/` scenario: the adversarial
  route-back pattern run end to end with Survey-shaped per-round review
  evidence, including recovery through supersession.
- Cross-links the Kontour family throughout the docs and adds a Survey row to
  the product table.

## 0.1.17

- Fixes `flow init` failing to copy the bundled sample definition after the
  `src/runtime/` move: `moduleRoot()` now resolves the package root by locating
  `package.json` instead of assuming a fixed directory depth, and CLI runtime
  tests cover the init scaffold path.
- Adds `flow init --demo`, which scaffolds a ready-made `demo` run (plan gate
  passed, sitting at implement) so status, resume, and the console have real
  state to show immediately; `scaffoldDemoRun` is exported from the package
  root.
- Adds `flow evaluate --exit-code` for CI and agent-hook enforcement: exits
  non-zero unless every evaluated gate passed.
- Surfaces gate expectation `explore_hint` text on blocked gates in `flow
  status` summaries and `flow resume` output.
- Prints a friendly empty state from `flow list` when no runs exist.
- Restructures documentation: focused guides for getting started, use cases,
  evidence, gates and route-back, agent hooks, project config, release
  readiness, the CLI, and the library; merges product boundaries and market
  positioning into the product vision; retires the standalone adversarial-pass
  note into the gates guide.
- Adds a Kontour-branded, mobile-optimized GitHub Pages docs site built by
  `npm run docs:build` (`scripts/docs-site/build.ts`), checked by
  `npm run docs:check` in CI, and deployed by the `Docs` workflow.

## 0.1.16

- Collapses the npm package API to the `@kontourai/flow` root import plus the
  `flow` CLI, removing console package subpaths.
- Removes root compatibility source shims for console projection, console
  server, and runtime file helpers while keeping those APIs available from the
  package root.
- Adds package contents coverage so stale root generated entrypoint files cannot
  be included in the published package.
- Updates tests and docs to use the root package API and the `src/console/` and
  `src/runtime/` implementation homes.

## 0.1.15

- Closes authored `FlowDefinition`, `FlowGate`, `FlowExpectation`, and
  `FlowStep` public types so stale and unknown top-level Flow Definition fields
  fail TypeScript excess-property checks.
- Adds a focused public contract type fixture for typed gate `expects`,
  gate-level `requires` rejection, and intentionally open evidence, diagnostic,
  release, runtime, and config extension surfaces.
- Removes stale ADR transition wording now that typed `expects` is the authored
  gate expectation contract.

## 0.1.14

- Makes typed gate `expects` the only authored Flow Definition expectation
  field.
- Removes gate-level `requires` from public examples, schemas, runtime
  validation, fallback evaluation, docs, and tests.
- Preserves gate behavior through typed `surface.claim` expectations, route-back
  handling, reports, transitions, CLI validation, and package checks.

## 0.1.13

- Removes the obsolete named gate evaluator from the package root API.
- Keeps `evaluateGate` as the public gate evaluation entrypoint for flat v0.1
  definitions, typed expectations, route-back policy, and Surface claim checks.
- Locks the cleaned package root export boundary in runtime tests.

## 0.1.12

- Adds a docs index so developers can find package, contributor, repo
  structure, architecture, boundary, vision, positioning, example, and ADR
  material from one place.
- Points the README at the docs index instead of scattering contributor and
  structure links in package-facing copy.
- Keeps contributor docs focused on source layout, validation, hooks, local
  product state, and release prep.

## 0.1.11

- Splits the oversized Node schema/runtime suite into focused domain files
  under `tests/node/` for package runtime, CLI, config merge, definitions,
  transitions, release checks, Surface claim handling, route-back behavior, and
  reports.
- Adds shared test-only helpers under `tests/node/helpers/` so fixture loading,
  CLI setup, config fixtures, route-back fixtures, and schema assertions have a
  clear home.
- Keeps `check:schemas` on the full Node contract lane so the split preserves
  the previous runtime/schema coverage.

## 0.1.10

- Defines the public npm package API boundary as `@kontourai/flow`,
  `@kontourai/flow/console-projection`, and `@kontourai/flow/console-server`.
- Adds package-boundary tests that import the supported entrypoints as package
  specifiers and reject representative generated implementation subpaths.
- Clarifies that packaged `dist/` domain files are build output, not public
  consumer subpaths.

## 0.1.9

- Organizes Flow runtime source into domain folders for contracts, runtime,
  shared helpers, config, definitions, gates, transitions, reports, release
  checks, and console implementation.
- Keeps package-facing root shims for the CLI, console projection, console
  server, and internal file helpers so generated package entrypoints remain
  stable.
- Moves Node test suites from `scripts/` to `tests/node/` and leaves
  `scripts/` focused on operational repository tooling.

## 0.1.8

- Documents the published `examples/` boundary with top-level and console
  projection scenario READMEs.
- Keeps the console projection `.flow` run fixture in the package as a
  deliberate local-file example for console consumers.
- Adds npm pack contents assertions so package-visible examples, schemas, built
  output, and excluded repo-only files cannot drift silently.

## 0.1.7

- Made the README package-first by moving contributor hook and TypeScript
  development details to `docs/contributing.md`.
- Removed stale historical cleanup and one-time release setup notes now that
  source control and current docs preserve the useful decisions.
- Kept transient workflow artifacts out of the published package surface.

## 0.1.6

- Clarified the generated `.flow/runs/<run-id>/` layout and documented
  `state.json` as the flat v0.1 Flow Run continuation authority.
- Added run layout constants and drift checks for generated runs and the
  package-visible console projection scenario.
- Added run identity metadata to newly generated evidence manifests while
  keeping Flow Run state, evidence manifests, and reports out of the current
  Resource Contract migration.

## 0.1.5

- Added Flow Project Config Resource Contract authoring support with
  `apiVersion`, `kind`, `metadata`, and `spec`.
- Preserved flat `.flow/config.json` compatibility while normalizing
  Resource-shaped configs to the existing flat runtime config.
- Added Resource-shaped project config merge coverage and a package-visible
  example.

## 0.1.4

- Made CLI `--cwd <path>` consistently scope run lifecycle commands and local
  file inputs instead of only the console command.
- Added regression coverage for starting, attaching evidence, evaluating,
  reading status, reading reports, and listing runs from a caller-selected cwd.

## 0.1.3

- Added Flow Definition Resource Contract authoring support with
  `apiVersion`, `kind`, `metadata`, and `spec`.
- Preserved flat v0.1 Flow Definition compatibility for existing files and API
  callers.
- Normalized Resource-shaped definitions to flat runtime snapshots for start,
  load, report, and transition flows.
- Added a Resource-shaped Flow Definition example and README guidance that
  explicitly limits this compatibility slice to Flow Definition resources.

## 0.1.2

- Renamed published example data from `examples/fixtures/` to `examples/scenarios/`
  so package-visible examples read as developer scenarios rather than test-only
  fixtures.
- Updated README, repo structure docs, scripts, and browser test
  support paths for the scenario layout.
- Included the `Publish NPM` ancestry-check fix from PR #41 so future release
  workflow reruns can validate older tag commits after `main` advances.

## 0.1.1

- Split Flow core runtime code into focused domain modules while preserving the
  package root export surface.
- Added durable repo structure, architecture, product-boundary, and cleanup
  documentation.
- Hardened Markdown report rendering with escaping and line-break normalization.
- Published `@kontourai/flow@0.1.1` to npm as `latest`.

## 0.1.0

- Initial public npm package for the local file-backed Flow CLI and library.
