import assert from "node:assert/strict";
import test from "node:test";
import {
  TELEMETRY_SCHEMA_VERSION,
  buildInvocationRecord,
  logInvocation
} from "../lib/telemetry.mjs";

test("buildInvocationRecord keeps required invocation fields and optional provenance ids", () => {
  const record = buildInvocationRecord({
    timestamp: "2026-07-18T15:20:30.123Z",
    agentId: "neo",
    exitCode: 17,
    stderr: "falha controlada",
    childSessionKey: "agent:neo:subagent:00000000-0000-4000-8000-000000000000",
    runId: "agent:neo:subagent:00000000-0000-4000-8000-000000000000"
  });

  assert.deepEqual(record, {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    timestamp: "2026-07-18T15:20:30.123Z",
    agentId: "neo",
    exitCode: 17,
    stderr: "falha controlada",
    childSessionKey: "agent:neo:subagent:00000000-0000-4000-8000-000000000000",
    runId: "agent:neo:subagent:00000000-0000-4000-8000-000000000000"
  });
});

test("stderr and ids are sanitized before logging", async () => {
  const calls = [];
  const logger = async (level, message, meta) => {
    calls.push({ level, message, meta });
  };

  const record = await logInvocation({
    timestamp: "2026-07-18T15:20:30.000Z",
    agentId: "neo token=abc123",
    exitCode: 1,
    stderr: "Authorization: Bearer abc.def.ghi\napi_key=secret-value\n/Users/hermes/private.txt",
    childSessionKey: "agent:neo:subagent:000000000001",
    runId: "agent:neo:subagent:000000000001"
  }, { logger });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, "info");
  assert.equal(calls[0].message, "ask_openclaw invocation");
  assert.deepEqual(calls[0].meta, record);
  assert.equal(record.timestamp, "2026-07-18T15:20:30.000Z");
  assert.equal(record.agentId, "neo [REDACTED]");
  assert.equal(record.stderr.includes("[REDACTED]"), true);
  assert.equal(record.stderr.includes("secret-value"), false);
  assert.equal(record.stderr.includes("/Users/hermes"), false);
  assert.equal(record.childSessionKey, "agent:neo:subagent:000000000001");
});

test("buildInvocationRecord rejects missing agentId and invalid exitCode", () => {
  assert.throws(() => buildInvocationRecord({ exitCode: 0 }), /agentId/);
  assert.throws(() => buildInvocationRecord({ agentId: "neo", exitCode: -1 }), /exitCode/);
  assert.throws(() => buildInvocationRecord({ agentId: "neo", exitCode: 1.5 }), /exitCode/);
});
