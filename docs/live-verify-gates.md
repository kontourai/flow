# Live-verify gates

A **live-verify gate** is the final passive gate in a delivery flow. It keeps a
run open after deployment until an external producer has exercised the relevant
provider-to-consumer contract in the target environment and attached a Hachure
contract-claim bundle.

This is a composition pattern, not a step type or an executor:

1. Name the final ordinary step `live-verify`.
2. Give its gate a `trust.bundle` expectation selecting `claimType: "contract"`,
   the deployment or integration subject, and `accepted_statuses: ["verified"]`.
3. Have the bundle's contract claim use the canonical `provider`, `consumer`,
   and `contract` qualifiers.
4. Apply a contract policy requiring `runtime_observation` evidence and the
   `observation` method.
5. Attach the producer's bundle and ask Flow to evaluate the gate.

The canonical contract-claims profile recommends a short validity window (for example, 7 days) so contract claims go stale and must be re-exercised—freshness pressure that is intentional in production; these checked-in fixtures use `durationDays: 3650` only to keep the shipped walkthrough and test executable, and producers SHOULD use short windows.

Gate evaluation is passive: it never runs build, deployment, smoke, or probe
commands. It validates and re-derives attached bundles, then matches the
derived claim status to the gate selector. An operator can invoke `flow
capture` to run a command at capture time and retain its receipt as evidence.

## Why unit-test evidence remains blocked

The contract-claims policy, rather than Flow's gate evaluator, distinguishes a
live exercise from an isolated test. A verification event backed only by
`test_output` is missing the required `runtime_observation`, so Hachure derives
the claim as `proposed`. Because the gate accepts only `verified`, that bundle
does not satisfy the expectation. A live receipt using
`evidenceType: "runtime_observation"`, `method: "observation"`, and a suitable
`execution.environment` closes the policy gap and can derive `verified`.

The full runnable sequence is published in
[`examples/scenarios/deploy-live-verify/README.md`](../examples/scenarios/deploy-live-verify/README.md).
The Flow definition itself is
[`examples/deploy-live-verify-flow.json`](../examples/deploy-live-verify-flow.json).

## Producer wiring

`flow capture` is the standard path when the probe is a command and its raw
output should be retained in the run:

```sh
flow capture deploy-1842 --gate live-confirm-gate --kind command -- \
  plumb-run --context deploy="$DEPLOYED_SHA" <probe arguments>
```

The captured command receipt is ordinary supporting evidence; by itself it
does not satisfy a `trust.bundle` expectation. The external producer or adapter
must turn the probe result into the contract-claim bundle, including the
runtime observation and deployment context, and then attach it:

```sh
flow attach-evidence deploy-1842 --gate live-confirm-gate \
  --file ./release-worker-production-contract.bundle.json --kind trust.bundle
flow evaluate deploy-1842 --gate live-confirm-gate
```

[Plumb deploy-context checks](https://github.com/kontourai/plumb/issues/6),
invoked with `plumb-run --context deploy=<sha>`, are the reference external
producer. Plumb owns executing the environment-aware check and producing its
result; Flow owns retaining the evidence and enforcing the declared passive
gate.

The bundle should record the deployed SHA or an equivalent integrity reference
and should never record secrets. For an environment-passthrough contract,
record presence, a redacted fingerprint, or another non-secret outcome.

## Schema decision

No Flow schema field is added for evidence kind. The existing selector already
expresses the required gate contract through claim type, deployment subject,
and accepted derived status. Repeating `requiredEvidence` in the Flow
definition would split trust semantics across Flow and Hachure and could drift
from the producer's policy. Contract qualifiers remain in the Hachure claim;
the deployment subject scopes this example's selector without teaching Flow
the contract-claims profile.
