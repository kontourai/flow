# Changelog

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
- Kept repo-local Flow Agents workflow artifacts under ignored `.flow-agents/`.

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
