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

  return {
    schemaVersion: 4,
    source: options.source ?? `flow-run:${def.id}:${state.run_id}`,
    claims,
    evidence: bundleEvidence,
    policies: [],
    events,
    claimGroups,
  };
}
