import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalize } from '../lib/canonical-json.js';
import {
  deriveKeyIdFromPublicKey,
  ensureLedgerdSigningKey,
  loadKeyring,
  rawPublicKeyFromPrivateKey,
  saveKeyring
} from '../lib/keyring.js';
import { signReceipt, verifyReceipt } from '../lib/receipt.js';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ts = '2026-07-16T16:30:00.000Z';
const commit = 'a'.repeat(40);
const artifact = { path: 'package.json', blobSha256: 'b'.repeat(64) };
const runId = 'agent:neo:subagent:receipt-keyring-gate-000000000001';

async function tempCase(name) {
  const dir = await mkdtemp(join(tmpdir(), `cartorio-receipt-${name}-`));
  const keyDir = join(dir, 'keys-private');
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  await chmod(keyDir, 0o700);
  return {
    dir,
    keyPath: join(keyDir, 'ledgerd.ed25519.pem'),
    keyringPath: join(dir, '.cartorio', 'keys', 'keyring.json'),
    receiptDir: join(dir, '.cartorio', 'missoes'),
    ledgerPath: join(dir, 'missoes.jsonl'),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function receiptBase(overrides = {}) {
  return {
    version: 'cartorio.receipt.v1',
    missaoId: 'm-receipt',
    ledgerHeadHash: 'c'.repeat(64),
    ledgerSeq: 3,
    commit,
    artefatos: [artifact],
    runId,
    ator: 'uid:501',
    ts,
    codeManifestHash: 'd'.repeat(64),
    buildId: 'uid-peer-helper:test-build',
    ...overrides
  };
}

async function signedFixture(name, overrides = {}) {
  const t = await tempCase(name);
  await ensureLedgerdSigningKey({
    privateKeyPath: t.keyPath,
    keyringPath: t.keyringPath,
    notBefore: '2026-01-01T00:00:00.000Z',
    notAfter: '2027-01-01T00:00:00.000Z'
  });
  const signed = await signReceipt(receiptBase(overrides), {
    privateKeyPath: t.keyPath,
    keyringPath: t.keyringPath
  });
  return { t, signed };
}

test('gate passo7: ledgerd emite receipt assinado verificavel pela pub do keyring', async () => {
  const t = await tempCase('ledgerd-happy');
  try {
    const env = {
      ...process.env,
      CARTORIO_LEDGERD_KEY_PATH: t.keyPath,
      CARTORIO_KEYRING_PATH: t.keyringPath,
      CARTORIO_RECEIPT_DIR: t.receiptDir,
      CARTORIO_CODE_MANIFEST_HASH: 'e'.repeat(64),
      CARTORIO_BUILD_ID: 'uid-peer-helper:gate'
    };
    const base = { actorUid: process.getuid?.() ?? 501, runId };
    const abrir = { ...base, command: 'abrir', missaoId: 'm-ledgerd', idempotencyKey: 'open', payload: { missaoId: 'm-ledgerd' } };
    const entregar = {
      ...base,
      command: 'entregar',
      missaoId: 'm-ledgerd',
      idempotencyKey: 'deliver',
      payload: { missaoId: 'm-ledgerd', commit, artefatos: [artifact] }
    };
    const coletar = { ...base, command: 'coletar', missaoId: 'm-ledgerd', idempotencyKey: 'collect', payload: { missaoId: 'm-ledgerd' } };
    await execFileAsync(process.execPath, ['bin/ledgerd.js', '--append-json', JSON.stringify(abrir), '--ledger', t.ledgerPath], { cwd: root, env });
    await execFileAsync(process.execPath, ['bin/ledgerd.js', '--append-json', JSON.stringify(entregar), '--ledger', t.ledgerPath], { cwd: root, env });
    const result = await execFileAsync(process.execPath, ['bin/ledgerd.js', '--append-json', JSON.stringify(coletar), '--ledger', t.ledgerPath], { cwd: root, env });
    const parsed = JSON.parse(result.stdout);
    const receipt = JSON.parse(await readFile(join(t.receiptDir, 'm-ledgerd.receipt.json'), 'utf8'));

    assert.equal(parsed.receipt.signature, receipt.signature);
    assert.equal(receipt.keyId, Object.keys(await loadKeyring(t.keyringPath))[0]);
    await verifyReceipt(receipt, {
      keyringPath: t.keyringPath,
      currentHead: {
        ledgerSeq: receipt.ledgerSeq,
        ledgerHeadHash: receipt.ledgerHeadHash
      },
      expectedCommit: commit,
      expectedArtifacts: [artifact]
    });
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: receipt forjado com assinatura invalida falha', async () => {
  const { t, signed } = await signedFixture('forged');
  try {
    await assert.rejects(
      () => verifyReceipt({ ...signed, signature: Buffer.alloc(64).toString('base64') }, { keyringPath: t.keyringPath }),
      { code: 'RECEIPT_SIGNATURE_INVALID' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: receipt stale sobre cabeca antiga falha', async () => {
  const { t, signed } = await signedFixture('stale');
  try {
    await assert.rejects(
      () => verifyReceipt(signed, { keyringPath: t.keyringPath, currentHead: { ledgerSeq: 4, ledgerHeadHash: 'f'.repeat(64) } }),
      { code: 'RECEIPT_STALE_HEAD' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: commit divergente falha', async () => {
  const { t, signed } = await signedFixture('commit');
  try {
    await assert.rejects(
      () => verifyReceipt(signed, { keyringPath: t.keyringPath, expectedCommit: '1'.repeat(40) }),
      { code: 'RECEIPT_COMMIT_MISMATCH' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: keyId diferente de sha256(pub) falha', async () => {
  const { t, signed } = await signedFixture('keyid');
  try {
    const keyring = await loadKeyring(t.keyringPath);
    const [[keyId, entry]] = Object.entries(keyring);
    const badKeyId = keyId === '0'.repeat(16) ? '1'.repeat(16) : '0'.repeat(16);
    delete keyring[keyId];
    keyring[badKeyId] = entry;
    await assert.rejects(
      () => verifyReceipt({ ...signed, keyId: badKeyId }, { keyring }),
      { code: 'RECEIPT_KEYID_MISMATCH' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: chave expirada fora da janela falha', async () => {
  const { t, signed } = await signedFixture('expired');
  try {
    const keyring = await loadKeyring(t.keyringPath);
    keyring[signed.keyId].notAfter = '2026-01-02T00:00:00.000Z';
    await assert.rejects(
      () => verifyReceipt(signed, { keyring }),
      { code: 'KEY_TIME_WINDOW' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: revogacao soft verifica antes de revokedAt e falha depois', async () => {
  const { t, signed } = await signedFixture('soft-revoke');
  try {
    const keyring = await loadKeyring(t.keyringPath);
    keyring[signed.keyId].status = 'revoked';
    keyring[signed.keyId].revokedAt = '2026-07-17T00:00:00.000Z';
    await verifyReceipt(signed, { keyring });

    keyring[signed.keyId].revokedAt = '2026-07-16T00:00:00.000Z';
    await assert.rejects(
      () => verifyReceipt(signed, { keyring }),
      { code: 'KEY_REVOKED' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: revogacao hard compromised invalida todo historico', async () => {
  const { t, signed } = await signedFixture('hard-revoke');
  try {
    const keyring = await loadKeyring(t.keyringPath);
    keyring[signed.keyId].compromised = true;
    await assert.rejects(
      () => verifyReceipt(signed, { keyring }),
      { code: 'KEY_COMPROMISED' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: rotacao com overlap retired verifica historico mas nao assina novo', async () => {
  const { t, signed } = await signedFixture('rotation');
  try {
    const keyring = await loadKeyring(t.keyringPath);
    keyring[signed.keyId].status = 'retired';
    const { privateKey: nextPrivateKey } = generateKeyPairSync('ed25519');
    const nextPub = rawPublicKeyFromPrivateKey(nextPrivateKey);
    const nextKeyId = deriveKeyIdFromPublicKey(nextPub);
    keyring[nextKeyId] = {
      alg: 'ed25519',
      pub: nextPub.toString('base64'),
      role: 'ledgerd',
      status: 'active',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2027-01-01T00:00:00.000Z',
      revokedAt: null
    };
    await saveKeyring(keyring, t.keyringPath);
    await verifyReceipt(signed, { keyringPath: t.keyringPath });
    await assert.rejects(
      () => signReceipt(receiptBase({ missaoId: 'm-rotation-new' }), {
        privateKeyPath: t.keyPath,
        keyringPath: t.keyringPath
      }),
      { code: 'KEY_NOT_ACTIVE' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: permissao aberta de chave ou diretorio falha', async () => {
  const { t } = await signedFixture('perms');
  try {
    await chmod(t.keyPath, 0o644);
    await assert.rejects(
      () => ensureLedgerdSigningKey({ privateKeyPath: t.keyPath, keyringPath: t.keyringPath }),
      { code: 'KEY_PERMISSION_OPEN' }
    );
    await chmod(t.keyPath, 0o600);
    await chmod(dirname(t.keyPath), 0o755);
    await assert.rejects(
      () => ensureLedgerdSigningKey({ privateKeyPath: t.keyPath, keyringPath: t.keyringPath }),
      { code: 'KEY_PERMISSION_OPEN' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: receipt sem codeManifestHash falha', async () => {
  const { t, signed } = await signedFixture('manifest-missing');
  try {
    const missingManifest = { ...signed };
    delete missingManifest.codeManifestHash;
    await assert.rejects(
      () => verifyReceipt(missingManifest, { keyringPath: t.keyringPath }),
      { code: 'RECEIPT_INVALID' }
    );
  } finally {
    await t.cleanup();
  }
});

test('gate passo7: assinatura cobre JSON canonico do payload sem signature', async () => {
  const { t, signed } = await signedFixture('canonical');
  try {
    const material = { ...signed };
    delete material.signature;
    const originalHash = createHash('sha256').update(canonicalize(material), 'utf8').digest('hex');
    const shuffled = {
      signature: signed.signature,
      keyId: signed.keyId,
      ts: signed.ts,
      ator: signed.ator,
      runId: signed.runId,
      artefatos: signed.artefatos,
      commit: signed.commit,
      ledgerSeq: signed.ledgerSeq,
      ledgerHeadHash: signed.ledgerHeadHash,
      missaoId: signed.missaoId,
      version: signed.version,
      buildId: signed.buildId,
      codeManifestHash: signed.codeManifestHash
    };
    assert.equal(createHash('sha256').update(canonicalize(material), 'utf8').digest('hex'), originalHash);
    await verifyReceipt(shuffled, { keyringPath: t.keyringPath });
  } finally {
    await t.cleanup();
  }
});
