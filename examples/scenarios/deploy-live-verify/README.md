# Deploy live-verify gate

This scenario composes ordinary passive Flow gates into a delivery run that
cannot complete until production reality is confirmed. The final gate selects
the Hachure contract claim for the production release-worker deployment and accepts only
its derived `verified` status.

The fixture bundles use the canonical Hachure schemaVersion 7 contract-claim
vocabulary: `runtime_observation` evidence, `execution.environment`, and the
`policy.contract.live-exercise` policy profile described in
[`docs/live-verify-gates.md`](../../../docs/live-verify-gates.md).

The canonical contract-claims profile recommends a short validity window (for example, 7 days) so contract claims go stale and must be re-exercised—freshness pressure that is intentional in production; these checked-in fixtures use `durationDays: 3650` only to keep the shipped walkthrough and test executable, and producers SHOULD use short windows.

From the package root, build the CLI and use a disposable working directory:

```sh
npm run build
workdir="$(mktemp -d)"
node dist/cli.js start "$PWD/examples/deploy-live-verify-flow.json" \
  --run-id deploy-1842 --cwd "$workdir"

node dist/cli.js attach-evidence deploy-1842 --gate build-gate \
  --file "$PWD/examples/scenarios/deploy-live-verify/static-build.bundle.json" \
  --kind trust.bundle --cwd "$workdir"
node dist/cli.js evaluate deploy-1842 --cwd "$workdir"

node dist/cli.js attach-evidence deploy-1842 --gate deploy-gate \
  --file "$PWD/examples/scenarios/deploy-live-verify/deployed-sha.bundle.json" \
  --kind trust.bundle --cwd "$workdir"
node dist/cli.js evaluate deploy-1842 --cwd "$workdir"

# No live receipt: the run blocks at live-confirm-gate.
node dist/cli.js evaluate deploy-1842 --cwd "$workdir"

# A green unit test still derives the contract claim as proposed, not verified.
node dist/cli.js attach-evidence deploy-1842 --gate live-confirm-gate \
  --file "$PWD/examples/scenarios/deploy-live-verify/test-only.bundle.json" \
  --kind trust.bundle --cwd "$workdir"
node dist/cli.js evaluate deploy-1842 --cwd "$workdir"

# The live receipt derives verified and completes the run.
node dist/cli.js attach-evidence deploy-1842 --gate live-confirm-gate \
  --file "$PWD/examples/scenarios/deploy-live-verify/live-receipt.bundle.json" \
  --kind trust.bundle --cwd "$workdir"
node dist/cli.js evaluate deploy-1842 --cwd "$workdir"
node dist/cli.js status deploy-1842 --cwd "$workdir"
```

Gate evaluation does not run the build, deployment, or probe. External actors
perform those actions and attach their results; `evaluate` only validates,
derives, and matches the attached claims. Operators may use `flow capture` to
run a command explicitly at capture time and retain its output as evidence.
