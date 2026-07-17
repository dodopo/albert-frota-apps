import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalize, canonicalizeToBytes } from '../lib/canonical-json.js';
import {
  deriveKeyIdFromPublicKey,
  rawPublicKeyFromPrivateKey,
  signBytes
} from '../lib/keyring.js';
import { computeTreeHashExcludingReceipts, resolveCartorioAppDir, TREE_SCOPE_V1 } from '../lib/remote-verify.js';
import { computeCodeManifestHash } from '../lib/uid-peer.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifyBin = join(root, 'bin', 'verify-receipt.js');
const ts = '2026-07-16T17:00:00.000Z';
const runId = 'agent:neo:subagent:00000000-0000-4000-8000-000000000009';
const helperSource = 'int main(void) { return 0; }\n';
let receiptCounter = 0;

async function tempRepo(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-remote-${name}-`));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'neo@example.invalid']);
  await git(dir, ['config', 'user.name', 'Neo Test']);
  await mkdir(join(dir, '.cartorio', 'keys'), { recursive: true });
  await mkdir(join(dir, '.cartorio', 'missoes'), { recursive: true });
  await mkdir(join(dir, '.cartorio', 'break-glass'), { recursive: true });
  await mkdir(join(dir, 'build'), { recursive: true });
  await mkdir(join(dir, 'native'), { recursive: true });
  await writeFile(join(dir, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(dir, 'entrega.txt'), 'base\n');
  await writeFile(join(dir, 'native', 'uid-peer-helper.c'), helperSource);

  const keys = makeKeys();
  await writeJson(join(dir, '.cartorio', 'keys', 'keyring.json'), keys.keyring);
  const manifest = makeManifest();
  await writeJson(join(dir, 'build', 'uid-peer-helper.manifest.json'), manifest);
  await commitAll(dir, 'base');
  return {
    dir,
    keys,
    manifest,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function tempCartorioRepo(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-remote-${name}-`));
  const appRoot = join(dir, 'cartorio');
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'neo@example.invalid']);
  await git(dir, ['config', 'user.name', 'Neo Test']);
  await mkdir(join(appRoot, '.cartorio', 'keys'), { recursive: true });
  await mkdir(join(appRoot, '.cartorio', 'missoes'), { recursive: true });
  await mkdir(join(appRoot, '.cartorio', 'break-glass'), { recursive: true });
  await mkdir(join(appRoot, 'build'), { recursive: true });
  await mkdir(join(appRoot, 'native'), { recursive: true });
  await writeFile(join(appRoot, 'package.json'), '{"name":"fixture-cartorio"}\n');
  await writeFile(join(appRoot, 'entrega.txt'), 'base\n');
  await writeFile(join(appRoot, 'native', 'uid-peer-helper.c'), helperSource);

  const keys = makeKeys();
  await writeJson(join(appRoot, '.cartorio', 'keys', 'keyring.json'), keys.keyring);
  const manifest = makeManifest();
  await writeJson(join(appRoot, 'build', 'uid-peer-helper.manifest.json'), manifest);
  await commitAll(dir, 'base cartorio app');
  return {
    dir,
    keys,
    manifest,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function tempBootstrapRepo(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-remote-${name}-`));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'neo@example.invalid']);
  await git(dir, ['config', 'user.name', 'Neo Test']);
  await writeFile(join(dir, 'README.md'), 'base sem keyring\n');
  await commitAll(dir, 'base without keyring');
  await git(dir, ['switch', '-c', 'pr-bootstrap']);
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test('passo9: receipt valido retorna receipt-valid', async () => {
  const fx = await tempRepo('valid');
  try {
    await createReceiptCommit(fx, {});
    const result = await runVerify(fx.dir);
    assert.equal(result.status, 0);
    assert.equal(result.json.state, 'receipt-valid');
  } finally {
    await fx.cleanup();
  }
});

test('f2-pr1: bootstrap-valid aceita keyring inicial com fingerprint externo e diff exclusivo', async () => {
  const fx = await tempBootstrapRepo('bootstrap-valid');
  try {
    const keys = makeKeys();
    await mkdir(join(fx.dir, '.cartorio', 'keys'), { recursive: true });
    await writeJson(join(fx.dir, '.cartorio', 'keys', 'keyring.json'), keys.keyring);
    await commitAll(fx.dir, 'bootstrap keyring');
    const result = await runVerify(fx.dir, [
      '--bootstrap-keyring-fingerprint',
      keyringFingerprint(keys.keyring),
      '--bootstrap-base-ref',
      'main'
    ]);
    assert.equal(result.status, 0);
    assert.equal(result.json.state, 'bootstrap-valid');
  } finally {
    await fx.cleanup();
  }
});

test('f2-pr1: bootstrap-valid falha sem fingerprint externo', async () => {
  const fx = await tempBootstrapRepo('bootstrap-no-fingerprint');
  try {
    const keys = makeKeys();
    await mkdir(join(fx.dir, '.cartorio', 'keys'), { recursive: true });
    await writeJson(join(fx.dir, '.cartorio', 'keys', 'keyring.json'), keys.keyring);
    await commitAll(fx.dir, 'bootstrap keyring');
    const result = await runVerify(fx.dir, ['--bootstrap-base-ref', 'main']);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.code, 'BOOTSTRAP_FINGERPRINT_MISSING');
  } finally {
    await fx.cleanup();
  }
});

test('f2-pr1: bootstrap-valid falha quando diff toca arquivo alem do keyring', async () => {
  const fx = await tempBootstrapRepo('bootstrap-extra-file');
  try {
    const keys = makeKeys();
    await mkdir(join(fx.dir, '.cartorio', 'keys'), { recursive: true });
    await writeJson(join(fx.dir, '.cartorio', 'keys', 'keyring.json'), keys.keyring);
    await writeFile(join(fx.dir, 'extra.txt'), 'nao pode\n');
    await commitAll(fx.dir, 'bootstrap keyring plus extra');
    const result = await runVerify(fx.dir, [
      '--bootstrap-keyring-fingerprint',
      keyringFingerprint(keys.keyring),
      '--bootstrap-base-ref',
      'main'
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.code, 'BOOTSTRAP_DIFF_NOT_EXCLUSIVE');
  } finally {
    await fx.cleanup();
  }
});

test('passo10: receipt valido em caminho divergente do missaoId retorna fail', async () => {
  const fx = await tempRepo('receipt-path-mismatch');
  try {
    await createReceiptCommit(fx, { receiptFilename: 'missao-errada.receipt.json' });
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.details.receiptResults[0].code, 'RECEIPT_PATH_MISMATCH');
  } finally {
    await fx.cleanup();
  }
});

test('f2-pr1: mais de um receipt de missao no PR retorna fail', async () => {
  const fx = await tempRepo('receipt-count');
  try {
    await writeFile(join(fx.dir, 'entrega.txt'), 'conteudo multi receipt\n');
    await commitAll(fx.dir, 'mission content');
    const parentCommit = await head(fx.dir);
    const tree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: parentCommit, appDir: '' });
    const artifact = await artifactAtCommit(fx.dir, parentCommit, 'entrega.txt');
    const receipt = signReceipt(fx, {
      parentCommit,
      treeHashExcludingReceipts: tree.treeHashExcludingReceipts,
      artefatos: [artifact]
    });
    await writeJson(join(fx.dir, '.cartorio', 'missoes', 'm-extra.receipt.json'), {
      ...receipt,
      missaoId: 'm-extra'
    });
    await writeJson(join(fx.dir, '.cartorio', 'missoes', 'm-remote.receipt.json'), receipt);
    await commitAll(fx.dir, 'two mission receipts');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.code, 'REMOTE_RECEIPT_COUNT_INVALID');
  } finally {
    await fx.cleanup();
  }
});

test('f2-pr1: receipt historico nao conta como receipt novo do PR', async () => {
  const fx = await tempRepo('receipt-historical');
  try {
    await createReceiptCommit(fx, {});
    await git(fx.dir, ['mv', '.cartorio/missoes/m-remote.receipt.json', '.cartorio/missoes/m-old.receipt.json']);
    await commitAll(fx.dir, 'preserve historical receipt fixture');
    await createReceiptCommit(fx, {});
    const result = await runVerify(fx.dir);
    assert.equal(result.status, 0);
    assert.equal(result.json.state, 'receipt-valid');
  } finally {
    await fx.cleanup();
  }
});

test('f2-pr1: keyring alterado junto com receipt normal retorna fail', async () => {
  const fx = await tempRepo('keyring-with-receipt');
  try {
    await writeFile(join(fx.dir, 'entrega.txt'), 'conteudo com keyring trocado\n');
    await commitAll(fx.dir, 'mission content');
    const parentCommit = await head(fx.dir);
    const tree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: parentCommit, appDir: '' });
    const artifact = await artifactAtCommit(fx.dir, parentCommit, 'entrega.txt');
    const receipt = signReceipt(fx, {
      parentCommit,
      treeHashExcludingReceipts: tree.treeHashExcludingReceipts,
      artefatos: [artifact]
    });
    const extraKey = makeSingleKey('ledgerd');
    await writeJson(join(fx.dir, '.cartorio', 'keys', 'keyring.json'), {
      ...fx.keys.keyring,
      [extraKey.keyId]: extraKey.entry
    });
    await writeJson(join(fx.dir, '.cartorio', 'missoes', `${receipt.missaoId}.receipt.json`), receipt);
    await commitAll(fx.dir, 'receipt plus keyring change');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.code, 'KEYRING_CHANGED_WITH_RECEIPT');
  } finally {
    await fx.cleanup();
  }
});

test('passo10: path traversal em artefato assinado no receipt retorna fail', async () => {
  const fx = await tempRepo('receipt-artifact-traversal');
  try {
    await createReceiptCommit(fx, {
      receiptOverrides: {
        artefatos: [{ path: '../entrega.txt', blobSha256: '1'.repeat(64) }]
      }
    });
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.details.receiptResults[0].code, 'INVALID_STATE');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: receipt ausente retorna fail', async () => {
  const fx = await tempRepo('absent');
  try {
    await writeFile(join(fx.dir, 'entrega.txt'), 'sem receipt\n');
    await commitAll(fx.dir, 'content without receipt');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: assinatura forjada retorna fail', async () => {
  const fx = await tempRepo('forged');
  try {
    await createReceiptCommit(fx, {
      mutateReceipt: (receipt) => ({ ...receipt, signature: Buffer.alloc(64).toString('base64') })
    });
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: parentCommit divergente retorna fail', async () => {
  const fx = await tempRepo('parent');
  try {
    const base = await head(fx.dir);
    await createReceiptCommit(fx, { receiptOverrides: { parentCommit: base } });
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: conteudo efetivo alterado e digest divergente retorna fail', async () => {
  const fx = await tempRepo('tree');
  try {
    await writeFile(join(fx.dir, 'entrega.txt'), 'conteudo assinado\n');
    await commitAll(fx.dir, 'signed content');
    const parentCommit = await head(fx.dir);
    const signedTree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: parentCommit, appDir: '' });
    await writeFile(join(fx.dir, 'entrega.txt'), 'conteudo diferente\n');
    const artifact = await artifactAtWorktree(fx.dir, 'entrega.txt');
    const receipt = signReceipt(fx, {
      parentCommit,
      treeHashExcludingReceipts: signedTree.treeHashExcludingReceipts,
      artefatos: [artifact]
    });
    await writeJson(join(fx.dir, '.cartorio', 'missoes', 'm-tree.receipt.json'), receipt);
    await commitAll(fx.dir, 'receipt with stale tree digest');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: blob divergente retorna fail', async () => {
  const fx = await tempRepo('blob');
  try {
    await createReceiptCommit(fx, { artifactOverrides: { blobSha256: '0'.repeat(64) } });
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: codeManifestHash divergente retorna fail', async () => {
  const fx = await tempRepo('manifest');
  try {
    await createReceiptCommit(fx, { receiptOverrides: { codeManifestHash: '0'.repeat(64) } });
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('f2: manifesto falha quando sourceSha256 nao bate com blob .c commitado', async () => {
  const fx = await tempRepo('manifest-source');
  try {
    await writeFile(join(fx.dir, 'entrega.txt'), 'conteudo com source divergente\n');
    await commitAll(fx.dir, 'mission content');
    const parentCommit = await head(fx.dir);
    const tree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: parentCommit, appDir: '' });
    const artifact = await artifactAtCommit(fx.dir, parentCommit, 'entrega.txt');
    const manifest = {
      ...fx.manifest,
      sourceSha256: '4'.repeat(64)
    };
    manifest.codeManifestHash = computeCodeManifestHash(manifest);
    const receipt = signReceipt(fx, {
      parentCommit,
      treeHashExcludingReceipts: tree.treeHashExcludingReceipts,
      artefatos: [artifact],
      codeManifestHash: manifest.codeManifestHash
    });
    await writeJson(join(fx.dir, 'build', 'uid-peer-helper.manifest.json'), manifest);
    await writeJson(join(fx.dir, '.cartorio', 'missoes', `${receipt.missaoId}.receipt.json`), receipt);
    await commitAll(fx.dir, 'receipt with forged source manifest');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.code, 'CODE_MANIFEST_SOURCE_MISMATCH');
  } finally {
    await fx.cleanup();
  }
});

test('f2: appDir, treeHashExcludingReceipts e codeManifestHash batem entre produtor e verificador', async () => {
  const fx = await tempCartorioRepo('appdir-invariant');
  try {
    await writeFile(join(fx.dir, 'cartorio', 'entrega.txt'), 'conteudo no app cartorio\n');
    await commitAll(fx.dir, 'mission content in app');
    const parentCommit = await head(fx.dir);
    const producerAppDir = await resolveCartorioAppDir({ repo: fx.dir, commit: parentCommit });
    const producerTree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: parentCommit, appDir: producerAppDir });
    const artifact = await artifactAtCommit(fx.dir, parentCommit, 'cartorio/entrega.txt');
    const receipt = signReceipt(fx, {
      parentCommit,
      treeHashExcludingReceipts: producerTree.treeHashExcludingReceipts,
      artefatos: [artifact]
    });
    await writeJson(join(fx.dir, 'cartorio', '.cartorio', 'missoes', `${receipt.missaoId}.receipt.json`), receipt);
    await commitAll(fx.dir, 'mission receipt in app');

    const defaultVerify = await runVerify(fx.dir);
    const explicitVerify = await runVerify(fx.dir, ['--app-dir', 'cartorio']);
    assert.equal(producerAppDir, 'cartorio');
    assert.equal(defaultVerify.status, 0);
    assert.equal(explicitVerify.status, 0);
    assert.equal(defaultVerify.json.appDir, producerAppDir);
    assert.equal(explicitVerify.json.appDir, producerAppDir);
    assert.equal(defaultVerify.json.treeHashExcludingReceipts, producerTree.treeHashExcludingReceipts);
    assert.equal(explicitVerify.json.treeHashExcludingReceipts, producerTree.treeHashExcludingReceipts);
    assert.equal(defaultVerify.json.codeManifestHash, computeCodeManifestHash(fx.manifest));
    assert.equal(explicitVerify.json.codeManifestHash, computeCodeManifestHash(fx.manifest));
  } finally {
    await fx.cleanup();
  }
});

test('f2: receipt em merge commit valida contra primeiro pai e arvore efetiva sem receipts', async () => {
  const fx = await tempRepo('merge-commit');
  try {
    await writeFile(join(fx.dir, 'entrega.txt'), 'conteudo antes do merge\n');
    await commitAll(fx.dir, 'mission content');
    const parentCommit = await head(fx.dir);
    await git(fx.dir, ['switch', '-c', 'side']);
    await writeFile(join(fx.dir, 'side.txt'), 'conteudo do segundo pai\n');
    await commitAll(fx.dir, 'side content');
    await git(fx.dir, ['switch', 'main']);
    await git(fx.dir, ['merge', '--no-ff', 'side', '-m', 'merge side without receipt']);
    const unsignedMerge = await head(fx.dir);
    const mergeTree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: unsignedMerge, appDir: '' });
    const artifact = await artifactAtCommit(fx.dir, unsignedMerge, 'entrega.txt');
    const receipt = signReceipt(fx, {
      parentCommit,
      treeHashExcludingReceipts: mergeTree.treeHashExcludingReceipts,
      artefatos: [artifact]
    });
    await writeJson(join(fx.dir, '.cartorio', 'missoes', `${receipt.missaoId}.receipt.json`), receipt);
    await git(fx.dir, ['add', '.cartorio/missoes']);
    await git(fx.dir, ['commit', '--amend', '--no-edit']);

    const result = await runVerify(fx.dir);
    assert.equal(result.status, 0);
    assert.equal(result.json.state, 'receipt-valid');
    assert.equal(result.json.parentCommit, parentCommit);
    assert.equal(result.json.treeHashExcludingReceipts, mergeTree.treeHashExcludingReceipts);
  } finally {
    await fx.cleanup();
  }
});

test('passo9: receipt replicado em commit com outro pai retorna fail', async () => {
  const fx = await tempRepo('replay');
  try {
    const { receiptText } = await createReceiptCommit(fx, {});
    await git(fx.dir, ['checkout', '--detach', 'HEAD~2']);
    await writeFile(join(fx.dir, 'entrega.txt'), 'replay same content\n');
    await mkdir(join(fx.dir, '.cartorio', 'missoes'), { recursive: true });
    await writeFile(join(fx.dir, '.cartorio', 'missoes', 'm-remote.receipt.json'), receiptText);
    await commitAll(fx.dir, 'replayed receipt');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: break-glass valido posterior retorna break-glass-valid com marca explicita', async () => {
  const fx = await tempRepo('breakglass-valid');
  try {
    const target = await createTargetCommit(fx, 'target sem receipt');
    await writeBreakGlass(fx, { id: 'bg-valid', targetCommit: target, expiry: '2099-01-01T00:00:00.000Z' });
    await commitAll(fx.dir, 'break-glass posterior');
    const result = await runVerify(fx.dir);
    assert.equal(result.status, 0);
    assert.equal(result.json.state, 'break-glass-valid');
    assert.equal(result.json.exception, true);
    assert.equal(result.json.targetCommit, target);
  } finally {
    await fx.cleanup();
  }
});

test('passo9: break-glass com role errada retorna fail', async () => {
  const fx = await tempRepo('breakglass-role');
  try {
    const target = await createTargetCommit(fx, 'target role errada');
    await writeBreakGlass(fx, {
      id: 'bg-role',
      targetCommit: target,
      expiry: '2099-01-01T00:00:00.000Z',
      signer: fx.keys.ledger
    });
    await commitAll(fx.dir, 'break-glass wrong role');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('f2: break-glass replayado fora do parentCommit e treeHash assinados retorna fail', async () => {
  const fx = await tempRepo('breakglass-context-replay');
  try {
    const target = await createTargetCommit(fx, 'target replay context');
    await writeBreakGlass(fx, { id: 'bg-context', targetCommit: target, expiry: '2099-01-01T00:00:00.000Z' });
    await commitAll(fx.dir, 'break-glass original');
    await writeFile(join(fx.dir, 'entrega.txt'), 'outro contexto sem nova assinatura\n');
    await commitAll(fx.dir, 'replay break-glass in another context');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
    assert.equal(result.json.details.breakGlassResults[0].code, 'BREAK_GLASS_CONTEXT_MISMATCH');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: reuso de id break-glass em mais de um commit alvo retorna fail', async () => {
  const fx = await tempRepo('breakglass-reuse');
  try {
    const targetOne = await createTargetCommit(fx, 'target one');
    await writeBreakGlass(fx, { id: 'bg-reuse', targetCommit: targetOne, expiry: '2099-01-01T00:00:00.000Z' });
    await commitAll(fx.dir, 'break-glass one');
    const targetTwo = await createTargetCommit(fx, 'target two');
    await writeBreakGlass(fx, { id: 'bg-reuse', targetCommit: targetTwo, expiry: '2099-01-01T00:00:00.000Z' });
    await commitAll(fx.dir, 'break-glass reused');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: break-glass expirado retorna fail', async () => {
  const fx = await tempRepo('breakglass-expired');
  try {
    const target = await createTargetCommit(fx, 'target expired');
    await writeBreakGlass(fx, { id: 'bg-expired', targetCommit: target, expiry: '2000-01-01T00:00:00.000Z' });
    await commitAll(fx.dir, 'break-glass expired');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

test('passo9: keyId ausente do keyring retorna fail', async () => {
  const fx = await tempRepo('breakglass-key');
  try {
    const target = await createTargetCommit(fx, 'target unknown key');
    const external = makeSingleKey('break-glass');
    await writeBreakGlass(fx, {
      id: 'bg-unknown-key',
      targetCommit: target,
      expiry: '2099-01-01T00:00:00.000Z',
      signer: external
    });
    await commitAll(fx.dir, 'break-glass unknown key');
    const result = await runVerify(fx.dir);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.state, 'fail');
  } finally {
    await fx.cleanup();
  }
});

async function createReceiptCommit(fx, { receiptOverrides = {}, artifactOverrides = {}, mutateReceipt = null, receiptFilename = null } = {}) {
  receiptCounter += 1;
  await writeFile(join(fx.dir, 'entrega.txt'), `conteudo ${receiptCounter}\n`);
  await commitAll(fx.dir, 'mission content');
  const parentCommit = await head(fx.dir);
  const tree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: parentCommit, appDir: '' });
  const artifact = { ...(await artifactAtCommit(fx.dir, parentCommit, 'entrega.txt')), ...artifactOverrides };
  const receipt = signReceipt(fx, {
    parentCommit,
    treeHashExcludingReceipts: tree.treeHashExcludingReceipts,
    artefatos: [artifact],
    ...receiptOverrides
  });
  const finalReceipt = mutateReceipt ? mutateReceipt(receipt) : receipt;
  const receiptPath = join(fx.dir, '.cartorio', 'missoes', receiptFilename ?? `${receipt.missaoId}.receipt.json`);
  await writeJson(receiptPath, finalReceipt);
  await commitAll(fx.dir, 'mission receipt');
  return { receiptPath, receipt: finalReceipt, receiptText: await readFile(receiptPath, 'utf8') };
}

async function createTargetCommit(fx, message) {
  await writeFile(join(fx.dir, 'entrega.txt'), `${message}\n`);
  await commitAll(fx.dir, message);
  return head(fx.dir);
}

function signReceipt(fx, overrides = {}) {
  const material = {
    version: 'cartorio.receipt.v1',
    missaoId: 'm-remote',
    ledgerHeadHash: '1'.repeat(64),
    ledgerSeq: 7,
    parentCommit: overrides.parentCommit,
    treeScope: TREE_SCOPE_V1,
    treeHashExcludingReceipts: overrides.treeHashExcludingReceipts,
    artefatos: overrides.artefatos,
    runId,
    ator: 'uid:501',
    ts,
    keyId: fx.keys.ledger.keyId,
    codeManifestHash: fx.manifest.codeManifestHash,
    buildId: fx.manifest.buildId,
    ...overrides
  };
  const signature = signBytes(fx.keys.ledger.privateKey, canonicalizeToBytes(material)).toString('base64');
  return { ...material, signature };
}

async function writeBreakGlass(fx, { id, targetCommit, expiry, signer = fx.keys.breakGlass }) {
  const artifact = await artifactAtCommit(fx.dir, targetCommit, 'entrega.txt');
  const tree = await computeTreeHashExcludingReceipts({ repo: fx.dir, commit: targetCommit, appDir: '' });
  const material = {
    id,
    motivo: 'emergencia testavel',
    commit: targetCommit,
    parentCommit: targetCommit,
    treeHashExcludingReceipts: tree.treeHashExcludingReceipts,
    artefatos: [artifact],
    autorizadoPor: 'Dudous',
    ts,
    expiry,
    incidentRef: `INC-${id}`,
    keyId: signer.keyId
  };
  const signature = signBytes(signer.privateKey, canonicalizeToBytes(material)).toString('base64');
  await writeJson(join(fx.dir, '.cartorio', 'break-glass', `${id}.json`), { ...material, signature });
}

function makeKeys() {
  const ledger = makeSingleKey('ledgerd');
  const breakGlass = makeSingleKey('break-glass');
  return {
    ledger,
    breakGlass,
    keyring: {
      [ledger.keyId]: ledger.entry,
      [breakGlass.keyId]: breakGlass.entry
    }
  };
}

function makeSingleKey(role) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pubRaw = rawPublicKeyFromPrivateKey(privateKey);
  const keyId = deriveKeyIdFromPublicKey(pubRaw);
  return {
    privateKey,
    keyId,
    entry: {
      alg: 'ed25519',
      pub: pubRaw.toString('base64'),
      role,
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
    buildId: 'uid-peer-helper:test',
    binarySha256: '2'.repeat(64),
    sourceSha256: sha256Buffer(Buffer.from(helperSource)),
    primitive: 'getpeereid(3)',
    signature: null
  };
  manifest.codeManifestHash = computeCodeManifestHash(manifest);
  return manifest;
}

async function runVerify(repo, extraArgs = []) {
  const result = await execFileAsync(process.execPath, [verifyBin, '--repo', repo, ...extraArgs], {
    cwd: root
  }).then(
    (ok) => ({ status: 0, stdout: ok.stdout, stderr: ok.stderr }),
    (error) => ({ status: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' })
  );
  const text = result.status === 0 ? result.stdout : result.stderr;
  return { ...result, json: JSON.parse(text) };
}

async function artifactAtCommit(repo, commit, path) {
  const { stdout } = await git(repo, ['cat-file', 'blob', `${commit}:${path}`], { encoding: 'buffer' });
  return {
    path,
    blobSha256: sha256Buffer(stdout)
  };
}

async function artifactAtWorktree(repo, path) {
  const blob = await readFile(join(repo, path));
  return {
    path,
    blobSha256: sha256Buffer(blob)
  };
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function keyringFingerprint(keyring) {
  return createHash('sha256').update(canonicalize(keyring), 'utf8').digest('hex');
}

async function writeJson(path, value) {
  await writeFile(path, canonicalize(value), 'utf8');
}

async function commitAll(repo, message) {
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', message]);
}

async function head(repo) {
  const { stdout } = await git(repo, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function git(cwd, args, options = {}) {
  return execFileAsync('git', args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 1024 * 1024 * 64
  });
}
