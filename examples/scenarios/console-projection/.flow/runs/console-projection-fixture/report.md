# Flow Report: console-projection-fixture

- Definition: console-projection-flow v0.1
- Subject: console-projection-fixture
- Status: active
- Current step: verify
- Next action: Fix the test failure and rerun verification.
- Continuation: resume from verify, not chat memory

## Gates

- PASS build gate: Implementation diff accepted by explicit exception.
  - Missing: missing review
  - Evidence: ev.scoped-diff
- BLOCK verify gate: Tests failed; route back to build.
  - Evidence: ev.surface-tests, ev.veritas-readiness, ev.failed-tests

## Accepted Exceptions

- build-gate: Reviewer approval deferred for fixture coverage. (fixture-owner)

## Evidence Manifest

- ev.scoped-diff: file for build-gate ()
- ev.surface-tests: surface.claim for verify-gate ()
- ev.veritas-readiness: veritas-readiness for verify-gate ()
- ev.failed-tests: command for verify-gate ()
