/**
 * Shared telemetry redaction for Manager and Worker evidence boundaries.
 * @version 0.1.0
 */

const REDACTED = "***REDACTED***";

const SECRET_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/("(?:api[_-]?key|token|secret|password|credential|authorization|auth)"\s*:\s*")[^"]+(")/gi, `$1${REDACTED}$2`],
  [/(api[_-]?key|token|secret|password)=([^&\s'"]+)/gi, "$1=***REDACTED***"],
  [/(Authorization:\s*(?:Bearer|token)\s+)[^\s'"]+/gi, "$1***REDACTED***"],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1***REDACTED***"],
  [/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/g, "$1***REDACTED***$3"],
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, REDACTED],
];

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized === "apikey"
    || normalized.endsWith("apikey")
    || normalized === "token"
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("approvaltoken")
    || normalized === "secret"
    || normalized.endsWith("clientsecret")
    || normalized === "password"
    || normalized === "credential"
    || normalized === "authorization"
    || normalized === "auth";
}

export function redactTelemetry(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let redacted = value;
    for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
      redacted = redacted.replace(pattern, replacement);
    }
    return redacted.length > 4000 ? `${redacted.slice(0, 4000)}...` : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactTelemetry(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = isSecretKey(key)
        ? REDACTED
        : redactTelemetry(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}
