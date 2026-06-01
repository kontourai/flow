# Flow Console

Flow Console is the visual and control surface for Flow-owned process transparency. It should follow the same local-first architecture as Surface Console while exposing Flow concepts instead of claim-trust concepts.

## Architecture Pattern

Flow Console should be built as:

- a local-first shell over Flow projection/read-model files
- a product-owned projection contract derived from Flow Runs, gate outcomes, evidence, exceptions, review queues, and run-control state
- a small server or embeddable shell that reads the projection fresh as producers update it
- extension points for product vocabulary, field renderers, queue grouping, suggested actions, proof panels, and branding
- core Flow semantics that do not depend on extension code

This mirrors Surface Console:

- Surface Console renders Surface claim status, evidence, transparency gaps, and claim review queues from Surface projections.
- Flow Console renders Flow run status, open gates, Review Items, route-back state, decisions, and next actions from Flow projections.

The two consoles should remain interoperable so a future Kontour Console can bridge claim status and process status without rewriting either model.

## Kontour Console Foundation

Kontour Console is the suite-level management and visibility product. It is the thing that brings the Kontour primitives together: one place to see claim status, process status, proof, queues, decisions, freshness, exceptions, and next actions across Surface, Flow, Survey, Veritas, Flow Agents, and vertical products.

The primitives should remain portable and useful without Kontour Console. Surface, Flow, Survey, Veritas, and Flow Agents still need local-first contracts, files, APIs, reports, and embedded views. Kontour Console sells the comprehensive operating layer on top of those primitives rather than becoming a prerequisite for using them.

Flow Console should lay that foundation early by aligning with Surface Console on contracts before extracting shared UI code:

- common local-first server and route conventions where practical
- explicit projection/read-model boundaries
- stable summary, list, detail, history, queue, and action regions
- extension metadata for labels, renderers, actions, proof panels, and branding
- portable links between Surface claim IDs, Flow Run IDs, Review Item IDs, evidence IDs, and producer-owned domain IDs
- refresh semantics that can distinguish clock-derived status changes from producer reverification or full workflow runs

The first abstraction should be the console contract and composition model, not only a shared component package. A shared `kontour-console` shell can emerge once Surface Console and Flow Console prove which layout, routing, projection, and extension primitives are actually common.

## Reference Extension First

The first Flow Console implementation should be Flow-focused, with a reference vertical product treated as a Flow Product Extension. The extension should supply product-native labels, field renderers, proof panels, queue grouping, proposed-field-change views, and branding while Flow owns the generic Review Queue, Review Item, Run Control API, decision history, and gate semantics.

Vertical review concepts should map into Flow rather than become Flow:

- proposed field change -> Review Item
- source excerpt and URL -> evidence reference or proof panel payload
- approve, reject, apply next -> Review Item actions backed by Flow transition/control semantics
- required-field coverage -> gate expectation or Surface claim status, depending on whether the question is process progress or trust state
- `lastVerifiedAt`, field provenance, and confidence -> Surface claim/evidence state projected alongside Flow process state

## Extension Limits

Flow Product Extensions may customize presentation and domain fit. They must not:

- redefine gate semantics
- bypass transition authority
- hide blocking evidence gaps
- reinterpret route-back rules
- replace Flow project config authority
- make domain approval imply Surface claim validity unless Surface derives that status from evidence and policy

## Current Scope

This is product direction for the console architecture. Flow v0.1 remains a local file-backed CLI and library and does not yet ship a hosted web UI.
