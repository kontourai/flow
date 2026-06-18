/**
 * Trust-bundle EMISSION (the inverse of the consume side in flow-gates.ts).
 *
 * Flow *consumes* `trust.bundle` evidence to decide whether a gate may pass.
 * This module *emits* `trust.bundle` artifacts so a Flow Run's own outcome is
 * an inspectable Hachure trust bundle that the Surface trust panel can pick up
 * ("recursive trust": the process that gates work is itself trust-bearing).
 *
 * Two builders, mirroring the bundle shape the consume side validates against
 * (see examples/scenarios/trust-bundle/evidence/pass-verified.json):
 *   - buildGateTrustBundle(...)  — one bundle per gate evaluation.
 *   - buildFlowTrustBundle(run)  — a run-level aggregate over every gate.
 *
 * Every emitted bundle is built to the Hachure trust-bundle schema and round
 * trips cleanly through Surface's validateTrustBundle + buildTrustReport.
 */
import type { MutableRecord } from "../contracts/flow-types.js";
import { slugLabel } from "../shared/flow-utils.js";

/** Surface/Hachure claimType used for a single gate's outcome. */
export const FLOW_GATE_OUTCOME_CLAIM_TYPE = "flow.gate.outcome";
/** Surface/Hachure claimType used for the run-level aggregate outcome. */
export const FLOW_RUN_OUTCOME_CLAIM_TYPE = "flow.run.outcome";
/** Surface name carried by the emitted claims. */
export const FLOW_TRUST_SURFACE = "flow.process-transparency";

/**
 * Map a Flow gate outcome status onto a Hachure verification-event status.
 *
 * The gate outcome IS the claim: "gate X passed/failed because …". A passing
 * gate is a verified claim; a blocked gate is a rejected claim (evidence was
 * required and absent/failing); a route-back is disputed (failing evidence
 * routed work back); a waiting gate has no event yet, deriving to `proposed`.
 */
export function gateOutcomeEventStatus(status: string): "verified" | "rejected" | "disputed" | null {
  switch (status) {
    case "pass":
      return "verified";
    case "block":
      return "rejected";
    case "route-back":
      return "disputed";
    default:
      // "wait" (and any unknown status) carry no verification event; the claim
      // derives to `proposed` — recorded but not yet trust-bearing.
      return null;
  }
}

function gateOutcomeValue(outcome: MutableRecord): string {
  const label = slugLabel(outcome.gate_id);
  switch (outcome.status) {
    case "pass":
      return `${label} passed: ${outcome.summary}`;
    case "block":
      return `${label} blocked: ${outcome.summary}`;
    case "route-back":
      return `${label} routed back: ${outcome.summary}`;
    default:
      return `${label} waiting: ${outcome.summary ?? "no evidence yet"}`;
  }
}

interface BuildOptions {
  /** Run id; subjects are namespaced under it so bundles stay run-scoped. */
  runId?: string;
  /** Stable timestamp (tests pass a fixed value); defaults to now. */
  now?: string;
  /** Bundle source label; defaults to flow/run/<runId>. */
  source?: string;
}

function claimAndEventsForOutcome(
  outcome: MutableRecord,
  runId: string,
  now: string
): { claim: MutableRecord; evidence: MutableRecord[]; events: MutableRecord[] } {
  const gateId = outcome.gate_id;
  const claimId = `claim.flow.gate.${gateId}`;
  const claim: MutableRecord = {
    id: claimId,
    subjectType: "flow-gate",
    subjectId: `${runId}/${gateId}`,
    surface: FLOW_TRUST_SURFACE,
    claimType: FLOW_GATE_OUTCOME_CLAIM_TYPE,
    fieldOrBehavior: "gateOutcome",
    value: gateOutcomeValue(outcome),
    createdAt: now,
    updatedAt: now,
    metadata: {
      gateStatus: outcome.status,
      runId
    }
  };

  // The gate's evidence manifest references become evidence entries. Each
  // referenced evidence id is summarized; this keeps the emitted bundle a
  // faithful manifest of what the gate actually weighed.
  const evidenceRefs: string[] = Array.isArray(outcome.evidence_refs) ? outcome.evidence_refs : [];
  const matched: Array<{ expectation_id: string; evidence_id: string }> = Array.isArray(
    outcome.matched_expectations
  )
    ? outcome.matched_expectations
    : [];
  const matchedByEvidence = new Map<string, string[]>();
  for (const m of matched) {
    const list = matchedByEvidence.get(m.evidence_id) ?? [];
    list.push(m.expectation_id);
    matchedByEvidence.set(m.evidence_id, list);
  }

  const evidence: MutableRecord[] = [];
  const evidenceIds: string[] = [];
  if (evidenceRefs.length) {
    for (const [index, ref] of evidenceRefs.entries()) {
      const evId = `evidence.flow.gate.${gateId}.${index + 1}`;
      evidenceIds.push(evId);
      const satisfies = matchedByEvidence.get(ref) ?? [];
      const summary = satisfies.length
        ? `Gate evidence ${ref} satisfied expectation(s): ${satisfies.join(", ")}.`
        : `Gate evidence ${ref} attached to ${slugLabel(gateId)}.`;
      evidence.push({
        id: evId,
        claimId,
        evidenceType: "human_attestation",
        method: "auditability",
        sourceRef: `flow:run/${runId}/gate/${gateId}/evidence/${ref}`,
        excerptOrSummary: summary,
        observedAt: now,
        collectedBy: "flow"
      });
    }
  } else {
    // Always emit at least one evidence entry so the manifest is inspectable
    // even for gates with no attached evidence (e.g. blocked-on-missing).
    const evId = `evidence.flow.gate.${gateId}.outcome`;
    evidenceIds.push(evId);
    evidence.push({
      id: evId,
      claimId,
      evidenceType: "human_attestation",
      method: "auditability",
      sourceRef: `flow:run/${runId}/gate/${gateId}`,
      excerptOrSummary: `Gate ${slugLabel(gateId)} outcome: ${outcome.status} — ${outcome.summary}`,
      observedAt: now,
      collectedBy: "flow"
    });
  }

  const events: MutableRecord[] = [];
  const eventStatus = gateOutcomeEventStatus(outcome.status);
  if (eventStatus) {
    events.push({
      id: `event.flow.gate.${gateId}.${eventStatus}`,
      claimId,
      status: eventStatus,
      actor: "flow",
      method: "flow.evaluateGate",
      evidenceIds,
      createdAt: now,
      ...(eventStatus === "verified" ? { verifiedAt: now } : {})
    });
  }

  return { claim, evidence, events };
}

/**
 * Build a per-gate trust bundle for a single gate outcome. The subject is the
 * gate (namespaced under the run); the single claim is the gate's outcome and
 * the evidence is the gate's evidence manifest.
 */
export function buildGateTrustBundle(outcome: MutableRecord, options: BuildOptions = {}): MutableRecord {
  if (!outcome || typeof outcome.gate_id !== "string") {
    throw new Error("buildGateTrustBundle requires a gate outcome with a gate_id");
  }
  const runId = options.runId ?? "run";
  const now = options.now ?? new Date().toISOString();
  const { claim, evidence, events } = claimAndEventsForOutcome(outcome, runId, now);
  return {
    schemaVersion: 3,
    source: options.source ?? `flow/run/${runId}`,
    claims: [claim],
    evidence,
    policies: [],
    events
  };
}

/**
 * Build a run-level aggregate trust bundle: one claim per gate outcome plus a
 * run-level rollup claim, so the whole run is one inspectable trust artifact.
 */
export function buildFlowTrustBundle(run: MutableRecord, options: BuildOptions = {}): MutableRecord {
  const state = run?.state ?? run;
  if (!state || typeof state.run_id !== "string") {
    throw new Error("buildFlowTrustBundle requires a run (or run state) with a run_id");
  }
  const runId = options.runId ?? state.run_id;
  const now = options.now ?? state.updated_at ?? new Date().toISOString();
  const outcomes: MutableRecord[] = Array.isArray(state.gate_outcomes) ? state.gate_outcomes : [];

  const claims: MutableRecord[] = [];
  const evidence: MutableRecord[] = [];
  const events: MutableRecord[] = [];
  const gateClaimIds: string[] = [];

  for (const outcome of outcomes) {
    const built = claimAndEventsForOutcome(outcome, runId, now);
    claims.push(built.claim);
    evidence.push(...built.evidence);
    events.push(...built.events);
    gateClaimIds.push(built.claim.id);
  }

  // Run-level rollup claim. It is verified only when every gate outcome that
  // bears a status is verified (weakest-link); a blocked/route-back gate or a
  // completed run with no gates leaves it proposed/rejected accordingly.
  const runClaimId = `claim.flow.run.${runId}`;
  const statuses = outcomes.map((o) => o.status);
  const anyFailing = statuses.some((s) => s === "block" || s === "route-back");
  const allPass = statuses.length > 0 && statuses.every((s) => s === "pass");
  const runEventStatus: "verified" | "rejected" | "disputed" | null = anyFailing
    ? statuses.includes("route-back")
      ? "disputed"
      : "rejected"
    : allPass
      ? "verified"
      : null;

  const runValue =
    state.status === "completed"
      ? `Run ${runId} completed; all gates passed.`
      : anyFailing
        ? `Run ${runId} ${state.status}; one or more gates did not pass.`
        : `Run ${runId} ${state.status}; gates pending.`;

  const runClaim: MutableRecord = {
    id: runClaimId,
    subjectType: "flow-run",
    subjectId: runId,
    surface: FLOW_TRUST_SURFACE,
    claimType: FLOW_RUN_OUTCOME_CLAIM_TYPE,
    fieldOrBehavior: "runOutcome",
    value: runValue,
    createdAt: now,
    updatedAt: now,
    derivedFrom: gateClaimIds,
    metadata: {
      runStatus: state.status,
      definitionId: state.definition_id,
      subject: state.subject,
      gateCount: outcomes.length
    }
  };

  const runEvidenceId = `evidence.flow.run.${runId}.outcome`;
  evidence.push({
    id: runEvidenceId,
    claimId: runClaimId,
    evidenceType: "human_attestation",
    method: "auditability",
    sourceRef: `flow:run/${runId}/report.json`,
    excerptOrSummary: `${outcomes.length} gate outcome(s): ${
      outcomes.map((o) => `${o.gate_id}=${o.status}`).join(", ") || "none"
    }.`,
    observedAt: now,
    collectedBy: "flow"
  });

  if (runEventStatus) {
    events.push({
      id: `event.flow.run.${runId}.${runEventStatus}`,
      claimId: runClaimId,
      status: runEventStatus,
      actor: "flow",
      method: "flow.evaluateRun",
      evidenceIds: [runEvidenceId],
      createdAt: now,
      ...(runEventStatus === "verified" ? { verifiedAt: now } : {})
    });
  }

  claims.push(runClaim);

  return {
    schemaVersion: 3,
    source: options.source ?? `flow/run/${runId}`,
    claims,
    evidence,
    policies: [],
    events
  };
}
