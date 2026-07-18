import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize, canonicalizeToBytes, parseCanonicalJson } from './canonical-json.js';
import { writeFileAtomic } from './atomic-fs.js';
import {
  defaultKeyringPath,
  deriveKeyIdFromPublicKey,
  ensureLedgerdSigningKey,
  loadKeyring,
  publicKeyRawFromBase64,
  signBytes,
  validateKeyForReceiptTs,
  verifyBytes
} from './keyring.js';

export const RECEIPT_VERSION = 'cartorio.receipt.v1';

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_COMMIT = /^[0-9a-f]{40,64}$/;
const HEX_KEY_ID = /^[0-9a-f]{16}$/;
const RECEIPT_ALLOWED_KEYS = new Set([
  'version',
  'missaoId',
  'eventId',
  'ledgerHeadHash',
  'ledgerSeq',
  'parentCommit',
  'treeScope',
  'treeHashExcludingReceipts',
  'artefatos',
  'runId',
  'ator',
  'actorUid',
  'ts',
  'keyId',
  'codeManifestHash',
  'buildId',
  'signature'
]);
const ARTIFACT_KEYS = ['blobSha256', 'path'];

export function buildReceipt({
  missaoId,
  eventId,
  ledgerHeadHash,
  ledgerSeq,
  parentCommit,
  treeScope,
  treeHashExcludingReceipts,
  artefatos = [],
  runId,
  ator,
  actorUid,
  ts = new Date().toISOString(),
  keyId,
  codeManifestHash,
  buildId
} = {}) {
  const receipt = compact({
    version: RECEIPT_VERSION,
    missaoId,
    eventId,
    ledgerHeadHash,
    ledgerSeq,
    parentCommit,
    treeScope,
    treeHashExcludingReceipts,
    artefatos,
    runId,
    ator,
    actorUid,
    ts,
    keyId,
    codeManifestHash,
    buildId,
    signature: null
  });
  validateReceiptPayload(receipt, { requireKeyId: keyId != null });
  return receipt;
}

export async function signReceipt(receipt, options = {}) {
  const material = { ...receipt };
  delete material.signature;
  const signing = await ensureLedgerdSigningKey(options);
  material.keyId = material.keyId ?? signing.keyId;
  if (material.keyId !== signing.keyId) {
    throw receiptError('RECEIPT_KEYID_MISMATCH', 'receipt cita keyId diferente da chave privada', {
      receiptKeyId: material.keyId,
      signingKeyId: signing.keyId
    });
  }
  validateReceiptPayload(material);
  const signature = signBytes(signing.privateKey, canonicalizeToBytes(material)).toString('base64');
  return {
    ...material,
    signature
  };
}

export async function writeSignedReceipt(receipt, receiptPath, options = {}) {
  const signed = await signReceipt(receipt, options);
  await writeFileAtomic(receiptPath, canonicalize(signed), { mode: 0o644 });
  await chmod(receiptPath, 0o644);
  return signed;
}

export async function readReceipt(receiptPath) {
  return parseCanonicalJson(await readFile(receiptPath, 'utf8'));
}

export async function verifyReceipt(receipt, {
  keyring,
  keyringPath = process.env.CARTORIO_KEYRING_PATH || defaultKeyringPath(),
  currentHead = null,
  expectedParentCommit = null,
  expectedTreeHashExcludingReceipts = null,
  expectedTreeScope = null,
  expectedArtifacts = null
} = {}) {
  const parsed = typeof receipt === 'string' ? parseCanonicalJson(receipt) : receipt;
  validateReceiptPayload(parsed, { requireSignature: true });
  const ring = keyring ?? await loadKeyring(keyringPath);
  const entry = ring[parsed.keyId];
  if (!entry) {
    throw receiptError('RECEIPT_UNKNOWN_KEY', 'keyId ausente do keyring', { keyId: parsed.keyId });
  }
  const pubRaw = publicKeyRawFromBase64(entry.pub, parsed.keyId);
  const derived = deriveKeyIdFromPublicKey(pubRaw);
  if (derived !== parsed.keyId) {
    throw receiptError('RECEIPT_KEYID_MISMATCH', 'keyId nao e sha256(pub) truncado', {
      keyId: parsed.keyId,
      derived
    });
  }
  validateKeyForReceiptTs(entry, parsed.keyId, parsed.ts);

  const material = { ...parsed };
  delete material.signature;
  const signature = Buffer.from(parsed.signature, 'base64');
  if (!verifyBytes(pubRaw, canonicalizeToBytes(material), signature)) {
    throw receiptError('RECEIPT_SIGNATURE_INVALID', 'assinatura Ed25519 invalida', { keyId: parsed.keyId });
  }

  if (currentHead != null) {
    if (parsed.ledgerSeq !== currentHead.ledgerSeq || parsed.ledgerHeadHash !== currentHead.ledgerHeadHash) {
      throw receiptError('RECEIPT_STALE_HEAD', 'receipt nao aponta para a cabeca atual do ledger', {
        receiptHead: {
          ledgerSeq: parsed.ledgerSeq,
          ledgerHeadHash: parsed.ledgerHeadHash
        },
        currentHead
      });
    }
  }
  if (expectedParentCommit != null && parsed.parentCommit !== expectedParentCommit) {
    throw receiptError('RECEIPT_PARENT_COMMIT_MISMATCH', 'parentCommit do receipt diverge do pai esperado', {
      receiptParentCommit: parsed.parentCommit,
      expectedParentCommit
    });
  }
  if (expectedTreeScope != null && parsed.treeScope !== expectedTreeScope) {
    throw receiptError('RECEIPT_TREE_SCOPE_MISMATCH', 'treeScope do receipt diverge do esperado', {
      receiptTreeScope: parsed.treeScope,
      expectedTreeScope
    });
  }
  if (expectedTreeHashExcludingReceipts != null && parsed.treeHashExcludingReceipts !== expectedTreeHashExcludingReceipts) {
    throw receiptError('RECEIPT_TREE_HASH_MISMATCH', 'treeHashExcludingReceipts diverge da arvore reconstruida', {
      receiptTreeHashExcludingReceipts: parsed.treeHashExcludingReceipts,
      expectedTreeHashExcludingReceipts
    });
  }
  if (expectedArtifacts != null) {
    assertArtifactsEqual(parsed.artefatos, expectedArtifacts);
  }
  return { ok: true, keyId: parsed.keyId, receipt: parsed };
}

export function receiptPathForMission(receiptDir, missaoId) {
  return join(receiptDir, `${missaoId}.receipt.json`);
}

export function unsignedReceiptMaterial(receipt) {
  const material = { ...receipt };
  delete material.signature;
  return material;
}

function validateReceiptPayload(receipt, { requireSignature = false, requireKeyId = true } = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw receiptError('RECEIPT_INVALID', 'receipt precisa ser objeto');
  }
  for (const key of Object.keys(receipt)) {
    if (!RECEIPT_ALLOWED_KEYS.has(key)) {
      throw receiptError('RECEIPT_INVALID', 'receipt contem campo fora da whitelist EMENDA-1', { field: key });
    }
  }
  if (receipt.version !== RECEIPT_VERSION) {
    throw receiptError('RECEIPT_INVALID', 'version de receipt invalida', { version: receipt.version });
  }
  assertNonEmptyString(receipt.missaoId, 'missaoId');
  if (receipt.eventId != null) {
    assertNonEmptyString(receipt.eventId, 'eventId');
  }
  if (!Number.isInteger(receipt.ledgerSeq) || receipt.ledgerSeq < 1) {
    throw receiptError('RECEIPT_INVALID', 'ledgerSeq invalido', { ledgerSeq: receipt.ledgerSeq });
  }
  assertHex(receipt.ledgerHeadHash, 'ledgerHeadHash', HEX_SHA256);
  assertHex(receipt.parentCommit, 'parentCommit', HEX_COMMIT);
  assertNonEmptyString(receipt.treeScope, 'treeScope');
  assertHex(receipt.treeHashExcludingReceipts, 'treeHashExcludingReceipts', HEX_SHA256);
  if (!Array.isArray(receipt.artefatos)) {
    throw receiptError('RECEIPT_INVALID', 'artefatos precisa ser array');
  }
  for (const artifact of receipt.artefatos) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw receiptError('RECEIPT_INVALID', 'artefato precisa ser objeto');
    }
    const keys = Object.keys(artifact).sort();
    if (canonicalize(keys) !== canonicalize(ARTIFACT_KEYS)) {
      throw receiptError('RECEIPT_INVALID', 'artefato precisa conter exatamente path e blobSha256', { keys });
    }
    assertNonEmptyString(artifact.path, 'artefato.path');
    assertHex(artifact.blobSha256, 'artefato.blobSha256', HEX_SHA256);
  }
  assertNonEmptyString(receipt.runId, 'runId');
  assertNonEmptyString(receipt.ator, 'ator');
  if (receipt.actorUid != null && (!Number.isInteger(receipt.actorUid) || receipt.actorUid < 0)) {
    throw receiptError('RECEIPT_INVALID', 'actorUid invalido', { actorUid: receipt.actorUid });
  }
  if (requireKeyId) {
    assertHex(receipt.keyId, 'keyId', HEX_KEY_ID);
  }
  assertHex(receipt.codeManifestHash, 'codeManifestHash', HEX_SHA256);
  if (receipt.buildId != null) {
    assertNonEmptyString(receipt.buildId, 'buildId');
  }
  if (typeof receipt.ts !== 'string' || !Number.isFinite(Date.parse(receipt.ts))) {
    throw receiptError('RECEIPT_INVALID', 'ts invalido', { ts: receipt.ts });
  }
  if (requireSignature) {
    assertNonEmptyString(receipt.signature, 'signature');
  }
  return true;
}

function assertArtifactsEqual(actual, expected) {
  const left = canonicalize(actual);
  const right = canonicalize(expected);
  if (left !== right) {
    throw receiptError('RECEIPT_ARTIFACTS_MISMATCH', 'artefatos do receipt divergem do esperado');
  }
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw receiptError('RECEIPT_INVALID', `${field} obrigatorio`, { field });
  }
}

function assertHex(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw receiptError('RECEIPT_INVALID', `${field} invalido`, { field, value });
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function receiptError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}
