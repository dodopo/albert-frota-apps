import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalize, parseCanonicalJson } from '../lib/canonical-json.js';
import { ensureLedgerdSigningKey, loadKeyring } from '../lib/keyring.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = 'agent:neo:subagent:f2feedface01';
const replayRunId = 'agent:neo:subagent:f2feedface02';
const missaoId = 'f2-produce-e2e';
const idempotencyKey = 'f2-produce-e2e-deliver';
const receiptWhitelist = [
  'actorUid',
  'artefatos',
  'ator',
  'buildId',
  'codeManifestHash',
  'eventId',
  'keyId',
  'ledgerHeadHash',
  'ledgerSeq',
  'missaoId',
  'parentCommit',
  'runId',
  'signature',
  'treeHashExcludingReceipts',
  'treeScope',
  'ts',
  'version'
];

test('f2 write lifecycle: entregar via socket produz receipt verificavel, replay e recovery read-only', async () => {
  const t = await tempCase();
  try {
    await setupRepo(t);
    await ensureLedgerdSigningKey({
      privateKeyPath: t.privateKeyPath,
      keyringPath: t.keyringPath
    });
    await git(t.repoPath, ['add', 'cartorio']);
    await git(t.repoPath, ['add', '-f', 'cartorio/build/uid-peer-helper.manifest.json']);
    await git(t.repoPath, ['commit', '-m', 'base cartorio app']);

    await runMissao(t, ['abrir', '--missao-id', missaoId, '--run-id', runId, '--idempotency-key', 'f2-open']);
    const delivered = await runMissao(t, deliverArgs(runId));
    const receipt = delivered.cli.receipt;
    const keyring = await loadKeyring(t.keyringPath);

    assert.equal(delivered.cli.status.state, 'delivered-pending-git');
    assert.deepEqual(Object.keys(receipt).sort(), receiptWhitelist);
    assert.deepEqual(Object.keys(receipt.artefatos[0]).sort(), ['blobSha256', 'path']);
    assert.equal(receipt.signature.length > 0, true);
    assert.ok(keyring[receipt.keyId]);
    assert.equal(receipt.runId, runId);

    const materialized = parseCanonicalJson(await readFile(delivered.cli.result.receiptPath, 'utf8'));
    assert.equal(canonicalize(materialized), canonicalize(receipt));

    const replay = await runMissao(t, deliverArgs(runId));
    assert.equal(replay.cli.result.idempotent, true);
    assert.equal(canonicalize(replay.cli.receipt), canonicalize(receipt));

    const invalidReplay = await runMissaoFailure(t, deliverArgs(replayRunId, 'f2-produce-e2e-deliver-other'));
    assert.equal(invalidReplay.code, 65);
    assert.match(invalidReplay.stderr, /INVALID_STATE/);

    const beforeReceiptLines = await ledgerLines(t.ledgerPath);
    const recovered = await runMissao(t, ['receipt', '--missao-id', missaoId], { cwd: t.appPath });
    assert.equal(canonicalize(recovered.cli.receipt), canonicalize(receipt));
    assert.equal((await ledgerLines(t.ledgerPath)).length, beforeReceiptLines.length);

    await git(t.repoPath, ['add', 'cartorio/.cartorio/missoes']);
    await git(t.repoPath, ['commit', '-m', 'add mission receipt']);
    const verify = await execFileAsync(process.execPath, [
      resolve(root, 'bin/verify-receipt.js'),
      '--repo',
      t.repoPath,
      '--commit',
      'HEAD'
    ], { cwd: t.repoPath });
    const verified = parseCanonicalJson(verify.stdout);
    assert.equal(verified.ok, true);
    assert.equal(verified.state, 'receipt-valid');
    assert.equal(verified.missaoId, missaoId);
    assert.equal(verified.runId, runId);
  } finally {
    await t.cleanup();
  }
});

function deliverArgs(activeRunId, idem = idempotencyKey) {
  return [
    'entregar',
    '--missao-id',
    missaoId,
    '--run-id',
    activeRunId,
    '--idempotency-key',
    idem,
    '--artefato',
    'package.json'
  ];
}

async function tempCase() {
  const dir = await mkdtemp(join(tmpdir(), 'cartorio-produce-e2e-'));
  const repoPath = join(dir, 'repo');
  const keyDir = join(dir, 'keys-private');
  await mkdir(repoPath, { recursive: true });
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  await chmod(keyDir, 0o700);
  return {
    dir,
    repoPath,
    appPath: join(repoPath, 'cartorio'),
    ledgerPath: join(dir, 'missoes.jsonl'),
    socketPath: join(dir, 'ledgerd.sock'),
    privateKeyPath: join(keyDir, 'ledgerd.ed25519.pem'),
    keyringPath: join(repoPath, 'cartorio', '.cartorio', 'keys', 'keyring.json'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function setupRepo(t) {
  await cp(root, t.appPath, {
    recursive: true,
    filter: (source) => !source.includes('/node_modules/') && !source.includes('/.cartorio/dev-keys/')
  });
  await git(t.repoPath, ['init']);
  await git(t.repoPath, ['config', 'user.name', 'Cartorio E2E']);
  await git(t.repoPath, ['config', 'user.email', 'cartorio-e2e@example.invalid']);
}

async function runMissao(t, args, options = {}) {
  const raw = await runMissaoRaw(t, args, options);
  assert.equal(raw.code, 0, raw.stderr || raw.stdout);
  assert.ok(raw.result);
  return raw;
}

async function runMissaoFailure(t, args, options = {}) {
  const raw = await runMissaoRaw(t, args, options);
  assert.notEqual(raw.code, 0);
  return raw;
}

async function runMissaoRaw(t, args, options = {}) {
  const child = fork(resolve(root, 'bin/ledgerd.js'), ['--serve-once', t.socketPath, '--ledger', t.ledgerPath], {
    cwd: root,
    env: ledgerdEnv(t),
    silent: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closePromise = new Promise((resolveClose) => child.once('close', resolveClose));
  await waitForReady(child, closePromise, () => ({ stdout, stderr }));

  let result = null;
  try {
    result = await execFileAsync(process.execPath, [resolve(root, 'bin/missao.js'), ...args, '--socket', t.socketPath], {
      cwd: options.cwd ?? t.appPath,
      env: process.env
    });
  } catch (error) {
    stderr += error.stderr ?? '';
  }
  const code = await closePromise;
  return {
    code,
    stdout,
    stderr,
    result,
    cli: result ? JSON.parse(result.stdout) : null
  };
}

function ledgerdEnv(t) {
  return {
    ...process.env,
    CARTORIO_LEDGERD_KEY_PATH: t.privateKeyPath,
    CARTORIO_KEYRING_PATH: t.keyringPath
  };
}

async function waitForReady(child, closePromise, output) {
  await Promise.race([
    new Promise((resolveReady, rejectReady) => {
      child.once('message', resolveReady);
      child.once('error', rejectReady);
    }),
    closePromise.then((code) => {
      const { stdout, stderr } = output();
      throw new Error(`ledgerd encerrou antes de ouvir socket code=${code} stderr=${stderr} stdout=${stdout}`);
    })
  ]);
}

async function ledgerLines(path) {
  const text = await readFile(path, 'utf8');
  return text.trim().split('\n').filter(Boolean);
}

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, maxBuffer: 1024 * 1024 * 64 });
}
