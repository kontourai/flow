# Flow Examples

These files are published with `@kontourai/flow` so package users can inspect and run the same contracts that the README documents.

## Flow Definitions

- `agent-dev-flow.json` is the primary local agentic-development flow used by the quickstart.
- `builder-kit-flow.json` shows a Builder Kit-like required path represented as normal Flow steps and gates.
- `adversarial-pass-flow.json` shows a produce, adversarial review, and resolve loop with route-back policy.
- `flow-definition-resource-contract.json` shows the Resource Contract authoring shape for Flow Definitions.
- `invalid-claim-expectation-flow.json` is a negative validation example for `flow validate-definition --json`.

## Project Config

- `flow-project-config-resource-contract.json` shows the Resource Contract authoring shape for Flow Project Config.

## Scenarios

Scenario directories are larger, package-visible examples that exercise a full local contract:

- `scenarios/console-projection/` is a deterministic local `.flow` run for `flow console` and console projection consumers.
- `scenarios/release-readiness/` shows release lane policy and fixture adapter inputs.
- `scenarios/surface-claims/` shows neutral Surface-shaped claim evidence outcomes.
- `scenarios/version-release-report/` shows versioned release report projection inputs.

Test-only fixtures should not be added here. If a scenario is published under `examples/`, it must be useful for package users and protected by the package contents check.
