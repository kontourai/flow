# Runtime Roots

Flow separates durable authored project state from generated runtime state.

## Canonical Layout

`.flow/config.json` and `.flow/definitions/` are durable authored state and remain Git-visible in `.flow/`. All supported generated state belongs under `.kontourai/flow/`:

```text
.flow/
├── config.json
└── definitions/
    └── agent-dev-flow.json

.kontourai/flow/
├── demo/
│   └── acceptance-bundle.json
└── runs/dev-1847/
    ├── definition.json
    ├── state.json
    ├── evidence/manifest.json
    ├── recovery-fence.json
    ├── report.md
    └── report.json
```

Repositories need one generated-state ignore boundary:

```gitignore
.kontourai/
```

Do not ignore `.flow/`. Current runtime commands read authored config and definitions there, but they do not discover, list, read, mutate, or select `.flow/runs/`.

## Public Path API

- `flowRoot(cwd)` returns `<cwd>/.flow`, the authored project-state root.
- `flowConfigPath(cwd)` returns `<cwd>/.flow/config.json`.
- `flowRuntimeRoot(cwd)` returns `<cwd>/.kontourai/flow`, the generated runtime root.
- `runDir(runId, cwd)` returns `<cwd>/.kontourai/flow/runs/<run-id>`.
- `flowRunRecoveryFencePath(runId, cwd)` returns the stable supported-recovery
  fence at `<run-dir>/recovery-fence.json`.

The `runDir()` change is semver-major. There is no public or internal dual-root resolver and no runtime legacy support.

## Supported recovery coordination

An external recovery coordinator closes a run by atomically writing the
provider-neutral v1 recovery fence with `status: "active"`, then waits for
Flow's native per-run mutation ticket before touching canonical artifacts. It
releases that ticket with the exact active generation still in place after
recovery work. It then calls the active-generation-bound finalization API,
which obtains a new native ticket and publishes `status: "open"` before release.
The generic writer is active-only. Flow generates a canonical UUID v4
generation and durably publishes every update with file and parent-directory
`fsync`. Supported Flow reads require the same exact bytes, generation, and
run-directory device/inode before and after the complete read. Supported
mutations recheck after acquiring the native ticket.
`docs/decisions/run-recovery-fence.md` records the exact guarantee and
exclusions.

## Upgrade Migration

Flow performs no automatic migration. Before upgrading an installation that has generated runs under `.flow/runs/`:

1. Stop every writer using that repository and keep the repository single-writer until migration and verification finish.
2. Back up `.flow/runs/` outside the repository and verify the backup is readable.
3. Inventory each old run id. Reject the migration if either `.kontourai/flow/runs/<run-id>` or `.kontourai/flow/runs/<run-id>.migrating` already exists; never merge or overwrite run directories.
4. Copy one old run to the new temporary sibling `.kontourai/flow/runs/<run-id>.migrating` without following links. Recursively reject the staged tree if it contains any symbolic link.
5. Verify the staged `state.json`, `definition.json`, and `evidence/manifest.json` against the current published schemas. Confirm `state.run_id` equals the intended final `<run-id>` (not the temporary directory name), definition id/version agree with state, and manifest run/definition identity agrees with both. Treat stored reports as disposable derived output.
6. Re-check that `.kontourai/flow/runs/<run-id>` does not exist, then rename the verified temporary directory to that final path while all other writers remain stopped. If the destination appears, stop and investigate rather than overwriting it.
7. Run `flow status <run-id>` and `flow report <run-id>` with the new version.
8. Keep the old `.flow/runs/` tree and external backup unchanged until the new version has been accepted. Remove old generated state only as a separate operator decision.

Repeat the collision, schema, identity, and recursive link checks independently for every run. Do not migrate a partial, corrupt, linked, or ambiguous directory. Flow's current file store is single-writer; do not run lifecycle commands concurrently against the same run during migration or normal operation.

## Rollback

If verification fails, stop new-version writers, remove only the unaccepted canonical copy, restore the external backup if needed, and run the older Flow version against its original `.flow/runs/` state. Older versions cannot see runs created only under `.kontourai/flow/runs/`; preserve those canonical runs separately before rollback. Never copy newer mutations back over old state without an explicit data review.

The durable source fixture under `examples/scenarios/console-projection/runtime-fixture/` is copied into `.kontourai/flow/runs/` by tests and smoke scripts. It is not a second runtime root.

## Definition amendments

`definition.json` is permanently the run's start snapshot. An authorized
compatible amendment writes its complete successor only into the append-only
ledger inside `state.json`; it never rewrites the start definition, evidence
manifest, or copied evidence. Reports are derived outputs and may be repaired
from canonical state after an interrupted projection write. There is no
automatic legacy migration, digest backfill, downgrade, or rollback: submit a
fresh compatible amendment with a new exact head instead.

Downstream read-only consumers must adopt the same hard cut. The Kontour Console bridge update is tracked in `kontourai/console#141`; it must not introduce a legacy fallback.
