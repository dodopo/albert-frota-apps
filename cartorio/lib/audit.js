import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize } from './canonical-json.js';
import { ZERO_HASH, LEDGER_RECORD_VERSION } from './ledger-store.js';
import { defaultKeyringPath, defaultPrivateKeyPath } from './keyring.js';
import { readReceipt, receiptPathForMission, verifyReceipt } from './receipt.js';
import { nextState, STATES } from './state-machine.js';

export const AUDIT_STATUSES = {
  RECEIPT_VALID: 'receipt-valid',
  BREAK_GLASS_VALID: 'break-glass-valid',
  FAIL: 'fail'
};

export const AUDIT_FINDING_SEVERITY = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info'
};

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LEDGER = '/Users/cartorio/ledger/missoes.jsonl';
const DEFAULT_SOCKET = '/Users/cartorio/run/ledgerd.sock';
const DEFAULT_SESSIONS_ROOT = join(appRoot, 'fixtures', 'openclaw-agents');
const AGENT_RUN_ID = /^agent:([^:]+):subagent:([0-9a-fA-F-]{12,})$/;
const HUMAN_RUN_ID = /^human:[^:]+$/;
const MANUAL_RUN_ID = /^manual:.+$/;
const HEX_64 = /^[0-9a-f]{64}$/;

const LEDGER_RECORD_FIELDS = [
  'version',
  'seq',
  'prevHash',
  'eventId',
  'eventType',
  'missaoId',
  'idempotencyKey',
  'payloadHash',
  'payload',
  'actorUid',
  'actor',
  'claimedActorUid',
  'runId',
  'runIdDeclarado',
  'runIdVerificado',
  'runIdStatus',
  'ts',
  'stateBefore',
  'stateAfter',
  'codeManifestHash',
  'buildId',
  'hash'
];

export async function auditLocalRepository(options = {}) {
  const config = auditConfig(options);
  const ctx = {
    config,
    findings: [],
    warnings: [],
    records: [],
    head: { ledgerSeq: 0, ledgerHeadHash: ZERO_HASH },
    missions: new Map(),
    runIds: new Map(),
    receipts: [],
    provenance: []
  };

  await auditOrphans(ctx);
  await auditPermissions(ctx);
  await auditLedger(ctx);
  await auditSnapshots(ctx);
  await auditReceipts(ctx);
  await auditRunIds(ctx);
  await reconcileBreakGlass(ctx);

  const errors = ctx.findings.filter((finding) => finding.severity === AUDIT_FINDING_SEVERITY.ERROR);
  const status = errors.length === 0 ? AUDIT_STATUSES.RECEIPT_VALID : AUDIT_STATUSES.FAIL;
  return {
    ok: errors.length === 0,
    status,
    ledger: {
      path: config.ledgerPath,
      records: ctx.records.length,
      head: ctx.head
    },
    sessions: {
      root: config.sessionsRoot,
      downgrade: ctx.findings.some((finding) => finding.code === 'SOURCE_UNAVAILABLE')
    },
    receipts: ctx.receipts,
    provenance: ctx.provenance,
    findings: ctx.findings,
    summary: summarize(ctx.findings)
  };
}

export async function reconcileBreakGlass(ctxOrOptions = {}) {
  const ctx = ctxOrOptions.findings ? ctxOrOptions : {
    config: auditConfig(ctxOrOptions),
    findings: []
  };
  let entries = [];
  try {
    entries = await readdir(ctx.config.breakGlassDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    addFinding(ctx, 'BREAK_GLASS_READ_FAILED', 'error', 'falha ao ler diretorio de break-glass', {
      path: ctx.config.breakGlassDir,
      cause: error.code ?? error.message
    });
    return [];
  }
  const pending = entries.filter((entry) => entry.endsWith('.json'));
  for (const entry of pending) {
    addFinding(ctx, 'BREAK_GLASS_PENDING_RECONCILIATION', 'warning', 'break-glass pendente de reconciliacao no ledger', {
      path: join(ctx.config.breakGlassDir, entry)
    });
  }
  return pending;
}

export function formatAuditReport(report) {
  const lines = [];
  lines.push(`missao audit: ${report.ok ? 'LIMPO' : 'REPROVADO'} (${report.status})`);
  lines.push(`ledger: ${report.ledger.path}`);
  lines.push(`cabeca: seq=${report.ledger.head.ledgerSeq} hash=${report.ledger.head.ledgerHeadHash}`);
  lines.push(`achados: ${report.summary.error} erro(s), ${report.summary.warning} aviso(s), ${report.summary.info} info`);
  if (report.sessions.downgrade) {
    lines.push('sessions.json: SOURCE_UNAVAILABLE; proveniencia rebaixada para nao-verificada');
  }
  if (report.provenance.length > 0) {
    lines.push('proveniencia:');
    for (const item of report.provenance) {
      lines.push(`  - ${item.runId}: ${item.proveniencia}${item.agentId ? ` (${item.agentId})` : ''}`);
    }
  }
  if (report.receipts.length > 0) {
    lines.push('receipts:');
    for (const receipt of report.receipts) {
      lines.push(`  - ${receipt.missaoId}: ${receipt.status}`);
    }
  }
  if (report.findings.length > 0) {
    lines.push('achados:');
    for (const finding of report.findings) {
      lines.push(`  - [${finding.severity}] ${finding.code}: ${finding.message}${finding.seq ? ` (seq ${finding.seq})` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function auditConfig(options) {
  const ledgerPath = options.ledgerPath ?? process.env.CARTORIO_LEDGER_PATH ?? DEFAULT_LEDGER;
  return {
    ledgerPath,
    statePath: options.statePath ?? process.env.CARTORIO_LEDGER_STATE_PATH ?? `${ledgerPath}.head.json`,
    snapshotDir: options.snapshotDir ?? process.env.CARTORIO_LEDGER_SNAPSHOT_DIR ?? join(dirname(ledgerPath), 'snapshots'),
    socketPath: options.socketPath ?? process.env.CARTORIO_LEDGERD_SOCKET ?? DEFAULT_SOCKET,
    receiptDir: options.receiptDir ?? process.env.CARTORIO_RECEIPT_DIR ?? null,
    keyringPath: options.keyringPath ?? process.env.CARTORIO_KEYRING_PATH ?? defaultKeyringPath(),
    privateKeyPath: options.privateKeyPath ?? process.env.CARTORIO_LEDGERD_KEY_PATH ?? defaultPrivateKeyPath(),
    sessionsRoot: options.sessionsRoot ?? process.env.CARTORIO_SESSIONS_ROOT ?? DEFAULT_SESSIONS_ROOT,
    sessionsPath: options.sessionsPath ?? process.env.CARTORIO_SESSIONS_JSON ?? null,
    breakGlassDir: options.breakGlassDir ?? process.env.CARTORIO_BREAK_GLASS_DIR ?? join(appRoot, '.cartorio', 'break-glass')
  };
}

async function auditLedger(ctx) {
  let text;
  try {
    text = await readFile(ctx.config.ledgerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    addFinding(ctx, 'LEDGER_READ_FAILED', 'error', 'falha ao ler ledger', { cause: error.code ?? error.message });
    return;
  }
  if (text.length === 0) {
    return;
  }
  if (!text.endsWith('\n')) {
    addFinding(ctx, 'LEDGER_TRUNCATED', 'error', 'ledger truncado: JSONL nao termina em LF');
    return;
  }

  const lines = text.split('\n').filter(Boolean);
  let expectedSeq = 1;
  let previousHash = ZERO_HASH;
  const idempotency = new Map();

  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      addFinding(ctx, 'LEDGER_BAD_JSON', 'error', 'JSONL ruim detectado no ledger', {
        line: index + 1,
        cause: error.message
      });
      continue;
    }
    ctx.records.push(record);
    validateRecordSchema(ctx, record, index + 1);
    if (record.seq !== expectedSeq) {
      addFinding(ctx, 'LEDGER_SEQ_GAP', 'error', 'seq monotônico com gap ou regressao', {
        seq: record.seq,
        expectedSeq,
        actualSeq: record.seq
      });
    }
    if (record.prevHash !== previousHash) {
      addFinding(ctx, 'LEDGER_CHAIN_BROKEN', 'error', 'hash encadeado divergente', {
        seq: record.seq,
        expectedPrevHash: previousHash,
        actualPrevHash: record.prevHash
      });
    }
    const computed = hashRecord(stripHash(record));
    if (record.hash !== computed) {
      addFinding(ctx, 'LEDGER_HASH_MISMATCH', 'error', 'hash de linha divergente', {
        seq: record.seq,
        expectedHash: computed,
        actualHash: record.hash
      });
    }

    const before = ctx.missions.get(record.missaoId) ?? STATES.INEXISTENTE;
    try {
      const after = nextState(before, record.eventType);
      if (record.stateBefore !== before || record.stateAfter !== after) {
        addFinding(ctx, 'LEDGER_STATE_MISMATCH', 'error', 'snapshot de estado no evento diverge da maquina', {
          seq: record.seq,
          expectedBefore: before,
          expectedAfter: after,
          actualBefore: record.stateBefore,
          actualAfter: record.stateAfter
        });
      }
      ctx.missions.set(record.missaoId, after);
    } catch (error) {
      addFinding(ctx, 'LEDGER_STATE_INVALID', 'error', error.message, { seq: record.seq });
    }

    const idemKey = `${record.missaoId}\u0000${record.idempotencyKey}`;
    if (idempotency.has(idemKey)) {
      addFinding(ctx, 'IDEMPOTENCY_REPLAY', 'error', 'idempotencyKey duplicada no ledger', {
        seq: record.seq,
        firstSeq: idempotency.get(idemKey).seq,
        idempotencyKey: record.idempotencyKey
      });
    } else {
      idempotency.set(idemKey, record);
    }
    if (typeof record.runId === 'string' && record.runId.length > 0) {
      ctx.runIds.set(record.runId, record);
    }
    previousHash = typeof record.hash === 'string' ? record.hash : previousHash;
    expectedSeq += 1;
  }

  ctx.head = { ledgerSeq: ctx.records.length, ledgerHeadHash: previousHash };
  await auditHeadState(ctx);
}

function validateRecordSchema(ctx, record, line) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    addFinding(ctx, 'LEDGER_SCHEMA_CLOSED', 'error', 'registro de ledger nao e objeto', { line });
    return;
  }
  const allowed = new Set(LEDGER_RECORD_FIELDS);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      addFinding(ctx, 'LEDGER_SCHEMA_CLOSED', 'error', 'campo inesperado no schema fechado do ledger', {
        line,
        field: key
      });
    }
  }
  for (const key of LEDGER_RECORD_FIELDS) {
    if (!(key in record)) {
      addFinding(ctx, 'LEDGER_SCHEMA_CLOSED', 'error', 'campo obrigatorio ausente no ledger', {
        line,
        field: key
      });
    }
  }
  if (record.version !== LEDGER_RECORD_VERSION) {
    addFinding(ctx, 'LEDGER_BAD_RECORD', 'error', 'version de registro invalida', { line, version: record.version });
  }
  if (!Number.isInteger(record.seq) || record.seq < 1) {
    addFinding(ctx, 'LEDGER_SCHEMA_CLOSED', 'error', 'seq invalido', { line, seq: record.seq });
  }
  for (const field of ['prevHash', 'payloadHash', 'hash']) {
    if (typeof record[field] !== 'string' || !HEX_64.test(record[field])) {
      addFinding(ctx, 'LEDGER_SCHEMA_CLOSED', 'error', `${field} invalido`, { line, field });
    }
  }
  if (record.codeManifestHash != null && (typeof record.codeManifestHash !== 'string' || !HEX_64.test(record.codeManifestHash))) {
    addFinding(ctx, 'LEDGER_SCHEMA_CLOSED', 'error', 'codeManifestHash invalido', { line });
  }
}

async function auditHeadState(ctx) {
  let state;
  try {
    state = JSON.parse(await readFile(ctx.config.statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && ctx.head.ledgerSeq === 0) {
      return;
    }
    addFinding(ctx, error.code === 'ENOENT' ? 'LEDGER_HEAD_MISSING' : 'LEDGER_HEAD_INVALID', 'error', 'estado anti-rollback ausente ou invalido', {
      path: ctx.config.statePath,
      cause: error.code ?? error.message
    });
    return;
  }
  if (state.ledgerSeq !== ctx.head.ledgerSeq || state.ledgerHeadHash !== ctx.head.ledgerHeadHash) {
    addFinding(ctx, state.ledgerSeq > ctx.head.ledgerSeq ? 'LEDGER_TRUNCATED' : 'LEDGER_ROLLBACK_DETECTED', 'error', 'cabeca anti-rollback diverge do ledger', {
      stateHead: { ledgerSeq: state.ledgerSeq, ledgerHeadHash: state.ledgerHeadHash },
      actualHead: ctx.head
    });
  }
}

async function auditReceipts(ctx) {
  const verifiedRecords = ctx.records.filter((record) => record.stateAfter === STATES.VERIFICADA);
  for (const record of verifiedRecords) {
    const delivery = findLastBefore(ctx.records, record, 'missao.entregue');
    const receiptDir = ctx.config.receiptDir ?? (
      delivery?.payload?.cartorioRepoRoot ? join(delivery.payload.cartorioRepoRoot, '.cartorio', 'missoes') : null
    );
    const receiptPath = receiptDir ? receiptPathForMission(receiptDir, record.missaoId) : null;
    if (!receiptPath) {
      ctx.receipts.push({ missaoId: record.missaoId, status: 'missing', path: null });
      addFinding(ctx, 'RECEIPT_MISSING', 'error', 'receipt ausente para missao verificada', {
        missaoId: record.missaoId,
        seq: record.seq
      });
      continue;
    }
    try {
      await access(receiptPath, fsConstants.R_OK);
    } catch {
      ctx.receipts.push({ missaoId: record.missaoId, status: 'missing', path: receiptPath });
      addFinding(ctx, 'RECEIPT_MISSING', 'error', 'receipt ausente para missao verificada', {
        missaoId: record.missaoId,
        path: receiptPath,
        seq: record.seq
      });
      continue;
    }
    try {
      const receipt = await readReceipt(receiptPath);
      await verifyReceipt(receipt, {
        keyringPath: ctx.config.keyringPath,
        currentHead: delivery ? {
          ledgerSeq: delivery.seq,
          ledgerHeadHash: delivery.hash
        } : ctx.head,
        expectedParentCommit: delivery?.payload?.parentCommit ?? record.payload?.parentCommit,
        expectedTreeScope: delivery?.payload?.treeScope ?? record.payload?.treeScope,
        expectedTreeHashExcludingReceipts: delivery?.payload?.treeHashExcludingReceipts ?? record.payload?.treeHashExcludingReceipts,
        expectedArtifacts: normalizeReceiptArtifacts(delivery?.payload?.artefatos ?? record.payload?.artefatos ?? [])
      });
      ctx.receipts.push({ missaoId: record.missaoId, status: 'valid', path: receiptPath });
    } catch (error) {
      const code = error.code === 'RECEIPT_STALE_HEAD' ? 'RECEIPT_STALE' : 'RECEIPT_INVALID';
      ctx.receipts.push({ missaoId: record.missaoId, status: 'invalid', path: receiptPath, code: error.code ?? error.name });
      addFinding(ctx, code, 'error', error.message, {
        missaoId: record.missaoId,
        path: receiptPath,
        rawCode: error.code ?? error.name
      });
    }
  }
}

function normalizeReceiptArtifacts(artifacts) {
  return artifacts.map((artifact) => ({
    path: artifact.path,
    blobSha256: artifact.blobSha256
  }));
}

async function auditRunIds(ctx) {
  for (const [runId, record] of ctx.runIds) {
    const parsed = parseRunId(runId);
    if (parsed.kind === 'manual' || parsed.kind === 'human') {
      ctx.provenance.push({ runId, proveniencia: 'nao-verificada', reason: parsed.kind });
      continue;
    }
    if (parsed.kind !== 'agent') {
      addFinding(ctx, 'RUNID_INVALID', 'error', 'runId fora do formato contratado', { runId, seq: record.seq });
      ctx.provenance.push({ runId, proveniencia: 'nao-verificada', reason: 'invalid' });
      continue;
    }
    await reconcileAgentRunId(ctx, runId, parsed.agentId, record);
  }
}

async function reconcileAgentRunId(ctx, runId, agentId, record) {
  const sessionsPath = sessionsPathFor(ctx.config, agentId);
  let sessions;
  try {
    sessions = JSON.parse(await readFile(sessionsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      addFinding(ctx, 'SOURCE_UNAVAILABLE', 'warning', 'sessions.json ausente; proveniencia rebaixada explicitamente', {
        source: 'sessions.json',
        path: sessionsPath,
        runId
      });
      ctx.provenance.push({ runId, agentId, proveniencia: 'nao-verificada', reason: 'SOURCE_UNAVAILABLE' });
      return;
    }
    addFinding(ctx, 'SESSIONS_TAMPERED', 'error', 'sessions.json nao parseia ou nao pode ser lido', {
      path: sessionsPath,
      runId,
      cause: error.message
    });
    ctx.provenance.push({ runId, agentId, proveniencia: 'nao-verificada', reason: 'SESSIONS_TAMPERED' });
    return;
  }
  const entry = sessions?.[runId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    addFinding(ctx, 'RUNID_AGENT_NOT_FOUND', 'error', 'runId agent nao encontrado em sessions.json', {
      runId,
      agentId,
      path: sessionsPath,
      seq: record.seq
    });
    ctx.provenance.push({ runId, agentId, proveniencia: 'nao-verificada', reason: 'not-found' });
    return;
  }
  const expectedFile = sessionFileFor(sessionsPath, entry);
  try {
    await assertSafeSessionFile(expectedFile);
    ctx.provenance.push({ runId, agentId, proveniencia: 'verificada', sessionFile: expectedFile });
  } catch (error) {
    addFinding(ctx, 'SESSIONS_TAMPERED', 'error', 'registro de sessions.json aponta sessao contradita por open/fstat seguro', {
      runId,
      agentId,
      path: sessionsPath,
      sessionFile: expectedFile,
      cause: error.code ?? error.message
    });
    ctx.provenance.push({ runId, agentId, proveniencia: 'nao-verificada', reason: 'SESSIONS_TAMPERED' });
  }
}

async function assertSafeSessionFile(sessionFile) {
  if (!sessionFile) {
    throw Object.assign(new Error('sessionId/sessionFile ausente'), { code: 'SESSION_FILE_MISSING' });
  }
  const handle = await open(sessionFile, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw Object.assign(new Error('session file nao e arquivo regular'), { code: 'SESSION_FILE_NOT_FILE' });
    }
  } finally {
    await handle.close();
  }
}

async function auditSnapshots(ctx) {
  let entries = [];
  try {
    entries = await readdir(ctx.config.snapshotDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    addFinding(ctx, 'SNAPSHOT_READ_FAILED', 'error', 'falha ao ler snapshots', {
      path: ctx.config.snapshotDir,
      cause: error.code ?? error.message
    });
    return;
  }
  for (const entry of entries.filter((name) => name.endsWith('.json'))) {
    const snapshotPath = join(ctx.config.snapshotDir, entry);
    try {
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
      if (snapshot.schema !== 'cartorio.ledger-snapshot/v1') {
        throw new Error('schema invalido');
      }
      if (snapshot.head?.ledgerSeq > ctx.head.ledgerSeq) {
        addFinding(ctx, 'SNAPSHOT_AHEAD_OF_LEDGER', 'error', 'snapshot aponta cabeca futura ao ledger', {
          path: snapshotPath,
          snapshotHead: snapshot.head,
          ledgerHead: ctx.head
        });
      }
      if (snapshot.head?.ledgerSeq === ctx.head.ledgerSeq && snapshot.head?.ledgerHeadHash !== ctx.head.ledgerHeadHash) {
        addFinding(ctx, 'SNAPSHOT_HEAD_MISMATCH', 'error', 'snapshot diverge da cabeca atual', {
          path: snapshotPath,
          snapshotHead: snapshot.head,
          ledgerHead: ctx.head
        });
      }
    } catch (error) {
      addFinding(ctx, 'SNAPSHOT_INVALID', 'error', 'snapshot invalido', {
        path: snapshotPath,
        cause: error.message
      });
    }
  }
}

async function auditOrphans(ctx) {
  let entries = [];
  try {
    entries = await readdir(dirname(ctx.config.ledgerPath));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    addFinding(ctx, 'LEDGER_DIR_READ_FAILED', 'error', 'falha ao ler diretorio do ledger', { cause: error.code ?? error.message });
    return;
  }
  const prefix = `${basename(ctx.config.ledgerPath)}.tmp-`;
  for (const entry of entries) {
    if (entry.startsWith(prefix)) {
      addFinding(ctx, 'TMP_ORPHAN', 'error', 'tmp atomico orfao encontrado', {
        path: join(dirname(ctx.config.ledgerPath), entry)
      });
    }
  }
}

async function auditPermissions(ctx) {
  await expectMode(ctx, ctx.config.ledgerPath, 0o600, 'LEDGER_PERMISSION_OPEN', 'ledger precisa ser 600', { optionalEmptyLedger: true });
  await expectMode(ctx, ctx.config.statePath, 0o600, 'LEDGER_STATE_PERMISSION_OPEN', 'estado anti-rollback precisa ser 600', { optional: true });
  await expectMode(ctx, ctx.config.snapshotDir, 0o700, 'SNAPSHOT_PERMISSION_OPEN', 'diretorio de snapshots precisa ser 700', { optional: true, directory: true });
  await expectMode(ctx, ctx.config.privateKeyPath, 0o600, 'KEY_PERMISSION_OPEN', 'chave privada precisa ser 600', { optional: true });
  await expectMode(ctx, dirname(ctx.config.privateKeyPath), 0o700, 'KEY_PERMISSION_OPEN', 'diretorio da chave precisa ser 700', { optional: true, directory: true });
  await expectSocketMode(ctx, ctx.config.socketPath);
}

async function expectMode(ctx, path, expected, code, message, { optional = false, optionalEmptyLedger = false, directory = false } = {}) {
  try {
    const stats = await stat(path);
    const mode = stats.mode & 0o777;
    if (directory && !stats.isDirectory()) {
      addFinding(ctx, code, 'error', `${message}: nao e diretorio`, { path });
      return;
    }
    if (!directory && !stats.isFile()) {
      addFinding(ctx, code, 'error', `${message}: nao e arquivo`, { path });
      return;
    }
    if (mode !== expected) {
      addFinding(ctx, code, 'error', message, { path, expected: octal(expected), actual: octal(mode) });
    }
  } catch (error) {
    if (error.code === 'ENOENT' && (optional || optionalEmptyLedger)) {
      return;
    }
    addFinding(ctx, code, 'error', `${message}: caminho ausente/inacessivel`, { path, cause: error.code ?? error.message });
  }
}

async function expectSocketMode(ctx, socketPath) {
  try {
    const stats = await stat(socketPath);
    const mode = stats.mode & 0o777;
    if ((mode & 0o007) !== 0) {
      addFinding(ctx, 'SOCKET_PERMISSION_OPEN', 'error', 'socket UDS com permissao aberta a outros', {
        path: socketPath,
        actual: octal(mode)
      });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      addFinding(ctx, 'SOCKET_PERMISSION_OPEN', 'error', 'socket UDS inacessivel para auditoria', {
        path: socketPath,
        cause: error.code ?? error.message
      });
    }
  }
}

function parseRunId(runId) {
  const agent = AGENT_RUN_ID.exec(runId);
  if (agent) {
    return { kind: 'agent', agentId: agent[1], childSessionKey: runId };
  }
  if (HUMAN_RUN_ID.test(runId)) {
    return { kind: 'human' };
  }
  if (MANUAL_RUN_ID.test(runId)) {
    return { kind: 'manual' };
  }
  return { kind: 'invalid' };
}

function sessionsPathFor(config, agentId) {
  if (config.sessionsPath) {
    return config.sessionsPath.includes('{agentId}')
      ? config.sessionsPath.replaceAll('{agentId}', agentId)
      : config.sessionsPath;
  }
  return join(config.sessionsRoot, agentId, 'sessions', 'sessions.json');
}

function sessionFileFor(sessionsPath, entry) {
  if (typeof entry.sessionFile === 'string' && entry.sessionFile.length > 0) {
    return resolve(entry.sessionFile);
  }
  if (typeof entry.sessionId === 'string' && entry.sessionId.length > 0) {
    return join(dirname(sessionsPath), `${entry.sessionId}.jsonl`);
  }
  return null;
}

function findLastBefore(records, record, eventType) {
  for (let index = records.indexOf(record) - 1; index >= 0; index -= 1) {
    if (records[index].missaoId === record.missaoId && records[index].eventType === eventType) {
      return records[index];
    }
  }
  return null;
}

function hashRecord(recordWithoutHash) {
  return createHash('sha256').update(canonicalize(recordWithoutHash), 'utf8').digest('hex');
}

function stripHash(record) {
  const stripped = { ...record };
  delete stripped.hash;
  return stripped;
}

function addFinding(ctx, code, severity, message, details = {}) {
  ctx.findings.push({
    code,
    severity,
    message,
    ...compact(details)
  });
}

function summarize(findings) {
  const out = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    out[finding.severity] = (out[finding.severity] ?? 0) + 1;
  }
  return out;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function octal(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`;
}
