// #region redact
/**
 * Applied to everything that leaves the gateway as telemetry. Prompts and
 * completions contain whatever users typed, so treat them as personal data
 * by default. Patterns are deliberately broad: a false positive costs a
 * slightly less useful log line, a false negative costs an incident.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, '[secret]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [secret]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[card]'],
  [/\b(?:19|20)?\d{6}[-+]?\d{4}\b/g, '[national-id]'],
  [/\+?\d[\d\s().-]{7,}\d/g, '[phone]'],
];

export function redact(text: string): string {
  return PATTERNS.reduce((s, [re, replacement]) => s.replace(re, replacement), text);
}
// #endregion redact
