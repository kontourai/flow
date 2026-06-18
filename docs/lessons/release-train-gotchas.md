# Release-Train Gotchas — Lessons

Captured after shipping the cross-repo trust/freshness/recursion feature across
`hachure`, `surface`, `flow`, and `console`. Three systemic issues cost real
time; each has a concrete prevention. Read this before driving a multi-repo
release chain or touching CI hooks.

---

## 1. Git hooks leak `GIT_*` into subprocesses — tests that shell out to `git` get hijacked

**What happened.** The pre-push hook runs `npm test`. Git invokes hooks with
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` (and friends) exported into the
environment. A kit-operations test created a throwaway repo and ran
`git -C <tmpdir> add . && git -C <tmpdir> commit -m init` — but the leaked
`GIT_DIR`/`GIT_WORK_TREE` **override `-C <tmpdir>`**, so the commit landed in the
**real repo**: a bogus `init` commit on top of the working branch, with the
worktree's tracked files rewritten. The test passed in isolation (`npm run
test:node`) and only corrupted things **under the hook**, which made it baffling.

**Tell.** A test suite shells out to `git` AND only misbehaves when run from a
git hook (pre-push/pre-commit), not when run directly.

**Prevention.**
- **Hooks:** `unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE
  GIT_QUARANTINE_PATH GIT_QUARANTINE_ID` at the top of the hook before running the
  suite. (See `.githooks/pre-push`.)
- **Tests/prod that spawn `git`:** pass a scrubbed env (`process.env` with all
  `GIT_*` keys removed), not the inherited one. `-C <dir>` is **not** enough — an
  explicit `GIT_DIR` in the environment wins. (See `tests/node/check-kit-operations.test.mjs`
  and `src/kit/kit-operations.ts` `gitCleanEnv()`.)
- A pinned-hook-content test (`check-repo-hooks.test.mjs`) must be updated when
  the hook changes.

---

## 2. A stale `package-lock.json` blocks CI at every dependent gate

**What happened.** Each dependent repo bumped its dependency in `package.json`
(e.g. `hachure ^0.5.0`, `@kontourai/flow ^1.4.0`) but **did not update
`package-lock.json`**. CI runs `npm ci`, which fails closed when the lock and
`package.json` are out of sync ("`Invalid: lock file's hachure@0.2.0 does not
satisfy hachure@0.5.0`"). This produced red CI on surface/flow/console that
looked like "the dep isn't published yet" but was actually a lock-sync failure —
and it recurred at **every** gate in the chain.

**Tell.** CI fails in `Install dependencies` with `npm error code EUSAGE` /
"can only install packages when your package.json and package-lock.json … are in
sync", not in build or test.

**Prevention.**
- When you change a dependency range, run `npm install` (or `npm update <dep>`)
  in the **same commit** so the lock moves with it.
- `npm install` will **not** upgrade a dep that's already within range — if the
  lock pins `1.3.0` and you need `1.4.0` under `^1.3.0`, either `npm update <dep>`
  or bump the range to `^1.4.0` (do the latter when the old version genuinely
  won't work, e.g. it lacks a new subpath export).
- In a release train, treat "sync the lock to the just-published upstream" as a
  required step at each gate, before re-running CI.

---

## 3. `statusFunctionVersion` declared in two places drifted apart

**What happened.** Hachure's `statusFunctionVersion` bump to `'2'` updated
`index.mjs` (the runtime export) but **not** `package.json`. Surface's
fail-closed release-signing gate (`scripts/release-trust-bundle.mjs`) reads the
**spec-side** value from `hachurePkg.statusFunctionVersion ?? "1"` — i.e. from
hachure's `package.json` — and compared it against surface's impl `'2'`. With the
field missing it defaulted to `'1'` → `MISMATCH: impl="2" spec="1"`. The npm
publish succeeded, but the **fail-closed signing job failed**, so the release
shipped **without a signed trust bundle**. Fixed by declaring
`statusFunctionVersion` in hachure's `package.json` (0.5.1) and re-cutting a
signed surface release (1.2.1).

**Tell.** A value that has both a runtime export and a packaged/metadata
declaration; a consumer or gate reads one source while the bump touched the
other. Fail-*closed* gates surface this only at release time, after publish.

**Prevention.**
- Single-source the value, or keep the two in sync with a check. The spec-side
  source of truth that consumers read is **`package.json`** — bump it there
  whenever the runtime export changes.
- Run fail-closed release gates **before** publish where possible, or at least
  treat a post-publish gate failure as "the artifact is incomplete, re-cut a
  patch," not "ignore it."

---

## Meta-lesson

Two of the three only appeared **at the boundary** — under a git hook, or in
CI's `npm ci`, or in a fail-closed release job — not in normal local runs. When
driving a release chain, verify each gate against the **real** conditions
(published deps via `npm ci`, the actual hook, the signing job), not just a green
local `npm test`.
