import { readJson } from "../runtime/flow-files.js";
import { FLOW_SCHEMA_VERSION } from "../contracts/flow-types.js";
import type {
  FlowEvidenceEntry,
  MutableRecord,
  ReleaseExternalLink,
  ReleaseLaneOutcome,
  ReleaseLanePolicy,
  ReleaseLaneStatus,
  ReleaseNativeRef,
  ReleaseReadinessContext,
  ReleaseReadinessDecision,
  ReleaseReadinessPolicy,
  ReleaseReadinessResult,
  VersionReleaseReport,
  VersionReleaseReportDecision,
  VersionReleaseReportGap,
  VersionReleaseReportInput
} from "../contracts/flow-types.js";
import { cloneJson, isObject, markdownText } from "../shared/flow-utils.js";

function releaseStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function releaseLinkUrl(entry: MutableRecord) {
  const candidate = entry.url ?? entry.href ?? entry.path;
  return candidate === undefined ? "" : String(candidate);
}

function releaseNativeRefId(entry: MutableRecord) {
  const candidate = entry.id ?? entry.ref ?? entry.native_id ?? entry.number ?? entry.key;
  return candidate === undefined ? "" : String(candidate);
}

function releaseLinks(value): ReleaseExternalLink[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((entry: any) => ({
    ...cloneJson(entry),
    label: String(entry.label ?? entry.type ?? "source"),
    url: releaseLinkUrl(entry)
  }));
}

function releaseNativeRefs(value): ReleaseNativeRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject).map((entry: any) => ({
    ...cloneJson(entry),
    system: String(entry.system ?? entry.kind ?? "fixture"),
    id: releaseNativeRefId(entry),
    ...(entry.url ? { url: String(entry.url) } : {})
  }));
}

function mergeReleaseNativeRefs(value, fallback: ReleaseNativeRef): ReleaseNativeRef[] {
  const refs = releaseNativeRefs(value);
  if (!fallback.system || !fallback.id) return refs;
  const exists = refs.some((ref) => ref.system === fallback.system && ref.id === fallback.id);
  return exists ? refs : [...refs, cloneJson(fallback)];
}

function releaseTrustEventStatus(status) {
  if (status === "trusted") return "verified";
  if (status === "rejected") return "rejected";
  return "unknown";
}

function releaseEvidenceEntry(fields: MutableRecord): FlowEvidenceEntry {
  const claim = fields.claim ?? {};
  const subject = claim.subject ?? fields.subject;
  const producer = fields.producer ?? "release-fixture/adapter";
  const authorityTraces = releaseStringArray(fields.authority_traces);
  const claimId = `${fields.id}.claim`;
  const evidenceId = `${fields.id}.evidence`;
  const eventId = `${fields.id}.verified`;
  const bundleClaim = {
    claimType: claim.type,
    subjectId: subject,
    accepted_statuses: ["trusted"]
  };
  return {
    id: fields.id,
    gate_id: fields.gate_id,
    kind: "trust.bundle",
    requested_kind: "trust.bundle",
    status: "passed",
    bundle_claim: bundleClaim,
    claim: {
      type: claim.type,
      subject,
      status: claim.status
    },
    producer,
    authority_traces: authorityTraces,
    ...(authorityTraces[0] ? { authority_trace: authorityTraces[0] } : {}),
    bundle: {
      schemaVersion: 3,
      source: producer,
      claims: [
        {
          id: claimId,
          subjectType: "release",
          subjectId: subject,
          surface: "release-readiness",
          claimType: claim.type,
          fieldOrBehavior: "releaseLane",
          value: claim.status,
          createdAt: fields.issued_at,
          updatedAt: fields.issued_at
        }
      ],
      evidence: [
        {
          id: evidenceId,
          claimId,
          evidenceType: "human_attestation",
          method: "attestation",
          sourceRef: String(fields.source_adapter_id ?? producer),
          excerptOrSummary: `${claim.type} is ${claim.status}`,
          observedAt: fields.issued_at,
          collectedBy: producer
        }
      ],
      policies: [],
      events: [
        {
          id: eventId,
          claimId,
          status: releaseTrustEventStatus(claim.status),
          actor: producer,
          method: "attestation",
          evidenceIds: [evidenceId],
          createdAt: fields.issued_at,
          ...(claim.status === "trusted" ? { verifiedAt: fields.issued_at } : {})
        }
      ]
    },
    trust_artifact: {
      schema_version: FLOW_SCHEMA_VERSION,
      artifact_type: "trust-report",
      subject,
      producer,
      status: claim.status,
      issued_at: fields.issued_at,
      authority_traces: authorityTraces,
      claims: [
        {
          type: claim.type,
          subject,
          status: claim.status,
          issued_at: fields.issued_at
        }
      ],
      integrity: { verified: true }
    },
    external_links: releaseLinks(fields.external_links),
    native_refs: releaseNativeRefs(fields.native_refs),
    source_adapter_id: fields.source_adapter_id,
    attached_at: fields.attached_at
  };
}

function changeApprovalStatus(record: MutableRecord) {
  const approval = String(record.approval_state ?? record.approval?.state ?? record.state ?? "missing");
  if (["approved", "implemented"].includes(approval)) return "trusted";
  if (["pending", "requested", "scheduled"].includes(approval)) return "pending";
  if (["rejected", "denied", "cancelled"].includes(approval)) return "rejected";
  return "missing";
}

export function changeManagementFixtureAdapter(record: MutableRecord, context: ReleaseReadinessContext): FlowEvidenceEntry[] {
  const changeId = String(record.id ?? record.number ?? record.change_id ?? "unknown-change");
  const status = changeApprovalStatus(record);
  return [
    releaseEvidenceEntry({
      id: `ev.release.change.${changeId}`,
      gate_id: context.gate_id,
      source_adapter_id: "fixture/change-management",
      subject: `release:${context.subject}`,
      claim: {
        type: "release.change.approved",
        status
      },
      producer: record.producer ?? "release-fixture/change-management",
      authority_traces: record.authority_traces ?? ["fixture:change-management"],
      external_links: record.external_links,
      native_refs: mergeReleaseNativeRefs(record.native_refs, { system: record.system ?? "change-management-fixture", id: changeId, url: record.url }),
      issued_at: record.approved_at ?? record.updated_at,
      attached_at: context.attached_at ?? record.updated_at
    })
  ];
}

export function deploymentWindowFixtureAdapter(record: MutableRecord, context: ReleaseReadinessContext): FlowEvidenceEntry[] {
  const deploymentId = String(record.id ?? record.environment ?? "deployment-window");
  const allowed = record.window_state === "open" || record.allowed === true;
  return [
    releaseEvidenceEntry({
      id: `ev.release.deployment.${deploymentId}`,
      gate_id: context.gate_id,
      source_adapter_id: "fixture/deployment-window",
      subject: `release:${context.subject}`,
      claim: {
        type: "release.deployment.window.allowed",
        status: allowed ? "trusted" : "pending"
      },
      producer: record.producer ?? "release-fixture/deployment-window",
      authority_traces: record.authority_traces ?? ["fixture:deployment-window"],
      external_links: record.external_links,
      native_refs: mergeReleaseNativeRefs(record.native_refs, { system: record.system ?? "deployment-fixture", id: deploymentId, url: record.url }),
      issued_at: record.updated_at,
      attached_at: context.attached_at ?? record.updated_at
    })
  ];
}

export function freezeStateFixtureAdapter(record: MutableRecord, context: ReleaseReadinessContext): FlowEvidenceEntry[] {
  const freezeId = String(record.id ?? record.window_id ?? "freeze-state");
  const clear = record.freeze_state === "clear" || record.clear === true;
  return [
    releaseEvidenceEntry({
      id: `ev.release.freeze.${freezeId}`,
      gate_id: context.gate_id,
      source_adapter_id: "fixture/freeze-state",
      subject: `release:${context.subject}`,
      claim: {
        type: "release.freeze.clear",
        status: clear ? "trusted" : "pending"
      },
      producer: record.producer ?? "release-fixture/freeze-state",
      authority_traces: record.authority_traces ?? ["fixture:freeze-state"],
      external_links: record.external_links,
      native_refs: mergeReleaseNativeRefs(record.native_refs, { system: record.system ?? "freeze-fixture", id: freezeId, url: record.url }),
      issued_at: record.updated_at,
      attached_at: context.attached_at ?? record.updated_at
    })
  ];
}

export async function loadReleaseReadinessInputs(options: MutableRecord): Promise<FlowEvidenceEntry[]> {
  const subject = options.subject ?? "release";
  const context = {
    subject,
    gate_id: options.gateId ?? options.gate_id,
    attached_at: options.attachedAt ?? options.attached_at
  };
  const entries: FlowEvidenceEntry[] = [];
  if (options.changeRecord) entries.push(...changeManagementFixtureAdapter(await readJson(options.changeRecord), context));
  if (options.deploymentState) entries.push(...deploymentWindowFixtureAdapter(await readJson(options.deploymentState), context));
  if (options.freezeState) entries.push(...freezeStateFixtureAdapter(await readJson(options.freezeState), context));
  return entries;
}

function releaseRequiredLanes(policy: ReleaseReadinessPolicy, riskClass: string) {
  const riskPolicy = policy.risk_classes?.[riskClass];
  if (!riskPolicy) throw new Error(`unknown release risk class: ${riskClass}`);
  return releaseStringArray(riskPolicy.required_lanes);
}

function laneCandidateEvidence(evidence: FlowEvidenceEntry[], lane: ReleaseLanePolicy) {
  const adapterIds = releaseStringArray(lane.adapter_ids);
  return evidence.filter((entry) => {
    if (adapterIds.length && !adapterIds.includes(String(entry.source_adapter_id ?? ""))) return false;
    if (entry.claim?.type !== lane.claim.type) return false;
    if (lane.claim.subject && entry.claim?.subject !== lane.claim.subject) return false;
    return true;
  });
}

function collectReleaseRefs(evidence: FlowEvidenceEntry[]) {
  return {
    external_links: evidence.flatMap((entry) => releaseLinks(entry.external_links)),
    native_refs: evidence.flatMap((entry) => releaseNativeRefs(entry.native_refs))
  };
}

function evaluateReleaseLane(
  lane: ReleaseLanePolicy,
  required: boolean,
  evidence: FlowEvidenceEntry[]
): ReleaseLaneOutcome {
  const candidates = laneCandidateEvidence(evidence, lane);
  const acceptedStatuses = releaseStringArray(lane.claim.accepted_statuses ?? ["trusted"]);
  const match = candidates.find((entry) => acceptedStatuses.includes(String(entry.claim?.status ?? "")));
  const refs = collectReleaseRefs(candidates);
  const status: ReleaseLaneStatus = !required ? "not_required" : match ? "pass" : candidates.length ? "hold" : "not_verified";
  return {
    lane_id: lane.id,
    status,
    summary: match ? `${lane.description} satisfied` : required ? `${lane.description} not satisfied` : `${lane.description} not required`,
    required,
    evidence_refs: candidates.map((entry) => entry.id),
    external_links: refs.external_links,
    native_refs: refs.native_refs,
    source_adapter_ids: [...new Set(candidates.map((entry) => entry.source_adapter_id).filter(Boolean))]
  };
}

export function evaluateReleaseReadiness(policy: ReleaseReadinessPolicy, options: MutableRecord = {}): ReleaseReadinessResult {
  const riskClass = options.riskClass ?? options.risk_class;
  if (!riskClass) throw new Error("release readiness requires riskClass");
  const subject = options.subject ?? "release";
  const evidence: FlowEvidenceEntry[] = options.evidence ?? [];
  const requiredLanes = releaseRequiredLanes(policy, riskClass);
  const laneIds = new Set(policy.lanes.map((lane) => lane.id));
  for (const laneId of requiredLanes) {
    if (!laneIds.has(laneId)) throw new Error(`risk class ${riskClass} requires unknown release lane: ${laneId}`);
  }

  const lanes = policy.lanes.map((lane) => evaluateReleaseLane(lane, requiredLanes.includes(lane.id), evidence));
  const decision: ReleaseReadinessDecision = lanes.some((lane) => lane.required && lane.status !== "pass") ? "hold" : "pass";
  const allRefs = collectReleaseRefs(evidence);
  return {
    schema_version: FLOW_SCHEMA_VERSION,
    policy_id: policy.id,
    decision,
    risk_class: riskClass,
    subject,
    required_lanes: requiredLanes,
    lanes,
    evidence,
    report_data: {
      decision,
      risk_class: riskClass,
      subject,
      required_lanes: requiredLanes,
      external_links: allRefs.external_links,
      native_refs: allRefs.native_refs
    }
  };
}

export function projectVersionReleaseReport(input: VersionReleaseReportInput): VersionReleaseReport {
  const verificationEvidence = input.verification_evidence ?? [];
  const releaseReadiness = input.release_readiness;
  if (!releaseReadiness) throw new Error("version release report requires release_readiness");
  const requiredVerification = releaseStringArray(input.required_verification_evidence);
  const requiredLaneIds = releaseStringArray(releaseReadiness.required_lanes);
  const laneIds = new Set((releaseReadiness.lanes ?? []).map((lane) => lane.lane_id));
  const verificationSatisfied = (entry: FlowEvidenceEntry | undefined) => {
    const claimStatus = entry?.claim?.status ?? entry?.trust_status ?? entry?.status;
    return Boolean(entry) && ["trusted", "passed"].includes(String(claimStatus));
  };
  const gaps: VersionReleaseReportGap[] = [];

  for (const evidenceId of requiredVerification) {
    const entry = verificationEvidence.find((candidate) => candidate.id === evidenceId);
    const claimStatus = entry?.claim?.status ?? entry?.trust_status ?? entry?.status;
    if (!verificationSatisfied(entry)) {
      gaps.push({
        id: evidenceId,
        kind: "verification_evidence",
        summary: entry ? `required verification evidence ${evidenceId} is ${claimStatus}` : `required verification evidence ${evidenceId} is missing`
      });
    }
  }

  for (const laneId of requiredLaneIds) {
    if (!laneIds.has(laneId)) {
      gaps.push({
        id: laneId,
        kind: "release_lane",
        summary: `required release lane ${laneId} is absent`
      });
    }
  }

  for (const lane of releaseReadiness.lanes ?? []) {
    if (lane.required && lane.status !== "pass") {
      gaps.push({
        id: lane.lane_id,
        kind: "release_lane",
        summary: `required release lane ${lane.lane_id} is ${lane.status}`
      });
    }
  }

  const externalLinks = [
    ...releaseLinks(input.external_links),
    ...releaseLinks(verificationEvidence.flatMap((entry) => Array.isArray(entry.external_links) ? entry.external_links : [])),
    ...releaseLinks(releaseReadiness.report_data?.external_links),
    ...releaseLinks((releaseReadiness.lanes ?? []).flatMap((lane) => Array.isArray(lane.external_links) ? lane.external_links : []))
  ];
  const nativeRefs = [
    ...releaseNativeRefs(input.native_refs),
    ...releaseNativeRefs(verificationEvidence.flatMap((entry) => Array.isArray(entry.native_refs) ? entry.native_refs : [])),
    ...releaseNativeRefs(releaseReadiness.report_data?.native_refs),
    ...releaseNativeRefs((releaseReadiness.lanes ?? []).flatMap((lane) => Array.isArray(lane.native_refs) ? lane.native_refs : []))
  ];
  const decision: VersionReleaseReportDecision = gaps.length || releaseReadiness.decision !== "pass" ? "hold" : "ready";
  const summary = input.summary ?? `${input.version?.id ?? "version"} release ${decision}`;

  return {
    schema_version: FLOW_SCHEMA_VERSION,
    version: cloneJson(input.version ?? {}),
    subject: input.subject ?? releaseReadiness.subject,
    decision,
    status: decision,
    summary,
    changeset: cloneJson(input.changeset ?? []),
    verification_evidence: cloneJson(verificationEvidence),
    release_evidence: cloneJson(releaseReadiness),
    exceptions: cloneJson(input.exceptions ?? []),
    accepted_risks: cloneJson(input.accepted_risks ?? []),
    gaps,
    external_links: externalLinks,
    native_refs: nativeRefs,
    report_data: {
      decision,
      status: decision,
      verification_evidence_count: verificationEvidence.length,
      release_decision: releaseReadiness.decision,
      release_required_lanes: cloneJson(requiredLaneIds),
      release_lane_statuses: Object.fromEntries((releaseReadiness.lanes ?? []).map((lane) => [lane.lane_id, lane.status])),
      required_verification_evidence: requiredVerification,
      satisfied_required_verification_evidence: requiredVerification.filter((id) => verificationSatisfied(verificationEvidence.find((entry) => entry.id === id))),
      gap_count: gaps.length,
      external_links: externalLinks,
      native_refs: nativeRefs
    }
  };
}

function safeMarkdownUrl(value: any) {
  const url = String(value ?? "");
  if (!url) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(https?|file):/i.test(url)) return "[blocked-url]";
  return markdownText(url);
}

function renderVersionReleaseBucket(title: string, entries: MutableRecord[], renderEntry: (entry: MutableRecord) => string) {
  const lines = [`## ${markdownText(title)}`, ""];
  if (!entries.length) return [...lines, "- none", ""].join("\n");
  for (const entry of entries) lines.push(renderEntry(entry));
  lines.push("");
  return lines.join("\n");
}

export function renderVersionReleaseReportMarkdown(report: VersionReleaseReport) {
  return [
    `# Version Release Report: ${markdownText(report.version.id ?? report.subject)}`,
    "",
    `- Subject: ${markdownText(report.subject)}`,
    `- Version: ${markdownText(report.version.id ?? "unknown")}`,
    `- Decision: ${markdownText(report.decision)}`,
    `- Status: ${markdownText(report.status)}`,
    `- Summary: ${markdownText(report.summary)}`,
    "",
    renderVersionReleaseBucket("Changeset", report.changeset, (entry) => `- ${markdownText(entry.id ?? entry.path ?? "change")}: ${markdownText(entry.summary ?? entry.description ?? entry.title ?? "changed")}`),
    renderVersionReleaseBucket("Verification Evidence", report.verification_evidence, (entry) => `- ${markdownText(entry.id)}: ${markdownText(entry.kind)}${entry.claim?.type ? ` ${markdownText(entry.claim.type)}` : ""}${entry.claim?.status ? ` (${markdownText(entry.claim.status)})` : entry.status ? ` (${markdownText(entry.status)})` : ""}`),
    renderVersionReleaseBucket("Release Evidence", report.release_evidence.lanes ?? [], (lane) => `- ${markdownText(lane.lane_id)}: ${markdownText(lane.status)}${lane.required ? " required" : " optional"} - ${markdownText(lane.summary)}`),
    renderVersionReleaseBucket("Gaps", report.gaps, (gap) => `- ${markdownText(gap.kind)} ${markdownText(gap.id)}: ${markdownText(gap.summary)}`),
    renderVersionReleaseBucket("Accepted Exceptions", report.exceptions, (entry) => `- ${markdownText(entry.id ?? entry.gate_id ?? "exception")}: ${markdownText(entry.reason ?? entry.summary ?? "accepted")}${entry.authority ? ` (${markdownText(entry.authority)})` : ""}`),
    renderVersionReleaseBucket("Accepted Risks", report.accepted_risks, (entry) => `- ${markdownText(entry.id ?? "risk")}: ${markdownText(entry.summary ?? entry.reason ?? "accepted")}${entry.owner ? ` (${markdownText(entry.owner)})` : ""}`),
    renderVersionReleaseBucket("Native Refs", report.native_refs, (entry) => `- ${markdownText(entry.system)}:${markdownText(entry.id)}${entry.url ? ` ${safeMarkdownUrl(entry.url)}` : ""}`),
    renderVersionReleaseBucket("External Links", report.external_links, (entry) => `- ${markdownText(entry.label)}: ${safeMarkdownUrl(entry.url)}`)
  ].join("\n");
}
