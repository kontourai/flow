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

export type GateEvaluationReadStatus = "found" | "missing" | "unavailable" | "unsupported";

/** Strict allowlist returned by the native reader; no path, raw bundle, or authority payload crosses this seam. */
export interface GateEvaluationReadProjection extends GateEvaluationProjection {
  kind: "initial" | "recheck";
  trigger: GateEvaluationRecord["trigger"];
  previousRef?: GateEvaluationRef;
  exceptionId?: string;
  routeBack?: GateEvaluationRecord["routeBack"];
  currentStanding: "current" | "superseded" | "invalidated";
  currentRun: { status: string; currentStep: string | null };
  currentPersistedGateRef?: GateEvaluationRef;
  selectedEvidence: Array<{
    evidenceId: string;
    sha256?: string;
    standing: "current" | "superseded" | "missing";
    freshness: "recorded" | "stale" | "unavailable";
    revocationCodes: string[];
  }>;
}

export type GateEvaluationReadResult =
  | { status: "found"; evaluation: GateEvaluationReadProjection }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "unsupported" };

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

function dateTime(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Snapshot only own data properties. Getters/Proxies are invalid, never invoked. */
function closedObject(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> | undefined {
  try {
    if (!object(value)) return undefined;
    const keys = Object.keys(value);
    const allowed = new Set([...required, ...optional]);
    if (keys.length < required.length || keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) return undefined;
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Total parser: invalid values return undefined and never throw. */
export function parseGateEvaluationRef(value: unknown): GateEvaluationRef | undefined {
  const source = closedObject(value, ["runId", "gateId", "evaluationId"]);
  if (!source || !nonEmpty(source.runId) || !nonEmpty(source.gateId) || !nonEmpty(source.evaluationId) || !uuid.test(source.evaluationId)) return undefined;
  return { runId: source.runId, gateId: source.gateId, evaluationId: source.evaluationId };
}

/** Total parser: accepts only the closed v1 ledger shape needed by Phase 1. */
export function parseGateEvaluationLedger(value: unknown): GateEvaluationLedger | undefined {
  try {
    const source = closedObject(value, ["version", "records"]);
    if (!source || source.version !== GATE_EVALUATION_CONTRACT_VERSION || !Array.isArray(source.records)) return undefined;
    const records: GateEvaluationRecord[] = [];
    for (let index = 0; index < source.records.length; index += 1) {
    const rawCandidate = source.records[index];
    const candidate = closedObject(rawCandidate, ["version", "ref", "evaluatedAt", "trigger", "definition", "gate", "originalVerdict", "selections"], ["previousRef", "exceptionId", "routeBack"]);
    if (!candidate || candidate.version !== "1" || !dateTime(candidate.evaluatedAt) || !nonEmpty(candidate.originalVerdict) || !verdicts.has(candidate.originalVerdict) || !nonEmpty(candidate.trigger) || !triggers.has(candidate.trigger)) return undefined;
    const ref = parseGateEvaluationRef(candidate.ref);
    const previousRef = candidate.previousRef === undefined ? undefined : parseGateEvaluationRef(candidate.previousRef);
    const definition = closedObject(candidate.definition, ["id", "version", "digest"]);
    const gate = closedObject(candidate.gate, ["id", "digest"]);
    if (!ref || (candidate.previousRef !== undefined && !previousRef) || !definition || !nonEmpty(definition.id) || !nonEmpty(definition.version) || !nonEmpty(definition.digest) || !digest.test(definition.digest) || !gate || gate.id !== ref.gateId || !nonEmpty(gate.digest) || !digest.test(gate.digest) || !Array.isArray(candidate.selections)) return undefined;
    const selections: GateEvaluationEvidenceSelection[] = [];
    for (const rawSelection of candidate.selections) {
      const selection = closedObject(rawSelection, ["evidenceId"], ["expectationId", "sha256"]);
      if (!selection || !nonEmpty(selection.evidenceId) || (selection.expectationId !== undefined && !nonEmpty(selection.expectationId)) || (selection.sha256 !== undefined && (!nonEmpty(selection.sha256) || !digest.test(selection.sha256)))) return undefined;
      selections.push({ ...(typeof selection.expectationId === "string" ? { expectationId: selection.expectationId } : {}), evidenceId: selection.evidenceId, ...(typeof selection.sha256 === "string" ? { sha256: selection.sha256 } : {}) });
    }
    let routeBack: GateEvaluationRecord["routeBack"] | undefined;
    if (candidate.routeBack !== undefined) {
      const route = closedObject(candidate.routeBack, [], ["attempt", "maxAttempts", "retryEpoch", "reason", "selectedRoute"]);
      if (!route) return undefined;
      for (const field of ["attempt", "maxAttempts", "retryEpoch"]) {
        if (route[field] !== undefined && (!Number.isInteger(route[field]) || (route[field] as number) < 1)) return undefined;
      }
      if ((route.reason !== undefined && !nonEmpty(route.reason)) || (route.selectedRoute !== undefined && !nonEmpty(route.selectedRoute))) return undefined;
      routeBack = { ...(typeof route.attempt === "number" ? { attempt: route.attempt } : {}), ...(typeof route.maxAttempts === "number" ? { maxAttempts: route.maxAttempts } : {}), ...(typeof route.retryEpoch === "number" ? { retryEpoch: route.retryEpoch } : {}), ...(typeof route.reason === "string" ? { reason: route.reason } : {}), ...(typeof route.selectedRoute === "string" ? { selectedRoute: route.selectedRoute } : {}) };
    }
    records.push({ version: "1", ref, evaluatedAt: candidate.evaluatedAt as string, trigger: candidate.trigger as GateEvaluationRecord["trigger"], ...(previousRef ? { previousRef } : {}), definition: { id: definition.id as string, version: definition.version as string, digest: definition.digest as string }, gate: { id: gate.id as string, digest: gate.digest as string }, originalVerdict: candidate.originalVerdict as GateEvaluationRecord["originalVerdict"], selections, ...(nonEmpty(candidate.exceptionId) ? { exceptionId: candidate.exceptionId } : {}), ...(routeBack ? { routeBack } : {}) });
  }
    return { version: "1", records };
  } catch {
    return undefined;
  }
}

/** Total parser for one immutable record; it shares the ledger's closed v1 grammar. */
export function parseGateEvaluationRecord(value: unknown): GateEvaluationRecord | undefined {
  return parseGateEvaluationLedger({ version: "1", records: [value] })?.records[0];
}

/** Total parser for the minimal, strict public projection safe for browsers. */
export function parseGateEvaluationProjection(value: unknown): GateEvaluationProjection | undefined {
  const source = closedObject(value, ["ref", "evaluatedAt", "originalVerdict"]);
  if (!source || !dateTime(source.evaluatedAt) || !nonEmpty(source.originalVerdict) || !verdicts.has(source.originalVerdict)) return undefined;
  const ref = parseGateEvaluationRef(source.ref);
  return ref ? { ref, evaluatedAt: source.evaluatedAt, originalVerdict: source.originalVerdict as GateEvaluationProjection["originalVerdict"] } : undefined;
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
