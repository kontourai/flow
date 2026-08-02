// Internal Flow preflight shared by direct gate evaluation and canonical
// report re-derivation. It deliberately is not part of Flow's public API.
const MAX_RESOLUTION_TRACE_COMPARISONS = 4_096;
const MAX_SURFACE_DERIVATION_RECORDS = 4_096;
const MAX_SURFACE_DERIVATION_PRODUCT = 1_000_000;

const FOLDED_COLLECTIONS = ["claims", "evidence", "events", "policies", "identityLinks", "claimGroups", "authorityTrace"] as const;

type BudgetMetrics = { claims: number; traces: number; resolutionEvents: number; work: number };

/**
 * Count every collection Surface can traverse, including nested references.
 * Array lengths are rejected before any array-element reads: a sparse or huge
 * raw array therefore cannot force allocation, eager iteration, or accessor
 * evaluation beyond the small Flow ceiling.
 */
function boundedMetrics(bundle: any): BudgetMetrics | null {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return null;
  const collections = new Map<string, unknown[]>();
  for (const key of FOLDED_COLLECTIONS) {
    const value = bundle[key];
    if (value === undefined) {
      collections.set(key, []);
      continue;
    }
    if (!Array.isArray(value) || value.length > MAX_SURFACE_DERIVATION_RECORDS) return null;
    collections.set(key, value);
  }

  const claims = collections.get("claims")!.length;
  const traces = collections.get("authorityTrace")!.length;
  let resolutionEvents = 0;
  const events = collections.get("events")!;
  for (let index = 0; index < events.length; index += 1) {
    if ((events[index] as any)?.resolvesDispute === true) resolutionEvents += 1;
  }

  const stack: unknown[] = [];
  for (const values of collections.values()) stack.push(values);
  const visited = new WeakSet<object>();
  let work = 0;
  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      if (value.length > MAX_SURFACE_DERIVATION_RECORDS - work) return null;
      work += value.length;
      for (let index = 0; index < value.length; index += 1) stack.push(value[index]);
      continue;
    }
    work += 1;
    if (work > MAX_SURFACE_DERIVATION_RECORDS) return null;
    if (!value || typeof value !== "object") continue;
    if (visited.has(value)) continue;
    visited.add(value);
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (work >= MAX_SURFACE_DERIVATION_RECORDS) return null;
      work += 1;
      stack.push((value as Record<string, unknown>)[key]);
    }
  }
  return { claims, traces, resolutionEvents, work };
}

export function surfaceDerivationWithinBudget(bundle: any): boolean {
  const metrics = boundedMetrics(bundle);
  return metrics !== null
    && metrics.claims * (metrics.work + 1) <= MAX_SURFACE_DERIVATION_PRODUCT
    && metrics.resolutionEvents * metrics.traces <= MAX_RESOLUTION_TRACE_COMPARISONS;
}
