# Version Release Report Fixtures

These fixtures exercise the local-file-first Version Release Report artifact. They are plain JSON inputs for `projectVersionReleaseReport` and `flow version-release-report`; they do not call provider APIs or depend on implicit `.flow` run state.

## Files

- `complete.json` includes a changeset, required verification evidence, high-risk release-readiness lanes, an accepted exception, an accepted risk, external links, and native artifact refs.
- `missing-required-evidence.json` omits required verification evidence and leaves the `deployment-window` release lane as `not_verified`. Projection must return `decision: "hold"` and explicit gap entries.

## Commands

```sh
node dist/cli.js version-release-report examples/fixtures/version-release-report/complete.json --format json
node dist/cli.js version-release-report examples/fixtures/version-release-report/missing-required-evidence.json --format markdown
```

The report preserves Flow evidence entries, release-readiness lane statuses, `native_refs`, and `external_links` as data. Missing required verification evidence or required release lanes are represented as gaps and never as ready/pass decisions.
