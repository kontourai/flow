import type { GateOutcome, MutableRecord } from "../contracts/flow-types.js";
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
import { buildTrustReport, checkAuthorityActive, validateTrustBundle } from "@kontourai/surface";
import { validateTrustBundleSchema } from "./trust-bundle-validator.js";

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

function exactClaimTimelineDiagnostic(bundle: any, reportClaim: any, acceptedStatuses: string[], evaluatedAt: ParsedRfc3339Timestamp): string | null {
  const claim = bundle?.claims?.find((candidate: any) => candidate?.id === reportClaim.id);
  if (!claim) return "bundle_invalid";

  const issuedAt = parseRfc3339Timestamp(claim.createdAt);
  const updatedAt = parseRfc3339Timestamp(claim.updatedAt);
  if (issuedAt === null || updatedAt === null) return "bundle_invalid";

  const expiresAt = claim.expiresAt === undefined ? undefined : parseRfc3339Timestamp(claim.expiresAt);
  if (expiresAt === null) return "bundle_invalid";

  const events = (bundle?.events ?? [])
    .filter((event: any) => event?.claimId === claim.id)
    .map((event: any, index: number) => {
      const createdAt = parseRfc3339Timestamp(event.createdAt);
      const verifiedAt = event.verifiedAt === undefined ? undefined : parseRfc3339Timestamp(event.verifiedAt);
      return { event, index, createdAt, verifiedAt };
  });
  if (events.some(({ createdAt, verifiedAt }: any) => createdAt === null || verifiedAt === null)) return "bundle_invalid";

  // Surface selects its latest event with Date.parse, but its resolution and
  // invalidation rules are intentionally more complete than Flow's gate
  // projection. Refuse only the lossy ordering case rather than reproducing
  // that policy here: a pair of distinct precise instants that Date collapses
  // into one millisecond leaves Surface's result dependent on bundle order.
  for (let left = 0; left < events.length; left += 1) {
    for (let right = left + 1; right < events.length; right += 1) {
      const exactOrder = compareRfc3339Timestamps(events[left].createdAt, events[right].createdAt);
      if (exactOrder !== 0 && surfaceDateMilliseconds(events[left].createdAt) === surfaceDateMilliseconds(events[right].createdAt)) {
        return "claim_time_ambiguous";
      }
    }
  }

  // The ambiguity fence means an exact sort now agrees with Surface's Date
  // sort. Intrinsic expiry is only part of Surface's ordinary latest-verified
  // branch: assumed claims and authority-gated dispute resolutions bypass it.
  // Preserve those richer Surface outcomes rather than duplicating its policy.
  const latest = [...events].sort((left: any, right: any) => (
    compareRfc3339Timestamps(right.createdAt, left.createdAt) || left.index - right.index
  ))[0];
  const intrinsicFreshnessEligible = reportClaim.status === "verified"
    && latest?.event.status === "verified"
    && latest.event.resolvesDispute !== true
    && !events.some(({ event }: any) => event.resolvesDispute === true);
  if (intrinsicFreshnessEligible && expiresAt !== undefined && compareRfc3339Timestamps(expiresAt, evaluatedAt) < 0) {
    // Surface uses a strict expiry boundary (`now > expiresAt`): a claim is
    // still valid at its exact expiry instant and stale immediately after.
    return acceptedStatuses.includes("stale") ? null : "stale";
  }
  if (intrinsicFreshnessEligible && claim.expiresAt === undefined && claim.ttlSeconds !== undefined) {
    if (!Number.isSafeInteger(claim.ttlSeconds)) return "bundle_invalid";
    const anchor = latest.verifiedAt ?? latest.createdAt;
    const expiry = { epochSecond: anchor.epochSecond + claim.ttlSeconds, fractionalSecond: anchor.fractionalSecond };
    if (!Number.isFinite(expiry.epochSecond)) return "bundle_invalid";
    if (compareRfc3339Timestamps(expiry, evaluatedAt) < 0) {
      return acceptedStatuses.includes("stale") ? null : "stale";
    }
  }

  return null;
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

function deriveBundleReport(bundle: unknown, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies): { report: any | null; error: string | null } {
  if (!evaluationNow) {
    return { report: null, error: "evaluation_time_missing" };
  }
  // First validate via Surface (referential/structural)
  let validated: any;
  try {
    validated = dependencies.validate(surfaceTimestampValidationView(bundle));
  } catch (err: any) {
    return { report: null, error: `bundle_invalid: ${err?.message ?? String(err)}` };
  }
  // Then derive statuses via Surface
  try {
    const report = dependencies.buildReport(validated, { now: evaluationNow.surfaceNow });
    return { report, error: null };
  } catch (err: any) {
    return { report: null, error: `bundle_derivation_failed: ${err?.message ?? String(err)}` };
  }
}

function evidenceBundleDiagnostic(entry: any, expectation: any, enteredAt: ParsedRfc3339Timestamp | null = null, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies): string | null {
  if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") return null;
  if (entry.status === "failed") return "rejected";

  const bundle = entry.bundle;
  if (!bundle) return "bundle_invalid";

  // Schema validation
  const schemaResult = validateTrustBundleSchema(bundle);
  if (!schemaResult.valid) return "bundle_invalid";

  try {
    // Producer and authority policy only consumes the same rich bundle shape
    // that Surface validates, never a caller-authored manifest projection.
    dependencies.validate(surfaceTimestampValidationView(bundle));
  } catch {
    return "bundle_invalid";
  }

  // Derive report
  // A stored report is useful historical display data, but an authoritative
  // evaluation must re-derive it from the validated bundle at its one pinned
  // instant. Otherwise an expired/revoked authority could inherit a stale
  // report produced while it was active.
  const report = deriveBundleReport(bundle, evaluationNow, dependencies).report;
  if (!report) return "bundle_invalid";

  const selector = expectation.bundle_claim ?? expectation.claim;
  if (!selector) return "bundle_invalid";

  const claims = findClaimsInReport(report, selector);
  if (!claims.length) return "claim_not_found";

  const currentClaims = enteredAt === null
    ? claims
    : claims.filter((claim: any) => claimIsCurrentForVisit(bundle, claim, enteredAt));
  if (!currentClaims.length) {
    return "claim_not_current";
  }

  const accepted = selector.accepted_statuses ?? ["verified"];
  const acceptedClaims = currentClaims.filter((claim: any) => accepted.includes(claim.status ?? "unknown"));
  if (acceptedClaims.length) {
    const exactDiagnostics = acceptedClaims.map((claim: any) => (
      exactClaimTimelineDiagnostic(bundle, claim, accepted, evaluationNow!.exact)
    ));
    if (exactDiagnostics.includes(null)) return null;
    return exactDiagnostics[0] ?? "rejected";
  }

  const claimStatus = currentClaims[0].status ?? "unknown";
  if (!accepted.includes(claimStatus)) {
    if (claimStatus === "stale") return "stale";
    if (claimStatus === "disputed") return "disputed";
    return "rejected";
  }

  return null;
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

function acceptedClaimsForAuthority(entry: any, expectation: any, enteredAt: ParsedRfc3339Timestamp | null, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies): any[] {
  const selector = expectation.bundle_claim ?? expectation.claim;
  const report = deriveBundleReport(entry.bundle, evaluationNow, dependencies).report;
  if (!selector || !report) return [];
  const accepted = selector.accepted_statuses ?? ["verified"];
  const claims = findClaimsInReport(report, selector);
  const current = enteredAt === null ? claims : claims.filter((claim: any) => claimIsCurrentForVisit(entry.bundle, claim, enteredAt));
  return current.filter((claim: any) => accepted.includes(claim.status ?? "unknown"));
}

function authorityTraceDiagnostic(entry: any, expectation: any, policies: ReturnType<typeof trustedProducerPolicy>, enteredAt: ParsedRfc3339Timestamp | null, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies): ProducerAuthorityResult {
  const bundle = entry.bundle;
  const traces = Array.isArray(bundle?.authorityTrace) ? bundle.authorityTrace : [];
  if (!traces.length) return { reason: "untrusted_producer", authority: { code: "no_trace" } };
  const refScoped = traces.filter((trace: any) => policies.every((policy) => policy.authorityRefs.has(trace?.authorityRef)));
  if (!refScoped.length) return { reason: "untrusted_producer", authority: { code: "authority_ref_mismatch" } };
  const claims = acceptedClaimsForAuthority(entry, expectation, enteredAt, evaluationNow, dependencies);
  const selector = expectation.bundle_claim ?? expectation.claim;
  const accepted = selector?.accepted_statuses ?? ["verified"];
  const failures = new Set<string>();
  if (!evaluationNow) {
    return { reason: "untrusted_producer", authority: { code: "evaluation_time_missing" } };
  }
  const evaluatedAt = evaluationNow.exact;

  for (const trace of refScoped) {
    for (const claim of claims) {
      if (trace?.subject?.subjectType !== claim.subjectType || trace?.subject?.subjectId !== claim.subjectId) continue;
      const linkedEvidence = (bundle.evidence ?? []).filter((evidence: any) => evidence?.claimId === claim.id);
      const acceptedEvents = (bundle.events ?? []).filter((event: any) => event?.claimId === claim.id && accepted.includes(event.status));
      const linkedEvidenceIds = new Set(linkedEvidence.map((evidence: any) => evidence.id));
      const authorityCompatibleEvents = acceptedEvents.filter((event: any) => event.authorityRef === undefined || event.authorityRef === trace.authorityRef);
      const acceptedEventEvidenceIds = new Set(authorityCompatibleEvents.flatMap((event: any) => event.evidenceIds ?? []));
      const claimLinked = Array.isArray(trace.claimIds) && trace.claimIds.includes(claim.id);
      const evidenceLinked = Array.isArray(trace.evidenceIds) && trace.evidenceIds.some((id: string) => linkedEvidenceIds.has(id) && acceptedEventEvidenceIds.has(id));
      if (!claimLinked && !evidenceLinked) {
        failures.add("scope_mismatch");
        continue;
      }
      const eventActorMatches = authorityCompatibleEvents.some((event: any) => event.actor === trace.actorRef);
      const evidenceActorMatches = linkedEvidence.some((evidence: any) => (
        Array.isArray(trace.evidenceIds)
        && trace.evidenceIds.includes(evidence.id)
        && acceptedEventEvidenceIds.has(evidence.id)
        && evidence.collectedBy === trace.actorRef
      ));
      if (!eventActorMatches && !evidenceActorMatches) {
        failures.add("actor_mismatch");
        continue;
      }

      const normalizedTrace = structuredClone(trace);
      let invalidTimestamp = false;
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
      // Flow owns the exact RFC3339 chronology above, including fractional
      // seconds beyond JavaScript Date precision. Surface still corroborates
      // the trace per authority candidate, but receives no validity fields it
      // could compare lexically and thereby override Flow's precise decision.
      delete normalizedTrace.validFrom;
      delete normalizedTrace.validUntil;
      delete normalizedTrace.revokedAt;
      const active = dependencies.checkAuthorityActive(trace.actorRef, [normalizedTrace], evaluationNow.surfaceNow);
      if (active === "active") return null;
      failures.add(active === "expired" ? "expired" : active === "revoked" ? "revoked" : "no_trace");
    }
  }
  const failure = ["invalid_trace_timestamp", "revoked", "expired", "not_yet_valid", "actor_mismatch", "scope_mismatch", "subject_mismatch", "no_trace"]
    .find((code) => failures.has(code)) ?? "subject_mismatch";
  return { reason: "untrusted_producer", authority: { code: failure } };
}

/**
 * Pins are evaluated only after the bundle has otherwise satisfied the
 * expectation. That keeps a malformed or non-matching bundle diagnostic
 * honest while ensuring an unattributed or untrusted otherwise-valid claim
 * can never advance a gate.
 */
function evidenceProducerDiagnostic(entry: any, expectation: any, config: MutableRecord, enteredAt: ParsedRfc3339Timestamp | null = null, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies): ProducerAuthorityResult {
  // An unrelated file, malformed bundle, or non-matching claim has its own
  // established diagnostic (or no claim diagnostic at all). Producer policy
  // applies only to a bundle candidate that otherwise satisfies this selector.
  if (expectation.kind !== "trust.bundle") return null;
  if (entry?.kind !== "trust.bundle" && entry?.requested_kind !== "trust.bundle") return null;
  if (evidenceBundleDiagnostic(entry, expectation, enteredAt, evaluationNow, dependencies) !== null) return null;
  const policies = trustedProducerPolicy(expectation, config);
  if (!policies.length) return null;
  if (policies.some((policy) => policy.denyAll)) return { reason: "untrusted_producer", authority: { code: "deny_all" } };
  const producerId = entry.bundle?.producerId;
  if (entry.producer !== undefined && entry.producer !== producerId) return { reason: "untrusted_producer", authority: { code: "producer_mismatch" } };
  if (typeof producerId === "string" && policies.every((policy) => policy.producers.has(producerId))) return null;
  return authorityTraceDiagnostic(entry, expectation, policies, enteredAt, evaluationNow, dependencies);
}

function evidenceMatchesExpectationForEvaluation(entry: any, expectation: any, config: MutableRecord, enteredAt: ParsedRfc3339Timestamp | null, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies) {
  if (expectation.kind !== "trust.bundle") return false;
  if (entry.kind !== "trust.bundle" && entry.requested_kind !== "trust.bundle") return false;
  return evidenceBundleDiagnostic(entry, expectation, enteredAt, evaluationNow, dependencies) === null
    && evidenceProducerDiagnostic(entry, expectation, config, enteredAt, evaluationNow, dependencies) === null;
}

export function evidenceMatchesExpectation(entry: any, expectation: any, config: MutableRecord = defaultFlowConfig(), enteredAt: ParsedRfc3339Timestamp | null = null, evaluationNow?: GateEvaluationInput) {
  return evidenceMatchesExpectationForEvaluation(entry, expectation, config, enteredAt, parseGateEvaluationTime(evaluationNow), DEFAULT_GATE_AUTHORITY_DEPENDENCIES);
}

function claimDiagnosticsForExpectation(evidence: any[], expectation: any, config: MutableRecord = defaultFlowConfig(), visit: GateVisit, evaluationNow: GateEvaluationTime | undefined, dependencies: GateAuthorityDependencies) {
  const diagnostics: MutableRecord[] = [];
  for (const entry of evidence) {
    const bundleReason = evidenceBundleDiagnostic(entry, expectation, visit.enteredAt, evaluationNow, dependencies);
    const producer = evidenceProducerDiagnostic(entry, expectation, config, visit.enteredAt, evaluationNow, dependencies);
    const reason = evidenceVisitDiagnostic(entry, visit)
      ?? bundleReason
      ?? producer?.reason;
    if (!reason) continue;
    diagnostics.push({
      expectation_id: expectation.id,
      evidence_id: entry.id,
      reason,
      ...(producer?.authority ? { authority: producer.authority } : {})
    });
  }
  return diagnostics;
}

/**
 * Internal reducer seam. This module is not exported from the package root;
 * only the reducer may supply its already-validated, snapshotted adapter.
 */
export function evaluateGateWithReducerDependencies(definition: any, state: any, manifest: any, gateId: string, config: MutableRecord = defaultFlowConfig(), evaluationNow: GateEvaluationInput | undefined, dependencies: GateAuthorityDependencies): GateOutcome {
  validateFlatFlowConfig(config);
  const effectiveEvaluationNow = evaluationNow === undefined
    ? parseGateEvaluationTime(state?.updated_at)
    : parseGateEvaluationTime(evaluationNow);
  const gate = findGate(definition, gateId);
  if (!gate) throw new Error(`unknown gate: ${gateId}`);

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

  const expectations = expectationsForGate(gate, config);
  const matched: Array<{ expectation_id: string; evidence_id: string }> = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];
  const claimDiagnostics: MutableRecord[] = [];
  for (const expectation of expectations) {
    const expectationWithGate = { ...expectation, gate_id: gateId };
    const match = visit.revisited && (visit.awaitingReentry || visit.enteredAt === null)
      ? undefined
      : evidence.find((entry) => evidenceMatchesExpectationForEvaluation(entry, expectationWithGate, config, visit.enteredAt, effectiveEvaluationNow, dependencies));
    if (match) {
      matched.push({ expectation_id: expectation.id, evidence_id: match.id });
    } else if (expectation.required) {
      missingRequired.push(expectation.id);
      claimDiagnostics.push(...claimDiagnosticsForExpectation(attachedEvidence, expectationWithGate, config, visit, effectiveEvaluationNow, dependencies));
    } else {
      missingOptional.push(expectation.id);
      claimDiagnostics.push(...claimDiagnosticsForExpectation(attachedEvidence, expectationWithGate, config, visit, effectiveEvaluationNow, dependencies));
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
