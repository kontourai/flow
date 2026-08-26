import type { GateOutcome, MutableRecord } from "../contracts/flow-types.js";
import type { GateEvaluationEvidenceSelection } from "../contracts/gate-evaluation-contract.js";
import { defaultFlowConfig } from "../config/flow-config.js";
import { validateFlatFlowConfig } from "../config/flow-config-validator.js";
import {
  acceptedExceptionFor,
  attachedEvidenceFor,
  descendantsOf,
  occupiedSteps,
  findGate,
  getStep,
  invalidateDescendants,
  nextActionForStep,
  routeBackDecision,
  routeReasonForFailedEvidence
} from "../definition/flow-definition.js";
import {
  expectationLabel,
  slugLabel
} from "../shared/flow-utils.js";
import { compareRfc3339Timestamps, parseRfc3339Timestamp, surfaceTimestampValidationView } from "../shared/rfc3339.js";
import type { ParsedRfc3339Timestamp } from "../shared/rfc3339.js";
import { applyDerivation, buildIdentityIndex, buildTrustReport, checkAuthorityActive, deriveClaimGroupRollups, deriveConflictTransparencyGaps, deriveWaiverValidity, evidenceEntailsClaim, resolvePolicyForClaim, summarizeClaims, validateTrustBundle } from "@kontourai/surface";
import { validateTrustBundleSchema } from "./trust-bundle-validator.js";
import { surfaceDerivationWithinBudget } from "./surface-derivation-budget.js";

interface GateAuthorityDependencies {
  validate(bundle: unknown): any;
  buildReport(bundle: any, options: { now: Date }): any;
  checkAuthorityActive(actorRef: string, traces: any[], now: Date): string;
}

const DEFAULT_GATE_AUTHORITY_DEPENDENCIES: GateAuthorityDependencies = {
  validate: validateTrustBundle,
  buildReport: buildTrustReport,
  checkAuthorityActive
};

/**
 * Flow compares authority chronology at RFC3339 precision, including
 * fractional seconds that JavaScript's Date cannot represent. Surface is
 * still given a Date for its public APIs, but it never becomes Flow's source
 * of truth for the comparison itself.
 */
interface GateEvaluationTime {
  exact: ParsedRfc3339Timestamp;
  surfaceNow: Date;
}

type GateEvaluationInput = Date | string;

function parseGateEvaluationTime(value: unknown): GateEvaluationTime | undefined {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return undefined;
    const exact = parseRfc3339Timestamp(value.toISOString());
    return exact ? { exact, surfaceNow: new Date(value.getTime()) } : undefined;
  }
  const exact = parseRfc3339Timestamp(value);
  if (!exact || typeof value !== "string") return undefined;
  const surfaceNow = new Date(value);
  return Number.isFinite(surfaceNow.getTime()) ? { exact, surfaceNow } : undefined;
}

export function expectationsForGate(gate: any, config: MutableRecord = defaultFlowConfig()) {
  const overrides = config.gate_overrides?.[gate.id]?.expectations ?? {};
  return (gate.expects ?? []).map((expectation) => ({
    ...expectation,
    bundle_claim: expectation.bundle_claim ? { ...expectation.bundle_claim } : undefined,
    ...(overrides[expectation.id] ?? {}),
    id: expectation.id
  }));
}

function findClaimsInReport(report: any, selector: any): any[] {
  if (!report?.claims || !Array.isArray(report.claims)) return [];
  return report.claims.filter((claim: any) => {
    // Surface preserves producer-level supersession separately from its derived
    // status. Historical critique claims can therefore re-derive as `proposed`
    // while still carrying producerStatus=superseded. They remain audit history,
    // but must never compete with the live replacement claim at a gate.
    if (claim.producerStatus === "superseded" || claim.metadata?.superseded_by) return false;
    if (claim.claimType !== selector.claimType) return false;
    if (selector.subjectType && claim.subjectType !== selector.subjectType) return false;
    if (selector.subjectId && claim.subjectId !== selector.subjectId) return false;
    return true;
  });
}

/**
 * Surface 2.14.0 accepts a `Date` as its evaluation clock. Date truncates
 * RFC3339 fractional seconds below milliseconds, so Flow applies this small
 * chronology fence only after Surface has selected an otherwise accepted
 * claim. Surface remains responsible for status/policy derivation; Flow only
 * refuses an accepted result when the claim's own issue/expiry or the event
 * timeline that Surface folds cannot be true at Flow's exact instant.
 */
function surfaceDateMilliseconds(timestamp: ParsedRfc3339Timestamp): number {
  return (timestamp.epochSecond * 1000) + Number(timestamp.fractionalSecond.slice(0, 3).padEnd(3, "0"));
}

type TimedEvent = { event: any; index: number; createdAt: ParsedRfc3339Timestamp; verifiedAt?: ParsedRfc3339Timestamp };
type TimedTrace = { trace: any; index: number; observedAt?: ParsedRfc3339Timestamp; validFrom?: ParsedRfc3339Timestamp; validUntil?: ParsedRfc3339Timestamp; revokedAt?: ParsedRfc3339Timestamp; invalidTimestamp: boolean };
type Reconciliation = { reason: string | null; status: "stale" | "unknown" | null; governing?: TimedEvent; expiresAt?: string; freshnessStale?: boolean };
type BundleContext = {
  claims: Map<string, any>;
  eventsByClaim: Map<string, TimedEvent[]>;
  evidenceByClaim: Map<string, any[]>;
  traces: TimedTrace[];
  policies: any[];
  surfaceResolutionComparisons: number;
  exactResolutionComparisons: number;
  resolutionBudgetExceeded: boolean;
};

const MAX_RESOLUTION_TRACE_COMPARISONS = 4_096;

function indexedBundle(bundle: any): BundleContext | null {
  const claims = new Map<string, any>();
  for (const claim of bundle?.claims ?? []) if (typeof claim?.id === "string") claims.set(claim.id, claim);
  const eventsByClaim = new Map<string, TimedEvent[]>();
  for (const [index, event] of (bundle?.events ?? []).entries()) {
    const createdAt = parseRfc3339Timestamp(event?.createdAt);
    const verifiedAt = event?.verifiedAt === undefined ? undefined : parseRfc3339Timestamp(event.verifiedAt);
    if (createdAt === null || verifiedAt === null || typeof event?.claimId !== "string") return null;
    const events = eventsByClaim.get(event.claimId) ?? [];
    events.push({ event, index, createdAt, verifiedAt });
    eventsByClaim.set(event.claimId, events);
  }
  const evidenceByClaim = new Map<string, any[]>();
  for (const evidence of bundle?.evidence ?? []) {
    if (typeof evidence?.claimId !== "string" || parseRfc3339Timestamp(evidence.observedAt) === null) return null;
    const evidenceForClaim = evidenceByClaim.get(evidence.claimId) ?? [];
    evidenceForClaim.push(evidence);
    evidenceByClaim.set(evidence.claimId, evidenceForClaim);
  }
  const traces: TimedTrace[] = [];
  for (const [index, trace] of (bundle?.authorityTrace ?? []).entries()) {
    const fields = ["observedAt", "validFrom", "validUntil", "revokedAt"] as const;
    const parsed = Object.fromEntries(fields.map((field) => [field, trace?.[field] === undefined ? undefined : parseRfc3339Timestamp(trace[field])])) as Record<string, ParsedRfc3339Timestamp | null | undefined>;
    traces.push({ trace, index, observedAt: parsed.observedAt ?? undefined, validFrom: parsed.validFrom ?? undefined, validUntil: parsed.validUntil ?? undefined, revokedAt: parsed.revokedAt ?? undefined, invalidTimestamp: fields.some((field) => parsed[field] === null) });
  }
  return { claims, eventsByClaim, evidenceByClaim, traces, policies: bundle?.policies ?? [], surfaceResolutionComparisons: 0, exactResolutionComparisons: 0, resolutionBudgetExceeded: false };
}

function latestEvent(events: TimedEvent[], comparison: (left: TimedEvent, right: TimedEvent) => number, predicate: (entry: TimedEvent) => boolean = () => true): TimedEvent | undefined {
  let latest: TimedEvent | undefined;
  for (const event of events) {
    if (!predicate(event) || (latest && comparison(event, latest) <= 0)) continue;
    latest = event;
  }
  return latest;
}

function surfaceEventOrder(left: TimedEvent, right: TimedEvent) {
  const byMillisecond = surfaceDateMilliseconds(left.createdAt) - surfaceDateMilliseconds(right.createdAt);
  return byMillisecond || right.index - left.index;
}

function exactEventOrder(left: TimedEvent, right: TimedEvent) {
  return compareRfc3339Timestamps(left.createdAt, right.createdAt) || right.index - left.index;
}

function decimalNumber(value: number): { unscaled: bigint; scale: number } | null {
  if (!Number.isFinite(value)) return null;
  const source = String(value).toLowerCase();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(source);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+(?=\d)/, "");
  const exponent = Number(match[4] ?? "0");
  const sourceScale = (match[3] ?? "").length;
  const scale = sourceScale - exponent;
  if (!Number.isSafeInteger(scale)) return null;
  if (scale >= 0) return { unscaled: sign * BigInt(digits || "0"), scale };
  return { unscaled: sign * BigInt(digits || "0") * (10n ** BigInt(-scale)), scale: 0 };
}

function timestampUnits(value: ParsedRfc3339Timestamp, scale: number): bigint {
  const factor = 10n ** BigInt(scale);
  const fraction = value.fractionalSecond ? BigInt(value.fractionalSecond) * (10n ** BigInt(scale - value.fractionalSecond.length)) : 0n;
  return (BigInt(value.epochSecond) * factor) + fraction;
}

function durationExpiredSeconds(anchor: ParsedRfc3339Timestamp, durationSeconds: number, evaluatedAt: ParsedRfc3339Timestamp): boolean | null {
  const decimal = decimalNumber(durationSeconds);
  if (!decimal) return null;
  const scale = Math.max(anchor.fractionalSecond.length, evaluatedAt.fractionalSecond.length, decimal.scale);
  const duration = decimal.unscaled * (10n ** BigInt(scale - decimal.scale));
  return timestampUnits(evaluatedAt, scale) > timestampUnits(anchor, scale) + duration;
}

function durationExpired(anchor: ParsedRfc3339Timestamp, durationDays: number, evaluatedAt: ParsedRfc3339Timestamp): boolean | null {
  const decimal = decimalNumber(durationDays);
  if (!decimal) return null;
  const scale = Math.max(anchor.fractionalSecond.length, evaluatedAt.fractionalSecond.length, decimal.scale);
  const duration = decimal.unscaled * 86_400n * (10n ** BigInt(scale - decimal.scale));
  return timestampUnits(evaluatedAt, scale) > timestampUnits(anchor, scale) + duration;
}

function timestampAfterSeconds(anchor: ParsedRfc3339Timestamp, seconds: number): ParsedRfc3339Timestamp | null {
  const decimal = decimalNumber(seconds);
  if (!decimal) return null;
  const scale = Math.max(anchor.fractionalSecond.length, decimal.scale);
  const factor = 10n ** BigInt(scale);
  let total = timestampUnits(anchor, scale) + (decimal.unscaled * (10n ** BigInt(scale - decimal.scale)));
  let epochSecond = total / factor;
  let fractional = total % factor;
  if (fractional < 0n) {
    epochSecond -= 1n;
    fractional += factor;
  }
  const numberEpoch = Number(epochSecond);
  if (!Number.isSafeInteger(numberEpoch)) return null;
  return { epochSecond: numberEpoch, fractionalSecond: fractional.toString().padStart(scale, "0").replace(/0+$/, "") };
}

function timestampAfterDays(anchor: ParsedRfc3339Timestamp, days: number): ParsedRfc3339Timestamp | null {
  const decimal = decimalNumber(days);
  if (!decimal) return null;
  const scale = Math.max(anchor.fractionalSecond.length, decimal.scale);
  const factor = 10n ** BigInt(scale);
  let total = timestampUnits(anchor, scale) + (decimal.unscaled * 86_400n * (10n ** BigInt(scale - decimal.scale)));
  let epochSecond = total / factor;
  let fractional = total % factor;
  if (fractional < 0n) {
    epochSecond -= 1n;
    fractional += factor;
  }
  const numberEpoch = Number(epochSecond);
  if (!Number.isSafeInteger(numberEpoch)) return null;
  return { epochSecond: numberEpoch, fractionalSecond: fractional.toString().padStart(scale, "0").replace(/0+$/, "") };
}

function exactResolutionAuthorized(event: TimedEvent, trace: TimedTrace): boolean {
  if (trace.invalidTimestamp) return false;
  if (trace.trace?.actorRef !== event.event.actor) return false;
  if (event.event.authorityRef !== undefined && trace.trace.authorityRef !== event.event.authorityRef) return false;
  if (trace.validFrom && compareRfc3339Timestamps(trace.validFrom, event.createdAt) > 0) return false;
  if (trace.validUntil && compareRfc3339Timestamps(trace.validUntil, event.createdAt) < 0) return false;
  if (trace.revokedAt && compareRfc3339Timestamps(trace.revokedAt, event.createdAt) <= 0) return false;
  return true;
}

function traceScopesResolution(trace: TimedTrace, claim: any, governing: TimedEvent, linkedEvidence: any[]): boolean {
  if (trace.trace?.subject?.subjectType !== claim.subjectType || trace.trace?.subject?.subjectId !== claim.subjectId) return false;
  if (Array.isArray(trace.trace?.claimIds) && trace.trace.claimIds.includes(claim.id)) return true;
  const governingEvidenceIds = new Set(Array.isArray(governing.event.evidenceIds) ? governing.event.evidenceIds : []);
  const linkedEvidenceIds = new Set(linkedEvidence.map((entry: any) => entry.id));
  return Array.isArray(trace.trace?.evidenceIds)
    && trace.trace.evidenceIds.some((id: string) => governingEvidenceIds.has(id) && linkedEvidenceIds.has(id));
}

/**
 * Surface resolution selection is actor/ref and decision-time based. Before
 * Flow relies on that result, one individual trace must also bind this exact
 * claim (or its governing evidence) and be observed no later than evaluation.
 * An observation may legitimately arrive after the decision but before the
 * evaluation, so it is not constrained to decision time.
 */
function exactResolutionAuthorizedForClaim(event: TimedEvent, trace: TimedTrace, claim: any, linkedEvidence: any[], evaluatedAt: ParsedRfc3339Timestamp): boolean {
  return exactResolutionAuthorized(event, trace)
    && trace.observedAt !== undefined
    && compareRfc3339Timestamps(trace.observedAt, evaluatedAt) <= 0
    && traceScopesResolution(trace, claim, event, linkedEvidence);
}

function surfaceResolutionAuthorized(event: TimedEvent, trace: TimedTrace): boolean {
  const atDecision = event.event.createdAt;
  return trace.trace?.actorRef === event.event.actor
    && (event.event.authorityRef === undefined || trace.trace.authorityRef === event.event.authorityRef)
    && (!trace.trace.revokedAt || trace.trace.revokedAt > atDecision)
    && (!trace.trace.validFrom || trace.trace.validFrom <= atDecision)
    && (!trace.trace.validUntil || trace.trace.validUntil >= atDecision);
}

function semanticallyEquivalentEvents(left: TimedEvent, right: TimedEvent) {
  const comparable = (entry: TimedEvent) => ({
    status: entry.event.status,
    type: entry.event.type,
    actor: entry.event.actor,
    authorityRef: entry.event.authorityRef,
    resolvesDispute: entry.event.resolvesDispute === true,
    evidenceIds: [...(entry.event.evidenceIds ?? [])].sort()
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function resolutionCandidate(context: BundleContext, events: TimedEvent[], order: (left: TimedEvent, right: TimedEvent) => number, authorized: (event: TimedEvent, trace: TimedTrace) => boolean, pass: "surface" | "exact"): { event: TimedEvent; trace: TimedTrace } | "over_budget" | undefined {
  let chosen: { event: TimedEvent; trace: TimedTrace } | undefined;
  for (const event of events) {
    if (event.event.resolvesDispute !== true) continue;
    for (const trace of context.traces) {
      const counter = pass === "surface" ? "surfaceResolutionComparisons" : "exactResolutionComparisons";
      context[counter] += 1;
      // The adapter runs in mutation paths. Surface has no exact-clock API yet,
      // so cap this bounded reconciliation rather than allow an adversarial
      // event×trace product to make a run lock unbounded.
      if (context[counter] > MAX_RESOLUTION_TRACE_COMPARISONS) {
        context.resolutionBudgetExceeded = true;
        return "over_budget";
      }
      if (!authorized(event, trace) || (chosen && order(event, chosen.event) <= 0)) continue;
      chosen = { event, trace };
    }
  }
  return chosen;
}

function reconciliationForClaim(context: BundleContext, reportClaim: any, evaluatedAt: ParsedRfc3339Timestamp): Reconciliation {
  const claim = context.claims.get(reportClaim.id);
  const replacementStatus = reportClaim.status === "verified" ? "stale" : "unknown" as const;
  if (!claim) return { reason: "bundle_invalid", status: replacementStatus };
  const createdAt = parseRfc3339Timestamp(claim.createdAt);
  const updatedAt = parseRfc3339Timestamp(claim.updatedAt);
  const expiresAt = claim.expiresAt === undefined ? undefined : parseRfc3339Timestamp(claim.expiresAt);
  const events = context.eventsByClaim.get(claim.id) ?? [];
  if (createdAt === null || updatedAt === null || expiresAt === null) return { reason: "bundle_invalid", status: replacementStatus };

  const evidence = context.evidenceByClaim.get(claim.id) ?? [];
  const observedAt = evidence.map((entry: any) => parseRfc3339Timestamp(entry.observedAt));
  if (observedAt.some((timestamp) => timestamp === null)) return { reason: "bundle_invalid", status: replacementStatus };
  if (compareRfc3339Timestamps(createdAt, evaluatedAt) > 0 || compareRfc3339Timestamps(updatedAt, evaluatedAt) > 0
    || events.some((entry) => compareRfc3339Timestamps(entry.createdAt, evaluatedAt) > 0 || (entry.verifiedAt && compareRfc3339Timestamps(entry.verifiedAt, evaluatedAt) > 0))
    || observedAt.some((timestamp) => compareRfc3339Timestamps(timestamp!, evaluatedAt) > 0)) {
    return { reason: "claim_not_current", status: replacementStatus };
  }

  const surfaceTop = latestEvent(events, surfaceEventOrder);
  const exactTop = latestEvent(events, exactEventOrder);
  // Surface's stable sort retains input order for same-millisecond events.
  // If exact order selects a different governing event, actor provenance and
  // terminal status are both unknowable from Surface's Date-based result.
  if (surfaceTop?.event.id !== exactTop?.event.id && (!surfaceTop || !exactTop || !semanticallyEquivalentEvents(surfaceTop, exactTop))) return { reason: "claim_time_ambiguous", status: replacementStatus };

  if (context.resolutionBudgetExceeded) return { reason: "claim_time_ambiguous", status: replacementStatus };
  const surfaceResolution = resolutionCandidate(context, events, surfaceEventOrder, surfaceResolutionAuthorized, "surface");
  const exactResolution = resolutionCandidate(
    context,
    events,
    exactEventOrder,
    (event, trace) => exactResolutionAuthorizedForClaim(event, trace, claim, evidence, evaluatedAt),
    "exact"
  );
  if (surfaceResolution === "over_budget" || exactResolution === "over_budget") return { reason: "claim_time_ambiguous", status: replacementStatus };
  if (surfaceResolution && surfaceResolution.event.event.status === reportClaim.status) {
    if (!exactResolution || exactResolution.event.event.id !== surfaceResolution.event.event.id) return { reason: "claim_time_ambiguous", status: replacementStatus };
    const hasExactNewerBlockingFailure = evidence.filter((entry: any) => evidenceEntailsClaim(entry) && entry.passing === false && entry.blocking !== false)
      .some((entry: any) => compareRfc3339Timestamps(parseRfc3339Timestamp(entry.observedAt)!, exactResolution.event.createdAt) > 0);
    if (hasExactNewerBlockingFailure) return { reason: "claim_time_ambiguous", status: replacementStatus };
    // Surface resolution semantics deliberately bypass normal freshness.
    return { reason: null, status: null, governing: exactResolution.event };
  }

  const latestVerified = latestEvent(events, exactEventOrder, (entry) => entry.event.status === "verified");
  const freshnessAnchor = latestVerified?.verifiedAt ?? latestVerified?.createdAt;
  let exactExpiry: ParsedRfc3339Timestamp | undefined;
  if (freshnessAnchor && expiresAt !== undefined) {
    exactExpiry = expiresAt;
  } else if (freshnessAnchor && claim.expiresAt === undefined && claim.ttlSeconds !== undefined) {
    if (!Number.isFinite(claim.ttlSeconds)) return { reason: "bundle_invalid", status: replacementStatus };
    exactExpiry = timestampAfterSeconds(freshnessAnchor, claim.ttlSeconds) ?? undefined;
    if (!exactExpiry) return { reason: "bundle_invalid", status: replacementStatus };
  } else if (freshnessAnchor && claim.expiresAt === undefined && claim.ttlSeconds === undefined) {
    const policy = resolvePolicyForClaim(claim, context.policies);
    if (policy?.validityRule?.kind === "duration") {
      exactExpiry = timestampAfterDays(freshnessAnchor, policy.validityRule.durationDays) ?? undefined;
      if (!exactExpiry) return { reason: "bundle_invalid", status: replacementStatus };
    }
  }

  const eventDrivenStale = reportClaim.status === "stale" && exactTop && (exactTop.event.type === "invalidation" || ["revoked", "stale"].includes(exactTop.event.status));
  if (eventDrivenStale) return { reason: null, status: null, governing: exactTop, ...(exactExpiry ? { expiresAt: canonicalAuthorityTimestamp(exactExpiry) } : {}) };
  // Surface may short-circuit a previously stale checkpoint. Reconstruct the
  // same exact expiry on every pass so checkpoint/report projections do not
  // lose sub-millisecond TTL or duration information after the first stale run.
  if (reportClaim.status === "stale") {
    return {
      reason: null,
      status: null,
      governing: latestVerified,
      ...(exactExpiry ? { expiresAt: canonicalAuthorityTimestamp(exactExpiry), freshnessStale: true } : {})
    };
  }

  // Freshness is Surface's normal verified-event branch. Assumed and
  // resolution outcomes intentionally bypass it, so do not reinterpret them.
  if (reportClaim.status !== "verified") return { reason: null, status: null };
  const latest = exactTop;
  if (!latest || latest.event.status !== "verified") return { reason: null, status: null };
  if (exactExpiry && compareRfc3339Timestamps(exactExpiry, evaluatedAt) < 0) {
    return { reason: "stale", status: "stale", governing: latest, expiresAt: canonicalAuthorityTimestamp(exactExpiry), freshnessStale: true };
  }
  return { reason: null, status: null, governing: latest, ...(exactExpiry ? { expiresAt: canonicalAuthorityTimestamp(exactExpiry) } : {}) };
}

/**
 * Surface remains the status and policy authority. This reconciliation only
 * changes a Surface-verified claim when the public Date/string APIs lost an
 * exact RFC3339 ordering that could have authorized it. The result is shared
 * by direct gate evaluation and canonical live report re-derivation.
 * TODO(surface exact-clock): replace this adapter when Surface exposes an
 * exact-RFC3339 clock/status derivation API; Flow must not grow a duplicate
 * status fold while that upstream contract is unavailable.
 */
export function reconcileSurfaceBundleReport(bundle: any, report: any, evaluationNow: GateEvaluationInput) {
  const evaluation = parseGateEvaluationTime(evaluationNow);
  if (!evaluation || !report?.claims || !Array.isArray(report.claims)) return { report, diagnostics: new Map<string, string>(), reconciliations: new Map<string, Reconciliation>() };
  const context = indexedBundle(bundle);
  if (!context) return { report, diagnostics: new Map<string, string>(report.claims.map((claim: any) => [claim.id, "bundle_invalid"])), reconciliations: new Map<string, Reconciliation>() };
  const reconciled = structuredClone(report);
  const exactNow = evaluationNow instanceof Date ? evaluationNow.toISOString() : evaluationNow;
  // Checkpoints use report.generatedAt as their as-of instant. Retain the
  // caller's exact instant so the next canonical derivation does not inherit a
  // millisecond-truncated checkpoint boundary.
  reconciled.generatedAt = exactNow;
  const diagnostics = new Map<string, string>();
  const reconciliations = new Map<string, Reconciliation>();
  const exactlyStale = new Set<string>();
  for (const claim of reconciled.claims) {
    const result = reconciliationForClaim(context, claim, evaluation.exact);
    reconciliations.set(claim.id, result);
    if (result.reason) diagnostics.set(claim.id, result.reason);
    if (result.status) {
      claim.status = result.status;
    }
    if (result.status || result.expiresAt) {
      claim.freshness = {
        ...(claim.freshness ?? {}),
        asOf: exactNow,
        stale: (result.status ?? claim.status) === "stale",
        ...(result.expiresAt ? { expiresAt: result.expiresAt } : {})
      };
    }
    // A stale Surface checkpoint can skip the normal gap fold. An exact expiry
    // reconstructed above identifies that time-based stale branch without
    // relabeling event-driven stale/revocation as a freshness breach.
    if (result.freshnessStale) exactlyStale.add(claim.id);
  }

  // Apply Surface's public derivation ceiling again after Flow has corrected a
  // base claim at exact RFC3339 precision. The original Surface fold cannot
  // observe that correction, so a derived claim would otherwise remain
  // verified even though one of its inputs is now stale.
  const derivationGaps: any[] = [];
  const derivationChanges: any[] = [];
  for (let pass = 0; pass < reconciled.claims.length; pass += 1) {
    let changed = false;
    const statuses = new Map<string, any>(reconciled.claims.map((claim: any) => [claim.id, claim.status]));
    for (const claim of reconciled.claims) {
      const sourceClaim = context.claims.get(claim.id);
      if (!sourceClaim) continue;
      const outcome = applyDerivation({
        claim: sourceClaim,
        ownStatus: claim.status,
        ownStatusByClaimId: statuses,
        claimsById: context.claims,
        now: evaluation.surfaceNow
      });
      derivationGaps.push(...outcome.transparencyGaps.map((gap: any) => ({ ...gap, createdAt: exactNow })));
      derivationChanges.push(...outcome.changeRecords.map((record: any) => ({ ...record, createdAt: exactNow })));
      if (outcome.status !== claim.status) {
        claim.status = outcome.status;
        claim.freshness = { ...(claim.freshness ?? {}), asOf: exactNow, stale: outcome.status === "stale" };
        changed = true;
      }
    }
    if (!changed) break;
  }

  const exactFreshnessGaps = reconciled.claims
    .filter((claim: any) => exactlyStale.has(claim.id))
    .map((claim: any) => {
      const policy = resolvePolicyForClaim(context.claims.get(claim.id), context.policies);
      return {
      id: `${claim.id}.gap.freshness-breach`,
      claimId: claim.id,
      type: "freshness_breach",
      severity: claim.impactLevel ?? policy?.impactLevel,
      ...(claim.materiality === undefined ? {} : { materiality: claim.materiality }),
      message: "Claim verification is stale under its verification policy.",
      evidenceIds: (context.evidenceByClaim.get(claim.id) ?? []).filter((entry: any) => evidenceEntailsClaim(entry)).map((entry: any) => entry.id),
      ...(policy?.id ? { policyId: policy.id } : {}),
      blocking: true,
      createdAt: exactNow,
      metadata: { source: "flow.exact-freshness" }
      };
    });
  const mergeCanonicalRecords = (existing: any[], additions: any[]) => {
    const merged = [...existing];
    const indexes = new Map<string, number>();
    const canonicalSource = (item: any) => {
      const source = item.metadata?.source;
      return source === "flow.exact-freshness"
        || source === "policy.incompatibleValues"
        || source === "policy.incompatibleStatuses"
        || (typeof source === "string" && source.startsWith("derivation."));
    };
    const keyFor = (item: any) => `${item.metadata?.source}\u0000${item.id}`;
    for (const [index, item] of existing.entries()) {
      if (canonicalSource(item)) indexes.set(keyFor(item), index);
    }
    for (const item of additions) {
      // Evidence hints (including repeated authored ids) are records, not a
      // cache. Preserve them verbatim; only known generated projections are
      // eligible for a same-source/id regeneration replacement.
      if (!canonicalSource(item)) {
        merged.push(item);
        continue;
      }
      const key = keyFor(item);
      const existingIndex = indexes.get(key);
      if (existingIndex === undefined) {
        indexes.set(key, merged.length);
        merged.push(item);
      } else {
        // Same semantic id from the same canonical producer is the one safe
        // replacement case (for example a regenerated exact derivation).
        merged[existingIndex] = item;
      }
    }
    return merged;
  };
  // Replace Surface's same-id gap when an exact correction discovers stale at
  // a sub-millisecond boundary, then append only the public derivation output.
  reconciled.transparencyGaps = mergeCanonicalRecords(
    (reconciled.transparencyGaps ?? []).filter((gap: any) => !(
      exactlyStale.has(gap.claimId)
      && gap.id === `${gap.claimId}.gap.freshness-breach`
      && gap.metadata?.source === undefined
    )),
    [...exactFreshnessGaps, ...derivationGaps]
  );
  reconciled.changeRecords = mergeCanonicalRecords(reconciled.changeRecords ?? [], derivationChanges);
  const waiverValidityByClaimId = Object.create(null);
  for (const claim of reconciled.claims) {
    const sourceClaim = context.claims.get(claim.id);
    if (sourceClaim) waiverValidityByClaimId[claim.id] = deriveWaiverValidity({
      claim: sourceClaim,
      status: claim.status,
      evidence: context.evidenceByClaim.get(claim.id) ?? []
    });
  }
  reconciled.waiverValidityByClaimId = waiverValidityByClaimId;
  // Surface's conflict projection depends on status. Replace only its conflict
  // gaps with a public re-derivation against the exact-corrected claims, so a
  // stale/unknown correction cannot leave a contradiction from the old status.
  const policyByClaimId = new Map<string, any>();
  for (const claim of reconciled.claims) {
    const policy = resolvePolicyForClaim(context.claims.get(claim.id), context.policies);
    if (policy) policyByClaimId.set(claim.id, policy);
  }
  const identityIndex = buildIdentityIndex({ ...bundle, claims: [...context.claims.values()] });
  const conflictGaps = deriveConflictTransparencyGaps({
    claims: reconciled.claims,
    policyByClaimId,
    canonicalKeyForClaim: (claim: any) => identityIndex.canonicalKeyForClaim(claim),
    now: evaluation.surfaceNow
  }).map((gap: any) => ({ ...gap, createdAt: exactNow }));
  reconciled.transparencyGaps = mergeCanonicalRecords(
    reconciled.transparencyGaps.filter((gap: any) => !(
      gap.type === "contradiction"
      && ["policy.incompatibleValues", "policy.incompatibleStatuses"].includes(gap.metadata?.source)
    )),
    conflictGaps
  );
  // The reconciled report is stored on canonical evidence and can be rendered
  // outside a gate. Recompute Surface's public projections rather than leaving
  // a stale summary or group rollup beside corrected claim statuses.
  reconciled.summary = summarizeClaims(reconciled.claims, reconciled.transparencyGaps, reconciled.changeRecords);
  reconciled.claimGroupRollups = deriveClaimGroupRollups({ claimGroups: reconciled.claimGroups ?? [], claims: reconciled.claims });
  return { report: reconciled, diagnostics, reconciliations, context };
}

function claimIsCurrentForVisit(bundle: any, claim: any, enteredAt: ParsedRfc3339Timestamp): boolean {
  const bundleClaim = bundle?.claims?.find((candidate: any) => candidate?.id === claim.id);
  if (!bundleClaim) return false;

  const createdAt = parseRfc3339Timestamp(bundleClaim.createdAt);
  if (createdAt === null) return false;

  const observations = (bundle.evidence ?? [])
    .filter((evidence: any) => evidence?.claimId === bundleClaim.id)
    .map((evidence: any) => parseRfc3339Timestamp(evidence.observedAt));
  if (observations.some((observedAt) => observedAt === null)) return false;

  return compareRfc3339Timestamps(createdAt, enteredAt) >= 0
    || observations.some((observedAt) => compareRfc3339Timestamps(observedAt!, enteredAt) >= 0);
}

function routeBackAffectsStep(definition: any, transition: any, step: string): boolean {
  return ["route_back", "retry_authorized"].includes(transition?.type) && (
    transition.from_step === step
    || transition.to_step === step
    || (Array.isArray(transition.invalidated_steps) && transition.invalidated_steps.includes(step))
    || descendantsOf(definition, transition.to_step).includes(step)
  );
}

interface GateVisit {
  revisited: boolean;
  awaitingReentry: boolean;
  enteredAt: ParsedRfc3339Timestamp | null;
}

function currentGateVisit(definition: any, state: any, step: string): GateVisit {
  let awaitingReentry = false;
  let reentryAt: ParsedRfc3339Timestamp | null | undefined;
  for (const transition of state.transitions ?? []) {
    if (routeBackAffectsStep(definition, transition, step)) {
      awaitingReentry = transition.to_step !== step;
      reentryAt = transition.to_step === step ? parseRfc3339Timestamp(transition.at) : undefined;
    } else if (awaitingReentry && transition?.to_step === step) {
      awaitingReentry = false;
      reentryAt = parseRfc3339Timestamp(transition.at);
    }
  }
  return {
    revisited: reentryAt !== undefined || awaitingReentry,
    awaitingReentry,
    enteredAt: reentryAt ?? null
  };
}

function evidenceVisitDiagnostic(entry: any, visit: GateVisit): string | null {
  if (!visit.revisited) return null;
  if (visit.awaitingReentry) return "gate_reentry_pending";
  if (visit.enteredAt === null) return "gate_reentry_timestamp_invalid";

  const attachedAt = parseRfc3339Timestamp(entry.attached_at);
  if (attachedAt === null) return "attachment_timestamp_invalid";
  if (compareRfc3339Timestamps(attachedAt, visit.enteredAt) < 0) return "attachment_not_current";
  return null;
}

type DerivedBundle = { bundle?: any; report: any | null; diagnostics: Map<string, string>; reconciliations: Map<string, Reconciliation>; context?: BundleContext; error: string | null };

/**
 * A bundle can have several claims which satisfy the public selector, but a
 * gate advances on one concrete authorization path. Keep the candidates in
 * report order so the subsequent producer/authority decision can return the
 * exact claim it authorized, rather than re-selecting a broader set later.
 */
type EvidenceBundleDecision =
  | { matched: true; acceptedClaims: readonly any[] }
  | { matched: false; diagnostic: string };

type AuthorityWitness = Exclude<GateEvaluationEvidenceSelection["authorityWitness"], null | undefined>;

type EvidenceProducerDecision =
  | { matched: true; witnessClaimIds: readonly [string]; authorityWitness: AuthorityWitness | null }
  | { matched: false; diagnostic: NonNullable<ProducerAuthorityResult> };

type EvidenceMatchDecision =
  | { matched: true; evidenceId: string; witnessClaimIds: readonly [string]; authorityWitness: AuthorityWitness | null }
  | { matched: false; bundleDiagnostic?: string; producerDiagnostic?: NonNullable<ProducerAuthorityResult> };

function deriveBundleReport(bundle: unknown, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies): DerivedBundle {
  if (!evaluationNow) {
    return { report: null, diagnostics: new Map(), reconciliations: new Map(), error: "evaluation_time_missing" };
  }
  let snapshot: any;
  try {
    snapshot = structuredClone(bundle);
  } catch {
    return { report: null, diagnostics: new Map(), reconciliations: new Map(), error: "bundle_snapshot_failed" };
  }
  if (!surfaceDerivationWithinBudget(snapshot)) {
    return { report: null, diagnostics: new Map(), reconciliations: new Map(), error: "bundle_derivation_budget_exceeded" };
  }
  // First validate via Surface (referential/structural)
  let validated: any;
  try {
    validated = dependencies.validate(surfaceTimestampValidationView(snapshot));
  } catch (err: any) {
    return { report: null, diagnostics: new Map(), reconciliations: new Map(), error: `bundle_invalid: ${err?.message ?? String(err)}` };
  }
  if (!surfaceDerivationWithinBudget(validated)) {
    return { report: null, diagnostics: new Map(), reconciliations: new Map(), error: "bundle_derivation_budget_exceeded" };
  }
  // Then derive statuses via Surface
  try {
    const report = dependencies.buildReport(validated, { now: evaluationNow.surfaceNow });
    const reconciled = reconcileSurfaceBundleReport(validated, report, canonicalAuthorityTimestamp(evaluationNow.exact));
    return { bundle: snapshot, report: reconciled.report, diagnostics: reconciled.diagnostics, reconciliations: reconciled.reconciliations ?? new Map(), context: reconciled.context, error: null };
  } catch (err: any) {
    return { report: null, diagnostics: new Map(), reconciliations: new Map(), error: `bundle_derivation_failed: ${err?.message ?? String(err)}` };
  }
}

function evidenceBundleDiagnostic(entry: any, expectation: any, enteredAt: ParsedRfc3339Timestamp | null = null, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies, derivedBundle?: DerivedBundle): EvidenceBundleDecision {
  if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") return { matched: false, diagnostic: "bundle_invalid" };
  if (entry.status === "failed") return { matched: false, diagnostic: "rejected" };

  const derived = derivedBundle ?? deriveBundleReport(entry.bundle, evaluationNow, dependencies);
  const bundle = derived.bundle;
  if (!bundle) return { matched: false, diagnostic: "bundle_invalid" };
  if (!surfaceDerivationWithinBudget(bundle)) return { matched: false, diagnostic: "bundle_invalid" };

  // Schema validation
  const schemaResult = validateTrustBundleSchema(bundle);
  if (!schemaResult.valid) return { matched: false, diagnostic: "bundle_invalid" };

  try {
    // Producer and authority policy only consumes the same rich bundle shape
    // that Surface validates, never a caller-authored manifest projection.
    dependencies.validate(surfaceTimestampValidationView(bundle));
  } catch {
    return { matched: false, diagnostic: "bundle_invalid" };
  }

  // Derive report
  // A stored report is useful historical display data, but an authoritative
  // evaluation must re-derive it from the validated bundle at its one pinned
  // instant. Otherwise an expired/revoked authority could inherit a stale
  // report produced while it was active.
  const report = derived.report;
  if (!report) return { matched: false, diagnostic: "bundle_invalid" };

  const selector = expectation.bundle_claim ?? expectation.claim;
  if (!selector) return { matched: false, diagnostic: "bundle_invalid" };

  const claims = findClaimsInReport(report, selector);
  if (!claims.length) return { matched: false, diagnostic: "claim_not_found" };

  const currentClaims = enteredAt === null
    ? claims
    : claims.filter((claim: any) => claimIsCurrentForVisit(bundle, claim, enteredAt));
  if (!currentClaims.length) {
    return { matched: false, diagnostic: "claim_not_current" };
  }

  const accepted = selector.accepted_statuses ?? ["verified"];
  // A stale-accepting selector intentionally admits the claim with its stale
  // chronology. It never admits ambiguous/future/malformed chronology: those
  // Surface diagnostics remain a failed candidate and preserve their existing
  // diagnostic precedence below.
  const acceptedClaims = currentClaims.filter((claim: any) => (
    accepted.includes(claim.status ?? "unknown")
    && (derived.diagnostics.get(claim.id) === undefined || derived.diagnostics.get(claim.id) === "stale")
  ));
  if (acceptedClaims.length) {
    return { matched: true, acceptedClaims };
  }

  const reconciliationDiagnostic = currentClaims.map((claim: any) => derived.diagnostics.get(claim.id)).find(Boolean);
  if (reconciliationDiagnostic) return { matched: false, diagnostic: reconciliationDiagnostic };
  const claimStatus = currentClaims[0].status ?? "unknown";
  if (!accepted.includes(claimStatus)) {
    if (claimStatus === "stale") return { matched: false, diagnostic: "stale" };
    if (claimStatus === "disputed") return { matched: false, diagnostic: "disputed" };
    return { matched: false, diagnostic: "rejected" };
  }

  return { matched: false, diagnostic: "rejected" };
}

/**
 * Evidence integrity is re-verified by the run store before gate evaluation:
 * each attached artifact carrying a recorded `sha256` is re-hashed on disk and
 * the result is carried as a transient `integrity` field on the manifest entry
 * (never persisted — see manifestWithIntegrity in the run store). A digest
 * mismatch or an unreadable/missing copied file fails closed with the documented
 * `integrity_mismatch` reason. Flow's gate evaluator stays pure and synchronous;
 * it consumes the pre-computed status rather than performing file I/O itself.
 */
const INTEGRITY_FAILURE_STATES = new Set(["mismatch", "missing", "unreadable"]);

function evidenceIntegrityDiagnostic(entry: any): string | null {
  return INTEGRITY_FAILURE_STATES.has(entry?.integrity) ? "integrity_mismatch" : null;
}

/**
 * Resolve the producer and authority pins which apply to one expectation.
 *
 * Claim-type pins are the project-wide baseline. An expectation may add a
 * narrower, gate-specific pin through the project config override that
 * `expectationsForGate` already applies. Every configured scope must allow an
 * attachment; a gate-specific override can therefore never broaden the
 * project-wide authority boundary.
 *
 * Empty mappings are intentionally not pins: config authors can reserve a
 * claim type without making every existing attachment unattributed.
 */
function trustedProducerPolicy(expectation: any, config: MutableRecord) {
  const selector = expectation.bundle_claim ?? expectation.claim;
  const claimType = selector?.claimType;
  const claimMapping = typeof claimType === "string"
    ? config.trusted_producers?.[claimType]
    : undefined;
  const strings = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const policy = (producers: unknown, authorityRefs: unknown) => {
    const allowedProducers = new Set(strings(producers));
    const allowedAuthorityRefs = new Set(strings(authorityRefs));
    return {
      // `{}` is deliberately an unpinned reservation, while an explicitly
      // authored empty list is a deny-all authority boundary.
      configured: producers !== undefined || authorityRefs !== undefined,
      // An explicitly empty route is an authored refusal, not an omitted
      // route. In particular, `{ producers: ["ci/main"], authority_refs: [] }`
      // must not silently regain access through the populated producer route.
      denyAll: (Array.isArray(producers) && producers.length === 0)
        || (Array.isArray(authorityRefs) && authorityRefs.length === 0),
      producers: allowedProducers,
      authorityRefs: allowedAuthorityRefs
    };
  };
  return [
    policy(claimMapping?.producers, claimMapping?.authority_refs),
    policy(expectation.trusted_producers, expectation.authority_refs)
  ].filter((entry) => entry.configured);
}

type ProducerAuthorityResult = { reason: "untrusted_producer"; authority?: { code: string } } | null;

function canonicalAuthorityTimestamp(timestamp: ParsedRfc3339Timestamp): string {
  const wholeSecond = new Date(timestamp.epochSecond * 1000).toISOString().replace(/\.000Z$/, "");
  return `${wholeSecond}${timestamp.fractionalSecond ? `.${timestamp.fractionalSecond}` : ""}Z`;
}

function governingAuthorizationEvent(claim: any, derived: DerivedBundle): TimedEvent | undefined {
  return derived.reconciliations.get(claim.id)?.governing;
}

function authorityTraceDiagnostic(policies: ReturnType<typeof trustedProducerPolicy>, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies, derived: DerivedBundle, candidates: readonly any[]): EvidenceProducerDecision {
  const bundle = derived.bundle;
  // The Surface validator returns a validated clone. Carry its stable trace
  // index/context through the authority path instead of comparing object
  // identity to the caller's raw trace object.
  const traces = derived.context?.traces ?? [];
  if (!traces.length) return { matched: false, diagnostic: { reason: "untrusted_producer", authority: { code: "no_trace" } } };
  const refScoped = traces.filter((timedTrace) => policies.every((policy) => policy.authorityRefs.has(timedTrace.trace?.authorityRef)));
  if (!refScoped.length) return { matched: false, diagnostic: { reason: "untrusted_producer", authority: { code: "authority_ref_mismatch" } } };
  const failures = new Set<string>();
  if (!evaluationNow) {
    return { matched: false, diagnostic: { reason: "untrusted_producer", authority: { code: "evaluation_time_missing" } } };
  }
  const evaluatedAt = evaluationNow.exact;

  for (const timedTrace of refScoped) {
    const trace = timedTrace.trace;
    for (const claim of candidates) {
      if (trace?.subject?.subjectType !== claim.subjectType || trace?.subject?.subjectId !== claim.subjectId) continue;
      const governing = governingAuthorizationEvent(claim, derived);
      if (!governing) {
        failures.add("scope_mismatch");
        continue;
      }
      const linkedEvidence = derived.context?.evidenceByClaim.get(claim.id) ?? (bundle.evidence ?? []).filter((evidence: any) => evidence?.claimId === claim.id);
      const linkedEvidenceIds = new Set(linkedEvidence.map((evidence: any) => evidence.id));
      const governingEvidenceIds = new Set(Array.isArray(governing.event.evidenceIds) ? governing.event.evidenceIds : []);
      const claimLinked = Array.isArray(trace.claimIds) && trace.claimIds.includes(claim.id);
      const evidenceLinked = Array.isArray(trace.evidenceIds) && trace.evidenceIds.some((id: string) => linkedEvidenceIds.has(id) && governingEvidenceIds.has(id));
      if (!claimLinked && !evidenceLinked) {
        failures.add("scope_mismatch");
        continue;
      }
      const actorMatchesGoverningEvent = governing.event.actor === trace.actorRef;
      const actorMatchesGoverningCollector = linkedEvidence.some((evidence: any) => governingEvidenceIds.has(evidence.id) && evidence.collectedBy === trace.actorRef);
      // Project config deliberately binds ordinary producer authority at Flow's
      // explicit evaluation instant. Resolution authority is different: Surface
      // makes it a decision-time predicate and reconciliation checks that exact
      // decision instant above. Do not retroactively require ordinary evidence
      // to have been produced while a currently active trace was valid.
      if ((!actorMatchesGoverningEvent && !actorMatchesGoverningCollector) || (governing.event.authorityRef !== undefined && governing.event.authorityRef !== trace.authorityRef)) {
        failures.add("actor_mismatch");
        continue;
      }

      const normalizedTrace = structuredClone(trace);
      let invalidTimestamp = false;
      const observedAt = timedTrace.observedAt;
      if (observedAt === undefined || timedTrace.invalidTimestamp || compareRfc3339Timestamps(observedAt, evaluatedAt) > 0) {
        failures.add(observedAt === undefined || timedTrace.invalidTimestamp ? "invalid_trace_timestamp" : "not_yet_valid");
        continue;
      }
      for (const field of ["validFrom", "validUntil", "revokedAt"] as const) {
        if (trace[field] === undefined) continue;
        const parsed = parseRfc3339Timestamp(trace[field]);
        if (parsed === null) {
          invalidTimestamp = true;
          break;
        }
        normalizedTrace[field] = canonicalAuthorityTimestamp(parsed);
      }
      if (invalidTimestamp) {
        failures.add("invalid_trace_timestamp");
        continue;
      }
      const validFrom = trace.validFrom === undefined ? null : parseRfc3339Timestamp(trace.validFrom);
      if (validFrom && compareRfc3339Timestamps(validFrom, evaluatedAt) > 0) {
        failures.add("not_yet_valid");
        continue;
      }
      const validUntil = trace.validUntil === undefined ? null : parseRfc3339Timestamp(trace.validUntil);
      if (validUntil && compareRfc3339Timestamps(validUntil, evaluatedAt) < 0) {
        failures.add("expired");
        continue;
      }
      const revokedAt = trace.revokedAt === undefined ? null : parseRfc3339Timestamp(trace.revokedAt);
      if (revokedAt && compareRfc3339Timestamps(revokedAt, evaluatedAt) <= 0) {
        failures.add("revoked");
        continue;
      }
      if (governing.event.resolvesDispute === true && !exactResolutionAuthorizedForClaim(governing, timedTrace, claim, linkedEvidence, evaluatedAt)) {
        failures.add("scope_mismatch");
        continue;
      }
      // Flow owns the exact RFC3339 chronology above, including fractional
      // seconds beyond JavaScript Date precision. Surface still corroborates
      // the trace per authority candidate, but receives no validity fields it
      // could compare lexically and thereby override Flow's precise decision.
      delete normalizedTrace.validFrom;
      delete normalizedTrace.validUntil;
      delete normalizedTrace.revokedAt;
      const active = dependencies.checkAuthorityActive(trace.actorRef, [normalizedTrace], evaluationNow.surfaceNow);
      if (active === "active") {
        // These three ids are read exactly at the successful authorization
        // branch. They are the immutable proof of the authority path, never a
        // later re-selection from the bundle.
        if (typeof claim.id === "string" && typeof trace?.id === "string" && typeof governing.event?.id === "string") {
          return { matched: true, witnessClaimIds: [claim.id], authorityWitness: { claimId: claim.id, traceId: trace.id, governingEventId: governing.event.id } };
        }
        failures.add("scope_mismatch");
        continue;
      }
      failures.add(active === "expired" ? "expired" : active === "revoked" ? "revoked" : "no_trace");
    }
  }
  const failure = ["invalid_trace_timestamp", "revoked", "expired", "not_yet_valid", "actor_mismatch", "scope_mismatch", "subject_mismatch", "no_trace"]
    .find((code) => failures.has(code)) ?? "subject_mismatch";
  return { matched: false, diagnostic: { reason: "untrusted_producer", authority: { code: failure } } };
}

/**
 * Pins are evaluated only after the bundle has otherwise satisfied the
 * expectation. That keeps a malformed or non-matching bundle diagnostic
 * honest while ensuring an unattributed or untrusted otherwise-valid claim
 * can never advance a gate.
 */
function evidenceProducerDiagnostic(entry: any, expectation: any, config: MutableRecord, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies, derived: DerivedBundle, candidates: readonly any[]): EvidenceProducerDecision {
  const policies = trustedProducerPolicy(expectation, config);
  if (!policies.length) return { matched: true, witnessClaimIds: [candidates[0].id], authorityWitness: null };
  if (policies.some((policy) => policy.denyAll)) return { matched: false, diagnostic: { reason: "untrusted_producer", authority: { code: "deny_all" } } };
  const producerId = derived.bundle?.producerId;
  if (entry.producer !== undefined && entry.producer !== producerId) return { matched: false, diagnostic: { reason: "untrusted_producer", authority: { code: "producer_mismatch" } } };
  if (typeof producerId === "string" && policies.every((policy) => policy.producers.has(producerId))) return { matched: true, witnessClaimIds: [candidates[0].id], authorityWitness: null };
  return authorityTraceDiagnostic(policies, evaluationNow, dependencies, derived, candidates);
}

function evidenceMatchDecision(entry: any, expectation: any, config: MutableRecord, enteredAt: ParsedRfc3339Timestamp | null, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies, derivedBundle?: DerivedBundle): EvidenceMatchDecision {
  const integrityDiagnostic = evidenceIntegrityDiagnostic(entry);
  if (integrityDiagnostic !== null) return { matched: false, bundleDiagnostic: integrityDiagnostic };
  if (expectation.kind !== "trust.bundle") return { matched: false };
  if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") return { matched: false };
  const derived = derivedBundle ?? deriveBundleReport(entry.bundle, evaluationNow, dependencies);
  const bundle = evidenceBundleDiagnostic(entry, expectation, enteredAt, evaluationNow, dependencies, derived);
  if (bundle.matched === false) return { matched: false, bundleDiagnostic: bundle.diagnostic };
  const producer = evidenceProducerDiagnostic(entry, expectation, config, evaluationNow, dependencies, derived, bundle.acceptedClaims);
  if (producer.matched === false) return { matched: false, producerDiagnostic: producer.diagnostic };
  return { matched: true, evidenceId: entry.id, witnessClaimIds: producer.witnessClaimIds, authorityWitness: producer.authorityWitness };
}

export function evidenceMatchesExpectation(entry: any, expectation: any, config: MutableRecord = defaultFlowConfig(), enteredAt: ParsedRfc3339Timestamp | null = null, evaluationNow?: GateEvaluationInput) {
  return evidenceMatchDecision(entry, expectation, config, enteredAt, parseGateEvaluationTime(evaluationNow), DEFAULT_GATE_AUTHORITY_DEPENDENCIES).matched;
}

function claimDiagnosticsForExpectation(evidence: any[], expectation: any, config: MutableRecord = defaultFlowConfig(), visit: GateVisit, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies, derivedFor?: (entry: any) => DerivedBundle) {
  const diagnostics: MutableRecord[] = [];
  for (const entry of evidence) {
    // A tampered or missing copied artifact fails closed before any expensive
    // bundle/authority derivation, emitting the documented reason code.
    const integrityReason = evidenceIntegrityDiagnostic(entry);
    if (integrityReason) {
      diagnostics.push({ expectation_id: expectation.id, evidence_id: entry.id, reason: integrityReason });
      continue;
    }
    const trustEntry = entry?.kind === "trust.bundle" || entry?.requested_kind === "trust.bundle";
    const derived = trustEntry ? (derivedFor?.(entry) ?? deriveBundleReport(entry.bundle, evaluationNow, dependencies)) : undefined;
    const decision = evidenceMatchDecision(entry, expectation, config, visit.enteredAt, evaluationNow, dependencies, derived);
    let bundleDiagnostic: string | undefined;
    let producerDiagnostic: NonNullable<ProducerAuthorityResult> | undefined;
    if (decision.matched === false) {
      bundleDiagnostic = decision.bundleDiagnostic;
      producerDiagnostic = decision.producerDiagnostic;
    }
    const reason = evidenceVisitDiagnostic(entry, visit)
      ?? bundleDiagnostic
      ?? producerDiagnostic?.reason;
    if (!reason) continue;
    diagnostics.push({
      expectation_id: expectation.id,
      evidence_id: entry.id,
      reason,
      ...(producerDiagnostic?.authority ? { authority: producerDiagnostic.authority } : {})
    });
  }
  return diagnostics;
}

/**
 * Internal reducer seam. This module is not exported from the package root;
 * only the reducer may supply its already-validated, snapshotted adapter.
 */
export function evaluateGateWithReducerDependencies(definition: any, state: any, manifest: any, gateId: string, config: MutableRecord = defaultFlowConfig(), evaluationNow: GateEvaluationInput | undefined, dependencies: GateAuthorityDependencies): GateOutcome {
  // Gate outcomes may authorize a state transition. Freeze the complete
  // caller-controlled input boundary before config validation, entry-kind
  // routing, policy lookup, or report derivation so access-varying getters
  // cannot present different facts to different expectations.
  try {
    const snapshot = structuredClone({ definition, state, manifest, config });
    definition = snapshot.definition;
    state = snapshot.state;
    manifest = snapshot.manifest;
    config = snapshot.config;
  } catch (error) {
    throw new Error("flow gate inputs cannot be snapshotted");
  }
  validateFlatFlowConfig(config);
  const effectiveEvaluationNow = evaluationNow === undefined
    ? parseGateEvaluationTime(state?.updated_at)
    : parseGateEvaluationTime(evaluationNow);
  const gate = findGate(definition, gateId);
  if (!gate) throw new Error(`unknown gate: ${gateId}`);

  // Superseded entries stay in the manifest for audit but no longer drive
  // gate outcomes: replacing failing evidence is how a route-back recovers.
  const visit = currentGateVisit(definition, state, gate.step);
  const attachedEvidence = attachedEvidenceFor(manifest, gateId).filter((entry) => !entry.superseded_by);
  // A failed attachment can never advance a pending revisit, but it must keep
  // its established route reason and attempt accounting until re-entry occurs.
  const evidence = attachedEvidence.filter((entry) => (
    evidenceVisitDiagnostic(entry, visit) === null
    || (entry.status === "failed" && visit.awaitingReentry)
  ));
  const failed = evidence.filter((entry) => entry.status === "failed");
  // An exception waives the evidence REQUIREMENT (missing evidence) but may
  // not override an explicit FAILURE. Failed evidence is a stronger signal
  // than "no evidence provided" — the work was attempted and rejected (#198).
  if (failed.length) {
    const routeReason = routeReasonForFailedEvidence(failed[0]);
    const route = routeBackDecision(state, gate, routeReason, failed);
    return {
      gate_id: gateId,
      status: route.status,
      summary: `${slugLabel(gate.id)} has failing evidence`,
      ...route
    };
  }

  const exception = acceptedExceptionFor(state, gateId);
  if (exception) {
    return {
      gate_id: gateId,
      status: "pass",
      summary: "accepted exception",
      evidence_refs: exception.evidence_refs ?? [],
      accepted_exception_id: exception.id
    };
  }

  // A gate may have multiple required selectors. Snapshot/derive each attached
  // evidence entry exactly once before any selector can match it, preventing an
  // access-varying bundle getter from satisfying different expectations with
  // different payloads under one evidence id.
  const derivedByEntry = new Map<any, DerivedBundle>();
  const derivedFor = (entry: any) => {
    if (!derivedByEntry.has(entry)) {
      derivedByEntry.set(entry, deriveBundleReport(entry.bundle, effectiveEvaluationNow, dependencies));
    }
    return derivedByEntry.get(entry)!;
  };
  for (const entry of attachedEvidence) {
    if (entry?.kind === "trust.bundle" || entry?.requested_kind === "trust.bundle") derivedFor(entry);
  }

  const expectations = expectationsForGate(gate, config);
  const matched: Array<{ expectation_id: string; evidence_id: string; claim_ids?: string[]; authority_witness?: AuthorityWitness | null }> = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const claimDiagnostics: MutableRecord[] = [];
  for (const expectation of expectations) {
    const expectationWithGate = { ...expectation, gate_id: gateId };
    let match: EvidenceMatchDecision | undefined;
    if (!(visit.revisited && (visit.awaitingReentry || visit.enteredAt === null))) {
      for (const entry of evidence) {
        if (expectationWithGate.kind !== "trust.bundle") continue;
        if (entry?.kind !== "trust.bundle" && entry?.requested_kind !== "trust.bundle") continue;
        const decision = evidenceMatchDecision(entry, expectationWithGate, config, visit.enteredAt, effectiveEvaluationNow, dependencies, derivedFor(entry));
        if (decision.matched) {
          match = decision;
          break;
        }
      }
    }
    if (match?.matched) {
      matched.push({ expectation_id: expectation.id, evidence_id: match.evidenceId, claim_ids: [...match.witnessClaimIds], authority_witness: match.authorityWitness });
    } else if (expectation.required) {
      missingRequired.push(expectation.id);
      claimDiagnostics.push(...claimDiagnosticsForExpectation(attachedEvidence, expectationWithGate, config, visit, effectiveEvaluationNow, dependencies, derivedFor));
    } else {
      missingOptional.push(expectation.id);
      claimDiagnostics.push(...claimDiagnosticsForExpectation(attachedEvidence, expectationWithGate, config, visit, effectiveEvaluationNow, dependencies, derivedFor));
    }
  }
  const diagnosticPayload = claimDiagnostics.length ? { claim_evaluation: claimDiagnostics } : undefined;
  const outcomeEvidenceRefs = evidence.length
    ? evidence.map((entry) => entry.id)
    : [...new Set(claimDiagnostics.map((diagnostic) => diagnostic.evidence_id).filter(Boolean))];

  if (missingRequired.length) {
    const first = expectations.find((expectation) => expectation.id === missingRequired[0]);
    if (gate.on_route_back?.missing_evidence) {
      const route = routeBackDecision(state, gate, "missing_evidence", evidence, { expectationIds: missingRequired });
      return {
        gate_id: gateId,
        status: route.status,
        summary: `${expectationLabel(first)} missing`,
        missing: missingRequired,
        optional_missing: missingOptional,
        matched_expectations: matched,
        ...route,
        evidence_refs: outcomeEvidenceRefs,
        ...(diagnosticPayload ? { diagnostics: { ...(route.diagnostics ?? {}), ...diagnosticPayload } } : {})
      };
    }
    return {
      gate_id: gateId,
      status: "block",
      summary: `${expectationLabel(first)} missing`,
      missing: missingRequired,
      optional_missing: missingOptional,
      matched_expectations: matched,
      ...(diagnosticPayload ? { diagnostics: diagnosticPayload } : {}),
      evidence_refs: outcomeEvidenceRefs
    };
  }

  if (!expectations.length) {
    return {
      gate_id: gateId,
      status: "wait",
      summary: `${slugLabel(gate.id)} waiting for evidence`,
      evidence_refs: evidence.map((entry) => entry.id),
      optional_missing: missingOptional,
      matched_expectations: matched
    };
  }

  return {
    gate_id: gateId,
    status: "pass",
    summary: `${expectationLabel(expectations[0])} satisfied`,
    evidence_refs: evidence.map((entry) => entry.id),
    optional_missing: missingOptional,
    matched_expectations: matched,
    ...(diagnosticPayload ? { diagnostics: diagnosticPayload } : {})
  };
}

/** Public gate evaluation intentionally has no trust-helper injection seam. */
export function evaluateGate(definition: any, state: any, manifest: any, gateId: string, config: MutableRecord = defaultFlowConfig(), evaluationNow?: GateEvaluationInput): GateOutcome {
  return evaluateGateWithReducerDependencies(
    definition,
    state,
    manifest,
    gateId,
    config,
    evaluationNow,
    DEFAULT_GATE_AUTHORITY_DEPENDENCIES
  );
}

export function mergeGateOutcome(state, outcome) {
  if (!Array.isArray(state.gate_outcome_history)) {
    state.gate_outcome_history = structuredClone(state.gate_outcomes ?? []);
  }
  state.gate_outcome_history.push(structuredClone(outcome));
  const without = state.gate_outcomes.filter((entry) => entry.gate_id !== outcome.gate_id);
  state.gate_outcomes = [...without, outcome];
}

/**
 * flow#202 AC3 — no persisted transition may name a `from_step` the run was not
 * on. Every transition `applyEvaluation` appends carries `from_step:
 * gate.step`, so this is checkable exactly at the write point.
 *
 * The rule is exactly AC3's wording: `gate.step` must be a step this run has
 * actually occupied — where it started, anywhere the cursor was moved to, or
 * where it is now. A stale-ancestor re-check and a fail-closed downstream
 * re-appraisal both satisfy it; a forward jump to a step the run never reached
 * does not, and fails closed here even if some caller reintroduces a
 * synthesised cursor upstream.
 */
function assertTransitionProvenance(definition, state, gate) {
  if (occupiedSteps(definition, state).has(gate.step)) return;
  const error = new Error(
    `flow.transition.from_step.fabricated: refusing to record a transition from "${gate.step}" for gate "${gate.id}" while the run is on "${state.current_step}"`
  );
  (error as Error & { code?: string }).code = "flow.transition.from_step.fabricated";
  throw error;
}

export function applyEvaluation(definition, state, outcome, at = new Date().toISOString()) {
  const gate = findGate(definition, outcome.gate_id);
  assertTransitionProvenance(definition, state, gate);
  mergeGateOutcome(state, outcome);

  if (outcome.status === "pass") {
    const step = getStep(definition, gate.step);
    const nextStep = step?.next ?? null;
    state.transitions.push({
      from_step: gate.step,
      to_step: nextStep,
      status: "allowed",
      reason: outcome.accepted_exception_id ? "accepted exception" : "required evidence present",
      at,
      gate_id: outcome.gate_id
    });
    state.current_step = nextStep ?? gate.step;
    state.status = nextStep ? "active" : "completed";
  } else if (outcome.status === "block") {
    state.status = "blocked";
    if (outcome.limit_exceeded) {
      state.transitions.push({
        type: "route_back",
        from_step: gate.step,
        to_step: outcome.route_back_to,
        status: "blocked",
        reason: outcome.reason ?? outcome.route_reason ?? outcome.summary,
        route_reason: outcome.route_reason,
        selected_route: outcome.selected_route,
        recovery_step: outcome.recovery_step,
        attempt: outcome.attempt,
        retry_epoch: outcome.retry_epoch,
        max_attempts: outcome.max_attempts,
        limit_exceeded: outcome.limit_exceeded,
        invalidated_steps: outcome.invalidated_steps,
        evidence_refs: outcome.evidence_refs,
        failed_evidence_refs: outcome.failed_evidence_refs,
        expectation_ids: outcome.expectation_ids,
        classifier: outcome.classifier,
        diagnostics: outcome.diagnostics,
        analytics: outcome.analytics,
        analytics_loop_key: outcome.analytics_loop_key,
        freshness_transitions: outcome.freshness_transitions,
        at,
        gate_id: outcome.gate_id
      });
    } else {
      state.transitions.push({
        from_step: gate.step,
        to_step: getStep(definition, gate.step)?.next ?? null,
        status: "blocked",
        reason: outcome.summary,
        invalidated_steps: outcome.invalidated_steps,
        evidence_refs: outcome.evidence_refs,
        expectation_ids: outcome.expectation_ids,
        freshness_transitions: outcome.freshness_transitions,
        at,
        gate_id: outcome.gate_id
      });
    }
  } else if (outcome.status === "route-back") {
    state.status = "active";
    // Cascade: clear gate outcomes for every step downstream of the target so
    // dependent stages re-run instead of keeping stale "passed" outcomes.
    const invalidated = invalidateDescendants(definition, state, outcome.route_back_to);
    state.current_step = outcome.route_back_to;
    state.transitions.push({
      type: "route_back",
      from_step: gate.step,
      to_step: outcome.route_back_to,
      status: "blocked",
      reason: outcome.reason ?? outcome.route_reason ?? outcome.summary,
      route_reason: outcome.route_reason,
      selected_route: outcome.selected_route,
      recovery_step: outcome.recovery_step,
      attempt: outcome.attempt,
      retry_epoch: outcome.retry_epoch,
      max_attempts: outcome.max_attempts,
      limit_exceeded: outcome.limit_exceeded,
      invalidated_steps: invalidated.length ? invalidated : undefined,
      evidence_refs: outcome.evidence_refs,
      failed_evidence_refs: outcome.failed_evidence_refs,
      expectation_ids: outcome.expectation_ids,
      classifier: outcome.classifier,
      diagnostics: outcome.diagnostics,
      analytics: outcome.analytics,
      analytics_loop_key: outcome.analytics_loop_key,
      freshness_transitions: outcome.freshness_transitions,
      at,
      gate_id: outcome.gate_id
    });
  } else {
    state.status = "active";
  }

  state.next_action = state.status === "completed"
    ? "run complete; no further action required"
    : nextActionForStep(definition, state.current_step, outcome);
  state.updated_at = at;
}
