import { compareRfc3339Timestamps, parseRfc3339Timestamp } from "../shared/rfc3339.js";
import { surfaceTimestampValidationView } from "../shared/rfc3339.js";
import { parseGateEvaluationLedger, parseGateEvaluationRef } from "../contracts/gate-evaluation-contract.js";
import type { GateEvaluationReadProjection, GateEvaluationReadResult, GateEvaluationRecord, GateEvaluationRef } from "../contracts/gate-evaluation-contract.js";
import { loadRun, readVerifiedPinnedEvidenceBytes } from "./flow-run-store.js";
import { buildTrustReport, checkAuthorityActive, validateTrustBundle } from "@kontourai/surface";

export type { GateEvaluationReadProjection, GateEvaluationReadResult, GateEvaluationReadStatus } from "../contracts/gate-evaluation-contract.js";

export interface GateEvaluationReadAuthorization {
  authorize(request: { ref: GateEvaluationRef }): boolean | Promise<boolean>;
}

export interface GateEvaluationReadOptions extends GateEvaluationReadAuthorization {
  cwd?: string;
  now?: Date | string;
}

function sameRef(left: GateEvaluationRef | undefined, right: GateEvaluationRef) {
  return !!left && left.runId === right.runId && left.gateId === right.gateId && left.evaluationId === right.evaluationId;
}

type ReaderTime = { asOf: string; exact: NonNullable<ReturnType<typeof parseRfc3339Timestamp>>; surfaceNow: Date };

function readerTime(value: unknown): ReaderTime | undefined {
  if (value instanceof Date && !Number.isFinite(value.getTime())) return undefined;
  const asOf = value === undefined ? new Date().toISOString() : value instanceof Date ? value.toISOString() : value;
  const exact = parseRfc3339Timestamp(asOf);
  const surfaceNow = typeof asOf === "string" ? new Date(asOf) : new Date(NaN);
  return exact && typeof asOf === "string" && Number.isFinite(surfaceNow.getTime()) ? { asOf, exact, surfaceNow } : undefined;
}

function canonicalTimestamp(timestamp: NonNullable<ReturnType<typeof parseRfc3339Timestamp>>) {
  const whole = new Date(timestamp.epochSecond * 1000).toISOString().replace(/\.000Z$/, "");
  return `${whole}${timestamp.fractionalSecond ? `.${timestamp.fractionalSecond}` : ""}Z`;
}

/** Apply Flow's exact RFC3339 fence before calling Surface with only the one pinned trace. */
function pinnedAuthorityState(bundle: any, witness: Exclude<GateEvaluationRecord["selections"][number]["authorityWitness"], null | undefined>, time: ReaderTime): "active" | "revoked" | "expired" | "not_yet_valid" | "unavailable" {
  const trace = (bundle?.authorityTrace ?? []).find((candidate: any) => candidate?.id === witness.traceId);
  if (!trace || typeof trace.actorRef !== "string") return "unavailable";
  const observedAt = parseRfc3339Timestamp(trace.observedAt);
  if (!observedAt || compareRfc3339Timestamps(observedAt, time.exact) > 0) return "not_yet_valid";
  const normalized = structuredClone(trace);
  for (const field of ["validFrom", "validUntil", "revokedAt"] as const) {
    if (trace[field] === undefined) continue;
    const parsed = parseRfc3339Timestamp(trace[field]);
    if (!parsed) return "unavailable";
    normalized[field] = canonicalTimestamp(parsed);
    if (field === "validFrom" && compareRfc3339Timestamps(parsed, time.exact) > 0) return "not_yet_valid";
    if (field === "validUntil" && compareRfc3339Timestamps(parsed, time.exact) < 0) return "expired";
    if (field === "revokedAt" && compareRfc3339Timestamps(parsed, time.exact) <= 0) return "revoked";
  }
  delete normalized.validFrom;
  delete normalized.validUntil;
  delete normalized.revokedAt;
  const active = checkAuthorityActive(trace.actorRef, [normalized], time.surfaceNow);
  return active === "active" ? "active" : active === "revoked" ? "revoked" : active === "expired" ? "expired" : "unavailable";
}

async function retainedReport(runDir: string, entry: any, selection: GateEvaluationRecord["selections"][number], time: ReaderTime) {
  const bytes = await readVerifiedPinnedEvidenceBytes(runDir, entry, selection.sha256);
  if (!bytes) return undefined;
  try {
    // This parsed value comes from the same immutable byte buffer we hashed.
    // `entry.bundle` is only an attachment-time convenience projection and can
    // never heal the receipt if a manifest is later modified.
    const bundle = JSON.parse(bytes.toString("utf8"));
    const validated = validateTrustBundle(surfaceTimestampValidationView(bundle));
    return { bundle, report: buildTrustReport(validated, { now: time.surfaceNow }) };
  } catch {
    return undefined;
  }
}

async function projectRecord(record: GateEvaluationRecord, run: any, time: ReaderTime): Promise<GateEvaluationReadProjection> {
  const current = (run.state.gate_outcomes ?? []).find((outcome: any) => outcome.gate_id === record.ref.gateId);
  const currentRef = current?.evaluation_ref;
  const currentStanding = !current ? "invalidated" : sameRef(currentRef, record.ref) ? "current" : "superseded";
  const evidence = new Map<string, any>((run.manifest.evidence ?? []).map((entry: any): [string, any] => [entry.id, entry]));
  const reports = new Map<string, ReturnType<typeof retainedReport>>();
  const selectedEvidence: GateEvaluationReadProjection["selectedEvidence"] = await Promise.all(record.selections.map(async (selection): Promise<GateEvaluationReadProjection["selectedEvidence"][number]> => {
      const entry = evidence.get(selection.evidenceId);
      let retained = reports.get(selection.evidenceId);
      if (retained === undefined) {
        retained = retainedReport(run.dir, entry, selection, time);
        reports.set(selection.evidenceId, retained);
      }
      const retainedValue = await retained;
      const claims = new Map<string, any>((retainedValue?.report?.claims ?? []).map((claim: any): [string, any] => [claim?.id, claim]));
      const selectedClaims = (selection.claimIds ?? []).map((id) => claims.get(id));
      const freshness = !retainedValue || !selection.claimIds?.length || selectedClaims.some((claim) => !claim)
        ? "unavailable"
        : selectedClaims.some((claim) => claim.status === "stale" || claim.freshness?.stale === true) ? "stale" : "recorded";
      const authorityState = selection.authorityWitness === undefined ? "not-captured"
        : selection.authorityWitness === null ? "not-used"
          : !retainedValue ? "unavailable" : pinnedAuthorityState(retainedValue.bundle, selection.authorityWitness, time);
      return {
        evidenceId: selection.evidenceId,
        ...(selection.sha256 ? { sha256: selection.sha256 } : {}),
        standing: !entry ? "missing" : entry.superseded_by ? "superseded" : "current",
        freshness,
        revocationCodes: authorityState === "revoked" ? ["revoked"] : [],
        authority: authorityState === "active" ? "active" : authorityState === "not-captured" ? "not-captured" : authorityState === "not-used" ? "not-used" : "unavailable"
      };
    }));
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
    validityAsOf: time.asOf,
    validityScope: "retained-immutable-bundle",
    externalRevocation: "not-observed",
    selectedEvidence
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
  const time = readerTime(options.now);
  if (!time) throw new Error("flow.gate_evaluation_read.now.invalid");
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
  const evaluation = await projectRecord(record, run, time);
  // Authorization can be revoked while the fenced read is in progress. Check
  // again immediately before publishing the projection to the caller.
  try {
    if (await options.authorize({ ref }) !== true) return { status: "missing" };
  } catch {
    return { status: "unavailable" };
  }
  return { status: "found", evaluation };
}
