# Adversarial Review With Survey-Shaped Evidence

This scenario runs the [adversarial route-back pattern](../../../docs/gates-and-route-back.md#pattern-adversarial-review-with-a-defect-budget) end to end with evidence shaped the way [Kontour Survey](https://kontourai.io/survey) produces it: Surface-shaped trust artifacts whose producer and authority traces point back at a Survey review session and its per-round records.

The artifacts here are authored fixtures in the neutral shape Flow consumes. Survey owns the review reasoning and the per-round [adversarial-pass records](https://kontourai.github.io/survey/adversarial-and-learning.html); Flow evaluates only the artifact fields, the Flow Definition, and persisted transitions.

## Files

- `producer-output.trust.json` — the trusted `adversarial.producer-output` claim for the work under review.
- `review-round-1-completeness-defect.trust.json` — round 1: the review **rejects** the output (attached as failed evidence with `--route-reason completeness_defect`).
- `review-round-2-trusted.trust.json` — round 2: the review passes after regeneration; attached with `--supersede` to replace round 1. It is attached twice in this walkthrough — see [Why round 2 is attached twice](#why-round-2-is-attached-twice) below.
- `resolution.trust.json` — the trusted `adversarial.resolution` claim for the resolve gate.

Their claim/evidence timestamps are set comfortably in the future (`2030-01-01`) so the walkthrough keeps working no matter when you run it — see the currency rule linked below.

## Run it

Run these from the package root. `--cwd` only selects where the run's `.flow` state lives — definition and evidence file paths are *not* resolved against it, so pass those as absolute paths (as below) rather than paths relative to `--cwd`.

```sh
PKG=$(pwd)
DEMO=/tmp/adv-demo
S="$PKG/examples/scenarios/adversarial-survey"

flow init --cwd "$DEMO"
flow start "$PKG/examples/adversarial-pass-flow.json" --run-id adv-204 \
  --params subject=pricing-faq --cwd "$DEMO"
```

Attach round 1 as failed evidence and evaluate:

```sh
flow attach-evidence adv-204 --gate adversarial-review-gate \
  --file "$S/review-round-1-completeness-defect.trust.json" \
  --kind trust.bundle --status failed --route-reason completeness_defect --cwd "$DEMO"

flow evaluate adv-204 --gate adversarial-review-gate --cwd "$DEMO"
```

```text
attached evidence: ev.1784558777054.1
gate: adversarial-review-gate
kind: trust.bundle

route-back adversarial-review-gate: adversarial review gate has failing evidence
current step: produce
next action: return to produce and replace failing evidence attempt 1/2
```

Round 1 routes back to `produce` against the per-case budget. Note the printed evidence id — you need it to supersede.

Now supersede the failed round-1 evidence with round 2 (note the id printed here too):

```sh
flow attach-evidence adv-204 --gate adversarial-review-gate \
  --file "$S/review-round-2-trusted.trust.json" --kind trust.bundle \
  --supersede <round-1-evidence-id> --cwd "$DEMO"

flow evaluate adv-204 --gate adversarial-review-gate --cwd "$DEMO"
```

```text
attached evidence: ev.1784558786135.2
gate: adversarial-review-gate
kind: trust.bundle

route-back adversarial-review-gate: The producer output under adversarial review is available as trusted evidence. missing
current step: adversarial-review
next action: return to adversarial-review and replace failing evidence attempt 1/2
```

This second route-back is expected — see [Why round 2 is attached twice](#why-round-2-is-attached-twice). It marks the run's re-entry into `adversarial-review`; it draws from a separate `missing_evidence` route (its own attempt budget, independent of `completeness_defect`'s) and only fires once per re-entry.

Re-attach both claims the gate needs now that the step has been re-entered — producer-output for the first time in this walkthrough, and round 2 again (superseding the first round-2 attachment) so its attachment timestamp is current for this visit:

```sh
flow attach-evidence adv-204 --gate adversarial-review-gate \
  --file "$S/producer-output.trust.json" --kind trust.bundle --cwd "$DEMO"

flow attach-evidence adv-204 --gate adversarial-review-gate \
  --file "$S/review-round-2-trusted.trust.json" --kind trust.bundle \
  --supersede <first-round-2-evidence-id> --cwd "$DEMO"

flow evaluate adv-204 --gate adversarial-review-gate --cwd "$DEMO"
```

```text
attached evidence: ev.1784558793150.3
gate: adversarial-review-gate
kind: trust.bundle

attached evidence: ev.1784558793591.4
gate: adversarial-review-gate
kind: trust.bundle

pass adversarial-review-gate: The producer output under adversarial review is available as trusted evidence. satisfied
current step: resolve
```

The superseded entries stay in the manifest for audit — reports still show round 1 and the first round-2 attachment happened — but only the current attachments drive the gate. Finish the run:

```sh
flow attach-evidence adv-204 --gate resolve-gate \
  --file "$S/resolution.trust.json" --kind trust.bundle --cwd "$DEMO"

flow evaluate adv-204 --cwd "$DEMO"
```

```text
attached evidence: ev.1784558800224.5
gate: resolve-gate
kind: trust.bundle

pass resolve-gate: The resolved output addresses the adversarial review findings. satisfied
current step: resolve
next action: run complete; no further action required
```

Both gates pass, and `flow status` shows the complete adversarial history: one rejected round, two route-back transitions (the defect and the re-entry marker), and the trusted evidence that ultimately satisfied the gate.

## Why round 2 is attached twice

Flow scopes claim evidence to the *current* gate visit: after any route-back, a claim can't satisfy the gate using a `createdAt`/`observedAt` (or, for the attachment itself, an `attached_at`) from before the transition that sent the run back into that step — see [claim currency](../../../docs/evidence.md#how-claim-evidence-is-evaluated). The first evaluation after a route-back can only discover *that* the step has been re-entered (`gate_reentry_pending`); it can't yet credit any evidence, including evidence attached in the same breath as round 2. That discovery is itself recorded as a route-back (reason `missing_evidence`), which is what re-entry actually is in Flow's model. Only the following evaluation, with evidence attached after that marker, can pass. Since `producer-output-claim` was never re-supplied after the first route-back either, it needs a fresh attachment at the same point as round 2's second attachment.
