/**
 * Browser-safe public contract for an immutable committed gate appraisal.
 * The ledger itself stays in a Flow run's canonical state; this module has no
 * filesystem or Node imports so readers can validate projections in a browser.
 */
export const GATE_EVALUATION_CONTRACT_VERSION = "1" as const;

export interface GateEvaluationRef {
  runId: string;
  gateId: string;
  evaluationId: string;
}

export interface GateEvaluationEvidenceSelection {
  expectationId?: string;
  evidenceId: string;
  sha256?: string;
}

export interface GateEvaluationRecord {
  version: "1";
  ref: GateEvaluationRef;
  evaluatedAt: string;
  trigger: "ordinary" | "freshness" | "claimed" | "paused";
  previousRef?: GateEvaluationRef;
  definition: { id: string; version: string; digest: string };
  gate: { id: string; digest: string };
  originalVerdict: "pass" | "block" | "route-back" | "wait";
  selections: GateEvaluationEvidenceSelection[];
  exceptionId?: string;
  routeBack?: {
    attempt?: number;
    maxAttempts?: number;
    retryEpoch?: number;
    reason?: string;
    selectedRoute?: string;
  };
}

export interface GateEvaluationLedger {
  version: "1";
  records: GateEvaluationRecord[];
}

export interface GateEvaluationProjection {
  ref: GateEvaluationRef;
  evaluatedAt: string;
  originalVerdict: "pass" | "block" | "route-back" | "wait";
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/;
const verdicts = new Set(["pass", "block", "route-back", "wait"]);
const triggers = new Set(["ordinary", "freshness", "claimed", "paused"]);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Total parser: invalid values return undefined and never throw. */
export function parseGateEvaluationRef(value: unknown): GateEvaluationRef | undefined {
  if (!object(value) || !nonEmpty(value.runId) || !nonEmpty(value.gateId) || !nonEmpty(value.evaluationId) || !uuid.test(value.evaluationId)) return undefined;
  return { runId: value.runId, gateId: value.gateId, evaluationId: value.evaluationId };
}

/** Total parser: accepts only the closed v1 ledger shape needed by Phase 1. */
export function parseGateEvaluationLedger(value: unknown): GateEvaluationLedger | undefined {
  if (!object(value) || value.version !== GATE_EVALUATION_CONTRACT_VERSION || !Array.isArray(value.records)) return undefined;
  const records: GateEvaluationRecord[] = [];
  for (const candidate of value.records) {
    if (!object(candidate) || candidate.version !== "1" || !nonEmpty(candidate.evaluatedAt) || !nonEmpty(candidate.originalVerdict) || !verdicts.has(candidate.originalVerdict) || !nonEmpty(candidate.trigger) || !triggers.has(candidate.trigger)) return undefined;
    const ref = parseGateEvaluationRef(candidate.ref);
    const previousRef = candidate.previousRef === undefined ? undefined : parseGateEvaluationRef(candidate.previousRef);
    if (!ref || (candidate.previousRef !== undefined && !previousRef) || !object(candidate.definition) || !nonEmpty(candidate.definition.id) || !nonEmpty(candidate.definition.version) || !nonEmpty(candidate.definition.digest) || !digest.test(candidate.definition.digest) || !object(candidate.gate) || candidate.gate.id !== ref.gateId || !nonEmpty(candidate.gate.digest) || !digest.test(candidate.gate.digest) || !Array.isArray(candidate.selections)) return undefined;
    const selections: GateEvaluationEvidenceSelection[] = [];
    for (const selection of candidate.selections) {
      if (!object(selection) || !nonEmpty(selection.evidenceId) || (selection.expectationId !== undefined && !nonEmpty(selection.expectationId)) || (selection.sha256 !== undefined && (!nonEmpty(selection.sha256) || !digest.test(selection.sha256)))) return undefined;
      selections.push({ ...(typeof selection.expectationId === "string" ? { expectationId: selection.expectationId } : {}), evidenceId: selection.evidenceId as string, ...(typeof selection.sha256 === "string" ? { sha256: selection.sha256 } : {}) });
    }
    let routeBack: GateEvaluationRecord["routeBack"] | undefined;
    if (candidate.routeBack !== undefined) {
      if (!object(candidate.routeBack)) return undefined;
      const route = candidate.routeBack;
      for (const field of ["attempt", "maxAttempts", "retryEpoch"]) {
        if (route[field] !== undefined && (!Number.isInteger(route[field]) || (route[field] as number) < 1)) return undefined;
      }
      if ((route.reason !== undefined && !nonEmpty(route.reason)) || (route.selectedRoute !== undefined && !nonEmpty(route.selectedRoute))) return undefined;
      routeBack = { ...(typeof route.attempt === "number" ? { attempt: route.attempt } : {}), ...(typeof route.maxAttempts === "number" ? { maxAttempts: route.maxAttempts } : {}), ...(typeof route.retryEpoch === "number" ? { retryEpoch: route.retryEpoch } : {}), ...(typeof route.reason === "string" ? { reason: route.reason } : {}), ...(typeof route.selectedRoute === "string" ? { selectedRoute: route.selectedRoute } : {}) };
    }
    records.push({ version: "1", ref, evaluatedAt: candidate.evaluatedAt as string, trigger: candidate.trigger as GateEvaluationRecord["trigger"], ...(previousRef ? { previousRef } : {}), definition: candidate.definition as GateEvaluationRecord["definition"], gate: candidate.gate as GateEvaluationRecord["gate"], originalVerdict: candidate.originalVerdict as GateEvaluationRecord["originalVerdict"], selections, ...(nonEmpty(candidate.exceptionId) ? { exceptionId: candidate.exceptionId } : {}), ...(routeBack ? { routeBack } : {}) });
  }
  return { version: "1", records };
}

/** Total parser for one immutable record; it shares the ledger's closed v1 grammar. */
export function parseGateEvaluationRecord(value: unknown): GateEvaluationRecord | undefined {
  return parseGateEvaluationLedger({ version: "1", records: [value] })?.records[0];
}

/** Total parser for the minimal, strict public projection safe for browsers. */
export function parseGateEvaluationProjection(value: unknown): GateEvaluationProjection | undefined {
  if (!object(value) || Object.keys(value).length !== 3 || !nonEmpty(value.evaluatedAt) || !nonEmpty(value.originalVerdict) || !verdicts.has(value.originalVerdict)) return undefined;
  const ref = parseGateEvaluationRef(value.ref);
  return ref ? { ref, evaluatedAt: value.evaluatedAt, originalVerdict: value.originalVerdict as GateEvaluationProjection["originalVerdict"] } : undefined;
}

export const gateEvaluationRefSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kontourai.io/schemas/gate-evaluation-ref.schema.json",
  type: "object", required: ["runId", "gateId", "evaluationId"], additionalProperties: false,
  properties: { runId: { type: "string", minLength: 1 }, gateId: { type: "string", minLength: 1 }, evaluationId: { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" } }
} as const;

export const gateEvaluationLedgerSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kontourai.io/schemas/gate-evaluation-ledger.schema.json",
  type: "object", required: ["version", "records"], additionalProperties: false,
  properties: { version: { const: "1" }, records: { type: "array" } }
} as const;

export const gateEvaluationProjectionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://kontourai.io/schemas/gate-evaluation-projection.schema.json",
  type: "object", required: ["ref", "evaluatedAt", "originalVerdict"], additionalProperties: false,
  properties: { ref: gateEvaluationRefSchema, evaluatedAt: { type: "string", format: "date-time" }, originalVerdict: { enum: ["pass", "block", "route-back", "wait"] } }
} as const;
