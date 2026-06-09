# Console Projection Scenario

This scenario is a deterministic local Flow Run used to demonstrate the console projection boundary. It is published with the package so consumers can inspect a complete `.flow/runs/<run-id>/` directory without first running a workflow.

## Run

- Run id: `console-projection-fixture`
- Definition id: `console-projection-flow`
- Current step: `verify`

## Files

- `.flow/runs/console-projection-fixture/definition.json` is the normalized Flow Definition snapshot.
- `.flow/runs/console-projection-fixture/state.json` is the authoritative flat Flow Run state.
- `.flow/runs/console-projection-fixture/evidence/manifest.json` indexes copied evidence and carries run/definition identity.
- `.flow/runs/console-projection-fixture/report.json` and `report.md` are derived reports.
- `.flow/runs/console-projection-fixture/expected-projection.json` is the expected console projection read model.

## Commands

```sh
npm run build
node dist/cli.js console --run console-projection-fixture --cwd examples/scenarios/console-projection --port 0
```

The scenario is intentionally local-file-first. It does not call hosted services or require provider credentials.
