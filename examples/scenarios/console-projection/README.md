# Console Projection Runtime Fixture

This scenario is durable source data for a deterministic local Flow Run used to demonstrate the console projection boundary.

- Run id: `console-projection-fixture`
- Source fixture: `runtime-fixture/console-projection-fixture/`
- Runtime location: `.kontourai/flow/runs/console-projection-fixture/`

Node tests, the console smoke script, and the browser server materialize the source fixture into the ignored canonical runtime location before invoking file-backed Flow APIs. The source directory is not a second supported runtime root.

The fixture contains:

- `definition.json`: normalized Flow Definition snapshot.
- `state.json`: authoritative flat Flow Run state.
- `evidence/manifest.json`: copied-evidence index with run and definition identity.
- `report.json` and `report.md`: derived reports.
- `expected-projection.json`: expected console projection read model.

Materialize an isolated temporary project and inspect it with:

```bash
fixture_cwd="$(mktemp -d)"
mkdir -p "$fixture_cwd/.kontourai/flow/runs"
cp -R examples/scenarios/console-projection/runtime-fixture/console-projection-fixture \
  "$fixture_cwd/.kontourai/flow/runs/console-projection-fixture"
node dist/cli.js console --run console-projection-fixture --cwd "$fixture_cwd" --port 0
rm -rf "$fixture_cwd"
```

Current runtime commands do not read `.flow/runs/`. See [Runtime Roots](../../../docs/runtime-roots.md) for migration from generated state created by older Flow versions.
