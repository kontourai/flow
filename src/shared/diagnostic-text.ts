/** Maximum displayed diagnostic text length, including an explicit truncation marker. */
export const DIAGNOSTIC_TEXT_LIMIT = 1024;
export const SURFACE_GAP_LIMIT = 32;
const TRUNCATED = " [truncated]";

/**
 * Producer diagnostics are data, never terminal instructions or report lines.
 * Escape controls before bounding the display value. Stop scanning once the
 * bound is exceeded; retain complete code points/escape tokens before marking
 * truncation. Reapplying this to a stored display value is idempotent.
 */
export function diagnosticText(value: unknown): string {
  if (typeof value !== "string") return "[invalid diagnostic text]";
  let output = "";
  let markerEnd = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    const escaped = character === "\n" ? "\\n" : character === "\r" ? "\\r" : character === "\t" ? "\\t"
      : point < 0x20 || (point >= 0x7f && point <= 0x9f)
        || (point >= 0xd800 && point <= 0xdfff) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(character)
        ? point <= 0xffff ? `\\u${point.toString(16).padStart(4, "0")}` : `\\u{${point.toString(16)}}`
        : character;
    if (output.length + escaped.length > DIAGNOSTIC_TEXT_LIMIT) return output.slice(0, markerEnd) + TRUNCATED;
    output += escaped;
    if (output.length <= DIAGNOSTIC_TEXT_LIMIT - TRUNCATED.length) markerEnd = output.length;
  }
  return output;
}

/** Also bound legacy persisted gap diagnostics when projecting a JSON report. */
export function diagnosticPayload(value: any): any {
  if (!Array.isArray(value?.claim_evaluation)) return value;
  let remaining = SURFACE_GAP_LIMIT;
  let truncated = value.surface_gaps_truncated === true;
  const entries = value.claim_evaluation.map((entry: any) => {
    truncated ||= entry.surface_gaps_truncated === true;
    if (!Array.isArray(entry.surface_gaps)) return entry;
    const omitted = entry.surface_gaps.length > remaining || entry.surface_gaps_truncated === true;
    const gaps = entry.surface_gaps.slice(0, remaining).map((gap: any) => {
      const display = { ...gap };
      for (const field of ["id", "claim_id", "type", "message", "reason", "source"]) {
        if (display[field] !== undefined) display[field] = diagnosticText(display[field]);
      }
      return display;
    });
    remaining -= gaps.length;
    truncated ||= omitted;
    return { ...entry, surface_gaps: gaps, ...(omitted ? { surface_gaps_truncated: true } : {}) };
  });
  return { ...value, claim_evaluation: entries, ...(truncated ? { surface_gaps_truncated: true } : {}) };
}
