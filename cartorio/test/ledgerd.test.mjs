import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalize } from '../lib/canonical-json.js';
import { createLedgerStore, ZERO_HASH } from '../lib/ledger-store.js';
import { makeEnvelope } from '../lib/protocol.js';
import { uidPeerHelperBinary } from '../lib/uid-peer.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uid = process.getuid();
const gid = process.getgid();
const runId = 'agent:neo:subagent:00000000-0000-4000-8000-000000000000';

function request(command, missaoId, idempotencyKey, payload = {}) {
  return {
    command,
    missaoId,
    idempotencyKey,
    actorUid: uid,
    runId,
    payload: { missaoId, ...payload }
  };
}

async function tempCase(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-ledgerd-${name}-`));
  return {
    dir,
    ledgerPath: join(dir, 'missoes.jsonl'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test('gate: fluxo feliz abrir -> entregar -> coletar deixa missao verificada', async () => {
  const t = await tempCase('happy');
  try {
    const store = createLedgerStore({ ledgerPath: t.ledgerPath });
    const abrir = await store.append(request('abrir', 'm-happy', 'idem-open', { assunto: 'abrir' }));
    const entregar = await store.append(request('entregar', 'm-happy', 'idem-deliver', { commit: 'abc123' }));
    const coletar = await store.append(request('coletar', 'm-happy', 'idem-collect', { confirmacao: 'ok' }));

    assert.equal(abrir.event.stateAfter, 'aberta');
    assert.equal(entregar.event.stateAfter, 'entregue');
    assert.equal(coletar.event.stateAfter, 'verificada');
    assert.equal(coletar.event.seq, 3);
  } finally {
    await t.cleanup();
  }
});

test('gate: coleta antes da entrega e rejeitada', async () => {
  const t = await tempCase('state');
  try {
    const store = createLedgerStore({ ledgerPath: t.ledgerPath });
    await store.append(request('abrir', 'm-state', 'idem-open', { assunto: 'abrir' }));
    await assert.rejects(
      () => store.append(request('coletar', 'm-state', 'idem-collect', { confirmacao: 'cedo' })),
      /transicao de missao rejeitada/
    );
  } finally {
    await t.cleanup();
  }
});

test('gate: dois appends simultaneos mantem seq monotônico e cadeia valida', async () => {
  const t = await tempCase('concurrent');
  try {
    const a = JSON.stringify(request('abrir', 'm-concurrent-a', 'idem-a', { assunto: 'a' }));
    const b = JSON.stringify(request('abrir', 'm-concurrent-b', 'idem-b', { assunto: 'b' }));
    const [ra, rb] = await Promise.all([
      execFileAsync(process.execPath, ['bin/ledgerd.js', '--append-json', a, '--ledger', t.ledgerPath], { cwd: root }),
      execFileAsync(process.execPath, ['bin/ledgerd.js', '--append-json', b, '--ledger', t.ledgerPath], { cwd: root })
    ]);
    assert.equal(JSON.parse(ra.stdout).ok, true);
    assert.equal(JSON.parse(rb.stdout).ok, true);

    const head = await createLedgerStore({ ledgerPath: t.ledgerPath }).readHead();
    assert.equal(head.ledgerSeq, 2);
    assert.notEqual(head.ledgerHeadHash, ZERO_HASH);
  } finally {
    await t.cleanup();
  }
});

test('gate: replay idempotente devolve mesmo evento e payload diferente conflita em estado final', async () => {
  const t = await tempCase('idempotency');
  try {
    const store = createLedgerStore({ ledgerPath: t.ledgerPath });
    await store.append(request('abrir', 'm-idem', 'idem-open', { assunto: 'abrir' }));
    await store.append(request('entregar', 'm-idem', 'idem-deliver', { commit: 'abc123' }));
    const first = await store.append(request('coletar', 'm-idem', 'idem-collect', { confirmacao: 'ok' }));
    const replay = await store.append(request('coletar', 'm-idem', 'idem-collect', { confirmacao: 'ok' }));
    assert.equal(replay.idempotent, true);
    assert.equal(replay.event.eventId, first.event.eventId);
    await assert.rejects(
      () => store.append(request('coletar', 'm-idem', 'idem-collect', { confirmacao: 'alterado' })),
      /idempotency key reutilizada/
    );
  } finally {
    await t.cleanup();
  }
});

test('gate: cabeca antiga e rejeitada por anti-rollback esperado pelo cliente', async () => {
  const t = await tempCase('old-head');
  try {
    const store = createLedgerStore({ ledgerPath: t.ledgerPath });
    await store.append(request('abrir', 'm-old-head', 'idem-open', { assunto: 'abrir' }));
    await assert.rejects(
      () => store.append({
        ...request('entregar', 'm-old-head', 'idem-deliver', { commit: 'abc123' }),
        expectedLedgerSeq: 0,
        expectedLedgerHeadHash: ZERO_HASH
      }),
      /ledgerSeq esperado diverge/
    );
  } finally {
    await t.cleanup();
  }
});

test('gate: gap de seq, JSONL ruim e ledger truncado sao detectados', async () => {
  const gap = await tempCase('gap');
  try {
    const store = createLedgerStore({ ledgerPath: gap.ledgerPath });
    await store.append(request('abrir', 'm-gap', 'idem-open', { assunto: 'abrir' }));
    const record = JSON.parse((await readFile(gap.ledgerPath, 'utf8')).trim());
    record.seq = 3;
    await writeFile(gap.ledgerPath, canonicalize(record), 'utf8');
    await assert.rejects(() => store.readHead(), /gap de seq/);
  } finally {
    await gap.cleanup();
  }

  const badJson = await tempCase('bad-json');
  try {
    await writeFile(badJson.ledgerPath, '{bad-json}\n', 'utf8');
    await assert.rejects(() => createLedgerStore({ ledgerPath: badJson.ledgerPath }).readHead(), /JSONL ruim/);
  } finally {
    await badJson.cleanup();
  }

  const trunc = await tempCase('trunc');
  try {
    const store = createLedgerStore({ ledgerPath: trunc.ledgerPath });
    await store.append(request('abrir', 'm-trunc', 'idem-open', { assunto: 'abrir' }));
    const text = await readFile(trunc.ledgerPath, 'utf8');
    await writeFile(trunc.ledgerPath, text.trimEnd(), 'utf8');
    await assert.rejects(() => store.readHead(), /ledger truncado/);
  } finally {
    await trunc.cleanup();
  }
});

test('gate: tmp orfao de crash e recuperado no startup', async () => {
  const t = await tempCase('tmp');
  try {
    const store = createLedgerStore({ ledgerPath: t.ledgerPath });
    await writeFile(join(t.dir, 'missoes.jsonl.tmp-crash'), 'parcial', 'utf8');
    const head = await store.readHead();
    assert.equal(head.ledgerSeq, 0);
    await assert.rejects(() => stat(join(t.dir, 'missoes.jsonl.tmp-crash')), /ENOENT/);
  } finally {
    await t.cleanup();
  }
});

test('gate: UID efetivo divergente do ator alegado e normalizado pelo ledgerd', async () => {
  const t = await tempCase('uid');
  try {
    const socketPath = join(t.dir, 'ledgerd.sock');
    const child = fork(resolve(root, 'bin/ledgerd.js'), ['--serve-once', socketPath, '--ledger', t.ledgerPath], {
      cwd: root,
      silent: true
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await new Promise((resolveReady, rejectReady) => {
      child.once('message', resolveReady);
      child.once('error', rejectReady);
    });
    const envelope = makeEnvelope({
      command: 'abrir',
      idempotencyKey: 'idem-open',
      actorUid: uid + 1,
      actorGid: gid,
      runId,
      payload: { missaoId: 'm-uid', assunto: 'abrir' }
    });
    await send(socketPath, canonicalize(envelope));
    const code = await new Promise((resolveClose) => child.once('close', resolveClose));
    assert.equal(code, 0);
    assert.equal(stderr, '');
    const [record] = (await readFile(t.ledgerPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(record.actorUid, uid);
    assert.equal(record.claimedActorUid, uid + 1);
  } finally {
    await t.cleanup();
  }
});

test('gate: ledgerd recusa subir quando binario do helper diverge do manifesto', async () => {
  const t = await tempCase('manifest');
  try {
    const helperPath = join(t.dir, 'uid-peer-helper');
    const manifestPath = join(t.dir, 'uid-peer-helper.manifest.json');
    await copyFile(uidPeerHelperBinary, helperPath);
    const badManifest = {
      schema: 'cartorio.uid-peer-helper.manifest/v1',
      buildId: 'bad',
      binaryPath: helperPath,
      binarySha256: '0'.repeat(64),
      primitive: 'getpeereid(3)'
    };
    badManifest.codeManifestHash = createHash('sha256').update(canonicalize(badManifest), 'utf8').digest('hex');
    await writeFile(manifestPath, `${JSON.stringify(badManifest)}\n`, 'utf8');

    await assert.rejects(
      () => execFileAsync(process.execPath, ['bin/ledgerd.js', '--self-check', '--uid-helper', helperPath, '--uid-manifest', manifestPath], { cwd: root }),
      (error) => {
        assert.equal(error.code, 77);
        assert.match(error.stderr, /UID_PEER_HELPER_UNTRUSTED/);
        return true;
      }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate: ledgerd recusa subir quando binario do helper nao existe', async () => {
  const t = await tempCase('missing-helper');
  try {
    const missingHelperPath = join(t.dir, 'uid-peer-helper-missing');
    const manifestPath = join(t.dir, 'uid-peer-helper.manifest.json');
    const manifest = {
      schema: 'cartorio.uid-peer-helper.manifest/v1',
      buildId: 'missing',
      binaryPath: missingHelperPath,
      binarySha256: '0'.repeat(64),
      primitive: 'getpeereid(3)'
    };
    manifest.codeManifestHash = createHash('sha256').update(canonicalize(manifest), 'utf8').digest('hex');
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');

    await assert.rejects(
      () => execFileAsync(process.execPath, ['bin/ledgerd.js', '--self-check', '--uid-helper', missingHelperPath, '--uid-manifest', manifestPath], { cwd: root }),
      (error) => {
        assert.equal(error.code, 77);
        assert.match(error.stderr, /UID_PEER_HELPER_UNTRUSTED/);
        return true;
      }
    );
  } finally {
    await t.cleanup();
  }
});

async function send(socketPath, payload) {
  await new Promise((resolveSend, rejectSend) => {
    const socket = net.createConnection(socketPath);
    socket.once('error', rejectSend);
    socket.once('connect', () => {
      socket.end(typeof payload === 'string' ? payload : `${JSON.stringify(payload)}\n`);
    });
    socket.once('close', resolveSend);
  });
}
