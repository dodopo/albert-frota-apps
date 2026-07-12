const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(?:token|api[_-]?key|secret|password|authorization|cookie)\s*[:=]\s*["']?[^"',\s}]+/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /\/Users\/(?!openclaw(?:\/|$))[^/\s"']+(?:\/[^\s"']*)?/g,
  /\b[A-Za-z0-9._%+-]+:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\b/g
];

const DENY_KEYS = new Set([
  "token",
  "tokens",
  "apiKey",
  "api_key",
  "secret",
  "password",
  "authorization",
  "cookie",
  "env",
  "environment",
  "messages",
  "conversation",
  "content",
  "sessionFile",
  "path",
  "home"
]);

export function redactString(value) {
  let out = String(value);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

export function sanitize(value, depth = 0) {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (DENY_KEYS.has(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[redactString(key)] = sanitize(item, depth + 1);
      }
    }
    return out;
  }
  return redactString(String(value));
}

export function jsonSafe(value) {
  return JSON.stringify(sanitize(value));
}

export function publicError(source, code, message) {
  return sanitize({
    source,
    code,
    message
  });
}
