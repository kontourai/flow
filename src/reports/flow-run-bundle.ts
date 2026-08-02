import { statusFunctionVersion } from "@kontourai/surface";

import type { FlowEvidenceEntry, MutableRecord } from "../contracts/flow-types.js";
import { stageStatuses, normalizeFlowDefinition } from "../definition/flow-definition.js";

/**
 * Flow follow-up §2 — emit a run-output TrustBundle.
 *
 * A completed run produces a Flow Report (not a TrustBundle). This projection
 * emits a Hachure TrustBundle so a *parent* flow can consume the run as a single
 * referenceable claim (ADR 0001 still holds — Flow emits an attestable artifact,
 * it does not orchestrate).
 *
 * Shape (decided per surface.md Findings — Surface rollups are intra-bundle):
 *  - **claims** = one `stage X passed` member claim per stage — EVERY stage, not
 *    the passing subset — PLUS a `claimGroup` (all-required) so SURFACE derives
 *    the run-level verdict from the members. Flow does NOT compute "all green ⇒
 *    green" — that is claim logic Surface owns, and delegating it is only
 *    meaningful if Surface receives the failures. Flow emits no producer-side
 *    `status` on a member claim; a stage the run has not appraised carries no
 *    event at all and derives `unknown`.
 *  - **evidence** = by-reference pointers to each stage's gate-evidence bundle
 *    (id + claim selector + statusFunctionVersion + asOf). NEVER inlines the
 *    child bundle's claims/events ledger.
 *  - **events** = run transitions / route-backs as ledger lines.
 *
 * The reference graph is kept acyclic: references point only *downward* to leaf
 * gate-evidence bundles already attached to this run; a run-output bundle never
 * references itself or an ancestor.
 */

export interface RunOutputBundleOptions {
  /** Evaluation instant stamped as the asOf on emitted references. Defaults to now. */
  now?: Date;
  /** Override the run-output bundle source label. */
  source?: string;
}

const RUN_CLAIM_TYPE = "flow.stage.passed";
const RUN_GROUP_CLAIM_TYPE = "flow.run.verified";

function isPassed(status: string): boolean {
  return status === "passed";
}

function isFailed(status: string): boolean {
  return status === "failed";
}

/**
 * The hachure `waivers.md` record for a stage that passed only because an
 * exception was accepted.
 *
 * `evaluateGate` short-circuits on an accepted exception and returns `pass` with
 * no evidence, so the stage counted as passed and emitted `status: "verified"`
 * with `evidenceIds: []` — indistinguishable from a stage that passed on real
 * evidence. Nothing in the artifact named the exception, its reason, or who
 * accepted it.
 *
 * `waivers.md` is the spec's existing vocabulary for exactly this: a typed
 * `{reason, approved_by, approved_at}` object inside the claim's free-form
 * `metadata`, documenting an accepted gap. Per that profile a waiver never
 * upgrades a status, so the stage's event is `assumed` — "operationally present
 * but not appraised to affirmation" — and the waiver says why that gap was
 * accepted and by whom.
 */
function stageWaiver(state: any, stepGateIds: string[]): MutableRecord | null {
  if (!stepGateIds.length) return null;
  const outcomes: any[] = state?.gate_outcomes ?? [];
  for (const gateId of stepGateIds) {
    const outcome = outcomes.find((entry: any) => entry.gate_id === gateId && entry.status === "pass");
    const exceptionId = outcome?.accepted_exception_id;
    if (!exceptionId) continue;
    const exception = (state?.exceptions ?? []).find((entry: any) => entry.id === exceptionId);
    if (!exception) continue;
    return {
      reason: exception.reason,
      approved_by: exception.authority,
      approved_at: exception.accepted_at,
      // Flow-side provenance so a consumer can find the exception on the run.
      exceptionId: exception.id,
      gateId: exception.gate_id,
    };
  }
  return null;
}

/**
 * The ledger line for a stage, or `null` when the run has not appraised it.
 *
 * Derived from the stage's recorded gate outcomes rather than from the display
 * status alone: `stageStatuses` reports the cursor's own step as `current` even
 * when its gate blocked, and a blocked stage has very much been appraised.
 *
 * A stage with no event derives `unknown` through Surface — the status
 * function's "nothing to appraise" — which is the honest reading of a stage the
 * run has not reached. Emitting a `verified` event for it, or dropping it from
 * the bundle entirely (which asserts the same `unknown` while also removing it
 * from the rollup), were the two shapes this projection used to produce.
 */
function stageEvent(
  status: string,
  stepGateIds: string[],
  state: any,
  waiver: MutableRecord | null,
): { status: string; notes: string } | null {
  const outcomes: any[] = state?.gate_outcomes ?? [];
  const forStep = stepGateIds
    .map((gateId) => outcomes.find((entry: any) => entry.gate_id === gateId))
    .filter(Boolean);

  const failing = forStep.find((entry: any) => entry.status === "block" || entry.status === "route-back");
  if (failing) {
    return {
      status: "rejected",
      notes: `Stage did not pass: gate ${failing.gate_id} recorded ${failing.status}.`,
    };
  }
  if (isFailed(status)) return { status: "rejected", notes: "Stage did not pass: a gate blocked or routed back." };

  if (stagePassedOnOutcomes(status, stepGateIds, state)) {
    return waiver
      ? { status: "assumed", notes: `Stage passed on an accepted exception (${waiver.exceptionId}), not on gate evidence.` }
      : { status: "verified", notes: "Stage passed in the flow run." };
  }
  return null;
}

/**
 * Whether a stage actually passed, read from its recorded gate outcomes rather
 * than from the display status.
 *
 * `stageStatuses` reports whichever step the cursor sits on as `current`, and a
 * completed run leaves its cursor on the terminal step (`applyEvaluation` sets
 * `current_step = nextStep ?? gate.step`). So the FINAL stage of a fully green
 * run is never reported `passed` — which, while membership was filtered to the
 * passing subset, silently dropped it from the bundle altogether.
 */
function stagePassedOnOutcomes(status: string, stepGateIds: string[], state: any): boolean {
  if (isPassed(status)) return true;
  if (!stepGateIds.length) return false;
  const outcomes: any[] = state?.gate_outcomes ?? [];
  return stepGateIds.every((gateId) =>
    outcomes.some((entry: any) => entry.gate_id === gateId && entry.status === "pass"));
}

/**
 * Extract a by-reference pointer to each gate-evidence bundle backing a step's
 * gates. Returns one ref per trust.bundle evidence entry — id + selector +
 * statusFunctionVersion + asOf — without inlining the child ledger.
 */
function bundleReferencesForStep(
  stepGateIds: string[],
  evidence: FlowEvidenceEntry[],
  asOf: string,
): MutableRecord[] {
  const refs: MutableRecord[] = [];
  for (const entry of evidence) {
    if (entry.superseded_by) continue;
    if (!entry.gate_id || !stepGateIds.includes(entry.gate_id)) continue;
    if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") continue;
    const report: any = entry.bundle_report;
    // Cite each derived claim in the child bundle by selector (subjectType +
    // subjectId + claimType), pinned to the version + asOf it was derived at.
    const claimSelectors = Array.isArray(report?.claims)
      ? report.claims.map((claim: any) => ({
          claimType: claim.claimType,
          subjectType: claim.subjectType,
          subjectId: claim.subjectId,
        }))
      : [];
    refs.push({
      evidenceId: entry.id,
      gateId: entry.gate_id,
      claimSelectors,
      statusFunctionVersion:
        (report?.statusFunctionVersion as string | undefined) ?? statusFunctionVersion,
      asOf,
    });
  }
  return refs;
}

/**
 * Error thrown when the evidence-reference graph of a run-output bundle is not
 * acyclic — i.e. a reference path loops back to the bundle being emitted (or to
 * any bundle already on the path). Recursion is by reference and MUST stay
 * acyclic, otherwise freshness propagation up the reference tree would loop.
 */
export class EvidenceReferenceCycleError extends Error {
  readonly cycle: string[];
  constructor(cycle: string[]) {
    super(`evidence-reference cycle detected: ${cycle.join(" -> ")}`);
    this.name = "EvidenceReferenceCycleError";
    this.cycle = cycle;
  }
}

/** Stable node identity for a bundle in the reference graph. */
function bundleNodeId(bundle: any, fallback: string): string {
  const source = bundle?.source;
  return typeof source === "string" && source.length > 0 ? source : fallback;
}

/**
 * Collect the evidence-bundle identities a bundle references by walking its
 * claims' `metadata.bundleReferences` and resolving each to the referenced
 * bundle when it is available in `bundlesByEvidenceId`. Returns `[evidenceId,
 * resolvedBundle | undefined]` pairs so the DFS can both name the edge and
 * recurse into a referenced bundle that itself carries references.
 */
function outgoingReferences(
  bundle: any,
  bundlesByEvidenceId: Map<string, any>,
): Array<{ evidenceId: string; bundle: any | undefined }> {
  const out: Array<{ evidenceId: string; bundle: any | undefined }> = [];
  const claims = Array.isArray(bundle?.claims) ? bundle.claims : [];
  for (const claim of claims) {
    const refs = claim?.metadata?.bundleReferences;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      const evidenceId = ref?.evidenceId;
      if (typeof evidenceId !== "string") continue;
      out.push({ evidenceId, bundle: bundlesByEvidenceId.get(evidenceId) });
    }
  }
  return out;
}

/**
 * Runtime acyclicity guard for the evidence-reference graph (Task C). The graph
 * is acyclic by construction (references only point *down* to leaf gate-evidence
 * bundles already on the run), but "by construction" is not a check. This walks
 * the reference graph with three-colour DFS and throws
 * `EvidenceReferenceCycleError` if any reference path revisits a node currently
 * on the stack — including a reference that loops back to the run-output bundle
 * being emitted. Independent of (and not guarded by) the `needs` step-DAG check.
 */
export function assertEvidenceReferencesAcyclic(
  rootBundle: any,
  bundlesByEvidenceId: Map<string, any>,
): void {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const rootId = bundleNodeId(rootBundle, "flow-run-output");

  const visit = (bundle: any, nodeId: string, path: string[]): void => {
    const state = color.get(nodeId);
    if (state === BLACK) return;
    if (state === GRAY) {
      const start = path.indexOf(nodeId);
      throw new EvidenceReferenceCycleError([...path.slice(start >= 0 ? start : 0), nodeId]);
    }
    color.set(nodeId, GRAY);
    for (const { evidenceId, bundle: child } of outgoingReferences(bundle, bundlesByEvidenceId)) {
      const childId = child ? bundleNodeId(child, evidenceId) : evidenceId;
      // A reference that points straight back at the root is the most direct cycle.
      if (childId === rootId) {
        throw new EvidenceReferenceCycleError([...path, nodeId, childId]);
      }
      visit(child, childId, [...path, nodeId]);
    }
    color.set(nodeId, BLACK);
  };

  visit(rootBundle, rootId, []);
}

export function projectRunOutputBundle(
  definition: any,
  state: any,
  manifest: any,
  options: RunOutputBundleOptions = {},
): MutableRecord {
  const def = normalizeFlowDefinition(definition);
  const now = options.now ?? new Date();
  const asOf = now.toISOString();
  const nowIso = asOf;

  const statuses = stageStatuses(def, state, manifest);
  const evidence: FlowEvidenceEntry[] = manifest?.evidence ?? [];

  const gatesByStep = new Map<string, string[]>();
  for (const [gateId, gate] of Object.entries(def.gates ?? {}) as [string, any][]) {
    const list = gatesByStep.get(gate.step) ?? [];
    list.push(gateId);
    gatesByStep.set(gate.step, list);
  }

  const claims: MutableRecord[] = [];
  const bundleEvidence: MutableRecord[] = [];
  const events: MutableRecord[] = [];
  const memberClaimIds: string[] = [];

  for (const [index, step] of (def.steps ?? []).entries()) {
    const status = statuses[step.id];
    const claimId = `claim.flow.stage.${step.id}`;
    // EVERY stage is a member. Filtering the membership to the passing subset
    // made the `all-required` rollup vacuously true by construction — it removed
    // every counter-example before Surface could see one. Delegating the rollup
    // is only meaningful if Surface receives the failures.
    memberClaimIds.push(claimId);

    const refs = bundleReferencesForStep(gatesByStep.get(step.id) ?? [], evidence, asOf);
    const waiver = stageWaiver(state, gatesByStep.get(step.id) ?? []);

    const claim: MutableRecord = {
      id: claimId,
      subjectType: "flow-stage",
      subjectId: `${def.id}:${step.id}`,
      facet: "flow.process",
      claimType: RUN_CLAIM_TYPE,
      fieldOrBehavior: "stagePassed",
      value: stagePassedOnOutcomes(status, gatesByStep.get(step.id) ?? [], state),
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: {
        // By-reference links to the gate-evidence bundles that back this stage.
        // NOT the child claims/events themselves (recursion by reference).
        bundleReferences: refs,
        flowStageStatus: status ?? "pending",
        // hachure waivers.md: an accepted exception is a producer assertion that
        // a gap was deliberately accepted. It documents the gap; it never
        // upgrades the derived status.
        ...(waiver ? { waiver } : {}),
      },
    };
    // No producer-asserted `status` on the claim. Flow emits the ledger and
    // lets Surface derive — that is the whole point of the claimGroup.
    claims.push(claim);

    // One evidence record per referenced gate-evidence bundle, by reference.
    const evidenceIds: string[] = [];
    for (const ref of refs) {
      const evidenceId = `evidence.flow.ref.${step.id}.${ref.evidenceId}`;
      evidenceIds.push(evidenceId);
      bundleEvidence.push({
        id: evidenceId,
        claimId,
        evidenceType: "attestation",
        method: "attestation",
        sourceRef: `flow-run:${state.run_id}#${ref.evidenceId}`,
        excerptOrSummary: `Stage ${step.id} backed by gate-evidence bundle ${ref.evidenceId} (statusFunctionVersion ${ref.statusFunctionVersion}, asOf ${ref.asOf}).`,
        observedAt: nowIso,
        collectedBy: `flow:${def.id}`,
        metadata: { bundleReference: ref },
      });
    }

    const event = stageEvent(status, gatesByStep.get(step.id) ?? [], state, waiver);
    // A stage the run has not appraised gets NO event, so Surface derives
    // `unknown` — "nothing to appraise" — rather than Flow asserting anything
    // about it. sf-runtime-observation-required: no qualifying observation, no
    // `verified`.
    if (!event) continue;
    events.push({
      id: `event.flow.stage.${index + 1}.${event.status}`,
      claimId,
      status: event.status,
      type: "verification",
      actor: `flow:${def.id}`,
      method: "transition",
      // Cite the evidence this bundle actually carries for the stage instead of
      // a literal empty list. An exception-passed stage legitimately has none,
      // and that is now visible rather than indistinguishable from a stage that
      // passed on real evidence.
      evidenceIds,
      createdAt: nowIso,
      ...(event.status === "verified" ? { verifiedAt: nowIso } : {}),
      notes: event.notes,
    });
  }

  // Run-level rollup group. Surface derives whether the run is verified from the
  // member claims (all-required). Flow does NOT compute this — the title and
  // description state the REQUIREMENT, they do not assert the outcome.
  const claimGroups = [
    {
      id: `group.flow.run.${state.run_id}`,
      title: "All flow stages verified",
      kind: "claimGroup",
      description: "Every stage of this flow run must derive verified for the run to roll up as verified.",
      claimIds: memberClaimIds,
      rollupPolicy: { mode: "all-required" },
      metadata: { claimType: RUN_GROUP_CLAIM_TYPE },
    },
  ];

  const bundle: MutableRecord = {
    schemaVersion: 5,
    source: options.source ?? `flow-run:${def.id}:${state.run_id}`,
    claims,
    evidence: bundleEvidence,
    policies: [],
    events,
    claimGroups,
  };

  // Task C — real acyclicity guard on the evidence-reference graph. Build a
  // lookup from each referenced gate-evidence bundle's id to the bundle itself
  // (so the DFS can recurse into a referenced bundle that is itself a
  // flow-output bundle with its own references), then assert no reference path
  // loops back to this run-output bundle or revisits any node on the stack.
  const bundlesByEvidenceId = new Map<string, any>();
  for (const entry of evidence) {
    if (entry?.id && entry?.bundle) bundlesByEvidenceId.set(entry.id, entry.bundle);
  }
  assertEvidenceReferencesAcyclic(bundle, bundlesByEvidenceId);

  return bundle;
}
