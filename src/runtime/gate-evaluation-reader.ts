import { compareRfc3339Timestamps, parseRfc3339Timestamp } from "../shared/rfc3339.js";
import { parseGateEvaluationLedger, parseGateEvaluationRef } from "../contracts/gate-evaluation-contract.js";
import type { GateEvaluationReadProjection, GateEvaluationReadResult, GateEvaluationRecord, GateEvaluationRef } from "../contracts/gate-evaluation-contract.js";
import { loadRun } from "./flow-run-store.js";

export type { GateEvaluationReadProjection, GateEvaluationReadResult, GateEvaluationReadStatus } from "../contracts/gate-evaluation-contract.js";

export interface GateEvaluationReadAuthorization {
  authorize(request: { ref: GateEvaluationRef }): boolean | Promise<boolean>;
}

export interface GateEvaluationReadOptions extends GateEvaluationReadAuthorization {
  cwd?: string;
}

function sameRef(left: GateEvaluationRef | undefined, right: GateEvaluationRef) {
  return !!left && left.runId === right.runId && left.gateId === right.gateId && left.evaluationId === right.evaluationId;
}

function revocationCodes(_entry: any, _at: string) {
  // v1 writer receipts bind evidence/expectation ids, not selected claim ids.
  // Never let an unrelated bundle trace taint this appraisal; a later contract
  // revision may expose claim-scoped revocation only after it is recorded.
  return [];
  /*
  const pinned = parseRfc3339Timestamp(at);
  if (!pinned) return [];
  const revoked = (entry?.bundle?.authorityTrace ?? []).some((trace: any) => {
    const instant = parseRfc3339Timestamp(trace?.revokedAt);
    return instant && compareRfc3339Timestamps(instant, pinned) <= 0;
  }) || (entry?.bundle?.events ?? []).some((event: any) => {
    const instant = parseRfc3339Timestamp(event?.verifiedAt ?? event?.createdAt);
    return (event?.status === "revoked" || event?.type === "invalidation") && instant && compareRfc3339Timestamps(instant, pinned) <= 0;
  });
  return revoked ? ["revoked"] : [];
  */
}

function pinnedFreshness(_entry: any, _at: string): "recorded" | "stale" | "unavailable" {
  // Same fail-closed boundary as revocationCodes: checkpoint claim maps are
  // bundle-wide and cannot identify the claim selected by this receipt.
  return "unavailable";
  /*
  const checkpoint = (entry?.inquiry_records ?? []).find((record: any) => record?.asOf === at);
  if (!checkpoint?.statusByClaimId || typeof checkpoint.statusByClaimId !== "object") return "unavailable";
  return Object.values(checkpoint.statusByClaimId).includes("stale") ? "stale" : "recorded";
  */
}

function projectRecord(record: GateEvaluationRecord, run: any): GateEvaluationReadProjection {
  const current = (run.state.gate_outcomes ?? []).find((outcome: any) => outcome.gate_id === record.ref.gateId);
  const currentRef = current?.evaluation_ref;
  const currentStanding = !current ? "invalidated" : sameRef(currentRef, record.ref) ? "current" : "superseded";
  const evidence = new Map<string, any>((run.manifest.evidence ?? []).map((entry: any): [string, any] => [entry.id, entry]));
  return {
    ref: record.ref,
    evaluatedAt: record.evaluatedAt,
    originalVerdict: record.originalVerdict,
    kind: record.previousRef ? "recheck" : "initial",
    trigger: record.trigger,
    ...(record.previousRef ? { previousRef: record.previousRef } : {}),
    ...(record.exceptionId ? { exceptionId: record.exceptionId } : {}),
    ...(record.routeBack ? { routeBack: record.routeBack } : {}),
    currentStanding,
    currentRun: { status: run.state.status, currentStep: run.state.current_step },
    ...(parseGateEvaluationRef(currentRef) ? { currentPersistedGateRef: currentRef } : {}),
    selectedEvidence: record.selections.map((selection) => {
      const entry = evidence.get(selection.evidenceId);
      return {
        evidenceId: selection.evidenceId,
        ...(selection.sha256 ? { sha256: selection.sha256 } : {}),
        standing: !entry ? "missing" : entry.superseded_by ? "superseded" : "current",
        freshness: !entry ? "unavailable" : pinnedFreshness(entry, record.evaluatedAt),
        revocationCodes: !entry ? [] : revocationCodes(entry, record.evaluatedAt)
      };
    })
  };
}

/**
 * Read one exact immutable receipt. Authorization is intentionally invoked
 * before the recovery-fenced load performs any run I/O. A denial or unknown
 * id is opaque; malformed persisted state remains fail-closed as unavailable.
 */
export async function readGateEvaluation(value: unknown, options: GateEvaluationReadOptions): Promise<GateEvaluationReadResult> {
  const ref = parseGateEvaluationRef(value);
  if (!ref) throw new Error("flow.gate_evaluation_read.request.invalid");
  if (!options || typeof options.authorize !== "function") throw new Error("flow.gate_evaluation_read.authorization.required");
  let authorized = false;
  try {
    authorized = await options.authorize({ ref });
  } catch {
    return { status: "unavailable" };
  }
  if (authorized !== true) return { status: "missing" };
  let run: any;
  try {
    run = await loadRun(ref.runId, options.cwd);
  } catch (error) {
    const code = (error as Error & { code?: string }).code ?? "";
    if (code === "flow.run_location.not_found") return { status: "missing" };
    if (String((error as Error).message).includes("flow.gate_evaluation_ledger.unsupported")) return { status: "unsupported" };
    return { status: "unavailable" };
  }
  const ledger = run.state.gate_evaluation_ledger;
  if (ledger === undefined || ledger?.version !== "1") return { status: "unsupported" };
  const parsed = parseGateEvaluationLedger(ledger);
  if (!parsed) return { status: "unavailable" };
  const record = parsed.records.find((candidate) => sameRef(candidate.ref, ref));
  if (!record) return { status: "missing" };
  const evaluation = projectRecord(record, run);
  // Authorization can be revoked while the fenced read is in progress. Check
  // again immediately before publishing the projection to the caller.
  try {
    if (await options.authorize({ ref }) !== true) return { status: "missing" };
  } catch {
    return { status: "unavailable" };
  }
  return { status: "found", evaluation };
}
