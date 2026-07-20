# Adversarial Review With Survey-Shaped Evidence

> **Known issue (2026-07-20):** this walkthrough does not currently complete on flow 3.5.0.
> The commands below originally used `--trust-artifact`, which is now a no-op (use
> `--kind trust.bundle`), but even with the corrected flag the shipped `*.trust.json`
> fixtures no longer satisfy the definition's `bundle_claim` expectations
> (`accepted_statuses: ["verified"]`) under the current trust-attachment semantics —
> `flow evaluate` reports the producer-output expectation `missing` and the run blocks.
> The fixtures and transcript need regeneration against current semantics before this
> scenario is runnable again.

This scenario runs the [adversarial route-back pattern](../../../docs/gates-and-route-back.md#pattern-adversarial-review-with-a-defect-budget) end to end with evidence shaped the way [Kontour Survey](https://kontourai.io/survey) produces it: Surface-shaped trust artifacts whose producer and authority traces point back at a Survey review session and its per-round records.

The artifacts here are authored fixtures in the neutral shape Flow consumes. Survey owns the review reasoning and the per-round [adversarial-pass records](https://kontourai.github.io/survey/adversarial-and-learning.html); Flow evaluates only the artifact fields, the Flow Definition, and persisted transitions.

## Files

- `producer-output.trust.json` — the trusted `adversarial.producer-output` claim for the work under review.
- `review-round-1-completeness-defect.trust.json` — round 1: the review **rejects** the output (attached as failed evidence with `--route-reason completeness_defect`).
- `review-round-2-trusted.trust.json` — round 2: the review passes after regeneration; attached with `--supersede` to replace round 1.
- `resolution.trust.json` — the trusted `adversarial.resolution` claim for the resolve gate.

## Run it

From the package root (or any directory, adjusting paths):

```sh
flow init --cwd /tmp/adv-demo
flow start examples/adversarial-pass-flow.json --run-id adv-204 \
  --params subject=pricing-faq --cwd /tmp/adv-demo

S=examples/scenarios/adversarial-survey
flow attach-evidence adv-204 --gate adversarial-review-gate \
  --file $S/producer-output.trust.json --kind trust.bundle --cwd /tmp/adv-demo
flow attach-evidence adv-204 --gate adversarial-review-gate \
  --file $S/review-round-1-completeness-defect.trust.json \
  --kind trust.bundle --status failed --route-reason completeness_defect --cwd /tmp/adv-demo

flow evaluate adv-204 --gate adversarial-review-gate --cwd /tmp/adv-demo
```

Round 1 routes back to `produce` against the per-case budget:

```text
route-back adversarial-review-gate: adversarial review gate has failing evidence
current step: produce
next action: return to produce and replace failing evidence attempt 1/2
```

After regenerating, round 2 **supersedes** the failed round-1 evidence (note the evidence id printed when you attached it):

```sh
flow attach-evidence adv-204 --gate adversarial-review-gate \
  --file $S/review-round-2-trusted.trust.json --kind trust.bundle \
  --supersede <round-1-evidence-id> --cwd /tmp/adv-demo
flow evaluate adv-204 --gate adversarial-review-gate --cwd /tmp/adv-demo
```

```text
pass adversarial-review-gate: The producer output under adversarial review is available as trusted evidence. satisfied
current step: resolve
```

The superseded entry stays in the manifest for audit — reports still show round 1 happened — but it no longer drives the gate. Finish the run:

```sh
flow attach-evidence adv-204 --gate resolve-gate \
  --file $S/resolution.trust.json --kind trust.bundle --cwd /tmp/adv-demo
flow evaluate adv-204 --cwd /tmp/adv-demo
```

Both gates pass, and `flow status` shows the complete adversarial history: one rejected round, one route-back transition with its reason and attempt count, and the trusted round that replaced it.
