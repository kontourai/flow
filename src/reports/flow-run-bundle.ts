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
 *  - **claims** = one `stage X passed` member claim per passed stage, PLUS a
 *    `claimGroup` ("run verified", all-required) so SURFACE derives the
 *    run-level verdict from the members. Flow does NOT compute "all green ⇒
 *    green" — that is claim logic Surface owns.
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
  const memberClaimIds: string[] = [];

  for (const step of def.steps ?? []) {
    const status = statuses[step.id];
    if (!isPassed(status)) continue;

    const claimId = `claim.flow.stage.${step.id}`;
    memberClaimIds.push(claimId);

    const refs = bundleReferencesForStep(gatesByStep.get(step.id) ?? [], evidence, asOf);

    // Member claim: "stage X passed". Surface derives its status; Flow asserts
    // the producer-side status as a starting point only.
    claims.push({
      id: claimId,
      subjectType: "flow-stage",
      subjectId: `${def.id}:${step.id}`,
      surface: "flow.process",
      claimType: RUN_CLAIM_TYPE,
      fieldOrBehavior: "stagePassed",
      value: true,
      status: "verified",
      createdAt: nowIso,
      updatedAt: nowIso,
      metadata: {
        // By-reference links to the gate-evidence bundles that back this stage.
        // NOT the child claims/events themselves (recursion by reference).
        bundleReferences: refs,
      },
    });

    // One evidence record per referenced gate-evidence bundle, by reference.
    for (const ref of refs) {
      bundleEvidence.push({
        id: `evidence.flow.ref.${step.id}.${ref.evidenceId}`,
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
  }

  // Run-level rollup group. Surface derives whether the run is verified from the
  // member claims (all-required). Flow does NOT compute this.
  const claimGroups = [
    {
      id: `group.flow.run.${state.run_id}`,
      title: "Run verified",
      kind: "claimGroup",
      description: "All flow stages passed.",
      claimIds: memberClaimIds,
      rollupPolicy: { mode: "all-required" },
      metadata: { claimType: RUN_GROUP_CLAIM_TYPE },
    },
  ];

  // Events = the verification ledger line per passed stage. Surface requires
  // every event.claimId to reference a claim in claims[], and the latest event
  // governs status — so each passed member claim gets exactly one `verified`
  // event (it is currently passed). Route-back history is recorded in the Flow
  // Report / transitions, not re-asserted here as claim status (a re-passed
  // stage is verified, not stale). Keeping route-back events off the member
  // claims preserves a correct intra-bundle "run verified" rollup.
  const events: MutableRecord[] = memberClaimIds.map((claimId, index) => ({
    id: `event.flow.stage.${index + 1}.verified`,
    claimId,
    status: "verified",
    type: "verification",
    actor: `flow:${def.id}`,
    method: "transition",
    evidenceIds: [],
    createdAt: nowIso,
    verifiedAt: nowIso,
    notes: "Stage passed in the flow run.",
  }));

  const bundle: MutableRecord = {
    schemaVersion: 4,
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
