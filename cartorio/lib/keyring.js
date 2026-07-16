import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, parseCanonicalJson } from './canonical-json.js';
import { writeFileAtomic } from './atomic-fs.js';

export const KEYRING_VERSION = 'cartorio.keyring.v1';
export const KEY_ALG = 'ed25519';
export const LEDGERD_ROLE = 'ledgerd';
export const BREAK_GLASS_ROLE = 'break-glass';

const ED25519_SPKI_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const KEY_ID_HEX_LENGTH = 16;
const DEFAULT_NOT_AFTER = '9999-12-31T23:59:59.999Z';
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function defaultPrivateKeyPath() {
  return join(appRoot, '.cartorio', 'dev-keys', 'ledgerd.ed25519.pem');
}

export function defaultKeyringPath() {
  return join(appRoot, '.cartorio', 'keys', 'keyring.json');
}

export async function loadKeyring(path = defaultKeyringPath()) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed = parseCanonicalJson(text);
  validateKeyring(parsed);
  return parsed;
}

export async function saveKeyring(keyring, path = defaultKeyringPath()) {
  validateKeyring(keyring);
  await writeFileAtomic(path, canonicalize(keyring), { mode: 0o644 });
  await chmod(path, 0o644);
  return path;
}

export function deriveKeyIdFromPublicKey(pubRaw) {
  const raw = normalizePublicKeyRaw(pubRaw);
  return createHash('sha256').update(raw).digest('hex').slice(0, KEY_ID_HEX_LENGTH);
}

export function validateKeyring(keyring) {
  if (!keyring || typeof keyring !== 'object' || Array.isArray(keyring)) {
    throw keyringError('KEYRING_INVALID', 'keyring precisa ser objeto keyId -> entry');
  }
  for (const [keyId, entry] of Object.entries(keyring)) {
    validateKeyringEntry(entry, keyId);
  }
  return true;
}

export function validateKeyringEntry(entry, keyId = null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw keyringError('KEYRING_INVALID_ENTRY', 'entry de keyring precisa ser objeto', { keyId });
  }
  if (entry.alg !== KEY_ALG) {
    throw keyringError('KEYRING_INVALID_ENTRY', 'algoritmo de chave invalido', { keyId, alg: entry.alg });
  }
  if (![LEDGERD_ROLE, BREAK_GLASS_ROLE].includes(entry.role)) {
    throw keyringError('KEYRING_INVALID_ENTRY', 'role de chave invalida', { keyId, role: entry.role });
  }
  if (!['active', 'retired', 'revoked'].includes(entry.status)) {
    throw keyringError('KEYRING_INVALID_ENTRY', 'status de chave invalido', { keyId, status: entry.status });
  }
  const pubRaw = publicKeyRawFromBase64(entry.pub, keyId);
  const derived = deriveKeyIdFromPublicKey(pubRaw);
  if (keyId != null && derived !== keyId) {
    throw keyringError('KEYRING_KEYID_MISMATCH', 'keyId nao e sha256(pub) truncado', {
      keyId,
      derived
    });
  }
  assertIsoInstant(entry.notBefore, 'notBefore', keyId);
  assertIsoInstant(entry.notAfter, 'notAfter', keyId);
  if (Date.parse(entry.notBefore) > Date.parse(entry.notAfter)) {
    throw keyringError('KEYRING_INVALID_WINDOW', 'janela temporal da chave invertida', { keyId });
  }
  if (entry.revokedAt !== null) {
    assertIsoInstant(entry.revokedAt, 'revokedAt', keyId);
  }
  if (entry.compromised != null && typeof entry.compromised !== 'boolean') {
    throw keyringError('KEYRING_INVALID_ENTRY', 'compromised precisa ser booleano quando presente', { keyId });
  }
  return true;
}

export async function ensureLedgerdSigningKey({
  privateKeyPath = process.env.CARTORIO_LEDGERD_KEY_PATH || defaultPrivateKeyPath(),
  keyringPath = process.env.CARTORIO_KEYRING_PATH || defaultKeyringPath(),
  now = new Date(),
  notBefore = '1970-01-01T00:00:00.000Z',
  notAfter = DEFAULT_NOT_AFTER
} = {}) {
  if (!existsSync(privateKeyPath)) {
    await generatePrivateKeyFile(privateKeyPath);
  }
  const privateKey = await loadPrivateKey(privateKeyPath);
  const pubRaw = rawPublicKeyFromPrivateKey(privateKey);
  const keyId = deriveKeyIdFromPublicKey(pubRaw);
  const keyring = await loadKeyring(keyringPath);
  if (!keyring[keyId]) {
    keyring[keyId] = {
      alg: KEY_ALG,
      pub: pubRaw.toString('base64'),
      role: LEDGERD_ROLE,
      status: 'active',
      notBefore,
      notAfter,
      revokedAt: null
    };
    await saveKeyring(keyring, keyringPath);
  }
  validateSigningKey(keyring[keyId], keyId, now);
  return { privateKey, keyId, keyring, keyringPath, privateKeyPath };
}

export async function loadPrivateKey(privateKeyPath = process.env.CARTORIO_LEDGERD_KEY_PATH || defaultPrivateKeyPath()) {
  await assertPrivateKeyPermissions(privateKeyPath);
  return createPrivateKey(await readFile(privateKeyPath, 'utf8'));
}

export async function assertPrivateKeyPermissions(privateKeyPath) {
  const dir = dirname(privateKeyPath);
  const [dirStat, keyStat] = await Promise.all([stat(dir), stat(privateKeyPath)]);
  const dirMode = dirStat.mode & 0o777;
  const keyMode = keyStat.mode & 0o777;
  if (!dirStat.isDirectory() || dirMode !== 0o700) {
    throw keyringError('KEY_PERMISSION_OPEN', 'diretorio da chave precisa ser 700', {
      path: dir,
      mode: octal(dirMode)
    });
  }
  if (!keyStat.isFile() || keyMode !== 0o600) {
    throw keyringError('KEY_PERMISSION_OPEN', 'arquivo de chave privada precisa ser 600', {
      path: privateKeyPath,
      mode: octal(keyMode)
    });
  }
  return true;
}

export function validateSigningKey(entry, keyId, now = new Date()) {
  validateKeyringEntry(entry, keyId);
  if (entry.role !== LEDGERD_ROLE) {
    throw keyringError('KEY_NOT_LEDGERD', 'chave nao tem role ledgerd', { keyId, role: entry.role });
  }
  if (entry.status !== 'active') {
    throw keyringError('KEY_NOT_ACTIVE', 'assinatura nova exige chave active', { keyId, status: entry.status });
  }
  validateKeyForReceiptTs(entry, keyId, now.toISOString(), { forSigning: true });
  return true;
}

export function validateKeyForReceiptTs(entry, keyId, ts, { role = LEDGERD_ROLE, forSigning = false } = {}) {
  validateKeyringEntry(entry, keyId);
  if (entry.role !== role) {
    throw keyringError('KEY_ROLE_MISMATCH', 'role da chave nao confere', { keyId, expected: role, actual: entry.role });
  }
  if (entry.compromised === true) {
    throw keyringError('KEY_COMPROMISED', 'chave comprometida invalida todo historico', { keyId });
  }
  if (forSigning && entry.status !== 'active') {
    throw keyringError('KEY_NOT_ACTIVE', 'assinatura nova exige chave active', { keyId, status: entry.status });
  }
  if (!forSigning && !['active', 'retired', 'revoked'].includes(entry.status)) {
    throw keyringError('KEY_STATUS_INVALID_FOR_VERIFY', 'status da chave nao verifica receipt', { keyId, status: entry.status });
  }
  const receiptTime = Date.parse(ts);
  if (!Number.isFinite(receiptTime)) {
    throw keyringError('RECEIPT_TS_INVALID', 'ts do receipt invalido', { keyId, ts });
  }
  if (receiptTime < Date.parse(entry.notBefore) || receiptTime > Date.parse(entry.notAfter)) {
    throw keyringError('KEY_TIME_WINDOW', 'ts fora da janela notBefore/notAfter', {
      keyId,
      ts,
      notBefore: entry.notBefore,
      notAfter: entry.notAfter
    });
  }
  if (entry.revokedAt !== null && receiptTime >= Date.parse(entry.revokedAt)) {
    throw keyringError('KEY_REVOKED', 'receipt posterior ou igual a revokedAt', { keyId, ts, revokedAt: entry.revokedAt });
  }
  if (entry.status === 'revoked' && entry.revokedAt === null) {
    throw keyringError('KEY_REVOKED', 'chave revogada sem janela soft', { keyId });
  }
  return true;
}

export function signBytes(privateKey, bytes) {
  return cryptoSign(null, bytes, privateKey);
}

export function verifyBytes(pubRaw, bytes, signature) {
  return cryptoVerify(null, bytes, publicKeyObjectFromRaw(pubRaw), signature);
}

export function publicKeyRawFromBase64(value, keyId = null) {
  if (typeof value !== 'string') {
    throw keyringError('KEYRING_INVALID_PUB', 'pub precisa ser base64', { keyId });
  }
  return normalizePublicKeyRaw(Buffer.from(value, 'base64'), keyId);
}

export function publicKeyObjectFromRaw(pubRaw) {
  const raw = normalizePublicKeyRaw(pubRaw);
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_DER_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  });
}

export function rawPublicKeyFromPrivateKey(privateKey) {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return normalizePublicKeyRaw(der.subarray(-32));
}

async function generatePrivateKeyFile(privateKeyPath) {
  await mkdir(dirname(privateKeyPath), { recursive: true, mode: 0o700 });
  await chmod(dirname(privateKeyPath), 0o700);
  const { privateKey } = generateKeyPairSync(KEY_ALG);
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  await writeFileAtomic(privateKeyPath, pem, { mode: 0o600 });
  await chmod(privateKeyPath, 0o600);
}

function normalizePublicKeyRaw(pubRaw, keyId = null) {
  const raw = Buffer.isBuffer(pubRaw) ? pubRaw : Buffer.from(pubRaw);
  if (raw.length !== 32) {
    throw keyringError('KEYRING_INVALID_PUB', 'pub Ed25519 precisa ter 32 bytes raw', {
      keyId,
      length: raw.length
    });
  }
  return raw;
}

function assertIsoInstant(value, field, keyId) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw keyringError('KEYRING_INVALID_TIME', `${field} precisa ser ISO instant`, { keyId, field, value });
  }
}

function keyringError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function octal(mode) {
  return `0${mode.toString(8).padStart(3, '0')}`;
}
