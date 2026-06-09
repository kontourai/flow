# Changelog

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
- Updated README, repo structure docs, audit docs, scripts, and browser test
  support paths for the scenario layout.
- Included the `Publish NPM` ancestry-check fix from PR #41 so future release
  workflow reruns can validate older tag commits after `main` advances.

## 0.1.1

- Split Flow core runtime code into focused domain modules while preserving the
  package root export surface.
- Added durable repo structure, architecture, product-boundary, and dead-code
  audit documentation.
- Hardened Markdown report rendering with escaping and line-break normalization.
- Published `@kontourai/flow@0.1.1` to npm as `latest`.

## 0.1.0

- Initial public npm package for the local file-backed Flow CLI and library.
