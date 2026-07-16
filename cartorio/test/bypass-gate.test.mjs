import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalize } from '../lib/canonical-json.js';
import { createLedgerStore } from '../lib/ledger-store.js';
import {
  deriveKeyIdFromPublicKey,
  rawPublicKeyFromPrivateKey
} from '../lib/keyring.js';
import { computeCodeManifestHash } from '../lib/uid-peer.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uid = process.getuid?.() ?? 501;
const runId = 'agent:neo:subagent:bypass-00000000-0000-4000-8000-000000000010';

test('gate passo10: hook local recusa commit quando existe missao aberta', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cartorio-bypass-hook-'));
  try {
    const ledgerPath = join(dir, 'ledger', 'missoes.jsonl');
    await mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 });
    const store = createLedgerStore({ ledgerPath });
    await store.append({
      command: 'abrir',
      missaoId: 'm-hook-open',
      idempotencyKey: 'open',
      actorUid: uid,
      runId,
      payload: { missaoId: 'm-hook-open' }
    });

    await assert.rejects(
      () => execFileAsync(join(root, 'scripts', 'missao-pre-commit.sh'), [], {
        cwd: root,
        env: { ...process.env, CARTORIO_LEDGER_PATH: ledgerPath }
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr, /missão aberta detectada/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gate passo10: git commit --no-verify sem receipt ainda falha no required check remoto', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'cartorio-bypass-no-verify-'));
  try {
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'neo@example.invalid']);
    await git(repo, ['config', 'user.name', 'Neo Test']);
    await mkdir(join(repo, '.cartorio', 'keys'), { recursive: true });
    await mkdir(join(repo, 'build'), { recursive: true });
    await writeJson(join(repo, '.cartorio', 'keys', 'keyring.json'), makeKeyring());
    await writeJson(join(repo, 'build', 'uid-peer-helper.manifest.json'), makeManifest());
    await writeFile(join(repo, 'README.md'), 'base\n', 'utf8');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'base']);

    await writeFile(join(repo, 'entrega.txt'), 'entrega sem receipt\n', 'utf8');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--no-verify', '-m', 'delivery without receipt']);

    const result = await execFileAsync(process.execPath, [join(root, 'bin', 'verify-receipt.js'), '--repo', repo], {
      cwd: root
    }).then(
      (ok) => ({ status: 0, text: ok.stdout }),
      (error) => ({ status: error.code ?? 1, text: error.stderr ?? '' })
    );

    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.text).state, 'fail');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

function makeKeyring() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = rawPublicKeyFromPrivateKey(privateKey);
  const keyId = deriveKeyIdFromPublicKey(pubRaw);
  return {
    [keyId]: {
      alg: 'ed25519',
      pub: pubRaw.toString('base64'),
      role: 'ledgerd',
      status: 'active',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2100-01-01T00:00:00.000Z',
      revokedAt: null
    }
  };
}

function makeManifest() {
  const manifest = {
    schema: 'cartorio.uid-peer-helper.manifest/v1',
    buildId: 'uid-peer-helper:bypass-gate',
    binaryPath: 'build/uid-peer-helper',
    binarySha256: '2'.repeat(64),
    sourcePath: 'native/uid-peer-helper.c',
    sourceSha256: '3'.repeat(64),
    primitive: 'getpeereid(3)',
    buildCommand: ['cc', '-o', 'build/uid-peer-helper', 'native/uid-peer-helper.c'],
    signature: null
  };
  manifest.codeManifestHash = computeCodeManifestHash(manifest);
  return manifest;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalize(value), 'utf8');
  await chmod(path, 0o644);
}

async function git(cwd, args) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 16
  });
}
