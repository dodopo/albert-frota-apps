import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalize } from '../lib/canonical-json.js';
import { auditLocalRepository } from '../lib/audit.js';
import { createLedgerStore } from '../lib/ledger-store.js';
import { receiptPathForMission } from '../lib/receipt.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uid = process.getuid?.() ?? 501;
const runId = 'agent:neo:subagent:audit-00000000-0000-4000-8000-000000000001';
const missingRunId = 'agent:neo:subagent:audit-00000000-0000-4000-8000-000000000002';
const humanRunId = `human:${uid}`;
const parentCommit = 'a'.repeat(40);
const treeScope = 'cartorio.git-tree.v1:app-files-excluding-mission-receipts';
const treeHashExcludingReceipts = 'd'.repeat(64);
const artifact = { path: 'package.json', blobSha256: 'b'.repeat(64) };
const codeManifestHash = 'c'.repeat(64);

async function tempCase(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-audit-${name}-`));
  const t = {
    dir,
    ledgerPath: join(dir, 'ledger', 'missoes.jsonl'),
    statePath: join(dir, 'ledger', 'missoes.jsonl.head.json'),
    snapshotDir: join(dir, 'ledger', 'snapshots'),
    socketPath: join(dir, 'run', 'ledgerd.sock'),
    receiptDir: join(dir, '.cartorio', 'missoes'),
    keyringPath: join(dir, '.cartorio', 'keys', 'keyring.json'),
    privateKeyPath: join(dir, 'keys-private', 'ledgerd.ed25519.pem'),
    sessionsRoot: join(dir, 'agents'),
    breakGlassDir: join(dir, '.cartorio', 'break-glass'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
  await mkdir(dirname(t.ledgerPath), { recursive: true, mode: 0o700 });
  await mkdir(t.snapshotDir, { recursive: true, mode: 0o700 });
  await mkdir(t.breakGlassDir, { recursive: true, mode: 0o700 });
  await mkdir(dirname(t.privateKeyPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(t.privateKeyPath), 0o700);
  return t;
}

function storeFor(t) {
  return createLedgerStore({
    ledgerPath: t.ledgerPath,
    statePath: t.statePath,
    snapshotDir: t.snapshotDir,
    receiptDir: t.receiptDir,
    keyringPath: t.keyringPath,
    privateKeyPath: t.privateKeyPath,
    codeManifestHash,
    buildId: 'audit-test'
  });
}

function request(command, missaoId, idempotencyKey, payload = {}, id = runId) {
  return {
    command,
    missaoId,
    idempotencyKey,
    actorUid: uid,
    runId: id,
    payload: { missaoId, ...payload }
  };
}

async function writeSessions(t, entries = { [runId]: 'session-ok' }) {
  const sessionsDir = join(t.sessionsRoot, 'neo', 'sessions');
  await mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  const sessions = {};
  for (const [key, sessionId] of Object.entries(entries)) {
    sessions[key] = {
      sessionId,
      updatedAt: Date.now(),
      lastInteractionAt: Date.now()
    };
    await writeFile(join(sessionsDir, `${sessionId}.jsonl`), `${JSON.stringify({ key })}\n`, 'utf8');
  }
  await writeFile(join(sessionsDir, 'sessions.json'), `${JSON.stringify(sessions, null, 2)}\n`, 'utf8');
}

async function buildVerifiedLedger(t, id = runId) {
  const store = storeFor(t);
  await store.append(request('abrir', 'm-audit', 'open', { assunto: 'audit' }, id));
  await store.append(request('entregar', 'm-audit', 'deliver', {
    parentCommit,
    treeScope,
    treeHashExcludingReceipts,
    artefatos: [artifact]
  }, id));
  await store.append(request('coletar', 'm-audit', 'collect', { confirmacao: 'ok' }, id));
}

async function report(t, overrides = {}) {
  return auditLocalRepository({
    ledgerPath: t.ledgerPath,
    statePath: t.statePath,
    snapshotDir: t.snapshotDir,
    receiptDir: t.receiptDir,
    keyringPath: t.keyringPath,
    privateKeyPath: t.privateKeyPath,
    sessionsRoot: t.sessionsRoot,
    socketPath: t.socketPath,
    breakGlassDir: t.breakGlassDir,
    ...overrides
  });
}

function codes(result) {
  return result.findings.map((finding) => finding.code);
}

function hashRecord(recordWithoutHash) {
  return createHash('sha256').update(canonicalize(recordWithoutHash), 'utf8').digest('hex');
}

async function rewriteLedger(t, mutate) {
  const records = (await readFile(t.ledgerPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  mutate(records);
  await writeFile(t.ledgerPath, `${records.map((record) => canonicalize(record)).join('\n')}\n`, 'utf8');
  await chmod(t.ledgerPath, 0o600);
}

test('gate passo8: ledger limpo com receipt e runId agent verificado passa', async () => {
  const t = await tempCase('clean');
  try {
    await writeSessions(t);
    await buildVerifiedLedger(t);
    const result = await report(t);
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
    assert.equal(result.provenance[0].proveniencia, 'verificada');
    assert.equal(result.receipts[0].status, 'valid');
  } finally {
    await t.cleanup();
  }
});

test('gate passo8: corrupcoes de ledger sao achados nao-zero', async () => {
  const cases = [
    ['gap', 'LEDGER_SEQ_GAP', async (t) => rewriteLedger(t, (records) => { records[1].seq = 7; })],
    ['hash', 'LEDGER_HASH_MISMATCH', async (t) => rewriteLedger(t, (records) => { records[0].missaoId = 'm-tampered'; })],
    ['schema', 'LEDGER_SCHEMA_CLOSED', async (t) => rewriteLedger(t, (records) => { records[0].campoExtra = true; })],
    ['bad-json', 'LEDGER_BAD_JSON', async (t) => writeFile(t.ledgerPath, '{bad-json}\n', 'utf8')],
    ['truncated', 'LEDGER_TRUNCATED', async (t) => writeFile(t.ledgerPath, (await readFile(t.ledgerPath, 'utf8')).trimEnd(), 'utf8')],
    ['tmp', 'TMP_ORPHAN', async (t) => writeFile(join(dirname(t.ledgerPath), 'missoes.jsonl.tmp-crash'), 'partial', 'utf8')],
    ['ledger-perms', 'LEDGER_PERMISSION_OPEN', async (t) => chmod(t.ledgerPath, 0o644)],
    ['key-perms', 'KEY_PERMISSION_OPEN', async (t) => chmod(t.privateKeyPath, 0o644)],
    ['socket-perms', 'SOCKET_PERMISSION_OPEN', async (t) => {
      await mkdir(dirname(t.socketPath), { recursive: true });
      await writeFile(t.socketPath, 'not-a-real-socket-for-mode-audit', 'utf8');
      await chmod(t.socketPath, 0o666);
    }],
    ['snapshot', 'SNAPSHOT_AHEAD_OF_LEDGER', async (t) => {
      await writeFile(join(t.snapshotDir, 'ledger-future.json'), `${JSON.stringify({
        schema: 'cartorio.ledger-snapshot/v1',
        head: { ledgerSeq: 99, ledgerHeadHash: 'f'.repeat(64) },
        missions: {}
      })}\n`, 'utf8');
    }]
  ];

  for (const [name, expectedCode, corrupt] of cases) {
    const t = await tempCase(name);
    try {
      await writeSessions(t);
      await buildVerifiedLedger(t);
      await corrupt(t);
      const result = await report(t);
      assert.equal(result.ok, false, `${name} deveria reprovar`);
      assert.ok(codes(result).includes(expectedCode), `${name}: ${codes(result).join(', ')}`);
    } finally {
      await t.cleanup();
    }
  }
});

test('gate passo10: escrita direta no ledger sem ledgerd e detectada pelo anti-rollback', async () => {
  const t = await tempCase('direct-ledger-write');
  try {
    await writeSessions(t);
    await buildVerifiedLedger(t);
    const records = (await readFile(t.ledgerPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const previous = records.at(-1);
    const direct = {
      version: previous.version,
      seq: previous.seq + 1,
      prevHash: previous.hash,
      eventId: '00000000-0000-4000-8000-000000000010',
      eventType: 'missao.aberta',
      missaoId: 'm-direct-ledger-write',
      idempotencyKey: 'direct-open',
      payloadHash: 'f'.repeat(64),
      payload: { missaoId: 'm-direct-ledger-write' },
      actorUid: uid,
      actor: `uid:${uid}`,
      claimedActorUid: uid,
      runId,
      ts: '2026-07-16T18:00:00.000Z',
      stateBefore: 'inexistente',
      stateAfter: 'aberta',
      codeManifestHash,
      buildId: 'audit-test'
    };
    direct.hash = hashRecord(direct);
    await writeFile(t.ledgerPath, `${records.map((record) => canonicalize(record)).join('\n')}\n${canonicalize(direct)}\n`, 'utf8');
    await chmod(t.ledgerPath, 0o600);

    const result = await report(t);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('LEDGER_ROLLBACK_DETECTED'), codes(result).join(', '));
  } finally {
    await t.cleanup();
  }
});

test('gate passo8: receipts ausente, invalido e stale reprovam', async () => {
  const missing = await tempCase('receipt-missing');
  try {
    await writeSessions(missing);
    await buildVerifiedLedger(missing);
    await unlink(receiptPathForMission(missing.receiptDir, 'm-audit'));
    const result = await report(missing);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('RECEIPT_MISSING'));
  } finally {
    await missing.cleanup();
  }

  const invalid = await tempCase('receipt-invalid');
  try {
    await writeSessions(invalid);
    await buildVerifiedLedger(invalid);
    const receiptPath = receiptPathForMission(invalid.receiptDir, 'm-audit');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.signature = Buffer.alloc(64).toString('base64');
    await writeFile(receiptPath, canonicalize(receipt), 'utf8');
    const result = await report(invalid);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('RECEIPT_INVALID'));
  } finally {
    await invalid.cleanup();
  }

  const stale = await tempCase('receipt-stale');
  try {
    await writeSessions(stale);
    await buildVerifiedLedger(stale);
    await storeFor(stale).append(request('abrir', 'm-later', 'later-open', { assunto: 'later' }));
    const result = await report(stale);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('RECEIPT_STALE'));
  } finally {
    await stale.cleanup();
  }
});

test('gate passo10: break-glass no commit sem importacao posterior fica pendente no audit', async () => {
  const t = await tempCase('break-glass-pending');
  try {
    await writeSessions(t);
    await buildVerifiedLedger(t);
    await writeFile(join(t.breakGlassDir, 'bg-pendente.json'), `${JSON.stringify({
      id: 'bg-pendente',
      commit: 'a'.repeat(40),
      incidentRef: 'INC-bg-pendente'
    })}\n`, 'utf8');

    const result = await report(t);
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
    assert.ok(codes(result).includes('BREAK_GLASS_PENDING_RECONCILIATION'), codes(result).join(', '));
    assert.equal(result.summary.warning, 1);
  } finally {
    await t.cleanup();
  }
});

test('gate passo8: runId agent encontrado verifica; nao encontrado reprova', async () => {
  const t = await tempCase('runid-not-found');
  try {
    await writeSessions(t);
    await buildVerifiedLedger(t, missingRunId);
    const result = await report(t);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('RUNID_AGENT_NOT_FOUND'));
  } finally {
    await t.cleanup();
  }
});

test('gate passo8: human e manual sao nao-verificados honestos sem falha', async () => {
  for (const id of [humanRunId, 'manual:offline-fundador']) {
    const t = await tempCase(id.startsWith('human') ? 'human' : 'manual');
    try {
      await buildVerifiedLedger(t, id);
      const result = await report(t);
      assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
      assert.equal(result.provenance[0].proveniencia, 'nao-verificada');
    } finally {
      await t.cleanup();
    }
  }
});

test('gate passo8: sessions.json ausente faz downgrade explicito e exit 0', async () => {
  const t = await tempCase('sessions-missing');
  try {
    await buildVerifiedLedger(t);
    const result = await report(t);
    assert.equal(result.ok, true, JSON.stringify(result.findings, null, 2));
    assert.ok(codes(result).includes('SOURCE_UNAVAILABLE'));
    assert.equal(result.sessions.downgrade, true);

    const cli = await execFileAsync(process.execPath, [
      'bin/missao.js',
      'audit',
      '--ledger',
      t.ledgerPath,
      '--ledger-state',
      t.statePath,
      '--snapshot-dir',
      t.snapshotDir,
      '--receipt-dir',
      t.receiptDir,
      '--keyring',
      t.keyringPath,
      '--private-key',
      t.privateKeyPath,
      '--sessions-root',
      t.sessionsRoot,
      '--break-glass-dir',
      t.breakGlassDir,
      '--json'
    ], { cwd: root });
    assert.equal(JSON.parse(cli.stdout).sessions.downgrade, true);
  } finally {
    await t.cleanup();
  }
});

test('gate passo8: sessions.json tampered ou arquivo contradito falha fechado', async () => {
  const badJson = await tempCase('sessions-bad-json');
  try {
    await buildVerifiedLedger(badJson);
    const sessionsDir = join(badJson.sessionsRoot, 'neo', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sessions.json'), '{bad-json}\n', 'utf8');
    const result = await report(badJson);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('SESSIONS_TAMPERED'));
  } finally {
    await badJson.cleanup();
  }

  const missingFile = await tempCase('sessions-missing-file');
  try {
    await buildVerifiedLedger(missingFile);
    const sessionsDir = join(missingFile.sessionsRoot, 'neo', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sessions.json'), `${JSON.stringify({
      [runId]: { sessionId: 'missing-session' }
    })}\n`, 'utf8');
    const result = await report(missingFile);
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('SESSIONS_TAMPERED'));
  } finally {
    await missingFile.cleanup();
  }
});

test('gate passo8: missao audit retorna codigo nao-zero para bypass silencioso', async () => {
  const t = await tempCase('cli-fail');
  try {
    await writeSessions(t);
    await buildVerifiedLedger(t);
    await chmod(t.ledgerPath, 0o644);
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        'bin/missao.js',
        'audit',
        '--ledger',
        t.ledgerPath,
        '--ledger-state',
        t.statePath,
        '--snapshot-dir',
        t.snapshotDir,
        '--receipt-dir',
        t.receiptDir,
        '--keyring',
        t.keyringPath,
        '--private-key',
        t.privateKeyPath,
        '--sessions-root',
        t.sessionsRoot,
        '--break-glass-dir',
        t.breakGlassDir,
        '--json'
      ], { cwd: root }),
      (error) => {
        assert.equal(error.code, 1);
        assert.ok(JSON.parse(error.stdout).findings.some((finding) => finding.code === 'LEDGER_PERMISSION_OPEN'));
        return true;
      }
    );
  } finally {
    await t.cleanup();
  }
});
