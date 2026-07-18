import { log as writeLog } from "../../observatorio/lib/logger.mjs";
import { sanitize } from "../../observatorio/lib/sanitize.mjs";

export const TELEMETRY_SCHEMA_VERSION = "ask_openclaw.telemetry.invocation.v1";

function isoTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError("timestamp must be a valid Date or date-compatible value");
  }
  return date.toISOString();
}

function safeString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return sanitize(value.trim());
}

function safeOptionalString(value) {
  if (value == null || value === "") return undefined;
  return sanitize(String(value));
}

function safeExitCode(value) {
  const code = Number(value);
  if (!Number.isInteger(code) || code < 0) {
    throw new TypeError("exitCode must be a non-negative integer");
  }
  return code;
}

function safeStderr(value) {
  if (value == null) return "";
  return sanitize(String(value));
}

export function buildInvocationRecord({
  agentId,
  exitCode,
  stderr = "",
  childSessionKey,
  runId,
  timestamp = new Date()
} = {}) {
  const record = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    timestamp: isoTimestamp(timestamp),
    agentId: safeString(agentId, "agentId"),
    exitCode: safeExitCode(exitCode),
    stderr: safeStderr(stderr)
  };
  const safeChildSessionKey = safeOptionalString(childSessionKey);
  const safeRunId = safeOptionalString(runId);
  if (safeChildSessionKey) record.childSessionKey = safeChildSessionKey;
  if (safeRunId) record.runId = safeRunId;
  return record;
}

export async function appendInvocationRecord(record, {
  logger = writeLog
} = {}) {
  const sanitized = sanitize(buildInvocationRecord(record));
  await logger("info", "ask_openclaw invocation", sanitized);
  return sanitized;
}

export async function logInvocation(invocation, options = {}) {
  return appendInvocationRecord(invocation, options);
}
