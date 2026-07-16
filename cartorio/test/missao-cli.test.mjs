import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalize } from '../lib/canonical-json.js';
import { uidPeerHelperBinary } from '../lib/uid-peer.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runId = 'agent:neo:subagent:4bbb60d3-b421-41f5-9856-8aa5a4f547cc';

async function tempCase(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-missao-cli-${name}-`));
  return {
    dir,
    ledgerPath: join(dir, 'missoes.jsonl'),
    socketPath: join(dir, 'ledgerd.sock'),
    privateKeyPath: join(dir, 'keys-private', 'ledgerd.ed25519.pem'),
    keyringPath: join(dir, '.cartorio', 'keys', 'keyring.json'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function runWithLedgerd(t, args, options = {}) {
  const { result, code, stdout, stderr } = await runWithLedgerdRaw(t, args, options);
  assert.equal(code, 0, stderr || stdout);
  return {
    cli: result,
    daemon: { stdout, stderr }
  };
}

async function runWithLedgerdFailure(t, args, expectedCode, expectedMessage) {
  const { result, code, stdout, stderr } = await runWithLedgerdRaw(t, args);
  assert.equal(result, null);
  assert.equal(code, expectedCode, stderr || stdout);
  assert.match(stderr, expectedMessage);
  return { stdout, stderr };
}

async function runWithLedgerdRaw(t, args, options = {}) {
  const child = fork(resolve(root, 'bin/ledgerd.js'), ['--serve-once', t.socketPath, '--ledger', t.ledgerPath], {
    cwd: root,
    env: {
      ...process.env,
      CARTORIO_LEDGERD_KEY_PATH: t.privateKeyPath,
      CARTORIO_KEYRING_PATH: t.keyringPath
    },
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
  await new Promise((resolveReady, rejectReady) => {
    child.once('message', resolveReady);
    child.once('error', rejectReady);
  });

  const closePromise = new Promise((resolveClose) => child.once('close', resolveClose));
  let result = null;
  try {
    result = await execFileAsync(process.execPath, [resolve(root, 'bin/missao.js'), ...args, '--socket', t.socketPath], {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env
    });
  } catch (error) {
    stderr += error.stderr ?? '';
  }
  const code = await closePromise;
  return { result, code, stdout, stderr };
}

test('gate passo5: missao CLI fino executa abrir, entregar, coletar e status via ledgerd', async () => {
  const t = await tempCase('flow');
  try {
    const fixture = await tempGitRepo(t, 'flow');
    const abrir = await runWithLedgerd(t, [
      'abrir',
      '--missao-id',
      'f1-passo5-cli',
      '--run-id',
      runId,
      '--idempotency-key',
      'cli-open',
      '--payload-json',
      '{"assunto":"gate"}'
    ]);
    assert.equal(JSON.parse(abrir.cli.stdout).status.state, 'aberta');

    const entregar = await runWithLedgerd(t, [
      'entregar',
      '--missao-id',
      'f1-passo5-cli',
      '--run-id',
      runId,
      '--idempotency-key',
      'cli-deliver',
      '--artefato',
      'package.json'
    ], { cwd: fixture.repoPath });
    assert.equal(JSON.parse(entregar.cli.stdout).status.state, 'entregue');
    assert.ok(JSON.parse(entregar.cli.stdout).receipt);

    const coletar = await runWithLedgerd(t, [
      'coletar',
      '--missao-id',
      'f1-passo5-cli',
      '--run-id',
      runId,
      '--idempotency-key',
      'cli-collect',
      '--payload-json',
      '{"confirmacao":"ok"}'
    ]);
    assert.equal(JSON.parse(coletar.cli.stdout).status.state, 'verificada');

    const status = await runWithLedgerd(t, [
      'status',
      '--missao-id',
      'f1-passo5-cli'
    ]);
    const statusJson = JSON.parse(status.cli.stdout);
    assert.equal(statusJson.status.state, 'verificada');
    assert.equal(statusJson.status.ledgerSeq, 3);

    const records = (await readFile(t.ledgerPath, 'utf8')).trim().split('\n');
    assert.equal(records.length, 3);
    const entregaRecord = JSON.parse(records[1]);
    assert.equal(entregaRecord.payload.commit.length, 40);
    assert.deepEqual(entregaRecord.payload.artefatos, [{
      path: 'package.json',
      blobSha256: await gitBlobSha256(fixture.repoPath, 'package.json'),
      gitBlobOid: await gitBlobOid(fixture.repoPath, 'package.json'),
      gitSource: 'index',
      commit: entregaRecord.payload.commit
    }]);
  } finally {
    await t.cleanup();
  }
});

async function tempGitRepo(t, name) {
  const repoPath = join(t.dir, `${name}-repo`);
  await mkdir(repoPath);
  await writeFile(join(repoPath, 'package.json'), `${JSON.stringify({
    name: `cartorio-${name}-fixture`,
    private: true,
    version: '1.0.0'
  }, null, 2)}\n`, 'utf8');
  await execFileAsync('git', ['init'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.name', 'Cartorio Test'], { cwd: repoPath });
  await execFileAsync('git', ['config', 'user.email', 'cartorio-test@example.invalid'], { cwd: repoPath });
  await execFileAsync('git', ['add', 'package.json'], { cwd: repoPath });
  await execFileAsync('git', ['commit', '-m', 'fixture artifact'], { cwd: repoPath });
  return { repoPath };
}

async function gitBlobOid(repoPath, path) {
  const result = await execFileAsync('git', ['rev-parse', '--verify', `:${path}`], { cwd: repoPath });
  return result.stdout.trim();
}

async function gitBlobSha256(repoPath, path) {
  const oid = await gitBlobOid(repoPath, path);
  const result = await execFileAsync('git', ['cat-file', 'blob', oid], {
    cwd: repoPath,
    encoding: 'buffer'
  });
  return createHash('sha256').update(result.stdout).digest('hex');
}

test('gate passo6: entregar fora de repo git falha com GIT_CONTEXT_MISSING', async () => {
  const t = await tempCase('git-context-missing');
  try {
    await assert.rejects(
      () => execFileAsync(process.execPath, [
        resolve(root, 'bin/missao.js'),
        'entregar',
        '--missao-id',
        'sem-git',
        '--run-id',
        runId,
        '--idempotency-key',
        'sem-git-entrega',
        '--artefato',
        'package.json',
        '--socket',
        t.socketPath
      ], { cwd: t.dir }),
      (error) => {
        assert.equal(error.code, 66);
        assert.match(error.stderr, /GIT_CONTEXT_MISSING/);
        assert.doesNotMatch(error.stderr, /"code": "INVALID_STATE"/);
        return true;
      }
    );
    await assert.rejects(() => stat(t.ledgerPath), /ENOENT/);
  } finally {
    await t.cleanup();
  }
});

test('gate passo5: sem daemon falha com DAEMON_UNAVAILABLE e nao cria ledger', async () => {
  const t = await tempCase('unavailable');
  try {
    let error;
    try {
      await execFileAsync(process.execPath, [
        'bin/missao.js',
        'abrir',
        '--missao-id',
        'no-daemon',
        '--run-id',
        runId,
        '--socket',
        t.socketPath
      ], { cwd: root, env: { ...process.env, CARTORIO_LEDGER_PATH: t.ledgerPath } });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.equal(error.code, 69);
    assert.match(error.stderr, /DAEMON_UNAVAILABLE/);
    await assert.rejects(() => stat(t.ledgerPath), /ENOENT/);
  } finally {
    await t.cleanup();
  }
});

test('gate passo5: conflito usa codigo distinto CONFLICT', async () => {
  const t = await tempCase('conflict');
  try {
    await runWithLedgerd(t, [
      'abrir',
      '--missao-id',
      'conflito',
      '--run-id',
      runId,
      '--idempotency-key',
      'same-key',
      '--payload-json',
      '{"valor":"a"}'
    ]);
    await runWithLedgerdFailure(t, [
      'abrir',
      '--missao-id',
      'conflito',
      '--run-id',
      runId,
      '--idempotency-key',
      'same-key',
      '--payload-json',
      '{"valor":"b"}'
    ], 73, /CONFLICT/);
  } finally {
    await t.cleanup();
  }
});

test('gate passo5: estado invalido usa codigo distinto INVALID_STATE', async () => {
  const t = await tempCase('invalid-state');
  try {
    await runWithLedgerd(t, [
      'abrir',
      '--missao-id',
      'estado-invalido',
      '--run-id',
      runId,
      '--idempotency-key',
      'invalid-open'
    ]);
    await runWithLedgerdFailure(t, [
      'coletar',
      '--missao-id',
      'estado-invalido',
      '--run-id',
      runId,
      '--idempotency-key',
      'invalid-collect'
    ], 65, /INVALID_STATE/);
  } finally {
    await t.cleanup();
  }
});

test('gate passo5: UID divergente do ator alegado e normalizado pelo daemon', async () => {
  const t = await tempCase('uid');
  try {
    const claimed = (process.getuid?.() ?? 0) + 1;
    const result = await runWithLedgerd(t, [
      'abrir',
      '--missao-id',
      'uid-normalizado',
      '--run-id',
      runId,
      '--idempotency-key',
      'uid-open',
      '--actor-uid',
      String(claimed)
    ]);
    assert.equal(JSON.parse(result.cli.stdout).status.state, 'aberta');
    const [record] = (await readFile(t.ledgerPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(record.actorUid, process.getuid?.());
    assert.equal(record.claimedActorUid, claimed);
  } finally {
    await t.cleanup();
  }
});

test('gate passo5: missao self-check fail-closed sai nao-zero para UID_PEER_HELPER_UNTRUSTED', async () => {
  const t = await tempCase('self-check');
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
      () => execFileAsync(process.execPath, [
        'bin/missao.js',
        '--self-check',
        '--uid-helper',
        helperPath,
        '--uid-manifest',
        manifestPath
      ], { cwd: root }),
      (error) => {
        assert.equal(error.code, 77);
        assert.match(error.stderr, /UID_PEER_HELPER_UNTRUSTED/);
        assert.match(error.stderr, /"ok": false/);
        return true;
      }
    );
  } finally {
    await t.cleanup();
  }
});
