const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/;

export interface ParsedRfc3339Timestamp {
  epochSecond: number;
  fractionalSecond: string;
}

export function parseRfc3339Timestamp(value: unknown): ParsedRfc3339Timestamp | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_TIMESTAMP.exec(value);
  if (!match) return null;

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const fractionalSecond = match[7] ?? "";
  const timezone = match[8];
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (timezone.toUpperCase() !== "Z") {
    const [offsetHour, offsetMinute] = timezone.slice(1).split(":").map(Number);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (timezone[0] === "-" ? -1 : 1) * ((offsetHour * 60) + offsetMinute);
  }

  const base = new Date(0);
  base.setUTCFullYear(year, month - 1, day);
  base.setUTCHours(hour, minute, second, 0);
  const epochSecond = (base.getTime() / 1000) - (offsetMinutes * 60);
  return Number.isFinite(epochSecond) ? { epochSecond, fractionalSecond } : null;
}

export function compareRfc3339Timestamps(left: ParsedRfc3339Timestamp, right: ParsedRfc3339Timestamp): number {
  if (left.epochSecond !== right.epochSecond) return left.epochSecond < right.epochSecond ? -1 : 1;
  const width = Math.max(left.fractionalSecond.length, right.fractionalSecond.length);
  const leftFraction = left.fractionalSecond.padEnd(width, "0");
  const rightFraction = right.fractionalSecond.padEnd(width, "0");
  if (leftFraction === rightFraction) return 0;
  return leftFraction < rightFraction ? -1 : 1;
}

function canonicalRfc3339Timestamp(value: unknown): unknown {
  if (typeof value !== "string" || parseRfc3339Timestamp(value) === null) return value;
  return value.replace("t", "T").replace("z", "Z");
}

function normalizeFields(record: any, fields: string[]) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return;
  for (const field of fields) {
    if (field in record) record[field] = canonicalRfc3339Timestamp(record[field]);
  }
}

function normalizeIntegrityAnchor(anchor: any) {
  normalizeFields(anchor, ["observedAt", "verifiedAt"]);
}

// Surface currently requires upper-case T/Z. Normalize only timestamp paths
// declared by the Hachure TrustBundle schema; unconstrained values and metadata
// remain byte-for-byte equivalent in the validation copy.
export function surfaceTimestampValidationView(value: unknown): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const bundle: any = structuredClone(value);

  for (const claim of bundle.claims ?? []) {
    normalizeFields(claim, ["createdAt", "updatedAt", "expiresAt"]);
    normalizeFields(claim.freshness, ["asOf", "expiresAt"]);
    normalizeIntegrityAnchor(claim.currentIntegrityAnchor);
  }
  for (const evidence of bundle.evidence ?? []) {
    normalizeFields(evidence, ["observedAt"]);
    normalizeIntegrityAnchor(evidence.integrityAnchor);
  }
  for (const event of bundle.events ?? []) {
    normalizeFields(event, ["createdAt", "verifiedAt"]);
  }
  for (const trace of bundle.authorityTrace ?? []) {
    normalizeFields(trace, ["observedAt", "validFrom", "validUntil", "revokedAt"]);
    normalizeIntegrityAnchor(trace.integrityAnchor);
  }

  return bundle;
}
